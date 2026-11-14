import type { CareSummary } from './care-summary';

/** Metadata for an immutable patient-facing copy; contains no command or account identifiers. */
export interface CareSummaryCopy {
  id: string;
  patientId: string;
  /** Patient name recorded in the frozen summary, unaffected by later corrections. */
  patientName: string;
  sourceRevision: string;
  generatedAt: string;
  savedAt: string;
  savedBy: { name: string; role: 'patient' | 'doctor' | 'admin' };
  /** SHA-256 of the exact UTF-8 JSON download bytes, including the final newline. */
  contentSha256: string;
  byteLength: number;
}

export interface CareSummaryCopyInput {
  expectedRevision: string;
  requestId: string;
}

/** Returned only for the authenticated caller's successful save or exact retry. */
export interface CareSummaryCopyReceipt {
  requestId: string;
  actorId: string;
  patientId: string;
  expectedRevision: string;
  copyId: string;
}

export interface CareSummaryCopyResult {
  copy: CareSummaryCopy;
  receipt: CareSummaryCopyReceipt;
}

export interface CareSummaryCopyDetail {
  copy: CareSummaryCopy;
  summary: CareSummary;
}

export interface CareSummaryCopyPage {
  items: CareSummaryCopy[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
