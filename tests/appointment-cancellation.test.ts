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
  CANCELLATION_SOURCE_STALE,
  CANCELLATION_REQUEST_COLLISION,
} from '../server/appointment-cancellation.ts';
import type {
  AppointmentCancellationContext,
  AppointmentCancellationInput,
  AppointmentCancellationResult,
} from '../shared/appointment-cancellation.ts';

type Client = { cookie: string; csrf: string; user: User };
const route = '/appointment-bookings';
async function fixture(t: TestContext, existingPath?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'derma-individual-cancellation-'));
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
async function context(
  f: Fixture,
  appointmentId: string,
  who = f.admin,
): Promise<AppointmentCancellationContext> {
  const r = await f.call(`${base(appointmentId)}/cancellation-context`, who);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.headers.get('cache-control')!, /no-store/);
  return r.data;
}
function command(
  source: AppointmentCancellationContext,
  requestId = randomUUID(),
): AppointmentCancellationInput {
  return { expectedRevision: source.revision, cancellationConfirmed: true, requestId };
}
async function cancel(
  f: Fixture,
  source: AppointmentCancellationContext,
  who = f.admin,
  body = command(source),
): Promise<AppointmentCancellationResult> {
  const r = await f.call(`${base(source.appointment.id)}/cancellations`, who, 'POST', body);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}
function cancellationState(f: Fixture) {
  return {
    ...f.state(),
    versions: f.db
      .prepare('SELECT * FROM appointmentMutationVersions ORDER BY appointmentId')
      .all(),
    events: f.db.prepare('SELECT * FROM appointmentCancellationEvents ORDER BY id').all(),
    commands: f.db
      .prepare('SELECT * FROM appointmentCancellationCommands ORDER BY requestId')
      .all(),
    allocations: f.db.prepare('SELECT * FROM resourceAllocationEvents ORDER BY id').all(),
    links: f.db.prepare('SELECT * FROM resourceEventLinks ORDER BY resourceId,eventId').all(),
    reservations: f.db
      .prepare('SELECT * FROM resourceReservations ORDER BY appointmentId,resourceId')
      .all(),
  };
}
async function setResources(f: Fixture, appointmentId: string, resourceIds: string[]) {
  const current = await f.call(`${base(appointmentId)}/resources`, f.admin);
  const r = await f.call(`${base(appointmentId)}/resources`, f.admin, 'PUT', {
    resourceIds,
    reason: 'PRIVATE_CANCELLATION_RESOURCE_REASON',
    expectedRevision: current.data.revision,
    requestId: randomUUID(),
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
}
async function allocate(f: Fixture, appointmentId: string, count = 1) {
  const resources: string[] = [];
  for (let n = 0; n < count; n++) {
    const r = await f.call('/clinic-resources', f.admin, 'POST', {
      name: `Private room ${randomUUID()}`,
      kind: 'room',
      requestId: randomUUID(),
    });
    assert.equal(r.status, 201);
    resources.push(r.data.resource.id);
  }
  await setResources(f, appointmentId, resources);
  return resources;
}
function updateFixtureAppointment(f: Fixture, appointment: Appointment) {
  f.db
    .prepare('UPDATE appointments SET doctorId=?,date=?,time=?,status=?,data=? WHERE id=?')
    .run(
      appointment.doctorId,
      appointment.date,
      appointment.time,
      appointment.status,
      JSON.stringify(appointment),
      appointment.id,
    );
}

test('all staff roles and the owning patient cancel reviewed visits with exact immutable evidence and one notice', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor();
  const users = [
    f.admin,
    await f.account('doctor', { doctorId: doctor.id }),
    await f.account('receptionist'),
    await f.login('patient'),
  ];
  for (const [offset, user] of users.entries()) {
    const booked = success(
      await f.call(
        route,
        f.admin,
        'POST',
        f.input(doctor.id, { date: addDays(clinicToday(), 40 + offset) }),
      ),
    );
    const source = await context(f, booked.appointment.id, user),
      body = command(source);
    assert.equal(source.canCancel, true);
    assert.equal(source.blockedReason, null);
    const result = await cancel(f, source, user, {
      ...body,
      requestId: body.requestId.toUpperCase(),
    });
    assert.deepEqual(result.event.before, source.appointment);
    assert.deepEqual(result.event.after, { ...source.appointment, status: 'cancelled' });
    assert.deepEqual(result.appointment, result.event.after);
    assert.equal(result.event.createdById, user.user.id);
    assert.equal(result.event.createdByRole, user.user.role);
    assert.equal(result.event.cancellationConfirmed, true);
    assert.deepEqual(result.receipt, {
      requestId: body.requestId,
      actorId: user.user.id,
      patientId: source.appointment.patientId,
      appointmentId: source.appointment.id,
      eventId: result.event.id,
      expectedRevision: source.revision,
    });
    const original = cancellationState(f);
    const replay = await f.call(`${base(source.appointment.id)}/cancellations`, user, 'POST', body);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.data, result);
    assert.deepEqual(cancellationState(f), original);
    assert.equal(
      f.db
        .prepare('SELECT COUNT(*) n FROM activity WHERE eventKey=?')
        .get(`appointment-cancelled:${result.event.id}`)!.n,
      1,
    );
    assert.deepEqual(get(f.db, 'appointmentBookings', booked.booking.id), booked.booking);
  }
});

