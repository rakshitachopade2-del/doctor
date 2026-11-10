import type { Express } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AuthRequest } from './app.ts';
import type { ClinicalImage, Doctor, Patient, User } from '../shared/types.ts';
import {
  annotationColors,
  type ImageAnnotationHistory,
  type ImageAnnotationVersion,
} from '../shared/image-annotations.ts';
import { get, id, nowISO, type DB } from './db.ts';
import { notifyPatient } from './activity.ts';

interface AnnotationContext {
  db: DB;
  actor: (req: AuthRequest, roles?: User['role'][]) => User;
  patientAccess: (req: AuthRequest, patientId: string, allowReception?: boolean) => Patient;
  clinicianId: (req: AuthRequest) => string;
  moduleEnabled: (name: 'images') => void;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
}
type StoredVersion = Omit<
  ImageAnnotationVersion,
  'publishedAt' | 'publishedByDoctorId' | 'publishedByDoctorName'
> & {
  createdById: string;
};
interface AnnotationPublication {
  versionId: string;
  publishedAt: string;
  doctorId: string;
  doctorName: string;
  publishedById: string;
}
const fingerprint = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex');
export function imageProvenance(bytes: Uint8Array, user: User) {
  return {
    sha256: fingerprint(bytes),
    sizeBytes: bytes.byteLength,
    createdById: user.id,
    createdByName: user.name,
    createdByRole: user.role,
  };
}

function safeVersion(
  version: StoredVersion,
  publication: AnnotationPublication | null,
): ImageAnnotationVersion {
  // Project fields explicitly so stored account provenance and future internal fields
  // cannot accidentally enter the patient view or exported care summary.
  return {
    id: version.id,
    imageId: version.imageId,
    imageSha256: version.imageSha256,
    doctorId: version.doctorId,
    doctorName: version.doctorName,
    createdAt: version.createdAt,
    note: version.note,
    markers: version.markers,
    publishedAt: publication?.publishedAt ?? null,
    publishedByDoctorId: publication?.doctorId ?? null,
    publishedByDoctorName: publication?.doctorName ?? null,
  };
}

/** Call only after patient authorization; returns published overlays without private revision state. */
export function publishedImageAnnotationsForPatient(
  db: DB,
  patientId: string,
): ImageAnnotationVersion[] {
  return db
    .prepare(
      `SELECT versions.data AS versionData,publications.data AS publicationData
    FROM imageAnnotationVersions AS versions
    JOIN images ON images.id=versions.imageId
    JOIN imageAnnotationPublications AS publications ON publications.versionId=versions.id
    WHERE images.patientId=? ORDER BY versions.rowid DESC`,
    )
    .all(patientId)
    .map((row) =>
      safeVersion(
        JSON.parse(row.versionData as string) as StoredVersion,
        JSON.parse(row.publicationData as string) as AnnotationPublication,
      ),
    );
}

const unit = z
  .number()
  .min(0)
  .max(1)
  .transform((value) => Math.round(value * 1_000_000) / 1_000_000);
const markerFields = {
  id: z
    .string()
    .uuid()
    .transform((value) => value.toLowerCase()),
  color: z.enum(annotationColors),
  label: z.string().trim().max(200).default(''),
};
const boxMarker = z
  .object({
    ...markerFields,
    type: z.enum(['rectangle', 'ellipse']),
    x: unit,
    y: unit,
    width: unit.refine((value) => value > 0, 'Use a positive width.'),
    height: unit.refine((value) => value > 0, 'Use a positive height.'),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      Math.round((value.x + value.width) * 1_000_000) > 1_000_000 ||
      Math.round((value.y + value.height) * 1_000_000) > 1_000_000
    )
      ctx.addIssue({ code: 'custom', message: 'Keep the entire marker inside the image.' });
  });
const arrowMarker = z
  .object({ ...markerFields, type: z.literal('arrow'), x1: unit, y1: unit, x2: unit, y2: unit })
  .strict()
  .refine(
    (value) => value.x1 !== value.x2 || value.y1 !== value.y2,
    'An arrow must have two different endpoints.',
  );
const revisionSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'Refresh image notes to obtain the current revision.');
const versionFields = z
  .object({
    expectedRevision: revisionSchema,
    note: z.string().trim().max(4000),
    markers: z.array(z.union([boxMarker, arrowMarker])).max(50),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.note && !value.markers.length)
      ctx.addIssue({ code: 'custom', message: 'Add a note or at least one marker.' });
    if (new Set(value.markers.map((marker) => marker.id)).size !== value.markers.length)
      ctx.addIssue({
        code: 'custom',
        message: 'Every marker needs a unique ID.',
        path: ['markers'],
      });
  });

