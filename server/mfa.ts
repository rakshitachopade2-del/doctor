import type { Express, Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { AuthRequest } from './app.ts';
import type { Session, User } from '../shared/types.ts';
import type {
  MfaChallenge,
  MfaEvent,
  MfaMutation,
  MfaOperation,
  MfaPending,
  MfaPreparation,
  MfaProof,
  MfaStateSnapshot,
  MfaStatus,
} from '../shared/mfa.ts';
import { get, id, insert, nowISO, verifyPassword, type DB } from './db.ts';
import {
  acceptedTotpStep,
  base32,
  mfaBinding,
  mfaHash,
  mfaKeyCheck,
  normalizeRecoveryCode,
  openMfa,
  recoveryCodeHash,
  recoveryCodes,
  sealMfa,
} from './mfa-crypto.ts';

const challengeCookie = 'derma_mfa_challenge',
  cookiePath = '/api/auth/mfa';
const pendingLifetime = 10 * 60_000,
  challengeLifetime = 5 * 60_000,
  attemptWindow = 15 * 60_000;
const keyCheckName = 'mfa-key-check-v1';
const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const password = z.string().min(1).max(128);
const proofSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('totp'), code: z.string().regex(/^\d{6}$/) }).strict(),
  z
    .object({
      method: z.literal('recovery-code'),
      code: z
        .string()
        .max(50)
        .transform(normalizeRecoveryCode)
        .pipe(z.string().regex(/^[A-F0-9]{32}$/)),
    })
    .strict(),
]);
const commandFields = { expectedRevision: revision, requestId: uuid };
interface Credential {
  userId: string;
  id: string;
  secret: string;
  enabledAt: string;
  lastStep: number;
}
interface PendingRow {
  id: string;
  userId: string;
  sessionHash: string;
  kind: MfaPending['kind'];
  expiresAt: number;
  fingerprint: string;
  payload: string;
  eventId: string;
}
interface PendingPayload {
  credentialId: string;
  secret?: string;
  otpauthUri?: string;
  recoveryCodes: string[];
}
interface IssuedSession {
  session: Session;
  apply: (res: Response) => void;
}
interface Dependencies {
  db: DB;
  key: Buffer | null;
  production: boolean;
  actor: (req: AuthRequest, roles?: User['role'][]) => User;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
  issueSession: (user: User, req: Request, credentialId?: string) => IssuedSession;
  clearSessionCookie: (res: Response) => void;
}
class InvalidProof extends Error {}

