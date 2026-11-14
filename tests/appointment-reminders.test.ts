import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import { get, openDatabase, type DB } from '../server/db.ts';
import type { Appointment, Patient, User } from '../shared/types.ts';
import type {
  AppointmentReminderPreview,
  AppointmentReminderRun,
  AppointmentReminderPolicyContext,
} from '../shared/appointment-reminders.ts';

const now = Date.parse('2027-03-01T04:30:00.000Z'); // 10:00 IST.
const policyPath = '/appointment-reminder-policy';
const previewPath = '/appointment-reminders/preview';
const runPath = '/appointment-reminders/run';
const privateText = 'PRIVATE_VISIT_REASON_AND_CLINICAL_CONTENT';
type Client = { cookie: string; csrf: string; user: User };
function clock(t: TestContext, time = now) {
  t.mock.timers.enable({ apis: ['Date'], now: time });
}
async function fixture(t: TestContext, path?: string, clear = true) {
  const directory = mkdtempSync(join(tmpdir(), 'derma-appointment-reminders-'));
  const databasePath = path ?? join(directory, 'clinic.sqlite');
  const app = createApp({ databasePath, demoMode: true, production: false });
  const db = app.locals.db as DB;
  if (clear)
    db.exec(
      "UPDATE appointments SET status='cancelled',data=json_set(data,'$.status','cancelled')",
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
  async function call(url: string, who?: Client, method = 'GET', body?: unknown) {
    const response = await fetch(`${base}/api${url}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(who ? { Cookie: who.cookie, 'X-CSRF-Token': who.csrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  async function login(role: string) {
    const r = await call('/auth/login', undefined, 'POST', {
      email: `${role}@derma.demo`,
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
  function appointment(offsetMinutes = 60, fields: Partial<Appointment> = {}): Appointment {
    const local = new Date(now + offsetMinutes * 60000 + 19800000).toISOString();
    const value: Appointment = {
      id: randomUUID(),
      patientId: 'patient-ananya',
      patientName: 'Old booked name',
      doctorId: 'doctor-meera',
      doctorName: 'Booked clinician',
      date: local.slice(0, 10),
      time: local.slice(11, 16),
      mode: 'in-person',
      reason: privateText,
      status: 'scheduled',
      fee: 777,
      durationMinutes: 30,
      createdAt: new Date().toISOString(),
      ...fields,
    };
    db.prepare(
      'INSERT INTO appointments(id,patientId,doctorId,date,time,status,data) VALUES (?,?,?,?,?,?,?)',
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
  function update(value: Appointment, fields: Partial<Appointment>): Appointment {
    const next = { ...value, ...fields };
    db.prepare(
      'UPDATE appointments SET patientId=?,doctorId=?,date=?,time=?,status=?,data=? WHERE id=?',
    ).run(
      next.patientId,
      next.doctorId,
      next.date,
      next.time,
      next.status,
      JSON.stringify(next),
      next.id,
    );
    return next;
  }
  function patient(withPortal = true, fields: Partial<User> = {}) {
    const value: Patient = {
      ...get<Patient>(db, 'patients', 'patient-ananya')!,
      id: randomUUID(),
      name: 'Synthetic reminder patient',
      email: `${randomUUID()}@example.test`,
      allergies: privateText,
    };
    db.prepare('INSERT INTO patients(id,data) VALUES (?,?)').run(value.id, JSON.stringify(value));
    const user: User = {
      id: randomUUID(),
      name: 'Synthetic portal name',
      email: value.email,
      role: 'patient',
      patientId: value.id,
      ...fields,
    };
    if (withPortal) {
      const password = db
        .prepare("SELECT password FROM users WHERE email='patient@derma.demo'")
        .get()!.password;
      db.prepare('INSERT INTO users(id,email,password,role,data) VALUES (?,?,?,?,?)').run(
        user.id,
        user.email,
        password as string,
        user.role,
        JSON.stringify(user),
      );
    }
    return { patient: value, user };
  }
  async function context(): Promise<AppointmentReminderPolicyContext> {
    const r = await call(policyPath, admin);
    assert.equal(r.status, 200);
    return r.data;
  }
  async function setPolicy(fields: Record<string, unknown> = {}) {
    const current = await context(),
      body = {
        ...current.policy,
        enabled: true,
        reason: 'PRIVATE_POLICY_NOTE',
        expectedRevision: current.revision,
        requestId: randomUUID(),
        ...fields,
      };
    const r = await call(policyPath, admin, 'POST', body);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return { ...r.data, body };
  }
  async function preview(): Promise<AppointmentReminderPreview> {
    const r = await call(previewPath, admin);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  }
  const command = (p: AppointmentReminderPreview) => ({
    expectedPreviewRevision: p.revision,
    expectedPolicyRevision: p.policyRevision,
    confirmed: true,
    requestId: randomUUID(),
  });
  async function run() {
    const body = command(await preview()),
      r = await call(runPath, admin, 'POST', body);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return { value: r.data as AppointmentReminderRun, body };
  }
  function state() {
    return Object.fromEntries(
      [
        'appointmentReminderPolicyChanges',
        'appointmentReminderRuns',
        'appointmentReminderEvents',
        'appointmentReminderCommands',
        'activity',
        'audit',
      ].map((table) => [table, Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n)]),
    );
  }
  return {
    app,
    db,
    databasePath,
    call,
    login,
    admin,
    appointment,
    update,
    patient,
    context,
    setPolicy,
    preview,
    command,
    run,
    state,
    close,
  };
}

test('defaults, all-staff reads, admin-only writes, strict inputs and no empty runs', async (t) => {
  clock(t);
  const f = await fixture(t),
    doctor = await f.login('doctor'),
    reception = await f.login('reception'),
    patient = await f.login('patient');
  const a = f.appointment(),
    c = await f.context();
  assert.deepEqual(c.policy, { enabled: false, leadHours: 24 });
  assert.equal(c.latestChange, null);
  assert.deepEqual(c.worker, {
    automaticEnabled: false,
    intervalSeconds: 300,
    batchLimit: 200,
    lastCheckedAt: null,
    lastRunId: null,
    lastErrorAt: null,
  });
  const disabled = await f.preview();
  assert.equal(disabled.upcomingAppointmentTotal, 1);
  assert.equal(disabled.readyTotal, 0);
  assert.deepEqual(disabled.items, []);
  for (const who of [doctor, reception])
    for (const url of [
      policyPath,
      `${policyPath}/history`,
      previewPath,
      '/appointment-reminders/runs',
      `/appointments/${a.id}/reminders`,
    ]) {
      const r = await f.call(url, who);
      assert.equal(r.status, 200);
      assert.match(r.headers.get('cache-control') ?? '', /no-store/);
    }
  for (const url of [
    policyPath,
    `${policyPath}/history`,
    previewPath,
    '/appointment-reminders/runs',
    `/appointments/${a.id}/reminders`,
    '/appointment-reminders/runs/missing',
  ]) {
    assert.equal((await f.call(url, patient)).status, 403);
    assert.equal((await f.call(url)).status, 401);
  }
  const body = {
    enabled: true,
    leadHours: 24,
    reason: 'Enable',
    expectedRevision: c.revision,
    requestId: randomUUID(),
  };
  for (const who of [doctor, reception, patient])
    assert.equal((await f.call(policyPath, who, 'POST', body)).status, 403);
  for (const patch of [
    { leadHours: 0 },
    { leadHours: 169 },
    { leadHours: 1.5 },
    { reason: ' ' },
    { extra: true },
    { expectedRevision: 'X'.repeat(64) },
    { requestId: 'bad' },
  ])
    assert.equal((await f.call(policyPath, f.admin, 'POST', { ...body, ...patch })).status, 400);
  for (const url of [
    `${policyPath}?extra=1`,
    `${previewPath}?patientId=${a.patientId}`,
    `${policyPath}/history?page=0`,
    `${policyPath}/history?pageSize=100`,
    `${policyPath}/history?page=1000001`,
  ])
    assert.equal((await f.call(url, f.admin)).status, 400);
  assert.equal(
    (await f.call(`${runPath}?extra=1`, f.admin, 'POST', f.command(disabled))).status,
    400,
  );
  assert.equal(
    (await f.call(runPath, f.admin, 'POST', { ...f.command(disabled), confirmed: false })).status,
    400,
  );
  const before = f.state();
  assert.equal((await f.call(runPath, f.admin, 'POST', f.command(disabled))).status, 409);
  assert.deepEqual(f.state(), before);
  await f.setPolicy();
  f.update(a, { status: 'cancelled' });
  const empty = await f.preview();
  const prior = f.state();
  assert.equal((await f.call(runPath, f.admin, 'POST', f.command(empty))).status, 409);
  assert.deepEqual(f.state(), prior);
});

test('exact millisecond IST window boundaries, captured preview time, and stable revision within unchanged window', async (t) => {
  clock(t);
  const f = await fixture(t);
  await f.setPolicy({ leadHours: 1 });
  f.appointment(-1);
  f.appointment(0);
  const inside = f.appointment(1),
    edge = f.appointment(60);
  f.appointment(61);
  f.appointment(30, { status: 'checked-in' });
  let p = await f.preview();
  assert.deepEqual(
    p.items.map((x) => x.appointment.id),
    [inside.id, edge.id],
  );
  assert.equal(p.clinicDate, '2027-03-01');
  assert.equal(p.generatedAt, '2027-03-01T04:30:00.000Z');
  assert.equal(p.windowEndAt, '2027-03-01T05:30:00.000Z');
  assert.equal(p.items[1].startAt, '2027-03-01T05:30:00.000Z');
  assert.equal(p.items[1].dueAt, p.generatedAt);
  t.mock.timers.setTime(now + 1);
  const later = await f.preview();
  assert.equal(later.revision, p.revision);
  t.mock.timers.setTime(now - 1);
  p = await f.preview();
  assert.equal(
    p.items.some((x) => x.appointment.id === edge.id),
    false,
  );
  assert.equal(p.upcomingAppointmentTotal, 2);
  t.mock.timers.setTime(Date.parse('2027-03-01T18:29:59.999Z'));
  Object.assign(f.admin, await f.login('admin'));
  f.appointment(14 * 60, { date: '2027-03-02', time: '00:00' });
  p = await f.preview();
  assert.equal(p.clinicDate, '2027-03-01');
  assert.equal(p.items[0].startAt, '2027-03-01T18:30:00.000Z');
});

test('current demographic name, booked clinician snapshot and narrow patient notices leave clinical and summary sources unchanged', async (t) => {
  clock(t);
  const f = await fixture(t),
    patient = await f.login('patient');
  const a = f.appointment();
  await f.setPolicy();
  f.db
    .prepare(
      "UPDATE patients SET data=json_set(data,'$.name','Current patient name','$.allergies',?) WHERE id=?",
    )
    .run(privateText, a.patientId);
  const oldSummary = await f.call(`/patients/${a.patientId}/care-summary`, patient);
  const source = f.db.prepare('SELECT data FROM appointments WHERE id=?').get(a.id)!.data;
  const p = await f.preview();
  assert.equal(p.items[0].appointment.patientName, 'Current patient name');
  assert.equal(p.items[0].appointment.doctorName, 'Booked clinician');
  assert.deepEqual(
    Object.keys(p.items[0].appointment).sort(),
    [
      'id',
      'patientId',
      'patientName',
      'doctorId',
      'doctorName',
      'date',
      'time',
      'mode',
      'durationMinutes',
      'status',
    ].sort(),
  );
  const run = await f.run();
  assert.equal(run.value.noticeCount, 1);
  assert.equal(run.value.remainingReady, 0);
  const activity = await f.call('/activity', patient);
  const notice = activity.data.items.find(
    (x: { title: string }) => x.title === 'Upcoming appointment reminder',
  );
  assert.ok(notice);
  assert.equal(notice.href, `/my-care?appointment=${a.id}`);
  assert.match(notice.detail, /IST.*Booked clinician.*30 minutes.*current appointment/);
  for (const value of [p, run.value, notice])
    assert.equal(JSON.stringify(value).includes(privateText), false);
  assert.equal(JSON.stringify(notice).includes('PRIVATE_POLICY_NOTE'), false);
  assert.equal(JSON.stringify(notice).includes('777'), false);
  assert.equal(f.db.prepare('SELECT data FROM appointments WHERE id=?').get(a.id)!.data, source);
  const summary = await f.call(`/patients/${a.patientId}/care-summary`, patient);
  assert.equal(summary.data.revision, oldSummary.data.revision);
  assert.equal(JSON.stringify(summary.data).includes('Upcoming appointment reminder'), false);
  const history = await f.call(`/appointments/${a.id}/reminders`, f.admin);
  assert.equal(history.data.current.state, 'recorded');
  assert.equal(history.data.current.recordedAt, run.value.createdAt);
});

test('dedupe excludes duration, fee, reason, names and policy; changed scheduling identity sends once and returning to old identity stays recorded', async (t) => {
  clock(t);
  const f = await fixture(t);
  let a = f.appointment();
  await f.setPolicy();
  const first = await f.run();
  a = f.update(a, {
    durationMinutes: 60,
    fee: 1234,
    doctorName: 'Renamed clinician',
    reason: 'Other shared reason',
  });
  f.db
    .prepare("UPDATE patients SET data=json_set(data,'$.name','Renamed patient') WHERE id=?")
    .run(a.patientId);
  await f.setPolicy({ leadHours: 48 });
  await f.setPolicy({ enabled: false });
  await f.setPolicy({ enabled: true });
  let p = await f.preview();
  assert.equal(p.readyTotal, 0);
  assert.equal(p.alreadyRecordedTotal, 1);
  a = f.update(a, { time: '11:30' });
  p = await f.preview();
  assert.equal(p.readyTotal, 1);
  assert.notEqual(p.items[0].episodeId, first.value.events[0].episodeId);
  await f.run();
  a = f.update(a, { mode: 'online' });
  await f.run();
  a = f.update(a, { doctorId: 'doctor-arjun' });
  await f.run();
  a = f.update(a, { doctorId: 'doctor-meera', mode: 'in-person', time: '11:00' });
  p = await f.preview();
  assert.equal(p.readyTotal, 0);
  assert.equal(p.alreadyRecordedTotal, 1);
  const history = await f.call(`/appointments/${a.id}/reminders`, f.admin);
  assert.equal(history.data.total, 4);
  assert.equal(history.data.current.episodeId, first.value.events[0].episodeId);
  assert.equal(
    history.data.items.find((x: { id: string }) => x.id === first.value.events[0].id).appointment
      .durationMinutes,
    30,
  );
});

test('no recipient consumes no identity; later exact portal becomes eligible while temporary/inactive/wrong-role accounts are excluded', async (t) => {
  clock(t);
  const f = await fixture(t);
  await f.setPolicy();
  const missing = f.patient(false),
    temporary = f.patient(true, { mustChangePassword: true }),
    inactive = f.patient(true, { active: false });
  f.appointment(30, { patientId: missing.patient.id });
  f.appointment(60, { patientId: temporary.patient.id });
  f.appointment(90, { patientId: inactive.patient.id });
  let p = await f.preview();
  assert.equal(p.upcomingAppointmentTotal, 3);
  assert.equal(p.unroutableTotal, 3);
  assert.equal(p.readyTotal, 0);
  assert.equal(f.app.locals.runAppointmentReminders(), null);
  assert.equal(f.state().appointmentReminderEvents, 0);
  const source = f.db.prepare("SELECT password FROM users WHERE email='patient@derma.demo'").get()!;
  f.db
    .prepare('INSERT INTO users(id,email,password,role,data) VALUES (?,?,?,?,?)')
    .run(
      missing.user.id,
      missing.user.email,
      source.password as string,
      'patient',
      JSON.stringify(missing.user),
    );
  f.db
    .prepare("UPDATE users SET data=json_set(data,'$.mustChangePassword',json('false')) WHERE id=?")
    .run(temporary.user.id);
  p = await f.preview();
  assert.equal(p.readyTotal, 2);
  assert.equal(p.unroutableTotal, 1);
  await f.run();
  assert.equal(
    f.db.prepare('SELECT count(*) AS n FROM activity WHERE userId=?').get(inactive.user.id)!.n,
    0,
  );
  // An email coincidence cannot route another patient's reminder.
  const foreign = f.patient(false);
  f.appointment(120, { patientId: foreign.patient.id });
  f.db
    .prepare("UPDATE patients SET data=json_set(data,'$.email','patient@derma.demo') WHERE id=?")
    .run(foreign.patient.id);
  p = await f.preview();
  assert.equal(p.unroutableTotal, 2);
  assert.equal(p.readyTotal, 0);
});

test('flat candidates and uniqueness are per-recipient even without the current single-portal index', async (t) => {
  clock(t);
  const f = await fixture(t);
  await f.setPolicy();
  const a = f.appointment();
  f.db.exec('DROP INDEX unique_patient_portal');
  const user = get<User>(f.db, 'users', (await f.login('patient')).user.id)!;
  const source = f.db.prepare('SELECT password FROM users WHERE id=?').get(user.id)!;
  const second = {
    ...user,
    id: randomUUID(),
    email: 'second-portal@example.test',
    name: 'Second exact linked account',
  };
  f.db
    .prepare('INSERT INTO users(id,email,password,role,data) VALUES (?,?,?,?,?)')
    .run(second.id, second.email, source.password as string, 'patient', JSON.stringify(second));
  const p = await f.preview();
  assert.equal(p.upcomingAppointmentTotal, 1);
  assert.equal(p.readyTotal, 2);
  assert.equal(p.unroutableTotal, 0);
  assert.equal(p.items[0].episodeId, p.items[1].episodeId);
  assert.deepEqual(
    p.items.map((x) => x.recipient.id),
    [user.id, second.id].sort(),
  );
  const run = await f.run();
  assert.equal(run.value.noticeCount, 2);
  assert.equal(new Set(run.value.events.map((x) => x.recipient.id)).size, 2);
  assert.equal((await f.preview()).alreadyRecordedTotal, 2);
  assert.equal(
    f.db
      .prepare('SELECT count(*) AS n FROM appointmentReminderEvents WHERE appointmentId=?')
      .get(a.id)!.n,
    2,
  );
});

test('policy and run UUID receipts bind actor, operation and payload, replay before changed eligibility, and survive restart', async (t) => {
  clock(t);
  const f = await fixture(t),
    a = f.appointment();
  const savedPolicy = await f.setPolicy();
  const first = await f.run();
  f.update(a, { status: 'cancelled' });
  await f.setPolicy({ enabled: false });
  let r = await f.call(runPath, f.admin, 'POST', {
    ...first.body,
    requestId: first.body.requestId.toUpperCase(),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, first.value);
  r = await f.call(policyPath, f.admin, 'POST', savedPolicy.body);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.change, savedPolicy.change);
  assert.equal(r.data.context.policy.enabled, false);
  assert.equal(
    (await f.call(policyPath, f.admin, 'POST', { ...savedPolicy.body, reason: 'Changed' })).status,
    409,
  );
  assert.equal(
    (
      await f.call(runPath, f.admin, 'POST', {
        ...first.body,
        expectedPreviewRevision: '0'.repeat(64),
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.call(runPath, f.admin, 'POST', {
        ...first.body,
        requestId: savedPolicy.body.requestId,
      })
    ).status,
    409,
  );
  const other = await f.login('doctor');
  const account = get<User>(f.db, 'users', other.user.id)!;
  f.db
    .prepare("UPDATE users SET role='admin',data=? WHERE id=?")
    .run(JSON.stringify({ ...account, role: 'admin' }), account.id);
  assert.equal((await f.call(runPath, other, 'POST', first.body)).status, 409);
  const g = await fixture(t, f.databasePath, false);
  r = await g.call(runPath, f.admin, 'POST', first.body);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, first.value);
  assert.equal(g.state().appointmentReminderRuns, 1);
  for (const table of [
    'appointmentReminderPolicyChanges',
    'appointmentReminderRuns',
    'appointmentReminderEvents',
    'appointmentReminderCommands',
  ]) {
    assert.throws(
      () =>
        g.db.exec(
          `UPDATE ${table} SET ${table === 'appointmentReminderCommands' ? 'payload=payload' : 'data=data'}`,
        ),
      /immutable/,
    );
    assert.throws(() => g.db.exec(`DELETE FROM ${table}`), /immutable/);
  }
});

test('current source/recipient changes invalidate preview and independent application connections create one run only', async (t) => {
  clock(t);
  const f = await fixture(t);
  let a = f.appointment();
  await f.setPolicy();
  for (const change of ['duration', 'recipient', 'patient-name', 'slot', 'policy']) {
    const p = await f.preview(),
      body = f.command(p);
    if (change === 'duration') a = f.update(a, { durationMinutes: 60 });
    if (change === 'recipient')
      f.db
        .prepare(
          "UPDATE users SET data=json_set(data,'$.name','Current recipient') WHERE email='patient@derma.demo'",
        )
        .run();
    if (change === 'patient-name')
      f.db
        .prepare(
          "UPDATE patients SET data=json_set(data,'$.name','Updated source patient') WHERE id=?",
        )
        .run(a.patientId);
    if (change === 'slot') a = f.update(a, { time: '12:00' });
    if (change === 'policy') await f.setPolicy({ leadHours: 48 });
    assert.equal((await f.call(runPath, f.admin, 'POST', body)).status, 409, change);
    assert.equal(f.state().appointmentReminderRuns, 0);
  }
  const g = await fixture(t, f.databasePath, false),
    p = await f.preview(),
    body = f.command(p);
  const results = await Promise.all([
    f.call(runPath, f.admin, 'POST', body),
    g.call(runPath, f.admin, 'POST', body),
  ]);
  assert.deepEqual(results.map((x) => x.status).sort(), [200, 201]);
  assert.deepEqual(results[0].data, results[1].data);
  assert.equal(f.state().appointmentReminderRuns, 1);
  assert.equal(f.state().appointmentReminderEvents, 1);
  a = f.update(a, { time: '13:00' });
  const source = await f.preview();
  const competing = await Promise.all([
    f.call(runPath, f.admin, 'POST', f.command(source)),
    g.call(runPath, f.admin, 'POST', g.command(source)),
  ]);
  assert.deepEqual(competing.map((x) => x.status).sort(), [201, 409]);
  assert.equal(f.state().appointmentReminderEvents, 2);
});

test('every operational path revalidates current session, CSRF, MFA, active state and roles under its transaction, including exact retries', async (t) => {
  clock(t);
  const f = await fixture(t),
    a = f.appointment(),
    savedPolicy = await f.setPolicy(),
    savedRun = await f.run();
  f.update(a, { time: '12:00' });
  const pending = f.command(await f.preview());
  const routes: [string, string, unknown?][] = [
    [policyPath, 'GET'],
    [`${policyPath}/history`, 'GET'],
    [previewPath, 'GET'],
    ['/appointment-reminders/runs', 'GET'],
    [`/appointment-reminders/runs/${savedRun.value.id}`, 'GET'],
    [`/appointments/${a.id}/reminders`, 'GET'],
    [policyPath, 'POST', savedPolicy.body],
    [policyPath, 'POST', { ...savedPolicy.body, requestId: randomUUID() }],
    [runPath, 'POST', savedRun.body],
    [runPath, 'POST', pending],
  ];
  const external = openDatabase(f.databasePath),
    original = f.db.exec.bind(f.db);
  const user = external.prepare('SELECT role,data FROM users WHERE id=?').get(f.admin.user.id)!;
  const session = external.prepare('SELECT * FROM sessions WHERE userId=?').get(f.admin.user.id)!;
  const columns = Object.keys(session);
  try {
    for (const change of [
      'revoked',
      'expired',
      'csrf',
      'inactive',
      'temporary',
      'patient-role',
      'mfa',
    ])
      for (const [url, method, body] of routes) {
        let fired = false;
        f.db.exec = ((sql: string) => {
          if (sql === 'BEGIN IMMEDIATE' && !fired) {
            fired = true;
            if (change === 'revoked')
              external.prepare('DELETE FROM sessions WHERE userId=?').run(f.admin.user.id);
            if (change === 'expired')
              external
                .prepare('UPDATE sessions SET expiresAt=0 WHERE userId=?')
                .run(f.admin.user.id);
            if (change === 'csrf')
              external
                .prepare("UPDATE sessions SET csrfToken='replaced' WHERE userId=?")
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
            if (change === 'patient-role')
              external
                .prepare(
                  "UPDATE users SET role='patient',data=json_set(data,'$.role','patient','$.patientId','patient-2') WHERE id=?",
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
                  'synthetic-unused-encrypted-fixture',
                  new Date().toISOString(),
                  -1,
                );
          }
          return original(sql);
        }) as typeof f.db.exec;
        const before = f.state(),
          r = await f.call(url, f.admin, method, body);
        assert.ok(fired, `${change} ${url}`);
        assert.ok([401, 403].includes(r.status), `${change} ${method} ${url}: ${r.status}`);
        assert.deepEqual(f.state(), before);
        f.db.exec = original;
        external
          .prepare('UPDATE users SET role=?,data=? WHERE id=?')
          .run(user.role as string, user.data as string, f.admin.user.id);
        external.prepare('DELETE FROM mfaCredentials WHERE userId=?').run(f.admin.user.id);
        external
          .prepare(
            `INSERT OR REPLACE INTO sessions(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
          )
          .run(...columns.map((key) => session[key]));
      }
  } finally {
    f.db.exec = original;
    external.close();
  }
});

