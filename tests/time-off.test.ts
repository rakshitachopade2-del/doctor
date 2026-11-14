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
import type { ScheduleClosure } from '../shared/scheduling.ts';
import type { TimeOffValues, TimeOffContext, TimeOffMutation } from '../shared/time-off.ts';
type Client = { cookie: string; csrf: string; user: User };
const privateReason = 'PRIVATE_TIME_OFF_CHANGE_REASON';
const basePath = '/time-off';
async function fixture(t: TestContext, database?: string, fresh = false) {
  const directory = mkdtempSync(join(tmpdir(), 'derma-time-off-')),
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

  async function context(key: string, who = admin): Promise<TimeOffContext> {
    const r = await call(`${basePath}/${key}`, who);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  }
  const count = (table: string) => Number(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n);
  function state() {
    return {
      active: db.prepare('SELECT * FROM scheduleClosures ORDER BY id').all(),
      retained: db.prepare('SELECT * FROM scheduleClosureRecords ORDER BY id').all(),
      events: count('scheduleClosureChanges'),
      commands: count('scheduleClosureCommands'),
      audit: count('audit'),
      appointments: db.prepare('SELECT * FROM appointments ORDER BY id').all(),
    };
  }
  async function create(
    doctorId: string | null,
    overrides: Partial<TimeOffValues> = {},
    who = admin,
  ) {
    const body = {
      closure: {
        doctorId,
        startDate: addDays(clinicToday(), 40),
        endDate: addDays(clinicToday(), 40),
        startTime: '10:00',
        endTime: '11:00',
        reason: 'Synthetic operational leave',
        ...overrides,
      },
      requestId: randomUUID(),
    };
    const r = await call(basePath, who, 'POST', body);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return { body, value: r.data as TimeOffMutation };
  }
  async function edit(
    key: string,
    overrides: Partial<Omit<TimeOffValues, 'doctorId'>> = {},
    who = admin,
  ) {
    const source = await context(key, who),
      { id: _, doctorId: __, createdAt: ___, ...closure } = source.closure;
    const body = {
      closure: { ...closure, ...overrides },
      changeReason: privateReason,
      expectedRevision: source.revision,
      requestId: randomUUID(),
    };
    return { body, source };
  }
  async function cancel(key: string, who = admin) {
    const source = await context(key, who),
      body = {
        changeReason: privateReason,
        expectedRevision: source.revision,
        requestId: randomUUID(),
      };
    const r = await call(`${basePath}/${key}/cancel`, who, 'POST', body);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return { body, value: r.data as TimeOffMutation };
  }
  return {
    app,
    db,
    base,
    databasePath,
    call,
    login,
    account,
    admin,
    doctor,
    context,
    create,
    edit,
    cancel,
    state,
    close,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function saveEdit(
  f: Fixture,
  key: string,
  overrides: Partial<Omit<TimeOffValues, 'doctorId'>>,
  who = f.admin,
) {
  const pending = await f.edit(key, overrides, who),
    r = await f.call(`${basePath}/${key}/changes`, who, 'POST', pending.body);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return { ...pending, value: r.data as TimeOffMutation };
}
async function openSchedule(f: Fixture, doctorId: string) {
  const r = await f.call(`/schedules/${doctorId}`, f.admin, 'PUT', {
    durationMinutes: 30,
    windows: Array.from({ length: 7 }, (_, day) => ({
      day,
      start: '09:00',
      end: '18:00',
      mode: 'both',
    })),
  });
  assert.equal(r.status, 200);
}

test('reviewed lifecycle retains originals, preserves identity and publishes only active projection; replay returns original evidence with later context', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor(),
    created = await f.create(doctor.id),
    key = created.value.context.closure.id;
  assert.equal(created.value.change.before, null);
  assert.equal(created.value.change.action, 'created');
  assert.equal(created.value.change.changeReason, null);
  assert.deepEqual(created.value.receipt, {
    requestId: created.body.requestId,
    actorId: f.admin.user.id,
    operation: 'create',
    closureId: key,
    expectedRevision: null,
    changeId: created.value.change.id,
  });
  const edited = await saveEdit(f, key, { startTime: '11:00', endTime: '12:00' });
  assert.deepEqual(edited.value.change.before, {
    closure: created.value.context.closure,
    status: 'active',
  });
  assert.equal(edited.value.context.closure.createdAt, created.value.context.closure.createdAt);
  assert.equal(edited.value.context.closure.doctorId, doctor.id);
  assert.deepEqual(get(f.db, 'scheduleClosures', key), edited.value.context.closure);
  const cancelled = await f.cancel(key);
  assert.equal(cancelled.value.context.status, 'cancelled');
  assert.equal(get(f.db, 'scheduleClosures', key), undefined);
  assert.deepEqual(cancelled.value.change.after.closure, edited.value.context.closure);
  const before = f.state();
  for (const [path, body, original] of [
    [basePath, created.body, created.value],
    [`${basePath}/${key}/changes`, edited.body, edited.value],
    [`${basePath}/${key}/cancel`, cancelled.body, cancelled.value],
  ] as const) {
    const replay = await f.call(path, f.admin, 'POST', {
      ...body,
      requestId: body.requestId.toUpperCase(),
    });
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.data.change, original.change);
    assert.deepEqual(replay.data.receipt, original.receipt);
    assert.equal(replay.data.context.status, 'cancelled');
  }
  assert.deepEqual(f.state(), before);
  const terminal = await f.call(`${basePath}/${key}/cancel`, f.admin, 'POST', {
    ...cancelled.body,
    expectedRevision: cancelled.value.context.revision,
    requestId: randomUUID(),
  });
  assert.equal(terminal.status, 409);
  assert.match(terminal.data.error, /already been cancelled/);
});

