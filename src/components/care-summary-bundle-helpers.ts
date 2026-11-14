import type { CareSummary } from '../../shared/care-summary';
import type { CareSummaryCopy } from '../../shared/care-summary-copies';
import type {
  CareSummaryAttachmentSelection,
  CareSummaryBundleAttachment,
  CareSummaryBundleAttachmentPage,
  CareSummaryBundleFile,
  CareSummaryBundleLimits,
  CareSummaryBundlePreview,
} from '../../shared/care-summary-bundles';
import { checkedSummaryCopy } from './care-summary-copy-helpers';

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const string = (v: unknown): v is string => typeof v === 'string';
const hash = (v: unknown) => string(v) && /^[a-f0-9]{64}$/.test(v);
const integer = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const timestamp = (v: unknown) => string(v) && Number.isFinite(Date.parse(v));
const roles = ['patient', 'doctor', 'admin', 'receptionist'];
const extensions: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};
export const bundleLimits: CareSummaryBundleLimits = {
  maxAttachments: 20,
  maxFileBytes: 5242880,
  maxBundleBytes: 26214400,
};
export const bundleFailure = (error: unknown) =>
  error instanceof Error
    ? error.message
    : 'This download could not be confirmed. Please try again.';
const invalid = () =>
  new Error(
    'The attachment response did not match this saved summary. No file was downloaded. Refresh the attachment list and review your selection.',
  );
