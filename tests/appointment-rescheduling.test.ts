import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import { addDays, clinicToday, createUser, get, openDatabase, type DB } from '../server/db.ts';
import type { Appointment, Doctor, Patient, User } from '../shared/types.ts';
import type {
  AppointmentBookingInput,
  AppointmentBookingResult,
} from '../shared/appointment-booking.ts';
import {
  RESCHEDULE_SOURCE_STALE,
  RESCHEDULE_PREVIEW_STALE,
  RESCHEDULE_REQUEST_COLLISION,
} from '../server/appointment-rescheduling.ts';
import type {
  AppointmentRescheduleContext,
  AppointmentRescheduleInput,
  AppointmentReschedulePreview,
  AppointmentRescheduleResult,
  AppointmentRescheduleTarget,
} from '../shared/appointment-rescheduling.ts';

type Client = { cookie: string; csrf: string; user: User };
const route = '/appointment-bookings';
async function fixture(t: TestContext, existingPath?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'derma-single-rescheduling-'));
  const databasePath = existingPath ?? join(directory, 'clinic.sqlite');
  const app = createApp({ databasePath, demoMode: true, production: false });
  const db = app.locals.db as DB;
  let server: Server;
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server!.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    app.locals.close();
  }
  t.after(async () => {
    await close();
    rmSync(directory, { recursive: true, force: true });
  });
  async function call(path: string, who?: Client, method = 'GET', body?: unknown) {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(who ? { Cookie: who.cookie, 'X-CSRF-Token': who.csrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = response.headers.get('content-type')?.includes('application/json')
      ? await response.json()
      : await response.text();
    return { status: response.status, data, headers: response.headers };
  }
  async function login(email: string) {
    const r = await call('/auth/login', undefined, 'POST', {
      email: email.includes('@') ? email : `${email}@derma.demo`,
      password: 'DemoClinic2026!',
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return {
      cookie: r.headers.get('set-cookie')!.split(';')[0],
      csrf: r.data.csrfToken,
      user: r.data.user,
    } as Client;
  }
  const admin = await login('admin');
  async function account(role: User['role'], extra: Partial<User> = {}) {
    const id = randomUUID(),
      email = `${id}@example.test`;
    createUser(
      db,
      { id, email, name: `Synthetic ${role}`, role, active: true, ...extra },
      'DemoClinic2026!',
    );
    return login(email);
  }
  async function doctor() {
    const value: Doctor = {
      id: randomUUID(),
      name: 'Original schedule doctor',
      title: 'Dermatologist',
      qualifications: 'Synthetic only',
      specialties: ['Dermatology'],
      experience: 1,
      fee: 500,
      bio: 'Synthetic only',
      languages: ['English'],
      color: '#b3c7aa',
    };
    db.prepare('INSERT INTO doctors(id,data) VALUES (?,?)').run(value.id, JSON.stringify(value));
    const response = await call(`/schedules/${value.id}`, admin, 'PUT', {
      durationMinutes: 30,
      windows: Array.from({ length: 7 }, (_, day) => ({
        day,
        start: '09:00',
        end: '18:00',
        mode: 'both',
      })),
    });
    assert.equal(response.status, 200);
    return value;
  }
  function input(
    doctorId: string,
    overrides: Partial<AppointmentBookingInput> = {},
  ): AppointmentBookingInput {
    return {
      requestId: randomUUID(),
      patientId: 'patient-ananya',
      doctorId,
      date: addDays(clinicToday(), 40),
      time: '09:00',
      mode: 'in-person',
      reason: 'Synthetic ordinary visit',
      ...overrides,
    };
  }
  async function waiting(body: AppointmentBookingInput, who = admin) {
    const r = await call('/waitlist', who, 'POST', {
      patientId: body.patientId,
      doctorId: body.doctorId,
      mode: body.mode,
      startDate: body.date,
      endDate: addDays(body.date, 2),
      reason: 'Synthetic waiting request',
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return r.data.id as string;
  }
  async function accepting(doctorId: string, value: boolean) {
    const source = await call(`/doctors/${doctorId}/booking-status`, admin);
    const result = await call(`/doctors/${doctorId}/booking-status`, admin, 'POST', {
      acceptingNewBookings: value,
      reason: 'Synthetic roster change',
      expectedRevision: source.data.revision,
      requestId: randomUUID(),
    });
    assert.equal(result.status, 201, JSON.stringify(result.data));
  }
  function state() {
    return Object.fromEntries(
      [
        'appointments',
        'waitlistEvents',
        'appointmentBookings',
        'appointmentBookingCommands',
        'audit',
        'activity',
      ].map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
    );
  }
  function beforeLock(operation: () => void) {
    const original = db.exec.bind(db);
    let invoked = false;
    db.exec = ((sql: string) => {
      if (!invoked && sql === 'BEGIN IMMEDIATE') {
        invoked = true;
        operation();
      }
      return original(sql);
    }) as DB['exec'];
    return () => {
      db.exec = original;
      assert.equal(invoked, true);
    };
  }
  return {
    app,
    db,
    databasePath,
    call,
    login,
    admin,
    account,
    doctor,
    input,
    waiting,
    accepting,
    state,
    beforeLock,
    close,
  };
}
function success(
  response: { status: number; data: unknown },
  status = 201,
): AppointmentBookingResult {
  assert.equal(response.status, status, JSON.stringify(response.data));
  return response.data as AppointmentBookingResult;
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const base = (appointmentId: string) => `/appointments/${appointmentId}`;
async function source(
  f: Fixture,
  appointmentId: string,
  who = f.admin,
): Promise<AppointmentRescheduleContext> {
  const r = await f.call(`${base(appointmentId)}/reschedule-context`, who);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.headers.get('cache-control')!, /no-store/);
  return r.data;
}
async function reviewed(
  f: Fixture,
  appointmentId: string,
  target: AppointmentRescheduleTarget,
  who = f.admin,
): Promise<AppointmentReschedulePreview> {
  const current = await source(f, appointmentId, who);
  const r = await f.call(`${base(appointmentId)}/reschedule-preview`, who, 'POST', {
    ...target,
    expectedSourceRevision: current.sourceRevision,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}
function change(
  preview: AppointmentReschedulePreview,
  requestId = randomUUID(),
): AppointmentRescheduleInput {
  return {
    doctorId: preview.after.doctorId,
    date: preview.after.date,
    time: preview.after.time,
    mode: preview.after.mode,
    expectedRevision: preview.revision,
    patientConfirmed: true,
    requestId,
  };
}
async function apply(
  f: Fixture,
  preview: AppointmentReschedulePreview,
  who = f.admin,
  body = change(preview),
): Promise<AppointmentRescheduleResult> {
  const r = await f.call(`${base(preview.appointmentId)}/reschedules`, who, 'POST', body);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}
function move(
  appointment: Appointment,
  fields: Partial<AppointmentRescheduleTarget> = {},
): AppointmentRescheduleTarget {
  return {
    doctorId: appointment.doctorId,
    date: appointment.date,
    time: '10:00',
    mode: appointment.mode,
    ...fields,
  };
}
function changeState(f: Fixture) {
  return {
    ...f.state(),
    versions: f.db
      .prepare('SELECT * FROM appointmentMutationVersions ORDER BY appointmentId')
      .all(),
    events: f.db.prepare('SELECT * FROM appointmentRescheduleEvents ORDER BY id').all(),
    commands: f.db.prepare('SELECT * FROM appointmentRescheduleCommands ORDER BY requestId').all(),
    allocations: f.db.prepare('SELECT * FROM resourceAllocationEvents ORDER BY id').all(),
    reservations: f.db
      .prepare('SELECT * FROM resourceReservations ORDER BY appointmentId,resourceId')
      .all(),
  };
}
async function allocate(f: Fixture, appointmentId: string) {
  const room = await f.call('/clinic-resources', f.admin, 'POST', {
    name: `Synthetic room ${randomUUID()}`,
    kind: 'room',
    requestId: randomUUID(),
  });
  assert.equal(room.status, 201);
  const resourceId = room.data.resource.id;
  const context = await f.call(`${base(appointmentId)}/resources`, f.admin);
  const assigned = await f.call(`${base(appointmentId)}/resources`, f.admin, 'PUT', {
    resourceIds: [resourceId],
    reason: 'Synthetic retained resource',
    expectedRevision: context.data.revision,
    requestId: randomUUID(),
  });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.data));
  return resourceId as string;
}

test('all roles can review and move an owned operational visit, with exact event/receipt and one notification', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor();
  const users = [
    f.admin,
    await f.account('doctor', { doctorId: doctor.id }),
    await f.account('receptionist'),
    await f.login('patient'),
  ];
  for (const [offset, who] of users.entries()) {
    const booking = success(
      await f.call(
        route,
        f.admin,
        'POST',
        f.input(doctor.id, { date: addDays(clinicToday(), 40 + offset) }),
      ),
    );
    const original = booking.appointment,
      context = await source(f, original.id, who);
    assert.equal(context.canReschedule, true);
    assert.equal(context.blockedReason, null);
    assert.equal(context.bookingThroughDate, addDays(context.clinicDate, 180));
    const preview = await reviewed(f, original.id, move(original), who);
    assert.equal(preview.canReschedule, true);
    assert.deepEqual(preview.before, original);
    assert.equal(preview.after.time, '10:00');
    const body = change(preview),
      result = await apply(f, preview, who, { ...body, requestId: body.requestId.toUpperCase() });
    assert.deepEqual(result.appointment, preview.after);
    assert.deepEqual(result.event.before, original);
    assert.deepEqual(result.event.after, preview.after);
    assert.equal(result.event.createdById, who.user.id);
    assert.equal(result.event.createdByRole, who.user.role);
    assert.equal(result.event.patientConfirmed, true);
    assert.deepEqual(result.receipt, {
      requestId: body.requestId,
      actorId: who.user.id,
      patientId: original.patientId,
      appointmentId: original.id,
      eventId: result.event.id,
      expectedRevision: body.expectedRevision,
    });
    const before = changeState(f);
    const replay = await f.call(`${base(original.id)}/reschedules`, who, 'POST', body);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.data, result);
    assert.deepEqual(changeState(f), before);
    assert.equal(
      f.db
        .prepare('SELECT COUNT(*) n FROM activity WHERE eventKey=?')
        .get(`appointment-rescheduled:${result.event.id}`)!.n,
      1,
    );
    assert.deepEqual(get(f.db, 'appointmentBookings', booking.booking.id), booking.booking);
  }
});

test('schemas and private scope reject invalid requests without false terminal outcomes', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor(),
    booking = success(await f.call(route, f.admin, 'POST', f.input(doctor.id)));
  const appointment = booking.appointment,
    current = await source(f, appointment.id);
  const target = move(appointment),
    input = { ...target, expectedSourceRevision: current.sourceRevision };
  for (const patch of [
    { date: '2026-02-30' },
    { time: '24:00' },
    { time: '10:61' },
    { mode: 'phone' },
    { durationMinutes: 90 },
    { patientId: appointment.patientId },
    { expectedSourceRevision: 'bad' },
    { unknown: true },
  ]) {
    const r = await f.call(`${base(appointment.id)}/reschedule-preview`, f.admin, 'POST', {
      ...input,
      ...patch,
    });
    assert.equal(r.status, 400, JSON.stringify(r.data));
    assert.equal(r.data.rescheduleOutcome, undefined);
  }
  const preview = await reviewed(f, appointment.id, target),
    body = change(preview);
  for (const patch of [
    { patientConfirmed: false },
    { patientConfirmed: undefined },
    { requestId: 'bad' },
    { expectedRevision: 'bad' },
    { status: 'cancelled' },
    { reason: 'not supported' },
  ]) {
    const r = await f.call(`${base(appointment.id)}/reschedules`, f.admin, 'POST', {
      ...body,
      ...patch,
    });
    assert.equal(r.status, 400);
    assert.equal(r.data.rescheduleOutcome, undefined);
  }
  for (const [path, method, value] of [
    [`${base(appointment.id)}/reschedule-context`, 'GET', undefined],
    [`${base(appointment.id)}/reschedule-preview`, 'POST', input],
    [`${base(appointment.id)}/reschedules`, 'POST', body],
  ] as const) {
    assert.equal((await f.call(`${path}?unexpected=1`, f.admin, method, value)).status, 400);
    assert.equal((await f.call(path, undefined, method, value)).status, 401);
  }
  const otherPatient = await f.account('patient', { patientId: 'patient-2' });
  for (const [suffix, method, value] of [
    ['reschedule-context', 'GET', undefined],
    ['reschedule-preview', 'POST', input],
    ['reschedules', 'POST', body],
  ] as const) {
    const r = await f.call(`${base(appointment.id)}/${suffix}`, otherPatient, method, value);
    assert.equal(r.status, 403);
    assert.equal(r.data.rescheduleOutcome, undefined);
  }
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM appointmentRescheduleCommands').get()!.n, 0);
});

test('actual moves adopt current target profile/default duration, while custom minutes and immutable patient/reason snapshots stay fixed', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor(),
    targetDoctor = await f.doctor();
  const booking = success(await f.call(route, f.admin, 'POST', f.input(doctor.id))),
    before = booking.appointment;
  const targetProfile = { ...targetDoctor, name: 'Current transfer doctor', fee: 1350 };
  f.db
    .prepare('UPDATE doctors SET data=? WHERE id=?')
    .run(JSON.stringify(targetProfile), targetDoctor.id);
  assert.equal(
    (
      await f.call(`/schedules/${targetDoctor.id}`, f.admin, 'PUT', {
        durationMinutes: 45,
        windows: Array.from({ length: 7 }, (_, day) => ({
          day,
          start: '09:00',
          end: '18:00',
          mode: 'both',
        })),
      })
    ).status,
    200,
  );
  const preview = await reviewed(
    f,
    before.id,
    move(before, { doctorId: targetDoctor.id, time: '10:30', mode: 'online' }),
  );
  assert.equal(preview.after.durationMinutes, 45);
  assert.equal(preview.after.fee, 1350);
  assert.equal(preview.after.doctorName, targetProfile.name);
  const changed = await apply(f, preview);
  for (const key of ['patientId', 'patientName', 'reason', 'id', 'createdAt'] as const)
    assert.equal(changed.appointment[key], before[key]);
  const custom = await f.call('/visit-duration/bookings', f.admin, 'POST', {
    ...f.input(doctor.id, { date: addDays(before.date, 2) }),
    durationMinutes: 75,
  });
  assert.equal(custom.status, 201, JSON.stringify(custom.data));
  const customVisit = custom.data.appointment as Appointment;
  const customPreview = await reviewed(
    f,
    customVisit.id,
    move(customVisit, { doctorId: targetDoctor.id, time: '10:05' }),
  );
  assert.equal(customPreview.canReschedule, true);
  assert.equal(customPreview.after.durationPolicy, 'custom');
  assert.equal(customPreview.after.durationMinutes, 75);
  assert.equal((await apply(f, customPreview)).appointment.fee, 1350);
});

test('no-op, late, out-of-horizon, closed and overnight proposals remain explicit blocked previews and cannot partially change a visit', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor(),
    before = success(await f.call(route, f.admin, 'POST', f.input(doctor.id))).appointment;
  f.db
    .prepare('UPDATE doctors SET data=? WHERE id=?')
    .run(JSON.stringify({ ...doctor, fee: 900, name: 'Changed label' }), doctor.id);
  const noop = await reviewed(f, before.id, move(before, { time: before.time }));
  assert.equal(noop.canReschedule, false);
  assert.deepEqual(noop.after, before);
  const original = get(f.db, 'appointments', before.id);
  for (const target of [
    move(before, { time: before.time }),
    move(before, { date: addDays(clinicToday(), -1) }),
    move(before, { date: addDays(clinicToday(), 181) }),
  ]) {
    const preview = await reviewed(f, before.id, target);
    assert.equal(preview.canReschedule, false);
    const r = await f.call(`${base(before.id)}/reschedules`, f.admin, 'POST', change(preview));
    assert.equal(r.status, 409);
    assert.equal(r.data.rescheduleOutcome, 'not-applied');
    assert.deepEqual(get(f.db, 'appointments', before.id), original);
  }
  const custom = await f.call('/visit-duration/bookings', f.admin, 'POST', {
    ...f.input(doctor.id, { date: addDays(before.date, 2) }),
    durationMinutes: 240,
  });
  assert.equal(custom.status, 201);
  const overnight = await reviewed(
    f,
    custom.data.appointment.id,
    move(custom.data.appointment, { time: '23:55' }),
  );
  assert.equal(overnight.canReschedule, false);
  assert.equal(overnight.after.time, '23:55');
  assert.equal(overnight.after.durationMinutes, 240);
  assert.equal(
    (await f.call(base(before.id), f.admin, 'PATCH', { status: 'cancelled' })).status,
    200,
  );
  const closed = await source(f, before.id);
  assert.equal(closed.canReschedule, false);
  const closedPreview = await reviewed(f, before.id, move(before));
  assert.equal(closedPreview.after.status, 'cancelled');
  assert.equal(closedPreview.canReschedule, false);
});

