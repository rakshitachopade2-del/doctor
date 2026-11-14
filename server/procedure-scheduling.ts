import type { Express } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AuthRequest } from './app.ts';
import type { Appointment, User } from '../shared/types.ts';
import type {
  ProcedureAppointmentSnapshot,
  ProcedureCandidatePage,
  ProcedureScheduleContext,
  ProcedureScheduleEvent,
  ProcedureScheduleMutation,
  ProcedureSchedulePage,
  ProcedureScheduleRow,
} from '../shared/procedure-scheduling.ts';
import { addDays, clinicToday, get, id, nowISO, type DB } from './db.ts';
import { notifyPatient } from './activity.ts';

interface Dependencies {
  db: DB;
  actor: (req: AuthRequest, roles?: User['role'][]) => User;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
}
interface PlanLink {
  id: string;
  appointmentId: string | null;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const revision = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'Refresh the scheduling details before saving.');
const identifier = z.string().trim().min(1).max(300);
const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const pagination = {
  page: z
    .string()
    .regex(/^[1-9]\d*$/)
    .default('1')
    .transform(Number)
    .pipe(z.number().int().max(1_000_000)),
  pageSize: z.enum(['10', '25', '50']).default('25').transform(Number),
};
const date = z
  .string()
  .refine(
    (value) =>
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      value >= '0001-01-01' &&
      Number.isFinite(Date.parse(`${value}T12:00:00Z`)) &&
      new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value,
    'Use a real calendar date.',
  );
const commandSchema = z
  .object({
    appointmentId: identifier.nullable(),
    expectedAppointmentRevision: revision.nullable(),
    expectedRevision: revision,
    requestId: uuid,
    reason: z.string().trim().min(1).max(1000),
    removeConfirmed: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.appointmentId === null
        ? value.expectedAppointmentRevision === null && value.removeConfirmed === true
        : value.expectedAppointmentRevision !== null && value.removeConfirmed === undefined,
    'Choose a visit with its revision, or explicitly confirm removal with a null target revision.',
  );
const localNow = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, -1);

export function procedureAppointmentSnapshot(value: Appointment): ProcedureAppointmentSnapshot {
  return {
    id: value.id,
    patientId: value.patientId,
    doctorId: value.doctorId,
    doctorName: value.doctorName,
    date: value.date,
    time: value.time,
    mode: value.mode,
    status: value.status,
    durationMinutes: value.durationMinutes ?? 30,
    durationPolicy: value.durationPolicy === 'custom' ? 'custom' : 'schedule',
  };
}
/** Explicit null on the latest event is a removal, never a fallback to the original link. */
export function effectiveProcedureAppointment(db: DB, plan: PlanLink) {
  const event = db
    .prepare(
      'SELECT afterAppointmentId FROM procedureScheduleEvents WHERE procedureId=? ORDER BY rowid DESC LIMIT 1',
    )
    .get(plan.id);
  const effectiveAppointmentId = event
    ? (event.afterAppointmentId as string | null)
    : (plan.appointmentId ?? null);
  const appointment = effectiveAppointmentId
    ? get<Appointment>(db, 'appointments', effectiveAppointmentId)
    : undefined;
  return {
    effectiveAppointmentId,
    scheduledAppointment: appointment ? procedureAppointmentSnapshot(appointment) : null,
  };
}
const appointmentSelection = (alias: string) => `json_object(
  'id',${alias}.id,'patientId',${alias}.patientId,'doctorId',${alias}.doctorId,
  'doctorName',json_extract(${alias}.data,'$.doctorName'),'date',${alias}.date,'time',${alias}.time,
  'mode',json_extract(${alias}.data,'$.mode'),'status',${alias}.status,
  'durationMinutes',COALESCE(json_extract(${alias}.data,'$.durationMinutes'),30),
  'durationPolicy',CASE WHEN json_extract(${alias}.data,'$.durationPolicy')='custom' THEN 'custom' ELSE 'schedule' END)`;
interface SourceRow {
  id: string;
  patientId: string;
  patientName: string;
  title: string;
  doctorId: string;
  doctorName: string;
  status: ProcedureScheduleRow['status'];
  createdAt: string;
  originalAppointmentId: string | null;
  effectiveAppointmentId: string | null;
  appointmentData: string | null;
  appointmentFuture: number;
  appointmentStatus: Appointment['status'] | null;
  latestEventId: string | null;
  schedulingState: ProcedureScheduleRow['schedulingState'];
}