function check(condition: unknown): asserts condition {
  if (!condition) throw invalid();
}
function canonical(v: unknown): unknown {
  return Array.isArray(v)
    ? v.map(canonical)
    : object(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((key) => [key, canonical(v[key])]),
        )
      : v;
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export const attachmentKey = (value: CareSummaryAttachmentSelection) => `${value.type}:${value.id}`;
export const attachmentTitle = (value: Pick<CareSummaryBundleAttachment, 'type' | 'title'>) =>
  value.title || (value.type === 'image' ? 'Untitled image' : 'Untitled PDF');
export function fileSize(bytes: number | null) {
  if (bytes === null) return 'Size not recorded';
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1048576).toFixed(2)} MiB`;
}
export const orderedAttachments = (values: CareSummaryAttachmentSelection[]) =>
  [...values].sort((a, b) =>
    a.type === b.type ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.type < b.type ? -1 : 1,
  );
function references(summary: CareSummary) {
  return orderedAttachments([
    ...summary.documents.map(({ id }) => ({ type: 'document' as const, id })),
    ...summary.images.map(({ id }) => ({ type: 'image' as const, id })),
  ]);
}
function checkedLimits(value: unknown) {
  check(same(value, bundleLimits));
  return bundleLimits;
}
function copyMatches(value: unknown, copy: CareSummaryCopy) {
  const actual = checkedSummaryCopy(value, copy.patientId, copy.id);
  check(same(actual, copy));
  return actual;
}
function checkedSelection(value: unknown): CareSummaryAttachmentSelection {
  check(
    object(value) &&
      (value.type === 'document' || value.type === 'image') &&
      string(value.id) &&
      value.id.length > 0 &&
      value.id.length <= 300,
  );
  return { type: value.type, id: value.id };
}
function frozenMetadata(ref: CareSummaryAttachmentSelection, summary: CareSummary) {
  const row =
    ref.type === 'image'
      ? summary.images.find((item) => item.id === ref.id)
      : summary.documents.find((item) => item.id === ref.id);
  check(row && row.patientId === summary.patient.id);
  return {
    title: 'caption' in row ? row.caption : row.title,
    originalName: 'originalName' in row ? row.originalName : null,
    mimeType: row.mimeType,
    recordedByteLength: integer(row.sizeBytes) ? row.sizeBytes : null,
    recordedSha256: hash(row.sha256) ? row.sha256! : null,
    createdAt: row.createdAt,
    uploadedBy:
      string(row.createdByName) && roles.includes(row.createdByRole ?? '')
        ? { name: row.createdByName, role: row.createdByRole! }
        : null,
  };
}
export function checkedBundleAttachment(
  value: unknown,
  summary: CareSummary,
): CareSummaryBundleAttachment {
  const ref = checkedSelection(value);
  check(object(value));
  const expected = frozenMetadata(ref, summary);
  for (const [key, field] of Object.entries(expected)) check(same(value[key], field));
  check(
    ['present', 'missing', 'unsupported', 'too-large'].includes(value.availability as string) &&
      (value.availability === 'present'
        ? value.problem === null
        : string(value.problem) && value.problem.trim().length > 0),
  );
  return {
    ...ref,
    ...expected,
    availability: value.availability as CareSummaryBundleAttachment['availability'],
    problem: value.problem as string | null,
  };
}
export function checkedBundleAttachmentPage(
  value: unknown,
  copy: CareSummaryCopy,
  summary: CareSummary,
  page: number,
): CareSummaryBundleAttachmentPage {
  check(object(value) && Array.isArray(value.items));
  const refs = references(summary);
  check(new Set(refs.map(attachmentKey)).size === refs.length);
  check(
    value.total === refs.length &&
      value.pageSize === 25 &&
      value.totalPages === Math.max(1, Math.ceil(refs.length / 25)) &&
      value.page === Math.min(page, Number(value.totalPages)),
  );
  const items = value.items.map((entry) => checkedBundleAttachment(entry, summary));
  check(
    same(
      items.map(({ type, id }) => ({ type, id })),
      refs.slice((Number(value.page) - 1) * 25, Number(value.page) * 25),
    ),
  );
  return {
    copy: copyMatches(value.copy, copy),
    items,
    page: Number(value.page),
    pageSize: 25,
    total: refs.length,
    totalPages: Number(value.totalPages),
    limits: checkedLimits(value.limits),
  };
}
export async function sha256(value: string | ArrayBuffer) {
  const data = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))]
    .map((part) => part.toString(16).padStart(2, '0'))
    .join('');
}
export async function checkedBundlePreview(
  value: unknown,
  copy: CareSummaryCopy,
  summary: CareSummary,
  selected: CareSummaryAttachmentSelection[],
): Promise<CareSummaryBundlePreview> {
  check(
    object(value) &&
      object(value.manifest) &&
      Array.isArray(value.selection) &&
      Array.isArray(value.manifest.files),
  );
  copyMatches(value.copy, copy);
  copyMatches(value.manifest.copy, copy);
  checkedLimits(value.limits);
  const selection = value.selection.map(checkedSelection),
    expected = orderedAttachments(selected);
  check(
    expected.length >= 1 &&
      expected.length <= bundleLimits.maxAttachments &&
      new Set(expected.map(attachmentKey)).size === expected.length &&
      same(selection, expected),
  );
  check(
    value.manifest.format === 'derma-care-summary-bundle' &&
      value.manifest.version === 1 &&
      same(value.manifest.summary, {
        path: 'care-summary.json',
        byteLength: copy.byteLength,
        sha256: copy.contentSha256,
      }),
  );
  check(
    value.manifest.files.length === expected.length &&
      hash(value.revision) &&
      hash(value.contentSha256) &&
      integer(value.byteLength) &&
      value.byteLength > 0 &&
      value.byteLength <= bundleLimits.maxBundleBytes,
  );
  const files: CareSummaryBundleFile[] = [];
  for (let index = 0; index < expected.length; index++) {
    const raw = value.manifest.files[index],
      ref = expected[index],
      metadata = frozenMetadata(ref, summary);
    check(
      object(raw) &&
        same(checkedSelection(raw), ref) &&
        Object.hasOwn(extensions, raw.mimeType as string) &&
        raw.mimeType === metadata.mimeType &&
        integer(raw.byteLength) &&
        raw.byteLength > 0 &&
        raw.byteLength <= bundleLimits.maxFileBytes &&
        hash(raw.sha256) &&
        timestamp(raw.createdAt),
    );
    for (const key of ['title', 'originalName', 'createdAt', 'uploadedBy'] as const)
      check(same(raw[key], metadata[key]));
    check(metadata.recordedByteLength === null || metadata.recordedByteLength === raw.byteLength);
    check(metadata.recordedSha256 === null || metadata.recordedSha256 === raw.sha256);
    check(
      raw.verification ===
        (metadata.recordedSha256 === null ? 'computed-at-export' : 'saved-sha256') &&
        (ref.type !== 'document' || raw.verification === 'saved-sha256'),
    );
    check(
      raw.path ===
        `attachments/${ref.type}-${await sha256(attachmentKey(ref))}.${extensions[String(raw.mimeType)]}`,
    );
    files.push(raw as unknown as CareSummaryBundleFile);
  }
  check(value.byteLength > copy.byteLength + files.reduce((sum, file) => sum + file.byteLength, 0));
  check(
    value.filename === `care-summary-bundle-${(await sha256(copy.id)).slice(0, 24)}.zip` &&
      value.revision === (await sha256(`${JSON.stringify(value.manifest, null, 2)}\n`)),
  );
  return value as unknown as CareSummaryBundlePreview;
}
export function checkBundleHeaders(response: Response, preview: CareSummaryBundlePreview) {
  const disposition = response.headers.get('content-disposition') ?? '';
  const name = disposition.match(/(?:^|;)\s*filename=(?:"([^"]+)"|([^;\s]+))/i);
  check(
    /^application\/zip(?:;|$)/i.test(response.headers.get('content-type') ?? '') &&
      /^attachment\s*;/i.test(disposition) &&
      (name?.[1] || name?.[2]) === preview.filename &&
      response.headers.get('x-bundle-revision') === preview.revision &&
      response.headers.get('x-content-sha256') === preview.contentSha256 &&
      response.headers.get('content-length') === String(preview.byteLength),
  );
}
export async function checkedBundleBytes(bytes: ArrayBuffer, preview: CareSummaryBundlePreview) {
  check(bytes.byteLength === preview.byteLength && (await sha256(bytes)) === preview.contentSha256);
  const prefix = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength));
  check(
    prefix.length === 4 &&
      prefix[0] === 0x50 &&
      prefix[1] === 0x4b &&
      prefix[2] === 0x03 &&
      prefix[3] === 0x04,
  );
}
