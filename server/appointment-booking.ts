import type { Express } from 'express';
import { z } from 'zod';
import type { AuthRequest } from './app.ts';
import type { createScheduling } from './scheduling.ts';
import type { createWaitlist } from './waitlist.ts';
import { get, id, nowISO, type DB } from './db.ts';
import { mfaSessionAllowed } from './mfa.ts';
import { notifyPatient } from './activity.ts';
import type { Appointment, Doctor, Patient, User } from '../shared/types.ts';
import type {
  AppointmentBooking,
  AppointmentBookingNotCreated,
  AppointmentBookingResult,
} from '../shared/appointment-booking.ts';

interface Dependencies {
  db: DB;
  actor: (req: AuthRequest, roles?: User['role'][]) => User;
  ownPatient: (req: AuthRequest, patientId?: string) => string;
  patientAccess: (req: AuthRequest, patientId: string, allowReception?: boolean) => Patient;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
  businessFailure: (error: unknown) => { status: number; message: string } | null;
  scheduling: ReturnType<typeof createScheduling>;
  waitlist: ReturnType<typeof createWaitlist>;
}
const identifier = z.string().trim().min(1).max(300);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine(
    (value) =>
      Number.isFinite(Date.parse(`${value}T12:00:00Z`)) &&
      new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value,
    'Invalid calendar date',
  );
const fields = {
  patientId: identifier,
  doctorId: identifier,
  date,
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Use a real time (HH:mm).'),
  mode: z.enum(['in-person', 'online']),
  reason: z.string().trim().min(1).max(300),
  waitlistId: identifier.optional(),
  patientConfirmed: z.literal(true).optional(),
};
const bookingSchema = z
  .object({
    ...fields,
    requestId: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
  })
  .strict()
  .refine(
    (value) => !value.waitlistId || value.patientConfirmed === true,
    'Confirm that the patient agrees to this appointment before booking from the waitlist.',
  );
// Retain the original endpoint's stripping and patient-default behavior.
const legacySchema = z.object({
  ...fields,
  patientId: identifier.optional(),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  durationMinutes: z.never().optional(),
  durationPolicy: z.never().optional(),
});
export const BOOKING_REQUEST_COLLISION =
  'This request ID was already used for a different booking command.';
type BookingFields = z.infer<typeof legacySchema>;
type Rejection = { status: number; body: AppointmentBookingNotCreated };