test('eligibility preserves past scheduled patient cancellations and staff checked-in cancellations, while progression/terminal states are blocked', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor(),
    patient = await f.login('patient'),
    staff = await f.account('receptionist');
  let offset = 0;
  for (const who of [patient, staff])
    for (const status of [
      'scheduled',
      'checked-in',
      'in-consultation',
      'completed',
      'cancelled',
      'no-show',
    ] as const) {
      const booked = success(
        await f.call(
          route,
          f.admin,
          'POST',
          f.input(doctor.id, { date: addDays(clinicToday(), 40 + offset++) }),
        ),
      );
      const old = { ...booked.appointment, date: addDays(clinicToday(), -offset), status };
      updateFixtureAppointment(f, old);
      const source = await context(f, old.id, who);
      const expected =
        status === 'scheduled' || (who.user.role !== 'patient' && status === 'checked-in');
      assert.equal(source.canCancel, expected, `${who.user.role} ${status}`);
      const result = await f.call(`${base(old.id)}/cancellations`, who, 'POST', command(source));
      assert.equal(result.status, expected ? 201 : 409);
      if (expected) assert.deepEqual(result.data.appointment, { ...old, status: 'cancelled' });
      else {
        assert.equal(result.data.cancellationOutcome, 'not-applied');
        assert.deepEqual(get(f.db, 'appointments', old.id), old);
      }
    }
});

test('cancellation changes only status even for old omitted duration fields and after doctor fees, labels and booking status change', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor();
  const booked = success(await f.call(route, f.admin, 'POST', f.input(doctor.id)));
  const { durationMinutes: _, durationPolicy: __, ...legacy } = booked.appointment;
  updateFixtureAppointment(f, legacy);
  const source = await context(f, legacy.id);
  f.db
    .prepare('UPDATE doctors SET data=? WHERE id=?')
    .run(JSON.stringify({ ...doctor, name: 'Later clinician label', fee: 999 }), doctor.id);
  await f.accepting(doctor.id, false);
  assert.equal((await context(f, legacy.id)).revision, source.revision);
  const cancelled = await cancel(f, source);
  assert.deepEqual(cancelled.event.after, { ...legacy, status: 'cancelled' });
  assert.equal('durationMinutes' in cancelled.appointment, false);
  assert.equal('durationPolicy' in cancelled.appointment, false);
  assert.equal(cancelled.appointment.fee, 500);
  assert.equal(cancelled.appointment.doctorName, doctor.name);
});

