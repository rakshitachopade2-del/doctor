import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import type { Express } from 'express';
import { z } from 'zod';
import type { AuthRequest } from './app.ts';
import type { DB } from './db.ts';
import type { CareSummaryCopy } from '../shared/care-summary-copies.ts';
import type {
  CareSummaryAttachmentSelection,
  CareSummaryBundleAttachment,
  CareSummaryBundleAttachmentPage,
  CareSummaryBundleFile,
  CareSummaryBundleLimits,
  CareSummaryBundleManifest,
  CareSummaryBundlePreview,
} from '../shared/care-summary-bundles.ts';
import type { Role } from '../shared/types.ts';

interface Context {
  db: DB;
  authorize: (req: AuthRequest) => unknown;
  patientAccess: (req: AuthRequest, patientId: string) => unknown;
  transaction: <T>(work: () => T) => T;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
}
const limits: CareSummaryBundleLimits = {
  maxAttachments: 20,
  maxFileBytes: 5242880,
  maxBundleBytes: 26214400,
};
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/;
const reference = z.string().min(1).max(300);
const empty = z.object({}).strict();
const selectionSchema = z
  .array(z.object({ type: z.enum(['document', 'image']), id: reference }).strict())
  .min(1)
  .max(limits.maxAttachments)
  .refine((items) => new Set(items.map(key)).size === items.length, 'Select each attachment once.');
const previewSchema = z.object({ attachments: selectionSchema }).strict();
const downloadSchema = previewSchema.extend({ expectedRevision: z.string().regex(hashPattern) });
const pageSchema = z
  .object({
    page: z
      .string()
      .regex(/^[1-9]\d{0,6}$/)
      .transform(Number)
      .refine((v) => v <= 1000000)
      .default(1),
    pageSize: z.enum(['10', '25', '50']).transform(Number).default(25),
  })
  .strict();
const key = (item: CareSummaryAttachmentSelection) => `${item.type}:${item.id}`;
const compare = (a: CareSummaryAttachmentSelection, b: CareSummaryAttachmentSelection) =>
  key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const roles: Role[] = ['patient', 'doctor', 'admin', 'receptionist'];
const extensions: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};
type FrozenReference = CareSummaryBundleAttachment & { invalid: boolean };
interface Entry {
  path: string;
  bytes: Buffer;
}

/** Bounded ZIP32 STORE writer: canonical ASCII paths, fixed timestamps, no descriptors or extras. */
function zip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8'),
      checksum = crc32(entry.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(33, 12); // 1980-01-01, 00:00:00, independent of server timezone.
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.bytes.length, 18);
    local.writeUInt32LE(entry.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, entry.bytes);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(33, 14);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(entry.bytes.length, 20);
    record.writeUInt32LE(entry.bytes.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += local.length + name.length + entry.bytes.length;
  }
  const directoryLength = central.reduce((sum, item) => sum + item.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directoryLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end], offset + directoryLength + end.length);
}
const zipSize = (entries: Entry[]) =>
  22 +
  entries.reduce(
    (sum, entry) => sum + entry.bytes.length + 76 + 2 * Buffer.byteLength(entry.path),
    0,
  );
function validBytes(mime: string, bytes: Buffer) {
  if (mime === 'application/pdf')
    return (
      /^%PDF-(?:1\.[0-7]|2\.0)[\r\n ]/.test(bytes.subarray(0, 16).toString('latin1')) &&
      /%%EOF\s*$/.test(bytes.subarray(-1024).toString('latin1'))
    );
  if (bytes.length < 12) return false;
  if (mime === 'image/png')
    return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  return (
    mime === 'image/webp' &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  );
}

