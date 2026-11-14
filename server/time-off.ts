import { createHash } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import type { AuthRequest } from './app.ts';
import type { Doctor, User } from '../shared/types.ts';
import type { ScheduleClosure } from '../shared/scheduling.ts';
import type {
  TimeOffValues,
  TimeOffSnapshot,
  TimeOffChange,
  TimeOffContext,
  TimeOffMutation,
  TimeOffPage,
  TimeOffHistory,
} from '../shared/time-off.ts';
import { clinicToday, get, id, nowISO, type DB } from './db.ts';
import { mfaSessionAllowed } from './mfa.ts';
interface Dependencies {
  db: DB;
  actor: (req: AuthRequest, roles?: User['role'][]) => User;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
  transaction: <T>(work: () => T) => T;
  assertPreservesBookings: (closure: ScheduleClosure) => void;
}
type Manager = User & { role: 'admin' | 'doctor' };
type StoredChange = TimeOffChange & {
  createdById: string;
  requestId: string | null;
  expectedRevision: string | null;
  operation: 'create' | 'edit' | 'cancel';
};
const reference = z.string().min(1).max(300),
  empty = z.object({}).strict();
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) =>
      Number.isFinite(Date.parse(`${v}T12:00:00Z`)) &&
      new Date(`${v}T12:00:00Z`).toISOString().slice(0, 10) === v,
    'Invalid calendar date.',
  );
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Use a real 24-hour time (HH:mm).');
const fields = {
  startDate: date,
  endDate: date,
  startTime: time.nullable(),
  endTime: time.nullable(),
  reason: z.string().trim().min(1).max(300),
};
function interval(value: z.infer<z.ZodObject<typeof fields>>, ctx: z.RefinementCtx) {
  if (value.endDate < value.startDate)
    ctx.addIssue({
      code: 'custom',
      message: 'End date must not precede the start date.',
      path: ['endDate'],
    });
  if ((value.startTime === null) !== (value.endTime === null))
    ctx.addIssue({
      code: 'custom',
      message: 'Provide both start and end times or leave both empty.',
      path: ['endTime'],
    });
  if (value.startTime !== null && value.endTime !== null && value.startTime >= value.endTime)
    ctx.addIssue({
      code: 'custom',
      message: 'The end time must be after the start time on the same day.',
      path: ['endTime'],
    });
}
const closureFields = { doctorId: reference.nullable(), ...fields };
const legacySchema = z.object(closureFields).superRefine(interval);
const uuid = z
  .string()
  .uuid()
  .transform((v) => v.toLowerCase());
const commandFields = {
  changeReason: z.string().trim().min(1).max(1000),
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  requestId: uuid,
};
const createSchema = z
  .object({ closure: z.object(closureFields).strict().superRefine(interval), requestId: uuid })
  .strict();
const editSchema = z
  .object({ closure: z.object(fields).strict().superRefine(interval), ...commandFields })
  .strict();
const cancelSchema = z.object(commandFields).strict();
const pageFields = {
  page: z
    .string()
    .regex(/^[1-9]\d{0,6}$/)
    .transform(Number)
    .refine((v) => v <= 1000000)
    .default(1),
  pageSize: z.enum(['10', '25', '50']).transform(Number).default(25),
};
const historyQuery = z.object(pageFields).strict();
const listQuery = z
  .object({
    ...pageFields,
    doctorId: reference.optional(),
    filter: z.enum(['upcoming', 'past', 'cancelled', 'all']).default('upcoming'),
  })
  .strict();
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
function closure(v: ScheduleClosure): ScheduleClosure {
  return {
    id: v.id,
    doctorId: v.doctorId,
    startDate: v.startDate,
    endDate: v.endDate,
    startTime: v.startTime,
    endTime: v.endTime,
    reason: v.reason,
    createdAt: v.createdAt,
  };
}
function snapshot(v: TimeOffSnapshot): TimeOffSnapshot {
  return { closure: closure(v.closure), status: v.status };
}
function safeChange(v: StoredChange): TimeOffChange {
  return {
    id: v.id,
    closureId: v.closureId,
    doctorId: v.doctorId,
    doctorName: v.doctorName,
    source: v.source,
    action: v.action,
    before: v.before ? snapshot(v.before) : null,
    after: snapshot(v.after),
    changeReason: v.changeReason,
    createdByName: v.createdByName,
    createdByRole: v.createdByRole,
    createdAt: v.createdAt,
  };
}