export function initializeMfa(db: DB, key: Buffer | null, validateKey = true) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mfaCredentials(userId TEXT PRIMARY KEY REFERENCES users(id),id TEXT NOT NULL UNIQUE,secret TEXT NOT NULL,enabledAt TEXT NOT NULL,lastStep INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS mfaRecoveryCodes(codeHash TEXT PRIMARY KEY,userId TEXT NOT NULL REFERENCES users(id),credentialId TEXT NOT NULL REFERENCES mfaCredentials(id) ON DELETE CASCADE,usedAt TEXT);
    CREATE INDEX IF NOT EXISTS mfa_recovery_user ON mfaRecoveryCodes(userId,usedAt);
    CREATE TABLE IF NOT EXISTS mfaPending(id TEXT PRIMARY KEY,userId TEXT NOT NULL UNIQUE REFERENCES users(id),sessionHash TEXT NOT NULL,kind TEXT NOT NULL,expiresAt INTEGER NOT NULL,fingerprint TEXT NOT NULL,payload TEXT NOT NULL,eventId TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mfaChallenges(tokenHash TEXT PRIMARY KEY,userId TEXT NOT NULL REFERENCES users(id),credentialId TEXT NOT NULL,csrfToken TEXT NOT NULL,fingerprint TEXT NOT NULL,expiresAt INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS mfa_challenge_user ON mfaChallenges(userId);
    CREATE TABLE IF NOT EXISTS mfaAttempts(userId TEXT PRIMARY KEY REFERENCES users(id),windowStart INTEGER NOT NULL,failures INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS mfaEpochs(userId TEXT PRIMARY KEY REFERENCES users(id),version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS mfaEvents(id TEXT PRIMARY KEY,userId TEXT NOT NULL REFERENCES users(id),operation TEXT NOT NULL,data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS mfa_events_user ON mfaEvents(userId);
    CREATE TABLE IF NOT EXISTS mfaCommands(requestId TEXT PRIMARY KEY,userId TEXT NOT NULL REFERENCES users(id),sessionHash TEXT NOT NULL,operation TEXT NOT NULL,binding TEXT NOT NULL,eventId TEXT NOT NULL REFERENCES mfaEvents(id),pendingId TEXT);
  `);
  if (
    !db
      .prepare('PRAGMA table_info(sessions)')
      .all()
      .some((column) => column.name === 'mfaCredentialId')
  )
    db.exec('ALTER TABLE sessions ADD COLUMN mfaCredentialId TEXT');
  for (const table of ['mfaEvents', 'mfaCommands'])
    db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${table}_immutable_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'MFA evidence is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ${table}_immutable_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'MFA evidence is immutable'); END;
  `);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM mfaPending WHERE expiresAt<=?').run(Date.now());
    db.prepare('DELETE FROM mfaChallenges WHERE expiresAt<=?').run(Date.now());
    if (validateKey) {
      const credentials = db.prepare('SELECT userId,id,secret FROM mfaCredentials').all(),
        pending = db.prepare('SELECT userId,id,payload FROM mfaPending').all();
      if (credentials.length || pending.length) {
        if (!key)
          throw new Error('MFA_ENCRYPTION_KEY is required to open existing protected MFA data.');
        const check = db.prepare('SELECT value FROM meta WHERE key=?').get(keyCheckName);
        if (check && check.value !== mfaKeyCheck(key))
          throw new Error('MFA_ENCRYPTION_KEY does not match existing protected MFA data.');
        for (const row of credentials)
          openMfa(key, String(row.userId), `credential:${row.id}`, String(row.secret));
        for (const row of pending)
          openMfa(key, String(row.userId), `pending:${row.id}`, String(row.payload));
        // A missing verifier may be restored only after every retained ciphertext was opened under the same write lock.
        if (!check)
          db.prepare('INSERT INTO meta(key,value) VALUES (?,?)').run(
            keyCheckName,
            mfaKeyCheck(key),
          );
      } else db.prepare('DELETE FROM meta WHERE key=?').run(keyCheckName);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
export function invalidateMfaTransient(db: DB, userId: string) {
  db.prepare(
    'INSERT INTO mfaEpochs(userId,version) VALUES (?,1) ON CONFLICT(userId) DO UPDATE SET version=version+1',
  ).run(userId);
  db.prepare('DELETE FROM mfaChallenges WHERE userId=?').run(userId);
  db.prepare('DELETE FROM mfaPending WHERE userId=?').run(userId);
}
export function mfaSessionAllowed(db: DB, userId: string, credentialId: unknown) {
  const current = db.prepare('SELECT id FROM mfaCredentials WHERE userId=?').get(userId);
  return !current || current.id === credentialId;
}
/** Local operator use only; no HTTP endpoint. Caller holds a write transaction. */
export function resetMfaForOperator(db: DB, userId: string, reason: string) {
  const user = get<User>(db, 'users', userId);
  if (!user) throw new Error('Account not found.');
  const enabled = !!db.prepare('SELECT 1 FROM mfaCredentials WHERE userId=?').get(userId);
  const count = Number(
    db
      .prepare('SELECT count(*) n FROM mfaRecoveryCodes WHERE userId=? AND usedAt IS NULL')
      .get(userId)!.n,
  );
  invalidateMfaTransient(db, userId);
  db.prepare('DELETE FROM mfaCredentials WHERE userId=?').run(userId);
  db.prepare('DELETE FROM sessions WHERE userId=?').run(userId);
  db.prepare('DELETE FROM recoveryGrants WHERE userId=?').run(userId);
  db.prepare('DELETE FROM mfaAttempts WHERE userId=?').run(userId);
  db.prepare('UPDATE users SET data=? WHERE id=?').run(
    JSON.stringify({ ...user, mustChangePassword: true }),
    userId,
  );
  const event: MfaEvent = {
    id: id(),
    userId,
    operation: 'operator-reset',
    requestId: null,
    expectedRevision: null,
    pendingId: null,
    before: { enabled, recoveryCodesRemaining: count },
    after: { enabled: false, recoveryCodesRemaining: 0 },
    createdById: null,
    createdByName: 'Local operator',
    createdAt: nowISO(),
  };
  db.prepare('INSERT INTO mfaEvents(id,userId,operation,data) VALUES (?,?,?,?)').run(
    event.id,
    userId,
    event.operation,
    JSON.stringify(event),
  );
  insert(db, 'audit', {
    id: id(),
    actorName: 'Local operator',
    action: `reset MFA after identity verification: ${reason}`,
    entityType: 'user',
    entityId: userId,
    createdAt: nowISO(),
  } as { id: string });
  if (
    !db.prepare('SELECT 1 FROM mfaCredentials LIMIT 1').get() &&
    !db.prepare('SELECT 1 FROM mfaPending LIMIT 1').get()
  )
    db.prepare('DELETE FROM meta WHERE key=?').run(keyCheckName);
  return event;
}

export function registerMfa(app: Express, dependencies: Dependencies) {
  const { db, key, production, actor, audit, fail, issueSession, clearSessionCookie } =
    dependencies;
  const credential = (userId: string) =>
    db.prepare('SELECT * FROM mfaCredentials WHERE userId=?').get(userId) as unknown as
      Credential | undefined;
  function transaction<T>(work: () => T) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  const protectedMaterial = () =>
    !!db.prepare('SELECT 1 FROM mfaCredentials LIMIT 1').get() ||
    !!db.prepare('SELECT 1 FROM mfaPending WHERE expiresAt>? LIMIT 1').get(Date.now());
  const configured = () => {
    if (!key)
      return fail(
        503,
        'Authenticator setup is unavailable until the clinic configures its MFA encryption key.',
      );
    const check = db.prepare('SELECT value FROM meta WHERE key=?').get(keyCheckName);
    if (protectedMaterial() && (!check || check.value !== mfaKeyCheck(key)))
      return fail(503, 'The configured MFA encryption key does not match protected account data.');
    return key;
  };
  function revalidateSession(req: AuthRequest, user: User) {
    const session = db
      .prepare('SELECT userId,expiresAt,mfaCredentialId,csrfToken FROM sessions WHERE tokenHash=?')
      .get(req.sessionToken ?? '');
    const current = get<User>(db, 'users', user.id);
    if (
      !session ||
      session.userId !== user.id ||
      session.csrfToken !== req.csrfToken ||
      Number(session.expiresAt) <= Date.now() ||
      !current ||
      current.active === false ||
      !mfaSessionAllowed(db, user.id, session.mfaCredentialId)
    )
      return fail(401, 'Your session changed. Sign in again.');
    if (current.mustChangePassword)
      return fail(403, 'Change your temporary password before managing MFA.');
    if (key) configured();
    return current;
  }
  const publicPending = (value: PendingRow): MfaPending => ({
    id: value.id,
    kind: value.kind,
    expiresAt: new Date(value.expiresAt).toISOString(),
  });
  function fingerprint(userId: string) {
    const row = db.prepare('SELECT data,password FROM users WHERE id=?').get(userId)!;
    const user = JSON.parse(row.data as string) as User;
    return mfaHash(
      JSON.stringify([
        userId,
        row.password,
        user.role,
        user.doctorId ?? null,
        user.patientId ?? null,
        user.active !== false,
        user.mustChangePassword === true,
        db.prepare('SELECT version FROM mfaEpochs WHERE userId=?').get(userId)?.version ?? 0,
        credential(userId)?.id ?? null,
      ]),
    );
  }
  function snapshot(userId: string): MfaStateSnapshot {
    return {
      enabled: !!credential(userId),
      recoveryCodesRemaining: Number(
        db
          .prepare('SELECT count(*) n FROM mfaRecoveryCodes WHERE userId=? AND usedAt IS NULL')
          .get(userId)!.n,
      ),
    };
  }
  function status(userId: string, sessionHash?: string): MfaStatus {
    db.prepare('DELETE FROM mfaPending WHERE expiresAt<=?').run(Date.now());
    const current = credential(userId),
      state = snapshot(userId);
    const codes = db
      .prepare(
        'SELECT codeHash FROM mfaRecoveryCodes WHERE userId=? AND usedAt IS NULL ORDER BY codeHash',
      )
      .all(userId)
      .map((row) => row.codeHash);
    const latest =
      db
        .prepare(
          "SELECT id FROM mfaEvents WHERE userId=? AND operation IN ('enabled','recovery-codes-replaced','disabled','operator-reset') ORDER BY rowid DESC LIMIT 1",
        )
        .get(userId)?.id ?? null;
    const pending = db
      .prepare('SELECT * FROM mfaPending WHERE userId=? AND sessionHash=?')
      .get(userId, sessionHash ?? '') as unknown as PendingRow | undefined;
    return {
      ...state,
      available: key !== null,
      enabledAt: current?.enabledAt ?? null,
      revision: mfaHash(JSON.stringify([current?.id ?? null, codes, latest])),
      pending: pending ? publicPending(pending) : null,
      history: db
        .prepare('SELECT data FROM mfaEvents WHERE userId=? ORDER BY rowid DESC LIMIT 100')
        .all(userId)
        .map((row) => JSON.parse(row.data as string) as MfaEvent),
    };
  }
  function assertRevision(userId: string, expected: string) {
    if (status(userId).revision !== expected)
      fail(409, 'MFA settings changed. Refresh and review the current state before saving.');
  }
  function checkBudget(userId: string) {
    const attempts = db
      .prepare('SELECT windowStart,failures FROM mfaAttempts WHERE userId=?')
      .get(userId);
    if (
      attempts &&
      Number(attempts.windowStart) + attemptWindow > Date.now() &&
      Number(attempts.failures) >= 10
    )
      fail(
        429,
        'Too many verification attempts. Wait 15 minutes from the first failed attempt before trying again.',
      );
  }
  function failedAttempt(userId: string) {
    const now = Date.now();
    db.prepare(
      `INSERT INTO mfaAttempts(userId,windowStart,failures) VALUES (?,?,1) ON CONFLICT(userId) DO UPDATE SET
      windowStart=CASE WHEN windowStart<=? THEN ? ELSE windowStart END,failures=CASE WHEN windowStart<=? THEN 1 ELSE failures+1 END`,
    ).run(userId, now, now - attemptWindow, now, now - attemptWindow);
  }
  function sensitive<T>(userId: string, work: () => T): T {
    const outcome = transaction(() => {
      db.exec('SAVEPOINT mfa_proof_operation');
      try {
        const value = work();
        db.exec('RELEASE mfa_proof_operation');
        return { valid: true as const, value };
      } catch (error) {
        if (!(error instanceof InvalidProof)) throw error;
        db.exec('ROLLBACK TO mfa_proof_operation');
        db.exec('RELEASE mfa_proof_operation');
        failedAttempt(userId);
        return { valid: false as const };
      }
    });
    if (!outcome.valid)
      return fail(400, 'The password or verification code is incorrect, expired or already used.');
    return outcome.value;
  }
  function management<T>(req: AuthRequest, user: User, work: () => T): T {
    return sensitive(user.id, () => {
      revalidateSession(req, user);
      return work();
    });
  }
  function verifyCurrentPassword(userId: string, value: string) {
    checkBudget(userId);
    const row = db.prepare('SELECT password FROM users WHERE id=?').get(userId)!;
    if (!verifyPassword(value, String(row.password))) throw new InvalidProof();
  }
  function verifyProof(userId: string, proof: MfaProof) {
    configured();
    checkBudget(userId);
    const current = credential(userId);
    if (!current) return fail(409, 'MFA is not enabled.');
    if (proof.method === 'recovery-code') {
      const result = db
        .prepare(
          'UPDATE mfaRecoveryCodes SET usedAt=? WHERE userId=? AND credentialId=? AND codeHash=? AND usedAt IS NULL',
        )
        .run(nowISO(), userId, current.id, recoveryCodeHash(current.id, proof.code));
      if (!result.changes) throw new InvalidProof();
    } else {
      const secret = openMfa<{ secret: string }>(
        configured(),
        userId,
        `credential:${current.id}`,
        current.secret,
      ).secret;
      const step = acceptedTotpStep(secret, proof.code, Date.now(), current.lastStep);
      if (
        step === null ||
        !db
          .prepare('UPDATE mfaCredentials SET lastStep=? WHERE userId=? AND lastStep<?')
          .run(step, userId, step).changes
      )
        throw new InvalidProof();
    }
  }
  function replay(
    req: AuthRequest,
    user: User,
    operation: MfaOperation,
    input: { requestId: string },
  ) {
    const row = db.prepare('SELECT * FROM mfaCommands WHERE requestId=?').get(input.requestId);
    if (!row) return null;
    if (
      row.userId !== user.id ||
      row.sessionHash !== req.sessionToken ||
      row.operation !== operation ||
      row.binding !== mfaBinding(configured(), input)
    )
      return fail(409, 'This request ID was already used for a different MFA command or session.');
    return get<MfaEvent>(db, 'mfaEvents', String(row.eventId))!;
  }
  function record(
    req: AuthRequest,
    user: User,
    operation: MfaOperation,
    input: { requestId: string; expectedRevision: string },
    before: MfaStateSnapshot,
    pendingId: string | null,
  ): MfaEvent {
    const event: MfaEvent = {
      id: id(),
      userId: user.id,
      operation,
      requestId: input.requestId,
      expectedRevision: input.expectedRevision,
      pendingId,
      before,
      after: snapshot(user.id),
      createdById: user.id,
      createdByName: user.name,
      createdAt: nowISO(),
    };
    db.prepare('INSERT INTO mfaEvents(id,userId,operation,data) VALUES (?,?,?,?)').run(
      event.id,
      user.id,
      operation,
      JSON.stringify(event),
    );
    db.prepare(
      'INSERT INTO mfaCommands(requestId,userId,sessionHash,operation,binding,eventId,pendingId) VALUES (?,?,?,?,?,?,?)',
    ).run(
      input.requestId,
      user.id,
      req.sessionToken!,
      operation,
      mfaBinding(configured(), input),
      event.id,
      pendingId,
    );
    audit(req, `MFA ${operation}`, 'user', user.id);
    db.prepare('DELETE FROM mfaAttempts WHERE userId=?').run(user.id);
    return event;
  }
  function readPending(req: AuthRequest, user: User, pendingId: string, kind: MfaPending['kind']) {
    const pending = db.prepare('SELECT * FROM mfaPending WHERE id=?').get(pendingId) as unknown as
      PendingRow | undefined;
    if (
      !pending ||
      pending.userId !== user.id ||
      pending.sessionHash !== req.sessionToken ||
      pending.kind !== kind ||
      pending.expiresAt <= Date.now() ||
      pending.fingerprint !== fingerprint(user.id)
    )
      return fail(410, 'This MFA setup expired or was replaced. Start a new setup.');
    return pending;
  }
  function preparation(req: AuthRequest, user: User, event: MfaEvent): MfaPreparation {
    const kind = event.operation === 'enrollment-prepared' ? 'enrollment' : 'recovery-codes';
    const pending = readPending(req, user, event.pendingId!, kind);
    const value = openMfa<PendingPayload>(
      configured(),
      user.id,
      `pending:${pending.id}`,
      pending.payload,
    );
    return {
      event,
      status: status(user.id, req.sessionToken),
      setup: {
        ...publicPending(pending),
        recoveryCodes: value.recoveryCodes,
        ...(value.secret ? { secret: value.secret, otpauthUri: value.otpauthUri } : {}),
      },
    };
  }
  function revokeOthers(req: AuthRequest, userId: string) {
    invalidateMfaTransient(db, userId);
    db.prepare('DELETE FROM sessions WHERE userId=? AND tokenHash!=?').run(
      userId,
      req.sessionToken!,
    );
    db.prepare('UPDATE sessions SET mfaCredentialId=? WHERE tokenHash=?').run(
      credential(userId)?.id ?? null,
      req.sessionToken!,
    );
    db.prepare('DELETE FROM recoveryGrants WHERE userId=?').run(userId);
  }
  function addCodes(userId: string, credentialId: string, codes: string[]) {
    for (const code of codes)
      db.prepare(
        'INSERT INTO mfaRecoveryCodes(codeHash,userId,credentialId,usedAt) VALUES (?,?,?,NULL)',
      ).run(recoveryCodeHash(credentialId, code), userId, credentialId);
  }
  const strictQuery = (req: AuthRequest) => z.object({}).strict().parse(req.query);
  app.get('/api/auth/mfa', (req: AuthRequest, res) => {
    const user = actor(req);
    strictQuery(req);
    res.json(
      transaction(() => {
        revalidateSession(req, user);
        const value = status(user.id, req.sessionToken);
        audit(req, 'viewed own MFA settings', 'user', user.id);
        return value;
      }),
    );
  });
  for (const kind of ['enrollment', 'recovery-codes'] as const) {
    app.post(`/api/auth/mfa/${kind}/prepare`, (req: AuthRequest, res) => {
      const user = actor(req);
      strictQuery(req);
      configured();
      const input = (
        kind === 'enrollment'
          ? z.object({ currentPassword: password, ...commandFields }).strict()
          : z.object({ currentPassword: password, proof: proofSchema, ...commandFields }).strict()
      ).parse(req.body);
      const operation = kind === 'enrollment' ? 'enrollment-prepared' : 'recovery-codes-prepared';
      res.json(
        management(req, user, () => {
          verifyCurrentPassword(user.id, input.currentPassword);
          const prior = replay(req, user, operation, input);
          if (prior) return preparation(req, user, prior);
          assertRevision(user.id, input.expectedRevision);
          const before = snapshot(user.id),
            current = credential(user.id);
          if (kind === 'enrollment' ? !!current : !current)
            return fail(
              409,
              kind === 'enrollment'
                ? 'MFA is already enabled.'
                : 'Enable MFA before replacing recovery codes.',
            );
          if ('proof' in input) verifyProof(user.id, input.proof as MfaProof);
          if (!protectedMaterial())
            db.prepare(
              'INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
            ).run(keyCheckName, mfaKeyCheck(configured()));
          const pendingId = id(),
            credentialId = current?.id ?? id(),
            secret = kind === 'enrollment' ? base32(randomBytes(20)) : undefined;
          const issuer = 'Derma Clinic';
          const payload: PendingPayload = {
            credentialId,
            recoveryCodes: recoveryCodes(),
            ...(secret
              ? {
                  secret,
                  otpauthUri: `otpauth://totp/${encodeURIComponent(`${issuer}:${user.email}`)}?${new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' })}`,
                }
              : {}),
          };
          db.prepare('DELETE FROM mfaPending WHERE userId=? OR expiresAt<=?').run(
            user.id,
            Date.now(),
          );
          const event = record(req, user, operation, input, before, pendingId);
          db.prepare(
            'INSERT INTO mfaPending(id,userId,sessionHash,kind,expiresAt,fingerprint,payload,eventId) VALUES (?,?,?,?,?,?,?,?)',
          ).run(
            pendingId,
            user.id,
            req.sessionToken!,
            kind,
            Date.now() + pendingLifetime,
            fingerprint(user.id),
            sealMfa(configured(), user.id, `pending:${pendingId}`, payload),
            event.id,
          );
          return preparation(req, user, event);
        }),
      );
    });
    app.post(`/api/auth/mfa/${kind}/confirm`, (req: AuthRequest, res) => {
      const user = actor(req);
      strictQuery(req);
      configured();
      const fields = {
        pendingId: z.string().uuid(),
        savedRecoveryCodes: z.literal(true),
        ...commandFields,
      };
      const input = (
        kind === 'enrollment'
          ? z.object({ ...fields, code: z.string().regex(/^\d{6}$/) }).strict()
          : z.object(fields).strict()
      ).parse(req.body);
      const operation = kind === 'enrollment' ? 'enabled' : 'recovery-codes-replaced';
      res.json(
        management(req, user, (): MfaMutation => {
          const prior = replay(req, user, operation, input);
          if (prior) return { status: status(user.id, req.sessionToken), event: prior };
          assertRevision(user.id, input.expectedRevision);
          const pending = readPending(req, user, input.pendingId, kind),
            value = openMfa<PendingPayload>(
              configured(),
              user.id,
              `pending:${pending.id}`,
              pending.payload,
            );
          const before = snapshot(user.id),
            current = credential(user.id);
          if (kind === 'enrollment') {
            if (current) return fail(409, 'MFA is already enabled.');
            checkBudget(user.id);
            const step = acceptedTotpStep(
              value.secret!,
              'code' in input ? String(input.code) : '',
              Date.now(),
              -1,
            );
            if (step === null) throw new InvalidProof();
            db.prepare(
              'INSERT INTO mfaCredentials(userId,id,secret,enabledAt,lastStep) VALUES (?,?,?,?,?)',
            ).run(
              user.id,
              value.credentialId,
              sealMfa(configured(), user.id, `credential:${value.credentialId}`, {
                secret: value.secret,
              }),
              nowISO(),
              step,
            );
          } else if (!current || current.id !== value.credentialId)
            return fail(410, 'This recovery-code setup is no longer valid.');
          db.prepare('DELETE FROM mfaRecoveryCodes WHERE userId=?').run(user.id);
          addCodes(user.id, value.credentialId, value.recoveryCodes);
          revokeOthers(req, user.id);
          const event = record(req, user, operation, input, before, pending.id);
          return { status: status(user.id, req.sessionToken), event };
        }),
      );
    });
  }
  app.post('/api/auth/mfa/disable', (req: AuthRequest, res) => {
    const user = actor(req);
    strictQuery(req);
    configured();
    const input = z
      .object({ currentPassword: password, proof: proofSchema, ...commandFields })
      .strict()
      .parse(req.body);
    res.json(
      management(req, user, (): MfaMutation => {
        const prior = replay(req, user, 'disabled', input);
        if (prior) return { status: status(user.id, req.sessionToken), event: prior };
        assertRevision(user.id, input.expectedRevision);
        const before = snapshot(user.id);
        verifyCurrentPassword(user.id, input.currentPassword);
        verifyProof(user.id, input.proof);
        db.prepare('DELETE FROM mfaCredentials WHERE userId=?').run(user.id);
        revokeOthers(req, user.id);
        const event = record(req, user, 'disabled', input, before, null);
        return { status: status(user.id, req.sessionToken), event };
      }),
    );
  });
  function clearChallenge(res: Response) {
    res.clearCookie(challengeCookie, {
      httpOnly: true,
      sameSite: 'lax',
      secure: production,
      path: cookiePath,
    });
  }
  function challenge(req: AuthRequest, csrf: boolean) {
    const token = req.headers.cookie
      ?.split(';')
      .map((value) => value.trim())
      .find((value) => value.startsWith(`${challengeCookie}=`))
      ?.slice(challengeCookie.length + 1);
    if (!token || !/^[a-f0-9]{64}$/.test(token))
      return fail(401, 'Sign in again to start a new verification challenge.');
    const tokenHash = mfaHash(token),
      row = db
        .prepare('SELECT * FROM mfaChallenges WHERE tokenHash=? AND expiresAt>?')
        .get(tokenHash, Date.now());
    if (!row) return fail(401, 'The verification challenge expired. Sign in again.');
    const user = get<User>(db, 'users', String(row.userId)),
      current = credential(String(row.userId));
    if (
      !user ||
      user.active === false ||
      !current ||
      current.id !== row.credentialId ||
      row.fingerprint !== fingerprint(user.id)
    )
      return fail(401, 'The account changed. Sign in again to verify.');
    if (csrf && req.headers['x-mfa-csrf-token'] !== row.csrfToken)
      return fail(403, 'The verification security token is missing or expired.');
    return { row, user, current, tokenHash };
  }
  const challengeView = (value: ReturnType<typeof challenge>): MfaChallenge => ({
    mfaRequired: true,
    accountId: value.user.id,
    csrfToken: String(value.row.csrfToken),
    expiresAt: new Date(Number(value.row.expiresAt)).toISOString(),
  });
  app.get('/api/auth/mfa/challenge', (req: AuthRequest, res) => {
    strictQuery(req);
    res.json(transaction(() => challengeView(challenge(req, false))));
  });
  app.post('/api/auth/mfa/challenge/cancel', (req: AuthRequest, res) => {
    strictQuery(req);
    z.object({}).strict().parse(req.body);
    transaction(() => {
      const current = challenge(req, true);
      db.prepare('DELETE FROM mfaChallenges WHERE tokenHash=?').run(current.tokenHash);
    });
    clearChallenge(res);
    res.json({ ok: true });
  });
  app.post('/api/auth/mfa/verify', (req: AuthRequest, res) => {
    strictQuery(req);
    const input = z.object({ proof: proofSchema }).strict().parse(req.body);
    const owner = challenge(req, true).user.id;
    const issued = sensitive(owner, () => {
      const current = challenge(req, true);
      verifyProof(owner, input.proof);
      db.prepare('DELETE FROM mfaChallenges WHERE tokenHash=?').run(current.tokenHash);
      db.prepare('DELETE FROM mfaAttempts WHERE userId=?').run(owner);
      const issued = issueSession(current.user, req, current.current.id);
      audit({ ...req, user: current.user } as AuthRequest, 'signed in with MFA', 'user', owner);
      return issued;
    });
    issued.apply(res);
    clearChallenge(res);
    res.json(issued.session);
  });
  function beginLogin(
    user: User,
    req: AuthRequest,
    res: Response,
    verifiedPasswordHash: string,
    securityVersion: number,
  ): MfaChallenge | null {
    if (!credential(user.id)) return null;
    configured();
    const token = randomBytes(32).toString('hex'),
      csrfToken = randomBytes(32).toString('hex'),
      expiresAt = Date.now() + challengeLifetime;
    transaction(() => {
      configured();
      const account = db.prepare('SELECT password FROM users WHERE id=?').get(user.id);
      const currentUser = get<User>(db, 'users', user.id);
      if (
        !currentUser ||
        currentUser.active === false ||
        account?.password !== verifiedPasswordHash ||
        Number(
          db.prepare('SELECT version FROM mfaEpochs WHERE userId=?').get(user.id)?.version ?? 0,
        ) !== securityVersion
      )
        return fail(409, 'The account changed. Sign in again.');
      const current = credential(user.id);
      if (!current) return fail(409, 'MFA settings changed. Sign in again.');
      checkBudget(user.id);
      db.prepare('DELETE FROM mfaChallenges WHERE userId=? OR expiresAt<=?').run(
        user.id,
        Date.now(),
      );
      if (req.sessionToken)
        db.prepare('DELETE FROM sessions WHERE tokenHash=?').run(req.sessionToken);
      db.prepare(
        'INSERT INTO mfaChallenges(tokenHash,userId,credentialId,csrfToken,fingerprint,expiresAt) VALUES (?,?,?,?,?,?)',
      ).run(mfaHash(token), user.id, current.id, csrfToken, fingerprint(user.id), expiresAt);
      audit({ ...req, user } as AuthRequest, 'started MFA login verification', 'user', user.id);
    });
    clearSessionCookie(res);
    res.cookie(challengeCookie, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: production,
      path: cookiePath,
      maxAge: challengeLifetime,
    });
    return {
      mfaRequired: true,
      accountId: user.id,
      csrfToken,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }
  return { beginLogin, clearChallenge };
}