export function registerProcedureScheduling(
  app: Express,
  { db, actor, audit, fail }: Dependencies,
) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS procedureScheduleEvents (
      id TEXT PRIMARY KEY, procedureId TEXT NOT NULL REFERENCES procedures(id),
      afterAppointmentId TEXT REFERENCES appointments(id), data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS procedure_schedule_events_plan ON procedureScheduleEvents(procedureId);
    CREATE TABLE IF NOT EXISTS procedureScheduleCommands (
      requestId TEXT PRIMARY KEY, actorId TEXT NOT NULL REFERENCES users(id),
      procedureId TEXT NOT NULL REFERENCES procedures(id), payload TEXT NOT NULL,
      eventId TEXT NOT NULL REFERENCES procedureScheduleEvents(id)
    );
    CREATE INDEX IF NOT EXISTS procedure_schedule_created ON procedures(json_extract(data,'$.createdAt') DESC,id DESC);
    CREATE INDEX IF NOT EXISTS procedure_schedule_candidates ON appointments(patientId,status,date,time,id);
  `);
  for (const table of ['procedureScheduleEvents', 'procedureScheduleCommands'])
    db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table}
    BEGIN SELECT RAISE(ABORT,'Procedure scheduling evidence is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}
    BEGIN SELECT RAISE(ABORT,'Procedure scheduling evidence is immutable'); END;
  `);
  function transaction<T>(work: () => T) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  const staff = (req: AuthRequest) => actor(req, ['admin', 'doctor', 'receptionist']);
  const effectiveId =
    "CASE WHEN e.id IS NULL THEN json_extract(p.data,'$.appointmentId') ELSE e.afterAppointmentId END";
  const source = `WITH base AS (
    SELECT p.id,p.patientId,json_extract(patient.data,'$.name') AS patientName,
      json_extract(p.data,'$.title') AS title,json_extract(p.data,'$.doctorId') AS doctorId,
      json_extract(p.data,'$.doctorName') AS doctorName,json_extract(p.data,'$.createdAt') AS createdAt,
      json_extract(p.data,'$.appointmentId') AS originalAppointmentId,${effectiveId} AS effectiveAppointmentId,
      CASE WHEN completed.id IS NOT NULL THEN 'completed' WHEN cancelled.id IS NOT NULL THEN 'cancelled' ELSE 'planned' END AS status,
      e.id AS latestEventId,CASE WHEN a.id IS NULL THEN NULL ELSE ${appointmentSelection('a')} END AS appointmentData,
      a.status AS appointmentStatus,CASE WHEN a.date||'T'||a.time||':00.000'>? THEN 1 ELSE 0 END AS appointmentFuture
    FROM procedures p JOIN patients patient ON patient.id=p.patientId
    LEFT JOIN procedureCompletions completed ON completed.id=p.id
    LEFT JOIN procedureCancellations cancelled ON cancelled.id=p.id
    LEFT JOIN procedureScheduleEvents e ON e.rowid=(SELECT rowid FROM procedureScheduleEvents WHERE procedureId=p.id ORDER BY rowid DESC LIMIT 1)
    LEFT JOIN appointments a ON a.id=${effectiveId}
  ), source AS (
    SELECT *,CASE WHEN effectiveAppointmentId IS NULL THEN 'unlinked'
      WHEN appointmentStatus IN ('checked-in','in-consultation') OR (appointmentStatus='scheduled' AND appointmentFuture=1)
      THEN 'linked' ELSE 'attention' END AS schedulingState FROM base
  )`;
  function project(value: SourceRow): ProcedureScheduleRow {
    const appointment = value.appointmentData
      ? (JSON.parse(value.appointmentData) as ProcedureAppointmentSnapshot)
      : null;
    const canChange =
      value.status === 'planned' &&
      (!appointment ||
        ['cancelled', 'no-show'].includes(appointment.status) ||
        (appointment.status === 'scheduled' && value.appointmentFuture === 1));
    return {
      id: value.id,
      patientId: value.patientId,
      patientName: value.patientName,
      title: value.title,
      doctorId: value.doctorId,
      doctorName: value.doctorName,
      status: value.status,
      createdAt: value.createdAt,
      originalAppointmentId: value.originalAppointmentId,
      effectiveAppointmentId: value.effectiveAppointmentId,
      appointment,
      schedulingState: value.schedulingState,
      canChange,
      blockedReason: canChange
        ? null
        : value.status !== 'planned'
          ? 'This procedure is completed or cancelled; its scheduling history is read-only.'
          : 'The current visit has started or is completed. Its association is read-only.',
    };
  }
  function sourceRow(procedureId: string) {
    const value = db
      .prepare(`${source} SELECT * FROM source WHERE id=?`)
      .get(localNow(), procedureId) as unknown as SourceRow | undefined;
    if (!value) return fail(404, 'Procedure not found.');
    return value;
  }
  function context(procedureId: string): ProcedureScheduleContext {
    const value = sourceRow(procedureId),
      procedure = project(value);
    const history = db
      .prepare('SELECT data FROM procedureScheduleEvents WHERE procedureId=? ORDER BY rowid DESC')
      .all(procedureId)
      .map((row) => JSON.parse(row.data as string) as ProcedureScheduleEvent);
    return {
      procedure,
      revision: hash([
        procedure.id,
        procedure.patientId,
        procedure.doctorId,
        procedure.originalAppointmentId,
        procedure.status,
        procedure.effectiveAppointmentId,
        procedure.appointment,
        value.latestEventId,
      ]),
      history,
    };
  }
  const pageInfo = (total: number, requested: number, pageSize: number) => {
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    return { page: Math.min(requested, totalPages), pageSize, total, totalPages };
  };
  app.get('/api/procedure-scheduling', (req: AuthRequest, res) => {
    staff(req);
    const input = z
      .object({
        search: z.string().trim().max(300).default(''),
        status: z.enum(['planned', 'completed', 'cancelled', 'all']).default('planned'),
        booking: z.enum(['all', 'unlinked', 'linked', 'attention']).default('all'),
        ...pagination,
      })
      .strict()
      .parse(req.query);
    const result = transaction((): ProcedureSchedulePage => {
      const clauses: string[] = [],
        values: (string | number)[] = [localNow()];
      if (input.search) {
        clauses.push('(instr(lower(patientName),lower(?))>0 OR instr(lower(title),lower(?))>0)');
        values.push(input.search, input.search);
      }
      if (input.status !== 'all') {
        clauses.push('status=?');
        values.push(input.status);
      }
      if (input.booking !== 'all') {
        clauses.push('schedulingState=?');
        values.push(input.booking);
      }
      const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
      const total = Number(
        db.prepare(`${source} SELECT count(*) total FROM source${where}`).get(...values)!.total,
      );
      const info = pageInfo(total, input.page, input.pageSize);
      const rows = db
        .prepare(
          `${source} SELECT * FROM source${where} ORDER BY createdAt DESC,id DESC LIMIT ? OFFSET ?`,
        )
        .all(...values, info.pageSize, (info.page - 1) * info.pageSize) as unknown as SourceRow[];
      audit(req, 'viewed procedure scheduling worklist', 'procedure-scheduling', 'worklist');
      return {
        items: rows.map(project),
        filters: { search: input.search, status: input.status, booking: input.booking },
        ...info,
      };
    });
    res.json(result);
  });
  app.get('/api/procedures/:id/scheduling', (req: AuthRequest, res) => {
    staff(req);
    z.object({}).strict().parse(req.query);
    res.json(
      transaction(() => {
        const value = context(String(req.params.id));
        audit(req, 'viewed procedure scheduling history', 'procedure', value.procedure.id);
        return value;
      }),
    );
  });
  app.get('/api/procedures/:id/scheduling/candidates', (req: AuthRequest, res) => {
    staff(req);
    const today = clinicToday(),
      lastDay = addDays(today, 180);
    const input = z
      .object({ from: date.default(today), to: date.default(lastDay), ...pagination })
      .strict()
      .refine(
        (value) => value.from >= today && value.to <= lastDay && value.from <= value.to,
        'Choose an ordered date range within the next 180 days.',
      )
      .parse(req.query);
    res.json(
      transaction((): ProcedureCandidatePage => {
        const plan = sourceRow(String(req.params.id));
        const where =
          "WHERE a.patientId=? AND a.status='scheduled' AND a.date>=? AND a.date<=? AND a.id!=? AND a.date||'T'||a.time||':00.000'>?";
        const values = [
          plan.patientId,
          input.from,
          input.to,
          plan.effectiveAppointmentId ?? '',
          localNow(),
        ];
        const total = Number(
          db
            .prepare(
              `SELECT count(*) total FROM appointments a INDEXED BY procedure_schedule_candidates ${where}`,
            )
            .get(...values)!.total,
        );
        const info = pageInfo(total, input.page, input.pageSize);
        const rows = db
          .prepare(
            `SELECT ${appointmentSelection('a')} data FROM appointments a INDEXED BY procedure_schedule_candidates ${where} ORDER BY a.date,a.time,a.id LIMIT ? OFFSET ?`,
          )
          .all(...values, info.pageSize, (info.page - 1) * info.pageSize);
        const items = rows.map((row) => {
          const appointment = JSON.parse(row.data as string) as ProcedureAppointmentSnapshot;
          return { appointment, revision: hash(appointment) };
        });
        audit(req, 'viewed procedure scheduling candidates', 'procedure', plan.id);
        return { procedureId: plan.id, from: input.from, to: input.to, items, ...info };
      }),
    );
  });
  app.post('/api/procedures/:id/scheduling', (req: AuthRequest, res) => {
    const user = staff(req),
      procedureId = String(req.params.id),
      input = commandSchema.parse(req.body);
    res.json(
      transaction((): ProcedureScheduleMutation => {
        const prior = db
          .prepare('SELECT * FROM procedureScheduleCommands WHERE requestId=?')
          .get(input.requestId);
        if (prior) {
          if (
            prior.actorId !== user.id ||
            prior.procedureId !== procedureId ||
            prior.payload !== JSON.stringify(input)
          )
            return fail(409, 'This request ID was already used for a different command.');
          return {
            context: context(procedureId),
            event: get<ProcedureScheduleEvent>(
              db,
              'procedureScheduleEvents',
              prior.eventId as string,
            )!,
          };
        }
        const current = context(procedureId),
          plan = current.procedure;
        if (current.revision !== input.expectedRevision)
          return fail(
            409,
            'The procedure or its current visit changed. Review the latest scheduling details.',
          );
        if (!plan.canChange) return fail(409, plan.blockedReason!);
        if (plan.effectiveAppointmentId === input.appointmentId)
          return fail(400, 'The appointment association is unchanged.');
        let target: ProcedureAppointmentSnapshot | null = null;
        if (input.appointmentId) {
          const appointment = get<Appointment>(db, 'appointments', input.appointmentId);
          if (!appointment || appointment.patientId !== plan.patientId)
            return fail(400, 'Choose an appointment for this patient.');
          target = procedureAppointmentSnapshot(appointment);
          if (hash(target) !== input.expectedAppointmentRevision)
            return fail(
              409,
              'The selected visit changed. Refresh the candidates and review it again.',
            );
          if (
            appointment.status !== 'scheduled' ||
            Date.parse(`${appointment.date}T${appointment.time}:00+05:30`) <= Date.now()
          )
            return fail(409, 'Choose a future scheduled appointment.');
        }
        const event: ProcedureScheduleEvent = {
          id: id(),
          procedureId,
          operation:
            input.appointmentId === null
              ? 'unlink'
              : plan.effectiveAppointmentId === null
                ? 'attach'
                : 'replace',
          requestId: input.requestId,
          expectedRevision: input.expectedRevision,
          expectedAppointmentRevision: input.expectedAppointmentRevision,
          beforeAppointmentId: plan.effectiveAppointmentId,
          afterAppointmentId: input.appointmentId,
          beforeAppointment: plan.appointment,
          afterAppointment: target,
          reason: input.reason,
          createdById: user.id,
          createdByName: user.name,
          createdByRole: user.role as ProcedureScheduleEvent['createdByRole'],
          createdAt: nowISO(),
        };
        db.prepare(
          'INSERT INTO procedureScheduleEvents(id,procedureId,afterAppointmentId,data) VALUES (?,?,?,?)',
        ).run(event.id, procedureId, event.afterAppointmentId, JSON.stringify(event));
        db.prepare(
          'INSERT INTO procedureScheduleCommands(requestId,actorId,procedureId,payload,eventId) VALUES (?,?,?,?,?)',
        ).run(input.requestId, user.id, procedureId, JSON.stringify(input), event.id);
        audit(req, `procedure appointment ${event.operation}`, 'procedure', procedureId);
        notifyPatient(db, plan.patientId, `procedure-scheduling:${event.id}`, {
          kind: 'procedure',
          title: target
            ? 'Your procedure plan has an appointment'
            : 'A procedure appointment link was removed',
          detail: target
            ? `${target.date} at ${target.time} IST · ${target.durationMinutes} minutes · ${target.doctorName}`
            : 'The procedure plan is now unlinked. Existing appointments remain booked.',
          href: '/my-care/record?tab=workflows',
        });
        return { context: context(procedureId), event };
      }),
    );
  });
}
