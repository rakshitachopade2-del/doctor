import { useRef, useState, type FormEvent } from 'react';
import type { KnowledgeAuthoringDetail, KnowledgeVersion } from '../../shared/knowledge-authoring';
import { api, ApiError, useSession } from '../lib';
import { ErrorState, Field, Loading, Modal } from './ui';
import { useVisitData } from './visit-duration-helpers';
import { KnowledgeArticleContent } from './KnowledgeArticleContent';
import {
  checkedKnowledgeDetail,
  checkedKnowledgeMutation,
  knowledgeFailure,
  knowledgeFieldsEqual,
  knowledgeStamp,
  useKnowledgeGuard,
  type KnowledgeAttempt,
  type KnowledgeFields,
} from './knowledge-authoring-helpers';
import './knowledge-authoring.css';

export type KnowledgeEditorKind = 'edit' | 'publish' | 'withdraw' | 'restore';
export function KnowledgeArticleSource({ detail }: { detail: KnowledgeAuthoringDetail }) {
  return (
    <div className="knowledge-authoring-source">
      <strong>{detail.article.title}</strong>
      <p>
        Current version {detail.currentVersion.version} ·{' '}
        {detail.article.status === 'published'
          ? 'Published in the public library'
          : 'Private draft'}
      </p>
      {detail.publication ? (
        <p className="muted small">
          Publication approved by {detail.publication.createdByName} ·{' '}
          {knowledgeStamp(detail.publication.createdAt)} IST
        </p>
      ) : detail.article.status === 'published' ? (
        <p className="muted small">
          Legacy publication. Its original approval attribution was not recorded.
        </p>
      ) : null}
      {detail.history[0] && (
        <p className="muted small">
          Latest change by {detail.history[0].createdByName} ·{' '}
          {knowledgeStamp(detail.history[0].createdAt)} IST
        </p>
      )}
    </div>
  );
}
export function KnowledgeVersionAttribution({ version }: { version: KnowledgeVersion }) {
  return version.legacy ? (
    <p className="notice small">
      Retained legacy snapshot. Recorded author label: {version.legacy.authorName}; recorded update:{' '}
      {knowledgeStamp(version.legacy.updatedAt)} IST; recorded state: {version.legacy.status}. The
      actual saving account and approval time were not recorded.
    </p>
  ) : (
    <p className="muted small">
      Content saved by {version.createdByName} · {knowledgeStamp(version.createdAt!)} IST
      {version.origin === 'restored' ? ' · Restored as a new draft' : ''}
    </p>
  );
}
export function KnowledgeArticleEditor({
  articleId,
  kind = 'edit',
  restoredVersion = null,
  onClose,
  onSaved,
}: {
  articleId?: string;
  kind?: KnowledgeEditorKind;
  restoredVersion?: KnowledgeVersion | null;
  onClose: () => void;
  onSaved: (detail: KnowledgeAuthoringDetail) => void;
}) {
  const resource = useVisitData(
    articleId ? `/api/knowledge-authoring/${encodeURIComponent(articleId)}` : null,
    (value) => checkedKnowledgeDetail(value, articleId),
  );
  const title =
    kind === 'restore'
      ? 'Restore an article version'
      : kind === 'publish'
        ? 'Publish the current article'
        : kind === 'withdraw'
          ? 'Withdraw this article'
          : articleId
            ? 'Review clinic article'
            : 'Write a clinic article';
  if (articleId && (resource.loading || resource.error || !resource.data))
    return (
      <Modal title={title} onClose={onClose}>
        {resource.loading ? (
          <Loading />
        ) : (
          <ErrorState
            message={resource.error || 'Article details are unavailable.'}
            retry={resource.reload}
          />
        )}
      </Modal>
    );
  return (
    <ArticleForm
      title={title}
      initial={resource.data}
      kind={kind}
      restoredVersion={restoredVersion}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}
function ArticleForm({
  title,
  initial,
  kind,
  restoredVersion,
  onClose,
  onSaved,
}: {
  title: string;
  initial: KnowledgeAuthoringDetail | null;
  kind: KnowledgeEditorKind;
  restoredVersion: KnowledgeVersion | null;
  onClose: () => void;
  onSaved: (detail: KnowledgeAuthoringDetail) => void;
}) {
  const { session } = useSession(),
    guard = useKnowledgeGuard(),
    pending = useRef(false);
  const [source, setSource] = useState(initial),
    [reviewed, setReviewed] = useState<KnowledgeAuthoringDetail | null>(null),
    [fields, setFields] = useState<KnowledgeFields>(
      initial?.currentVersion.fields ?? { title: '', category: '', body: '' },
    ),
    [reason, setReason] = useState(''),
    [publish, setPublish] = useState(false),
    [confirmed, setConfirmed] = useState(false),
    [attempt, setAttempt] = useState<KnowledgeAttempt | null>(null),
    [phase, setPhase] = useState<'editing' | 'conflict' | 'uncertain'>('editing'),
    [busy, setBusy] = useState(false),
    [refreshing, setRefreshing] = useState(false),
    [error, setError] = useState('');
  const content = kind === 'edit',
    locked = busy || refreshing || phase !== 'editing';
  const normalized: KnowledgeFields = {
    title: fields.title.trim(),
    category: fields.category.trim(),
    body: fields.body.trim(),
  };
  const applicable =
    kind === 'restore'
      ? !!source &&
        !!restoredVersion &&
        restoredVersion.articleId === source.article.id &&
        restoredVersion.id !== source.currentVersion.id
      : kind === 'publish'
        ? source?.article.status === 'draft'
        : kind === 'withdraw'
          ? source?.article.status === 'published'
          : true;
  const changed =
    !content ||
    !source ||
    !knowledgeFieldsEqual(normalized, source.currentVersion.fields) ||
    source.article.status !== (publish ? 'published' : 'draft');
  function close() {
    if (!pending.current && !busy && !refreshing && phase !== 'uncertain') onClose();
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || phase === 'conflict') return;
    if (phase === 'uncertain' && attempt) {
      await save(attempt);
      return;
    }
    if (!applicable || !changed) return;
    const action: KnowledgeAttempt['kind'] = kind === 'edit' ? (source ? 'save' : 'create') : kind;
    const sent: KnowledgeAttempt = {
      kind: action,
      source,
      restoredVersion,
      actorId: session.user!.id,
      actorRole: session.user!.role as 'admin' | 'doctor',
      path: source
        ? `/api/knowledge-authoring/${encodeURIComponent(source.article.id)}/${action === 'publish' || action === 'withdraw' ? 'publication' : action}`
        : '/api/knowledge-authoring',
      body: {
        requestId: crypto.randomUUID(),
        ...(source ? { expectedRevision: source.revision } : {}),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        ...(content
          ? {
              fields: normalized,
              publication: publish ? ('published' as const) : ('draft' as const),
              ...(publish ? { reviewed: true as const } : {}),
            }
          : {}),
        ...(kind === 'publish' || kind === 'withdraw'
          ? {
              published: kind === 'publish',
              ...(kind === 'publish' ? { reviewed: true as const } : {}),
            }
          : {}),
        ...(kind === 'restore' ? { versionId: restoredVersion!.id, confirmed: true as const } : {}),
      },
    };
    setAttempt(sent);
    await save(sent);
  }
  async function save(sent: KnowledgeAttempt) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    const current = guard(),
      uncertain = phase === 'uncertain';
    try {
      const result = checkedKnowledgeMutation(
        await api<unknown>(sent.path, { method: 'POST', body: sent.body, isCurrent: current }),
        sent,
      );
      if (current()) onSaved(result.detail);
    } catch (cause) {
      if (!current()) return;
      setError(knowledgeFailure(cause));
      if (uncertain) setPhase('uncertain');
      else if (
        cause instanceof ApiError &&
        cause.status === 409 &&
        sent.source &&
        !/request (?:id|identifier)|idempot|already used|different.*payload/i.test(cause.message)
      ) {
        setPhase('conflict');
        setReviewed(null);
        setPublish(false);
        setConfirmed(false);
      } else if (cause instanceof ApiError && [400, 403, 404, 422, 429].includes(cause.status)) {
        setPhase('editing');
        setAttempt(null);
      } else setPhase('uncertain');
    } finally {
      pending.current = false;
      if (current()) setBusy(false);
    }
  }
  async function refresh() {
    if (!source || pending.current) return;
    pending.current = true;
    setRefreshing(true);
    setReviewed(null);
    const current = guard();
    try {
      const result = checkedKnowledgeDetail(
        await api<unknown>(`/api/knowledge-authoring/${encodeURIComponent(source.article.id)}`, {
          isCurrent: current,
        }),
        source.article.id,
      );
      if (current()) {
        setReviewed(result);
        setError('');
      }
    } catch (cause) {
      if (current()) setError(knowledgeFailure(cause));
    } finally {
      pending.current = false;
      if (current()) setRefreshing(false);
    }
  }
  return (
    <Modal title={title} onClose={close}>
      <form className="stack knowledge-authoring-editor" onSubmit={submit}>
        {source && <KnowledgeArticleSource detail={source} />}
        {content ? (
          <fieldset disabled={locked} className="stack">
            <legend className="sr-only">Article content fields</legend>
            <Field label="Title">
              <input
                required
                maxLength={300}
                value={fields.title}
                onChange={(e) => setFields({ ...fields, title: e.target.value })}
              />
            </Field>
            <Field label="Category">
              <input
                required
                maxLength={100}
                placeholder="e.g. Visiting the clinic"
                value={fields.category}
                onChange={(e) => setFields({ ...fields, category: e.target.value })}
              />
            </Field>
            <Field label="Article content">
              <textarea
                required
                maxLength={30000}
                rows={12}
                value={fields.body}
                onChange={(e) => setFields({ ...fields, body: e.target.value })}
              />
            </Field>
          </fieldset>
        ) : kind === 'restore' && restoredVersion ? (
          <section aria-label="Selected version to restore">
            <h3>Restore version {restoredVersion.version}</h3>
            <KnowledgeVersionAttribution version={restoredVersion} />
            <KnowledgeArticleContent article={restoredVersion.fields} />
          </section>
        ) : source ? (
          <KnowledgeArticleContent article={source.currentVersion.fields} />
        ) : null}
        <Field
          label={kind === 'restore' ? 'Reason for restoration' : 'Internal change note'}
          hint={
            kind === 'restore'
              ? 'Required. Visible only to clinical staff.'
              : 'Optional. Visible only to clinical staff; not included in public articles.'
          }
        >
          <textarea
            required={kind === 'restore'}
            minLength={kind === 'restore' ? 3 : undefined}
            maxLength={1000}
            rows={3}
            disabled={locked}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        {(content || kind === 'publish') && (
          <label className="checkbox-field">
            <input
              type="checkbox"
              required={kind === 'publish'}
              checked={publish}
              disabled={locked}
              onChange={(e) => setPublish(e.target.checked)}
            />
            <span>
              I have reviewed this information and approve it for the public clinic library.
            </span>
          </label>
        )}
        {kind === 'restore' && (
          <label className="checkbox-field">
            <input
              type="checkbox"
              required
              checked={confirmed}
              disabled={locked}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <span>
              I understand this creates a new private draft and removes any current public
              publication.
            </span>
          </label>
        )}
        {(kind === 'restore' ||
          kind === 'withdraw' ||
          (source?.article.status === 'published' && content && !publish)) && (
          <p className="notice">
            {kind === 'restore'
              ? 'Restoring retains all existing versions and creates a new private draft.'
              : kind === 'withdraw'
                ? 'Withdrawing retains the article and its history.'
                : 'Saving as a draft retains the previous saved versions.'}{' '}
            The article will be removed from the public library until it is explicitly reviewed and
            published again.
          </p>
        )}
        {!changed && (
          <p className="muted small">Change the content or publication state before saving.</p>
        )}
        {!applicable && (
          <p className="notice">
            This action is no longer available for the current article. Close this form and review
            its history.
          </p>
        )}
        {error && (
          <p role="alert" className="notice notice-error">
            {error}
          </p>
        )}
        {phase === 'uncertain' && (
          <div className="notice" role="status">
            <strong>The save outcome could not be confirmed.</strong>
            <p>
              Your exact submitted content and request are retained in this open form. Retry the
              same request to confirm its result without creating a second change.
            </p>
          </div>
        )}
        {phase === 'conflict' && (
          <div className="knowledge-authoring-conflict">
            <p className="notice">
              The article changed. Your draft is retained. Review the latest saved content before
              continuing; publication approval must be given again.
            </p>
            <button
              type="button"
              className="button button-secondary"
              disabled={refreshing || busy}
              onClick={() => void refresh()}
            >
              {refreshing ? 'Refreshing…' : 'Refresh article for review'}
            </button>
            {reviewed && (
              <>
                <KnowledgeArticleSource detail={reviewed} />
                <details open>
                  <summary>
                    Latest saved content · version {reviewed.currentVersion.version}
                  </summary>
                  <KnowledgeArticleContent article={reviewed.currentVersion.fields} />
                </details>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => {
                    setSource(reviewed);
                    setReviewed(null);
                    setAttempt(null);
                    setPhase('editing');
                    setError('');
                    setPublish(false);
                    setConfirmed(false);
                  }}
                >
                  I reviewed the latest article; keep my draft
                </button>
              </>
            )}
          </div>
        )}
        <div className="knowledge-authoring-actions">
          <button
            className="button button-ghost"
            type="button"
            disabled={busy || refreshing || phase === 'uncertain'}
            onClick={close}
          >
            Cancel
          </button>
          <button
            className="button button-primary"
            disabled={
              busy ||
              refreshing ||
              phase === 'conflict' ||
              (phase === 'editing' && (!changed || !applicable))
            }
          >
            {busy
              ? 'Saving…'
              : phase === 'uncertain'
                ? 'Retry same request'
                : kind === 'restore'
                  ? 'Restore as new draft'
                  : kind === 'withdraw'
                    ? 'Withdraw publication'
                    : publish
                      ? 'Approve and publish'
                      : 'Save draft'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
