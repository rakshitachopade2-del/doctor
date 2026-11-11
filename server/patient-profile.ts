import type { Express } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AuthRequest } from './app.ts';
import type { Doctor, Patient, User } from '../shared/types.ts';
import type {
  AllergyStatus,
  PatientAllergies,
  PatientAllergyChange,
  PatientAllergyHistory,
  PatientDemographics,
  PatientProfile,
  PatientProfileChange,
} from '../shared/patient-profile.ts';
import { clinicToday, get, id, nowISO, type DB } from './db.ts';

interface ProfileContext {
  db: DB;
  actor: (req: AuthRequest, roles?: User['role'][]) => User;
  patientAccess: (req: AuthRequest, patientId: string, allowReception?: boolean) => Patient;
  clinicianId: (req: AuthRequest) => string;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
}
type PatientWithStatus = Patient & { allergyStatus?: AllergyStatus };
type StoredAllergyChange = PatientAllergyChange & { createdById: string };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const reason = z.string().trim().min(1).max(1000);
const commandFields = {
  reason,
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/, 'Refresh the current patient details.'),
  requestId: z
    .string()
    .uuid()
    .transform((value) => value.toLowerCase()),
};
const realDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      !Number.isNaN(Date.parse(`${value}T12:00:00Z`)) &&
      new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value &&
      value <= clinicToday(),
    'Use a real birth date that is not in the future.',
  );
const profileInput = z
  .object({
    name: z.string().trim().min(1).max(300),
    email: z
      .union([z.string().trim().email().max(254), z.literal('')])
      .transform((value) => value.toLowerCase()),
    phone: z.string().trim().min(7).max(30),
    dob: z.union([realDate, z.literal('')]),
    gender: z.string().trim().max(50),
    ...commandFields,
  })
  .strict();
const allergyInput = z
  .object({
    status: z.enum(['not-recorded', 'none-known', 'recorded']),
    text: z.string().trim().max(8000),
    ...commandFields,
  })
  .strict()
  .refine(
    (value) => (value.status === 'recorded' ? value.text.length > 0 : value.text.length === 0),
    'Record allergy details only when the status is recorded; leave details empty for the other statuses.',
  );

function demographics(patient: Patient): PatientDemographics {
  return {
    name: patient.name,
    email: patient.email,
    phone: patient.phone,
    dob: patient.dob,
    gender: patient.gender,
  };
}
function allergies(patient: PatientWithStatus): PatientAllergies {
  const text = patient.allergies?.trim() ?? '';
  return {
    status: text
      ? 'recorded'
      : patient.allergyStatus === 'none-known'
        ? 'none-known'
        : 'not-recorded',
    text,
  };
}
/** Derive legacy status without fabricating an event, author or review date. */
export function patientWithAllergyStatus(
  patient: Patient,
): Patient & { allergyStatus: AllergyStatus } {
  return { ...patient, allergyStatus: allergies(patient).status };
}
/** An explicit operational projection, independent of allergy state and its history. */
export function receptionPatient(patient: Patient): Patient {
  return { id: patient.id, ...demographics(patient), allergies: '', createdAt: patient.createdAt };
}
function safeAllergyChange(value: StoredAllergyChange): PatientAllergyChange {
  return {
    id: value.id,
    patientId: value.patientId,
    before: value.before,
    after: value.after,
    reason: value.reason,
    doctorId: value.doctorId,
    doctorName: value.doctorName,
    createdAt: value.createdAt,
  };
}
/** Call after patient authorization; contains only the explicitly patient-shared allergy record. */
export function safeAllergyHistory(db: DB, patientId: string): PatientAllergyHistory {
  const patient = get<Patient>(db, 'patients', patientId);
  if (!patient) throw new Error('Patient not found.');
  const changes = db
    .prepare('SELECT data FROM patientAllergyChanges WHERE patientId=? ORDER BY rowid DESC')
    .all(patientId)
    .map((row) => safeAllergyChange(JSON.parse(row.data as string) as StoredAllergyChange));
  return { patientId, current: allergies(patient), revision: null, changes };
}

