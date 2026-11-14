import type { CareSummaryCopy } from './care-summary-copies';
import type { Role } from './types';

export interface CareSummaryAttachmentSelection {
  type: 'document' | 'image';
  id: string;
}
export interface CareSummaryBundleLimits {
  maxAttachments: 20;
  maxFileBytes: 5242880;
  maxBundleBytes: 26214400;
}
/** Labels and provenance come from the saved summary, never later current metadata. */
export interface CareSummaryBundleAttachment extends CareSummaryAttachmentSelection {
  title: string;
  originalName: string | null;
  mimeType: string;
  recordedByteLength: number | null;
  recordedSha256: string | null;
  createdAt: string;
  uploadedBy: { name: string; role: Role } | null;
  /** Presence/size only. Preview verifies the actual bytes and recorded hashes. */
  availability: 'present' | 'missing' | 'unsupported' | 'too-large';
  problem: string | null;
}
export interface CareSummaryBundleAttachmentPage {
  copy: CareSummaryCopy;
  items: CareSummaryBundleAttachment[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  limits: CareSummaryBundleLimits;
}
export interface CareSummaryBundleFile extends CareSummaryAttachmentSelection {
  path: string;
  title: string;
  originalName: string | null;
  mimeType: 'application/pdf' | 'image/png' | 'image/jpeg' | 'image/webp';
  byteLength: number;
  sha256: string;
  createdAt: string;
  uploadedBy: { name: string; role: Role } | null;
  verification: 'saved-sha256' | 'computed-at-export';
}
export interface CareSummaryBundleManifest {
  format: 'derma-care-summary-bundle';
  version: 1;
  copy: CareSummaryCopy;
  summary: { path: 'care-summary.json'; byteLength: number; sha256: string };
  files: CareSummaryBundleFile[];
}
export interface CareSummaryBundleInput {
  attachments: CareSummaryAttachmentSelection[];
}
export interface CareSummaryBundleDownloadInput extends CareSummaryBundleInput {
  expectedRevision: string;
}
export interface CareSummaryBundlePreview {
  copy: CareSummaryCopy;
  /** Canonical type/id order, independent of caller selection order. */
  selection: CareSummaryAttachmentSelection[];
  manifest: CareSummaryBundleManifest;
  /** SHA-256 of canonical manifest bytes, including the final newline. */
  revision: string;
  filename: string;
  /** Exact complete ZIP download size and SHA-256, including ZIP metadata. */
  byteLength: number;
  contentSha256: string;
  limits: CareSummaryBundleLimits;
}
