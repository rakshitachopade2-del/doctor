import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createApp } from '../server/app.ts';
import { createUser, get, openDatabase, type DB } from '../server/db.ts';
import { backupDatabase } from '../server/backup.ts';
import type { Patient, User } from '../shared/types.ts';
import type { CareSummary } from '../shared/care-summary.ts';
import type { CareSummaryCopyResult } from '../shared/care-summary-copies.ts';
import { syntheticPdf } from './fixtures/report.ts';

const password = 'DemoClinic2026!';
const patientId = 'patient-ananya';
const summaryPath = (id = patientId) => `/patients/${id}/care-summary`;
const copiesPath = (id = patientId) => `${summaryPath(id)}/copies`;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Client = { user: User; cookie: string; csrf: string };

async function fixture(t: TestContext, database?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'derma-summary-copies-'));
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
  async function call(path: string, who?: Client, method = 'GET', body?: unknown) {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(who ? { Cookie: who.cookie, 'X-CSRF-Token': who.csrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    const text = bytes.toString('utf8');
    const data = response.headers.get('content-type')?.includes('application/json')
      ? JSON.parse(text)
      : text;
    return { status: response.status, data, bytes, headers: response.headers };
  }
  async function login(role: string) {
    const result = await call('/auth/login', undefined, 'POST', {
      email: role.includes('@') ? role : `${role}@derma.demo`,
      password,
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return {
      user: result.data.user,
      csrf: result.data.csrfToken,
      cookie: result.headers.get('set-cookie')!.split(';')[0],
    } as Client;
  }
  const admin = await login('admin');
  async function account(role: User['role'], overrides: Partial<User> = {}) {
    const id = randomUUID(),
      email = `${id}@example.test`;
    createUser(
      db,
      { id, email, role, name: `Synthetic ${role}`, active: true, ...overrides },
      password,
    );
    return login(email);
  }
  async function live(who = admin, id = patientId): Promise<CareSummary> {
    const result = await call(summaryPath(id), who);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data;
  }
  async function save(who = admin, id = patientId, revision?: string) {
    const body = {
      expectedRevision: revision ?? (await live(who, id)).revision,
      requestId: randomUUID(),
    };
    const result = await call(copiesPath(id), who, 'POST', body);
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return { ...(result.data as CareSummaryCopyResult), body };
  }
  async function post(path: string, body: unknown, who = admin, expected = 201) {
    const result = await call(path, who, 'POST', body);
    assert.equal(result.status, expected, JSON.stringify(result.data));
    return result.data;
  }
  return { app, db, base, databasePath, call, login, account, admin, live, save, post, close };
}

const count = (db: DB, table: string) =>
  Number(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n);
const counts = (db: DB) =>
  Object.fromEntries(
    ['careSummaryCopies', 'careSummaryCopyCommands', 'audit'].map((table) => [
      table,
      count(db, table),
    ]),
  );

test('own patients and clinicians can save and read the same scope, while anonymous, reception and other patients are denied', async (t) => {
  const f = await fixture(t),
    patient = await f.login('patient'),
    doctor = await f.login('doctor'),
    reception = await f.login('reception');
  const other = await f.account('patient', { patientId: 'patient-2' });
  const saved = await f.save(patient),
    detailPath = `${copiesPath()}/${saved.copy.id}`;
  for (const path of [copiesPath(), detailPath, `${detailPath}/download`]) {
    assert.equal((await f.call(path)).status, 401);
    assert.equal((await f.call(path, reception)).status, 403);
    assert.equal((await f.call(path, other)).status, 403);
    for (const client of [patient, doctor, f.admin]) {
      const result = await f.call(path, client);
      assert.equal(result.status, 200);
      assert.match(result.headers.get('cache-control') ?? '', /no-store/);
      assert.match(result.headers.get('x-robots-tag') ?? '', /noindex/);
    }
  }
  for (const who of [undefined, reception, other])
    assert.equal((await f.call(copiesPath(), who, 'POST', saved.body)).status, who ? 403 : 401);
  const doctorCopy = await f.save(doctor);
  const adminCopy = await f.save();
  assert.deepEqual(saved.copy.savedBy, { name: patient.user.name, role: 'patient' });
  assert.deepEqual(doctorCopy.copy.savedBy, { name: doctor.user.name, role: 'doctor' });
  assert.deepEqual(adminCopy.copy.savedBy, { name: f.admin.user.name, role: 'admin' });
  assert.equal((await f.call(`${copiesPath('patient-2')}/${saved.copy.id}`, f.admin)).status, 404);
  assert.equal(
    (await f.call(`${copiesPath('patient-2')}/${saved.copy.id}/download`, other)).status,
    404,
  );
  assert.equal((await f.call(copiesPath('missing-patient'), f.admin)).status, 404);
});

test('a saved copy has independently verifiable exact UTF-8 bytes and remains frozen after shared records and attribution change', async (t) => {
  const f = await fixture(t),
    patient = get<Patient>(f.db, 'patients', patientId)!;
  f.db
    .prepare('UPDATE patients SET data=? WHERE id=?')
    .run(JSON.stringify({ ...patient, name: 'Synthetic नमस्ते — café patient' }), patientId);
  const source = await f.live(),
    saved = await f.save(f.admin, patientId, source.revision);
  const path = `${copiesPath()}/${saved.copy.id}`;
  const detail = await f.call(path, f.admin),
    download = await f.call(`${path}/download`, f.admin);
  assert.equal(detail.status, 200);
  assert.equal(download.status, 200);
  assert.deepEqual(detail.data.copy, saved.copy);
  assert.deepEqual(download.data, detail.data.summary);
  assert.equal(detail.data.summary.revision, source.revision);
  assert.equal(saved.copy.sourceRevision, source.revision);
  assert.equal(saved.copy.patientName, source.patient.name);
  assert.equal(saved.copy.generatedAt, detail.data.summary.generatedAt);
  assert.deepEqual(
    download.bytes,
    Buffer.from(JSON.stringify(detail.data.summary, null, 2) + '\n', 'utf8'),
  );
  assert.equal(saved.copy.contentSha256, digest(download.bytes));
  assert.equal(saved.copy.byteLength, download.bytes.byteLength);
  assert.equal(download.headers.get('x-content-sha256'), saved.copy.contentSha256);
  assert.equal(Number(download.headers.get('content-length')), saved.copy.byteLength);
  assert.equal(download.headers.get('etag'), null);
  assert.ok(saved.copy.byteLength > download.bytes.toString('utf8').length);
  assert.match(
    download.headers.get('content-disposition') ?? '',
    /^attachment; filename="[^"\r\n]+\.json"$/,
  );
  assert.match(download.headers.get('content-type') ?? '', /application\/json/);
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  f.db
    .prepare('UPDATE patients SET data=? WHERE id=?')
    .run(JSON.stringify({ ...patient, name: 'Later corrected current patient' }), patientId);
  f.db
    .prepare("UPDATE users SET data=json_set(data,'$.name','Later renamed saver') WHERE id=?")
    .run(f.admin.user.id);
  const current = await f.live();
  assert.notEqual(current.revision, source.revision);
  const later = await f.call(`${path}/download`, f.admin);
  assert.deepEqual(later.bytes, download.bytes);
  assert.deepEqual((await f.call(path, f.admin)).data, detail.data);
  const newest = await f.save();
  assert.notEqual(newest.copy.id, saved.copy.id);
  assert.equal(newest.copy.savedBy.name, 'Later renamed saver');
  assert.equal(
    (await f.call(`${copiesPath()}/${newest.copy.id}`, f.admin)).data.summary.patient.name,
    current.patient.name,
  );
});

test('save commands are strict, revision checked and actor/patient/payload bound while UUID normalization preserves an exact replay', async (t) => {
  const f = await fixture(t),
    source = await f.live(),
    requestId = randomUUID();
  const body = { expectedRevision: source.revision, requestId: requestId.toUpperCase() };
  for (const invalid of [
    {},
    { ...body, expectedRevision: undefined },
    { ...body, expectedRevision: 'bad' },
    { ...body, expectedRevision: source.revision.toUpperCase() },
    { ...body, requestId: 'bad' },
    { ...body, summary: source },
    { ...body, savedBy: { name: 'Injected saver', role: 'doctor' } },
  ])
    assert.equal((await f.call(copiesPath(), f.admin, 'POST', invalid)).status, 400);
  assert.equal(
    (await f.call(copiesPath(), { ...f.admin, csrf: 'incorrect' }, 'POST', body)).status,
    403,
  );
  const stale = await f.call(copiesPath(), f.admin, 'POST', {
    ...body,
    expectedRevision: '0'.repeat(64),
  });
  assert.equal(stale.status, 409);
  assert.equal(count(f.db, 'careSummaryCopies'), 0);
  const result = await f.call(copiesPath(), f.admin, 'POST', body);
  assert.equal(result.status, 201);
  assert.deepEqual(result.data.receipt, {
    requestId,
    actorId: f.admin.user.id,
    patientId,
    expectedRevision: source.revision,
    copyId: result.data.copy.id,
  });
  const before = counts(f.db),
    retry = await f.call(copiesPath(), f.admin, 'POST', { ...body, requestId });
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.data, result.data);
  assert.deepEqual(counts(f.db), before);
  const doctor = await f.login('doctor');
  assert.equal((await f.call(copiesPath(), doctor, 'POST', body)).status, 409);
  assert.equal(
    (await f.call(copiesPath(), f.admin, 'POST', { ...body, expectedRevision: '1'.repeat(64) }))
      .status,
    409,
  );
  assert.equal((await f.call(copiesPath('patient-2'), f.admin, 'POST', body)).status, 409);
  assert.equal(count(f.db, 'careSummaryCopies'), 1);
});

test('private notes and unpublished material do not stale saving and never enter a saved patient-facing copy or file bytes', async (t) => {
  const f = await fixture(t),
    doctor = await f.login('doctor'),
    patient = await f.login('patient');
  const documentBytes = syntheticPdf('PRIVATE_FILE_BYTES_SENTINEL');
  const document = await f.post(
    '/documents',
    {
      title: 'Shared PDF metadata',
      originalName: 'synthetic.pdf',
      dataUrl: `data:application/pdf;base64,${documentBytes.toString('base64')}`,
      consent: true,
    },
    patient,
  );
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCeoAAAAASUVORK5CYII=';
  const image = await f.post(
    '/images',
    {
      caption: 'Shared image metadata',
      category: 'clinical',
      consent: true,
      dataUrl: `data:image/png;base64,${png}`,
    },
    patient,
  );
  const investigation = await f.post(
    '/investigations',
    {
      patientId,
      title: 'Shared request',
      kind: 'laboratory',
      reason: 'Synthetic request',
      instructions: 'Shared instructions',
    },
    doctor,
  );
  const result = await f.post(
    `/investigations/${investigation.id}/results`,
    { note: 'Shared patient result', documentIds: [document.id] },
    patient,
  );
  const review = await f.post(
    `/investigations/${investigation.id}/reviews`,
    {
      resultId: result.results[0].id,
      summary: 'PRIVATE_UNPUBLISHED_REVIEW',
      publishToPatient: false,
    },
    doctor,
  );
  const source = await f.live(patient);
  const encounter = await f.post(
    '/encounters',
    { patientId, assessment: 'PRIVATE_ENCOUNTER_ASSESSMENT', plan: 'PRIVATE_ENCOUNTER_PLAN' },
    doctor,
  );
  await f.post(
    `/encounters/${encounter.id}/amendments`,
    { reason: 'PRIVATE_AMENDMENT_REASON', text: 'PRIVATE_AMENDMENT_TEXT' },
    doctor,
  );
  await f.post('/messages', { patientId, body: 'PRIVATE_MESSAGE_THREAD' }, doctor);
  const annotations = await f.call(`/images/${image.id}/annotations`, doctor);
  await f.post(
    `/images/${image.id}/annotations`,
    { expectedRevision: annotations.data.revision, note: 'PRIVATE_IMAGE_ANNOTATION', markers: [] },
    doctor,
  );
  const after = await f.live(patient);
  assert.equal(after.revision, source.revision);
  const saved = await f.save(patient, patientId, source.revision);
  const downloaded = await f.call(`${copiesPath()}/${saved.copy.id}/download`, patient);
  assert.equal(downloaded.status, 200);
  for (const secret of [
    'PRIVATE_',
    png,
    documentBytes.toString('base64'),
    '"dataUrl"',
    '"bytes"',
    '"encounters"',
    '"messages"',
    '"amendments"',
  ])
    assert.ok(!downloaded.bytes.toString('utf8').includes(secret), secret);
  assert.ok(downloaded.data.documents.some((entry: { id: string }) => entry.id === document.id));
  assert.ok(downloaded.data.images.some((entry: { id: string }) => entry.id === image.id));
  assert.deepEqual(
    downloaded.data.investigations.find((entry: { id: string }) => entry.id === investigation.id)
      .reviews,
    [],
  );
  await f.post(
    `/investigations/${investigation.id}/reviews/${review.reviews[0].id}/publish`,
    {},
    doctor,
    200,
  );
  assert.equal(
    (
      await f.call(copiesPath(), patient, 'POST', {
        expectedRevision: source.revision,
        requestId: randomUUID(),
      })
    ).status,
    409,
  );
  const newer = await f.save(patient);
  const newerDetail = await f.call(`${copiesPath()}/${newer.copy.id}`, patient);
  assert.ok(
    JSON.stringify(newerDetail.data.summary).includes('PRIVATE_UNPUBLISHED_REVIEW'),
    'explicit publication makes the recorded review patient-visible',
  );
  assert.deepEqual(
    (await f.call(`${copiesPath()}/${saved.copy.id}/download`, patient)).bytes,
    downloaded.bytes,
  );
});

test('save, command receipt and audit failures are atomic and a failed request can be retried without a partial copy', async (t) => {
  for (const failure of ['copy', 'command', 'audit']) {
    const f = await fixture(t),
      source = await f.live(),
      body = { expectedRevision: source.revision, requestId: randomUUID() };
    const table =
      failure === 'copy'
        ? 'careSummaryCopies'
        : failure === 'command'
          ? 'careSummaryCopyCommands'
          : 'audit';
    const condition =
      failure === 'audit' ? " WHEN json_extract(NEW.data,'$.entityType')='care-summary-copy'" : '';
    f.db.exec(
      `CREATE TRIGGER synthetic_copy_failure BEFORE INSERT ON ${table}${condition} BEGIN SELECT RAISE(ABORT,'Synthetic saved-copy failure'); END;`,
    );
    const before = counts(f.db),
      failed = await f.call(copiesPath(), f.admin, 'POST', body);
    assert.equal(failed.status, 500);
    assert.equal(failed.headers.get('content-disposition'), null);
    assert.equal(failed.data.copy, undefined);
    assert.deepEqual(counts(f.db), before);
    f.db.exec('DROP TRIGGER synthetic_copy_failure');
    const retry = await f.call(copiesPath(), f.admin, 'POST', body);
    assert.equal(retry.status, 201);
    assert.equal(count(f.db, 'careSummaryCopies'), 1);
    assert.equal(count(f.db, 'careSummaryCopyCommands'), 1);
    assert.equal(retry.data.receipt.requestId, body.requestId);
  }
});

test('read audit failures prevent list, detail and byte responses without leaking a successful attachment', async (t) => {
  const f = await fixture(t),
    saved = await f.save();
  f.db.exec(
    "CREATE TRIGGER synthetic_copy_read_failure BEFORE INSERT ON audit WHEN json_extract(NEW.data,'$.entityType')='care-summary-copy' BEGIN SELECT RAISE(ABORT,'Synthetic copy read audit failure'); END;",
  );
  const before = counts(f.db);
  for (const path of [
    copiesPath(),
    `${copiesPath()}/${saved.copy.id}`,
    `${copiesPath()}/${saved.copy.id}/download`,
  ]) {
    const result = await f.call(path, f.admin);
    assert.equal(result.status, 500);
    assert.equal(result.headers.get('content-disposition'), null);
    assert.equal(result.data.copy, undefined);
    assert.equal(result.data.summary, undefined);
    assert.ok(!result.bytes.toString('utf8').includes(saved.copy.contentSha256));
  }
  assert.deepEqual(counts(f.db), before);
  f.db.exec('DROP TRIGGER synthetic_copy_read_failure');
  assert.equal((await f.call(`${copiesPath()}/${saved.copy.id}/download`, f.admin)).status, 200);
});

test('every saved-copy path rechecks current session, account, CSRF and MFA inside the transaction, including exact retries', async (t) => {
  for (const change of [
    'revoked',
    'expired',
    'csrf',
    'inactive',
    'temporary',
    'role',
    'mfa',
  ] as const) {
    for (const operation of ['list', 'detail', 'download', 'save', 'retry'] as const) {
      const f = await fixture(t),
        saved = await f.save(),
        external = openDatabase(f.databasePath);
      const original = f.db.exec.bind(f.db);
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
              .run('concurrently-replaced-csrf', f.admin.user.id);
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
                'INSERT INTO mfaCredentials(userId,id,secret,enabledAt,lastStep) VALUES(?,?,?,?,?)',
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
        const path =
          operation === 'detail' || operation === 'download'
            ? `${copiesPath()}/${saved.copy.id}${operation === 'download' ? '/download' : ''}`
            : copiesPath();
        const before = counts(f.db);
        const response = await f.call(
          path,
          f.admin,
          operation === 'save' || operation === 'retry' ? 'POST' : 'GET',
          operation === 'retry'
            ? saved.body
            : operation === 'save'
              ? { ...saved.body, requestId: randomUUID() }
              : undefined,
        );
        assert.equal(injected, true, `${change} ${operation}`);
        assert.equal(
          response.status,
          change === 'temporary' || change === 'role' ? 403 : 401,
          `${change} ${operation}: ${JSON.stringify(response.data)}`,
        );
        assert.equal(response.headers.get('content-disposition'), null);
        assert.equal(response.data.copy, undefined);
        assert.equal(response.data.summary, undefined);
        assert.equal(response.data.receipt, undefined);
        assert.deepEqual(counts(f.db), before);
      } finally {
        f.db.exec = original;
        external.close();
      }
    }
  }
});