export function registerTimeOff(app: Express, deps: Dependencies) {
  const { db, actor, audit, fail, transaction, assertPreservesBookings } = deps;
  db.exec(`CREATE TABLE IF NOT EXISTS scheduleClosureRecords (
    id TEXT PRIMARY KEY,doctorId TEXT REFERENCES doctors(id),startDate TEXT NOT NULL,endDate TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active','cancelled')),data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS time_off_status_date ON scheduleClosureRecords(status,startDate,id);
  CREATE INDEX IF NOT EXISTS time_off_doctor_date ON scheduleClosureRecords(doctorId,startDate,id);
  CREATE INDEX IF NOT EXISTS time_off_date ON scheduleClosureRecords(startDate,id);
  CREATE TABLE IF NOT EXISTS scheduleClosureChanges (
    id TEXT PRIMARY KEY,closureId TEXT NOT NULL REFERENCES scheduleClosureRecords(id),createdAt TEXT NOT NULL,data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS time_off_change_head ON scheduleClosureChanges(closureId);
  CREATE INDEX IF NOT EXISTS time_off_change_history ON scheduleClosureChanges(closureId,createdAt DESC,id DESC);
  CREATE TABLE IF NOT EXISTS scheduleClosureCommands (
    requestId TEXT PRIMARY KEY,actorId TEXT NOT NULL REFERENCES users(id),operation TEXT NOT NULL,
    closureId TEXT NOT NULL REFERENCES scheduleClosureRecords(id),payload TEXT NOT NULL,changeId TEXT NOT NULL UNIQUE REFERENCES scheduleClosureChanges(id)
  );`);
  for (const table of ['scheduleClosureChanges', 'scheduleClosureCommands'])
    db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Time-off evidence is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Time-off evidence is immutable'); END;`);
  // Preserve original JSON bytes and timestamps; an imported source has no fabricated event/author.
  transaction(() =>
    db.exec(`INSERT OR IGNORE INTO scheduleClosureRecords(id,doctorId,startDate,endDate,status,data)
    SELECT id,doctorId,startDate,endDate,'active',data FROM scheduleClosures;`),
  );

  function authorize(req: AuthRequest) {
    const cached = actor(req, ['admin', 'doctor', 'receptionist']),
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
    if (user.mustChangePassword || !['admin', 'doctor', 'receptionist'].includes(user.role))
      return fail(403, 'This account cannot access clinic time off.');
    req.user = user;
    return user;
  }
  function manage(user: User, doctorId: string | null): Manager {
    if (
      user.role !== 'admin' &&
      (user.role !== 'doctor' || doctorId === null || user.doctorId !== doctorId)
    )
      return fail(403, 'You may manage time off only for your own doctor profile.');
    if (doctorId !== null && !get<Doctor>(db, 'doctors', doctorId))
      return fail(404, 'Doctor not found.');
    return user as Manager;
  }
  function record(id: string): TimeOffSnapshot {
    const row = db.prepare('SELECT status,data FROM scheduleClosureRecords WHERE id=?').get(id);
    if (!row) return fail(404, 'Time-off record not found.');
    return {
      closure: closure(JSON.parse(row.data as string) as ScheduleClosure),
      status: row.status as TimeOffSnapshot['status'],
    };
  }
  function latest(id: string) {
    const row = db
      .prepare(
        'SELECT data FROM scheduleClosureChanges WHERE closureId=? ORDER BY rowid DESC LIMIT 1',
      )
      .get(id);
    return row ? safeChange(JSON.parse(row.data as string) as StoredChange) : null;
  }
  function context(id: string): TimeOffContext {
    const current = record(id),
      latestChange = latest(id);
    const doctor = current.closure.doctorId
      ? get<Doctor>(db, 'doctors', current.closure.doctorId)
      : null;
    return {
      ...current,
      doctor: doctor ? { id: doctor.id, name: doctor.name } : null,
      revision: digest([current, latestChange?.id ?? null]),
      latestChange,
    };
  }
  function eligible(value: ScheduleClosure) {
    if (value.endDate < clinicToday())
      return fail(400, 'Closures must include today or a future date.');
    assertPreservesBookings(value);
  }
  function apply(
    req: AuthRequest,
    user: Manager,
    before: TimeOffSnapshot | null,
    after: TimeOffSnapshot,
    operation: StoredChange['operation'],
    source: StoredChange['source'],
    changeReason: string | null,
    requestId: string | null,
    expectedRevision: string | null,
  ): StoredChange {
    const value = closure(after.closure),
      body = JSON.stringify(value),
      doctor = value.doctorId ? get<Doctor>(db, 'doctors', value.doctorId) : null;
    if (after.status === 'active')
      db.prepare(
        'INSERT INTO scheduleClosures(id,doctorId,startDate,endDate,data) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET doctorId=excluded.doctorId,startDate=excluded.startDate,endDate=excluded.endDate,data=excluded.data',
      ).run(value.id, value.doctorId, value.startDate, value.endDate, body);
    else db.prepare('DELETE FROM scheduleClosures WHERE id=?').run(value.id);
    db.prepare(
      'INSERT INTO scheduleClosureRecords(id,doctorId,startDate,endDate,status,data) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET startDate=excluded.startDate,endDate=excluded.endDate,status=excluded.status,data=excluded.data',
    ).run(value.id, value.doctorId, value.startDate, value.endDate, after.status, body);
    const event: StoredChange = {
      id: id(),
      closureId: value.id,
      doctorId: value.doctorId,
      doctorName: doctor?.name ?? null,
      source,
      action: operation === 'create' ? 'created' : operation === 'edit' ? 'edited' : 'cancelled',
      before: before ? snapshot(before) : null,
      after: snapshot(after),
      changeReason,
      createdById: user.id,
      createdByName: user.name,
      createdByRole: user.role,
      createdAt: nowISO(),
      requestId,
      expectedRevision,
      operation,
    };
    db.prepare(
      'INSERT INTO scheduleClosureChanges(id,closureId,createdAt,data) VALUES(?,?,?,?)',
    ).run(event.id, event.closureId, event.createdAt, JSON.stringify(event));
    audit(
      req,
      operation === 'create'
        ? 'created schedule closure'
        : operation === 'edit'
          ? 'edited schedule closure'
          : 'removed schedule closure',
      'scheduleClosure',
      value.id,
    );
    return event;
  }
  function response(event: StoredChange): TimeOffMutation {
    if (!event.requestId) return fail(500, 'The original time-off receipt is unavailable.');
    return {
      context: context(event.closureId),
      change: safeChange(event),
      receipt: {
        requestId: event.requestId,
        actorId: event.createdById,
        operation: event.operation,
        closureId: event.closureId,
        expectedRevision: event.expectedRevision,
        changeId: event.id,
      },
    };
  }
  function replay(
    user: User,
    requestId: string,
    operation: StoredChange['operation'],
    payload: string,
  ) {
    const prior = db
      .prepare(
        'SELECT actorId,operation,closureId,payload,changeId FROM scheduleClosureCommands WHERE requestId=?',
      )
      .get(requestId);
    if (!prior) return null;
    if (prior.actorId !== user.id || prior.operation !== operation || prior.payload !== payload)
      return fail(409, 'This request ID has already been used for a different time-off operation.');
    const current = record(String(prior.closureId));
    manage(user, current.closure.doctorId);
    const event = get<StoredChange>(db, 'scheduleClosureChanges', String(prior.changeId));
    if (!event) return fail(500, 'The original time-off receipt is unavailable.');
    return response(event);
  }
  function receipt(event: StoredChange, payload: string) {
    db.prepare(
      'INSERT INTO scheduleClosureCommands(requestId,actorId,operation,closureId,payload,changeId) VALUES(?,?,?,?,?,?)',
    ).run(event.requestId!, event.createdById, event.operation, event.closureId, payload, event.id);
    return response(event);
  }
  app.get('/api/time-off', (req: AuthRequest, res) => {
    actor(req, ['admin', 'doctor', 'receptionist']);
    const query = listQuery.parse(req.query);
    const result = transaction((): TimeOffPage => {
      authorize(req);
      if (query.doctorId && !get(db, 'doctors', query.doctorId))
        return fail(404, 'Doctor not found.');
      const where: string[] = [],
        params: (string | number)[] = [];
      if (query.doctorId) {
        where.push('(doctorId=? OR doctorId IS NULL)');
        params.push(query.doctorId);
      }
      if (query.filter === 'upcoming' || query.filter === 'past') {
        where.push(`status='active' AND endDate${query.filter === 'upcoming' ? '>=' : '<'}?`);
        params.push(clinicToday());
      }
      if (query.filter === 'cancelled') where.push("status='cancelled'");
      const predicate = where.length ? ` WHERE ${where.join(' AND ')}` : '',
        order = query.filter === 'upcoming' ? 'ASC' : 'DESC';
      const total = Number(
          db.prepare(`SELECT COUNT(*) n FROM scheduleClosureRecords${predicate}`).get(...params)
            ?.n ?? 0,
        ),
        totalPages = Math.max(1, Math.ceil(total / query.pageSize)),
        page = Math.min(query.page, totalPages);
      const rows = db
        .prepare(
          `SELECT status,data FROM scheduleClosureRecords${predicate} ORDER BY startDate ${order},id ${order} LIMIT ? OFFSET ?`,
        )
        .all(...params, query.pageSize, (page - 1) * query.pageSize);
      const items = rows.map((row) => ({
        closure: closure(JSON.parse(row.data as string) as ScheduleClosure),
        status: row.status as TimeOffSnapshot['status'],
      }));
      audit(req, 'viewed time-off records', 'scheduleClosure', query.doctorId ?? 'clinic');
      return { items, page, pageSize: query.pageSize, total, totalPages };
    });
    res.json(result);
  });
  app.get('/api/time-off/:id', (req: AuthRequest, res) => {
    actor(req, ['admin', 'doctor']);
    const key = reference.parse(req.params.id);
    empty.parse(req.query);
    const result = transaction(() => {
      const user = authorize(req),
        current = record(key);
      manage(user, current.closure.doctorId);
      const result = context(key);
      audit(req, 'viewed time-off context', 'scheduleClosure', key);
      return result;
    });
    res.json(result);
  });
  app.get('/api/time-off/:id/history', (req: AuthRequest, res) => {
    actor(req, ['admin', 'doctor']);
    const key = reference.parse(req.params.id),
      query = historyQuery.parse(req.query);
    const result = transaction((): TimeOffHistory => {
      const user = authorize(req),
        current = record(key);
      manage(user, current.closure.doctorId);
      const total = Number(
          db.prepare('SELECT COUNT(*) n FROM scheduleClosureChanges WHERE closureId=?').get(key)
            ?.n ?? 0,
        ),
        totalPages = Math.max(1, Math.ceil(total / query.pageSize)),
        page = Math.min(query.page, totalPages);
      const rows = db
        .prepare(
          'SELECT data FROM scheduleClosureChanges WHERE closureId=? ORDER BY createdAt DESC,id DESC LIMIT ? OFFSET ?',
        )
        .all(key, query.pageSize, (page - 1) * query.pageSize);
      const items = rows.map((row) => safeChange(JSON.parse(row.data as string) as StoredChange));
      audit(req, 'viewed time-off history', 'scheduleClosure', key);
      return { items, page, pageSize: query.pageSize, total, totalPages };
    });
    res.json(result);
  });
  app.post('/api/time-off', (req: AuthRequest, res) => {
    actor(req, ['admin', 'doctor']);
    empty.parse(req.query);
    const input = createSchema.parse(req.body),
      payload = JSON.stringify({ closure: input.closure });
    const result = transaction(() => {
      const user = manage(authorize(req), input.closure.doctorId),
        prior = replay(user, input.requestId, 'create', payload);
      if (prior) return { value: prior, status: 200 };
      const value: ScheduleClosure = { id: id(), ...input.closure, createdAt: nowISO() };
      eligible(value);
      const event = apply(
        req,
        user,
        null,
        { closure: value, status: 'active' },
        'create',
        'reviewed',
        null,
        input.requestId,
        null,
      );
      return { value: receipt(event, payload), status: 201 };
    });
    res.status(result.status).json(result.value);
  });
  app.post('/api/time-off/:id/changes', (req: AuthRequest, res) => {
    actor(req, ['admin', 'doctor']);
    empty.parse(req.query);
    const key = reference.parse(req.params.id),
      input = editSchema.parse(req.body);
    const payload = JSON.stringify({
      closureId: key,
      closure: input.closure,
      changeReason: input.changeReason,
      expectedRevision: input.expectedRevision,
    });
    const result = transaction(() => {
      const user = authorize(req),
        before = context(key),
        manager = manage(user, before.closure.doctorId),
        prior = replay(user, input.requestId, 'edit', payload);
      if (prior) return { value: prior, status: 200 };
      if (before.revision !== input.expectedRevision)
        return fail(409, 'Time off changed. Refresh and review the latest record before saving.');
      if (before.status === 'cancelled')
        return fail(409, 'This time-off record has already been cancelled.');
      const value = closure({ ...before.closure, ...input.closure });
      if (digest(value) === digest(before.closure))
        return fail(400, 'This time off is already saved. Change its details before saving.');
      eligible(value);
      const event = apply(
        req,
        manager,
        before,
        { closure: value, status: 'active' },
        'edit',
        'reviewed',
        input.changeReason,
        input.requestId,
        input.expectedRevision,
      );
      return { value: receipt(event, payload), status: 201 };
    });
    res.status(result.status).json(result.value);
  });
  app.post('/api/time-off/:id/cancel', (req: AuthRequest, res) => {
    actor(req, ['admin', 'doctor']);
    empty.parse(req.query);
    const key = reference.parse(req.params.id),
      input = cancelSchema.parse(req.body);
    const payload = JSON.stringify({
      closureId: key,
      changeReason: input.changeReason,
      expectedRevision: input.expectedRevision,
    });
    const result = transaction(() => {
      const user = authorize(req),
        before = context(key),
        manager = manage(user, before.closure.doctorId),
        prior = replay(user, input.requestId, 'cancel', payload);
      if (prior) return { value: prior, status: 200 };
      if (before.revision !== input.expectedRevision)
        return fail(409, 'Time off changed. Refresh and review the latest record before saving.');
      if (before.status === 'cancelled')
        return fail(409, 'This time-off record has already been cancelled.');
      const event = apply(
        req,
        manager,
        before,
        { closure: before.closure, status: 'cancelled' },
        'cancel',
        'reviewed',
        input.changeReason,
        input.requestId,
        input.expectedRevision,
      );
      return { value: receipt(event, payload), status: 201 };
    });
    res.status(result.status).json(result.value);
  });
  app.post('/api/schedule-closures', (req: AuthRequest, res) => {
    actor(req, ['admin', 'doctor']);
    const input = legacySchema.parse(req.body);
    const result = transaction(() => {
      const user = manage(authorize(req), input.doctorId),
        value: ScheduleClosure = { id: id(), ...input, createdAt: nowISO() };
      eligible(value);
      return apply(
        req,
        user,
        null,
        { closure: value, status: 'active' },
        'create',
        'legacy',
        null,
        null,
        null,
      ).after.closure;
    });
    res.status(201).json(result);
  });
  app.delete('/api/schedule-closures/:id', (req: AuthRequest, res) => {
    actor(req, ['admin', 'doctor']);
    const key = String(req.params.id);
    transaction(() => {
      const user = authorize(req),
        before = record(key),
        manager = manage(user, before.closure.doctorId);
      if (before.status !== 'active') return fail(404, 'Schedule closure not found.');
      apply(
        req,
        manager,
        before,
        { closure: before.closure, status: 'cancelled' },
        'cancel',
        'legacy',
        null,
        null,
        null,
      );
    });
    res.json({ ok: true });
  });
}
