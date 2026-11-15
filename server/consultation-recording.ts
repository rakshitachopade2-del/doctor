import { createHash } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import type { AuthRequest } from './app.ts';
import { get, id, insert, nowISO, type DB } from './db.ts';
import { mfaSessionAllowed } from './mfa.ts';
import type { Appointment, Doctor, Encounter, Patient, User } from '../shared/types.ts';
import type { EncounterAmendment } from '../shared/clinical.ts';
import type {
  ConsultationNotRecorded,
  ConsultationRecordingReceipt,
  ConsultationRecordingResult,
} from '../shared/consultation-recording.ts';

interface Dependencies {
  db: DB;
  actor: (req: AuthRequest, roles?: User['role'][]) => User;
  patientAccess: (req: AuthRequest, patientId: string, allowReception?: boolean) => Patient;
  clinicianId: (req: AuthRequest) => string;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
  businessFailure: (error: unknown) => { status: number; message: string } | null;
}
const required = z.string().trim().min(1).max(300);
const text = z.string().trim().max(8000);
const noteFields = z.object({
  patientId: required,
  appointmentId: required.optional(),
  history: text.default(''),
  examination: text.default(''),
  assessment: text.min(1),
  investigations: text.default(''),
  plan: text.min(1),
});
const amendmentFields = z.object({ reason: text.min(1), text: text.min(1) });
const review = {
  reviewedConfirmed: z.literal(true),
  requestId: z
    .string()
    .uuid()
    .transform((value) => value.toLowerCase()),
};
const noteCommand = noteFields.extend(review).strict();
const amendmentCommand = amendmentFields.extend(review).strict();
const empty = z.object({}).strict();
type NoteFields = z.infer<typeof noteFields>;
type AmendmentFields = z.infer<typeof amendmentFields>;
type Identity = { user: User; doctor: Doctor };
type Operation = 'create' | 'amend';
type Rejection = { status: number; body: ConsultationNotRecorded };
export const CONSULTATION_REQUEST_COLLISION =
  'This request ID was already used for a different consultation recording.';

