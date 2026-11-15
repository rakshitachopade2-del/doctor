import { createHash } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import type { AuthRequest } from './app.ts';
import type { registerAppointmentRescheduling } from './appointment-rescheduling.ts';
import type { createScheduling } from './scheduling.ts';
import type { createClinicResources } from './clinic-resources.ts';
import { get, id, nowISO, type DB } from './db.ts';
import { notifyPatient } from './activity.ts';
import type { Appointment, User } from '../shared/types.ts';
import type {
  AppointmentCancellationContext,
  AppointmentCancellationEvent,
  AppointmentCancellationNotApplied,
  AppointmentCancellationResult,
} from '../shared/appointment-cancellation.ts';

interface Dependencies {
  db: DB;
  actor: (req: AuthRequest, roles?: User['role'][]) => User;
  appointmentGet: (req: AuthRequest, appointmentId: string) => Appointment;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
  businessFailure: (error: unknown) => { status: number; message: string } | null;
  scheduling: ReturnType<typeof createScheduling>;
  clinicResources: ReturnType<typeof createClinicResources>;
  appointmentRescheduling: ReturnType<typeof registerAppointmentRescheduling>;
}
const empty = z.object({}).strict();
const reference = z.string().trim().min(1).max(300);
const commandSchema = z
  .object({
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
    cancellationConfirmed: z.literal(true),
    requestId: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
  })
  .strict();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const CANCELLATION_SOURCE_STALE =
  'The appointment changed. Review the latest visit before cancelling.';
export const CANCELLATION_REQUEST_COLLISION =
  'This request ID was already used for a different cancellation command.';
function blockedReason(appointment: Appointment, user: User): string | null {
  if (user.role === 'patient')
    return appointment.status === 'scheduled'
      ? null
      : 'Patients may only cancel scheduled appointments. Contact the clinic for a visit already in progress.';
  return ['scheduled', 'checked-in'].includes(appointment.status)
    ? null
    : 'Only scheduled or checked-in appointments can be cancelled.';
}
type Rejection = { status: number; body: AppointmentCancellationNotApplied };

