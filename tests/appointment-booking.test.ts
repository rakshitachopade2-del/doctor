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
import { BOOKING_REQUEST_COLLISION } from '../server/appointment-booking.ts';

type Client = { cookie: string; csrf: string; user: User };
const route = '/appointment-bookings';
async function fixture(t: TestContext, existingPath?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'derma-ordinary-booking-'));
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

test('all four roles receive one original ordinary booking, exact normalized receipt and no duplicated replay activity', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor();
  const users = [
    f.admin,
    await f.account('doctor', { doctorId: doctor.id }),
    await f.account('receptionist'),
    await f.login('patient'),
  ];
  for (const [offset, user] of users.entries()) {
    const input = f.input(doctor.id, { date: addDays(clinicToday(), 40 + offset) });
    const booked = success(
      await f.call(route, user, 'POST', {
        ...input,
        requestId: input.requestId.toUpperCase(),
        reason: ` ${input.reason} `,
      }),
    );
    assert.deepEqual(booked.booking.appointment, booked.appointment);
    assert.equal(booked.booking.createdById, user.user.id);
    assert.equal(booked.booking.createdByRole, user.user.role);
    assert.equal(booked.booking.createdAt, booked.appointment.createdAt);
    assert.equal(booked.booking.waitlistId, null);
    assert.equal(booked.booking.patientConfirmed, false);
    assert.equal(booked.appointment.fee, 500);
    assert.equal(booked.appointment.durationMinutes, 30);
    assert.equal(booked.appointment.status, 'scheduled');
    assert.deepEqual(booked.receipt, {
      requestId: input.requestId,
      actorId: user.user.id,
      patientId: input.patientId,
      bookingId: booked.booking.id,
      appointmentId: booked.appointment.id,
    });
    const before = f.state();
    const replay = await f.call(route, user, 'POST', input);
    assert.deepEqual(success(replay, 200), booked);
    assert.deepEqual(f.state(), before);
    assert.match(replay.headers.get('cache-control')!, /no-store/);
  }
});

test('strict commands reject malformed calendar, fields, identifiers, confirmation and queries without an outcome claim', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor(),
    input = f.input(doctor.id);
  const invalid = [
    { requestId: 'invalid' },
    { patientId: undefined },
    { doctorId: '' },
    { date: '2026-02-30' },
    { time: '24:00' },
    { time: '09:61' },
    { mode: 'phone' },
    { reason: ' ' },
    { reason: 'x'.repeat(301) },
    { durationMinutes: 90 },
    { durationPolicy: 'custom' },
    { existingAppointmentId: 'x' },
    { patientConfirmed: false },
    { waitlistId: 'some-request' },
    { unknown: true },
  ];
  const before = f.state();
  for (const change of invalid) {
    const r = await f.call(route, f.admin, 'POST', { ...input, ...change });
    assert.equal(r.status, 400, JSON.stringify(r.data));
    assert.equal(r.data.bookingOutcome, undefined);
  }
  assert.equal((await f.call(`${route}?unknown=1`, f.admin, 'POST', input)).status, 400);
  const unauthenticated = await f.call(route, undefined, 'POST', input);
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.data.bookingOutcome, undefined);
  const patient = await f.login('patient');
  const wrongPatient = await f.call(route, patient, 'POST', {
    ...input,
    patientId: 'patient-2',
  });
  assert.equal(wrongPatient.status, 403);
  assert.equal(wrongPatient.data.bookingOutcome, undefined);
  assert.deepEqual(f.db.prepare('SELECT * FROM appointmentBookingCommands').all(), []);
  assert.deepEqual(f.state().appointments, before.appointments);
});

test('legacy writer retains plain response, patient default, stripping and rejects custom lengths without exposing booking evidence', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor(),
    patient = await f.login('patient');
  const { patientId: _, ...body } = f.input(doctor.id);
  const r = await f.call('/appointments', patient, 'POST', {
    ...body,
    status: 'completed',
    fee: 1,
    role: 'admin',
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.patientId, patient.user.patientId);
  assert.equal(r.data.status, 'scheduled');
  assert.equal(r.data.fee, 500);
  assert.equal(r.data.requestId, undefined);
  assert.equal(r.data.booking, undefined);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM appointmentBookings').get()!.n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM appointmentBookingCommands').get()!.n, 0);
  assert.equal(
    (await f.call('/appointments', f.admin, 'POST', { ...f.input(doctor.id), durationMinutes: 60 }))
      .status,
    400,
  );
});