test('overlapping closures are independent and partial hours repeat on each inclusive day; cancellation reopens only uncovered intervals', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor();
  await openSchedule(f, doctor.id);
  const startDate = addDays(clinicToday(), 45),
    endDate = addDays(startDate, 2),
    a = await f.create(doctor.id, { startDate, endDate, startTime: '10:00', endTime: '11:00' }),
    b = await f.create(null, { startDate, endDate, startTime: '10:30', endTime: '11:30' });
  const slots = async (date: string) =>
    (await f.call(`/slots?doctorId=${doctor.id}&date=${date}&mode=in-person`)).data as string[];
  for (const date of [startDate, addDays(startDate, 1), endDate]) {
    const values = await slots(date);
    assert.ok(values.includes('09:30'));
    assert.ok(!values.includes('10:00'));
    assert.ok(!values.includes('11:00'));
    assert.ok(values.includes('11:30'));
  }
  await f.cancel(a.value.context.closure.id);
  assert.ok((await slots(startDate)).includes('10:00'));
  assert.ok(!(await slots(startDate)).includes('10:30'));
  await f.cancel(b.value.context.closure.id);
  assert.ok((await slots(startDate)).includes('10:30'));
  const full = await f.create(null, { startDate, endDate, startTime: null, endTime: null });
  assert.deepEqual(await slots(startDate), []);
  await f.cancel(full.value.context.closure.id);
  assert.ok((await slots(startDate)).length > 0);
});

test('strict command schemas reject scope reassignment, malformed dates, mixed/overnight times, missing reasons and unknown fields; no-op edit400', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor(),
    created = await f.create(doctor.id),
    key = created.value.context.closure.id;
  for (const change of [
    { startDate: '2026-02-30' },
    { endDate: addDays(created.body.closure.startDate, -1) },
    { startTime: null },
    { startTime: '12:00', endTime: '10:00' },
    { startTime: '9:00' },
    { reason: '' },
    { reason: 'x'.repeat(301) },
    { extra: true },
  ])
    assert.equal(
      (
        await f.call(basePath, f.admin, 'POST', {
          closure: { ...created.body.closure, ...change },
          requestId: randomUUID(),
        })
      ).status,
      400,
    );
  const input = await f.edit(key);
  for (const extra of [
    { closure: { ...input.body.closure, doctorId: null } },
    { changeReason: '' },
    { changeReason: 'x'.repeat(1001) },
    { requestId: 'bad' },
    { expectedRevision: 'A'.repeat(64) },
    { unknown: true },
  ])
    assert.equal(
      (await f.call(`${basePath}/${key}/changes`, f.admin, 'POST', { ...input.body, ...extra }))
        .status,
      400,
    );
  assert.equal(
    (await f.call(`${basePath}/${key}/changes`, f.admin, 'POST', input.body)).status,
    400,
  );
  for (const query of [
    '?status=active',
    '?period=all',
    '?page=0',
    '?pageSize=100',
    '?page=1000001',
    '?filter=wrong',
  ])
    assert.equal((await f.call(`${basePath}${query}`, f.admin)).status, 400);
  for (const path of [`${basePath}/${key}?extra=x`, `${basePath}/${key}/history?extra=x`])
    assert.equal((await f.call(path, f.admin)).status, 400);
});

test('ABA edits advance revision, doctor renames do not; exact request collisions bind actor, operation, target and all normalized payload fields', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor(),
    created = await f.create(doctor.id),
    key = created.value.context.closure.id;
  const a = await saveEdit(f, key, { reason: 'A' });
  await saveEdit(f, key, { reason: 'B' });
  const back = await saveEdit(f, key, { reason: 'A' });
  assert.notEqual(a.value.context.revision, back.value.context.revision);
  const stale = await f.call(`${basePath}/${key}/changes`, f.admin, 'POST', {
    ...a.body,
    requestId: randomUUID(),
  });
  assert.equal(stale.status, 409);
  assert.match(stale.data.error, /^Time off changed/);
  f.db
    .prepare('UPDATE doctors SET data=? WHERE id=?')
    .run(JSON.stringify({ ...doctor, name: 'Current renamed clinician' }), doctor.id);
  assert.equal((await f.context(key)).revision, back.value.context.revision);
  const replay = await f.call(basePath, f.admin, 'POST', created.body);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.change.doctorName, doctor.name);
  assert.equal(replay.data.context.doctor.name, 'Current renamed clinician');
  const other = await f.create(doctor.id),
    secondAdmin = await f.account('admin');
  for (const [path, who, body] of [
    [basePath, secondAdmin, created.body],
    [
      basePath,
      f.admin,
      { ...created.body, closure: { ...created.body.closure, reason: 'Different' } },
    ],
    [`${basePath}/${other.value.context.closure.id}/changes`, f.admin, a.body],
    [
      `${basePath}/${key}/changes`,
      f.admin,
      { ...a.body, expectedRevision: back.value.context.revision },
    ],
    [
      `${basePath}/${key}/cancel`,
      f.admin,
      {
        changeReason: privateReason,
        expectedRevision: back.value.context.revision,
        requestId: a.body.requestId,
      },
    ],
  ] as const) {
    const r = await f.call(path, who, 'POST', body);
    assert.equal(r.status, 409);
    assert.match(r.data.error, /request ID.*different time-off operation/);
  }
});

