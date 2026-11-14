import type { Express } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AuthRequest } from './app.ts';
import type { User } from '../shared/types.ts';
import type {
  AppointmentReminderPolicy,
  AppointmentReminderPolicyChange,
  AppointmentReminderPolicyContext,
  AppointmentReminderWorker,
  AppointmentReminderSnapshot,
  AppointmentReminderRecipient,
  AppointmentReminderCandidate,
  AppointmentReminderPreview,
  AppointmentReminderEvent,
  AppointmentReminderRun,
  AppointmentReminderRunSummary,
  AppointmentReminderPage,
  AppointmentReminderHistory,
} from '../shared/appointment-reminders.ts';
import { get, id, nowISO, type DB } from './db.ts';
import { mfaSessionAllowed } from './mfa.ts';
import { notifyPatientRecipient } from './activity.ts';

interface Dependencies {
  db: DB;
  actor: (req: AuthRequest, roles?: User['role'][]) => User;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
}
const defaultPolicy: AppointmentReminderPolicy = { enabled: false, leadHours: 24 };
const intervalSeconds = 300,
  batchLimit = 200;
const heartbeatKey = 'appointment-reminder-worker';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const empty = z.object({}).strict();
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const policySchema = z
  .object({
    enabled: z.boolean(),
    leadHours: z.number().int().min(1).max(168),
    reason: z.string().trim().min(1).max(1000),
    expectedRevision: revision,
    requestId: uuid,
  })
  .strict();
const runSchema = z
  .object({
    expectedPreviewRevision: revision,
    expectedPolicyRevision: revision,
    confirmed: z.literal(true),
    requestId: uuid,
  })
  .strict();
const pageSchema = z
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
const localISO = (time: number) => new Date(time + 19800000).toISOString().slice(0, -1);
const episode = (value: AppointmentReminderSnapshot) =>
  digest([value.id, value.date, value.time, value.doctorId, value.mode]);
const startsAt = (value: AppointmentReminderSnapshot) =>
  new Date(`${value.date}T${value.time}:00+05:30`).toISOString();
const eligibleUser = `u.role='patient' AND COALESCE(json_extract(u.data,'$.active'),1)=1
  AND COALESCE(json_extract(u.data,'$.mustChangePassword'),0)=0`;
const projection = `a.id,a.patientId,json_extract(p.data,'$.name') AS patientName,a.doctorId,
  json_extract(a.data,'$.doctorName') AS doctorName,a.date,a.time,json_extract(a.data,'$.mode') AS mode,
  COALESCE(json_extract(a.data,'$.durationMinutes'),30) AS durationMinutes,a.status`;
type CandidateRow = AppointmentReminderSnapshot & { recipientId: string; recipientName: string };

