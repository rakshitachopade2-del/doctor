import { useState } from 'react';
import type { KnowledgeEvent, KnowledgeVersion } from '../../shared/knowledge-authoring';
import { Badge, ErrorState, Loading, Modal } from './ui';
import { Pagination } from './Pagination';
import { useVisitData } from './visit-duration-helpers';
import { KnowledgeArticleContent } from './KnowledgeArticleContent';
import {
  KnowledgeArticleSource,
  KnowledgeVersionAttribution,
  type KnowledgeEditorKind,
} from './KnowledgeArticleEditor';
import {
  checkedKnowledgeDetail,
  checkedKnowledgeHistory,
  checkedKnowledgeVersions,
  knowledgeStamp,
} from './knowledge-authoring-helpers';
import './knowledge-authoring.css';

const eventLabels: Record<KnowledgeEvent['operation'], string> = {
  created: 'Article created',
  saved: 'Article saved',
  published: 'Publication approved',
  withdrawn: 'Publication withdrawn',
  restored: 'Historical content restored as a draft',
};
export function KnowledgeArticleHistory({
  articleId,
  readOnly = false,
  onClose,
  onAction,
}: {
  articleId: string;
  readOnly?: boolean;
  onClose: () => void;
  onAction: (kind: KnowledgeEditorKind, version?: KnowledgeVersion) => void;
}) {
  const [tab, setTab] = useState<'versions' | 'history'>('versions'),
    [page, setPage] = useState(1);
  const detail = useVisitData(
    `/api/knowledge-authoring/${encodeURIComponent(articleId)}`,
    (value) => checkedKnowledgeDetail(value, articleId),
  );
  const versions = useVisitData(
    !readOnly && tab === 'versions'
      ? `/api/knowledge-authoring/${encodeURIComponent(articleId)}/versions?page=${page}&pageSize=10`
      : null,
    (value) => checkedKnowledgeVersions(value, articleId, page, 10),
  );
  const history = useVisitData(
    !readOnly && tab === 'history'
      ? `/api/knowledge-authoring/${encodeURIComponent(articleId)}/history?page=${page}&pageSize=10`
      : null,
    (value) => checkedKnowledgeHistory(value, articleId, page, 10),
  );
  const resource = tab === 'versions' ? versions : history;
  return (
    <Modal
      title={
        readOnly ? (detail.data?.article.title ?? 'Read clinic article') : 'Private article history'
      }
      onClose={onClose}
    >
      <div className="knowledge-authoring-history">
        {detail.loading ? (
          <Loading />
        ) : detail.error ? (
          <ErrorState message={detail.error} retry={detail.reload} />
        ) : detail.data ? (
          <>
            <KnowledgeArticleSource detail={detail.data} />
            {readOnly ? (
              <>
                <KnowledgeVersionAttribution version={detail.data.currentVersion} />
                <KnowledgeArticleContent article={detail.data.currentVersion.fields} />
              </>
            ) : (
              <>
                <p className="notice">
                  Saved versions, internal notes and activity are visible only to clinical staff.
                  Restoring creates a new private draft; it never changes a historical version.
                </p>
                <div className="knowledge-authoring-actions">
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => onAction('edit')}
                  >
                    Edit &amp; review
                  </button>
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() =>
                      onAction(detail.data!.article.status === 'published' ? 'withdraw' : 'publish')
                    }
                  >
                    {detail.data.article.status === 'published'
                      ? 'Withdraw publication'
                      : 'Publish current version'}
                  </button>
                </div>
                <div
                  className="knowledge-authoring-actions"
                  role="group"
                  aria-label="Article history views"
                >
                  <button
                    type="button"
                    className={`button ${tab === 'versions' ? 'button-primary' : 'button-secondary'}`}
                    aria-pressed={tab === 'versions'}
                    onClick={() => {
                      setTab('versions');
                      setPage(1);
                    }}
                  >
                    Saved versions
                  </button>
                  <button
                    type="button"
                    className={`button ${tab === 'history' ? 'button-primary' : 'button-secondary'}`}
                    aria-pressed={tab === 'history'}
                    onClick={() => {
                      setTab('history');
                      setPage(1);
                    }}
                  >
                    Activity history
                  </button>
                </div>
                {resource.loading ? (
                  <Loading />
                ) : resource.error ? (
                  <ErrorState message={resource.error} retry={resource.reload} />
                ) : tab === 'versions' && versions.data ? (
                  <>
                    <section
                      className="knowledge-authoring-history"
                      aria-label="Saved article versions"
                    >
                      {versions.data.items.map((version) => (
                        <article className="knowledge-authoring-history-entry" key={version.id}>
                          <div className="row between">
                            <h3>Version {version.version}</h3>
                            {version.id === detail.data!.currentVersion.id && (
                              <Badge tone="green">Current content</Badge>
                            )}
                          </div>
                          <KnowledgeVersionAttribution version={version} />
                          {version.restoredFromVersionId && (
                            <p className="small">
                              Copied from an earlier retained version; the source remains unchanged.
                            </p>
                          )}
                          {version.reason && (
                            <p className="knowledge-authoring-private-reason">
                              <strong>Internal note: </strong>
                              {version.reason}
                            </p>
                          )}
                          <details>
                            <summary>
                              Read version {version.version} · {version.fields.title}
                            </summary>
                            <KnowledgeArticleContent article={version.fields} />
                          </details>
                          <button
                            type="button"
                            className="button button-secondary button-small"
                            disabled={version.id === detail.data!.currentVersion.id}
                            onClick={() => onAction('restore', version)}
                          >
                            Restore as new draft
                          </button>
                        </article>
                      ))}
                    </section>
                    <Pagination
                      {...versions.data}
                      label="Article version pagination"
                      onPageChange={setPage}
                    />
                  </>
                ) : tab === 'history' && history.data ? (
                  <>
                    {!history.data.items.length ? (
                      <p className="notice">
                        No attributed authoring events were recorded for these legacy snapshots.
                      </p>
                    ) : (
                      <section
                        className="knowledge-authoring-history"
                        aria-label="Article activity history"
                      >
                        {history.data.items.map((event) => (
                          <article className="knowledge-authoring-history-entry" key={event.id}>
                            <h3>{eventLabels[event.operation]}</h3>
                            <p className="muted small">
                              {event.createdByName} · {knowledgeStamp(event.createdAt)} IST
                            </p>
                            <p>
                              {event.before
                                ? `Version ${event.before.currentVersion} (${event.before.status})`
                                : 'New article'}{' '}
                              → Version {event.after.currentVersion} ({event.after.status})
                            </p>
                            <p>
                              {event.reviewConfirmed
                                ? 'Explicit publication approval recorded.'
                                : event.restoreConfirmed
                                  ? 'Explicit restoration confirmation recorded.'
                                  : 'No publication approval recorded by this action.'}
                            </p>
                            {event.reason ? (
                              <p className="knowledge-authoring-private-reason">
                                <strong>Internal note: </strong>
                                {event.reason}
                              </p>
                            ) : (
                              <p className="muted small">No internal note supplied.</p>
                            )}
                            {event.source === 'legacy-api' && (
                              <p className="muted small">
                                Recorded through the compatible article API.
                              </p>
                            )}
                          </article>
                        ))}
                      </section>
                    )}
                    <Pagination
                      {...history.data}
                      label="Article activity pagination"
                      onPageChange={setPage}
                    />
                  </>
                ) : null}
              </>
            )}
          </>
        ) : null}
      </div>
    </Modal>
  );
}
