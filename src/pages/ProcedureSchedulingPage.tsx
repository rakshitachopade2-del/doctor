import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CalendarDays, RefreshCw, Search } from 'lucide-react';
import type {
  ProcedureScheduleFilters,
  ProcedureSchedulePage,
} from '../../shared/procedure-scheduling';
import { formatDate } from '../lib';
import { Badge, Card, EmptyState, ErrorState, Field, Loading, PageHeader } from '../components/ui';
import { Pagination } from '../components/Pagination';
import { ProcedureAppointmentModal } from '../components/ProcedureAppointmentModal';
import { checkedProcedureScheduleRow } from '../components/procedure-scheduling-helpers';
import { useVisitData, visitInterval } from '../components/visit-duration-helpers';
import './procedure-scheduling-page.css';

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const positive = (value: string | null, fallback: number) =>
  value && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0
    ? Number(value)
    : fallback;
const bookingLabels = {
  unlinked: 'No visit linked',
  linked: 'Upcoming or underway',
  attention: 'Check linked visit',
};

function checkedPage(
  value: unknown,
  filters: ProcedureScheduleFilters,
  requestedPage: number,
  pageSize: number,
): ProcedureSchedulePage {
  const bad = () => new Error('The procedure list did not match this view. Refresh to try again.');
  if (
    !object(value) ||
    !object(value.filters) ||
    !Array.isArray(value.items) ||
    !['page', 'pageSize', 'total', 'totalPages'].every((key) => Number.isSafeInteger(value[key])) ||
    Number(value.total) < 0 ||
    value.pageSize !== pageSize ||
    value.filters.search !== filters.search ||
    value.filters.status !== filters.status ||
    value.filters.booking !== filters.booking
  )
    throw bad();
  const total = Number(value.total),
    totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (value.totalPages !== totalPages || value.page !== Math.min(requestedPage, totalPages))
    throw bad();
  const items = value.items.map(checkedProcedureScheduleRow);
  if (
    items.length !== Math.min(pageSize, Math.max(0, total - (Number(value.page) - 1) * pageSize)) ||
    new Set(items.map((item) => item.id)).size !== items.length ||
    items.some(
      (item) =>
        (filters.status !== 'all' && item.status !== filters.status) ||
        (filters.booking !== 'all' && item.schedulingState !== filters.booking),
    )
  )
    throw bad();
  return { ...value, items } as unknown as ProcedureSchedulePage;
}

