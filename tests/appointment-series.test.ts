import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.ts';
import { addDays, clinicToday, get, openDatabase, type DB } from '../server/db.ts';
import type { Appointment, Doctor, Patient, User } from '../shared/types.ts';
import type {
  AppointmentSeriesInput,
  AppointmentSeriesPreview,
  AppointmentSeriesDetail,
} from '../shared/appointment-series.ts';

const password = 'DemoClinic2026!';
const privateNote = 'PRIVATE_SERIES_NOTE_SENTINEL';
type Client = { cookie: string; csrf: string; user: User };
const allDays = Array.from({ length: 7 }, (_, day) => ({
  day,
  start: '09:00',
  end: '18:00',
  mode: 'both',
}));

async function fixture(t: TestContext, path?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'derma-appointment-series-'));
  const databasePath = path ?? join(directory, 'clinic.sqlite');
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
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
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
  async function login(role: string) {
    const result = await call('/auth/login', undefined, 'POST', {
      email: role.includes('@') ? role : `${role}@derma.demo`,
      password,
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return {
      cookie: result.headers.get('set-cookie')!.split(';')[0],
      csrf: result.data.csrfToken,
      user: result.data.user,
    } as Client;
  }
  const admin = await login('admin');
  async function doctor(durationMinutes = 20) {
    const result = await call('/doctors', admin, 'POST', {
      name: `Dr. Series ${randomUUID().slice(0, 8)}`,
      title: 'Synthetic dermatologist',
      qualifications: 'Synthetic profile',
      specialties: ['General dermatology'],
      experience: 1,
      fee: 600,
      bio: 'Synthetic appointment series fixture.',
      languages: ['English'],
      color: '#b3c7aa',
    });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    const schedule = await call(`/schedules/${result.data.id}`, admin, 'PUT', {
      durationMinutes,
      windows: allDays,
    });
    assert.equal(schedule.status, 200, JSON.stringify(schedule.data));
    return result.data as Doctor;
  }
  const clinician = await doctor();
  async function ordinary(overrides: Record<string, unknown> = {}) {
    const result = await call('/appointments', admin, 'POST', {
      patientId: 'patient-ananya',
      doctorId: clinician.id,
      date: addDays(clinicToday(), 35),
      time: '09:00',
      mode: 'in-person',
      reason: 'Synthetic ordinary visit',
      ...overrides,
    });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return result.data as Appointment;
  }
  const input = (overrides: Record<string, unknown> = {}): AppointmentSeriesInput =>
    ({
      patientId: 'patient-ananya',
      doctorId: clinician.id,
      mode: 'in-person',
      reason: 'Patient requested scheduled follow-up visits',
      firstDate: addDays(clinicToday(), 35),
      time: '09:00',
      count: 3,
      intervalWeeks: 1,
      durationPolicy: 'schedule',
      ...overrides,
    }) as AppointmentSeriesInput;
  async function preview(value = input(), who = admin): Promise<AppointmentSeriesPreview> {
    const response = await call('/appointment-series/preview', who, 'POST', value);
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return response.data;
  }
  const command = (source: AppointmentSeriesPreview, overrides: Record<string, unknown> = {}) => ({
    input: source.input,
    expectedRevision: source.revision,
    patientConfirmed: true,
    privateNote,
    requestId: randomUUID(),
    ...overrides,
  });
  async function book(overrides: Record<string, unknown> = {}, who = admin) {
    const source = await preview(input(overrides), who),
      body = command(source);
    const response = await call('/appointment-series', who, 'POST', body);
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return { ...(response.data as AppointmentSeriesDetail), body, preview: source };
  }
  return {
    app,
    db,
    databasePath,
    base,
    call,
    login,
    admin,
    doctor,
    clinician,
    ordinary,
    input,
    preview,
    command,
    book,
    close,
  };
}

const count = (db: DB, table: string) =>
  Number(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n);
const transactionTables = [
  'appointments',
  'appointmentSeries',
  'appointmentSeriesMembers',
  'appointmentSeriesCommands',
  'audit',
  'activity',
  'visitDurationEvents',
];
const counts = (db: DB) =>
  Object.fromEntries(transactionTables.map((table) => [table, count(db, table)]));

test('preview expands finite calendar patterns without reservations and all staff can book with explicit patient confirmation', async (t) => {
  const f = await fixture(t),
    reception = await f.login('reception'),
    doctor = await f.login('doctor');
  for (const intervalWeeks of [1, 2, 4]) {
    const before = count(f.db, 'appointments');
    const preview = await f.preview(f.input({ intervalWeeks, count: 5 }), reception);
    assert.equal(preview.visits.length, 5);
    assert.equal(preview.canBook, true);
    assert.equal(preview.durationMinutes, 20);
    assert.deepEqual(
      preview.visits.map((visit) => visit.date),
      Array.from({ length: 5 }, (_, position) =>
        addDays(preview.input.firstDate, position * intervalWeeks * 7),
      ),
    );
    assert.deepEqual(
      preview.visits.map((visit) => visit.position),
      [1, 2, 3, 4, 5],
    );
    assert.ok(
      preview.visits.every(
        (visit) =>
          visit.available &&
          visit.blockedReason === null &&
          visit.time === '09:00' &&
          visit.endTime === '09:20' &&
          visit.endDate === visit.date,
      ),
    );
    assert.equal(count(f.db, 'appointments'), before);
    assert.equal(count(f.db, 'appointmentSeries'), 0);
    assert.match(preview.revision, /^[a-f0-9]{64}$/);
  }
  const preview = await f.preview(f.input(), doctor);
  const body = f.command(preview);
  assert.equal(
    (await f.call('/appointment-series', doctor, 'POST', { ...body, patientConfirmed: false }))
      .status,
    400,
  );
  const saved = await f.call('/appointment-series', reception, 'POST', body);
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  assert.equal(saved.data.series.createdById, reception.user.id);
  assert.equal(saved.data.series.createdByRole, 'receptionist');
  assert.equal(saved.data.series.patientConfirmed, true);
  assert.deepEqual(saved.data.series.bookedAppointments, saved.data.appointments);
  assert.equal(saved.data.appointments.length, 3);
  assert.ok(
    saved.data.appointments.every(
      (visit: Appointment) =>
        visit.fee === 600 && visit.durationMinutes === 20 && visit.status === 'scheduled',
    ),
  );
});

test('past, horizon, closed and blocked occurrences stay visible and prevent booking the entire requested set', async (t) => {
  const f = await fixture(t);
  const past = await f.preview(f.input({ firstDate: addDays(clinicToday(), -7), count: 3 }));
  assert.equal(past.visits.length, 3);
  assert.equal(past.visits[0].available, false);
  assert.ok(past.visits[0].blockedReason);
  assert.equal(past.canBook, false);
  const horizon = await f.preview(f.input({ firstDate: addDays(clinicToday(), 175), count: 3 }));
  assert.equal(horizon.visits.length, 3);
  assert.equal(horizon.visits[0].available, true);
  assert.equal(horizon.visits[1].available, false);
  assert.equal(horizon.visits[2].available, false);
  const value = f.input(),
    closedDate = addDays(value.firstDate, 7);
  const closure = await f.call('/schedule-closures', f.admin, 'POST', {
    doctorId: f.clinician.id,
    startDate: closedDate,
    endDate: closedDate,
    startTime: null,
    endTime: null,
    reason: 'PRIVATE_CLOSURE_REASON_SENTINEL',
  });
  assert.equal(closure.status, 201, JSON.stringify(closure.data));
  const closed = await f.preview(value);
  assert.deepEqual(
    closed.visits.map((visit) => visit.available),
    [true, false, true],
  );
  assert.ok(!JSON.stringify(closed).includes('PRIVATE_CLOSURE_REASON_SENTINEL'));
  for (const source of [past, horizon, closed]) {
    const before = counts(f.db);
    assert.equal(
      (await f.call('/appointment-series', f.admin, 'POST', f.command(source))).status,
      409,
    );
    assert.deepEqual(counts(f.db), before);
  }
});

test('strict finite inputs reject unsupported intervals, count limits, malformed dates and duration overrides', async (t) => {
  const f = await fixture(t);
  for (const invalid of [
    { count: 1 },
    { count: 13 },
    { count: 2.5 },
    { intervalWeeks: 3 },
    { firstDate: '2027-02-29' },
    { firstDate: '9999-12-31' },
    { time: '24:00' },
    { mode: 'unknown' },
    { reason: '' },
    { reason: 'a'.repeat(301) },
    { unknown: true },
    { durationMinutes: 30 },
    { durationPolicy: 'custom' },
    { durationPolicy: 'custom', durationMinutes: 10 },
    { durationPolicy: 'custom', durationMinutes: 245 },
    { durationPolicy: 'custom', durationMinutes: 16 },
  ])
    assert.equal(
      (await f.call('/appointment-series/preview', f.admin, 'POST', f.input(invalid))).status,
      400,
      JSON.stringify(invalid),
    );
  const twelve = await f.preview(f.input({ count: 12, firstDate: addDays(clinicToday(), 1) }));
  assert.equal(twelve.visits.length, 12);
  assert.equal(twelve.canBook, true);
  const source = await f.preview();
  for (const overrides of [
    { expectedRevision: undefined },
    { expectedRevision: 'bad' },
    { requestId: 'bad' },
    { patientConfirmed: undefined },
    { privateNote: 'x'.repeat(1001) },
    { unknown: true },
  ])
    assert.equal(
      (await f.call('/appointment-series', f.admin, 'POST', f.command(source, overrides))).status,
      400,
      JSON.stringify(overrides),
    );
  assert.equal(count(f.db, 'appointmentSeries'), 0);
});

test('custom series use five-minute cadence, full interval conflicts and truthful next-day blocked end times', async (t) => {
  const f = await fixture(t);
  const scheduleOffGrid = await f.preview(f.input({ time: '09:05' }));
  assert.equal(scheduleOffGrid.canBook, false);
  const custom = await f.preview(
    f.input({ time: '09:05', durationPolicy: 'custom', durationMinutes: 90 }),
  );
  assert.equal(custom.canBook, true);
  assert.ok(
    custom.visits.every((visit) => visit.endTime === '10:35' && visit.durationMinutes === 90),
  );
  const late = await f.preview(
    f.input({ time: '23:30', durationPolicy: 'custom', durationMinutes: 120 }),
  );
  assert.equal(late.canBook, false);
  assert.ok(
    late.visits.every(
      (visit) => visit.endDate === addDays(visit.date, 1) && visit.endTime === '01:30',
    ),
  );
  await f.ordinary({
    patientId: 'patient-2',
    date: addDays(custom.input.firstDate, 7),
    time: '10:20',
  });
  const conflict = await f.preview(custom.input);
  assert.deepEqual(
    conflict.visits.map((visit) => visit.available),
    [true, false, true],
  );
  assert.ok(!JSON.stringify(conflict).includes('patient-2'));
  assert.ok(!JSON.stringify(conflict).includes('Rohan Patel'));
  const adjacent = await f.preview(
    f.input({ time: '09:00', durationPolicy: 'custom', durationMinutes: 80 }),
  );
  assert.equal(adjacent.canBook, true);
  const booked = await f.book({ time: '09:00', durationPolicy: 'custom', durationMinutes: 80 });
  assert.ok(
    booked.appointments.every(
      (visit) => visit.durationPolicy === 'custom' && visit.durationMinutes === 80,
    ),
  );
  assert.equal(count(f.db, 'visitDurationEvents'), 0);
});

test('patient conflicts on another doctor or consultation mode block only the affected preview row without identity disclosure', async (t) => {
  const f = await fixture(t),
    other = await f.doctor();
  const value = f.input({ mode: 'online' });
  await f.ordinary({ doctorId: other.id, date: addDays(value.firstDate, 14), mode: 'in-person' });
  const source = await f.preview(value);
  assert.deepEqual(
    source.visits.map((visit) => visit.available),
    [true, true, false],
  );
  assert.equal(source.canBook, false);
  assert.ok(!JSON.stringify(source).includes(other.id));
  assert.ok(!JSON.stringify(source).includes(other.name));
  assert.equal(
    (await f.call('/appointment-series', f.admin, 'POST', f.command(source))).status,
    409,
  );
});

test('preview source binds fee, labels, contact, schedule, closures and competing slots while excluding unrelated clinical changes', async (t) => {
  const changes = [
    'fee',
    'doctor-name',
    'patient-name',
    'patient-phone',
    'schedule',
    'closure',
    'slot',
  ] as const;
  for (const change of changes) {
    const f = await fixture(t),
      source = await f.preview();
    if (change === 'fee' || change === 'doctor-name') {
      const current = get<Doctor>(f.db, 'doctors', f.clinician.id)!;
      const value = {
        ...current,
        ...(change === 'fee' ? { fee: current.fee + 100 } : { name: 'New current doctor label' }),
      };
      f.db.prepare('UPDATE doctors SET data=? WHERE id=?').run(JSON.stringify(value), current.id);
    }
    if (change === 'patient-name' || change === 'patient-phone') {
      const current = get<Patient>(f.db, 'patients', 'patient-ananya')!;
      f.db.prepare('UPDATE patients SET data=? WHERE id=?').run(
        JSON.stringify({
          ...current,
          ...(change === 'patient-name'
            ? { name: 'Corrected current patient label' }
            : { phone: '9000000999' }),
        }),
        current.id,
      );
    }
    if (change === 'schedule')
      assert.equal(
        (
          await f.call(`/schedules/${f.clinician.id}`, f.admin, 'PUT', {
            durationMinutes: 30,
            windows: allDays,
          })
        ).status,
        200,
      );
    if (change === 'closure')
      assert.equal(
        (
          await f.call('/schedule-closures', f.admin, 'POST', {
            doctorId: f.clinician.id,
            startDate: source.input.firstDate,
            endDate: source.input.firstDate,
            startTime: '12:00',
            endTime: '13:00',
            reason: 'Operational change',
          })
        ).status,
        201,
      );
    if (change === 'slot')
      await f.ordinary({ patientId: 'patient-2', date: source.input.firstDate });
    const before = counts(f.db);
    assert.equal(
      (await f.call('/appointment-series', f.admin, 'POST', f.command(source))).status,
      409,
      change,
    );
    assert.deepEqual(counts(f.db), before);
    assert.notEqual((await f.preview(source.input)).revision, source.revision, change);
  }
  const f = await fixture(t),
    source = await f.preview();
  const patient = get<Patient>(f.db, 'patients', 'patient-ananya')!;
  f.db
    .prepare('UPDATE patients SET data=? WHERE id=?')
    .run(JSON.stringify({ ...patient, allergies: 'PRIVATE_CLINICAL_CHANGE_SENTINEL' }), patient.id);
  const current = await f.preview(source.input);
  assert.equal(current.revision, source.revision);
  assert.ok(!JSON.stringify(current).includes('PRIVATE_CLINICAL_CHANGE_SENTINEL'));
  assert.equal(
    (await f.call('/appointment-series', f.admin, 'POST', f.command(source))).status,
    201,
  );
});

test('IST midnight and the current clock invalidate stale previews without imposing an arbitrary timestamp expiry', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2027-01-01T18:29:58.000Z') });
  const f = await fixture(t),
    value = f.input({ firstDate: '2027-01-02', time: '09:00', count: 2 });
  const initial = await f.preview(value);
  assert.equal(initial.clinicDate, '2027-01-01');
  assert.equal(initial.horizonEndDate, addDays('2027-01-01', 180));
  t.mock.timers.setTime(Date.parse('2027-01-01T18:29:59.000Z'));
  const another = await f.preview(value);
  assert.notEqual(another.generatedAt, initial.generatedAt);
  assert.equal(another.revision, initial.revision);
  t.mock.timers.setTime(Date.parse('2027-01-01T18:30:00.000Z'));
  assert.equal(
    (await f.call('/appointment-series', f.admin, 'POST', f.command(initial))).status,
    409,
  );
  const afterMidnight = await f.preview(value);
  assert.equal(afterMidnight.clinicDate, '2027-01-02');
  assert.notEqual(afterMidnight.revision, initial.revision);
  t.mock.timers.setTime(Date.parse('2027-01-02T03:29:59.000Z'));
  const beforeStart = await f.preview(value);
  assert.equal(beforeStart.canBook, true);
  t.mock.timers.setTime(Date.parse('2027-01-02T03:30:01.000Z'));
  assert.equal(
    (await f.call('/appointment-series', f.admin, 'POST', f.command(beforeStart))).status,
    409,
  );
  assert.equal(count(f.db, 'appointmentSeries'), 0);
});

