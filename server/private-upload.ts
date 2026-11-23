import { createHash } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import type { AuthRequest } from './app.ts';
import { get, id, nowISO, settings, type DB } from './db.ts';
import { required, short } from './validation.ts';
import type { User } from '../shared/types.ts';
import type { PatientDocument } from '../shared/documents.ts';
import type {
  ImageUploadNotSaved,
  PrivateUploadFile,
  PrivateUploadKind,
  PrivateUploadResult,
  UploadedImage,
} from '../shared/private-upload.ts';

interface Dependencies {
  db: DB;
  resolvePatient: (req: AuthRequest, patientId?: string) => string;
  authorizePatientRecord: (
    req: AuthRequest,
    patientId?: string,
  ) => { user: User; patientId: string };
  transaction: <T>(work: () => T) => T;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
}
const dataUrl = z.string().max(7 * 1024 * 1024);
const consent = z.literal(true);
const imageSchema = z.object({
  patientId: required.optional(),
  caption: short.min(1),
  category: z.enum(['clinical', 'report']),
  dataUrl,
  consent,
});
const documentSchema = z
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
    dataUrl,
    consent,
  })
  .strict();
const commandFields = {
  patientId: required,
  requestId: z
    .string()
    .uuid()
    .transform((value) => value.toLowerCase()),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
};
const schemas = {
  image: { legacy: imageSchema, command: imageSchema.extend(commandFields).strict() },
  document: { legacy: documentSchema, command: documentSchema.extend(commandFields).strict() },
};
const emptyQuery = z.object({}).strict();
const maxBytes = 5 * 1024 * 1024;
const paused = 'This module is currently disabled by the clinic.';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

type Input = z.infer<typeof imageSchema> | z.infer<typeof documentSchema>;
type FileDetails =
  | Pick<UploadedImage, 'caption' | 'category' | 'mimeType'>
  | Pick<PatientDocument, 'originalName' | 'title' | 'mimeType'>;

function decode(input: Input, fail: Dependencies['fail']): { bytes: Buffer; details: FileDetails } {
  if ('caption' in input) {
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
      input.dataUrl,
    );
    if (!match) return fail(400, 'Upload a JPEG, PNG or WebP image.');
    const [, mimeType, base64] = match;
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length > maxBytes) return fail(413, 'Images must be 5 MB or smaller.');
    if (bytes.length < 12) return fail(400, 'The image file is invalid.');
    const valid =
      mimeType === 'image/png'
        ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : mimeType === 'image/jpeg'
          ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          : bytes.subarray(0, 4).toString() === 'RIFF' &&
            bytes.subarray(8, 12).toString() === 'WEBP';
    if (!valid) return fail(400, 'The image content does not match its file type.');
    return { bytes, details: { caption: input.caption, category: input.category, mimeType } };
  }
  const match = /^data:application\/pdf;base64,([A-Za-z0-9+/]+={0,2})$/.exec(input.dataUrl);
  if (!match) return fail(400, 'Upload a PDF report.');
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.length > maxBytes) return fail(413, 'Reports must be 5 MB or smaller.');
  if (
    bytes.toString('base64') !== match[1] ||
    !/^%PDF-(?:1\.[0-7]|2\.0)[\r\n ]/.test(bytes.subarray(0, 16).toString('latin1')) ||
    !/%%EOF\s*$/.test(bytes.subarray(-1024).toString('latin1'))
  )
    return fail(400, 'The file does not appear to be a complete PDF report.');
  return {
    bytes,
    details: { title: input.title, originalName: input.originalName, mimeType: 'application/pdf' },
  };
}