test('strict confirmation/revision/UUID/query schemas and patient ownership prevent false terminal claims', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor(),
    before = success(await f.call(route, f.admin, 'POST', f.input(doctor.id))).appointment;
  const source = await context(f, before.id),
    body = command(source),
    original = cancellationState(f);
  for (const patch of [
    { cancellationConfirmed: undefined },
    { cancellationConfirmed: false },
    { patientConfirmed: true },
    { reason: 'not supported' },
    { expectedRevision: 'bad' },
    { requestId: 'bad' },
    { status: 'cancelled' },
  ]) {
    const response = await f.call(`${base(before.id)}/cancellations`, f.admin, 'POST', {
      ...body,
      ...patch,
    });
    assert.equal(response.status, 400, JSON.stringify(response.data));
    assert.equal(response.data.cancellationOutcome, undefined);
  }
  const stranger = await f.account('patient', { patientId: 'patient-2' });
  for (const [suffix, method, input] of [
    ['cancellation-context', 'GET', undefined],
    ['cancellations', 'POST', body],
  ] as const) {
    assert.equal(
      (await f.call(`${base(before.id)}/${suffix}?extra=1`, f.admin, method, input)).status,
      400,
    );
    assert.equal(
      (await f.call(`${base(before.id)}/${suffix}`, undefined, method, input)).status,
      401,
    );
    const denied = await f.call(`${base(before.id)}/${suffix}`, stranger, method, input);
    assert.equal(denied.status, 403);
    assert.equal(denied.data.cancellationOutcome, undefined);
  }
  for (const key of ['appointments', 'events', 'commands', 'versions'])
    assert.deepEqual(
      cancellationState(f)[key as keyof ReturnType<typeof cancellationState>],
      original[key as keyof ReturnType<typeof cancellationState>],
    );
});

test('legacy appointment ABA and reviewed rescheduling invalidate cancellation sources before any cancellation occurs', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor(),
    before = success(await f.call(route, f.admin, 'POST', f.input(doctor.id))).appointment;
  const source = await context(f, before.id),
    body = command(source);
  assert.equal((await f.call(base(before.id), f.admin, 'PATCH', { time: '10:00' })).status, 200);
  assert.equal(
    (await f.call(base(before.id), f.admin, 'PATCH', { time: before.time })).status,
    200,
  );
  assert.deepEqual(get(f.db, 'appointments', before.id), before);
  const afterABA = await context(f, before.id);
  assert.notEqual(afterABA.revision, source.revision);
  const stale = await f.call(`${base(before.id)}/cancellations`, f.admin, 'POST', body);
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error, CANCELLATION_SOURCE_STALE);
  assert.equal(stale.data.cancellationOutcome, 'not-applied');
  const rescheduleContext = await f.call(`${base(before.id)}/reschedule-context`, f.admin);
  const target = { doctorId: before.doctorId, date: before.date, time: '11:00', mode: before.mode };
  const preview = await f.call(`${base(before.id)}/reschedule-preview`, f.admin, 'POST', {
    ...target,
    expectedSourceRevision: rescheduleContext.data.sourceRevision,
  });
  assert.equal(preview.status, 200);
  assert.equal(
    (
      await f.call(`${base(before.id)}/reschedules`, f.admin, 'POST', {
        ...target,
        expectedRevision: preview.data.revision,
        patientConfirmed: true,
        requestId: randomUUID(),
      })
    ).status,
    201,
  );
  const staleAgain = await f.call(
    `${base(before.id)}/cancellations`,
    f.admin,
    'POST',
    command(afterABA),
  );
  assert.equal(staleAgain.data.error, CANCELLATION_SOURCE_STALE);
  assert.equal(get<Appointment>(f.db, 'appointments', before.id)!.status, 'scheduled');
});

