import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import { createUser, get, openDatabase, addDays, clinicToday, type DB } from '../server/db.ts';
import type { User, Doctor, Appointment } from '../shared/types.ts';
import type {
  DoctorBookingContext,
  DoctorBookingInput,
  DoctorBookingMutation,
} from '../shared/doctor-booking.ts';
import { doctorAllowsBooking, DOCTOR_BOOKING_PAUSED } from '../server/doctor-booking.ts';
import { createScheduling } from '../server/scheduling.ts';
type Client = { cookie: string; csrf: string; user: User };
const privateReason = 'PRIVATE_DOCTOR_BOOKING_REASON';
const path = (doctorId: string) => `/doctors/${doctorId}/booking-status`;
async function fixture(t: TestContext, database?: string, fresh = false) {
  const directory = mkdtempSync(join(tmpdir(), 'derma-doctor-booking-')),
    databasePath = database ?? join(directory, 'clinic.sqlite');
  const app = createApp({ databasePath, demoMode: !fresh, production: false }),
    db = app.locals.db as DB;
  if (fresh)
    createUser(
      db,
      {
        id: randomUUID(),
        name: 'Synthetic initial admin',
        email: 'admin@derma.demo',
        role: 'admin',
        active: true,
      },
      'DemoClinic2026!',
    );
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
  function doctor(): Doctor {
    const value: Doctor = {
      id: randomUUID(),
      name: 'Synthetic Schedule Doctor',
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
    return value;
  }

  async function context(doctorId: string, who = admin): Promise<DoctorBookingContext> {
    const r = await call(path(doctorId), who);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  }
  async function command(
    doctorId: string,
    acceptingNewBookings: boolean,
    who = admin,
  ): Promise<DoctorBookingInput> {
    return {
      acceptingNewBookings,
      reason: privateReason,
      expectedRevision: (await context(doctorId, who)).revision,
      requestId: randomUUID(),
    };
  }
  async function change(doctorId: string, acceptingNewBookings: boolean, who = admin) {
    const body = await command(doctorId, acceptingNewBookings, who),
      r = await call(path(doctorId), who, 'POST', body);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return { body, value: r.data as DoctorBookingMutation };
  }
  function state() {
    return {
      status: db.prepare('SELECT * FROM doctorBookingStatuses ORDER BY id').all(),
      changes: db.prepare('SELECT * FROM doctorBookingChanges ORDER BY id').all(),
      commands: db.prepare('SELECT * FROM doctorBookingCommands ORDER BY requestId').all(),
      audit: db.prepare('SELECT COUNT(*) n FROM audit').get()!.n,
      appointments: db.prepare('SELECT * FROM appointments ORDER BY id').all(),
      waiting: db.prepare('SELECT * FROM waitlistRequests ORDER BY id').all(),
      activity: db.prepare('SELECT COUNT(*) n FROM activity').get()!.n,
    };
  }
  async function schedule(doctorId: string, durationMinutes = 30) {
    const r = await call(`/schedules/${doctorId}`, admin, 'PUT', {
      durationMinutes,
      windows: Array.from({ length: 7 }, (_, day) => ({
        day,
        start: '09:00',
        end: '18:00',
        mode: 'both',
      })),
    });
    assert.equal(r.status, 200);
  }
  function input(doctorId: string, overrides: Record<string, unknown> = {}) {
    return {
      patientId: 'patient-ananya',
      doctorId,
      date: addDays(clinicToday(), 40),
      time: '09:00',
      mode: 'in-person',
      reason: 'Synthetic visit',
      ...overrides,
    };
  }
  async function book(
    doctorId: string,
    overrides: Record<string, unknown> = {},
    who = admin,
  ): Promise<Appointment> {
    const r = await call('/appointments', who, 'POST', input(doctorId, overrides));
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return r.data;
  }
  function seriesInput(doctorId: string, overrides: Record<string, unknown> = {}) {
    return {
      patientId: 'patient-ananya',
      doctorId,
      mode: 'in-person',
      reason: 'Synthetic series',
      firstDate: addDays(clinicToday(), 60),
      time: '09:00',
      count: 2,
      intervalWeeks: 1,
      durationPolicy: 'schedule',
      ...overrides,
    };
  }
  async function series(doctorId: string, overrides: Record<string, unknown> = {}) {
    const input = seriesInput(doctorId, overrides),
      preview = await call('/appointment-series/preview', admin, 'POST', input);
    assert.equal(preview.status, 200);
    assert.equal(preview.data.canBook, true, JSON.stringify(preview.data));
    const body = {
        input,
        expectedRevision: preview.data.revision,
        patientConfirmed: true,
        requestId: randomUUID(),
      },
      r = await call('/appointment-series', admin, 'POST', body);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return { body, value: r.data };
  }
  return {
    app,
    db,
    databasePath,
    base,
    call,
    login,
    account,
    admin,
    doctor,
    context,
    command,
    change,
    state,
    schedule,
    input,
    book,
    seriesInput,
    series,
    close,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

test('legacy and newly created profiles default to accepting without fabricated history; pause changes only operational status and audited evidence', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor(),
    before = await f.context(doctor.id);
  assert.equal(before.acceptingNewBookings, true);
  assert.equal(before.latestChange, null);
  assert.match(before.revision, /^[a-f0-9]{64}$/);
  const source = f.db.prepare('SELECT data FROM doctors WHERE id=?').get(doctor.id)!.data;
  const protectedTables = [
    'patients',
    'appointments',
    'carePlans',
    'users',
    'waitlistRequests',
    'resourceReservations',
    'activity',
  ];
  const snapshots = protectedTables.map((table) => f.db.prepare(`SELECT * FROM ${table}`).all());
  const paused = await f.change(doctor.id, false);
  assert.equal(paused.value.change.before, true);
  assert.equal(paused.value.change.after, false);
  assert.equal(paused.value.context.acceptingNewBookings, false);
  assert.deepEqual(paused.value.receipt, {
    actorId: f.admin.user.id,
    requestId: paused.body.requestId,
    doctorId: doctor.id,
    expectedRevision: before.revision,
    changeId: paused.value.change.id,
  });
  assert.equal(f.db.prepare('SELECT data FROM doctors WHERE id=?').get(doctor.id)!.data, source);
  protectedTables.forEach((table, i) =>
    assert.deepEqual(f.db.prepare(`SELECT * FROM ${table}`).all(), snapshots[i], table),
  );
  const all = await f.call('/doctors');
  assert.equal(all.status, 200);
  assert.ok(all.data.every((d: Doctor) => typeof d.acceptingNewBookings === 'boolean'));
  assert.equal(all.data.find((d: Doctor) => d.id === doctor.id).acceptingNewBookings, false);
  assert.equal((await f.context('doctor-meera')).acceptingNewBookings, true);
  const { _ignore, ...profile } = { ...doctor, _ignore: 0 };
  const created = await f.call('/doctors', f.admin, 'POST', profile);
  assert.equal(created.status, 201);
  assert.equal((await f.context(created.data.id)).latestChange, null);
  assert.equal((await f.context(created.data.id)).acceptingNewBookings, true);
});

test('revision prevents ABA, ignores independent doctor profile/hours edits, and exact retries retain original labels with later-current context', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor(),
    baseline = await f.context(doctor.id),
    paused = await f.change(doctor.id, false),
    resumed = await f.change(doctor.id, true);
  assert.notEqual(resumed.value.context.revision, baseline.revision);
  const stale = await f.call(path(doctor.id), f.admin, 'POST', {
    ...paused.body,
    requestId: randomUUID(),
  });
  assert.equal(stale.status, 409);
  assert.match(stale.data.error, /^Doctor booking status changed/);
  const profile = {
    ...doctor,
    name: 'Renamed synthetic clinician',
    fee: 800,
    acceptingNewBookings: false,
  };
  assert.equal((await f.call(`/doctors/${doctor.id}`, f.admin, 'PATCH', profile)).status, 200);
  await f.schedule(doctor.id, 20);
  assert.equal((await f.context(doctor.id)).revision, resumed.value.context.revision);
  assert.equal((await f.context(doctor.id)).acceptingNewBookings, true);
  const auditBefore = f.state().audit,
    replay = await f.call(path(doctor.id), f.admin, 'POST', {
      ...paused.body,
      requestId: paused.body.requestId.toUpperCase(),
    });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data.change, paused.value.change);
  assert.deepEqual(replay.data.receipt, paused.value.receipt);
  assert.equal(replay.data.context.doctor.name, profile.name);
  assert.equal(replay.data.context.acceptingNewBookings, true);
  assert.equal(f.state().audit, auditBefore);
  const second = await f.change(doctor.id, false);
  assert.equal(second.value.change.doctorName, profile.name);
  assert.equal(
    (
      await f.call(`/doctors/${doctor.id}`, f.admin, 'PATCH', {
        ...profile,
        acceptingNewBookings: true,
      })
    ).status,
    200,
  );
  assert.equal((await f.context(doctor.id)).acceptingNewBookings, false);
});