test('exact replay retains original names, fee, reason and duration after move, cancellation, renamed profiles and booking pause', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor(),
    body = f.input(doctor.id);
  const original = success(await f.call(route, f.admin, 'POST', body));
  const patient = get<Patient>(f.db, 'patients', body.patientId)!;
  f.db
    .prepare('UPDATE patients SET data=? WHERE id=?')
    .run(JSON.stringify({ ...patient, name: 'New patient name' }), patient.id);
  f.db
    .prepare('UPDATE doctors SET data=? WHERE id=?')
    .run(JSON.stringify({ ...doctor, name: 'Renamed doctor', fee: 990 }), doctor.id);
  const moved = await f.call(`/appointments/${original.appointment.id}`, f.admin, 'PATCH', {
    date: addDays(body.date, 2),
    time: '10:00',
    mode: 'online',
  });
  assert.equal(moved.status, 200);
  await f.accepting(doctor.id, false);
  assert.equal(
    (
      await f.call(`/appointments/${original.appointment.id}`, f.admin, 'PATCH', {
        status: 'cancelled',
      })
    ).status,
    200,
  );
  const replay = success(await f.call(route, f.admin, 'POST', body), 200);
  assert.deepEqual(replay.booking, original.booking);
  assert.deepEqual(replay.receipt, original.receipt);
  assert.equal(replay.appointment.status, 'cancelled');
  assert.equal(replay.appointment.date, addDays(body.date, 2));
  assert.equal(replay.appointment.doctorName, 'Renamed doctor');
  assert.equal(replay.appointment.fee, 990);
  const publicRows = await f.call('/appointments', await f.login('patient'));
  const row = publicRows.data.find((v: Appointment) => v.id === original.appointment.id);
  for (const key of ['booking', 'receipt', 'requestId', 'createdById', 'waitlistId'])
    assert.equal(row[key], undefined);
});

test('waitlist fulfillment is one atomic booking and terminal event; exact retry works after waitlist terminal state', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor(),
    patient = await f.login('patient');
  const body = f.input(doctor.id);
  body.waitlistId = await f.waiting(body, patient);
  body.patientConfirmed = true;
  const booked = success(await f.call(route, patient, 'POST', body));
  assert.equal(booked.booking.waitlistId, body.waitlistId);
  assert.equal(booked.booking.patientConfirmed, true);
  const event = f.db
    .prepare('SELECT * FROM waitlistEvents WHERE waitlistId=?')
    .all(body.waitlistId);
  assert.equal(event.length, 1);
  assert.equal(event[0].appointmentId, booked.appointment.id);
  const before = f.state();
  assert.deepEqual(success(await f.call(route, patient, 'POST', body), 200), booked);
  assert.deepEqual(f.state(), before);
  const notices = f.db
    .prepare('SELECT data FROM activity WHERE eventKey=?')
    .all(`waitlist-booked:${body.waitlistId}`);
  assert.equal(notices.length, 1);
  assert.equal(
    f.db
      .prepare('SELECT COUNT(*) n FROM activity WHERE eventKey=?')
      .get(`appointment-created:${booked.appointment.id}`)!.n,
    0,
  );
});

test('invalid waitlist scope or terminal state rolls back inserted appointments and gives only authorized durable domain rejections', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor(),
    body = f.input(doctor.id);
  const waiting = await f.waiting(body);
  const wrongMode = { ...body, waitlistId: waiting, patientConfirmed: true, mode: 'online' };
  const before = f.state();
  const rejected = await f.call(route, f.admin, 'POST', wrongMode);
  assert.equal(rejected.status, 400);
  assert.equal(rejected.data.bookingOutcome, 'not-created');
  for (const table of [
    'appointments',
    'waitlistEvents',
    'appointmentBookings',
    'audit',
    'activity',
  ])
    assert.deepEqual(f.state()[table], before[table]);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM appointmentBookingCommands').get()!.n, 1);
  const cancelled = await f.call(`/waitlist/${waiting}/cancel`, f.admin, 'POST', {
    reason: 'Patient withdrew',
  });
  assert.equal(cancelled.status, 200);
  const terminal = await f.call(route, f.admin, 'POST', {
    ...body,
    requestId: randomUUID(),
    waitlistId: waiting,
    patientConfirmed: true,
  });
  assert.equal(terminal.status, 409);
  assert.equal(terminal.data.bookingOutcome, 'not-created');
  const foreign = { ...body, patientId: 'patient-2', requestId: randomUUID() };
  const foreignId = await f.waiting(foreign);
  const denied = await f.call(route, await f.login('patient'), 'POST', {
    ...body,
    requestId: randomUUID(),
    waitlistId: foreignId,
    patientConfirmed: true,
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.data.bookingOutcome, undefined);
});