test('a patient account moved to another record loses access under the same lock on saved reads, new writes and retries', async (t) => {
  for (const operation of ['list', 'detail', 'download', 'save', 'retry']) {
    const f = await fixture(t),
      patient = await f.login('patient'),
      saved = await f.save(patient);
    const external = openDatabase(f.databasePath),
      original = f.db.exec.bind(f.db);
    let changed = false;
    f.db.exec = ((sql: string) => {
      if (sql === 'BEGIN IMMEDIATE' && !changed) {
        changed = true;
        external
          .prepare("UPDATE users SET data=json_set(data,'$.patientId','patient-2') WHERE id=?")
          .run(patient.user.id);
      }
      return original(sql);
    }) as typeof f.db.exec;
    try {
      const path =
        operation === 'detail' || operation === 'download'
          ? `${copiesPath()}/${saved.copy.id}${operation === 'download' ? '/download' : ''}`
          : copiesPath();
      const before = counts(f.db);
      const response = await f.call(
        path,
        patient,
        operation === 'save' || operation === 'retry' ? 'POST' : 'GET',
        operation === 'retry'
          ? saved.body
          : operation === 'save'
            ? { ...saved.body, requestId: randomUUID() }
            : undefined,
      );
      assert.equal(changed, true);
      assert.equal(response.status, 403, operation);
      assert.equal(response.data.copy, undefined);
      assert.equal(response.data.summary, undefined);
      assert.equal(response.headers.get('content-disposition'), null);
      assert.deepEqual(counts(f.db), before);
    } finally {
      f.db.exec = original;
      external.close();
    }
  }
});

