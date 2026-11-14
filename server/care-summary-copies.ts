import { createHash } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import type { AuthRequest } from './app.ts';
import type { Patient, User } from '../shared/types.ts';
import type { CareSummary } from '../shared/care-summary.ts';
import type {
  CareSummaryCopy,
  CareSummaryCopyDetail,
  CareSummaryCopyPage,
  CareSummaryCopyReceipt,
  CareSummaryCopyResult,
} from '../shared/care-summary-copies.ts';
import { get, id, nowISO, type DB } from './db.ts';
import { mfaSessionAllowed } from './mfa.ts';
import { registerCareSummaryBundles } from './care-summary-bundles.ts';

interface Context {
  db: DB;
  actor: (req: AuthRequest, roles?: User['role'][]) => User;
  patientAccess: (req: AuthRequest, patientId: string, allowReception?: boolean) => Patient;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
  /** Same patient-facing builder as the live summary, called within our transaction. */
  snapshot: (patient: Patient) => CareSummary;
}

interface StoredCommand {
  requestId: string;
  actorId: string;
  operation: string;
  payload: string;
  copyId: string;
}

const MAX_BYTES = 10 * 1024 * 1024;
const empty = z.object({}).strict();
const reference = z.string().min(1).max(300);
const inputSchema = z
  .object({
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
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

export function registerCareSummaryCopies(app: Express, context: Context) {
  const { db, actor, patientAccess, audit, fail, snapshot } = context;
  db.exec(`
    CREATE TABLE IF NOT EXISTS careSummaryCopies (
      id TEXT PRIMARY KEY,
      patientId TEXT NOT NULL REFERENCES patients(id),
      savedAt TEXT NOT NULL,
      data TEXT NOT NULL,
      body BLOB NOT NULL CHECK(length(body) <= ${MAX_BYTES})
    );
    CREATE INDEX IF NOT EXISTS care_summary_copies_patient_created
      ON careSummaryCopies(patientId,savedAt DESC,id DESC);
    CREATE TABLE IF NOT EXISTS careSummaryCopyCommands (
      requestId TEXT PRIMARY KEY,
      actorId TEXT NOT NULL REFERENCES users(id),
      operation TEXT NOT NULL CHECK(operation = 'save'),
      payload TEXT NOT NULL,
      copyId TEXT NOT NULL UNIQUE REFERENCES careSummaryCopies(id)
    );
  `);
  for (const table of ['careSummaryCopies', 'careSummaryCopyCommands'])
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS ${table}_immutable_update BEFORE UPDATE ON ${table}
        BEGIN SELECT RAISE(ABORT,'Saved care summaries are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS ${table}_immutable_delete BEFORE DELETE ON ${table}
        BEGIN SELECT RAISE(ABORT,'Saved care summaries are immutable'); END;
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

  function authorize(req: AuthRequest) {
    const cached = actor(req, ['patient', 'doctor', 'admin']);
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
    if (user.mustChangePassword || !['patient', 'doctor', 'admin'].includes(user.role))
      return fail(403, 'This account cannot access saved care summaries.');
    req.user = user;
    return user as User & { role: CareSummaryCopy['savedBy']['role'] };
  }

  function copyMetadata(patientId: string, copyId: string): CareSummaryCopy {
    const row = db
      .prepare('SELECT data FROM careSummaryCopies WHERE id=? AND patientId=?')
      .get(copyId, patientId);
    if (!row) return fail(404, 'Saved care summary not found.');
    return JSON.parse(row.data as string) as CareSummaryCopy;
  }

  const base = '/api/patients/:id/care-summary/copies';
  app.post(base, (req: AuthRequest, res) => {
    empty.parse(req.query);
    const patientId = reference.parse(req.params.id);
    const input = inputSchema.parse(req.body);
    const payload = JSON.stringify({ patientId, expectedRevision: input.expectedRevision });
    const result = transaction(() => {
      const user = authorize(req);
      const patient = patientAccess(req, patientId);
      const prior = db
        .prepare(
          'SELECT requestId,actorId,operation,payload,copyId FROM careSummaryCopyCommands WHERE requestId=?',
        )
        .get(input.requestId) as unknown as StoredCommand | undefined;
      if (prior) {
        if (prior.actorId !== user.id || prior.operation !== 'save' || prior.payload !== payload)
          return fail(409, 'This request ID has already been used for a different operation.');
        const copy = copyMetadata(patientId, prior.copyId);
        const receipt: CareSummaryCopyReceipt = {
          requestId: prior.requestId,
          actorId: prior.actorId,
          patientId,
          expectedRevision: input.expectedRevision,
          copyId: prior.copyId,
        };
        return { value: { copy, receipt } satisfies CareSummaryCopyResult, status: 200 };
      }

      const summary = snapshot(patient);
      if (summary.revision !== input.expectedRevision)
        return fail(
          409,
          'The shared care record has changed. Refresh this summary before saving a copy.',
        );
      const body = Buffer.from(JSON.stringify(summary, null, 2) + '\n', 'utf8');
      if (body.length > MAX_BYTES)
        return fail(
          413,
          'This care summary exceeds the 10 MiB saved-copy limit. No partial copy was saved.',
        );
      const copy: CareSummaryCopy = {
        id: id(),
        patientId,
        patientName: summary.patient.name,
        sourceRevision: summary.revision,
        generatedAt: summary.generatedAt,
        savedAt: nowISO(),
        savedBy: { name: user.name, role: user.role },
        contentSha256: createHash('sha256').update(body).digest('hex'),
        byteLength: body.length,
      };
      const receipt: CareSummaryCopyReceipt = {
        requestId: input.requestId,
        actorId: user.id,
        patientId,
        expectedRevision: input.expectedRevision,
        copyId: copy.id,
      };
      db.prepare(
        'INSERT INTO careSummaryCopies(id,patientId,savedAt,data,body) VALUES (?,?,?,?,?)',
      ).run(copy.id, patientId, copy.savedAt, JSON.stringify(copy), body);
      db.prepare(
        'INSERT INTO careSummaryCopyCommands(requestId,actorId,operation,payload,copyId) VALUES (?,?,?,?,?)',
      ).run(input.requestId, user.id, 'save', payload, copy.id);
      audit(req, 'saved patient-facing care summary copy', 'care-summary-copy', copy.id);
      return { value: { copy, receipt } satisfies CareSummaryCopyResult, status: 201 };
    });
    res.status(result.status).json(result.value);
  });

  app.get(base, (req: AuthRequest, res) => {
    const patientId = reference.parse(req.params.id);
    const query = pageSchema.parse(req.query);
    const result = transaction((): CareSummaryCopyPage => {
      authorize(req);
      patientAccess(req, patientId);
      const total = Number(
        db.prepare('SELECT COUNT(*) AS n FROM careSummaryCopies WHERE patientId=?').get(patientId)
          ?.n ?? 0,
      );
      const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
      const page = Math.min(query.page, totalPages);
      // Snapshot bodies are deliberately absent from the list query, before and after LIMIT.
      const rows = db
        .prepare(
          'SELECT data FROM careSummaryCopies WHERE patientId=? ORDER BY savedAt DESC,id DESC LIMIT ? OFFSET ?',
        )
        .all(patientId, query.pageSize, (page - 1) * query.pageSize);
      const items = rows.map((row) => JSON.parse(row.data as string) as CareSummaryCopy);
      audit(req, 'viewed patient-facing care summary copy list', 'care-summary-copy', patientId);
      return { items, page, pageSize: query.pageSize, total, totalPages };
    });
    res.json(result);
  });

  function read(req: AuthRequest, download: boolean) {
    empty.parse(req.query);
    const patientId = reference.parse(req.params.id);
    const copyId = reference.parse(req.params.copyId);
    return transaction(() => {
      authorize(req);
      patientAccess(req, patientId);
      const row = db
        .prepare('SELECT data,body FROM careSummaryCopies WHERE id=? AND patientId=?')
        .get(copyId, patientId);
      if (!row) return fail(404, 'Saved care summary not found.');
      const copy = JSON.parse(row.data as string) as CareSummaryCopy;
      const body = Buffer.from(row.body as Uint8Array);
      audit(
        req,
        download
          ? 'downloaded patient-facing care summary copy'
          : 'viewed patient-facing care summary copy',
        'care-summary-copy',
        copyId,
      );
      return { copy, body };
    });
  }

  app.get(`${base}/:copyId/download`, (req: AuthRequest, res) => {
    const { copy, body } = read(req, true);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="care-summary-copy-${copy.id}.json"`,
    );
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', body.length);
    res.setHeader('X-Content-SHA256', copy.contentSha256);
    // End with stored bytes rather than serializing again or allowing conditional 304 responses.
    res.end(body);
  });

  app.get(`${base}/:copyId`, (req: AuthRequest, res) => {
    const { copy, body } = read(req, false);
    const value: CareSummaryCopyDetail = {
      copy,
      summary: JSON.parse(body.toString('utf8')) as CareSummary,
    };
    res.json(value);
  });
  registerCareSummaryBundles(app, { db, authorize, patientAccess, transaction, audit, fail });
}