test('source changes committed between middleware and BEGIN are reflected coherently and stale manual execution rolls back', async (t) => {
  clock(t);
  const f = await fixture(t),
    a = f.appointment();
  await f.setPolicy();
  const body = f.command(await f.preview());
  const external = openDatabase(f.databasePath),
    original = f.db.exec.bind(f.db);
  let changed = false;
  f.db.exec = ((sql: string) => {
    if (sql === 'BEGIN IMMEDIATE' && !changed) {
      changed = true;
      external
        .prepare(
          "UPDATE appointments SET time='12:00',data=json_set(data,'$.time','12:00') WHERE id=?",
        )
        .run(a.id);
    }
    return original(sql);
  }) as typeof f.db.exec;
  try {
    const r = await f.call(runPath, f.admin, 'POST', body);
    assert.equal(r.status, 409);
    assert.ok(changed);
    assert.equal(f.state().appointmentReminderRuns, 0);
  } finally {
    f.db.exec = original;
    external.close();
  }
  const p = await f.preview();
  assert.equal(p.items[0].appointment.time, '12:00');
  await f.run();
});

test('nine failed writes roll back policy, run, all recipient notices, evidence, commands and audits together', async (t) => {
  clock(t);
  const points = [
    'policy-row',
    'policy-command',
    'policy-audit',
    'run-row',
    'first-activity',
    'last-activity',
    'last-event',
    'run-audit',
    'run-command',
  ];
  for (const point of points) {
    const f = await fixture(t);
    f.appointment(60);
    f.appointment(90);
    let url: string, body: unknown;
    if (point.startsWith('policy-')) {
      const c = await f.context();
      url = policyPath;
      body = {
        enabled: true,
        leadHours: 24,
        reason: 'Enable',
        expectedRevision: c.revision,
        requestId: randomUUID(),
      };
    } else {
      await f.setPolicy();
      url = runPath;
      body = f.command(await f.preview());
    }
    const table =
      point === 'policy-row'
        ? 'appointmentReminderPolicyChanges'
        : point.endsWith('command')
          ? 'appointmentReminderCommands'
          : point.endsWith('audit')
            ? 'audit'
            : point === 'run-row'
              ? 'appointmentReminderRuns'
              : point === 'last-event'
                ? 'appointmentReminderEvents'
                : 'activity';
    const condition =
      point === 'last-activity'
        ? "(SELECT count(*) FROM activity WHERE eventKey LIKE 'appointment-reminder:%')=1"
        : point === 'first-activity'
          ? "NEW.eventKey LIKE 'appointment-reminder:%'"
          : point === 'last-event'
            ? '(SELECT count(*) FROM appointmentReminderEvents)=1'
            : point === 'policy-audit'
              ? "json_extract(NEW.data,'$.action')='changed appointment reminder policy'"
              : point === 'run-audit'
                ? "json_extract(NEW.data,'$.action')='created appointment reminder notices'"
                : '1';
    f.db.exec(
      `CREATE TRIGGER injected_reminder_failure BEFORE INSERT ON ${table} WHEN ${condition} BEGIN SELECT RAISE(ABORT,'injected atomic failure'); END`,
    );
    const before = f.state(),
      r = await f.call(url, f.admin, 'POST', body);
    assert.equal(r.status, 500, point);
    assert.deepEqual(f.state(), before, point);
    f.db.exec('DROP TRIGGER injected_reminder_failure');
    const retry = await f.call(url, f.admin, 'POST', body);
    assert.equal(retry.status, 201, point);
    await f.close();
  }
});