test('create/edit retries survive date expiry and cancellation is permitted for past active records', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor(),
    created = await f.create(doctor.id, { startDate: clinicToday(), endDate: clinicToday() }),
    key = created.value.context.closure.id;
  const edited = await saveEdit(f, key, { reason: 'Revised same-day block' });
  const NativeDate = Date,
    future = Date.parse(`${addDays(clinicToday(), 2)}T12:00:00Z`);
  const originalSession = f.db
    .prepare('SELECT expiresAt FROM sessions WHERE userId=?')
    .get(f.admin.user.id)!.expiresAt;
  f.db
    .prepare('UPDATE sessions SET expiresAt=? WHERE userId=?')
    .run(future + 86400000, f.admin.user.id);
  class FutureDate extends NativeDate {
    constructor(value?: string | number) {
      super(value === undefined ? future : value);
    }
    static now() {
      return future;
    }
  }
  try {
    globalThis.Date = FutureDate as DateConstructor;
    for (const [path, body] of [
      [basePath, created.body],
      [`${basePath}/${key}/changes`, edited.body],
    ] as const)
      assert.equal((await f.call(path, f.admin, 'POST', body)).status, 200);
    assert.equal(
      (await f.call(basePath, f.admin, 'POST', { ...created.body, requestId: randomUUID() }))
        .status,
      400,
    );
    const cancellation = await f.cancel(key);
    assert.equal(cancellation.value.context.status, 'cancelled');
  } finally {
    globalThis.Date = NativeDate;
    f.db
      .prepare('UPDATE sessions SET expiresAt=? WHERE userId=?')
      .run(originalSession, f.admin.user.id);
  }
});

test('legacy creation/removal shapes remain compatible while retaining truthful evidence and no private reason/UUID fabrication', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor();
  const created = await f.call('/schedule-closures', f.admin, 'POST', {
    doctorId: doctor.id,
    startDate: addDays(clinicToday(), 40),
    endDate: addDays(clinicToday(), 40),
    startTime: null,
    endTime: null,
    reason: 'Legacy original',
    ignored: true,
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.ignored, undefined);
  assert.equal(created.data.context, undefined);
  const before = await f.context(created.data.id);
  assert.equal(before.latestChange?.source, 'legacy');
  assert.equal(before.latestChange?.changeReason, null);
  assert.deepEqual(
    (await f.call(`/schedule-closures/${created.data.id}`, f.admin, 'DELETE', {})).data,
    { ok: true },
  );
  assert.equal(
    (await f.call(`/schedule-closures/${created.data.id}`, f.admin, 'DELETE', {})).status,
    404,
  );
  const after = await f.context(created.data.id);
  assert.equal(after.status, 'cancelled');
  assert.deepEqual(after.closure, created.data);
  assert.equal(after.latestChange?.source, 'legacy');
  assert.equal(after.latestChange?.changeReason, null);
  assert.equal(f.state().commands, 0);
  assert.equal(f.state().events, 2);
  assert.equal(
    (await f.call('/scheduling', f.admin)).data.closures.some(
      (c: ScheduleClosure) => c.id === created.data.id,
    ),
    false,
  );
});

test('full saved intervals, custom durations and today-active visits protect create/edit atomically, with no appointment changes', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor();
  await openSchedule(f, doctor.id);
  const date = addDays(clinicToday(), 45);
  const booked = await f.call('/visit-duration/bookings', f.admin, 'POST', {
    patientId: 'patient-ananya',
    doctorId: doctor.id,
    date,
    time: '09:00',
    mode: 'online',
    reason: 'Synthetic visit',
    durationMinutes: 90,
    requestId: randomUUID(),
  });
  assert.equal(booked.status, 201, JSON.stringify(booked.data));
  const created = await f.create(doctor.id, {
      startDate: date,
      endDate: date,
      startTime: '10:30',
      endTime: '11:00',
    }),
    edit = await f.edit(created.value.context.closure.id, { startTime: '10:15' }),
    before = f.state();
  const blocked = await f.call(
    `${basePath}/${created.value.context.closure.id}/changes`,
    f.admin,
    'POST',
    edit.body,
  );
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error, /affect 1 booked appointment/);
  assert.deepEqual(f.state(), before);
  const invalid = await f.call(basePath, f.admin, 'POST', {
    ...created.body,
    closure: { ...created.body.closure, startTime: '10:00' },
    requestId: randomUUID(),
  });
  assert.equal(invalid.status, 409);
  assert.deepEqual(get(f.db, 'appointments', booked.data.appointment.id), booked.data.appointment);
  await f.cancel(created.value.context.closure.id);
  assert.deepEqual(get(f.db, 'appointments', booked.data.appointment.id), booked.data.appointment);
});

