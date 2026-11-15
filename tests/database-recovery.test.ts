import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash, createCipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { createApp } from '../server/app.ts';
import { openDatabase, seedDemo, type DB } from '../server/db.ts';
import { syntheticPdf } from './fixtures/report.ts';

const key = Buffer.from('71'.repeat(32), 'hex');
const secret = 'JBSWY3DPEHPK3PXP';
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const quoted = (value: string) => `"${value.replaceAll('"', '""')}"`;
const scalar = (value: unknown) =>
  value instanceof Uint8Array ? { bytes: Buffer.from(value).toString('hex') } : value;
function snapshot(db: DatabaseSync) {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  return Object.fromEntries(
    tables.map(({ name }) => {
      const rows = db
        .prepare(`SELECT * FROM ${quoted(String(name))}`)
        .all()
        .map((row) =>
          Object.fromEntries(Object.entries(row).map(([key, value]) => [key, scalar(value)])),
        );
      rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      return [String(name), rows];
    }),
  );
}
function readIsolated<T>(path: string, read: (db: DatabaseSync) => T) {
  // Even a read-only SQLite connection may create sidecars for a WAL-mode header.
  // Inspect a byte copy so the test itself does not alter the protected source.
  const directory = mkdtempSync(join(tmpdir(), 'derma-recovery-inspect-'));
  const copy = join(directory, 'inspection.sqlite');
  writeFileSync(copy, readFileSync(path));
  const db = new DatabaseSync(copy, { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
function inspect(path: string) {
  return readIsolated(path, snapshot);
}
function sealed(userId: string, purpose: string, value: unknown) {
  const nonce = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(JSON.stringify(['mfa-v1', userId, purpose])));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return JSON.stringify({
    version: 1,
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  });
}
function addProtectedData(db: DB) {
  const now = Date.now(),
    enabledAt = new Date(now - 86400000).toISOString();
  const credentials = [
    { userId: 'user-admin', id: randomUUID(), lastStep: 1 },
    { userId: 'user-doctor', id: randomUUID(), lastStep: Math.floor(now / 30000) + 1000 },
  ];
  const credential = db.prepare(
    'INSERT INTO mfaCredentials(userId,id,secret,enabledAt,lastStep) VALUES(?,?,?,?,?)',
  );
  for (const value of credentials) {
    credential.run(
      value.userId,
      value.id,
      sealed(value.userId, `credential:${value.id}`, secret),
      enabledAt,
      value.lastStep,
    );
    db.prepare(
      'INSERT INTO mfaRecoveryCodes(codeHash,userId,credentialId,usedAt) VALUES(?,?,?,?)',
    ).run(digest(Buffer.from(`${value.id}:unused`)), value.userId, value.id, null);
    db.prepare(
      'INSERT INTO mfaRecoveryCodes(codeHash,userId,credentialId,usedAt) VALUES(?,?,?,?)',
    ).run(digest(Buffer.from(`${value.id}:used`)), value.userId, value.id, enabledAt);
    db.prepare('INSERT INTO mfaEpochs(userId,version) VALUES(?,7)').run(value.userId);
    db.prepare('INSERT INTO mfaAttempts(userId,windowStart,failures) VALUES(?,?,9)').run(
      value.userId,
      now,
    );
  }
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run(
    'mfa-key-check-v1',
    createHmac('sha256', key).update('mfa-key-check-v1').digest('hex'),
  );
  const eventId = randomUUID(),
    sessionHash = digest(Buffer.from('synthetic-old-session'));
  db.prepare(
    'INSERT INTO sessions(tokenHash,userId,csrfToken,expiresAt,createdAt,label,mfaCredentialId) VALUES(?,?,?,?,?,?,?)',
  ).run(
    sessionHash,
    'user-admin',
    'synthetic-old-csrf',
    now + 3600000,
    now,
    'Browser session',
    credentials[0].id,
  );
  db.prepare(
    'INSERT INTO recoveryGrants(tokenHash,userId,createdAt,expiresAt) VALUES(?,?,?,?)',
  ).run(digest(Buffer.from('synthetic-recovery-grant')), 'user-patient', now, now + 1800000);
  db.prepare('INSERT INTO mfaEvents(id,userId,operation,data) VALUES(?,?,?,?)').run(
    eventId,
    'user-admin',
    'recovery-codes-prepared',
    JSON.stringify({ id: eventId, privateSyntheticMarker: 'Immutable MFA command evidence' }),
  );
  const pendingId = randomUUID();
  db.prepare(
    'INSERT INTO mfaPending(id,userId,sessionHash,kind,expiresAt,fingerprint,payload,eventId) VALUES(?,?,?,?,?,?,?,?)',
  ).run(
    pendingId,
    'user-admin',
    sessionHash,
    'recovery-codes',
    now + 600000,
    'synthetic-fingerprint',
    sealed('user-admin', `pending:${pendingId}`, { recoveryCodes: ['SYNTHETIC-UNCONFIRMED-CODE'] }),
    eventId,
  );
  db.prepare(
    'INSERT INTO mfaCommands(requestId,userId,sessionHash,operation,binding,eventId,pendingId) VALUES(?,?,?,?,?,?,?)',
  ).run(
    randomUUID(),
    'user-admin',
    sessionHash,
    'recovery-codes-prepared',
    'synthetic-binding',
    eventId,
    pendingId,
  );
  db.prepare(
    'INSERT INTO mfaChallenges(tokenHash,userId,credentialId,csrfToken,fingerprint,expiresAt) VALUES(?,?,?,?,?,?)',
  ).run(
    digest(Buffer.from('synthetic-old-challenge')),
    'user-admin',
    credentials[0].id,
    'synthetic-factor-csrf',
    'synthetic-password-fingerprint',
    now + 300000,
  );
  db.prepare(
    'INSERT INTO authRateLimits(scope,subjectHash,windowStart,attempts,throttleLogged) VALUES(?,?,?,?,?)',
  ).run('identifier:login', 'a'.repeat(64), now, 10, 1);

  const imageId = randomUUID(),
    imageBytes = Buffer.from([0, 255, 47, 10, 0, 128, 88]);
  db.prepare('INSERT INTO images(id,patientId,data,bytes) VALUES(?,?,?,?)').run(
    imageId,
    'patient-ananya',
    '{ "id": "' +
      imageId +
      '", "patientId":"patient-ananya", "caption":"Synthetic frozen image — मराठी" }\n',
    imageBytes,
  );
  const documentId = randomUUID(),
    pdf = Buffer.from(syntheticPdf('Synthetic recovery PDF'));
  db.prepare('INSERT INTO documents(id,patientId,data,bytes) VALUES(?,?,?,?)').run(
    documentId,
    'patient-ananya',
    JSON.stringify({
      id: documentId,
      patientId: 'patient-ananya',
      title: 'Synthetic report',
      sha256: digest(pdf),
      sizeBytes: pdf.length,
    }),
    pdf,
  );
  const copyId = randomUUID(),
    body = Buffer.from(
      '{\n  "schemaVersion": 1,\n  "synthetic": "Frozen JSON — untouched",\n  "patient": {"id":"patient-ananya"}\n}\n',
    );
  db.prepare('INSERT INTO careSummaryCopies(id,patientId,savedAt,data,body) VALUES(?,?,?,?,?)').run(
    copyId,
    'patient-ananya',
    enabledAt,
    JSON.stringify({
      id: copyId,
      patientId: 'patient-ananya',
      sourceRevision: 'b'.repeat(64),
      generatedAt: enabledAt,
      savedAt: enabledAt,
      contentSha256: digest(body),
      byteLength: body.length,
      savedBy: { name: 'Synthetic patient', role: 'patient' },
    }),
    body,
  );
  db.prepare(
    'INSERT INTO careSummaryCopyCommands(requestId,actorId,operation,payload,copyId) VALUES(?,?,?,?,?)',
  ).run(
    randomUUID(),
    'user-patient',
    'save',
    JSON.stringify({ patientId: 'patient-ananya', expectedRevision: 'b'.repeat(64) }),
    copyId,
  );
}
function fixture(t: TestContext, legacy = false) {
  const directory = mkdtempSync(join(tmpdir(), 'derma-recovery-'));
  const source = join(directory, 'source.sqlite'),
    destination = join(directory, 'recovered', 'clinic.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  if (legacy) {
    const db = openDatabase(source);
    seedDemo(db);
    db.prepare('INSERT INTO sessions(tokenHash,userId,csrfToken,expiresAt) VALUES(?,?,?,?)').run(
      'legacy-session',
      'user-admin',
      'legacy-csrf',
      Date.now() + 3600000,
    );
    db.close();
  } else {
    const app = createApp({
      databasePath: source,
      demoMode: true,
      production: false,
      mfaEncryptionKey: key.toString('hex'),
    });
    try {
      addProtectedData(app.locals.db as DB);
    } finally {
      app.locals.close();
    }
  }
  return { directory, source, destination };
}
function unchanged(source: string, bytes: Buffer) {
  assert.deepEqual(readFileSync(source), bytes);
  for (const suffix of ['-wal', '-shm', '-journal'])
    assert.equal(existsSync(source + suffix), false);
}
function noPartial(destination: string) {
  assert.equal(existsSync(destination), false);
  const parent = dirname(destination);
  if (existsSync(parent)) assert.deepEqual(readdirSync(parent), []);
}

// Import the recovery API directly: these checks never initialize the recovered schema implicitly.
import { verifyDatabaseBackup, restoreDatabaseBackup } from '../server/database-recovery.ts';

const retiredTables = [
  'sessions',
  'recoveryGrants',
  'mfaChallenges',
  'mfaPending',
  'mfaRecoveryCodes',
] as const;
const reason = 'Synthetic independent recovery rehearsal; no deployment.';
function schema(path: string) {
  return readIsolated(path, (db) =>
    db
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
      )
      .all(),
  );
}
function amend(path: string, sql: string) {
  const db = new DatabaseSync(path);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

test('verification inspects an isolated current backup without modifying bytes, creating sidecars or exposing records', async (t) => {
  const f = fixture(t),
    bytes = readFileSync(f.source),
    before = inspect(f.source);
  const files = readdirSync(f.directory);
  const result = await verifyDatabaseBackup(f.source);
  assert.equal(result.operation, 'verify');
  assert.equal(result.source.path, resolve(f.source));
  assert.equal(result.source.sha256, digest(bytes));
  assert.equal(result.source.byteLength, bytes.length);
  assert.match(result.schema.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(result.schema.recognition, 'clinic-baseline');
  assert.deepEqual(result.checks, {
    integrity: 'ok',
    foreignKeys: 'ok',
    schema: 'recognized-baseline',
  });
  for (const [table, rows] of Object.entries(before))
    assert.equal(result.counts.tables[table], rows.length);
  assert.equal(result.counts.mfaEnrolledAccounts, 2);
  const printed = JSON.stringify(result);
  for (const privateValue of [
    'Ananya',
    'admin@derma.demo',
    secret,
    'synthetic-old-csrf',
    'Immutable MFA command evidence',
    'Frozen JSON',
  ])
    assert.ok(!printed.includes(privateValue));
  unchanged(f.source, bytes);
  assert.deepEqual(readdirSync(f.directory), files);
});

test('restoration preserves every retained SQL value and BLOB, retires all access material, and appends exactly one attributed audit', async (t) => {
  const f = fixture(t),
    bytes = readFileSync(f.source),
    before = inspect(f.source),
    originalSchema = schema(f.source);
  const result = await restoreDatabaseBackup(f.source, f.destination, { reason: `  ${reason}  ` });
  assert.equal(result.operation, 'restore');
  assert.equal(result.source.sha256, digest(bytes));
  assert.equal(result.destination.sha256, digest(readFileSync(f.destination)));
  assert.equal(result.destination.byteLength, statSync(f.destination).size);
  assert.equal(result.destination.path, resolve(f.destination));
  assert.equal(result.checks.preservation, 'ok');
  assert.equal(result.mfaReplayProtectedCount, 1);
  assert.deepEqual(schema(f.destination), originalSchema);
  const after = inspect(f.destination);
  assert.deepEqual(Object.keys(after), Object.keys(before));
  for (const [table, rows] of Object.entries(before)) {
    assert.equal(result.countsBefore[table], rows.length);
    assert.equal(result.countsAfter[table], after[table].length);
    if (retiredTables.includes(table as (typeof retiredTables)[number])) {
      assert.deepEqual(after[table], []);
      assert.equal(result.retired[table as (typeof retiredTables)[number]], rows.length);
    } else if (table === 'audit') {
      assert.deepEqual(
        after.audit.filter((row) => row.id !== result.auditId),
        rows,
      );
      const added = after.audit.filter((row) => row.id === result.auditId);
      assert.equal(added.length, 1);
      const entry = JSON.parse(added[0].data as string);
      assert.deepEqual(entry, {
        id: result.auditId,
        actorName: 'Local recovery operator',
        action: 'restored database copy',
        entityType: 'database-recovery',
        entityId: result.source.sha256,
        createdAt: result.restoredAt,
        details: {
          reason,
          sourceSha256: result.source.sha256,
          retired: result.retired,
          mfaReplayProtectedCount: 1,
        },
      });
    } else if (table === 'mfaCredentials') {
      const protectedStep = Math.floor(Date.parse(result.restoredAt) / 30000) + 1;
      for (const original of rows)
        assert.deepEqual(
          after[table].find((row) => row.userId === original.userId),
          { ...original, lastStep: Math.max(Number(original.lastStep), protectedStep) },
        );
    } else assert.deepEqual(after[table], rows, `Retained table changed: ${table}`);
  }
  assert.equal(statSync(f.destination).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(f.destination)).mode & 0o777, 0o700);
  assert.equal(statSync(f.destination).nlink, 1);
  assert.deepEqual(readdirSync(dirname(f.destination)), ['clinic.sqlite']);
  unchanged(f.source, bytes);
  const restored = new DatabaseSync(f.destination);
  try {
    assert.equal(restored.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    assert.deepEqual(restored.prepare('PRAGMA foreign_key_check').all(), []);
    assert.throws(() => restored.exec('DELETE FROM careSummaryCopies'), /immutable/i);
    assert.throws(() => restored.exec('DELETE FROM audit'), /append-only/i);
  } finally {
    restored.close();
  }
});

test('a baseline legacy backup restores without invented modules, history or MFA enrollment', async (t) => {
  const f = fixture(t, true),
    bytes = readFileSync(f.source),
    before = inspect(f.source);
  assert.equal(before.mfaCredentials, undefined);
  assert.equal(before.recoveryGrants, undefined);
  const verified = await verifyDatabaseBackup(f.source);
  assert.equal(verified.counts.mfaEnrolledAccounts, 0);
  const result = await restoreDatabaseBackup(f.source, f.destination, { reason });
  const after = inspect(f.destination);
  assert.deepEqual(Object.keys(after), Object.keys(before));
  assert.deepEqual(result.retired, {
    sessions: 1,
    recoveryGrants: 0,
    mfaChallenges: 0,
    mfaPending: 0,
    mfaRecoveryCodes: 0,
  });
  assert.equal(result.mfaReplayProtectedCount, 0);
  for (const [table, rows] of Object.entries(before)) {
    if (table === 'sessions') assert.deepEqual(after[table], []);
    else if (table === 'audit')
      assert.deepEqual(
        after[table].filter((row) => row.id !== result.auditId),
        rows,
      );
    else assert.deepEqual(after[table], rows, table);
  }
  unchanged(f.source, bytes);
});

test('ordinary additive columns and tables remain exact and repeated recovery never revives retired credentials', async (t) => {
  const f = fixture(t);
  amend(
    f.source,
    `ALTER TABLE mfaCredentials ADD COLUMN preservedHint TEXT DEFAULT 'synthetic extra credential column';
    CREATE TABLE additiveRecords(id TEXT PRIMARY KEY, counter INTEGER, textValue TEXT, bytes BLOB);
    INSERT INTO additiveRecords VALUES('later-module',9223372036854775807,'Exact later module bytes',x'00ff0a');`,
  );
  // BigInt SQLite integers must not lose precision during streaming preservation checks.
  const bytes = readFileSync(f.source);
  const first = await restoreDatabaseBackup(f.source, f.destination, { reason });
  const secondPath = join(f.directory, 'second', 'clinic.sqlite');
  const second = await restoreDatabaseBackup(f.destination, secondPath, {
    reason: 'Second independent recovery rehearsal.',
  });
  assert.deepEqual(second.retired, {
    sessions: 0,
    recoveryGrants: 0,
    mfaChallenges: 0,
    mfaPending: 0,
    mfaRecoveryCodes: 0,
  });
  const db = new DatabaseSync(secondPath, { readOnly: true });
  try {
    const query = db.prepare('SELECT * FROM additiveRecords');
    query.setReadBigInts(true);
    assert.deepEqual(
      { ...query.get()! },
      {
        id: 'later-module',
        counter: 9223372036854775807n,
        textValue: 'Exact later module bytes',
        bytes: new Uint8Array([0, 255, 10]),
      },
    );
    assert.equal(
      db
        .prepare('SELECT COUNT(*) n FROM audit WHERE id IN (?,?)')
        .get(first.auditId, second.auditId)!.n,
      2,
    );
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) n FROM mfaCredentials WHERE preservedHint='synthetic extra credential column'",
        )
        .get()!.n,
      2,
    );
  } finally {
    db.close();
  }
  unchanged(f.source, bytes);
});

