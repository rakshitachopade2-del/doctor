import type { Express } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AuthRequest } from './app.ts';
import { get, id, nowISO, type DB } from './db.ts';
import { mfaSessionAllowed } from './mfa.ts';
import type { User } from '../shared/types.ts';
import type { KnowledgeArticle } from '../shared/operations.ts';
import type {
  KnowledgeFields,
  KnowledgeVersion,
  KnowledgeEvent,
  KnowledgeState,
  KnowledgeAuthoringDetail,
  KnowledgeAuthoringMutation,
  KnowledgeAuthoringRow,
} from '../shared/knowledge-authoring.ts';

interface Context {
  db: DB;
  actor: (req: AuthRequest, roles?: User['role'][]) => User;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
}
interface Head {
  articleId: string;
  currentVersionId: string;
  latestEventId: string | null;
  publishedEventId: string | null;
}
interface Source {
  article: KnowledgeArticle;
  rawData: string;
  head: Head;
  version: KnowledgeVersion;
}
interface Command {
  requestId: string;
  actorId: string;
  operation: string;
  targetId: string | null;
  articleId: string;
  payload: string;
  eventId: string;
}
const fields = z
  .object({
    title: z.string().trim().min(1).max(300),
    category: z.string().trim().min(1).max(100),
    body: z.string().trim().min(1).max(30000),
  })
  .strict();
const note = z.string().trim().max(1000).default('');
const requestId = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const existingCommand = { reason: note, requestId, expectedRevision: revision };
const saveFields = {
  fields,
  publication: z.enum(['draft', 'published']),
  reviewed: z.literal(true).optional(),
};
const createSchema = z.object({ ...saveFields, reason: note, requestId }).strict();
const saveSchema = z.object({ ...saveFields, ...existingCommand }).strict();
const publicationSchema = z
  .object({ published: z.boolean(), reviewed: z.literal(true).optional(), ...existingCommand })
  .strict();
const restoreSchema = z
  .object({
    ...existingCommand,
    versionId: z.string().uuid(),
    confirmed: z.literal(true),
    reason: z.string().trim().min(3).max(1000),
  })
  .strict();
const empty = z.object({}).strict();
const pageQuery = z
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
const listQuery = pageQuery
  .extend({
    q: z.string().trim().max(200).default(''),
    status: z.enum(['all', 'draft', 'published']).default('all'),
  })
  .strict();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const content = (article: KnowledgeArticle): KnowledgeFields => ({
  title: article.title,
  category: article.category,
  body: article.body,
});
const projectArticle = (raw: string, articleId: string): KnowledgeArticle => {
  const value = JSON.parse(raw) as KnowledgeArticle;
  return {
    id: articleId,
    title: value.title,
    category: value.category,
    body: value.body,
    status: value.status,
    authorName: value.authorName,
    updatedAt: value.updatedAt,
  };
};

