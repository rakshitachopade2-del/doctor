import type { Express } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AuthRequest } from './app.ts';
import type { CarePlan, CheckIn, Doctor, Patient, User } from '../shared/types.ts';
import type {
  CheckInSnapshot,
  FollowUpReview,
  FollowUpSummary,
  FollowUpWorkItem,
  PatientFollowUpReview,
  FollowUpAssignment,
  FollowUpOwner,
} from '../shared/follow-up.ts';
import type {
  FollowUpReviewCommand,
  FollowUpReviewContext,
  FollowUpReviewNotRecorded,
  FollowUpReviewResult,
} from '../shared/follow-up-review-recording.ts';
import { followUpRevisionData } from '../shared/follow-up-review-recording.ts';
import { required } from './validation.ts';
import { clinicToday, get, id, list, nowISO, settings, type DB } from './db.ts';
import { notifyPatient, notifyClinicians } from './activity.ts';
import type { FollowUpEscalationState } from '../shared/follow-up-escalation.ts';

interface FollowUpContext {
  db: DB;
  actor: (req: AuthRequest, roles?: User['role'][]) => User;
  patientAccess: (req: AuthRequest, patientId: string, allowReception?: boolean) => Patient;
  clinicianId: (req: AuthRequest) => string;
  authorizeClinician: (req: AuthRequest) => { user: User; doctor: Doctor };
  moduleEnabled: (name: 'followUp') => void;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      !Number.isNaN(Date.parse(`${value}T12:00:00Z`)) &&
      new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value,
    'Invalid calendar date.',
  );
const revisionSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'Refresh the care plan to obtain its current revision.');

const reviewFields = z
  .object({
    expectedRevision: revisionSchema,
    assessment: z.string().trim().min(1).max(8000),
    patientInstructions: z.string().trim().min(1).max(8000),
    disposition: z.enum(['continue', 'visit-requested', 'complete']),
    nextReviewDate: date.nullable(),
  })
  .strict();

const legacyReview = reviewFields
  .extend({ nextReviewDate: date.nullable().optional() })
  .refine((value) => value.disposition === 'complete' || !!value.nextReviewDate, {
    message: 'Choose the next review date while follow-up remains active.',
    path: ['nextReviewDate'],
  });
const reviewCommand = reviewFields
  .extend({
    requestId: z
      .string()
      .uuid()
      .transform((key) => key.toLowerCase()),
    carePlanId: required,
    patientId: required,
    doctorId: required,
    reviewedConfirmed: z.literal(true),
  })
  .refine((value) => (value.disposition === 'complete') === (value.nextReviewDate === null), {
    message: 'Choose a next review date only while follow-up remains active.',
    path: ['nextReviewDate'],
  });
const noQuery = z.object({}).strict();
const staleRevision =
  'This care plan has changed, including new or edited check-ins. Refresh and review the latest information before saving.';
const pastDate = 'Choose today or a future review date.';