test('corrupt, foreign and unrecognized schema markers fail without a destination or source mutation', async (t) => {
  const f = fixture(t, true);
  const variants = [
    ['corrupt', () => writeFileSync(f.source, 'Synthetic secret: not a database')],
    [
      'foreign',
      () => {
        rmSync(f.source);
        const db = new DatabaseSync(f.source);
        db.exec('CREATE TABLE unrelated(id TEXT)');
        db.close();
      },
    ],
    ['user-version', () => amend(f.source, 'PRAGMA user_version=2147483647')],
    ['application-id', () => amend(f.source, 'PRAGMA application_id=129999')],
    ['missing-baseline', () => amend(f.source, 'DROP TABLE sessions')],
    ['malformed-auth', () => amend(f.source, 'CREATE TABLE mfaRecoveryCodes(id TEXT PRIMARY KEY)')],
  ] as const;
  const original = readFileSync(f.source);
  for (const [label, mutate] of variants) {
    writeFileSync(f.source, original);
    mutate();
    const bytes = readFileSync(f.source),
      target = join(f.directory, label, 'result.sqlite');
    await assert.rejects(verifyDatabaseBackup(f.source), () => true, label);
    await assert.rejects(restoreDatabaseBackup(f.source, target, { reason }), () => true, label);
    unchanged(f.source, bytes);
    noPartial(target);
  }
});

