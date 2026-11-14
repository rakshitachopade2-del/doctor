import type { Express } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AuthRequest } from './app.ts';
import type { createScheduling } from './scheduling.ts';
import type { createClinicResources } from './clinic-resources.ts';
import { get, id, nowISO, type DB } from './db.ts';
import { notifyPatient } from './activity.ts';
import type { Appointment, Doctor, Patient, User } from '../shared/types.ts';
import type {
  VisitDurationContext,
  VisitDurationEvent,
  VisitDurationMutation,
} from '../shared/visit-duration.ts';

interface Dependencies {
  db: DB;
  actor: (req: AuthRequest, roles?: User['role'][]) => User;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
  patientAccess: (req: AuthRequest, patientId: string, allowReception?: boolean) => Patient;
  appointmentGet: (req: AuthRequest, appointmentId: string) => Appointment;
  scheduling: ReturnType<typeof createScheduling>;
  clinicResources: ReturnType<typeof createClinicResources>;
}
const identifier = z.string().trim().min(1).max(300);
const date = z
  .string()
  .refine(
    (value) =>
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number.isFinite(Date.parse(`${value}T12:00:00Z`)) &&
      new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value,
    'Use a real calendar date (YYYY-MM-DD).',
  );
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Use a real time (HH:mm).');
const mode = z.enum(['in-person', 'online']);
const duration = z.number().int().min(15).max(240).multipleOf(5);
const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const revision = z.string().regex(/^[a-f0-9]{64}$/, 'Refresh the appointment before saving.');
const policy = z.enum(['custom', 'schedule']);
const durationChoice = (value: { durationPolicy: string; durationMinutes?: number }) =>
  value.durationPolicy === 'custom'
    ? value.durationMinutes !== undefined
    : value.durationMinutes === undefined;
const choiceMessage = 'Custom visits require minutes; schedule-default visits must omit minutes.';
const slotsSchema = z
  .object({
    doctorId: identifier,
    patientId: identifier,
    date,
    mode,
    durationPolicy: policy,
    durationMinutes: z.string().regex(/^\d+$/).transform(Number).pipe(duration).optional(),
    excludeAppointmentId: identifier.optional(),
  })
  .strict()
  .refine(durationChoice, choiceMessage);
const bookingSchema = z
  .object({
    patientId: identifier,
    doctorId: identifier,
    date,
    time,
    mode,
    reason: z.string().trim().min(1).max(300),
    durationMinutes: duration,
    requestId: uuid,
  })
  .strict();
const changeSchema = z
  .object({
    durationPolicy: policy,
    durationMinutes: duration.optional(),
    date,
    time,
    reason: z.string().trim().min(1).max(1000),
    expectedRevision: revision,
    requestId: uuid,
  })
  .strict()
  .refine(durationChoice, choiceMessage);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canChange = (appointment: Appointment) =>
  appointment.status === 'scheduled' &&
  Date.parse(`${appointment.date}T${appointment.time}:00+05:30`) > Date.now();

