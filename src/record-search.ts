import { useCallback, useEffect, useRef, useState } from 'react';
import type { SearchPage } from '../shared/record-search';
import { api } from './lib';

function checkedPage<T>(value: unknown, path: string): SearchPage<T> {
  const page = value as SearchPage<T> | null;
  const params = new URL(path, window.location.origin).searchParams;
  const requestedPage = Number(params.get('page') ?? 1);
  const requestedSize = Number(params.get('pageSize') ?? 25);
  if (
    !page ||
    typeof page !== 'object' ||
    !Array.isArray(page.items) ||
    !Number.isSafeInteger(page.page) ||
    !Number.isSafeInteger(page.pageSize) ||
    !Number.isSafeInteger(page.total) ||
    !Number.isSafeInteger(page.totalPages) ||
    page.page < 1 ||
    page.pageSize < 1 ||
    page.pageSize > 100 ||
    page.pageSize !== requestedSize ||
    page.total < 0 ||
    page.totalPages !== Math.max(1, Math.ceil(page.total / page.pageSize)) ||
    page.page > page.totalPages ||
    page.page !== Math.min(requestedPage, page.totalPages) ||
    page.items.length !==
      Math.min(page.pageSize, Math.max(0, page.total - (page.page - 1) * page.pageSize))
  )
    throw new Error('The search results could not be confirmed. Refresh to try again.');
  return page;
}

/** A result belongs to its exact query; obsolete responses cannot populate newer filters. */
export function useSearchPage<T>(path: string | null) {
  const [state, setState] = useState<{
    path: string | null;
    data: SearchPage<T> | null;
    loading: boolean;
    error: string;
  }>({ path, data: null, loading: !!path, error: '' });
  const generation = useRef(0);
  const currentPath = useRef(path);
  currentPath.current = path;
  const reload = useCallback(async () => {
    if (path !== currentPath.current) return;
    const request = ++generation.current;
    if (!path) {
      setState({ path, data: null, loading: false, error: '' });
      return;
    }
    setState({ path, data: null, loading: true, error: '' });
    try {
      const data = checkedPage<T>(await api<unknown>(path), path);
      if (request === generation.current && path === currentPath.current)
        setState({ path, data, loading: false, error: '' });
    } catch (problem) {
      if (request === generation.current && path === currentPath.current)
        setState({
          path,
          data: null,
          loading: false,
          error: problem instanceof Error ? problem.message : 'Search failed. Please try again.',
        });
    }
  }, [path]);
  useEffect(() => {
    void reload();
    return () => {
      generation.current++;
    };
  }, [reload]);
  return state.path === path
    ? { data: state.data, loading: state.loading, error: state.error, reload }
    : { data: null, loading: !!path, error: '', reload };
}