test('successful series insert each appointment and notification exactly once with no unrelated operational side effects', async (t) => {
  const f = await fixture(t);
  const tables = [
    'resourceReservations',
    'resourceAllocationEvents',
    'invoices',
    'procedureScheduleEvents',
    'waitlistEvents',
  ];
  const beforeUnrelated = Object.fromEntries(tables.map((table) => [table, count(f.db, table)]));
  const before = counts(f.db),
    booked = await f.book({ count: 4, mode: 'online' });
  assert.equal(count(f.db, 'appointments') - before.appointments, 4);
  assert.equal(count(f.db, 'appointmentSeries'), 1);
  assert.equal(count(f.db, 'appointmentSeriesMembers'), 4);
  assert.equal(count(f.db, 'appointmentSeriesCommands'), 1);
  const notices = f.db
    .prepare("SELECT eventKey,data FROM activity WHERE eventKey LIKE 'appointment-created:%'")
    .all()
    .filter((row) =>
      booked.appointments.some(
        (appointment) => row.eventKey === `appointment-created:${appointment.id}`,
      ),
    );
  assert.equal(notices.length, 4);
  for (const notice of notices) {
    assert.ok(!String(notice.data).includes(privateNote));
    assert.ok(!String(notice.data).includes(booked.series.requestId));
  }
  const ordinaryAudits = f.db
    .prepare("SELECT data FROM audit WHERE json_extract(data,'$.action')='booked appointment'")
    .all()
    .map((row) => JSON.parse(String(row.data)))
    .filter((row) => booked.appointments.some((appointment) => appointment.id === row.entityId));
  assert.equal(ordinaryAudits.length, 4);
  assert.deepEqual(
    Object.fromEntries(tables.map((table) => [table, count(f.db, table)])),
    beforeUnrelated,
  );
  assert.ok(
    booked.appointments.every(
      (appointment) =>
        appointment.reason === booked.series.input.reason &&
        appointment.patientName === booked.series.patient.name &&
        appointment.doctorName === booked.series.doctor.name,
    ),
  );
});