test('resource allocation changes and remove/reassign cycles invalidate context without exposing private resource data', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor(),
    before = success(await f.call(route, f.admin, 'POST', f.input(doctor.id))).appointment;
  const empty = await context(f, before.id),
    resources = await allocate(f, before.id, 2);
  const allocated = await context(f, before.id, await f.login('patient'));
  assert.notEqual(allocated.revision, empty.revision);
  assert.equal(
    (await f.call(`${base(before.id)}/cancellations`, f.admin, 'POST', command(empty))).data
      .cancellationOutcome,
    'not-applied',
  );
  await setResources(f, before.id, []);
  await setResources(f, before.id, resources);
  const restored = await context(f, before.id);
  assert.notEqual(restored.revision, allocated.revision);
  for (const secret of [...resources, 'PRIVATE_CANCELLATION_RESOURCE_REASON'])
    assert.equal(JSON.stringify(restored).includes(secret), false);
  for (const key of ['reservationCount', 'resources', 'resourceIds', 'allocationHead'])
    assert.equal(key in restored, false);
  const currentResource = await f.call(`/clinic-resources/${resources[0]}`, f.admin);
  assert.equal(
    (
      await f.call(`/clinic-resources/${resources[0]}`, f.admin, 'PATCH', {
        name: 'Renamed resource unrelated to cancellation',
        expectedRevision: currentResource.data.resource.revision,
        reason: 'Private rename',
        requestId: randomUUID(),
      })
    ).status,
    200,
  );
  assert.equal((await context(f, before.id)).revision, restored.revision);
  const cancelled = await cancel(f, restored);
  assert.deepEqual(
    f.db.prepare('SELECT * FROM resourceReservations WHERE appointmentId=?').all(before.id),
    [],
  );
  const history = await f.call(`${base(before.id)}/resources`, f.admin);
  assert.deepEqual(history.data.resourceIds, []);
  assert.equal(history.data.history[0].source, 'appointment-status');
  assert.equal(history.data.history[0].after.appointment.status, 'cancelled');
  for (const secret of [...resources, 'PRIVATE_CANCELLATION_RESOURCE_REASON'])
    assert.equal(JSON.stringify(cancelled).includes(secret), false);
});

test('resource release preserves booking/waitlist, clinical procedure and invoice source records', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor(),
    bookingInput = f.input(doctor.id);
  const waitingId = await f.waiting(bookingInput);
  const booking = success(
    await f.call(route, f.admin, 'POST', {
      ...bookingInput,
      waitlistId: waitingId,
      patientConfirmed: true,
    }),
  );
  const before = booking.appointment;
  await allocate(f, before.id);
  const procedure = await f.call('/procedures', f.admin, 'POST', {
    patientId: before.patientId,
    appointmentId: before.id,
    title: 'Synthetic planned procedure',
    indication: 'Synthetic indication',
    benefits: 'Discussed benefits',
    risks: 'Discussed risks',
    alternatives: 'Discussed alternatives',
    aftercare: 'Discussed aftercare',
  });
  assert.equal(procedure.status, 201, JSON.stringify(procedure.data));
  const invoice = await f.call('/invoices', f.admin, 'POST', {
    patientId: before.patientId,
    procedureId: procedure.data.id,
    items: [{ description: 'Agreed synthetic charge', quantity: 1, unitAmountPaise: 12300 }],
  });
  assert.equal(invoice.status, 201);
  const names = [
    'appointmentBookings',
    'waitlistRequests',
    'waitlistEvents',
    'procedures',
    'invoices',
    'payments',
  ];
  const snapshot = Object.fromEntries(
    names.map((table) => [table, f.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]),
  );
  await cancel(f, await context(f, before.id));
  for (const table of names)
    assert.deepEqual(
      f.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
      snapshot[table],
      table,
    );
  assert.equal(
    (await f.call(`/invoices/${invoice.data.id}`, f.admin)).data.invoice.totalPaise,
    12300,
  );
  const waitlist = await f.call('/waitlist', f.admin);
  assert.equal(
    waitlist.data.find((entry: { id: string }) => entry.id === waitingId).status,
    'booked',
  );
});