export function createAppointmentReminders({ db, actor, audit, fail }: Dependencies) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS appointmentReminderPolicyChanges(id TEXT PRIMARY KEY,createdAt TEXT NOT NULL,data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS appointment_reminder_policy_history ON appointmentReminderPolicyChanges(createdAt DESC,id DESC);
    CREATE TABLE IF NOT EXISTS appointmentReminderRuns(id TEXT PRIMARY KEY,source TEXT NOT NULL,createdAt TEXT NOT NULL,data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS appointment_reminder_runs_history ON appointmentReminderRuns(createdAt DESC,id DESC);
    CREATE TABLE IF NOT EXISTS appointmentReminderEvents(
      id TEXT PRIMARY KEY,appointmentId TEXT NOT NULL REFERENCES appointments(id),
      recipientId TEXT NOT NULL REFERENCES users(id),episodeId TEXT NOT NULL,
      date TEXT NOT NULL,time TEXT NOT NULL,doctorId TEXT NOT NULL,mode TEXT NOT NULL,
      runId TEXT NOT NULL REFERENCES appointmentReminderRuns(id),createdAt TEXT NOT NULL,data TEXT NOT NULL,
      UNIQUE(episodeId,recipientId)
    );
    CREATE INDEX IF NOT EXISTS appointment_reminder_identity ON appointmentReminderEvents(appointmentId,date,time,doctorId,mode,recipientId);
    CREATE INDEX IF NOT EXISTS appointment_reminder_history ON appointmentReminderEvents(appointmentId,createdAt DESC,id DESC);
    CREATE INDEX IF NOT EXISTS appointment_reminder_window ON appointments(date,time,id) WHERE status='scheduled';
    CREATE INDEX IF NOT EXISTS appointment_reminder_patient_accounts_text ON users(CAST(json_extract(data,'$.patientId') AS TEXT),id) WHERE role='patient';
    CREATE TABLE IF NOT EXISTS appointmentReminderCommands(requestId TEXT PRIMARY KEY,actorId TEXT NOT NULL REFERENCES users(id),
      operation TEXT NOT NULL,payload TEXT NOT NULL,resultId TEXT NOT NULL);
  `);
  for (const table of [
    'appointmentReminderPolicyChanges',
    'appointmentReminderRuns',
    'appointmentReminderEvents',
    'appointmentReminderCommands',
  ])
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT,'Appointment reminder evidence is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT,'Appointment reminder evidence is immutable'); END;`);
  let timer: ReturnType<typeof setInterval> | undefined;
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
  function authorize(req: AuthRequest, adminOnly = false) {
    const cached = actor(req, ['admin', 'doctor', 'receptionist']);
    const user = get<User>(db, 'users', cached.id);
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
    if (
      user.mustChangePassword ||
      !['admin', 'doctor', 'receptionist'].includes(user.role) ||
      (adminOnly && user.role !== 'admin')
    )
      return fail(403, 'This account cannot manage appointment reminders.');
    req.user = user;
    return user;
  }
  function policy() {
    const row = db
      .prepare('SELECT data FROM appointmentReminderPolicyChanges ORDER BY rowid DESC LIMIT 1')
      .get();
    const latestChange = row
      ? (JSON.parse(row.data as string) as AppointmentReminderPolicyChange)
      : null;
    const value = latestChange?.after ?? { ...defaultPolicy };
    return { policy: value, revision: digest([value, latestChange?.id ?? null]), latestChange };
  }
  function worker(): AppointmentReminderWorker {
    const row = db.prepare('SELECT value FROM meta WHERE key=?').get(heartbeatKey);
    const saved = row
      ? (JSON.parse(row.value as string) as Partial<AppointmentReminderWorker>)
      : {};
    return {
      automaticEnabled: timer !== undefined,
      intervalSeconds,
      batchLimit: 200 as const,
      lastCheckedAt: saved.lastCheckedAt ?? null,
      lastRunId: saved.lastRunId ?? null,
      lastErrorAt: saved.lastErrorAt ?? null,
    };
  }
  function heartbeat(success: boolean, runId: string | null = null) {
    const previous = worker();
    const value = {
      lastCheckedAt: success ? nowISO() : previous.lastCheckedAt,
      lastRunId: runId ?? previous.lastRunId,
      lastErrorAt: success ? previous.lastErrorAt : nowISO(),
    };
    db.prepare(
      'INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    ).run(heartbeatKey, JSON.stringify(value));
  }
  function context(): AppointmentReminderPolicyContext {
    return { ...policy(), worker: worker() };
  }
  function page<T>(
    table: string,
    input: z.infer<typeof pageSchema>,
    where = '',
    params: string[] = [],
    select = 'data',
  ): AppointmentReminderPage<T> {
    const clause = where ? ` WHERE ${where}` : '';
    const total = Number(
      db.prepare(`SELECT count(*) AS n FROM ${table}${clause}`).get(...params)!.n,
    );
    const totalPages = Math.max(1, Math.ceil(total / input.pageSize)),
      page = Math.min(input.page, totalPages);
    const items = db
      .prepare(
        `SELECT ${select} FROM ${table}${clause} ORDER BY createdAt DESC,id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, input.pageSize, (page - 1) * input.pageSize)
      .map((row) => JSON.parse(row.data as string) as T);
    return { items, page, pageSize: input.pageSize, total, totalPages };
  }
  function evaluate(asOf = Date.now()): AppointmentReminderPreview {
    const current = policy(),
      lower = localISO(asOf),
      upper = localISO(asOf + current.policy.leadHours * 3600000);
    const cte = `WITH upcoming AS (
      SELECT ${projection} FROM appointments a JOIN patients p ON p.id=a.patientId
      WHERE a.status='scheduled' AND a.date>=? AND a.date<=?
      AND a.date||'T'||a.time||':00.000'>? AND a.date||'T'||a.time||':00.000'<=?
    ), candidates AS (
      SELECT a.*,u.id AS recipientId,json_extract(u.data,'$.name') AS recipientName,
        EXISTS(SELECT 1 FROM appointmentReminderEvents e WHERE e.appointmentId=a.id AND e.date=a.date
          AND e.time=a.time AND e.doctorId=a.doctorId AND e.mode=a.mode AND e.recipientId=u.id) AS recorded
      FROM upcoming a JOIN users u ON CAST(json_extract(u.data,'$.patientId') AS TEXT)=a.patientId AND ${eligibleUser}
    )`;
    const params = [lower.slice(0, 10), upper.slice(0, 10), lower, upper];
    const counts = db
      .prepare(
        `${cte} SELECT
      (SELECT count(*) FROM upcoming) AS upcomingAppointmentTotal,
      (SELECT count(*) FROM upcoming a WHERE NOT EXISTS(SELECT 1 FROM candidates c WHERE c.id=a.id)) AS unroutableTotal,
      (SELECT count(*) FROM candidates WHERE recorded=0) AS readyTotal,
      (SELECT count(*) FROM candidates WHERE recorded=1) AS alreadyRecordedTotal`,
      )
      .get(...params)!;
    const items: AppointmentReminderCandidate[] = current.policy.enabled
      ? db
          .prepare(
            `${cte}
      SELECT id,patientId,patientName,doctorId,doctorName,date,time,mode,durationMinutes,status,recipientId,recipientName
      FROM candidates WHERE recorded=0 ORDER BY date,time,id,recipientId LIMIT ?`,
          )
          .all(...params, batchLimit)
          .map((raw) => {
            const row = raw as unknown as CandidateRow;
            const { recipientId, recipientName, ...appointment } = row;
            const startAt = startsAt(appointment);
            return {
              episodeId: episode(appointment),
              appointment,
              recipient: { id: recipientId, name: recipientName },
              startAt,
              dueAt: new Date(
                Date.parse(startAt) - current.policy.leadHours * 3600000,
              ).toISOString(),
            };
          })
      : [];
    const fields = {
      policy: current.policy,
      policyRevision: current.revision,
      status: current.policy.enabled ? ('ready' as const) : ('disabled' as const),
      batchLimit: 200 as const,
      upcomingAppointmentTotal: Number(counts.upcomingAppointmentTotal),
      readyTotal: current.policy.enabled ? Number(counts.readyTotal) : 0,
      unroutableTotal: Number(counts.unroutableTotal),
      alreadyRecordedTotal: Number(counts.alreadyRecordedTotal),
      items,
    };
    return {
      ...fields,
      revision: digest(fields),
      generatedAt: new Date(asOf).toISOString(),
      windowEndAt: new Date(asOf + current.policy.leadHours * 3600000).toISOString(),
      clinicDate: lower.slice(0, 10),
    };
  }
  function commandReplay(user: User, operation: 'policy' | 'run', input: { requestId: string }) {
    const prior = db
      .prepare(
        'SELECT actorId,operation,payload,resultId FROM appointmentReminderCommands WHERE requestId=?',
      )
      .get(input.requestId);
    if (!prior) return null;
    if (
      prior.actorId !== user.id ||
      prior.operation !== operation ||
      prior.payload !== JSON.stringify(input)
    )
      return fail(409, 'This request identifier was already used for another command.');
    return prior.resultId as string;
  }
  function recordCommand(
    user: User,
    operation: string,
    input: { requestId: string },
    resultId: string,
  ) {
    db.prepare(
      'INSERT INTO appointmentReminderCommands(requestId,actorId,operation,payload,resultId) VALUES (?,?,?,?,?)',
    ).run(input.requestId, user.id, operation, JSON.stringify(input), resultId);
  }
  function finalClock(items: AppointmentReminderCandidate[]) {
    const now = Date.now();
    if (items.some((item) => Date.parse(item.startAt) <= now || Date.parse(item.dueAt) > now))
      return fail(409, 'The appointment reminder time window changed. Review a new preview.');
  }
  function deliver(
    preview: AppointmentReminderPreview,
    source: 'manual' | 'automatic',
    req?: AuthRequest,
    requestId: string | null = null,
  ): AppointmentReminderRun {
    if (preview.status !== 'ready' || !preview.items.length)
      return fail(409, 'There are no appointment reminders ready to create.');
    const runId = id(),
      createdAt = nowISO();
    const events: AppointmentReminderEvent[] = preview.items.map((item) => ({
      ...item,
      id: id(),
      runId,
      source,
      policy: preview.policy,
      policyRevision: preview.policyRevision,
      createdAt,
    }));
    const run: AppointmentReminderRun = {
      id: runId,
      requestId,
      source,
      createdById: req?.user?.id ?? null,
      createdByName: req?.user?.name ?? 'Appointment reminder scheduler',
      createdAt,
      previewRevision: preview.revision,
      policyRevision: preview.policyRevision,
      policy: preview.policy,
      checkedAt: preview.generatedAt,
      noticeCount: events.length,
      remainingReady: preview.readyTotal - events.length,
      unroutableTotal: preview.unroutableTotal,
      alreadyRecordedTotal: preview.alreadyRecordedTotal,
      events,
    };
    db.prepare(
      'INSERT INTO appointmentReminderRuns(id,source,createdAt,data) VALUES (?,?,?,?)',
    ).run(runId, source, createdAt, JSON.stringify(run));
    for (const event of events) {
      const a = event.appointment;
      const key = `appointment-reminder:${event.episodeId}:${event.recipient.id}`;
      const activityId = notifyPatientRecipient(db, a.patientId, event.recipient.id, key, {
        kind: 'appointment',
        title: 'Upcoming appointment reminder',
        detail: `Recorded visit: ${a.date} at ${a.time} IST with ${a.doctorName}, ${a.mode}, ${a.durationMinutes} minutes. Open for current appointment details.`,
        href: `/my-care?appointment=${a.id}`,
      });
      if (!activityId) return fail(409, 'A reminder recipient changed. Review a new preview.');
      const inserted = db
        .prepare('SELECT userId,patientId,eventKey FROM activity WHERE id=?')
        .get(activityId);
      if (
        !inserted ||
        inserted.userId !== event.recipient.id ||
        inserted.patientId !== a.patientId ||
        inserted.eventKey !== key
      )
        return fail(409, 'The reminder receipt could not be verified. Review a new preview.');
      db.prepare(
        `INSERT INTO appointmentReminderEvents(id,appointmentId,recipientId,episodeId,date,time,doctorId,mode,runId,createdAt,data)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        event.id,
        a.id,
        event.recipient.id,
        event.episodeId,
        a.date,
        a.time,
        a.doctorId,
        a.mode,
        runId,
        createdAt,
        JSON.stringify(event),
      );
    }
    if (req) audit(req, 'created appointment reminder notices', 'appointment-reminder-run', runId);
    else {
      const value = {
        id: id(),
        actorId: 'system',
        actorName: 'Appointment reminder scheduler',
        action: 'created automatic appointment reminder notices',
        entityType: 'appointment-reminder-run',
        entityId: runId,
        createdAt: nowISO(),
      };
      db.prepare('INSERT INTO audit(id,data) VALUES (?,?)').run(value.id, JSON.stringify(value));
    }
    return run;
  }
  function runAutomatic(): AppointmentReminderRun | null {
    try {
      return transaction(() => {
        const preview = evaluate();
        const run =
          preview.status === 'ready' && preview.items.length ? deliver(preview, 'automatic') : null;
        heartbeat(true, run?.id ?? null);
        if (run) finalClock(run.events);
        return run;
      });
    } catch {
      // A single bounded heartbeat is sufficient; no patient details or raw errors are logged.
      try {
        transaction(() => heartbeat(false));
      } catch {
        /* Database may already be closing. */
      }
      console.error('Appointment reminder check failed. Review local server health.');
      return null;
    }
  }
  function start() {
    if (timer || process.env.APPOINTMENT_REMINDERS_AUTO === 'false') return;
    timer = setInterval(runAutomatic, intervalSeconds * 1000);
    timer.unref();
    runAutomatic();
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = undefined;
  }
  function appointmentHistory(
    appointmentId: string,
    input: z.infer<typeof pageSchema>,
  ): AppointmentReminderHistory {
    const raw = db
      .prepare(
        `SELECT ${projection} FROM appointments a JOIN patients p ON p.id=a.patientId WHERE a.id=?`,
      )
      .get(appointmentId);
    if (!raw) return fail(404, 'Appointment not found.');
    const appointment = raw as unknown as AppointmentReminderSnapshot;
    const current = policy(),
      asOf = Date.now(),
      startAt = startsAt(appointment),
      episodeId = episode(appointment);
    const recipientRow = db
      .prepare(
        `SELECT u.id,json_extract(u.data,'$.name') AS name FROM users u
      WHERE CAST(json_extract(u.data,'$.patientId') AS TEXT)=? AND ${eligibleUser} ORDER BY u.id LIMIT 1`,
      )
      .get(appointment.patientId);
    const recipient = recipientRow
      ? (recipientRow as unknown as AppointmentReminderRecipient)
      : null;
    const prior = recipient
      ? db
          .prepare(
            'SELECT createdAt FROM appointmentReminderEvents WHERE episodeId=? AND recipientId=?',
          )
          .get(episodeId, recipient.id)
      : null;
    const state: AppointmentReminderHistory['current']['state'] = !current.policy.enabled
      ? 'disabled'
      : appointment.status !== 'scheduled'
        ? 'not-scheduled'
        : Date.parse(startAt) <= asOf
          ? 'past'
          : Date.parse(startAt) > asOf + current.policy.leadHours * 3600000
            ? 'not-due'
            : !recipient
              ? 'no-recipient'
              : prior
                ? 'recorded'
                : 'ready';
    return {
      ...page<AppointmentReminderEvent>('appointmentReminderEvents', input, 'appointmentId=?', [
        appointmentId,
      ]),
      appointment,
      current: {
        state,
        episodeId,
        startAt,
        dueAt: new Date(Date.parse(startAt) - current.policy.leadHours * 3600000).toISOString(),
        recipient,
        recordedAt: prior ? String(prior.createdAt) : null,
      },
    };
  }
  function register(app: Express) {
    app.get('/api/appointment-reminder-policy', (req: AuthRequest, res) =>
      res.json(
        transaction(() => {
          authorize(req);
          empty.parse(req.query);
          const value = context();
          audit(
            req,
            'viewed appointment reminder policy',
            'appointment-reminder-policy',
            'current',
          );
          return value;
        }),
      ),
    );
    app.post('/api/appointment-reminder-policy', (req: AuthRequest, res) => {
      const result = transaction(() => {
        const user = authorize(req, true);
        empty.parse(req.query);
        const input = policySchema.parse(req.body);
        const replay = commandReplay(user, 'policy', input);
        if (replay) {
          const change = get<AppointmentReminderPolicyChange>(
            db,
            'appointmentReminderPolicyChanges',
            replay,
          );
          if (!change) return fail(500, 'The saved reminder policy receipt is unavailable.');
          return {
            status: 200,
            value: {
              context: context(),
              change,
            },
          };
        }
        const current = policy();
        if (input.expectedRevision !== current.revision)
          return fail(409, 'The appointment reminder policy changed. Review it before saving.');
        const after = { enabled: input.enabled, leadHours: input.leadHours };
        if (JSON.stringify(after) === JSON.stringify(current.policy))
          return fail(400, 'The appointment reminder policy is unchanged.');
        const change: AppointmentReminderPolicyChange = {
          id: id(),
          requestId: input.requestId,
          expectedRevision: input.expectedRevision,
          before: current.policy,
          after,
          reason: input.reason,
          createdById: user.id,
          createdByName: user.name,
          createdByRole: 'admin',
          createdAt: nowISO(),
        };
        db.prepare(
          'INSERT INTO appointmentReminderPolicyChanges(id,createdAt,data) VALUES (?,?,?)',
        ).run(change.id, change.createdAt, JSON.stringify(change));
        recordCommand(user, 'policy', input, change.id);
        audit(req, 'changed appointment reminder policy', 'appointment-reminder-policy', change.id);
        return { status: 201, value: { context: context(), change } };
      });
      res.status(result.status).json(result.value);
    });
    app.get('/api/appointment-reminder-policy/history', (req: AuthRequest, res) =>
      res.json(
        transaction(() => {
          authorize(req);
          const input = pageSchema.parse(req.query);
          const value = page<AppointmentReminderPolicyChange>(
            'appointmentReminderPolicyChanges',
            input,
          );
          audit(
            req,
            'viewed appointment reminder policy history',
            'appointment-reminder-policy',
            'history',
          );
          return value;
        }),
      ),
    );
    app.get('/api/appointment-reminders/preview', (req: AuthRequest, res) =>
      res.json(
        transaction(() => {
          authorize(req);
          empty.parse(req.query);
          const value = evaluate();
          audit(req, 'previewed appointment reminders', 'appointment-reminder', 'preview');
          return value;
        }),
      ),
    );
    app.post('/api/appointment-reminders/run', (req: AuthRequest, res) => {
      const result = transaction(() => {
        const user = authorize(req, true);
        empty.parse(req.query);
        const input = runSchema.parse(req.body);
        const replay = commandReplay(user, 'run', input);
        if (replay) {
          const value = get<AppointmentReminderRun>(db, 'appointmentReminderRuns', replay);
          if (!value) return fail(500, 'The saved appointment reminder receipt is unavailable.');
          return {
            status: 200,
            value,
          };
        }
        const preview = evaluate();
        if (
          input.expectedPolicyRevision !== preview.policyRevision ||
          input.expectedPreviewRevision !== preview.revision
        )
          return fail(409, 'The appointment reminder preview changed. Review a new preview.');
        const run = deliver(preview, 'manual', req, input.requestId);
        recordCommand(user, 'run', input, run.id);
        finalClock(run.events);
        return { status: 201, value: run };
      });
      res.status(result.status).json(result.value);
    });
    const summaryFields = [
      'id',
      'requestId',
      'source',
      'createdById',
      'createdByName',
      'createdAt',
      'previewRevision',
      'policyRevision',
      'policy',
      'checkedAt',
      'noticeCount',
      'remainingReady',
      'unroutableTotal',
      'alreadyRecordedTotal',
    ];
    const summarySQL = `json_object(${summaryFields.map((key) => `'${key}',json_extract(data,'$.${key}')`).join(',')}) AS data`;
    app.get('/api/appointment-reminders/runs', (req: AuthRequest, res) =>
      res.json(
        transaction(() => {
          authorize(req);
          const input = pageSchema.parse(req.query);
          const value = page<AppointmentReminderRunSummary>(
            'appointmentReminderRuns',
            input,
            '',
            [],
            summarySQL,
          );
          audit(req, 'viewed appointment reminder runs', 'appointment-reminder-run', 'history');
          return value;
        }),
      ),
    );
    app.get('/api/appointment-reminders/runs/:id', (req: AuthRequest, res) =>
      res.json(
        transaction(() => {
          authorize(req);
          empty.parse(req.query);
          const runId = String(req.params.id);
          const value = get<AppointmentReminderRun>(db, 'appointmentReminderRuns', runId);
          if (!value) return fail(404, 'Appointment reminder run not found.');
          audit(req, 'viewed appointment reminder run', 'appointment-reminder-run', runId);
          return value;
        }),
      ),
    );
    app.get('/api/appointments/:id/reminders', (req: AuthRequest, res) =>
      res.json(
        transaction(() => {
          authorize(req);
          const input = pageSchema.parse(req.query),
            appointmentId = String(req.params.id);
          const value = appointmentHistory(appointmentId, input);
          audit(req, 'viewed appointment reminder history', 'appointment', appointmentId);
          return value;
        }),
      ),
    );
  }
  return { register, runAutomatic, start, stop };
}
