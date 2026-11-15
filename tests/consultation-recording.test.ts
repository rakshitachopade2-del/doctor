import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import { addDays, clinicToday, createUser, get, openDatabase, type DB } from '../server/db.ts';
import type { Appointment, Doctor, Encounter, User } from '../shared/types.ts';
import type { EncounterAmendment } from '../shared/clinical.ts';
import type {
  ConsultationNoteInput,
  ConsultationAmendmentInput,
  ConsultationRecordingResult,
} from '../shared/consultation-recording.ts';
import { CONSULTATION_REQUEST_COLLISION } from '../server/consultation-recording.ts';

type Client = { cookie: string; csrf: string; user: User };
async function fixture(t: TestContext, existingPath?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'derma-consultation-recording-')),
    databasePath = existingPath ?? join(directory, 'clinic.sqlite');
  const app = createApp({ databasePath, demoMode: true, production: false }),
    db = app.locals.db as DB;
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
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(who ? { Cookie: who.cookie, 'X-CSRF-Token': who.csrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: res.status,
      data: res.headers.get('content-type')?.includes('application/json')
        ? await res.json()
        : await res.text(),
      headers: res.headers,
    };
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
  const admin = await login('admin');
  function beforeLock(work: () => void) {
    const original = db.exec.bind(db);
    let invoked = false;
    db.exec = ((sql: string) => {
      if (!invoked && sql === 'BEGIN IMMEDIATE') {
        invoked = true;
        work();
      }
      return original(sql);
    }) as DB['exec'];
    return () => {
      db.exec = original;
      assert.equal(invoked, true);
    };
  }
  return { app, db, databasePath, call, login, account, admin, beforeLock, close };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function input(overrides: Partial<ConsultationNoteInput> = {}): ConsultationNoteInput {
  return {
    patientId: 'patient-ananya',
    history: 'PRIVATE_HISTORY_SENTINEL',
    examination: 'PRIVATE_EXAMINATION_SENTINEL',
    assessment: 'PRIVATE_ASSESSMENT_SENTINEL',
    investigations: 'PRIVATE_INVESTIGATIONS_SENTINEL',
    plan: 'PRIVATE_PLAN_SENTINEL',
    reviewedConfirmed: true,
    requestId: randomUUID(),
    ...overrides,
  };
}
function amendment(
  overrides: Partial<ConsultationAmendmentInput> = {},
): ConsultationAmendmentInput {
  return {
    reason: 'PRIVATE_AMENDMENT_REASON_SENTINEL',
    text: 'PRIVATE_AMENDMENT_TEXT_SENTINEL',
    reviewedConfirmed: true,
    requestId: randomUUID(),
    ...overrides,
  };
}
async function create(
  f: Fixture,
  body = input(),
  who = f.admin,
): Promise<ConsultationRecordingResult> {
  const r = await f.call('/consultation-notes', who, 'POST', body);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}
const amendPath = (id: string) => `/encounters/${id}/amendment-recordings`;
async function amend(
  f: Fixture,
  id: string,
  body = amendment(),
  who = f.admin,
): Promise<ConsultationRecordingResult> {
  const r = await f.call(amendPath(id), who, 'POST', body);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}
function state(f: Fixture) {
  return Object.fromEntries(
    ['encounters', 'encounterAmendments', 'consultationRecordingCommands', 'audit', 'activity'].map(
      (table) => [table, f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()],
    ),
  );
}
function storedAppointment(f: Fixture, overrides: Partial<Appointment> = {}) {
  const value: Appointment = {
    id: randomUUID(),
    patientId: 'patient-ananya',
    patientName: 'Synthetic original patient',
    doctorId: 'doctor-meera',
    doctorName: 'Different clinician',
    date: addDays(clinicToday(), -1),
    time: '03:00',
    mode: 'in-person',
    status: 'scheduled',
    reason: 'Synthetic appointment',
    fee: 500,
    createdAt: new Date().toISOString(),
    ...overrides,
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
function noteFields(body: ConsultationNoteInput) {
  const { requestId: _, reviewedConfirmed: __, ...fields } = body;
  return {
    patientId: fields.patientId.trim(),
    ...(fields.appointmentId === undefined ? {} : { appointmentId: fields.appointmentId.trim() }),
    history: fields.history?.trim() ?? '',
    examination: fields.examination?.trim() ?? '',
    assessment: fields.assessment.trim(),
    investigations: fields.investigations?.trim() ?? '',
    plan: fields.plan.trim(),
  };
}

test('reviewed note creation normalizes fields, binds actual actor and clinician, and exact replay produces one original and audit', async (t) => {
  const f = await fixture(t),
    body = input({
      patientId: ' patient-ananya ',
      history: '  Clinical history\nwith details  ',
      examination: undefined,
      investigations: undefined,
    });
  const before = state(f),
    result = await create(f, { ...body, requestId: body.requestId.toUpperCase() });
  assert.deepEqual(result.amendment, null);
  assert.deepEqual(result.encounter, {
    ...noteFields(body),
    id: result.encounter.id,
    doctorId: f.admin.user.doctorId,
    doctorName: get<Doctor>(f.db, 'doctors', f.admin.user.doctorId!)!.name,
    createdAt: result.encounter.createdAt,
  });
  assert.deepEqual(result.receipt, {
    requestId: body.requestId,
    actorId: f.admin.user.id,
    operation: 'create',
    patientId: 'patient-ananya',
    encounterId: result.encounter.id,
    amendmentId: null,
    doctorId: f.admin.user.doctorId,
  });
  assert.equal('reviewedConfirmed' in result.encounter, false);
  assert.equal('requestId' in result.encounter, false);
  const saved = state(f),
    replay = await f.call('/consultation-notes', f.admin, 'POST', body);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data, result);
  assert.deepEqual(state(f), saved);
  assert.equal(saved.encounters.length, before.encounters.length + 1);
  assert.equal(saved.audit.length, before.audit.length + 1);
  assert.deepEqual(saved.activity, before.activity);
  const commands = JSON.stringify(saved.consultationRecordingCommands);
  for (const value of [body.assessment, body.plan, body.history!])
    assert.equal(commands.includes(value), false);
});

test('any current linked clinician can append an attributed amendment without replacing the original author or note', async (t) => {
  const f = await fixture(t),
    original = await create(f),
    doctor = await f.account('doctor', { doctorId: 'doctor-arjun' }),
    body = amendment({ reason: '  Clarification  ', text: '  More specific documentation  ' });
  const result = await amend(f, original.encounter.id, body, doctor);
  assert.deepEqual(result.encounter, original.encounter);
  assert.ok(result.amendment);
  assert.deepEqual(result.amendment, {
    id: result.amendment.id,
    encounterId: original.encounter.id,
    patientId: original.encounter.patientId,
    doctorId: doctor.user.doctorId,
    doctorName: get<Doctor>(f.db, 'doctors', doctor.user.doctorId!)!.name,
    reason: 'Clarification',
    text: 'More specific documentation',
    createdAt: result.amendment.createdAt,
  });
  assert.deepEqual(result.receipt, {
    requestId: body.requestId,
    actorId: doctor.user.id,
    operation: 'amend',
    patientId: original.encounter.patientId,
    encounterId: original.encounter.id,
    amendmentId: result.amendment.id,
    doctorId: doctor.user.doctorId,
  });
  const saved = state(f),
    replay = await f.call(amendPath(original.encounter.id), doctor, 'POST', body);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data, result);
  assert.deepEqual(state(f), saved);
  assert.equal(result.encounter.doctorId, original.encounter.doctorId);
});

test('existing standalone and same-patient appointment rules remain valid for past, future and terminal visits regardless of assigned doctor', async (t) => {
  const f = await fixture(t);
  let index = 0;
  const states = [
    'scheduled',
    'checked-in',
    'in-consultation',
    'completed',
    'cancelled',
    'no-show',
  ] as const;
  for (const status of states) {
    const a = storedAppointment(f, {
      status,
      date: addDays(clinicToday(), index % 2 === 0 ? -20 - index : 20 + index),
      time: '03:00',
    });
    index++;
    const before = f.db.prepare('SELECT * FROM appointments WHERE id=?').get(a.id),
      result = await create(f, input({ appointmentId: a.id }));
    assert.equal(result.encounter.appointmentId, a.id);
    assert.equal(result.encounter.doctorId, f.admin.user.doctorId);
    assert.deepEqual(f.db.prepare('SELECT * FROM appointments WHERE id=?').get(a.id), before);
  }
  const standalone = await create(
    f,
    input({ history: undefined, examination: undefined, investigations: undefined }),
  );
  assert.equal(standalone.encounter.appointmentId, undefined);
  assert.equal(standalone.encounter.history, '');
  assert.equal(standalone.encounter.examination, '');
});

test('strict reviewed schemas reject excess fields, missing confirmation, malformed UUID and overlong content while preserving plain legacy adapters', async (t) => {
  const f = await fixture(t),
    body = input(),
    original = await create(f);
  for (const patch of [
    { reviewedConfirmed: false },
    { reviewedConfirmed: undefined },
    { requestId: 'bad' },
    { unexpected: true },
    { doctorId: 'doctor-arjun' },
    { patientId: '' },
    { appointmentId: '' },
    { assessment: ' ' },
    { plan: '' },
    { history: 'x'.repeat(8001) },
  ]) {
    const r = await f.call('/consultation-notes', f.admin, 'POST', { ...body, ...patch });
    assert.equal(r.status, 400);
    assert.equal(r.data.consultationOutcome, undefined);
  }
  for (const patch of [
    { reviewedConfirmed: false },
    { requestId: 'bad' },
    { doctorId: 'doctor-arjun' },
    { reason: '' },
    { text: '' },
    { text: 'x'.repeat(8001) },
  ]) {
    const r = await f.call(amendPath(original.encounter.id), f.admin, 'POST', {
      ...amendment(),
      ...patch,
    });
    assert.equal(r.status, 400);
    assert.equal(r.data.consultationOutcome, undefined);
  }
  for (const [path, data] of [
    ['/consultation-notes', body],
    [amendPath(original.encounter.id), amendment()],
  ] as const)
    assert.equal((await f.call(`${path}?extra=1`, f.admin, 'POST', data)).status, 400);
  const old = await f.call('/encounters?legacy=ignored', f.admin, 'POST', {
    ...body,
    extra: 'ignored',
    doctorName: 'Do not trust input',
  });
  assert.equal(old.status, 201);
  assert.equal(old.data.receipt, undefined);
  assert.equal(old.data.doctorName, get<Doctor>(f.db, 'doctors', f.admin.user.doctorId!)!.name);
  assert.equal(old.data.extra, undefined);
  const oldAmend = await f.call(
    `/encounters/${old.data.id}/amendments?legacy=ignored`,
    f.admin,
    'POST',
    {
      reason: ' Legacy ',
      text: ' Clarification ',
      requestId: 'ignored-not-uuid',
      extra: 'ignored',
    },
  );
  assert.equal(oldAmend.status, 201);
  assert.equal(oldAmend.data.reason, 'Legacy');
  assert.equal(oldAmend.data.receipt, undefined);
  assert.equal(oldAmend.data.requestId, undefined);
});

test('patient, reception, unlinked, suspended and missing private-source requests cannot obtain definitive recording markers', async (t) => {
  const f = await fixture(t),
    original = await create(f),
    patient = await f.login('patient'),
    reception = await f.login('reception'),
    unlinked = await f.account('admin');
  for (const [path, body] of [
    ['/consultation-notes', input()],
    [amendPath(original.encounter.id), amendment()],
  ] as const) {
    for (const [who, status] of [
      [undefined, 401],
      [patient, 403],
      [reception, 403],
      [unlinked, 400],
    ] as const) {
      const r = await f.call(path, who, 'POST', body);
      assert.equal(r.status, status, JSON.stringify(r.data));
      assert.equal(r.data.consultationOutcome, undefined);
    }
    const badCsrf = await f.call(path, { ...f.admin, csrf: 'wrong' }, 'POST', body);
    assert.equal(badCsrf.status, 403);
    assert.equal(badCsrf.data.consultationOutcome, undefined);
  }
  for (const [path, body] of [
    ['/consultation-notes', input({ patientId: randomUUID() })],
    [amendPath(randomUUID()), amendment()],
  ] as const) {
    const r = await f.call(path, f.admin, 'POST', body);
    assert.equal(r.status, 404);
    assert.equal(r.data.consultationOutcome, undefined);
  }
});

test('invalid linked visits produce a durable known rejection that cannot later record, while a fresh reviewed UUID can succeed', async (t) => {
  const f = await fixture(t),
    missing = randomUUID(),
    body = input({ appointmentId: missing }),
    previous = state(f);
  const r = await f.call('/consultation-notes', f.admin, 'POST', body);
  assert.equal(r.status, 400);
  assert.deepEqual(r.data, {
    error: 'The appointment must belong to this patient.',
    consultationOutcome: 'not-recorded',
    requestId: body.requestId,
    actorId: f.admin.user.id,
    operation: 'create',
    patientId: body.patientId,
    encounterId: null,
  });
  assert.deepEqual(state(f).encounters, previous.encounters);
  assert.deepEqual(state(f).audit, previous.audit);
  storedAppointment(f, { id: missing });
  const saved = state(f),
    replay = await f.call('/consultation-notes', f.admin, 'POST', body);
  assert.equal(replay.status, 400);
  assert.deepEqual(replay.data, r.data);
  assert.deepEqual(state(f), saved);
  const result = await create(f, { ...body, requestId: randomUUID() });
  assert.equal(result.encounter.appointmentId, missing);
  const foreign = storedAppointment(f, { patientId: 'patient-2', time: '04:00' }),
    mismatch = await f.call(
      '/consultation-notes',
      f.admin,
      'POST',
      input({ appointmentId: foreign.id }),
    );
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.data.consultationOutcome, 'not-recorded');
});