test('durable stale and blocked rejections cannot apply after eligibility changes; revised payload, actor and target IDs collide', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor(),
    patient = await f.login('patient');
  const before = success(await f.call(route, f.admin, 'POST', f.input(doctor.id))).appointment;
  const second = success(
    await f.call(route, f.admin, 'POST', f.input(doctor.id, { date: addDays(before.date, 1) })),
  ).appointment;
  updateFixtureAppointment(f, { ...before, status: 'checked-in' });
  const checkedIn = await context(f, before.id, patient),
    body = command(checkedIn);
  const rejected = await f.call(`${base(before.id)}/cancellations`, patient, 'POST', body);
  assert.equal(rejected.status, 409);
  assert.deepEqual(rejected.data, {
    error: checkedIn.blockedReason,
    cancellationOutcome: 'not-applied',
    requestId: body.requestId,
    actorId: patient.user.id,
    patientId: before.patientId,
    appointmentId: before.id,
  });
  updateFixtureAppointment(f, before);
  const current = await context(f, before.id, patient);
  assert.equal(current.canCancel, true);
  const previous = cancellationState(f);
  assert.deepEqual(
    (await f.call(`${base(before.id)}/cancellations`, patient, 'POST', body)).data,
    rejected.data,
  );
  assert.deepEqual(cancellationState(f), previous);
  for (const [appointmentId, who, changed] of [
    [before.id, patient, { ...body, expectedRevision: current.revision }],
    [before.id, f.admin, body],
    [second.id, patient, body],
  ] as const) {
    const r = await f.call(`${base(appointmentId)}/cancellations`, who, 'POST', changed);
    assert.equal(r.status, 409);
    assert.equal(r.data.error, CANCELLATION_REQUEST_COLLISION);
    assert.equal(r.data.cancellationOutcome, undefined);
  }
  await cancel(f, current, patient);
});

test('clock progression and current clinician metadata do not invalidate reviewed cancellation or original exact replay', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor(),
    before = success(await f.call(route, f.admin, 'POST', f.input(doctor.id))).appointment;
  const source = await context(f, before.id),
    body = command(source);
  const RealDate = Date,
    later = Date.parse(`${addDays(before.date, 400)}T12:00:00Z`);
  f.db.prepare('UPDATE sessions SET expiresAt=?').run(later + 86400000);
  class LaterDate extends RealDate {
    constructor(...args: ConstructorParameters<typeof Date>) {
      if (args.length) super(...args);
      else super(later);
    }
    static now() {
      return later;
    }
  }
  globalThis.Date = LaterDate as DateConstructor;
  try {
    const stillValid = await context(f, before.id);
    assert.equal(stillValid.revision, source.revision);
    assert.equal(stillValid.canCancel, true);
    const saved = await cancel(f, source, f.admin, body);
    assert.ok(
      Date.parse(saved.event.createdAt) > Date.parse(`${before.date}T${before.time}:00+05:30`),
    );
    const replay = await f.call(`${base(before.id)}/cancellations`, f.admin, 'POST', body);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.data, saved);
    assert.equal((await context(f, before.id)).canCancel, false);
  } finally {
    globalThis.Date = RealDate;
  }
});

