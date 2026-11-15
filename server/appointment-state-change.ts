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
  AppointmentStateChangeContext,
  AppointmentStateChangeEvent,
  AppointmentStateChangeNotApplied,
  AppointmentStateChangeResult,
  AppointmentStateChangeStatus,
} from '../shared/appointment-state-change.ts';

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
const statuses = ['checked-in', 'in-consultation', 'completed', 'no-show'] as const;
const staffRoles: User['role'][] = ['admin', 'doctor', 'receptionist'];
const commandSchema = z
  .object({
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(statuses),
    changeConfirmed: z.literal(true),
    requestId: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
  })
  .strict();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const STATE_CHANGE_SOURCE_STALE =
  'The appointment changed. Review the latest visit before changing its status.';
export const STATE_CHANGE_REQUEST_COLLISION =
  'This request ID was already used for a different appointment state command.';
const CLINICIAN_ONLY = 'Only a clinician can start or complete a consultation.';
const dateAt = (asOf: number) => new Date(asOf + 330 * 60000).toISOString().slice(0, 10);
function roleAllowed(user: User, status: AppointmentStateChangeStatus) {
  return user.role !== 'receptionist' || !['in-consultation', 'completed'].includes(status);
}
function blocked(
  appointment: Appointment,
  user: User,
  status: AppointmentStateChangeStatus,
  asOf: number,
): { status: number; message: string } | null {
  if (!roleAllowed(user, status)) return { status: 403, message: CLINICIAN_ONLY };
  const previous = {
    'checked-in': 'scheduled',
    'in-consultation': 'checked-in',
    completed: 'in-consultation',
    'no-show': 'scheduled',
  } as const;
  if (appointment.status !== previous[status])
    return { status: 409, message: 'This appointment status change is not allowed.' };
  if (appointment.date > dateAt(asOf))
    return {
      status: 400,
      message: 'Future appointments cannot be checked in, completed or marked as no-show.',
    };
  if (status === 'no-show' && Date.parse(`${appointment.date}T${appointment.time}:00+05:30`) > asOf)
    return {
      status: 400,
      message: 'An appointment cannot be marked as a no-show before its scheduled time.',
    };
  return null;
}
type Rejection = { status: number; body: AppointmentStateChangeNotApplied };

