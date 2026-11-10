import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import { addDays, clinicToday } from '../server/db.ts';
import type { WaitlistEntry } from '../shared/waitlist.ts';

const app = createApp({ databasePath: ':memory:', demoMode: true });
let server: Server, base: string;
type Client = { cookie?: string; csrf?: string };
const patient: Client = {},
  other: Client = {},
  reception: Client = {},
  doctor: Client = {},
  admin: Client = {};
let otherPatientId: string;
let fixtureCounter = 0;
async function call(path: string, client: Client = {}, method = 'GET', body?: unknown) {
  const response = await fetch(`${base}/api${path}`, {
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
  return { status: response.status, data };
}
function workingDate(offset = 30) {
  let date = addDays(clinicToday(), offset);
  while (new Date(`${date}T12:00:00Z`).getUTCDay() === 0) date = addDays(date, 1);
  return date;
}
async function newPatient() {
  const result = await call('/patients', reception, 'POST', {
    name: `Waitlist fixture ${++fixtureCounter}`,
    phone: '9000000077',
    email: '',
    dob: '',
    gender: 'Other',
    allergies: '',
  });
  assert.equal(result.status, 201);
  return result.data.id as string;
}
async function newEntry(
  overrides: Record<string, unknown> = {},
  client = reception,
): Promise<WaitlistEntry> {
  const result = await call('/waitlist', client, 'POST', {
    patientId:
      client === patient
        ? 'patient-ananya'
        : client === other
          ? otherPatientId
          : await newPatient(),
    doctorId: 'doctor-meera',
    mode: 'in-person',
    startDate: workingDate(),
    endDate: addDays(workingDate(), 6),
    reason: 'Patient requested a clinic appointment.',
    ...overrides,
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data;
}
async function current(entry: WaitlistEntry, client = reception): Promise<WaitlistEntry> {
  const result = await call('/waitlist', client);
  assert.equal(result.status, 200);
  const value = result.data.find((item: WaitlistEntry) => item.id === entry.id);
  assert.ok(value);
  return value;
}
async function booking(entry: WaitlistEntry, overrides: Record<string, unknown> = {}) {
  const query = new URLSearchParams({
    doctorId: entry.doctorId,
    date: entry.startDate,
    mode: entry.mode,
  });
  const slots = await call(`/slots?${query}`, reception);
  assert.ok(slots.data.length >= 2);
  return {
    patientId: entry.patientId,
    doctorId: entry.doctorId,
    mode: entry.mode,
    date: entry.startDate,
    time: slots.data[0],
    reason: entry.reason,
    waitlistId: entry.id,
    patientConfirmed: true,
    ...overrides,
  };
}
function eventCount(entry: WaitlistEntry) {
  return app.locals.db
    .prepare('SELECT count(*) AS n FROM waitlistEvents WHERE waitlistId=?')
    .get(entry.id).n;
}
before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  for (const [role, client] of [
    ['doctor', doctor],
    ['admin', admin],
    ['reception', reception],
    ['patient', patient],
  ] as const) {
    assert.equal(
      (
        await call('/auth/login', client, 'POST', {
          email: `${role}@derma.demo`,
          password: 'DemoClinic2026!',
        })
      ).status,
      200,
    );
  }
  const registered = await call('/auth/register', other, 'POST', {
    name: 'Other waitlist patient',
    email: 'waitlist-other@example.test',
    password: 'WaitlistOther2026!',
    phone: '9000000088',
    dob: '1992-04-05',
    gender: 'Other',
  });
  assert.equal(registered.status, 201);
  otherPatientId = registered.data.user.patientId;
});
after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  app.locals.close();
});

test('waitlist ownership isolates patients while reception receives operational contact data only', async () => {
  assert.equal((await call('/waitlist')).status, 401);
  const entry = await newEntry({}, patient);
  assert.equal(entry.status, 'waiting');
  assert.ok(!('patientPhone' in entry));
  const patientRecord = JSON.parse(
    app.locals.db.prepare('SELECT data FROM patients WHERE id=?').get(entry.patientId).data,
  );
  assert.equal((await current(entry)).patientPhone, patientRecord.phone);
  for (const role of [doctor, admin, reception]) {
    const rows = (await call('/waitlist?status=waiting&doctorId=doctor-meera', role)).data;
    assert.ok(rows.some((item: WaitlistEntry) => item.id === entry.id));
    assert.ok(rows.every((item: WaitlistEntry) => !('allergies' in item)));
  }
  assert.deepEqual((await call('/waitlist', other)).data, []);
  assert.equal((await call(`/waitlist/${entry.id}/cancel`, other, 'POST', {})).status, 403);
  assert.equal(
    (
      await call('/waitlist', other, 'POST', {
        patientId: entry.patientId,
        doctorId: entry.doctorId,
        mode: 'online',
        startDate: entry.startDate,
        endDate: entry.endDate,
        reason: 'Wrong owner',
      })
    ).status,
    403,
  );
  assert.equal((await call(`/waitlist/${entry.id}/cancel`, patient, 'POST', {})).status, 200);
});

