import type { KnowledgeArticle } from './operations';

export interface KnowledgeFields {
  title: string;
  category: string;
  body: string;
}
export interface KnowledgeVersion {
  id: string;
  articleId: string;
  /** Retained-snapshot sequence; imported snapshots are explicitly labelled legacy. */
  version: number;
  fields: KnowledgeFields;
  origin: 'created' | 'saved' | 'restored' | 'legacy-snapshot' | 'legacy-current';
  restoredFromVersionId: string | null;
  reason: string | null;
  createdById: string | null;
  createdByName: string | null;
  createdByRole: 'admin' | 'doctor' | null;
  createdAt: string | null;
  /** Original recorded labels, never inferred actor identity or publication time. */
  legacy: {
    revisionId: string | null;
    authorName: string;
    updatedAt: string;
    status: 'draft' | 'published';
  } | null;
}
export interface KnowledgeState {
  status: 'draft' | 'published';
  currentVersionId: string;
  currentVersion: number;
}
export interface KnowledgeEvent {
  id: string;
  articleId: string;
  operation: 'created' | 'saved' | 'published' | 'withdrawn' | 'restored';
  source: 'command' | 'legacy-api';
  before: KnowledgeState | null;
  after: KnowledgeState;
  versionId: string;
  restoredFromVersionId: string | null;
  reason: string;
  reviewConfirmed: boolean;
  restoreConfirmed: boolean;
  requestId: string | null;
  expectedRevision: string | null;
  createdById: string;
  createdByName: string;
  createdByRole: 'admin' | 'doctor';
  createdAt: string;
}
export interface KnowledgeAuthoringRow extends Omit<KnowledgeArticle, 'body'> {
  currentVersion: number;
  revision: string;
}
export interface KnowledgeAuthoringDetail {
  article: KnowledgeArticle;
  revision: string;
  currentVersion: KnowledgeVersion;
  /** Null for a legacy publication whose approval attribution was never recorded. */
  publication: KnowledgeEvent | null;
  history: KnowledgeEvent[];
  historyTotal: number;
  versionTotal: number;
}
export interface KnowledgeAuthoringMutation {
  detail: KnowledgeAuthoringDetail;
  /** Exact original receipt, even when current detail has advanced. */
  event: KnowledgeEvent;
  version: KnowledgeVersion;
}
export interface KnowledgeAuthoringPage {
  items: KnowledgeAuthoringRow[];
  filters: { q: string; status: 'all' | 'draft' | 'published' };
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
export interface KnowledgeVersionPage {
  articleId: string;
  items: KnowledgeVersion[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
export interface KnowledgeHistoryPage {
  articleId: string;
  items: KnowledgeEvent[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
