import { createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import type { Request } from 'express';
import type { User } from '../shared/types.ts';
import { id, insert, nowISO, verifyPassword, type DB } from './db.ts';

const windowMs = 15 * 60_000;
const identifierLimit = 10;
const keyName = 'auth-security-hmac-key-v1';
const networkLimits = {
  login: 20,
  register: 10,
  'change-password': 10,
  'issue-recovery': 10,
  'redeem-recovery': 20,
} as const;
type NetworkOperation = keyof typeof networkLimits;
interface Counter {
  scope: string;
  subjectHash: string;
  windowStart: number;
  attempts: number;
  throttleLogged: number;
}
export interface VerifiedPassword {
  user: User;
  passwordHash: string;
  securityVersion: number;
}
export class AuthenticationThrottle extends Error {
  constructor(
    public retryAfter: number,
    public scope: string,
    public subjectHash: string,
    public auditPending = false,
  ) {
    super(`Too many attempts. Wait at least ${retryAfter} seconds before trying again.`);
  }
}
interface Dependencies {
  db: DB;
  dummyPasswordHash: string;
  fail: (status: number, message: string) => never;
}

/** Durable counters and failure audits use keyed subjects, never raw submitted credentials or IPs. */
export function createAuthSecurity({ db, dummyPasswordHash, fail }: Dependencies) {
  db.exec(`CREATE TABLE IF NOT EXISTS authRateLimits (
    scope TEXT NOT NULL, subjectHash TEXT NOT NULL, windowStart INTEGER NOT NULL,
    attempts INTEGER NOT NULL CHECK(attempts>=0), throttleLogged INTEGER NOT NULL DEFAULT 0 CHECK(throttleLogged IN (0,1)),
    PRIMARY KEY(scope,subjectHash)
  );
  CREATE INDEX IF NOT EXISTS auth_rate_limits_expiry ON authRateLimits(windowStart);`);
  function transaction<T>(work: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  const key = transaction(() => {
    let row = db.prepare('SELECT value FROM meta WHERE key=?').get(keyName);
    if (!row) {
      if (db.prepare('SELECT 1 FROM authRateLimits LIMIT 1').get())
        throw new Error(
          'The authentication rate-limit key is missing for existing security counters.',
        );
      const value = randomBytes(32).toString('hex');
      db.prepare('INSERT INTO meta(key,value) VALUES (?,?)').run(keyName, value);
      row = { value };
    }
    if (typeof row.value !== 'string' || !/^[a-f0-9]{64}$/.test(row.value))
      throw new Error('The persisted authentication rate-limit key is invalid.');
    return Buffer.from(row.value, 'hex');
  });
  const pseudonym = (kind: 'network' | 'identifier', value: string) =>
    createHmac('sha256', key).update(`auth-security-v1:${kind}:`).update(value).digest('hex');
  const identifierHash = (value: string) => pseudonym('identifier', value.trim().toLowerCase());
  const networkHash = (req: Request) => {
    let address = (req.ip ?? req.socket.remoteAddress ?? 'unknown').trim().toLowerCase();
    if (isIP(address) === 6) {
      try {
        address = new URL(`http://[${address}]/`).hostname.slice(1, -1);
      } catch {
        address = 'unknown';
      }
      const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(address);
      if (mapped) {
        const high = parseInt(mapped[1], 16),
          low = parseInt(mapped[2], 16);
        address = [high >>> 8, high & 255, low >>> 8, low & 255].join('.');
      }
    } else if (isIP(address) !== 4) address = 'unknown';
    return pseudonym('network', address);
  };
  const counter = (scope: string, subjectHash: string, now = Date.now()) =>
    db
      .prepare(
        'SELECT scope,subjectHash,windowStart,attempts,throttleLogged FROM authRateLimits WHERE scope=? AND subjectHash=? AND windowStart>?',
      )
      .get(scope, subjectHash, now - windowMs) as unknown as Counter | undefined;
  function clean(now: number) {
    db.prepare(
      'DELETE FROM authRateLimits WHERE rowid IN (SELECT rowid FROM authRateLimits WHERE windowStart<=? ORDER BY windowStart LIMIT 256)',
    ).run(now - windowMs);
  }
  function securityAudit(action: string, scope: string, subjectHash: string) {
    insert(db, 'audit', {
      id: id(),
      actorName: 'Unauthenticated',
      action,
      entityType: 'auth-security',
      entityId: `${scope}:${subjectHash}`,
      createdAt: nowISO(),
    } as { id: string });
  }
  function logThrottle(row: Counter) {
    if (row.throttleLogged) return;
    db.prepare('UPDATE authRateLimits SET throttleLogged=1 WHERE scope=? AND subjectHash=?').run(
      row.scope,
      row.subjectHash,
    );
    securityAudit('authentication throttled', row.scope, row.subjectHash);
  }
  const remaining = (row: Counter, now: number) =>
    Math.max(1, Math.ceil((row.windowStart + windowMs - now) / 1000));
  function loginRetry(req: Request, row: Counter, identifier: string | undefined, now: number) {
    let seconds = remaining(row, now);
    const network = counter('network:login', networkHash(req), now);
    if (network && network.attempts >= networkLimits.login)
      seconds = Math.max(seconds, remaining(network, now));
    if (identifier) {
      const account = counter('identifier:login', identifierHash(identifier), now);
      if (account && account.attempts >= identifierLimit)
        seconds = Math.max(seconds, remaining(account, now));
    }
    return seconds;
  }
  function rateLimit(req: Request, operation: string, max?: number) {
    if (!(operation in networkLimits)) throw new Error('Unknown authentication limiter operation.');
    const limit = networkLimits[operation as NetworkOperation];
    if (max !== undefined && max !== limit)
      throw new Error('Authentication limiter threshold does not match its configured operation.');
    const subjectHash = networkHash(req),
      scope = `network:${operation}`;
    const blocked = transaction(() => {
      const now = Date.now();
      clean(now);
      const row = counter(scope, subjectHash, now);
      if (row && row.attempts >= limit) {
        logThrottle(row);
        const submitted = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
        const identifier = submitted.length > 0 && submitted.length <= 254 ? submitted : undefined;
        return new AuthenticationThrottle(
          operation === 'login' ? loginRetry(req, row, identifier, now) : remaining(row, now),
          scope,
          subjectHash,
        );
      }
      db.prepare(
        `INSERT INTO authRateLimits(scope,subjectHash,windowStart,attempts,throttleLogged) VALUES (?,?,?,1,0)
        ON CONFLICT(scope,subjectHash) DO UPDATE SET
        attempts=CASE WHEN windowStart<=? THEN 1 ELSE attempts+1 END,
        throttleLogged=CASE WHEN windowStart<=? THEN 0 ELSE throttleLogged END,
        windowStart=CASE WHEN windowStart<=? THEN excluded.windowStart ELSE windowStart END`,
      ).run(scope, subjectHash, now, now - windowMs, now - windowMs, now - windowMs);
      return null;
    });
    if (blocked) throw blocked;
  }
  function verifyLogin(req: Request, email: string, password: string): VerifiedPassword {
    const subjectHash = identifierHash(email),
      scope = 'identifier:login';
    const result = transaction(() => {
      const now = Date.now();
      clean(now);
      const row = counter(scope, subjectHash, now);
      if (row && row.attempts >= identifierLimit) {
        logThrottle(row);
        return {
          blocked: new AuthenticationThrottle(loginRetry(req, row, email, now), scope, subjectHash),
        };
      }
      const stored = db
        .prepare(
          'SELECT data,password,COALESCE((SELECT version FROM mfaEpochs WHERE userId=users.id),0) securityVersion FROM users WHERE email=? COLLATE NOCASE',
        )
        .get(email.trim().toLowerCase());
      const validPassword = verifyPassword(password, String(stored?.password ?? dummyPasswordHash));
      const user = stored ? (JSON.parse(String(stored.data)) as User) : null;
      if (!validPassword || !user || user.active === false) {
        const attempts = (row?.attempts ?? 0) + 1;
        db.prepare(
          `INSERT INTO authRateLimits(scope,subjectHash,windowStart,attempts,throttleLogged) VALUES (?,?,?,?,0)
          ON CONFLICT(scope,subjectHash) DO UPDATE SET attempts=excluded.attempts,
          throttleLogged=CASE WHEN windowStart<=? THEN 0 ELSE throttleLogged END,
          windowStart=CASE WHEN windowStart<=? THEN excluded.windowStart ELSE windowStart END`,
        ).run(scope, subjectHash, now, attempts, now - windowMs, now - windowMs);
        if (attempts === 1) securityAudit('authentication failed', scope, subjectHash);
        if (attempts === identifierLimit)
          securityAudit('authentication failure limit reached', scope, subjectHash);
        return { failed: true };
      }
      return {
        verified: {
          user,
          passwordHash: String(stored!.password),
          securityVersion: Number(stored!.securityVersion),
        },
      };
    });
    if (result.blocked) throw result.blocked;
    if (result.verified) return result.verified;
    return fail(401, 'Email or password is incorrect.');
  }
  /** Caller holds the final session/challenge transaction and has revalidated current verified credentials. */
  function acceptPassword(req: Request, email: string) {
    const subjectHash = identifierHash(email),
      scope = 'identifier:login',
      now = Date.now(),
      row = counter(scope, subjectHash, now);
    if (row && row.attempts >= identifierLimit)
      throw new AuthenticationThrottle(loginRetry(req, row, email, now), scope, subjectHash, true);
    db.prepare('DELETE FROM authRateLimits WHERE scope=? AND subjectHash=?').run(
      scope,
      subjectHash,
    );
  }
  /** A concurrent lock can appear between verification and final issuance. Record it only after issuance rolled back. */
  function finalize<T>(work: () => T): T {
    try {
      return work();
    } catch (error) {
      if (error instanceof AuthenticationThrottle && error.auditPending)
        transaction(() => {
          const row = counter(error.scope, error.subjectHash);
          if (row && row.attempts >= identifierLimit) logThrottle(row);
        });
      throw error;
    }
  }
  return { rateLimit, verifyLogin, acceptPassword, finalize };
}