test('monotonic source revisions detect legacy A→B→A and duration policy changes; no-op SQL and unrelated visits do not invalidate context', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor(),
    before = success(await f.call(route, f.admin, 'POST', f.input(doctor.id))).appointment;
  const initial = await source(f, before.id);
  assert.equal(
    f.db
      .prepare('SELECT COUNT(*) n FROM appointmentMutationVersions WHERE appointmentId=?')
      .get(before.id)!.n,
    0,
  );
  f.db.prepare('UPDATE appointments SET data=data WHERE id=?').run(before.id);
  assert.equal((await source(f, before.id)).sourceRevision, initial.sourceRevision);
  const unrelated = success(
    await f.call(route, f.admin, 'POST', f.input(doctor.id, { date: addDays(before.date, 1) })),
  ).appointment;
  assert.equal((await f.call(base(unrelated.id), f.admin, 'PATCH', { time: '10:00' })).status, 200);
  assert.equal((await source(f, before.id)).sourceRevision, initial.sourceRevision);
  assert.equal((await f.call(base(before.id), f.admin, 'PATCH', { time: '10:00' })).status, 200);
  assert.equal(
    (await f.call(base(before.id), f.admin, 'PATCH', { time: before.time })).status,
    200,
  );
  assert.deepEqual(get(f.db, 'appointments', before.id), before);
  const afterABA = await source(f, before.id);
  assert.notEqual(afterABA.sourceRevision, initial.sourceRevision);
  const stale = await f.call(`${base(before.id)}/reschedule-preview`, f.admin, 'POST', {
    ...move(before),
    expectedSourceRevision: initial.sourceRevision,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error, RESCHEDULE_SOURCE_STALE);
  assert.equal(stale.data.rescheduleOutcome, undefined);
  const duration = await f.call(`${base(before.id)}/duration`, f.admin);
  assert.equal(
    (
      await f.call(`${base(before.id)}/duration`, f.admin, 'POST', {
        durationPolicy: 'custom',
        durationMinutes: 60,
        date: before.date,
        time: before.time,
        reason: 'Synthetic length revision',
        expectedRevision: duration.data.revision,
        requestId: randomUUID(),
      })
    ).status,
    200,
  );
  assert.notEqual((await source(f, before.id)).sourceRevision, afterABA.sourceRevision);
});

