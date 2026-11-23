import { createHash } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import type { Doctor, Patient, User } from '../shared/types.ts';
import type {
  CarePlanFields,
  CreatedCarePlan,
  CarePlanCreationCommand,
  CarePlanCreationResult,
  CarePlanNotCreated,
} from '../shared/care-plan-creation.ts';
import type { AuthRequest } from './app.ts';
import { notifyPatient } from './activity.ts';
import { id, insert, nowISO, type DB } from './db.ts';
import { date, required, short, text } from './validation.ts';

interface Dependencies {
  db: DB;
  transaction: <T>(work: () => T) => T;
  authorize: (req: AuthRequest) => { user: User; doctor: Doctor };
  patientAccess: (req: AuthRequest, patientId: string) => Patient;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
}

const medication = z.object({
  name: required,
  instructions: text.min(1),
  schedule: required,
  duration: required,
  warnings: text,
});
const fields = z.object({
  patientId: required,
  title: required,
  instructions: text.min(1),
  expectations: text,
  warnings: text,
  cost: short,
  startDate: date,
  endDate: date,
  followUpDate: date,
  medications: z.array(medication.strict()).max(30),
});
const checkEnd = (v: CarePlanFields) => v.endDate >= v.startDate;
const checkFollowUp = (v: CarePlanFields) => v.followUpDate >= v.startDate;
const endError = 'End date must not precede start date';
const followUpError = 'Follow-up must not precede start date';

const reviewedSchema = fields
  .extend({
    requestId: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
    doctorId: required,
    reviewedConfirmed: z.literal(true),
  })
  .strict()
  .refine(checkEnd, endError)
  .refine(checkFollowUp, followUpError);
const legacySchema = fields
  .extend({
    expectations: text.default(''),
    warnings: text.default(''),
    cost: short.default(''),
    medications: z.array(medication.extend({ warnings: text.default('') })).max(30),
  })
  .refine(checkEnd, endError)
  .refine(checkFollowUp, followUpError);
const emptyQuery = z.object({}).strict();

export function registerCarePlanCreation(
  app: Express,
  { db, transaction, authorize, patientAccess, audit, fail }: Dependencies,
) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS carePlanCreationCommands (
      requestId TEXT PRIMARY KEY, actorId TEXT NOT NULL REFERENCES users(id),
      patientId TEXT NOT NULL REFERENCES patients(id), doctorId TEXT NOT NULL,
      payloadHash TEXT NOT NULL, planId TEXT UNIQUE REFERENCES carePlans(id),
      originalPlan TEXT, rejection TEXT,
      CHECK ((planId IS NOT NULL AND originalPlan IS NOT NULL AND rejection IS NULL)
        OR (planId IS NULL AND originalPlan IS NULL AND rejection IS NOT NULL))
    );
    CREATE TRIGGER IF NOT EXISTS care_plan_creation_immutable_update BEFORE UPDATE ON carePlanCreationCommands
      BEGIN SELECT RAISE(ABORT,'Care plan creation evidence is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS care_plan_creation_immutable_delete BEFORE DELETE ON carePlanCreationCommands
      BEGIN SELECT RAISE(ABORT,'Care plan creation evidence is immutable'); END;
  `);

  function record(
    req: AuthRequest,
    patient: Patient,
    doctor: Doctor,
    input: CarePlanFields,
  ): CreatedCarePlan {
    const plan: CreatedCarePlan = {
      ...input,
      patientId: patient.id,
      id: id(),
      doctorId: doctor.id,
      doctorName: doctor.name,
      patientName: patient.name,
      status: 'active',
      createdAt: nowISO(),
    };
    insert(db, 'carePlans', plan);
    audit(req, 'created care plan', 'carePlan', plan.id);
    notifyPatient(db, plan.patientId, `care-plan-created:${plan.id}`, {
      kind: 'care-plan',
      title: 'Your care plan is ready',
      detail: plan.title,
      href: `/my-care?plan=${encodeURIComponent(plan.id)}`,
    });
    return plan;
  }
  app.post('/api/care-plans', (req: AuthRequest, res) => {
    const value = transaction(() => {
      const { doctor } = authorize(req);
      const { patientId, ...input } = legacySchema.parse(req.body);
      return record(req, patientAccess(req, patientId), doctor, input);
    });
    res.status(201).json(value);
  });
  app.post('/api/care-plans/create', (req: AuthRequest, res) => {
    const outcome = transaction(() => {
      const { user, doctor } = authorize(req);
      emptyQuery.parse(req.query);
      const command: CarePlanCreationCommand = reviewedSchema.parse(req.body);
      const { requestId, patientId, doctorId, reviewedConfirmed, ...input } = command;
      const patient = patientAccess(req, patientId);
      // Parser field order makes equivalent JSON objects hash alike. Array order is meaningful.
      const payloadHash = createHash('sha256')
        .update(JSON.stringify({ reviewedConfirmed, ...input }))
        .digest('hex');
      const actorId = user.id;
      const success = (plan: CreatedCarePlan): CarePlanCreationResult => ({
        receipt: { requestId, actorId, patientId, doctorId, plan },
      });
      const rejected = (message: string): CarePlanNotCreated => ({
        code: 'CARE_PLAN_NOT_CREATED',
        actorId,
        command,
        message,
      });
      const stored = db
        .prepare('SELECT * FROM carePlanCreationCommands WHERE requestId=?')
        .get(requestId);
      if (stored) {
        if (
          stored.actorId !== actorId ||
          stored.patientId !== patientId ||
          stored.doctorId !== doctorId ||
          stored.payloadHash !== payloadHash
        )
          return fail(409, 'This request ID was already used for a different care plan creation.');
        if (typeof stored.rejection === 'string')
          return { status: 409, body: rejected(stored.rejection) };
        return { status: 200, body: success(JSON.parse(String(stored.originalPlan))) };
      }
      const store = db.prepare(
        'INSERT INTO carePlanCreationCommands(requestId,actorId,patientId,doctorId,payloadHash,planId,originalPlan,rejection) VALUES (?,?,?,?,?,?,?,?)',
      );
      if (doctor.id !== doctorId) {
        const message =
          'The linked clinician changed. Review the care plan under the current clinician profile.';
        store.run(requestId, actorId, patientId, doctorId, payloadHash, null, null, message);
        return { status: 409, body: rejected(message) };
      }
      const plan = record(req, patient, doctor, input);
      store.run(
        requestId,
        actorId,
        patientId,
        doctorId,
        payloadHash,
        plan.id,
        JSON.stringify(plan),
        null,
      );
      return { status: 201, body: success(plan) };
    });
    res.status(outcome.status).json(outcome.body);
  });
}