function insertAppointment(
  db: DB,
  doctor: Doctor,
  overrides: Partial<Appointment> = {},
): Appointment {
  const value: Appointment = {
    id: randomUUID(),
    patientId: 'patient-ananya',
    patientName: 'Synthetic patient',
    doctorId: doctor.id,
    doctorName: doctor.name,
    date: addDays(clinicToday(), 40),
    time: '10:00',
    mode: 'in-person',
    reason: 'Synthetic appointment',
    status: 'scheduled',
    fee: 500,
    durationMinutes: 30,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
  db.prepare(
    'INSERT INTO appointments(id,patientId,doctorId,date,time,status,data) VALUES(?,?,?,?,?,?,?)',
  ).run(
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

test('operational staff lists are safe; private context/history and mutations remain admin-all/doctor-own, with patient and anonymous denial', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor(),
    own = await f.account('doctor', { doctorId: doctor.id }),
    other = await f.login('doctor'),
    reception = await f.login('reception'),
    patient = await f.login('patient');
  const saved = await f.create(doctor.id, {}, own),
    key = saved.value.context.closure.id;
  await saveEdit(f, key, { reason: 'Revised operational block' }, own);
  const clinic = await f.create(null);
  for (const who of [f.admin, own, other, reception]) {
    const result = await f.call(`${basePath}?doctorId=${doctor.id}`, who);
    assert.equal(result.status, 200);
    assert.match(result.headers.get('cache-control')!, /no-store/);
    assert.match(result.headers.get('x-robots-tag')!, /noindex/);
    assert.deepEqual(
      new Set(result.data.items.map((row: { closure: ScheduleClosure }) => row.closure.id)),
      new Set([key, clinic.value.context.closure.id]),
    );
    for (const secret of [
      privateReason,
      saved.body.requestId,
      saved.value.change.id,
      'expectedRevision',
      'createdById',
      'latestChange',
    ])
      assert.equal(JSON.stringify(result.data).includes(secret), false, secret);
  }
  for (const path of [basePath, `${basePath}/${key}`, `${basePath}/${key}/history`])
    for (const who of [undefined, patient])
      assert.equal((await f.call(path, who)).status, who ? 403 : 401);
  for (const path of [`${basePath}/${key}`, `${basePath}/${key}/history`]) {
    for (const who of [other, reception]) assert.equal((await f.call(path, who)).status, 403);
    for (const who of [f.admin, own]) assert.equal((await f.call(path, who)).status, 200);
  }
  for (const who of [other, reception, patient])
    assert.equal((await f.call(basePath, who, 'POST', saved.body)).status, 403);
  assert.equal((await f.call(`${basePath}/${clinic.value.context.closure.id}`, own)).status, 403);
  for (const path of ['/scheduling', `/schedules/${doctor.id}`]) {
    const result = await f.call(path, reception);
    assert.equal(result.status, 200);
    assert.equal(JSON.stringify(result.data).includes(privateReason), false);
  }
  const slots = await f.call(`/slots?doctorId=${doctor.id}&date=${saved.body.closure.startDate}`);
  assert.equal(slots.status, 200);
  assert.ok(slots.data.every((v: unknown) => typeof v === 'string'));
});

test('current account/session security is rechecked inside every read, write, replay and legacy transaction', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor(),
    saved = await f.create(doctor.id),
    key = saved.value.context.closure.id,
    edit = await f.edit(key, { reason: 'Next source' });
  const routes: [string, string, unknown?][] = [
    [basePath, 'GET'],
    [`${basePath}/${key}`, 'GET'],
    [`${basePath}/${key}/history`, 'GET'],
    [basePath, 'POST', saved.body],
    [basePath, 'POST', { ...saved.body, requestId: randomUUID() }],
    [`${basePath}/${key}/changes`, 'POST', edit.body],
    [
      `${basePath}/${key}/cancel`,
      'POST',
      {
        changeReason: privateReason,
        expectedRevision: edit.source.revision,
        requestId: randomUUID(),
      },
    ],
    ['/schedule-closures', 'POST', saved.body.closure],
    [`/schedule-closures/${key}`, 'DELETE', {}],
  ];
  const external = openDatabase(f.databasePath),
    exec = f.db.exec.bind(f.db),
    account = external.prepare('SELECT role,data FROM users WHERE id=?').get(f.admin.user.id)!,
    session = external.prepare('SELECT * FROM sessions WHERE userId=?').get(f.admin.user.id)!,
    columns = Object.keys(session);
  try {
    for (const change of ['revoked', 'expired', 'csrf', 'inactive', 'temporary', 'role', 'mfa'])
      for (const [path, method, body] of routes) {
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
                  "UPDATE users SET role='patient',data=json_set(data,'$.role','patient') WHERE id=?",
                )
                .run(f.admin.user.id);
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
          result = await f.call(path, f.admin, method, body);
        assert.equal(injected, true);
        assert.equal(
          result.status,
          ['role', 'temporary'].includes(change) ? 403 : 401,
          `${change}/${path}`,
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

test('changed doctor ownership is authoritative under lock for scoped reads, reviewed commands/replays and legacy removal', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor(),
    other = f.doctor(),
    own = await f.account('doctor', { doctorId: doctor.id }),
    created = await f.create(doctor.id, {}, own),
    key = created.value.context.closure.id,
    edit = await f.edit(key, { reason: 'Changed' }, own),
    external = openDatabase(f.databasePath),
    exec = f.db.exec.bind(f.db),
    user = external.prepare('SELECT data FROM users WHERE id=?').get(own.user.id)!.data;
  try {
    for (const [path, method, body] of [
      [`${basePath}/${key}`, 'GET'],
      [`${basePath}/${key}/history`, 'GET'],
      [basePath, 'POST', created.body],
      [`${basePath}/${key}/changes`, 'POST', edit.body],
      [
        `${basePath}/${key}/cancel`,
        'POST',
        {
          expectedRevision: edit.source.revision,
          changeReason: privateReason,
          requestId: randomUUID(),
        },
      ],
      ['/schedule-closures', 'POST', created.body.closure],
      [`/schedule-closures/${key}`, 'DELETE', {}],
    ] as const) {
      let injected = false;
      f.db.exec = ((sql: string) => {
        if (sql === 'BEGIN IMMEDIATE' && !injected) {
          injected = true;
          external
            .prepare("UPDATE users SET data=json_set(data,'$.doctorId',?) WHERE id=?")
            .run(other.id, own.user.id);
        }
        return exec(sql);
      }) as typeof f.db.exec;
      const before = f.state(),
        r = await f.call(path, own, method, body);
      assert.equal(injected, true);
      assert.equal(r.status, 403);
      assert.deepEqual(f.state(), before);
      f.db.exec = exec;
      external.prepare('UPDATE users SET data=? WHERE id=?').run(user, own.user.id);
    }
  } finally {
    f.db.exec = exec;
    external.close();
  }
});

test('projection, retained record, event, command, audit and response failures roll back all reviewed mutations; legacy writes and reads remain atomic', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor(),
    created = await f.create(doctor.id),
    key = created.value.context.closure.id,
    pending = await f.edit(key, { reason: 'Next details' }),
    cancel = {
      expectedRevision: pending.source.revision,
      changeReason: privateReason,
      requestId: randomUUID(),
    };
  for (const operation of ['create', 'edit', 'cancel', 'legacy-create', 'legacy-cancel'])
    for (const point of [
      'active',
      'record',
      'event',
      'audit',
      ...(operation.startsWith('legacy') ? [] : ['command', 'response']),
    ]) {
      const body =
        operation === 'create'
          ? { ...created.body, requestId: randomUUID() }
          : operation === 'edit'
            ? pending.body
            : operation === 'cancel'
              ? cancel
              : operation === 'legacy-create'
                ? created.body.closure
                : {};
      const path =
        operation === 'create'
          ? basePath
          : operation === 'edit'
            ? `${basePath}/${key}/changes`
            : operation === 'cancel'
              ? `${basePath}/${key}/cancel`
              : operation === 'legacy-create'
                ? '/schedule-closures'
                : `/schedule-closures/${key}`;
      const table =
        point === 'active'
          ? 'scheduleClosures'
          : point === 'record'
            ? 'scheduleClosureRecords'
            : point === 'event'
              ? 'scheduleClosureChanges'
              : point === 'command'
                ? 'scheduleClosureCommands'
                : 'audit';
      const action =
        point === 'active'
          ? operation.includes('cancel')
            ? 'DELETE'
            : operation === 'edit'
              ? 'UPDATE'
              : 'INSERT'
          : point === 'record' && operation !== 'create' && operation !== 'legacy-create'
            ? 'UPDATE'
            : 'INSERT';
      const prepare = f.db.prepare.bind(f.db);
      let fired = false;
      if (point === 'response') {
        let reads = 0;
        f.db.prepare = ((sql: string) => {
          const statement = prepare(sql);
          if (
            sql ===
            'SELECT data FROM scheduleClosureChanges WHERE closureId=? ORDER BY rowid DESC LIMIT 1'
          ) {
            const getRow = statement.get.bind(statement);
            statement.get = ((...params: Parameters<typeof statement.get>) => {
              reads++;
              if (reads === (operation === 'create' ? 1 : 2)) {
                fired = true;
                throw new Error('Synthetic time-off response failure');
              }
              return getRow(...params);
            }) as typeof statement.get;
          }
          return statement;
        }) as typeof f.db.prepare;
      } else
        f.db.exec(
          `CREATE TRIGGER time_off_failure BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'Synthetic time-off failure'); END;`,
        );
      const before = f.state();
      try {
        const r = await f.call(
          path,
          f.admin,
          operation === 'legacy-cancel' ? 'DELETE' : 'POST',
          body,
        );
        assert.equal(r.status, 500, `${operation}/${point}`);
        if (point === 'response') assert.equal(fired, true);
        assert.deepEqual(f.state(), before);
        assert.equal(r.data.context, undefined);
      } finally {
        f.db.prepare = prepare;
        if (point !== 'response') f.db.exec('DROP TRIGGER time_off_failure');
      }
    }
  f.db.exec(
    "CREATE TRIGGER time_off_read_failure BEFORE INSERT ON audit WHEN json_extract(NEW.data,'$.action') LIKE 'viewed time-off%' BEGIN SELECT RAISE(ABORT,'Synthetic time-off read failure'); END;",
  );
  const before = f.state();
  for (const path of [basePath, `${basePath}/${key}`, `${basePath}/${key}/history`]) {
    const r = await f.call(path, f.admin);
    assert.equal(r.status, 500);
    assert.equal(r.data.items, undefined);
    assert.equal(r.data.closure, undefined);
  }
  assert.deepEqual(f.state(), before);
});

test('future and current-date scheduled/active full intervals are protected without broadening historical-active policy', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor(),
    today = clinicToday(),
    realNow = Date.now,
    noon = Date.parse(`${today}T12:00:00+05:30`);
  const p = get<Record<string, unknown>>(f.db, 'patients', 'patient-ananya')!,
    patientId = randomUUID();
  f.db
    .prepare('INSERT INTO patients(id,data) VALUES(?,?)')
    .run(patientId, JSON.stringify({ ...p, id: patientId }));
  const ongoing = insertAppointment(f.db, doctor, {
      patientId,
      date: today,
      time: '11:30',
      durationMinutes: 90,
      durationPolicy: 'custom',
    }),
    checked = insertAppointment(f.db, doctor, {
      patientId,
      date: today,
      time: '09:00',
      status: 'checked-in',
    }),
    consult = insertAppointment(f.db, doctor, {
      patientId,
      date: today,
      time: '10:00',
      status: 'in-consultation',
    });
  insertAppointment(f.db, doctor, {
    patientId,
    date: addDays(today, -1),
    time: '09:00',
    status: 'in-consultation',
  });
  insertAppointment(f.db, doctor, {
    patientId,
    date: addDays(today, 2),
    time: '09:00',
    status: 'completed',
  });
  insertAppointment(f.db, doctor, {
    patientId,
    date: addDays(today, 3),
    time: '09:00',
    status: 'cancelled',
  });
  insertAppointment(f.db, doctor, {
    patientId,
    date: addDays(today, 4),
    time: '09:00',
    status: 'no-show',
  });
  const body = {
    closure: {
      doctorId: doctor.id,
      startDate: addDays(today, -2),
      endDate: addDays(today, 5),
      startTime: null,
      endTime: null,
      reason: 'Operational all-day closure',
    },
    requestId: randomUUID(),
  };
  try {
    Date.now = () => noon;
    const r = await f.call(basePath, f.admin, 'POST', body);
    assert.equal(r.status, 409);
    assert.match(r.data.error, /affect 3 booked appointment/);
    for (const value of [ongoing, checked, consult])
      f.db
        .prepare("UPDATE appointments SET status='completed',data=? WHERE id=?")
        .run(JSON.stringify({ ...value, status: 'completed' }), value.id);
    assert.equal((await f.call(basePath, f.admin, 'POST', body)).status, 201);
  } finally {
    Date.now = realNow;
  }
});

test('a new booking committed before the mutation lock blocks the entire edit; original exact replay remains available', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor(),
    created = await f.create(doctor.id, { startTime: '15:00', endTime: '16:00' }),
    key = created.value.context.closure.id,
    edit = await f.edit(key, { startTime: '10:00', endTime: '11:00' }),
    external = openDatabase(f.databasePath),
    exec = f.db.exec.bind(f.db);
  let injected = false;
  f.db.exec = ((sql: string) => {
    if (sql === 'BEGIN IMMEDIATE' && !injected) {
      injected = true;
      insertAppointment(external, doctor);
    }
    return exec(sql);
  }) as typeof f.db.exec;
  const before = f.state();
  try {
    const r = await f.call(`${basePath}/${key}/changes`, f.admin, 'POST', edit.body);
    assert.equal(injected, true);
    assert.equal(r.status, 409);
    assert.match(r.data.error, /affect 1 booked appointment/);
    const after = f.state();
    assert.deepEqual({ ...after, appointments: [] }, { ...before, appointments: [] });
  } finally {
    f.db.exec = exec;
    external.close();
  }
  assert.equal((await f.call(basePath, f.admin, 'POST', created.body)).status, 200);
});

test('active closure edits and cancellation invalidate series previews and public slots without altering existing series origins', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor();
  await openSchedule(f, doctor.id);
  const input = {
    patientId: 'patient-ananya',
    doctorId: doctor.id,
    mode: 'in-person',
    reason: 'Synthetic two-visit series',
    firstDate: addDays(clinicToday(), 50),
    time: '09:00',
    count: 2,
    intervalWeeks: 1,
    durationPolicy: 'schedule',
  };
  const created = await f.create(doctor.id, {
      startDate: input.firstDate,
      endDate: input.firstDate,
      startTime: '15:00',
      endTime: '16:00',
    }),
    key = created.value.context.closure.id;
  const source = await f.call('/appointment-series/preview', f.admin, 'POST', input);
  assert.equal(source.status, 200);
  assert.equal(source.data.canBook, true);
  const edited = await saveEdit(f, key, { startTime: '09:00', endTime: '10:00' });
  const command = {
    input,
    expectedRevision: source.data.revision,
    patientConfirmed: true,
    requestId: randomUUID(),
  };
  const stale = await f.call('/appointment-series', f.admin, 'POST', command);
  assert.equal(stale.status, 409);
  assert.equal(
    (await f.call(`/slots?doctorId=${doctor.id}&date=${input.firstDate}`)).data.includes('09:00'),
    false,
  );
  const blocked = await f.call('/appointment-series/preview', f.admin, 'POST', input);
  assert.equal(blocked.data.canBook, false);
  assert.notEqual(blocked.data.revision, source.data.revision);
  await f.cancel(key);
  const clear = await f.call('/appointment-series/preview', f.admin, 'POST', input);
  assert.equal(clear.data.canBook, true);
  assert.notEqual(clear.data.revision, blocked.data.revision);
  assert.equal(
    (await f.call(`/slots?doctorId=${doctor.id}&date=${input.firstDate}`)).data.includes('09:00'),
    true,
  );
  const booked = await f.call('/appointment-series', f.admin, 'POST', {
    ...command,
    expectedRevision: clear.data.revision,
    requestId: randomUUID(),
  });
  assert.equal(booked.status, 201, JSON.stringify(booked.data));
  const replay = await f.call(`${basePath}/${key}/changes`, f.admin, 'POST', edited.body);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.context.status, 'cancelled');
  assert.deepEqual(replay.data.change, edited.value.change);
});

