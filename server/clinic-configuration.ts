import type { Express } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AuthRequest } from './app.ts';
import type { ClinicSettings, User } from '../shared/types.ts';
import type {
  ClinicProfile,
  ClinicModules,
  ClinicConfigurationScope,
  ClinicConfigurationChange,
  ClinicConfigurationContext,
  ClinicConfigurationMutation,
  ClinicConfigurationHistory,
} from '../shared/clinic-configuration.ts';
import { get, id, nowISO, settings, type DB } from './db.ts';
import { mfaSessionAllowed } from './mfa.ts';

interface Dependencies {
  db: DB;
  actor: (req: AuthRequest, roles?: User['role'][]) => User;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
}
type StoredChange = ClinicConfigurationChange & {
  createdById: string;
  requestId: string | null;
  expectedRevision: string | null;
};
const short = z.string().trim().max(300);
const email = z
  .string()
  .trim()
  .email()
  .max(254)
  .transform((value) => value.toLowerCase())
  .or(z.literal(''));
const profileSchema = z
  .object({
    name: short.min(1),
    tagline: short,
    phone: short,
    email,
    address: short,
    hours: short,
    timezone: z.literal('Asia/Kolkata'),
  })
  .strict();
const modulesFields = { intake: z.boolean(), images: z.boolean(), followUp: z.boolean() };
const modulesSchema = z.object(modulesFields).strict();
// Preserve the former PATCH schema's partial outer object and unknown-field stripping.
const legacySchema = z
  .object({ ...profileSchema.shape, modules: z.object(modulesFields) })
  .partial();
const commandFields = {
  reason: z.string().trim().min(1).max(1000),
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  requestId: z
    .string()
    .uuid()
    .transform((value) => value.toLowerCase()),
};
const profileInput = z.object({ profile: profileSchema, ...commandFields }).strict();
const modulesInput = z.object({ modules: modulesSchema, ...commandFields }).strict();
const empty = z.object({}).strict();
const historyQuery = z
  .object({
    scope: z.enum(['all', 'profile', 'modules']).default('all'),
    page: z
      .string()
      .regex(/^[1-9]\d{0,6}$/)
      .transform(Number)
      .refine((value) => value <= 1000000)
      .default(1),
    pageSize: z.enum(['10', '25', '50']).transform(Number).default(25),
  })
  .strict();
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function profile(value: ClinicProfile): ClinicProfile {
  return {
    name: value.name,
    tagline: value.tagline,
    phone: value.phone,
    email: value.email,
    address: value.address,
    hours: value.hours,
    timezone: 'Asia/Kolkata',
  };
}
function modules(value: ClinicModules): ClinicModules {
  return { intake: value.intake, images: value.images, followUp: value.followUp };
}
/** Only these current fields belong on the public settings endpoint. */
export function publicClinicSettings(db: DB): ClinicSettings {
  const value = settings(db);
  return { ...profile(value), modules: modules(value.modules) };
}
function safeChange(value: StoredChange): ClinicConfigurationChange {
  const fields = {
    id: value.id,
    source: value.source,
    reason: value.reason,
    createdByName: value.createdByName,
    createdAt: value.createdAt,
  };
  return value.scope === 'profile'
    ? { ...fields, scope: 'profile', before: profile(value.before), after: profile(value.after) }
    : { ...fields, scope: 'modules', before: modules(value.before), after: modules(value.after) };
}