export function registerImageAnnotations(
  app: Express,
  { db, actor, patientAccess, clinicianId, moduleEnabled, audit, fail }: AnnotationContext,
) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS imageAnnotationVersions (
      id TEXT PRIMARY KEY, imageId TEXT NOT NULL REFERENCES images(id), data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS image_annotation_versions_image ON imageAnnotationVersions(imageId);
    CREATE TABLE IF NOT EXISTS imageAnnotationPublications (
      versionId TEXT PRIMARY KEY REFERENCES imageAnnotationVersions(id), publishedAt TEXT NOT NULL, data TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS image_original_no_update BEFORE UPDATE ON images
      BEGIN SELECT RAISE(ABORT,'Original images are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS image_original_no_delete BEFORE DELETE ON images
      BEGIN SELECT RAISE(ABORT,'Original images are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS image_annotation_version_no_update BEFORE UPDATE ON imageAnnotationVersions
      BEGIN SELECT RAISE(ABORT,'Image annotation versions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS image_annotation_version_no_delete BEFORE DELETE ON imageAnnotationVersions
      BEGIN SELECT RAISE(ABORT,'Image annotation versions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS image_annotation_publication_no_update BEFORE UPDATE ON imageAnnotationPublications
      BEGIN SELECT RAISE(ABORT,'Image annotation publications are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS image_annotation_publication_no_delete BEFORE DELETE ON imageAnnotationPublications
      BEGIN SELECT RAISE(ABORT,'Image annotation publications are immutable'); END;
  `);
  function transaction<T>(operation: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  function imageAccess(req: AuthRequest, imageId: string) {
    actor(req);
    const image = get<ClinicalImage>(db, 'images', imageId);
    if (!image) return fail(404, 'Image not found.');
    patientAccess(req, image.patientId);
    return image;
  }
  function versions(imageId: string): ImageAnnotationVersion[] {
    return db
      .prepare(
        `SELECT versions.data AS versionData,publications.data AS publicationData
      FROM imageAnnotationVersions AS versions
      LEFT JOIN imageAnnotationPublications AS publications ON publications.versionId=versions.id
      WHERE versions.imageId=? ORDER BY versions.rowid DESC`,
      )
      .all(imageId)
      .map((row) =>
        safeVersion(
          JSON.parse(row.versionData as string) as StoredVersion,
          row.publicationData
            ? (JSON.parse(row.publicationData as string) as AnnotationPublication)
            : null,
        ),
      );
  }
  function history(imageId: string, forPatient = false): ImageAnnotationHistory {
    const values = versions(imageId);
    return {
      imageId,
      revision: forPatient
        ? null
        : fingerprint(
            JSON.stringify({
              imageId,
              latestVersionId: values[0]?.id ?? null,
              publishedVersionIds: values
                .filter((version) => version.publishedAt !== null)
                .map((version) => version.id),
            }),
          ),
      versions: forPatient ? values.filter((version) => version.publishedAt !== null) : values,
    };
  }
  function assertCurrent(expectedRevision: string, current: ImageAnnotationHistory) {
    if (expectedRevision !== current.revision)
      fail(
        409,
        'Image notes have changed. Refresh and review the latest version before saving or sharing.',
      );
  }
  function identity(req: AuthRequest) {
    const doctorId = clinicianId(req);
    return {
      doctorId,
      doctorName: get<Doctor>(db, 'doctors', doctorId)!.name,
      userId: actor(req).id,
    };
  }
  app.get('/api/images/:id/annotations', (req: AuthRequest, res) => {
    const image = imageAccess(req, String(req.params.id));
    const value = history(image.id, actor(req).role === 'patient');
    audit(req, 'viewed image annotation history', 'image', image.id);
    res.json(value);
  });
  app.post('/api/images/:id/annotations', (req: AuthRequest, res) => {
    const author = identity(req);
    moduleEnabled('images');
    const input = versionFields.parse(req.body);
    const value = transaction(() => {
      const image = imageAccess(req, String(req.params.id));
      assertCurrent(input.expectedRevision, history(image.id));
      const row = db.prepare('SELECT bytes FROM images WHERE id=?').get(image.id)!;
      const version: StoredVersion = {
        id: id(),
        imageId: image.id,
        imageSha256: fingerprint(row.bytes as Uint8Array),
        doctorId: author.doctorId,
        doctorName: author.doctorName,
        createdById: author.userId,
        createdAt: nowISO(),
        note: input.note,
        markers: input.markers,
      };
      db.prepare('INSERT INTO imageAnnotationVersions(id,imageId,data) VALUES (?,?,?)').run(
        version.id,
        image.id,
        JSON.stringify(version),
      );
      audit(req, 'saved private image annotation version', 'image', image.id);
      return history(image.id);
    });
    res.status(201).json(value);
  });
  app.post('/api/images/:id/annotations/:versionId/publish', (req: AuthRequest, res) => {
    const author = identity(req);
    moduleEnabled('images');
    const input = z
      .object({ expectedRevision: revisionSchema, patientSharingConfirmed: z.literal(true) })
      .strict()
      .parse(req.body);
    const value = transaction(() => {
      const image = imageAccess(req, String(req.params.id));
      const current = history(image.id);
      const version = current.versions.find(
        (candidate) => candidate.id === String(req.params.versionId),
      );
      if (!version) return fail(404, 'Image annotation version not found.');
      if (version.publishedAt !== null) return current;
      assertCurrent(input.expectedRevision, current);
      if (current.versions[0]?.id !== version.id)
        return fail(
          409,
          'Only the latest saved image notes can be newly shared. Save a new version if an older note needs to be restored.',
        );
      const publication: AnnotationPublication = {
        versionId: version.id,
        publishedAt: nowISO(),
        doctorId: author.doctorId,
        doctorName: author.doctorName,
        publishedById: author.userId,
      };
      db.prepare(
        'INSERT INTO imageAnnotationPublications(versionId,publishedAt,data) VALUES (?,?,?)',
      ).run(version.id, publication.publishedAt, JSON.stringify(publication));
      audit(
        req,
        'shared image annotation version with patient',
        'imageAnnotationVersion',
        version.id,
      );
      notifyPatient(db, image.patientId, `image-annotation-published:${version.id}`, {
        kind: 'image-annotation',
        title: 'Your clinician shared image notes',
        detail: 'Open your private image record to see the notes shared by your clinic.',
        href: `/my-care/record?tab=images&image=${image.id}`,
      });
      return history(image.id);
    });
    res.json(value);
  });
}
