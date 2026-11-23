import { createHash } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import type {
  CheckInFields,
  CheckInNotSaved,
  CheckInSubmissionCommand,
  CheckInSubmissionResult,
} from '../shared/check-in-submission.ts';
import type { CarePlan, CheckIn, Patient, User } from '../shared/types.ts';
import { notifyClinicians } from './activity.ts';
import type { AuthRequest } from './app.ts';
import { clinicToday, get, id, settings, type DB } from './db.ts';
import { date, required, text } from './validation.ts';

interface Dependencies {
  db: DB;
  transaction: <T>(work: () => T) => T;
  authorize: (req: AuthRequest) => User;
  patientAccess: (req: AuthRequest, patientId: string) => Patient;
  currentOwner: (plan: CarePlan) => string;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
}

const fields = z.object({
  carePlanId: required,
  date,
  adherence: z.enum(['taken', 'partial', 'missed']),
  feeling: z.enum(['better', 'same', 'worse']),
  note: text,
});
const legacySchema = fields.extend({ note: text.default('') });
const commandSchema = fields
  .extend({
    requestId: z
      .string()
      .uuid()
      .transform((s) => s.toLowerCase()),
    patientId: required,
    expectedUpdatedAt: z.string().datetime({ precision: 3 }).nullable(),
    reviewedConfirmed: z.literal(true),
  })
  .strict();
const emptyQuery = z.object({}).strict();
const modulePaused = { status: 403, message: 'This module is currently disabled by the clinic.' };

