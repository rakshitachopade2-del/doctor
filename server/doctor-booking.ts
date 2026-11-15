import { createHash } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import type { AuthRequest } from './app.ts';
import type { Doctor, User } from '../shared/types.ts';
import type {
  DoctorBookingChange,
  DoctorBookingContext,
  DoctorBookingHistory,
  DoctorBookingMutation,
} from '../shared/doctor-booking.ts';
import { get, id, nowISO, type DB } from './db.ts';
import { mfaSessionAllowed } from './mfa.ts';

export const DOCTOR_BOOKING_PAUSED =
  'This doctor is not accepting new bookings. Choose another doctor or contact the clinic.';
interface Dependencies {
  db: DB;
  actor: (req: AuthRequest, roles?: User['role'][]) => User;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
  transaction: <T>(work: () => T) => T;
}
type StoredChange = DoctorBookingChange & {
  createdById: string;
  requestId: string;
  expectedRevision: string;
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const reference = z.string().min(1).max(300),
  empty = z.object({}).strict();
const commandSchema = z
  .object({
    acceptingNewBookings: z.boolean(),
    reason: z.string().trim().min(1).max(1000),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
    requestId: z
      .string()
      .uuid()
      .transform((v) => v.toLowerCase()),
  })
  .strict();
const pageSchema = z
  .object({
    page: z
      .string()
      .regex(/^[1-9]\d{0,6}$/)
      .transform(Number)
      .refine((v) => v <= 1000000)
      .default(1),
    pageSize: z.enum(['10', '25', '50']).transform(Number).default(25),
  })
  .strict();
export function initializeDoctorBooking(db: DB) {
  db.exec(`CREATE TABLE IF NOT EXISTS doctorBookingStatuses (
    id TEXT PRIMARY KEY REFERENCES doctors(id),acceptingNewBookings INTEGER NOT NULL CHECK(acceptingNewBookings IN (0,1))
  );
  CREATE TABLE IF NOT EXISTS doctorBookingChanges (
    id TEXT PRIMARY KEY,doctorId TEXT NOT NULL REFERENCES doctors(id),createdAt TEXT NOT NULL,data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS doctor_booking_head ON doctorBookingChanges(doctorId);
  CREATE INDEX IF NOT EXISTS doctor_booking_history ON doctorBookingChanges(doctorId,createdAt DESC,id DESC);
  CREATE TABLE IF NOT EXISTS doctorBookingCommands (
    requestId TEXT PRIMARY KEY,actorId TEXT NOT NULL REFERENCES users(id),doctorId TEXT NOT NULL REFERENCES doctors(id),
    payload TEXT NOT NULL,changeId TEXT NOT NULL UNIQUE REFERENCES doctorBookingChanges(id)
  );`);
  for (const table of ['doctorBookingChanges', 'doctorBookingCommands'])
    db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Doctor booking evidence is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Doctor booking evidence is immutable'); END;
  `);
}
export function doctorAcceptingNewBookings(db: DB, doctorId: string): boolean {
  const row = db
    .prepare('SELECT acceptingNewBookings FROM doctorBookingStatuses WHERE id=?')
    .get(doctorId);
  return !row || row.acceptingNewBookings === 1;
}
function head(db: DB, doctorId: string) {
  return db
    .prepare('SELECT data FROM doctorBookingChanges WHERE doctorId=? ORDER BY rowid DESC LIMIT 1')
    .get(doctorId);
}
export function doctorBookingRevision(db: DB, doctorId: string): string {
  const row = db
    .prepare('SELECT id FROM doctorBookingChanges WHERE doctorId=? ORDER BY rowid DESC LIMIT 1')
    .get(doctorId);
  return digest([doctorId, doctorAcceptingNewBookings(db, doctorId), row?.id ?? null]);
}
/** A booking exception is derived from the stored scheduled visit, never from an exclusion list. */
export function doctorAllowsBooking(
  db: DB,
  doctorId: string,
  existingAppointmentId?: string,
  patientId?: string,
): boolean {
  if (doctorAcceptingNewBookings(db, doctorId)) return true;
  if (!existingAppointmentId || !patientId) return false;
  const appointment = db
    .prepare('SELECT doctorId,patientId,status FROM appointments WHERE id=?')
    .get(existingAppointmentId);
  return (
    !!appointment &&
    appointment.doctorId === doctorId &&
    appointment.patientId === patientId &&
    appointment.status === 'scheduled'
  );
}
function safeChange(value: StoredChange): DoctorBookingChange {
  return {
    id: value.id,
    doctorId: value.doctorId,
    doctorName: value.doctorName,
    before: value.before,
    after: value.after,
    reason: value.reason,
    createdByName: value.createdByName,
    createdAt: value.createdAt,
  };
}
export function registerDoctorBooking(
  app: Express,
  { db, actor, audit, fail, transaction }: Dependencies,
) {
  function authorize(req: AuthRequest) {
    const cached = actor(req, ['admin']),
      user = get<User>(db, 'users', cached.id),
      session = db
        .prepare(
          'SELECT userId,expiresAt,csrfToken,mfaCredentialId FROM sessions WHERE tokenHash=?',
        )
        .get(req.sessionToken ?? '');
    if (
      !user ||
      user.active === false ||
      !session ||
      session.userId !== user.id ||
      Number(session.expiresAt) <= Date.now() ||
      session.csrfToken !== req.csrfToken ||
      !mfaSessionAllowed(db, user.id, session.mfaCredentialId)
    )
      return fail(401, 'Your session changed. Sign in again.');
    if (user.role !== 'admin' || user.mustChangePassword)
      return fail(403, 'Only an administrator can manage doctor booking status.');
    req.user = user;
    return user;
  }
  function context(doctorId: string): DoctorBookingContext {
    const doctor = get<Doctor>(db, 'doctors', doctorId);
    if (!doctor) return fail(404, 'Doctor not found.');
    const row = head(db, doctorId),
      latestChange = row ? safeChange(JSON.parse(row.data as string) as StoredChange) : null;
    const acceptingNewBookings = doctorAcceptingNewBookings(db, doctorId);
    return {
      doctor: { id: doctor.id, name: doctor.name },
      acceptingNewBookings,
      revision: digest([doctorId, acceptingNewBookings, latestChange?.id ?? null]),
      latestChange,
    };
  }
  function response(event: StoredChange): DoctorBookingMutation {
    return {
      context: context(event.doctorId),
      change: safeChange(event),
      receipt: {
        actorId: event.createdById,
        requestId: event.requestId,
        doctorId: event.doctorId,
        expectedRevision: event.expectedRevision,
        changeId: event.id,
      },
    };
  }
  const base = '/api/doctors/:doctorId/booking-status';
  app.get(base, (req: AuthRequest, res) => {
    actor(req, ['admin']);
    empty.parse(req.query);
    const doctorId = reference.parse(req.params.doctorId);
    const result = transaction(() => {
      authorize(req);
      const result = context(doctorId);
      audit(req, 'viewed doctor booking status', 'doctor', doctorId);
      return result;
    });
    res.json(result);
  });
  app.get(`${base}/history`, (req: AuthRequest, res) => {
    actor(req, ['admin']);
    const doctorId = reference.parse(req.params.doctorId),
      query = pageSchema.parse(req.query);
    const result = transaction((): DoctorBookingHistory => {
      authorize(req);
      if (!get<Doctor>(db, 'doctors', doctorId)) return fail(404, 'Doctor not found.');
      const total = Number(
          db.prepare('SELECT COUNT(*) n FROM doctorBookingChanges WHERE doctorId=?').get(doctorId)!
            .n,
        ),
        totalPages = Math.max(1, Math.ceil(total / query.pageSize)),
        page = Math.min(query.page, totalPages);
      const rows = db
        .prepare(
          'SELECT data FROM doctorBookingChanges WHERE doctorId=? ORDER BY createdAt DESC,id DESC LIMIT ? OFFSET ?',
        )
        .all(doctorId, query.pageSize, (page - 1) * query.pageSize);
      const items = rows.map((row) => safeChange(JSON.parse(row.data as string) as StoredChange));
      audit(req, 'viewed doctor booking history', 'doctor', doctorId);
      return { items, page, pageSize: query.pageSize, total, totalPages };
    });
    res.json(result);
  });
  app.post(base, (req: AuthRequest, res) => {
    actor(req, ['admin']);
    empty.parse(req.query);
    const doctorId = reference.parse(req.params.doctorId),
      input = commandSchema.parse(req.body),
      payload = JSON.stringify({
        doctorId,
        acceptingNewBookings: input.acceptingNewBookings,
        reason: input.reason,
        expectedRevision: input.expectedRevision,
      });
    const result = transaction(() => {
      const user = authorize(req);
      const prior = db
        .prepare(
          'SELECT actorId,doctorId,payload,changeId FROM doctorBookingCommands WHERE requestId=?',
        )
        .get(input.requestId);
      if (prior) {
        if (prior.actorId !== user.id || prior.doctorId !== doctorId || prior.payload !== payload)
          return fail(
            409,
            'This request ID has already been used for a different doctor booking-status change.',
          );
        const event = get<StoredChange>(db, 'doctorBookingChanges', String(prior.changeId));
        if (!event) return fail(500, 'The original booking-status receipt is unavailable.');
        return { value: response(event), status: 200 };
      }
      const before = context(doctorId);
      if (before.revision !== input.expectedRevision)
        return fail(
          409,
          'Doctor booking status changed. Refresh and review the latest status before saving.',
        );
      if (before.acceptingNewBookings === input.acceptingNewBookings)
        return fail(400, 'This doctor already has the requested booking status.');
      const event: StoredChange = {
        id: id(),
        doctorId,
        doctorName: before.doctor.name,
        before: before.acceptingNewBookings,
        after: input.acceptingNewBookings,
        reason: input.reason,
        createdById: user.id,
        createdByName: user.name,
        createdAt: nowISO(),
        requestId: input.requestId,
        expectedRevision: input.expectedRevision,
      };
      db.prepare(
        'INSERT INTO doctorBookingStatuses(id,acceptingNewBookings) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET acceptingNewBookings=excluded.acceptingNewBookings',
      ).run(doctorId, input.acceptingNewBookings ? 1 : 0);
      db.prepare(
        'INSERT INTO doctorBookingChanges(id,doctorId,createdAt,data) VALUES(?,?,?,?)',
      ).run(event.id, doctorId, event.createdAt, JSON.stringify(event));
      db.prepare(
        'INSERT INTO doctorBookingCommands(requestId,actorId,doctorId,payload,changeId) VALUES(?,?,?,?,?)',
      ).run(input.requestId, user.id, doctorId, payload, event.id);
      audit(
        req,
        input.acceptingNewBookings ? 'resumed doctor new bookings' : 'paused doctor new bookings',
        'doctor',
        doctorId,
      );
      return { value: response(event), status: 201 };
    });
    res.status(result.status).json(result.value);
  });
}
