import type { Express } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AuthRequest } from './app.ts';
import type { User } from '../shared/types.ts';
import type {
  EscalationCandidate,
  EscalationEvent,
  EscalationHistory,
  EscalationPolicy,
  EscalationPolicyChange,
  EscalationPolicyContext,
  EscalationPolicyMutation,
  EscalationPreview,
  EscalationRecipient,
  EscalationRun,
  EscalationStage,
  EscalationWorkerState,
  FollowUpEscalationState,
} from '../shared/follow-up-escalation.ts';
import { clinicToday, get, id, insert, nowISO, settings, type DB } from './db.ts';
import { notifyClinicalRecipients } from './activity.ts';

interface Dependencies {
  db: DB;
  actor: (req: AuthRequest, roles?: User['role'][]) => User;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
}
interface Source {
  carePlanId: string;
  patientId: string;
  patientName: string;
  title: string;
  latestReviewId: string | null;
  latestAssignmentId: string | null;
  status: 'active' | 'completed';
  reviewDate: string | null;
  ownerDoctorId: string;
  ownerDoctorName: string;
}
interface Notice {
  carePlanId: string;
  episodeId: string;
  stage: EscalationStage;
  createdAt: string;
}
const defaultPolicy: EscalationPolicy = { enabled: false, ownerAfterDays: 3, clinicAfterDays: 7 };
const intervalSeconds = 900,
  batchLimit = 200;
const heartbeatKey = 'follow-up-escalation-worker';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const revision = z.string().regex(/^[a-f0-9]{64}$/, 'Refresh the reminder details before saving.');
const policySchema = z
  .object({
    enabled: z.boolean(),
    ownerAfterDays: z.number().int().min(1).max(30),
    clinicAfterDays: z.number().int().min(2).max(90),
    reason: z.string().trim().min(1).max(1000),
    expectedRevision: revision,
    requestId: uuid,
  })
  .strict()
  .refine(
    (value) => value.clinicAfterDays > value.ownerAfterDays,
    'The clinic reminder must follow the owner reminder.',
  );
const runSchema = z
  .object({ expectedPreviewRevision: revision, expectedPolicyRevision: revision, requestId: uuid })
  .strict();

