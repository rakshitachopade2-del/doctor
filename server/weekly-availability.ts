import { createHash } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import type { AuthRequest } from './app.ts';
import type { Doctor, User } from '../shared/types.ts';
import type { DoctorSchedule } from '../shared/scheduling.ts';
import type {
  WeeklyAvailabilityValues,
  WeeklyAvailabilitySnapshot,
  WeeklyAvailabilityChange,
  WeeklyAvailabilityContext,
  WeeklyAvailabilityInput,
  WeeklyAvailabilityMutation,
  WeeklyAvailabilityHistory,
} from '../shared/weekly-availability.ts';
import { get, id, nowISO, type DB } from './db.ts';
import { mfaSessionAllowed } from './mfa.ts';

interface Dependencies {
  db: DB;
  actor: (req: AuthRequest, roles?: User['role'][]) => User;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
  transaction: <T>(work: () => T) => T;
  schedule: (doctorId: string) => DoctorSchedule;
  assertPreservesBookings: (value: DoctorSchedule) => void;
}
type StoredChange = WeeklyAvailabilityChange & {
  createdById: string;
  requestId: string | null;
  expectedRevision: string | null;
};
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Use a real 24-hour time (HH:mm).');
const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
function values(value: WeeklyAvailabilityValues): WeeklyAvailabilityValues {
  return {
    durationMinutes: value.durationMinutes,
    windows: value.windows
      .map((window) => ({
        day: window.day,
        start: window.start,
        end: window.end,
        mode: window.mode,
      }))
      .sort(
        (a, b) =>
          a.day - b.day ||
          a.start.localeCompare(b.start) ||
          a.end.localeCompare(b.end) ||
          a.mode.localeCompare(b.mode),
      ),
  };
}
function scheduleSchema(strict: boolean) {
  const window = z.object({
    day: z.number().int().min(0).max(6),
    start: time,
    end: time,
    mode: z.enum(['in-person', 'online', 'both']),
  });
  const shape = z.object({
    durationMinutes: z.union([
      z.literal(15),
      z.literal(20),
      z.literal(30),
      z.literal(45),
      z.literal(60),
    ]),
    windows: z.array(strict ? window.strict() : window).max(70),
  });
  return (strict ? shape.strict() : shape)
    .superRefine((value, ctx) => {
      const windows = values(value).windows;
      for (let index = 0; index < windows.length; index++) {
        const window = windows[index];
        if (minutes(window.end) - minutes(window.start) < value.durationMinutes)
          ctx.addIssue({
            code: 'custom',
            message: 'Every session must end after it starts and fit at least one appointment.',
            path: ['windows'],
          });
        if (
          index > 0 &&
          windows[index - 1].day === window.day &&
          windows[index - 1].end > window.start
        )
          ctx.addIssue({
            code: 'custom',
            message:
              'Sessions on the same day cannot overlap, including sessions for different modes.',
            path: ['windows'],
          });
      }
    })
    .transform(values);
}
const legacySchema = scheduleSchema(false);
const reviewedSchema = z
  .object({
    schedule: scheduleSchema(true),
    reason: z.string().trim().min(1).max(1000),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
    requestId: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
  })
  .strict();