test('a source change committed after middleware rejects the old revision and uses fresh attribution on a reviewed save', async (t) => {
  const f = await fixture(t),
    source = await f.live(),
    body = { expectedRevision: source.revision, requestId: randomUUID() };
  const external = openDatabase(f.databasePath),
    original = f.db.exec.bind(f.db);
  let changed = false;
  f.db.exec = ((sql: string) => {
    if (sql === 'BEGIN IMMEDIATE' && !changed) {
      changed = true;
      external
        .prepare("UPDATE patients SET data=json_set(data,'$.phone','9000000071') WHERE id=?")
        .run(patientId);
    }
    return original(sql);
  }) as typeof f.db.exec;
  try {
    const before = counts(f.db),
      response = await f.call(copiesPath(), f.admin, 'POST', body);
    assert.equal(changed, true);
    assert.equal(response.status, 409);
    assert.deepEqual(counts(f.db), before);
  } finally {
    f.db.exec = original;
  }
  const reviewed = await f.live();
  changed = false;
  f.db.exec = ((sql: string) => {
    if (sql === 'BEGIN IMMEDIATE' && !changed) {
      changed = true;
      external
        .prepare("UPDATE users SET data=json_set(data,'$.name','Current saver label') WHERE id=?")
        .run(f.admin.user.id);
    }
    return original(sql);
  }) as typeof f.db.exec;
  try {
    const response = await f.call(copiesPath(), f.admin, 'POST', {
      ...body,
      expectedRevision: reviewed.revision,
    });
    assert.equal(changed, true);
    assert.equal(response.status, 201);
    assert.equal(response.data.copy.savedBy.name, 'Current saver label');
    const audit = f.db
      .prepare(
        "SELECT data FROM audit WHERE json_extract(data,'$.action')='saved patient-facing care summary copy' ORDER BY rowid DESC LIMIT 1",
      )
      .get()!;
    assert.equal(JSON.parse(String(audit.data)).actorName, 'Current saver label');
  } finally {
    f.db.exec = original;
    external.close();
  }
});