test('independent application connections serialize edits/cancellation and exact creates without duplicate events or lost source state', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor(),
    created = await f.create(doctor.id),
    key = created.value.context.closure.id,
    g = await fixture(t, f.databasePath);
  const pending = await f.edit(key, { reason: 'Concurrent edit' }),
    cancel = {
      expectedRevision: pending.source.revision,
      changeReason: privateReason,
      requestId: randomUUID(),
    };
  const responses = await Promise.all([
    f.call(`${basePath}/${key}/changes`, f.admin, 'POST', pending.body),
    g.call(`${basePath}/${key}/cancel`, g.admin, 'POST', cancel),
  ]);
  assert.deepEqual(responses.map((v) => v.status).sort(), [201, 409]);
  assert.equal(f.state().events, 2);
  assert.equal(f.state().commands, 2);
  const body = { ...created.body, requestId: randomUUID() },
    duplicates = await Promise.all([
      f.call(basePath, f.admin, 'POST', body),
      g.call(basePath, g.admin, 'POST', body),
    ]);
  assert.deepEqual(duplicates.map((v) => v.status).sort(), [200, 201]);
  assert.deepEqual(duplicates[0].data.change, duplicates[1].data.change);
  assert.deepEqual(duplicates[0].data.receipt, duplicates[1].data.receipt);
  assert.equal(f.state().events, 3);
  assert.equal(f.state().commands, 3);
});

