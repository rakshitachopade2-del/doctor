import type { Express } from 'express';
import { z } from 'zod';
import type { AuthRequest } from './app.ts';
import { get, list, type DB } from './db.ts';
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