export function registerPrivateUploads(
  app: Express,
  { db, resolvePatient, authorizePatientRecord, transaction, audit, fail }: Dependencies,
) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS privateUploadCommands (
      requestId TEXT PRIMARY KEY, actorId TEXT NOT NULL REFERENCES users(id),
      patientId TEXT NOT NULL REFERENCES patients(id), kind TEXT NOT NULL, payloadHash TEXT NOT NULL,
      imageId TEXT UNIQUE REFERENCES images(id), documentId TEXT UNIQUE REFERENCES documents(id), rejection TEXT,
      CHECK ((kind='image' AND documentId IS NULL AND ((imageId IS NULL) <> (rejection IS NULL)))
          OR (kind='document' AND documentId IS NOT NULL AND imageId IS NULL AND rejection IS NULL))
    );
    CREATE TRIGGER IF NOT EXISTS private_upload_command_no_update BEFORE UPDATE ON privateUploadCommands
      BEGIN SELECT RAISE(ABORT,'Upload receipts are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS private_upload_command_no_delete BEFORE DELETE ON privateUploadCommands
      BEGIN SELECT RAISE(ABORT,'Upload receipts are immutable'); END;
  `);
  function upload(req: AuthRequest, kind: PrivateUploadKind, retryable: boolean) {
    if (retryable) emptyQuery.parse(req.query);
    if (!retryable && kind === 'image' && !settings(db).modules.images) return fail(403, paused);
    const schema = schemas[kind][retryable ? 'command' : 'legacy'];
    const input: Input & { requestId?: string; sha256?: string } = schema.parse(req.body);
    // Reject inaccessible records before processing a potentially large file. The
    // writer checks the current session, account and owner again under its lock.
    const requestedPatient = resolvePatient(req, input.patientId);
    const { bytes, details } = decode(input, fail);
    const sha256 = hash(bytes);
    const sizeBytes = bytes.length;
    const { requestId } = input;
    if (input.sha256 !== undefined && input.sha256 !== sha256)
      return fail(400, 'The fingerprint does not match the uploaded file.');
    const table = kind === 'image' ? 'images' : 'documents';
    const payloadHash = hash(
      JSON.stringify({ ...details, sha256, sizeBytes, consent: input.consent }),
    );

    return transaction(() => {
      const { user, patientId } = authorizePatientRecord(req, requestedPatient);
      const actorId = user.id;
      function success(requestId: string, file: PrivateUploadFile): PrivateUploadResult {
        const common = { requestId, actorId, patientId };
        return {
          receipt:
            'caption' in file
              ? { ...common, kind: 'image', file }
              : { ...common, kind: 'document', file },
        };
      }
      function rejection(requestId: string, reason: string): ImageUploadNotSaved {
        if (!('caption' in details)) throw new Error('Unexpected document upload rejection.');
        return {
          requestId,
          actorId,
          patientId,
          kind: 'image',
          ...details,
          sha256,
          sizeBytes,
          consent: true,
          code: 'UPLOAD_NOT_SAVED',
          message: reason,
        };
      }
      if (requestId) {
        const stored = db
          .prepare('SELECT * FROM privateUploadCommands WHERE requestId=?')
          .get(requestId);
        if (stored) {
          if (
            stored.actorId !== actorId ||
            stored.patientId !== patientId ||
            stored.kind !== kind ||
            stored.payloadHash !== payloadHash
          )
            return fail(409, 'This request ID was already used for a different file upload.');
          if (typeof stored.rejection === 'string')
            return { status: 403, body: rejection(requestId, stored.rejection) };
          const file = get<PrivateUploadFile>(
            db,
            table,
            String(stored.imageId ?? stored.documentId),
          );
          if (!file) throw new Error('Missing original uploaded file.');
          return { status: 200, body: success(requestId, file) };
        }
      }
      if (kind === 'image' && !settings(db).modules.images) {
        if (!requestId) return fail(403, paused);
        db.prepare(
          'INSERT INTO privateUploadCommands(requestId,actorId,patientId,kind,payloadHash,rejection) VALUES (?,?,?,?,?,?)',
        ).run(requestId, actorId, patientId, kind, payloadHash, paused);
        return { status: 403, body: rejection(requestId, paused) };
      }
      const key = id();
      const file: PrivateUploadFile = {
        ...details,
        id: key,
        patientId,
        sha256,
        sizeBytes,
        createdAt: nowISO(),
        consent: true,
        createdById: actorId,
        createdByName: user.name,
        createdByRole: user.role,
        url: `/api/${table}/${key}/file`,
      };
      db.prepare(`INSERT INTO ${table}(id,patientId,data,bytes) VALUES (?,?,?,?)`).run(
        key,
        patientId,
        JSON.stringify(file),
        bytes,
      );
      audit(
        req,
        kind === 'image' ? 'uploaded private image' : 'uploaded private report document',
        kind,
        key,
      );
      if (!requestId) return { status: 201, body: file };
      db.prepare(
        'INSERT INTO privateUploadCommands(requestId,actorId,patientId,kind,payloadHash,imageId,documentId) VALUES (?,?,?,?,?,?,?)',
      ).run(
        requestId,
        actorId,
        patientId,
        kind,
        payloadHash,
        kind === 'image' ? key : null,
        kind === 'document' ? key : null,
      );
      return { status: 201, body: success(requestId, file) };
    });
  }
  for (const [path, kind] of [
    ['images', 'image'],
    ['documents', 'document'],
  ] as const) {
    app.post(`/api/${path}`, (req: AuthRequest, res) => {
      const result = upload(req, kind, false);
      res.status(result.status).json(result.body);
    });
    app.post(`/api/${path}/upload`, (req: AuthRequest, res) => {
      const result = upload(req, kind, true);
      res.status(result.status).json(result.body);
    });
  }
}