test('metadata paging is bounded and patient-scoped, and historical reads or exact retries do not rebuild the live summary', async (t) => {
  const f = await fixture(t),
    source = await f.live();
  const saved = [];
  for (let index = 0; index < 27; index++)
    saved.push(await f.save(f.admin, patientId, source.revision));
  await f.save(f.admin, 'patient-2');
  const prepare = f.db.prepare.bind(f.db);
  let metadataPageRows = 0;
  f.db.prepare = ((sql: string) => {
    assert.ok(
      !/FROM\s+carePlans\b/i.test(sql),
      'historical access must not invoke the live summary builder',
    );
    const statement = prepare(sql);
    if (/FROM\s+careSummaryCopies\b/i.test(sql) && /\bLIMIT\b/i.test(sql)) {
      assert.ok(!/\bbody\b/i.test(sql), 'metadata pages must not load saved file bytes');
      const all = statement.all.bind(statement);
      statement.all = ((...parameters: Parameters<typeof statement.all>) => {
        const rows = all(...parameters);
        metadataPageRows = Math.max(metadataPageRows, rows.length);
        return rows;
      }) as typeof statement.all;
    }
    return statement;
  }) as typeof f.db.prepare;
  try {
    const first = await f.call(`${copiesPath()}?pageSize=10`, f.admin),
      last = await f.call(`${copiesPath()}?page=999999&pageSize=10`, f.admin);
    assert.equal(first.status, 200);
    assert.equal(last.status, 200);
    assert.deepEqual(
      [first.data.page, first.data.total, first.data.totalPages, first.data.items.length],
      [1, 27, 3, 10],
    );
    assert.deepEqual(
      [last.data.page, last.data.total, last.data.totalPages, last.data.items.length],
      [3, 27, 3, 7],
    );
    assert.ok(metadataPageRows > 0 && metadataPageRows <= 10);
    assert.ok(
      first.data.items.every(
        (copy: { id: string }) =>
          !last.data.items.some((other: { id: string }) => copy.id === other.id),
      ),
    );
    for (const row of first.data.items) {
      assert.equal(row.patientId, patientId);
      for (const key of ['summary', 'body', 'receipt', 'requestId', 'actorId'])
        assert.equal(key in row, false);
      assert.deepEqual(Object.keys(row.savedBy).sort(), ['name', 'role']);
    }
    const detail = await f.call(`${copiesPath()}/${saved[0].copy.id}`, f.admin);
    const download = await f.call(`${copiesPath()}/${saved[0].copy.id}/download`, f.admin);
    assert.equal(detail.status, 200);
    assert.equal(download.status, 200);
    const replay = await f.call(copiesPath(), f.admin, 'POST', saved[0].body);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.data.copy, saved[0].copy);
    assert.equal((await f.call(copiesPath('patient-2'), f.admin)).data.total, 1);
  } finally {
    f.db.prepare = prepare;
  }
  const empty = await f.call(copiesPath('patient-3'), f.admin);
  assert.equal(empty.status, 200);
  assert.deepEqual(
    [empty.data.page, empty.data.total, empty.data.totalPages, empty.data.items.length],
    [1, 0, 1, 0],
  );
});

