import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigationType, useSearchParams } from 'react-router-dom';
import { RefreshCw, Search, ShieldCheck } from 'lucide-react';
import type { AuditEntry } from '../../shared/types';
import type { SearchPage } from '../../shared/record-search';
import { useSearchPage } from '../record-search';
import { Pagination } from '../components/Pagination';
import { Badge, Card, EmptyState, ErrorState, Field, Loading, PageHeader } from '../components/ui';
import './audit.css';

const filterKeys = ['q', 'actor', 'action', 'entityType', 'entityId', 'from', 'to'] as const;
type FilterKey = (typeof filterKeys)[number];
type Filters = Record<FilterKey, string>;
const blankFilters: Filters = {
  q: '',
  actor: '',
  action: '',
  entityType: '',
  entityId: '',
  from: '',
  to: '',
};
function readFilters(params: URLSearchParams): Filters {
  return Object.fromEntries(filterKeys.map((key) => [key, params.get(key) ?? ''])) as Filters;
}
function pageNumber(value: string | null) {
  if (!value || !/^\d+$/.test(value)) return 1;
  const page = Number(value);
  return Number.isSafeInteger(page) && page >= 1 && page <= 1_000_000 ? page : 1;
}
function query(filters: Filters, page: number) {
  const result = new URLSearchParams();
  for (const key of filterKeys) if (filters[key].trim()) result.set(key, filters[key].trim());
  if (page > 1) result.set('page', String(page));
  return result;
}
function validRows(data: SearchPage<AuditEntry>) {
  return (
    data.pageSize === 25 &&
    data.items.every(
      (entry) =>
        entry &&
        typeof entry.id === 'string' &&
        entry.id.length > 0 &&
        typeof entry.actorName === 'string' &&
        typeof entry.action === 'string' &&
        typeof entry.entityType === 'string' &&
        typeof entry.entityId === 'string' &&
        typeof entry.createdAt === 'string' &&
        Number.isFinite(Date.parse(entry.createdAt)),
    ) &&
    new Set(data.items.map((entry) => entry.id)).size === data.items.length
  );
}
const dateLabel = (value: string) =>
  new Date(value).toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
const timeLabel = (value: string) =>
  new Date(value).toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

