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
import type { DoctorSchedule } from '../shared/scheduling.ts';
import type {
  WeeklyAvailabilityContext,
  WeeklyAvailabilityInput,
  WeeklyAvailabilityMutation,
  WeeklyAvailabilityValues,
} from '../shared/weekly-availability.ts';

type Client = { cookie: string; csrf: string; user: User };
const reason = 'PRIVATE_WEEKLY_AVAILABILITY_REASON';
const basePath = (doctorId: string) => `/schedules/${doctorId}/availability`;
const values = (schedule: DoctorSchedule): WeeklyAvailabilityValues => ({
  durationMinutes: schedule.durationMinutes,
  windows: schedule.windows,
});
const allDays: WeeklyAvailabilityValues = {
  durationMinutes: 30,
  windows: Array.from({ length: 7 }, (_, day) => ({
    day,
    start: '09:00',
    end: '18:00',
    mode: 'both',
  })),
};
async function fixture(t: TestContext, database?: string, fresh = false) {
  const directory = mkdtempSync(join(tmpdir(), 'derma-weekly-availability-')),
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
  async function context(doctorId: string, who = admin): Promise<WeeklyAvailabilityContext> {
    const r = await call(basePath(doctorId), who);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  }
  async function command(
    doctorId: string,
    desired = allDays,
    who = admin,
  ): Promise<WeeklyAvailabilityInput> {
    const source = await context(doctorId, who);
    return {
      schedule: desired,
      reason,
      expectedRevision: source.revision,
      requestId: randomUUID(),
    };
  }
  async function save(doctorId: string, desired = allDays, who = admin) {
    const body = await command(doctorId, desired, who),
      r = await call(basePath(doctorId), who, 'POST', body);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return { body, value: r.data as WeeklyAvailabilityMutation };
  }
  const count = (table: string) => Number(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n);
  function state() {
    return {
      schedules: db.prepare('SELECT id,data FROM doctorSchedules ORDER BY id').all(),
      changes: count('weeklyAvailabilityChanges'),
      commands: count('weeklyAvailabilityCommands'),
      audit: count('audit'),
      appointments: db.prepare('SELECT * FROM appointments ORDER BY id').all(),
    };
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
    command,
    save,
    state,
    close,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const dayOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
function appointment(f: Fixture, doctorId: string, fields: Partial<Appointment> = {}): Appointment {
  const value: Appointment = {
    id: randomUUID(),
    patientId: 'patient-ananya',
    patientName: 'Original patient label',
    doctorId,
    doctorName: 'Original clinician label',
    date: addDays(clinicToday(), 40),
    time: '09:00',
    mode: 'in-person',
    reason: 'Original shared booking reason',
    status: 'scheduled',
    fee: 100,
    durationMinutes: 30,
    createdAt: new Date().toISOString(),
    ...fields,
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

test('fresh inherited and existing explicit schedules have truthful baselines and first explicit default confirmation is a real event', async (t) => {
  const f = await fixture(t, undefined, true),
    doctor = f.doctor(),
    source = await f.context(doctor.id);
  assert.equal(source.source, 'inherited');
  assert.equal(source.latestChange, null);
  assert.equal(source.schedule.updatedAt, '');
  assert.equal(source.schedule.durationMinutes, 30);
  assert.deepEqual(
    source.schedule.windows.map((w) => w.day),
    [1, 2, 3, 4, 5, 6],
  );
  const saved = await f.save(doctor.id, values(source.schedule));
  assert.equal(saved.value.change.before.source, 'inherited');
  assert.equal(saved.value.change.after.source, 'explicit');
  assert.equal(saved.value.context.source, 'explicit');
  assert.notEqual(saved.value.context.revision, source.revision);
  assert.equal(saved.value.change.source, 'reviewed');
  assert.equal(saved.value.change.createdByName, f.admin.user.name);
  assert.equal(saved.value.change.reason, reason);
  assert.deepEqual(saved.value.receipt, {
    requestId: saved.body.requestId,
    actorId: f.admin.user.id,
    doctorId: doctor.id,
    expectedRevision: source.revision,
    changeId: saved.value.change.id,
  });
  const legacyDoctor = f.doctor(),
    older: DoctorSchedule = {
      doctorId: legacyDoctor.id,
      ...allDays,
      updatedAt: '2025-01-01T00:00:00.000Z',
    };
  f.db
    .prepare('INSERT INTO doctorSchedules(id,data) VALUES (?,?)')
    .run(legacyDoctor.id, JSON.stringify(older));
  const legacy = await f.context(legacyDoctor.id);
  assert.equal(legacy.source, 'explicit');
  assert.equal(legacy.latestChange, null);
  assert.deepEqual(legacy.schedule, older);
  assert.equal((await f.call(`${basePath(legacyDoctor.id)}/history`, f.admin)).data.total, 0);
});

test('per-doctor revisions are independent, canonical window order is stable, ABA changes cannot reuse an older revision', async (t) => {
  const f = await fixture(t),
    a = f.doctor(),
    b = f.doctor(),
    initialA = await f.context(a.id),
    initialB = await f.context(b.id);
  const first = await f.save(a.id, { ...allDays, windows: [...allDays.windows].reverse() });
  assert.deepEqual(first.value.context.schedule.windows, allDays.windows);
  assert.equal((await f.context(b.id)).revision, initialB.revision);
  const second = await f.save(a.id, { ...allDays, durationMinutes: 20 });
  const third = await f.save(a.id, allDays);
  assert.notEqual(first.value.context.revision, third.value.context.revision);
  assert.notEqual(initialA.revision, third.value.context.revision);
  const stale = await f.call(basePath(a.id), f.admin, 'POST', {
    ...first.body,
    requestId: randomUUID(),
    schedule: { ...allDays, durationMinutes: 45 },
  });
  assert.equal(stale.status, 409);
  assert.match(stale.data.error, /^Weekly availability changed/);
  assert.equal(second.value.change.before.schedule.durationMinutes, 30);
});

test('reviewed schemas are strict, accept split sessions/closed weeks and reject invalid times, overlap and explicit no-ops', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor(),
    body = await f.command(doctor.id);
  for (const patch of [
    { unknown: true },
    { reason: '' },
    { reason: 'x'.repeat(1001) },
    { requestId: 'wrong' },
    { expectedRevision: 'A'.repeat(64) },
    { schedule: { ...allDays, durationMinutes: 25 } },
    { schedule: { ...allDays, extra: true } },
    { schedule: { ...allDays, windows: [{ day: 7, start: '09:00', end: '10:00', mode: 'both' }] } },
    { schedule: { ...allDays, windows: [{ day: 1, start: '9:00', end: '10:00', mode: 'both' }] } },
    { schedule: { ...allDays, windows: [{ day: 1, start: '23:00', end: '01:00', mode: 'both' }] } },
    { schedule: { ...allDays, windows: [{ day: 1, start: '09:00', end: '09:15', mode: 'both' }] } },
    {
      schedule: {
        ...allDays,
        windows: [
          { day: 1, start: '09:00', end: '11:00', mode: 'in-person' },
          { day: 1, start: '10:00', end: '12:00', mode: 'online' },
        ],
      },
    },
    {
      schedule: {
        ...allDays,
        windows: [{ day: 1, start: '09:00', end: '11:00', mode: 'both', extra: true }],
      },
    },
    { schedule: { ...allDays, windows: Array.from({ length: 71 }, () => allDays.windows[0]) } },
  ])
    assert.equal(
      (await f.call(basePath(doctor.id), f.admin, 'POST', { ...body, ...patch })).status,
      400,
    );
  for (const query of ['?unknown=x', '?page=0', '?page=1000001', '?pageSize=100'])
    assert.equal((await f.call(`${basePath(doctor.id)}/history${query}`, f.admin)).status, 400);
  assert.equal((await f.call(`${basePath(doctor.id)}?unknown=x`, f.admin)).status, 400);
  assert.equal(
    (await f.call(`${basePath(doctor.id)}?unknown=x`, f.admin, 'POST', body)).status,
    400,
  );
  const split: WeeklyAvailabilityValues = {
    durationMinutes: 15,
    windows: [
      { day: 0, start: '09:00', end: '10:00', mode: 'online' },
      { day: 0, start: '10:00', end: '11:00', mode: 'in-person' },
    ],
  };
  await f.save(doctor.id, split);
  const noop = await f.command(doctor.id, { ...split, windows: [...split.windows].reverse() });
  assert.equal((await f.call(basePath(doctor.id), f.admin, 'POST', noop)).status, 400);
  const closed = await f.save(doctor.id, { durationMinutes: 60, windows: [] });
  assert.deepEqual(closed.value.context.schedule.windows, []);
});

test('exact canonical UUID retries return original event and receipt after later writes and current name changes; collisions are actor/doctor/payload bound', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor(),
    other = f.doctor(),
    saved = await f.save(doctor.id),
    newer = await f.save(doctor.id, { ...allDays, durationMinutes: 20 });
  const changedDoctor = { ...doctor, name: 'Later current clinician name' };
  f.db
    .prepare('UPDATE doctors SET data=? WHERE id=?')
    .run(JSON.stringify(changedDoctor), doctor.id);
  const before = f.state(),
    replay = await f.call(basePath(doctor.id), f.admin, 'POST', {
      ...saved.body,
      requestId: saved.body.requestId.toUpperCase(),
      schedule: { ...saved.body.schedule, windows: [...saved.body.schedule.windows].reverse() },
    });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data.change, saved.value.change);
  assert.deepEqual(replay.data.receipt, saved.value.receipt);
  assert.equal(replay.data.context.schedule.durationMinutes, 20);
  assert.equal(replay.data.context.revision, newer.value.context.revision);
  assert.equal(replay.data.context.doctor.name, changedDoctor.name);
  assert.deepEqual(f.state(), before);
  const secondAdmin = await f.account('admin');
  for (const [id, actor, body] of [
    [other.id, f.admin, saved.body],
    [doctor.id, secondAdmin, saved.body],
    [doctor.id, f.admin, { ...saved.body, reason: 'Changed reason' }],
    [doctor.id, f.admin, { ...saved.body, expectedRevision: newer.value.context.revision }],
    [doctor.id, f.admin, { ...saved.body, schedule: { ...allDays, durationMinutes: 45 } }],
  ] as const) {
    const result = await f.call(basePath(id), actor, 'POST', body);
    assert.equal(result.status, 409);
    assert.match(result.data.error, /request ID.*different weekly availability operation/);
  }
});

test('legacy PUT strips extra fields, records actual changes with no invented review, and keeps explicit no-op timestamps and history unchanged', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor(),
    source = await f.context(doctor.id);
  const first = await f.call(`/schedules/${doctor.id}`, f.admin, 'PUT', {
    ...values(source.schedule),
    ignored: true,
    windows: source.schedule.windows.map((w) => ({ ...w, ignored: true })),
  });
  assert.equal(first.status, 200);
  assert.equal(first.data.ignored, undefined);
  assert.equal(first.data.windows[0].ignored, undefined);
  const after = await f.context(doctor.id);
  assert.equal(after.latestChange?.source, 'legacy');
  assert.equal(after.latestChange?.reason, null);
  assert.equal(after.latestChange?.before.source, 'inherited');
  const auditBefore = f.state().audit,
    noop = await f.call(`/schedules/${doctor.id}`, f.admin, 'PUT', values(source.schedule));
  assert.equal(noop.status, 200);
  assert.deepEqual(noop.data, first.data);
  assert.equal(f.state().audit, auditBefore + 1);
  assert.equal((await f.context(doctor.id)).revision, after.revision);
  assert.equal((await f.call(`${basePath(doctor.id)}/history`, f.admin)).data.total, 1);
  const reviewed = await f.command(doctor.id, { ...allDays, durationMinutes: 20 });
  assert.equal(
    (await f.call(`/schedules/${doctor.id}`, f.admin, 'PUT', { ...allDays, durationMinutes: 45 }))
      .status,
    200,
  );
  const stale = await f.call(basePath(doctor.id), f.admin, 'POST', reviewed);
  assert.equal(stale.status, 409);
});