test('one shared UUID namespace binds actor, create/amend action, patient, encounter and every normalized clinical field', async (t) => {
  const f = await fixture(t),
    body = input(),
    saved = await create(f, body),
    second = await create(f),
    colleague = await f.account('doctor', { doctorId: 'doctor-arjun' }),
    amendBody = amendment();
  await amend(f, saved.encounter.id, amendBody);
  const cases: Array<[string, Client, unknown]> = [
    ['/consultation-notes', colleague, body],
    ['/consultation-notes', f.admin, { ...body, plan: 'Different plan' }],
    ['/consultation-notes', f.admin, { ...body, patientId: 'patient-2' }],
    [amendPath(saved.encounter.id), f.admin, { ...amendment(), requestId: body.requestId }],
    ['/consultation-notes', f.admin, { ...input(), requestId: amendBody.requestId }],
    [amendPath(second.encounter.id), f.admin, amendBody],
    [amendPath(saved.encounter.id), colleague, amendBody],
    [amendPath(saved.encounter.id), f.admin, { ...amendBody, text: 'Different clarification' }],
  ];
  const previous = state(f);
  for (const [path, who, payload] of cases) {
    const r = await f.call(path, who, 'POST', payload);
    assert.equal(r.status, 409);
    assert.equal(r.data.error, CONSULTATION_REQUEST_COLLISION);
    assert.equal(r.data.consultationOutcome, undefined);
    assert.deepEqual(state(f), previous);
  }
});

