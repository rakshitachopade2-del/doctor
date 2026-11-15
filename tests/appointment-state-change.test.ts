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
  STATE_CHANGE_SOURCE_STALE,
  STATE_CHANGE_REQUEST_COLLISION,
} from '../server/appointment-state-change.ts';
import type {
  AppointmentStateChangeContext,
  AppointmentStateChangeInput,
  AppointmentStateChangeResult,
  AppointmentStateChangeStatus,
} from '../shared/appointment-state-change.ts';

type Client = { cookie: string; csrf: string; user: User };
const route = '/appointment-bookings';
async function fixture(t: TestContext, existingPath?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'derma-appointment-state-'));
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
const statuses = ['checked-in', 'in-consultation', 'completed', 'no-show'] as const;
const sourceStatuses = [
  'scheduled',
  'checked-in',
  'in-consultation',
  'completed',
  'cancelled',
  'no-show',
] as const;
function stored(f: Fixture, doctorId: string, overrides: Partial<Appointment> = {}) {
  const value: Appointment = {
    id: randomUUID(),
    patientId: 'patient-ananya',
    patientName: 'Original synthetic patient',
    doctorId,
    doctorName: 'Original synthetic clinician',
    date: addDays(clinicToday(), -1),
    time: '09:00',
    mode: 'in-person',
    reason: 'Original ordinary visit reason',
    status: 'scheduled',
    fee: 650,
    durationMinutes: 30,
    durationPolicy: 'schedule',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
  f.db
    .prepare(
      'INSERT INTO appointments(id,patientId,doctorId,date,time,status,data) VALUES (?,?,?,?,?,?,?)',
    )
    .run(
      value.id,
      value.patientId,
      value.doctorId,
      value.date,
      value.time,
      value.status,
      JSON.stringify(value),
    );
  return value;
}
function update(f: Fixture, value: Appointment) {
  f.db
    .prepare('UPDATE appointments SET doctorId=?,date=?,time=?,status=?,data=? WHERE id=?')
    .run(value.doctorId, value.date, value.time, value.status, JSON.stringify(value), value.id);
}
async function context(
  f: Fixture,
  id: string,
  who = f.admin,
): Promise<AppointmentStateChangeContext> {
  const r = await f.call(`${base(id)}/state-context`, who);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.headers.get('cache-control')!, /no-store/);
  return r.data;
}
function command(
  source: AppointmentStateChangeContext,
  status: AppointmentStateChangeStatus,
  requestId = randomUUID(),
): AppointmentStateChangeInput {
  return { status, expectedRevision: source.revision, changeConfirmed: true, requestId };
}
async function apply(
  f: Fixture,
  source: AppointmentStateChangeContext,
  status: AppointmentStateChangeStatus,
  who = f.admin,
  body = command(source, status),
): Promise<AppointmentStateChangeResult> {
  const r = await f.call(`${base(source.appointment.id)}/state-changes`, who, 'POST', body);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}