export function registerAppointmentStateChange(app: Express, dependencies: Dependencies) {
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
    CREATE TABLE IF NOT EXISTS appointmentStateChangeEvents (
      id TEXT PRIMARY KEY, appointmentId TEXT NOT NULL REFERENCES appointments(id), data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS appointment_state_change_events_appointment ON appointmentStateChangeEvents(appointmentId);
    CREATE TABLE IF NOT EXISTS appointmentStateChangeCommands (
      requestId TEXT PRIMARY KEY, actorId TEXT NOT NULL REFERENCES users(id),
      appointmentId TEXT NOT NULL REFERENCES appointments(id), operation TEXT NOT NULL CHECK(operation='state-change'),
      payload TEXT NOT NULL, eventId TEXT REFERENCES appointmentStateChangeEvents(id), rejection TEXT,
      CHECK ((eventId IS NOT NULL AND rejection IS NULL) OR (eventId IS NULL AND rejection IS NOT NULL))
    );
  `);
  for (const table of ['appointmentStateChangeEvents', 'appointmentStateChangeCommands'])
    db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${table}_immutable_update BEFORE UPDATE ON ${table}
    BEGIN SELECT RAISE(ABORT,'Appointment state confirmations are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ${table}_immutable_delete BEFORE DELETE ON ${table}
    BEGIN SELECT RAISE(ABORT,'Appointment state confirmations are immutable'); END;
  `);

  function authorize(req: AuthRequest, status?: AppointmentStateChangeStatus) {
    const user = appointmentRescheduling.authorize(req);
    if (!staffRoles.includes(user.role)) fail(403, 'Clinic staff access is required.');
    if (status && !roleAllowed(user, status)) fail(403, CLINICIAN_ONLY);
    return user;
  }

  function context(req: AuthRequest, appointmentId: string): AppointmentStateChangeContext {
    const appointment = appointmentGet(req, appointmentId),
      user = actor(req);
    // State changes retain or release recorded claims without rechecking catalogue availability.
    // The allocation head invalidates reviews after resource assignment/removal cycles.
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
    const asOf = Date.now();
    return {
      appointment,
      revision: hash([appointmentRescheduling.sourceRevision(appointment), reservations, head]),
      actions: statuses.map((status) => {
        const reason = blocked(appointment, user, status, asOf);
        return { status, allowed: reason === null, blockedReason: reason?.message ?? null };
      }),
      generatedAt: new Date(asOf).toISOString(),
      clinicDate: dateAt(asOf),
    };
  }
  function result(req: AuthRequest, eventId: string): AppointmentStateChangeResult {
    const event = get<AppointmentStateChangeEvent>(db, 'appointmentStateChangeEvents', eventId);
    if (!event) return fail(500, 'The original appointment state confirmation is unavailable.');
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
        status: event.after.status as AppointmentStateChangeStatus,
      },
    };
  }
  const base = '/api/appointments/:id';
  app.get(`${base}/state-context`, (req: AuthRequest, res) => {
    actor(req, staffRoles);
    empty.parse(req.query);
    const appointmentId = reference.parse(req.params.id);
    const value = scheduling.transaction(() => {
      authorize(req);
      const value = context(req, appointmentId);
      audit(req, 'viewed appointment state context', 'appointment', appointmentId);
      return value;
    });
    res.json(value);
  });
  app.post(`${base}/state-changes`, (req: AuthRequest, res) => {
    actor(req, staffRoles);
    empty.parse(req.query);
    const appointmentId = reference.parse(req.params.id),
      input = commandSchema.parse(req.body);
    const payload = JSON.stringify({
      operation: 'state-change',
      status: input.status,
      appointmentId,
      expectedRevision: input.expectedRevision,
      changeConfirmed: input.changeConfirmed,
    });
    const response = scheduling.transaction(() => {
      const user = authorize(req, input.status),
        appointment = appointmentGet(req, appointmentId);
      const previous = db
        .prepare(
          'SELECT actorId,appointmentId,operation,payload,eventId,rejection FROM appointmentStateChangeCommands WHERE requestId=?',
        )
        .get(input.requestId);
      if (previous) {
        if (
          previous.actorId !== user.id ||
          previous.appointmentId !== appointmentId ||
          previous.operation !== 'state-change' ||
          previous.payload !== payload
        )
          return fail(409, STATE_CHANGE_REQUEST_COLLISION);
        if (previous.rejection) {
          const rejected = JSON.parse(String(previous.rejection)) as Rejection;
          return { status: rejected.status, body: rejected.body };
        }
        return { status: 200, body: result(req, String(previous.eventId)) };
      }
      db.exec('SAVEPOINT appointment_state_change');
      try {
        const current = context(req, appointmentId);
        if (current.revision !== input.expectedRevision)
          return fail(409, STATE_CHANGE_SOURCE_STALE);
        const eligibility = blocked(current.appointment, user, input.status, Date.now());
        if (eligibility) return fail(eligibility.status, eligibility.message);
        const before = current.appointment,
          after: Appointment = { ...before, status: input.status };
        clinicResources.appointmentChanged(req, before, after);
        db.prepare('UPDATE appointments SET status=?,data=? WHERE id=?').run(
          after.status,
          JSON.stringify(after),
          appointmentId,
        );
        const event: AppointmentStateChangeEvent = {
          id: id(),
          appointmentId,
          requestId: input.requestId,
          expectedRevision: input.expectedRevision,
          before,
          after,
          changeConfirmed: true,
          createdById: user.id,
          createdByName: user.name,
          createdByRole: user.role as Exclude<User['role'], 'patient'>,
          createdAt: nowISO(),
        };
        db.prepare(
          'INSERT INTO appointmentStateChangeEvents(id,appointmentId,data) VALUES (?,?,?)',
        ).run(event.id, appointmentId, JSON.stringify(event));
        db.prepare(
          'INSERT INTO appointmentStateChangeCommands(requestId,actorId,appointmentId,operation,payload,eventId) VALUES (?,?,?,?,?,?)',
        ).run(input.requestId, user.id, appointmentId, 'state-change', payload, event.id);
        audit(req, `appointment ${after.status}`, 'appointment', appointmentId);
        notifyPatient(db, after.patientId, `appointment-state-changed:${event.id}`, {
          kind: 'appointment',
          title: `Appointment ${after.status.replaceAll('-', ' ')}`,
          detail: `${after.date} at ${after.time} IST · ${after.durationMinutes ?? 30} minutes · ${after.doctorName}`,
          href: '/my-care/record?tab=visits',
        });
        const finalEligibility = blocked(before, user, input.status, Date.now());
        if (finalEligibility) return fail(finalEligibility.status, finalEligibility.message);
        const body = result(req, event.id);
        db.exec('RELEASE appointment_state_change');
        return { status: 201, body };
      } catch (error) {
        const failure = businessFailure(error);
        if (!failure || ![400, 404, 409].includes(failure.status)) throw error;
        db.exec('ROLLBACK TO appointment_state_change');
        db.exec('RELEASE appointment_state_change');
        const rejection: Rejection = {
          status: failure.status,
          body: {
            error: failure.message,
            stateChangeOutcome: 'not-applied',
            requestId: input.requestId,
            actorId: user.id,
            patientId: appointment.patientId,
            appointmentId,
          },
        };
        db.prepare(
          'INSERT INTO appointmentStateChangeCommands(requestId,actorId,appointmentId,operation,payload,rejection) VALUES (?,?,?,?,?,?)',
        ).run(
          input.requestId,
          user.id,
          appointmentId,
          'state-change',
          payload,
          JSON.stringify(rejection),
        );
        return { status: rejection.status, body: rejection.body };
      }
    });
    res.status(response.status).json(response.body);
  });
}