test('private availability history is admin-all/doctor-own; reception legacy reads and public slots retain safe shapes without reasons or receipts', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor(),
    own = await f.account('doctor', { doctorId: doctor.id }),
    other = await f.login('doctor'),
    reception = await f.login('reception'),
    patient = await f.login('patient');
  const saved = await f.save(doctor.id, allDays, own);
  for (const path of [basePath(doctor.id), `${basePath(doctor.id)}/history`]) {
    for (const who of [undefined, other, reception, patient])
      assert.equal((await f.call(path, who)).status, who ? 403 : 401);
    for (const who of [f.admin, own]) {
      const r = await f.call(path, who);
      assert.equal(r.status, 200);
      assert.match(r.headers.get('cache-control')!, /no-store/);
      assert.match(r.headers.get('x-robots-tag')!, /noindex/);
    }
  }
  for (const who of [undefined, other, reception, patient])
    assert.equal(
      (await f.call(basePath(doctor.id), who, 'POST', saved.body)).status,
      who ? 403 : 401,
    );
  for (const path of [`/schedules/${doctor.id}`, '/scheduling']) {
    const r = await f.call(path, reception);
    assert.equal(r.status, 200);
    for (const secret of [
      reason,
      saved.body.requestId,
      saved.value.change.id,
      'latestChange',
      'createdById',
      'expectedRevision',
    ])
      assert.equal(JSON.stringify(r.data).includes(secret), false);
  }
  const slots = await f.call(
    `/slots?doctorId=${doctor.id}&date=${addDays(clinicToday(), 30)}&mode=in-person`,
  );
  assert.equal(slots.status, 200);
  assert.ok(Array.isArray(slots.data));
  assert.ok(slots.data.length > 0);
  const history = await f.call(`${basePath(doctor.id)}/history`, own);
  assert.equal(JSON.stringify(history.data).includes('requestId'), false);
  assert.equal(JSON.stringify(history.data).includes(own.user.id), false);
});