export function registerClinicConfiguration(
  app: Express,
  { db, actor, audit, fail }: Dependencies,
) {
  db.exec(`CREATE TABLE IF NOT EXISTS clinicConfigurationChanges(
    id TEXT PRIMARY KEY,scope TEXT NOT NULL CHECK(scope IN ('profile','modules')),createdAt TEXT NOT NULL,data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS clinic_configuration_scope ON clinicConfigurationChanges(scope);
  CREATE INDEX IF NOT EXISTS clinic_configuration_history ON clinicConfigurationChanges(createdAt DESC,id DESC);
  CREATE INDEX IF NOT EXISTS clinic_configuration_scope_history ON clinicConfigurationChanges(scope,createdAt DESC,id DESC);
  CREATE TABLE IF NOT EXISTS clinicConfigurationCommands(
    requestId TEXT PRIMARY KEY,actorId TEXT NOT NULL REFERENCES users(id),scope TEXT NOT NULL,
    payload TEXT NOT NULL,changeId TEXT NOT NULL REFERENCES clinicConfigurationChanges(id)
  );`);
  for (const table of ['clinicConfigurationChanges', 'clinicConfigurationCommands'])
    db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT,'Clinic configuration history is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT,'Clinic configuration history is immutable'); END;`);
  function transaction<T>(work: () => T): T {
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
  function authorize(req: AuthRequest) {
    const cached = actor(req, ['admin']),
      user = get<User>(db, 'users', cached.id);
    const session = db
      .prepare('SELECT userId,expiresAt,csrfToken,mfaCredentialId FROM sessions WHERE tokenHash=?')
      .get(req.sessionToken ?? '');
    if (
      !user ||
      user.active === false ||
      !session ||
      session.userId !== user.id ||
      Number(session.expiresAt) <= Date.now() ||
      session.csrfToken !== req.csrfToken ||
      !mfaSessionAllowed(db, user.id, session.mfaCredentialId)
    )
      return fail(401, 'Your session changed. Sign in again.');
    if (user.mustChangePassword || user.role !== 'admin')
      return fail(403, 'Only an active administrator can manage clinic configuration.');
    req.user = user;
    return user;
  }
  function latest(scope: ClinicConfigurationScope) {
    const row = db
      .prepare(
        'SELECT data FROM clinicConfigurationChanges WHERE scope=? ORDER BY rowid DESC LIMIT 1',
      )
      .get(scope);
    return row ? safeChange(JSON.parse(row.data as string) as StoredChange) : null;
  }
  function context(): ClinicConfigurationContext {
    const settings = publicClinicSettings(db),
      latestProfileChange = latest('profile') as ClinicConfigurationContext['latestProfileChange'],
      latestModulesChange = latest('modules') as ClinicConfigurationContext['latestModulesChange'];
    return {
      settings,
      profileRevision: digest([profile(settings), latestProfileChange?.id ?? null]),
      modulesRevision: digest([modules(settings.modules), latestModulesChange?.id ?? null]),
      latestProfileChange,
      latestModulesChange,
    };
  }
  function record(
    req: AuthRequest,
    user: User,
    scope: ClinicConfigurationScope,
    before: ClinicProfile | ClinicModules,
    after: ClinicProfile | ClinicModules,
    source: 'reviewed' | 'legacy',
    reason: string | null,
    requestId: string | null,
    expectedRevision: string | null,
  ) {
    const fields = {
      id: id(),
      source,
      reason,
      createdByName: user.name,
      createdById: user.id,
      createdAt: nowISO(),
      requestId,
      expectedRevision,
    };
    const value: StoredChange =
      scope === 'profile'
        ? { ...fields, scope, before: before as ClinicProfile, after: after as ClinicProfile }
        : { ...fields, scope, before: before as ClinicModules, after: after as ClinicModules };
    db.prepare(
      'INSERT INTO clinicConfigurationChanges(id,scope,createdAt,data) VALUES (?,?,?,?)',
    ).run(value.id, scope, value.createdAt, JSON.stringify(value));
    audit(
      req,
      source === 'reviewed'
        ? `reviewed clinic ${scope} configuration`
        : `updated clinic ${scope} configuration via legacy settings`,
      'clinic-configuration',
      value.id,
    );
    return value;
  }
  function response(change: StoredChange): ClinicConfigurationMutation {
    if (!change.requestId || !change.expectedRevision)
      return fail(500, 'The original configuration receipt is unavailable.');
    return {
      context: context(),
      change: safeChange(change),
      receipt: {
        requestId: change.requestId,
        actorId: change.createdById,
        scope: change.scope,
        expectedRevision: change.expectedRevision,
        changeId: change.id,
      },
    };
  }
  app.get('/api/settings', (_req, res) => res.json(publicClinicSettings(db)));
  app.get('/api/clinic-configuration', (req: AuthRequest, res) =>
    res.json(
      transaction(() => {
        authorize(req);
        empty.parse(req.query);
        const value = context();
        audit(req, 'viewed clinic configuration', 'clinic-configuration', 'current');
        return value;
      }),
    ),
  );
  for (const scope of ['profile', 'modules'] as const)
    app.post(`/api/clinic-configuration/${scope}`, (req: AuthRequest, res) => {
      const result = transaction(() => {
        const user = authorize(req);
        empty.parse(req.query);
        const input =
          scope === 'profile' ? profileInput.parse(req.body) : modulesInput.parse(req.body);
        const prior = db
          .prepare(
            'SELECT actorId,scope,payload,changeId FROM clinicConfigurationCommands WHERE requestId=?',
          )
          .get(input.requestId);
        if (prior) {
          if (
            prior.actorId !== user.id ||
            prior.scope !== scope ||
            prior.payload !== JSON.stringify(input)
          )
            return fail(
              409,
              'This request identifier was already used for a different configuration change.',
            );
          const change = get<StoredChange>(
            db,
            'clinicConfigurationChanges',
            String(prior.changeId),
          );
          if (!change) return fail(500, 'The original configuration receipt is unavailable.');
          return { status: 200, value: response(change) };
        }
        const current = context(),
          expected = scope === 'profile' ? current.profileRevision : current.modulesRevision;
        if (input.expectedRevision !== expected)
          return fail(
            409,
            'This part of the clinic configuration changed. Review its current values before saving.',
          );
        const before =
          scope === 'profile' ? profile(current.settings) : modules(current.settings.modules);
        const after = 'profile' in input ? input.profile : input.modules;
        if (JSON.stringify(before) === JSON.stringify(after))
          return fail(400, 'Change at least one value before saving this configuration.');
        const updated: ClinicSettings =
          'profile' in input
            ? { ...input.profile, modules: current.settings.modules }
            : { ...current.settings, modules: input.modules };
        db.prepare("UPDATE meta SET value=? WHERE key='settings'").run(JSON.stringify(updated));
        const change = record(
          req,
          user,
          scope,
          before,
          after,
          'reviewed',
          input.reason,
          input.requestId,
          input.expectedRevision,
        );
        db.prepare(
          'INSERT INTO clinicConfigurationCommands(requestId,actorId,scope,payload,changeId) VALUES (?,?,?,?,?)',
        ).run(input.requestId, user.id, scope, JSON.stringify(input), change.id);
        return { status: 201, value: response(change) };
      });
      res.status(result.status).json(result.value);
    });
  app.get('/api/clinic-configuration/history', (req: AuthRequest, res) =>
    res.json(
      transaction((): ClinicConfigurationHistory => {
        authorize(req);
        const input = historyQuery.parse(req.query),
          where = input.scope === 'all' ? '' : ' WHERE scope=?',
          params = input.scope === 'all' ? [] : [input.scope];
        const total = Number(
          db.prepare(`SELECT count(*) AS n FROM clinicConfigurationChanges${where}`).get(...params)!
            .n,
        );
        const totalPages = Math.max(1, Math.ceil(total / input.pageSize)),
          page = Math.min(input.page, totalPages);
        const items = db
          .prepare(
            `SELECT data FROM clinicConfigurationChanges${where} ORDER BY createdAt DESC,id DESC LIMIT ? OFFSET ?`,
          )
          .all(...params, input.pageSize, (page - 1) * input.pageSize)
          .map((row) => safeChange(JSON.parse(row.data as string) as StoredChange));
        audit(req, 'viewed clinic configuration history', 'clinic-configuration', input.scope);
        return { items, page, pageSize: input.pageSize, total, totalPages };
      }),
    ),
  );
  app.patch('/api/settings', (req: AuthRequest, res) =>
    res.json(
      transaction(() => {
        const user = authorize(req),
          input = legacySchema.parse(req.body),
          before = publicClinicSettings(db);
        const updated = { ...before, ...input };
        const oldProfile = profile(before),
          nextProfile = profile(updated),
          oldModules = modules(before.modules),
          nextModules = modules(updated.modules);
        const profileChanged = JSON.stringify(oldProfile) !== JSON.stringify(nextProfile),
          modulesChanged = JSON.stringify(oldModules) !== JSON.stringify(nextModules);
        if (profileChanged || modulesChanged) {
          db.prepare("UPDATE meta SET value=? WHERE key='settings'").run(
            JSON.stringify({ ...nextProfile, modules: nextModules }),
          );
          if (profileChanged)
            record(req, user, 'profile', oldProfile, nextProfile, 'legacy', null, null, null);
          if (modulesChanged)
            record(req, user, 'modules', oldModules, nextModules, 'legacy', null, null, null);
        }
        // Retain the existing general audit action, including a no-op compatibility PATCH.
        audit(req, 'updated clinic settings', 'settings', 'clinic');
        return { ...nextProfile, modules: nextModules };
      }),
    ),
  );
}