test('last-member, patient-notice, audit and receipt failures roll back the entire series and preserve the exact retry', async (t) => {
  for (const failure of ['last-appointment', 'activity', 'audit', 'receipt'] as const) {
    const f = await fixture(t),
      source = await f.preview(),
      body = f.command(source),
      before = counts(f.db);
    if (failure === 'last-appointment')
      f.db.exec(
        `CREATE TRIGGER synthetic_series_failure BEFORE INSERT ON appointments WHEN NEW.date='${source.visits[2].date}' AND NEW.doctorId='${f.clinician.id}' BEGIN SELECT RAISE(ABORT,'Synthetic last series visit failure'); END;`,
      );
    if (failure === 'activity')
      f.db.exec(
        "CREATE TRIGGER synthetic_series_failure BEFORE INSERT ON activity WHEN NEW.eventKey LIKE 'appointment-created:%' BEGIN SELECT RAISE(ABORT,'Synthetic series activity failure'); END;",
      );
    if (failure === 'audit')
      f.db.exec(
        "CREATE TRIGGER synthetic_series_failure BEFORE INSERT ON audit WHEN json_extract(NEW.data,'$.entityType')='appointment-series' BEGIN SELECT RAISE(ABORT,'Synthetic series audit failure'); END;",
      );
    if (failure === 'receipt')
      f.db.exec(
        "CREATE TRIGGER synthetic_series_failure BEFORE INSERT ON appointmentSeriesCommands BEGIN SELECT RAISE(ABORT,'Synthetic series receipt failure'); END;",
      );
    const failed = await f.call('/appointment-series', f.admin, 'POST', body);
    assert.equal(failed.status, 500, `${failure}: ${JSON.stringify(failed.data)}`);
    assert.equal(failed.headers.get('set-cookie'), null);
    assert.deepEqual(counts(f.db), before);
    f.db.exec('DROP TRIGGER synthetic_series_failure');
    const saved = await f.call('/appointment-series', f.admin, 'POST', body);
    assert.equal(saved.status, 201, JSON.stringify(saved.data));
    assert.equal(saved.data.series.requestId, body.requestId);
    assert.equal(saved.data.appointments.length, 3);
  }
});

