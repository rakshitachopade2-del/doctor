/** Explicitly public, approved knowledge. Never serialize internal knowledge rows directly. */
export interface PublicArticle {
  id: string;
  title: string;
  category: string;
  body: string;
  authorName: string;
  updatedAt: string;
}

export interface PublicArticleSummary extends Omit<PublicArticle, 'body'> {
  excerpt: string;
}

export interface PublicLibraryIndex {
  articles: PublicArticleSummary[];
  query: string;
  page: number;
  pageSize: 25;
  total: number;
  totalPages: number;
}

interface PublicLibraryBase {
  schemaVersion: 1;
  clinicName: string;
  demoMode: boolean;
  /** Only configured origins can produce absolute public URLs. */
  canonicalUrl: string | null;
  indexable: boolean;
}

export type PublicLibraryBootstrap =
  | (PublicLibraryBase & PublicLibraryIndex & { pageType: 'library' })
  | (PublicLibraryBase & { pageType: 'article'; article: PublicArticle })
  | (PublicLibraryBase & { pageType: 'not-found' });
