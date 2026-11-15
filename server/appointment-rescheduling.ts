import { createHash } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import type { AuthRequest } from './app.ts';
import type { createScheduling } from './scheduling.ts';
import type { createClinicResources } from './clinic-resources.ts';
import { addDays, get, id, nowISO, type DB } from './db.ts';
import { mfaSessionAllowed } from './mfa.ts';
import { notifyPatient } from './activity.ts';
import type { Appointment, Doctor, User } from '../shared/types.ts';
import type {
  AppointmentRescheduleContext,
  AppointmentRescheduleEvent,
  AppointmentRescheduleNotApplied,
  AppointmentReschedulePreview,
  AppointmentRescheduleResult,
  AppointmentRescheduleTarget,
} from '../shared/appointment-rescheduling.ts';

interface Dependencies {
  db: DB;
  actor: (req: AuthRequest, roles?: User['role'][]) => User;
  appointmentGet: (req: AuthRequest, appointmentId: string) => Appointment;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
  businessFailure: (error: unknown) => { status: number; message: string } | null;
  scheduling: ReturnType<typeof createScheduling>;
  clinicResources: ReturnType<typeof createClinicResources>;
}
const reference = z.string().trim().min(1).max(300);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      Number.isFinite(Date.parse(`${value}T12:00:00Z`)) &&
      new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value,
    'Use a real calendar date (YYYY-MM-DD).',
  );
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const targetFields = {
  doctorId: reference,
  date,
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Use a real time (HH:mm).'),
  mode: z.enum(['in-person', 'online']),
};
const previewSchema = z.object({ ...targetFields, expectedSourceRevision: revision }).strict();
const commandSchema = z
  .object({
    ...targetFields,
    expectedRevision: revision,
    patientConfirmed: z.literal(true),
    requestId: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
  })
  .strict();
const empty = z.object({}).strict();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const startAt = (appointment: Appointment) =>
  Date.parse(`${appointment.date}T${appointment.time}:00+05:30`);
const clinicDateAt = (asOf: number) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(asOf));
function sourceBlocked(appointment: Appointment, asOf: number): string | null {
  if (appointment.status !== 'scheduled')
    return 'Only scheduled appointments can be rescheduled here.';
  if (!(startAt(appointment) > asOf))
    return 'This appointment has reached or passed its scheduled start.';
  return null;
}
export const RESCHEDULE_SOURCE_STALE =
  'The appointment changed. Review the latest visit before previewing a new time.';
export const RESCHEDULE_PREVIEW_STALE =
  'The appointment or available time changed. Review a fresh preview before confirming.';
export const RESCHEDULE_REQUEST_COLLISION =
  'This request ID was already used for a different reschedule command.';
const RESOURCE_BLOCKED =
  'This time is unavailable for the appointment. Choose another time or contact the clinic.';
type Rejection = { status: number; body: AppointmentRescheduleNotApplied };