test('exact retries preserve the original booking receipt after individual moves and cancellation, and reject actor or payload collisions', async (t) => {
  const f = await fixture(t),
    reception = await f.login('reception');
  const saved = await f.book({ durationPolicy: 'custom', durationMinutes: 60, count: 2 });
  const first = saved.appointments[0],
    second = saved.appointments[1];
  assert.equal(
    (
      await f.call(`/appointments/${first.id}`, f.admin, 'PATCH', {
        date: addDays(first.date, 1),
        time: '10:00',
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.call(`/appointments/${second.id}`, f.admin, 'PATCH', { status: 'cancelled' })).status,
    200,
  );
  const before = counts(f.db);
  const replay = await f.call('/appointment-series', f.admin, 'POST', saved.body);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data.series, saved.series);
  assert.deepEqual(replay.data.series.bookedAppointments, saved.series.bookedAppointments);
  assert.deepEqual(
    replay.data.appointments.map((visit: Appointment) => visit.id),
    saved.appointments.map((visit) => visit.id),
  );
  assert.equal(replay.data.appointments[0].date, addDays(first.date, 1));
  assert.equal(replay.data.appointments[0].durationMinutes, 60);
  assert.equal(replay.data.appointments[1].status, 'cancelled');
  assert.equal(replay.data.series.bookedAppointments[1].status, 'scheduled');
  assert.deepEqual(counts(f.db), before);
  assert.equal((await f.call('/appointment-series', reception, 'POST', saved.body)).status, 409);
  for (const changed of [
    { ...saved.body, privateNote: 'Changed private note' },
    { ...saved.body, expectedRevision: '0'.repeat(64) },
    { ...saved.body, input: { ...saved.body.input, reason: 'Changed public reason' } },
  ])
    assert.equal((await f.call('/appointment-series', f.admin, 'POST', changed)).status, 409);
});

test('patients see ordinary visits, calendars and care summaries without series notes, receipts or staff-only identifiers', async (t) => {
  const f = await fixture(t),
    patient = await f.login('patient'),
    saved = await f.book({ count: 2 });
  for (const path of ['/appointment-series', `/appointment-series/${saved.series.id}`]) {
    assert.equal((await f.call(path)).status, 401);
    assert.equal((await f.call(path, patient)).status, 403);
  }
  assert.equal(
    (await f.call('/appointment-series/preview', patient, 'POST', f.input())).status,
    403,
  );
  assert.equal((await f.call('/appointment-series', patient, 'POST', saved.body)).status, 403);
  const appointments = await f.call('/appointments', patient);
  assert.equal(appointments.status, 200);
  for (const visit of saved.appointments)
    assert.ok(appointments.data.some((entry: Appointment) => entry.id === visit.id));
  const summary = await f.call('/patients/patient-ananya/care-summary', patient);
  assert.equal(summary.status, 200);
  const calendar = await f.call(`/appointments/${saved.appointments[0].id}/calendar`, patient);
  assert.equal(calendar.status, 200);
  assert.match(calendar.headers.get('content-type') ?? '', /text\/calendar/);
  const activity = await f.call('/activity', patient);
  assert.equal(activity.status, 200);
  for (const output of [
    JSON.stringify(appointments.data),
    JSON.stringify(summary.data),
    String(calendar.data),
    JSON.stringify(activity.data),
  ]) {
    for (const secret of [
      privateNote,
      saved.series.requestId,
      saved.series.expectedRevision,
      saved.series.id,
    ])
      assert.ok(!output.includes(secret));
  }
  const staff = await f.call(`/appointment-series/${saved.series.id}`, f.admin);
  assert.equal(staff.status, 200);
  assert.equal(staff.data.series.privateNote, privateNote);
});

test('fresh booking and exact replay revalidate role, password state, session, CSRF and MFA after acquiring the write lock', async (t) => {
  for (const change of [
    'revoked',
    'expired',
    'csrf',
    'inactive',
    'temporary',
    'role',
    'mfa',
  ] as const) {
    for (const replay of [false, true]) {
      const f = await fixture(t),
        source = await f.preview(),
        body = f.command(source);
      if (replay)
        assert.equal((await f.call('/appointment-series', f.admin, 'POST', body)).status, 201);
      const external = openDatabase(f.databasePath),
        original = f.db.exec.bind(f.db);
      let injected = false;
      f.db.exec = ((sql: string) => {
        if (sql === 'BEGIN IMMEDIATE' && !injected) {
          injected = true;
          if (change === 'revoked')
            external.prepare('DELETE FROM sessions WHERE userId=?').run(f.admin.user.id);
          if (change === 'expired')
            external.prepare('UPDATE sessions SET expiresAt=0 WHERE userId=?').run(f.admin.user.id);
          if (change === 'csrf')
            external
              .prepare('UPDATE sessions SET csrfToken=? WHERE userId=?')
              .run('replaced-csrf', f.admin.user.id);
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
                "UPDATE users SET role='patient',data=json_set(data,'$.role','patient') WHERE id=?",
              )
              .run(f.admin.user.id);
          if (change === 'mfa')
            external
              .prepare(
                'INSERT INTO mfaCredentials(userId,id,secret,enabledAt,lastStep) VALUES (?,?,?,?,?)',
              )
              .run(
                f.admin.user.id,
                randomUUID(),
                'Unused synthetic encrypted-source sentinel',
                new Date().toISOString(),
                -1,
              );
        }
        return original(sql);
      }) as typeof f.db.exec;
      try {
        const before = counts(f.db),
          result = await f.call('/appointment-series', f.admin, 'POST', body);
        assert.equal(injected, true, `${change}, replay=${replay}`);
        assert.equal(
          result.status,
          change === 'role' || change === 'temporary' ? 403 : 401,
          `${change}, replay=${replay}: ${JSON.stringify(result.data)}`,
        );
        assert.equal(result.data.series, undefined);
        assert.equal(result.data.appointments, undefined);
        assert.deepEqual(counts(f.db), before);
      } finally {
        f.db.exec = original;
        external.close();
      }
    }
  }
});