export function registerCheckInSubmission(
  app: Express,
  { db, transaction, authorize, patientAccess, currentOwner, audit, fail }: Dependencies,
) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS checkInSubmissionCommands (
      requestId TEXT PRIMARY KEY, actorId TEXT NOT NULL REFERENCES users(id),
      patientId TEXT NOT NULL REFERENCES patients(id), carePlanId TEXT NOT NULL REFERENCES carePlans(id),
      payloadHash TEXT NOT NULL, checkInId TEXT REFERENCES checkIns(id), originalCheckIn TEXT,
      rejectionStatus INTEGER, rejection TEXT,
      CHECK ((checkInId IS NOT NULL AND originalCheckIn IS NOT NULL AND rejection IS NULL AND rejectionStatus IS NULL)
          OR (checkInId IS NULL AND originalCheckIn IS NULL AND rejection IS NOT NULL AND rejectionStatus IS NOT NULL AND rejectionStatus IN (400,403,409)))
    );
    CREATE TRIGGER IF NOT EXISTS check_in_submission_immutable_update BEFORE UPDATE ON checkInSubmissionCommands
      BEGIN SELECT RAISE(ABORT,'Check-in submission evidence is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS check_in_submission_immutable_delete BEFORE DELETE ON checkInSubmissionCommands
      BEGIN SELECT RAISE(ABORT,'Check-in submission evidence is immutable'); END;
  `);
  function context(req: AuthRequest, carePlanId: string) {
    const plan = get<CarePlan>(db, 'carePlans', carePlanId);
    if (!plan) return fail(404, 'Care plan not found.');
    return { plan, patient: patientAccess(req, plan.patientId) };
  }
  function eligibility(plan: CarePlan, day: string) {
    if (plan.status !== 'active') return { status: 409, message: 'This care plan is completed.' };
    if (day < plan.startDate || day > plan.endDate || day > clinicToday())
      return {
        status: 400,
        message: 'Check-ins must be within the plan dates and cannot be in the future.',
      };
  }
  function latest(carePlanId: string, day: string): CheckIn | null {
    const row = db
      .prepare('SELECT data FROM checkIns WHERE carePlanId=? AND date=?')
      .get(carePlanId, day);
    return row ? JSON.parse(String(row.data)) : null;
  }
  function record(
    req: AuthRequest,
    plan: CarePlan,
    patient: Patient,
    input: CheckInFields,
    existing: CheckIn | null,
  ) {
    // createdAt identifies the report version in clinical review history, even during a clock rollback.
    const timestamp = existing
      ? Math.max(Date.now(), Date.parse(existing.createdAt) + 1)
      : Date.now();
    const check: CheckIn = {
      ...input,
      id: existing?.id ?? id(),
      patientId: patient.id,
      createdAt: new Date(timestamp).toISOString(),
    };
    const data = JSON.stringify(check);
    // Two legacy processes could both allocate an ID before their upserts. The visible report
    // then retained the second ID while the row kept the first. Preserve both identities.
    const row = db
      .prepare(
        'INSERT INTO checkIns(id,patientId,carePlanId,date,data) VALUES (?,?,?,?,?) ON CONFLICT(carePlanId,date) DO UPDATE SET data=excluded.data RETURNING id',
      )
      .get(check.id, patient.id, plan.id, check.date, data)!;
    audit(
      req,
      existing ? 'updated daily check-in' : 'recorded daily check-in',
      'checkIn',
      check.id,
    );
    notifyClinicians(
      db,
      patient.id,
      `check-in:${check.id}:${createHash('sha256').update(data).digest('hex')}`,
      {
        kind: 'check-in',
        title: existing ? 'A patient updated their check-in' : 'A patient shared a check-in',
        detail: `${patient.name} · ${plan.title}`,
        href: `/clinic/patients/${patient.id}?tab=care&plan=${plan.id}`,
      },
      { doctorId: currentOwner(plan), excludeActorId: req.user!.id },
    );
    return { checkIn: check, rowId: String(row.id) };
  }
  app.post('/api/check-ins', (req: AuthRequest, res) => {
    const outcome = transaction(() => {
      authorize(req);
      if (!settings(db).modules.followUp) return fail(modulePaused.status, modulePaused.message);
      const input = legacySchema.parse(req.body);
      const { plan, patient } = context(req, input.carePlanId);
      const denied = eligibility(plan, input.date);
      if (denied) return fail(denied.status, denied.message);
      const existing = latest(plan.id, input.date);
      return {
        status: existing ? 200 : 201,
        body: record(req, plan, patient, input, existing).checkIn,
      };
    });
    res.status(outcome.status).json(outcome.body);
  });

  app.post('/api/check-ins/submit', (req: AuthRequest, res) => {
    const outcome = transaction(() => {
      const { id: actorId, patientId: linkedPatient } = authorize(req);
      emptyQuery.parse(req.query);
      const command: CheckInSubmissionCommand = commandSchema.parse(req.body);
      const { requestId, patientId, expectedUpdatedAt, reviewedConfirmed, ...input } = command;
      if (patientId !== linkedPatient)
        return fail(403, 'You can only access your own care record.');
      const { plan, patient } = context(req, input.carePlanId);
      // Zod supplies a stable field order, regardless of the order received over the wire.
      const payloadHash = createHash('sha256')
        .update(JSON.stringify({ ...input, expectedUpdatedAt, reviewedConfirmed }))
        .digest('hex');
      const success = (checkIn: CheckIn): CheckInSubmissionResult => ({
        receipt: {
          requestId,
          actorId,
          patientId,
          carePlanId: plan.id,
          date: input.date,
          expectedUpdatedAt,
          operation: expectedUpdatedAt === null ? 'created' : 'corrected',
          checkIn,
        },
      });
      const rejected = (message: string): CheckInNotSaved => ({
        code: 'CHECK_IN_NOT_SAVED',
        actorId,
        command,
        message,
      });
      const stored = db
        .prepare('SELECT * FROM checkInSubmissionCommands WHERE requestId=?')
        .get(requestId);
      if (stored) {
        if (
          stored.actorId !== actorId ||
          stored.patientId !== patientId ||
          stored.carePlanId !== plan.id ||
          stored.payloadHash !== payloadHash
        )
          return fail(409, 'This request ID was already used for a different check-in submission.');
        if (typeof stored.rejection === 'string')
          return { status: Number(stored.rejectionStatus), body: rejected(stored.rejection) };
        return { status: 200, body: success(JSON.parse(String(stored.originalCheckIn))) };
      }
      const save = db.prepare(
        'INSERT INTO checkInSubmissionCommands(requestId,actorId,patientId,carePlanId,payloadHash,checkInId,originalCheckIn,rejectionStatus,rejection) VALUES (?,?,?,?,?,?,?,?,?)',
      );
      const existing = latest(plan.id, input.date);
      const denied =
        (settings(db).modules.followUp ? eligibility(plan, input.date) : modulePaused) ??
        ((existing?.createdAt ?? null) !== expectedUpdatedAt
          ? {
              status: 409,
              message:
                'The check-in for this date changed. Review the current report before saving.',
            }
          : undefined);
      if (denied) {
        save.run(
          requestId,
          actorId,
          patientId,
          plan.id,
          payloadHash,
          null,
          null,
          denied.status,
          denied.message,
        );
        return { status: denied.status, body: rejected(denied.message) };
      }
      const { checkIn, rowId } = record(req, plan, patient, input, existing);
      save.run(
        requestId,
        actorId,
        patientId,
        plan.id,
        payloadHash,
        rowId,
        JSON.stringify(checkIn),
        null,
        null,
      );
      return { status: 201, body: success(checkIn) };
    });
    res.status(outcome.status).json(outcome.body);
  });
}