function state(f: Fixture) {
  return Object.fromEntries(
    [
      'appointments',
      'appointmentMutationVersions',
      'appointmentStateChangeEvents',
      'appointmentStateChangeCommands',
      'resourceReservations',
      'resourceAllocationEvents',
      'resourceEventLinks',
      'audit',
      'activity',
    ].map((table) => [table, f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
  );
}
async function setResources(f: Fixture, id: string, resourceIds: string[]) {
  const c = await f.call(`${base(id)}/resources`, f.admin);
  const r = await f.call(`${base(id)}/resources`, f.admin, 'PUT', {
    resourceIds,
    reason: 'PRIVATE_STATE_CHANGE_RESOURCE_REASON',
    expectedRevision: c.data.revision,
    requestId: randomUUID(),
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
}
async function allocate(f: Fixture, id: string, count = 1) {
  const ids: string[] = [];
  for (let n = 0; n < count; n++) {
    const r = await f.call('/clinic-resources', f.admin, 'POST', {
      name: `Private room ${randomUUID()}`,
      kind: 'room',
      requestId: randomUUID(),
    });
    assert.equal(r.status, 201);
    ids.push(r.data.resource.id);
  }
  await setResources(f, id, ids);
  return ids;
}
function clock(t: TestContext, f: Fixture, initial: string) {
  const OriginalDate = Date;
  let now = OriginalDate.parse(initial);
  class ControlledDate extends OriginalDate {
    constructor(...args: ConstructorParameters<typeof Date>) {
      if (args.length) super(...args);
      else super(now);
    }
    static now() {
      return now;
    }
  }
  globalThis.Date = ControlledDate as DateConstructor;
  f.db.prepare('UPDATE sessions SET expiresAt=?').run(OriginalDate.parse('2099-01-01T00:00:00Z'));
  t.after(() => {
    globalThis.Date = OriginalDate;
  });
  return (value: string | number) => {
    now = typeof value === 'number' ? value : OriginalDate.parse(value);
  };
}

test('all staff roles receive explicit actions and exact status-only evidence; retries preserve the original after later progression', async (t) => {
  const f = await fixture(t),
    d = await f.doctor(),
    doctor = await f.account('doctor', { doctorId: d.id }),
    reception = await f.account('receptionist');
  const a = stored(f, d.id),
    initial = await context(f, a.id, reception);
  assert.deepEqual(
    initial.actions.map((x) => x.status),
    statuses,
  );
  assert.deepEqual(
    initial.actions.filter((x) => x.allowed).map((x) => x.status),
    ['checked-in', 'no-show'],
  );
  assert.equal(
    initial.actions.find((x) => x.status === 'in-consultation')!.blockedReason,
    'Only a clinician can start or complete a consultation.',
  );
  const checkedBody = command(initial, 'checked-in'),
    checked = await apply(f, initial, 'checked-in', reception, {
      ...checkedBody,
      requestId: checkedBody.requestId.toUpperCase(),
    });
  for (const [who, status] of [
    [doctor, 'in-consultation'],
    [f.admin, 'completed'],
  ] as const) {
    const c = await context(f, a.id, who),
      body = command(c, status),
      r = await apply(f, c, status, who, body);
    assert.deepEqual(r.event.before, c.appointment);
    assert.deepEqual(r.event.after, { ...c.appointment, status });
    assert.deepEqual(r.receipt, {
      requestId: body.requestId,
      actorId: who.user.id,
      patientId: a.patientId,
      appointmentId: a.id,
      eventId: r.event.id,
      expectedRevision: c.revision,
      status,
    });
    assert.equal(r.event.createdById, who.user.id);
    assert.equal(r.event.createdByRole, who.user.role);
    assert.equal(r.event.changeConfirmed, true);
    assert.equal(
      f.db
        .prepare('SELECT COUNT(*) n FROM activity WHERE eventKey=?')
        .get(`appointment-state-changed:${r.event.id}`)!.n,
      1,
    );
  }
  const original = state(f),
    replayed = await f.call(`${base(a.id)}/state-changes`, reception, 'POST', checkedBody);
  assert.equal(replayed.status, 200);
  assert.deepEqual(replayed.data.event, checked.event);
  assert.deepEqual(replayed.data.receipt, checked.receipt);
  assert.equal(replayed.data.appointment.status, 'completed');
  assert.deepEqual(state(f), original);
  const noShow = stored(f, d.id, { date: addDays(clinicToday(), -2) });
  const result = await apply(f, await context(f, noShow.id, reception), 'no-show', reception);
  assert.deepEqual(result.event.after, { ...noShow, status: 'no-show' });
});

test('state transition and role matrix preserves legacy clinical authority without doctor assignment or linked-admin requirements', async (t) => {
  const f = await fixture(t),
    d = await f.doctor(),
    otherDoctor = await f.account('doctor', { doctorId: 'doctor-meera' }),
    admin = await f.account('admin'),
    reception = await f.account('receptionist');
  let offset = 1;
  const permitted: Record<AppointmentStateChangeStatus, Appointment['status']> = {
    'checked-in': 'scheduled',
    'in-consultation': 'checked-in',
    completed: 'in-consultation',
    'no-show': 'scheduled',
  };
  for (const who of [admin, otherDoctor, reception])
    for (const status of sourceStatuses) {
      const a = stored(f, d.id, { date: addDays(clinicToday(), -offset++), status }),
        c = await context(f, a.id, who);
      for (const action of c.actions) {
        const roleAllowed =
          who.user.role !== 'receptionist' ||
          !['in-consultation', 'completed'].includes(action.status);
        assert.equal(
          action.allowed,
          roleAllowed && permitted[action.status] === status,
          `${who.user.role}/${status}/${action.status}`,
        );
        assert.equal(action.blockedReason === null, action.allowed);
        if (!action.allowed) {
          const r = await f.call(
            `${base(a.id)}/state-changes`,
            who,
            'POST',
            command(c, action.status),
          );
          assert.equal(r.status, roleAllowed ? 409 : 403);
          assert.equal(r.data.stateChangeOutcome, roleAllowed ? 'not-applied' : undefined);
        }
      }
      const permittedAction = c.actions.find((x) => x.allowed);
      if (permittedAction) await apply(f, c, permittedAction.status, who);
    }
});

test('IST day and exact no-show boundaries are coherent, while same-day early check-in/start/completion and past actions remain allowed', async (t) => {
  const f = await fixture(t),
    d = await f.doctor(),
    setTime = clock(t, f, '2036-06-02T18:29:59.999Z'); // 23:59:59.999 IST
  const next = stored(f, d.id, { date: '2036-06-03', time: '00:00' }),
    before = await context(f, next.id);
  assert.equal(before.clinicDate, '2036-06-02');
  assert.equal(before.generatedAt, '2036-06-02T18:29:59.999Z');
  assert.ok(before.actions.every((a) => !a.allowed));
  const rejected = command(before, 'checked-in'),
    r = await f.call(`${base(next.id)}/state-changes`, f.admin, 'POST', rejected);
  assert.equal(r.status, 400);
  assert.equal(r.data.stateChangeOutcome, 'not-applied');
  setTime('2036-06-02T18:30:00.000Z');
  const midnight = await context(f, next.id);
  assert.equal(midnight.clinicDate, '2036-06-03');
  assert.equal(midnight.revision, before.revision);
  assert.equal(midnight.actions.find((x) => x.status === 'no-show')!.allowed, true);
  assert.deepEqual(
    (await f.call(`${base(next.id)}/state-changes`, f.admin, 'POST', rejected)).data,
    r.data,
  );
  await apply(f, midnight, 'checked-in');
  const early = stored(f, d.id, { date: '2036-06-03', time: '23:00' }),
    earlyContext = await context(f, early.id);
  assert.equal(earlyContext.actions.find((x) => x.status === 'checked-in')!.allowed, true);
  assert.equal(earlyContext.actions.find((x) => x.status === 'no-show')!.allowed, false);
  for (const status of ['checked-in', 'in-consultation', 'completed'] as const)
    await apply(f, await context(f, early.id), status);
  const boundary = stored(f, d.id, { date: '2036-06-03', time: '12:00' });
  setTime('2036-06-03T06:29:59.999Z');
  const justBefore = await context(f, boundary.id);
  assert.equal(justBefore.actions.find((x) => x.status === 'no-show')!.allowed, false);
  setTime('2036-06-03T06:30:00.000Z');
  const atStart = await context(f, boundary.id);
  assert.equal(atStart.revision, justBefore.revision);
  assert.equal(atStart.actions.find((x) => x.status === 'no-show')!.allowed, true);
  await apply(f, atStart, 'no-show');
});

test('all ordinary booked fields and absent legacy duration values survive, independent of profile fees, pause and catalogue metadata', async (t) => {
  const f = await fixture(t),
    d = await f.doctor(),
    a = stored(f, d.id, { durationMinutes: undefined, durationPolicy: undefined }),
    c = await context(f, a.id);
  f.db
    .prepare('UPDATE doctors SET data=? WHERE id=?')
    .run(JSON.stringify({ ...d, name: 'Later clinician name', fee: 999 }), d.id);
  await f.accepting(d.id, false);
  assert.equal((await context(f, a.id)).revision, c.revision);
  const r = await apply(f, c, 'checked-in');
  assert.deepEqual(r.event.after, { ...c.appointment, status: 'checked-in' });
  assert.equal('durationMinutes' in r.appointment, false);
  assert.equal('durationPolicy' in r.appointment, false);
  assert.equal(r.appointment.fee, 650);
  const custom = stored(f, d.id, {
    date: addDays(clinicToday(), -2),
    durationPolicy: 'custom',
    durationMinutes: 90,
    mode: 'online',
  });
  const result = await apply(f, await context(f, custom.id), 'no-show');
  assert.deepEqual(result.event.after, { ...custom, status: 'no-show' });
});

test('strict input/query validation and private staff access never manufacture terminal failure evidence', async (t) => {
  const f = await fixture(t),
    d = await f.doctor(),
    a = stored(f, d.id),
    c = await context(f, a.id),
    body = command(c, 'checked-in'),
    patient = await f.login('patient');
  for (const patch of [
    { changeConfirmed: false },
    { changeConfirmed: undefined },
    { patientConfirmed: true },
    { reason: 'no reason supported' },
    { status: 'cancelled' },
    { status: 'scheduled' },
    { status: 'bad' },
    { expectedRevision: 'x' },
    { requestId: 'x' },
  ]) {
    const r = await f.call(`${base(a.id)}/state-changes`, f.admin, 'POST', { ...body, ...patch });
    assert.equal(r.status, 400);
    assert.equal(r.data.stateChangeOutcome, undefined);
  }
  for (const [suffix, method, input] of [
    ['state-context', 'GET', undefined],
    ['state-changes', 'POST', body],
  ] as const) {
    for (const who of [undefined, patient]) {
      const r = await f.call(`${base(a.id)}/${suffix}`, who, method, input);
      assert.equal(r.status, who ? 403 : 401);
      assert.equal(r.data.stateChangeOutcome, undefined);
    }
    assert.equal(
      (await f.call(`${base(a.id)}/${suffix}?unknown=1`, f.admin, method, input)).status,
      400,
    );
    assert.equal(
      (await f.call(`${base('missing')}/${suffix}`, f.admin, method, input)).status,
      404,
    );
  }
  const noCSRF = await f.call(
    `${base(a.id)}/state-changes`,
    { ...f.admin, csrf: 'wrong' },
    'POST',
    body,
  );
  assert.equal(noCSRF.status, 403);
  assert.equal(noCSRF.data.stateChangeOutcome, undefined);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM appointmentStateChangeCommands').get()!.n, 0);
});

test('appointment ABA from legacy writers and resource allocation cycles invalidate review without coupling unrelated profile or maintenance data', async (t) => {
  const f = await fixture(t),
    d = await f.doctor(),
    setTime = clock(t, f, '2036-06-03T03:30:00.000Z'); // 09:00 IST
  const a = stored(f, d.id, { date: '2036-06-03', time: '11:00' }),
    c = await context(f, a.id),
    body = command(c, 'checked-in');
  assert.equal((await f.call(base(a.id), f.admin, 'PATCH', { time: '11:30' })).status, 200);
  assert.equal((await f.call(base(a.id), f.admin, 'PATCH', { time: a.time })).status, 200);
  const stale = await f.call(`${base(a.id)}/state-changes`, f.admin, 'POST', body);
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error, STATE_CHANGE_SOURCE_STALE);
  assert.equal(stale.data.stateChangeOutcome, 'not-applied');
  const beforeResources = await context(f, a.id),
    ids = await allocate(f, a.id, 2);
  const staleResources = await f.call(
    `${base(a.id)}/state-changes`,
    f.admin,
    'POST',
    command(beforeResources, 'checked-in'),
  );
  assert.equal(staleResources.data.error, STATE_CHANGE_SOURCE_STALE);
  const allocated = await context(f, a.id);
  await setResources(f, a.id, []);
  await setResources(f, a.id, ids);
  assert.notEqual((await context(f, a.id)).revision, allocated.revision);
  const latest = await context(f, a.id),
    resource = await f.call(`/clinic-resources/${ids[0]}`, f.admin);
  const changed = await f.call(`/clinic-resources/${ids[0]}`, f.admin, 'PATCH', {
    name: 'PRIVATE_NEW_RESOURCE_NAME',
    active: true,
    reason: 'Private rename',
    expectedRevision: resource.data.resource.revision,
    requestId: randomUUID(),
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  assert.equal((await context(f, a.id)).revision, latest.revision);
  await f.accepting(d.id, false);
  assert.equal((await context(f, a.id)).revision, latest.revision);
  const r = await apply(f, latest, 'checked-in');
  assert.equal(
    f.db.prepare('SELECT COUNT(*) n FROM resourceReservations WHERE appointmentId=?').get(a.id)!.n,
    2,
  );
  assert.ok(!JSON.stringify(r).includes('PRIVATE_'));
  assert.ok(!JSON.stringify(r).includes(ids[0]));
  setTime('2036-06-03T06:00:00.000Z');
});

test('check-in/start/completion retain recorded intervals and no-show releases claims without mutating procedure, billing, waitlist or booking origins', async (t) => {
  const f = await fixture(t),
    d = await f.doctor(),
    setTime = clock(t, f, '2036-06-03T03:30:00.000Z');
  const booked = success(
      await f.call(route, f.admin, 'POST', f.input(d.id, { date: '2036-06-03', time: '11:00' })),
    ),
    a = booked.appointment;
  const ids = await allocate(f, a.id, 2),
    claims = f.db
      .prepare(
        'SELECT resourceId,startAt,endAt FROM resourceReservations WHERE appointmentId=? ORDER BY resourceId',
      )
      .all(a.id);
  const procedure = await f.call('/procedures', f.admin, 'POST', {
    patientId: a.patientId,
    appointmentId: a.id,
    title: 'Synthetic procedure',
    indication: 'Patient-specific',
    benefits: 'Discussed',
    risks: 'Discussed',
    alternatives: 'Discussed',
    aftercare: 'Clinician instructions',
  });
  assert.equal(procedure.status, 201, JSON.stringify(procedure.data));
  const invoice = await f.call('/invoices', f.admin, 'POST', {
    patientId: a.patientId,
    procedureId: procedure.data.id,
    items: [{ description: 'Synthetic', quantity: 1, unitAmountPaise: 10000 }],
  });
  assert.equal(invoice.status, 201);
  const domain = () =>
    Object.fromEntries(
      [
        'procedures',
        'procedureAgreements',
        'invoices',
        'payments',
        'waitlistEvents',
        'appointmentBookings',
        'appointmentBookingCommands',
      ].map((table) => [table, f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
    );
  const domainBefore = domain();
  for (const status of ['checked-in', 'in-consultation', 'completed'] as const) {
    const result = await apply(f, await context(f, a.id), status);
    assert.deepEqual(
      f.db
        .prepare(
          'SELECT resourceId,startAt,endAt FROM resourceReservations WHERE appointmentId=? ORDER BY resourceId',
        )
        .all(a.id),
      claims,
    );
    assert.equal(
      JSON.parse(
        String(
          f.db
            .prepare(
              'SELECT data FROM resourceAllocationEvents WHERE appointmentId=? ORDER BY rowid DESC LIMIT 1',
            )
            .get(a.id)!.data,
        ),
      ).after.appointment.status,
      status,
    );
    const item = f.db
      .prepare('SELECT data FROM activity WHERE eventKey=?')
      .get(`appointment-state-changed:${result.event.id}`)!;
    assert.equal(JSON.parse(String(item.data)).href, '/my-care/record?tab=visits');
  }
  assert.deepEqual(domain(), domainBefore);
  const noShow = stored(f, d.id, {
    date: '2036-06-03',
    time: '12:00',
    durationMinutes: 90,
    durationPolicy: 'custom',
  });
  await setResources(f, noShow.id, ids);
  setTime('2036-06-03T06:30:00.000Z');
  const done = await apply(f, await context(f, noShow.id), 'no-show');
  assert.equal(
    f.db
      .prepare('SELECT COUNT(*) n FROM resourceReservations WHERE appointmentId=?')
      .get(noShow.id)!.n,
    0,
  );
  assert.deepEqual(done.event.after, { ...noShow, status: 'no-show' });
  const next = stored(f, d.id, { date: '2036-06-03', time: '12:30', patientId: 'patient-2' });
  await setResources(f, next.id, ids);
  assert.deepEqual(domain(), domainBefore);
});

test('durable rejections cannot later apply and UUID actor, target-status, appointment and revision collisions never return a definitive marker', async (t) => {
  const f = await fixture(t),
    d = await f.doctor(),
    a = stored(f, d.id, { status: 'checked-in' }),
    source = await context(f, a.id),
    body = command(source, 'no-show');
  const rejected = await f.call(`${base(a.id)}/state-changes`, f.admin, 'POST', body);
  assert.equal(rejected.status, 409);
  assert.equal(rejected.data.stateChangeOutcome, 'not-applied');
  update(f, { ...a, status: 'scheduled' });
  assert.deepEqual(
    (await f.call(`${base(a.id)}/state-changes`, f.admin, 'POST', body)).data,
    rejected.data,
  );
  const next = await context(f, a.id),
    freshBody = command(next, 'checked-in'),
    saved = await apply(f, next, 'checked-in', f.admin, freshBody),
    other = stored(f, d.id, { date: addDays(clinicToday(), -2) }),
    colleague = await f.account('admin');
  for (const [id, who, changed] of [
    [a.id, f.admin, { ...freshBody, status: 'no-show' }],
    [a.id, f.admin, { ...freshBody, expectedRevision: 'a'.repeat(64) }],
    [other.id, f.admin, freshBody],
    [a.id, colleague, freshBody],
  ] as const) {
    const r = await f.call(`${base(id)}/state-changes`, who, 'POST', changed);
    assert.equal(r.status, 409);
    assert.equal(r.data.error, STATE_CHANGE_REQUEST_COLLISION);
    assert.equal(r.data.stateChangeOutcome, undefined);
  }
  const noop = await f.call(
    `${base(a.id)}/state-changes`,
    f.admin,
    'POST',
    command(await context(f, a.id), 'checked-in'),
  );
  assert.equal(noop.status, 409);
  assert.equal(noop.data.stateChangeOutcome, 'not-applied');
  assert.deepEqual(
    (await f.call(`${base(a.id)}/state-changes`, f.admin, 'POST', freshBody)).data.event,
    saved.event,
  );
});

test('current sessions, MFA, account roles and per-target authority are rechecked under lock on reads, new commands and both replay outcomes', async (t) => {
  const f = await fixture(t),
    d = await f.doctor(),
    a = stored(f, d.id, { status: 'checked-in' }),
    source = await context(f, a.id),
    body = command(source, 'in-consultation');
  await apply(f, source, 'in-consultation', f.admin, body);
  const second = stored(f, d.id, { date: addDays(clinicToday(), -2), status: 'checked-in' }),
    next = await context(f, second.id),
    newBody = command(next, 'in-consultation'),
    rejectedBody = { ...newBody, expectedRevision: 'a'.repeat(64), requestId: randomUUID() };
  assert.equal(
    (await f.call(`${base(second.id)}/state-changes`, f.admin, 'POST', rejectedBody)).data
      .stateChangeOutcome,
    'not-applied',
  );
  const other = openDatabase(f.databasePath);
  t.after(() => other.close());
  const rawUser = String(
      f.db.prepare('SELECT data FROM users WHERE id=?').get(f.admin.user.id)!.data,
    ),
    sessions = f.db.prepare('SELECT * FROM sessions WHERE userId=?').all(f.admin.user.id);
  const changes = [
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
    {
      status: 403,
      readAllowed: true,
      apply: () =>
        other
          .prepare("UPDATE users SET role='receptionist',data=? WHERE id=?")
          .run(
            JSON.stringify({ ...JSON.parse(rawUser), role: 'receptionist', doctorId: undefined }),
            f.admin.user.id,
          ),
    },
  ];
  for (const [path, method, input] of [
    [`${base(second.id)}/state-context`, 'GET', undefined],
    [`${base(second.id)}/state-changes`, 'POST', newBody],
    [`${base(a.id)}/state-changes`, 'POST', body],
    [`${base(second.id)}/state-changes`, 'POST', rejectedBody],
  ] as const)
    for (const change of changes) {
      if (method === 'GET' && change.readAllowed) continue;
      const previous = state(f),
        restore = f.beforeLock(change.apply),
        r = await f.call(path, f.admin, method, input);
      restore();
      assert.equal(r.status, change.status, JSON.stringify(r.data));
      assert.equal(r.data.stateChangeOutcome, undefined);
      assert.deepEqual(state(f), previous);
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

test('two application connections serialize identical and competing commands with one state counter, resource outcome and notice', async (t) => {
  const f = await fixture(t),
    d = await f.doctor(),
    a = stored(f, d.id),
    c = await context(f, a.id),
    body = command(c, 'checked-in'),
    other = await fixture(t, f.databasePath);
  const responses = await Promise.all([
    f.call(`${base(a.id)}/state-changes`, f.admin, 'POST', body),
    other.call(`${base(a.id)}/state-changes`, f.admin, 'POST', body),
  ]);
  assert.deepEqual(responses.map((x) => x.status).sort(), [200, 201]);
  assert.deepEqual(responses[0].data, responses[1].data);
  assert.equal(
    f.db.prepare('SELECT version FROM appointmentMutationVersions WHERE appointmentId=?').get(a.id)!
      .version,
    1,
  );
  const second = stored(f, d.id, { date: addDays(clinicToday(), -2) }),
    source = await context(f, second.id);
  const competing = await Promise.all([
    f.call(`${base(second.id)}/state-changes`, f.admin, 'POST', command(source, 'checked-in')),
    other.call(`${base(second.id)}/state-changes`, f.admin, 'POST', command(source, 'no-show')),
  ]);
  assert.deepEqual(competing.map((x) => x.status).sort(), [201, 409]);
  assert.equal(competing.find((x) => x.status === 409)!.data.stateChangeOutcome, 'not-applied');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM appointmentStateChangeEvents').get()!.n, 2);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM appointmentStateChangeCommands').get()!.n, 3);
});

test('resource evidence, claims, appointment counter, immutable receipt, audit and notice failures all roll back without a false rejection marker', async (t) => {
  const f = await fixture(t),
    d = await f.doctor(),
    setTime = clock(t, f, '2036-06-03T03:30:00.000Z'),
    a = stored(f, d.id, { date: '2036-06-03', time: '11:00' });
  await allocate(f, a.id, 2);
  setTime('2036-06-03T05:30:00.000Z');
  const c = await context(f, a.id),
    body = command(c, 'no-show');
  for (const [table, operation, condition] of [
    ['resourceAllocationEvents', 'INSERT', '1'],
    ['resourceReservations', 'DELETE', '1'],
    ['resourceEventLinks', 'INSERT', '1'],
    ['appointments', 'UPDATE', '1'],
    ['appointmentMutationVersions', 'INSERT', '1'],
    ['appointmentStateChangeEvents', 'INSERT', '1'],
    ['appointmentStateChangeCommands', 'INSERT', '1'],
    ['audit', 'INSERT', "json_extract(NEW.data,'$.action')='appointment no-show'"],
    ['activity', 'INSERT', '1'],
  ]) {
    const previous = state(f);
    f.db.exec(
      `CREATE TRIGGER state_change_failure BEFORE ${operation} ON ${table} WHEN ${condition} BEGIN SELECT RAISE(ABORT,'Synthetic state change rollback'); END;`,
    );
    const r = await f.call(`${base(a.id)}/state-changes`, f.admin, 'POST', body);
    f.db.exec('DROP TRIGGER state_change_failure');
    assert.equal(r.status, 500, `${table}: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.stateChangeOutcome, undefined);
    assert.deepEqual(state(f), previous, table);
  }
  await apply(f, c, 'no-show', f.admin, body);
});

test('read audit failure and rejected-command storage failure do not expose successful partial evidence', async (t) => {
  const f = await fixture(t),
    d = await f.doctor(),
    a = stored(f, d.id),
    c = await context(f, a.id),
    previous = state(f);
  f.db.exec(
    "CREATE TRIGGER state_context_failure BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT,'Synthetic context failure'); END;",
  );
  assert.equal((await f.call(`${base(a.id)}/state-context`, f.admin)).status, 500);
  f.db.exec('DROP TRIGGER state_context_failure');
  assert.deepEqual(state(f), previous);
  const body = { ...command(c, 'checked-in'), expectedRevision: 'a'.repeat(64) };
  f.db.exec(
    "CREATE TRIGGER state_rejection_failure BEFORE INSERT ON appointmentStateChangeCommands WHEN NEW.rejection IS NOT NULL BEGIN SELECT RAISE(ABORT,'Synthetic rejected receipt failure'); END;",
  );
  const r = await f.call(`${base(a.id)}/state-changes`, f.admin, 'POST', body);
  f.db.exec('DROP TRIGGER state_rejection_failure');
  assert.equal(r.status, 500);
  assert.equal(r.data.stateChangeOutcome, undefined);
  assert.deepEqual(state(f), previous);
  assert.equal(
    (await f.call(`${base(a.id)}/state-changes`, f.admin, 'POST', body)).data.stateChangeOutcome,
    'not-applied',
  );
});

test('source and clock races are checked under lock, and a backward clock during notification rolls back the whole state change', async (t) => {
  const f = await fixture(t),
    d = await f.doctor(),
    setTime = clock(t, f, '2036-06-03T06:30:00.000Z'),
    a = stored(f, d.id, { date: '2036-06-03', time: '12:00' }),
    c = await context(f, a.id);
  const other = openDatabase(f.databasePath);
  t.after(() => other.close());
  const changed = { ...a, time: '12:30' },
    restore = f.beforeLock(() =>
      other
        .prepare('UPDATE appointments SET time=?,data=? WHERE id=?')
        .run(changed.time, JSON.stringify(changed), a.id),
    );
  const stale = await f.call(`${base(a.id)}/state-changes`, f.admin, 'POST', command(c, 'no-show'));
  restore();
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error, STATE_CHANGE_SOURCE_STALE);
  assert.deepEqual(get(f.db, 'appointments', a.id), changed);
  const next = await context(f, a.id),
    body = command(next, 'no-show');
  setTime('2036-06-03T07:00:00.000Z');
  const oldState = state(f),
    prepare = f.db.prepare.bind(f.db);
  let shifted = false;
  f.db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (sql.includes('INSERT OR IGNORE INTO activity')) {
      const run = statement.run.bind(statement);
      statement.run = ((...args: Parameters<typeof statement.run>) => {
        const r = run(...args);
        shifted = true;
        setTime('2036-06-03T06:59:59.999Z');
        return r;
      }) as typeof statement.run;
    }
    return statement;
  }) as DB['prepare'];
  const failed = await f.call(`${base(a.id)}/state-changes`, f.admin, 'POST', body);
  f.db.prepare = prepare;
  assert.equal(shifted, true);
  assert.equal(failed.status, 400);
  assert.equal(failed.data.stateChangeOutcome, 'not-applied');
  const after = state(f);
  for (const key of Object.keys(oldState).filter((key) => key !== 'appointmentStateChangeCommands'))
    assert.deepEqual(after[key], oldState[key], key);
  setTime('2036-06-03T07:00:00.000Z');
  assert.deepEqual(
    (await f.call(`${base(a.id)}/state-changes`, f.admin, 'POST', body)).data,
    failed.data,
  );
  await apply(f, await context(f, a.id), 'no-show');
  const tomorrow = stored(f, d.id, { date: '2036-06-04', time: '10:00' }),
    tomorrowSource = await context(f, tomorrow.id);
  setTime('2036-06-03T18:30:00.000Z');
  const unlock = f.beforeLock(() => setTime('2036-06-03T18:29:59.999Z'));
  const clockRejected = await f.call(
    `${base(tomorrow.id)}/state-changes`,
    f.admin,
    'POST',
    command(tomorrowSource, 'checked-in'),
  );
  unlock();
  assert.equal(clockRejected.status, 400);
  assert.equal(clockRejected.data.stateChangeOutcome, 'not-applied');
  assert.equal(get<Appointment>(f.db, 'appointments', tomorrow.id)!.status, 'scheduled');
});

test('immutable original outcomes and terminal rejections survive restart, remain private and preserve legacy PATCH compatibility', async (t) => {
  const f = await fixture(t),
    d = await f.doctor(),
    a = stored(f, d.id),
    c = await context(f, a.id),
    body = command(c, 'checked-in'),
    saved = await apply(f, c, 'checked-in', f.admin, body);
  const rejectedBody = command(c, 'no-show'),
    rejected = await f.call(`${base(a.id)}/state-changes`, f.admin, 'POST', rejectedBody);
  assert.equal(rejected.data.stateChangeOutcome, 'not-applied');
  const legacy = await f.call(base(a.id), f.admin, 'PATCH', { status: 'in-consultation' });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.data.status, 'in-consultation');
  assert.equal(legacy.data.event, undefined);
  const legacyNoop = await f.call(base(a.id), f.admin, 'PATCH', { status: 'in-consultation' });
  assert.equal(legacyNoop.status, 200);
  const current = await context(f, a.id);
  for (const table of ['appointmentStateChangeEvents', 'appointmentStateChangeCommands']) {
    assert.throws(() => f.db.exec(`UPDATE ${table} SET rowid=rowid`), /immutable/);
    assert.throws(() => f.db.exec(`DELETE FROM ${table}`), /immutable/);
  }
  const patient = await f.login('patient');
  for (const path of [
    '/appointments',
    `/patients/${a.patientId}/care-summary`,
    `${base(a.id)}/calendar`,
  ]) {
    const r = await f.call(path, patient);
    assert.equal(r.status, 200);
    for (const token of [
      body.requestId,
      rejectedBody.requestId,
      saved.event.id,
      c.revision,
      current.revision,
    ])
      assert.equal(JSON.stringify(r.data).includes(token), false);
  }
  await f.close();
  const reopened = await fixture(t, f.databasePath);
  assert.equal((await context(reopened, a.id)).revision, current.revision);
  const replay = await reopened.call(`${base(a.id)}/state-changes`, f.admin, 'POST', body);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data.event, saved.event);
  assert.deepEqual(replay.data.receipt, saved.receipt);
  assert.equal(replay.data.appointment.status, 'in-consultation');
  assert.deepEqual(
    (await reopened.call(`${base(a.id)}/state-changes`, f.admin, 'POST', rejectedBody)).data,
    rejected.data,
  );
  const plan = reopened.db
    .prepare(
      'EXPLAIN QUERY PLAN SELECT actorId,eventId,rejection FROM appointmentStateChangeCommands WHERE requestId=?',
    )
    .all(body.requestId);
  assert.match(JSON.stringify(plan), /INDEX sqlite_autoindex_appointmentStateChangeCommands_1/);
});

test('fresh role authority is checked before replay, while successful actor receipts retain original role after an authorized account change', async (t) => {
  const f = await fixture(t),
    d = await f.doctor(),
    operator = await f.account('admin'),
    a = stored(f, d.id),
    c = await context(f, a.id, operator),
    body = command(c, 'checked-in'),
    saved = await apply(f, c, 'checked-in', operator, body);
  const progressedSource = await context(f, a.id, operator),
    progressedBody = command(progressedSource, 'in-consultation');
  await apply(f, progressedSource, 'in-consultation', operator, progressedBody);
  const changed = await f.call(`/accounts/${operator.user.id}`, f.admin, 'PATCH', {
    role: 'receptionist',
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  const currentOperator = await f.login(operator.user.email);
  const allowed = await f.call(`${base(a.id)}/state-changes`, currentOperator, 'POST', body);
  assert.equal(allowed.status, 200);
  assert.deepEqual(allowed.data.event, saved.event);
  assert.equal(allowed.data.event.createdByRole, 'admin');
  const denied = await f.call(
    `${base(a.id)}/state-changes`,
    currentOperator,
    'POST',
    progressedBody,
  );
  assert.equal(denied.status, 403);
  assert.equal(denied.data.stateChangeOutcome, undefined);
});