export function registerAppointmentBookings(app: Express, dependencies: Dependencies) {
  const {
    db,
    actor,
    ownPatient,
    patientAccess,
    audit,
    fail,
    businessFailure,
    scheduling,
    waitlist,
  } = dependencies;
  db.exec(`
    CREATE TABLE IF NOT EXISTS appointmentBookings (
      id TEXT PRIMARY KEY, appointmentId TEXT NOT NULL UNIQUE REFERENCES appointments(id),
      patientId TEXT NOT NULL REFERENCES patients(id), data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS appointmentBookingCommands (
      requestId TEXT PRIMARY KEY, actorId TEXT NOT NULL REFERENCES users(id),
      operation TEXT NOT NULL CHECK(operation='book'), payload TEXT NOT NULL,
      bookingId TEXT REFERENCES appointmentBookings(id), rejection TEXT,
      CHECK ((bookingId IS NOT NULL AND rejection IS NULL) OR (bookingId IS NULL AND rejection IS NOT NULL))
    );
  `);
  for (const table of ['appointmentBookings', 'appointmentBookingCommands'])
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS ${table}_immutable_update BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT,'Booking confirmations are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS ${table}_immutable_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT,'Booking confirmations are immutable'); END;
    `);

  function authorize(req: AuthRequest) {
    const cached = actor(req);
    const user = get<User>(db, 'users', cached.id);
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
    if (
      user.mustChangePassword ||
      !['admin', 'doctor', 'receptionist', 'patient'].includes(user.role)
    )
      return fail(403, 'This account cannot book appointments.');
    req.user = user;
    return user;
  }

  /** Caller holds the write lock and has revalidated current identity and patient access. */
  function create(req: AuthRequest, input: BookingFields, patient: Patient): Appointment {
    const durationMinutes = scheduling.validateBooking({
      doctorId: input.doctorId,
      date: input.date,
      time: input.time,
      mode: input.mode,
      patientId: patient.id,
    });
    const doctor = get<Doctor>(db, 'doctors', input.doctorId)!;
    const value: Appointment = {
      id: id(),
      patientId: patient.id,
      patientName: patient.name,
      doctorId: doctor.id,
      doctorName: doctor.name,
      date: input.date,
      time: input.time,
      mode: input.mode,
      reason: input.reason,
      fee: doctor.fee,
      durationMinutes,
      status: 'scheduled',
      createdAt: nowISO(),
    };
    db.prepare(
      'INSERT INTO appointments(id,patientId,doctorId,date,time,status,data) VALUES (?,?,?,?,?,?,?)',
    ).run(
      value.id,
      value.patientId,
      value.doctorId,
      value.date,
      value.time,
      value.status,
      JSON.stringify(value),
    );
    if (input.waitlistId) waitlist.book(req, input.waitlistId, value, input.patientConfirmed);
    audit(req, 'booked appointment', 'appointment', value.id);
    if (!input.waitlistId)
      notifyPatient(db, value.patientId, `appointment-created:${value.id}`, {
        kind: 'appointment',
        title: 'Your appointment is booked',
        detail: `${value.date} at ${value.time} IST · ${value.doctorName}`,
        href: '/my-care',
      });
    return value;
  }

  function result(bookingId: string, requestId: string, actorId: string): AppointmentBookingResult {
    const booking = get<AppointmentBooking>(db, 'appointmentBookings', bookingId);
    if (!booking) return fail(500, 'The original booking confirmation is unavailable.');
    const appointment = get<Appointment>(db, 'appointments', booking.appointment.id);
    if (!appointment) return fail(500, 'The booked appointment is unavailable.');
    return {
      appointment,
      booking,
      receipt: {
        requestId,
        actorId,
        patientId: booking.appointment.patientId,
        bookingId,
        appointmentId: appointment.id,
      },
    };
  }

  app.post('/api/appointment-bookings', (req: AuthRequest, res) => {
    actor(req);
    z.object({}).strict().parse(req.query);
    const input = bookingSchema.parse(req.body);
    const payload = JSON.stringify({
      operation: 'book',
      patientId: input.patientId,
      doctorId: input.doctorId,
      date: input.date,
      time: input.time,
      mode: input.mode,
      reason: input.reason,
      waitlistId: input.waitlistId ?? null,
      patientConfirmed: input.patientConfirmed === true,
    });
    const response = scheduling.transaction(() => {
      const user = authorize(req);
      const patientId = ownPatient(req, input.patientId);
      const patient = patientAccess(req, patientId, true);
      const previous = db
        .prepare(
          'SELECT actorId,operation,payload,bookingId,rejection FROM appointmentBookingCommands WHERE requestId=?',
        )
        .get(input.requestId);
      if (previous) {
        if (
          previous.actorId !== user.id ||
          previous.operation !== 'book' ||
          previous.payload !== payload
        )
          return fail(409, BOOKING_REQUEST_COLLISION);
        if (previous.rejection) {
          const rejection = JSON.parse(previous.rejection as string) as Rejection;
          return { status: rejection.status, body: rejection.body };
        }
        return {
          status: 200,
          body: result(previous.bookingId as string, input.requestId, user.id),
        };
      }
      // A terminal rejection stays under the same writer lock as the absence check.
      // Delayed concurrent copies of this UUID can never create after a definitive rejection.
      db.exec('SAVEPOINT ordinary_booking');
      try {
        const appointment = create(req, input, patient);
        const booking: AppointmentBooking = {
          id: id(),
          appointment,
          waitlistId: input.waitlistId ?? null,
          patientConfirmed: input.patientConfirmed === true,
          createdById: user.id,
          createdByName: user.name,
          createdByRole: user.role,
          createdAt: appointment.createdAt,
        };
        db.prepare(
          'INSERT INTO appointmentBookings(id,appointmentId,patientId,data) VALUES (?,?,?,?)',
        ).run(booking.id, appointment.id, patient.id, JSON.stringify(booking));
        db.prepare(
          'INSERT INTO appointmentBookingCommands(requestId,actorId,operation,payload,bookingId) VALUES (?,?,?,?,?)',
        ).run(input.requestId, user.id, 'book', payload, booking.id);
        const body = result(booking.id, input.requestId, user.id);
        db.exec('RELEASE ordinary_booking');
        return { status: 201, body };
      } catch (error) {
        const failure = businessFailure(error);
        if (!failure || ![400, 404, 409].includes(failure.status)) throw error;
        db.exec('ROLLBACK TO ordinary_booking');
        db.exec('RELEASE ordinary_booking');
        const rejection: Rejection = {
          status: failure.status,
          body: {
            error: failure.message,
            bookingOutcome: 'not-created',
            requestId: input.requestId,
            actorId: user.id,
            patientId,
          },
        };
        db.prepare(
          'INSERT INTO appointmentBookingCommands(requestId,actorId,operation,payload,rejection) VALUES (?,?,?,?,?)',
        ).run(input.requestId, user.id, 'book', payload, JSON.stringify(rejection));
        return { status: rejection.status, body: rejection.body };
      }
    });
    res.status(response.status).json(response.body);
  });

  app.post('/api/appointments', (req: AuthRequest, res) => {
    const input = legacySchema.parse(req.body);
    const appointment = scheduling.transaction(() => {
      authorize(req);
      const patientId = ownPatient(req, input.patientId);
      return create(req, input, patientAccess(req, patientId, true));
    });
    res.status(201).json(appointment);
  });
}