test('an external writer changing the displayed source between middleware and transaction makes the whole command stale', async (t) => {
  const f = await fixture(t),
    source = await f.preview(),
    body = f.command(source);
  const external = openDatabase(f.databasePath),
    original = f.db.exec.bind(f.db);
  let injected = false;
  f.db.exec = ((sql: string) => {
    if (sql === 'BEGIN IMMEDIATE' && !injected) {
      injected = true;
      external
        .prepare("UPDATE doctors SET data=json_set(data,'$.fee',700) WHERE id=?")
        .run(f.clinician.id);
    }
    return original(sql);
  }) as typeof f.db.exec;
  try {
    const before = counts(f.db),
      response = await f.call('/appointment-series', f.admin, 'POST', body);
    assert.equal(injected, true);
    assert.equal(response.status, 409);
    assert.deepEqual(counts(f.db), before);
  } finally {
    f.db.exec = original;
    external.close();
  }
  const refreshed = await f.preview(source.input);
  assert.equal(refreshed.doctor.fee, 700);
  const saved = await f.call('/appointment-series', f.admin, 'POST', f.command(refreshed));
  assert.equal(saved.status, 201);
  assert.ok(saved.data.appointments.every((appointment: Appointment) => appointment.fee === 700));
});

test('independent app instances serialize competing bookings and identical concurrent requests create only one complete series', async (t) => {
  const first = await fixture(t),
    second = await fixture(t, first.databasePath);
  const source = await first.preview(),
    firstCommand = first.command(source),
    secondCommand = first.command(source);
  const before = count(first.db, 'appointments');
  const competing = await Promise.all([
    first.call('/appointment-series', first.admin, 'POST', firstCommand),
    second.call('/appointment-series', second.admin, 'POST', secondCommand),
  ]);
  assert.deepEqual(competing.map((result) => result.status).sort(), [201, 409]);
  assert.equal(count(first.db, 'appointmentSeries'), 1);
  assert.equal(count(first.db, 'appointmentSeriesMembers'), 3);
  assert.equal(count(first.db, 'appointments') - before, 3);
  const next = await first.preview(first.input({ time: '10:00' })),
    command = first.command(next);
  const repeated = await Promise.all([
    first.call('/appointment-series', first.admin, 'POST', command),
    second.call('/appointment-series', second.admin, 'POST', command),
  ]);
  assert.deepEqual(repeated.map((result) => result.status).sort(), [200, 201]);
  assert.deepEqual(repeated[0].data, repeated[1].data);
  assert.equal(count(first.db, 'appointmentSeries'), 2);
  assert.equal(count(first.db, 'appointmentSeriesCommands'), 2);
  assert.equal(count(first.db, 'appointmentSeriesMembers'), 6);
  assert.equal(count(first.db, 'appointments') - before, 6);
  await second.close();
});