test('note/amendment insert, audit and command failures roll back reviewed and legacy writers without false definitive outcomes', async (t) => {
  const f = await fixture(t),
    source = await create(f);
  const cases: Array<{ path: string; body: unknown; tables: string[]; action: string }> = [
    {
      path: '/consultation-notes',
      body: input(),
      tables: ['encounters', 'audit', 'consultationRecordingCommands'],
      action: 'recorded consultation',
    },
    {
      path: amendPath(source.encounter.id),
      body: amendment(),
      tables: ['encounterAmendments', 'audit', 'consultationRecordingCommands'],
      action: 'added consultation amendment',
    },
    {
      path: '/encounters',
      body: input(),
      tables: ['encounters', 'audit'],
      action: 'recorded consultation',
    },
    {
      path: `/encounters/${source.encounter.id}/amendments`,
      body: amendment(),
      tables: ['encounterAmendments', 'audit'],
      action: 'added consultation amendment',
    },
  ];
  for (const item of cases) {
    for (const table of item.tables) {
      const previous = state(f);
      f.db.exec(
        `CREATE TRIGGER consultation_injected_failure BEFORE INSERT ON ${table} ${table === 'audit' ? `WHEN json_extract(NEW.data,'$.action')='${item.action}'` : ''} BEGIN SELECT RAISE(ABORT,'Synthetic clinical recording failure'); END;`,
      );
      const r = await f.call(item.path, f.admin, 'POST', item.body);
      f.db.exec('DROP TRIGGER consultation_injected_failure');
      assert.equal(r.status, 500, `${table}: ${JSON.stringify(r.data)}`);
      assert.equal(r.data.consultationOutcome, undefined);
      assert.deepEqual(state(f), previous);
    }
    assert.equal((await f.call(item.path, f.admin, 'POST', item.body)).status, 201);
  }
});

