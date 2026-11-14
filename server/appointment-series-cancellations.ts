import { createHash } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import type { AuthRequest } from './app.ts';
import type { registerAppointmentSeries } from './appointment-series.ts';
import type { createClinicResources } from './clinic-resources.ts';
import type { createScheduling } from './scheduling.ts';
import type { Appointment, Patient } from '../shared/types.ts';
import type {
  SeriesCancellationContext,
  SeriesCancellationEvent,
  SeriesCancellationPage,
  SeriesCancellationPreview,
  SeriesCancellationResult,
  SeriesCancellationVisit,
} from '../shared/appointment-series-cancellations.ts';
import { id, nowISO, type DB } from './db.ts';
import { notifyPatient } from './activity.ts';

interface Context {
  db: DB;
  patientAccess: (req: AuthRequest, patientId: string, allowReception?: boolean) => Patient;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
  scheduling: ReturnType<typeof createScheduling>;
  clinicResources: ReturnType<typeof createClinicResources>;
  series: ReturnType<typeof registerAppointmentSeries>;
}

const reference = z.string().trim().min(1).max(300);
const selection = z
  .array(reference)
  .min(1)
  .max(12)
  .refine((values) => new Set(values).size === values.length, 'Select each appointment only once.');
const empty = z.object({}).strict();
const previewSchema = z.object({ appointmentIds: selection }).strict();
const commandSchema = z
  .object({
    appointmentIds: selection,
    reason: z.string().trim().min(1).max(1000),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
    patientConfirmed: z.literal(true),
    requestId: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
  })
  .strict();
const pageSchema = z
  .object({
    page: z
      .string()
      .regex(/^[1-9]\d{0,6}$/)
      .transform(Number)
      .refine((value) => value <= 1000000)
      .default(1),
    pageSize: z.enum(['10', '25', '50']).transform(Number).default(25),
  })
  .strict();
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function eligibility(appointment: Appointment, asOf = Date.now()): string | null {
  if (appointment.status !== 'scheduled')
    return 'Only scheduled appointments can be cancelled together.';
  if (!(Date.parse(`${appointment.date}T${appointment.time}:00+05:30`) > asOf))
    return 'This appointment has reached or passed its scheduled start.';
  return null;
}