test('reviewed source changes made by atomic series rescheduling also advance single-appointment revisions without altering series origins', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor();
  const pattern = {
    patientId: 'patient-ananya',
    doctorId: doctor.id,
    firstDate: addDays(clinicToday(), 70),
    time: '09:00',
    count: 2,
    intervalWeeks: 1,
    mode: 'in-person',
    reason: 'Synthetic series source',
    durationPolicy: 'schedule',
  };
  const first = await f.call('/appointment-series/preview', f.admin, 'POST', pattern);
  assert.equal(first.status, 200);
  const saved = await f.call('/appointment-series', f.admin, 'POST', {
    input: pattern,
    expectedRevision: first.data.revision,
    patientConfirmed: true,
    requestId: randomUUID(),
  });
  assert.equal(saved.status, 201);
  const [one, two] = saved.data.appointments as Appointment[];
  const context = await source(f, one.id);
  const moves = [
    { appointmentId: one.id, date: two.date, time: two.time },
    { appointmentId: two.id, date: one.date, time: one.time },
  ];
  const preview = await f.call(
    `/appointment-series/${saved.data.series.id}/reschedules/preview`,
    f.admin,
    'POST',
    { moves },
  );
  assert.equal(preview.status, 200);
  assert.equal(preview.data.canReschedule, true);
  const changed = await f.call(
    `/appointment-series/${saved.data.series.id}/reschedules`,
    f.admin,
    'POST',
    {
      moves,
      reason: 'Synthetic swapped series',
      expectedRevision: preview.data.revision,
      patientConfirmed: true,
      requestId: randomUUID(),
    },
  );
  assert.equal(changed.status, 201, JSON.stringify(changed.data));
  assert.notEqual((await source(f, one.id)).sourceRevision, context.sourceRevision);
  assert.ok(
    Number(
      f.db
        .prepare('SELECT version FROM appointmentMutationVersions WHERE appointmentId=?')
        .get(one.id)!.version,
    ) >= 2,
  );
  const single = await reviewed(
    f,
    one.id,
    move(
      changed.data.detail.appointments.find((v: Appointment) => v.id === one.id),
      { time: '11:00' },
    ),
  );
  await apply(f, single);
  const detail = await f.call(`/appointment-series/${saved.data.series.id}`, f.admin);
  assert.deepEqual(detail.data.series, saved.data.series);
});

