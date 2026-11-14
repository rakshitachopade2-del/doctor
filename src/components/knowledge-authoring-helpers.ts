import { useEffect, useRef } from 'react';
import type { KnowledgeArticle } from '../../shared/operations';
import type {
  KnowledgeAuthoringDetail,
  KnowledgeAuthoringMutation,
  KnowledgeAuthoringPage,
  KnowledgeEvent,
  KnowledgeHistoryPage,
  KnowledgeState,
  KnowledgeVersion,
  KnowledgeVersionPage,
} from '../../shared/knowledge-authoring';

export type KnowledgeFields = Pick<KnowledgeArticle, 'title' | 'category' | 'body'>;
export const knowledgeFieldKeys = ['title', 'category', 'body'] as const;
export const knowledgeFieldsEqual = (a: KnowledgeFields, b: KnowledgeFields) =>
  knowledgeFieldKeys.every((field) => a[field] === b[field]);
export const knowledgeFailure = (error: unknown) =>
  error instanceof Error
    ? error.message
    : 'The article request could not be confirmed. Please try again.';
export const knowledgeStamp = (value: string) =>
  new Date(value).toLocaleString('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  });
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const timestamp = (value: unknown): value is string =>
  text(value) && Number.isFinite(Date.parse(value));
const revision = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const positive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;
const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((item, i) => same(item, b[i]));
  if (object(a) && object(b))
    return (
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every((key) => same(a[key], b[key]))
    );
  return false;
};
const bad = () =>
  new Error(
    'The article response was incomplete or did not match this request. Refresh the record or retry the same submitted request.',
  );