test('foreign-key violations, views and virtual tables are refused before data is acted upon', async (t) => {
  const f = fixture(t, true),
    original = readFileSync(f.source);
  const variants = [
    [
      'foreign-key',
      "PRAGMA foreign_keys=OFF; INSERT INTO appointments VALUES('broken-patient','missing-patient','doctor-meera','2099-01-01','08:00','scheduled','{}')",
    ],
    ['view', 'CREATE VIEW hidden_patient_export AS SELECT data FROM patients'],
    ['virtual', 'CREATE VIRTUAL TABLE external_content USING fts5(secret)'],
  ] as const;
  for (const [label, sql] of variants) {
    writeFileSync(f.source, original);
    amend(f.source, sql);
    const bytes = readFileSync(f.source),
      destination = join(f.directory, label, 'result.sqlite');
    await assert.rejects(
      restoreDatabaseBackup(f.source, destination, { reason }),
      () => true,
      label,
    );
    unchanged(f.source, bytes);
    noPartial(destination);
  }
});

test('source sidecars, directories, symlinks and missing files are refused even when sidecars are empty or dangling', async (t) => {
  const f = fixture(t, true),
    bytes = readFileSync(f.source);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    for (const kind of ['empty', 'dangling'] as const) {
      const sidecar = f.source + suffix;
      if (kind === 'empty') writeFileSync(sidecar, '');
      else symlinkSync(join(f.directory, 'absent-sidecar-target'), sidecar);
      await assert.rejects(verifyDatabaseBackup(f.source));
      await assert.rejects(restoreDatabaseBackup(f.source, f.destination, { reason }));
      assert.ok(lstatSync(sidecar));
      noPartial(f.destination);
      rmSync(sidecar);
    }
  }
  const alias = join(f.directory, 'source-link.sqlite');
  symlinkSync(f.source, alias);
  for (const source of [alias, f.directory, join(f.directory, 'missing.sqlite')])
    await assert.rejects(restoreDatabaseBackup(source, f.destination, { reason }));
  unchanged(f.source, bytes);
  noPartial(f.destination);
});