test('target fee, schedule, closure and allocation changes stale previews; unrelated slots and same-doctor pause do not', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor(),
    before = success(await f.call(route, f.admin, 'POST', f.input(doctor.id))).appointment;
  const target = move(before);
  const initial = await reviewed(f, before.id, target);
  // A nonoverlapping independent visit does not invalidate this target interval.
  success(await f.call(route, f.admin, 'POST', f.input(doctor.id, { time: '15:00' })));
  assert.equal((await reviewed(f, before.id, target)).revision, initial.revision);
  await f.accepting(doctor.id, false);
  assert.equal((await reviewed(f, before.id, target)).revision, initial.revision);
  await f.accepting(doctor.id, true);
  f.db
    .prepare('UPDATE doctors SET data=? WHERE id=?')
    .run(JSON.stringify({ ...doctor, fee: 700 }), doctor.id);
  const staleFee = await f.call(`${base(before.id)}/reschedules`, f.admin, 'POST', change(initial));
  assert.equal(staleFee.status, 409);
  assert.equal(staleFee.data.error, RESCHEDULE_PREVIEW_STALE);
  assert.equal(staleFee.data.rescheduleOutcome, 'not-applied');
  const feePreview = await reviewed(f, before.id, target);
  assert.equal(feePreview.after.fee, 700);
  const room = await allocate(f, before.id);
  const staleAllocation = await f.call(
    `${base(before.id)}/reschedules`,
    f.admin,
    'POST',
    change(feePreview),
  );
  assert.equal(staleAllocation.data.error, RESCHEDULE_PREVIEW_STALE);
  const allocated = await reviewed(f, before.id, target);
  const resourceContext = await f.call(`${base(before.id)}/resources`, f.admin);
  assert.equal(
    (
      await f.call(`${base(before.id)}/resources`, f.admin, 'PUT', {
        resourceIds: [],
        reason: 'Release for source ABA',
        expectedRevision: resourceContext.data.revision,
        requestId: randomUUID(),
      })
    ).status,
    200,
  );
  const empty = await f.call(`${base(before.id)}/resources`, f.admin);
  assert.equal(
    (
      await f.call(`${base(before.id)}/resources`, f.admin, 'PUT', {
        resourceIds: [room],
        reason: 'Restore for source ABA',
        expectedRevision: empty.data.revision,
        requestId: randomUUID(),
      })
    ).status,
    200,
  );
  assert.notEqual((await reviewed(f, before.id, target)).revision, allocated.revision);
  const beforeClosure = await reviewed(f, before.id, target);
  const closure = await f.call('/schedule-closures', f.admin, 'POST', {
    doctorId: doctor.id,
    startDate: before.date,
    endDate: before.date,
    startTime: '10:00',
    endTime: '11:00',
    reason: 'PRIVATE_TIME_OFF_REASON',
  });
  assert.equal(closure.status, 201);
  const blocked = await reviewed(f, before.id, target);
  assert.equal(blocked.canReschedule, false);
  assert.equal(JSON.stringify(blocked).includes('PRIVATE_TIME_OFF_REASON'), false);
  assert.equal(
    (await f.call(`${base(before.id)}/reschedules`, f.admin, 'POST', change(beforeClosure))).data
      .error,
    RESCHEDULE_PREVIEW_STALE,
  );
});

