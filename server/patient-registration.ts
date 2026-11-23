import { createHash } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import {
  staffPatientRegistrationFields,
  type PatientRegistrationFields,
  type PatientRegistrationResponse,
} from '../shared/patient-registration.ts';
import type { Patient, User } from '../shared/types.ts';
import type { AuthRequest } from './app.ts';
import { clinicToday, id, insert, nowISO, type DB } from './db.ts';
import { patientWithAllergyStatus, receptionPatient } from './patient-profile.ts';

interface Dependencies {
  db: DB;
  currentSessionUser: (req: AuthRequest) => User;
  transaction: <T>(operation: () => T) => T;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
}

const fields = staffPatientRegistrationFields(clinicToday);
const legacy = fields.extend({
  email: fields.shape.email.default(''),
  dob: fields.shape.dob.default(''),
  gender: fields.shape.gender.default('Prefer not to say'),
  allergies: fields.shape.allergies.default(''),
});
const reviewed = fields
  .extend({
    requestId: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
    registeredByRole: z.enum(['admin', 'doctor', 'receptionist']),
    reviewedConfirmed: z.literal(true),
  })
  .strict();
const noQuery = z.object({}).strict();

export function registerPatientRegistration(
  app: Express,
  { db, currentSessionUser, transaction, audit, fail }: Dependencies,
) {
  db.exec(`CREATE TABLE IF NOT EXISTS patientRegistrationCommands (
    requestId TEXT PRIMARY KEY, actorId TEXT NOT NULL REFERENCES users(id),
    patientId TEXT NOT NULL UNIQUE REFERENCES patients(id), commandHash TEXT NOT NULL,
    originalPatient TEXT NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS patientRegistrationCommands_no_update BEFORE UPDATE ON patientRegistrationCommands
    BEGIN SELECT RAISE(ABORT,'Patient registration evidence is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS patientRegistrationCommands_no_delete BEFORE DELETE ON patientRegistrationCommands
    BEGIN SELECT RAISE(ABORT,'Patient registration evidence is immutable'); END;`);

  function staff(req: AuthRequest) {
    const user = currentSessionUser(req);
    if (user.mustChangePassword || !['admin', 'doctor', 'receptionist'].includes(user.role))
      return fail(403, 'A current staff account is required to register a clinic patient.');
    return user;
  }
  function checkAllergies(user: User, allergies: string) {
    if (user.role === 'receptionist' && allergies)
      fail(403, 'Clinical information must be recorded by a clinician.');
  }
  function createPatient(req: AuthRequest, user: User, input: PatientRegistrationFields) {
    const patient: Patient = { ...input, id: id(), createdAt: nowISO() };
    insert(db, 'patients', patient);
    audit(req, 'created patient', 'patient', patient.id);
    return user.role === 'receptionist'
      ? receptionPatient(patient)
      : patientWithAllergyStatus(patient);
  }

  app.post('/api/patients', (req: AuthRequest, res) => {
    const patient = transaction(() => {
      const user = staff(req);
      const input = legacy.parse(req.body);
      checkAllergies(user, input.allergies);
      return createPatient(req, user, input);
    });
    res.status(201).json(patient);
  });

  app.post('/api/patients/register', (req: AuthRequest, res) => {
    const result = transaction(() => {
      const user = staff(req);
      noQuery.parse(req.query);
      const command = reviewed.parse(req.body);
      const {
        requestId,
        registeredByRole,
        reviewedConfirmed: _reviewedConfirmed,
        ...input
      } = command;
      if (registeredByRole !== user.role)
        return fail(403, 'The reviewed registration role must match the current staff account.');
      checkAllergies(user, input.allergies);
      const commandHash = createHash('sha256').update(JSON.stringify(command)).digest('hex');
      const prior = db
        .prepare(
          'SELECT actorId, commandHash, originalPatient FROM patientRegistrationCommands WHERE requestId=?',
        )
        .get(requestId);
      const response = (patient: Patient): PatientRegistrationResponse => ({
        receipt: { requestId, actorId: user.id, registeredByRole, patient },
      });
      if (prior) {
        if (prior.actorId !== user.id || prior.commandHash !== commandHash)
          return fail(409, 'This request ID was already used for another patient registration.');
        return {
          status: 200,
          body: response(JSON.parse(String(prior.originalPatient)) as Patient),
        };
      }
      const patient = createPatient(req, user, input);
      db.prepare(
        'INSERT INTO patientRegistrationCommands(requestId,actorId,patientId,commandHash,originalPatient) VALUES (?,?,?,?,?)',
      ).run(requestId, user.id, patient.id, commandHash, JSON.stringify(patient));
      return { status: 201, body: response(patient) };
    });
    res.status(result.status).json(result.body);
  });
}