test('copy list count and rows use one locked snapshot and strict queries cannot broaden scope', async (t) => {
  const f = await fixture(t),
    saved = await f.save();
  for (const query of [
    'page=0',
    'page=1000001',
    'page=1.2',
    'pageSize=100',
    'pageSize=1',
    'unknown=true',
    'patientId=patient-2',
    'page=1&page=2',
  ])
    assert.equal((await f.call(`${copiesPath()}?${query}`, f.admin)).status, 400, query);
  for (const path of [
    copiesPath(),
    `${copiesPath()}/${saved.copy.id}`,
    `${copiesPath()}/${saved.copy.id}/download`,
  ]) {
    if (path !== copiesPath())
      assert.equal(
        (await f.call(`${path}?revision=${saved.copy.sourceRevision}`, f.admin)).status,
        400,
      );
  }
  assert.equal(
    (await f.call(`${copiesPath()}?unknown=x`, f.admin, 'POST', saved.body)).status,
    400,
  );
  assert.equal((await f.call(`${copiesPath()}/not-found`, f.admin)).status, 404);
  assert.equal((await f.call(`${copiesPath()}/not-found/download`, f.admin)).status, 404);
  const external = openDatabase(f.databasePath),
    prepare = f.db.prepare.bind(f.db);
  external.exec('PRAGMA busy_timeout=0');
  let checked = false;
  f.db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (/SELECT\s+count\(\*\).*FROM\s+careSummaryCopies/i.test(sql)) {
      const get = statement.get.bind(statement);
      statement.get = ((...parameters: Parameters<typeof statement.get>) => {
        const value = get(...parameters);
        checked = true;
        assert.throws(() => external.exec('BEGIN IMMEDIATE'), /locked/i);
        return value;
      }) as typeof statement.get;
    }
    return statement;
  }) as typeof f.db.prepare;
  try {
    const result = await f.call(copiesPath(), f.admin);
    assert.equal(checked, true);
    assert.equal(result.status, 200);
    assert.equal(result.data.total, result.data.items.length);
  } finally {
    f.db.prepare = prepare;
    external.close();
  }
});