export function registerAppointmentSeriesCancellations(app: Express, context: Context) {
  const { db, patientAccess, audit, fail, scheduling, clinicResources, series } = context;
  db.exec(`
    CREATE TABLE IF NOT EXISTS appointmentSeriesCancellations (
      id TEXT PRIMARY KEY,
      seriesId TEXT NOT NULL REFERENCES appointmentSeries(id),
      requestId TEXT NOT NULL UNIQUE REFERENCES appointmentSeriesCommands(requestId),
      createdAt TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS appointment_series_cancellations_series_created
      ON appointmentSeriesCancellations(seriesId,createdAt DESC,id DESC);
    CREATE TRIGGER IF NOT EXISTS appointmentSeriesCancellations_immutable_update
      BEFORE UPDATE ON appointmentSeriesCancellations
      BEGIN SELECT RAISE(ABORT,'Appointment series cancellations are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS appointmentSeriesCancellations_immutable_delete
      BEFORE DELETE ON appointmentSeriesCancellations
      BEGIN SELECT RAISE(ABORT,'Appointment series cancellations are immutable'); END;
  `);

  function source(req: AuthRequest, seriesId: string) {
    const detail = series.detail(seriesId);
    const currentPatient = patientAccess(req, detail.series.patient.id, true);
    if (detail.appointments.some((appointment) => appointment.patientId !== currentPatient.id))
      return fail(500, 'Appointment series membership is inconsistent.');
    return {
      detail,
      patient: { id: currentPatient.id, name: currentPatient.name, phone: currentPatient.phone },
    };
  }

  function normalize(appointments: Appointment[], selected: string[]) {
    const requested = new Set(selected);
    const values = appointments.filter((appointment) => requested.has(appointment.id));
    if (values.length !== selected.length)
      return fail(400, 'Select only appointments belonging to this series.');
    return values.map((appointment) => appointment.id);
  }

  function reservationSource(appointmentIds: string[]) {
    const placeholders = appointmentIds.map(() => '?').join(',');
    const reservations = db
      .prepare(
        `
      SELECT appointmentId,resourceId,startAt,endAt,data FROM resourceReservations
      WHERE appointmentId IN (${placeholders}) ORDER BY appointmentId,resourceId
    `,
      )
      .all(...appointmentIds);
    const heads = appointmentIds.map((appointmentId) => ({
      appointmentId,
      eventId:
        db
          .prepare(
            'SELECT id FROM resourceAllocationEvents WHERE appointmentId=? ORDER BY rowid DESC LIMIT 1',
          )
          .get(appointmentId)?.id ?? null,
    }));
    return { reservations, heads };
  }

  function visits(
    appointments: Appointment[],
    appointmentIds: string[],
    reservations: ReturnType<typeof reservationSource>['reservations'],
    asOf: number,
  ): SeriesCancellationVisit[] {
    const selected = new Set(appointmentIds);
    return appointments.flatMap((appointment, index) => {
      if (!selected.has(appointment.id)) return [];
      const blockedReason = eligibility(appointment, asOf);
      return [
        {
          position: index + 1,
          appointment,
          eligible: blockedReason === null,
          blockedReason,
          reservationCount: reservations.filter((row) => row.appointmentId === appointment.id)
            .length,
        },
      ];
    });
  }

  function preview(
    req: AuthRequest,
    seriesId: string,
    selected: string[],
  ): SeriesCancellationPreview {
    const asOf = Date.now();
    const current = source(req, seriesId);
    const appointmentIds = normalize(current.detail.appointments, selected);
    const resources = reservationSource(appointmentIds);
    const rows = visits(current.detail.appointments, appointmentIds, resources.reservations, asOf);
    return {
      seriesId,
      patient: current.patient,
      appointmentIds,
      visits: rows,
      canCancel: rows.every((row) => row.eligible),
      revision: digest([seriesId, current.patient, appointmentIds, rows, resources]),
      generatedAt: new Date(asOf).toISOString(),
    };
  }

  const base = '/api/appointment-series/:id/cancellations';
  app.get(`${base}/context`, (req: AuthRequest, res) => {
    empty.parse(req.query);
    const seriesId = reference.parse(req.params.id);
    const value = scheduling.transaction((): SeriesCancellationContext => {
      series.authorize(req);
      const asOf = Date.now();
      const current = source(req, seriesId);
      const appointmentIds = current.detail.appointments.map((appointment) => appointment.id);
      const resources = reservationSource(appointmentIds);
      audit(req, 'viewed appointment series cancellation context', 'appointment-series', seriesId);
      return {
        seriesId,
        patient: current.patient,
        visits: visits(current.detail.appointments, appointmentIds, resources.reservations, asOf),
        generatedAt: new Date(asOf).toISOString(),
      };
    });
    res.json(value);
  });

  app.post(`${base}/preview`, (req: AuthRequest, res) => {
    empty.parse(req.query);
    const seriesId = reference.parse(req.params.id);
    const input = previewSchema.parse(req.body);
    const value = scheduling.transaction(() => {
      series.authorize(req);
      const result = preview(req, seriesId, input.appointmentIds);
      audit(req, 'previewed appointment series cancellation', 'appointment-series', seriesId);
      return result;
    });
    res.json(value);
  });

  app.get(base, (req: AuthRequest, res) => {
    const seriesId = reference.parse(req.params.id);
    const query = pageSchema.parse(req.query);
    const value = scheduling.transaction((): SeriesCancellationPage => {
      series.authorize(req);
      source(req, seriesId);
      const total = Number(
        db
          .prepare('SELECT COUNT(*) AS n FROM appointmentSeriesCancellations WHERE seriesId=?')
          .get(seriesId)!.n,
      );
      const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
      const page = Math.min(query.page, totalPages);
      const items = db
        .prepare(
          'SELECT data FROM appointmentSeriesCancellations WHERE seriesId=? ORDER BY createdAt DESC,id DESC LIMIT ? OFFSET ?',
        )
        .all(seriesId, query.pageSize, (page - 1) * query.pageSize)
        .map((row) => JSON.parse(row.data as string) as SeriesCancellationEvent);
      audit(req, 'viewed appointment series cancellation history', 'appointment-series', seriesId);
      return { items, page, pageSize: query.pageSize, total, totalPages };
    });
    res.json(value);
  });

  app.post(base, (req: AuthRequest, res) => {
    empty.parse(req.query);
    const seriesId = reference.parse(req.params.id);
    const input = commandSchema.parse(req.body);
    let repeated = false;
    const value = scheduling.transaction((): SeriesCancellationResult => {
      const user = series.authorize(req);
      const current = source(req, seriesId);
      const appointmentIds = normalize(current.detail.appointments, input.appointmentIds);
      const payload = JSON.stringify({ ...input, appointmentIds, seriesId });
      const previous = db
        .prepare(
          'SELECT actorId,operation,payload,seriesId FROM appointmentSeriesCommands WHERE requestId=?',
        )
        .get(input.requestId);
      if (previous) {
        if (
          previous.actorId !== user.id ||
          previous.operation !== 'cancel' ||
          previous.seriesId !== seriesId ||
          previous.payload !== payload
        )
          return fail(
            409,
            'This request ID was already used for different appointment series details.',
          );
        const row = db
          .prepare(
            'SELECT data FROM appointmentSeriesCancellations WHERE requestId=? AND seriesId=?',
          )
          .get(input.requestId, seriesId);
        if (!row) return fail(500, 'The recorded cancellation receipt is missing.');
        repeated = true;
        return {
          event: JSON.parse(row.data as string) as SeriesCancellationEvent,
          detail: current.detail,
        };
      }

      const checked = preview(req, seriesId, appointmentIds);
      if (checked.revision !== input.expectedRevision)
        return fail(
          409,
          'The selected visits or reservations changed. Preview the cancellation again.',
        );
      if (!checked.canCancel)
        return fail(
          409,
          'Every selected visit must be scheduled in the future. No appointments were cancelled.',
        );

      const changes: SeriesCancellationEvent['visits'] = [];
      for (const visit of checked.visits) {
        if (eligibility(visit.appointment) !== null)
          return fail(
            409,
            'A selected visit has reached its scheduled start. No appointments were cancelled.',
          );
        const before = visit.appointment;
        const after: Appointment = { ...before, status: 'cancelled' };
        clinicResources.appointmentChanged(req, before, after);
        const updated = db
          .prepare(
            "UPDATE appointments SET status='cancelled',data=? WHERE id=? AND status='scheduled'",
          )
          .run(JSON.stringify(after), before.id);
        if (Number(updated.changes) !== 1)
          return fail(409, 'A selected appointment changed. No appointments were cancelled.');
        changes.push({
          position: visit.position,
          before,
          after,
          releasedReservationCount: visit.reservationCount,
        });
      }
      const event: SeriesCancellationEvent = {
        id: id(),
        seriesId,
        appointmentIds,
        reason: input.reason,
        patientConfirmed: true,
        requestId: input.requestId,
        expectedRevision: input.expectedRevision,
        createdById: user.id,
        createdByName: user.name,
        createdByRole: user.role,
        createdAt: nowISO(),
        visits: changes,
      };
      db.prepare(
        'INSERT INTO appointmentSeriesCommands(requestId,actorId,operation,payload,seriesId) VALUES (?,?,?,?,?)',
      ).run(input.requestId, user.id, 'cancel', payload, seriesId);
      db.prepare(
        'INSERT INTO appointmentSeriesCancellations(id,seriesId,requestId,createdAt,data) VALUES (?,?,?,?,?)',
      ).run(event.id, seriesId, event.requestId, event.createdAt, JSON.stringify(event));
      audit(req, 'cancelled appointment series visits', 'appointment-series', seriesId);
      for (const visit of changes) {
        audit(req, 'appointment cancelled', 'appointment', visit.after.id);
        notifyPatient(
          db,
          visit.after.patientId,
          `appointment-series-cancelled:${event.id}:${visit.after.id}`,
          {
            kind: 'appointment',
            title: 'Appointment cancelled',
            detail: `${visit.after.date} at ${visit.after.time} IST · ${visit.after.durationMinutes ?? 30} minutes · ${visit.after.doctorName}`,
            href: '/my-care/record?tab=visits',
          },
        );
      }
      return { event, detail: series.detail(seriesId) };
    });
    res.status(repeated ? 200 : 201).json(value);
  });
}