test('both writers preserve saved full intervals and modes, including custom length, while default cadence changes do not rewrite bookings', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor();
  await f.save(doctor.id);
  const visit = appointment(f, doctor.id, {
    time: '09:10',
    mode: 'online',
    durationMinutes: 90,
    durationPolicy: 'custom',
  });
  const original = get<Appointment>(f.db, 'appointments', visit.id),
    before = await f.context(doctor.id);
  const cutoff: WeeklyAvailabilityValues = {
    durationMinutes: 20,
    windows: [{ day: dayOf(visit.date), start: '09:00', end: '10:30', mode: 'both' }],
  };
  const wrongMode: WeeklyAvailabilityValues = {
    ...allDays,
    windows: allDays.windows.map((w) => ({ ...w, mode: 'in-person' })),
  };
  for (const desired of [cutoff, wrongMode, { durationMinutes: 30 as const, windows: [] }]) {
    const command = {
      schedule: desired,
      reason,
      expectedRevision: before.revision,
      requestId: randomUUID(),
    };
    const r = await f.call(basePath(doctor.id), f.admin, 'POST', command);
    assert.equal(r.status, 409);
    assert.match(r.data.error, /invalidate 1 booked appointment/);
    const legacy = await f.call(`/schedules/${doctor.id}`, f.admin, 'PUT', desired);
    assert.equal(legacy.status, 409);
    assert.deepEqual(get(f.db, 'appointments', visit.id), original);
  }
  const expanded = await f.save(doctor.id, { ...allDays, durationMinutes: 20 });
  assert.equal(expanded.value.context.schedule.durationMinutes, 20);
  assert.deepEqual(get(f.db, 'appointments', visit.id), original);
  assert.equal(
    (await f.call(`/slots?doctorId=${doctor.id}&date=${visit.date}&mode=online`)).data.includes(
      '10:20',
    ),
    false,
  );
  assert.equal(
    (await f.call(`/slots?doctorId=${doctor.id}&date=${visit.date}&mode=online`)).data.includes(
      '10:40',
    ),
    true,
  );
  const calendar = await f.call(`/appointments/${visit.id}/calendar`, f.admin);
  assert.equal(calendar.status, 200);
  assert.ok(calendar.data.includes('DTEND:'));
});