export function checkedKnowledgeFields(value: unknown): KnowledgeFields {
  if (
    !object(value) ||
    !text(value.title) ||
    value.title.length > 300 ||
    !text(value.category) ||
    value.category.length > 100 ||
    !text(value.body) ||
    value.body.length > 30000
  )
    throw bad();
  return { title: value.title, category: value.category, body: value.body };
}
export function checkedKnowledgeArticle(value: unknown, id?: string): KnowledgeArticle {
  if (
    !object(value) ||
    !text(value.id) ||
    (id !== undefined && value.id !== id) ||
    !['draft', 'published'].includes(value.status as string) ||
    !text(value.authorName) ||
    !timestamp(value.updatedAt)
  )
    throw bad();
  checkedKnowledgeFields(value);
  return value as unknown as KnowledgeArticle;
}
function checkedState(value: unknown): KnowledgeState {
  if (
    !object(value) ||
    !['draft', 'published'].includes(value.status as string) ||
    !text(value.currentVersionId) ||
    !positive(value.currentVersion)
  )
    throw bad();
  return value as unknown as KnowledgeState;
}
export const knowledgeState = (detail: KnowledgeAuthoringDetail): KnowledgeState => ({
  status: detail.article.status,
  currentVersionId: detail.currentVersion.id,
  currentVersion: detail.currentVersion.version,
});
export function checkedKnowledgeVersion(value: unknown, articleId: string): KnowledgeVersion {
  if (
    !object(value) ||
    !text(value.id) ||
    value.articleId !== articleId ||
    !positive(value.version) ||
    !['created', 'saved', 'restored', 'legacy-snapshot', 'legacy-current'].includes(
      value.origin as string,
    )
  )
    throw bad();
  checkedKnowledgeFields(value.fields);
  if (String(value.origin).startsWith('legacy-')) {
    if (
      !object(value.legacy) ||
      !(value.legacy.revisionId === null || text(value.legacy.revisionId)) ||
      !text(value.legacy.authorName) ||
      !timestamp(value.legacy.updatedAt) ||
      !['draft', 'published'].includes(value.legacy.status as string) ||
      ![
        'reason',
        'createdById',
        'createdByName',
        'createdByRole',
        'createdAt',
        'restoredFromVersionId',
      ].every((key) => value[key] === null)
    )
      throw bad();
  } else if (
    value.legacy !== null ||
    typeof value.reason !== 'string' ||
    value.reason.length > 1000 ||
    !text(value.createdById) ||
    !text(value.createdByName) ||
    !['doctor', 'admin'].includes(value.createdByRole as string) ||
    !timestamp(value.createdAt) ||
    (value.origin === 'restored'
      ? !text(value.restoredFromVersionId) || value.restoredFromVersionId === value.id
      : value.restoredFromVersionId !== null)
  )
    throw bad();
  return value as unknown as KnowledgeVersion;
}
export function checkedKnowledgeEvent(value: unknown, articleId: string): KnowledgeEvent {
  if (
    !object(value) ||
    !text(value.id) ||
    value.articleId !== articleId ||
    !['created', 'saved', 'published', 'withdrawn', 'restored'].includes(
      value.operation as string,
    ) ||
    !['command', 'legacy-api'].includes(value.source as string) ||
    typeof value.reason !== 'string' ||
    value.reason.length > 1000 ||
    !text(value.createdById) ||
    !text(value.createdByName) ||
    !['admin', 'doctor'].includes(value.createdByRole as string) ||
    !timestamp(value.createdAt) ||
    typeof value.reviewConfirmed !== 'boolean' ||
    typeof value.restoreConfirmed !== 'boolean'
  )
    throw bad();
  const after = checkedState(value.after);
  if (value.versionId !== after.currentVersionId) throw bad();
  if (value.operation === 'created') {
    if (value.before !== null || value.expectedRevision !== null || after.currentVersion !== 1)
      throw bad();
  } else {
    const before = checkedState(value.before);
    if (
      after.currentVersion < before.currentVersion ||
      after.currentVersion > before.currentVersion + 1
    )
      throw bad();
    if (
      ['published', 'withdrawn'].includes(String(value.operation)) &&
      (before.currentVersionId !== after.currentVersionId ||
        before.currentVersion !== after.currentVersion)
    )
      throw bad();
  }
  if (
    value.source === 'command'
      ? !uuid(value.requestId) ||
        (value.operation !== 'created' && !revision(value.expectedRevision))
      : value.requestId !== null || value.expectedRevision !== null
  )
    throw bad();
  if (
    value.operation === 'restored'
      ? !text(value.restoredFromVersionId) ||
        !value.restoreConfirmed ||
        after.status !== 'draft' ||
        value.reviewConfirmed
      : value.restoredFromVersionId !== null || value.restoreConfirmed
  )
    throw bad();
  if (
    (value.operation === 'published' && (after.status !== 'published' || !value.reviewConfirmed)) ||
    (value.operation === 'withdrawn' && (after.status !== 'draft' || value.reviewConfirmed))
  )
    throw bad();
  return value as unknown as KnowledgeEvent;
}
export function checkedKnowledgeDetail(value: unknown, id?: string): KnowledgeAuthoringDetail {
  if (!object(value)) throw bad();
  const article = checkedKnowledgeArticle(value.article, id),
    version = checkedKnowledgeVersion(value.currentVersion, article.id);
  if (
    !revision(value.revision) ||
    !Array.isArray(value.history) ||
    value.history.length > 25 ||
    !Number.isSafeInteger(value.historyTotal) ||
    Number(value.historyTotal) < value.history.length ||
    !positive(value.versionTotal) ||
    value.versionTotal !== version.version ||
    !knowledgeFieldsEqual(article, version.fields)
  )
    throw bad();
  const history = value.history.map((event) => checkedKnowledgeEvent(event, article.id));
  if (
    history.length !== Math.min(25, Number(value.historyTotal)) ||
    new Set(history.map((event) => event.id)).size !== history.length ||
    new Set(history.filter((event) => event.requestId).map((event) => event.requestId)).size !==
      history.filter((event) => event.requestId).length
  )
    throw bad();
  const state = {
    status: article.status,
    currentVersionId: version.id,
    currentVersion: version.version,
  };
  if (history.length && !same(history[0].after, state)) throw bad();
  for (let i = 1; i < history.length; i++)
    if (!same(history[i - 1].before, history[i].after)) throw bad();
  if (value.publication !== null) {
    const publication = checkedKnowledgeEvent(value.publication, article.id);
    if (
      article.status !== 'published' ||
      publication.after.status !== 'published' ||
      !publication.reviewConfirmed ||
      publication.versionId !== version.id ||
      publication.after.currentVersion !== version.version
    )
      throw bad();
    const matching = history.find((event) => event.id === publication.id);
    if (matching && !same(matching, publication)) throw bad();
  } else if (article.status === 'published' && !version.origin.startsWith('legacy-')) throw bad();
  return {
    ...value,
    article,
    currentVersion: version,
    history,
  } as unknown as KnowledgeAuthoringDetail;
}
function checkedPage(
  value: unknown,
  page: number,
  pageSize: number,
): Record<string, unknown> & { items: unknown[] } {
  if (
    !object(value) ||
    !Array.isArray(value.items) ||
    !Number.isSafeInteger(value.total) ||
    Number(value.total) < 0 ||
    !positive(value.page) ||
    value.pageSize !== pageSize ||
    value.totalPages !== Math.max(1, Math.ceil(Number(value.total) / pageSize)) ||
    value.page !== Math.min(page, Number(value.totalPages)) ||
    value.items.length !==
      Math.min(pageSize, Math.max(0, Number(value.total) - (Number(value.page) - 1) * pageSize))
  )
    throw bad();
  return value as Record<string, unknown> & { items: unknown[] };
}
export function checkedKnowledgePage(
  value: unknown,
  filters: KnowledgeAuthoringPage['filters'],
  page: number,
  pageSize: number,
): KnowledgeAuthoringPage {
  const data = checkedPage(value, page, pageSize);
  if (!same(data.filters, filters)) throw bad();
  const items = data.items.map((item) => {
    if (!object(item) || !positive(item.currentVersion) || !revision(item.revision)) throw bad();
    checkedKnowledgeArticle({ ...item, body: 'Listing metadata' }, undefined);
    return item;
  });
  if (new Set(items.map((item) => item.id)).size !== items.length) throw bad();
  return data as unknown as KnowledgeAuthoringPage;
}
export function checkedKnowledgeVersions(
  value: unknown,
  id: string,
  page: number,
  pageSize: number,
): KnowledgeVersionPage {
  const data = checkedPage(value, page, pageSize);
  if (data.articleId !== id) throw bad();
  const items = data.items.map((item) => checkedKnowledgeVersion(item, id));
  if (
    new Set(items.map((item) => item.id)).size !== items.length ||
    items.some(
      (item, i) => item.version !== Number(data.total) - (Number(data.page) - 1) * pageSize - i,
    )
  )
    throw bad();
  return { ...data, items } as unknown as KnowledgeVersionPage;
}
export function checkedKnowledgeHistory(
  value: unknown,
  id: string,
  page: number,
  pageSize: number,
): KnowledgeHistoryPage {
  const data = checkedPage(value, page, pageSize);
  if (data.articleId !== id) throw bad();
  const items = data.items.map((item) => checkedKnowledgeEvent(item, id));
  if (new Set(items.map((item) => item.id)).size !== items.length) throw bad();
  for (let i = 1; i < items.length; i++)
    if (!same(items[i - 1].before, items[i].after)) throw bad();
  return { ...data, items } as unknown as KnowledgeHistoryPage;
}