test('failure while storing a terminal rejected command leaves no marker or partial record and a later exact retry remains safe', async (t) => {
  const f = await fixture(t),
    body = input({ appointmentId: randomUUID() }),
    previous = state(f);
  f.db.exec(
    "CREATE TRIGGER consultation_rejection_failure BEFORE INSERT ON consultationRecordingCommands WHEN NEW.rejection IS NOT NULL BEGIN SELECT RAISE(ABORT,'Synthetic rejection storage failure'); END;",
  );
  const failed = await f.call('/consultation-notes', f.admin, 'POST', body);
  f.db.exec('DROP TRIGGER consultation_rejection_failure');
  assert.equal(failed.status, 500);
  assert.equal(failed.data.consultationOutcome, undefined);
  assert.deepEqual(state(f), previous);
  const rejected = await f.call('/consultation-notes', f.admin, 'POST', body);
  assert.equal(rejected.status, 400);
  assert.equal(rejected.data.consultationOutcome, 'not-recorded');
});

test('all reviewed/legacy writes and successful/rejected replays revalidate current session, MFA, role and linked clinician under lock', async (t) => {
  const f = await fixture(t),
    body = input(),
    source = await create(f, body),
    amendBody = amendment();
  await amend(f, source.encounter.id, amendBody);
  const rejectBody = input({ appointmentId: randomUUID() });
  assert.equal(
    (await f.call('/consultation-notes', f.admin, 'POST', rejectBody)).data.consultationOutcome,
    'not-recorded',
  );
  const rawUser = String(
      f.db.prepare('SELECT data FROM users WHERE id=?').get(f.admin.user.id)!.data,
    ),
    sessions = f.db.prepare('SELECT * FROM sessions WHERE userId=?').all(f.admin.user.id),
    other = openDatabase(f.databasePath);
  t.after(() => other.close());
  const changes = [
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
          .prepare("UPDATE sessions SET csrfToken='new-token' WHERE userId=?")
          .run(f.admin.user.id),
    },
    {
      status: 401,
      apply: () =>
        other
          .prepare(
            'INSERT INTO mfaCredentials(userId,id,secret,enabledAt,lastStep) VALUES (?,?,?,?,?)',
          )
          .run(f.admin.user.id, 'new-factor', 'synthetic', new Date().toISOString(), -1),
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
        other
          .prepare("UPDATE users SET role='receptionist',data=? WHERE id=?")
          .run(
            JSON.stringify({ ...JSON.parse(rawUser), role: 'receptionist', doctorId: undefined }),
            f.admin.user.id,
          ),
    },
    {
      status: 400,
      apply: () =>
        other
          .prepare('UPDATE users SET data=? WHERE id=?')
          .run(JSON.stringify({ ...JSON.parse(rawUser), doctorId: undefined }), f.admin.user.id),
    },
    {
      status: 400,
      apply: () =>
        other
          .prepare('UPDATE users SET data=? WHERE id=?')
          .run(
            JSON.stringify({ ...JSON.parse(rawUser), doctorId: 'missing-profile' }),
            f.admin.user.id,
          ),
    },
  ];
  const requests: Array<[string, unknown]> = [
    ['/consultation-notes', input()],
    [amendPath(source.encounter.id), amendment()],
    ['/consultation-notes', body],
    [amendPath(source.encounter.id), amendBody],
    ['/consultation-notes', rejectBody],
    ['/encounters', input()],
    [`/encounters/${source.encounter.id}/amendments`, amendment()],
  ];
  for (const [path, payload] of requests)
    for (const change of changes) {
      const previous = state(f),
        restore = f.beforeLock(change.apply),
        r = await f.call(path, f.admin, 'POST', payload);
      restore();
      assert.equal(r.status, change.status, `${path}: ${JSON.stringify(r.data)}`);
      assert.equal(r.data.consultationOutcome, undefined);
      assert.deepEqual(state(f), previous);
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
});