test('waitlist validates real inclusive date windows, known doctors and bounded operational text', async () => {
  const patientId = await newPatient();
  const body = {
    patientId,
    doctorId: 'doctor-meera',
    mode: 'in-person',
    startDate: workingDate(),
    endDate: workingDate(),
    reason: 'Test request',
  };
  for (const change of [
    { startDate: '2027-02-30' },
    { endDate: '2027-13-01' },
    { startDate: addDays(clinicToday(), -1) },
    { endDate: addDays(body.startDate, -1) },
    { endDate: addDays(clinicToday(), 181) },
    { reason: '' },
    { reason: 'x'.repeat(301) },
    { mode: 'both' },
    { patientPhone: 'injected field' },
  ])
    assert.equal((await call('/waitlist', reception, 'POST', { ...body, ...change })).status, 400);
  assert.equal(
    (await call('/waitlist', reception, 'POST', { ...body, doctorId: 'missing-doctor' })).status,
    404,
  );
  const boundary = await call('/waitlist', reception, 'POST', {
    ...body,
    startDate: clinicToday(),
    endDate: addDays(clinicToday(), 180),
  });
  assert.equal(boundary.status, 201);
  assert.equal((await call('/waitlist?status=invalid', reception)).status, 400);
});

test('active uniqueness holds under simultaneous joins and permits distinct consultation modes', async () => {
  const patientId = await newPatient();
  const body = {
    patientId,
    doctorId: 'doctor-meera',
    mode: 'in-person',
    startDate: workingDate(),
    endDate: workingDate(),
    reason: 'Duplicate request test',
  };
  const results = await Promise.all([
    call('/waitlist', reception, 'POST', body),
    call('/waitlist', reception, 'POST', body),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  const online = await newEntry({ ...body, mode: 'online' });
  assert.throws(
    () =>
      app.locals.db
        .prepare('UPDATE waitlistActive SET mode=? WHERE waitlistId=?')
        .run('in-person', online.id),
    /UNIQUE constraint failed/,
  );
});

test('cancellation preserves immutable history, releases the active claim and is idempotent', async () => {
  const entry = await newEntry({}, patient);
  const cancelled = await call(`/waitlist/${entry.id}/cancel`, reception, 'POST', {
    reason: 'Patient requested withdrawal by phone.',
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.status, 'cancelled');
  assert.ok(cancelled.data.closedAt);
  const repeated = await call(`/waitlist/${entry.id}/cancel`, patient, 'POST', {
    reason: 'Must not replace the first reason.',
  });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.data.cancellationReason, 'Patient requested withdrawal by phone.');
  assert.equal(repeated.data.closedAt, cancelled.data.closedAt);
  assert.equal(eventCount(entry), 1);
  assert.equal(
    app.locals.db
      .prepare('SELECT count(*) AS n FROM activity WHERE eventKey=?')
      .get(`waitlist-cancelled:${entry.id}`).n,
    1,
  );
  assert.throws(
    () =>
      app.locals.db.prepare('UPDATE waitlistRequests SET data=? WHERE id=?').run('{}', entry.id),
    /immutable/,
  );
  assert.throws(
    () => app.locals.db.prepare('DELETE FROM waitlistEvents WHERE waitlistId=?').run(entry.id),
    /immutable/,
  );
  const replacement = await newEntry({}, patient);
  assert.notEqual(replacement.id, entry.id);
  await call(`/waitlist/${replacement.id}/cancel`, patient, 'POST', {});
});

test('expiry is derived without erasing history and expired claims do not prevent a new request', async () => {
  const patientId = await newPatient();
  const expired = {
    id: randomUUID(),
    patientId,
    patientName: 'Expired fixture',
    doctorId: 'doctor-meera',
    doctorName: 'Dr. Meera Shah',
    mode: 'in-person',
    startDate: addDays(clinicToday(), -3),
    endDate: addDays(clinicToday(), -1),
    reason: 'Stored request from a previous clinic day',
    createdAt: new Date(`${addDays(clinicToday(), -4)}T10:00:00+05:30`).toISOString(),
  };
  app.locals.db
    .prepare(
      'INSERT INTO waitlistRequests(id,patientId,doctorId,mode,startDate,endDate,data) VALUES (?,?,?,?,?,?,?)',
    )
    .run(
      expired.id,
      patientId,
      expired.doctorId,
      expired.mode,
      expired.startDate,
      expired.endDate,
      JSON.stringify(expired),
    );
  app.locals.db
    .prepare(
      'INSERT INTO waitlistActive(waitlistId,patientId,doctorId,mode,endDate) VALUES (?,?,?,?,?)',
    )
    .run(expired.id, patientId, expired.doctorId, expired.mode, expired.endDate);
  const rows = (await call('/waitlist?status=expired', reception)).data;
  const value = rows.find((item: WaitlistEntry) => item.id === expired.id);
  assert.equal(value.status, 'expired');
  assert.equal(value.closedAt, null);
  assert.equal((await call(`/waitlist/${expired.id}/cancel`, reception, 'POST', {})).status, 409);
  const future = await newEntry({ patientId });
  const invalidBooking = await booking(future, { waitlistId: expired.id });
  assert.equal((await call('/appointments', reception, 'POST', invalidBooking)).status, 409);
  assert.equal(eventCount(value), 0);
  assert.equal(
    (await call('/waitlist?status=expired', reception)).data.some(
      (item: WaitlistEntry) => item.id === expired.id,
    ),
    true,
  );
});

test('confirmed staff booking atomically links the appointment and records one patient booking notification', async () => {
  const entry = await newEntry({}, patient);
  const input = await booking(entry);
  const booked = await call('/appointments', reception, 'POST', input);
  assert.equal(booked.status, 201);
  assert.ok(!('patientConfirmed' in booked.data));
  assert.ok(!('waitlistId' in booked.data));
  const updated = await current(entry, patient);
  assert.equal(updated.status, 'booked');
  assert.equal(updated.appointmentId, booked.data.id);
  const event = JSON.parse(
    app.locals.db.prepare('SELECT data FROM waitlistEvents WHERE waitlistId=?').get(entry.id).data,
  );
  assert.equal(event.patientConfirmed, true);
  assert.equal(event.actorRole, 'receptionist');
  assert.equal(
    app.locals.db
      .prepare('SELECT count(*) AS n FROM activity WHERE eventKey=?')
      .get(`waitlist-booked:${entry.id}`).n,
    1,
  );
  assert.equal(
    app.locals.db
      .prepare('SELECT count(*) AS n FROM activity WHERE eventKey=?')
      .get(`appointment-created:${booked.data.id}`).n,
    0,
  );
  assert.equal((await call(`/waitlist/${entry.id}/cancel`, patient, 'POST', {})).status, 409);
  assert.equal(
    (await call(`/appointments/${booked.data.id}`, patient, 'PATCH', { status: 'cancelled' }))
      .status,
    200,
  );
  assert.equal((await current(entry, patient)).status, 'booked');
  const replacement = await newEntry({}, patient);
  await call(`/waitlist/${replacement.id}/cancel`, patient, 'POST', {});
});

test('booking rejects missing confirmation and mismatched patient, doctor, mode or date without partial appointments', async () => {
  const entry = await newEntry();
  const input = await booking(entry);
  const before = app.locals.db.prepare('SELECT count(*) AS n FROM appointments').get().n;
  for (const changes of [
    { patientConfirmed: undefined },
    { patientConfirmed: false },
    { patientId: await newPatient() },
    { doctorId: 'doctor-arjun' },
    { mode: 'online' },
    { date: workingDate(45) },
    { waitlistId: 'missing-entry' },
  ]) {
    const result = await call('/appointments', reception, 'POST', { ...input, ...changes });
    assert.equal(result.status, changes.waitlistId ? 404 : 400, JSON.stringify(result.data));
    assert.equal(app.locals.db.prepare('SELECT count(*) AS n FROM appointments').get().n, before);
    assert.equal((await current(entry)).status, 'waiting');
    assert.equal(eventCount(entry), 0);
  }
});

test('patients can confirm their own waitlist booking and cannot attach another patient request', async () => {
  const entry = await newEntry({}, other);
  const body = await booking(entry);
  assert.equal(
    (await call('/appointments', patient, 'POST', { ...body, patientId: 'patient-ananya' })).status,
    403,
  );
  assert.equal((await current(entry, other)).status, 'waiting');
  assert.equal(
    (await call('/appointments', other, 'POST', { ...body, patientConfirmed: undefined })).status,
    400,
  );
  assert.equal((await call('/appointments', other, 'POST', body)).status, 201);
  assert.equal((await current(entry, other)).status, 'booked');
});

test('an occupied slot leaves the waitlist waiting and creates no terminal event', async () => {
  const entry = await newEntry();
  const body = await booking(entry);
  const occupied = await call('/appointments', reception, 'POST', {
    ...body,
    waitlistId: undefined,
    patientConfirmed: undefined,
    patientId: await newPatient(),
  });
  assert.equal(occupied.status, 201);
  assert.equal((await call('/appointments', reception, 'POST', body)).status, 409);
  assert.equal((await current(entry)).status, 'waiting');
  assert.equal(eventCount(entry), 0);
});

test('concurrent booking attempts or booking versus withdrawal produce exactly one terminal event', async () => {
  const entry = await newEntry();
  const body = await booking(entry);
  const slots = (
    await call(
      `/slots?doctorId=${entry.doctorId}&date=${entry.startDate}&mode=${entry.mode}`,
      reception,
    )
  ).data;
  const double = await Promise.all([
    call('/appointments', reception, 'POST', body),
    call('/appointments', reception, 'POST', { ...body, time: slots[1] }),
  ]);
  assert.deepEqual(double.map((result) => result.status).sort(), [201, 409]);
  assert.equal(eventCount(entry), 1);
  assert.equal(
    app.locals.db
      .prepare('SELECT count(*) AS n FROM appointments WHERE patientId=?')
      .get(entry.patientId).n,
    1,
  );
  const racing = await newEntry();
  const racingBody = await booking(racing);
  const outcomes = await Promise.all([
    call(`/waitlist/${racing.id}/cancel`, reception, 'POST', { reason: 'Patient withdrew.' }),
    call('/appointments', reception, 'POST', racingBody),
  ]);
  assert.equal(outcomes.filter((result) => result.status === 409).length, 1);
  assert.equal(
    outcomes.filter((result) => result.status === 200 || result.status === 201).length,
    1,
  );
  assert.equal(eventCount(racing), 1);
  const final = await current(racing);
  assert.equal(
    app.locals.db
      .prepare('SELECT count(*) AS n FROM appointments WHERE patientId=?')
      .get(racing.patientId).n,
    final.status === 'booked' ? 1 : 0,
  );
});

test('notification failure rolls back waitlist creation, cancellation and appointment linkage', async () => {
  const entry = await newEntry({}, patient);
  const bookingBody = await booking(entry);
  const requestsBefore = app.locals.db
    .prepare('SELECT count(*) AS n FROM waitlistRequests')
    .get().n;
  const appointmentsBefore = app.locals.db
    .prepare('SELECT count(*) AS n FROM appointments')
    .get().n;
  app.locals.db.exec(
    "CREATE TRIGGER simulate_waitlist_notification_failure BEFORE INSERT ON activity WHEN json_extract(NEW.data,'$.kind')='waitlist' BEGIN SELECT RAISE(ABORT,'Synthetic waitlist notification failure'); END;",
  );
  try {
    assert.equal(
      (
        await call('/waitlist', patient, 'POST', {
          doctorId: 'doctor-arjun',
          mode: 'online',
          startDate: workingDate(),
          endDate: workingDate(),
          reason: 'Must roll back.',
        })
      ).status,
      500,
    );
    assert.equal(
      app.locals.db.prepare('SELECT count(*) AS n FROM waitlistRequests').get().n,
      requestsBefore,
    );
    assert.equal((await call(`/waitlist/${entry.id}/cancel`, patient, 'POST', {})).status, 500);
    assert.equal((await call('/appointments', patient, 'POST', bookingBody)).status, 500);
    assert.equal(
      app.locals.db.prepare('SELECT count(*) AS n FROM appointments').get().n,
      appointmentsBefore,
    );
    assert.equal((await current(entry, patient)).status, 'waiting');
    assert.equal(eventCount(entry), 0);
    assert.equal(
      app.locals.db
        .prepare('SELECT count(*) AS n FROM waitlistActive WHERE waitlistId=?')
        .get(entry.id).n,
      1,
    );
  } finally {
    app.locals.db.exec('DROP TRIGGER simulate_waitlist_notification_failure');
  }
});
