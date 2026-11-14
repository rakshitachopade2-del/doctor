import { createHash } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import type { AuthRequest } from './app.ts';
import type { registerAppointmentSeries } from './appointment-series.ts';
import type { createClinicResources } from './clinic-resources.ts';
import type { createScheduling } from './scheduling.ts';
import type { Appointment, Doctor, Patient } from '../shared/types.ts';
import type {
  SeriesRescheduleContext,
  SeriesRescheduleMove,
  SeriesReschedulePreview,
  SeriesRescheduleEvent,
  SeriesRescheduleResult,
  SeriesReschedulePage,
} from '../shared/appointment-series-rescheduling.ts';
import { addDays, get, id, nowISO, type DB } from './db.ts';
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
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = Date.parse(`${value}T12:00:00Z`);
    return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
  }, 'Use a real calendar date.');
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const movesSchema = z
  .array(z.object({ appointmentId: reference, date, time }).strict())
  .min(1)
  .max(12)
  .refine(
    (values) => new Set(values.map((move) => move.appointmentId)).size === values.length,
    'Select each appointment only once.',
  );
const empty = z.object({}).strict();
const previewSchema = z.object({ moves: movesSchema }).strict();
const commandSchema = z
  .object({
    moves: movesSchema,
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
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const epoch = (value: Pick<Appointment, 'date' | 'time'>) =>
  Date.parse(`${value.date}T${value.time}:00+05:30`);
const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
const clinicDateAt = (asOf: number) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(asOf));
function sourceEligibility(appointment: Appointment, asOf: number) {
  if (appointment.status !== 'scheduled')
    return 'Only scheduled appointments can be moved together.';
  if (!(epoch(appointment) > asOf))
    return 'This appointment has reached or passed its scheduled start.';
  return null;
}
function knownConflict(error: unknown): error is Error & { status: 400 | 409 } {
  return error instanceof Error && 'status' in error && [400, 409].includes(Number(error.status));
}

export function registerAppointmentSeriesRescheduling(app: Express, context: Context) {
  const { db, patientAccess, audit, fail, scheduling, clinicResources, series } = context;
  db.exec(`
    CREATE TABLE IF NOT EXISTS appointmentSeriesReschedules (
      id TEXT PRIMARY KEY, seriesId TEXT NOT NULL REFERENCES appointmentSeries(id),
      requestId TEXT NOT NULL UNIQUE REFERENCES appointmentSeriesCommands(requestId), createdAt TEXT NOT NULL, data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS appointment_series_reschedules_series_created ON appointmentSeriesReschedules(seriesId,createdAt DESC,id DESC);
    CREATE TRIGGER IF NOT EXISTS appointmentSeriesReschedules_immutable_update BEFORE UPDATE ON appointmentSeriesReschedules
      BEGIN SELECT RAISE(ABORT,'Appointment series reschedules are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS appointmentSeriesReschedules_immutable_delete BEFORE DELETE ON appointmentSeriesReschedules
      BEGIN SELECT RAISE(ABORT,'Appointment series reschedules are immutable'); END;
  `);
  function source(req: AuthRequest, seriesId: string) {
    const detail = series.detail(seriesId);
    const current = patientAccess(req, detail.series.patient.id, true);
    if (detail.appointments.some((appointment) => appointment.patientId !== current.id))
      return fail(500, 'Appointment series membership is inconsistent.');
    return { detail, patient: { id: current.id, name: current.name, phone: current.phone } };
  }
  function normalize(appointments: Appointment[], moves: SeriesRescheduleMove[]) {
    const selected = new Map(moves.map((move) => [move.appointmentId, move]));
    const result = appointments.flatMap((appointment) =>
      selected.has(appointment.id) ? [selected.get(appointment.id)!] : [],
    );
    if (result.length !== moves.length)
      return fail(400, 'Select only appointments belonging to this series.');
    return result;
  }
  function endOf(appointment: Appointment) {
    const end = new Date(
      Date.parse(`${appointment.date}T${appointment.time}:00Z`) +
        (appointment.durationMinutes ?? 30) * 60000,
    ).toISOString();
    if (!/^\d{4}-/.test(end))
      return fail(400, 'Target visit dates must remain within four-digit calendar years.');
    return { endDate: end.slice(0, 10), endTime: end.slice(11, 16) };
  }
  function preview(
    req: AuthRequest,
    seriesId: string,
    requested: SeriesRescheduleMove[],
  ): SeriesReschedulePreview {
    const asOf = Date.now(),
      clinicDate = clinicDateAt(asOf),
      horizonEndDate = addDays(clinicDate, 180);
    const current = source(req, seriesId),
      moves = normalize(current.detail.appointments, requested);
    const selectedIds = moves.map((move) => move.appointmentId),
      placeholders = selectedIds.map(() => '?').join(',');
    const doctors = new Map<
      string,
      { id: string; name: string; fee: number; schedule: ReturnType<typeof scheduling.schedule> }
    >();
    const sources: unknown[] = [];
    const visits: SeriesReschedulePreview['visits'] = moves.map((move) => {
      const position = current.detail.appointments.findIndex(
        (appointment) => appointment.id === move.appointmentId,
      );
      const before = current.detail.appointments[position];
      let doctor = doctors.get(before.doctorId);
      if (!doctor) {
        const record = get<Doctor>(db, 'doctors', before.doctorId);
        if (!record) return fail(404, 'Doctor not found.');
        doctor = {
          id: record.id,
          name: record.name,
          fee: record.fee,
          schedule: scheduling.schedule(record.id),
        };
        doctors.set(record.id, doctor);
      }
      const moved = before.date !== move.date || before.time !== move.time;
      const after: Appointment = moved
        ? {
            ...before,
            date: move.date,
            time: move.time,
            durationMinutes:
              before.durationPolicy === 'custom'
                ? (before.durationMinutes ?? 30)
                : doctor.schedule.durationMinutes,
            doctorName: doctor.name,
            fee: doctor.fee,
          }
        : { ...before };
      let blockedReason = sourceEligibility(before, asOf);
      if (!moved) blockedReason ??= 'Choose a different date or time for every selected visit.';
      try {
        scheduling.validateBooking(
          {
            patientId: before.patientId,
            doctorId: before.doctorId,
            mode: before.mode,
            date: move.date,
            time: move.time,
            customDurationMinutes:
              before.durationPolicy === 'custom' ? (before.durationMinutes ?? 30) : undefined,
          },
          { excludeAppointmentIds: selectedIds, asOf },
        );
      } catch (error) {
        if (!knownConflict(error)) throw error;
        blockedReason ??= error.message;
      }
      const start = minutes(move.time),
        end = start + (after.durationMinutes ?? 30);
      const closures = db
        .prepare(
          'SELECT id,doctorId,startDate,endDate,data FROM scheduleClosures WHERE (doctorId IS NULL OR doctorId=?) AND startDate<=? AND endDate>=? ORDER BY id',
        )
        .all(before.doctorId, move.date, move.date);
      const busy = db
        .prepare(
          `SELECT id,patientId,doctorId,date,time,status,COALESCE(json_extract(data,'$.durationMinutes'),30) AS durationMinutes FROM appointments
        WHERE date=? AND (doctorId=? OR patientId=?) AND id NOT IN (${placeholders}) AND status NOT IN ('cancelled','no-show')
        AND (CAST(substr(time,1,2) AS INTEGER)*60+CAST(substr(time,4,2) AS INTEGER))<?
        AND (CAST(substr(time,1,2) AS INTEGER)*60+CAST(substr(time,4,2) AS INTEGER)+COALESCE(json_extract(data,'$.durationMinutes'),30))>? ORDER BY id`,
        )
        .all(move.date, before.doctorId, before.patientId, ...selectedIds, end, start);
      sources.push({ appointmentId: before.id, closures, busy });
      return {
        position: position + 1,
        before,
        after,
        ...endOf(after),
        reservationCount: 0,
        eligible: blockedReason === null,
        blockedReason,
      };
    });
    for (let left = 0; left < visits.length; left++) {
      for (let right = left + 1; right < visits.length; right++) {
        const a = visits[left].after,
          b = visits[right].after;
        if (
          (a.doctorId === b.doctorId || a.patientId === b.patientId) &&
          epoch(a) < epoch(b) + (b.durationMinutes ?? 30) * 60000 &&
          epoch(b) < epoch(a) + (a.durationMinutes ?? 30) * 60000
        ) {
          visits[left].blockedReason ??=
            'Selected target visits overlap for the patient or clinician.';
          visits[right].blockedReason ??=
            'Selected target visits overlap for the patient or clinician.';
        }
      }
    }
    const resources = clinicResources.previewAppointmentMoves(
      visits.map(({ before, after }) => ({ before, after })),
    );
    visits.forEach((visit) => {
      const resource = resources.visits.find((entry) => entry.appointmentId === visit.before.id)!;
      visit.reservationCount = resource.reservationCount;
      visit.blockedReason ??= resource.blockedReason;
      visit.eligible = visit.blockedReason === null;
    });
    return {
      seriesId,
      patient: current.patient,
      moves,
      visits,
      canReschedule: visits.every((visit) => visit.eligible),
      revision: hash([
        seriesId,
        current.patient,
        moves,
        visits,
        [...doctors.values()],
        sources,
        resources.revision,
        clinicDate,
        horizonEndDate,
      ]),
      clinicDate,
      horizonEndDate,
      generatedAt: new Date(asOf).toISOString(),
    };
  }
  const base = '/api/appointment-series/:id/reschedules';
  app.get(`${base}/context`, (req: AuthRequest, res) => {
    empty.parse(req.query);
    const seriesId = reference.parse(req.params.id);
    res.json(
      scheduling.transaction((): SeriesRescheduleContext => {
        series.authorize(req);
        const asOf = Date.now(),
          clinicDate = clinicDateAt(asOf),
          current = source(req, seriesId);
        const counts = db
          .prepare(
            'SELECT r.appointmentId,COUNT(*) AS n FROM resourceReservations r JOIN appointmentSeriesMembers m ON m.appointmentId=r.appointmentId WHERE m.seriesId=? GROUP BY r.appointmentId',
          )
          .all(seriesId);
        const visits = current.detail.appointments.map((appointment, index) => {
          const blockedReason = sourceEligibility(appointment, asOf);
          return {
            position: index + 1,
            appointment,
            eligible: blockedReason === null,
            blockedReason,
            reservationCount: Number(
              counts.find((row) => row.appointmentId === appointment.id)?.n ?? 0,
            ),
          };
        });
        audit(
          req,
          'viewed appointment series rescheduling context',
          'appointment-series',
          seriesId,
        );
        return {
          seriesId,
          patient: current.patient,
          visits,
          clinicDate,
          horizonEndDate: addDays(clinicDate, 180),
          generatedAt: new Date(asOf).toISOString(),
        };
      }),
    );
  });
  app.post(`${base}/preview`, (req: AuthRequest, res) => {
    empty.parse(req.query);
    const seriesId = reference.parse(req.params.id),
      input = previewSchema.parse(req.body);
    res.json(
      scheduling.transaction(() => {
        series.authorize(req);
        const result = preview(req, seriesId, input.moves);
        audit(req, 'previewed appointment series reschedule', 'appointment-series', seriesId);
        return result;
      }),
    );
  });
  app.get(base, (req: AuthRequest, res) => {
    const seriesId = reference.parse(req.params.id),
      query = pageSchema.parse(req.query);
    res.json(
      scheduling.transaction((): SeriesReschedulePage => {
        series.authorize(req);
        source(req, seriesId);
        const total = Number(
          db
            .prepare('SELECT COUNT(*) AS n FROM appointmentSeriesReschedules WHERE seriesId=?')
            .get(seriesId)!.n,
        );
        const totalPages = Math.max(1, Math.ceil(total / query.pageSize)),
          page = Math.min(query.page, totalPages);
        const items = db
          .prepare(
            'SELECT data FROM appointmentSeriesReschedules WHERE seriesId=? ORDER BY createdAt DESC,id DESC LIMIT ? OFFSET ?',
          )
          .all(seriesId, query.pageSize, (page - 1) * query.pageSize)
          .map((row) => JSON.parse(String(row.data)) as SeriesRescheduleEvent);
        audit(
          req,
          'viewed appointment series rescheduling history',
          'appointment-series',
          seriesId,
        );
        return { items, page, pageSize: query.pageSize, total, totalPages };
      }),
    );
  });
  app.post(base, (req: AuthRequest, res) => {
    empty.parse(req.query);
    const seriesId = reference.parse(req.params.id),
      input = commandSchema.parse(req.body);
    let repeated = false;
    const value = scheduling.transaction((): SeriesRescheduleResult => {
      const user = series.authorize(req),
        current = source(req, seriesId),
        moves = normalize(current.detail.appointments, input.moves);
      const payload = JSON.stringify({ ...input, moves, seriesId });
      const prior = db
        .prepare(
          'SELECT actorId,operation,payload,seriesId FROM appointmentSeriesCommands WHERE requestId=?',
        )
        .get(input.requestId);
      if (prior) {
        if (
          prior.actorId !== user.id ||
          prior.operation !== 'reschedule' ||
          prior.payload !== payload ||
          prior.seriesId !== seriesId
        )
          return fail(
            409,
            'This request ID was already used for different appointment series details.',
          );
        const row = db
          .prepare('SELECT data FROM appointmentSeriesReschedules WHERE requestId=? AND seriesId=?')
          .get(input.requestId, seriesId);
        if (!row) return fail(500, 'The recorded rescheduling receipt is missing.');
        repeated = true;
        return {
          event: JSON.parse(String(row.data)) as SeriesRescheduleEvent,
          detail: current.detail,
        };
      }
      const checked = preview(req, seriesId, moves);
      if (checked.revision !== input.expectedRevision)
        return fail(
          409,
          'The selected visits, target availability or fees changed. Preview every move again.',
        );
      if (!checked.canReschedule)
        return fail(
          409,
          'Every selected move must be available and change the date or time. No appointments were moved.',
        );
      const selectedIds = moves.map((move) => move.appointmentId);
      for (const visit of checked.visits) {
        if (sourceEligibility(visit.before, Date.now()))
          return fail(
            409,
            'A selected visit has reached its scheduled start. No appointments were moved.',
          );
        try {
          scheduling.validateBooking(
            {
              patientId: visit.after.patientId,
              doctorId: visit.after.doctorId,
              mode: visit.after.mode,
              date: visit.after.date,
              time: visit.after.time,
              customDurationMinutes:
                visit.before.durationPolicy === 'custom'
                  ? (visit.before.durationMinutes ?? 30)
                  : undefined,
            },
            { excludeAppointmentIds: selectedIds },
          );
        } catch (error) {
          if (!knownConflict(error)) throw error;
          return fail(409, 'A target visit is no longer available. Preview every move again.');
        }
      }
      // SQLite checks these UNIQUE keys immediately, even within a multi-row UPDATE.
      // Vacate selected keys only inside this locked transaction. JSON originals stay
      // unchanged; this internal stage emits no cancellation history, audit or notice.
      const staged = db
        .prepare(
          `UPDATE appointments SET status='cancelled' WHERE id IN (${selectedIds.map(() => '?').join(',')}) AND status='scheduled'`,
        )
        .run(...selectedIds);
      if (Number(staged.changes) !== selectedIds.length)
        return fail(409, 'A selected appointment changed. No appointments were moved.');
      clinicResources.applyAppointmentMoves(
        req,
        checked.visits.map(({ before, after }) => ({ before, after })),
      );
      for (const visit of checked.visits) {
        if (sourceEligibility(visit.before, Date.now()) || !(epoch(visit.after) > Date.now()))
          return fail(
            409,
            'A source or target visit has reached its scheduled start. No appointments were moved.',
          );
        const changed = db
          .prepare(
            "UPDATE appointments SET date=?,time=?,status='scheduled',data=? WHERE id=? AND status='cancelled'",
          )
          .run(visit.after.date, visit.after.time, JSON.stringify(visit.after), visit.after.id);
        if (Number(changed.changes) !== 1)
          return fail(409, 'A selected appointment changed. No appointments were moved.');
      }
      const event: SeriesRescheduleEvent = {
        id: id(),
        seriesId,
        moves,
        reason: input.reason,
        expectedRevision: input.expectedRevision,
        patientConfirmed: true,
        requestId: input.requestId,
        createdById: user.id,
        createdByName: user.name,
        createdByRole: user.role,
        createdAt: nowISO(),
        visits: checked.visits.map((visit) => ({
          position: visit.position,
          before: visit.before,
          after: visit.after,
          retainedReservationCount: visit.reservationCount,
        })),
      };
      db.prepare(
        'INSERT INTO appointmentSeriesCommands(requestId,actorId,operation,payload,seriesId) VALUES (?,?,?,?,?)',
      ).run(input.requestId, user.id, 'reschedule', payload, seriesId);
      db.prepare(
        'INSERT INTO appointmentSeriesReschedules(id,seriesId,requestId,createdAt,data) VALUES (?,?,?,?,?)',
      ).run(event.id, seriesId, event.requestId, event.createdAt, JSON.stringify(event));
      audit(req, 'rescheduled appointment series visits', 'appointment-series', seriesId);
      for (const visit of event.visits) {
        audit(req, 'rescheduled appointment', 'appointment', visit.after.id);
        notifyPatient(
          db,
          visit.after.patientId,
          `appointment-series-rescheduled:${event.id}:${visit.after.id}`,
          {
            kind: 'appointment',
            title: 'Your appointment was rescheduled',
            detail: `${visit.after.date} at ${visit.after.time} IST · ${visit.after.durationMinutes ?? 30} minutes · ${visit.after.doctorName}`,
            href: '/my-care',
          },
        );
      }
      // Fail closed if any write/trigger left a staged or mismatched appointment.
      const completedAsOf = Date.now();
      for (const visit of event.visits) {
        if (sourceEligibility(visit.before, completedAsOf) || !(epoch(visit.after) > completedAsOf))
          return fail(
            409,
            'A source or target visit has reached its scheduled start. No appointments were moved.',
          );
        const row = db
          .prepare('SELECT patientId,doctorId,date,time,status,data FROM appointments WHERE id=?')
          .get(visit.after.id);
        if (
          !row ||
          row.patientId !== visit.after.patientId ||
          row.doctorId !== visit.after.doctorId ||
          row.date !== visit.after.date ||
          row.time !== visit.after.time ||
          row.status !== 'scheduled' ||
          row.data !== JSON.stringify(visit.after)
        )
          return fail(
            500,
            'The complete appointment move could not be verified. No appointments were moved.',
          );
      }
      return { event, detail: series.detail(seriesId) };
    });
    res.status(repeated ? 200 : 201).json(value);
  });
}