test('fresh current account/session/CSRF/MFA/ownership guards apply to context, new commits and both success/rejection retries', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor(),
    before = success(await f.call(route, f.admin, 'POST', f.input(doctor.id))).appointment;
  const second = success(
    await f.call(route, f.admin, 'POST', f.input(doctor.id, { date: addDays(before.date, 1) })),
  ).appointment;
  const source = await context(f, before.id),
    successBody = command(source);
  await cancel(f, source, f.admin, successBody);
  const secondSource = await context(f, second.id),
    newBody = command(secondSource),
    rejectedBody = { ...newBody, expectedRevision: 'a'.repeat(64), requestId: randomUUID() };
  assert.equal(
    (await f.call(`${base(second.id)}/cancellations`, f.admin, 'POST', rejectedBody)).data
      .cancellationOutcome,
    'not-applied',
  );
  const other = openDatabase(f.databasePath);
  t.after(() => other.close());
  const rawUser = f.db.prepare('SELECT data FROM users WHERE id=?').get(f.admin.user.id)!
    .data as string;
  const sessions = f.db.prepare('SELECT * FROM sessions WHERE userId=?').all(f.admin.user.id);
  const changes: Array<{ status: number; apply: () => void }> = [
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
  for (const [path, method, body] of [
    [`${base(second.id)}/cancellation-context`, 'GET', undefined],
    [`${base(second.id)}/cancellations`, 'POST', newBody],
    [`${base(before.id)}/cancellations`, 'POST', successBody],
    [`${base(second.id)}/cancellations`, 'POST', rejectedBody],
  ] as const)
    for (const change of changes) {
      const original = cancellationState(f),
        restore = f.beforeLock(change.apply);
      const r = await f.call(path, f.admin, method, body);
      restore();
      assert.equal(r.status, change.status, `${method} ${path}: ${JSON.stringify(r.data)}`);
      assert.equal(r.data.cancellationOutcome, undefined);
      assert.deepEqual(cancellationState(f), original);
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

test('separate application connections serialize identical and competing cancellation requests with one counter/event/notification', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor(),
    before = success(await f.call(route, f.admin, 'POST', f.input(doctor.id))).appointment;
  await allocate(f, before.id);
  const source = await context(f, before.id),
    body = command(source),
    other = await fixture(t, f.databasePath);
  const responses = await Promise.all([
    f.call(`${base(before.id)}/cancellations`, f.admin, 'POST', body),
    other.call(`${base(before.id)}/cancellations`, f.admin, 'POST', body),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 201]);
  assert.deepEqual(responses[0].data, responses[1].data);
  assert.equal(
    f.db
      .prepare('SELECT version FROM appointmentMutationVersions WHERE appointmentId=?')
      .get(before.id)!.version,
    1,
  );
  const second = success(
    await f.call(route, f.admin, 'POST', f.input(doctor.id, { date: addDays(before.date, 1) })),
  ).appointment;
  const next = await context(f, second.id);
  const competing = await Promise.all([
    f.call(`${base(second.id)}/cancellations`, f.admin, 'POST', command(next)),
    other.call(`${base(second.id)}/cancellations`, f.admin, 'POST', command(next)),
  ]);
  assert.deepEqual(competing.map((r) => r.status).sort(), [201, 409]);
  assert.equal(competing.find((r) => r.status === 409)!.data.cancellationOutcome, 'not-applied');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM appointmentCancellationEvents').get()!.n, 2);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM appointmentCancellationCommands').get()!.n, 3);
  assert.equal(
    f.db
      .prepare('SELECT COUNT(*) n FROM activity WHERE eventKey=?')
      .get(`appointment-cancelled:${responses[0].data.event.id}`)!.n,
    1,
  );
});