test('exact notification receipt is required; missing, ignored or wrongly routed insert rolls back the whole run', async (t) => {
  clock(t);
  const f = await fixture(t),
    a = f.appointment();
  await f.setPolicy();
  const p = await f.preview(),
    body = f.command(p);
  // A pre-existing unrelated collision must not be accepted as this run's newly inserted notice.
  const key = `appointment-reminder:${p.items[0].episodeId}:${p.items[0].recipient.id}`;
  const activity = {
    id: randomUUID(),
    kind: 'appointment',
    title: 'Synthetic existing notice',
    detail: 'Existing',
    href: '/my-care',
    createdAt: new Date().toISOString(),
    readAt: null,
  };
  f.db
    .prepare(
      'INSERT INTO activity(id,userId,patientId,audience,eventKey,data) VALUES (?,?,?,?,?,?)',
    )
    .run(
      activity.id,
      p.items[0].recipient.id,
      a.patientId,
      'patient',
      key,
      JSON.stringify(activity),
    );
  const before = f.state();
  assert.equal((await f.call(runPath, f.admin, 'POST', body)).status, 409);
  assert.deepEqual(f.state(), before);
  // Separate source episode permits an insertion, but a database trigger makes its reported ID false.
  f.update(a, { time: '12:00' });
  const next = f.command(await f.preview());
  f.db.exec(
    `CREATE TRIGGER injected_notice_ignore BEFORE INSERT ON activity WHEN NEW.eventKey LIKE 'appointment-reminder:%' BEGIN SELECT RAISE(IGNORE); END`,
  );
  const prior = f.state();
  assert.equal((await f.call(runPath, f.admin, 'POST', next)).status, 409);
  assert.deepEqual(f.state(), prior);
  f.db.exec('DROP TRIGGER injected_notice_ignore');
  assert.equal((await f.call(runPath, f.admin, 'POST', next)).status, 201);
});

