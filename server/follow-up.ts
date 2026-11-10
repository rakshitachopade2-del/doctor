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
} from '../shared/follow-up.ts';
import { clinicToday, get, id, list, nowISO, type DB } from './db.ts';
import { notifyPatient } from './activity.ts';

interface FollowUpContext {
  db: DB;
  actor: (req: AuthRequest, roles?: User['role'][]) => User;
  patientAccess: (req: AuthRequest, patientId: string, allowReception?: boolean) => Patient;
  clinicianId: (req: AuthRequest) => string;
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

export function createFollowUp(context: FollowUpContext) {
  const { db, actor, patientAccess, clinicianId, moduleEnabled, audit, fail } = context;
  db.exec(`CREATE TABLE IF NOT EXISTS followUpReviews (
    id TEXT PRIMARY KEY, carePlanId TEXT NOT NULL REFERENCES carePlans(id), data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS follow_up_reviews_plan ON followUpReviews(carePlanId);
  CREATE TRIGGER IF NOT EXISTS prevent_follow_up_review_update BEFORE UPDATE ON followUpReviews
    BEGIN SELECT RAISE(ABORT,'Follow-up review history is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS prevent_follow_up_review_delete BEFORE DELETE ON followUpReviews
    BEGIN SELECT RAISE(ABORT,'Follow-up review history is append-only'); END;`);
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
  function reviews(carePlanId: string): FollowUpReview[] {
    return db
      .prepare('SELECT data FROM followUpReviews WHERE carePlanId=? ORDER BY rowid DESC')
      .all(carePlanId)
      .map((row) => JSON.parse(row.data as string) as FollowUpReview);
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
    const revision = hash({
      id: plan.id,
      patientId: plan.patientId,
      doctorId: plan.doctorId,
      status: plan.status,
      startDate: plan.startDate,
      endDate: plan.endDate,
      followUpDate: plan.followUpDate,
      latestReviewId: latestReview?.id ?? null,
      checkIns: currentSnapshots.map((version) => ({
        id: version.id,
        contentHash: version.contentHash,
      })),
    });
    return {
      history,
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
    if (expected !== current)
      fail(
        409,
        'This care plan has changed, including new or edited check-ins. Refresh and review the latest information before saving.',
      );
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
  function register(app: Express) {
    app.get('/api/follow-up-worklist', (req: AuthRequest, res) => {
      const user = actor(req, ['admin', 'doctor']);
      const query = z.object({ scope: z.enum(['mine', 'all']).optional() }).parse(req.query);
      const scope = query.scope ?? (user.role === 'admin' ? 'all' : 'mine');
      const today = clinicToday();
      const worklist: FollowUpWorkItem[] = list<CarePlan>(db, 'carePlans')
        .filter((plan) => scope === 'all' || plan.doctorId === user.doctorId)
        .map((plan) => {
          const current = state(plan),
            patient = get<Patient>(db, 'patients', plan.patientId)!;
          return {
            carePlan: hydratePlan(plan, false, current),
            patient,
            ownerDoctorId: plan.doctorId,
            ownerDoctorName:
              get<Doctor>(db, 'doctors', plan.doctorId)?.name ?? plan.doctorName ?? 'Clinic doctor',
            revision: current.revision,
            latestReview: current.latestReview,
            unreviewedCheckIns: current.unreviewedCheckIns,
            unreviewedCount: current.unreviewedCheckIns.length,
            due:
              current.effectiveStatus === 'active' &&
              current.effectiveFollowUpDate !== null &&
              current.effectiveFollowUpDate <= today,
          };
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
    app.post('/api/care-plans/:id/reviews', (req: AuthRequest, res) => {
      const author = identity(req);
      moduleEnabled('followUp');
      const input = z
        .object({
          expectedRevision: revisionSchema,
          assessment: z.string().trim().min(1).max(8000),
          patientInstructions: z.string().trim().min(1).max(8000),
          disposition: z.enum(['continue', 'visit-requested', 'complete']),
          nextReviewDate: date.nullable().optional(),
        })
        .strict()
        .superRefine((value, ctx) => {
          if (value.disposition !== 'complete' && !value.nextReviewDate)
            ctx.addIssue({
              code: 'custom',
              message: 'Choose the next review date while follow-up remains active.',
              path: ['nextReviewDate'],
            });
          if (
            value.disposition !== 'complete' &&
            value.nextReviewDate &&
            value.nextReviewDate < clinicToday()
          )
            ctx.addIssue({
              code: 'custom',
              message: 'Choose today or a future review date.',
              path: ['nextReviewDate'],
            });
        })
        .parse(req.body);
      const planId = String(req.params.id);
      const updated = transaction(() => {
        const plan = planAccess(req, planId),
          current = state(plan);
        assertCurrent(input.expectedRevision, current.revision);
        const review: FollowUpReview = {
          id: id(),
          carePlanId: plan.id,
          ...author,
          source: 'clinical-review',
          assessment: input.assessment,
          patientInstructions: input.patientInstructions,
          disposition: input.disposition,
          nextReviewDate: input.disposition === 'complete' ? null : input.nextReviewDate!,
          checkInSnapshots: current.currentSnapshots,
          createdAt: nowISO(),
        };
        return hydratePlan(save(plan, review, req));
      });
      res.status(201).json(updated);
    });
  }
  return { hydratePlan, hydratePlans, recordLegacyStatus, register };
}
