import type { Express } from 'express';
import { z } from 'zod';
import {
  doctorProfileFields,
  type DoctorProfileFields,
  type DoctorProfileCreationReceipt,
  type DoctorProfileCreationResponse,
} from '../shared/doctor-profile-creation.ts';
import type { User } from '../shared/types.ts';
import type { AuthRequest } from './app.ts';
import { id, insert, type DB } from './db.ts';

interface Dependencies {
  db: DB;
  currentSessionUser: (req: AuthRequest) => User;
  transaction: <T>(operation: () => T) => T;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
}

const reviewed = doctorProfileFields
  .extend({
    requestId: z.uuid().transform((value) => value.toLowerCase()),
    reviewedConfirmed: z.literal(true),
  })
  .strict();
const noQuery = z.object({}).strict();

export function registerDoctorProfileCreation(
  app: Express,
  { db, currentSessionUser, transaction, audit, fail }: Dependencies,
) {
  db.exec(`CREATE TABLE IF NOT EXISTS doctorProfileCreationCommands (
    requestId TEXT PRIMARY KEY, actorId TEXT NOT NULL REFERENCES users(id),
    doctorId TEXT NOT NULL UNIQUE REFERENCES doctors(id), originalDoctor TEXT NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS doctorProfileCreationCommands_no_update BEFORE UPDATE ON doctorProfileCreationCommands
    BEGIN SELECT RAISE(ABORT,'Doctor profile creation evidence is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS doctorProfileCreationCommands_no_delete BEFORE DELETE ON doctorProfileCreationCommands
    BEGIN SELECT RAISE(ABORT,'Doctor profile creation evidence is immutable'); END;`);

  function administrator(req: AuthRequest) {
    const actor = currentSessionUser(req);
    if (actor.role !== 'admin' || actor.mustChangePassword)
      return fail(403, 'A current administrator is required to create a doctor profile.');
    return actor;
  }
  function create(req: AuthRequest, fields: DoctorProfileFields) {
    const doctor = { ...fields, id: id() };
    insert(db, 'doctors', doctor);
    audit(req, 'created doctor profile', 'doctor', doctor.id);
    return doctor;
  }
  app.post('/api/doctors', (req: AuthRequest, res) => {
    const doctor = transaction(() => {
      administrator(req);
      return create(req, doctorProfileFields.parse(req.body));
    });
    res.status(201).json(doctor);
  });
  app.post('/api/doctors/create', (req: AuthRequest, res) => {
    const result = transaction(() => {
      const actor = administrator(req);
      noQuery.parse(req.query);
      const { requestId, reviewedConfirmed: _confirmed, ...fields } = reviewed.parse(req.body);
      const prior = db
        .prepare(
          'SELECT actorId,originalDoctor FROM doctorProfileCreationCommands WHERE requestId=?',
        )
        .get(requestId);
      const response = (
        doctor: DoctorProfileCreationReceipt['doctor'],
      ): DoctorProfileCreationResponse => ({ receipt: { requestId, actorId: actor.id, doctor } });
      if (prior) {
        const original: DoctorProfileCreationReceipt['doctor'] = JSON.parse(
          String(prior.originalDoctor),
        );
        // Compare normalized fields so JSON key order in a saved snapshot has no effect.
        if (
          prior.actorId !== actor.id ||
          JSON.stringify(doctorProfileFields.parse(original)) !== JSON.stringify(fields)
        )
          return fail(409, 'This request ID was already used for another doctor profile creation.');
        return { status: 200, body: response(original) };
      }
      const doctor = create(req, fields);
      db.prepare(
        'INSERT INTO doctorProfileCreationCommands(requestId,actorId,doctorId,originalDoctor) VALUES (?,?,?,?)',
      ).run(requestId, actor.id, doctor.id, JSON.stringify(doctor));
      return { status: 201, body: response(doctor) };
    });
    res.status(result.status).json(result.body);
  });
}