test('legacy active rows migrate without rewriting bytes or inventing history, and retained evidence/replays survive repeated startup', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'time-off-migration-')),
    path = join(directory, 'clinic.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const initial = createApp({ databasePath: path, demoMode: true, production: false }),
    db = initial.locals.db as DB;
  const value: ScheduleClosure = {
    id: randomUUID(),
    doctorId: null,
    startDate: addDays(clinicToday(), 30),
    endDate: addDays(clinicToday(), 31),
    startTime: null,
    endTime: null,
    reason: 'Legacy original bytes',
    createdAt: '2020-01-02T03:04:05.000Z',
  };
  const raw = JSON.stringify({ ...value, unknownLegacySentinel: 'NOT_PUBLIC' }, null, 2);
  db.prepare(
    'INSERT INTO scheduleClosures(id,doctorId,startDate,endDate,data) VALUES(?,?,?,?,?)',
  ).run(value.id, null, value.startDate, value.endDate, raw);
  initial.locals.close();
  const f = await fixture(t, path),
    first = await f.context(value.id);
  assert.deepEqual(first.closure, value);
  assert.equal(first.latestChange, null);
  assert.equal(f.state().events, 0);
  for (const table of ['scheduleClosures', 'scheduleClosureRecords'])
    assert.equal(f.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(value.id)!.data, raw);
  const second = await fixture(t, path);
  assert.equal((await second.context(value.id)).revision, first.revision);
  assert.equal(second.state().events, 0);
  const edit = await saveEdit(f, value.id, { reason: 'Reviewed imported leave' });
  assert.deepEqual(edit.value.change.before, { closure: value, status: 'active' });
  assert.equal(edit.value.change.action, 'edited');
  const cancelled = await f.cancel(value.id);
  for (const [table, column, key] of [
    ['scheduleClosureChanges', 'id', edit.value.change.id],
    ['scheduleClosureCommands', 'requestId', edit.body.requestId],
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
  await second.close();
  const reopened = await fixture(t, path),
    current = await reopened.context(value.id);
  assert.equal(current.revision, cancelled.value.context.revision);
  assert.equal(current.status, 'cancelled');
  assert.equal(
    reopened.db.prepare('SELECT id FROM scheduleClosures WHERE id=?').get(value.id),
    undefined,
  );
  const replay = await reopened.call(
    `${basePath}/${value.id}/changes`,
    reopened.admin,
    'POST',
    edit.body,
  );
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data.change, edit.value.change);
  assert.deepEqual(replay.data.receipt, edit.value.receipt);
  assert.equal(replay.data.context.status, 'cancelled');
});