const empty = z.object({}).strict();
const reference = z.string().min(1).max(300);
const historyQuery = z
  .object({
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
function snapshot(value: WeeklyAvailabilitySnapshot): WeeklyAvailabilitySnapshot {
  return {
    source: value.source,
    schedule: {
      doctorId: value.schedule.doctorId,
      ...values(value.schedule),
      updatedAt: value.schedule.updatedAt,
    },
  };
}
function safeChange(value: StoredChange): WeeklyAvailabilityChange {
  return {
    id: value.id,
    doctorId: value.doctorId,
    doctorName: value.doctorName,
    source: value.source,
    before: snapshot(value.before),
    after: { ...snapshot(value.after), source: 'explicit' },
    reason: value.reason,
    createdByName: value.createdByName,
    createdByRole: value.createdByRole,
    createdAt: value.createdAt,
  };
}

export function registerWeeklyAvailability(app: Express, dependencies: Dependencies) {
  const { db, actor, audit, fail, transaction, schedule, assertPreservesBookings } = dependencies;
  db.exec(`CREATE TABLE IF NOT EXISTS weeklyAvailabilityChanges (
    id TEXT PRIMARY KEY, doctorId TEXT NOT NULL REFERENCES doctors(id), createdAt TEXT NOT NULL, data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS weekly_availability_doctor_head ON weeklyAvailabilityChanges(doctorId);
  CREATE INDEX IF NOT EXISTS weekly_availability_doctor_history ON weeklyAvailabilityChanges(doctorId,createdAt DESC,id DESC);
  CREATE TABLE IF NOT EXISTS weeklyAvailabilityCommands (
    requestId TEXT PRIMARY KEY,actorId TEXT NOT NULL REFERENCES users(id),doctorId TEXT NOT NULL REFERENCES doctors(id),
    payload TEXT NOT NULL,changeId TEXT NOT NULL UNIQUE REFERENCES weeklyAvailabilityChanges(id)
  );`);
  for (const table of ['weeklyAvailabilityChanges', 'weeklyAvailabilityCommands'])
    db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT,'Weekly availability history is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT,'Weekly availability history is immutable'); END;`);
  function authorize(req: AuthRequest, doctorId: string) {
    const cached = actor(req, ['admin', 'doctor']),
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
    if (user.mustChangePassword || !['admin', 'doctor'].includes(user.role))
      return fail(403, 'This account cannot manage weekly availability.');
    if (user.role !== 'admin' && user.doctorId !== doctorId)
      return fail(403, 'You may manage availability only for your own doctor profile.');
    req.user = user;
    if (!get<Doctor>(db, 'doctors', doctorId)) return fail(404, 'Doctor not found.');
    return user as User & { role: 'admin' | 'doctor' };
  }
  function latest(doctorId: string) {
    const row = db
      .prepare(
        'SELECT data FROM weeklyAvailabilityChanges WHERE doctorId=? ORDER BY rowid DESC LIMIT 1',
      )
      .get(doctorId);
    return row ? safeChange(JSON.parse(row.data as string) as StoredChange) : null;
  }
  function context(doctorId: string): WeeklyAvailabilityContext {
    const doctor = get<Doctor>(db, 'doctors', doctorId);
    if (!doctor) return fail(404, 'Doctor not found.');
    const current = schedule(doctorId),
      source = db.prepare('SELECT 1 FROM doctorSchedules WHERE id=?').get(doctorId)
        ? 'explicit'
        : 'inherited';
    const latestChange = latest(doctorId),
      state = snapshot({ source, schedule: current });
    return {
      doctor: { id: doctorId, name: doctor.name },
      ...state,
      revision: digest([doctorId, values(current), source, latestChange?.id ?? null]),
      latestChange,
    };
  }
  function record(
    req: AuthRequest,
    user: User & { role: 'admin' | 'doctor' },
    before: WeeklyAvailabilityContext,
    desired: WeeklyAvailabilityValues,
    command: WeeklyAvailabilityInput | null,
  ): StoredChange {
    const schedule: DoctorSchedule = {
      doctorId: before.doctor.id,
      ...values(desired),
      updatedAt: nowISO(),
    };
    assertPreservesBookings(schedule);
    const change: StoredChange = {
      id: id(),
      doctorId: before.doctor.id,
      doctorName: before.doctor.name,
      source: command ? 'reviewed' : 'legacy',
      before: snapshot(before),
      after: { source: 'explicit', schedule },
      reason: command?.reason ?? null,
      createdByName: user.name,
      createdByRole: user.role,
      createdAt: schedule.updatedAt,
      createdById: user.id,
      requestId: command?.requestId ?? null,
      expectedRevision: command?.expectedRevision ?? null,
    };
    db.prepare(
      'INSERT INTO doctorSchedules(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
    ).run(schedule.doctorId, JSON.stringify(schedule));
    db.prepare(
      'INSERT INTO weeklyAvailabilityChanges(id,doctorId,createdAt,data) VALUES (?,?,?,?)',
    ).run(change.id, change.doctorId, change.createdAt, JSON.stringify(change));
    audit(
      req,
      command ? 'reviewed doctor weekly availability' : 'updated doctor availability',
      'doctorSchedule',
      change.doctorId,
    );
    return change;
  }
  function response(change: StoredChange): WeeklyAvailabilityMutation {
    if (!change.requestId || !change.expectedRevision)
      return fail(500, 'The original weekly availability receipt is unavailable.');
    return {
      context: context(change.doctorId),
      change: safeChange(change),
      receipt: {
        requestId: change.requestId,
        actorId: change.createdById,
        doctorId: change.doctorId,
        expectedRevision: change.expectedRevision,
        changeId: change.id,
      },
    };
  }
  const base = '/api/schedules/:doctorId/availability';
  app.get(base, (req: AuthRequest, res) => {
    actor(req, ['admin', 'doctor']);
    const doctorId = reference.parse(req.params.doctorId);
    empty.parse(req.query);
    const result = transaction(() => {
      authorize(req, doctorId);
      const result = context(doctorId);
      audit(req, 'viewed doctor weekly availability context', 'doctorSchedule', doctorId);
      return result;
    });
    res.json(result);
  });
  app.get(`${base}/history`, (req: AuthRequest, res) => {
    actor(req, ['admin', 'doctor']);
    const doctorId = reference.parse(req.params.doctorId),
      query = historyQuery.parse(req.query);
    const result = transaction((): WeeklyAvailabilityHistory => {
      authorize(req, doctorId);
      const total = Number(
        db
          .prepare('SELECT COUNT(*) n FROM weeklyAvailabilityChanges WHERE doctorId=?')
          .get(doctorId)?.n ?? 0,
      );
      const totalPages = Math.max(1, Math.ceil(total / query.pageSize)),
        page = Math.min(query.page, totalPages);
      const rows = db
        .prepare(
          'SELECT data FROM weeklyAvailabilityChanges WHERE doctorId=? ORDER BY createdAt DESC,id DESC LIMIT ? OFFSET ?',
        )
        .all(doctorId, query.pageSize, (page - 1) * query.pageSize);
      const items = rows.map((row) => safeChange(JSON.parse(row.data as string) as StoredChange));
      audit(req, 'viewed doctor weekly availability history', 'doctorSchedule', doctorId);
      return { items, page, pageSize: query.pageSize, total, totalPages };
    });
    res.json(result);
  });
  app.post(base, (req: AuthRequest, res) => {
    actor(req, ['admin', 'doctor']);
    const doctorId = reference.parse(req.params.doctorId);
    empty.parse(req.query);
    const input = reviewedSchema.parse(req.body),
      payload = JSON.stringify({
        doctorId,
        schedule: input.schedule,
        reason: input.reason,
        expectedRevision: input.expectedRevision,
      });
    const result = transaction(() => {
      const user = authorize(req, doctorId);
      const prior = db
        .prepare(
          'SELECT actorId,doctorId,payload,changeId FROM weeklyAvailabilityCommands WHERE requestId=?',
        )
        .get(input.requestId);
      if (prior) {
        if (prior.actorId !== user.id || prior.doctorId !== doctorId || prior.payload !== payload)
          return fail(
            409,
            'This request ID has already been used for a different weekly availability operation.',
          );
        const change = get<StoredChange>(db, 'weeklyAvailabilityChanges', String(prior.changeId));
        if (!change) return fail(500, 'The original weekly availability receipt is unavailable.');
        return { value: response(change), status: 200 };
      }
      const before = context(doctorId);
      if (before.revision !== input.expectedRevision)
        return fail(
          409,
          "Weekly availability changed. Refresh and review this doctor's latest schedule before saving.",
        );
      if (
        before.source === 'explicit' &&
        digest(values(before.schedule)) === digest(input.schedule)
      )
        return fail(
          400,
          'This weekly availability is already saved. Change the schedule before saving.',
        );
      const change = record(req, user, before, input.schedule, input);
      db.prepare(
        'INSERT INTO weeklyAvailabilityCommands(requestId,actorId,doctorId,payload,changeId) VALUES (?,?,?,?,?)',
      ).run(input.requestId, user.id, doctorId, payload, change.id);
      return { value: response(change), status: 201 };
    });
    res.status(result.status).json(result.value);
  });
  // Compatibility full-value PUT remains last-write-wins, but uses the same coherent writer.
  app.put('/api/schedules/:doctorId', (req: AuthRequest, res) => {
    actor(req, ['admin', 'doctor']);
    const doctorId = String(req.params.doctorId),
      input = legacySchema.parse(req.body);
    const result = transaction(() => {
      const user = authorize(req, doctorId),
        before = context(doctorId);
      if (before.source === 'explicit' && digest(values(before.schedule)) === digest(input)) {
        audit(req, 'updated doctor availability', 'doctorSchedule', doctorId);
        return before.schedule;
      }
      return record(req, user, before, input, null).after.schedule;
    });
    res.json(result);
  });
}
