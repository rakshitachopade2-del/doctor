import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import { addDays, clinicToday } from '../server/db.ts';

const app = createApp({ databasePath: ':memory:', demoMode: true });
let server: Server, base: string;
type Client = { cookie?: string; csrf?: string };
const admin: Client = {},
  doctor: Client = {},
  reception: Client = {},
  patient: Client = {},
  other: Client = {};
async function call(
  path: string,
  { method = 'GET', body, client = {} }: { method?: string; body?: unknown; client?: Client } = {},
) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(client.cookie ? { Cookie: client.cookie } : {}),
      ...(client.csrf ? { 'X-CSRF-Token': client.csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const cookie = response.headers.get('set-cookie');
  if (cookie) client.cookie = cookie.split(';')[0];
  const data = response.headers.get('content-type')?.includes('application/json')
    ? await response.json()
    : await response.text();
  if (data?.csrfToken) client.csrf = data.csrfToken;
  return { status: response.status, data };
}
const dayOfWeek = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
const futureDate = (offset = 40) => addDays(clinicToday(), offset);
const defaultWindows = [1, 2, 3, 4, 5, 6].map((day) => ({
  day,
  start: '09:00',
  end: '18:00',
  mode: 'both',
}));
const allDays = [0, 1, 2, 3, 4, 5, 6].map((day) => ({
  day,
  start: '09:00',
  end: '18:00',
  mode: 'both',
}));
let doctorCounter = 0;
async function newDoctor() {
  const created = await call('/doctors', {
    method: 'POST',
    client: admin,
    body: {
      name: `Dr. Schedule Test ${++doctorCounter}`,
      title: 'Dermatologist',
      qualifications: 'Test profile',
      specialties: ['General dermatology'],
      experience: 2,
      fee: 600,
      bio: 'Synthetic schedule test.',
      languages: ['English'],
      color: '#b3c7aa',
    },
  });
  assert.equal(created.status, 201);
  return created.data.id as string;
}
async function configure(doctorId: string, durationMinutes = 30, windows = allDays) {
  const result = await call(`/schedules/${doctorId}`, {
    method: 'PUT',
    client: admin,
    body: { durationMinutes, windows },
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data;
}
async function book(
  doctorId: string,
  date: string,
  time: string,
  patientId = 'patient-ananya',
  mode = 'in-person',
) {
  return call('/appointments', {
    method: 'POST',
    client: reception,
    body: { doctorId, patientId, date, time, mode, reason: 'Scheduling test' },
  });
}
before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  for (const [role, client] of [
    ['admin', admin],
    ['doctor', doctor],
    ['reception', reception],
    ['patient', patient],
  ] as const)
    assert.equal(
      (
        await call('/auth/login', {
          method: 'POST',
          client,
          body: { email: `${role}@derma.demo`, password: 'DemoClinic2026!' },
        })
      ).status,
      200,
    );
  assert.equal(
    (
      await call('/auth/register', {
        method: 'POST',
        client: other,
        body: {
          name: 'Other scheduling patient',
          email: 'scheduling-other@example.test',
          password: 'SchedulingOther2026!',
          phone: '9000000088',
          dob: '1995-01-01',
          gender: 'Other',
        },
      })
    ).status,
    201,
  );
});
after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  app.locals.close();
});

test('legacy doctors receive compatible default schedules without public closure details', async () => {
  assert.equal((await call('/scheduling')).status, 401);
  assert.equal((await call('/scheduling', { client: patient })).status, 403);
  const result = await call('/scheduling', { client: reception });
  assert.equal(result.status, 200);
  assert.equal(result.data.timezone, 'Asia/Kolkata');
  assert.equal(result.data.bookingWindowDays, 180);
  assert.equal(result.data.schedules.length, 2);
  assert.equal(result.data.schedules[0].durationMinutes, 30);
  assert.deepEqual(result.data.schedules[0].windows, defaultWindows);
  assert.ok(
    (await call('/doctors')).data.every((item: any) => item.appointmentDurationMinutes === 30),
  );
  assert.equal((await call('/schedules/missing', { client: admin })).status, 404);
});