test('existing current-date ongoing/active guard and historical terminal exceptions are preserved without broadening closure behavior', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor();
  await f.save(doctor.id);
  const today = clinicToday(),
    noon = Date.parse(`${today}T12:00:00+05:30`),
    realNow = Date.now;
  const patientId = randomUUID();
  const patient = get<Record<string, unknown>>(f.db, 'patients', 'patient-ananya')!;
  f.db
    .prepare('INSERT INTO patients(id,data) VALUES (?,?)')
    .run(patientId, JSON.stringify({ ...patient, id: patientId }));
  const ongoing = appointment(f, doctor.id, {
    patientId,
    date: today,
    time: '11:30',
    durationMinutes: 60,
  });
  const checked = appointment(f, doctor.id, {
    patientId,
    date: today,
    time: '09:00',
    status: 'checked-in',
  });
  const consult = appointment(f, doctor.id, {
    patientId,
    date: today,
    time: '10:00',
    status: 'in-consultation',
  });
  appointment(f, doctor.id, {
    patientId,
    date: addDays(today, -1),
    time: '09:00',
    status: 'in-consultation',
  });
  appointment(f, doctor.id, {
    patientId,
    date: addDays(today, 2),
    time: '09:00',
    status: 'completed',
  });
  appointment(f, doctor.id, {
    patientId,
    date: addDays(today, 3),
    time: '09:00',
    status: 'cancelled',
  });
  appointment(f, doctor.id, {
    patientId,
    date: addDays(today, 4),
    time: '09:00',
    status: 'no-show',
  });
  try {
    Date.now = () => noon;
    const body = await f.command(doctor.id, { durationMinutes: 30, windows: [] });
    const blocked = await f.call(basePath(doctor.id), f.admin, 'POST', body);
    assert.equal(blocked.status, 409);
    assert.match(blocked.data.error, /invalidate 3 booked appointments/);
    for (const value of [ongoing, checked, consult])
      f.db
        .prepare("UPDATE appointments SET status='completed',data=? WHERE id=?")
        .run(JSON.stringify({ ...value, status: 'completed' }), value.id);
    const r = await f.call(basePath(doctor.id), f.admin, 'POST', body);
    assert.equal(r.status, 201);
  } finally {
    Date.now = realNow;
  }
});

