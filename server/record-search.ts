import type { Express } from 'express';
import { z } from 'zod';
import type { AuthRequest } from './app.ts';
import type { DB } from './db.ts';
import type { Appointment, AuditEntry, User } from '../shared/types.ts';
import type { PatientDirectoryItem, SearchPage } from '../shared/record-search.ts';

interface SearchContext {
  db: DB;
  actor: (req: AuthRequest, roles?: User['role'][]) => User;
  fail: (status: number, message: string) => never;
}
const positiveInteger = (fallback: string, maximum: number) =>
  z
    .string()
    .regex(/^[1-9]\d*$/)
    .default(fallback)
    .transform(Number)
    .pipe(z.number().int().max(maximum));
const pagination = { page: positiveInteger('1', 1_000_000), pageSize: positiveInteger('25', 100) };
const text = (maximum = 200) =>
  z
    .string()
    .trim()
    .max(maximum)
    .transform((value) => value || undefined)
    .optional();
const date = z
  .string()
  .trim()
  .refine((value) => {
    if (value === '') return true;
    return (
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      value >= '0001-01-01' &&
      Number.isFinite(Date.parse(`${value}T12:00:00Z`)) &&
      new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value
    );
  }, 'Use a real calendar date in YYYY-MM-DD format.')
  .transform((value) => value || undefined)
  .optional();
const optionalEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), z.enum(values).optional());
const orderedDates = (input: { from?: string; to?: string }) =>
  !input.from || !input.to || input.from <= input.to;
type SqlValue = string | number;
interface Filter {
  clauses: string[];
  values: SqlValue[];
}
const filter = (): Filter => ({ clauses: [], values: [] });
function exact(target: Filter, expression: string, value: string | undefined) {
  if (value !== undefined) {
    target.clauses.push(`${expression}=?`);
    target.values.push(value);
  }
}
/** instr uses literal text, so %, _, backslashes and quotes never become wildcard syntax. */
function contains(target: Filter, expressions: string[], value: string | undefined) {
  if (value !== undefined) {
    target.clauses.push(
      `(${expressions.map((expression) => `instr(lower(COALESCE(${expression},'')),lower(?))>0`).join(' OR ')})`,
    );
    target.values.push(...expressions.map(() => value));
  }
}
function bound(
  target: Filter,
  expression: string,
  operator: '>=' | '<=',
  value: string | undefined,
) {
  if (value !== undefined) {
    target.clauses.push(`${expression}${operator}?`);
    target.values.push(value);
  }
}