export function createFollowUpEscalation({ db, actor, audit, fail }: Dependencies) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS followUpEscalationPolicyChanges (id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS followUpEscalationRuns (id TEXT PRIMARY KEY,source TEXT NOT NULL,createdAt TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS followUpEscalationEvents (
      id TEXT PRIMARY KEY,carePlanId TEXT NOT NULL REFERENCES carePlans(id),episodeId TEXT NOT NULL,
      stage TEXT NOT NULL CHECK(stage IN ('owner','clinic')),runId TEXT NOT NULL REFERENCES followUpEscalationRuns(id),
      createdAt TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(episodeId,stage)
    );
    CREATE INDEX IF NOT EXISTS follow_up_escalation_events_plan ON followUpEscalationEvents(carePlanId);
    CREATE TABLE IF NOT EXISTS followUpEscalationCommands (
      requestId TEXT PRIMARY KEY,actorId TEXT NOT NULL REFERENCES users(id),operation TEXT NOT NULL,
      payload TEXT NOT NULL,resultId TEXT NOT NULL
    );
  `);
  for (const table of [
    'followUpEscalationPolicyChanges',
    'followUpEscalationRuns',
    'followUpEscalationEvents',
    'followUpEscalationCommands',
  ])
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT,'Follow-up escalation evidence is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT,'Follow-up escalation evidence is immutable'); END;`);
  let timer: ReturnType<typeof setInterval> | undefined;
  function transaction<T>(work: () => T) {
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
  function policy() {
    const row = db
      .prepare('SELECT data FROM followUpEscalationPolicyChanges ORDER BY rowid DESC LIMIT 1')
      .get();
    const latest = row ? (JSON.parse(row.data as string) as EscalationPolicyChange) : null;
    const value = latest?.after ?? { ...defaultPolicy };
    return { policy: value, revision: hash([value, latest?.id ?? null]) };
  }
  function worker(): EscalationWorkerState {
    const row = db.prepare('SELECT value FROM meta WHERE key=?').get(heartbeatKey);
    const saved = row ? (JSON.parse(row.value as string) as Partial<EscalationWorkerState>) : {};
    return {
      automaticEnabled: timer !== undefined,
      intervalSeconds,
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
  function policyContext(): EscalationPolicyContext {
    return {
      ...policy(),
      followUpEnabled: settings(db).modules.followUp,
      history: db
        .prepare('SELECT data FROM followUpEscalationPolicyChanges ORDER BY rowid DESC')
        .all()
        .map((row) => JSON.parse(row.data as string) as EscalationPolicyChange),
      worker: worker(),
    };
  }
  function sources(planId?: string): Source[] {
    // SQL projects only operational dates, identities and ownership. Assessments and
    // check-in contents never enter reminder evaluation or preview hashing.
    const owner = "COALESCE(json_extract(a.data,'$.doctorId'),json_extract(p.data,'$.doctorId'))";
    return db
      .prepare(
        `SELECT p.id AS carePlanId,p.patientId,json_extract(patient.data,'$.name') AS patientName,
      json_extract(p.data,'$.title') AS title,r.id AS latestReviewId,a.id AS latestAssignmentId,
      CASE WHEN r.id IS NOT NULL THEN CASE WHEN json_extract(r.data,'$.disposition')='complete' THEN 'completed' ELSE 'active' END
        ELSE json_extract(p.data,'$.status') END AS status,
      CASE WHEN (r.id IS NOT NULL AND json_extract(r.data,'$.disposition')='complete')
        OR (r.id IS NULL AND json_extract(p.data,'$.status')='completed') THEN NULL
        ELSE COALESCE(json_extract(r.data,'$.nextReviewDate'),json_extract(p.data,'$.followUpDate')) END AS reviewDate,
      ${owner} AS ownerDoctorId,
      COALESCE(json_extract(d.data,'$.name'),json_extract(a.data,'$.doctorName'),json_extract(p.data,'$.doctorName'),'Clinic doctor') AS ownerDoctorName
      FROM carePlans p JOIN patients patient ON patient.id=p.patientId
      LEFT JOIN followUpReviews r ON r.rowid=(SELECT rowid FROM followUpReviews WHERE carePlanId=p.id ORDER BY rowid DESC LIMIT 1)
      LEFT JOIN followUpAssignments a ON a.rowid=(SELECT rowid FROM followUpAssignments WHERE carePlanId=p.id ORDER BY rowid DESC LIMIT 1)
      LEFT JOIN doctors d ON d.id=${owner}${planId ? ' WHERE p.id=?' : ''}
      ORDER BY reviewDate,p.id`,
      )
      .all(...(planId ? [planId] : [])) as unknown as Source[];
  }
  function recipients(): EscalationRecipient[] {
    return db
      .prepare(
        `SELECT u.id AS userId,json_extract(u.data,'$.name') AS name,u.role,
      json_extract(u.data,'$.doctorId') AS doctorId FROM users u
      JOIN doctors d ON d.id=json_extract(u.data,'$.doctorId')
      WHERE u.role IN ('doctor','admin') AND COALESCE(json_extract(u.data,'$.active'),1)=1
      AND COALESCE(json_extract(u.data,'$.mustChangePassword'),0)=0 ORDER BY u.id`,
      )
      .all() as unknown as EscalationRecipient[];
  }
  function evaluate(planId?: string) {
    const currentPolicy = policy(),
      followUpEnabled = settings(db).modules.followUp,
      today = clinicToday();
    const status: EscalationPreview['status'] = !currentPolicy.policy.enabled
      ? 'disabled'
      : !followUpEnabled
        ? 'paused'
        : 'ready';
    const users = recipients(),
      rows = sources(planId);
    const notices = db
      .prepare(
        `SELECT carePlanId,episodeId,stage,createdAt FROM followUpEscalationEvents${planId ? ' WHERE carePlanId=?' : ''} ORDER BY rowid`,
      )
      .all(...(planId ? [planId] : [])) as unknown as Notice[];
    const byPlan = new Map<string, Notice[]>();
    for (const notice of notices) {
      const values = byPlan.get(notice.carePlanId) ?? [];
      values.push(notice);
      byPlan.set(notice.carePlanId, values);
    }
    const states = new Map<string, FollowUpEscalationState>();
    const items: EscalationCandidate[] = [];
    let readyTotal = 0,
      unroutableTotal = 0,
      alreadyNotifiedTotal = 0;
    for (const row of rows) {
      const active = row.status === 'active' && row.reviewDate !== null;
      const episodeId = active
        ? hash([row.carePlanId, row.latestReviewId ?? 'original', row.reviewDate])
        : null;
      const overdueDays = active
        ? Math.max(
            0,
            Math.floor(
              (Date.parse(`${today}T12:00:00Z`) - Date.parse(`${row.reviewDate}T12:00:00Z`)) /
                86400000,
            ),
          )
        : null;
      const stage: EscalationStage | null =
        overdueDays !== null && overdueDays >= currentPolicy.policy.clinicAfterDays
          ? 'clinic'
          : overdueDays !== null && overdueDays >= currentPolicy.policy.ownerAfterDays
            ? 'owner'
            : null;
      const prior = byPlan.get(row.carePlanId) ?? [],
        current = prior.filter((notice) => notice.episodeId === episodeId);
      const ownerNoticeAt = current.find((notice) => notice.stage === 'owner')?.createdAt ?? null;
      const clinicNoticeAt = current.find((notice) => notice.stage === 'clinic')?.createdAt ?? null;
      const satisfied = clinicNoticeAt !== null || (stage === 'owner' && ownerNoticeAt !== null);
      const ownerUsers = users.filter((user) => user.doctorId === row.ownerDoctorId);
      const targetUsers = stage === 'owner' && ownerUsers.length ? ownerUsers : users;
      const routing: EscalationCandidate['routing'] =
        stage === 'clinic' ? 'clinic' : ownerUsers.length ? 'owner' : 'owner-unavailable-fallback';
      if (stage) {
        if (satisfied) alreadyNotifiedTotal++;
        else if (!targetUsers.length) unroutableTotal++;
        else {
          readyTotal++;
          if (items.length < batchLimit)
            items.push({
              carePlanId: row.carePlanId,
              patientId: row.patientId,
              patientName: row.patientName,
              title: row.title,
              episodeId: episodeId!,
              latestReviewId: row.latestReviewId,
              latestAssignmentId: row.latestAssignmentId,
              reviewDate: row.reviewDate!,
              overdueDays: overdueDays!,
              ownerDoctorId: row.ownerDoctorId,
              ownerDoctorName: row.ownerDoctorName,
              stage,
              routing,
              recipients: targetUsers,
            });
        }
      }
      states.set(row.carePlanId, {
        episodeId,
        reviewDate: row.reviewDate,
        overdueDays,
        eligibleStage: stage,
        ownerNoticeAt,
        clinicNoticeAt,
        historyCount: prior.length,
        state:
          row.status === 'completed'
            ? 'completed'
            : !stage
              ? 'not-due'
              : status === 'disabled'
                ? 'disabled'
                : status === 'paused'
                  ? 'paused'
                  : satisfied
                    ? 'recorded'
                    : !targetUsers.length
                      ? 'no-recipients'
                      : 'ready',
      });
    }
    const snapshot = {
      policyRevision: currentPolicy.revision,
      policy: currentPolicy.policy,
      clinicDate: today,
      status,
      batchLimit,
      readyTotal,
      unroutableTotal,
      alreadyNotifiedTotal,
      items,
    };
    const preview: EscalationPreview = {
      revision: hash({ ...snapshot, followUpEnabled }),
      ...snapshot,
    };
    return { preview, states, sources: rows };
  }
  function commandReplay(user: User, operation: 'policy' | 'run', input: { requestId: string }) {
    const prior = db
      .prepare('SELECT * FROM followUpEscalationCommands WHERE requestId=?')
      .get(input.requestId);
    if (!prior) return null;
    if (
      prior.actorId !== user.id ||
      prior.operation !== operation ||
      prior.payload !== JSON.stringify(input)
    )
      return fail(409, 'This request ID was already used for a different command.');
    return prior.resultId as string;
  }
  function recordCommand(
    user: User,
    operation: 'policy' | 'run',
    input: { requestId: string },
    resultId: string,
  ) {
    db.prepare(
      'INSERT INTO followUpEscalationCommands(requestId,actorId,operation,payload,resultId) VALUES (?,?,?,?,?)',
    ).run(input.requestId, user.id, operation, JSON.stringify(input), resultId);
  }
  function deliver(
    preview: EscalationPreview,
    source: 'manual' | 'automatic',
    req?: AuthRequest,
    requestId: string | null = null,
  ): EscalationRun {
    const runId = id(),
      createdAt = nowISO();
    const events: EscalationEvent[] = preview.items.map((candidate) => ({
      ...candidate,
      id: id(),
      runId,
      source,
      policy: preview.policy,
      policyRevision: preview.policyRevision,
      clinicDate: preview.clinicDate,
      createdAt,
    }));
    const run: EscalationRun = {
      id: runId,
      requestId,
      source,
      createdById: req?.user?.id ?? null,
      createdByName: req?.user?.name ?? 'Follow-up scheduler',
      previewRevision: preview.revision,
      policyRevision: preview.policyRevision,
      clinicDate: preview.clinicDate,
      createdAt,
      notifiedPlans: events.length,
      recipientCount: events.reduce((count, event) => count + event.recipients.length, 0),
      unroutableTotal: preview.unroutableTotal,
      alreadyNotifiedTotal: preview.alreadyNotifiedTotal,
      remainingReady: preview.readyTotal - events.length,
      events,
    };
    db.prepare('INSERT INTO followUpEscalationRuns(id,source,createdAt,data) VALUES (?,?,?,?)').run(
      run.id,
      source,
      createdAt,
      JSON.stringify(run),
    );
    for (const event of events) {
      db.prepare(
        'INSERT INTO followUpEscalationEvents(id,carePlanId,episodeId,stage,runId,createdAt,data) VALUES (?,?,?,?,?,?,?)',
      ).run(
        event.id,
        event.carePlanId,
        event.episodeId,
        event.stage,
        event.runId,
        createdAt,
        JSON.stringify(event),
      );
      const expected = event.recipients.map((user) => user.userId);
      const inserted = notifyClinicalRecipients(
        db,
        event.patientId,
        `follow-up-escalation:${event.episodeId}:${event.stage}`,
        {
          kind: 'follow-up',
          title:
            event.stage === 'clinic'
              ? 'Clinic follow-up review reminder'
              : 'Follow-up review reminder',
          detail: `Recorded review date: ${event.reviewDate} · ${event.overdueDays} calendar days overdue. Open the care plan to review it.`,
          href: `/clinic/follow-ups?escalation=${event.carePlanId}`,
        },
        expected,
      );
      if (JSON.stringify(inserted) !== JSON.stringify(expected))
        fail(409, 'The reminder recipients changed. Refresh the preview before trying again.');
    }
    if (req) audit(req, 'recorded follow-up escalation check', 'follow-up-escalation', run.id);
    else
      insert(db, 'audit', {
        id: id(),
        actorName: 'Follow-up scheduler',
        action: 'recorded automatic follow-up escalation check',
        entityType: 'follow-up-escalation',
        entityId: run.id,
        createdAt,
      } as { id: string });
    return run;
  }
  function runAutomatic(): EscalationRun | null {
    try {
      const result = transaction(() => {
        const preview = evaluate().preview;
        return preview.status === 'ready' && preview.items.length
          ? deliver(preview, 'automatic')
          : null;
      });
      heartbeat(true, result?.id ?? null);
      return result;
    } catch {
      try {
        heartbeat(false);
      } catch {
        /* Database failure must not expose patient data in logs. */
      }
      console.error(
        'Follow-up reminder check failed. Review the local application logs and retry.',
      );
      return null;
    }
  }
  function start() {
    if (timer) return;
    timer = setInterval(runAutomatic, intervalSeconds * 1000);
    timer.unref();
    runAutomatic();
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = undefined;
  }
  function register(app: Express) {
    app.get('/api/follow-up-escalation-policy', (req: AuthRequest, res) => {
      actor(req, ['admin', 'doctor']);
      z.object({}).strict().parse(req.query);
      res.json(
        transaction(() => {
          const value = policyContext();
          audit(req, 'viewed follow-up escalation policy', 'follow-up-escalation', 'policy');
          return value;
        }),
      );
    });
    app.post('/api/follow-up-escalation-policy', (req: AuthRequest, res) => {
      z.object({}).strict().parse(req.query);
      const user = actor(req, ['admin']),
        input = policySchema.parse(req.body);
      res.json(
        transaction((): EscalationPolicyMutation => {
          const prior = commandReplay(user, 'policy', input);
          if (prior)
            return {
              context: policyContext(),
              change: get<EscalationPolicyChange>(db, 'followUpEscalationPolicyChanges', prior)!,
            };
          const current = policy();
          if (current.revision !== input.expectedRevision)
            return fail(
              409,
              'The reminder policy changed. Review the latest policy before saving.',
            );
          const after: EscalationPolicy = {
            enabled: input.enabled,
            ownerAfterDays: input.ownerAfterDays,
            clinicAfterDays: input.clinicAfterDays,
          };
          if (JSON.stringify(after) === JSON.stringify(current.policy))
            return fail(400, 'The reminder policy is unchanged.');
          const change: EscalationPolicyChange = {
            id: id(),
            requestId: input.requestId,
            expectedRevision: input.expectedRevision,
            before: current.policy,
            after,
            reason: input.reason,
            createdById: user.id,
            createdByName: user.name,
            createdAt: nowISO(),
          };
          insert(db, 'followUpEscalationPolicyChanges', change);
          recordCommand(user, 'policy', input, change.id);
          audit(req, 'changed follow-up escalation policy', 'follow-up-escalation', change.id);
          return { context: policyContext(), change };
        }),
      );
    });
    app.get('/api/follow-up-escalations/preview', (req: AuthRequest, res) => {
      actor(req, ['admin']);
      z.object({}).strict().parse(req.query);
      res.json(
        transaction(() => {
          const value = evaluate().preview;
          audit(req, 'previewed follow-up escalation notices', 'follow-up-escalation', 'preview');
          return value;
        }),
      );
    });
    app.post('/api/follow-up-escalations/run', (req: AuthRequest, res) => {
      z.object({}).strict().parse(req.query);
      const user = actor(req, ['admin']),
        input = runSchema.parse(req.body);
      res.json(
        transaction(() => {
          const prior = commandReplay(user, 'run', input);
          if (prior) return get<EscalationRun>(db, 'followUpEscalationRuns', prior)!;
          const preview = evaluate().preview;
          if (
            input.expectedPolicyRevision !== preview.policyRevision ||
            input.expectedPreviewRevision !== preview.revision
          )
            return fail(
              409,
              'The reminder preview changed. Review a new preview before creating notices.',
            );
          if (preview.status !== 'ready')
            return fail(
              409,
              preview.status === 'disabled'
                ? 'The reminder policy is disabled.'
                : 'Follow-up care is currently paused.',
            );
          const run = deliver(preview, 'manual', req, input.requestId);
          recordCommand(user, 'run', input, run.id);
          return run;
        }),
      );
    });
    app.get('/api/care-plans/:id/escalations', (req: AuthRequest, res) => {
      actor(req, ['admin', 'doctor']);
      z.object({}).strict().parse(req.query);
      res.json(
        transaction((): EscalationHistory => {
          const planId = String(req.params.id),
            value = evaluate(planId),
            source = value.sources[0];
          if (!source) return fail(404, 'Care plan not found.');
          const events = db
            .prepare(
              'SELECT data FROM followUpEscalationEvents WHERE carePlanId=? ORDER BY rowid DESC',
            )
            .all(planId)
            .map((row) => JSON.parse(row.data as string) as EscalationEvent);
          audit(req, 'viewed follow-up escalation history', 'carePlan', planId);
          return {
            carePlanId: planId,
            patientId: source.patientId,
            patientName: source.patientName,
            title: source.title,
            current: value.states.get(planId)!,
            events,
          };
        }),
      );
    });
  }
  // The worklist calls states within its own read transaction for a coherent clinical/operational view.
  return { register, states: () => evaluate().states, runAutomatic, start, stop };
}