test('concurrent requests save once, and restart or restored backups preserve original receipts and bytes after later changes', async (t) => {
  const first = await fixture(t),
    second = await fixture(t, first.databasePath),
    source = await first.live();
  const body = { expectedRevision: source.revision, requestId: randomUUID() };
  const results = await Promise.all([
    first.call(copiesPath(), first.admin, 'POST', body),
    second.call(copiesPath(), second.admin, 'POST', body),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 201]);
  assert.deepEqual(results[0].data, results[1].data);
  assert.equal(count(first.db, 'careSummaryCopies'), 1);
  assert.equal(count(first.db, 'careSummaryCopyCommands'), 1);
  const saved = results[0].data as CareSummaryCopyResult;
  const download = await first.call(`${copiesPath()}/${saved.copy.id}/download`, first.admin);
  const backupPath = join(dirname(first.databasePath), 'saved-copy-backup.sqlite');
  await backupDatabase(first.databasePath, backupPath);
  first.db
    .prepare("UPDATE patients SET data=json_set(data,'$.phone','9000000072') WHERE id=?")
    .run(patientId);
  await second.close();
  await first.close();
  const restarted = await fixture(t, first.databasePath),
    before = counts(restarted.db);
  const replay = await restarted.call(copiesPath(), restarted.admin, 'POST', body);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data, saved);
  assert.deepEqual(counts(restarted.db), before);
  assert.deepEqual(
    (await restarted.call(`${copiesPath()}/${saved.copy.id}/download`, restarted.admin)).bytes,
    download.bytes,
  );
  const live = await restarted.live();
  assert.notEqual(live.revision, saved.copy.sourceRevision);
  const fresh = await restarted.save();
  assert.notEqual(fresh.copy.contentSha256, saved.copy.contentSha256);
  await restarted.close();
  const restored = await fixture(t, backupPath);
  assert.equal(
    (await restored.live()).revision,
    source.revision,
    'the backup excludes subsequent live edits',
  );
  assert.deepEqual(
    (await restored.call(`${copiesPath()}/${saved.copy.id}/download`, restored.admin)).bytes,
    download.bytes,
  );
  const restoredRetry = await restored.call(copiesPath(), restored.admin, 'POST', body);
  assert.equal(restoredRetry.status, 200);
  assert.deepEqual(restoredRetry.data, saved);
  assert.equal(count(restored.db, 'careSummaryCopies'), 1);
  assert.throws(() => restored.db.exec('UPDATE careSummaryCopies SET body=body'), /immutable/i);
  assert.throws(() => restored.db.exec('DELETE FROM careSummaryCopyCommands'), /immutable/i);
  await restored.close();
});