export function registerVisitDuration(app: Express, dependencies: Dependencies) {
  const { db, actor, audit, fail, patientAccess, appointmentGet, scheduling, clinicResources } =
    dependencies;
  db.exec(`
    CREATE TABLE IF NOT EXISTS visitDurationEvents (
      id TEXT PRIMARY KEY, appointmentId TEXT NOT NULL REFERENCES appointments(id), data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS visit_duration_events_appointment ON visitDurationEvents(appointmentId);
    CREATE TABLE IF NOT EXISTS visitDurationCommands (
      requestId TEXT PRIMARY KEY, actorId TEXT NOT NULL REFERENCES users(id), operation TEXT NOT NULL,
      targetId TEXT NOT NULL, payload TEXT NOT NULL, eventId TEXT NOT NULL REFERENCES visitDurationEvents(id)
    );
  `);
  for (const table of ['visitDurationEvents', 'visitDurationCommands'])
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT,'Visit duration evidence is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT,'Visit duration evidence is immutable'); END;
    `);
  const staff = (req: AuthRequest) => actor(req, ['admin', 'doctor', 'receptionist']);
  function history(appointmentId: string): VisitDurationEvent[] {
    return db
      .prepare('SELECT data FROM visitDurationEvents WHERE appointmentId=? ORDER BY rowid DESC')
      .all(appointmentId)
      .map((row) => JSON.parse(row.data as string) as VisitDurationEvent);
  }
  function context(req: AuthRequest, appointmentId: string): VisitDurationContext {
    const appointment = appointmentGet(req, appointmentId);
    const schedule = scheduling.schedule(appointment.doctorId);
    const doctor = get<Doctor>(db, 'doctors', appointment.doctorId)!;
    const events = history(appointmentId);
    return {
      appointment,
      revision: digest([appointment, schedule, doctor.fee, doctor.name, events[0]?.id ?? null]),
      scheduleDurationMinutes: schedule.durationMinutes,
      currentDoctorFee: doctor.fee,
      currentDoctorName: doctor.name,
      canChange: canChange(appointment),
      history: events,
    };
  }
  function replay(
    req: AuthRequest,
    user: User,
    operation: VisitDurationEvent['operation'],
    targetId: string,
    input: { requestId: string },
  ): VisitDurationMutation | null {
    const row = db
      .prepare('SELECT * FROM visitDurationCommands WHERE requestId=?')
      .get(input.requestId);
    if (!row) return null;
    if (
      row.actorId !== user.id ||
      row.operation !== operation ||
      row.targetId !== targetId ||
      row.payload !== JSON.stringify(input)
    )
      return fail(409, 'This request ID was already used for a different command.');
    const event = get<VisitDurationEvent>(db, 'visitDurationEvents', row.eventId as string)!;
    return { appointment: appointmentGet(req, event.appointmentId), event };
  }
  function record(
    req: AuthRequest,
    user: User,
    operation: VisitDurationEvent['operation'],
    targetId: string,
    input: { requestId: string },
    before: Appointment | null,
    after: Appointment,
    reason: string,
    expectedRevision: string | null,
  ): VisitDurationMutation {
    const event: VisitDurationEvent = {
      id: id(),
      appointmentId: after.id,
      operation,
      requestId: input.requestId,
      expectedRevision,
      before,
      after,
      reason,
      createdById: user.id,
      createdByName: user.name,
      createdByRole: user.role as VisitDurationEvent['createdByRole'],
      createdAt: nowISO(),
    };
    db.prepare('INSERT INTO visitDurationEvents(id,appointmentId,data) VALUES (?,?,?)').run(
      event.id,
      after.id,
      JSON.stringify(event),
    );
    db.prepare(
      'INSERT INTO visitDurationCommands(requestId,actorId,operation,targetId,payload,eventId) VALUES (?,?,?,?,?,?)',
    ).run(input.requestId, user.id, operation, targetId, JSON.stringify(input), event.id);
    audit(
      req,
      operation === 'custom-booking'
        ? 'booked custom-length appointment'
        : 'changed visit duration',
      'appointment',
      after.id,
    );
    notifyPatient(db, after.patientId, `visit-duration:${event.id}`, {
      kind: 'appointment',
      title:
        operation === 'custom-booking'
          ? 'Your appointment is booked'
          : 'Your visit length was updated',
      detail: `${after.date} at ${after.time} IST · ${after.durationMinutes ?? 30} minutes · ${after.doctorName}`,
      href: '/my-care',
    });
    return { appointment: after, event };
  }
  app.get('/api/visit-duration/slots', (req: AuthRequest, res) => {
    staff(req);
    const input = slotsSchema.parse(req.query);
    patientAccess(req, input.patientId, true);
    if (
      input.excludeAppointmentId &&
      appointmentGet(req, input.excludeAppointmentId).patientId !== input.patientId
    )
      fail(400, 'The appointment must belong to the selected patient.');
    const customDurationMinutes =
      input.durationPolicy === 'custom' ? input.durationMinutes : undefined;
    const slots = scheduling.availableSlots({ ...input, customDurationMinutes });
    const minutes = customDurationMinutes ?? scheduling.schedule(input.doctorId).durationMinutes;
    res.json(
      input.excludeAppointmentId
        ? clinicResources.availableSlotsForAppointment(
            input.excludeAppointmentId,
            input.date,
            slots,
            minutes,
          )
        : slots,
    );
  });
  app.post('/api/visit-duration/bookings', (req: AuthRequest, res) => {
    const user = staff(req);
    const input = bookingSchema.parse(req.body);
    let repeated = false;
    const result = scheduling.transaction(() => {
      const prior = replay(req, user, 'custom-booking', '', input);
      if (prior) {
        repeated = true;
        return prior;
      }
      const patient = patientAccess(req, input.patientId, true);
      const durationMinutes = scheduling.validateBooking({
        ...input,
        customDurationMinutes: input.durationMinutes,
      });
      const doctor = get<Doctor>(db, 'doctors', input.doctorId)!;
      const appointment: Appointment = {
        id: id(),
        patientId: patient.id,
        patientName: patient.name,
        doctorId: doctor.id,
        doctorName: doctor.name,
        date: input.date,
        time: input.time,
        mode: input.mode,
        reason: input.reason,
        durationMinutes,
        durationPolicy: 'custom',
        fee: doctor.fee,
        status: 'scheduled',
        createdAt: nowISO(),
      };
      db.prepare(
        'INSERT INTO appointments(id,patientId,doctorId,date,time,status,data) VALUES (?,?,?,?,?,?,?)',
      ).run(
        appointment.id,
        patient.id,
        doctor.id,
        appointment.date,
        appointment.time,
        appointment.status,
        JSON.stringify(appointment),
      );
      return record(
        req,
        user,
        'custom-booking',
        '',
        input,
        null,
        appointment,
        'Booked a custom-length visit.',
        null,
      );
    });
    res.status(repeated ? 200 : 201).json(result);
  });
  app.get('/api/appointments/:id/duration', (req: AuthRequest, res) => {
    staff(req);
    const result = scheduling.transaction(() => {
      const value = context(req, String(req.params.id));
      audit(req, 'viewed visit duration history', 'appointment', value.appointment.id);
      return value;
    });
    res.json(result);
  });
  app.post('/api/appointments/:id/duration', (req: AuthRequest, res) => {
    const user = staff(req);
    const appointmentId = String(req.params.id);
    const input = changeSchema.parse(req.body);
    const result = scheduling.transaction(() => {
      const prior = replay(req, user, 'duration-change', appointmentId, input);
      if (prior) return prior;
      const current = context(req, appointmentId);
      if (input.expectedRevision !== current.revision)
        return fail(
          409,
          'The appointment or doctor details changed. Review the latest visit before saving.',
        );
      const before = current.appointment;
      if (!current.canChange)
        return fail(409, 'Only future scheduled visits can have their length changed.');
      const durationMinutes = scheduling.validateBooking({
        doctorId: before.doctorId,
        patientId: before.patientId,
        mode: before.mode,
        date: input.date,
        time: input.time,
        excludeAppointmentId: before.id,
        customDurationMinutes:
          input.durationPolicy === 'custom' ? input.durationMinutes : undefined,
      });
      if (
        before.date === input.date &&
        before.time === input.time &&
        (before.durationPolicy ?? 'schedule') === input.durationPolicy &&
        (before.durationMinutes ?? 30) === durationMinutes
      )
        return fail(400, 'The visit length, policy and scheduled time are unchanged.');
      const moved = before.date !== input.date || before.time !== input.time;
      const after: Appointment = {
        ...before,
        date: input.date,
        time: input.time,
        durationPolicy: input.durationPolicy,
        durationMinutes,
        fee: moved ? current.currentDoctorFee : before.fee,
        doctorName: moved ? current.currentDoctorName : before.doctorName,
      };
      clinicResources.appointmentChanged(req, before, after);
      db.prepare('UPDATE appointments SET date=?,time=?,data=? WHERE id=?').run(
        after.date,
        after.time,
        JSON.stringify(after),
        after.id,
      );
      return record(
        req,
        user,
        'duration-change',
        appointmentId,
        input,
        before,
        after,
        input.reason,
        input.expectedRevision,
      );
    });
    res.json(result);
  });
}