export function createFollowUp(context: FollowUpContext) {
  const { db, actor, patientAccess, clinicianId, moduleEnabled, audit, fail } = context;
  db.exec(`CREATE TABLE IF NOT EXISTS followUpReviews (
    id TEXT PRIMARY KEY, carePlanId TEXT NOT NULL REFERENCES carePlans(id), data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS follow_up_reviews_plan ON followUpReviews(carePlanId);
  CREATE TRIGGER IF NOT EXISTS prevent_follow_up_review_update BEFORE UPDATE ON followUpReviews
    BEGIN SELECT RAISE(ABORT,'Follow-up review history is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS prevent_follow_up_review_delete BEFORE DELETE ON followUpReviews
    BEGIN SELECT RAISE(ABORT,'Follow-up review history is append-only'); END;
  CREATE TABLE IF NOT EXISTS followUpAssignments (
    id TEXT PRIMARY KEY, carePlanId TEXT NOT NULL REFERENCES carePlans(id), data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS follow_up_assignments_plan ON followUpAssignments(carePlanId);
  CREATE TRIGGER IF NOT EXISTS prevent_follow_up_assignment_update BEFORE UPDATE ON followUpAssignments
    BEGIN SELECT RAISE(ABORT,'Follow-up assignment history is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS prevent_follow_up_assignment_delete BEFORE DELETE ON followUpAssignments
    BEGIN SELECT RAISE(ABORT,'Follow-up assignment history is append-only'); END;
  CREATE TABLE IF NOT EXISTS followUpReviewCommands (
    requestId TEXT PRIMARY KEY, actorId TEXT NOT NULL REFERENCES users(id),
    carePlanId TEXT NOT NULL REFERENCES carePlans(id), payloadHash TEXT NOT NULL,
    reviewId TEXT UNIQUE REFERENCES followUpReviews(id), rejectionStatus INTEGER, rejection TEXT,
    CHECK ((reviewId IS NOT NULL AND rejection IS NULL AND rejectionStatus IS NULL)
      OR (reviewId IS NULL AND rejection IS NOT NULL AND rejectionStatus IS NOT NULL AND rejectionStatus IN (400,403,409)))
  );
  CREATE TRIGGER IF NOT EXISTS prevent_follow_up_command_update BEFORE UPDATE ON followUpReviewCommands
    BEGIN SELECT RAISE(ABORT,'Follow-up review command evidence is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS prevent_follow_up_command_delete BEFORE DELETE ON followUpReviewCommands
    BEGIN SELECT RAISE(ABORT,'Follow-up review command evidence is immutable'); END;`);
  function transaction<T>(
    operation: () => T,
    start: 'BEGIN IMMEDIATE' | 'BEGIN' = 'BEGIN IMMEDIATE',
  ): T {
    db.exec(start);
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  function reviews(carePlanId: string): FollowUpReview[] {
    return db
      .prepare('SELECT data FROM followUpReviews WHERE carePlanId=? ORDER BY rowid DESC')
      .all(carePlanId)
      .map((row) => JSON.parse(row.data as string) as FollowUpReview);
  }
  function assignments(carePlanId: string): FollowUpAssignment[] {
    return db
      .prepare('SELECT data FROM followUpAssignments WHERE carePlanId=? ORDER BY rowid DESC')
      .all(carePlanId)
      .map((row) => JSON.parse(row.data as string) as FollowUpAssignment);
  }
  function owner(plan: CarePlan) {
    const assignment = assignments(plan.id)[0] ?? null;
    const doctorId = assignment?.doctorId ?? plan.doctorId;
    return {
      doctorId,
      doctorName:
        get<Doctor>(db, 'doctors', doctorId)?.name ??
        assignment?.doctorName ??
        plan.doctorName ??
        'Clinic doctor',
      assignment,
    };
  }
  function eligibleOwners(): FollowUpOwner[] {
    const counts = new Map<string, number>();
    for (const user of list<User>(db, 'users')) {
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
      .sort((a, b) => a.doctorName.localeCompare(b.doctorName));
  }
  function snapshots(carePlanId: string): CheckInSnapshot[] {
    return db
      .prepare('SELECT data FROM checkIns WHERE carePlanId=? ORDER BY date,id')
      .all(carePlanId)
      .map((row) => {
        const original = JSON.parse(row.data as string) as CheckIn;
        // Canonical field order makes the fingerprint independent of JSON property ordering.
        const snapshot: CheckIn = {
          id: original.id,
          carePlanId: original.carePlanId,
          patientId: original.patientId,
          date: original.date,
          adherence: original.adherence,
          feeling: original.feeling,
          note: original.note,
          createdAt: original.createdAt,
        };
        return {
          id: snapshot.id,
          updatedAt: snapshot.createdAt,
          contentHash: hash(snapshot),
          snapshot,
        };
      });
  }
  function patientReview(review: FollowUpReview): PatientFollowUpReview {
    const { assessment: _assessment, checkInSnapshots: _snapshots, ...safe } = review;
    return safe;
  }
  function state(plan: CarePlan) {
    const history = reviews(plan.id),
      latestReview = history[0] ?? null;
    const currentSnapshots = snapshots(plan.id);
    const latestClinicalReview = history.find((review) => review.source === 'clinical-review');
    const priorVersions = new Map(
      latestClinicalReview?.checkInSnapshots.map((version) => [version.id, version.contentHash]) ??
        [],
    );
    const unreviewedCheckIns = currentSnapshots
      .filter((version) => priorVersions.get(version.id) !== version.contentHash)
      .map((version) => version.snapshot);
    const effectiveStatus: 'active' | 'completed' = latestReview
      ? latestReview.disposition === 'complete'
        ? 'completed'
        : 'active'
      : plan.status;
    const effectiveFollowUpDate =
      effectiveStatus === 'completed' ? null : (latestReview?.nextReviewDate ?? plan.followUpDate);
    const assignedOwner = owner(plan);
    const revision = hash(
      followUpRevisionData(
        plan,
        latestReview?.id ?? null,
        assignedOwner.assignment?.id ?? null,
        currentSnapshots,
      ),
    );
    return {
      history,
      assignedOwner,
      latestReview,
      currentSnapshots,
      unreviewedCheckIns,
      effectiveStatus,
      effectiveFollowUpDate,
      revision,
    };
  }
  function hydratePlan(
    plan: CarePlan,
    forPatient = false,
    current = state(plan),
  ): CarePlan & FollowUpSummary {
    return {
      ...plan,
      status: current.effectiveStatus,
      effectiveStatus: current.effectiveStatus,
      effectiveFollowUpDate: current.effectiveFollowUpDate,
      followUpRevision: current.revision,
      latestReview: current.latestReview
        ? forPatient
          ? patientReview(current.latestReview)
          : current.latestReview
        : null,
    };
  }
  function hydratePlans(plans: CarePlan[], forPatient = false) {
    return plans.map((plan) => hydratePlan(plan, forPatient));
  }
  function planAccess(req: AuthRequest, planId: string) {
    actor(req);
    const plan = get<CarePlan>(db, 'carePlans', planId);
    if (!plan) return fail(404, 'Care plan not found.');
    patientAccess(req, plan.patientId);
    return plan;
  }
  function identity(req: AuthRequest) {
    const doctorId = clinicianId(req);
    return { doctorId, doctorName: get<Doctor>(db, 'doctors', doctorId)!.name };
  }
  function assertCurrent(expected: string, current: string) {
    if (expected !== current) fail(409, staleRevision);
  }
  function save(plan: CarePlan, review: FollowUpReview, req: AuthRequest) {
    db.prepare('INSERT INTO followUpReviews(id,carePlanId,data) VALUES (?,?,?)').run(
      review.id,
      plan.id,
      JSON.stringify(review),
    );
    const {
      effectiveStatus: _effectiveStatus,
      effectiveFollowUpDate: _date,
      followUpRevision: _revision,
      latestReview: _latest,
      ...original
    } = plan;
    const updated: CarePlan = {
      ...original,
      status: review.disposition === 'complete' ? 'completed' : 'active',
    };
    db.prepare('UPDATE carePlans SET data=? WHERE id=?').run(JSON.stringify(updated), plan.id);
    audit(
      req,
      review.source === 'clinical-review'
        ? 'reviewed follow-up and shared patient instructions'
        : `care plan ${updated.status}`,
      'carePlan',
      plan.id,
    );
    notifyPatient(db, plan.patientId, `follow-up-review:${review.id}`, {
      kind: 'follow-up',
      title:
        review.source === 'clinical-review'
          ? 'Your clinic reviewed your follow-up'
          : 'Your care plan status changed',
      detail: 'Open your care plan to see the update from your clinic.',
      href: `/my-care?plan=${plan.id}`,
    });
    return updated;
  }
  function recordLegacyStatus(
    req: AuthRequest,
    planId: string,
    status: 'active' | 'completed',
    expectedRevision?: string,
  ) {
    const author = identity(req);
    return transaction(() => {
      const plan = planAccess(req, planId),
        current = state(plan);
      if (expectedRevision) assertCurrent(expectedRevision, current.revision);
      if (current.effectiveStatus === status) return hydratePlan(plan, false, current);
      const followUpDate = current.effectiveFollowUpDate ?? plan.followUpDate;
      const review: FollowUpReview = {
        id: id(),
        carePlanId: plan.id,
        ...author,
        source: 'status-change',
        assessment: '',
        patientInstructions: `Your clinic marked this care plan ${status}. No new clinical instructions were recorded with this status change.`,
        disposition: status === 'completed' ? 'complete' : 'continue',
        nextReviewDate:
          status === 'completed'
            ? null
            : followUpDate < clinicToday()
              ? clinicToday()
              : followUpDate,
        checkInSnapshots: current.currentSnapshots,
        createdAt: nowISO(),
      };
      return hydratePlan(save(plan, review, req));
    });
  }
  function workItem(
    plan: CarePlan,
    current: ReturnType<typeof state>,
    today: string,
  ): FollowUpWorkItem {
    const { assignedOwner } = current;
    return {
      carePlan: hydratePlan(plan, false, current),
      patient: get<Patient>(db, 'patients', plan.patientId)!,
      ownerDoctorId: assignedOwner.doctorId,
      ownerDoctorName: assignedOwner.doctorName,
      revision: current.revision,
      latestReview: current.latestReview,
      unreviewedCheckIns: current.unreviewedCheckIns,
      unreviewedCount: current.unreviewedCheckIns.length,
      due:
        current.effectiveStatus === 'active' &&
        current.effectiveFollowUpDate !== null &&
        current.effectiveFollowUpDate <= today,
    };
  }
  function recordClinicalReview(
    req: AuthRequest,
    plan: CarePlan,
    current: ReturnType<typeof state>,
    doctor: Doctor,
    input: z.infer<typeof legacyReview>,
  ) {
    const review: FollowUpReview = {
      id: id(),
      carePlanId: plan.id,
      doctorId: doctor.id,
      doctorName: doctor.name,
      source: 'clinical-review',
      assessment: input.assessment,
      patientInstructions: input.patientInstructions,
      disposition: input.disposition,
      nextReviewDate: input.disposition === 'complete' ? null : input.nextReviewDate!,
      checkInSnapshots: current.currentSnapshots,
      createdAt: nowISO(),
    };
    return { review, plan: save(plan, review, req) };
  }
  function register(app: Express, escalationStates?: () => Map<string, FollowUpEscalationState>) {
    app.get('/api/follow-up-owners', (req: AuthRequest, res) => {
      actor(req, ['admin', 'doctor']);
      res.json(eligibleOwners());
    });
    app.get('/api/care-plans/:id/assignments', (req: AuthRequest, res) => {
      actor(req, ['admin', 'doctor']);
      const plan = planAccess(req, String(req.params.id));
      audit(req, 'viewed follow-up assignment history', 'carePlan', plan.id);
      res.json(assignments(plan.id));
    });
    app.post('/api/care-plans/:id/assignment', (req: AuthRequest, res) => {
      const user = actor(req, ['admin', 'doctor']);
      const input = z
        .object({
          doctorId: z.string().trim().min(1).max(300),
          reason: z.string().trim().min(1).max(8000),
          expectedRevision: revisionSchema,
        })
        .strict()
        .parse(req.body);
      const result = transaction(() => {
        const plan = planAccess(req, String(req.params.id));
        const previous = owner(plan);
        if (user.role === 'doctor' && user.doctorId !== previous.doctorId)
          fail(
            403,
            'Only the current follow-up owner or an administrator can reassign this care plan.',
          );
        assertCurrent(input.expectedRevision, state(plan).revision);
        const next = eligibleOwners().find((candidate) => candidate.doctorId === input.doctorId);
        if (!next) return fail(400, 'Choose a clinician with an active linked account.');
        if (next.doctorId === previous.doctorId)
          fail(409, 'This clinician already owns this follow-up.');
        const assignment: FollowUpAssignment = {
          id: id(),
          carePlanId: plan.id,
          doctorId: next.doctorId,
          doctorName: next.doctorName,
          previousDoctorId: previous.doctorId,
          previousDoctorName: previous.doctorName,
          reason: input.reason,
          assignedById: user.id,
          assignedByName: user.name,
          createdAt: nowISO(),
        };
        db.prepare('INSERT INTO followUpAssignments(id,carePlanId,data) VALUES (?,?,?)').run(
          assignment.id,
          plan.id,
          JSON.stringify(assignment),
        );
        audit(req, 'assigned follow-up ownership', 'carePlan', plan.id);
        notifyClinicians(
          db,
          plan.patientId,
          `follow-up-assignment:${assignment.id}`,
          {
            kind: 'follow-up',
            title: 'Follow-up care was assigned to you',
            detail: 'Open the care plan to review the handover and current patient reports.',
            href: `/clinic/patients/${plan.patientId}?tab=care&plan=${plan.id}`,
          },
          { doctorId: next.doctorId, excludeActorId: user.id },
        );
        return hydratePlan(plan);
      });
      res.status(201).json(result);
    });
    app.get('/api/follow-up-worklist', (req: AuthRequest, res) => {
      const user = actor(req, ['admin', 'doctor']);
      const query = z.object({ scope: z.enum(['mine', 'all']).optional() }).parse(req.query);
      const scope = query.scope ?? (user.role === 'admin' ? 'all' : 'mine');
      const today = clinicToday();
      const worklist: FollowUpWorkItem[] = transaction(() => {
        const reminders = escalationStates?.();
        return list<CarePlan>(db, 'carePlans')
          .filter((plan) => scope === 'all' || owner(plan).doctorId === user.doctorId)
          .map((plan) => ({
            ...workItem(plan, state(plan), today),
            escalation: reminders?.get(plan.id),
          }));
      });
      worklist.sort(
        (a, b) =>
          Number(b.due) - Number(a.due) ||
          b.unreviewedCount - a.unreviewedCount ||
          (a.carePlan.effectiveFollowUpDate ?? '9999-12-31').localeCompare(
            b.carePlan.effectiveFollowUpDate ?? '9999-12-31',
          ) ||
          a.patient.name.localeCompare(b.patient.name),
      );
      res.json(worklist);
    });
    app.get('/api/care-plans/:id/reviews', (req: AuthRequest, res) => {
      const plan = planAccess(req, String(req.params.id)),
        user = actor(req);
      audit(req, 'viewed follow-up review history', 'carePlan', plan.id);
      const history = reviews(plan.id);
      res.json(user.role === 'patient' ? history.map(patientReview) : history);
    });
    app.get('/api/care-plans/:id/review-context', (req: AuthRequest, res) => {
      const value = transaction((): FollowUpReviewContext => {
        const { doctor } = context.authorizeClinician(req);
        noQuery.parse(req.query);
        const plan = planAccess(req, String(req.params.id)),
          current = state(plan);
        return {
          item: workItem(plan, current, clinicToday()),
          checkInSnapshots: current.currentSnapshots,
          doctorId: doctor.id,
          doctorName: doctor.name,
          followUpEnabled: settings(db).modules.followUp,
          latestAssignmentId: current.assignedOwner.assignment?.id ?? null,
        };
      }, 'BEGIN');
      res.json(value);
    });
    app.post('/api/care-plans/:id/reviews', (req: AuthRequest, res) => {
      const updated = transaction(() => {
        const { doctor } = context.authorizeClinician(req);
        moduleEnabled('followUp');
        const input = legacyReview.parse(req.body);
        if (input.disposition !== 'complete' && input.nextReviewDate! < clinicToday())
          return fail(400, pastDate);
        const plan = planAccess(req, String(req.params.id)),
          current = state(plan);
        assertCurrent(input.expectedRevision, current.revision);
        return hydratePlan(recordClinicalReview(req, plan, current, doctor, input).plan);
      });
      res.status(201).json(updated);
    });
    app.post('/api/care-plans/:id/reviews/record', (req: AuthRequest, res) => {
      const outcome = transaction(() => {
        const { user, doctor } = context.authorizeClinician(req);
        noQuery.parse(req.query);
        const command: FollowUpReviewCommand = reviewCommand.parse(req.body);
        const plan = planAccess(req, String(req.params.id));
        const { requestId, carePlanId, patientId, doctorId, expectedRevision } = command;
        if (plan.id !== carePlanId || plan.patientId !== patientId)
          return fail(409, 'The reviewed care plan and patient must match this record.');
        // Zod fixes field order and trims clinical text before computing command identity.
        const payloadHash = hash(command),
          actorId = user.id;
        const result = (review: FollowUpReview): FollowUpReviewResult => ({
          receipt: {
            requestId,
            actorId,
            carePlanId,
            patientId,
            doctorId,
            expectedRevision,
            review,
          },
        });
        const rejection = (message: string): FollowUpReviewNotRecorded => ({
          code: 'FOLLOW_UP_REVIEW_NOT_RECORDED',
          actorId,
          command,
          message,
        });
        const prior = db
          .prepare(
            'SELECT c.*, r.data AS originalReview FROM followUpReviewCommands c LEFT JOIN followUpReviews r ON r.id=c.reviewId WHERE c.requestId=?',
          )
          .get(requestId);
        if (prior) {
          if (
            prior.actorId !== actorId ||
            prior.carePlanId !== carePlanId ||
            prior.payloadHash !== payloadHash
          )
            return fail(409, 'This request ID was already used for a different follow-up review.');
          if (typeof prior.rejection === 'string')
            return { status: Number(prior.rejectionStatus), body: rejection(prior.rejection) };
          return { status: 200, body: result(JSON.parse(String(prior.originalReview))) };
        }
        const store = db.prepare(
          'INSERT INTO followUpReviewCommands(requestId,actorId,carePlanId,payloadHash,reviewId,rejectionStatus,rejection) VALUES (?,?,?,?,?,?,?)',
        );
        function reject(status: number, message: string) {
          store.run(requestId, actorId, carePlanId, payloadHash, null, status, message);
          return { status, body: rejection(message) };
        }
        if (doctor.id !== doctorId)
          return reject(
            409,
            'The linked clinician changed. Review the draft under the current clinician profile.',
          );
        if (!settings(db).modules.followUp)
          return reject(403, 'This module is currently disabled by the clinic.');
        if (command.nextReviewDate !== null && command.nextReviewDate < clinicToday())
          return reject(400, pastDate);
        const current = state(plan);
        if (current.revision !== expectedRevision) return reject(409, staleRevision);
        const { review } = recordClinicalReview(req, plan, current, doctor, command);
        store.run(requestId, actorId, carePlanId, payloadHash, review.id, null, null);
        return { status: 201, body: result(review) };
      });
      res.status(outcome.status).json(outcome.body);
    });
  }
  return {
    hydratePlan,
    hydratePlans,
    recordLegacyStatus,
    owner,
    register,
    patientReviews: (carePlanId: string) => reviews(carePlanId).map(patientReview),
  };
}
