export interface RecoverySource {
  path: string;
  sha256: string;
  byteLength: number;
}
export interface RecoverySchema {
  fingerprint: string;
  userVersion: number;
  applicationId: number;
  recognition: 'clinic-baseline';
}
export interface RecoveryChecks {
  integrity: 'ok';
  foreignKeys: 'ok';
  schema: 'recognized-baseline';
}
export interface RecoveryRetired {
  sessions: number;
  recoveryGrants: number;
  mfaChallenges: number;
  mfaPending: number;
  mfaRecoveryCodes: number;
}
export interface DatabaseRecoveryVerification {
  operation: 'verify';
  verifiedAt: string;
  source: RecoverySource;
  schema: RecoverySchema;
  checks: RecoveryChecks;
  counts: { tables: Record<string, number>; mfaEnrolledAccounts: number };
  warnings: string[];
}
export interface DatabaseRecoveryResult {
  operation: 'restore';
  restoredAt: string;
  source: RecoverySource;
  destination: RecoverySource;
  schema: RecoverySchema;
  checks: RecoveryChecks & { preservation: 'ok' };
  retired: RecoveryRetired;
  mfaReplayProtectedCount: number;
  countsBefore: Record<string, number>;
  countsAfter: Record<string, number>;
  auditId: string;
  warnings: string[];
}
export interface DatabaseRecoveryOptions {
  reason: string;
  now?: () => number;
}

import { createHash, randomUUID, type Hash } from 'node:crypto';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeSync,
  linkSync,
  unlinkSync,
  chmodSync,
  type BigIntStats,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import type { AuditEntry } from '../shared/types.ts';