export function registerPatientProfile(app: Express, context: ProfileContext) {
  const { db, actor, patientAccess, clinicianId, audit, fail } = context;
  db.exec(`
    CREATE TABLE IF NOT EXISTS patientProfileChanges (
      id TEXT PRIMARY KEY, patientId TEXT NOT NULL REFERENCES patients(id), data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS patient_profile_changes_patient ON patientProfileChanges(patientId);
    CREATE TABLE IF NOT EXISTS patientAllergyChanges (
      id TEXT PRIMARY KEY, patientId TEXT NOT NULL REFERENCES patients(id), data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS patient_allergy_changes_patient ON patientAllergyChanges(patientId);
    CREATE TABLE IF NOT EXISTS patientProfileCommands (
      requestId TEXT PRIMARY KEY, actorId TEXT NOT NULL REFERENCES users(id),
      operation TEXT NOT NULL, patientId TEXT NOT NULL REFERENCES patients(id),
      payload TEXT NOT NULL, changeId TEXT NOT NULL
    );
  `);
  for (const table of [
    'patientProfileChanges',
    'patientAllergyChanges',
    'patientProfileCommands',
  ]) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT,'Patient correction history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT,'Patient correction history is immutable'); END;`);
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
  function patientRecord(patientId: string) {
    const patient = get<PatientWithStatus>(db, 'patients', patientId);
    if (!patient) return fail(404, 'Patient not found.');
    return patient;
  }
  function profile(patientId: string, patientView = false): PatientProfile {
    const current = demographics(patientRecord(patientId));
    const changes = db
      .prepare('SELECT data FROM patientProfileChanges WHERE patientId=? ORDER BY rowid DESC')
      .all(patientId)
      .map((row) => JSON.parse(row.data as string) as PatientProfileChange);
    return {
      patientId,
      demographics: current,
      revision: patientView ? null : hash([patientId, current, changes[0]?.id ?? null]),
      changes: patientView ? [] : changes,
    };
  }
  function allergyHistory(patientId: string, patientView = false): PatientAllergyHistory {
    const result = safeAllergyHistory(db, patientId);
    return {
      ...result,
      revision: patientView
        ? null
        : hash([patientId, result.current, result.changes[0]?.id ?? null]),
    };
  }
  function replay(
    requestId: string,
    user: User,
    operation: string,
    patientId: string,
    payload: unknown,
  ) {
    const prior = db
      .prepare(
        'SELECT actorId,operation,patientId,payload FROM patientProfileCommands WHERE requestId=?',
      )
      .get(requestId);
    if (!prior) return false;
    if (
      prior.actorId !== user.id ||
      prior.operation !== operation ||
      prior.patientId !== patientId ||
      prior.payload !== JSON.stringify(payload)
    )
      fail(409, 'This correction request was already used with different details.');
    return true;
  }
  function remember(
    requestId: string,
    user: User,
    operation: string,
    patientId: string,
    payload: unknown,
    changeId: string,
  ) {
    db.prepare(
      'INSERT INTO patientProfileCommands(requestId,actorId,operation,patientId,payload,changeId) VALUES (?,?,?,?,?,?)',
    ).run(requestId, user.id, operation, patientId, JSON.stringify(payload), changeId);
  }

  app.get('/api/patients/:id/profile', (req: AuthRequest, res) => {
    const user = actor(req);
    const patientId = String(req.params.id);
    patientAccess(req, patientId, true);
    res.json(
      transaction(() => {
        const result = profile(patientId, user.role === 'patient');
        audit(req, 'viewed patient demographics', 'patient', patientId);
        return result;
      }),
    );
  });
  app.patch('/api/patients/:id/profile', (req: AuthRequest, res) => {
    const user = actor(req, ['admin', 'doctor', 'receptionist']);
    const patientId = String(req.params.id);
    patientAccess(req, patientId, true);
    const { expectedRevision, requestId, ...input } = profileInput.parse(req.body);
    res.json(
      transaction(() => {
        if (replay(requestId, user, 'demographics', patientId, input)) return profile(patientId);
        const original = patientRecord(patientId),
          current = profile(patientId);
        if (current.revision !== expectedRevision)
          fail(
            409,
            'Patient demographics changed. Refresh and review the latest details before saving.',
          );
        const { reason: changeReason, ...after } = input;
        if (JSON.stringify(current.demographics) === JSON.stringify(after))
          fail(400, 'Change at least one demographic field.');
        const change: PatientProfileChange = {
          id: id(),
          patientId,
          before: current.demographics,
          after,
          reason: changeReason,
          createdById: user.id,
          createdByName: user.name,
          createdByRole: user.role,
          createdAt: nowISO(),
        };
        db.prepare('INSERT INTO patientProfileChanges(id,patientId,data) VALUES (?,?,?)').run(
          change.id,
          patientId,
          JSON.stringify(change),
        );
        db.prepare('UPDATE patients SET data=? WHERE id=?').run(
          JSON.stringify({ ...original, ...after }),
          patientId,
        );
        remember(requestId, user, 'demographics', patientId, input, change.id);
        audit(req, 'corrected patient demographics', 'patient', patientId);
        return profile(patientId);
      }),
    );
  });
  app.get('/api/patients/:id/allergies', (req: AuthRequest, res) => {
    const user = actor(req, ['admin', 'doctor', 'patient']);
    const patientId = String(req.params.id);
    patientAccess(req, patientId);
    res.json(
      transaction(() => {
        const result = allergyHistory(patientId, user.role === 'patient');
        audit(req, 'viewed allergy record', 'patient', patientId);
        return result;
      }),
    );
  });
  app.post('/api/patients/:id/allergies', (req: AuthRequest, res) => {
    const doctorId = clinicianId(req),
      user = actor(req);
    const patientId = String(req.params.id);
    patientAccess(req, patientId);
    const { expectedRevision, requestId, ...input } = allergyInput.parse(req.body);
    res.json(
      transaction(() => {
        if (replay(requestId, user, 'allergies', patientId, input))
          return allergyHistory(patientId);
        const original = patientRecord(patientId),
          current = allergyHistory(patientId);
        if (current.revision !== expectedRevision)
          fail(
            409,
            'The allergy record changed. Refresh and review the latest record before saving.',
          );
        const after: PatientAllergies = { status: input.status, text: input.text };
        if (JSON.stringify(current.current) === JSON.stringify(after))
          fail(400, 'Change the allergy status or details before saving.');
        const change: StoredAllergyChange = {
          id: id(),
          patientId,
          before: current.current,
          after,
          reason: input.reason,
          doctorId,
          doctorName: get<Doctor>(db, 'doctors', doctorId)!.name,
          createdById: user.id,
          createdAt: nowISO(),
        };
        db.prepare('INSERT INTO patientAllergyChanges(id,patientId,data) VALUES (?,?,?)').run(
          change.id,
          patientId,
          JSON.stringify(change),
        );
        db.prepare('UPDATE patients SET data=? WHERE id=?').run(
          JSON.stringify({ ...original, allergies: after.text, allergyStatus: after.status }),
          patientId,
        );
        remember(requestId, user, 'allergies', patientId, input, change.id);
        audit(req, 'updated patient allergy record', 'patient', patientId);
        return allergyHistory(patientId);
      }),
    );
  });
}