test('existing destinations and sidecars are never overwritten or removed, including aliases and dangling symlinks', async (t) => {
  const f = fixture(t, true),
    bytes = readFileSync(f.source);
  mkdirSync(dirname(f.destination), { mode: 0o700 });
  for (const type of ['file', 'directory', 'symlink', 'dangling', 'hardlink'] as const) {
    if (type === 'file') writeFileSync(f.destination, 'Preserve existing destination');
    else if (type === 'directory') mkdirSync(f.destination);
    else if (type === 'hardlink') linkSync(f.source, f.destination);
    else
      symlinkSync(
        type === 'symlink' ? f.source : join(f.directory, 'missing-target'),
        f.destination,
      );
    const before = lstatSync(f.destination);
    await assert.rejects(restoreDatabaseBackup(f.source, f.destination, { reason }));
    assert.equal(lstatSync(f.destination).ino, before.ino);
    assert.equal(lstatSync(f.destination).mode, before.mode);
    if (type === 'file')
      assert.equal(readFileSync(f.destination, 'utf8'), 'Preserve existing destination');
    if (type === 'directory') rmSync(f.destination, { recursive: true });
    else unlinkSync(f.destination);
  }
  await assert.rejects(restoreDatabaseBackup(f.source, f.source, { reason }));
  const parentAlias = join(f.directory, 'source-parent-alias');
  symlinkSync(f.directory, parentAlias);
  const filesBeforeSidecarTargets = readdirSync(f.directory).sort();
  for (const suffix of ['-wal', '-shm', '-journal']) {
    for (const target of [f.source + suffix, join(parentAlias, 'source.sqlite' + suffix)]) {
      await assert.rejects(restoreDatabaseBackup(f.source, target, { reason }));
      unchanged(f.source, bytes);
      assert.deepEqual(readdirSync(f.directory).sort(), filesBeforeSidecarTargets);
    }
    await assert.rejects(
      restoreDatabaseBackup(join(parentAlias, 'source.sqlite'), f.source + suffix, { reason }),
    );
    unchanged(f.source, bytes);
    assert.deepEqual(readdirSync(f.directory).sort(), filesBeforeSidecarTargets);
    // Reject before recursive destination-directory creation: otherwise even a
    // failed restore could leave a poisonous source-wal/-shm/-journal directory.
    for (const source of [f.source, join(parentAlias, 'source.sqlite')]) {
      for (const sidecar of [f.source + suffix, join(parentAlias, 'source.sqlite' + suffix)]) {
        for (const nested of ['recovered.sqlite', join('nested', 'deeper', 'recovered.sqlite')]) {
          await assert.rejects(restoreDatabaseBackup(source, join(sidecar, nested), { reason }));
          unchanged(f.source, bytes);
          assert.throws(() => lstatSync(f.source + suffix), { code: 'ENOENT' });
          assert.deepEqual(readdirSync(f.directory).sort(), filesBeforeSidecarTargets);
          assert.deepEqual(readdirSync(dirname(f.destination)), []);
        }
      }
    }
  }
  for (const suffix of ['-wal', '-shm', '-journal']) {
    writeFileSync(f.destination + suffix, 'Unrelated sidecar sentinel');
    await assert.rejects(restoreDatabaseBackup(f.source, f.destination, { reason }));
    assert.equal(readFileSync(f.destination + suffix, 'utf8'), 'Unrelated sidecar sentinel');
    assert.equal(existsSync(f.destination), false);
    rmSync(f.destination + suffix);
  }
  unchanged(f.source, bytes);
  noPartial(f.destination);
});