test('retained resource conflicts stay private and resource reservations move atomically with transferred visits', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor(),
    secondDoctor = await f.doctor(),
    patient = await f.login('patient');
  const before = success(await f.call(route, f.admin, 'POST', f.input(doctor.id))).appointment;
  const roomId = await allocate(f, before.id);
  const outside = success(
    await f.call(
      route,
      f.admin,
      'POST',
      f.input(secondDoctor.id, { patientId: 'patient-2', time: '10:00' }),
    ),
  ).appointment;
  const outsideContext = await f.call(`${base(outside.id)}/resources`, f.admin);
  assert.equal(
    (
      await f.call(`${base(outside.id)}/resources`, f.admin, 'PUT', {
        resourceIds: [roomId],
        reason: 'PRIVATE_RESOURCE_REASON',
        expectedRevision: outsideContext.data.revision,
        requestId: randomUUID(),
      })
    ).status,
    200,
  );
  const blocked = await reviewed(f, before.id, move(before), patient);
  assert.equal(blocked.canReschedule, false);
  assert.equal(
    blocked.blockedReason,
    'This time is unavailable for the appointment. Choose another time or contact the clinic.',
  );
  for (const privateValue of [roomId, 'PRIVATE_RESOURCE_REASON', outside.id])
    assert.equal(JSON.stringify(blocked).includes(privateValue), false);
  assert.equal('reservationCount' in blocked, false);
  const adjacent = await reviewed(
    f,
    before.id,
    move(before, { doctorId: secondDoctor.id, time: '10:30', mode: 'online' }),
    patient,
  );
  assert.equal(adjacent.canReschedule, true);
  const applied = await apply(f, adjacent, patient);
  assert.equal(applied.appointment.doctorId, secondDoctor.id);
  const claims = f.db
    .prepare('SELECT * FROM resourceReservations WHERE appointmentId=?')
    .all(before.id);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].resourceId, roomId);
  assert.equal(Number(claims[0].startAt), Date.parse(`${before.date}T10:30:00+05:30`));
  assert.equal(JSON.stringify(applied).includes(roomId), false);
  const calendar = await f.call(`${base(before.id)}/calendar`, patient);
  assert.match(calendar.data, /DTSTART:/);
  assert.equal(calendar.data.includes(applied.event.requestId), false);
});

test('paused same-doctor moves remain valid, incoming transfers are blocked, and incoming pause/resume invalidates review', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor(),
    otherDoctor = await f.doctor();
  const before = success(await f.call(route, f.admin, 'POST', f.input(doctor.id))).appointment;
  const same = await reviewed(f, before.id, move(before));
  const incoming = await reviewed(f, before.id, move(before, { doctorId: otherDoctor.id }));
  await f.accepting(doctor.id, false);
  assert.equal((await reviewed(f, before.id, move(before))).revision, same.revision);
  await f.accepting(otherDoctor.id, false);
  const pausedTransfer = await reviewed(f, before.id, move(before, { doctorId: otherDoctor.id }));
  assert.equal(pausedTransfer.canReschedule, false);
  await f.accepting(otherDoctor.id, true);
  assert.notEqual(
    (await reviewed(f, before.id, move(before, { doctorId: otherDoctor.id }))).revision,
    incoming.revision,
  );
  const applied = await apply(f, same);
  assert.equal(applied.appointment.doctorId, doctor.id);
});

test('successful reschedules replay original evidence after later legacy move, cancellation, changed fees and source time expiry', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor(),
    body = f.input(doctor.id);
  const waitingId = await f.waiting(body);
  const booking = success(
    await f.call(route, f.admin, 'POST', {
      ...body,
      waitlistId: waitingId,
      patientConfirmed: true,
    }),
  );
  const before = booking.appointment,
    preview = await reviewed(f, before.id, move(before)),
    command = change(preview);
  const saved = await apply(f, preview, f.admin, command);
  const waitlistBefore = f.db
    .prepare('SELECT * FROM waitlistEvents WHERE waitlistId=?')
    .all(waitingId);
  f.db
    .prepare('UPDATE doctors SET data=? WHERE id=?')
    .run(JSON.stringify({ ...doctor, fee: 999, name: 'Later label' }), doctor.id);
  assert.equal((await f.call(base(before.id), f.admin, 'PATCH', { time: '12:00' })).status, 200);
  assert.equal(
    (await f.call(base(before.id), f.admin, 'PATCH', { status: 'cancelled' })).status,
    200,
  );
  await f.accepting(doctor.id, false);
  const RealDate = Date,
    future = Date.parse(`${addDays(before.date, 2)}T12:00:00Z`);
  f.db.prepare('UPDATE sessions SET expiresAt=?').run(future + 86400000);
  class LaterDate extends RealDate {
    constructor(...args: ConstructorParameters<typeof Date>) {
      if (args.length) super(...args);
      else super(future);
    }
    static now() {
      return future;
    }
  }
  globalThis.Date = LaterDate as DateConstructor;
  try {
    const replay = await f.call(`${base(before.id)}/reschedules`, f.admin, 'POST', command);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.data.event, saved.event);
    assert.deepEqual(replay.data.receipt, saved.receipt);
    assert.equal(replay.data.appointment.status, 'cancelled');
    assert.equal(replay.data.appointment.time, '12:00');
    assert.equal(replay.data.appointment.fee, 999);
  } finally {
    globalThis.Date = RealDate;
  }
  assert.deepEqual(
    f.db.prepare('SELECT * FROM waitlistEvents WHERE waitlistId=?').all(waitingId),
    waitlistBefore,
  );
  assert.deepEqual(get(f.db, 'appointmentBookings', booking.booking.id), booking.booking);
});