export function registerAppointmentCancellation(app: Express, dependencies: Dependencies) {
  const {
    db,
    actor,
    appointmentGet,
    audit,
    fail,
    businessFailure,
    scheduling,
    clinicResources,
    appointmentRescheduling,
  } = dependencies;
  db.exec(`
    CREATE TABLE IF NOT EXISTS appointmentCancellationEvents (
      id TEXT PRIMARY KEY, appointmentId TEXT NOT NULL REFERENCES appointments(id), data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS appointment_cancellation_events_appointment ON appointmentCancellationEvents(appointmentId);
    CREATE TABLE IF NOT EXISTS appointmentCancellationCommands (
      requestId TEXT PRIMARY KEY, actorId TEXT NOT NULL REFERENCES users(id),
      appointmentId TEXT NOT NULL REFERENCES appointments(id), operation TEXT NOT NULL CHECK(operation='cancel'),
      payload TEXT NOT NULL, eventId TEXT REFERENCES appointmentCancellationEvents(id), rejection TEXT,
      CHECK ((eventId IS NOT NULL AND rejection IS NULL) OR (eventId IS NULL AND rejection IS NOT NULL))
    );
  `);
  for (const table of ['appointmentCancellationEvents', 'appointmentCancellationCommands'])
    db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${table}_immutable_update BEFORE UPDATE ON ${table}
    BEGIN SELECT RAISE(ABORT,'Cancellation confirmations are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ${table}_immutable_delete BEFORE DELETE ON ${table}
    BEGIN SELECT RAISE(ABORT,'Cancellation confirmations are immutable'); END;
  `);

  function context(req: AuthRequest, appointmentId: string): AppointmentCancellationContext {
    const appointment = appointmentGet(req, appointmentId),
      user = actor(req);
    // Cancellation releases recorded claims regardless of current catalogue availability.
    // Include the allocation head so release/reassign cycles cannot revive a stale review.
    const reservations = db
      .prepare(
        `SELECT appointmentId,resourceId,startAt,endAt,data FROM resourceReservations
      WHERE appointmentId=? ORDER BY resourceId`,
      )
      .all(appointmentId);
    const head =
      db
        .prepare(
          'SELECT id FROM resourceAllocationEvents WHERE appointmentId=? ORDER BY rowid DESC LIMIT 1',
        )
        .get(appointmentId)?.id ?? null;
    const blocked = blockedReason(appointment, user);
    return {
      appointment,
      revision: hash([appointmentRescheduling.sourceRevision(appointment), reservations, head]),
      canCancel: blocked === null,
      blockedReason: blocked,
    };
  }
  function result(req: AuthRequest, eventId: string): AppointmentCancellationResult {
    const event = get<AppointmentCancellationEvent>(db, 'appointmentCancellationEvents', eventId);
    if (!event) return fail(500, 'The original cancellation confirmation is unavailable.');
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
  const base = '/api/appointments/:id';
  app.get(`${base}/cancellation-context`, (req: AuthRequest, res) => {
    actor(req);
    empty.parse(req.query);
    const appointmentId = reference.parse(req.params.id);
    const value = scheduling.transaction(() => {
      appointmentRescheduling.authorize(req);
      const value = context(req, appointmentId);
      audit(req, 'viewed appointment cancellation context', 'appointment', appointmentId);
      return value;
    });
    res.json(value);
  });
  app.post(`${base}/cancellations`, (req: AuthRequest, res) => {
    actor(req);
    empty.parse(req.query);
    const appointmentId = reference.parse(req.params.id),
      input = commandSchema.parse(req.body);
    const payload = JSON.stringify({
      operation: 'cancel',
      appointmentId,
      expectedRevision: input.expectedRevision,
      cancellationConfirmed: input.cancellationConfirmed,
    });
    const response = scheduling.transaction(() => {
      const user = appointmentRescheduling.authorize(req),
        appointment = appointmentGet(req, appointmentId);
      const previous = db
        .prepare(
          'SELECT actorId,appointmentId,operation,payload,eventId,rejection FROM appointmentCancellationCommands WHERE requestId=?',
        )
        .get(input.requestId);
      if (previous) {
        if (
          previous.actorId !== user.id ||
          previous.appointmentId !== appointmentId ||
          previous.operation !== 'cancel' ||
          previous.payload !== payload
        )
          return fail(409, CANCELLATION_REQUEST_COLLISION);
        if (previous.rejection) {
          const rejected = JSON.parse(String(previous.rejection)) as Rejection;
          return { status: rejected.status, body: rejected.body };
        }
        return { status: 200, body: result(req, String(previous.eventId)) };
      }
      db.exec('SAVEPOINT appointment_cancellation');
      try {
        const current = context(req, appointmentId);
        if (current.revision !== input.expectedRevision)
          return fail(409, CANCELLATION_SOURCE_STALE);
        if (!current.canCancel) return fail(409, current.blockedReason!);
        const before = current.appointment,
          after: Appointment = { ...before, status: 'cancelled' };
        clinicResources.appointmentChanged(req, before, after);
        db.prepare('UPDATE appointments SET status=?,data=? WHERE id=?').run(
          after.status,
          JSON.stringify(after),
          appointmentId,
        );
        const event: AppointmentCancellationEvent = {
          id: id(),
          appointmentId,
          requestId: input.requestId,
          expectedRevision: input.expectedRevision,
          before,
          after,
          cancellationConfirmed: true,
          createdById: user.id,
          createdByName: user.name,
          createdByRole: user.role,
          createdAt: nowISO(),
        };
        db.prepare(
          'INSERT INTO appointmentCancellationEvents(id,appointmentId,data) VALUES (?,?,?)',
        ).run(event.id, appointmentId, JSON.stringify(event));
        db.prepare(
          'INSERT INTO appointmentCancellationCommands(requestId,actorId,appointmentId,operation,payload,eventId) VALUES (?,?,?,?,?,?)',
        ).run(input.requestId, user.id, appointmentId, 'cancel', payload, event.id);
        audit(req, 'appointment cancelled', 'appointment', appointmentId);
        notifyPatient(db, after.patientId, `appointment-cancelled:${event.id}`, {
          kind: 'appointment',
          title: 'Appointment cancelled',
          detail: `${after.date} at ${after.time} IST · ${after.durationMinutes ?? 30} minutes · ${after.doctorName}`,
          href: `/my-care?appointment=${appointmentId}`,
        });
        const body = result(req, event.id);
        db.exec('RELEASE appointment_cancellation');
        return { status: 201, body };
      } catch (error) {
        const failure = businessFailure(error);
        if (!failure || ![400, 404, 409].includes(failure.status)) throw error;
        db.exec('ROLLBACK TO appointment_cancellation');
        db.exec('RELEASE appointment_cancellation');
        const rejection: Rejection = {
          status: failure.status,
          body: {
            error: failure.message,
            cancellationOutcome: 'not-applied',
            requestId: input.requestId,
            actorId: user.id,
            patientId: appointment.patientId,
            appointmentId,
          },
        };
        db.prepare(
          'INSERT INTO appointmentCancellationCommands(requestId,actorId,appointmentId,operation,payload,rejection) VALUES (?,?,?,?,?,?)',
        ).run(
          input.requestId,
          user.id,
          appointmentId,
          'cancel',
          payload,
          JSON.stringify(rejection),
        );
        return { status: rejection.status, body: rejection.body };
      }
    });
    res.status(response.status).json(response.body);
  });
}
