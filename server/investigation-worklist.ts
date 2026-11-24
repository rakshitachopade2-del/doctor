import type { Express } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AuthRequest } from './app.ts';
import type { Investigation } from '../shared/clinical.ts';
import type { Doctor, Patient, User } from '../shared/types.ts';
import type {
  InvestigationAssignment,
  InvestigationHandoverCommand,
  InvestigationHandoverReceipt,
  InvestigationHandoverNotRecorded,
  InvestigationOwner,
  InvestigationReviewContext,
  InvestigationWorkItem,
} from '../shared/investigation-worklist.ts';
import { clinicToday, get, id, list, nowISO, type DB } from './db.ts';
import { notifyClinicians } from './activity.ts';

interface WorklistContext {
  currentCareUser: (req: AuthRequest) => User;
  db: DB;
  actor: (req: AuthRequest, roles?: User['role'][]) => User;
  patientAccess: (req: AuthRequest, patientId: string) => Patient;
  view: (investigationId: string) => Investigation;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
}
type Operation = 'assignment' | 'review';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const investigationRevision = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'Refresh the investigation review context.');
export const investigationRequestId = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());

export function registerInvestigationWorklist(app: Express, context: WorklistContext) {
  const { db, actor, patientAccess, view, audit, fail } = context;
  db.exec(`
    CREATE TABLE IF NOT EXISTS investigationAssignments (
      id TEXT PRIMARY KEY, investigationId TEXT NOT NULL REFERENCES investigations(id), data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS investigationHandoverRefusals (
      requestId TEXT PRIMARY KEY, actorId TEXT NOT NULL REFERENCES users(id), investigationId TEXT NOT NULL REFERENCES investigations(id),
      commandHash TEXT NOT NULL, status INTEGER NOT NULL CHECK(status IN (400,409)), message TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS investigationReviewRefusals (
      requestId TEXT PRIMARY KEY, actorId TEXT NOT NULL REFERENCES users(id), investigationId TEXT NOT NULL REFERENCES investigations(id),
      commandHash TEXT NOT NULL, message TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS investigation_assignments_order ON investigationAssignments(investigationId);
    CREATE TABLE IF NOT EXISTS investigationCommands (
      requestId TEXT PRIMARY KEY, actorId TEXT NOT NULL REFERENCES users(id),
      operation TEXT NOT NULL CHECK(operation IN ('assignment','review')),
      investigationId TEXT NOT NULL REFERENCES investigations(id), payload TEXT NOT NULL, eventId TEXT NOT NULL
    );
  `);
  for (const table of [
    'investigationAssignments',
    'investigationCommands',
    'investigationReviewRefusals',
    'investigationHandoverRefusals',
  ]) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT,'Investigation handovers and command records are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT,'Investigation handovers and command records are immutable'); END;`);
  }
  function transaction<T>(operation: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  function eligibleOwners(): InvestigationOwner[] {
    const counts = new Map<string, number>();
    const accounts = db
      .prepare("SELECT data FROM users WHERE role IN ('doctor','admin')")
      .all()
      .map((row) => JSON.parse(row.data as string) as User);
    for (const user of accounts) {
      if (user.active !== false && ['doctor', 'admin'].includes(user.role) && user.doctorId)
        counts.set(user.doctorId, (counts.get(user.doctorId) ?? 0) + 1);
    }
    return list<Doctor>(db, 'doctors')
      .filter((doctor) => counts.has(doctor.id))
      .map((doctor) => ({
        doctorId: doctor.id,
        doctorName: doctor.name,
        activeAccounts: counts.get(doctor.id)!,
      }))
      .sort(
        (a, b) => a.doctorName.localeCompare(b.doctorName) || a.doctorId.localeCompare(b.doctorId),
      );
  }
  function assignments(investigationId: string): InvestigationAssignment[] {
    return db
      .prepare(
        'SELECT data FROM investigationAssignments WHERE investigationId=? ORDER BY rowid DESC',
      )
      .all(investigationId)
      .map((row) => JSON.parse(row.data as string) as InvestigationAssignment);
  }
  function owner(
    investigation: Investigation,
    history = assignments(investigation.id),
    available = new Set(eligibleOwners().map((entry) => entry.doctorId)),
  ) {
    const latest = history[0];
    const doctorId = latest?.doctorId ?? investigation.doctorId;
    return {
      doctorId,
      doctorName:
        get<Doctor>(db, 'doctors', doctorId)?.name ??
        latest?.doctorName ??
        investigation.doctorName,
      available: available.has(doctorId),
    };
  }
  function reviewContext(
    investigationId: string,
    available = new Set(eligibleOwners().map((entry) => entry.doctorId)),
  ): InvestigationReviewContext {
    const investigation = view(investigationId),
      history = assignments(investigationId),
      assigned = owner(investigation, history, available);
    const latestResult = investigation.results.at(-1) ?? null;
    const latestReview = latestResult
      ? (investigation.reviews.filter((review) => review.resultId === latestResult.id).at(-1) ??
        null)
      : null;
    const cancelled = investigation.status === 'cancelled';
    return {
      investigationId,
      patientId: investigation.patientId,
      patientName: get<Patient>(db, 'patients', investigation.patientId)!.name,
      title: investigation.title,
      kind: investigation.kind,
      orderedByDoctorId: investigation.doctorId,
      orderedByDoctorName: investigation.doctorName,
      ownerDoctorId: assigned.doctorId,
      ownerDoctorName: assigned.doctorName,
      ownerAvailable: assigned.available,
      status: investigation.status,
      dueDate: investigation.dueDate,
      createdAt: investigation.createdAt,
      latestResultId: latestResult?.id ?? null,
      latestResultAt: latestResult?.createdAt ?? null,
      latestReviewId: latestReview?.id ?? null,
      latestReviewAt: latestReview?.createdAt ?? null,
      needsReview: !cancelled && latestResult !== null && latestReview === null,
      awaitingPublication: !cancelled && latestReview !== null && latestReview.publishedAt === null,
      pastRequestedDate:
        investigation.status === 'ordered' &&
        investigation.dueDate !== null &&
        investigation.dueDate < clinicToday(),
      // Only source state participates. Calendar rollover or corrected demographic labels
      // do not silently alter an order, result or clinician interpretation.
      revision: hash({ investigation, assignmentIds: history.map((entry) => entry.id) }),
      investigation,
      assignments: history,
    };
  }
  function access(req: AuthRequest, investigationId: string) {
    const order = get<Investigation>(db, 'investigations', investigationId);
    if (!order) return fail(404, 'Investigation not found.');
    patientAccess(req, order.patientId);
    return order;
  }
  function commandReplay(
    user: User,
    operation: Operation,
    investigationId: string,
    requestId: string,
    payload: unknown,
  ) {
    const prior = db
      .prepare(
        'SELECT actorId,operation,investigationId,payload,eventId FROM investigationCommands WHERE requestId=?',
      )
      .get(requestId);
    if (!prior) {
      if (
        db
          .prepare(
            'SELECT 1 FROM investigationReviewRefusals WHERE requestId=? UNION ALL SELECT 1 FROM investigationHandoverRefusals WHERE requestId=?',
          )
          .get(requestId, requestId)
      )
        return fail(409, 'This investigation request was already used with different details.');
      return null;
    }
    if (
      prior.actorId !== user.id ||
      prior.operation !== operation ||
      prior.investigationId !== investigationId ||
      prior.payload !== JSON.stringify(payload)
    )
      fail(409, 'This investigation request was already used with different details.');
    return String(prior.eventId);
  }
  function rememberCommand(
    user: User,
    operation: Operation,
    investigationId: string,
    requestId: string,
    payload: unknown,
    eventId: string,
  ) {
    const stored = db
      .prepare(
        'INSERT INTO investigationCommands(requestId,actorId,operation,investigationId,payload,eventId) VALUES (?,?,?,?,?,?)',
      )
      .run(requestId, user.id, operation, investigationId, JSON.stringify(payload), eventId);
    if (Number(stored.changes) !== 1)
      throw new Error('The investigation command could not be recorded.');
  }
  function audited(req: AuthRequest, action: string, investigationId: string) {
    audit(req, action, 'investigation', investigationId);
    if (Number(db.prepare('SELECT changes() AS n').get()!.n) !== 1)
      throw new Error('The investigation audit could not be recorded.');
  }
  function staff(req: AuthRequest) {
    context.currentCareUser(req);
    return actor(req, ['admin', 'doctor']);
  }
  app.get('/api/investigation-owners', (req: AuthRequest, res) => {
    res.json(
      transaction(() => {
        staff(req);
        return eligibleOwners();
      }),
    );
  });
  app.get('/api/investigation-worklist', (req: AuthRequest, res) => {
    const result = transaction(() => {
      const user = staff(req);
      const input = z
        .object({ scope: z.enum(['mine', 'all']).optional() })
        .strict()
        .parse(req.query);
      const scope = input.scope ?? (user.role === 'admin' ? 'all' : 'mine');
      const available = new Set(eligibleOwners().map((entry) => entry.doctorId));
      const rows: InvestigationWorkItem[] = list<Investigation>(db, 'investigations')
        .map((investigation) => reviewContext(investigation.id, available))
        .filter((entry) => scope === 'all' || entry.ownerDoctorId === user.doctorId)
        .map(({ investigation: _investigation, assignments: _assignments, ...entry }) => entry);
      const rank = (entry: InvestigationWorkItem) =>
        entry.needsReview
          ? 0
          : entry.awaitingPublication
            ? 1
            : entry.pastRequestedDate
              ? 2
              : entry.status === 'cancelled'
                ? 4
                : 3;
      rows.sort(
        (a, b) =>
          rank(a) - rank(b) ||
          (a.needsReview
            ? a.latestResultAt!
            : a.awaitingPublication
              ? a.latestReviewAt!
              : (a.dueDate ?? '9999-12-31')
          ).localeCompare(
            b.needsReview
              ? b.latestResultAt!
              : b.awaitingPublication
                ? b.latestReviewAt!
                : (b.dueDate ?? '9999-12-31'),
          ) ||
          a.createdAt.localeCompare(b.createdAt) ||
          a.investigationId.localeCompare(b.investigationId),
      );
      audited(req, 'viewed investigation worklist', scope);
      return rows;
    });
    res.json(result);
  });
  app.get('/api/investigations/:id/review-context', (req: AuthRequest, res) => {
    const investigationId = String(req.params.id);
    res.json(
      transaction(() => {
        staff(req);
        access(req, investigationId);
        const result = reviewContext(investigationId);
        audited(req, 'viewed investigation review context', investigationId);
        return result;
      }),
    );
  });
  app.post('/api/investigations/:id/assignment', (req: AuthRequest, res) => {
    const result = transaction(() => {
      const user = staff(req),
        investigationId = String(req.params.id);
      access(req, investigationId);
      const command = z
        .object({
          doctorId: z.string().trim().min(1).max(300),
          reason: z.string().trim().min(1).max(1000),
          expectedRevision: investigationRevision,
          requestId: investigationRequestId,
          recoverable: z.literal(true).optional(),
        })
        .strict()
        .parse(req.body);
      const { requestId, expectedRevision, recoverable, ...input } = command;
      const checked: InvestigationHandoverCommand | null = recoverable
        ? { ...command, recoverable }
        : null;
      if (checked) z.strictObject({}).parse(req.query);
      if (user.role === 'doctor' && (!user.doctorId || !get<Doctor>(db, 'doctors', user.doctorId)))
        return fail(
          403,
          'Only the current investigation owner or an administrator can reassign responsibility.',
        );
      const evidence = checked
        ? { command: checked, issuerRole: user.role, issuerDoctorId: user.doctorId ?? null }
        : input;
      const fingerprint = checked ? hash(evidence) : null;
      const refused = (
        body: InvestigationHandoverCommand,
        message: string,
      ): InvestigationHandoverNotRecorded => ({
        code: 'INVESTIGATION_HANDOVER_NOT_RECORDED',
        actorId: user.id,
        investigationId,
        command: body,
        message,
      });
      if (checked) {
        const prior = db
          .prepare(
            'SELECT actorId,investigationId,commandHash,status,message FROM investigationHandoverRefusals WHERE requestId=?',
          )
          .get(requestId);
        if (prior) {
          if (
            prior.actorId !== user.id ||
            prior.investigationId !== investigationId ||
            prior.commandHash !== fingerprint
          )
            return fail(409, 'This investigation request was already used with different details.');
          return { status: Number(prior.status), body: refused(checked, String(prior.message)) };
        }
      }
      const confirmed = (eventId: string, status: number) => {
        const current = reviewContext(investigationId);
        if (!checked) return { status, body: current };
        const event = current.assignments.find((a) => a.id === eventId);
        if (!event) throw new Error('The original investigation handover could not be confirmed.');
        const receipt: InvestigationHandoverReceipt = {
          requestId,
          actorId: user.id,
          investigationId,
          expectedRevision,
          assignment: event,
        };
        return { status, body: { ...current, receipt } };
      };
      // An eligible issuing account can recover its exact handover after the recipient took ownership.
      const priorEventId = commandReplay(user, 'assignment', investigationId, requestId, evidence);
      if (priorEventId) return confirmed(priorEventId, 200);
      const current = reviewContext(investigationId);
      if (user.role === 'doctor' && user.doctorId !== current.ownerDoctorId)
        return fail(
          403,
          'Only the current investigation owner or an administrator can reassign responsibility.',
        );
      const deny = (status: 400 | 409, message: string) => {
        if (!checked) return fail(status, message);
        const stored = db
          .prepare(
            'INSERT INTO investigationHandoverRefusals(requestId,actorId,investigationId,commandHash,status,message) VALUES (?,?,?,?,?,?)',
          )
          .run(requestId, user.id, investigationId, fingerprint, status, message);
        if (Number(stored.changes) !== 1)
          throw new Error('Investigation handover refusal could not be recorded.');
        return { status, body: refused(checked, message) };
      };
      if (current.revision !== expectedRevision)
        return deny(
          409,
          'The investigation, results, reviews or responsibility changed. Refresh and review the latest context before saving.',
        );
      if (current.status === 'cancelled')
        return deny(409, 'A cancelled investigation cannot be reassigned.');
      const next = eligibleOwners().find((candidate) => candidate.doctorId === input.doctorId);
      if (!next) return deny(400, 'Choose a clinician with an active linked account.');
      if (next.doctorId === current.ownerDoctorId)
        return deny(409, 'This clinician already owns this investigation.');
      const assignment: InvestigationAssignment = {
        id: id(),
        investigationId,
        doctorId: next.doctorId,
        doctorName: next.doctorName,
        previousDoctorId: current.ownerDoctorId,
        previousDoctorName: current.ownerDoctorName,
        reason: input.reason,
        assignedById: user.id,
        assignedByName: user.name,
        createdAt: nowISO(),
      };
      const stored = db
        .prepare('INSERT INTO investigationAssignments(id,investigationId,data) VALUES (?,?,?)')
        .run(assignment.id, investigationId, JSON.stringify(assignment));
      if (Number(stored.changes) !== 1)
        throw new Error('Investigation handover could not be recorded.');
      rememberCommand(user, 'assignment', investigationId, requestId, evidence, assignment.id);
      audited(req, 'assigned investigation responsibility', investigationId);
      const delivered = notifyClinicians(
        db,
        current.patientId,
        `investigation-assignment:${assignment.id}`,
        {
          kind: 'investigation',
          title: 'Investigation responsibility was assigned to you',
          detail: 'Open the investigation to review its current results and handover.',
          href: `/clinic/investigations?investigation=${investigationId}`,
        },
        { doctorId: next.doctorId, excludeActorId: user.id },
      );
      if (!delivered) throw new Error('Investigation handover notification could not be recorded.');
      return confirmed(assignment.id, 201);
    });
    res.status(result.status).json(result.body);
  });
  return {
    reviewContext,
    commandReplay,
    rememberCommand,
    ownerDoctorId: (investigationId: string) => owner(view(investigationId)).doctorId,
  };
}