test('canonical inputs and UUIDs replay exactly while missing records and invalid read queries fail explicitly', async (t) => {
  const f = await fixture(t),
    source = await f.preview(f.input({ reason: '  A normalized appointment reason  ' }));
  assert.equal(source.input.reason, 'A normalized appointment reason');
  const requestId = randomUUID(),
    body = f.command(source, {
      requestId: requestId.toUpperCase(),
      privateNote: '  Private operational note  ',
    });
  const result = await f.call('/appointment-series', f.admin, 'POST', body);
  assert.equal(result.status, 201);
  assert.equal(result.data.series.requestId, requestId);
  assert.equal(result.data.series.privateNote, 'Private operational note');
  const replay = await f.call('/appointment-series', f.admin, 'POST', {
    ...body,
    requestId,
    privateNote: 'Private operational note',
    input: { ...body.input, reason: ' A normalized appointment reason ' },
  });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data, result.data);
  for (const query of [
    'unknown=x',
    'page=0',
    'page=1000001',
    'page=1.5',
    'pageSize=100',
    'q=' + 'a'.repeat(201),
    'patientId=',
    'q=a&q=b',
  ]) {
    assert.equal((await f.call(`/appointment-series?${query}`, f.admin)).status, 400, query);
  }
  assert.equal(
    (await f.call(`/appointment-series/${result.data.series.id}?unknown=x`, f.admin)).status,
    400,
  );
  assert.equal((await f.call('/appointment-series/not-found', f.admin)).status, 404);
  assert.equal(
    (await f.call('/appointment-series/preview?unknown=x', f.admin, 'POST', f.input())).status,
    400,
  );
  assert.equal((await f.call('/appointment-series?unknown=x', f.admin, 'POST', body)).status, 400);
  assert.equal(
    (
      await f.call(
        '/appointment-series/preview',
        f.admin,
        'POST',
        f.input({ patientId: 'missing-patient' }),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await f.call(
        '/appointment-series/preview',
        f.admin,
        'POST',
        f.input({ doctorId: 'missing-doctor' }),
      )
    ).status,
    404,
  );
});

