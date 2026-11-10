import type { Express, Request } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { AuthRequest } from './app.ts';
import { get, hashPassword, list, type DB } from './db.ts';
import type { Doctor, Patient, User } from '../shared/types.ts';
import type { AccountSession, ManagedAccount, RecoveryGrant } from '../shared/identity.ts';

interface IdentityContext {
  db: DB;
  production: boolean;
  actor: (req: AuthRequest, roles?: User['role'][]) => User;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
  rateLimit: (req: Request, key: string, max?: number) => void;
}

const tokenDigest = (token: string) => createHash('sha256').update(token).digest('hex');
const roles = z.enum(['admin', 'doctor', 'receptionist', 'patient']);
const required = z.string().trim().min(1).max(300);
const newPassword = z.string().min(12, 'Use at least 12 characters').max(128);
const sessionDuration = 12 * 3600000;

/** Existing accounts retain their previous access; newly provisioned accounts opt into rotation. */
export function managedAccount(user: User): ManagedAccount {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    ...(user.patientId ? { patientId: user.patientId } : {}),
    ...(user.doctorId ? { doctorId: user.doctorId } : {}),
    active: user.active !== false,
    mustChangePassword: user.mustChangePassword === true,
  };
}

export function initializeIdentity(db: DB) {
  const columns = db.prepare('PRAGMA table_info(sessions)').all();
  if (!columns.some((column) => column.name === 'createdAt'))
    db.exec('ALTER TABLE sessions ADD COLUMN createdAt INTEGER');
  if (!columns.some((column) => column.name === 'label'))
    db.exec("ALTER TABLE sessions ADD COLUMN label TEXT NOT NULL DEFAULT 'Browser session'");
  // Legacy sessions had a fixed twelve-hour lifetime, so their creation time is reconstructable.
  db.prepare('UPDATE sessions SET createdAt=MAX(0,expiresAt-?) WHERE createdAt IS NULL').run(
    sessionDuration,
  );
  db.exec(`CREATE TABLE IF NOT EXISTS recoveryGrants (
    tokenHash TEXT PRIMARY KEY,
    userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    createdAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS recovery_user ON recoveryGrants(userId);`);
}

