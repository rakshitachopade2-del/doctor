import { Activity, ArrowLeft, ArrowRight, ArrowUpRight, BookOpen, Search } from 'lucide-react';
import type { PublicLibraryBootstrap, PublicArticleSummary } from '../../shared/public-library';

/** No router, session, browser globals or stylesheet imports: Express renders this exact view. */
export function PublicLibraryDocument({ data }: { data: PublicLibraryBootstrap }) {
  return (
    <div className="public-layout public-library-document">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="public-header">
        <PublicBrand />
        <nav aria-label="Public navigation">
          <a href="/">Find your dermatologist</a>
          <a href="/intake">Prepare for your visit</a>
          <a href="/library" aria-current={data.pageType === 'library' ? 'page' : undefined}>
            Clinic library
          </a>
        </nav>
        <a className="button button-primary" href="/login">
          Sign in <ArrowUpRight size={16} aria-hidden="true" />
        </a>
      </header>
      {data.demoMode && (
        <div className="public-demo">
          <span className="live-dot" />
          Demonstration clinic · All profiles and patient records are fictional
        </div>
      )}
      <main id="main" className="public-library-main">
        {data.pageType === 'library' ? (
          <>
            <header className="public-library-heading">
              <p className="eyebrow">INFORMATION YOU CAN COME BACK TO</p>
              <h1>Clinic library</h1>
              <p>Information published by {data.clinicName}, ready to read and share.</p>
            </header>
            <form method="get" action="/library" className="public-library-search" role="search">
              <div className="field">
                <label className="field-label" htmlFor="public-library-query">
                  Search articles
                </label>
                <input
                  id="public-library-query"
                  type="search"
                  name="q"
                  defaultValue={data.query}
                  maxLength={200}
                  placeholder="Search titles, topics or article content…"
                />
              </div>
              <button className="button button-primary">
                <Search size={16} aria-hidden="true" />
                Search library
              </button>
              {data.query && (
                <a className="button button-secondary" href="/library">
                  Clear search
                </a>
              )}
            </form>
            <p className="public-library-count">
              {data.total} {data.total === 1 ? 'article' : 'articles'}
              {data.query ? ` matching “${data.query}”` : ' published'}
            </p>
            {data.articles.length ? (
              <div className="public-library-grid">
                {data.articles.map((article) => (
                  <ArticleCard key={article.id} article={article} />
                ))}
              </div>
            ) : (
              <section className="card public-library-empty">
                <BookOpen size={28} aria-hidden="true" />
                <h2>
                  {data.query ? 'No articles match this search' : 'No published articles yet'}
                </h2>
                <p>
                  {data.query
                    ? 'Try another word or return to the full clinic library.'
                    : 'Your clinic will share information here when it is ready.'}
                </p>
                {data.query && (
                  <a href="/library" className="button button-secondary">
                    View all articles
                  </a>
                )}
              </section>
            )}
            <nav className="public-library-pagination" aria-label="Library pages">
              <p>
                Page {data.page} of {data.totalPages}
              </p>
              <div>
                <PageLink
                  label="First page"
                  page={1}
                  query={data.query}
                  disabled={data.page === 1}
                />
                <PageLink
                  label="Previous page"
                  page={data.page - 1}
                  query={data.query}
                  disabled={data.page === 1}
                />
                <PageLink
                  label="Next page"
                  page={data.page + 1}
                  query={data.query}
                  disabled={data.page === data.totalPages}
                />
                <PageLink
                  label="Last page"
                  page={data.totalPages}
                  query={data.query}
                  disabled={data.page === data.totalPages}
                />
              </div>
            </nav>
          </>
        ) : data.pageType === 'article' ? (
          <>
            <nav className="public-library-breadcrumb" aria-label="Breadcrumb">
              <a href="/library">
                <ArrowLeft size={16} aria-hidden="true" />
                Clinic library
              </a>
              <span aria-hidden="true">/</span>
              <span>Article</span>
            </nav>
            <article className="public-library-article">
              <header>
                <span className="badge badge-green">{data.article.category}</span>
                <h1>{data.article.title}</h1>
                <p className="public-library-attribution">
                  By {data.article.authorName} · Updated{' '}
                  <time dateTime={data.article.updatedAt}>
                    {publicArticleDate(data.article.updatedAt)}
                  </time>
                </p>
              </header>
              <div className="public-library-article-body">
                <p>{data.article.body}</p>
              </div>
              <footer>
                <p>Published in the {data.clinicName} library.</p>
                <a href="/library" className="button button-secondary">
                  <ArrowLeft size={16} aria-hidden="true" />
                  Back to library
                </a>
              </footer>
            </article>
          </>
        ) : (
          <section className="public-library-unavailable">
            <BookOpen size={34} aria-hidden="true" />
            <h1>This page is not available</h1>
            <p>
              The article may be unavailable, or this address may be incorrect. You can browse the
              current published library.
            </p>
            <a className="button button-primary" href="/library">
              Back to library <ArrowRight size={16} aria-hidden="true" />
            </a>
          </section>
        )}
      </main>
      <footer className="public-footer">
        <PublicBrand small />
        <span>Thoughtful care. Every step of the way.</span>
        <span>Dermatology, connected.</span>
      </footer>
    </div>
  );
}
function PublicBrand({ small = false }: { small?: boolean }) {
  return (
    <a href="/" className={`brand ${small ? 'brand-small' : ''}`} aria-label="Derma home">
      <span className="brand-mark">
        <Activity size={23} strokeWidth={2} aria-hidden="true" />
      </span>
      <span>
        derma<span className="brand-dot">.</span>
      </span>
    </a>
  );
}
/** Avoid Node/browser locale database differences during hydration. */
function publicArticleDate(value: string) {
  const date = new Date(Date.parse(value) + 330 * 60_000);
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}
function ArticleCard({ article }: { article: PublicArticleSummary }) {
  const href = `/library/${encodeURIComponent(article.id)}`;
  return (
    <article className="card public-library-card">
      <BookOpen size={24} aria-hidden="true" />
      <span className="badge badge-green">{article.category}</span>
      <h2>
        <a href={href}>{article.title}</a>
      </h2>
      <p className="public-library-excerpt">{article.excerpt}</p>
      <p className="public-library-attribution">
        By {article.authorName} · Updated{' '}
        <time dateTime={article.updatedAt}>{publicArticleDate(article.updatedAt)}</time>
      </p>
      <a
        href={href}
        className="button button-secondary button-small"
        aria-label={`Read article: ${article.title}`}
      >
        Read article
        <ArrowUpRight size={15} aria-hidden="true" />
      </a>
    </article>
  );
}
function PageLink({
  label,
  page,
  query,
  disabled,
}: {
  label: string;
  page: number;
  query: string;
  disabled: boolean;
}) {
  if (disabled)
    return (
      <span
        className="button button-secondary button-small public-library-page-disabled"
        aria-disabled="true"
      >
        {label}
      </span>
    );
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (page > 1) params.set('page', String(page));
  return (
    <a
      className="button button-secondary button-small"
      href={`/library${params.size ? `?${params}` : ''}`}
    >
      {label}
    </a>
  );
}