test('command replay binds current actor, doctor, requested status, private reason and original revision', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor(),
    other = f.doctor(),
    saved = await f.change(doctor.id, false),
    second = await f.account('admin');
  for (const [target, who, body] of [
    [doctor.id, second, saved.body],
    [other.id, f.admin, saved.body],
    [doctor.id, f.admin, { ...saved.body, acceptingNewBookings: true }],
    [doctor.id, f.admin, { ...saved.body, reason: 'Other reason' }],
    [doctor.id, f.admin, { ...saved.body, expectedRevision: saved.value.context.revision }],
  ] as const) {
    const r = await f.call(path(target), who, 'POST', body);
    assert.equal(r.status, 409);
    assert.match(r.data.error, /request ID.*different doctor booking-status change/);
  }
  const normalized = await f.call(path(doctor.id), f.admin, 'POST', {
    ...saved.body,
    reason: `  ${privateReason}  `,
  });
  assert.equal(normalized.status, 200);
  assert.deepEqual(normalized.data.receipt, saved.value.receipt);
});

test('private admin routes enforce roles, strict schemas, no-op behavior and safe uncached projections', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor(),
    own = await f.account('doctor', { doctorId: doctor.id }),
    reception = await f.login('reception'),
    patient = await f.login('patient'),
    input = await f.command(doctor.id, false);
  for (const who of [undefined, own, reception, patient])
    for (const [route, method, body] of [
      [path(doctor.id), 'GET'],
      [`${path(doctor.id)}/history`, 'GET'],
      [path(doctor.id), 'POST', {}],
    ] as const)
      assert.equal((await f.call(route, who, method, body)).status, who ? 403 : 401);
  for (const body of [
    { ...input, extra: true },
    { ...input, acceptingNewBookings: 'false' },
    { ...input, reason: ' ' },
    { ...input, reason: 'x'.repeat(1001) },
    { ...input, expectedRevision: '0' },
    { ...input, requestId: 'invalid' },
  ])
    assert.equal((await f.call(path(doctor.id), f.admin, 'POST', body)).status, 400);
  for (const query of ['?extra=1', '?page=0', '?pageSize=100', '?page=1000001'])
    assert.equal((await f.call(`${path(doctor.id)}/history${query}`, f.admin)).status, 400);
  assert.equal((await f.call(`${path(doctor.id)}?extra=1`, f.admin)).status, 400);
  assert.equal((await f.call(`${path(doctor.id)}?extra=1`, f.admin, 'POST', input)).status, 400);
  assert.equal(
    (await f.call(path(doctor.id), f.admin, 'POST', { ...input, acceptingNewBookings: true }))
      .status,
    400,
  );
  const saved = await f.change(doctor.id, false),
    history = await f.call(`${path(doctor.id)}/history`, f.admin);
  assert.match(history.headers.get('cache-control')!, /no-store/);
  assert.match(history.headers.get('x-robots-tag')!, /noindex/);
  const serialized = JSON.stringify(history.data);
  for (const field of ['createdById', 'requestId', 'expectedRevision'])
    assert.equal(serialized.includes(field), false);
  for (const route of [
    '/doctors',
    '/settings',
    '/slots?doctorId=' + doctor.id + '&date=' + addDays(clinicToday(), 40),
  ]) {
    const r = await f.call(route);
    for (const secret of [
      privateReason,
      saved.body.requestId,
      saved.value.change.id,
      'latestChange',
      'bookingStatusRevision',
    ])
      assert.equal(JSON.stringify(r.data).includes(secret), false, route + secret);
  }
});