test('saved metadata, bytes and command receipts are immutable and historical copies stay accessible when optional modules pause', async (t) => {
  const f = await fixture(t),
    patient = await f.login('patient'),
    saved = await f.save(patient);
  const original = await f.call(`${copiesPath()}/${saved.copy.id}/download`, patient);
  for (const sql of [
    'UPDATE careSummaryCopies SET data=data',
    'UPDATE careSummaryCopies SET body=body',
    'DELETE FROM careSummaryCopies',
    'UPDATE careSummaryCopyCommands SET payload=payload',
    'DELETE FROM careSummaryCopyCommands',
  ])
    assert.throws(() => f.db.exec(sql), /immutable|append.only/i);
  const settings = await f.call('/settings', f.admin, 'PATCH', {
    modules: { intake: false, images: false, followUp: false },
  });
  assert.equal(settings.status, 200);
  assert.equal((await f.call(copiesPath(), patient)).status, 200);
  assert.deepEqual(
    (await f.call(`${copiesPath()}/${saved.copy.id}/download`, patient)).bytes,
    original.bytes,
  );
  const retry = await f.call(copiesPath(), patient, 'POST', saved.body);
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.data.copy, saved.copy);
  const stored = f.db.prepare('SELECT body FROM careSummaryCopies WHERE id=?').get(saved.copy.id)!;
  assert.deepEqual(Buffer.from(stored.body as Uint8Array), original.bytes);
});

