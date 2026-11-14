import type { Express } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AuthRequest } from './app.ts';
import type { Doctor, User } from '../shared/types.ts';
import type { ProcedureRecord } from '../shared/clinical.ts';
import type {
  ProcedureCataloguePage,
  ProcedureCreateReceipt,
  ProcedureTemplateDetail,
  ProcedureTemplateEvent,
  ProcedureTemplateFields,
  ProcedureTemplateHistoryPage,
  ProcedureTemplateMutation,
  ProcedureTemplateRow,
  ProcedureTemplateSelection,
  ProcedureTemplateSource,
  ProcedureTemplateState,
  ProcedureTemplateVersion,
  ProcedureTemplateVersionPage,
} from '../shared/procedure-catalogue.ts';
import { get, id, nowISO, type DB } from './db.ts';
import { mfaSessionAllowed } from './mfa.ts';

interface Dependencies {
  db: DB;
  actor: (req: AuthRequest, roles?: User['role'][]) => User;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const required = z.string().trim().min(1).max(300);
const explanation = z.string().trim().min(1).max(8000);
const reason = z.string().trim().min(1).max(1000);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
export const procedureCatalogueRequestId = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
export const procedureTemplateFields = z
  .object({
    title: required,
    benefits: explanation,
    risks: explanation,
    alternatives: explanation,
    aftercare: explanation,
    estimatedCost: z.string().trim().max(300).default(''),
  })
  .strict();
export const procedureTemplateSelection = z
  .object({
    templateId: z.string().uuid(),
    versionId: z.string().uuid(),
    expectedSelectionRevision: revision,
  })
  .strict();
const pages = {
  page: z
    .string()
    .regex(/^[1-9]\d*$/)
    .default('1')
    .transform(Number)
    .pipe(z.number().int().max(1_000_000)),
  pageSize: z.enum(['10', '25', '50']).default('25').transform(Number),
};
const command = { reason, expectedRevision: revision, requestId: procedureCatalogueRequestId };
const fieldNames: Array<keyof ProcedureTemplateFields> = [
  'title',
  'benefits',
  'risks',
  'alternatives',
  'aftercare',
  'estimatedCost',
];
interface Source {
  id: string;
  active: number;
  createdAt: string;
  updatedAt: string;
  latestVersionId: string;
  publishedVersionId: string | null;
  publishedEventId: string | null;
  availabilityEventId: string | null;
  latestEventId: string;
  title: string;
  latestVersion: number;
  publishedVersion: number | null;
  publishedTitle: string | null;
  publishedAt: string | null;
}
interface CommandRow {
  actorId: string;
  operation: string;
  templateId: string | null;
  payload: string;
  eventId: string | null;
  receipt: string | null;
}

export function registerProcedureCatalogue(app: Express, { db, actor, audit, fail }: Dependencies) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS procedureTemplates (
      id TEXT PRIMARY KEY,active INTEGER NOT NULL CHECK(active IN (0,1)),createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,
      latestVersionId TEXT NOT NULL,publishedVersionId TEXT,publishedEventId TEXT,availabilityEventId TEXT,latestEventId TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS procedure_templates_updated ON procedureTemplates(updatedAt DESC,id DESC);
    CREATE TABLE IF NOT EXISTS procedureTemplateVersions (
      id TEXT PRIMARY KEY,templateId TEXT NOT NULL REFERENCES procedureTemplates(id),version INTEGER NOT NULL CHECK(version>0),data TEXT NOT NULL,UNIQUE(templateId,version)
    );
    CREATE TABLE IF NOT EXISTS procedureTemplateEvents (
      id TEXT PRIMARY KEY,templateId TEXT NOT NULL REFERENCES procedureTemplates(id),operation TEXT NOT NULL,data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS procedure_template_events_owner ON procedureTemplateEvents(templateId);
    CREATE TABLE IF NOT EXISTS procedureCatalogueCommands (
      requestId TEXT PRIMARY KEY,actorId TEXT NOT NULL REFERENCES users(id),operation TEXT NOT NULL,
      templateId TEXT REFERENCES procedureTemplates(id),payload TEXT NOT NULL,eventId TEXT REFERENCES procedureTemplateEvents(id),receipt TEXT
    );
  `);
  for (const table of [
    'procedureTemplateVersions',
    'procedureTemplateEvents',
    'procedureCatalogueCommands',
  ])
    db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${table}_immutable_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Procedure catalogue evidence is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ${table}_immutable_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Procedure catalogue evidence is immutable'); END;
  `);
  function transaction<T>(work: () => T): T {
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
  /** Called while the transaction lock is held, including by patient-plan creation. */
  function authorize(req: AuthRequest, linked = false, adminOnly = false) {
    const cached = actor(req, adminOnly ? ['admin'] : ['admin', 'doctor']);
    const current = get<User>(db, 'users', cached.id);
    const session = db
      .prepare('SELECT userId,expiresAt,csrfToken,mfaCredentialId FROM sessions WHERE tokenHash=?')
      .get(req.sessionToken ?? '');
    if (
      !current ||
      current.active === false ||
      !session ||
      session.userId !== current.id ||
      Number(session.expiresAt) <= Date.now() ||
      session.csrfToken !== req.csrfToken ||
      !mfaSessionAllowed(db, current.id, session.mfaCredentialId)
    )
      return fail(401, 'Your session changed. Sign in again.');
    if (current.mustChangePassword)
      return fail(403, 'Change your temporary password before using the procedure catalogue.');
    if (!['admin', 'doctor'].includes(current.role) || (adminOnly && current.role !== 'admin'))
      return fail(403, 'This account cannot access the procedure catalogue.');
    const doctor = current.doctorId ? get<Doctor>(db, 'doctors', current.doctorId) : undefined;
    if (linked && !doctor)
      return fail(400, 'Sign in with a linked doctor account to document clinical care.');
    req.user = current;
    return { user: current, doctor };
  }
  const sourceSql = `SELECT t.*,json_extract(v.data,'$.fields.title') title,v.version latestVersion,
    p.version publishedVersion,json_extract(p.data,'$.fields.title') publishedTitle,json_extract(e.data,'$.createdAt') publishedAt
    FROM procedureTemplates t JOIN procedureTemplateVersions v ON v.id=t.latestVersionId
    LEFT JOIN procedureTemplateVersions p ON p.id=t.publishedVersionId LEFT JOIN procedureTemplateEvents e ON e.id=t.publishedEventId`;
  function source(templateId: string): Source {
    const row = db.prepare(`${sourceSql} WHERE t.id=?`).get(templateId) as unknown as
      Source | undefined;
    return row ?? fail(404, 'Procedure template not found.');
  }
  const selectionRevision = (row: Source) =>
    hash([
      row.id,
      Boolean(row.active),
      row.publishedVersionId,
      row.publishedEventId,
      row.availabilityEventId,
    ]);
  const currentRevision = (row: Source) =>
    hash([
      row.id,
      Boolean(row.active),
      row.latestVersionId,
      row.publishedVersionId,
      row.latestEventId,
    ]);
  function project(row: Source): ProcedureTemplateRow {
    return {
      id: row.id,
      title: row.title,
      active: Boolean(row.active),
      latestVersion: Number(row.latestVersion),
      publishedVersion: row.publishedVersion === null ? null : Number(row.publishedVersion),
      publishedTitle: row.publishedTitle,
      publishedAt: row.publishedAt,
      revision: currentRevision(row),
      selectionRevision: selectionRevision(row),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
  const version = (versionId: string) =>
    get<ProcedureTemplateVersion>(db, 'procedureTemplateVersions', versionId)!;
  function detail(templateId: string): ProcedureTemplateDetail {
    const row = source(templateId);
    return {
      template: project(row),
      latestVersion: version(row.latestVersionId),
      publishedVersion: row.publishedVersionId ? version(row.publishedVersionId) : null,
      publication: row.publishedEventId
        ? get<ProcedureTemplateEvent>(db, 'procedureTemplateEvents', row.publishedEventId)!
        : null,
      history: db
        .prepare(
          'SELECT data FROM procedureTemplateEvents WHERE templateId=? ORDER BY rowid DESC LIMIT 25',
        )
        .all(templateId)
        .map((r) => JSON.parse(r.data as string) as ProcedureTemplateEvent),
      historyTotal: Number(
        db
          .prepare('SELECT count(*) n FROM procedureTemplateEvents WHERE templateId=?')
          .get(templateId)!.n,
      ),
    };
  }
  const state = (row: Source): ProcedureTemplateState => ({
    active: Boolean(row.active),
    latestVersionId: row.latestVersionId,
    publishedVersionId: row.publishedVersionId,
  });
  function replay(
    user: User,
    operation: string,
    templateId: string | null,
    input: { requestId: string },
  ) {
    const prior = db
      .prepare(
        'SELECT actorId,operation,templateId,payload,eventId,receipt FROM procedureCatalogueCommands WHERE requestId=?',
      )
      .get(input.requestId) as unknown as CommandRow | undefined;
    if (!prior) return null;
    if (
      prior.actorId !== user.id ||
      prior.operation !== operation ||
      prior.templateId !== templateId ||
      prior.payload !== JSON.stringify(input)
    )
      return fail(409, 'This request ID was already used with different procedure details.');
    return prior;
  }
  function receipt(
    user: User,
    operation: string,
    templateId: string | null,
    input: { requestId: string },
    eventId: string | null,
    planReceipt: ProcedureCreateReceipt | null = null,
  ) {
    db.prepare(
      'INSERT INTO procedureCatalogueCommands(requestId,actorId,operation,templateId,payload,eventId,receipt) VALUES (?,?,?,?,?,?,?)',
    ).run(
      input.requestId,
      user.id,
      operation,
      templateId,
      JSON.stringify(input),
      eventId,
      planReceipt ? JSON.stringify(planReceipt) : null,
    );
  }
  function mutation(event: ProcedureTemplateEvent): ProcedureTemplateMutation {
    return {
      detail: detail(event.templateId),
      event,
      version: event.versionId ? version(event.versionId) : null,
    };
  }
  function assertRevision(row: Source, expected: string) {
    if (currentRevision(row) !== expected)
      fail(
        409,
        'The procedure template changed. Refresh and review the latest version before saving.',
      );
  }
  function saveVersion(
    templateId: string,
    number: number,
    fields: ProcedureTemplateFields,
    why: string,
    user: User,
    doctor: Doctor,
    createdAt: string,
  ): ProcedureTemplateVersion {
    const value: ProcedureTemplateVersion = {
      id: id(),
      templateId,
      version: number,
      fields,
      reason: why,
      createdById: user.id,
      createdByName: user.name,
      doctorId: doctor.id,
      doctorName: doctor.name,
      createdAt,
    };
    db.prepare(
      'INSERT INTO procedureTemplateVersions(id,templateId,version,data) VALUES (?,?,?,?)',
    ).run(value.id, templateId, number, JSON.stringify(value));
    return value;
  }
  function saveEvent(
    req: AuthRequest,
    user: User,
    doctor: Doctor | undefined,
    templateId: string,
    operation: ProcedureTemplateEvent['operation'],
    versionId: string | null,
    before: ProcedureTemplateState | null,
    after: ProcedureTemplateState,
    input: { requestId: string; reason: string; expectedRevision?: string },
    createdAt: string,
    eventId = id(),
  ): ProcedureTemplateEvent {
    const event: ProcedureTemplateEvent = {
      id: eventId,
      templateId,
      operation,
      versionId,
      before,
      after,
      reason: input.reason,
      requestId: input.requestId,
      expectedRevision: input.expectedRevision ?? null,
      createdById: user.id,
      createdByName: user.name,
      createdByRole: user.role as Exclude<User['role'], 'patient'>,
      doctorId: doctor?.id ?? null,
      doctorName: doctor?.name ?? null,
      createdAt,
    };
    db.prepare(
      'INSERT INTO procedureTemplateEvents(id,templateId,operation,data) VALUES (?,?,?,?)',
    ).run(event.id, templateId, operation, JSON.stringify(event));
    db.prepare('UPDATE procedureTemplates SET latestEventId=?,updatedAt=? WHERE id=?').run(
      event.id,
      createdAt,
      templateId,
    );
    receipt(user, operation, operation === 'created' ? null : templateId, input, event.id);
    audit(req, `procedure catalogue ${operation}`, 'procedure-template', templateId);
    return event;
  }
  const pageInfo = (total: number, requested: number, pageSize: number) => {
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    return { page: Math.min(requested, totalPages), pageSize, total, totalPages };
  };
  const emptyQuery = (req: AuthRequest) => z.object({}).strict().parse(req.query);
  app.get('/api/procedure-catalogue', (req: AuthRequest, res) => {
    const input = z
      .object({
        search: z.string().trim().max(300).default(''),
        active: z.enum(['true', 'false', 'all']).default('true'),
        publication: z.enum(['all', 'published', 'unpublished']).default('all'),
        ...pages,
      })
      .strict()
      .parse(req.query);
    res.json(
      transaction((): ProcedureCataloguePage => {
        authorize(req);
        const clauses: string[] = [],
          values: (string | number)[] = [];
        if (input.active !== 'all') {
          clauses.push('t.active=?');
          values.push(input.active === 'true' ? 1 : 0);
        }
        if (input.publication !== 'all')
          clauses.push(
            `t.publishedVersionId IS ${input.publication === 'published' ? 'NOT ' : ''}NULL`,
          );
        if (input.search) {
          clauses.push(
            "(instr(lower(json_extract(v.data,'$.fields.title')),lower(?))>0 OR instr(lower(COALESCE(json_extract(p.data,'$.fields.title'),'')),lower(?))>0)",
          );
          values.push(input.search, input.search);
        }
        const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
        const total = Number(
            db.prepare(`SELECT count(*) n FROM (${sourceSql}${where})`).get(...values)!.n,
          ),
          info = pageInfo(total, input.page, input.pageSize);
        const rows = db
          .prepare(`${sourceSql}${where} ORDER BY t.updatedAt DESC,t.id DESC LIMIT ? OFFSET ?`)
          .all(...values, info.pageSize, (info.page - 1) * info.pageSize) as unknown as Source[];
        audit(req, 'viewed procedure catalogue', 'procedure-template', 'catalogue');
        return {
          items: rows.map(project),
          filters: { search: input.search, active: input.active, publication: input.publication },
          ...info,
        };
      }),
    );
  });
  app.get('/api/procedure-catalogue/:id', (req: AuthRequest, res) => {
    emptyQuery(req);
    res.json(
      transaction(() => {
        authorize(req);
        const value = detail(String(req.params.id));
        audit(req, 'viewed procedure template', 'procedure-template', value.template.id);
        return value;
      }),
    );
  });
  for (const kind of ['versions', 'history'] as const)
    app.get(`/api/procedure-catalogue/:id/${kind}`, (req: AuthRequest, res) => {
      const input = z.object(pages).strict().parse(req.query),
        templateId = String(req.params.id);
      res.json(
        transaction((): ProcedureTemplateVersionPage | ProcedureTemplateHistoryPage => {
          authorize(req);
          source(templateId);
          const table =
              kind === 'versions' ? 'procedureTemplateVersions' : 'procedureTemplateEvents',
            order = kind === 'versions' ? 'version' : 'rowid';
          const total = Number(
              db.prepare(`SELECT count(*) n FROM ${table} WHERE templateId=?`).get(templateId)!.n,
            ),
            info = pageInfo(total, input.page, input.pageSize);
          const items = db
            .prepare(
              `SELECT data FROM ${table} WHERE templateId=? ORDER BY ${order} DESC LIMIT ? OFFSET ?`,
            )
            .all(templateId, info.pageSize, (info.page - 1) * info.pageSize)
            .map((r) => JSON.parse(r.data as string));
          audit(req, `viewed procedure template ${kind}`, 'procedure-template', templateId);
          return { templateId, items, ...info };
        }),
      );
    });
  app.post('/api/procedure-catalogue', (req: AuthRequest, res) => {
    emptyQuery(req);
    const input = z
      .object({ fields: procedureTemplateFields, reason, requestId: procedureCatalogueRequestId })
      .strict()
      .parse(req.body);
    const result = transaction(() => {
      const { user, doctor } = authorize(req, true),
        prior = replay(user, 'created', null, input);
      if (prior)
        return {
          value: mutation(
            get<ProcedureTemplateEvent>(db, 'procedureTemplateEvents', prior.eventId!)!,
          ),
          replayed: true,
        };
      const templateId = id(),
        createdAt = nowISO(),
        eventId = id();
      db.prepare(
        'INSERT INTO procedureTemplates(id,active,createdAt,updatedAt,latestVersionId,latestEventId) VALUES (?,1,?,?,?,?)',
      ).run(templateId, createdAt, createdAt, 'pending', eventId);
      const created = saveVersion(
        templateId,
        1,
        input.fields,
        input.reason,
        user,
        doctor!,
        createdAt,
      );
      db.prepare('UPDATE procedureTemplates SET latestVersionId=? WHERE id=?').run(
        created.id,
        templateId,
      );
      const event = saveEvent(
        req,
        user,
        doctor,
        templateId,
        'created',
        created.id,
        null,
        { active: true, latestVersionId: created.id, publishedVersionId: null },
        input,
        createdAt,
        eventId,
      );
      return { value: mutation(event), replayed: false };
    });
    res.status(result.replayed ? 200 : 201).json(result.value);
  });
  for (const operation of ['versions', 'publish', 'availability'] as const)
    app.post(`/api/procedure-catalogue/:id/${operation}`, (req: AuthRequest, res) => {
      emptyQuery(req);
      const templateId = String(req.params.id);
      const input = (
        operation === 'versions'
          ? z.object({ fields: procedureTemplateFields, ...command }).strict()
          : operation === 'publish'
            ? z
                .object({ versionId: z.string().uuid(), reviewed: z.literal(true), ...command })
                .strict()
            : z.object({ active: z.boolean(), ...command }).strict()
      ).parse(req.body);
      res.json(
        transaction(() => {
          const { user, doctor } = authorize(
            req,
            operation !== 'availability',
            operation === 'availability',
          );
          const eventOperation =
            operation === 'versions'
              ? 'version-added'
              : operation === 'publish'
                ? 'published'
                : 'active' in input && input.active
                  ? 'reactivated'
                  : 'archived';
          const prior = replay(user, eventOperation, templateId, input);
          if (prior)
            return mutation(
              get<ProcedureTemplateEvent>(db, 'procedureTemplateEvents', prior.eventId!)!,
            );
          const row = source(templateId);
          assertRevision(row, input.expectedRevision);
          const before = state(row),
            createdAt = nowISO();
          let versionId: string | null = null;
          if (operation === 'versions' && 'fields' in input) {
            if (
              JSON.stringify(version(row.latestVersionId).fields) === JSON.stringify(input.fields)
            )
              fail(400, 'The template content is unchanged.');
            const created = saveVersion(
              templateId,
              Number(row.latestVersion) + 1,
              input.fields,
              input.reason,
              user,
              doctor!,
              createdAt,
            );
            versionId = created.id;
            db.prepare('UPDATE procedureTemplates SET latestVersionId=? WHERE id=?').run(
              versionId,
              templateId,
            );
          } else if (operation === 'publish' && 'versionId' in input) {
            if (!row.active) fail(409, 'Restore this procedure template before publishing it.');
            if (row.latestVersionId !== input.versionId)
              fail(409, 'Publish the latest saved version after reviewing its content.');
            if (row.publishedVersionId === input.versionId)
              fail(400, 'This version is already published.');
            versionId = String(input.versionId);
            db.prepare('UPDATE procedureTemplates SET publishedVersionId=? WHERE id=?').run(
              versionId,
              templateId,
            );
          } else if ('active' in input) {
            if (Boolean(row.active) === input.active)
              fail(400, 'The template availability is unchanged.');
            db.prepare('UPDATE procedureTemplates SET active=? WHERE id=?').run(
              input.active ? 1 : 0,
              templateId,
            );
          }
          const event = saveEvent(
            req,
            user,
            doctor,
            templateId,
            eventOperation,
            versionId,
            before,
            state(source(templateId)),
            input,
            createdAt,
          );
          if (operation === 'publish')
            db.prepare('UPDATE procedureTemplates SET publishedEventId=? WHERE id=?').run(
              event.id,
              templateId,
            );
          if (operation === 'availability')
            db.prepare('UPDATE procedureTemplates SET availabilityEventId=? WHERE id=?').run(
              event.id,
              templateId,
            );
          return mutation(event);
        }),
      );
    });
  /** Caller holds the plan-creation transaction; no catalogue content is copied implicitly. */
  function resolveSelection(
    selection: ProcedureTemplateSelection | undefined,
    fields: ProcedureTemplateFields,
  ): ProcedureTemplateSource | undefined {
    if (!selection) return undefined;
    const row = source(selection.templateId);
    if (
      !row.active ||
      !row.publishedVersionId ||
      row.publishedVersionId !== selection.versionId ||
      selectionRevision(row) !== selection.expectedSelectionRevision
    )
      return fail(
        409,
        'The selected procedure template changed or is no longer available. Refresh it and review the patient-specific explanation.',
      );
    const selected = version(row.publishedVersionId),
      publication = get<ProcedureTemplateEvent>(
        db,
        'procedureTemplateEvents',
        row.publishedEventId!,
      )!;
    return {
      templateId: row.id,
      versionId: selected.id,
      version: selected.version,
      templateTitle: selected.fields.title,
      publishedAt: publication.createdAt,
      reviewedByDoctorId: publication.doctorId!,
      reviewedByDoctorName: publication.doctorName!,
      customizedFields: fieldNames.filter((field) => fields[field] !== selected.fields[field]),
    };
  }
  function replayPlan(user: User, input: { requestId?: string }): ProcedureCreateReceipt | null {
    if (!input.requestId) return null;
    const prior = replay(user, 'plan-created', null, input as { requestId: string });
    return prior ? (JSON.parse(prior.receipt!) as ProcedureCreateReceipt) : null;
  }
  function recordPlan(
    user: User,
    input: { requestId?: string; templateSelection?: ProcedureTemplateSelection },
    plan: Pick<ProcedureRecord, 'id' | 'patientId' | 'appointmentId' | 'createdAt'>,
  ): ProcedureCreateReceipt | null {
    if (!input.requestId) return null;
    const value: ProcedureCreateReceipt = {
      requestId: input.requestId,
      createdById: user.id,
      patientId: plan.patientId,
      procedureId: plan.id,
      appointmentId: plan.appointmentId,
      templateSelection: input.templateSelection ?? null,
      createdAt: plan.createdAt,
    };
    receipt(user, 'plan-created', null, input as { requestId: string }, null, value);
    return value;
  }
  return { authorize, resolveSelection, replayPlan, recordPlan };
}
