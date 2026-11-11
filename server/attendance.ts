import type { Express } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AuthRequest } from './app.ts';
import { get, id, type DB } from './db.ts';
import { escapeCsvCell } from './insights.ts';
import type { User } from '../shared/types.ts';
import type {
  AttendanceContext,
  AttendanceDetail,
  AttendanceEvent,
  AttendanceMutation,
  AttendanceOperation,
  AttendanceReport,
  AttendanceShift,
  AttendanceStaff,
  AttendanceState,
  StaffRole,
} from '../shared/attendance.ts';

interface Dependencies {
  db: DB;
  actor: (req: AuthRequest, roles?: User['role'][]) => User;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
}
interface Origin {
  id: string;
  userId: string;
  staffName: string;
  staffRole: StaffRole;
  source: AttendanceShift['source'];
  createdAt: string;
  original: AttendanceState;
}
interface StateRow {
  shiftId: string;
  userId: string;
  startAt: number;
  endAt: number | null;
  startDate: string;
  status: AttendanceShift['status'];
  latestEventId: string;
  data: string;
}
const maxMilliseconds = 36 * 3_600_000;
const now = () => new Date(Date.now()).toISOString();
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const revision = z.string().regex(/^[a-f0-9]{64}$/, 'Refresh attendance before saving.');
const reason = z.string().trim().min(1).max(1000);
const identifier = z.string().trim().min(1).max(300);
const command = { requestId: uuid, expectedRevision: revision };
const timestamp = z
  .string()
  .refine(
    (value) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
      value >= '0001-01-01T00:00:00.000Z' &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    'Use a real UTC timestamp including milliseconds.',
  );
const date = z
  .string()
  .refine(
    (value) =>
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      value >= '0001-01-01' &&
      Number.isFinite(Date.parse(`${value}T12:00:00Z`)) &&
      new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value,
    'Use a real calendar date.',
  );
const filters = {
  from: date,
  to: date,
  userId: identifier.optional(),
  status: z.enum(['all', 'open', 'closed', 'voided']).default('all'),
};
const positiveInteger = (fallback: string, max: number) =>
  z
    .string()
    .regex(/^[1-9]\d*$/)
    .default(fallback)
    .transform(Number)
    .pipe(z.number().int().max(max));
const validRange = (input: { from: string; to: string }) => {
  const days =
    (Date.parse(`${input.to}T12:00:00Z`) - Date.parse(`${input.from}T12:00:00Z`)) / 86_400_000 + 1;
  return days >= 1 && days <= 366;
};
type ReportFilter = {
  from: string;
  to: string;
  userId: string | null;
  status: AttendanceReport['status'];
};
const iso = (milliseconds: number) => new Date(milliseconds).toISOString();
const startDate = (milliseconds: number) =>
  new Date(milliseconds + 330 * 60000).toISOString().slice(0, 10);