export function registerCareSummaryBundles(app: Express, context: Context) {
  const { db, authorize, patientAccess, transaction, audit, fail } = context;
  const broken = () =>
    fail(
      409,
      'This saved summary or selected original file could not be verified. No bundle was created.',
    );
  function load(req: AuthRequest) {
    authorize(req);
    const patientId = reference.parse(req.params.id),
      copyId = reference.parse(req.params.copyId);
    patientAccess(req, patientId);
    const row = db
      .prepare(
        'SELECT data,length(body) AS byteLength FROM careSummaryCopies WHERE id=? AND patientId=?',
      )
      .get(copyId, patientId);
    if (!row) return fail(404, 'Saved care summary not found.');
    if (Number(row.byteLength) > 10 * 1024 * 1024)
      return fail(413, 'The saved summary exceeds the supported size. No bundle was created.');
    let raw: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(row.data as string);
      if (!object(value)) return broken();
      raw = value;
    } catch {
      return broken();
    }
    const bodyRow = db
      .prepare('SELECT body FROM careSummaryCopies WHERE id=? AND patientId=?')
      .get(copyId, patientId);
    if (!(bodyRow?.body instanceof Uint8Array)) return broken();
    const body = Buffer.from(bodyRow.body);
    if (
      raw.id !== copyId ||
      raw.patientId !== patientId ||
      raw.byteLength !== body.length ||
      raw.contentSha256 !== hash(body) ||
      typeof raw.sourceRevision !== 'string' ||
      !hashPattern.test(raw.sourceRevision) ||
      typeof raw.generatedAt !== 'string' ||
      typeof raw.savedAt !== 'string' ||
      !object(raw.savedBy) ||
      typeof raw.savedBy.name !== 'string' ||
      !['patient', 'doctor', 'admin'].includes(String(raw.savedBy.role))
    )
      return broken();
    let summary: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(body.toString('utf8'));
      if (!object(value)) return broken();
      summary = value;
    } catch {
      return broken();
    }
    if (
      summary.schemaVersion !== 1 ||
      summary.audience !== 'patient' ||
      summary.revision !== raw.sourceRevision ||
      summary.generatedAt !== raw.generatedAt ||
      !object(summary.patient) ||
      summary.patient.id !== patientId ||
      typeof summary.patient.name !== 'string' ||
      !Array.isArray(summary.images) ||
      !Array.isArray(summary.documents)
    )
      return broken();
    if (raw.patientName !== undefined && raw.patientName !== summary.patient.name) return broken();
    const copy: CareSummaryCopy = {
      id: copyId,
      patientId,
      patientName: summary.patient.name,
      sourceRevision: raw.sourceRevision,
      generatedAt: raw.generatedAt,
      savedAt: raw.savedAt,
      savedBy: {
        name: raw.savedBy.name,
        role: raw.savedBy.role as CareSummaryCopy['savedBy']['role'],
      },
      contentSha256: raw.contentSha256 as string,
      byteLength: body.length,
    };
    const references: FrozenReference[] = [];
    for (const [type, values] of [
      ['document', summary.documents],
      ['image', summary.images],
    ] as const) {
      for (const value of values) {
        if (
          !object(value) ||
          typeof value.id !== 'string' ||
          !value.id ||
          value.id.length > 300 ||
          value.patientId !== patientId ||
          typeof value.mimeType !== 'string' ||
          typeof value.createdAt !== 'string'
        )
          return broken();
        const title = type === 'document' ? value.title : value.caption;
        if (
          typeof title !== 'string' ||
          (type === 'document' && typeof value.originalName !== 'string')
        )
          return broken();
        const recordedByteLength =
          typeof value.sizeBytes === 'number' &&
          Number.isSafeInteger(value.sizeBytes) &&
          value.sizeBytes >= 0
            ? value.sizeBytes
            : null;
        const recordedSha256 =
          typeof value.sha256 === 'string' && hashPattern.test(value.sha256) ? value.sha256 : null;
        const invalid =
          (value.sizeBytes !== undefined && recordedByteLength === null) ||
          (value.sha256 !== undefined && recordedSha256 === null) ||
          (type === 'document' && (recordedSha256 === null || recordedByteLength === null));
        const uploadedBy =
          typeof value.createdByName === 'string' && roles.includes(value.createdByRole as Role)
            ? { name: value.createdByName, role: value.createdByRole as Role }
            : null;
        references.push({
          type,
          id: value.id,
          title,
          originalName: type === 'document' ? (value.originalName as string) : null,
          mimeType: value.mimeType,
          recordedByteLength,
          recordedSha256,
          createdAt: value.createdAt,
          uploadedBy,
          availability: 'present',
          problem: null,
          invalid,
        });
      }
    }
    if (new Set(references.map(key)).size !== references.length) return broken();
    references.sort(compare);
    return { copy, body, references };
  }
  function presence(item: FrozenReference, patientId: string): CareSummaryBundleAttachment {
    const { invalid, ...safe } = item;
    const supported =
      item.type === 'document'
        ? item.mimeType === 'application/pdf'
        : item.mimeType.startsWith('image/') && !!extensions[item.mimeType];
    if (invalid || !supported)
      return {
        ...safe,
        availability: 'unsupported',
        problem: 'The recorded file format or integrity metadata is unsupported.',
      };
    const table = item.type === 'document' ? 'documents' : 'images';
    const row = db
      .prepare(`SELECT length(bytes) AS byteLength FROM ${table} WHERE id=? AND patientId=?`)
      .get(item.id, patientId);
    if (!row)
      return {
        ...safe,
        availability: 'missing',
        problem: 'The original file is unavailable for this patient.',
      };
    if (Number(row.byteLength) > limits.maxFileBytes)
      return {
        ...safe,
        availability: 'too-large',
        problem: 'This original file exceeds the 5 MiB bundle limit.',
      };
    return safe;
  }
  function build(req: AuthRequest, requested: CareSummaryAttachmentSelection[]) {
    const source = load(req),
      selection = [...requested].sort(compare);
    const byKey = new Map(source.references.map((item) => [key(item), item]));
    const selected = selection.map((item) => {
      const stored = byKey.get(key(item));
      if (!stored) return fail(400, 'Select only attachments referenced by this saved summary.');
      return stored;
    });
    const files: CareSummaryBundleFile[] = [],
      entries: Entry[] = [{ path: 'care-summary.json', bytes: source.body }];
    let payloadSize = source.body.length;
    for (const item of selected) {
      const status = presence(item, source.copy.patientId);
      if (status.availability === 'too-large')
        return fail(413, 'A selected original file exceeds 5 MiB. No bundle was created.');
      if (status.availability !== 'present') return broken();
      const table = item.type === 'document' ? 'documents' : 'images';
      // Size checked before retrieving bytes; only explicitly selected same-patient BLOBs are read.
      const row = db
        .prepare(`SELECT data,bytes FROM ${table} WHERE id=? AND patientId=?`)
        .get(item.id, source.copy.patientId);
      if (!row || !(row.bytes instanceof Uint8Array)) return broken();
      const bytes = Buffer.from(row.bytes),
        sha256 = hash(bytes);
      let metadata: unknown;
      try {
        metadata = JSON.parse(row.data as string);
      } catch {
        return broken();
      }
      if (
        !object(metadata) ||
        metadata.id !== item.id ||
        metadata.patientId !== source.copy.patientId ||
        metadata.mimeType !== item.mimeType ||
        !validBytes(item.mimeType, bytes) ||
        (item.recordedByteLength !== null && item.recordedByteLength !== bytes.length) ||
        (item.recordedSha256 !== null && item.recordedSha256 !== sha256)
      )
        return broken();
      payloadSize += bytes.length;
      if (payloadSize > limits.maxBundleBytes)
        return fail(
          413,
          'This selection exceeds the 25 MiB total bundle limit. Choose fewer files.',
        );
      const path = `attachments/${item.type}-${hash(key(item))}.${extensions[item.mimeType]}`;
      files.push({
        type: item.type,
        id: item.id,
        path,
        title: item.title,
        originalName: item.originalName,
        mimeType: item.mimeType as CareSummaryBundleFile['mimeType'],
        byteLength: bytes.length,
        sha256,
        createdAt: item.createdAt,
        uploadedBy: item.uploadedBy,
        verification: item.recordedSha256 ? 'saved-sha256' : 'computed-at-export',
      });
      entries.push({ path, bytes });
    }
    const manifest: CareSummaryBundleManifest = {
      format: 'derma-care-summary-bundle',
      version: 1,
      copy: source.copy,
      summary: {
        path: 'care-summary.json',
        byteLength: source.body.length,
        sha256: source.copy.contentSha256,
      },
      files,
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    entries.splice(1, 0, { path: 'manifest.json', bytes: manifestBytes });
    if (zipSize(entries) > limits.maxBundleBytes)
      return fail(413, 'This selection exceeds the 25 MiB total bundle limit. Choose fewer files.');
    const bytes = zip(entries);
    const preview: CareSummaryBundlePreview = {
      copy: source.copy,
      selection,
      manifest,
      revision: hash(manifestBytes),
      filename: `care-summary-bundle-${hash(source.copy.id).slice(0, 24)}.zip`,
      byteLength: bytes.length,
      contentSha256: hash(bytes),
      limits,
    };
    return { preview, bytes };
  }
  const base = '/api/patients/:id/care-summary/copies/:copyId/bundle';
  app.get(`${base}/attachments`, (req: AuthRequest, res) => {
    const query = pageSchema.parse(req.query);
    const result = transaction((): CareSummaryBundleAttachmentPage => {
      const source = load(req),
        total = source.references.length;
      const totalPages = Math.max(1, Math.ceil(total / query.pageSize)),
        page = Math.min(query.page, totalPages);
      const items = source.references
        .slice((page - 1) * query.pageSize, page * query.pageSize)
        .map((item) => presence(item, source.copy.patientId));
      audit(
        req,
        'viewed saved care summary bundle attachments',
        'care-summary-copy',
        source.copy.id,
      );
      return {
        copy: source.copy,
        items,
        page,
        pageSize: query.pageSize,
        total,
        totalPages,
        limits,
      };
    });
    res.json(result);
  });
  app.post(`${base}/preview`, (req: AuthRequest, res) => {
    empty.parse(req.query);
    const input = previewSchema.parse(req.body);
    const result = transaction(() => {
      const result = build(req, input.attachments);
      audit(
        req,
        'previewed saved care summary attachment bundle',
        'care-summary-copy',
        result.preview.copy.id,
      );
      return result.preview;
    });
    res.json(result);
  });
  app.post(`${base}/download`, (req: AuthRequest, res) => {
    empty.parse(req.query);
    const input = downloadSchema.parse(req.body);
    const result = transaction(() => {
      const result = build(req, input.attachments);
      if (result.preview.revision !== input.expectedRevision)
        return fail(409, 'The selected bundle changed. Review a fresh preview before downloading.');
      audit(
        req,
        'downloaded saved care summary attachment bundle',
        'care-summary-copy',
        result.preview.copy.id,
      );
      return result;
    });
    res.setHeader('Content-Disposition', `attachment; filename="${result.preview.filename}"`);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Length', result.bytes.length);
    res.setHeader('X-Content-SHA256', result.preview.contentSha256);
    res.setHeader('X-Bundle-Revision', result.preview.revision);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; frame-ancestors 'none'");
    res.end(result.bytes);
  });
}