export function registerAppointmentRescheduling(app: Express, dependencies: Dependencies) {
  const { db, actor, appointmentGet, audit, fail, businessFailure, scheduling, clinicResources } =
    dependencies;
  db.exec(`
    CREATE TABLE IF NOT EXISTS appointmentMutationVersions (
      appointmentId TEXT PRIMARY KEY REFERENCES appointments(id), version INTEGER NOT NULL CHECK(version>0)
    );
    CREATE TRIGGER IF NOT EXISTS appointment_mutation_version AFTER UPDATE ON appointments
    WHEN OLD.data IS NOT NEW.data OR OLD.patientId IS NOT NEW.patientId OR OLD.doctorId IS NOT NEW.doctorId
      OR OLD.date IS NOT NEW.date OR OLD.time IS NOT NEW.time OR OLD.status IS NOT NEW.status
    BEGIN
      INSERT INTO appointmentMutationVersions(appointmentId,version) VALUES (NEW.id,1)
      ON CONFLICT(appointmentId) DO UPDATE SET version=version+1;
    END;
    CREATE TABLE IF NOT EXISTS appointmentRescheduleEvents (
      id TEXT PRIMARY KEY, appointmentId TEXT NOT NULL REFERENCES appointments(id), data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS appointment_reschedule_events_appointment ON appointmentRescheduleEvents(appointmentId);
    CREATE TABLE IF NOT EXISTS appointmentRescheduleCommands (
      requestId TEXT PRIMARY KEY, actorId TEXT NOT NULL REFERENCES users(id),
      appointmentId TEXT NOT NULL REFERENCES appointments(id), operation TEXT NOT NULL CHECK(operation='reschedule'),
      payload TEXT NOT NULL, eventId TEXT REFERENCES appointmentRescheduleEvents(id), rejection TEXT,
      CHECK ((eventId IS NOT NULL AND rejection IS NULL) OR (eventId IS NULL AND rejection IS NOT NULL))
    );
  `);
  for (const table of ['appointmentRescheduleEvents', 'appointmentRescheduleCommands'])
    db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${table}_immutable_update BEFORE UPDATE ON ${table}
    BEGIN SELECT RAISE(ABORT,'Reschedule confirmations are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ${table}_immutable_delete BEFORE DELETE ON ${table}
    BEGIN SELECT RAISE(ABORT,'Reschedule confirmations are immutable'); END;
  `);

  /** Caller holds the write lock. Also used by the legacy PATCH without changing its semantics. */
  function authorize(req: AuthRequest) {
    const cached = actor(req),
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
      (!['GET', 'HEAD'].includes(req.method) &&
        req.headers['x-csrf-token'] !== session.csrfToken) ||
      !mfaSessionAllowed(db, user.id, session.mfaCredentialId)
    )
      return fail(401, 'Your session changed. Sign in again.');
    if (
      user.mustChangePassword ||
      !['admin', 'doctor', 'receptionist', 'patient'].includes(user.role)
    )
      return fail(403, 'This account cannot change appointments.');
    req.user = user;
    return user;
  }
  function sourceRevision(appointment: Appointment) {
    const row = db
      .prepare('SELECT version FROM appointmentMutationVersions WHERE appointmentId=?')
      .get(appointment.id);
    return hash([appointment, Number(row?.version ?? 0)]);
  }
  function context(req: AuthRequest, appointmentId: string): AppointmentRescheduleContext {
    const asOf = Date.now(),
      appointment = appointmentGet(req, appointmentId);
    const blockedReason = sourceBlocked(appointment, asOf),
      clinicDate = clinicDateAt(asOf);
    return {
      appointment,
      sourceRevision: sourceRevision(appointment),
      canReschedule: blockedReason === null,
      blockedReason,
      clinicDate,
      bookingThroughDate: addDays(clinicDate, 180),
    };
  }
  function target(input: AppointmentRescheduleTarget): AppointmentRescheduleTarget {
    return { doctorId: input.doctorId, date: input.date, time: input.time, mode: input.mode };
  }
  function preview(
    req: AuthRequest,
    appointmentId: string,
    input: AppointmentRescheduleTarget,
  ): AppointmentReschedulePreview {
    const asOf = Date.now(),
      before = appointmentGet(req, appointmentId),
      currentRevision = sourceRevision(before);
    const doctor = get<Doctor>(db, 'doctors', input.doctorId);
    if (!doctor) return fail(404, 'Doctor not found.');
    const schedule = scheduling.schedule(doctor.id);
    const changed =
      before.doctorId !== input.doctorId ||
      before.date !== input.date ||
      before.time !== input.time ||
      before.mode !== input.mode;
    const after: Appointment = changed
      ? {
          ...before,
          ...target(input),
          doctorName: doctor.name,
          fee: doctor.fee,
          durationMinutes:
            before.durationPolicy === 'custom'
              ? (before.durationMinutes ?? 30)
              : schedule.durationMinutes,
        }
      : { ...before };
    let blockedReason = sourceBlocked(before, asOf);
    if (!changed) blockedReason ??= 'Choose a different doctor, date, time or consultation mode.';
    try {
      scheduling.validateBooking(
        {
          patientId: before.patientId,
          ...target(input),
          excludeAppointmentId: before.id,
          customDurationMinutes:
            before.durationPolicy === 'custom' ? (before.durationMinutes ?? 30) : undefined,
        },
        { asOf },
      );
    } catch (error) {
      const failure = businessFailure(error);
      if (!failure || ![400, 409].includes(failure.status)) throw error;
      blockedReason ??= failure.message;
    }
    const start = minutes(input.time),
      end = start + (after.durationMinutes ?? 30);
    const closures = db
      .prepare(
        `SELECT id,doctorId,startDate,endDate,data FROM scheduleClosures
      WHERE (doctorId IS NULL OR doctorId=?) AND startDate<=? AND endDate>=? ORDER BY id`,
      )
      .all(doctor.id, input.date, input.date);
    const busy = db
      .prepare(
        `SELECT id,patientId,doctorId,date,time,status,COALESCE(json_extract(data,'$.durationMinutes'),30) AS durationMinutes
      FROM appointments WHERE date=? AND (doctorId=? OR patientId=?) AND id<>? AND status NOT IN ('cancelled','no-show')
      AND (CAST(substr(time,1,2) AS INTEGER)*60+CAST(substr(time,4,2) AS INTEGER))<?
      AND (CAST(substr(time,1,2) AS INTEGER)*60+CAST(substr(time,4,2) AS INTEGER)+COALESCE(json_extract(data,'$.durationMinutes'),30))>?
      ORDER BY id`,
      )
      .all(input.date, doctor.id, before.patientId, before.id, end, start);
    const resources = clinicResources.previewAppointmentMoves([{ before, after }]);
    if (!resources.visits[0].available) blockedReason ??= RESOURCE_BLOCKED;
    const clinicDate = clinicDateAt(asOf);
    return {
      appointmentId,
      sourceRevision: currentRevision,
      revision: hash([
        appointmentId,
        currentRevision,
        target(input),
        before,
        after,
        { id: doctor.id, name: doctor.name, fee: doctor.fee, schedule },
        closures,
        busy,
        resources.revision,
        // An existing same-doctor move remains available through a pause/resume cycle.
        before.doctorId === doctor.id ? null : scheduling.bookingStatusRevision(doctor.id),
        blockedReason,
        clinicDate,
        addDays(clinicDate, 180),
      ]),
      before,
      after,
      canReschedule: blockedReason === null,
      blockedReason,
      generatedAt: new Date(asOf).toISOString(),
    };
  }
  function result(req: AuthRequest, eventId: string): AppointmentRescheduleResult {
    const event = get<AppointmentRescheduleEvent>(db, 'appointmentRescheduleEvents', eventId);
    if (!event) return fail(500, 'The original reschedule confirmation is unavailable.');
    return {
      appointment: appointmentGet(req, event.appointmentId),
      event,
      receipt: {
        requestId: event.requestId,
        actorId: event.createdById,
        patientId: event.before.patientId,
        appointmentId: event.appointmentId,
        eventId: event.id,
        expectedRevision: event.expectedRevision,
      },
    };
  }
  function clockCheck(before: Appointment, after: Appointment) {
    const asOf = Date.now(),
      today = clinicDateAt(asOf);
    if (
      sourceBlocked(before, asOf) ||
      !(startAt(after) > asOf) ||
      after.date < today ||
      after.date > addDays(today, 180)
    )
      return fail(
        409,
        'The appointment time is no longer eligible. Review a fresh preview before confirming.',
      );
  }

  const base = '/api/appointments/:id';
  app.get(`${base}/reschedule-context`, (req: AuthRequest, res) => {
    actor(req);
    empty.parse(req.query);
    const appointmentId = reference.parse(req.params.id);
    const value = scheduling.transaction(() => {
      authorize(req);
      const value = context(req, appointmentId);
      audit(req, 'viewed appointment reschedule context', 'appointment', appointmentId);
      return value;
    });
    res.json(value);
  });
  app.post(`${base}/reschedule-preview`, (req: AuthRequest, res) => {
    actor(req);
    empty.parse(req.query);
    const appointmentId = reference.parse(req.params.id),
      input = previewSchema.parse(req.body);
    const value = scheduling.transaction(() => {
      authorize(req);
      const appointment = appointmentGet(req, appointmentId);
      if (sourceRevision(appointment) !== input.expectedSourceRevision)
        return fail(409, RESCHEDULE_SOURCE_STALE);
      const value = preview(req, appointmentId, input);
      audit(req, 'previewed appointment reschedule', 'appointment', appointmentId);
      return value;
    });
    res.json(value);
  });
  app.post(`${base}/reschedules`, (req: AuthRequest, res) => {
    actor(req);
    empty.parse(req.query);
    const appointmentId = reference.parse(req.params.id),
      input = commandSchema.parse(req.body);
    const payload = JSON.stringify({
      operation: 'reschedule',
      appointmentId,
      ...target(input),
      expectedRevision: input.expectedRevision,
      patientConfirmed: input.patientConfirmed,
    });
    const response = scheduling.transaction(() => {
      const user = authorize(req),
        appointment = appointmentGet(req, appointmentId);
      const previous = db
        .prepare(
          'SELECT actorId,appointmentId,operation,payload,eventId,rejection FROM appointmentRescheduleCommands WHERE requestId=?',
        )
        .get(input.requestId);
      if (previous) {
        if (
          previous.actorId !== user.id ||
          previous.appointmentId !== appointmentId ||
          previous.operation !== 'reschedule' ||
          previous.payload !== payload
        )
          return fail(409, RESCHEDULE_REQUEST_COLLISION);
        if (previous.rejection) {
          const rejected = JSON.parse(String(previous.rejection)) as Rejection;
          return { status: rejected.status, body: rejected.body };
        }
        return { status: 200, body: result(req, String(previous.eventId)) };
      }
      db.exec('SAVEPOINT appointment_reschedule');
      try {
        const current = preview(req, appointmentId, input);
        if (current.revision !== input.expectedRevision) return fail(409, RESCHEDULE_PREVIEW_STALE);
        if (!current.canReschedule) return fail(409, current.blockedReason!);
        const before = current.before,
          after = current.after;
        clockCheck(before, after);
        clinicResources.appointmentChanged(req, before, after);
        db.prepare(
          'UPDATE appointments SET doctorId=?,date=?,time=?,status=?,data=? WHERE id=?',
        ).run(
          after.doctorId,
          after.date,
          after.time,
          after.status,
          JSON.stringify(after),
          after.id,
        );
        const event: AppointmentRescheduleEvent = {
          id: id(),
          appointmentId,
          requestId: input.requestId,
          expectedRevision: input.expectedRevision,
          before,
          after,
          patientConfirmed: true,
          createdById: user.id,
          createdByName: user.name,
          createdByRole: user.role,
          createdAt: nowISO(),
        };
        db.prepare(
          'INSERT INTO appointmentRescheduleEvents(id,appointmentId,data) VALUES (?,?,?)',
        ).run(event.id, appointmentId, JSON.stringify(event));
        db.prepare(
          'INSERT INTO appointmentRescheduleCommands(requestId,actorId,appointmentId,operation,payload,eventId) VALUES (?,?,?,?,?,?)',
        ).run(input.requestId, user.id, appointmentId, 'reschedule', payload, event.id);
        audit(req, 'rescheduled appointment', 'appointment', appointmentId);
        notifyPatient(db, after.patientId, `appointment-rescheduled:${event.id}`, {
          kind: 'appointment',
          title: 'Your appointment was rescheduled',
          detail: `${after.date} at ${after.time} IST · ${after.durationMinutes ?? 30} minutes · ${after.doctorName}`,
          href: `/my-care?appointment=${appointmentId}`,
        });
        // One final instant checks both starts and the horizon after all source/evidence writes.
        clockCheck(before, after);
        const body = result(req, event.id);
        db.exec('RELEASE appointment_reschedule');
        return { status: 201, body };
      } catch (error) {
        const failure = businessFailure(error);
        if (!failure || ![400, 404, 409].includes(failure.status)) throw error;
        db.exec('ROLLBACK TO appointment_reschedule');
        db.exec('RELEASE appointment_reschedule');
        const rejection: Rejection = {
          status: failure.status,
          body: {
            error: failure.message,
            rescheduleOutcome: 'not-applied',
            requestId: input.requestId,
            actorId: user.id,
            patientId: appointment.patientId,
            appointmentId,
          },
        };
        db.prepare(
          'INSERT INTO appointmentRescheduleCommands(requestId,actorId,appointmentId,operation,payload,rejection) VALUES (?,?,?,?,?,?)',
        ).run(
          input.requestId,
          user.id,
          appointmentId,
          'reschedule',
          payload,
          JSON.stringify(rejection),
        );
        return { status: rejection.status, body: rejection.body };
      }
    });
    res.status(response.status).json(response.body);
  });
  return { authorize };
}