test('appointment ownership and recording clinician are resolved from the current committed source rather than a stale pre-lock request', async (t) => {
  const f = await fixture(t),
    a = storedAppointment(f),
    body = input({ appointmentId: a.id }),
    other = openDatabase(f.databasePath);
  t.after(() => other.close());
  const changed = { ...a, patientId: 'patient-2' },
    restore = f.beforeLock(() =>
      other
        .prepare('UPDATE appointments SET patientId=?,data=? WHERE id=?')
        .run(changed.patientId, JSON.stringify(changed), a.id),
    );
  const failed = await f.call('/consultation-notes', f.admin, 'POST', body);
  restore();
  assert.equal(failed.status, 400);
  assert.equal(failed.data.consultationOutcome, 'not-recorded');
  assert.equal(
    f.db
      .prepare("SELECT COUNT(*) n FROM encounters WHERE json_extract(data,'$.appointmentId')=?")
      .get(a.id)!.n,
    0,
  );
  const user = get<User>(f.db, 'users', f.admin.user.id)!,
    source = f.beforeLock(() =>
      other
        .prepare('UPDATE users SET data=? WHERE id=?')
        .run(JSON.stringify({ ...user, doctorId: 'doctor-arjun' }), user.id),
    );
  const recorded = await create(f, input());
  source();
  assert.equal(recorded.encounter.doctorId, 'doctor-arjun');
  assert.equal(recorded.receipt.doctorId, 'doctor-arjun');
});