test('immutable series origins and ordered membership survive restart and replay returns later current visit state', async (t) => {
  const f = await fixture(t),
    saved = await f.book({ count: 2 });
  for (const sql of [
    'UPDATE appointmentSeries SET data=data',
    'DELETE FROM appointmentSeries',
    'UPDATE appointmentSeriesMembers SET position=position',
    'DELETE FROM appointmentSeriesMembers',
    'UPDATE appointmentSeriesCommands SET payload=payload',
    'DELETE FROM appointmentSeriesCommands',
  ])
    assert.throws(() => f.db.exec(sql), /immutable/i);
  assert.throws(
    () =>
      f.db
        .prepare(
          'INSERT INTO appointmentSeriesMembers(seriesId,position,appointmentId) VALUES(?,?,?)',
        )
        .run(saved.series.id, 3, saved.appointments[0].id),
    /UNIQUE/,
  );
  const moved = await f.call(`/appointments/${saved.appointments[0].id}`, f.admin, 'PATCH', {
    date: addDays(saved.appointments[1].date, 1),
    time: '11:00',
  });
  assert.equal(moved.status, 200);
  await f.close();
  const restarted = await fixture(t, f.databasePath),
    before = counts(restarted.db);
  const retry = await restarted.call('/appointment-series', restarted.admin, 'POST', saved.body);
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.data.series, saved.series);
  assert.deepEqual(
    retry.data.appointments.map((appointment: Appointment) => appointment.id),
    saved.appointments.map((appointment) => appointment.id),
  );
  assert.equal(retry.data.appointments[0].date, moved.data.date);
  assert.ok(
    retry.data.appointments[0].date > retry.data.appointments[1].date,
    'member order remains original position rather than current appointment date',
  );
  assert.deepEqual(counts(restarted.db), before);
  const detail = await restarted.call(`/appointment-series/${saved.series.id}`, restarted.admin);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.data, retry.data);
  await restarted.close();
});