test('final live clock rejects start reached and backward movement before due, after all writes, without partial evidence', async (t) => {
  clock(t);
  for (const backwards of [false, true]) {
    t.mock.timers.setTime(now);
    const f = await fixture(t);
    f.appointment(backwards ? 60 : 1);
    await f.setPolicy({ leadHours: 1 });
    const p = await f.preview(),
      body = f.command(p),
      original = f.db.prepare.bind(f.db);
    let moved = false;
    f.db.prepare = ((sql: string) => {
      const statement = original(sql);
      if (sql.startsWith('INSERT INTO appointmentReminderCommands')) {
        const run = statement.run.bind(statement);
        statement.run = ((...params: Parameters<typeof statement.run>) => {
          const result = run(...params);
          moved = true;
          t.mock.timers.setTime(backwards ? now - 1 : now + 60000);
          return result;
        }) as typeof statement.run;
      }
      return statement;
    }) as typeof f.db.prepare;
    const before = f.state();
    try {
      assert.equal((await f.call(runPath, f.admin, 'POST', body)).status, 409);
      assert.ok(moved);
      assert.deepEqual(f.state(), before);
    } finally {
      f.db.prepare = original;
    }
    t.mock.timers.setTime(now);
    assert.equal((await f.call(runPath, f.admin, 'POST', body)).status, 201);
  }
});