test('resource release, appointment counter, immutable evidence, audit and notice failures roll back all effects without definitive rejection', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor(),
    before = success(await f.call(route, f.admin, 'POST', f.input(doctor.id))).appointment;
  await allocate(f, before.id, 2);
  const source = await context(f, before.id),
    body = command(source);
  const failures = [
    ['resourceAllocationEvents', 'INSERT', '1'],
    ['resourceReservations', 'DELETE', '1'],
    ['resourceEventLinks', 'INSERT', '1'],
    ['appointments', 'UPDATE', '1'],
    ['appointmentMutationVersions', 'INSERT', '1'],
    ['appointmentCancellationEvents', 'INSERT', '1'],
    ['appointmentCancellationCommands', 'INSERT', '1'],
    ['audit', 'INSERT', "json_extract(NEW.data,'$.action')='appointment cancelled'"],
    ['activity', 'INSERT', '1'],
  ];
  for (const [table, operation, condition] of failures) {
    const original = cancellationState(f);
    f.db.exec(
      `CREATE TRIGGER cancellation_injected_failure BEFORE ${operation} ON ${table} WHEN ${condition} BEGIN SELECT RAISE(ABORT,'Synthetic cancellation rollback'); END;`,
    );
    const r = await f.call(`${base(before.id)}/cancellations`, f.admin, 'POST', body);
    f.db.exec('DROP TRIGGER cancellation_injected_failure');
    assert.equal(r.status, 500, `${table}: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.cancellationOutcome, undefined);
    assert.deepEqual(cancellationState(f), original, table);
  }
  await cancel(f, source, f.admin, body);
});

test('read audit and durable-rejection receipt failures return unknown outcomes without partial state', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor(),
    before = success(await f.call(route, f.admin, 'POST', f.input(doctor.id))).appointment;
  const source = await context(f, before.id),
    original = cancellationState(f);
  f.db.exec(
    "CREATE TRIGGER cancellation_read_failure BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT,'Synthetic cancellation context audit'); END;",
  );
  const read = await f.call(`${base(before.id)}/cancellation-context`, f.admin);
  f.db.exec('DROP TRIGGER cancellation_read_failure');
  assert.equal(read.status, 500);
  assert.deepEqual(cancellationState(f), original);
  const body = { ...command(source), expectedRevision: 'a'.repeat(64) };
  f.db.exec(
    "CREATE TRIGGER cancellation_rejection_failure BEFORE INSERT ON appointmentCancellationCommands WHEN NEW.rejection IS NOT NULL BEGIN SELECT RAISE(ABORT,'Synthetic cancellation rejection failure'); END;",
  );
  const rejected = await f.call(`${base(before.id)}/cancellations`, f.admin, 'POST', body);
  f.db.exec('DROP TRIGGER cancellation_rejection_failure');
  assert.equal(rejected.status, 500);
  assert.equal(rejected.data.cancellationOutcome, undefined);
  assert.deepEqual(cancellationState(f), original);
  assert.equal(
    (await f.call(`${base(before.id)}/cancellations`, f.admin, 'POST', body)).data
      .cancellationOutcome,
    'not-applied',
  );
});

test('external source changes before the write lock are rejected, and cancellation cannot overwrite a changed visit', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor(),
    before = success(await f.call(route, f.admin, 'POST', f.input(doctor.id))).appointment;
  const source = await context(f, before.id),
    other = openDatabase(f.databasePath);
  t.after(() => other.close());
  const changed = { ...before, time: '10:00' };
  const restore = f.beforeLock(() =>
    other
      .prepare('UPDATE appointments SET time=?,data=? WHERE id=?')
      .run(changed.time, JSON.stringify(changed), before.id),
  );
  const r = await f.call(`${base(before.id)}/cancellations`, f.admin, 'POST', command(source));
  restore();
  assert.equal(r.status, 409);
  assert.equal(r.data.error, CANCELLATION_SOURCE_STALE);
  assert.equal(r.data.cancellationOutcome, 'not-applied');
  assert.deepEqual(get(f.db, 'appointments', before.id), changed);
  const newSource = await context(f, before.id);
  const current = await cancel(f, newSource);
  assert.equal(current.event.before.time, '10:00');
});

test('immutable success and terminal rejected commands survive restart, while ordinary patient projections remain free of cancellation metadata', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor(),
    before = success(await f.call(route, f.admin, 'POST', f.input(doctor.id))).appointment;
  const source = await context(f, before.id),
    body = command(source),
    saved = await cancel(f, source, f.admin, body);
  const rejectBody = command(source);
  const rejected = await f.call(`${base(before.id)}/cancellations`, f.admin, 'POST', rejectBody);
  assert.equal(rejected.data.cancellationOutcome, 'not-applied');
  const current = await context(f, before.id);
  for (const table of ['appointmentCancellationEvents', 'appointmentCancellationCommands']) {
    assert.throws(() => f.db.exec(`UPDATE ${table} SET rowid=rowid`), /immutable/);
    assert.throws(() => f.db.exec(`DELETE FROM ${table}`), /immutable/);
  }
  const patient = await f.login('patient');
  for (const path of [
    '/appointments',
    `/patients/${before.patientId}/care-summary`,
    `${base(before.id)}/calendar`,
  ]) {
    const response = await f.call(path, patient);
    assert.equal(response.status, 200);
    for (const token of [
      body.requestId,
      rejectBody.requestId,
      saved.event.id,
      source.revision,
      current.revision,
    ])
      assert.equal(JSON.stringify(response.data).includes(token), false);
  }
  await f.close();
  const reopened = await fixture(t, f.databasePath);
  assert.equal((await context(reopened, before.id)).revision, current.revision);
  const replay = await reopened.call(`${base(before.id)}/cancellations`, f.admin, 'POST', body);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data, saved);
  assert.deepEqual(
    (await reopened.call(`${base(before.id)}/cancellations`, f.admin, 'POST', rejectBody)).data,
    rejected.data,
  );
  const plan = reopened.db
    .prepare(
      'EXPLAIN QUERY PLAN SELECT actorId,eventId,rejection FROM appointmentCancellationCommands WHERE requestId=?',
    )
    .all(body.requestId);
  assert.match(JSON.stringify(plan), /INDEX sqlite_autoindex_appointmentCancellationCommands_1/);
});