export function registerConsultationRecording(app: Express, dependencies: Dependencies) {
  const { db, actor, patientAccess, clinicianId, audit, fail, businessFailure } = dependencies;
  db.exec(`
    CREATE TABLE IF NOT EXISTS consultationRecordingCommands (
      requestId TEXT PRIMARY KEY, actorId TEXT NOT NULL REFERENCES users(id),
      operation TEXT NOT NULL CHECK(operation IN ('create','amend')),
      patientId TEXT NOT NULL REFERENCES patients(id), sourceEncounterId TEXT REFERENCES encounters(id),
      payloadHash TEXT NOT NULL, receipt TEXT, rejection TEXT,
      CHECK ((operation='create' AND sourceEncounterId IS NULL) OR (operation='amend' AND sourceEncounterId IS NOT NULL)),
      CHECK ((receipt IS NOT NULL AND rejection IS NULL) OR (receipt IS NULL AND rejection IS NOT NULL))
    );
    CREATE TRIGGER IF NOT EXISTS consultation_recording_command_update BEFORE UPDATE ON consultationRecordingCommands
      BEGIN SELECT RAISE(ABORT,'Consultation recording receipts are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS consultation_recording_command_delete BEFORE DELETE ON consultationRecordingCommands
      BEGIN SELECT RAISE(ABORT,'Consultation recording receipts are immutable'); END;
  `);
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
  function authorize(req: AuthRequest): Identity {
    const cached = actor(req, ['admin', 'doctor']),
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
      !req.csrfToken ||
      session.csrfToken !== req.csrfToken ||
      req.headers['x-csrf-token'] !== session.csrfToken ||
      !mfaSessionAllowed(db, user.id, session.mfaCredentialId)
    )
      return fail(401, 'Your session changed. Sign in again.');
    if (user.mustChangePassword || !['admin', 'doctor'].includes(user.role))
      return fail(403, 'Only an active clinician can document clinical care.');
    req.user = user;
    const doctor = user.doctorId ? get<Doctor>(db, 'doctors', user.doctorId) : undefined;
    if (!doctor)
      return fail(400, 'Sign in with a linked doctor account to document clinical care.');
    return { user, doctor };
  }
  function encounterAccess(req: AuthRequest, encounterId: string) {
    const encounter = get<Encounter>(db, 'encounters', encounterId);
    if (!encounter) return fail(404, 'Consultation record not found.');
    patientAccess(req, encounter.patientId);
    return encounter;
  }
  function recordNote(req: AuthRequest, identity: Identity, input: NoteFields): Encounter {
    if (input.appointmentId) {
      const appointment = get<Appointment>(db, 'appointments', input.appointmentId);
      if (!appointment || appointment.patientId !== input.patientId)
        fail(400, 'The appointment must belong to this patient.');
    }
    const encounter: Encounter = {
      ...input,
      id: id(),
      doctorId: identity.doctor.id,
      doctorName: identity.doctor.name,
      createdAt: nowISO(),
    };
    insert(db, 'encounters', encounter);
    audit(req, 'recorded consultation', 'encounter', encounter.id);
    return encounter;
  }
  function recordAmendment(
    req: AuthRequest,
    identity: Identity,
    encounter: Encounter,
    input: AmendmentFields,
  ): EncounterAmendment {
    const amendment: EncounterAmendment = {
      ...input,
      id: id(),
      encounterId: encounter.id,
      patientId: encounter.patientId,
      doctorId: identity.doctor.id,
      doctorName: identity.doctor.name,
      createdAt: nowISO(),
    };
    db.prepare(
      'INSERT INTO encounterAmendments(id,patientId,encounterId,data) VALUES (?,?,?,?)',
    ).run(amendment.id, amendment.patientId, encounter.id, JSON.stringify(amendment));
    audit(req, 'added consultation amendment', 'encounter', encounter.id);
    return amendment;
  }
  function result(receipt: ConsultationRecordingReceipt): ConsultationRecordingResult {
    const encounter = get<Encounter>(db, 'encounters', receipt.encounterId);
    const amendment = receipt.amendmentId
      ? get<EncounterAmendment>(db, 'encounterAmendments', receipt.amendmentId)
      : null;
    if (!encounter || (receipt.amendmentId && !amendment))
      return fail(500, 'The original consultation recording is unavailable.');
    return { encounter, amendment: amendment ?? null, receipt };
  }
  function execute(
    req: AuthRequest,
    operation: Operation,
    fields: NoteFields | AmendmentFields,
    requestId: string,
    sourceEncounterId: string | null,
  ) {
    return transaction(() => {
      const identity = authorize(req);
      // Scope authorization precedes receipt lookup; missing private sources cannot establish a safe marker.
      const source = operation === 'amend' ? encounterAccess(req, sourceEncounterId!) : null;
      const patientId = source?.patientId ?? (fields as NoteFields).patientId;
      if (!source) patientAccess(req, patientId);
      const payloadHash = createHash('sha256')
        .update(
          JSON.stringify({
            operation,
            patientId,
            sourceEncounterId,
            fields,
            reviewedConfirmed: true,
          }),
        )
        .digest('hex');
      const previous = db
        .prepare(
          'SELECT actorId,operation,patientId,sourceEncounterId,payloadHash,receipt,rejection FROM consultationRecordingCommands WHERE requestId=?',
        )
        .get(requestId);
      if (previous) {
        if (
          previous.actorId !== identity.user.id ||
          previous.operation !== operation ||
          previous.patientId !== patientId ||
          previous.sourceEncounterId !== sourceEncounterId ||
          previous.payloadHash !== payloadHash
        )
          return fail(409, CONSULTATION_REQUEST_COLLISION);
        if (previous.rejection) {
          const rejection = JSON.parse(String(previous.rejection)) as Rejection;
          return { status: rejection.status, body: rejection.body };
        }
        if (!previous.receipt)
          return fail(500, 'The original consultation receipt is unavailable.');
        return {
          status: 200,
          body: result(JSON.parse(String(previous.receipt)) as ConsultationRecordingReceipt),
        };
      }
      db.exec('SAVEPOINT consultation_recording');
      try {
        const encounter = source ?? recordNote(req, identity, fields as NoteFields);
        const amendment = source
          ? recordAmendment(req, identity, source, fields as AmendmentFields)
          : null;
        const receipt: ConsultationRecordingReceipt = {
          requestId,
          actorId: identity.user.id,
          operation,
          patientId,
          encounterId: encounter.id,
          amendmentId: amendment?.id ?? null,
          doctorId: identity.doctor.id,
        };
        db.prepare(
          'INSERT INTO consultationRecordingCommands(requestId,actorId,operation,patientId,sourceEncounterId,payloadHash,receipt) VALUES (?,?,?,?,?,?,?)',
        ).run(
          requestId,
          identity.user.id,
          operation,
          patientId,
          sourceEncounterId,
          payloadHash,
          JSON.stringify(receipt),
        );
        db.exec('RELEASE consultation_recording');
        return {
          status: 201,
          body: { encounter, amendment, receipt } as ConsultationRecordingResult,
        };
      } catch (error) {
        const failure = businessFailure(error);
        if (!failure || ![400, 404, 409].includes(failure.status)) throw error;
        db.exec('ROLLBACK TO consultation_recording');
        db.exec('RELEASE consultation_recording');
        const rejection: Rejection = {
          status: failure.status,
          body: {
            error: failure.message,
            consultationOutcome: 'not-recorded',
            requestId,
            actorId: identity.user.id,
            operation,
            patientId,
            encounterId: sourceEncounterId,
          },
        };
        db.prepare(
          'INSERT INTO consultationRecordingCommands(requestId,actorId,operation,patientId,sourceEncounterId,payloadHash,rejection) VALUES (?,?,?,?,?,?,?)',
        ).run(
          requestId,
          identity.user.id,
          operation,
          patientId,
          sourceEncounterId,
          payloadHash,
          JSON.stringify(rejection),
        );
        return { status: rejection.status, body: rejection.body };
      }
    });
  }
  app.post('/api/consultation-notes', (req: AuthRequest, res) => {
    actor(req, ['admin', 'doctor']);
    empty.parse(req.query);
    const { requestId, reviewedConfirmed: _, ...fields } = noteCommand.parse(req.body);
    const response = execute(req, 'create', fields, requestId, null);
    res.status(response.status).json(response.body);
  });
  app.post('/api/encounters/:id/amendment-recordings', (req: AuthRequest, res) => {
    actor(req, ['admin', 'doctor']);
    empty.parse(req.query);
    const source = required.parse(req.params.id);
    const { requestId, reviewedConfirmed: _, ...fields } = amendmentCommand.parse(req.body);
    const response = execute(req, 'amend', fields, requestId, source);
    res.status(response.status).json(response.body);
  });
  // Compatible plain responses and existing input stripping; no implicit retry identity.
  app.post('/api/encounters', (req: AuthRequest, res) => {
    clinicianId(req);
    const input = noteFields.parse(req.body);
    const encounter = transaction(() => {
      const identity = authorize(req);
      patientAccess(req, input.patientId);
      return recordNote(req, identity, input);
    });
    res.status(201).json(encounter);
  });
  app.post('/api/encounters/:id/amendments', (req: AuthRequest, res) => {
    clinicianId(req);
    const encounterId = String(req.params.id);
    // Preserve original validation ordering without relying on this preliminary read at commit.
    encounterAccess(req, encounterId);
    const input = amendmentFields.parse(req.body);
    const amendment = transaction(() => {
      const identity = authorize(req),
        encounter = encounterAccess(req, encounterId);
      return recordAmendment(req, identity, encounter, input);
    });
    res.status(201).json(amendment);
  });
}