test('SQL bounds 205 ready recipients among large unrelated data, preserves earliest ordering and drains backlog without duplicate runs', async (t) => {
  clock(t);
  const f = await fixture(t);
  await f.setPolicy();
  const expected: Appointment[] = [];
  f.db.exec('BEGIN');
  for (let i = 0; i < 205; i++) expected.push(f.appointment(i + 1));
  for (let i = 0; i < 1500; i++)
    f.appointment(30000 + i, { status: i % 2 === 0 ? 'scheduled' : 'cancelled' });
  // Large clinical bodies do not enter candidate selection, hashing or DTO decoding.
  f.db
    .prepare("UPDATE patients SET data=json_set(data,'$.allergies',?) WHERE id='patient-ananya'")
    .run(privateText.repeat(5000));
  f.db.exec('COMMIT');
  const original = f.db.prepare.bind(f.db),
    selected: number[] = [],
    statements: { sql: string; params: Parameters<ReturnType<DB['prepare']>['all']> }[] = [];
  f.db.prepare = ((sql: string) => {
    const statement = original(sql);
    if (sql.includes('FROM candidates WHERE recorded=0 ORDER BY')) {
      assert.match(sql, /LIMIT \?/);
      assert.equal(sql.includes('a.data AS'), false);
      const all = statement.all.bind(statement);
      statement.all = ((...params: Parameters<typeof statement.all>) => {
        const rows = all(...params);
        selected.push(rows.length);
        statements.push({ sql, params });
        return rows;
      }) as typeof statement.all;
    }
    if (/^SELECT data FROM (appointments|users)$/.test(sql)) throw new Error('Unbounded JSON scan');
    return statement;
  }) as typeof f.db.prepare;
  try {
    const p = await f.preview();
    assert.equal(p.readyTotal, 205);
    assert.equal(p.upcomingAppointmentTotal, 205);
    assert.equal(p.items.length, 200);
    assert.deepEqual(
      p.items.map((x) => x.appointment.id),
      expected.slice(0, 200).map((x) => x.id),
    );
    assert.equal(JSON.stringify(p).includes(privateText), false);
    const first = await f.run();
    assert.equal(first.value.noticeCount, 200);
    assert.equal(first.value.remainingReady, 5);
    const second = await f.run();
    assert.equal(second.value.noticeCount, 5);
    assert.equal(second.value.alreadyRecordedTotal, 200);
    assert.equal(second.value.remainingReady, 0);
    assert.equal((await f.preview()).alreadyRecordedTotal, 205);
    assert.ok(selected.every((n) => n <= 200));
    const query = statements[0],
      plan = original(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params);
    assert.match(
      JSON.stringify(plan),
      /SEARCH a USING INDEX (appointment_reminder_window|search_appointments_status_date)/,
    );
    assert.match(
      JSON.stringify(plan),
      /SEARCH u USING INDEX appointment_reminder_patient_accounts_text/,
    );
    assert.doesNotMatch(JSON.stringify(plan), /SCAN u/);
    assert.match(JSON.stringify(plan), /appointment_reminder_identity/);
    const prior = f.state();
    assert.equal(f.app.locals.runAppointmentReminders(), null);
    assert.deepEqual(f.state(), prior);
  } finally {
    f.db.prepare = original;
  }
});