test('terminal not-created evidence cannot later create with a delayed exact retry; a fresh UUID is required', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor(),
    occupied = f.input(doctor.id);
  const existing = success(await f.call(route, f.admin, 'POST', occupied));
  const attempted = { ...occupied, requestId: randomUUID() };
  const rejected = await f.call(route, f.admin, 'POST', attempted);
  assert.equal(rejected.status, 409);
  assert.deepEqual(rejected.data, {
    error: rejected.data.error,
    bookingOutcome: 'not-created',
    requestId: attempted.requestId,
    actorId: f.admin.user.id,
    patientId: attempted.patientId,
  });
  assert.equal(
    (
      await f.call(`/appointments/${existing.appointment.id}`, f.admin, 'PATCH', {
        status: 'cancelled',
      })
    ).status,
    200,
  );
  const before = f.state();
  const delayed = await f.call(route, f.admin, 'POST', attempted);
  assert.deepEqual(delayed.data, rejected.data);
  assert.equal(delayed.status, 409);
  assert.deepEqual(f.state(), before);
  const changed = await f.call(route, f.admin, 'POST', { ...attempted, time: '10:00' });
  assert.equal(changed.status, 409);
  assert.equal(changed.data.error, BOOKING_REQUEST_COLLISION);
  assert.equal(changed.data.bookingOutcome, undefined);
  success(await f.call(route, f.admin, 'POST', { ...attempted, requestId: randomUUID() }));
});

test('actor and complete normalized payload binding prevents success and rejected-command UUID collisions', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor(),
    body = f.input(doctor.id),
    reception = await f.account('receptionist');
  success(await f.call(route, f.admin, 'POST', body));
  for (const change of [
    { reason: 'Different reason' },
    { patientConfirmed: true },
    { patientId: 'patient-2' },
    { time: '10:00' },
    { mode: 'online' },
  ]) {
    const response = await f.call(route, f.admin, 'POST', { ...body, ...change });
    assert.equal(response.status, 409);
    assert.equal(response.data.error, BOOKING_REQUEST_COLLISION);
    assert.equal(response.data.bookingOutcome, undefined);
  }
  const otherActor = await f.call(route, reception, 'POST', body);
  assert.equal(otherActor.status, 409);
  assert.equal(otherActor.data.error, BOOKING_REQUEST_COLLISION);
  const rejectedBody = { ...body, requestId: randomUUID() };
  assert.equal(
    (await f.call(route, f.admin, 'POST', rejectedBody)).data.bookingOutcome,
    'not-created',
  );
  const rejectedActor = await f.call(route, reception, 'POST', rejectedBody);
  assert.equal(rejectedActor.data.error, BOOKING_REQUEST_COLLISION);
  assert.equal(rejectedActor.data.bookingOutcome, undefined);
});

test('new and legacy creation and successful replay all revalidate session/account/CSRF/MFA and patient ownership inside the write lock', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor();
  const originalBody = f.input(doctor.id),
    original = success(await f.call(route, f.admin, 'POST', originalBody));
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
          .prepare("UPDATE sessions SET csrfToken='changed-token' WHERE userId=?")
          .run(f.admin.user.id),
    },
    {
      status: 401,
      apply: () =>
        other
          .prepare(
            'INSERT INTO mfaCredentials(userId,id,secret,enabledAt,lastStep) VALUES (?,?,?,?,?)',
          )
          .run(
            f.admin.user.id,
            'new-factor',
            'synthetic-no-decryption',
            new Date().toISOString(),
            -1,
          ),
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
  for (const operation of ['new', 'legacy', 'replay']) {
    for (const mutation of mutations) {
      const before = f.state();
      const restore = f.beforeLock(mutation.apply);
      const response = await f.call(
        operation === 'legacy' ? '/appointments' : route,
        f.admin,
        'POST',
        operation === 'replay' ? originalBody : f.input(doctor.id, { time: '11:00' }),
      );
      restore();
      assert.equal(
        response.status,
        mutation.status,
        `${operation}: ${JSON.stringify(response.data)}`,
      );
      assert.equal(response.data.bookingOutcome, undefined);
      assert.deepEqual(f.state(), before);
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
  }
  assert.deepEqual(
    success(await f.call(route, f.admin, 'POST', originalBody), 200).booking,
    original.booking,
  );
});

