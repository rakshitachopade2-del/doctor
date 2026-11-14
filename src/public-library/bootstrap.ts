import type {
  PublicArticle,
  PublicArticleSummary,
  PublicLibraryBootstrap,
} from '../../shared/public-library';

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const articleId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
function article(value: unknown, summary: boolean): value is PublicArticle | PublicArticleSummary {
  return (
    object(value) &&
    articleId(value.id) &&
    text(value.title, 300) &&
    text(value.category, 100) &&
    text(value.authorName, 300) &&
    typeof value.updatedAt === 'string' &&
    Number.isFinite(Date.parse(value.updatedAt)) &&
    (summary
      ? typeof value.excerpt === 'string' && value.excerpt.length <= 183 && !('body' in value)
      : text(value.body, 30000))
  );
}
/** Reject malformed/foreign bootstrap content instead of mounting an unrelated authenticated app. */
export function checkedPublicLibraryBootstrap(value: unknown, url: URL): PublicLibraryBootstrap {
  const bad = () =>
    new Error('The library page could not be loaded. Reload this page to try again.');
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    !['library', 'article', 'not-found'].includes(value.pageType as string) ||
    !text(value.clinicName, 300) ||
    typeof value.demoMode !== 'boolean' ||
    typeof value.indexable !== 'boolean'
  )
    throw bad();
  if (value.canonicalUrl !== null) {
    if (typeof value.canonicalUrl !== 'string') throw bad();
    let canonical: URL;
    try {
      canonical = new URL(value.canonicalUrl);
    } catch {
      throw bad();
    }
    if (
      !['http:', 'https:'].includes(canonical.protocol) ||
      canonical.username ||
      canonical.password ||
      canonical.hash ||
      !/^\/library(?:\/|$)/.test(canonical.pathname)
    )
      throw bad();
  }
  if (value.pageType === 'library') {
    if (
      url.pathname !== '/library' ||
      typeof value.query !== 'string' ||
      value.query.length > 200 ||
      value.query !== value.query.trim() ||
      !Array.isArray(value.articles) ||
      value.pageSize !== 25 ||
      !Number.isSafeInteger(value.page) ||
      Number(value.page) < 1 ||
      !Number.isSafeInteger(value.total) ||
      Number(value.total) < 0 ||
      value.totalPages !== Math.max(1, Math.ceil(Number(value.total) / 25)) ||
      Number(value.page) > Number(value.totalPages) ||
      value.articles.length !==
        Math.min(25, Math.max(0, Number(value.total) - (Number(value.page) - 1) * 25)) ||
      !value.articles.every((item) => article(item, true)) ||
      new Set(value.articles.map((item) => item.id)).size !== value.articles.length ||
      (value.query && value.indexable)
    )
      throw bad();
    const expected = url.searchParams.get('q')?.trim() ?? '';
    const suppliedPage = url.searchParams.get('page');
    const requestedPage =
      suppliedPage === null ? 1 : /^\d+$/.test(suppliedPage) ? Number(suppliedPage) : NaN;
    if (
      value.query !== expected ||
      !Number.isSafeInteger(requestedPage) ||
      requestedPage < 1 ||
      requestedPage > 1_000_000 ||
      value.page !== Math.min(requestedPage, Number(value.totalPages)) ||
      [...url.searchParams.keys()].some((key) => !['q', 'page'].includes(key)) ||
      url.searchParams.getAll('q').length > 1 ||
      url.searchParams.getAll('page').length > 1
    )
      throw bad();
  } else if (value.pageType === 'article') {
    if (
      !article(value.article, false) ||
      url.pathname !== `/library/${value.article.id}` ||
      url.search
    )
      throw bad();
  } else if (value.indexable || value.canonicalUrl !== null) throw bad();
  if (value.indexable && (value.demoMode || value.canonicalUrl === null)) throw bad();
  return value as unknown as PublicLibraryBootstrap;
}