test('list filters and history page before decoding, use deterministic indexes, clamp pages and retain a coherent SQLite snapshot', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor(),
    other = f.doctor();
  const first = await f.create(doctor.id),
    key = first.value.context.closure.id;
  for (let i = 1; i < 31; i++) await saveEdit(f, key, { reason: `Revision ${i}` });
  for (let i = 0; i < 31; i++)
    await f.create(i % 2 ? doctor.id : other.id, {
      startDate: addDays(clinicToday(), i + 1),
      endDate: addDays(clinicToday(), i + 1),
    });
  const clinic = await f.create(null);
  await f.cancel(clinic.value.context.closure.id);
  const prepare = f.db.prepare.bind(f.db),
    decoded: number[] = [];
  f.db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (
      (sql.startsWith('SELECT status,data FROM scheduleClosureRecords') ||
        sql.startsWith('SELECT data FROM scheduleClosureChanges')) &&
      sql.includes('OFFSET')
    ) {
      assert.ok(sql.includes('LIMIT'));
      const all = statement.all.bind(statement);
      statement.all = ((...params: Parameters<typeof statement.all>) => {
        const rows = all(...params);
        decoded.push(rows.length);
        return rows;
      }) as typeof statement.all;
    }
    return statement;
  }) as typeof f.db.prepare;
  try {
    const list = await f.call(`${basePath}?filter=all`, f.admin);
    assert.equal(list.data.total, 33);
    assert.equal(list.data.items.length, 25);
    const end = await f.call(`${basePath}?filter=all&page=1000000&pageSize=10`, f.admin);
    assert.equal(end.data.page, 4);
    assert.equal(end.data.items.length, 3);
    const history = await f.call(`${basePath}/${key}/history`, f.admin);
    assert.equal(history.data.total, 31);
    assert.equal(history.data.items.length, 25);
    const last = await f.call(`${basePath}/${key}/history?page=1000000&pageSize=10`, f.admin);
    assert.equal(last.data.page, 4);
    assert.equal(last.data.items.length, 1);
    assert.deepEqual(decoded, [25, 3, 25, 1]);
    const expected = prepare(
      'SELECT id FROM scheduleClosureChanges WHERE closureId=? ORDER BY createdAt DESC,id DESC LIMIT 25',
    )
      .all(key)
      .map((row) => row.id);
    assert.deepEqual(
      history.data.items.map((row: { id: string }) => row.id),
      expected,
    );
    for (const [sql, params, index] of [
      [
        'SELECT data FROM scheduleClosureChanges WHERE closureId=? ORDER BY rowid DESC LIMIT 1',
        [key],
        'time_off_change_head',
      ],
      [
        'SELECT data FROM scheduleClosureChanges WHERE closureId=? ORDER BY createdAt DESC,id DESC LIMIT ? OFFSET ?',
        [key, 25, 0],
        'time_off_change_history',
      ],
      [
        "SELECT status,data FROM scheduleClosureRecords WHERE status='active' AND endDate>=? ORDER BY startDate ASC,id ASC LIMIT ? OFFSET ?",
        [clinicToday(), 25, 0],
        'time_off_status_date',
      ],
    ] as const) {
      const plan = JSON.stringify(prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params));
      assert.match(plan, new RegExp(index));
      assert.doesNotMatch(plan, /TEMP B-TREE/);
    }
  } finally {
    f.db.prepare = prepare;
  }
  const own = await f.call(`${basePath}?doctorId=${doctor.id}&filter=all`, f.admin);
  assert.equal(own.data.total, 17);
  const cancelled = await f.call(`${basePath}?filter=cancelled`, f.admin);
  assert.equal(cancelled.data.total, 1);
  assert.equal(cancelled.data.items[0].closure.id, clinic.value.context.closure.id);
  assert.equal((await f.call(`${basePath}?filter=past`, f.admin)).data.total, 0);
  const external = openDatabase(f.databasePath);
  external.exec('PRAGMA busy_timeout=0');
  let checked = 0;
  f.db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (sql.startsWith('SELECT COUNT(*) n FROM scheduleClosure')) {
      const getRow = statement.get.bind(statement);
      statement.get = ((...params: Parameters<typeof statement.get>) => {
        const row = getRow(...params);
        assert.throws(() => external.exec('BEGIN IMMEDIATE'), /locked/);
        checked++;
        return row;
      }) as typeof statement.get;
    }
    return statement;
  }) as typeof f.db.prepare;
  try {
    assert.equal((await f.call(basePath, f.admin)).status, 200);
    assert.equal((await f.call(`${basePath}/${key}/history`, f.admin)).status, 200);
    assert.equal(checked, 2);
  } finally {
    f.db.prepare = prepare;
    external.close();
  }
});
