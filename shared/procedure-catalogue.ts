import type { ProcedureRecord } from './clinical';
import type { Role } from './types';

/** Patient indication, appointments, decisions and outcomes are never template fields. */
export interface ProcedureTemplateFields {
  title: string;
  benefits: string;
  risks: string;
  alternatives: string;
  aftercare: string;
  estimatedCost: string;
}
export interface ProcedureTemplateVersion {
  id: string;
  templateId: string;
  version: number;
  fields: ProcedureTemplateFields;
  reason: string;
  createdById: string;
  createdByName: string;
  doctorId: string;
  doctorName: string;
  createdAt: string;
}
export interface ProcedureTemplateState {
  active: boolean;
  latestVersionId: string;
  publishedVersionId: string | null;
}
export interface ProcedureTemplateEvent {
  id: string;
  templateId: string;
  operation: 'created' | 'version-added' | 'published' | 'archived' | 'reactivated';
  versionId: string | null;
  before: ProcedureTemplateState | null;
  after: ProcedureTemplateState;
  reason: string;
  requestId: string;
  expectedRevision: string | null;
  createdById: string;
  createdByName: string;
  createdByRole: Exclude<Role, 'patient'>;
  doctorId: string | null;
  doctorName: string | null;
  createdAt: string;
}
export interface ProcedureTemplateRow {
  id: string;
  title: string;
  active: boolean;
  latestVersion: number;
  publishedVersion: number | null;
  publishedTitle: string | null;
  publishedAt: string | null;
  revision: string;
  /** Draft-only edits do not change the selection revision. */
  selectionRevision: string;
  createdAt: string;
  updatedAt: string;
}
export interface ProcedureTemplateDetail {
  template: ProcedureTemplateRow;
  latestVersion: ProcedureTemplateVersion;
  publishedVersion: ProcedureTemplateVersion | null;
  /** Exact current review, even when newer events push it beyond the first history page. */
  publication: ProcedureTemplateEvent | null;
  /** Latest 25 attributed immutable events, newest first; use /history for older events. */
  history: ProcedureTemplateEvent[];
  historyTotal: number;
}
export interface ProcedureTemplateMutation {
  detail: ProcedureTemplateDetail;
  event: ProcedureTemplateEvent;
  /** Exact immutable event version; remains available on replay after later drafts/publications. */
  version: ProcedureTemplateVersion | null;
}
export interface ProcedureCataloguePage {
  items: ProcedureTemplateRow[];
  filters: {
    search: string;
    active: 'true' | 'false' | 'all';
    publication: 'all' | 'published' | 'unpublished';
  };
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
export interface ProcedureTemplateVersionPage {
  templateId: string;
  items: ProcedureTemplateVersion[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
export interface ProcedureTemplateHistoryPage {
  templateId: string;
  items: ProcedureTemplateEvent[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
export interface ProcedureTemplateSelection {
  templateId: string;
  versionId: string;
  expectedSelectionRevision: string;
}
/** Safe immutable provenance shared with the patient; no catalogue reason or command receipt. */
export interface ProcedureTemplateSource {
  templateId: string;
  versionId: string;
  version: number;
  templateTitle: string;
  publishedAt: string;
  reviewedByDoctorId: string;
  reviewedByDoctorName: string;
  customizedFields: Array<keyof ProcedureTemplateFields>;
}
export interface ProcedureCreateReceipt {
  requestId: string;
  createdById: string;
  patientId: string;
  procedureId: string;
  appointmentId: string | null;
  templateSelection: ProcedureTemplateSelection | null;
  createdAt: string;
}
export interface ProcedureCreateMutation {
  procedure: ProcedureRecord;
  receipt: ProcedureCreateReceipt;
}