/** Never persist raw user-agent strings, network addresses, or arbitrary user input as labels. */
export function sessionLabel(userAgent: string | undefined) {
  if (!userAgent) return 'Browser session';
  if (/Edg\//i.test(userAgent)) return 'Microsoft Edge browser';
  if (/Firefox\//i.test(userAgent)) return 'Firefox browser';
  if (/Chrome\//i.test(userAgent) || /CriOS\//i.test(userAgent)) return 'Chrome browser';
  if (/Safari\//i.test(userAgent)) return 'Safari browser';
  return 'Browser session';
}

/** Restrict temporary-password sessions before any private application route executes. */
export function restrictedSessionAllows(method: string, path: string) {
  if (['GET', 'HEAD'].includes(method))
    return [
      '/session',
      '/auth/sessions',
      '/doctors',
      '/settings',
      '/slots',
      '/knowledge',
      '/health',
    ].includes(path);
  if (method === 'POST')
    return [
      '/auth/password',
      '/auth/logout',
      '/auth/sessions/revoke-others',
      '/auth/login',
      '/auth/register',
      '/auth/recover',
    ].includes(path);
  return method === 'DELETE' && /^\/auth\/sessions\/[a-f0-9]{64}$/.test(path);
}

export function validateAccountLinkage(
  db: DB,
  account: Pick<User, 'role' | 'doctorId' | 'patientId'>,
  fail: IdentityContext['fail'],
) {
  if (account.role === 'patient') {
    if (!account.patientId || !get<Patient>(db, 'patients', account.patientId))
      fail(400, 'A patient account must remain linked to its patient record.');
    if (account.doctorId) fail(400, 'Patient accounts cannot be linked to doctor profiles.');
    return;
  }
  if (account.patientId) fail(400, 'Staff accounts cannot be linked to patient records.');
  if (account.role === 'doctor' && !account.doctorId)
    fail(400, 'Link a doctor account to a doctor profile.');
  if (account.role === 'receptionist' && account.doctorId)
    fail(400, 'Reception accounts cannot be linked to doctor profiles.');
  if (account.doctorId && !get<Doctor>(db, 'doctors', account.doctorId))
    fail(404, 'Doctor profile not found.');
}

export function registerIdentity(app: Express, context: IdentityContext) {
  const { db, production, actor, audit, fail, rateLimit } = context;
  app.get('/api/accounts', (req: AuthRequest, res) => {
    actor(req, ['admin']);
    const query = z
      .object({ search: z.string().trim().max(300).optional(), role: roles.optional() })
      .parse(req.query);
    const search = query.search?.toLowerCase() ?? '';
    res.json(
      list<User>(db, 'users')
        .map(managedAccount)
        .filter(
          (account) =>
            (!query.role || account.role === query.role) &&
            (!search || `${account.name} ${account.email}`.toLowerCase().includes(search)),
        ),
    );
  });
  app.patch('/api/accounts/:id', (req: AuthRequest, res) => {
    const administrator = actor(req, ['admin']);
    const accountId = String(req.params.id);
    const input = z
      .object({
        name: required.optional(),
        role: roles.optional(),
        doctorId: required.nullable().optional(),
        active: z.boolean().optional(),
      })
      .strict()
      .refine((value) => Object.keys(value).length > 0, 'No changes supplied')
      .parse(req.body);
    let updated: ManagedAccount;
    db.exec('BEGIN IMMEDIATE');
    try {
      const originalUser = get<User>(db, 'users', accountId);
      if (!originalUser) fail(404, 'Account not found.');
      const original = managedAccount(originalUser!);
      if (
        input.role &&
        input.role !== original.role &&
        (input.role === 'patient' || original.role === 'patient')
      )
        fail(400, 'Patient and staff accounts cannot be converted or relinked.');
      if (accountId === administrator.id && input.active === false)
        fail(400, 'You cannot deactivate your own account.');
      const doctorId = input.doctorId === null ? undefined : (input.doctorId ?? original.doctorId);
      updated = { ...original, ...input, doctorId };
      if (!doctorId) delete updated.doctorId;
      validateAccountLinkage(db, updated, fail);
      if (
        original.active &&
        original.role === 'admin' &&
        (!updated.active || updated.role !== 'admin')
      ) {
        const activeAdmins = list<User>(db, 'users').filter(
          (user) => user.role === 'admin' && user.active !== false,
        ).length;
        if (activeAdmins <= 1) fail(409, 'Keep at least one active administrator account.');
      }
      db.prepare('UPDATE users SET role=?,data=? WHERE id=?').run(
        updated.role,
        JSON.stringify(updated),
        accountId,
      );
      if (
        updated.active !== original.active ||
        updated.role !== original.role ||
        updated.doctorId !== original.doctorId
      ) {
        db.prepare('DELETE FROM sessions WHERE userId=?').run(accountId);
        db.prepare('DELETE FROM recoveryGrants WHERE userId=?').run(accountId);
      }
      audit(req, 'updated account access', 'user', accountId);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    res.json(updated);
  });
  app.get('/api/auth/sessions', (req: AuthRequest, res) => {
    const user = actor(req);
    const rows = db
      .prepare(
        'SELECT tokenHash,createdAt,expiresAt,label FROM sessions WHERE userId=? AND expiresAt>? ORDER BY createdAt DESC',
      )
      .all(user.id, Date.now());
    const sessions: AccountSession[] = rows.map((row) => ({
      id: String(row.tokenHash),
      createdAt: new Date(
        Number(row.createdAt ?? Number(row.expiresAt) - sessionDuration),
      ).toISOString(),
      expiresAt: new Date(Number(row.expiresAt)).toISOString(),
      current: row.tokenHash === req.sessionToken,
      label: String(row.label || 'Browser session'),
    }));
    res.json(sessions);
  });
  app.post('/api/auth/sessions/revoke-others', (req: AuthRequest, res) => {
    const user = actor(req);
    const result = db
      .prepare('DELETE FROM sessions WHERE userId=? AND tokenHash!=?')
      .run(user.id, req.sessionToken!);
    audit(req, 'revoked other sessions', 'user', user.id);
    res.json({ ok: true, revoked: Number(result.changes) });
  });
  app.delete('/api/auth/sessions/:id', (req: AuthRequest, res) => {
    const user = actor(req);
    const sessionId = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(req.params.id);
    const result = db
      .prepare('DELETE FROM sessions WHERE userId=? AND tokenHash=?')
      .run(user.id, sessionId);
    if (!result.changes) return fail(404, 'Session not found.');
    if (sessionId === req.sessionToken)
      res.clearCookie('derma_session', {
        httpOnly: true,
        sameSite: 'lax',
        secure: production,
        path: '/',
      });
    audit(req, 'revoked session', 'user', user.id);
    res.json({ ok: true });
  });
  app.post('/api/accounts/:id/recovery', (req: AuthRequest, res) => {
    actor(req, ['admin']);
    rateLimit(req, 'issue-recovery', 10);
    z.object({ identityVerified: z.literal(true) })
      .strict()
      .parse(req.body);
    const user = get<User>(db, 'users', String(req.params.id));
    if (!user) return fail(404, 'Account not found.');
    if (user.active === false)
      return fail(409, 'Reactivate this account before issuing recovery access.');
    const token = randomBytes(32).toString('hex'),
      createdAt = Date.now(),
      expiresAt = createdAt + 30 * 60000;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM recoveryGrants WHERE userId=? OR expiresAt<=?').run(
        user.id,
        createdAt,
      );
      db.prepare(
        'INSERT INTO recoveryGrants(tokenHash,userId,createdAt,expiresAt) VALUES (?,?,?,?)',
      ).run(tokenDigest(token), user.id, createdAt, expiresAt);
      audit(req, 'issued account recovery after identity verification', 'user', user.id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    const grant: RecoveryGrant = { token, expiresAt: new Date(expiresAt).toISOString() };
    res.status(201).json(grant);
  });
  app.post('/api/auth/recover', (req: AuthRequest, res) => {
    rateLimit(req, 'redeem-recovery', 20);
    const input = z
      .object({ token: z.string().regex(/^[a-f0-9]{64}$/), password: newPassword })
      .strict()
      .parse(req.body);
    db.exec('BEGIN IMMEDIATE');
    try {
      const grant = db
        .prepare('SELECT userId FROM recoveryGrants WHERE tokenHash=? AND expiresAt>?')
        .get(tokenDigest(input.token), Date.now()) as { userId: string } | undefined;
      if (!grant) fail(400, 'Recovery access is invalid or expired.');
      const user = get<User>(db, 'users', grant!.userId);
      if (!user || user.active === false) fail(400, 'Recovery access is invalid or expired.');
      const updated = { ...managedAccount(user!), mustChangePassword: false };
      db.prepare('UPDATE users SET password=?,data=? WHERE id=?').run(
        hashPassword(input.password),
        JSON.stringify(updated),
        updated.id,
      );
      db.prepare('DELETE FROM recoveryGrants WHERE userId=?').run(updated.id);
      db.prepare('DELETE FROM sessions WHERE userId=?').run(updated.id);
      audit(
        { ...req, user: updated } as AuthRequest,
        'recovered account password',
        'user',
        updated.id,
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    res.json({ ok: true });
  });
}