class RecoveryError extends Error {}
const fail = (message: string): never => {
  throw new RecoveryError(message);
};
const SIDECARS = ['-wal', '-shm', '-journal'] as const;
const TRANSIENT = [
  'sessions',
  'recoveryGrants',
  'mfaChallenges',
  'mfaPending',
  'mfaRecoveryCodes',
] as const;
const BASELINE: Record<string, Record<string, string>> = {
  meta: { key: 'TEXT', value: 'TEXT' },
  users: { id: 'TEXT', email: 'TEXT', password: 'TEXT', role: 'TEXT', data: 'TEXT' },
  sessions: { tokenHash: 'TEXT', userId: 'TEXT', csrfToken: 'TEXT', expiresAt: 'INTEGER' },
  doctors: { id: 'TEXT', data: 'TEXT' },
  patients: { id: 'TEXT', data: 'TEXT' },
  appointments: {
    id: 'TEXT',
    patientId: 'TEXT',
    doctorId: 'TEXT',
    date: 'TEXT',
    time: 'TEXT',
    status: 'TEXT',
    data: 'TEXT',
  },
  intakes: { id: 'TEXT', patientId: 'TEXT', data: 'TEXT' },
  encounters: { id: 'TEXT', patientId: 'TEXT', data: 'TEXT' },
  carePlans: { id: 'TEXT', patientId: 'TEXT', data: 'TEXT' },
  checkIns: { id: 'TEXT', patientId: 'TEXT', carePlanId: 'TEXT', date: 'TEXT', data: 'TEXT' },
  images: { id: 'TEXT', patientId: 'TEXT', data: 'TEXT', bytes: 'BLOB' },
  messages: { id: 'TEXT', patientId: 'TEXT', data: 'TEXT' },
  audit: { id: 'TEXT', data: 'TEXT' },
};
const OPTIONAL_AUTH: Record<string, Record<string, string>> = {
  recoveryGrants: { tokenHash: 'TEXT', userId: 'TEXT', createdAt: 'INTEGER', expiresAt: 'INTEGER' },
  mfaChallenges: {
    tokenHash: 'TEXT',
    userId: 'TEXT',
    credentialId: 'TEXT',
    csrfToken: 'TEXT',
    fingerprint: 'TEXT',
    expiresAt: 'INTEGER',
  },
  mfaPending: {
    id: 'TEXT',
    userId: 'TEXT',
    sessionHash: 'TEXT',
    kind: 'TEXT',
    expiresAt: 'INTEGER',
    fingerprint: 'TEXT',
    payload: 'TEXT',
    eventId: 'TEXT',
  },
  mfaRecoveryCodes: { codeHash: 'TEXT', userId: 'TEXT', credentialId: 'TEXT', usedAt: 'TEXT' },
  mfaCredentials: {
    userId: 'TEXT',
    id: 'TEXT',
    secret: 'TEXT',
    enabledAt: 'TEXT',
    lastStep: 'INTEGER',
  },
};
interface Table {
  name: string;
  columns: string[];
}
interface Inspection {
  schema: RecoverySchema;
  tables: Table[];
  counts: Record<string, number>;
  mfaEnrolledAccounts: number;
}
interface Stage {
  directory: string;
  file: string;
  source: RecoverySource;
  checkSource: () => void;
}
function exists(path: string) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
function noSidecars(path: string, kind: 'Source' | 'Destination') {
  if (SIDECARS.some((suffix) => exists(path + suffix)))
    fail(
      `${kind} has a SQLite sidecar. Use a completed standalone backup and a clean new destination.`,
    );
}
function inputPath(value: string) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0'))
    fail('Provide a valid local file path.');
  return resolve(value);
}
function sameFile(a: BigIntStats, b: BigIntStats) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}
function safeIdentifier(value: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
    fail('The backup contains an unsupported schema identifier.');
  return `"${value}"`;
}
function hashFile(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW),
    hash = createHash('sha256'),
    buffer = Buffer.allocUnsafe(64 * 1024);
  let size = 0;
  try {
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (!n) break;
      hash.update(buffer.subarray(0, n));
      size += n;
    }
    return { sha256: hash.digest('hex'), byteLength: size };
  } finally {
    closeSync(fd);
  }
}
function stageSource(sourcePath: string, parent: string): Stage {
  let directory: string | undefined, input: number | undefined, output: number | undefined;
  try {
    const requested = inputPath(sourcePath);
    if (!exists(requested)) return fail('Source backup does not exist.');
    const sourceStat = lstatSync(requested, { bigint: true });
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink())
      return fail('Source backup must be a regular, non-symlink file.');
    noSidecars(requested, 'Source');
    const source = join(realpathSync(dirname(requested)), basename(requested));
    input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(input, { bigint: true });
    if (!sameFile(sourceStat, before))
      return fail('Source backup changed while it was being opened.');
    directory = mkdtempSync(join(parent, '.clinic-recovery-'));
    chmodSync(directory, 0o700);
    const file = join(directory, 'database.sqlite');
    output = openSync(file, 'wx', 0o600);
    const buffer = Buffer.allocUnsafe(64 * 1024),
      hash = createHash('sha256');
    let size = 0;
    for (;;) {
      const n = readSync(input, buffer, 0, buffer.length, null);
      if (!n) break;
      hash.update(buffer.subarray(0, n));
      size += n;
      let written = 0;
      while (written < n) written += writeSync(output, buffer, written, n - written);
    }
    fsyncSync(output);
    closeSync(output);
    output = undefined;
    const after = fstatSync(input, { bigint: true });
    closeSync(input);
    input = undefined;
    if (!sameFile(before, after) || BigInt(size) !== before.size)
      return fail('Source backup changed while it was being copied.');
    const checkSource = () => {
      noSidecars(requested, 'Source');
      noSidecars(source, 'Source');
      if (!exists(requested) || !exists(source))
        return fail('Source backup changed during recovery.');
      const current = lstatSync(source, { bigint: true }),
        alias = lstatSync(requested, { bigint: true });
      if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        alias.isSymbolicLink() ||
        !sameFile(before, current) ||
        !sameFile(before, alias)
      )
        return fail('Source backup changed during recovery.');
    };
    checkSource();
    return {
      directory,
      file,
      source: { path: requested, sha256: hash.digest('hex'), byteLength: size },
      checkSource,
    };
  } catch (error) {
    if (output !== undefined) closeSync(output);
    if (input !== undefined) closeSync(input);
    if (directory) rmSync(directory, { recursive: true, force: true });
    if (error instanceof RecoveryError) throw error;
    return fail('The source backup could not be copied into private staging.');
  }
}
function checkedRows(db: DatabaseSync) {
  const integrity = db.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok')
    fail('The backup failed SQLite integrity checks.');
  const foreign = db.prepare('PRAGMA foreign_key_check').get();
  if (foreign) fail('The backup failed SQLite foreign-key checks.');
}
function inspect(db: DatabaseSync): Inspection {
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON;');
    const schemaRows = db
      .prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name,tbl_name')
      .all();
    if (
      schemaRows.some(
        (row) =>
          row.type === 'view' ||
          (typeof row.sql === 'string' && /^CREATE\s+VIRTUAL\s+TABLE\b/i.test(row.sql)),
      )
    )
      fail('The backup contains unsupported views or virtual tables.');
    const userVersion = Number(db.prepare('PRAGMA user_version').get()!.user_version),
      applicationId = Number(db.prepare('PRAGMA application_id').get()!.application_id);
    if (userVersion !== 0 || applicationId !== 0)
      fail('The backup has an unsupported database version marker.');
    const tables: Table[] = [];
    for (const row of db.prepare('PRAGMA table_list').all()) {
      if (row.schema !== 'main' || row.name === 'sqlite_schema') continue;
      if (row.type !== 'table' || row.wr !== 0)
        fail('The backup contains an unsupported table layout.');
      const name = String(row.name),
        columns = db.prepare(`PRAGMA table_xinfo(${safeIdentifier(name)})`).all();
      if (
        columns.some(
          (column) =>
            column.hidden !== 0 ||
            ['rowid', 'oid', '_rowid_'].includes(String(column.name).toLowerCase()),
        )
      )
        fail('The backup contains an unsupported table layout.');
      const expected = BASELINE[name] ?? OPTIONAL_AUTH[name];
      if (expected) {
        for (const [column, type] of Object.entries(expected))
          if (!columns.some((c) => c.name === column && String(c.type).toUpperCase() === type))
            fail('The backup does not have a recognized clinic/authentication schema.');
        const key =
          name === 'meta'
            ? 'key'
            : name === 'sessions' || name === 'recoveryGrants' || name === 'mfaChallenges'
              ? 'tokenHash'
              : name === 'mfaCredentials'
                ? 'userId'
                : name === 'mfaRecoveryCodes'
                  ? 'codeHash'
                  : 'id';
        if (!columns.some((column) => column.name === key && column.pk === 1))
          fail('The backup does not have a recognized clinic/authentication schema.');
      }
      tables.push({ name, columns: columns.map((column) => String(column.name)) });
    }
    tables.sort((a, b) => a.name.localeCompare(b.name));
    for (const name of Object.keys(BASELINE))
      if (!tables.some((table) => table.name === name))
        fail('The backup does not have the recognized clinic baseline schema.');
    if (
      tables.some((t) => t.name === 'mfaRecoveryCodes') &&
      !tables.some((t) => t.name === 'mfaCredentials')
    )
      fail('The backup has an incomplete authentication schema.');
    checkedRows(db);
    const counts = Object.fromEntries(
      tables.map((table) => [
        table.name,
        Number(db.prepare(`SELECT COUNT(*) n FROM ${safeIdentifier(table.name)}`).get()!.n),
      ]),
    );
    const fingerprint = createHash('sha256').update(JSON.stringify(schemaRows)).digest('hex');
    return {
      schema: { fingerprint, userVersion, applicationId, recognition: 'clinic-baseline' },
      tables,
      counts,
      mfaEnrolledAccounts: counts.mfaCredentials ?? 0,
    };
  } catch (error) {
    if (error instanceof RecoveryError) throw error;
    return fail('The backup could not be validated as a supported clinic database.');
  }
}
function warnings(enrolled: number) {
  return [
    'Recognized baseline structure is not a guarantee of full application-version compatibility; no release-version marker exists in these snapshots.',
    'This command does not replace or start a live database. Review post-backup account, password, factor, scheduling and operational changes before any cutover.',
    ...(enrolled
      ? [
          'Retained MFA enrollments require the original separately protected encryption key. Key correctness was not tested.',
        ]
      : []),
  ];
}
const checks: RecoveryChecks = {
  integrity: 'ok',
  foreignKeys: 'ok',
  schema: 'recognized-baseline',
};
export async function verifyDatabaseBackup(
  sourcePath: string,
): Promise<DatabaseRecoveryVerification> {
  let stage: Stage | undefined, db: DatabaseSync | undefined;
  try {
    stage = stageSource(sourcePath, tmpdir());
    db = new DatabaseSync(stage.file, { readOnly: true, allowExtension: false });
    db.exec('PRAGMA query_only=ON;');
    const inspected = inspect(db);
    stage.checkSource();
    return {
      operation: 'verify',
      verifiedAt: new Date().toISOString(),
      source: stage.source,
      schema: inspected.schema,
      checks: { ...checks },
      counts: { tables: inspected.counts, mfaEnrolledAccounts: inspected.mfaEnrolledAccounts },
      warnings: warnings(inspected.mfaEnrolledAccounts),
    };
  } catch (error) {
    if (error instanceof RecoveryError) throw error;
    return fail('The backup could not be verified.');
  } finally {
    db?.close();
    if (stage) rmSync(stage.directory, { recursive: true, force: true });
  }
}
function addValue(hash: Hash, value: SQLOutputValue) {
  if (value === null) {
    hash.update('N;');
    return;
  }
  if (value instanceof Uint8Array) {
    hash.update(`B${value.byteLength}:`);
    hash.update(value);
    return;
  }
  if (typeof value === 'string') {
    hash.update(`S${Buffer.byteLength(value, 'utf8')}:`);
    hash.update(value);
    return;
  }
  if (typeof value === 'bigint') {
    hash.update(`I${value};`);
    return;
  }
  if (typeof value === 'number') {
    hash.update(`F${Object.is(value, -0) ? '-0' : String(value)};`);
    return;
  }
  fail('The backup contains unsupported SQLite values.');
}
function preservedFingerprint(db: DatabaseSync, tables: Table[], auditId?: string) {
  const hash = createHash('sha256');
  for (const table of tables) {
    if (TRANSIENT.includes(table.name as (typeof TRANSIENT)[number])) continue;
    const columns = table.columns.filter(
      (column) => table.name !== 'mfaCredentials' || column !== 'lastStep',
    );
    hash.update(JSON.stringify([table.name, columns]));
    const statement = db.prepare(
      `SELECT rowid AS __recovery_rowid__,${columns.map(safeIdentifier).join(',')} FROM ${safeIdentifier(table.name)}${table.name === 'audit' && auditId ? ' WHERE id<>?' : ''} ORDER BY rowid`,
    );
    statement.setReadBigInts(true);
    for (const row of statement.iterate(...(table.name === 'audit' && auditId ? [auditId] : []))) {
      hash.update('R');
      addValue(hash, row.__recovery_rowid__);
      for (const column of columns) addValue(hash, row[column]);
    }
  }
  return hash.digest('hex');
}
function retainedMfaSteps(db: DatabaseSync, hasMfa: boolean, restoredAt: number) {
  const expected = new Map<string, bigint>();
  if (!hasMfa) return expected;
  const step = BigInt(Math.floor(restoredAt / 30000) + 1),
    statement = db.prepare('SELECT userId,lastStep FROM mfaCredentials ORDER BY userId');
  statement.setReadBigInts(true);
  for (const row of statement.iterate()) {
    if (
      typeof row.userId !== 'string' ||
      !row.userId ||
      typeof row.lastStep !== 'bigint' ||
      row.lastStep < -1n ||
      row.lastStep > BigInt(Number.MAX_SAFE_INTEGER)
    )
      return fail('The backup contains invalid MFA replay state.');
    expected.set(row.userId, row.lastStep > step ? row.lastStep : step);
  }
  return expected;
}
function verifyMfaSteps(db: DatabaseSync, expected: Map<string, bigint>) {
  const statement = db.prepare('SELECT userId,lastStep FROM mfaCredentials ORDER BY userId');
  statement.setReadBigInts(true);
  let count = 0;
  for (const row of statement.iterate()) {
    if (typeof row.userId !== 'string' || expected.get(row.userId) !== row.lastStep)
      fail('Recovery changed retained authentication data unexpectedly.');
    count++;
  }
  if (count !== expected.size) fail('Recovery changed retained authentication data unexpectedly.');
}
function prepareDestination(destinationPath: string) {
  const requested = inputPath(destinationPath);
  if (exists(requested)) fail('Destination already exists. Choose a new file path.');
  noSidecars(requested, 'Destination');
  try {
    mkdirSync(dirname(requested), { recursive: true, mode: 0o700 });
  } catch {
    return fail('The destination directory could not be prepared.');
  }
  const parent = realpathSync(dirname(requested)),
    destination = join(parent, basename(requested));
  const stat = statSync(parent, { bigint: true });
  const check = () => {
    if (realpathSync(dirname(requested)) !== parent) {
      fail('The destination directory changed during recovery.');
    }
    const current = statSync(parent, { bigint: true });
    if (current.dev !== stat.dev || current.ino !== stat.ino)
      fail('The destination directory changed during recovery.');
    if (exists(requested) || exists(destination))
      fail('Destination already exists. Choose a new file path.');
    noSidecars(requested, 'Destination');
    noSidecars(destination, 'Destination');
  };
  check();
  return { parent, destination, requested, check };
}
function projectedPath(path: string) {
  let ancestor = inputPath(path);
  const missing: string[] = [];
  try {
    while (!exists(ancestor)) {
      missing.unshift(basename(ancestor));
      const parent = dirname(ancestor);
      if (parent === ancestor) return fail('The recovery path could not be resolved.');
      ancestor = parent;
    }
    return join(realpathSync(ancestor), ...missing);
  } catch (error) {
    if (error instanceof RecoveryError) throw error;
    return fail('The recovery path could not be resolved.');
  }
}
function protectSourcePath(sourcePath: string, destination: string) {
  // Resolve the nearest existing ancestor without making directories first. A
  // destination inside backup.sqlite-wal must not create that sidecar directory.
  const sourcePaths = [inputPath(sourcePath), projectedPath(sourcePath)];
  const destinations = [inputPath(destination), projectedPath(destination)];
  for (const source of sourcePaths) {
    const protectedPaths = [source, ...SIDECARS.map((suffix) => source + suffix)];
    if (
      protectedPaths.some((path) =>
        destinations.some((candidate) => {
          const protectedPath = path.toLowerCase();
          const target = candidate.toLowerCase();
          return target === protectedPath || target.startsWith(protectedPath + sep);
        }),
      )
    )
      fail('Destination must not be the source backup or any of its SQLite sidecars.');
  }
}
export async function restoreDatabaseBackup(
  sourcePath: string,
  destinationPath: string,
  options: DatabaseRecoveryOptions,
): Promise<DatabaseRecoveryResult> {
  const reason = typeof options?.reason === 'string' ? options.reason.trim() : '';
  if (!reason || reason.length > 1000)
    fail('A recovery reason of 1 to 1000 characters is required.');
  const instant = options.now?.() ?? Date.now();
  if (
    !Number.isSafeInteger(instant) ||
    instant < 0 ||
    !Number.isFinite(new Date(instant).getTime())
  )
    fail('The recovery timestamp is invalid.');
  const restoredAt = new Date(instant).toISOString();
  let stage: Stage | undefined, db: DatabaseSync | undefined, published: string | undefined;
  try {
    protectSourcePath(sourcePath, destinationPath);
    const destination = prepareDestination(destinationPath);
    protectSourcePath(sourcePath, destination.destination);
    stage = stageSource(sourcePath, destination.parent);
    db = new DatabaseSync(stage.file, { allowExtension: false });
    const before = inspect(db),
      hasMfa = before.tables.some((table) => table.name === 'mfaCredentials');
    const preserved = preservedFingerprint(db, before.tables),
      expectedMfa = retainedMfaSteps(db, hasMfa, instant);
    const retired = Object.fromEntries(
      TRANSIENT.map((table) => [table, before.counts[table] ?? 0]),
    ) as unknown as RecoveryRetired;
    const auditId = randomUUID();
    let mfaReplayProtectedCount = 0;
    const audit: AuditEntry & {
      details: {
        reason: string;
        sourceSha256: string;
        retired: RecoveryRetired;
        mfaReplayProtectedCount: number;
      };
    } = {
      id: auditId,
      actorName: 'Local recovery operator',
      action: 'restored database copy',
      entityType: 'database-recovery',
      entityId: stage.source.sha256,
      createdAt: restoredAt,
      details: { reason, sourceSha256: stage.source.sha256, retired, mfaReplayProtectedCount: 0 },
    };
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');
    try {
      for (const table of TRANSIENT)
        if (table in before.counts) db.prepare(`DELETE FROM ${safeIdentifier(table)}`).run();
      if (hasMfa) {
        const step = Math.floor(instant / 30000) + 1;
        mfaReplayProtectedCount = Number(
          db.prepare('UPDATE mfaCredentials SET lastStep=? WHERE lastStep<?').run(step, step)
            .changes,
        );
        verifyMfaSteps(db, expectedMfa);
      }
      audit.details.mfaReplayProtectedCount = mfaReplayProtectedCount;
      const serialized = JSON.stringify(audit);
      db.prepare('INSERT INTO audit(id,data) VALUES(?,?)').run(auditId, serialized);
      if (db.prepare('SELECT data FROM audit WHERE id=?').get(auditId)?.data !== serialized)
        fail('The recovery audit could not be preserved.');
      for (const table of TRANSIENT)
        if (
          table in before.counts &&
          Number(db.prepare(`SELECT COUNT(*) n FROM ${safeIdentifier(table)}`).get()!.n) !== 0
        )
          fail('Recovery did not retire all restored authentication access.');
      if (preservedFingerprint(db, before.tables, auditId) !== preserved)
        fail('Recovery changed retained clinic data unexpectedly.');
      checkedRows(db);
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      if (error instanceof RecoveryError) throw error;
      return fail(
        'Recovery sanitation or preservation checks failed. No restored copy was published.',
      );
    }
    const after = inspect(db);
    if (
      after.schema.fingerprint !== before.schema.fingerprint ||
      preservedFingerprint(db, before.tables, auditId) !== preserved
    )
      fail('Recovery changed retained schema or clinic data unexpectedly.');
    if (hasMfa) verifyMfaSteps(db, expectedMfa);
    for (const table of TRANSIENT)
      if ((after.counts[table] ?? 0) !== 0)
        fail('Recovery did not retire all restored authentication access.');
    db.close();
    db = undefined;
    noSidecars(stage.file, 'Destination');
    chmodSync(stage.file, 0o600);
    const artifact = hashFile(stage.file);
    const fd = openSync(stage.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    stage.checkSource();
    destination.check();
    protectSourcePath(sourcePath, destination.destination);
    try {
      linkSync(stage.file, destination.destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        return fail('Destination already exists. Choose a new file path.');
      return fail('The verified restored copy could not be published.');
    }
    published = destination.destination;
    const directoryFd = openSync(destination.parent, constants.O_RDONLY);
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
    const result: DatabaseRecoveryResult = {
      operation: 'restore',
      restoredAt,
      source: stage.source,
      destination: { path: destination.requested, ...artifact },
      schema: after.schema,
      checks: { ...checks, preservation: 'ok' },
      retired,
      mfaReplayProtectedCount,
      countsBefore: before.counts,
      countsAfter: after.counts,
      auditId,
      warnings: [
        ...warnings(before.mfaEnrolledAccounts),
        ...(before.mfaEnrolledAccounts
          ? [
              'Authenticator verification requires a fresh step after recovery; normally allow up to 90 seconds before retrying a current authenticator code. A later saved replay step can require longer.',
            ]
          : []),
      ],
    };
    published = undefined;
    return result;
  } catch (error) {
    if (published && stage) {
      try {
        const output = lstatSync(published, { bigint: true }),
          staged = lstatSync(stage.file, { bigint: true });
        if (output.dev === staged.dev && output.ino === staged.ino) unlinkSync(published);
      } catch {
        /* Never remove an unrelated path. */
      }
    }
    if (error instanceof RecoveryError) throw error;
    return fail('Recovery failed safely. No restored copy was published.');
  } finally {
    db?.close();
    if (stage) rmSync(stage.directory, { recursive: true, force: true });
  }
}