test('separate application connections serialize concurrent duplicate note and amendment commands while distinct reviewed commands remain distinct', async (t) => {
  const f = await fixture(t),
    other = await fixture(t, f.databasePath),
    body = input();
  const results = await Promise.all([
    f.call('/consultation-notes', f.admin, 'POST', body),
    other.call('/consultation-notes', f.admin, 'POST', body),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 201]);
  assert.deepEqual(results[0].data, results[1].data);
  const encounterId = results[0].data.encounter.id,
    amendBody = amendment();
  const amendments = await Promise.all([
    f.call(amendPath(encounterId), f.admin, 'POST', amendBody),
    other.call(amendPath(encounterId), f.admin, 'POST', amendBody),
  ]);
  assert.deepEqual(amendments.map((r) => r.status).sort(), [200, 201]);
  assert.deepEqual(amendments[0].data, amendments[1].data);
  const different = await Promise.all([
    f.call('/consultation-notes', f.admin, 'POST', { ...body, requestId: randomUUID() }),
    other.call('/consultation-notes', f.admin, 'POST', { ...body, requestId: randomUUID() }),
  ]);
  assert.ok(different.every((r) => r.status === 201));
  assert.notEqual(different[0].data.encounter.id, different[1].data.encounter.id);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM consultationRecordingCommands').get()!.n, 4);
});

test('original note, amendment and receipt survive later amendments, doctor rename and relinking without changing original clinical attribution', async (t) => {
  const f = await fixture(t),
    writer = await f.account('doctor', { doctorId: 'doctor-arjun' }),
    body = input(),
    saved = await create(f, body, writer),
    amendBody = amendment(),
    savedAmendment = await amend(f, saved.encounter.id, amendBody, writer);
  await amend(f, saved.encounter.id, amendment({ text: 'Later independent clarification' }));
  const profile = get<Doctor>(f.db, 'doctors', 'doctor-arjun')!;
  f.db
    .prepare('UPDATE doctors SET data=? WHERE id=?')
    .run(JSON.stringify({ ...profile, name: 'Later professional name' }), profile.id);
  assert.equal(
    (await f.call(`/accounts/${writer.user.id}`, f.admin, 'PATCH', { doctorId: 'doctor-meera' }))
      .status,
    200,
  );
  const currentWriter = await f.login(writer.user.email);
  const noteReplay = await f.call('/consultation-notes', currentWriter, 'POST', body),
    amendReplay = await f.call(amendPath(saved.encounter.id), currentWriter, 'POST', amendBody);
  assert.equal(noteReplay.status, 200);
  assert.deepEqual(noteReplay.data, saved);
  assert.equal(amendReplay.status, 200);
  assert.deepEqual(amendReplay.data, savedAmendment);
  const newNote = await create(f, input(), currentWriter);
  assert.equal(newNote.receipt.doctorId, 'doctor-meera');
});

