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
  AppointmentSeriesDetail,
  AppointmentSeriesInput,
} from '../shared/appointment-series.ts';
import type {
  SeriesRescheduleMove,
  SeriesRescheduleInput,
  SeriesReschedulePreview,
} from '../shared/appointment-series-rescheduling.ts';

const patientId = 'patient-ananya';
const privateReason = 'PRIVATE_BATCH_RESCHEDULE_REASON';
const password = 'DemoClinic2026!';
const allDays = Array.from({ length: 7 }, (_, day) => ({
  day,
  start: '09:00',
  end: '18:00',
  mode: 'both',
}));
type Client = { user: User; cookie: string; csrf: string };
const path = (seriesId: string) => `/appointment-series/${seriesId}/reschedules`;

async function fixture(t: TestContext, database?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'derma-series-reschedules-'));
  const databasePath = database ?? join(directory, 'clinic.sqlite');
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
  async function call(url: string, who?: Client, method = 'GET', body?: unknown) {
    const response = await fetch(`${base}/api${url}`, {
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
      email: `${role}@derma.demo`,
      password,
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return {
      user: result.data.user,
      cookie: result.headers.get('set-cookie')!.split(';')[0],
      csrf: result.data.csrfToken,
    } as Client;
  }
  const admin = await login('admin');
  async function doctor() {
    const created = await call('/doctors', admin, 'POST', {
      name: `Dr. Reschedule ${randomUUID()}`,
      title: 'Synthetic clinician',
      qualifications: 'Synthetic profile',
      specialties: ['General dermatology'],
      experience: 1,
      fee: 600,
      bio: 'Synthetic rescheduling fixture.',
      languages: ['English'],
      color: '#b3c7aa',
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const configured = await call(`/schedules/${created.data.id}`, admin, 'PUT', {
      durationMinutes: 30,
      windows: allDays,
    });
    assert.equal(configured.status, 200, JSON.stringify(configured.data));
    return created.data as Doctor;
  }
  const clinician = await doctor();
  async function book(overrides: Record<string, unknown> = {}) {
    const input = {
      patientId,
      doctorId: clinician.id,
      mode: 'in-person',
      reason: 'Shared visit reason',
      firstDate: addDays(clinicToday(), 35),
      time: '09:00',
      count: 3,
      intervalWeeks: 1,
      durationPolicy: 'custom',
      durationMinutes: 60,
      ...overrides,
    } as AppointmentSeriesInput;
    const preview = await call('/appointment-series/preview', admin, 'POST', input);
    assert.equal(preview.status, 200, JSON.stringify(preview.data));
    assert.equal(preview.data.canBook, true, JSON.stringify(preview.data.visits));
    const body = {
      input,
      expectedRevision: preview.data.revision,
      patientConfirmed: true,
      privateNote: 'PRIVATE_ORIGIN_NOTE',
      requestId: randomUUID(),
    };
    const created = await call('/appointment-series', admin, 'POST', body);
    assert.equal(created.status, 201, JSON.stringify(created.data));
    return { ...(created.data as AppointmentSeriesDetail), body };
  }
  async function preview(seriesId: string, moves: SeriesRescheduleMove[], who = admin) {
    const result = await call(`${path(seriesId)}/preview`, who, 'POST', { moves });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data as SeriesReschedulePreview;
  }
  const command = (value: SeriesReschedulePreview): SeriesRescheduleInput => ({
    moves: value.moves,
    reason: privateReason,
    expectedRevision: value.revision,
    patientConfirmed: true,
    requestId: randomUUID(),
  });
  async function move(seriesId: string, moves: SeriesRescheduleMove[], who = admin) {
    const input = command(await preview(seriesId, moves, who));
    const result = await call(path(seriesId), who, 'POST', input);
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return { ...result.data, input };
  }
  async function resource() {
    const result = await call('/clinic-resources', admin, 'POST', {
      name: `Synthetic room ${randomUUID()}`,
      kind: 'room',
      requestId: randomUUID(),
    });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return result.data.resource.id as string;
  }
  async function allocate(appointmentId: string, resourceIds: string[]) {
    const current = await call(`/appointments/${appointmentId}/resources`, admin);
    assert.equal(current.status, 200);
    const result = await call(`/appointments/${appointmentId}/resources`, admin, 'PUT', {
      resourceIds,
      reason: 'Synthetic reservation',
      expectedRevision: current.data.revision,
      requestId: randomUUID(),
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data;
  }
  return {
    app,
    db,
    databasePath,
    call,
    login,
    admin,
    clinician,
    doctor,
    book,
    preview,
    command,
    move,
    resource,
    allocate,
    close,
  };
}

function changeAppointment(db: DB, appointmentId: string, patch: Partial<Appointment>) {
  const value = { ...get<Appointment>(db, 'appointments', appointmentId)!, ...patch };
  db.prepare('UPDATE appointments SET doctorId=?,date=?,time=?,status=?,data=? WHERE id=?').run(
    value.doctorId,
    value.date,
    value.time,
    value.status,
    JSON.stringify(value),
    appointmentId,
  );
  return value;
}
const count = (db: DB, table: string) =>
  Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
function state(db: DB) {
  return Object.fromEntries(
    [
      'appointments',
      'appointmentSeries',
      'appointmentSeriesMembers',
      'appointmentSeriesCommands',
      'appointmentSeriesCancellations',
      'appointmentSeriesReschedules',
      'resourceReservations',
      'resourceAllocationEvents',
      'resourceEventLinks',
      'audit',
      'activity',
    ].map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
  );
}

const target = (
  appointment: Appointment,
  date = addDays(appointment.date, 1),
  time = appointment.time,
): SeriesRescheduleMove => ({ appointmentId: appointment.id, date, time });

test('staff can move selected current visits while anonymous and patients cannot access any rescheduling path', async (t) => {
  const f = await fixture(t),
    booked = await f.book(),
    patient = await f.login('patient'),
    doctor = await f.login('doctor'),
    reception = await f.login('reception');
  const moves = booked.appointments.map((appointment) => target(appointment)),
    source = await f.preview(booked.series.id, moves);
  for (const who of [undefined, patient]) {
    for (const [suffix, method, payload] of [
      ['/context', 'GET', undefined],
      ['', 'GET', undefined],
      ['/preview', 'POST', { moves }],
      ['', 'POST', f.command(source)],
    ] as const)
      assert.equal(
        (await f.call(`${path(booked.series.id)}${suffix}`, who, method, payload)).status,
        who ? 403 : 401,
      );
  }
  for (const [index, who] of [f.admin, doctor, reception].entries()) {
    const result = await f.move(booked.series.id, [moves[index]], who);
    assert.equal(result.event.createdById, who.user.id);
    assert.equal(result.event.createdByRole, who.user.role);
    assert.deepEqual(result.detail.series, booked.series);
  }
  const context = await f.call(`${path(booked.series.id)}/context`, reception);
  assert.equal(context.status, 200);
  assert.match(context.headers.get('cache-control') ?? '', /no-store/);
  assert.equal(context.data.clinicDate, clinicToday());
  assert.equal(context.data.horizonEndDate, addDays(clinicToday(), 180));
});

test('strict moves reject duplicate, foreign, malformed and injected targets and unknown query fields without mutations', async (t) => {
  const f = await fixture(t),
    booked = await f.book(),
    other = await f.book({ time: '12:00' });
  const moves = [target(booked.appointments[0])],
    body = f.command(await f.preview(booked.series.id, moves));
  const before = state(f.db);
  for (const invalid of [
    [],
    [moves[0], moves[0]],
    [target(other.appointments[0])],
    [{ ...moves[0], appointmentId: 'missing' }],
    [{ ...moves[0], date: '2027-02-30' }],
    [{ ...moves[0], time: '25:00' }],
    [{ ...moves[0], doctorId: f.clinician.id }],
    Array.from({ length: 13 }, () => ({ ...moves[0], appointmentId: randomUUID() })),
  ])
    assert.equal(
      (await f.call(`${path(booked.series.id)}/preview`, f.admin, 'POST', { moves: invalid }))
        .status,
      400,
    );
  for (const invalid of [
    { ...body, reason: '' },
    { ...body, reason: 'x'.repeat(1001) },
    { ...body, patientConfirmed: false },
    { ...body, expectedRevision: 'invalid' },
    { ...body, requestId: 'bad' },
    { ...body, excludeAppointmentIds: [booked.appointments[1].id] },
  ])
    assert.equal((await f.call(path(booked.series.id), f.admin, 'POST', invalid)).status, 400);
  for (const suffix of [
    '/context?unknown=1',
    '?page=0',
    '?page=1000001',
    '?pageSize=100',
    '?page=1&page=2',
  ])
    assert.equal((await f.call(`${path(booked.series.id)}${suffix}`, f.admin)).status, 400);
  assert.equal(
    (await f.call(`${path(booked.series.id)}/preview?unknown=1`, f.admin, 'POST', { moves }))
      .status,
    400,
  );
  assert.equal(
    (await f.call(`${path(booked.series.id)}?unknown=1`, f.admin, 'POST', body)).status,
    400,
  );
  assert.equal(
    (await f.call(path(booked.series.id), { ...f.admin, csrf: 'wrong' }, 'POST', body)).status,
    403,
  );
  assert.deepEqual(state(f.db), before);
});

test('true swaps and three-member cycles preserve originals and retain the same resources without exposing temporary cancellation', async (t) => {
  const f = await fixture(t),
    booked = await f.book(),
    room = await f.resource();
  for (const appointment of booked.appointments) await f.allocate(appointment.id, [room]);
  const moves = booked.appointments.map((appointment, index) =>
    target(appointment, booked.appointments[(index + 1) % 3].date),
  );
  const before = state(f.db),
    source = await f.preview(booked.series.id, [...moves].reverse());
  assert.equal(source.canReschedule, true, JSON.stringify(source.visits));
  const afterPreview = state(f.db);
  for (const key of Object.keys(before).filter((key) => key !== 'audit'))
    assert.deepEqual(afterPreview[key], before[key], `preview cannot write ${key}`);
  let stagedObserved = false;
  const prepare = f.db.prepare.bind(f.db);
  f.db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (sql.startsWith("UPDATE appointments SET date=?,time=?,status='scheduled'")) {
      const run = statement.run.bind(statement);
      statement.run = ((...values: Parameters<typeof statement.run>) => {
        if (!stagedObserved) {
          const rows = prepare('SELECT status,data FROM appointments WHERE id IN (?,?,?)').all(
            ...booked.appointments.map((a) => a.id),
          );
          assert.ok(
            rows.every(
              (row) =>
                row.status === 'cancelled' && JSON.parse(String(row.data)).status === 'scheduled',
            ),
          );
          stagedObserved = true;
        }
        return run(...values);
      }) as typeof statement.run;
    }
    return statement;
  }) as typeof f.db.prepare;
  let result;
  try {
    result = await f.call(path(booked.series.id), f.admin, 'POST', f.command(source));
  } finally {
    f.db.prepare = prepare;
  }
  assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.equal(stagedObserved, true);
  assert.deepEqual(result.data.event.moves, moves);
  assert.deepEqual(result.data.detail.series, booked.series);
  for (const visit of result.data.event.visits) {
    assert.equal(visit.retainedReservationCount, 1);
    assert.equal(visit.after.status, 'scheduled');
    assert.equal(visit.before.date, booked.appointments[visit.position - 1].date);
    const context = await f.call(`/appointments/${visit.after.id}/resources`, f.admin);
    assert.deepEqual(context.data.resourceIds, [room]);
    assert.equal(context.data.history[0].source, 'appointment-rescheduled');
    assert.equal(context.data.history[0].before.appointment.date, visit.before.date);
    assert.equal(context.data.history[0].after.appointment.date, visit.after.date);
  }
  assert.equal(
    f.db
      .prepare(
        "SELECT COUNT(*) n FROM audit WHERE json_extract(data,'$.action')='appointment cancelled'",
      )
      .get()!.n,
    0,
  );
  assert.equal(count(f.db, 'appointmentSeriesCancellations'), 0);
  const latest = result.data.detail.appointments as Appointment[];
  const swapped = await f.move(booked.series.id, [
    target(latest[0], latest[1].date),
    target(latest[1], latest[0].date),
  ]);
  assert.equal(swapped.detail.appointments[0].date, latest[1].date);
  assert.equal(swapped.detail.appointments[1].date, latest[0].date);
});

test('real moves adopt current default duration and clinician fee/name while preserving custom length, current clinician/mode and booked patient fields', async (t) => {
  const f = await fixture(t),
    booked = await f.book({ durationPolicy: 'schedule', durationMinutes: undefined }),
    [first, second] = booked.appointments;
  const duration = await f.call(`/appointments/${second.id}/duration`, f.admin);
  const changed = await f.call(`/appointments/${second.id}/duration`, f.admin, 'POST', {
    durationPolicy: 'custom',
    durationMinutes: 60,
    date: second.date,
    time: second.time,
    reason: 'Extended visit',
    expectedRevision: duration.data.revision,
    requestId: randomUUID(),
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  const otherDoctor = await f.doctor();
  assert.equal(
    (
      await f.call(`/appointments/${second.id}`, f.admin, 'PATCH', {
        doctorId: otherDoctor.id,
        mode: 'online',
      })
    ).status,
    200,
  );
  for (const doctorId of [f.clinician.id, otherDoctor.id])
    f.db
      .prepare(
        "UPDATE doctors SET data=json_set(data,'$.name','Current clinician name','$.fee',875) WHERE id=?",
      )
      .run(doctorId);
  assert.equal(
    (
      await f.call(`/schedules/${f.clinician.id}`, f.admin, 'PUT', {
        durationMinutes: 45,
        windows: allDays,
      })
    ).status,
    200,
  );
  f.db
    .prepare(
      "UPDATE patients SET data=json_set(data,'$.name','Current patient name','$.phone','9000000666') WHERE id=?",
    )
    .run(patientId);
  const source = await f.preview(booked.series.id, [target(first), target(second)]);
  assert.equal(source.canReschedule, true);
  assert.equal(source.patient.name, 'Current patient name');
  assert.deepEqual(
    source.visits.map((v) => v.after.durationMinutes),
    [45, 60],
  );
  assert.equal(source.visits[1].after.doctorId, otherDoctor.id);
  assert.equal(source.visits[1].after.mode, 'online');
  for (const visit of source.visits) {
    assert.equal(visit.after.fee, 875);
    assert.equal(visit.after.doctorName, 'Current clinician name');
    assert.equal(visit.after.patientName, visit.before.patientName);
    assert.equal(visit.after.reason, visit.before.reason);
    assert.equal(visit.after.createdAt, visit.before.createdAt);
    assert.equal(visit.after.durationPolicy, visit.before.durationPolicy);
  }
  const result = await f.call(path(booked.series.id), f.admin, 'POST', f.command(source));
  assert.equal(result.status, 201);
});

test('selected target overlaps mark both rows blocked, adjacency succeeds, and unselected series visits remain real conflicts', async (t) => {
  const f = await fixture(t),
    booked = await f.book(),
    [first, second, third] = booked.appointments;
  const day = addDays(first.date, 2);
  const overlapping = await f.preview(booked.series.id, [
    target(first, day, '10:00'),
    target(second, day, '10:55'),
  ]);
  assert.equal(overlapping.canReschedule, false);
  assert.ok(
    overlapping.visits.every((v) => !v.eligible && v.blockedReason?.includes('Selected target')),
  );
  const before = state(f.db);
  assert.equal(
    (await f.call(path(booked.series.id), f.admin, 'POST', f.command(overlapping))).status,
    409,
  );
  assert.deepEqual(state(f.db), before);
  const unselected = await f.preview(booked.series.id, [target(first, third.date, third.time)]);
  assert.equal(unselected.canReschedule, false);
  const adjacent = await f.preview(booked.series.id, [
    target(first, day, '10:00'),
    target(second, day, '11:00'),
  ]);
  assert.equal(adjacent.canReschedule, true);
  assert.equal(
    (await f.call(path(booked.series.id), f.admin, 'POST', f.command(adjacent))).status,
    201,
  );
});

test('outside clinician, patient and resource reservations and maintenance block targets without identifying other patients', async (t) => {
  const f = await fixture(t),
    booked = await f.book(),
    first = booked.appointments[0],
    otherDoctor = await f.doctor(),
    room = await f.resource();
  await f.allocate(first.id, [room]);
  async function outsider(day: string, doctorId: string, patient: string, resource = false) {
    const result = await f.call('/appointments', f.admin, 'POST', {
      patientId: patient,
      doctorId,
      date: day,
      time: '09:00',
      mode: 'in-person',
      reason: 'OTHER_PATIENT_PRIVATE_REASON',
    });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    if (resource) await f.allocate(result.data.id, [room]);
  }
  await outsider(addDays(first.date, 1), f.clinician.id, 'patient-2');
  await outsider(addDays(first.date, 2), otherDoctor.id, patientId);
  await outsider(addDays(first.date, 3), otherDoctor.id, 'patient-2', true);
  for (let offset = 1; offset <= 3; offset++) {
    const source = await f.preview(booked.series.id, [target(first, addDays(first.date, offset))]);
    assert.equal(source.canReschedule, false);
    assert.ok(!JSON.stringify(source).includes('OTHER_PATIENT_PRIVATE_REASON'));
    assert.ok(!JSON.stringify(source).includes('patient-2'));
    if (offset === 3) assert.match(source.visits[0].blockedReason!, /resource is reserved/);
  }
  const detail = await f.call(`/clinic-resources/${room}`, f.admin);
  const day = addDays(first.date, 4);
  const closure = await f.call(`/clinic-resources/${room}/closures`, f.admin, 'POST', {
    startDate: day,
    endDate: day,
    startTime: null,
    endTime: null,
    reason: 'Synthetic maintenance',
    expectedRevision: detail.data.resource.revision,
    requestId: randomUUID(),
  });
  assert.equal(closure.status, 201, JSON.stringify(closure.data));
  const source = await f.preview(booked.series.id, [target(first, day)]);
  assert.match(source.visits[0].blockedReason!, /maintenance/);
  assert.equal(
    (await f.call(path(booked.series.id), f.admin, 'POST', f.command(source))).status,
    409,
  );
});

test('no-op, closed/past sources and unavailable targets stay visible and prevent the whole batch; midnight end labels remain truthful', async (t) => {
  const f = await fixture(t),
    booked = await f.book(),
    [first, second] = booked.appointments;
  for (const move of [
    target(first, first.date, first.time),
    target(first, addDays(clinicToday(), 181)),
    target(first, addDays(first.date, 1), '23:30'),
  ]) {
    const source = await f.preview(booked.series.id, [move, target(second)]);
    assert.equal(source.visits.length, 2);
    assert.equal(source.canReschedule, false);
    assert.equal(source.visits[1].eligible, true);
    if (move.time === '23:30') {
      assert.equal(source.visits[0].endDate, addDays(move.date, 1));
      assert.equal(source.visits[0].endTime, '00:30');
    }
    const before = state(f.db);
    assert.equal(
      (await f.call(path(booked.series.id), f.admin, 'POST', f.command(source))).status,
      409,
    );
    assert.deepEqual(state(f.db), before);
  }
  for (const status of [
    'cancelled',
    'checked-in',
    'in-consultation',
    'completed',
    'no-show',
  ] as const) {
    changeAppointment(f.db, first.id, { status });
    const source = await f.preview(booked.series.id, [target(first), target(second)]);
    assert.equal(source.visits[0].after.status, status);
    assert.equal(source.visits[0].eligible, false);
  }
  changeAppointment(f.db, first.id, { status: 'scheduled', date: addDays(clinicToday(), -1) });
  assert.equal((await f.preview(booked.series.id, [target(first)])).canReschedule, false);
  assert.equal(
    (
      await f.call(`${path(booked.series.id)}/preview`, f.admin, 'POST', {
        moves: [target(second, '9999-12-31', '23:30')],
      })
    ).status,
    400,
  );
});

test('every rescheduling path revalidates session, access, temporary-password and MFA state inside the write lock, including exact retries', async (t) => {
  for (const change of [
    'revoked',
    'expired',
    'csrf',
    'inactive',
    'temporary',
    'role',
    'mfa',
  ] as const) {
    const f = await fixture(t),
      booked = await f.book(),
      ids = booked.appointments.map((entry) => entry.id);
    const saved = await f.move(booked.series.id, [target(booked.appointments[0])]);
    const input = f.command(await f.preview(booked.series.id, [target(booked.appointments[1])]));
    const external = openDatabase(f.databasePath);
    const account = external
      .prepare('SELECT role,data FROM users WHERE id=?')
      .get(f.admin.user.id)!;
    const session = external.prepare('SELECT * FROM sessions WHERE userId=?').get(f.admin.user.id)!;
    const columns = Object.keys(session);
    const original = f.db.exec.bind(f.db);
    try {
      for (const operation of ['context', 'history', 'preview', 'commit', 'retry']) {
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
                .prepare("UPDATE sessions SET csrfToken='replaced-csrf' WHERE userId=?")
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
                  "UPDATE users SET role='patient',data=json_set(data,'$.role','patient','$.patientId',?) WHERE id=?",
                )
                .run('patient-2', f.admin.user.id);
            if (change === 'mfa')
              external
                .prepare(
                  'INSERT INTO mfaCredentials(userId,id,secret,enabledAt,lastStep) VALUES(?,?,?,?,?)',
                )
                .run(
                  f.admin.user.id,
                  randomUUID(),
                  'Unused synthetic encrypted source',
                  new Date().toISOString(),
                  -1,
                );
          }
          return original(sql);
        }) as typeof f.db.exec;
        const before = state(f.db);
        const response = await f.call(
          `${path(booked.series.id)}${operation === 'context' ? '/context' : operation === 'preview' ? '/preview' : ''}`,
          f.admin,
          ['preview', 'commit', 'retry'].includes(operation) ? 'POST' : 'GET',
          operation === 'preview'
            ? { moves: input.moves }
            : operation === 'commit'
              ? input
              : operation === 'retry'
                ? saved.input
                : undefined,
        );
        assert.equal(injected, true, `${change}/${operation}`);
        assert.equal(
          response.status,
          change === 'temporary' || change === 'role' ? 403 : 401,
          `${change}/${operation}: ${JSON.stringify(response.data)}`,
        );
        assert.equal(response.data.event, undefined);
        assert.equal(response.data.visits, undefined);
        assert.deepEqual(state(f.db), before, `${change}/${operation}`);
        f.db.exec = original;
        external
          .prepare('UPDATE users SET role=?,data=? WHERE id=?')
          .run(account.role, account.data, f.admin.user.id);
        external.prepare('DELETE FROM mfaCredentials WHERE userId=?').run(f.admin.user.id);
        external.prepare('DELETE FROM sessions WHERE userId=?').run(f.admin.user.id);
        external
          .prepare(
            `INSERT INTO sessions(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
          )
          .run(...columns.map((column) => session[column]));
      }
    } finally {
      f.db.exec = original;
      external.close();
    }
  }
});

test('changed doctor fees, names, schedules, selected allocation history and relevant closures require a fresh preview, while reads and unrelated resources do not', async (t) => {
  const f = await fixture(t),
    booked = await f.book(),
    first = booked.appointments[0],
    room = await f.resource();
  await f.allocate(first.id, [room]);
  const moves = [target(first)];
  for (const mutation of ['fee', 'name', 'schedule', 'allocation', 'maintenance']) {
    const source = await f.preview(booked.series.id, moves);
    if (mutation === 'fee')
      f.db
        .prepare("UPDATE doctors SET data=json_set(data,'$.fee',850) WHERE id=?")
        .run(f.clinician.id);
    if (mutation === 'name')
      f.db
        .prepare("UPDATE doctors SET data=json_set(data,'$.name','Renamed clinician') WHERE id=?")
        .run(f.clinician.id);
    if (mutation === 'schedule')
      assert.equal(
        (
          await f.call(`/schedules/${f.clinician.id}`, f.admin, 'PUT', {
            durationMinutes: 20,
            windows: allDays,
          })
        ).status,
        200,
      );
    if (mutation === 'allocation') {
      await f.allocate(first.id, []);
      await f.allocate(first.id, [room]);
    }
    if (mutation === 'maintenance') {
      const detail = await f.call(`/clinic-resources/${room}`, f.admin);
      assert.equal(
        (
          await f.call(`/clinic-resources/${room}/closures`, f.admin, 'POST', {
            startDate: moves[0].date,
            endDate: moves[0].date,
            startTime: '15:00',
            endTime: '16:00',
            reason: 'Later session maintenance',
            expectedRevision: detail.data.resource.revision,
            requestId: randomUUID(),
          })
        ).status,
        201,
      );
    }
    const before = state(f.db);
    assert.equal(
      (await f.call(path(booked.series.id), f.admin, 'POST', f.command(source))).status,
      409,
      mutation,
    );
    assert.deepEqual(state(f.db), before);
  }
  const source = await f.preview(booked.series.id, moves);
  await f.call(`${path(booked.series.id)}/context`, f.admin);
  await f.call(path(booked.series.id), f.admin);
  assert.equal(
    (
      await f.call(`/appointments/${booked.appointments[1].id}`, f.admin, 'PATCH', {
        time: '12:00',
      })
    ).status,
    200,
  );
  const unrelated = await f.call('/appointments', f.admin, 'POST', {
    patientId: 'patient-2',
    doctorId: f.clinician.id,
    date: addDays(first.date, 2),
    time: '13:00',
    mode: 'in-person',
    reason: 'Unrelated visit',
  });
  assert.equal(unrelated.status, 201);
  await f.allocate(unrelated.data.id, [room]);
  f.db
    .prepare(
      "UPDATE patients SET data=json_set(data,'$.allergies','PRIVATE_ALLERGY_CHANGE') WHERE id=?",
    )
    .run(patientId);
  assert.equal((await f.preview(booked.series.id, moves)).revision, source.revision);
  assert.equal(
    (await f.call(path(booked.series.id), f.admin, 'POST', f.command(source))).status,
    201,
  );
});

test('external source or target occupancy changes after middleware reject old previews before staging', async (t) => {
  const f = await fixture(t),
    booked = await f.book(),
    first = booked.appointments[0],
    external = openDatabase(f.databasePath),
    original = f.db.exec.bind(f.db);
  try {
    for (const change of ['source', 'patient', 'fee', 'target']) {
      const current = get<Appointment>(f.db, 'appointments', first.id)!;
      const moves = [target(current, addDays(first.date, 3), '10:00')],
        source = await f.preview(booked.series.id, moves);
      let injected = false;
      f.db.exec = ((sql: string) => {
        if (sql === 'BEGIN IMMEDIATE' && !injected) {
          injected = true;
          if (change === 'source') changeAppointment(external, first.id, { time: '11:00' });
          if (change === 'patient')
            external
              .prepare("UPDATE patients SET data=json_set(data,'$.phone','9000000998') WHERE id=?")
              .run(patientId);
          if (change === 'fee')
            external
              .prepare("UPDATE doctors SET data=json_set(data,'$.fee',999) WHERE id=?")
              .run(f.clinician.id);
          if (change === 'target') {
            const value = {
              ...current,
              id: randomUUID(),
              patientId: 'patient-2',
              date: moves[0].date,
              time: moves[0].time,
            };
            external
              .prepare(
                'INSERT INTO appointments(id,patientId,doctorId,date,time,status,data) VALUES(?,?,?,?,?,?,?)',
              )
              .run(
                value.id,
                value.patientId,
                value.doctorId,
                value.date,
                value.time,
                'scheduled',
                JSON.stringify(value),
              );
          }
        }
        return original(sql);
      }) as typeof f.db.exec;
      const result = await f.call(path(booked.series.id), f.admin, 'POST', f.command(source));
      f.db.exec = original;
      assert.equal(injected, true);
      assert.equal(result.status, 409, change);
      assert.equal(count(f.db, 'appointmentSeriesReschedules'), 0);
      assert.equal(get<Appointment>(f.db, 'appointments', first.id)!.status, 'scheduled');
    }
  } finally {
    f.db.exec = original;
    external.close();
  }
});

test('clock changes during preview stay coherent and during live validation or late audit return409 with complete rollback', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2027-03-01T06:29:59Z') });
  for (const phase of ['preview', 'validation', 'late-target', 'late-source']) {
    t.mock.timers.setTime(Date.parse('2027-03-01T06:29:59Z'));
    const f = await fixture(t),
      booked = await f.book(
        phase === 'late-source' ? { firstDate: clinicToday(), time: '12:00' } : {},
      );
    const moves = [
      target(
        booked.appointments[0],
        phase === 'late-source' ? addDays(clinicToday(), 1) : clinicToday(),
        '12:00',
      ),
    ];
    const source = await f.preview(booked.series.id, moves),
      body = f.command(source),
      prepare = f.db.prepare.bind(f.db);
    assert.equal(source.canReschedule, true);
    let crossed = false;
    f.db.prepare = ((sql: string) => {
      const statement = prepare(sql);
      if (
        (phase === 'preview' || phase === 'validation') &&
        sql.startsWith('SELECT id FROM resourceAllocationEvents')
      ) {
        const get = statement.get.bind(statement);
        statement.get = ((...values: Parameters<typeof statement.get>) => {
          const result = get(...values);
          crossed = true;
          t.mock.timers.setTime(Date.parse('2027-03-01T06:30:00Z'));
          return result;
        }) as typeof statement.get;
      }
      if (phase.startsWith('late-') && sql.startsWith('INSERT INTO audit')) {
        const run = statement.run.bind(statement);
        statement.run = ((...values: Parameters<typeof statement.run>) => {
          const result = run(...values);
          if (
            values.some(
              (value) =>
                typeof value === 'string' &&
                value.includes('rescheduled appointment series visits'),
            )
          ) {
            crossed = true;
            t.mock.timers.setTime(Date.parse('2027-03-01T06:30:00Z'));
          }
          return result;
        }) as typeof statement.run;
      }
      return statement;
    }) as typeof f.db.prepare;
    const before = state(f.db);
    try {
      const result = await f.call(
        `${path(booked.series.id)}${phase === 'preview' ? '/preview' : ''}`,
        f.admin,
        'POST',
        phase === 'preview' ? { moves } : body,
      );
      assert.equal(crossed, true, phase);
      if (phase === 'preview') {
        assert.equal(result.status, 200);
        assert.equal(result.data.generatedAt, '2027-03-01T06:29:59.000Z');
        assert.equal(result.data.canReschedule, true);
      } else {
        assert.equal(result.status, 409, `${phase}:${JSON.stringify(result.data)}`);
        assert.deepEqual(state(f.db), before, phase);
      }
    } finally {
      f.db.prepare = prepare;
    }
  }
});

test('staging, resource removal/reinsert, final appointment, event, receipt, audit and notification failures restore the entire old state', async (t) => {
  for (const failure of [
    'stage',
    'resource-delete',
    'resource-insert',
    'last-appointment',
    'event',
    'receipt',
    'audit',
    'activity',
    'verification',
  ]) {
    const f = await fixture(t),
      booked = await f.book(),
      room = await f.resource(),
      ids = booked.appointments.map((a) => a.id);
    for (const appointmentId of ids) await f.allocate(appointmentId, [room]);
    const moves = booked.appointments.map((a, index) =>
      target(a, booked.appointments[(index + 1) % 3].date),
    );
    const source = await f.preview(booked.series.id, moves),
      input = f.command(source);
    const timing = {
      stage: `BEFORE UPDATE ON appointments WHEN NEW.id='${ids[2]}' AND NEW.status='cancelled'`,
      'resource-delete': `BEFORE DELETE ON resourceReservations WHEN OLD.appointmentId='${ids[2]}'`,
      'resource-insert': `BEFORE INSERT ON resourceReservations WHEN NEW.appointmentId='${ids[2]}'`,
      'last-appointment': `BEFORE UPDATE ON appointments WHEN NEW.id='${ids[2]}' AND NEW.status='scheduled' AND OLD.status='cancelled'`,
      event: 'BEFORE INSERT ON appointmentSeriesReschedules',
      receipt: "BEFORE INSERT ON appointmentSeriesCommands WHEN NEW.operation='reschedule'",
      audit:
        "BEFORE INSERT ON audit WHEN json_extract(NEW.data,'$.action')='rescheduled appointment series visits'",
      activity: `BEFORE INSERT ON activity WHEN NEW.eventKey LIKE 'appointment-series-rescheduled:%:${ids[2]}'`,
      verification:
        "AFTER INSERT ON audit WHEN json_extract(NEW.data,'$.action')='rescheduled appointment series visits'",
    }[failure];
    const action =
      failure === 'verification'
        ? `UPDATE appointments SET status='cancelled' WHERE id='${ids[0]}';`
        : "SELECT RAISE(ABORT,'Synthetic reschedule rollback');";
    f.db.exec(`CREATE TRIGGER synthetic_move_failure ${timing} BEGIN ${action} END;`);
    const before = state(f.db),
      result = await f.call(path(booked.series.id), f.admin, 'POST', input);
    assert.equal(result.status, 500, `${failure}:${JSON.stringify(result.data)}`);
    assert.equal(result.data.event, undefined);
    assert.deepEqual(state(f.db), before, failure);
    f.db.exec('DROP TRIGGER synthetic_move_failure');
    assert.equal(
      (await f.call(path(booked.series.id), f.admin, 'POST', input)).status,
      201,
      failure,
    );
  }
});

test('exact replay preserves original move evidence after later individual changes/cancellation and shares UUID collision protection with booking/cancellation', async (t) => {
  const f = await fixture(t),
    booked = await f.book(),
    reception = await f.login('reception'),
    moves = booked.appointments.slice(0, 2).map((a) => target(a));
  const input = f.command(await f.preview(booked.series.id, moves));
  const initial = await f.call(path(booked.series.id), f.admin, 'POST', {
    ...input,
    moves: [...moves].reverse(),
    requestId: input.requestId.toUpperCase(),
    reason: ` ${privateReason} `,
  });
  assert.equal(initial.status, 201);
  assert.equal(
    (await f.call(`/appointments/${moves[0].appointmentId}`, f.admin, 'PATCH', { time: '12:00' }))
      .status,
    200,
  );
  assert.equal(
    (
      await f.call(`/appointments/${moves[1].appointmentId}`, f.admin, 'PATCH', {
        status: 'cancelled',
      })
    ).status,
    200,
  );
  const before = state(f.db),
    repeated = await f.call(path(booked.series.id), f.admin, 'POST', input);
  assert.equal(repeated.status, 200);
  assert.deepEqual(repeated.data.event, initial.data.event);
  assert.equal(repeated.data.detail.appointments[0].time, '12:00');
  assert.equal(repeated.data.detail.appointments[1].status, 'cancelled');
  assert.deepEqual(state(f.db), before);
  assert.equal((await f.call(path(booked.series.id), reception, 'POST', input)).status, 409);
  for (const changed of [
    { ...input, reason: 'Different reason' },
    { ...input, expectedRevision: '0'.repeat(64) },
    { ...input, moves: [moves[0]] },
  ])
    assert.equal((await f.call(path(booked.series.id), f.admin, 'POST', changed)).status, 409);
  assert.equal(
    (
      await f.call('/appointment-series', f.admin, 'POST', {
        ...booked.body,
        requestId: input.requestId,
      })
    ).status,
    409,
  );
  const cancellationPath = `/appointment-series/${booked.series.id}/cancellations`,
    ids = [booked.appointments[2].id];
  const cancelPreview = await f.call(`${cancellationPath}/preview`, f.admin, 'POST', {
    appointmentIds: ids,
  });
  const cancelBody = {
    appointmentIds: ids,
    reason: 'Separate cancellation',
    expectedRevision: cancelPreview.data.revision,
    patientConfirmed: true,
    requestId: input.requestId,
  };
  assert.equal((await f.call(cancellationPath, f.admin, 'POST', cancelBody)).status, 409);
  const nextPreview = await f.preview(booked.series.id, [target(booked.appointments[2])]);
  assert.equal(
    (
      await f.call(path(booked.series.id), f.admin, 'POST', {
        ...f.command(nextPreview),
        requestId: booked.body.requestId,
      })
    ).status,
    409,
  );
  cancelBody.requestId = randomUUID();
  assert.equal((await f.call(cancellationPath, f.admin, 'POST', cancelBody)).status, 201);
  assert.equal(
    (
      await f.call(path(booked.series.id), f.admin, 'POST', {
        ...f.command(nextPreview),
        requestId: cancelBody.requestId,
      })
    ).status,
    409,
  );
});

test('competing application connections serialize exact commands and stale alternative moves without duplicate events or notices', async (t) => {
  const f = await fixture(t),
    booked = await f.book(),
    second = await fixture(t, f.databasePath),
    moves = booked.appointments.slice(0, 2).map((a) => target(a));
  const input = f.command(await f.preview(booked.series.id, moves));
  const responses = await Promise.all([
    f.call(path(booked.series.id), f.admin, 'POST', input),
    second.call(path(booked.series.id), f.admin, 'POST', { ...input, moves: [...moves].reverse() }),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 201]);
  assert.deepEqual(responses[0].data.event, responses[1].data.event);
  assert.equal(count(f.db, 'appointmentSeriesReschedules'), 1);
  assert.equal(
    f.db
      .prepare(
        "SELECT COUNT(*) n FROM activity WHERE eventKey LIKE 'appointment-series-rescheduled:%'",
      )
      .get()!.n,
    2,
  );
  const current = get<Appointment>(f.db, 'appointments', booked.appointments[2].id)!;
  const a = f.command(
    await f.preview(booked.series.id, [target(current, addDays(current.date, 1), '10:00')]),
  );
  const b = f.command(
    await f.preview(booked.series.id, [target(current, addDays(current.date, 1), '11:00')]),
  );
  const racing = await Promise.all([
    f.call(path(booked.series.id), f.admin, 'POST', a),
    second.call(path(booked.series.id), second.admin, 'POST', b),
  ]);
  assert.deepEqual(racing.map((r) => r.status).sort(), [201, 409]);
  assert.equal(count(f.db, 'appointmentSeriesReschedules'), 2);
});

test('history is bounded before decode, immutable across restart and private to staff while patient records reflect only ordinary current appointments', async (t) => {
  const f = await fixture(t),
    booked = await f.book(),
    patient = await f.login('patient'),
    first = booked.appointments[0];
  const unchangedTables = [
    'procedures',
    'procedureScheduleEvents',
    'invoices',
    'payments',
    'waitlistEvents',
  ];
  const before = Object.fromEntries(
    unchangedTables.map((table) => [
      table,
      f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ]),
  );
  const results = [];
  for (let index = 0; index < 12; index++)
    results.push(
      await f.move(booked.series.id, [
        target(
          get<Appointment>(f.db, 'appointments', first.id)!,
          first.date,
          index % 2 === 0 ? '10:00' : '11:00',
        ),
      ]),
    );
  assert.deepEqual(
    Object.fromEntries(
      unchangedTables.map((table) => [
        table,
        f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    ),
    before,
  );
  const prepare = f.db.prepare.bind(f.db);
  let maxRows = 0;
  f.db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (sql.startsWith('SELECT data FROM appointmentSeriesReschedules')) {
      assert.match(sql, /LIMIT \? OFFSET \?/);
      const all = statement.all.bind(statement);
      statement.all = ((...values: Parameters<typeof statement.all>) => {
        const rows = all(...values);
        maxRows = Math.max(maxRows, rows.length);
        return rows;
      }) as typeof statement.all;
    }
    return statement;
  }) as typeof f.db.prepare;
  try {
    const a = await f.call(`${path(booked.series.id)}?pageSize=10`, f.admin),
      b = await f.call(`${path(booked.series.id)}?pageSize=10&page=1000000`, f.admin);
    assert.deepEqual(
      [a.data.total, a.data.items.length, b.data.page, b.data.items.length, maxRows],
      [12, 10, 2, 2, 10],
    );
    assert.deepEqual(
      [...a.data.items, ...b.data.items],
      [...results.map((r) => r.event)].sort(
        (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
      ),
    );
  } finally {
    f.db.prepare = prepare;
  }
  assert.match(
    JSON.stringify(
      f.db
        .prepare(
          'EXPLAIN QUERY PLAN SELECT data FROM appointmentSeriesReschedules WHERE seriesId=? ORDER BY createdAt DESC,id DESC LIMIT ? OFFSET ?',
        )
        .all(booked.series.id, 10, 0),
    ),
    /appointment_series_reschedules_series_created/,
  );
  for (const url of [
    '/appointments',
    `/patients/${patientId}/care-summary`,
    '/activity',
    `/appointments/${first.id}/calendar`,
  ]) {
    const response = await f.call(url, patient);
    assert.equal(response.status, 200);
    const text = JSON.stringify(response.data);
    for (const secret of [
      privateReason,
      results[0].event.id,
      results[0].input.requestId,
      results[0].input.expectedRevision,
      booked.series.id,
      'PRIVATE_ORIGIN_NOTE',
    ])
      assert.ok(!text.includes(secret), url);
  }
  for (const sql of [
    'UPDATE appointmentSeriesReschedules SET data=data',
    'DELETE FROM appointmentSeriesReschedules',
    "DELETE FROM appointmentSeriesCommands WHERE operation='reschedule'",
  ])
    assert.throws(() => f.db.exec(sql), /immutable/);
  await f.close();
  const reopened = await fixture(t, f.databasePath),
    replay = await reopened.call(path(booked.series.id), reopened.admin, 'POST', results[0].input);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data.event, results[0].event);
  assert.equal(replay.data.detail.appointments[0].time, '11:00');
  assert.deepEqual(replay.data.detail.series, booked.series);
});