test('durable stale rejection cannot later apply after source reverts; changed revision, actor, target appointment and payload collide', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor(),
    before = success(await f.call(route, f.admin, 'POST', f.input(doctor.id))).appointment;
  const second = success(
    await f.call(route, f.admin, 'POST', f.input(doctor.id, { date: addDays(before.date, 1) })),
  ).appointment;
  const preview = await reviewed(f, before.id, move(before)),
    command = change(preview);
  f.db
    .prepare('UPDATE doctors SET data=? WHERE id=?')
    .run(JSON.stringify({ ...doctor, fee: 999 }), doctor.id);
  const rejected = await f.call(`${base(before.id)}/reschedules`, f.admin, 'POST', command);
  assert.equal(rejected.status, 409);
  assert.deepEqual(rejected.data, {
    error: RESCHEDULE_PREVIEW_STALE,
    rescheduleOutcome: 'not-applied',
    requestId: command.requestId,
    actorId: f.admin.user.id,
    patientId: before.patientId,
    appointmentId: before.id,
  });
  f.db.prepare('UPDATE doctors SET data=? WHERE id=?').run(JSON.stringify(doctor), doctor.id);
  assert.equal((await reviewed(f, before.id, move(before))).revision, preview.revision);
  assert.deepEqual(
    (await f.call(`${base(before.id)}/reschedules`, f.admin, 'POST', command)).data,
    rejected.data,
  );
  for (const changed of [
    { time: '11:00' },
    { expectedRevision: 'a'.repeat(64) },
    { mode: 'online' },
  ]) {
    const r = await f.call(`${base(before.id)}/reschedules`, f.admin, 'POST', {
      ...command,
      ...changed,
    });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, RESCHEDULE_REQUEST_COLLISION);
    assert.equal(r.data.rescheduleOutcome, undefined);
  }
  const receptionist = await f.account('receptionist');
  assert.equal(
    (await f.call(`${base(before.id)}/reschedules`, receptionist, 'POST', command)).data.error,
    RESCHEDULE_REQUEST_COLLISION,
  );
  assert.equal(
    (await f.call(`${base(second.id)}/reschedules`, f.admin, 'POST', command)).data.error,
    RESCHEDULE_REQUEST_COLLISION,
  );
  await apply(f, preview, f.admin, { ...command, requestId: randomUUID() });
});