export function AuditPage() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigationType = useNavigationType();
  const ownFilterNavigations = useRef(new Set<string>());
  const applied = readFilters(params);
  const appliedKey = JSON.stringify(applied);
  const requestedPage = pageNumber(params.get('page'));
  const requestParams = query(applied, requestedPage);
  requestParams.set('pageSize', '25');
  const resource = useSearchPage<AuditEntry>(`/api/search/audit?${requestParams.toString()}`);
  const [draft, setDraft] = useState<Filters>(applied);
  const [validation, setValidation] = useState('');
  useLayoutEffect(() => {
    // Apply/Reset already updated the draft, and page normalization must keep it.
    // Reinitializing it after these URL transitions can erase newer input. History
    // navigation always restores its filters before the browser can accept input.
    if (navigationType !== 'POP' && ownFilterNavigations.current.delete(params.toString())) return;
    ownFilterNavigations.current.clear();
    setDraft(readFilters(params));
    setValidation('');
  }, [location.key]);
  let error = resource.error;
  if (!resource.loading && !error && resource.data && !validRows(resource.data))
    error = 'The activity response could not be read. Refresh to load a complete page.';
  const data = !resource.loading && !error ? resource.data : null;
  useEffect(() => {
    if (data && data.page !== requestedPage) {
      const next = query(applied, data.page);
      ownFilterNavigations.current.add(next.toString());
      setParams(next, { replace: true });
    }
  }, [data, requestedPage, appliedKey]);
  function update(key: FilterKey, value: string) {
    setDraft((current) => ({ ...current, [key]: value }));
    setValidation('');
  }
  function apply(event: FormEvent) {
    event.preventDefault();
    if (draft.from && draft.to && draft.from > draft.to) {
      setValidation('The start date must be on or before the end date.');
      return;
    }
    setValidation('');
    const next = query(draft, 1);
    setDraft(readFilters(next));
    ownFilterNavigations.current.add(next.toString());
    setParams(next);
  }
  function reset() {
    setDraft(blankFilters);
    setValidation('');
    ownFilterNavigations.current.add('');
    setParams(new URLSearchParams());
  }
  return (
    <>
      <PageHeader
        eyebrow="ACCESS & CHANGES"
        title="Clinic activity"
        description="Search the clinic audit history, including older access and changes."
        actions={
          <button
            className="button button-secondary"
            disabled={resource.loading}
            onClick={resource.reload}
          >
            <RefreshCw size={16} />
            Refresh activity
          </button>
        }
      />
      <Card className="audit-filter-card">
        <div className="section-heading">
          <div>
            <h2>Find clinic activity</h2>
            <p className="muted small">
              Search recorded actor names, actions and record identifiers.
            </p>
          </div>
          <ShieldCheck size={22} aria-hidden="true" />
        </div>
        <form onSubmit={apply} className="audit-filter-form">
          <div className="audit-filter-grid">
            <Field
              label="Search activity"
              hint="Literal text across the visible audit fields; % and _ are ordinary characters."
            >
              <input
                type="search"
                maxLength={200}
                value={draft.q}
                onChange={(event) => update('q', event.target.value)}
                placeholder="Search all audit fields"
              />
            </Field>
            <Field label="Performed by" hint="Contains the actor name recorded at the time.">
              <input
                type="search"
                maxLength={200}
                value={draft.actor}
                onChange={(event) => update('actor', event.target.value)}
                placeholder="Actor name contains…"
              />
            </Field>
            <Field label="Action contains">
              <input
                type="search"
                maxLength={200}
                value={draft.action}
                onChange={(event) => update('action', event.target.value)}
                placeholder="For example, booked appointment"
              />
            </Field>
            <Field label="Record type" hint="Exact type, such as patient, appointment or user.">
              <input
                maxLength={300}
                value={draft.entityType}
                onChange={(event) => update('entityType', event.target.value)}
                placeholder="Exact record type"
              />
            </Field>
            <Field label="Record ID" hint="Exact identifier of the affected record.">
              <input
                maxLength={300}
                value={draft.entityId}
                onChange={(event) => update('entityId', event.target.value)}
                placeholder="Exact record ID"
              />
            </Field>
            <div className="audit-date-range">
              <Field label="From date">
                <input
                  type="date"
                  value={draft.from}
                  onChange={(event) => update('from', event.target.value)}
                />
              </Field>
              <Field label="Through date">
                <input
                  type="date"
                  value={draft.to}
                  onChange={(event) => update('to', event.target.value)}
                />
              </Field>
            </div>
          </div>
          {validation && (
            <p className="form-error" role="alert">
              {validation}
            </p>
          )}
          <div className="audit-filter-actions">
            <button className="button button-primary">
              <Search size={16} />
              Apply filters
            </button>
            <button type="button" className="button button-secondary" onClick={reset}>
              Reset filters
            </button>
          </div>
        </form>
        <p className="audit-scope-note">
          Dates include the whole selected days in Asia/Kolkata. Results reflect current records;
          new activity can move entries between pages. Names remain as recorded at the time.
        </p>
      </Card>
      <Card className="audit-results-card">
        {resource.loading ? (
          <Loading />
        ) : error ? (
          <ErrorState message={error} retry={resource.reload} />
        ) : !data ? (
          <ErrorState message="Clinic activity is unavailable." retry={resource.reload} />
        ) : (
          <>
            <div className="audit-result-heading">
              <h2>Audit history</h2>
              <p className="audit-result-count" role="status">
                {data.total.toLocaleString('en-IN')}{' '}
                {data.total === 1 ? 'entry matches' : 'entries match'}
              </p>
            </div>
            {data.items.length ? (
              <div
                className="audit-table-region"
                role="region"
                aria-label="Clinic audit records"
                tabIndex={0}
              >
                <table className="data-table audit-table">
                  <caption className="sr-only">Clinic audit records, newest first</caption>
                  <thead>
                    <tr>
                      <th scope="col">Activity</th>
                      <th scope="col">Performed by</th>
                      <th scope="col">Record</th>
                      <th scope="col">Date & time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((entry) => (
                      <tr key={entry.id} className="audit-row">
                        <td>
                          <span className="audit-mobile-label" aria-hidden="true">
                            Activity
                          </span>
                          <strong>{entry.action || 'Not recorded'}</strong>
                        </td>
                        <td>
                          <span className="audit-mobile-label" aria-hidden="true">
                            Performed by
                          </span>
                          <span>{entry.actorName || 'Not recorded'}</span>
                        </td>
                        <td>
                          <span className="audit-mobile-label" aria-hidden="true">
                            Record
                          </span>
                          <span className="audit-record">
                            <Badge>{entry.entityType || 'Not recorded'}</Badge>
                            <code>{entry.entityId || 'No record ID'}</code>
                          </span>
                        </td>
                        <td>
                          <span className="audit-mobile-label" aria-hidden="true">
                            Recorded
                          </span>
                          <time dateTime={entry.createdAt}>
                            {dateLabel(entry.createdAt)}
                            <span className="table-subtitle">{timeLabel(entry.createdAt)} IST</span>
                          </time>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState
                title="No activity matches these filters"
                description="Try another actor, action, record or date range, or reset the filters to see all activity."
              />
            )}
            <Pagination
              page={data.page}
              pageSize={data.pageSize}
              total={data.total}
              totalPages={data.totalPages}
              onPageChange={(page) => setParams(query(applied, page))}
              disabled={resource.loading}
              label="Audit history pages"
            />
          </>
        )}
      </Card>
    </>
  );
}