test('doctor renames do not stale availability, saving after rename records current attribution, while old retries preserve original labels', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor(),
    source = await f.context(doctor.id);
  f.db
    .prepare('UPDATE doctors SET data=? WHERE id=?')
    .run(JSON.stringify({ ...doctor, name: 'Current renamed doctor' }), doctor.id);
  assert.equal((await f.context(doctor.id)).revision, source.revision);
  const body = {
    schedule: allDays,
    reason,
    expectedRevision: source.revision,
    requestId: randomUUID(),
  };
  const saved = await f.call(basePath(doctor.id), f.admin, 'POST', body);
  assert.equal(saved.status, 201);
  assert.equal(saved.data.change.doctorName, 'Current renamed doctor');
  f.db
    .prepare('UPDATE doctors SET data=? WHERE id=?')
    .run(JSON.stringify({ ...doctor, name: 'Later current name' }), doctor.id);
  const replay = await f.call(basePath(doctor.id), f.admin, 'POST', body);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data.change, saved.data.change);
  assert.equal(replay.data.context.doctor.name, 'Later current name');
});

test('every private read, reviewed write/replay and legacy PUT revalidates current auth under the transaction lock', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor(),
    saved = await f.save(doctor.id),
    next = await f.command(doctor.id, { ...allDays, durationMinutes: 20 });
  const routes: [string, string, unknown?][] = [
    [basePath(doctor.id), 'GET'],
    [`${basePath(doctor.id)}/history`, 'GET'],
    [basePath(doctor.id), 'POST', saved.body],
    [basePath(doctor.id), 'POST', next],
    [`/schedules/${doctor.id}`, 'PUT', next.schedule],
  ];
  const external = openDatabase(f.databasePath),
    original = f.db.exec.bind(f.db),
    account = external.prepare('SELECT role,data FROM users WHERE id=?').get(f.admin.user.id)!;
  const session = external.prepare('SELECT * FROM sessions WHERE userId=?').get(f.admin.user.id)!,
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
                  "UPDATE users SET role='receptionist',data=json_set(data,'$.role','receptionist') WHERE id=?",
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
                  'synthetic-unused-secret',
                  new Date().toISOString(),
                  -1,
                );
          }
          return original(sql);
        }) as typeof f.db.exec;
        const before = f.state(),
          response = await f.call(path, f.admin, method, body);
        assert.equal(injected, true);
        assert.equal(
          response.status,
          change === 'temporary' || change === 'role' ? 403 : 401,
          `${change}/${method}/${path}`,
        );
        assert.deepEqual(f.state(), before);
        f.db.exec = original;
        external
          .prepare('UPDATE users SET role=?,data=? WHERE id=?')
          .run(account.role, account.data, f.admin.user.id);
        external.prepare('DELETE FROM mfaCredentials WHERE userId=?').run(f.admin.user.id);
        external
          .prepare(
            `INSERT OR REPLACE INTO sessions(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
          )
          .run(...columns.map((key) => session[key]));
      }
  } finally {
    f.db.exec = original;
    external.close();
  }
});

test('doctor ownership is freshly checked on history, context, writes, legacy PUT and exact replay after reassignment', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor(),
    other = f.doctor(),
    own = await f.account('doctor', { doctorId: doctor.id }),
    saved = await f.save(doctor.id, allDays, own),
    next = await f.command(doctor.id, { ...allDays, durationMinutes: 20 }, own);
  const external = openDatabase(f.databasePath),
    original = f.db.exec.bind(f.db),
    originalData = external.prepare('SELECT data FROM users WHERE id=?').get(own.user.id)!.data;
  try {
    for (const [path, method, body] of [
      [basePath(doctor.id), 'GET'],
      [`${basePath(doctor.id)}/history`, 'GET'],
      [basePath(doctor.id), 'POST', saved.body],
      [basePath(doctor.id), 'POST', next],
      [`/schedules/${doctor.id}`, 'PUT', next.schedule],
    ] as const) {
      let injected = false;
      f.db.exec = ((sql: string) => {
        if (sql === 'BEGIN IMMEDIATE' && !injected) {
          injected = true;
          external
            .prepare("UPDATE users SET data=json_set(data,'$.doctorId',?) WHERE id=?")
            .run(other.id, own.user.id);
        }
        return original(sql);
      }) as typeof f.db.exec;
      const before = f.state(),
        response = await f.call(path, own, method, body);
      assert.equal(injected, true);
      assert.equal(response.status, 403);
      assert.deepEqual(f.state(), before);
      f.db.exec = original;
      external.prepare('UPDATE users SET data=? WHERE id=?').run(originalData, own.user.id);
    }
  } finally {
    f.db.exec = original;
    external.close();
  }
});

test('schedule, event, command, audit and response failures roll back new and legacy mutations; failed read audits expose no context/history', async (t) => {
  for (const legacy of [false, true])
    for (const point of [
      'schedule',
      'event',
      'audit',
      ...(legacy ? [] : ['command', 'response']),
    ]) {
      const f = await fixture(t),
        doctor = f.doctor();
      await f.save(doctor.id);
      const body = await f.command(doctor.id, { ...allDays, durationMinutes: 20 }),
        before = f.state();
      const table =
        point === 'schedule'
          ? 'doctorSchedules'
          : point === 'event'
            ? 'weeklyAvailabilityChanges'
            : point === 'command'
              ? 'weeklyAvailabilityCommands'
              : 'audit';
      const original = f.db.prepare.bind(f.db);
      let fired = false;
      if (point === 'response') {
        let reads = 0;
        f.db.prepare = ((sql: string) => {
          const statement = original(sql);
          if (
            sql ===
            'SELECT data FROM weeklyAvailabilityChanges WHERE doctorId=? ORDER BY rowid DESC LIMIT 1'
          ) {
            const getRow = statement.get.bind(statement);
            statement.get = ((...params: Parameters<typeof statement.get>) => {
              reads++;
              if (reads === 2) {
                fired = true;
                throw new Error('Synthetic response read failure');
              }
              return getRow(...params);
            }) as typeof statement.get;
          }
          return statement;
        }) as typeof f.db.prepare;
      } else
        f.db.exec(
          `CREATE TRIGGER weekly_failure BEFORE ${point === 'schedule' ? 'UPDATE' : 'INSERT'} ON ${table} BEGIN SELECT RAISE(ABORT,'Synthetic weekly write failure'); END;`,
        );
      try {
        const response = await f.call(
          legacy ? `/schedules/${doctor.id}` : basePath(doctor.id),
          f.admin,
          legacy ? 'PUT' : 'POST',
          legacy ? body.schedule : body,
        );
        assert.equal(response.status, 500, `${legacy}/${point}`);
        if (point === 'response') assert.equal(fired, true);
        assert.equal(response.data.change, undefined);
        assert.equal(response.data.context, undefined);
        assert.deepEqual(f.state(), before);
      } finally {
        f.db.prepare = original;
      }
    }
  const f = await fixture(t),
    doctor = f.doctor();
  await f.save(doctor.id);
  const before = f.state();
  f.db.exec(
    "CREATE TRIGGER weekly_read_failure BEFORE INSERT ON audit WHEN json_extract(NEW.data,'$.action') LIKE 'viewed doctor weekly availability%' BEGIN SELECT RAISE(ABORT,'Synthetic weekly read audit failure'); END;",
  );
  for (const path of [basePath(doctor.id), `${basePath(doctor.id)}/history`]) {
    const response = await f.call(path, f.admin);
    assert.equal(response.status, 500);
    assert.equal(response.data.items, undefined);
    assert.equal(response.data.schedule, undefined);
  }
  assert.deepEqual(f.state(), before);
});

test('a concurrent appointment or schedule change before BEGIN is authoritative; exact retry remains available after later conflicting bookings', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor(),
    saved = await f.save(doctor.id),
    body = await f.command(doctor.id, { durationMinutes: 30, windows: [] });
  const external = openDatabase(f.databasePath),
    original = f.db.exec.bind(f.db);
  const visit: Appointment = {
    id: randomUUID(),
    patientId: 'patient-ananya',
    patientName: 'Synthetic',
    doctorId: doctor.id,
    doctorName: doctor.name,
    date: addDays(clinicToday(), 30),
    time: '12:00',
    mode: 'in-person',
    reason: 'Concurrent new booking',
    status: 'scheduled',
    fee: 500,
    durationMinutes: 30,
    createdAt: new Date().toISOString(),
  };
  let injected = false;
  f.db.exec = ((sql: string) => {
    if (sql === 'BEGIN IMMEDIATE' && !injected) {
      injected = true;
      external
        .prepare(
          'INSERT INTO appointments(id,patientId,doctorId,date,time,status,data) VALUES(?,?,?,?,?,?,?)',
        )
        .run(
          visit.id,
          visit.patientId,
          visit.doctorId,
          visit.date,
          visit.time,
          visit.status,
          JSON.stringify(visit),
        );
    }
    return original(sql);
  }) as typeof f.db.exec;
  try {
    const before = f.state(),
      response = await f.call(basePath(doctor.id), f.admin, 'POST', body);
    assert.equal(injected, true);
    assert.equal(response.status, 409);
    assert.match(response.data.error, /booked appointment/);
    const after = f.state();
    assert.deepEqual(after.schedules, before.schedules);
    assert.equal(after.changes, before.changes);
    assert.equal(after.commands, before.commands);
    assert.equal(after.audit, before.audit);
  } finally {
    f.db.exec = original;
    external.close();
  }
  assert.equal((await f.call(basePath(doctor.id), f.admin, 'POST', saved.body)).status, 200);
  const source = await f.context(doctor.id),
    pending = { ...body, expectedRevision: source.revision, requestId: randomUUID() };
  await f.call(`/schedules/${doctor.id}`, f.admin, 'PUT', { ...allDays, durationMinutes: 20 });
  const stale = await f.call(basePath(doctor.id), f.admin, 'POST', pending);
  assert.equal(stale.status, 409);
  assert.match(stale.data.error, /^Weekly availability changed/);
});

test('independent connections serialize competing revisions and exact duplicates while keeping other doctors independent', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor(),
    other = f.doctor(),
    g = await fixture(t, f.databasePath);
  const a = await f.command(doctor.id),
    b = { ...a, requestId: randomUUID(), schedule: { ...allDays, durationMinutes: 20 } };
  const responses = await Promise.all([
    f.call(basePath(doctor.id), f.admin, 'POST', a),
    g.call(basePath(doctor.id), g.admin, 'POST', b),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
  const next = await f.command(other.id),
    duplicate = await Promise.all([
      f.call(basePath(other.id), f.admin, 'POST', next),
      g.call(basePath(other.id), g.admin, 'POST', next),
    ]);
  assert.deepEqual(duplicate.map((r) => r.status).sort(), [200, 201]);
  assert.deepEqual(duplicate[0].data.change, duplicate[1].data.change);
  assert.deepEqual(duplicate[0].data.receipt, duplicate[1].data.receipt);
});

test('history paging is doctor-scoped and SQL-bounded, stable by timestamp/ID, coherent, and uses dedicated history/head indexes', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor(),
    other = f.doctor();
  for (let index = 0; index < 56; index++)
    await f.save(doctor.id, { ...allDays, durationMinutes: index % 2 ? 20 : 30 });
  await f.save(other.id);
  const original = f.db.prepare.bind(f.db),
    decodedCounts: number[] = [];
  f.db.prepare = ((sql: string) => {
    const statement = original(sql);
    if (sql.startsWith('SELECT data FROM weeklyAvailabilityChanges')) {
      assert.ok(sql.includes('WHERE doctorId=?'));
      assert.ok(sql.includes('LIMIT'));
      if (sql.includes('OFFSET')) {
        const all = statement.all.bind(statement);
        statement.all = ((...params: Parameters<typeof statement.all>) => {
          const rows = all(...params);
          decodedCounts.push(rows.length);
          return rows;
        }) as typeof statement.all;
      }
    }
    return statement;
  }) as typeof f.db.prepare;
  try {
    const first = await f.call(`${basePath(doctor.id)}/history`, f.admin);
    assert.equal(first.data.total, 56);
    assert.equal(first.data.items.length, 25);
    const last = await f.call(`${basePath(doctor.id)}/history?page=1000000&pageSize=10`, f.admin);
    assert.equal(last.data.page, 6);
    assert.equal(last.data.items.length, 6);
    assert.deepEqual(decodedCounts, [25, 6]);
    const expected = original(
      'SELECT id FROM weeklyAvailabilityChanges WHERE doctorId=? ORDER BY createdAt DESC,id DESC LIMIT 25',
    )
      .all(doctor.id)
      .map((row) => row.id);
    assert.deepEqual(
      first.data.items.map((row: { id: string }) => row.id),
      expected,
    );
    for (const [sql, params, index] of [
      [
        'SELECT data FROM weeklyAvailabilityChanges WHERE doctorId=? ORDER BY rowid DESC LIMIT 1',
        [doctor.id],
        'weekly_availability_doctor_head',
      ],
      [
        'SELECT data FROM weeklyAvailabilityChanges WHERE doctorId=? ORDER BY createdAt DESC,id DESC LIMIT ? OFFSET ?',
        [doctor.id, 25, 0],
        'weekly_availability_doctor_history',
      ],
    ] as const) {
      const plan = JSON.stringify(original(`EXPLAIN QUERY PLAN ${sql}`).all(...params));
      assert.match(plan, new RegExp(index));
      assert.doesNotMatch(plan, /TEMP B-TREE/);
    }
  } finally {
    f.db.prepare = original;
  }
  const external = openDatabase(f.databasePath);
  external.exec('PRAGMA busy_timeout=0');
  let checked = false;
  f.db.prepare = ((sql: string) => {
    const statement = original(sql);
    if (sql === 'SELECT COUNT(*) n FROM weeklyAvailabilityChanges WHERE doctorId=?') {
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
    assert.equal((await f.call(`${basePath(doctor.id)}/history`, f.admin)).status, 200);
    assert.equal(checked, true);
  } finally {
    f.db.prepare = original;
    external.close();
  }
});

test('immutable source events and command receipts survive restart with later-current replay and no appointment or closure mutations', async (t) => {
  const f = await fixture(t),
    doctor = f.doctor(),
    saved = await f.save(doctor.id),
    later = await f.save(doctor.id, { ...allDays, durationMinutes: 20 });
  for (const [table, key, value] of [
    ['weeklyAvailabilityChanges', 'id', saved.value.change.id],
    ['weeklyAvailabilityCommands', 'requestId', saved.body.requestId],
  ] as const) {
    assert.throws(
      () => f.db.prepare(`UPDATE ${table} SET ${key}=${key} WHERE ${key}=?`).run(value),
      /immutable/,
    );
    assert.throws(
      () => f.db.prepare(`DELETE FROM ${table} WHERE ${key}=?`).run(value),
      /immutable/,
    );
  }
  const sources = f.db.prepare('SELECT * FROM appointments ORDER BY id').all(),
    closures = f.db.prepare('SELECT * FROM scheduleClosures ORDER BY id').all();
  const path = f.databasePath;
  await f.close();
  const reopened = await fixture(t, path);
  const replay = await reopened.call(basePath(doctor.id), reopened.admin, 'POST', saved.body);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data.change, saved.value.change);
  assert.deepEqual(replay.data.receipt, saved.value.receipt);
  assert.equal(replay.data.context.revision, later.value.context.revision);
  assert.deepEqual(reopened.db.prepare('SELECT * FROM appointments ORDER BY id').all(), sources);
  assert.deepEqual(
    reopened.db.prepare('SELECT * FROM scheduleClosures ORDER BY id').all(),
    closures,
  );
});