test('internal text and retry metadata remain absent from patient/reception records, summaries, public responses and patient activity', async (t) => {
  const f = await fixture(t),
    body = input(),
    saved = await create(f, body),
    amendBody = amendment(),
    correction = await amend(f, saved.encounter.id, amendBody),
    patient = await f.login('patient'),
    reception = await f.login('reception');
  const needles = [
    body.assessment,
    body.history!,
    body.plan,
    amendBody.reason,
    amendBody.text,
    body.requestId,
    amendBody.requestId,
  ];
  for (const [path, who] of [
    [`/patients/${body.patientId}`, patient],
    [`/patients/${body.patientId}`, reception],
    [`/patients/${body.patientId}/clinical-workflows`, patient],
    [`/patients/${body.patientId}/care-summary`, patient],
    ['/activity', patient],
    ['/settings', undefined],
    ['/doctors', undefined],
    ['/knowledge', undefined],
  ] as const) {
    const r = await f.call(path, who);
    assert.equal(r.status, who === reception ? 403 : 200, `${path}: ${JSON.stringify(r.data)}`);
    for (const needle of needles)
      assert.equal(JSON.stringify(r.data).includes(needle), false, path);
  }
  const audit = JSON.stringify(f.db.prepare('SELECT * FROM audit').all());
  for (const text of [body.assessment, body.history!, amendBody.reason, amendBody.text])
    assert.equal(audit.includes(text), false);
  const clinicianRecord = await f.call(`/patients/${body.patientId}`, f.admin);
  assert.ok(
    clinicianRecord.data.encounters.some((note: Encounter) => note.id === saved.encounter.id),
  );
  const workflows = await f.call(`/patients/${body.patientId}/clinical-workflows`, f.admin);
  assert.ok(
    workflows.data.amendments.some(
      (note: EncounterAmendment) => note.id === correction.amendment!.id,
    ),
  );
});

test('immutable originals and successful/rejected command records survive application restart and retain indexed exact retry lookup', async (t) => {
  const f = await fixture(t),
    body = input(),
    saved = await create(f, body),
    amendBody = amendment(),
    amended = await amend(f, saved.encounter.id, amendBody),
    rejectBody = input({ appointmentId: randomUUID() }),
    rejected = await f.call('/consultation-notes', f.admin, 'POST', rejectBody);
  for (const table of ['encounters', 'encounterAmendments', 'consultationRecordingCommands']) {
    assert.throws(() => f.db.exec(`UPDATE ${table} SET rowid=rowid`), /append-only|immutable/);
    assert.throws(() => f.db.exec(`DELETE FROM ${table}`), /append-only|immutable/);
  }
  const previous = state(f);
  await f.close();
  const reopened = await fixture(t, f.databasePath);
  assert.deepEqual((await reopened.call('/consultation-notes', f.admin, 'POST', body)).data, saved);
  assert.deepEqual(
    (await reopened.call(amendPath(saved.encounter.id), f.admin, 'POST', amendBody)).data,
    amended,
  );
  assert.deepEqual(
    (await reopened.call('/consultation-notes', f.admin, 'POST', rejectBody)).data,
    rejected.data,
  );
  // Startup/login audit is independent; command/clinical originals must not change during replay.
  for (const table of [
    'encounters',
    'encounterAmendments',
    'consultationRecordingCommands',
    'activity',
  ])
    assert.deepEqual(state(reopened)[table], previous[table]);
  const plan = reopened.db
    .prepare(
      'EXPLAIN QUERY PLAN SELECT actorId,receipt,rejection FROM consultationRecordingCommands WHERE requestId=?',
    )
    .all(body.requestId);
  assert.match(JSON.stringify(plan), /INDEX sqlite_autoindex_consultationRecordingCommands_1/);
});