test('availability permissions allow own doctor changes and reserve clinic-wide closures for admins', async () => {
  // Include Sunday so the legacy demo's optional Sunday-today appointments stay valid.
  const value = { durationMinutes: 30, windows: allDays };
  assert.equal(
    (await call('/schedules/doctor-meera', { method: 'PUT', client: reception, body: value }))
      .status,
    403,
  );
  assert.equal(
    (await call('/schedules/doctor-meera', { method: 'PUT', client: patient, body: value })).status,
    403,
  );
  assert.equal(
    (await call('/schedules/doctor-arjun', { method: 'PUT', client: doctor, body: value })).status,
    403,
  );
  assert.equal(
    (await call('/schedules/doctor-meera', { method: 'PUT', client: doctor, body: value })).status,
    200,
  );
  const body = {
    doctorId: null,
    startDate: futureDate(80),
    endDate: futureDate(80),
    startTime: null,
    endTime: null,
    reason: 'Internal operational closure',
  };
  assert.equal(
    (await call('/schedule-closures', { method: 'POST', client: doctor, body })).status,
    403,
  );
  assert.equal(
    (
      await call('/schedule-closures', {
        method: 'POST',
        client: doctor,
        body: { ...body, doctorId: 'doctor-arjun' },
      })
    ).status,
    403,
  );
  const own = await call('/schedule-closures', {
    method: 'POST',
    client: doctor,
    body: { ...body, doctorId: 'doctor-meera' },
  });
  assert.equal(own.status, 201);
  assert.equal(
    (
      await call(`/schedule-closures/${own.data.id}`, {
        method: 'DELETE',
        client: reception,
        body: {},
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call(`/schedule-closures/${own.data.id}`, {
        method: 'DELETE',
        client: doctor,
        body: {},
      })
    ).status,
    200,
  );
});

test('schedule validation rejects invalid times, overnight or overlapping sessions and unsupported durations', async () => {
  const doctorId = await newDoctor();
  for (const body of [
    { durationMinutes: 25, windows: allDays },
    { durationMinutes: 30, windows: [{ day: 1, start: '25:00', end: '26:00', mode: 'both' }] },
    { durationMinutes: 30, windows: [{ day: 1, start: '18:00', end: '09:00', mode: 'both' }] },
    { durationMinutes: 60, windows: [{ day: 1, start: '09:00', end: '09:30', mode: 'both' }] },
    {
      durationMinutes: 30,
      windows: [
        { day: 1, start: '09:00', end: '11:00', mode: 'online' },
        { day: 1, start: '10:00', end: '12:00', mode: 'in-person' },
      ],
    },
    { durationMinutes: 30, windows: [{ day: 7, start: '09:00', end: '10:00', mode: 'both' }] },
  ])
    assert.equal(
      (await call(`/schedules/${doctorId}`, { method: 'PUT', client: admin, body })).status,
      400,
      JSON.stringify(body),
    );
  await configure(doctorId, 30, []);
  assert.deepEqual((await call(`/slots?doctorId=${doctorId}&date=${futureDate()}`)).data, []);
});

test('weekly sessions generate mode-specific slots, preserve breaks and permit Sunday working', async () => {
  const doctorId = await newDoctor(),
    date = futureDate(),
    day = dayOfWeek(date);
  const configured = await configure(doctorId, 20, [
    { day, start: '14:00', end: '16:00', mode: 'online' },
    { day, start: '09:00', end: '10:00', mode: 'in-person' },
  ]);
  assert.equal(configured.windows[0].start, '09:00');
  assert.deepEqual((await call(`/slots?doctorId=${doctorId}&date=${date}&mode=in-person`)).data, [
    '09:00',
    '09:20',
    '09:40',
  ]);
  assert.deepEqual((await call(`/slots?doctorId=${doctorId}&date=${date}&mode=online`)).data, [
    '14:00',
    '14:20',
    '14:40',
    '15:00',
    '15:20',
    '15:40',
  ]);
  assert.equal((await call(`/slots?doctorId=${doctorId}&date=${date}`)).data.length, 9);
  assert.deepEqual((await call(`/slots?doctorId=${doctorId}&date=${addDays(date, 1)}`)).data, []);
  assert.equal((await book(doctorId, date, '09:00', 'patient-2', 'online')).status, 400);
  assert.equal((await book(doctorId, date, '10:00', 'patient-2', 'in-person')).status, 400);
  const appointment = await book(doctorId, date, '09:00', 'patient-2');
  assert.equal(appointment.status, 201);
  assert.equal(appointment.data.durationMinutes, 20);
  const calendar = await call(`/appointments/${appointment.data.id}/calendar`, { client: admin });
  const start = /DTSTART:(\d{8}T\d{6}Z)/.exec(calendar.data)![1],
    end = /DTEND:(\d{8}T\d{6}Z)/.exec(calendar.data)![1];
  assert.equal(start.slice(9, 13), '0330');
  assert.equal(end.slice(9, 13), '0350');
  const sundayDoctor = await newDoctor();
  let sunday = futureDate(50);
  while (dayOfWeek(sunday) !== 0) sunday = addDays(sunday, 1);
  await configure(sundayDoctor, 15, [{ day: 0, start: '11:00', end: '12:00', mode: 'both' }]);
  assert.deepEqual((await call(`/slots?doctorId=${sundayDoctor}&date=${sunday}`)).data, [
    '11:00',
    '11:15',
    '11:30',
    '11:45',
  ]);
  assert.equal((await book(sundayDoctor, sunday, '11:15', 'patient-3')).status, 201);
});

test('slots reject past times and enforce the 180-day booking horizon', async () => {
  const doctorId = await newDoctor();
  await configure(
    doctorId,
    15,
    [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '00:00', end: '23:59', mode: 'both' })),
  );
  assert.deepEqual(
    (await call(`/slots?doctorId=${doctorId}&date=${addDays(clinicToday(), -1)}`)).data,
    [],
  );
  assert.deepEqual((await call(`/slots?doctorId=${doctorId}&date=${futureDate(181)}`)).data, []);
  assert.equal((await book(doctorId, clinicToday(), '00:00', 'patient-2')).status, 400);
  assert.equal((await book(doctorId, futureDate(181), '12:00', 'patient-2')).status, 400);
  assert.equal((await book(doctorId, futureDate(), '12:07', 'patient-2')).status, 400);
  assert.equal((await call(`/slots?doctorId=${doctorId}&date=2026-02-30`)).status, 400);
});