test('series lists are bounded, literal, based on original labels and transactionally coherent while showing no command or note payload', async (t) => {
  const f = await fixture(t),
    patient = get<Patient>(f.db, 'patients', 'patient-ananya')!;
  const saved: AppointmentSeriesDetail[] = [];
  for (let index = 0; index < 26; index++) {
    f.db.prepare('UPDATE patients SET data=? WHERE id=?').run(
      JSON.stringify({
        ...patient,
        name: index === 7 ? 'Original %_ series patient' : `Original series patient ${index}`,
      }),
      patient.id,
    );
    const minutes = 9 * 60 + index * 20;
    saved.push(
      await f.book({
        count: 2,
        time: `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`,
      }),
    );
  }
  f.db
    .prepare('UPDATE patients SET data=? WHERE id=?')
    .run(JSON.stringify({ ...patient, name: 'Corrected current name' }), patient.id);
  const first = await f.call('/appointment-series?pageSize=10', f.admin);
  assert.equal(first.status, 200);
  assert.deepEqual(
    [first.data.total, first.data.totalPages, first.data.page, first.data.items.length],
    [26, 3, 1, 10],
  );
  const last = await f.call('/appointment-series?page=999999&pageSize=10', f.admin);
  assert.deepEqual(
    [last.data.total, last.data.totalPages, last.data.page, last.data.items.length],
    [26, 3, 3, 6],
  );
  assert.ok(
    first.data.items.every(
      (row: { id: string }) =>
        !last.data.items.some((other: { id: string }) => row.id === other.id),
    ),
  );
  for (const output of [first.data, last.data]) {
    const json = JSON.stringify(output);
    for (const secret of [
      privateNote,
      'requestId',
      'expectedRevision',
      'bookedAppointments',
      'Corrected current name',
    ])
      assert.ok(!json.includes(secret));
  }
  const literal = await f.call('/appointment-series?q=%25_', f.admin);
  assert.equal(literal.data.total, 1);
  assert.equal(literal.data.items[0].id, saved[7].series.id);
  assert.equal((await f.call('/appointment-series?q=ORIGINAL', f.admin)).data.total, 26);
  assert.equal((await f.call('/appointment-series?q=corrected', f.admin)).data.total, 0);
  assert.equal(
    (
      await f.call(
        `/appointment-series?patientId=${patient.id}&doctorId=${f.clinician.id}`,
        f.admin,
      )
    ).data.total,
    26,
  );
  const empty = await f.call('/appointment-series?patientId=patient-2&page=8', f.admin);
  assert.deepEqual(
    [empty.data.total, empty.data.totalPages, empty.data.page, empty.data.items.length],
    [0, 1, 1, 0],
  );
  const external = openDatabase(f.databasePath),
    prepare = f.db.prepare.bind(f.db);
  external.exec('PRAGMA busy_timeout=0');
  let checked = false;
  f.db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (sql.startsWith('SELECT count(*) AS n FROM appointmentSeries')) {
      const originalGet = statement.get.bind(statement);
      statement.get = ((...parameters: Parameters<typeof statement.get>) => {
        const result = originalGet(...parameters);
        checked = true;
        assert.throws(() => external.exec('BEGIN IMMEDIATE'), /locked/i);
        return result;
      }) as typeof statement.get;
    }
    return statement;
  }) as typeof f.db.prepare;
  try {
    const coherent = await f.call('/appointment-series?page=2&pageSize=10', f.admin);
    assert.equal(checked, true);
    assert.equal(coherent.status, 200);
    assert.deepEqual(
      [coherent.data.total, coherent.data.page, coherent.data.items.length],
      [26, 2, 10],
    );
  } finally {
    f.db.prepare = prepare;
    external.close();
  }
});

test('each saved member retains ordinary default or custom rescheduling behavior without changing the other members or original receipt', async (t) => {
  const f = await fixture(t),
    patient = await f.login('patient');
  const standard = await f.book({ count: 2 }),
    custom = await f.book({
      count: 2,
      time: '11:00',
      durationPolicy: 'custom',
      durationMinutes: 45,
    });
  assert.equal(
    (
      await f.call(`/schedules/${f.clinician.id}`, f.admin, 'PUT', {
        durationMinutes: 30,
        windows: allDays,
      })
    ).status,
    200,
  );
  const standardMoved = await f.call(
    `/appointments/${standard.appointments[0].id}`,
    patient,
    'PATCH',
    { date: addDays(standard.appointments[0].date, 1), time: '09:00' },
  );
  assert.equal(standardMoved.status, 200);
  assert.equal(standardMoved.data.durationMinutes, 30);
  const customMoved = await f.call(`/appointments/${custom.appointments[0].id}`, patient, 'PATCH', {
    date: addDays(custom.appointments[0].date, 1),
    time: '10:05',
    mode: 'online',
  });
  assert.equal(customMoved.status, 200);
  assert.equal(customMoved.data.durationMinutes, 45);
  assert.equal(customMoved.data.durationPolicy, 'custom');
  const currentStandard = await f.call(`/appointment-series/${standard.series.id}`, f.admin);
  assert.deepEqual(currentStandard.data.appointments[1], standard.appointments[1]);
  assert.deepEqual(currentStandard.data.series, standard.series);
  const currentCustom = await f.call(`/appointment-series/${custom.series.id}`, f.admin);
  assert.deepEqual(currentCustom.data.appointments[1], custom.appointments[1]);
  assert.deepEqual(currentCustom.data.series, custom.series);
  const calendar = await f.call(`/appointments/${custom.appointments[0].id}/calendar`, patient);
  const date = addDays(custom.appointments[0].date, 1).replaceAll('-', '');
  assert.ok(String(calendar.data).includes(`DTSTART:${date}T043500Z`));
  assert.ok(String(calendar.data).includes(`DTEND:${date}T052000Z`));
});
