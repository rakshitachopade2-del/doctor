import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SQLInputValue } from 'node:sqlite';
import { createApp } from '../server/app.ts';
import {
  addDays,
  clinicToday,
  createUser,
  get,
  openDatabase,
  seedDemo,
  type DB,
} from '../server/db.ts';
import type { Appointment, Doctor } from '../shared/types.ts';
import type { VisitDurationContext, VisitDurationMutation } from '../shared/visit-duration.ts';

const app = createApp({ databasePath: ':memory:', demoMode: true });
type Client = { cookie?: string; csrf?: string; id?: string };
const admin: Client = {},
  doctor: Client = {},
  reception: Client = {},
  patient: Client = {},
  temporary: Client = {};
let server: Server, base: string, doctorA: string, doctorB: string;
let sequence = 20;
const future = () => addDays(clinicToday(), ++sequence);
const windows = Array.from({ length: 7 }, (_, day) => ({
  day,
  start: '09:00',
  end: '18:00',
  mode: 'both',
}));
async function call(
  path: string,
  client: Client = admin,
  method = 'GET',
  body?: unknown,
  target = base,
) {
  const response = await fetch(`${target}/api${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(client.cookie ? { Cookie: client.cookie } : {}),
      ...(client.csrf ? { 'X-CSRF-Token': client.csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const cookie = response.headers.get('set-cookie');
  if (cookie) client.cookie = cookie.split(';')[0];
  const data = await response.json();
  if (data.csrfToken) client.csrf = data.csrfToken;
  if (data.user?.id) client.id = data.user.id;
  return { status: response.status, data, headers: response.headers };
}
async function listen(application: ReturnType<typeof createApp>) {
  let server: Server;
  await new Promise<void>((resolve) => {
    server = application.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server!.address();
  assert.ok(address && typeof address !== 'string');
  return { server: server!, base: `http://127.0.0.1:${address.port}` };
}
async function close(value: Server) {
  await new Promise<void>((resolve, reject) =>
    value.close((error) => (error ? reject(error) : resolve())),
  );
}
async function setSchedule(doctorId: string, durationMinutes = 20, sessions = windows) {
  const result = await call(`/schedules/${doctorId}`, admin, 'PUT', {
    durationMinutes,
    windows: sessions,
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
}
async function newDoctor(durationMinutes = 20) {
  const result = await call('/doctors', admin, 'POST', {
    name: `Dr. Duration ${randomUUID().slice(0, 8)}`,
    title: 'Dermatologist',
    qualifications: 'Synthetic profile',
    specialties: ['General dermatology'],
    experience: 2,
    fee: 600,
    bio: 'Synthetic duration fixture',
    languages: ['English'],
    color: '#b3c7aa',
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  await setSchedule(result.data.id, durationMinutes);
  return result.data.id as string;
}
function bookingBody(overrides: Record<string, unknown> = {}) {
  return {
    patientId: 'patient-ananya',
    doctorId: doctorA,
    date: future(),
    time: '09:00',
    mode: 'in-person',
    reason: 'Synthetic extended visit',
    durationMinutes: 90,
    requestId: randomUUID(),
    ...overrides,
  };
}
async function custom(
  overrides: Record<string, unknown> = {},
  client = reception,
): Promise<VisitDurationMutation> {
  const result = await call('/visit-duration/bookings', client, 'POST', bookingBody(overrides));
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data;
}
async function ordinary(overrides: Record<string, unknown> = {}): Promise<Appointment> {
  const { durationMinutes: _minutes, requestId: _uuid, ...body } = bookingBody(overrides);
  const result = await call('/appointments', reception, 'POST', body);
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data;
}
async function context(id: string, client = reception): Promise<VisitDurationContext> {
  const result = await call(`/appointments/${id}/duration`, client);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data;
}
async function changeBody(appointment: Appointment, fields: Record<string, unknown> = {}) {
  return {
    durationPolicy: 'custom',
    durationMinutes: 60,
    date: appointment.date,
    time: appointment.time,
    reason: 'PRIVATE_DURATION_REASON',
    expectedRevision: (await context(appointment.id)).revision,
    requestId: randomUUID(),
    ...fields,
  };
}
async function slots(date: string, overrides: Record<string, string> = {}, client = reception) {
  return call(
    `/visit-duration/slots?${new URLSearchParams({
      doctorId: doctorA,
      patientId: 'patient-ananya',
      date,
      mode: 'in-person',
      durationPolicy: 'custom',
      durationMinutes: '90',
      ...overrides,
    })}`,
    client,
  );
}
function fixture(overrides: Partial<Appointment>, application = app): Appointment {
  const value: Appointment = {
    id: randomUUID(),
    patientId: 'patient-ananya',
    patientName: 'Synthetic patient',
    doctorId: doctorA,
    doctorName: 'Historical clinician',
    date: future(),
    time: '09:00',
    mode: 'in-person',
    status: 'scheduled',
    reason: 'Synthetic legacy visit',
    createdAt: new Date().toISOString(),
    fee: 300,
    ...overrides,
  };
  application.locals.db
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
function counts() {
  return Object.fromEntries(
    [
      'appointments',
      'visitDurationEvents',
      'visitDurationCommands',
      'resourceAllocationEvents',
      'resourceReservations',
      'audit',
      'activity',
    ].map((table) => [table, app.locals.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n]),
  );
}
async function room() {
  const result = await call('/clinic-resources', admin, 'POST', {
    name: `Duration room ${randomUUID()}`,
    kind: 'room',
    requestId: randomUUID(),
  });
  assert.equal(result.status, 201);
  return result.data.resource.id as string;
}
async function allocate(appointmentId: string, resourceIds: string[]) {
  const source = await call(`/appointments/${appointmentId}/resources`);
  const result = await call(`/appointments/${appointmentId}/resources`, reception, 'PUT', {
    resourceIds,
    reason: 'Operational fixture',
    expectedRevision: source.data.revision,
    requestId: randomUUID(),
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
}
before(async () => {
  createUser(
    app.locals.db,
    {
      id: 'duration-temporary',
      name: 'Temporary staff',
      email: 'duration-temp@example.test',
      role: 'admin',
      mustChangePassword: true,
    },
    'DurationTemporary2026!',
  );
  ({ server, base } = await listen(app));
  for (const [role, client] of [
    ['admin', admin],
    ['doctor', doctor],
    ['reception', reception],
    ['patient', patient],
  ] as const)
    assert.equal(
      (
        await call('/auth/login', client, 'POST', {
          email: `${role}@derma.demo`,
          password: 'DemoClinic2026!',
        })
      ).status,
      200,
    );
  assert.equal(
    (
      await call('/auth/login', temporary, 'POST', {
        email: 'duration-temp@example.test',
        password: 'DurationTemporary2026!',
      })
    ).status,
    200,
  );
  doctorA = await newDoctor();
  doctorB = await newDoctor(60);
});
after(async () => {
  await close(server);
  app.locals.db.close();
});

test('ordinary and legacy visits keep the current schedule default reschedule behavior', async () => {
  const original = await ordinary();
  assert.equal(original.durationMinutes, 20);
  assert.equal(original.durationPolicy, undefined);
  assert.equal((await context(original.id)).history.length, 0);
  await setSchedule(doctorA, 30);
  const result = await call(`/appointments/${original.id}`, patient, 'PATCH', { time: '10:00' });
  assert.equal(result.status, 200);
  assert.equal(result.data.durationMinutes, 30);
  const legacy = fixture({});
  assert.equal((await context(legacy.id)).appointment.durationMinutes, undefined);
  const moved = await call(`/appointments/${legacy.id}`, reception, 'PATCH', { time: '11:00' });
  assert.equal(moved.status, 200);
  assert.equal(moved.data.durationMinutes, 30);
  await setSchedule(doctorA, 20);
});

test('custom visits use 5-minute window-relative cadence, actual length and bounded full-session fit', async () => {
  const date = future();
  const available = await slots(date);
  assert.equal(available.status, 200);
  assert.ok(available.data.includes('09:05'));
  assert.ok(available.data.includes('16:30'));
  assert.ok(!available.data.includes('16:35'));
  const saved = await custom({ date, time: '09:05' });
  assert.equal(saved.appointment.durationMinutes, 90);
  assert.equal(saved.appointment.durationPolicy, 'custom');
  assert.equal(saved.appointment.fee, 600);
  assert.equal(saved.event.before, null);
  assert.equal(saved.event.operation, 'custom-booking');
  assert.equal(saved.event.createdById, reception.id);
  assert.deepEqual(saved.event.after, saved.appointment);
  for (const time of ['09:03', '16:35'])
    assert.equal(
      (
        await call(
          '/visit-duration/bookings',
          reception,
          'POST',
          bookingBody({ date: future(), time }),
        )
      ).status,
      400,
    );
  for (const durationMinutes of [0, 14, 16, 241, 245, 20.5, '90'])
    assert.equal(
      (await call('/visit-duration/bookings', reception, 'POST', bookingBody({ durationMinutes })))
        .status,
      400,
    );
  const offsetDoctor = await newDoctor();
  await setSchedule(
    offsetDoctor,
    20,
    windows.map((window) => ({ ...window, start: '09:02' })),
  );
  const offset = await slots(future(), { doctorId: offsetDoctor });
  assert.ok(offset.data.includes('09:07'));
  assert.ok(!offset.data.includes('09:05'));
});

test('full custom intervals enforce doctor and patient overlaps, closure boundaries, breaks and modes', async () => {
  const date = future();
  await custom({ date, time: '10:00' });
  for (const candidate of [
    { date, time: '09:00', patientId: 'patient-2' },
    { date, time: '10:30', doctorId: doctorB },
  ])
    assert.equal(
      (await call('/visit-duration/bookings', reception, 'POST', bookingBody(candidate))).status,
      409,
    );
  await custom({ date, time: '11:30', patientId: 'patient-2' });
  const available = await slots(date, { doctorId: doctorB });
  assert.ok(!available.data.includes('09:00'));
  assert.ok(available.data.includes('11:30'));
  const specialDoctor = await newDoctor();
  const sessions = windows.flatMap((window) => [
    { ...window, start: '09:00', end: '11:00', mode: 'in-person' },
    { ...window, start: '12:00', end: '14:00', mode: 'online' },
  ]);
  await setSchedule(specialDoctor, 20, sessions);
  const closedDate = future();
  assert.equal(
    (
      await call('/schedule-closures', admin, 'POST', {
        doctorId: specialDoctor,
        startDate: closedDate,
        endDate: closedDate,
        startTime: '09:30',
        endTime: '10:00',
        reason: 'PRIVATE_CLOSURE_REASON',
      })
    ).status,
    201,
  );
  const blocked = await slots(closedDate, { doctorId: specialDoctor, durationMinutes: '60' });
  assert.deepEqual(blocked.data, ['10:00']);
  assert.ok(!JSON.stringify(blocked.data).includes('PRIVATE'));
  assert.equal(
    (
      await call(
        '/visit-duration/bookings',
        reception,
        'POST',
        bookingBody({
          doctorId: specialDoctor,
          date: closedDate,
          time: '09:00',
          durationMinutes: 60,
        }),
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await call(
        '/visit-duration/bookings',
        reception,
        'POST',
        bookingBody({
          doctorId: specialDoctor,
          date: closedDate,
          time: '10:30',
          durationMinutes: 60,
        }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        '/visit-duration/bookings',
        reception,
        'POST',
        bookingBody({
          doctorId: specialDoctor,
          date: closedDate,
          time: '12:00',
          durationMinutes: 60,
        }),
      )
    ).status,
    400,
  );
});

test('staff slot validation rejects unknown or duplicate inputs and honors selected patient/exclusion identity', async () => {
  const visit = (await custom()).appointment;
  const baseQuery = new URLSearchParams({
    doctorId: doctorA,
    patientId: visit.patientId,
    date: visit.date,
    mode: visit.mode,
    durationPolicy: 'custom',
    durationMinutes: '90',
  }).toString();
  for (const extra of [
    '&durationMinutes=90',
    '&date=2026-02-30',
    '&unknown=yes',
    '&doctorId=other',
  ])
    assert.equal((await call(`/visit-duration/slots?${baseQuery}${extra}`, reception)).status, 400);
  for (const query of [
    baseQuery.replace('durationMinutes=90', 'durationMinutes=16'),
    baseQuery.replace('durationPolicy=custom', 'durationPolicy=schedule'),
    baseQuery.replace('&durationMinutes=90', ''),
    baseQuery.replace(visit.date, '2026-02-30'),
  ])
    assert.equal((await call(`/visit-duration/slots?${query}`, reception)).status, 400);
  const mismatch = await slots(visit.date, {
    patientId: 'patient-2',
    excludeAppointmentId: visit.id,
  });
  assert.equal(mismatch.status, 400);
  const own = await slots(visit.date, { excludeAppointmentId: visit.id });
  assert.ok(own.data.includes(visit.time));
  const defaultQuery = baseQuery
    .replace('durationPolicy=custom', 'durationPolicy=schedule')
    .replace('&durationMinutes=90', '');
  assert.equal((await call(`/visit-duration/slots?${defaultQuery}`, reception)).status, 200);
  assert.deepEqual((await slots(addDays(clinicToday(), 181))).data, []);
  assert.equal(
    (
      await call(
        '/visit-duration/bookings',
        reception,
        'POST',
        bookingBody({ date: addDays(clinicToday(), -1) }),
      )
    ).status,
    400,
  );
});

test('patients and temporary sessions cannot read private duration evidence or override appointment lengths', async () => {
  const visit = (await custom()).appointment;
  const body = await changeBody(visit);
  for (const client of [patient, temporary]) {
    assert.equal((await call(`/appointments/${visit.id}/duration`, client)).status, 403);
    assert.equal(
      (await call(`/appointments/${visit.id}/duration`, client, 'POST', body)).status,
      403,
    );
    assert.equal(
      (await call('/visit-duration/bookings', client, 'POST', bookingBody())).status,
      403,
    );
    assert.equal((await slots(visit.date, {}, client)).status, 403);
  }
  assert.equal((await call(`/appointments/${visit.id}/duration`, {})).status, 401);
  for (const field of [{ durationMinutes: 15 }, { durationPolicy: 'schedule' }]) {
    assert.equal(
      (await call(`/appointments/${visit.id}`, patient, 'PATCH', { time: '12:00', ...field }))
        .status,
      400,
    );
    assert.equal(
      (
        await call('/appointments', patient, 'POST', {
          patientId: visit.patientId,
          doctorId: doctorA,
          date: future(),
          time: '09:00',
          mode: 'in-person',
          reason: 'Synthetic override',
          ...field,
        })
      ).status,
      400,
    );
  }
  assert.equal(
    (await call(`/slots?doctorId=${doctorA}&date=${visit.date}&durationMinutes=15`, patient))
      .status,
    400,
  );
  assert.equal(
    (await call(`/slots?doctorId=${doctorA}&date=${visit.date}&durationPolicy=custom`, {})).status,
    400,
  );
  assert.equal(
    (
      await call(
        `/slots?doctorId=${doctorA}&date=${visit.date}&excludeAppointmentId=${visit.id}`,
        temporary,
      )
    ).status,
    403,
  );
  assert.equal((await call(`/appointments/${visit.id}/duration`, doctor)).status, 200);
});

test('custom length survives generic patient and staff rescheduling across doctor, mode and default changes', async () => {
  const original = (await custom({ time: '09:05' })).appointment;
  await setSchedule(doctorA, 60);
  const available = await call(
    `/slots?doctorId=${doctorB}&date=${original.date}&mode=online&excludeAppointmentId=${original.id}`,
    patient,
  );
  assert.ok(available.data.includes('10:05'));
  assert.ok(!available.data.includes('16:35'));
  const moved = await call(`/appointments/${original.id}`, patient, 'PATCH', {
    doctorId: doctorB,
    mode: 'online',
    time: '10:05',
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  assert.equal(moved.data.durationMinutes, 90);
  assert.equal(moved.data.durationPolicy, 'custom');
  await setSchedule(doctorB, 20);
  const again = await call(`/appointments/${original.id}`, reception, 'PATCH', { time: '12:05' });
  assert.equal(again.status, 200);
  assert.equal(again.data.durationMinutes, 90);
  const defaultPublic = await call(`/slots?doctorId=${doctorB}&date=${future()}&mode=online`, {});
  assert.ok(defaultPublic.data.includes('09:20'));
  assert.ok(!defaultPublic.data.includes('09:05'));
  const snapshot = (await context(original.id)).history[0];
  assert.equal(snapshot.after.time, '09:05');
  assert.equal(snapshot.after.doctorId, doctorA);
  await setSchedule(doctorA, 20);
});

test('duration-only edits preserve booked fee/name; actual moves adopt current doctor details and default restoration is explicit', async () => {
  const visit = await ordinary();
  const oldDoctor = get<Doctor>(app.locals.db, 'doctors', doctorA)!;
  const changedDoctor = { ...oldDoctor, name: 'Updated synthetic doctor', fee: 850 };
  assert.equal((await call(`/doctors/${doctorA}`, admin, 'PATCH', changedDoctor)).status, 200);
  const source = await context(visit.id);
  assert.equal(source.currentDoctorFee, 850);
  assert.equal(source.currentDoctorName, changedDoctor.name);
  const edited = await call(
    `/appointments/${visit.id}/duration`,
    reception,
    'POST',
    await changeBody(visit),
  );
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.equal(edited.data.appointment.fee, visit.fee);
  assert.equal(edited.data.appointment.doctorName, visit.doctorName);
  assert.equal(edited.data.event.reason, 'PRIVATE_DURATION_REASON');
  const moved = await call(
    `/appointments/${visit.id}/duration`,
    reception,
    'POST',
    await changeBody(edited.data.appointment, { time: '12:00' }),
  );
  assert.equal(moved.status, 200);
  assert.equal(moved.data.appointment.fee, 850);
  assert.equal(moved.data.appointment.doctorName, changedDoctor.name);
  const restored = await call(
    `/appointments/${visit.id}/duration`,
    reception,
    'POST',
    await changeBody(moved.data.appointment, {
      durationPolicy: 'schedule',
      durationMinutes: undefined,
    }),
  );
  assert.equal(restored.status, 200);
  assert.equal(restored.data.appointment.durationMinutes, 20);
  assert.equal(restored.data.appointment.durationPolicy, 'schedule');
  const same = await changeBody(restored.data.appointment, {
    durationPolicy: 'schedule',
    durationMinutes: undefined,
  });
  assert.equal(
    (await call(`/appointments/${visit.id}/duration`, reception, 'POST', same)).status,
    400,
  );
  assert.equal((await call(`/doctors/${doctorA}`, admin, 'PATCH', oldDoctor)).status, 200);
});

test('source revision rejects changed schedules, doctor details and generic edits without losing a valid fresh command', async () => {
  const visit = (await custom()).appointment;
  let body = await changeBody(visit);
  await setSchedule(doctorA, 30);
  assert.equal(
    (await call(`/appointments/${visit.id}/duration`, reception, 'POST', body)).status,
    409,
  );
  body = await changeBody(visit);
  const currentDoctor = get<Doctor>(app.locals.db, 'doctors', doctorA)!;
  await call(`/doctors/${doctorA}`, admin, 'PATCH', { ...currentDoctor, fee: 700 });
  assert.equal(
    (await call(`/appointments/${visit.id}/duration`, reception, 'POST', body)).status,
    409,
  );
  body = await changeBody(visit);
  assert.equal(
    (await call(`/appointments/${visit.id}`, patient, 'PATCH', { time: '11:00' })).status,
    200,
  );
  assert.equal(
    (await call(`/appointments/${visit.id}/duration`, reception, 'POST', body)).status,
    409,
  );
  const latest = (await context(visit.id)).appointment;
  assert.equal(
    (await call(`/appointments/${visit.id}/duration`, reception, 'POST', await changeBody(latest)))
      .status,
    200,
  );
  await call(`/doctors/${doctorA}`, admin, 'PATCH', currentDoctor);
  await setSchedule(doctorA, 20);
});

test('duration editing is limited to future scheduled visits and preserves read-only history for other states', async () => {
  for (const fields of [
    { status: 'checked-in' },
    { status: 'in-consultation' },
    { status: 'completed' },
    { status: 'cancelled' },
    { status: 'no-show' },
    { date: addDays(clinicToday(), -1) },
  ] as Partial<Appointment>[]) {
    const visit = fixture(fields);
    const source = await context(visit.id);
    assert.equal(source.canChange, false);
    const result = await call(
      `/appointments/${visit.id}/duration`,
      reception,
      'POST',
      await changeBody(visit, { date: future() }),
    );
    assert.equal(result.status, 409, JSON.stringify(result.data));
  }
  const visit = (await custom()).appointment;
  const before = get<Appointment>(app.locals.db, 'appointments', visit.id)!;
  const cancelled = await call(`/appointments/${visit.id}`, patient, 'PATCH', {
    status: 'cancelled',
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.durationMinutes, before.durationMinutes);
  assert.equal(cancelled.data.durationPolicy, 'custom');
  assert.equal(cancelled.data.fee, before.fee);
});

test('canonical booking and change command replay returns original proof after later cancellation with no duplicated effects', async () => {
  const body = bookingBody();
  const initial = await call('/visit-duration/bookings', reception, 'POST', {
    ...body,
    requestId: body.requestId.toUpperCase(),
  });
  assert.equal(initial.status, 201);
  assert.equal(initial.data.event.requestId, body.requestId);
  const count = counts();
  const again = await call('/visit-duration/bookings', reception, 'POST', body);
  assert.equal(again.status, 200);
  assert.deepEqual(again.data, initial.data);
  assert.deepEqual(counts(), count);
  assert.equal((await call('/visit-duration/bookings', admin, 'POST', body)).status, 409);
  assert.equal(
    (await call('/visit-duration/bookings', reception, 'POST', { ...body, durationMinutes: 95 }))
      .status,
    409,
  );
  const command = await changeBody(initial.data.appointment);
  const changed = await call(
    `/appointments/${initial.data.appointment.id}/duration`,
    reception,
    'POST',
    command,
  );
  assert.equal(changed.status, 200);
  assert.equal(
    (
      await call(`/appointments/${initial.data.appointment.id}/duration`, reception, 'POST', {
        ...command,
        expectedRevision: '0'.repeat(64),
      })
    ).status,
    409,
  );
  await call(`/appointments/${initial.data.appointment.id}`, patient, 'PATCH', {
    status: 'cancelled',
  });
  const terminalCounts = counts();
  const replay = await call(
    `/appointments/${initial.data.appointment.id}/duration`,
    reception,
    'POST',
    command,
  );
  assert.equal(replay.status, 200);
  assert.equal(replay.data.appointment.status, 'cancelled');
  assert.deepEqual(replay.data.event, changed.data.event);
  assert.deepEqual(counts(), terminalCounts);
  const bookingReplay = await call('/visit-duration/bookings', reception, 'POST', body);
  assert.equal(bookingReplay.status, 200);
  assert.deepEqual(bookingReplay.data.event, initial.data.event);
  const other = (await custom()).appointment;
  assert.equal(
    (await call(`/appointments/${other.id}/duration`, reception, 'POST', command)).status,
    409,
  );
  assert.equal(
    (
      await call(
        `/appointments/${other.id}/duration`,
        reception,
        'POST',
        await changeBody(other, { requestId: body.requestId }),
      )
    ).status,
    409,
  );
});

test('resource overlap rejects resize atomically while adjacent intervals remain available and successful edits resize reservations', async () => {
  const date = future(),
    resourceId = await room();
  const first = await ordinary({ date, time: '09:00' });
  const second = (
    await custom({
      date,
      time: '10:00',
      durationMinutes: 20,
      doctorId: doctorB,
      patientId: 'patient-2',
    })
  ).appointment;
  await allocate(first.id, [resourceId]);
  await allocate(second.id, [resourceId]);
  const body = await changeBody(first, { durationMinutes: 90 });
  const beforeCounts = counts();
  const reservation = app.locals.db
    .prepare('SELECT * FROM resourceReservations WHERE appointmentId=?')
    .all(first.id);
  const result = await call(`/appointments/${first.id}/duration`, reception, 'POST', body);
  assert.equal(result.status, 409);
  assert.deepEqual(counts(), beforeCounts);
  assert.deepEqual(get(app.locals.db, 'appointments', first.id), first);
  assert.deepEqual(
    app.locals.db.prepare('SELECT * FROM resourceReservations WHERE appointmentId=?').all(first.id),
    reservation,
  );
  const candidates = await slots(date, { excludeAppointmentId: first.id, durationMinutes: '90' });
  assert.ok(!candidates.data.includes('09:00'));
  assert.ok(candidates.data.includes('10:20'));
  const adjacent = await call(`/appointments/${first.id}/duration`, reception, 'POST', {
    ...body,
    durationMinutes: 60,
  });
  assert.equal(adjacent.status, 200, JSON.stringify(adjacent.data));
  const resized = (await call(`/appointments/${first.id}/resources`)).data;
  assert.equal(resized.appointment.durationMinutes, 60);
  const move = await changeBody(adjacent.data.appointment, { time: '10:20', durationMinutes: 90 });
  assert.equal(
    (await call(`/appointments/${first.id}/duration`, reception, 'POST', move)).status,
    200,
  );
  assert.equal(
    (await call(`/appointments/${first.id}/resources`)).data.appointment.durationMinutes,
    90,
  );
});

test('patient slots and forced reschedule use the retained custom interval for shared resources without exposing private conflict details', async () => {
  const date = future(),
    resourceId = await room();
  const visit = (await custom({ date, time: '12:00' })).appointment;
  const other = (
    await custom({
      date,
      time: '10:40',
      durationMinutes: 20,
      doctorId: doctorB,
      patientId: 'patient-2',
    })
  ).appointment;
  await allocate(visit.id, [resourceId]);
  await allocate(other.id, [resourceId]);
  const available = await call(
    `/slots?doctorId=${doctorA}&date=${date}&mode=in-person&excludeAppointmentId=${visit.id}`,
    patient,
  );
  assert.ok(!available.data.includes('10:00'));
  assert.ok(available.data.includes('11:00'));
  const body = { time: '10:00' },
    beforeCounts = counts();
  const blocked = await call(`/appointments/${visit.id}`, patient, 'PATCH', body);
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error, /Choose another slot or contact the clinic/);
  assert.ok(!JSON.stringify(blocked.data).includes(resourceId));
  assert.deepEqual(counts(), beforeCounts);
  assert.equal(
    (await call(`/appointments/${visit.id}`, patient, 'PATCH', { time: '11:00' })).status,
    200,
  );
  await call(`/appointments/${visit.id}`, patient, 'PATCH', { status: 'cancelled' });
  assert.equal(
    app.locals.db
      .prepare('SELECT count(*) n FROM resourceReservations WHERE appointmentId=?')
      .get(visit.id).n,
    0,
  );
});

test('atomic resize validates patient conflicts and maintenance windows using complete candidate intervals', async () => {
  const date = future(),
    resourceId = await room();
  const visit = await ordinary({ date });
  await allocate(visit.id, [resourceId]);
  const detail = (await call(`/clinic-resources/${resourceId}`)).data;
  assert.equal(
    (
      await call(`/clinic-resources/${resourceId}/closures`, admin, 'POST', {
        startDate: date,
        endDate: date,
        startTime: '10:00',
        endTime: '11:00',
        reason: 'Private maintenance',
        expectedRevision: detail.resource.revision,
        requestId: randomUUID(),
      })
    ).status,
    201,
  );
  let body = await changeBody(visit, { durationMinutes: 90 });
  assert.equal(
    (await call(`/appointments/${visit.id}/duration`, reception, 'POST', body)).status,
    409,
  );
  await custom({ date, doctorId: doctorB, time: '12:00', durationMinutes: 30 });
  body = await changeBody(visit, { time: '11:00', durationMinutes: 90 });
  assert.equal(
    (await call(`/appointments/${visit.id}/duration`, reception, 'POST', body)).status,
    409,
  );
  assert.deepEqual(get(app.locals.db, 'appointments', visit.id), visit);
});

test('failed audit and activity insert roll back bookings, edits, reservations, command receipts and notifications', async () => {
  const db = app.locals.db;
  for (const target of ['audit', 'activity'] as const) {
    const visit = await ordinary(),
      resourceId = await room();
    await allocate(visit.id, [resourceId]);
    const change = await changeBody(visit),
      booking = bookingBody(),
      beforeCounts = counts();
    const condition =
      target === 'audit'
        ? "json_extract(NEW.data,'$.action') IN ('changed visit duration','booked custom-length appointment')"
        : "NEW.eventKey LIKE 'visit-duration:%'";
    db.exec(
      `CREATE TRIGGER duration_failure BEFORE INSERT ON ${target} WHEN ${condition} BEGIN SELECT RAISE(ABORT,'Synthetic duration rollback'); END;`,
    );
    try {
      assert.equal(
        (await call('/visit-duration/bookings', reception, 'POST', booking)).status,
        500,
      );
      assert.equal(
        (await call(`/appointments/${visit.id}/duration`, reception, 'POST', change)).status,
        500,
      );
      assert.deepEqual(counts(), beforeCounts);
      assert.deepEqual(get(db, 'appointments', visit.id), visit);
    } finally {
      db.exec('DROP TRIGGER duration_failure');
    }
    assert.equal((await call('/visit-duration/bookings', reception, 'POST', booking)).status, 201);
    assert.equal(
      (await call(`/appointments/${visit.id}/duration`, reception, 'POST', change)).status,
      200,
    );
  }
});

test('simultaneous booking and stale duration commands cannot double-book or duplicate command evidence', async () => {
  const body = bookingBody();
  const repeated = await Promise.all([
    call('/visit-duration/bookings', reception, 'POST', body),
    call('/visit-duration/bookings', reception, 'POST', body),
  ]);
  assert.deepEqual(repeated.map((result) => result.status).sort(), [200, 201]);
  assert.equal(repeated[0].data.event.id, repeated[1].data.event.id);
  const collision = bookingBody();
  const bookings = await Promise.all([
    call('/visit-duration/bookings', reception, 'POST', collision),
    call('/visit-duration/bookings', reception, 'POST', {
      ...collision,
      requestId: randomUUID(),
      patientId: 'patient-2',
      time: '09:05',
    }),
  ]);
  assert.deepEqual(bookings.map((result) => result.status).sort(), [201, 409]);
  const appointment = repeated[0].data.appointment;
  const change = await changeBody(appointment);
  const updates = await Promise.all([
    call(`/appointments/${appointment.id}/duration`, reception, 'POST', change),
    call(`/appointments/${appointment.id}/duration`, reception, 'POST', {
      ...change,
      requestId: randomUUID(),
      durationMinutes: 75,
    }),
  ]);
  assert.deepEqual(updates.map((result) => result.status).sort(), [200, 409]);
});

test('calendar and care-summary use actual minutes while private reasons, revisions and evidence remain staff-only', async () => {
  const visit = (await custom()).appointment;
  const beforeSummary = (await call('/patients/patient-ananya/care-summary', patient)).data;
  const change = await changeBody(visit, { durationMinutes: 120 });
  const changed = await call(`/appointments/${visit.id}/duration`, reception, 'POST', change);
  assert.equal(changed.status, 200);
  const summary = (await call('/patients/patient-ananya/care-summary', patient)).data;
  assert.notEqual(summary.revision, beforeSummary.revision);
  assert.equal(
    summary.appointments.find((a: Appointment) => a.id === visit.id).durationMinutes,
    120,
  );
  assert.ok(!JSON.stringify(summary).includes('PRIVATE_DURATION_REASON'));
  assert.ok(!JSON.stringify(summary).includes(change.expectedRevision));
  const response = await fetch(`${base}/api/appointments/${visit.id}/calendar`, {
    headers: { Cookie: patient.cookie! },
  });
  assert.equal(response.status, 200);
  const calendar = await response.text();
  const stamp = (date: Date) =>
    date
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '');
  assert.match(calendar, /SUMMARY:Clinic visit with /);
  assert.ok(
    calendar.includes(
      `DTEND:${stamp(new Date(Date.parse(`${visit.date}T${visit.time}:00+05:30`) + 120 * 60000))}`,
    ),
  );
  const notification = app.locals.db
    .prepare('SELECT data FROM activity WHERE eventKey=?')
    .get(`visit-duration:${changed.data.event.id}`);
  assert.ok(notification);
  assert.match(notification.data as string, /120 minutes/);
  assert.ok(!(notification.data as string).includes('PRIVATE_DURATION_REASON'));
});

test('immutable duration evidence survives later changes and rejects direct source updates and deletion', async () => {
  const saved = await custom(),
    db = app.locals.db;
  for (const table of ['visitDurationEvents', 'visitDurationCommands']) {
    assert.throws(
      () =>
        db.exec(
          `UPDATE ${table} SET ${table === 'visitDurationEvents' ? 'data=data' : 'payload=payload'}`,
        ),
      /immutable/,
    );
    assert.throws(() => db.exec(`DELETE FROM ${table}`), /immutable/);
  }
  assert.equal((await context(saved.appointment.id)).history[0].id, saved.event.id);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});

test('changing a linked visit length leaves procedure identity, agreement and issued billing source records unchanged', async () => {
  const visit = await ordinary();
  const procedure = await call('/procedures', doctor, 'POST', {
    patientId: visit.patientId,
    appointmentId: visit.id,
    title: 'Synthetic linked procedure',
    indication: 'Recorded indication',
    benefits: 'Recorded benefits',
    risks: 'Recorded risks',
    alternatives: 'Recorded alternatives',
    aftercare: 'Recorded aftercare',
    estimatedCost: 'Discussed separately',
  });
  assert.equal(procedure.status, 201, JSON.stringify(procedure.data));
  assert.equal(
    (
      await call(`/procedures/${procedure.data.id}/agreements`, patient, 'POST', {
        decision: 'agreed',
        method: 'portal',
        note: 'Recorded patient decision',
      })
    ).status,
    201,
  );
  const invoice = await call('/invoices', reception, 'POST', {
    patientId: visit.patientId,
    procedureId: procedure.data.id,
    requestId: randomUUID(),
    items: [
      { description: 'Separately agreed synthetic fee', quantity: 1, unitAmountPaise: 75000 },
    ],
  });
  assert.equal(invoice.status, 201);
  const sources = () => ({
    procedure: get(app.locals.db, 'procedures', procedure.data.id),
    agreements: app.locals.db
      .prepare('SELECT * FROM procedureAgreements WHERE procedureId=?')
      .all(procedure.data.id),
    invoice: get(app.locals.db, 'invoices', invoice.data.id),
    link: app.locals.db
      .prepare('SELECT * FROM procedureInvoiceLinks WHERE procedureId=?')
      .get(procedure.data.id),
  });
  const originals = sources();
  const changed = await call(
    `/appointments/${visit.id}/duration`,
    reception,
    'POST',
    await changeBody(visit, { durationMinutes: 120 }),
  );
  assert.equal(changed.status, 200);
  assert.equal(changed.data.appointment.fee, visit.fee);
  assert.equal(
    (await call(`/appointments/${visit.id}`, patient, 'PATCH', { time: '12:00' })).status,
    200,
  );
  assert.deepEqual(sources(), originals);
  assert.equal(get<Appointment>(app.locals.db, 'appointments', visit.id)!.durationMinutes, 120);
  const summary = (await call('/patients/patient-ananya/care-summary', patient)).data;
  assert.equal(
    summary.procedures.find((value: { id: string }) => value.id === procedure.data.id)
      .appointmentId,
    visit.id,
  );
  assert.equal(
    summary.invoices.find((value: { id: string }) => value.id === invoice.data.id).totalPaise,
    75000,
  );
});

test('policy-only change of equal minutes is recorded, while waitlist booking keeps schedule-default length', async () => {
  const visit = await ordinary();
  const changed = await call(
    `/appointments/${visit.id}/duration`,
    reception,
    'POST',
    await changeBody(visit, { durationMinutes: visit.durationMinutes }),
  );
  assert.equal(changed.status, 200);
  assert.equal(changed.data.appointment.durationPolicy, 'custom');
  assert.equal(changed.data.appointment.durationMinutes, visit.durationMinutes);
  const date = future();
  const entry = await call('/waitlist', reception, 'POST', {
    patientId: visit.patientId,
    doctorId: doctorA,
    startDate: date,
    endDate: date,
    mode: 'in-person',
    reason: 'Synthetic waitlist',
  });
  assert.equal(entry.status, 201, JSON.stringify(entry.data));
  const booked = await ordinary({ date, waitlistId: entry.data.id, patientConfirmed: true });
  assert.equal(booked.durationMinutes, 20);
  assert.notEqual(booked.durationPolicy, 'custom');
  assert.equal((await context(booked.id)).history.length, 0);
});

test('duration context reads and its audit share one transaction against external writers', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'visit-duration-context-'));
  const databasePath = join(folder, 'clinic.sqlite');
  const application = createApp({ databasePath, demoMode: true });
  const running = await listen(application),
    client: Client = {};
  const writer = openDatabase(databasePath);
  writer.exec('PRAGMA busy_timeout=0');
  try {
    await call(
      '/auth/login',
      client,
      'POST',
      { email: 'admin@derma.demo', password: 'DemoClinic2026!' },
      running.base,
    );
    const appointment = fixture({ doctorId: 'doctor-meera' }, application);
    const initialDoctor = get<Doctor>(writer, 'doctors', appointment.doctorId)!;
    const database: DB = application.locals.db,
      prepare = database.prepare.bind(database);
    let blockedWrite = false;
    const mutation = () =>
      writer
        .prepare('UPDATE doctors SET data=? WHERE id=?')
        .run(JSON.stringify({ ...initialDoctor, fee: initialDoctor.fee + 100 }), initialDoctor.id);
    const mock = t.mock.method(database, 'prepare', (sql: string) => {
      const statement = prepare(sql);
      if (sql === 'SELECT data FROM doctors WHERE id=?' && !blockedWrite) {
        const read = statement.get.bind(statement);
        t.mock.method(statement, 'get', (...values: SQLInputValue[]) => {
          const value = read(...values);
          if (!blockedWrite) {
            assert.throws(mutation, /locked/);
            blockedWrite = true;
          }
          return value;
        });
      }
      return statement;
    });
    const first = await call(
      `/appointments/${appointment.id}/duration`,
      client,
      'GET',
      undefined,
      running.base,
    );
    assert.equal(first.status, 200);
    assert.equal(blockedWrite, true);
    assert.equal(first.data.currentDoctorFee, initialDoctor.fee);
    mock.mock.restore();
    mutation();
    const second = await call(
      `/appointments/${appointment.id}/duration`,
      client,
      'GET',
      undefined,
      running.base,
    );
    assert.equal(second.data.currentDoctorFee, initialDoctor.fee + 100);
    assert.notEqual(second.data.revision, first.data.revision);
    const count = database.prepare('SELECT count(*) n FROM audit').get()!.n;
    database.exec(
      "CREATE TRIGGER duration_context_audit_failure BEFORE INSERT ON audit WHEN json_extract(NEW.data,'$.action')='viewed visit duration history' BEGIN SELECT RAISE(ABORT,'Synthetic context audit failure'); END;",
    );
    assert.equal(
      (
        await call(
          `/appointments/${appointment.id}/duration`,
          client,
          'GET',
          undefined,
          running.base,
        )
      ).status,
      500,
    );
    assert.equal(database.prepare('SELECT count(*) n FROM audit').get()!.n, count);
    database.exec('DROP TRIGGER duration_context_audit_failure');
    mutation();
  } finally {
    writer.close();
    await close(running.server);
    application.locals.db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('duration tables migrate without inventing legacy history and command replay survives restart', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'visit-duration-'));
  const databasePath = join(folder, 'clinic.sqlite');
  const originalDb = openDatabase(databasePath);
  seedDemo(originalDb);
  originalDb.close();
  let application = createApp({ databasePath, demoMode: true }),
    running = await listen(application);
  const client: Client = {};
  const login = () =>
    call(
      '/auth/login',
      client,
      'POST',
      { email: 'admin@derma.demo', password: 'DemoClinic2026!' },
      running.base,
    );
  try {
    await login();
    assert.equal(
      application.locals.db.prepare('SELECT count(*) n FROM visitDurationEvents').get().n,
      0,
    );
    let date = future();
    while (new Date(`${date}T12:00:00Z`).getUTCDay() === 0) date = addDays(date, 1);
    const body = bookingBody({ doctorId: 'doctor-meera', date });
    const saved = await call('/visit-duration/bookings', client, 'POST', body, running.base);
    assert.equal(saved.status, 201, JSON.stringify(saved.data));
    await close(running.server);
    application.locals.db.close();
    application = createApp({ databasePath, demoMode: false });
    running = await listen(application);
    await login();
    const retry = await call('/visit-duration/bookings', client, 'POST', body, running.base);
    assert.equal(retry.status, 200);
    assert.deepEqual(retry.data, saved.data);
    assert.equal(
      application.locals.db.prepare('PRAGMA integrity_check').get().integrity_check,
      'ok',
    );
  } finally {
    await close(running.server);
    application.locals.db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
