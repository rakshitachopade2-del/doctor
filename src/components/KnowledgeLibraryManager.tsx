import { useState, type FormEvent } from 'react';
import { BookOpen, History, Plus, Search } from 'lucide-react';
import type { KnowledgeAuthoringPage, KnowledgeVersion } from '../../shared/knowledge-authoring';
import { Badge, Card, EmptyState, ErrorState, Field, Loading, PageHeader } from './ui';
import { Pagination } from './Pagination';
import { useVisitData } from './visit-duration-helpers';
import { useToast } from '../lib';
import { checkedKnowledgePage, knowledgeStamp } from './knowledge-authoring-helpers';
import { KnowledgeArticleEditor, type KnowledgeEditorKind } from './KnowledgeArticleEditor';
import { KnowledgeArticleHistory } from './KnowledgeArticleHistory';
import './knowledge-authoring.css';

type DialogState =
  | { type: 'editor'; articleId?: string; kind: KnowledgeEditorKind; version?: KnowledgeVersion }
  | { type: 'history' | 'read'; articleId: string };
export function KnowledgeLibraryManager() {
  const [filters, setFilters] = useState<KnowledgeAuthoringPage['filters']>({
      q: '',
      status: 'all',
    }),
    [draft, setDraft] = useState(filters),
    [page, setPage] = useState(1),
    [dialog, setDialog] = useState<DialogState | null>(null),
    toast = useToast();
  const query = new URLSearchParams({ ...filters, page: String(page), pageSize: '25' }),
    articles = useVisitData(`/api/knowledge-authoring?${query}`, (value) =>
      checkedKnowledgePage(value, filters, page, 25),
    );
  function search(event: FormEvent) {
    event.preventDefault();
    setFilters({ q: draft.q.trim(), status: draft.status });
    setPage(1);
  }
  return (
    <div className="knowledge-authoring-manager">
      <PageHeader
        eyebrow="CLINIC KNOWLEDGE"
        title="Your knowledge library"
        description="Write, review, and publish information for your patients."
        actions={
          <button
            className="button button-primary"
            onClick={() => setDialog({ type: 'editor', kind: 'edit' })}
          >
            <Plus size={16} />
            New article
          </button>
        }
      />
      <form className="knowledge-authoring-filter" onSubmit={search}>
        <Field label="Search articles">
          <input
            maxLength={200}
            placeholder="Search clinic information…"
            value={draft.q}
            onChange={(e) => setDraft({ ...draft, q: e.target.value })}
          />
        </Field>
        <Field label="Article status">
          <select
            value={draft.status}
            onChange={(e) =>
              setDraft({
                ...draft,
                status: e.target.value as KnowledgeAuthoringPage['filters']['status'],
              })
            }
          >
            <option value="all">All articles</option>
            <option value="draft">Private drafts</option>
            <option value="published">Published</option>
          </select>
        </Field>
        <button className="button button-secondary">
          <Search size={16} />
          Find articles
        </button>
        <button
          className="button button-ghost"
          type="button"
          onClick={() => {
            setDraft({ q: '', status: 'all' });
            setFilters({ q: '', status: 'all' });
            setPage(1);
          }}
        >
          Reset filters
        </button>
      </form>
      <p className="muted small" role="status">
        {articles.loading
          ? 'Loading articles…'
          : articles.error
            ? 'Article count unavailable'
            : `${articles.data?.total ?? 0} articles in this view`}
      </p>
      {articles.loading ? (
        <Loading />
      ) : articles.error ? (
        <ErrorState message={articles.error} retry={articles.reload} />
      ) : articles.data && !articles.data.items.length ? (
        <Card>
          <EmptyState
            title="No articles in this view"
            description="Adjust your filters or create a draft to review and publish."
          />
        </Card>
      ) : articles.data ? (
        <>
          <div className="grid-3 knowledge-grid">
            {articles.data.items.map((article) => (
              <Card key={article.id}>
                <div className="row between">
                  <span className="module-icon">
                    <BookOpen size={22} />
                  </span>
                  <Badge tone={article.status === 'published' ? 'green' : 'neutral'}>
                    {article.status}
                  </Badge>
                </div>
                <h2>{article.title}</h2>
                <p className="muted">{article.category}</p>
                <small>
                  Current version {article.currentVersion} · Updated{' '}
                  {knowledgeStamp(article.updatedAt)} IST
                </small>
                <div className="row">
                  <button
                    className="button button-secondary button-small"
                    onClick={() => setDialog({ type: 'read', articleId: article.id })}
                  >
                    Read article
                  </button>
                  {article.status === 'published' && (
                    <a
                      className="button button-secondary button-small"
                      href={`/library/${encodeURIComponent(article.id)}`}
                      aria-label={`Open public article: ${article.title}`}
                    >
                      Open public article
                    </a>
                  )}
                  <button
                    className="button button-ghost button-small"
                    onClick={() =>
                      setDialog({ type: 'editor', articleId: article.id, kind: 'edit' })
                    }
                  >
                    Edit &amp; review
                  </button>
                  <button
                    className="button button-ghost button-small"
                    onClick={() => setDialog({ type: 'history', articleId: article.id })}
                  >
                    <History size={14} />
                    Version history
                  </button>
                </div>
              </Card>
            ))}
          </div>
          <Pagination
            {...articles.data}
            label="Knowledge library pagination"
            onPageChange={setPage}
          />
        </>
      ) : null}
      {dialog?.type === 'editor' ? (
        <KnowledgeArticleEditor
          key={`${dialog.articleId ?? 'new'}:${dialog.kind}`}
          articleId={dialog.articleId}
          kind={dialog.kind}
          restoredVersion={dialog.version}
          onClose={() => setDialog(null)}
          onSaved={(detail) => {
            setDialog(null);
            toast(
              detail.article.status === 'published'
                ? 'Article published to your clinic library.'
                : 'Draft saved for review.',
            );
            void articles.reload();
          }}
        />
      ) : dialog ? (
        <KnowledgeArticleHistory
          key={`${dialog.articleId}:${dialog.type}`}
          articleId={dialog.articleId}
          readOnly={dialog.type === 'read'}
          onClose={() => setDialog(null)}
          onAction={(kind, version) =>
            setDialog({ type: 'editor', articleId: dialog.articleId, kind, version })
          }
        />
      ) : null}
    </div>
  );
}