test('inside-lock patient and doctor metadata supplies the original snapshot, while a concurrently paused doctor gets a terminal rejection', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor(),
    body = f.input(doctor.id);
  const other = openDatabase(f.databasePath);
  t.after(() => other.close());
  const patient = get<Patient>(f.db, 'patients', body.patientId)!;
  let restore = f.beforeLock(() => {
    other
      .prepare('UPDATE patients SET data=? WHERE id=?')
      .run(JSON.stringify({ ...patient, name: 'Current under-lock patient' }), patient.id);
    other
      .prepare('UPDATE doctors SET data=? WHERE id=?')
      .run(JSON.stringify({ ...doctor, name: 'Current under-lock doctor', fee: 750 }), doctor.id);
  });
  const booked = success(await f.call(route, f.admin, 'POST', body));
  restore();
  assert.equal(booked.booking.appointment.patientName, 'Current under-lock patient');
  assert.equal(booked.booking.appointment.doctorName, 'Current under-lock doctor');
  assert.equal(booked.booking.appointment.fee, 750);
  restore = f.beforeLock(() =>
    other
      .prepare('INSERT INTO doctorBookingStatuses(id,acceptingNewBookings) VALUES (?,0)')
      .run(doctor.id),
  );
  const pausedBody = f.input(doctor.id, { time: '10:00' });
  const paused = await f.call(route, f.admin, 'POST', pausedBody);
  restore();
  assert.equal(paused.status, 409);
  assert.equal(paused.data.bookingOutcome, 'not-created');
  other
    .prepare('UPDATE doctorBookingStatuses SET acceptingNewBookings=1 WHERE id=?')
    .run(doctor.id);
  assert.deepEqual((await f.call(route, f.admin, 'POST', pausedBody)).data, paused.data);
});

test('competing application connections serialize exact request retries and independent slot contenders', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor(),
    g = await fixture(t, f.databasePath);
  const body = f.input(doctor.id);
  const exact = await Promise.all([
    f.call(route, f.admin, 'POST', body),
    g.call(route, f.admin, 'POST', body),
  ]);
  assert.deepEqual(exact.map((v) => v.status).sort(), [200, 201]);
  assert.deepEqual(exact[0].data, exact[1].data);
  const a = f.input(doctor.id, { time: '10:00' }),
    b = { ...a, requestId: randomUUID() };
  const competing = await Promise.all([
    f.call(route, f.admin, 'POST', a),
    g.call(route, f.admin, 'POST', b),
  ]);
  assert.deepEqual(competing.map((v) => v.status).sort(), [201, 409]);
  assert.equal(competing.find((v) => v.status === 409)!.data.bookingOutcome, 'not-created');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM appointmentBookings').get()!.n, 2);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM appointmentBookingCommands').get()!.n, 3);
  const successfulId = exact[0].data.appointment.id;
  assert.equal(
    f.db
      .prepare('SELECT COUNT(*) n FROM activity WHERE eventKey=?')
      .get(`appointment-created:${successfulId}`)!.n,
    1,
  );
});

test('concurrent delayed rejected requests cannot create after an intervening cancellation frees their slot', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor(),
    g = await fixture(t, f.databasePath);
  const occupiedBody = f.input(doctor.id),
    occupied = success(await f.call(route, f.admin, 'POST', occupiedBody));
  const rejectedBody = { ...occupiedBody, requestId: randomUUID() };
  const rejected = await f.call(route, f.admin, 'POST', rejectedBody);
  assert.equal(rejected.data.bookingOutcome, 'not-created');
  assert.equal(
    (
      await f.call(`/appointments/${occupied.appointment.id}`, f.admin, 'PATCH', {
        status: 'cancelled',
      })
    ).status,
    200,
  );
  const responses = await Promise.all([
    f.call(route, f.admin, 'POST', rejectedBody),
    g.call(route, f.admin, 'POST', rejectedBody),
  ]);
  for (const response of responses) {
    assert.equal(response.status, 409);
    assert.deepEqual(response.data, rejected.data);
  }
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM appointmentBookings').get()!.n, 1);
});