test('current session, credential, active role and ownership are rechecked under lock for all new paths and legacy PATCH', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor(),
    before = success(await f.call(route, f.admin, 'POST', f.input(doctor.id))).appointment;
  const preview = await reviewed(f, before.id, move(before)),
    command = change(preview);
  await apply(f, preview, f.admin, command);
  const current = await source(f, before.id),
    next = await reviewed(f, before.id, move(before, { time: '11:00' }));
  const rejectedBody = { ...change(next), expectedRevision: 'a'.repeat(64) };
  assert.equal(
    (await f.call(`${base(before.id)}/reschedules`, f.admin, 'POST', rejectedBody)).data
      .rescheduleOutcome,
    'not-applied',
  );
  const other = openDatabase(f.databasePath);
  t.after(() => other.close());
  const rawUser = f.db.prepare('SELECT data FROM users WHERE id=?').get(f.admin.user.id)!
    .data as string;
  const sessions = f.db.prepare('SELECT * FROM sessions WHERE userId=?').all(f.admin.user.id);
  const mutations: Array<{ status: number; apply: () => void }> = [
    {
      status: 401,
      apply: () => other.prepare('DELETE FROM sessions WHERE userId=?').run(f.admin.user.id),
    },
    {
      status: 401,
      apply: () =>
        other.prepare('UPDATE sessions SET expiresAt=0 WHERE userId=?').run(f.admin.user.id),
    },
    {
      status: 401,
      apply: () =>
        other
          .prepare("UPDATE sessions SET csrfToken='changed' WHERE userId=?")
          .run(f.admin.user.id),
    },
    {
      status: 401,
      apply: () =>
        other
          .prepare(
            'INSERT INTO mfaCredentials(userId,id,secret,enabledAt,lastStep) VALUES (?,?,?,?,?)',
          )
          .run(f.admin.user.id, 'new-factor', 'synthetic', new Date().toISOString(), -1),
    },
    {
      status: 401,
      apply: () =>
        other
          .prepare('UPDATE users SET data=? WHERE id=?')
          .run(JSON.stringify({ ...JSON.parse(rawUser), active: false }), f.admin.user.id),
    },
    {
      status: 403,
      apply: () =>
        other
          .prepare('UPDATE users SET data=? WHERE id=?')
          .run(
            JSON.stringify({ ...JSON.parse(rawUser), mustChangePassword: true }),
            f.admin.user.id,
          ),
    },
    {
      status: 403,
      apply: () =>
        other.prepare("UPDATE users SET role='patient',data=? WHERE id=?").run(
          JSON.stringify({
            ...JSON.parse(rawUser),
            role: 'patient',
            patientId: 'patient-2',
            doctorId: undefined,
          }),
          f.admin.user.id,
        ),
    },
  ];
  const paths: Array<[string, string, unknown]> = [
    [`${base(before.id)}/reschedule-context`, 'GET', undefined],
    [
      `${base(before.id)}/reschedule-preview`,
      'POST',
      { ...move(before), expectedSourceRevision: current.sourceRevision },
    ],
    [`${base(before.id)}/reschedules`, 'POST', change(next)],
    [`${base(before.id)}/reschedules`, 'POST', command],
    [`${base(before.id)}/reschedules`, 'POST', rejectedBody],
    [base(before.id), 'PATCH', { time: '11:00' }],
  ];
  for (const [path, method, body] of paths)
    for (const mutation of mutations) {
      const state = changeState(f),
        restore = f.beforeLock(mutation.apply);
      const response = await f.call(path, f.admin, method, body);
      restore();
      assert.equal(
        response.status,
        mutation.status,
        `${method} ${path}: ${JSON.stringify(response.data)}`,
      );
      assert.equal(response.data.rescheduleOutcome, undefined);
      assert.deepEqual(changeState(f), state);
      other
        .prepare('UPDATE users SET role=?,data=? WHERE id=?')
        .run(f.admin.user.role, rawUser, f.admin.user.id);
      other.prepare('DELETE FROM mfaCredentials WHERE userId=?').run(f.admin.user.id);
      other.prepare('DELETE FROM sessions WHERE userId=?').run(f.admin.user.id);
      for (const session of sessions) {
        const columns = Object.keys(session);
        other
          .prepare(
            `INSERT INTO sessions(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
          )
          .run(...Object.values(session));
      }
    }
});

test('concurrent application connections commit a single exact reschedule and never apply two competing previews or counters', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor(),
    before = success(await f.call(route, f.admin, 'POST', f.input(doctor.id))).appointment;
  const second = await fixture(t, f.databasePath);
  const preview = await reviewed(f, before.id, move(before)),
    body = change(preview);
  const results = await Promise.all([
    f.call(`${base(before.id)}/reschedules`, f.admin, 'POST', body),
    second.call(`${base(before.id)}/reschedules`, f.admin, 'POST', body),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 201]);
  assert.deepEqual(results[0].data, results[1].data);
  assert.equal(
    f.db
      .prepare('SELECT version FROM appointmentMutationVersions WHERE appointmentId=?')
      .get(before.id)!.version,
    1,
  );
  const a = await reviewed(f, before.id, move(before, { time: '11:00' }));
  const b = await reviewed(f, before.id, move(before, { time: '12:00' }));
  const competing = await Promise.all([
    f.call(`${base(before.id)}/reschedules`, f.admin, 'POST', change(a)),
    second.call(`${base(before.id)}/reschedules`, f.admin, 'POST', change(b)),
  ]);
  assert.deepEqual(competing.map((r) => r.status).sort(), [201, 409]);
  assert.equal(competing.find((r) => r.status === 409)!.data.rescheduleOutcome, 'not-applied');
  assert.equal(
    f.db
      .prepare('SELECT version FROM appointmentMutationVersions WHERE appointmentId=?')
      .get(before.id)!.version,
    2,
  );
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM appointmentRescheduleEvents').get()!.n, 2);
});

test('appointment, resource, counter, audit, activity and evidence failures roll back together without a terminal marker', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor(),
    before = success(await f.call(route, f.admin, 'POST', f.input(doctor.id))).appointment;
  await allocate(f, before.id);
  const preview = await reviewed(f, before.id, move(before)),
    body = change(preview);
  const failures = [
    ['resourceAllocationEvents', 'INSERT', '1'],
    ['resourceReservations', 'DELETE', '1'],
    ['resourceReservations', 'INSERT', '1'],
    ['appointments', 'UPDATE', '1'],
    ['appointmentMutationVersions', 'INSERT', '1'],
    ['appointmentRescheduleEvents', 'INSERT', '1'],
    ['appointmentRescheduleCommands', 'INSERT', '1'],
    ['audit', 'INSERT', "json_extract(NEW.data,'$.action')='rescheduled appointment'"],
    ['activity', 'INSERT', '1'],
  ];
  for (const [table, operation, condition] of failures) {
    const original = changeState(f);
    f.db.exec(
      `CREATE TRIGGER reschedule_injected_failure BEFORE ${operation} ON ${table} WHEN ${condition} BEGIN SELECT RAISE(ABORT,'Synthetic single reschedule rollback'); END;`,
    );
    const response = await f.call(`${base(before.id)}/reschedules`, f.admin, 'POST', body);
    f.db.exec('DROP TRIGGER reschedule_injected_failure');
    assert.equal(response.status, 500, `${table}: ${JSON.stringify(response.data)}`);
    assert.equal(response.data.rescheduleOutcome, undefined);
    assert.deepEqual(changeState(f), original, table);
  }
  await apply(f, preview, f.admin, body);
});

test('preview/context audits and terminal rejection evidence failures never produce partial success or definitive markers', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor(),
    before = success(await f.call(route, f.admin, 'POST', f.input(doctor.id))).appointment;
  const context = await source(f, before.id),
    preview = await reviewed(f, before.id, move(before));
  for (const [path, method, body] of [
    [`${base(before.id)}/reschedule-context`, 'GET', undefined],
    [
      `${base(before.id)}/reschedule-preview`,
      'POST',
      { ...move(before), expectedSourceRevision: context.sourceRevision },
    ],
  ] as const) {
    const original = changeState(f);
    f.db.exec(
      "CREATE TRIGGER read_audit_failure BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT,'Synthetic read audit failure'); END;",
    );
    const r = await f.call(path, f.admin, method, body);
    f.db.exec('DROP TRIGGER read_audit_failure');
    assert.equal(r.status, 500);
    assert.deepEqual(changeState(f), original);
  }
  f.db
    .prepare('UPDATE doctors SET data=? WHERE id=?')
    .run(JSON.stringify({ ...doctor, fee: 501 }), doctor.id);
  const original = changeState(f);
  f.db.exec(
    "CREATE TRIGGER rejection_failure BEFORE INSERT ON appointmentRescheduleCommands WHEN NEW.rejection IS NOT NULL BEGIN SELECT RAISE(ABORT,'Synthetic rejection failure'); END;",
  );
  const r = await f.call(`${base(before.id)}/reschedules`, f.admin, 'POST', change(preview));
  f.db.exec('DROP TRIGGER rejection_failure');
  assert.equal(r.status, 500);
  assert.equal(r.data.rescheduleOutcome, undefined);
  assert.deepEqual(changeState(f), original);
});

test('a source start reached during the commit rolls back all effects and persists only a terminal rejection', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor(),
    before = success(await f.call(route, f.admin, 'POST', f.input(doctor.id))).appointment;
  await allocate(f, before.id);
  const start = Date.parse(`${before.date}T${before.time}:00+05:30`);
  let clock = start - 1000;
  const RealDate = Date;
  class ClockDate extends RealDate {
    constructor(...args: ConstructorParameters<typeof Date>) {
      if (args.length) super(...args);
      else super(clock);
    }
    static now() {
      return clock;
    }
  }
  f.db.prepare('UPDATE sessions SET expiresAt=?').run(start + 86400000);
  globalThis.Date = ClockDate as DateConstructor;
  const originalPrepare = f.db.prepare.bind(f.db);
  try {
    const preview = await reviewed(f, before.id, move(before));
    assert.equal(preview.canReschedule, true);
    assert.equal(preview.generatedAt, new RealDate(clock).toISOString());
    const original = changeState(f);
    f.db.prepare = ((sql: string) => {
      if (sql.includes('INSERT OR IGNORE INTO activity')) clock = start;
      return originalPrepare(sql);
    }) as DB['prepare'];
    const body = change(preview),
      rejected = await f.call(`${base(before.id)}/reschedules`, f.admin, 'POST', body);
    f.db.prepare = originalPrepare;
    assert.equal(rejected.status, 409);
    assert.equal(rejected.data.rescheduleOutcome, 'not-applied');
    const after = changeState(f);
    for (const key of Object.keys(original).filter((key) => key !== 'commands'))
      assert.deepEqual(after[key as keyof typeof after], original[key as keyof typeof original]);
    assert.equal(after.commands.length, original.commands.length + 1);
    clock = start - 1000;
    assert.deepEqual(
      (await f.call(`${base(before.id)}/reschedules`, f.admin, 'POST', body)).data,
      rejected.data,
    );
  } finally {
    f.db.prepare = originalPrepare;
    globalThis.Date = RealDate;
  }
});

test('source changes just before the commit lock are rejected; historical legacy scheduled visits keep their prior reschedule semantics', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor(),
    before = success(await f.call(route, f.admin, 'POST', f.input(doctor.id))).appointment;
  const preview = await reviewed(f, before.id, move(before)),
    other = openDatabase(f.databasePath);
  t.after(() => other.close());
  const changed = { ...before, time: '11:00' };
  const restore = f.beforeLock(() =>
    other
      .prepare('UPDATE appointments SET time=?,data=? WHERE id=?')
      .run(changed.time, JSON.stringify(changed), before.id),
  );
  const r = await f.call(`${base(before.id)}/reschedules`, f.admin, 'POST', change(preview));
  restore();
  assert.equal(r.status, 409);
  assert.equal(r.data.error, RESCHEDULE_PREVIEW_STALE);
  assert.equal(r.data.rescheduleOutcome, 'not-applied');
  assert.deepEqual(get(f.db, 'appointments', before.id), changed);
  const historical = { ...changed, date: addDays(clinicToday(), -1) };
  other
    .prepare('UPDATE appointments SET date=?,data=? WHERE id=?')
    .run(historical.date, JSON.stringify(historical), before.id);
  assert.equal((await source(f, before.id)).canReschedule, false);
  const legacy = await f.call(base(before.id), f.admin, 'PATCH', {
    date: before.date,
    time: '12:00',
  });
  assert.equal(legacy.status, 200, JSON.stringify(legacy.data));
  assert.equal(legacy.data.time, '12:00');
});

test('immutable success/rejection evidence and source revisions survive restart while ordinary patient projections stay free of command details', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor(),
    before = success(await f.call(route, f.admin, 'POST', f.input(doctor.id))).appointment;
  const preview = await reviewed(f, before.id, move(before)),
    command = change(preview),
    saved = await apply(f, preview, f.admin, command);
  const rejectedCommand = { ...command, requestId: randomUUID() };
  const rejected = await f.call(`${base(before.id)}/reschedules`, f.admin, 'POST', rejectedCommand);
  assert.equal(rejected.data.rescheduleOutcome, 'not-applied');
  const current = await source(f, before.id);
  for (const table of ['appointmentRescheduleEvents', 'appointmentRescheduleCommands']) {
    assert.throws(() => f.db.exec(`UPDATE ${table} SET rowid=rowid`), /immutable/);
    assert.throws(() => f.db.exec(`DELETE FROM ${table}`), /immutable/);
  }
  const patient = await f.login('patient');
  for (const path of ['/appointments', `/patients/${before.patientId}/care-summary`]) {
    const response = await f.call(path, patient);
    assert.equal(response.status, 200);
    for (const token of [
      command.requestId,
      rejectedCommand.requestId,
      saved.event.id,
      preview.revision,
      current.sourceRevision,
    ])
      assert.equal(JSON.stringify(response.data).includes(token), false);
  }
  await f.close();
  const reopened = await fixture(t, f.databasePath);
  assert.equal((await source(reopened, before.id)).sourceRevision, current.sourceRevision);
  const replay = await reopened.call(`${base(before.id)}/reschedules`, f.admin, 'POST', command);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data, saved);
  assert.deepEqual(
    (await reopened.call(`${base(before.id)}/reschedules`, f.admin, 'POST', rejectedCommand)).data,
    rejected.data,
  );
  const plan = reopened.db
    .prepare(
      'EXPLAIN QUERY PLAN SELECT version FROM appointmentMutationVersions WHERE appointmentId=?',
    )
    .all(before.id);
  assert.match(JSON.stringify(plan), /INDEX sqlite_autoindex_appointmentMutationVersions_1/);
});