test('daily time closures remove only overlapping slots without disclosing their reasons', async () => {
  const doctorId = await newDoctor(),
    date = futureDate(60);
  await configure(doctorId, 30);
  const closure = await call('/schedule-closures', {
    method: 'POST',
    client: admin,
    body: {
      doctorId,
      startDate: date,
      endDate: addDays(date, 1),
      startTime: '10:15',
      endTime: '11:00',
      reason: 'Confidential staff leave detail',
    },
  });
  assert.equal(closure.status, 201);
  for (const day of [date, addDays(date, 1)]) {
    const slots = await call(`/slots?doctorId=${doctorId}&date=${day}`);
    assert.ok(slots.data.includes('09:30'));
    assert.ok(!slots.data.includes('10:00'));
    assert.ok(!slots.data.includes('10:30'));
    assert.ok(slots.data.includes('11:00'));
    assert.ok(
      slots.data.every(
        (value: unknown) => typeof value === 'string' && /^\d\d:\d\d$/.test(value as string),
      ),
    );
    assert.ok(!JSON.stringify(slots.data).includes('Confidential'));
  }
  const blocked = await book(doctorId, date, '10:00', 'patient-2');
  assert.equal(blocked.status, 409);
  assert.ok(!blocked.data.error.includes('Confidential'));
  const full = await call('/schedule-closures', {
    method: 'POST',
    client: admin,
    body: {
      doctorId: null,
      startDate: addDays(date, 2),
      endDate: addDays(date, 2),
      startTime: null,
      endTime: null,
      reason: 'Clinic closed',
    },
  });
  assert.equal(full.status, 201);
  assert.deepEqual((await call(`/slots?doctorId=${doctorId}&date=${addDays(date, 2)}`)).data, []);
  assert.equal(
    (
      await call(`/schedule-closures/${full.data.id}`, {
        method: 'DELETE',
        client: doctor,
        body: {},
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call(`/schedule-closures/${full.data.id}`, {
        method: 'DELETE',
        client: admin,
        body: {},
      })
    ).status,
    200,
  );
  assert.ok((await call(`/slots?doctorId=${doctorId}&date=${addDays(date, 2)}`)).data.length > 0);
});

test('closure validation prevents incomplete intervals, invalid dates and retroactive closures', async () => {
  const base = {
    doctorId: null,
    startDate: futureDate(),
    endDate: futureDate(),
    startTime: null,
    endTime: null,
    reason: 'Test closure',
  };
  for (const body of [
    { ...base, startTime: '10:00' },
    { ...base, startTime: '15:00', endTime: '10:00' },
    { ...base, endDate: addDays(base.startDate, -1) },
    { ...base, startDate: '2026-02-30' },
    { ...base, startDate: addDays(clinicToday(), -2), endDate: addDays(clinicToday(), -1) },
  ]) {
    assert.equal(
      (await call('/schedule-closures', { method: 'POST', client: admin, body })).status,
      400,
    );
  }
});

test('schedule edits and closures preserve booked appointments and reject invalidation', async () => {
  const doctorId = await newDoctor(),
    date = futureDate(70);
  await configure(doctorId);
  const booked = await book(doctorId, date, '12:00');
  assert.equal(booked.status, 201);
  const narrowed = await call(`/schedules/${doctorId}`, {
    method: 'PUT',
    client: admin,
    body: {
      durationMinutes: 30,
      windows: allDays.map((window) => ({ ...window, start: '13:00' })),
    },
  });
  assert.equal(narrowed.status, 409);
  assert.match(narrowed.data.error, /1 booked appointment/);
  assert.equal(
    (await call(`/schedules/${doctorId}`, { client: reception })).data.windows[0].start,
    '09:00',
  );
  const closure = await call('/schedule-closures', {
    method: 'POST',
    client: admin,
    body: {
      doctorId,
      startDate: date,
      endDate: date,
      startTime: '12:15',
      endTime: '13:00',
      reason: 'Unavailable',
    },
  });
  assert.equal(closure.status, 409);
  assert.match(closure.data.error, /1 booked appointment/);
  assert.equal(
    (await call('/appointments', { client: patient })).data.find(
      (a: any) => a.id === booked.data.id,
    ).status,
    'scheduled',
  );
  await configure(doctorId, 20);
  const saved = (await call('/appointments', { client: patient })).data.find(
    (a: any) => a.id === booked.data.id,
  );
  assert.equal(saved.durationMinutes, 30);
  const slots = (await call(`/slots?doctorId=${doctorId}&date=${date}`)).data;
  assert.ok(slots.includes('11:40'));
  assert.ok(!slots.includes('12:00'));
  assert.ok(!slots.includes('12:20'));
  assert.ok(slots.includes('12:40'));
  const excluded = `/slots?doctorId=${doctorId}&date=${date}&excludeAppointmentId=${booked.data.id}`;
  assert.equal((await call(excluded)).status, 401);
  assert.equal((await call(excluded, { client: other })).status, 403);
  assert.ok((await call(excluded, { client: patient })).data.includes('12:00'));
  const moved = await call(`/appointments/${booked.data.id}`, {
    method: 'PATCH',
    client: patient,
    body: { time: '12:20', mode: 'online' },
  });
  assert.equal(moved.status, 200);
  assert.equal(moved.data.durationMinutes, 20);
  assert.equal(moved.data.mode, 'online');
});

test('overlap protection respects different doctor durations and the patient entire interval', async () => {
  const longDoctor = await newDoctor(),
    shortDoctor = await newDoctor(),
    date = futureDate(90);
  await configure(longDoctor, 60);
  await configure(shortDoctor, 20);
  const long = await book(longDoctor, date, '15:00');
  assert.equal(long.status, 201);
  assert.equal(long.data.durationMinutes, 60);
  assert.equal((await book(shortDoctor, date, '15:20')).status, 409);
  assert.ok((await call(`/slots?doctorId=${shortDoctor}&date=${date}`)).data.includes('15:20'));
  assert.ok(
    !(await call(`/slots?doctorId=${shortDoctor}&date=${date}`, { client: patient })).data.includes(
      '15:20',
    ),
  );
  assert.equal((await book(shortDoctor, date, '16:00')).status, 201);
  await configure(longDoctor, 15);
  assert.equal((await book(longDoctor, date, '15:15', 'patient-2')).status, 409);
  assert.equal((await book(longDoctor, date, '16:00', 'patient-2')).status, 201);
  assert.equal(
    (
      await call(`/appointments/${long.data.id}`, {
        method: 'PATCH',
        client: patient,
        body: { status: 'cancelled' },
      })
    ).status,
    200,
  );
  assert.ok((await call(`/slots?doctorId=${longDoctor}&date=${date}`)).data.includes('15:15'));
});

test('concurrent overlapping patient requests for different doctors cannot both succeed', async () => {
  const longDoctor = await newDoctor(),
    shortDoctor = await newDoctor(),
    date = futureDate(100);
  await configure(longDoctor, 60);
  await configure(shortDoctor, 20);
  const results = await Promise.all([
    book(longDoctor, date, '15:00', 'patient-4'),
    book(shortDoctor, date, '15:20', 'patient-4'),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  const audit = (await call('/audit', { client: admin })).data;
  assert.ok(audit.some((entry: any) => entry.action === 'updated doctor availability'));
  assert.ok(audit.some((entry: any) => entry.action === 'created schedule closure'));
  assert.ok(audit.some((entry: any) => entry.action === 'removed schedule closure'));
});

test('temporary-password patients can see public availability but not personalized slots or exclusions', async () => {
  const occupiedDoctor = await newDoctor(),
    availableDoctor = await newDoctor(),
    date = futureDate(110);
  await configure(occupiedDoctor);
  await configure(availableDoctor);
  const appointment = await book(occupiedDoctor, date, '12:00', 'patient-5');
  assert.equal(appointment.status, 201);
  const account = await call('/patients/patient-5/portal-account', {
    method: 'POST',
    client: admin,
    body: {
      email: 'scheduling-temporary@example.test',
      password: 'TemporarySchedule2026!',
      identityVerified: true,
    },
  });
  assert.equal(account.status, 201);
  const temporary: Client = {};
  const login = await call('/auth/login', {
    method: 'POST',
    client: temporary,
    body: { email: 'scheduling-temporary@example.test', password: 'TemporarySchedule2026!' },
  });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.mustChangePassword, true);
  const publicPath = `/slots?doctorId=${availableDoctor}&date=${date}`;
  assert.deepEqual(
    (await call(publicPath, { client: temporary })).data,
    (await call(publicPath)).data,
  );
  assert.ok((await call(publicPath, { client: temporary })).data.includes('12:00'));
  assert.equal(
    (
      await call(
        `/slots?doctorId=${occupiedDoctor}&date=${date}&excludeAppointmentId=${appointment.data.id}`,
        { client: temporary },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call('/auth/password', {
        method: 'POST',
        client: temporary,
        body: { currentPassword: 'TemporarySchedule2026!', newPassword: 'PersonalSchedule2026!' },
      })
    ).status,
    200,
  );
  assert.ok(!(await call(publicPath, { client: temporary })).data.includes('12:00'));
});

test('status changes preserve the booked fee and clinician name while explicit rescheduling adopts current profile terms', async () => {
  const doctorId = await newDoctor();
  await configure(doctorId);
  const booked = await book(doctorId, futureDate(150), '10:00');
  assert.equal(booked.status, 201);
  assert.equal(booked.data.fee, 600);
  const originalName = booked.data.doctorName;
  const profile = (await call('/doctors')).data.find(
    (value: { id: string }) => value.id === doctorId,
  );
  const revised = await call(`/doctors/${doctorId}`, {
    method: 'PATCH',
    client: admin,
    body: { ...profile, fee: 875, name: 'Dr. Revised Synthetic Profile' },
  });
  assert.equal(revised.status, 200);
  // Place this synthetic visit on today's queue without depending on clock time.
  const queued = { ...booked.data, date: clinicToday() };
  app.locals.db
    .prepare('UPDATE appointments SET date=?,data=? WHERE id=?')
    .run(queued.date, JSON.stringify(queued), queued.id);
  for (const [status, client] of [
    ['checked-in', reception],
    ['in-consultation', doctor],
    ['completed', doctor],
  ] as const) {
    const changed = await call(`/appointments/${queued.id}`, {
      method: 'PATCH',
      client,
      body: { status },
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.data.fee, 600);
    assert.equal(changed.data.doctorName, originalName);
  }
  const another = await book(doctorId, futureDate(151), '10:00');
  assert.equal(another.status, 201);
  assert.equal(another.data.fee, 875);
  assert.equal(
    (
      await call(`/doctors/${doctorId}`, {
        method: 'PATCH',
        client: admin,
        body: { ...revised.data, fee: 950 },
      })
    ).status,
    200,
  );
  const moved = await call(`/appointments/${another.data.id}`, {
    method: 'PATCH',
    client: reception,
    body: { date: futureDate(152), time: '11:00' },
  });
  assert.equal(moved.status, 200);
  assert.equal(moved.data.fee, 950);
  const cancelled = await call(`/appointments/${moved.data.id}`, {
    method: 'PATCH',
    client: reception,
    body: { status: 'cancelled' },
  });
  assert.equal(cancelled.data.fee, 950);
});