test('pause blocks new ordinary/custom/series/waitlist bookings and fulfillment while retaining old waitlist entries', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor();
  await f.schedule(doctor.id);
  const waitInput = {
    patientId: 'patient-ananya',
    doctorId: doctor.id,
    mode: 'in-person',
    startDate: addDays(clinicToday(), 40),
    endDate: addDays(clinicToday(), 45),
    reason: 'Synthetic waiting request',
  };
  const waiting = await f.call('/waitlist', f.admin, 'POST', waitInput);
  assert.equal(waiting.status, 201);
  const source = await f.call(
    '/appointment-series/preview',
    f.admin,
    'POST',
    f.seriesInput(doctor.id),
  );
  assert.equal(source.data.canBook, true);
  await f.change(doctor.id, false);
  const before = f.state();
  for (const [route, body] of [
    ['/appointments', f.input(doctor.id)],
    [
      '/visit-duration/bookings',
      { ...f.input(doctor.id), durationMinutes: 90, requestId: randomUUID() },
    ],
    ['/waitlist', { ...waitInput, mode: 'online' }],
    [
      '/appointments',
      { ...f.input(doctor.id), waitlistId: waiting.data.id, patientConfirmed: true },
    ],
  ] as const) {
    const r = await f.call(route, f.admin, 'POST', body);
    assert.equal(r.status, 409, JSON.stringify(r.data));
    assert.equal(r.data.error, DOCTOR_BOOKING_PAUSED);
    assert.deepEqual(f.state(), before);
  }
  assert.deepEqual(
    (await f.call(`/slots?doctorId=${doctor.id}&date=${waitInput.startDate}`)).data,
    [],
  );
  const preview = await f.call(
    '/appointment-series/preview',
    f.admin,
    'POST',
    f.seriesInput(doctor.id),
  );
  assert.equal(preview.status, 200);
  assert.equal(preview.data.canBook, false);
  assert.ok(
    preview.data.visits.every(
      (v: { blockedReason: string }) => v.blockedReason === DOCTOR_BOOKING_PAUSED,
    ),
  );
  const stale = await f.call('/appointment-series', f.admin, 'POST', {
    input: source.data.input,
    expectedRevision: source.data.revision,
    requestId: randomUUID(),
    patientConfirmed: true,
  });
  assert.equal(stale.status, 409);
  const list = await f.call('/waitlist', f.admin);
  assert.equal(list.data.find((v: { id: string }) => v.id === waiting.data.id).status, 'waiting');
  assert.equal(
    (
      await f.call(`/waitlist/${waiting.data.id}/cancel`, f.admin, 'POST', {
        reason: 'Patient withdrew',
      })
    ).status,
    200,
  );
});