export function registerRecordSearch(app: Express, { db, actor }: SearchContext) {
  // Built-in deterministic JSON expressions work when reopening the database without any
  // application-defined SQL functions. These indexes do not rewrite existing source rows.
  db.exec(`
    CREATE INDEX IF NOT EXISTS search_patients_created ON patients(json_extract(data,'$.createdAt') DESC,id DESC);
    CREATE INDEX IF NOT EXISTS search_appointments_date ON appointments(date,time,id);
    CREATE INDEX IF NOT EXISTS search_appointments_doctor_date ON appointments(doctorId,date,time,id);
    CREATE INDEX IF NOT EXISTS search_appointments_patient_date ON appointments(patientId,date,time,id);
    CREATE INDEX IF NOT EXISTS search_appointments_status_date ON appointments(status,date,time,id);
    CREATE INDEX IF NOT EXISTS search_appointments_mode_date ON appointments(json_extract(data,'$.mode'),date,time,id);
    CREATE INDEX IF NOT EXISTS search_audit_created ON audit(json_extract(data,'$.createdAt') DESC,id DESC);
    CREATE INDEX IF NOT EXISTS search_audit_entity_created ON audit(json_extract(data,'$.entityType'),json_extract(data,'$.createdAt') DESC,id DESC);
    CREATE INDEX IF NOT EXISTS search_audit_record_created ON audit(json_extract(data,'$.entityId'),json_extract(data,'$.createdAt') DESC,id DESC);
  `);
  function page<T>(
    table: string,
    selection: string,
    order: string,
    query: Filter,
    requestedPage: number,
    pageSize: number,
  ): SearchPage<T> {
    const where = query.clauses.length ? ` WHERE ${query.clauses.join(' AND ')}` : '';
    // Count and page share one SQLite read snapshot. Separate HTTP requests intentionally
    // show current data; offset pages do not promise stable positions after concurrent edits.
    db.exec('BEGIN');
    try {
      const total = Number(
        db.prepare(`SELECT count(*) AS total FROM ${table}${where}`).get(...query.values)!.total,
      );
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const effectivePage = Math.min(requestedPage, totalPages);
      const rows = db
        .prepare(
          `SELECT ${selection} AS data FROM ${table}${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
        )
        .all(...query.values, pageSize, (effectivePage - 1) * pageSize);
      const items = rows.map((row) => JSON.parse(row.data as string) as T);
      db.exec('COMMIT');
      return { items, page: effectivePage, pageSize, total, totalPages };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  app.get('/api/search/patients', (req: AuthRequest, res) => {
    actor(req, ['admin', 'doctor', 'receptionist']);
    const input = z
      .object({ q: text(), ...pagination })
      .strict()
      .parse(req.query);
    const query = filter();
    contains(
      query,
      [
        "json_extract(data,'$.name')",
        "json_extract(data,'$.email')",
        "json_extract(data,'$.phone')",
        'id',
      ],
      input.q,
    );
    // SQL selects only directory fields. Neither matching, counts nor returned rows use
    // allergies, clinical status, notes or private demographic-correction history.
    const selection = `json_object('id',id,'name',json_extract(data,'$.name'),'email',json_extract(data,'$.email'),'phone',json_extract(data,'$.phone'),'dob',json_extract(data,'$.dob'),'gender',json_extract(data,'$.gender'),'createdAt',json_extract(data,'$.createdAt'))`;
    res.json(
      page<PatientDirectoryItem>(
        'patients',
        selection,
        "json_extract(data,'$.createdAt') DESC,id DESC",
        query,
        input.page,
        input.pageSize,
      ),
    );
  });
  app.get('/api/search/appointments', (req: AuthRequest, res) => {
    actor(req, ['admin', 'doctor', 'receptionist']);
    const input = z
      .object({
        q: text(),
        from: date,
        to: date,
        doctorId: text(300),
        patientId: text(300),
        status: optionalEnum([
          'scheduled',
          'checked-in',
          'in-consultation',
          'completed',
          'cancelled',
          'no-show',
          'waiting',
        ]),
        mode: optionalEnum(['in-person', 'online']),
        ...pagination,
      })
      .strict()
      .refine(orderedDates, 'The end date must be on or after the start date.')
      .parse(req.query);
    const query = filter();
    bound(query, 'a.date', '>=', input.from);
    bound(query, 'a.date', '<=', input.to);
    exact(query, 'a.doctorId', input.doctorId);
    exact(query, 'a.patientId', input.patientId);
    if (input.status === 'waiting') query.clauses.push("a.status IN ('scheduled','checked-in')");
    else exact(query, 'a.status', input.status);
    exact(query, "json_extract(a.data,'$.mode')", input.mode);
    contains(
      query,
      [
        "json_extract(a.data,'$.patientName')",
        "json_extract(p.data,'$.name')",
        "json_extract(p.data,'$.email')",
        "json_extract(p.data,'$.phone')",
        'a.patientId',
      ],
      input.q,
    );
    const table = input.q ? 'appointments a JOIN patients p ON p.id=a.patientId' : 'appointments a';
    res.json(
      page<Appointment>(
        table,
        'a.data',
        'a.date ASC,a.time ASC,a.id ASC',
        query,
        input.page,
        input.pageSize,
      ),
    );
  });
  app.get('/api/search/audit', (req: AuthRequest, res) => {
    actor(req, ['admin']);
    const input = z
      .object({
        q: text(),
        actor: text(),
        action: text(),
        entityType: text(300),
        entityId: text(300),
        from: date,
        to: date,
        ...pagination,
      })
      .strict()
      .refine(orderedDates, 'The end date must be on or after the start date.')
      .parse(req.query);
    const query = filter();
    const fields = ['actorName', 'action', 'entityType', 'entityId', 'createdAt'].map(
      (field) => `json_extract(data,'$.${field}')`,
    );
    contains(query, ['id', ...fields], input.q);
    contains(query, ["json_extract(data,'$.actorName')"], input.actor);
    contains(query, ["json_extract(data,'$.action')"], input.action);
    exact(query, "json_extract(data,'$.entityType')", input.entityType);
    exact(query, "json_extract(data,'$.entityId')", input.entityId);
    bound(
      query,
      "json_extract(data,'$.createdAt')",
      '>=',
      input.from ? new Date(`${input.from}T00:00:00.000+05:30`).toISOString() : undefined,
    );
    bound(
      query,
      "json_extract(data,'$.createdAt')",
      '<=',
      input.to ? new Date(`${input.to}T23:59:59.999+05:30`).toISOString() : undefined,
    );
    res.json(
      page<AuditEntry>(
        'audit',
        'data',
        "json_extract(data,'$.createdAt') DESC,id DESC",
        query,
        input.page,
        input.pageSize,
      ),
    );
  });
}