export type KnowledgeAttempt = {
  kind: 'create' | 'save' | 'restore' | 'publish' | 'withdraw';
  source: KnowledgeAuthoringDetail | null;
  restoredVersion: KnowledgeVersion | null;
  actorId: string;
  actorRole: 'doctor' | 'admin';
  path: string;
  body: {
    requestId: string;
    expectedRevision?: string;
    reason?: string;
    fields?: KnowledgeFields;
    publication?: 'draft' | 'published';
    reviewed?: true;
    published?: boolean;
    versionId?: string;
    confirmed?: true;
  };
};
export function checkedKnowledgeMutation(
  value: unknown,
  sent: KnowledgeAttempt,
): KnowledgeAuthoringMutation {
  if (!object(value)) throw bad();
  const detail = checkedKnowledgeDetail(value.detail, sent.source?.article.id),
    id = detail.article.id,
    event = checkedKnowledgeEvent(value.event, id),
    version = checkedKnowledgeVersion(value.version, id);
  const operation =
    sent.kind === 'create'
      ? 'created'
      : sent.kind === 'save'
        ? 'saved'
        : sent.kind === 'restore'
          ? 'restored'
          : sent.kind === 'publish'
            ? 'published'
            : 'withdrawn';
  const expectedStatus =
    sent.kind === 'restore' || sent.kind === 'withdraw'
      ? 'draft'
      : sent.kind === 'publish'
        ? 'published'
        : sent.body.publication;
  if (
    event.source !== 'command' ||
    event.operation !== operation ||
    event.requestId !== sent.body.requestId ||
    event.createdById !== sent.actorId ||
    event.createdByRole !== sent.actorRole ||
    event.expectedRevision !== (sent.body.expectedRevision ?? null) ||
    !same(event.before, sent.source ? knowledgeState(sent.source) : null) ||
    event.after.status !== expectedStatus ||
    event.versionId !== version.id ||
    event.after.currentVersion !== version.version ||
    event.restoredFromVersionId !== (sent.body.versionId ?? null) ||
    event.restoreConfirmed !== (sent.kind === 'restore') ||
    event.reviewConfirmed !== (sent.body.reviewed === true) ||
    event.reason !== (sent.body.reason ?? '') ||
    (sent.source && detail.revision === sent.source.revision) ||
    detail.currentVersion.version < version.version
  )
    throw bad();
  const fields =
    sent.body.fields ?? sent.restoredVersion?.fields ?? sent.source?.currentVersion.fields;
  if (!fields || !knowledgeFieldsEqual(fields, version.fields)) throw bad();
  const newContent =
    sent.kind === 'create' ||
    sent.kind === 'restore' ||
    (sent.kind === 'save' && !knowledgeFieldsEqual(fields, sent.source!.currentVersion.fields));
  if (newContent) {
    if (
      version.version !== (sent.source?.currentVersion.version ?? 0) + 1 ||
      version.origin !==
        (sent.kind === 'create' ? 'created' : sent.kind === 'restore' ? 'restored' : 'saved') ||
      version.createdById !== sent.actorId ||
      version.createdByRole !== sent.actorRole ||
      version.createdByName !== event.createdByName ||
      version.createdAt !== event.createdAt ||
      version.reason !== event.reason ||
      version.restoredFromVersionId !== (sent.body.versionId ?? null)
    )
      throw bad();
  } else if (!same(version, sent.source!.currentVersion)) throw bad();
  const matching = detail.history.find((entry) => entry.id === event.id);
  if (matching && !same(matching, event)) throw bad();
  if (detail.currentVersion.id === version.id && !same(detail.currentVersion, version)) throw bad();
  if (sent.source?.history.some((entry) => entry.id === event.id)) throw bad();
  return { detail, event, version };
}

/** Check native history as well as mount state: a route may change before React cleans up. */
export function useKnowledgeGuard() {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return () => {
    const url = window.location.href,
      key = window.history.state?.key ?? null;
    return () =>
      mounted.current &&
      window.location.href === url &&
      (window.history.state?.key ?? null) === key;
  };
}