test('patients can still reschedule their existing paused-doctor visit, while incoming transfers fail and transfers away remain available', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor(),
    other = f.doctor(),
    patient = await f.login('patient');
  await f.schedule(doctor.id);
  await f.schedule(other.id);
  const own = await f.book(doctor.id),
    incoming = await f.book(other.id, { date: addDays(clinicToday(), 42) }),
    original = structuredClone(own);
  await f.change(doctor.id, false);
  assert.deepEqual(get(f.db, 'appointments', own.id), original);
  const target = addDays(clinicToday(), 41),
    slots = await f.call(
      `/slots?doctorId=${doctor.id}&date=${target}&excludeAppointmentId=${own.id}`,
      patient,
    );
  assert.ok(slots.data.includes('09:00'));
  const moved = await f.call(`/appointments/${own.id}`, patient, 'PATCH', {
    date: target,
    time: '09:00',
    mode: 'online',
  });
  assert.equal(moved.status, 200);
  assert.equal(moved.data.doctorId, doctor.id);
  assert.equal(moved.data.mode, 'online');
  const transfer = await f.call(`/appointments/${incoming.id}`, f.admin, 'PATCH', {
    doctorId: doctor.id,
  });
  assert.equal(transfer.status, 409);
  assert.equal(transfer.data.error, DOCTOR_BOOKING_PAUSED);
  assert.deepEqual(
    (
      await f.call(
        `/slots?doctorId=${doctor.id}&date=${incoming.date}&excludeAppointmentId=${incoming.id}`,
        patient,
      )
    ).data,
    [],
  );
  const away = await f.call(`/appointments/${own.id}`, patient, 'PATCH', {
    doctorId: other.id,
    date: addDays(clinicToday(), 43),
    time: '09:00',
  });
  assert.equal(away.status, 200);
  assert.equal(away.data.doctorId, other.id);
  assert.equal(
    (await f.call(`/appointments/${incoming.id}`, patient, 'PATCH', { status: 'cancelled' }))
      .status,
    200,
  );
});

test('custom length changes and resource-aware same-doctor moves remain usable during pause; original custom-booking retries remain exact', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor();
  await f.schedule(doctor.id);
  const body = { ...f.input(doctor.id), durationMinutes: 60, requestId: randomUUID() },
    booked = await f.call('/visit-duration/bookings', f.admin, 'POST', body);
  assert.equal(booked.status, 201);
  const visit = booked.data.appointment as Appointment;
  const room = await f.call('/clinic-resources', f.admin, 'POST', {
    name: 'Synthetic room',
    kind: 'room',
    requestId: randomUUID(),
  });
  assert.equal(room.status, 201);
  const resource = await f.call(`/appointments/${visit.id}/resources`, f.admin),
    allocated = await f.call(`/appointments/${visit.id}/resources`, f.admin, 'PUT', {
      resourceIds: [room.data.resource.id],
      reason: 'Synthetic allocation',
      expectedRevision: resource.data.revision,
      requestId: randomUUID(),
    });
  assert.equal(allocated.status, 200);
  await f.change(doctor.id, false);
  const current = await f.call(`/appointments/${visit.id}/duration`, f.admin);
  assert.equal(current.status, 200);
  assert.equal(current.data.canChange, true);
  const changed = await f.call(`/appointments/${visit.id}/duration`, f.admin, 'POST', {
    durationPolicy: 'custom',
    durationMinutes: 90,
    date: visit.date,
    time: visit.time,
    reason: 'Extended existing appointment',
    expectedRevision: current.data.revision,
    requestId: randomUUID(),
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.appointment.durationMinutes, 90);
  assert.equal(changed.data.appointment.fee, visit.fee);
  const moved = await f.call(`/appointments/${visit.id}`, f.admin, 'PATCH', {
    date: addDays(clinicToday(), 41),
    time: '09:00',
  });
  assert.equal(moved.status, 200);
  assert.equal(moved.data.durationMinutes, 90);
  const reservation = f.db
    .prepare('SELECT * FROM resourceReservations WHERE appointmentId=?')
    .all(visit.id);
  assert.equal(reservation.length, 1);
  assert.equal(JSON.parse(reservation[0].data as string).appointment.date, moved.data.date);
  const replay = await f.call('/visit-duration/bookings', f.admin, 'POST', body);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data.event, booked.data.event);
  assert.equal(replay.data.appointment.date, moved.data.date);
  const slots = await f.call(
    `/visit-duration/slots?doctorId=${doctor.id}&patientId=${visit.patientId}&date=${addDays(clinicToday(), 42)}&mode=in-person&durationPolicy=custom&durationMinutes=90&excludeAppointmentId=${visit.id}`,
    f.admin,
  );
  assert.equal(slots.status, 200);
  assert.ok(slots.data.includes('09:00'));
});

test('series moves use explicit stored member exceptions, survive pause/resume without staling, and preserve original booking retries', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor();
  await f.schedule(doctor.id);
  const saved = await f.series(doctor.id),
    seriesId = saved.value.series.id,
    visits = saved.value.appointments as Appointment[],
    moves = visits.map((v, i) => ({ appointmentId: v.id, date: visits[1 - i].date, time: v.time }));
  const route = `/appointment-series/${seriesId}/reschedules`,
    preview = await f.call(`${route}/preview`, f.admin, 'POST', { moves });
  assert.equal(preview.status, 200);
  assert.equal(preview.data.canReschedule, true);
  await f.change(doctor.id, false);
  const pausedPreview = await f.call(`${route}/preview`, f.admin, 'POST', { moves });
  assert.equal(pausedPreview.data.canReschedule, true);
  assert.equal(pausedPreview.data.revision, preview.data.revision);
  await f.change(doctor.id, true);
  await f.change(doctor.id, false);
  const moved = await f.call(route, f.admin, 'POST', {
    moves,
    reason: 'Patient requested swap',
    expectedRevision: preview.data.revision,
    patientConfirmed: true,
    requestId: randomUUID(),
  });
  assert.equal(moved.status, 201, JSON.stringify(moved.data));
  assert.deepEqual(
    moved.data.event.visits.map((v: { after: Appointment }) => v.after.date),
    moves.map((v) => v.date),
  );
  const replay = await f.call('/appointment-series', f.admin, 'POST', saved.body);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data.series, saved.value.series);
  assert.notDeepEqual(replay.data.appointments, saved.value.appointments);
  assert.deepEqual(replay.data.series.bookedAppointments, saved.value.series.bookedAppointments);
});