test('appointment, waitlist, activity, audit, original and receipt failures each roll back the complete new or legacy booking without false rejection evidence', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor(),
    base = f.input(doctor.id);
  const waitingId = await f.waiting(base);
  const body = { ...base, waitlistId: waitingId, patientConfirmed: true };
  const failures = [
    ['appointments', '1'],
    ['waitlistEvents', '1'],
    ['audit', "json_extract(NEW.data,'$.action')='booked confirmed waitlist request'"],
    ['activity', '1'],
    ['audit', "json_extract(NEW.data,'$.action')='booked appointment'"],
    ['appointmentBookings', '1'],
    ['appointmentBookingCommands', '1'],
  ];
  for (const [table, condition] of failures) {
    const before = f.state();
    f.db.exec(
      `CREATE TRIGGER booking_injected_failure BEFORE INSERT ON ${table} WHEN ${condition} BEGIN SELECT RAISE(ABORT,'Synthetic booking rollback'); END;`,
    );
    const response = await f.call(route, f.admin, 'POST', body);
    f.db.exec('DROP TRIGGER booking_injected_failure');
    assert.equal(response.status, 500, `${table}: ${JSON.stringify(response.data)}`);
    assert.equal(response.data.bookingOutcome, undefined);
    assert.deepEqual(f.state(), before, table);
  }
  for (const [table, condition] of failures.slice(0, 5)) {
    const before = f.state();
    f.db.exec(
      `CREATE TRIGGER booking_injected_failure BEFORE INSERT ON ${table} WHEN ${condition} BEGIN SELECT RAISE(ABORT,'Synthetic legacy rollback'); END;`,
    );
    const response = await f.call('/appointments', f.admin, 'POST', body);
    f.db.exec('DROP TRIGGER booking_injected_failure');
    assert.equal(response.status, 500, table);
    assert.deepEqual(f.state(), before, table);
  }
  success(await f.call(route, f.admin, 'POST', body));
});

test('rejection receipt failure rolls back evidence and never emits a definitive marker', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor();
  const occupied = f.input(doctor.id);
  success(await f.call(route, f.admin, 'POST', occupied));
  const attempted = { ...occupied, requestId: randomUUID() },
    before = f.state();
  f.db.exec(
    "CREATE TRIGGER reject_failure BEFORE INSERT ON appointmentBookingCommands WHEN NEW.rejection IS NOT NULL BEGIN SELECT RAISE(ABORT,'Synthetic rejection failure'); END;",
  );
  const response = await f.call(route, f.admin, 'POST', attempted);
  f.db.exec('DROP TRIGGER reject_failure');
  assert.equal(response.status, 500);
  assert.equal(response.data.bookingOutcome, undefined);
  assert.deepEqual(f.state(), before);
  const safe = await f.call(route, f.admin, 'POST', attempted);
  assert.equal(safe.status, 409);
  assert.equal(safe.data.bookingOutcome, 'not-created');
});

test('committed waitlist replay survives real calendar expiry; new expired dates are terminal rejections', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor(),
    body = f.input(doctor.id);
  body.waitlistId = await f.waiting(body);
  body.patientConfirmed = true;
  const booked = success(await f.call(route, f.admin, 'POST', body));
  const RealDate = Date,
    future = Date.parse(`${addDays(body.date, 10)}T12:00:00Z`);
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
    assert.deepEqual(success(await f.call(route, f.admin, 'POST', body), 200), booked);
    const past = await f.call(route, f.admin, 'POST', { ...body, requestId: randomUUID() });
    assert.equal(past.status, 400);
    assert.equal(past.data.bookingOutcome, 'not-created');
  } finally {
    globalThis.Date = RealDate;
  }
});

test('immutable successful and rejected evidence persists across restart without changing legacy appointments', async (t) => {
  const f = await fixture(t),
    doctor = await f.doctor(),
    body = f.input(doctor.id);
  const booked = success(await f.call(route, f.admin, 'POST', body));
  const rejectedBody = { ...body, requestId: randomUUID() },
    rejected = await f.call(route, f.admin, 'POST', rejectedBody);
  for (const table of ['appointmentBookings', 'appointmentBookingCommands']) {
    assert.throws(() => f.db.exec(`UPDATE ${table} SET rowid=rowid`), /immutable/);
    assert.throws(() => f.db.exec(`DELETE FROM ${table}`), /immutable/);
  }
  const before = f.state();
  await f.close();
  const reopened = await fixture(t, f.databasePath);
  assert.deepEqual(success(await reopened.call(route, f.admin, 'POST', body), 200), booked);
  assert.deepEqual((await reopened.call(route, f.admin, 'POST', rejectedBody)).data, rejected.data);
  for (const table of [
    'appointments',
    'waitlistEvents',
    'appointmentBookings',
    'appointmentBookingCommands',
    'activity',
  ])
    assert.deepEqual(reopened.state()[table], before[table]);
  const plan = reopened.db
    .prepare(
      'EXPLAIN QUERY PLAN SELECT actorId,payload,bookingId,rejection FROM appointmentBookingCommands WHERE requestId=?',
    )
    .all(body.requestId);
  assert.match(JSON.stringify(plan), /INDEX sqlite_autoindex_appointmentBookingCommands_1/);
});