test('bounded history returns metadata-only run pages, explicit timestamp/ID order and clamped pages in one snapshot', async (t) => {
  clock(t);
  const f = await fixture(t);
  let a = f.appointment();
  await f.setPolicy();
  for (let i = 0; i < 27; i++) {
    if (i)
      a = f.update(a, {
        time: `${String(11 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`,
      });
    await f.run();
    await f.setPolicy({ leadHours: 25 + (i % 2) });
  }
  const original = f.db.prepare.bind(f.db);
  let runSummarySeen = false;
  f.db.prepare = ((sql: string) => {
    if (sql.includes('FROM appointmentReminderRuns') && sql.includes('ORDER BY')) {
      assert.match(sql, /json_object/);
      assert.ok(!sql.includes("'events'"));
      assert.match(sql, /ORDER BY createdAt DESC,id DESC LIMIT \? OFFSET \?/);
      runSummarySeen = true;
    }
    return original(sql);
  }) as typeof f.db.prepare;
  try {
    const r = await f.call('/appointment-reminders/runs?page=1000000&pageSize=10', f.admin);
    assert.equal(r.status, 200);
    assert.equal(r.data.page, 3);
    assert.equal(r.data.items.length, 7);
    assert.equal(r.data.total, 27);
    assert.ok(runSummarySeen);
    assert.ok(
      r.data.items.every(
        (item: Record<string, unknown>) => !('events' in item) && typeof item.policy === 'object',
      ),
    );
    const first = await f.call('/appointment-reminders/runs?pageSize=50', f.admin);
    const expected = original(
      'SELECT id FROM appointmentReminderRuns ORDER BY createdAt DESC,id DESC',
    )
      .all()
      .map((row) => row.id);
    assert.deepEqual(
      first.data.items.map((x: { id: string }) => x.id),
      expected,
    );
    const history = await f.call(
      `/appointments/${a.id}/reminders?page=1000000&pageSize=10`,
      f.admin,
    );
    assert.equal(history.data.total, 27);
    assert.equal(history.data.page, 3);
    assert.equal(history.data.items.length, 7);
    const changes = await f.call(`${policyPath}/history?pageSize=10`, f.admin);
    assert.equal(changes.data.total, 28);
    assert.equal(changes.data.items.length, 10);
  } finally {
    f.db.prepare = original;
  }
  // COUNT and page SELECT share a transaction. An external writer cannot insert between them.
  const external = openDatabase(f.databasePath);
  external.exec('PRAGMA busy_timeout=0');
  let locked = false;
  f.db.prepare = ((sql: string) => {
    const statement = original(sql);
    if (sql === 'SELECT count(*) AS n FROM appointmentReminderRuns') {
      const getter = statement.get.bind(statement);
      statement.get = ((...params: Parameters<typeof statement.get>) => {
        const result = getter(...params);
        assert.throws(() => external.exec('BEGIN IMMEDIATE'), /locked/);
        locked = true;
        return result;
      }) as typeof statement.get;
    }
    return statement;
  }) as typeof f.db.prepare;
  try {
    assert.equal((await f.call('/appointment-reminders/runs', f.admin)).status, 200);
    assert.ok(locked);
  } finally {
    f.db.prepare = original;
    external.close();
  }
});