test('the 10 MiB cap measures exact UTF-8 output and an oversized summary leaves no copy or consumed command', async (t) => {
  const f = await fixture(t),
    originalPatient = get<Patient>(f.db, 'patients', patientId)!;
  const hugeName = 'é'.repeat(5 * 1024 * 1024 + 1);
  assert.ok(
    hugeName.length < 10 * 1024 * 1024 && Buffer.byteLength(hugeName, 'utf8') > 10 * 1024 * 1024,
  );
  f.db
    .prepare('UPDATE patients SET data=? WHERE id=?')
    .run(JSON.stringify({ ...originalPatient, name: hugeName }), patientId);
  const source = await f.live(),
    body = { expectedRevision: source.revision, requestId: randomUUID() },
    before = counts(f.db);
  const failed = await f.call(copiesPath(), f.admin, 'POST', body);
  assert.equal(failed.status, 413);
  assert.equal(failed.data.copy, undefined);
  assert.equal(failed.headers.get('content-disposition'), null);
  assert.deepEqual(counts(f.db), before);
  f.db
    .prepare('UPDATE patients SET data=? WHERE id=?')
    .run(JSON.stringify(originalPatient), patientId);
  const current = await f.live();
  const retry = await f.call(copiesPath(), f.admin, 'POST', {
    ...body,
    expectedRevision: current.revision,
  });
  assert.equal(retry.status, 201);
  assert.equal(retry.data.receipt.requestId, body.requestId);
  assert.equal(count(f.db, 'careSummaryCopies'), 1);
});