export function ProcedureSchedulingPage() {
  const [params, setParams] = useSearchParams();
  const search = (params.get('search') ?? '').trim().slice(0, 200);
  const status = ['all', 'planned', 'completed', 'cancelled'].includes(params.get('status') ?? '')
    ? (params.get('status') as ProcedureScheduleFilters['status'])
    : 'planned';
  const booking = ['all', 'unlinked', 'linked', 'attention'].includes(params.get('booking') ?? '')
    ? (params.get('booking') as ProcedureScheduleFilters['booking'])
    : 'all';
  const page = positive(params.get('page'), 1);
  const pageSize = [10, 25, 50].includes(Number(params.get('pageSize')))
    ? Number(params.get('pageSize'))
    : 25;
  const filters = { search, status, booking };
  const query = new URLSearchParams({ ...filters, page: String(page), pageSize: String(pageSize) });
  const resource = useVisitData(`/api/procedure-scheduling?${query}`, (value) =>
    checkedPage(value, filters, page, pageSize),
  );
  const [draft, setDraft] = useState(search);
  useEffect(() => setDraft(search), [search]);
  const latestReload = useRef(resource.reload);
  latestReload.current = resource.reload;
  const heading = useRef<HTMLHeadingElement>(null),
    focusResults = useRef(false);
  useEffect(() => {
    if (resource.data && focusResults.current) {
      focusResults.current = false;
      heading.current?.focus();
    }
  }, [resource.data]);
  function change(values: Record<string, string | null>) {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.delete('page');
      for (const [key, value] of Object.entries(values)) {
        if (value === null || value === '') next.delete(key);
        else next.set(key, value);
      }
      return next;
    });
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    change({ search: draft.trim() });
  }
  function openProcedure(id: string | null) {
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (id) next.set('procedure', id);
        else next.delete('procedure');
        return next;
      },
      { replace: true },
    );
  }
  return (
    <>
      <PageHeader
        eyebrow="CLINIC OPERATIONS"
        title="Procedure appointments"
        description="Connect existing procedure plans to booked visits and keep the scheduling history."
        actions={
          <Link className="button button-secondary" to="/clinic/appointments?new=1">
            <CalendarDays size={17} />
            Book a visit
          </Link>
        }
      />
      <div className="notice procedure-schedule-intro">
        <p>
          Book the visit first, then link it here. Check that its length and assigned rooms or
          equipment fit the planned work. Linking does not change an appointment, reserve extra
          time, or record patient agreement.
        </p>
      </div>
      <Card>
        <form className="procedure-schedule-search" onSubmit={submit}>
          <Field label="Search procedure appointments">
            <input
              type="search"
              maxLength={200}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Patient name or procedure title"
            />
          </Field>
          <button className="button button-secondary">
            <Search size={16} />
            Search
          </button>
        </form>
        <div className="procedure-schedule-filters">
          <Field label="Procedure status">
            <select value={status} onChange={(event) => change({ status: event.target.value })}>
              <option value="planned">Planned</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
              <option value="all">All statuses</option>
            </select>
          </Field>
          <Field label="Appointment link">
            <select value={booking} onChange={(event) => change({ booking: event.target.value })}>
              <option value="all">All links</option>
              <option value="unlinked">No visit linked</option>
              <option value="linked">Upcoming or underway</option>
              <option value="attention">Check linked visit</option>
            </select>
          </Field>
          <Field label="Results per page">
            <select value={pageSize} onChange={(event) => change({ pageSize: event.target.value })}>
              <option value="10">10</option>
              <option value="25">25</option>
              <option value="50">50</option>
            </select>
          </Field>
          <button
            className="button button-secondary"
            type="button"
            onClick={() => {
              setDraft('');
              change({ search: null, status: null, booking: null, pageSize: null });
            }}
          >
            Reset filters
          </button>
          <button
            className="button button-ghost"
            type="button"
            disabled={resource.loading}
            onClick={() => void resource.reload()}
          >
            <RefreshCw size={16} />
            Refresh list
          </button>
        </div>
        <p className="muted small">
          “Check linked visit” includes closed, missing, or past scheduled visits. Review the
          appointment and procedure documentation; it does not indicate clinical urgency.
        </p>
      </Card>
      <section className="procedure-schedule-results" aria-label="Procedure appointment results">
        <h2 ref={heading} tabIndex={-1}>
          Procedure list
        </h2>
        {resource.loading ? (
          <Loading />
        ) : resource.error ? (
          <ErrorState message={resource.error} retry={resource.reload} />
        ) : (
          resource.data && (
            <>
              {!resource.data.items.length ? (
                <Card>
                  <EmptyState
                    title="No matching procedure plans"
                    description="Change the filters or search. Clinicians create procedure plans from the patient’s clinical workup."
                  />
                </Card>
              ) : (
                <div className="procedure-schedule-rows">
                  {resource.data.items.map((item) => (
                    <Card key={item.id}>
                      <article className="procedure-schedule-row">
                        <div>
                          <div className="row">
                            <Badge
                              tone={
                                item.status === 'completed'
                                  ? 'green'
                                  : item.status === 'cancelled'
                                    ? 'gray'
                                    : 'blue'
                              }
                            >
                              {item.status}
                            </Badge>
                            <span className="muted small">
                              {bookingLabels[item.schedulingState]}
                            </span>
                          </div>
                          <h3>{item.title}</h3>
                          <p>
                            <strong>{item.patientName}</strong>
                          </p>
                          <p className="muted small">
                            Planned by {item.doctorName} · {formatDate(item.createdAt)}
                          </p>
                        </div>
                        <div className="procedure-schedule-visit">
                          {item.appointment ? (
                            <>
                              <strong>
                                {formatDate(item.appointment.date)} ·{' '}
                                {visitInterval(
                                  item.appointment.time,
                                  item.appointment.durationMinutes,
                                )}
                              </strong>
                              <p>
                                {item.appointment.doctorName} ·{' '}
                                {item.appointment.mode === 'online' ? 'Online' : 'In clinic'}
                              </p>
                              <p>
                                {item.appointment.durationMinutes} minutes ·{' '}
                                {item.appointment.status.replaceAll('-', ' ')}
                              </p>
                            </>
                          ) : (
                            <p>
                              {item.effectiveAppointmentId
                                ? 'Linked visit is unavailable. Review its scheduling history.'
                                : 'No appointment linked to this plan.'}
                            </p>
                          )}
                          {item.blockedReason && (
                            <p className="muted small">{item.blockedReason}</p>
                          )}
                        </div>
                        <button
                          className="button button-secondary"
                          onClick={() => openProcedure(item.id)}
                        >
                          {item.canChange ? 'Manage appointment' : 'Scheduling history'}
                        </button>
                      </article>
                    </Card>
                  ))}
                </div>
              )}
              <Pagination
                page={resource.data.page}
                pageSize={resource.data.pageSize}
                total={resource.data.total}
                totalPages={resource.data.totalPages}
                label="Procedure appointments pagination"
                onPageChange={(next) => {
                  focusResults.current = true;
                  change({ page: String(next) });
                }}
              />
            </>
          )
        )}
      </section>
      {params.get('procedure') && (
        <ProcedureAppointmentModal
          key={params.get('procedure')!}
          procedureId={params.get('procedure')!}
          onClose={() => openProcedure(null)}
          onSaved={async () => {
            await latestReload.current();
          }}
        />
      )}
    </>
  );
}