export function registerAttendance(app: Express, { db, actor, audit, fail }: Dependencies) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS attendanceShifts(id TEXT PRIMARY KEY,userId TEXT NOT NULL REFERENCES users(id),data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS attendanceEvents(id TEXT PRIMARY KEY,shiftId TEXT NOT NULL REFERENCES attendanceShifts(id),userId TEXT NOT NULL REFERENCES users(id),data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS attendance_events_shift ON attendanceEvents(shiftId);
    CREATE INDEX IF NOT EXISTS attendance_events_user ON attendanceEvents(userId);
    CREATE TABLE IF NOT EXISTS attendanceState(
      shiftId TEXT PRIMARY KEY REFERENCES attendanceShifts(id),userId TEXT NOT NULL REFERENCES users(id),
      startAt INTEGER NOT NULL,endAt INTEGER,startDate TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('open','closed','voided')),
      latestEventId TEXT NOT NULL REFERENCES attendanceEvents(id),
      CHECK(endAt IS NULL OR (endAt>=startAt AND endAt-startAt<=129600000)),
      CHECK((status='open' AND endAt IS NULL) OR (status='closed' AND endAt IS NOT NULL) OR status='voided')
    );
    CREATE UNIQUE INDEX IF NOT EXISTS attendance_one_open ON attendanceState(userId) WHERE status='open';
    CREATE INDEX IF NOT EXISTS attendance_state_user_window ON attendanceState(userId,startAt,endAt);
    CREATE INDEX IF NOT EXISTS attendance_state_dates ON attendanceState(startDate,startAt DESC,shiftId DESC);
    CREATE INDEX IF NOT EXISTS attendance_state_user_dates ON attendanceState(userId,startDate,startAt DESC,shiftId DESC);
    CREATE INDEX IF NOT EXISTS attendance_state_status_dates ON attendanceState(status,startDate,startAt DESC,shiftId DESC);
    CREATE TABLE IF NOT EXISTS attendanceCommands(requestId TEXT PRIMARY KEY,actorId TEXT NOT NULL REFERENCES users(id),operation TEXT NOT NULL,targetId TEXT NOT NULL,payload TEXT NOT NULL,shiftId TEXT NOT NULL REFERENCES attendanceShifts(id),eventId TEXT NOT NULL REFERENCES attendanceEvents(id));
  `);
  for (const operation of ['INSERT', 'UPDATE'])
    db.exec(`
    CREATE TRIGGER IF NOT EXISTS attendance_no_overlap_${operation.toLowerCase()} BEFORE ${operation} ON attendanceState
    WHEN NEW.status!='voided' AND (NEW.endAt IS NULL OR NEW.endAt>NEW.startAt) AND EXISTS(
      SELECT 1 FROM attendanceState WHERE userId=NEW.userId AND shiftId!=NEW.shiftId AND status!='voided'
      AND (endAt IS NULL OR endAt>startAt) AND startAt<COALESCE(NEW.endAt,9007199254740991)
      AND COALESCE(endAt,9007199254740991)>NEW.startAt
    ) BEGIN SELECT RAISE(ABORT,'Attendance intervals overlap'); END;
  `);
  for (const table of ['attendanceShifts', 'attendanceEvents', 'attendanceCommands'])
    db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Attendance source records are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Attendance source records are immutable'); END;
  `);
  function transaction<T>(work: () => T, write = true): T {
    db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try {
      const value = work();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  const staffActor = (req: AuthRequest) => actor(req, ['admin', 'doctor', 'receptionist']);
  function staffRecord(userId: string): AttendanceStaff {
    const user = get<User>(db, 'users', userId);
    if (!user || user.role === 'patient') return fail(404, 'Staff account not found.');
    return { id: user.id, name: user.name, role: user.role, active: user.active !== false };
  }
  function shiftFrom(row: StateRow): AttendanceShift {
    const original = JSON.parse(row.data) as Origin;
    return {
      id: original.id,
      userId: original.userId,
      staffName: original.staffName,
      staffRole: original.staffRole,
      source: original.source,
      startedAt: iso(row.startAt),
      endedAt: row.endAt === null ? null : iso(row.endAt),
      status: row.status,
      recordedSeconds:
        row.status === 'closed' ? Math.floor((row.endAt! - row.startAt) / 1000) : null,
      createdAt: original.createdAt,
      revision: digest([row.shiftId, row.latestEventId]),
    };
  }
  const selectShift =
    'SELECT s.*,o.data FROM attendanceState s JOIN attendanceShifts o ON o.id=s.shiftId';
  function shiftRecord(shiftId: string) {
    const row = db.prepare(`${selectShift} WHERE s.shiftId=?`).get(shiftId) as unknown as
      StateRow | undefined;
    if (!row) return fail(404, 'Attendance entry not found.');
    return shiftFrom(row);
  }
  function ownShift(req: AuthRequest, shiftId: string, administratorAllowed: boolean) {
    const user = staffActor(req),
      shift = shiftRecord(shiftId);
    if (shift.userId !== user.id && !(administratorAllowed && user.role === 'admin'))
      fail(404, 'Attendance entry not found.');
    return shift;
  }
  function context(userId: string): AttendanceContext {
    const staff = staffRecord(userId);
    const latest = db
      .prepare('SELECT id FROM attendanceEvents WHERE userId=? ORDER BY rowid DESC LIMIT 1')
      .get(userId);
    const open = db
      .prepare(`${selectShift} WHERE s.userId=? AND s.status='open'`)
      .get(userId) as unknown as StateRow | undefined;
    return {
      staff,
      revision: digest([userId, latest?.id ?? null]),
      openShift: open ? shiftFrom(open) : null,
      serverNow: now(),
      timezone: 'Asia/Kolkata',
    };
  }
  function expectAccount(userId: string, expected: string) {
    const current = context(userId);
    if (current.revision !== expected)
      fail(409, 'Attendance changed. Refresh and review the current account before saving.');
    return current;
  }
  function expectShift(shift: AttendanceShift, expected: string) {
    if (shift.revision !== expected)
      fail(
        409,
        'This attendance entry changed. Refresh and review its current history before saving.',
      );
  }
  function replay(
    user: User,
    operation: AttendanceOperation,
    target: string,
    requestId: string,
    payload: unknown,
  ): AttendanceMutation | undefined {
    const row = db.prepare('SELECT * FROM attendanceCommands WHERE requestId=?').get(requestId);
    if (!row) return undefined;
    if (
      row.actorId !== user.id ||
      row.operation !== operation ||
      row.targetId !== target ||
      row.payload !== JSON.stringify(payload)
    )
      fail(
        409,
        'This attendance request ID was already used for different details. Retry the original request.',
      );
    return {
      shift: shiftRecord(String(row.shiftId)),
      event: get<AttendanceEvent>(db, 'attendanceEvents', String(row.eventId))!,
    };
  }
  const stateOf = (shift: AttendanceShift): AttendanceState => ({
    startedAt: shift.startedAt,
    endedAt: shift.endedAt,
    voided: shift.status === 'voided',
  });
  function checkInterval(userId: string, state: AttendanceState, excludedShift = '') {
    const start = Date.parse(state.startedAt),
      end = state.endedAt === null ? null : Date.parse(state.endedAt);
    if (start > Date.now() || (end !== null && end > Date.now()))
      fail(400, 'Attendance times cannot be in the future.');
    if (end !== null && (end < start || end - start > maxMilliseconds))
      fail(400, 'Use an ordered attendance interval of no more than 36 hours.');
    if (state.voided || end === start) return;
    if (
      db
        .prepare(
          `SELECT 1 FROM attendanceState WHERE userId=? AND shiftId!=? AND status!='voided'
      AND (endAt IS NULL OR endAt>startAt) AND startAt<? AND COALESCE(endAt,9007199254740991)>?`,
        )
        .get(userId, excludedShift, end ?? Number.MAX_SAFE_INTEGER, start)
    )
      fail(
        409,
        'This interval overlaps another attendance entry for this staff account. Review the existing history.',
      );
  }
  function append(
    req: AuthRequest,
    operation: AttendanceOperation,
    target: string,
    input: { requestId: string; expectedRevision: string },
    payload: unknown,
    shiftId: string,
    userId: string,
    before: AttendanceState | null,
    after: AttendanceState,
    eventReason: string,
  ): AttendanceMutation {
    const user = staffActor(req);
    const event: AttendanceEvent = {
      id: id(),
      shiftId,
      userId,
      operation,
      requestId: input.requestId,
      expectedRevision: input.expectedRevision,
      before,
      after,
      reason: eventReason,
      createdById: user.id,
      createdByName: user.name,
      createdByRole: user.role as StaffRole,
      createdAt: now(),
    };
    db.prepare('INSERT INTO attendanceEvents(id,shiftId,userId,data) VALUES (?,?,?,?)').run(
      event.id,
      shiftId,
      userId,
      JSON.stringify(event),
    );
    const start = Date.parse(after.startedAt),
      end = after.endedAt === null ? null : Date.parse(after.endedAt);
    db.prepare(
      `INSERT INTO attendanceState(shiftId,userId,startAt,endAt,startDate,status,latestEventId) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(shiftId) DO UPDATE SET startAt=excluded.startAt,endAt=excluded.endAt,startDate=excluded.startDate,status=excluded.status,latestEventId=excluded.latestEventId`,
    ).run(
      shiftId,
      userId,
      start,
      end,
      startDate(start),
      after.voided ? 'voided' : end === null ? 'open' : 'closed',
      event.id,
    );
    db.prepare(
      'INSERT INTO attendanceCommands(requestId,actorId,operation,targetId,payload,shiftId,eventId) VALUES (?,?,?,?,?,?,?)',
    ).run(input.requestId, user.id, operation, target, JSON.stringify(payload), shiftId, event.id);
    audit(req, `attendance ${operation}`, 'attendance', shiftId);
    return { shift: shiftRecord(shiftId), event };
  }
  function origin(staff: AttendanceStaff, source: Origin['source'], state: AttendanceState) {
    const value: Origin = {
      id: id(),
      userId: staff.id,
      staffName: staff.name,
      staffRole: staff.role,
      source,
      createdAt: now(),
      original: state,
    };
    db.prepare('INSERT INTO attendanceShifts(id,userId,data) VALUES (?,?,?)').run(
      value.id,
      staff.id,
      JSON.stringify(value),
    );
    return value;
  }
  app.get('/api/attendance/me', (req: AuthRequest, res) => {
    const user = staffActor(req);
    res.json(transaction(() => context(user.id), false));
  });
  app.get('/api/attendance/staff', (req: AuthRequest, res) => {
    actor(req, ['admin']);
    res.json(
      db
        .prepare(
          "SELECT id,json_extract(data,'$.name') name,role,json_extract(data,'$.active') active FROM users WHERE role!='patient' ORDER BY name COLLATE NOCASE,id",
        )
        .all()
        .map((row): AttendanceStaff => ({
          id: String(row.id),
          name: String(row.name),
          role: row.role as StaffRole,
          active: row.active !== 0,
        })),
    );
  });
  app.get('/api/attendance/staff/:id/context', (req: AuthRequest, res) => {
    actor(req, ['admin']);
    res.json(transaction(() => context(String(req.params.id)), false));
  });
  app.get('/api/attendance/shifts/:id', (req: AuthRequest, res) => {
    res.json(
      transaction((): AttendanceDetail => {
        const shift = ownShift(req, String(req.params.id), true);
        const events = db
          .prepare('SELECT data FROM attendanceEvents WHERE shiftId=? ORDER BY rowid DESC')
          .all(shift.id)
          .map((row) => JSON.parse(row.data as string) as AttendanceEvent);
        audit(req, 'viewed attendance history', 'attendance', shift.id);
        return { shift, events };
      }),
    );
  });
  app.post('/api/attendance/clock-in', (req: AuthRequest, res) => {
    const user = staffActor(req),
      input = z.object(command).strict().parse(req.body);
    let duplicate = false;
    const result = transaction(() => {
      const previous = replay(user, 'clock-in', user.id, input.requestId, input);
      if (previous) {
        duplicate = true;
        return previous;
      }
      const current = expectAccount(user.id, input.expectedRevision);
      if (current.openShift)
        fail(
          409,
          'You already have an open attendance entry. Clock out or ask an administrator to correct it.',
        );
      const state: AttendanceState = { startedAt: now(), endedAt: null, voided: false };
      checkInterval(user.id, state);
      const created = origin(current.staff, 'clock', state);
      return append(
        req,
        'clock-in',
        user.id,
        input,
        input,
        created.id,
        user.id,
        null,
        state,
        'Self clock-in.',
      );
    });
    res.status(duplicate ? 200 : 201).json(result);
  });
  app.post('/api/attendance/shifts/:id/clock-out', (req: AuthRequest, res) => {
    const user = staffActor(req),
      shiftId = String(req.params.id),
      input = z.object(command).strict().parse(req.body);
    res.json(
      transaction(() => {
        const shift = ownShift(req, shiftId, false);
        const previous = replay(user, 'clock-out', shiftId, input.requestId, input);
        if (previous) return previous;
        expectAccount(user.id, input.expectedRevision);
        if (shift.status !== 'open')
          fail(409, 'This entry is no longer open. Refresh your current attendance.');
        if (Date.now() - Date.parse(shift.startedAt) > maxMilliseconds)
          fail(
            409,
            'This open entry exceeds 36 hours. Ask an administrator to correct its times or void it. No end time has been recorded.',
          );
        const after = { startedAt: shift.startedAt, endedAt: now(), voided: false };
        checkInterval(user.id, after, shiftId);
        return append(
          req,
          'clock-out',
          shiftId,
          input,
          input,
          shiftId,
          user.id,
          stateOf(shift),
          after,
          'Self clock-out.',
        );
      }),
    );
  });
  app.post('/api/attendance/shifts', (req: AuthRequest, res) => {
    const user = actor(req, ['admin']);
    const input = z
      .object({ userId: identifier, startedAt: timestamp, endedAt: timestamp, reason, ...command })
      .strict()
      .parse(req.body);
    let duplicate = false;
    const value = transaction(() => {
      const previous = replay(user, 'manual-entry', input.userId, input.requestId, input);
      if (previous) {
        duplicate = true;
        return previous;
      }
      const current = expectAccount(input.userId, input.expectedRevision);
      const state = { startedAt: input.startedAt, endedAt: input.endedAt, voided: false };
      checkInterval(input.userId, state);
      const created = origin(current.staff, 'manual', state);
      return append(
        req,
        'manual-entry',
        input.userId,
        input,
        input,
        created.id,
        input.userId,
        null,
        state,
        input.reason,
      );
    });
    res.status(duplicate ? 200 : 201).json(value);
  });
  app.post('/api/attendance/shifts/:id/corrections', (req: AuthRequest, res) => {
    const user = actor(req, ['admin']),
      shiftId = String(req.params.id);
    const input = z
      .object({ startedAt: timestamp, endedAt: timestamp, reason, ...command })
      .strict()
      .parse(req.body);
    res.json(
      transaction(() => {
        const previous = replay(user, 'correction', shiftId, input.requestId, input);
        if (previous) return previous;
        const shift = shiftRecord(shiftId);
        expectShift(shift, input.expectedRevision);
        if (shift.status === 'voided') fail(409, 'A voided attendance entry cannot be corrected.');
        if (shift.startedAt === input.startedAt && shift.endedAt === input.endedAt)
          fail(400, 'Change at least one attendance time.');
        const after = { startedAt: input.startedAt, endedAt: input.endedAt, voided: false };
        checkInterval(shift.userId, after, shiftId);
        return append(
          req,
          'correction',
          shiftId,
          input,
          input,
          shiftId,
          shift.userId,
          stateOf(shift),
          after,
          input.reason,
        );
      }),
    );
  });
  app.post('/api/attendance/shifts/:id/void', (req: AuthRequest, res) => {
    const user = actor(req, ['admin']),
      shiftId = String(req.params.id),
      input = z
        .object({ reason, ...command })
        .strict()
        .parse(req.body);
    res.json(
      transaction(() => {
        const previous = replay(user, 'void', shiftId, input.requestId, input);
        if (previous) return previous;
        const shift = shiftRecord(shiftId);
        expectShift(shift, input.expectedRevision);
        if (shift.status === 'voided') fail(409, 'This attendance entry is already voided.');
        const before = stateOf(shift),
          after = { ...before, voided: true };
        return append(
          req,
          'void',
          shiftId,
          input,
          input,
          shiftId,
          shift.userId,
          before,
          after,
          input.reason,
        );
      }),
    );
  });
  function scope(user: User, input: { userId?: string }): string | null {
    if (user.role !== 'admin') {
      if (input.userId && input.userId !== user.id)
        fail(403, 'You can only view your own attendance.');
      return user.id;
    }
    if (input.userId) staffRecord(input.userId);
    return input.userId ?? null;
  }
  function reportQuery(input: ReportFilter) {
    const clauses = ['s.startDate>=?', 's.startDate<=?'],
      values: (string | number)[] = [input.from, input.to];
    if (input.userId !== null) {
      clauses.push('s.userId=?');
      values.push(input.userId);
    }
    if (input.status !== 'all') {
      clauses.push('s.status=?');
      values.push(input.status);
    }
    return { where: ` WHERE ${clauses.join(' AND ')}`, values };
  }
  function reportSummary(input: ReportFilter) {
    const query = reportQuery(input);
    const row = db
      .prepare(
        `SELECT count(*) total,
      COALESCE(SUM(CASE WHEN s.status='closed' THEN 1 ELSE 0 END),0) closedShiftCount,
      COALESCE(SUM(CASE WHEN s.status='closed' THEN CAST((s.endAt-s.startAt)/1000 AS INTEGER) ELSE 0 END),0) recordedSeconds,
      COALESCE(SUM(CASE WHEN s.status='open' THEN 1 ELSE 0 END),0) openShiftCount,
      COALESCE(SUM(CASE WHEN s.status='voided' THEN 1 ELSE 0 END),0) voidedShiftCount
      FROM attendanceState s${query.where}`,
      )
      .get(...query.values)!;
    const hash = createHash('sha256').update(JSON.stringify(input));
    for (const item of db
      .prepare(
        `SELECT s.shiftId,s.latestEventId FROM attendanceState s${query.where} ORDER BY s.shiftId`,
      )
      .iterate(...query.values))
      hash.update(JSON.stringify([item.shiftId, item.latestEventId]));
    return {
      total: Number(row.total),
      revision: hash.digest('hex'),
      totals: {
        closedShiftCount: Number(row.closedShiftCount),
        recordedSeconds: Number(row.recordedSeconds),
        openShiftCount: Number(row.openShiftCount),
        voidedShiftCount: Number(row.voidedShiftCount),
      },
      query,
    };
  }
  app.get('/api/attendance', (req: AuthRequest, res) => {
    const user = staffActor(req);
    const input = z
      .object({
        ...filters,
        page: positiveInteger('1', 1_000_000),
        pageSize: positiveInteger('25', 100),
      })
      .strict()
      .refine(validRange, 'Choose an ordered range of at most 366 days.')
      .parse(req.query);
    res.json(
      transaction((): AttendanceReport => {
        const normalized: ReportFilter = {
          from: input.from,
          to: input.to,
          userId: scope(user, input),
          status: input.status,
        };
        const summary = reportSummary(normalized),
          totalPages = Math.max(1, Math.ceil(summary.total / input.pageSize)),
          page = Math.min(input.page, totalPages);
        const rows = db
          .prepare(
            `${selectShift}${summary.query.where} ORDER BY s.startAt DESC,s.shiftId DESC LIMIT ? OFFSET ?`,
          )
          .all(
            ...summary.query.values,
            input.pageSize,
            (page - 1) * input.pageSize,
          ) as unknown as StateRow[];
        return {
          ...normalized,
          items: rows.map(shiftFrom),
          page,
          pageSize: input.pageSize,
          total: summary.total,
          totalPages,
          timezone: 'Asia/Kolkata',
          generatedAt: now(),
          revision: summary.revision,
          totals: summary.totals,
        };
      }, false),
    );
  });
  app.get('/api/attendance/export.csv', (req: AuthRequest, res) => {
    const user = actor(req, ['admin']);
    const input = z
      .object({ ...filters, expectedRevision: revision })
      .strict()
      .refine(validRange, 'Choose an ordered range of at most 366 days.')
      .parse(req.query);
    const output = transaction(() => {
      const normalized: ReportFilter = {
        from: input.from,
        to: input.to,
        userId: scope(user, input),
        status: input.status,
      };
      const summary = reportSummary(normalized);
      if (summary.revision !== input.expectedRevision)
        fail(
          409,
          'Attendance changed since this report loaded. Refresh the report before exporting.',
        );
      if (summary.total > 10_000)
        fail(422, 'This export exceeds 10,000 entries. Narrow the dates, staff or status filters.');
      const csv = [
        [
          'Recorded attendance',
          'Asia/Kolkata start-date cohort; full closed-shift seconds; not payroll or verified physical presence',
        ],
        [
          'From',
          input.from,
          'Through',
          input.to,
          'Staff scope',
          normalized.userId ?? 'All staff',
          'Status',
          input.status,
        ],
        [
          'Closed entries',
          summary.totals.closedShiftCount,
          'Recorded seconds',
          summary.totals.recordedSeconds,
          'Open entries',
          summary.totals.openShiftCount,
          'Voided entries',
          summary.totals.voidedShiftCount,
        ],
        [
          'Entry ID',
          'Staff account ID',
          'Recorded staff name',
          'Recorded staff role',
          'Source',
          'Started at (UTC)',
          'Ended at (UTC)',
          'IST start date',
          'Status',
          'Recorded seconds',
        ],
      ].map((cells) => cells.map(escapeCsvCell).join(','));
      for (const row of db
        .prepare(`${selectShift}${summary.query.where} ORDER BY s.startAt DESC,s.shiftId DESC`)
        .iterate(...summary.query.values)) {
        const shift = shiftFrom(row as unknown as StateRow);
        csv.push(
          [
            shift.id,
            shift.userId,
            shift.staffName,
            shift.staffRole,
            shift.source,
            shift.startedAt,
            shift.endedAt ?? '',
            startDate(Date.parse(shift.startedAt)),
            shift.status,
            shift.recordedSeconds ?? '',
          ]
            .map(escapeCsvCell)
            .join(','),
        );
      }
      audit(req, 'exported attendance timesheet', 'attendance-report', `${input.from}:${input.to}`);
      return { csv: csv.join('\r\n') + '\r\n', revision: summary.revision };
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="attendance-${input.from}-to-${input.to}.csv"`,
    );
    res.setHeader('X-Attendance-Revision', output.revision);
    res.send(output.csv);
  });
}