test('trigger side effects, ignored retirement and failed audit writes roll back without publishing partial recovery', async (t) => {
  const f = fixture(t, true),
    original = readFileSync(f.source);
  const cases = [
    [
      'retained-record-side-effect',
      "CREATE TRIGGER delete_session_changes_patient AFTER DELETE ON sessions BEGIN UPDATE patients SET data='SYNTHETIC_SECRET_MUST_NOT_ESCAPE' WHERE id='patient-ananya'; END",
    ],
    [
      'retirement-ignored',
      'CREATE TRIGGER preserve_session BEFORE DELETE ON sessions BEGIN SELECT RAISE(IGNORE); END',
    ],
    [
      'replacement-session',
      "CREATE TRIGGER replace_session AFTER DELETE ON sessions BEGIN INSERT INTO sessions VALUES('replacement-session','user-admin','synthetic-csrf',9999999999999); END",
    ],
    [
      'audit-abort',
      "CREATE TRIGGER refuse_recovery_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT,'SYNTHETIC_SECRET_MUST_NOT_ESCAPE'); END",
    ],
  ] as const;
  for (const [name, sql] of cases) {
    writeFileSync(f.source, original);
    amend(f.source, sql);
    const bytes = readFileSync(f.source),
      destination = join(f.directory, name, 'result.sqlite');
    await assert.rejects(restoreDatabaseBackup(f.source, destination, { reason }), (error) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes('SYNTHETIC_SECRET_MUST_NOT_ESCAPE'));
      return true;
    });
    unchanged(f.source, bytes);
    noPartial(destination);
  }
});