test('automatic worker starts explicitly, runs immediately, uses unref 300-second interval and stops; empty polls only update bounded heartbeat', async (t) => {
  clock(t);
  const f = await fixture(t);
  assert.equal((await f.context()).worker.automaticEnabled, false);
  const priorEnv = process.env.APPOINTMENT_REMINDERS_AUTO;
  delete process.env.APPOINTMENT_REMINDERS_AUTO;
  let callback: (() => unknown) | undefined,
    delay = 0,
    unref = 0,
    cleared = 0;
  const fakeTimer = {
    unref() {
      unref++;
      return this;
    },
  };
  t.mock.method(globalThis, 'setInterval', (fn: () => unknown, ms: number) => {
    callback = fn;
    delay = ms;
    return fakeTimer;
  });
  t.mock.method(globalThis, 'clearInterval', (timer: unknown) => {
    assert.equal(timer, fakeTimer);
    cleared++;
  });
  try {
    const baseline = f.state();
    f.app.locals.startAppointmentReminders();
    assert.equal(delay, 300000);
    assert.equal(unref, 1);
    assert.deepEqual(f.state(), baseline);
    let c = await f.context();
    assert.equal(c.worker.automaticEnabled, true);
    assert.equal(c.worker.lastCheckedAt, new Date().toISOString());
    assert.equal(c.worker.lastRunId, null);
    f.app.locals.startAppointmentReminders();
    assert.equal(unref, 1);
    await f.setPolicy();
    f.appointment();
    callback!();
    c = await f.context();
    assert.ok(c.worker.lastRunId);
    const run = await f.call(`/appointment-reminders/runs/${c.worker.lastRunId}`, f.admin);
    assert.equal(run.data.source, 'automatic');
    assert.equal(run.data.createdById, null);
    assert.equal(run.data.requestId, null);
    assert.equal(run.data.noticeCount, 1);
    const before = f.state();
    for (let i = 0; i < 5; i++) callback!();
    assert.deepEqual(f.state(), before);
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM meta WHERE key='appointment-reminder-worker'").get()!
        .n,
      1,
    );
    f.app.locals.stopAppointmentReminders();
    assert.equal(cleared, 1);
    assert.equal((await f.context()).worker.automaticEnabled, false);
    process.env.APPOINTMENT_REMINDERS_AUTO = 'false';
    f.app.locals.startAppointmentReminders();
    assert.equal(unref, 1);
    assert.match(
      readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8'),
      /APPOINTMENT_REMINDERS_AUTO[^\n]+startAppointmentReminders/,
    );
  } finally {
    if (priorEnv === undefined) delete process.env.APPOINTMENT_REMINDERS_AUTO;
    else process.env.APPOINTMENT_REMINDERS_AUTO = priorEnv;
    f.app.locals.stopAppointmentReminders();
  }
});

test('automatic failure records one generic heartbeat, no partial notices, and later check can recover', async (t) => {
  clock(t);
  const f = await fixture(t);
  await f.setPolicy();
  f.appointment();
  f.db.exec(
    "CREATE TRIGGER fail_auto_audit BEFORE INSERT ON audit WHEN json_extract(NEW.data,'$.action')='created automatic appointment reminder notices' BEGIN SELECT RAISE(ABORT,'PRIVATE_DATABASE_ERROR'); END",
  );
  const messages: string[] = [];
  t.mock.method(console, 'error', (message: string) => messages.push(message));
  const before = f.state();
  assert.equal(f.app.locals.runAppointmentReminders(), null);
  assert.deepEqual(f.state(), before);
  const c = await f.context();
  assert.equal(c.worker.lastErrorAt, new Date().toISOString());
  assert.equal(c.worker.lastRunId, null);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].includes('PRIVATE'), false);
  f.db.exec('DROP TRIGGER fail_auto_audit');
  const run = f.app.locals.runAppointmentReminders() as AppointmentReminderRun;
  assert.equal(run.noticeCount, 1);
  assert.equal((await f.context()).worker.lastRunId, run.id);
});