export function registerKnowledgeAuthoring(app: Express, context: Context) {
  const { db, actor, audit, fail } = context;
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledgeVersions (
      id TEXT PRIMARY KEY, articleId TEXT NOT NULL REFERENCES knowledge(id), version INTEGER NOT NULL,
      data TEXT NOT NULL, UNIQUE(articleId,version)
    );
    CREATE TABLE IF NOT EXISTS knowledgeEvents (
      id TEXT PRIMARY KEY, articleId TEXT NOT NULL REFERENCES knowledge(id), data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS knowledge_events_article ON knowledgeEvents(articleId);
    CREATE TABLE IF NOT EXISTS knowledgeAuthoringHeads (
      articleId TEXT PRIMARY KEY REFERENCES knowledge(id),
      currentVersionId TEXT NOT NULL REFERENCES knowledgeVersions(id),
      latestEventId TEXT REFERENCES knowledgeEvents(id), publishedEventId TEXT REFERENCES knowledgeEvents(id)
    );
    CREATE TABLE IF NOT EXISTS knowledgeCommands (
      requestId TEXT PRIMARY KEY, actorId TEXT NOT NULL REFERENCES users(id), operation TEXT NOT NULL,
      targetId TEXT, articleId TEXT NOT NULL REFERENCES knowledge(id), payload TEXT NOT NULL,
      eventId TEXT NOT NULL REFERENCES knowledgeEvents(id)
    );
    CREATE INDEX IF NOT EXISTS knowledge_authoring_updated ON knowledge(json_extract(data,'$.updatedAt') DESC,id DESC);
    CREATE INDEX IF NOT EXISTS knowledge_legacy_article ON knowledgeRevisions(articleId);
  `);
  for (const table of ['knowledgeVersions', 'knowledgeEvents', 'knowledgeCommands'])
    db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${table}_immutable_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Knowledge evidence is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ${table}_immutable_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Knowledge evidence is immutable'); END;
  `);
  function transaction<T>(work: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  function authorize(req: AuthRequest) {
    const cached = actor(req, ['admin', 'doctor']);
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
    if (user.mustChangePassword || !['admin', 'doctor'].includes(user.role))
      return fail(403, 'This account cannot access knowledge authoring.');
    req.user = user;
    return user as User & { role: 'admin' | 'doctor' };
  }
  function storeVersion(value: KnowledgeVersion) {
    db.prepare('INSERT INTO knowledgeVersions(id,articleId,version,data) VALUES (?,?,?,?)').run(
      value.id,
      value.articleId,
      value.version,
      JSON.stringify(value),
    );
    return value;
  }
  function legacyVersion(article: KnowledgeArticle, sequence: number, revisionId: string | null) {
    return storeVersion({
      id: id(),
      articleId: article.id,
      version: sequence,
      fields: content(article),
      origin: revisionId ? 'legacy-snapshot' : 'legacy-current',
      restoredFromVersionId: null,
      reason: null,
      createdById: null,
      createdByName: null,
      createdByRole: null,
      createdAt: null,
      legacy: {
        revisionId,
        authorName: article.authorName,
        updatedAt: article.updatedAt,
        status: article.status,
      },
    });
  }
  /** Import factual retained snapshots only; no fabricated author, approval or action timestamp. */
  function initializeArticle(articleId: string, rawData: string) {
    if (db.prepare('SELECT 1 FROM knowledgeAuthoringHeads WHERE articleId=?').get(articleId))
      return;
    let cursor = 0,
      sequence = 0;
    for (;;) {
      const rows = db
        .prepare(
          'SELECT rowid AS sourceRow,id,data FROM knowledgeRevisions WHERE articleId=? AND rowid>? ORDER BY rowid LIMIT 100',
        )
        .all(articleId, cursor) as { sourceRow: number; id: string; data: string }[];
      for (const row of rows) {
        legacyVersion(projectArticle(row.data, articleId), ++sequence, row.id);
        cursor = Number(row.sourceRow);
      }
      if (rows.length < 100) break;
    }
    const baseline = legacyVersion(projectArticle(rawData, articleId), ++sequence, null);
    db.prepare(
      'INSERT INTO knowledgeAuthoringHeads(articleId,currentVersionId,latestEventId,publishedEventId) VALUES (?,?,NULL,NULL)',
    ).run(articleId, baseline.id);
  }
  function initializeMissing() {
    for (;;) {
      const rows = db
        .prepare(
          'SELECT k.id,k.data FROM knowledge k LEFT JOIN knowledgeAuthoringHeads h ON h.articleId=k.id WHERE h.articleId IS NULL ORDER BY k.rowid LIMIT 100',
        )
        .all() as { id: string; data: string }[];
      for (const row of rows) initializeArticle(row.id, row.data);
      if (rows.length < 100) break;
    }
  }
  transaction(initializeMissing);
  const versionById = (versionId: string) =>
    get<KnowledgeVersion>(db, 'knowledgeVersions', versionId);
  function source(articleId: string): Source {
    const row = db.prepare('SELECT data FROM knowledge WHERE id=?').get(articleId) as
      { data: string } | undefined;
    if (!row) return fail(404, 'Article not found.');
    initializeArticle(articleId, row.data);
    const head = db
      .prepare('SELECT * FROM knowledgeAuthoringHeads WHERE articleId=?')
      .get(articleId) as unknown as Head;
    return {
      article: projectArticle(row.data, articleId),
      rawData: row.data,
      head,
      version: versionById(head.currentVersionId)!,
    };
  }
  const currentRevision = (value: Source) =>
    hash([
      value.rawData,
      value.head.currentVersionId,
      value.head.latestEventId,
      value.head.publishedEventId,
    ]);
  const state = (value: Source): KnowledgeState => ({
    status: value.article.status,
    currentVersionId: value.version.id,
    currentVersion: value.version.version,
  });
  function detail(articleId: string): KnowledgeAuthoringDetail {
    const value = source(articleId);
    return {
      article: value.article,
      revision: currentRevision(value),
      currentVersion: value.version,
      publication: value.head.publishedEventId
        ? get<KnowledgeEvent>(db, 'knowledgeEvents', value.head.publishedEventId)!
        : null,
      history: db
        .prepare('SELECT data FROM knowledgeEvents WHERE articleId=? ORDER BY rowid DESC LIMIT 25')
        .all(articleId)
        .map((row) => JSON.parse(row.data as string) as KnowledgeEvent),
      historyTotal: Number(
        db.prepare('SELECT count(*) AS n FROM knowledgeEvents WHERE articleId=?').get(articleId)!.n,
      ),
      versionTotal: Number(
        db.prepare('SELECT count(*) AS n FROM knowledgeVersions WHERE articleId=?').get(articleId)!
          .n,
      ),
    };
  }
  const mutation = (eventId: string): KnowledgeAuthoringMutation => {
    const event = get<KnowledgeEvent>(db, 'knowledgeEvents', eventId)!;
    return { detail: detail(event.articleId), event, version: versionById(event.versionId)! };
  };
  function replay(
    user: User,
    operation: string,
    targetId: string | null,
    input: { requestId: string },
  ) {
    const prior = db
      .prepare('SELECT * FROM knowledgeCommands WHERE requestId=?')
      .get(input.requestId) as unknown as Command | undefined;
    if (!prior) return null;
    if (
      prior.actorId !== user.id ||
      prior.operation !== operation ||
      prior.targetId !== targetId ||
      prior.payload !== JSON.stringify(input)
    )
      return fail(409, 'This request ID was already used with different knowledge details.');
    return mutation(prior.eventId);
  }
  function receipt(
    user: User,
    operation: string,
    targetId: string | null,
    input: { requestId: string },
    event: KnowledgeEvent,
  ) {
    db.prepare(
      'INSERT INTO knowledgeCommands(requestId,actorId,operation,targetId,articleId,payload,eventId) VALUES (?,?,?,?,?,?,?)',
    ).run(
      input.requestId,
      user.id,
      operation,
      targetId,
      event.articleId,
      JSON.stringify(input),
      event.id,
    );
  }
  function checkRevision(value: Source, expected: string) {
    if (currentRevision(value) !== expected)
      fail(409, 'This article changed. Review the latest version before saving again.');
  }
  function record(
    req: AuthRequest,
    user: User & { role: 'admin' | 'doctor' },
    prior: Source | null,
    desired: KnowledgeFields,
    targetStatus: 'draft' | 'published',
    command: {
      operation: KnowledgeEvent['operation'];
      reason: string;
      requestId?: string;
      expectedRevision?: string;
      reviewed: boolean;
      restoredFrom?: KnowledgeVersion;
      legacy?: boolean;
    },
  ) {
    const articleId = prior?.article.id ?? id(),
      createdAt = nowISO();
    const changed = !prior || JSON.stringify(content(prior.article)) !== JSON.stringify(desired);
    const article: KnowledgeArticle = {
      ...desired,
      id: articleId,
      status: targetStatus,
      authorName:
        prior && targetStatus === 'published' && !command.reviewed
          ? prior.article.authorName
          : user.name,
      updatedAt: createdAt,
    };
    if (prior) {
      db.prepare('INSERT INTO knowledgeRevisions(id,articleId,data) VALUES (?,?,?)').run(
        id(),
        articleId,
        prior.rawData,
      );
      db.prepare('UPDATE knowledge SET data=? WHERE id=?').run(JSON.stringify(article), articleId);
    } else
      db.prepare('INSERT INTO knowledge(id,data) VALUES (?,?)').run(
        articleId,
        JSON.stringify(article),
      );
    const version =
      changed || command.restoredFrom
        ? storeVersion({
            id: id(),
            articleId,
            version: (prior?.version.version ?? 0) + 1,
            fields: desired,
            origin: command.restoredFrom ? 'restored' : prior ? 'saved' : 'created',
            restoredFromVersionId: command.restoredFrom?.id ?? null,
            reason: command.reason,
            createdById: user.id,
            createdByName: user.name,
            createdByRole: user.role,
            createdAt,
            legacy: null,
          })
        : prior!.version;
    const event: KnowledgeEvent = {
      id: id(),
      articleId,
      operation: command.operation,
      source: command.legacy ? 'legacy-api' : 'command',
      before: prior ? state(prior) : null,
      after: {
        status: targetStatus,
        currentVersionId: version.id,
        currentVersion: version.version,
      },
      versionId: version.id,
      restoredFromVersionId: command.restoredFrom?.id ?? null,
      reason: command.reason,
      reviewConfirmed: command.reviewed,
      restoreConfirmed: !!command.restoredFrom,
      requestId: command.requestId ?? null,
      expectedRevision: command.expectedRevision ?? null,
      createdById: user.id,
      createdByName: user.name,
      createdByRole: user.role,
      createdAt,
    };
    db.prepare('INSERT INTO knowledgeEvents(id,articleId,data) VALUES (?,?,?)').run(
      event.id,
      articleId,
      JSON.stringify(event),
    );
    const publishedEventId =
      targetStatus === 'draft'
        ? null
        : command.reviewed
          ? event.id
          : (prior?.head.publishedEventId ?? null);
    db.prepare(
      'INSERT INTO knowledgeAuthoringHeads(articleId,currentVersionId,latestEventId,publishedEventId) VALUES (?,?,?,?) ON CONFLICT(articleId) DO UPDATE SET currentVersionId=excluded.currentVersionId,latestEventId=excluded.latestEventId,publishedEventId=excluded.publishedEventId',
    ).run(articleId, version.id, event.id, publishedEventId);
    audit(
      req,
      targetStatus === 'published' && command.reviewed
        ? 'approved and published knowledge'
        : targetStatus === 'published'
          ? 'saved knowledge article'
          : prior
            ? 'saved knowledge draft'
            : 'created knowledge draft',
      'knowledge',
      articleId,
    );
    return event;
  }
  const pageMeta = (total: number, requested: number, pageSize: number) => {
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    return { total, totalPages, page: Math.min(requested, totalPages), pageSize };
  };
  app.get('/api/knowledge-authoring', (req: AuthRequest, res) => {
    const query = listQuery.parse(req.query);
    res.json(
      transaction(() => {
        authorize(req);
        initializeMissing();
        const clauses: string[] = [],
          parameters: string[] = [];
        if (query.status !== 'all') {
          clauses.push("json_extract(k.data,'$.status')=?");
          parameters.push(query.status);
        }
        if (query.q) {
          clauses.push(
            "(instr(lower(json_extract(k.data,'$.title')),lower(?))>0 OR instr(lower(json_extract(k.data,'$.category')),lower(?))>0 OR instr(lower(json_extract(k.data,'$.body')),lower(?))>0)",
          );
          parameters.push(query.q, query.q, query.q);
        }
        const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
        const total = Number(
          db.prepare(`SELECT count(*) AS n FROM knowledge k${where}`).get(...parameters)!.n,
        );
        const pagination = pageMeta(total, query.page, query.pageSize);
        const rows = db
          .prepare(
            `SELECT k.id,k.data,h.currentVersionId,h.latestEventId,h.publishedEventId,v.version FROM knowledge k JOIN knowledgeAuthoringHeads h ON h.articleId=k.id JOIN knowledgeVersions v ON v.id=h.currentVersionId${where} ORDER BY json_extract(k.data,'$.updatedAt') DESC,k.id DESC LIMIT ? OFFSET ?`,
          )
          .all(
            ...parameters,
            pagination.pageSize,
            (pagination.page - 1) * pagination.pageSize,
          ) as unknown as (Head & { id: string; data: string; version: number })[];
        const items: KnowledgeAuthoringRow[] = rows.map((row) => {
          const { body: _body, ...article } = projectArticle(row.data, row.id);
          return {
            ...article,
            currentVersion: Number(row.version),
            revision: hash([
              row.data,
              row.currentVersionId,
              row.latestEventId,
              row.publishedEventId,
            ]),
          };
        });
        audit(req, 'viewed knowledge authoring list', 'knowledge', 'library');
        return { items, filters: { q: query.q, status: query.status }, ...pagination };
      }),
    );
  });
  app.get('/api/knowledge-authoring/:id', (req: AuthRequest, res) => {
    empty.parse(req.query);
    res.json(
      transaction(() => {
        authorize(req);
        const value = detail(String(req.params.id));
        audit(req, 'viewed knowledge authoring', 'knowledge', value.article.id);
        return value;
      }),
    );
  });
  for (const kind of ['versions', 'history'] as const)
    app.get(`/api/knowledge-authoring/:id/${kind}`, (req: AuthRequest, res) => {
      const query = pageQuery.parse(req.query),
        articleId = String(req.params.id);
      res.json(
        transaction(() => {
          authorize(req);
          source(articleId);
          const table = kind === 'versions' ? 'knowledgeVersions' : 'knowledgeEvents';
          const total = Number(
            db.prepare(`SELECT count(*) AS n FROM ${table} WHERE articleId=?`).get(articleId)!.n,
          );
          const pagination = pageMeta(total, query.page, query.pageSize);
          const items = db
            .prepare(
              `SELECT data FROM ${table} WHERE articleId=? ORDER BY ${kind === 'versions' ? 'version' : 'rowid'} DESC LIMIT ? OFFSET ?`,
            )
            .all(articleId, pagination.pageSize, (pagination.page - 1) * pagination.pageSize)
            .map((row) => JSON.parse(row.data as string));
          audit(req, `viewed knowledge ${kind}`, 'knowledge', articleId);
          return { articleId, items, ...pagination };
        }),
      );
    });
  app.get('/api/knowledge-authoring/:id/versions/:versionId', (req: AuthRequest, res) => {
    empty.parse(req.query);
    const articleId = String(req.params.id);
    res.json(
      transaction(() => {
        authorize(req);
        source(articleId);
        const value = versionById(String(req.params.versionId));
        if (!value || value.articleId !== articleId)
          return fail(404, 'Knowledge version not found.');
        audit(req, 'viewed knowledge version', 'knowledge', articleId);
        return value;
      }),
    );
  });
  app.post('/api/knowledge-authoring', (req: AuthRequest, res) => {
    empty.parse(req.query);
    const input = createSchema.parse(req.body);
    let duplicate = false;
    const result = transaction(() => {
      const user = authorize(req),
        prior = replay(user, 'create', null, input);
      if (prior) {
        duplicate = true;
        return prior;
      }
      if (input.publication === 'published' && !input.reviewed)
        return fail(400, 'Confirm review before publishing this article.');
      const event = record(req, user, null, input.fields, input.publication, {
        operation: 'created',
        reason: input.reason,
        requestId: input.requestId,
        reviewed: !!input.reviewed,
      });
      receipt(user, 'create', null, input, event);
      return mutation(event.id);
    });
    res.status(duplicate ? 200 : 201).json(result);
  });
  for (const operation of ['save', 'publication', 'restore'] as const)
    app.post(`/api/knowledge-authoring/:id/${operation}`, (req: AuthRequest, res) => {
      empty.parse(req.query);
      const input =
        operation === 'save'
          ? saveSchema.parse(req.body)
          : operation === 'publication'
            ? publicationSchema.parse(req.body)
            : restoreSchema.parse(req.body);
      const articleId = String(req.params.id);
      res.json(
        transaction(() => {
          const user = authorize(req),
            prior = replay(user, operation, articleId, input);
          if (prior) return prior;
          const current = source(articleId);
          checkRevision(current, input.expectedRevision);
          let desired = content(current.article),
            status = current.article.status,
            reviewed = false;
          let restoredFrom: KnowledgeVersion | undefined;
          let eventOperation: KnowledgeEvent['operation'] = 'saved';
          if ('fields' in input) {
            desired = input.fields;
            status = input.publication;
            reviewed = !!input.reviewed;
            if (
              JSON.stringify(desired) === JSON.stringify(content(current.article)) &&
              status === current.article.status
            )
              return fail(400, 'No article changes were supplied.');
          } else if ('published' in input) {
            status = input.published ? 'published' : 'draft';
            reviewed = !!input.reviewed;
            if (status === current.article.status)
              return fail(400, 'The article already has this publication status.');
            eventOperation = input.published ? 'published' : 'withdrawn';
          } else {
            restoredFrom = versionById(input.versionId);
            if (!restoredFrom || restoredFrom.articleId !== articleId)
              return fail(404, 'Knowledge version not found.');
            if (restoredFrom.id === current.version.id)
              return fail(400, 'Choose an earlier version to restore.');
            desired = restoredFrom.fields;
            status = 'draft';
            eventOperation = 'restored';
          }
          if (status === 'published' && !reviewed)
            return fail(400, 'Confirm review before publishing this article.');
          const event = record(req, user, current, desired, status, {
            operation: eventOperation,
            reason: input.reason,
            requestId: input.requestId,
            expectedRevision: input.expectedRevision,
            reviewed,
            restoredFrom,
          });
          receipt(user, operation, articleId, input, event);
          return mutation(event.id);
        }),
      );
    });

  // Compatibility adapters keep the existing response shapes. New UI uses guarded commands above.
  app.get('/api/knowledge/manage', (req: AuthRequest, res) => {
    res.json(
      transaction(() => {
        authorize(req);
        initializeMissing();
        return db
          .prepare('SELECT id,data FROM knowledge ORDER BY rowid DESC')
          .all()
          .map((row) => projectArticle(row.data as string, row.id as string));
      }),
    );
  });
  app.post('/api/knowledge', (req: AuthRequest, res) => {
    const input = fields.strip().parse(req.body);
    const result = transaction(() => {
      const user = authorize(req);
      const event = record(req, user, null, input, 'draft', {
        operation: 'created',
        reason: 'Legacy API draft creation.',
        reviewed: false,
        legacy: true,
      });
      return detail(event.articleId).article;
    });
    res.status(201).json(result);
  });
  app.patch('/api/knowledge/:id', (req: AuthRequest, res) => {
    const input = fields
      .extend({ status: z.enum(['draft', 'published']) })
      .partial()
      .strict()
      .refine((value) => Object.keys(value).length > 0, 'No changes supplied')
      .parse(req.body);
    res.json(
      transaction(() => {
        const user = authorize(req),
          current = source(String(req.params.id));
        const desired = {
          ...content(current.article),
          ...('title' in input ? { title: input.title! } : {}),
          ...('category' in input ? { category: input.category! } : {}),
          ...('body' in input ? { body: input.body! } : {}),
        };
        const changed = JSON.stringify(desired) !== JSON.stringify(content(current.article));
        const status = input.status ?? (changed ? 'draft' : current.article.status);
        const event = record(req, user, current, desired, status, {
          operation: changed
            ? 'saved'
            : input.status === 'published'
              ? 'published'
              : input.status === 'draft' && current.article.status === 'published'
                ? 'withdrawn'
                : 'saved',
          reason: 'Legacy API article update.',
          reviewed: input.status === 'published',
          legacy: true,
        });
        return detail(event.articleId).article;
      }),
    );
  });
}