test('a read-only source hardlink and real ancestor aliases preserve their original inode and contents', async (t) => {
  const f = fixture(t, true),
    bytes = readFileSync(f.source),
    alias = join(f.directory, 'source-hardlink.sqlite');
  linkSync(f.source, alias);
  const inode = statSync(f.source).ino;
  const parentLink = join(f.directory, 'parent-alias');
  symlinkSync(f.directory, parentLink);
  const result = await restoreDatabaseBackup(
    alias,
    join(parentLink, 'alias-output', 'clinic.sqlite'),
    { reason },
  );
  assert.equal(result.source.sha256, digest(bytes));
  assert.equal(statSync(f.source).ino, inode);
  assert.equal(statSync(alias).ino, inode);
  assert.deepEqual(readFileSync(alias), bytes);
  assert.notEqual(statSync(result.destination.path).ino, inode);
  unchanged(f.source, bytes);
});

test('publication races refuse competing destinations and sidecars without removing another writer’s files', async (t) => {
  const f = fixture(t, true),
    original = readFileSync(f.source);
  for (const kind of [
    'destination',
    'destination-sidecar',
    'source-sidecar',
    'source-replacement',
  ] as const) {
    const destination = join(f.directory, kind, 'clinic.sqlite');
    const exec = DatabaseSync.prototype.exec;
    let injected = false;
    const hook = t.mock.method(
      DatabaseSync.prototype,
      'exec',
      function (this: DatabaseSync, sql: string) {
        const value = exec.call(this, sql);
        if (!injected && sql.trim().toUpperCase() === 'COMMIT') {
          injected = true;
          if (kind === 'destination')
            writeFileSync(destination, 'A different operator owns this destination.');
          else if (kind === 'destination-sidecar')
            writeFileSync(destination + '-wal', 'Other writer sidecar.');
          else if (kind === 'source-sidecar')
            writeFileSync(f.source + '-shm', 'Source became live.');
          else {
            const replacement = join(f.directory, 'replacement.sqlite');
            writeFileSync(replacement, original);
            renameSync(replacement, f.source);
          }
        }
        return value;
      },
    );
    try {
      await assert.rejects(
        restoreDatabaseBackup(f.source, destination, { reason }),
        () => true,
        kind,
      );
      assert.equal(injected, true, `Race hook did not run: ${kind}`);
      const files = readdirSync(dirname(destination));
      if (kind === 'destination') {
        assert.equal(
          readFileSync(destination, 'utf8'),
          'A different operator owns this destination.',
        );
        assert.deepEqual(files, ['clinic.sqlite']);
      } else if (kind === 'destination-sidecar') {
        assert.equal(readFileSync(destination + '-wal', 'utf8'), 'Other writer sidecar.');
        assert.equal(existsSync(destination), false);
        assert.deepEqual(files, ['clinic.sqlite-wal']);
      } else {
        assert.equal(existsSync(destination), false);
        assert.deepEqual(files, []);
        if (kind === 'source-sidecar') {
          assert.equal(readFileSync(f.source + '-shm', 'utf8'), 'Source became live.');
          rmSync(f.source + '-shm');
        }
      }
      assert.deepEqual(readFileSync(f.source), original);
    } finally {
      hook.mock.restore();
    }
  }
});