test('new-series preview sees pause/resume ABA while unrelated profile booking status does not stale it', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor(),
    other = f.doctor();
  await f.schedule(doctor.id);
  const input = f.seriesInput(doctor.id),
    source = await f.call('/appointment-series/preview', f.admin, 'POST', input);
  assert.equal(source.data.canBook, true);
  await f.change(other.id, false);
  const independent = await f.call('/appointment-series/preview', f.admin, 'POST', input);
  assert.equal(independent.data.revision, source.data.revision);
  await f.change(doctor.id, false);
  await f.change(doctor.id, true);
  const after = await f.call('/appointment-series/preview', f.admin, 'POST', input);
  assert.equal(after.data.canBook, true);
  assert.notEqual(after.data.revision, source.data.revision);
  const stale = await f.call('/appointment-series', f.admin, 'POST', {
    input,
    expectedRevision: source.data.revision,
    requestId: randomUUID(),
    patientConfirmed: true,
  });
  assert.equal(stale.status, 409);
  assert.match(stale.data.error, /preview changed/);
});

test('client flags, unrelated/terminal appointment IDs and batch exclusion lists cannot bypass a booking pause', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor(),
    other = f.doctor();
  await f.schedule(doctor.id);
  await f.schedule(other.id);
  const same = await f.book(doctor.id),
    foreign = await f.book(other.id, { date: addDays(clinicToday(), 41) }),
    patient = await f.login('patient');
  await f.change(doctor.id, false);
  for (const fields of [
    { existingAppointmentId: same.id },
    { excludeAppointmentId: same.id },
    { allowExisting: true },
    { acceptingNewBookings: true },
  ]) {
    const r = await f.call(
      '/appointments',
      f.admin,
      'POST',
      f.input(doctor.id, { date: addDays(clinicToday(), 42), ...fields }),
    );
    assert.equal(r.status, 409);
    assert.equal(r.data.error, DOCTOR_BOOKING_PAUSED);
    assert.equal(
      (
        await f.call('/visit-duration/bookings', f.admin, 'POST', {
          ...f.input(doctor.id),
          durationMinutes: 60,
          requestId: randomUUID(),
          ...fields,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.call('/appointment-series/preview', f.admin, 'POST', {
          ...f.seriesInput(doctor.id),
          ...fields,
        })
      ).status,
      400,
    );
  }
  assert.equal(
    (await f.call(`/slots?doctorId=${doctor.id}&date=${same.date}&excludeAppointmentId=${same.id}`))
      .status,
    401,
  );
  assert.equal(
    (await f.call(`/slots?doctorId=${doctor.id}&date=${same.date}&allowExisting=true`, patient))
      .status,
    400,
  );
  assert.equal(doctorAllowsBooking(f.db, doctor.id, same.id, 'patient-ananya'), true);
  assert.equal(doctorAllowsBooking(f.db, doctor.id, foreign.id, 'patient-ananya'), false);
  assert.equal(doctorAllowsBooking(f.db, doctor.id, same.id, 'wrong-patient'), false);
  const scheduling = createScheduling({
    db: f.db,
    actor: () => f.admin.user,
    audit: () => {},
    fail: (status, message) => {
      throw Object.assign(new Error(message), { status });
    },
  });
  assert.throws(
    () =>
      scheduling.validateBooking(
        { ...f.input(doctor.id), mode: 'in-person' } as Parameters<
          typeof scheduling.validateBooking
        >[0],
        { excludeAppointmentIds: [same.id] },
      ),
    /not accepting new bookings/,
  );
  assert.equal(
    (await f.call(`/appointments/${same.id}`, patient, 'PATCH', { status: 'cancelled' })).status,
    200,
  );
  assert.equal(doctorAllowsBooking(f.db, doctor.id, same.id, 'patient-ananya'), false);
  assert.deepEqual(
    (
      await f.call(
        `/slots?doctorId=${doctor.id}&date=${same.date}&excludeAppointmentId=${same.id}`,
        patient,
      )
    ).data,
    [],
  );
});

test('all private reads, writes and exact replays revalidate current admin/session security under the transaction lock', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor(),
    saved = await f.change(doctor.id, false),
    next = await f.command(doctor.id, true),
    external = openDatabase(f.databasePath),
    exec = f.db.exec.bind(f.db),
    account = external.prepare('SELECT role,data FROM users WHERE id=?').get(f.admin.user.id)!,
    session = external.prepare('SELECT * FROM sessions WHERE userId=?').get(f.admin.user.id)!,
    columns = Object.keys(session);
  const routes: [string, string, unknown?][] = [
    [path(doctor.id), 'GET'],
    [`${path(doctor.id)}/history`, 'GET'],
    [path(doctor.id), 'POST', saved.body],
    [path(doctor.id), 'POST', next],
  ];
  try {
    for (const change of ['revoked', 'expired', 'csrf', 'inactive', 'temporary', 'role', 'mfa'])
      for (const [route, method, body] of routes) {
        let injected = false;
        f.db.exec = ((sql: string) => {
          if (sql === 'BEGIN IMMEDIATE' && !injected) {
            injected = true;
            if (change === 'revoked')
              external.prepare('DELETE FROM sessions WHERE userId=?').run(f.admin.user.id);
            if (change === 'expired')
              external
                .prepare('UPDATE sessions SET expiresAt=0 WHERE userId=?')
                .run(f.admin.user.id);
            if (change === 'csrf')
              external
                .prepare("UPDATE sessions SET csrfToken='changed' WHERE userId=?")
                .run(f.admin.user.id);
            if (change === 'inactive')
              external
                .prepare("UPDATE users SET data=json_set(data,'$.active',json('false')) WHERE id=?")
                .run(f.admin.user.id);
            if (change === 'temporary')
              external
                .prepare(
                  "UPDATE users SET data=json_set(data,'$.mustChangePassword',json('true')) WHERE id=?",
                )
                .run(f.admin.user.id);
            if (change === 'role')
              external
                .prepare(
                  "UPDATE users SET role='doctor',data=json_set(data,'$.role','doctor','$.doctorId',?) WHERE id=?",
                )
                .run(doctor.id, f.admin.user.id);
            if (change === 'mfa')
              external
                .prepare(
                  'INSERT INTO mfaCredentials(userId,id,secret,enabledAt,lastStep) VALUES(?,?,?,?,?)',
                )
                .run(
                  f.admin.user.id,
                  randomUUID(),
                  'synthetic-unused-secret',
                  new Date().toISOString(),
                  -1,
                );
          }
          return exec(sql);
        }) as typeof f.db.exec;
        const before = f.state(),
          response = await f.call(route, f.admin, method, body);
        assert.equal(injected, true);
        assert.equal(
          response.status,
          ['temporary', 'role'].includes(change) ? 403 : 401,
          `${change}/${method}/${route}`,
        );
        assert.deepEqual(f.state(), before);
        f.db.exec = exec;
        external
          .prepare('UPDATE users SET role=?,data=? WHERE id=?')
          .run(account.role, account.data, f.admin.user.id);
        external.prepare('DELETE FROM mfaCredentials WHERE userId=?').run(f.admin.user.id);
        external
          .prepare(
            `INSERT OR REPLACE INTO sessions(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
          )
          .run(...columns.map((k) => session[k]));
      }
  } finally {
    f.db.exec = exec;
    external.close();
  }
});

test('status, immutable event/receipt, audit and response-read failures roll back together; failed read audit exposes no private result', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor(),
    input = await f.command(doctor.id, false);
  for (const point of ['status', 'event', 'command', 'audit', 'response']) {
    const prepare = f.db.prepare.bind(f.db),
      before = f.state();
    let fired = false,
      reads = 0;
    if (point === 'response')
      f.db.prepare = ((sql: string) => {
        const statement = prepare(sql);
        if (
          sql ===
          'SELECT data FROM doctorBookingChanges WHERE doctorId=? ORDER BY rowid DESC LIMIT 1'
        ) {
          const getRow = statement.get.bind(statement);
          statement.get = ((...params: Parameters<typeof statement.get>) => {
            if (++reads === 2) {
              fired = true;
              throw new Error('Synthetic booking-status response failure');
            }
            return getRow(...params);
          }) as typeof statement.get;
        }
        return statement;
      }) as typeof f.db.prepare;
    else {
      const table =
        point === 'status'
          ? 'doctorBookingStatuses'
          : point === 'event'
            ? 'doctorBookingChanges'
            : point === 'command'
              ? 'doctorBookingCommands'
              : 'audit';
      f.db.exec(
        `CREATE TRIGGER doctor_booking_failure BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'Synthetic booking-status write failure'); END;`,
      );
    }
    try {
      const r = await f.call(path(doctor.id), f.admin, 'POST', input);
      assert.equal(r.status, 500, point);
      assert.deepEqual(f.state(), before);
      assert.equal(r.data.context, undefined);
      if (point === 'response') assert.equal(fired, true);
    } finally {
      f.db.prepare = prepare;
      if (point !== 'response') f.db.exec('DROP TRIGGER doctor_booking_failure');
    }
  }
  const saved = await f.change(doctor.id, false),
    resume = await f.command(doctor.id, true),
    before = f.state();
  f.db.exec(
    "CREATE TRIGGER doctor_booking_update_failure BEFORE UPDATE ON doctorBookingStatuses BEGIN SELECT RAISE(ABORT,'Synthetic status update failure'); END;",
  );
  assert.equal((await f.call(path(doctor.id), f.admin, 'POST', resume)).status, 500);
  assert.deepEqual(f.state(), before);
  f.db.exec('DROP TRIGGER doctor_booking_update_failure');
  f.db.exec(
    "CREATE TRIGGER doctor_booking_read_failure BEFORE INSERT ON audit WHEN json_extract(NEW.data,'$.action') LIKE 'viewed doctor booking%' BEGIN SELECT RAISE(ABORT,'Synthetic read audit failure'); END;",
  );
  for (const route of [path(doctor.id), `${path(doctor.id)}/history`]) {
    const r = await f.call(route, f.admin);
    assert.equal(r.status, 500);
    assert.equal(r.data.items, undefined);
    assert.equal(r.data.doctor, undefined);
  }
  assert.deepEqual(f.state(), before);
  assert.equal((await f.call(path(doctor.id), f.admin, 'POST', saved.body)).status, 200);
});

test('a pause committed between middleware and booking BEGIN is authoritative on ordinary/custom/waitlist/series paths', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor();
  await f.schedule(doctor.id);
  await f.change(doctor.id, false);
  await f.change(doctor.id, true);
  const source = await f.call(
      '/appointment-series/preview',
      f.admin,
      'POST',
      f.seriesInput(doctor.id),
    ),
    waiting = await f.call('/waitlist', f.admin, 'POST', {
      patientId: 'patient-ananya',
      doctorId: doctor.id,
      mode: 'in-person',
      startDate: addDays(clinicToday(), 40),
      endDate: addDays(clinicToday(), 45),
      reason: 'Existing waitlist',
    });
  assert.equal(waiting.status, 201);
  const external = openDatabase(f.databasePath),
    exec = f.db.exec.bind(f.db);
  try {
    for (const [route, body] of [
      ['/appointments', f.input(doctor.id)],
      [
        '/visit-duration/bookings',
        { ...f.input(doctor.id), durationMinutes: 60, requestId: randomUUID() },
      ],
      [
        '/waitlist',
        {
          patientId: 'patient-ananya',
          doctorId: doctor.id,
          mode: 'online',
          startDate: addDays(clinicToday(), 40),
          endDate: addDays(clinicToday(), 45),
          reason: 'New request',
        },
      ],
      [
        '/appointments',
        { ...f.input(doctor.id), waitlistId: waiting.data.id, patientConfirmed: true },
      ],
      [
        '/appointment-series',
        {
          input: source.data.input,
          expectedRevision: source.data.revision,
          requestId: randomUUID(),
          patientConfirmed: true,
        },
      ],
    ] as const) {
      let injected = false;
      f.db.exec = ((sql: string) => {
        if (sql === 'BEGIN IMMEDIATE' && !injected) {
          injected = true;
          external
            .prepare('UPDATE doctorBookingStatuses SET acceptingNewBookings=0 WHERE id=?')
            .run(doctor.id);
        }
        return exec(sql);
      }) as typeof f.db.exec;
      const before = f.state(),
        r = await f.call(route, f.admin, 'POST', body);
      assert.equal(injected, true);
      assert.equal(r.status, 409, route);
      const after = f.state();
      assert.deepEqual({ ...after, status: [] }, { ...before, status: [] });
      f.db.exec = exec;
      external
        .prepare('UPDATE doctorBookingStatuses SET acceptingNewBookings=1 WHERE id=?')
        .run(doctor.id);
    }
  } finally {
    f.db.exec = exec;
    external.close();
  }
  const patient = await f.login('patient'),
    visit = await f.book(doctor.id),
    target = addDays(clinicToday(), 41);
  const writer = openDatabase(f.databasePath);
  let injected = false;
  f.db.exec = ((sql: string) => {
    if (sql === 'BEGIN IMMEDIATE' && !injected) {
      injected = true;
      writer
        .prepare('UPDATE doctorBookingStatuses SET acceptingNewBookings=0 WHERE id=?')
        .run(doctor.id);
    }
    return exec(sql);
  }) as typeof f.db.exec;
  try {
    const move = await f.call(`/appointments/${visit.id}`, patient, 'PATCH', {
      date: target,
      time: '09:00',
    });
    assert.equal(injected, true);
    assert.equal(move.status, 200);
    assert.equal(move.data.date, target);
  } finally {
    f.db.exec = exec;
    writer.close();
  }
});

test('independent connections serialize competing status changes, and duplicate commands produce only one immutable event', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor(),
    g = await fixture(t, f.databasePath),
    body = await f.command(doctor.id, false);
  const duplicate = await Promise.all([
    f.call(path(doctor.id), f.admin, 'POST', body),
    g.call(path(doctor.id), g.admin, 'POST', body),
  ]);
  assert.deepEqual(duplicate.map((r) => r.status).sort(), [200, 201]);
  assert.deepEqual(duplicate[0].data.change, duplicate[1].data.change);
  assert.equal(f.state().changes.length, 1);
  const resume = await f.command(doctor.id, true),
    competing = await Promise.all([
      f.call(path(doctor.id), f.admin, 'POST', resume),
      g.call(path(doctor.id), g.admin, 'POST', {
        ...resume,
        requestId: randomUUID(),
        reason: 'Independent competing change',
      }),
    ]);
  assert.deepEqual(competing.map((r) => r.status).sort(), [201, 409]);
  assert.equal(f.state().changes.length, 2);
  await f.schedule(doctor.id);
  const pause = await f.command(doctor.id, false),
    race = await Promise.all([
      g.call(path(doctor.id), g.admin, 'POST', pause),
      f.call('/appointments', f.admin, 'POST', f.input(doctor.id)),
    ]);
  assert.equal(race[0].status, 201);
  assert.ok([201, 409].includes(race[1].status));
  if (race[1].status === 201)
    assert.equal(get<Appointment>(f.db, 'appointments', race[1].data.id)?.status, 'scheduled');
  else assert.equal(race[1].data.error, DOCTOR_BOOKING_PAUSED);
});

test('history is scoped, SQL bounded and consistently ordered; count/page reads share the locked snapshot', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor(),
    other = f.doctor();
  for (let i = 0; i < 31; i++) await f.change(doctor.id, i % 2 === 1);
  await f.change(other.id, false);
  const prepare = f.db.prepare.bind(f.db),
    sizes: number[] = [];
  f.db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (sql.startsWith('SELECT data FROM doctorBookingChanges')) {
      assert.ok(sql.includes('WHERE doctorId=?'));
      assert.ok(sql.includes('LIMIT'));
      if (sql.includes('OFFSET')) {
        const all = statement.all.bind(statement);
        statement.all = ((...params: Parameters<typeof statement.all>) => {
          const rows = all(...params);
          sizes.push(rows.length);
          return rows;
        }) as typeof statement.all;
      }
    }
    return statement;
  }) as typeof f.db.prepare;
  try {
    const first = await f.call(`${path(doctor.id)}/history`, f.admin),
      last = await f.call(`${path(doctor.id)}/history?page=1000000&pageSize=10`, f.admin);
    assert.equal(first.data.total, 31);
    assert.equal(last.data.page, 4);
    assert.equal(last.data.totalPages, 4);
    assert.deepEqual(sizes, [25, 1]);
    const expected = prepare(
      'SELECT id FROM doctorBookingChanges WHERE doctorId=? ORDER BY createdAt DESC,id DESC LIMIT 25',
    )
      .all(doctor.id)
      .map((row) => row.id);
    assert.deepEqual(
      first.data.items.map((row: { id: string }) => row.id),
      expected,
    );
    for (const [sql, params, index] of [
      [
        'SELECT data FROM doctorBookingChanges WHERE doctorId=? ORDER BY rowid DESC LIMIT 1',
        [doctor.id],
        'doctor_booking_head',
      ],
      [
        'SELECT data FROM doctorBookingChanges WHERE doctorId=? ORDER BY createdAt DESC,id DESC LIMIT ? OFFSET ?',
        [doctor.id, 25, 0],
        'doctor_booking_history',
      ],
    ] as const) {
      const plan = JSON.stringify(prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params));
      assert.match(plan, new RegExp(index));
      assert.doesNotMatch(plan, /TEMP B-TREE/);
    }
  } finally {
    f.db.prepare = prepare;
  }
  const external = openDatabase(f.databasePath);
  external.exec('PRAGMA busy_timeout=0');
  let checked = false;
  f.db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (sql === 'SELECT COUNT(*) n FROM doctorBookingChanges WHERE doctorId=?') {
      const getRow = statement.get.bind(statement);
      statement.get = ((...params: Parameters<typeof statement.get>) => {
        const row = getRow(...params);
        assert.throws(() => external.exec('BEGIN IMMEDIATE'), /locked/);
        checked = true;
        return row;
      }) as typeof statement.get;
    }
    return statement;
  }) as typeof f.db.prepare;
  try {
    assert.equal((await f.call(`${path(doctor.id)}/history`, f.admin)).status, 200);
    assert.equal(checked, true);
  } finally {
    f.db.prepare = prepare;
    external.close();
  }
});

test('legacy profile bytes remain unchanged and booking state, append-only evidence and exact receipts survive restart', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor(),
    untouched = f.doctor(),
    raw = f.db.prepare('SELECT data FROM doctors WHERE id=?').get(untouched.id)!.data,
    saved = await f.change(doctor.id, false),
    resumed = await f.change(doctor.id, true);
  for (const [table, column, key] of [
    ['doctorBookingChanges', 'id', saved.value.change.id],
    ['doctorBookingCommands', 'requestId', saved.body.requestId],
  ] as const) {
    assert.throws(
      () => f.db.prepare(`UPDATE ${table} SET ${column}=${column} WHERE ${column}=?`).run(key),
      /immutable/,
    );
    assert.throws(
      () => f.db.prepare(`DELETE FROM ${table} WHERE ${column}=?`).run(key),
      /immutable/,
    );
  }
  await f.close();
  const reopened = await fixture(t, f.databasePath),
    source = await reopened.context(untouched.id);
  assert.equal(source.latestChange, null);
  assert.equal(source.acceptingNewBookings, true);
  assert.equal(
    reopened.db.prepare('SELECT data FROM doctors WHERE id=?').get(untouched.id)!.data,
    raw,
  );
  assert.equal((await reopened.context(doctor.id)).revision, resumed.value.context.revision);
  const replay = await reopened.call(path(doctor.id), reopened.admin, 'POST', saved.body);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data.change, saved.value.change);
  assert.deepEqual(replay.data.receipt, saved.value.receipt);
  assert.equal(replay.data.context.acceptingNewBookings, true);
  const user = reopened.db
    .prepare('SELECT data FROM users WHERE id=?')
    .get(reopened.admin.user.id)!.data;
  assert.notEqual(JSON.parse(user as string).active, false);
});
