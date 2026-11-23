import { createHash } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import type {
  IntakeAnswers,
  IntakeNotSubmitted,
  IntakeSubmissionResult,
} from '../shared/intake-submission.ts';
import type { Intake, User } from '../shared/types.ts';
import type { AuthRequest } from './app.ts';
import { get, id, insert, nowISO, settings, type DB } from './db.ts';

interface Dependencies {
  db: DB;
  transaction: <T>(work: () => T) => T;
  authorizePatientRecord: (
    req: AuthRequest,
    patientId?: string,
  ) => { user: User; patientId: string };
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
}

const required = z.string().trim().min(1).max(300);
const text = z.string().trim().max(8000);
const answersSchema = z.object({
  concern: required,
  location: required,
  duration: required,
  symptoms: text,
  triggers: text,
  previousTreatment: text,
  medications: text,
  allergies: text,
  goals: text,
  consent: z.literal(true),
});
const commandSchema = answersSchema
  .extend({
    requestId: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
    patientId: required,
  })
  .strict();
const legacySchema = answersSchema.extend({
  patientId: required.optional(),
  symptoms: text.default(''),
  triggers: text.default(''),
  previousTreatment: text.default(''),
  medications: text.default(''),
  allergies: text.default(''),
  goals: text.default(''),
});
const emptyQuery = z.object({}).strict();
const paused = 'This module is currently disabled by the clinic.';

export function registerIntakeSubmission(
  app: Express,
  { db, transaction, authorizePatientRecord, audit, fail }: Dependencies,
) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS intakeSubmissionCommands (
      requestId TEXT PRIMARY KEY, actorId TEXT NOT NULL REFERENCES users(id),
      patientId TEXT NOT NULL REFERENCES patients(id), answersHash TEXT NOT NULL,
      intakeId TEXT UNIQUE REFERENCES intakes(id), rejection TEXT,
      CHECK ((intakeId IS NULL) <> (rejection IS NULL))
    );
  `);
  for (const table of ['intakes', 'intakeSubmissionCommands'])
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS ${table}_immutable_update BEFORE UPDATE ON ${table}
        BEGIN SELECT RAISE(ABORT,'Intake submissions are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS ${table}_immutable_delete BEFORE DELETE ON ${table}
        BEGIN SELECT RAISE(ABORT,'Intake submissions are immutable'); END;
    `);

  function record(req: AuthRequest, patientId: string, answers: IntakeAnswers): Intake {
    const intake = { ...answers, patientId, id: id(), createdAt: nowISO() };
    insert(db, 'intakes', intake);
    audit(req, 'submitted intake', 'intake', intake.id);
    return intake;
  }

  app.post('/api/intakes/submit', (req: AuthRequest, res) => {
    emptyQuery.parse(req.query);
    // Zod emits the schema's field order, so equivalent input key orders hash identically.
    const { requestId, patientId, ...answers } = commandSchema.parse(req.body);
    const answersHash = createHash('sha256').update(JSON.stringify(answers)).digest('hex');
    const outcome = transaction(() => {
      const { user } = authorizePatientRecord(req, patientId);
      const identity = { requestId, actorId: user.id, patientId };
      const success = (intake: Intake): IntakeSubmissionResult => ({
        receipt: { ...identity, intake },
      });
      const rejected = (message: string): IntakeNotSubmitted => ({
        code: 'INTAKE_NOT_SUBMITTED',
        ...identity,
        answers,
        message,
      });
      const stored = db
        .prepare('SELECT * FROM intakeSubmissionCommands WHERE requestId=?')
        .get(requestId);
      if (stored) {
        if (
          stored.actorId !== user.id ||
          stored.patientId !== patientId ||
          stored.answersHash !== answersHash
        )
          return fail(409, 'This request ID was already used for a different intake submission.');
        if (typeof stored.rejection === 'string')
          return { status: 403, body: rejected(stored.rejection) };
        const intake = get<Intake>(db, 'intakes', String(stored.intakeId));
        if (!intake) throw new Error('Missing original intake.');
        return { status: 200, body: success(intake) };
      }
      const save = db.prepare(
        'INSERT INTO intakeSubmissionCommands(requestId,actorId,patientId,answersHash,intakeId,rejection) VALUES (?,?,?,?,?,?)',
      );
      if (!settings(db).modules.intake) {
        save.run(requestId, user.id, patientId, answersHash, null, paused);
        return { status: 403, body: rejected(paused) };
      }
      const intake = record(req, patientId, answers);
      save.run(requestId, user.id, patientId, answersHash, intake.id, null);
      return { status: 201, body: success(intake) };
    });
    res.status(outcome.status).json(outcome.body);
  });

  app.post('/api/intakes', (req: AuthRequest, res) => {
    const intake = transaction(() => {
      if (!settings(db).modules.intake) return fail(403, paused);
      const { patientId: requestedPatient, ...answers } = legacySchema.parse(req.body);
      const { patientId } = authorizePatientRecord(req, requestedPatient);
      return record(req, patientId, answers);
    });
    res.status(201).json(intake);
  });
}
