import type { Express } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AuthRequest } from './app.ts';
import { get, id, list, nowISO, type DB } from './db.ts';
import type { Patient, User } from '../shared/types.ts';
import type { PatientDocument } from '../shared/documents.ts';

interface DocumentsContext {
  db: DB;
  actor: (req: AuthRequest, roles?: User['role'][]) => User;
  patientAccess: (req: AuthRequest, patientId: string, allowReception?: boolean) => Patient;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
}

export function registerDocuments(app: Express, context: DocumentsContext) {
  const { db, actor, patientAccess, audit, fail } = context;
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY, patientId TEXT NOT NULL REFERENCES patients(id),
      data TEXT NOT NULL, bytes BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS documents_patient ON documents(patientId);
    CREATE TRIGGER IF NOT EXISTS prevent_document_update BEFORE UPDATE ON documents
      BEGIN SELECT RAISE(ABORT, 'Report documents are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS prevent_document_delete BEFORE DELETE ON documents
      BEGIN SELECT RAISE(ABORT, 'Report documents are append-only'); END;
  `);
  function owner(req: AuthRequest, supplied?: string) {
    const user = actor(req);
    const patientId = user.role === 'patient' ? user.patientId : supplied;
    if (!patientId) return fail(400, 'Select a patient.');
    if (user.role === 'patient' && supplied && supplied !== patientId)
      return fail(403, 'You can only access your own care record.');
    patientAccess(req, patientId);
    return patientId;
  }
  app.get('/api/documents', (req: AuthRequest, res) => {
    const input = z.object({ patientId: z.string().min(1).optional() }).parse(req.query);
    const patientId = owner(req, input.patientId);
    audit(req, 'viewed report document list', 'patient', patientId);
    res.json(list<PatientDocument>(db, 'documents', patientId));
  });
  app.post('/api/documents', (req: AuthRequest, res) => {
    const input = z
      .object({
        patientId: z.string().min(1).optional(),
        title: z.string().trim().min(1).max(200),
        originalName: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .refine(
            (value) => !/[\\/\u0000-\u001f\u007f]/.test(value),
            'Use a filename without path separators or control characters',
          )
          .refine((value) => /\.pdf$/i.test(value), 'Choose a PDF report'),
        dataUrl: z.string().max(7 * 1024 * 1024),
        consent: z.literal(true),
      })
      .strict()
      .parse(req.body);
    const patientId = owner(req, input.patientId);
    const user = actor(req);
    const match = /^data:application\/pdf;base64,([A-Za-z0-9+/]+={0,2})$/.exec(input.dataUrl);
    if (!match) return fail(400, 'Upload a PDF report.');
    const bytes = Buffer.from(match[1], 'base64');
    if (bytes.length > 5 * 1024 * 1024) return fail(413, 'Reports must be 5 MB or smaller.');
    // These are file-format checks, not a claim of malware scanning. Files are
    // downloaded as sandboxed attachments; uploaded PDFs are never embedded.
    if (
      bytes.toString('base64') !== match[1] ||
      !/^%PDF-(?:1\.[0-7]|2\.0)[\r\n ]/.test(bytes.subarray(0, 16).toString('latin1')) ||
      !/%%EOF\s*$/.test(bytes.subarray(-1024).toString('latin1'))
    )
      return fail(400, 'The file does not appear to be a complete PDF report.');
    const key = id();
    const document: PatientDocument = {
      id: key,
      patientId,
      title: input.title,
      originalName: input.originalName,
      mimeType: 'application/pdf',
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      createdById: user.id,
      createdByName: user.name,
      createdByRole: user.role,
      createdAt: nowISO(),
      consent: true,
      url: `/api/documents/${key}/file`,
    };
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO documents(id,patientId,data,bytes) VALUES (?,?,?,?)').run(
        key,
        patientId,
        JSON.stringify(document),
        bytes,
      );
      audit(req, 'uploaded private report document', 'document', key);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    res.status(201).json(document);
  });
  app.get('/api/documents/:id/file', (req: AuthRequest, res) => {
    actor(req);
    const document = get<PatientDocument>(db, 'documents', String(req.params.id));
    if (!document) return fail(404, 'Report not found.');
    patientAccess(req, document.patientId);
    const row = db.prepare('SELECT bytes FROM documents WHERE id=?').get(document.id) as {
      bytes: Uint8Array;
    };
    audit(req, 'downloaded private report document', 'document', document.id);
    res.setHeader('Content-Disposition', `attachment; filename="clinic-report-${document.id}.pdf"`);
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.type('application/pdf').send(Buffer.from(row.bytes));
  });
}
