import type { Express } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AuthRequest } from './app.ts';
import type { createScheduling } from './scheduling.ts';
import { get, id, nowISO, clinicToday, addDays, type DB } from './db.ts';
import { mfaSessionAllowed } from './mfa.ts';
import { notifyPatient } from './activity.ts';
import type { User, Patient, Doctor, Appointment } from '../shared/types.ts';
import type {
  AppointmentSeriesInput,
  AppointmentSeriesPreview,
  AppointmentSeriesVisit,
  AppointmentSeries,
  AppointmentSeriesDetail,
  AppointmentSeriesRow,
} from '../shared/appointment-series.ts';

interface Context {
  db: DB;
  actor: (req: AuthRequest, roles?: User['role'][]) => User;
  patientAccess: (req: AuthRequest, patientId: string, allowReception?: boolean) => Patient;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
  scheduling: ReturnType<typeof createScheduling>;
}
interface StoredCommand {
  actorId: string;
  operation: string;
  payload: string;
  seriesId: string;
}
const reference = z.string().trim().min(1).max(300);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = Date.parse(`${value}T12:00:00Z`);
    return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
  }, 'Use a real calendar date in YYYY-MM-DD format.');
const inputSchema = z
  .object({
    patientId: reference,
    doctorId: reference,
    mode: z.enum(['in-person', 'online']),
    reason: z.string().trim().min(1).max(300),
    firstDate: date,
    time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    count: z.number().int().min(2).max(12),
    intervalWeeks: z.union([z.literal(1), z.literal(2), z.literal(4)]),
    durationPolicy: z.enum(['schedule', 'custom']),
    durationMinutes: z.number().int().min(15).max(240).multipleOf(5).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.durationPolicy === 'custom'
        ? value.durationMinutes !== undefined
        : value.durationMinutes === undefined,
    'Supply durationMinutes only for a custom visit length.',
  );
const commandSchema = z
  .object({
    input: inputSchema,
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
    patientConfirmed: z.literal(true),
    privateNote: z.string().trim().max(1000).default(''),
    requestId: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
  })
  .strict();
const querySchema = z
  .object({
    q: z.string().trim().max(200).default(''),
    patientId: reference.optional(),
    doctorId: reference.optional(),
    page: z
      .string()
      .regex(/^[1-9]\d{0,6}$/)
      .transform(Number)
      .refine((value) => value <= 1000000)
      .default(1),
    pageSize: z.enum(['10', '25', '50']).transform(Number).default(25),
  })
  .strict();
const empty = z.object({}).strict();
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function validationFailure(error: unknown): error is Error & { status: 400 | 409 } {
  return error instanceof Error && 'status' in error && [400, 409].includes(Number(error.status));
}

export function registerAppointmentSeries(app: Express, context: Context) {
  const { db, actor, patientAccess, audit, fail, scheduling } = context;
  db.exec(`
    CREATE TABLE IF NOT EXISTS appointmentSeries (
      id TEXT PRIMARY KEY, patientId TEXT NOT NULL REFERENCES patients(id),
      doctorId TEXT NOT NULL REFERENCES doctors(id), createdAt TEXT NOT NULL, data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS appointment_series_created ON appointmentSeries(createdAt DESC,id DESC);
    CREATE INDEX IF NOT EXISTS appointment_series_patient ON appointmentSeries(patientId,createdAt DESC,id DESC);
    CREATE INDEX IF NOT EXISTS appointment_series_doctor ON appointmentSeries(doctorId,createdAt DESC,id DESC);
    CREATE TABLE IF NOT EXISTS appointmentSeriesMembers (
      seriesId TEXT NOT NULL REFERENCES appointmentSeries(id), position INTEGER NOT NULL CHECK(position BETWEEN 1 AND 12),
      appointmentId TEXT NOT NULL UNIQUE REFERENCES appointments(id), PRIMARY KEY(seriesId,position)
    );
    CREATE TABLE IF NOT EXISTS appointmentSeriesCommands (
      requestId TEXT PRIMARY KEY, actorId TEXT NOT NULL REFERENCES users(id), operation TEXT NOT NULL,
      payload TEXT NOT NULL, seriesId TEXT NOT NULL REFERENCES appointmentSeries(id)
    );
  `);
  for (const table of [
    'appointmentSeries',
    'appointmentSeriesMembers',
    'appointmentSeriesCommands',
  ])
    db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${table}_immutable_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Appointment series origins are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ${table}_immutable_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Appointment series origins are immutable'); END;
  `);
  function authorize(req: AuthRequest) {
    const cached = actor(req, ['admin', 'doctor', 'receptionist']);
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
      session.csrfToken !== req.csrfToken ||
      !mfaSessionAllowed(db, user.id, session.mfaCredentialId)
    )
      return fail(401, 'Your session changed. Sign in again.');
    if (user.mustChangePassword || !['admin', 'doctor', 'receptionist'].includes(user.role))
      return fail(403, 'This account cannot manage appointment series.');
    req.user = user;
    return user as User & { role: 'admin' | 'doctor' | 'receptionist' };
  }
  function requestedVisits(input: AppointmentSeriesInput, durationMinutes: number) {
    return Array.from({ length: input.count }, (_, offset) => {
      const start = new Date(
        Date.parse(`${input.firstDate}T${input.time}:00Z`) +
          offset * input.intervalWeeks * 7 * 86400000,
      );
      const end = new Date(start.getTime() + durationMinutes * 60000);
      const startISO = start.toISOString(),
        endISO = end.toISOString();
      if (!/^\d{4}-/.test(startISO) || !/^\d{4}-/.test(endISO))
        return fail(400, 'Generated visit dates must remain within four-digit calendar years.');
      return {
        position: offset + 1,
        date: startISO.slice(0, 10),
        time: input.time,
        endDate: endISO.slice(0, 10),
        endTime: endISO.slice(11, 16),
        durationMinutes,
      };
    });
  }
  function preview(req: AuthRequest, input: AppointmentSeriesInput): AppointmentSeriesPreview {
    const patientSource = patientAccess(req, input.patientId, true);
    const doctorSource = get<Doctor>(db, 'doctors', input.doctorId);
    if (!doctorSource) return fail(404, 'Doctor not found.');
    const patient = { id: patientSource.id, name: patientSource.name, phone: patientSource.phone };
    const doctor = { id: doctorSource.id, name: doctorSource.name, fee: doctorSource.fee };
    const schedule = scheduling.schedule(input.doctorId);
    const durationMinutes =
      input.durationPolicy === 'custom' ? input.durationMinutes : schedule.durationMinutes;
    const requested = requestedVisits(input, durationMinutes);
    const clinicDate = clinicToday(),
      horizonEndDate = addDays(clinicDate, 180);
    const visits: AppointmentSeriesVisit[] = requested.map((visit) => {
      try {
        scheduling.validateBooking({
          patientId: input.patientId,
          doctorId: input.doctorId,
          date: visit.date,
          time: visit.time,
          mode: input.mode,
          ...(input.durationPolicy === 'custom'
            ? { customDurationMinutes: input.durationMinutes }
            : {}),
        });
        return { ...visit, available: true, blockedReason: null };
      } catch (error) {
        if (!validationFailure(error)) throw error;
        return { ...visit, available: false, blockedReason: error.message };
      }
    });
    const dates = visits.map((visit) => visit.date);
    const closures = db
      .prepare(
        `SELECT id,doctorId,startDate,endDate,
      json_extract(data,'$.startTime') AS startTime,json_extract(data,'$.endTime') AS endTime
      FROM scheduleClosures WHERE (doctorId IS NULL OR doctorId=?) AND startDate<=? AND endDate>=? ORDER BY id`,
      )
      .all(input.doctorId, dates.at(-1)!, dates[0]);
    const appointments = db
      .prepare(
        `SELECT id,patientId,doctorId,date,time,status,
      COALESCE(json_extract(data,'$.durationMinutes'),30) AS durationMinutes FROM appointments
      WHERE date IN (${dates.map(() => '?').join(',')}) AND (doctorId=? OR patientId=?)
      AND status NOT IN ('cancelled','no-show') ORDER BY id`,
      )
      .all(...dates, input.doctorId, input.patientId);
    return {
      input,
      patient,
      doctor,
      durationMinutes,
      clinicDate,
      horizonEndDate,
      generatedAt: nowISO(),
      visits,
      canBook: visits.every((visit) => visit.available),
      revision: digest([
        input,
        patient,
        doctor,
        schedule,
        closures,
        appointments,
        clinicDate,
        horizonEndDate,
        visits,
      ]),
    };
  }
  function detail(seriesId: string): AppointmentSeriesDetail {
    const series = get<AppointmentSeries>(db, 'appointmentSeries', seriesId);
    if (!series) return fail(404, 'Appointment series not found.');
    const appointments = db
      .prepare(
        'SELECT a.data FROM appointmentSeriesMembers m JOIN appointments a ON a.id=m.appointmentId WHERE m.seriesId=? ORDER BY m.position',
      )
      .all(seriesId)
      .map((row) => JSON.parse(row.data as string) as Appointment);
    if (appointments.length !== series.input.count)
      return fail(500, 'Appointment series membership is incomplete.');
    return { series, appointments };
  }
  app.post('/api/appointment-series/preview', (req: AuthRequest, res) => {
    empty.parse(req.query);
    const input = inputSchema.parse(req.body) as AppointmentSeriesInput;
    const result = scheduling.transaction(() => {
      authorize(req);
      const value = preview(req, input);
      audit(req, 'previewed appointment series', 'appointment-series', input.patientId);
      return value;
    });
    res.json(result);
  });
  app.post('/api/appointment-series', (req: AuthRequest, res) => {
    empty.parse(req.query);
    const input = commandSchema.parse(req.body);
    let repeated = false;
    const result = scheduling.transaction(() => {
      const user = authorize(req);
      const prior = db
        .prepare(
          'SELECT actorId,operation,payload,seriesId FROM appointmentSeriesCommands WHERE requestId=?',
        )
        .get(input.requestId) as unknown as StoredCommand | undefined;
      if (prior) {
        if (
          prior.actorId !== user.id ||
          prior.operation !== 'book' ||
          prior.payload !== JSON.stringify(input)
        )
          return fail(
            409,
            'This request ID was already used with different appointment series details.',
          );
        repeated = true;
        return detail(prior.seriesId);
      }
      const current = preview(req, input.input as AppointmentSeriesInput);
      if (current.revision !== input.expectedRevision)
        return fail(409, 'The series preview changed. Review every visit again before booking.');
      if (!current.canBook)
        return fail(
          409,
          'The series includes unavailable visits. Change the pattern and preview every visit again.',
        );
      const createdAt = nowISO(),
        seriesId = id();
      const bookedAppointments: Appointment[] = [];
      for (const visit of current.visits) {
        let durationMinutes: number;
        try {
          durationMinutes = scheduling.validateBooking({
            patientId: current.input.patientId,
            doctorId: current.input.doctorId,
            mode: current.input.mode,
            date: visit.date,
            time: visit.time,
            ...(current.input.durationPolicy === 'custom'
              ? { customDurationMinutes: current.input.durationMinutes }
              : {}),
          });
        } catch (error) {
          if (!validationFailure(error)) throw error;
          return fail(
            409,
            'A series visit is no longer available. Preview every visit again before booking.',
          );
        }
        const appointment: Appointment = {
          id: id(),
          patientId: current.patient.id,
          patientName: current.patient.name,
          doctorId: current.doctor.id,
          doctorName: current.doctor.name,
          fee: current.doctor.fee,
          date: visit.date,
          time: visit.time,
          mode: current.input.mode,
          reason: current.input.reason,
          durationMinutes,
          durationPolicy: current.input.durationPolicy,
          status: 'scheduled',
          createdAt,
        };
        db.prepare(
          'INSERT INTO appointments(id,patientId,doctorId,date,time,status,data) VALUES (?,?,?,?,?,?,?)',
        ).run(
          appointment.id,
          appointment.patientId,
          appointment.doctorId,
          appointment.date,
          appointment.time,
          appointment.status,
          JSON.stringify(appointment),
        );
        bookedAppointments.push(appointment);
      }
      const series: AppointmentSeries = {
        id: seriesId,
        input: current.input,
        patient: current.patient,
        doctor: current.doctor,
        durationMinutes: current.durationMinutes,
        bookedAppointments,
        patientConfirmed: true,
        privateNote: input.privateNote,
        requestId: input.requestId,
        expectedRevision: input.expectedRevision,
        createdById: user.id,
        createdByName: user.name,
        createdByRole: user.role,
        createdAt,
      };
      db.prepare(
        'INSERT INTO appointmentSeries(id,patientId,doctorId,createdAt,data) VALUES (?,?,?,?,?)',
      ).run(series.id, current.patient.id, current.doctor.id, createdAt, JSON.stringify(series));
      const addMember = db.prepare(
        'INSERT INTO appointmentSeriesMembers(seriesId,position,appointmentId) VALUES (?,?,?)',
      );
      bookedAppointments.forEach((appointment, index) =>
        addMember.run(series.id, index + 1, appointment.id),
      );
      db.prepare(
        'INSERT INTO appointmentSeriesCommands(requestId,actorId,operation,payload,seriesId) VALUES (?,?,?,?,?)',
      ).run(input.requestId, user.id, 'book', JSON.stringify(input), series.id);
      audit(req, 'booked appointment series', 'appointment-series', series.id);
      for (const appointment of bookedAppointments) {
        audit(req, 'booked appointment', 'appointment', appointment.id);
        notifyPatient(db, appointment.patientId, `appointment-created:${appointment.id}`, {
          kind: 'appointment',
          title: 'Your appointment is booked',
          detail: `${appointment.date} at ${appointment.time} IST · ${appointment.doctorName}`,
          href: '/my-care',
        });
      }
      return detail(series.id);
    });
    res.status(repeated ? 200 : 201).json(result);
  });
  app.get('/api/appointment-series', (req: AuthRequest, res) => {
    const query = querySchema.parse(req.query);
    res.json(
      scheduling.transaction(() => {
        authorize(req);
        const clauses: string[] = [],
          parameters: string[] = [];
        if (query.patientId) {
          clauses.push('patientId=?');
          parameters.push(query.patientId);
        }
        if (query.doctorId) {
          clauses.push('doctorId=?');
          parameters.push(query.doctorId);
        }
        if (query.q) {
          clauses.push(
            "(instr(lower(json_extract(data,'$.patient.name')),lower(?))>0 OR instr(lower(json_extract(data,'$.doctor.name')),lower(?))>0)",
          );
          parameters.push(query.q, query.q);
        }
        const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
        const total = Number(
          db.prepare(`SELECT count(*) AS n FROM appointmentSeries${where}`).get(...parameters)!.n,
        );
        const totalPages = Math.max(1, Math.ceil(total / query.pageSize)),
          page = Math.min(query.page, totalPages);
        const items = db
          .prepare(
            `SELECT id,patientId,doctorId,createdAt,
        json_extract(data,'$.patient.name') AS patientName,json_extract(data,'$.doctor.name') AS doctorName,
        json_extract(data,'$.input.firstDate') AS firstDate,json_extract(data,'$.bookedAppointments[#-1].date') AS lastDate,
        json_extract(data,'$.input.time') AS time,json_extract(data,'$.input.count') AS count,
        json_extract(data,'$.input.intervalWeeks') AS intervalWeeks,json_extract(data,'$.input.mode') AS mode,
        json_extract(data,'$.input.durationPolicy') AS durationPolicy,json_extract(data,'$.durationMinutes') AS durationMinutes,
        json_extract(data,'$.createdByName') AS createdByName FROM appointmentSeries${where}
        ORDER BY createdAt DESC,id DESC LIMIT ? OFFSET ?`,
          )
          .all(
            ...parameters,
            query.pageSize,
            (page - 1) * query.pageSize,
          ) as unknown as AppointmentSeriesRow[];
        audit(req, 'viewed appointment series list', 'appointment-series', 'series');
        return {
          items,
          filters: {
            q: query.q,
            patientId: query.patientId ?? null,
            doctorId: query.doctorId ?? null,
          },
          page,
          pageSize: query.pageSize,
          total,
          totalPages,
        };
      }),
    );
  });
  app.get('/api/appointment-series/:id', (req: AuthRequest, res) => {
    empty.parse(req.query);
    res.json(
      scheduling.transaction(() => {
        authorize(req);
        const value = detail(String(req.params.id));
        audit(req, 'viewed appointment series', 'appointment-series', value.series.id);
        return value;
      }),
    );
  });
}