test('invalid reasons fail before creating a destination and never appear as raw CLI diagnostic payloads', async (t) => {
  const f = fixture(t, true),
    bytes = readFileSync(f.source);
  for (const invalid of ['', '   ', 'x'.repeat(1001), null, 123]) {
    await assert.rejects(
      restoreDatabaseBackup(f.source, f.destination, { reason: invalid as string }),
    );
    noPartial(f.destination);
  }
  unchanged(f.source, bytes);
});

test('CLI verification and restore emit one parseable safe report and preserve the separate MFA key requirement', async (t) => {
  const f = fixture(t),
    bytes = readFileSync(f.source);
  const cli = resolve('server/restore.ts');
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_NO_WARNINGS: '1',
        DATABASE_PATH: join(f.directory, 'must-not-open.sqlite'),
        MFA_ENCRYPTION_KEY: '',
      },
    });
  const verified = run('verify', f.source);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(verified.stderr, '');
  const verification = JSON.parse(verified.stdout);
  assert.equal(verification.operation, 'verify');
  assert.equal(verification.source.sha256, digest(bytes));
  const restored = run('restore', f.source, f.destination, '--reason', reason);
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(restored.stderr, '');
  const report = JSON.parse(restored.stdout);
  assert.equal(report.operation, 'restore');
  assert.equal(report.checks.preservation, 'ok');
  assert.equal(existsSync(join(f.directory, 'must-not-open.sqlite')), false);
  for (const output of [verified.stdout, restored.stdout]) {
    for (const privateValue of [
      'Ananya',
      'admin@derma.demo',
      secret,
      'synthetic-old-csrf',
      'Immutable MFA command evidence',
      'Frozen JSON',
      reason,
    ])
      assert.ok(!output.includes(privateValue));
  }
  const reopened = createApp({
    databasePath: f.destination,
    demoMode: false,
    production: false,
    mfaEncryptionKey: key.toString('hex'),
  });
  try {
    const db = reopened.locals.db as DB;
    assert.equal(db.prepare('SELECT COUNT(*) n FROM mfaCredentials').get()!.n, 2);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions').get()!.n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM mfaRecoveryCodes').get()!.n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM careSummaryCopies').get()!.n, 1);
  } finally {
    reopened.locals.close();
  }
  unchanged(f.source, bytes);
});

test('CLI rejects ambiguous arguments, existing paths and malicious trigger errors without printing record contents', async (t) => {
  const f = fixture(t, true),
    cli = resolve('server/restore.ts');
  const invalid = [
    [],
    ['verify'],
    ['verify', f.source, '--reason', 'no'],
    ['restore', f.source, f.destination],
    ['restore', f.source, f.destination, '--reason', reason, '--force'],
    ['restore', f.source, f.destination, '--reason', reason, '--reason', reason],
    ['unknown', f.source],
  ];
  for (const args of invalid) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], {
      encoding: 'utf8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    assert.notEqual(result.status, 0, JSON.stringify(args));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Recovery failed:/);
    noPartial(f.destination);
  }
  amend(
    f.source,
    "CREATE TRIGGER secret_failure BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT,'SYNTHETIC_PRIVATE_RECORD_SENTINEL'); END",
  );
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', cli, 'restore', f.source, f.destination, '--reason', reason],
    { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } },
  );
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Recovery failed:/);
  assert.ok(!result.stderr.includes('SYNTHETIC_PRIVATE_RECORD_SENTINEL'));
  noPartial(f.destination);
});
