import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Plus, Search } from 'lucide-react';
import type {
  AppointmentSeriesDetail,
  AppointmentSeriesPage as SeriesPage,
} from '../../shared/appointment-series';
import type { Doctor, Patient } from '../../shared/types';
import { formatDate, money, useResource, useToast } from '../lib';
import { Badge, Card, EmptyState, ErrorState, Field, Loading, PageHeader } from '../components/ui';
import { Pagination } from '../components/Pagination';
import { AppointmentSeriesModal } from '../components/AppointmentSeriesModal';
import {
  SeriesCancellationModal,
  SeriesCancellationHistory,
} from '../components/SeriesCancellationModal';
import { useCancellationData } from '../components/series-cancellation-helpers';
import {
  checkedSeriesDetail,
  checkedSeriesPage,
  seriesCadence,
  seriesDate,
  seriesStamp,
} from '../components/appointment-series-helpers';
import { visitInterval, visitMinutes, visitPolicy } from '../components/visit-duration-helpers';
import '../components/appointment-series.css';

function positive(value: string | null) {
  return value && /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 1000000
    ? Number(value)
    : 1;
}
export function AppointmentSeriesPage() {
  const [params, setParams] = useSearchParams(),
    location = useLocation(),
    toast = useToast();
  const seriesId = params.get('series'),
    page = positive(params.get('page')),
    filters: SeriesPage['filters'] = {
      q: (params.get('search') ?? '').trim().slice(0, 200),
      patientId: params.get('patientId') || null,
      doctorId: params.get('doctorId') || null,
    };
  const query = new URLSearchParams({
    q: filters.q,
    page: String(page),
    pageSize: '25',
    ...(filters.patientId ? { patientId: filters.patientId } : {}),
    ...(filters.doctorId ? { doctorId: filters.doctorId } : {}),
  });
  const list = useCancellationData(!seriesId ? `/api/appointment-series?${query}` : null, (value) =>
      checkedSeriesPage(value, filters, page, 25),
    ),
    detail = useCancellationData(
      seriesId ? `/api/appointment-series/${encodeURIComponent(seriesId)}` : null,
      (value) => checkedSeriesDetail(value, seriesId ?? undefined),
    );
  const doctors = useResource<Doctor[]>(!seriesId ? '/api/doctors' : null),
    patients = useResource<Patient[]>(!seriesId ? '/api/patients' : null);
  const [draft, setDraft] = useState(filters),
    [booking, setBooking] = useState<string | null>(null),
    [cancelling, setCancelling] = useState<string | null>(null),
    ownNavigation = useRef<string | null>(null);
  useLayoutEffect(() => {
    setBooking((origin) => (origin === location.key ? origin : null));
    setCancelling((origin) => (origin === location.key ? origin : null));
    if (ownNavigation.current === location.search) {
      ownNavigation.current = null;
      return;
    }
    setDraft(filters);
  }, [location.key]);
  function navigate(values: Record<string, string | null>, replace = false) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    const target = next.size ? `?${next}` : '';
    ownNavigation.current = target;
    setParams(next, { replace });
  }
  useEffect(() => {
    if (list.data && !list.loading && !list.error && list.data.page !== page)
      navigate({ page: list.data.page === 1 ? null : String(list.data.page) }, true);
  }, [list.data, list.loading, list.error, page]);
  function apply(event: FormEvent) {
    event.preventDefault();
    const normalized = { ...draft, q: draft.q.trim() };
    setDraft(normalized);
    navigate({
      search: normalized.q || null,
      patientId: normalized.patientId,
      doctorId: normalized.doctorId,
      page: null,
    });
  }
  return (
    <div className="appointment-series-page">
      <Link to="/clinic/appointments" className="text-link">
        <ArrowLeft size={15} />
        Back to appointments
      </Link>
      <PageHeader
        eyebrow="CLINIC OPERATIONS"
        title="Appointment series"
        description="Original recurring bookings and the current state of each individual visit."
        actions={
          <>
            {seriesId && detail.data && !detail.loading && !detail.error && (
              <button
                className="button button-secondary"
                onClick={() => setCancelling(location.key)}
              >
                Cancel remaining visits
              </button>
            )}
            <button className="button button-primary" onClick={() => setBooking(location.key)}>
              <Plus size={16} />
              Book recurring visits
            </button>
          </>
        }
      />
      {seriesId ? (
        <>
          <button className="button button-secondary" onClick={() => navigate({ series: null })}>
            Back to series list
          </button>
          {detail.loading ? (
            <Loading />
          ) : detail.error ? (
            <ErrorState message={detail.error} retry={detail.reload} />
          ) : detail.data ? (
            <SeriesDetail detail={detail.data} />
          ) : null}
        </>
      ) : (
        <>
          <form className="appointment-series-filter" onSubmit={apply}>
            <Field label="Search appointment series">
              <input
                maxLength={200}
                placeholder="Patient or doctor name"
                value={draft.q}
                onChange={(e) => setDraft({ ...draft, q: e.target.value })}
              />
            </Field>
            <button className="button button-secondary">
              <Search size={16} />
              Find series
            </button>
            <button
              className="button button-ghost"
              type="button"
              onClick={() => {
                setDraft({ q: '', patientId: null, doctorId: null });
                navigate({ search: null, patientId: null, doctorId: null, page: null });
              }}
            >
              Reset filters
            </button>
            <Field label="Series patient">
              <select
                value={draft.patientId ?? ''}
                disabled={patients.loading || !!patients.error}
                onChange={(e) => setDraft({ ...draft, patientId: e.target.value || null })}
              >
                <option value="">All patients</option>
                {patients.data?.map((patient) => (
                  <option key={patient.id} value={patient.id}>
                    {patient.name} · {patient.phone}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Series doctor">
              <select
                value={draft.doctorId ?? ''}
                disabled={doctors.loading || !!doctors.error}
                onChange={(e) => setDraft({ ...draft, doctorId: e.target.value || null })}
              >
                <option value="">All doctors</option>
                {doctors.data?.map((doctor) => (
                  <option key={doctor.id} value={doctor.id}>
                    {doctor.name}
                  </option>
                ))}
              </select>
            </Field>
          </form>
          {patients.error && <ErrorState message={patients.error} retry={patients.reload} />}{' '}
          {doctors.error && <ErrorState message={doctors.error} retry={doctors.reload} />}
          <p className="muted small" role="status">
            {list.loading
              ? 'Loading appointment series…'
              : list.error
                ? 'Series count unavailable'
                : `${list.data?.total ?? 0} series in this view`}
          </p>
          {list.loading ? (
            <Loading />
          ) : list.error ? (
            <ErrorState message={list.error} retry={list.reload} />
          ) : list.data && !list.data.items.length ? (
            <Card>
              <EmptyState
                title="No appointment series in this view"
                description="Adjust your filters or preview a fixed set of visits to book together."
              />
            </Card>
          ) : list.data ? (
            <>
              <div className="appointment-series-list">
                {list.data.items.map((row) => (
                  <Card key={row.id} className="appointment-series-row">
                    <div>
                      <h2>{row.patientName}</h2>
                      <p>
                        {row.doctorName} ·{' '}
                        {row.mode === 'online' ? 'Online consultation' : 'In clinic'}
                      </p>
                      <p>
                        {row.count} original visits · {seriesCadence(row.intervalWeeks)} ·{' '}
                        {row.durationMinutes} minutes
                      </p>
                      <p className="muted small">
                        {formatDate(row.firstDate)} – {formatDate(row.lastDate)} · Booked{' '}
                        {seriesStamp(row.createdAt)} IST
                      </p>
                    </div>
                    <div className="appointment-series-actions">
                      <button
                        className="button button-secondary"
                        onClick={() => navigate({ series: row.id })}
                      >
                        View series
                      </button>
                    </div>
                  </Card>
                ))}
              </div>
              <Pagination
                {...list.data}
                label="Appointment series pagination"
                onPageChange={(value) => navigate({ page: value === 1 ? null : String(value) })}
              />
            </>
          ) : null}
        </>
      )}
      {booking === location.key && (
        <AppointmentSeriesModal
          onClose={() => setBooking(null)}
          onSaved={(value) => {
            setBooking(null);
            toast(`${value.series.input.count} recurring visits booked.`);
            navigate({ series: value.series.id });
            void detail.reload();
            void list.reload();
          }}
        />
      )}
      {cancelling === location.key && detail.data && (
        <SeriesCancellationModal
          series={detail.data.series}
          onClose={() => setCancelling(null)}
          onSaved={async (result) => {
            setCancelling(null);
            toast(
              `${result.event.visits.length} ${result.event.visits.length === 1 ? 'visit cancelled' : 'visits cancelled'}.`,
            );
            await detail.reload();
          }}
        />
      )}
    </div>
  );
}
function SeriesDetail({ detail }: { detail: AppointmentSeriesDetail }) {
  const { series, appointments } = detail;
  return (
    <div className="appointment-series-visits">
      <Card>
        <h2>{series.patient.name}</h2>
        <p>
          {series.doctor.name} ·{' '}
          {series.input.mode === 'online' ? 'Online consultation' : 'In clinic'}
        </p>
        <p>
          {series.input.count} original visits · {seriesCadence(series.input.intervalWeeks)} ·{' '}
          {series.durationMinutes} minutes each
        </p>
        <p>
          {formatDate(series.input.firstDate)} –{' '}
          {formatDate(
            seriesDate(series.input.firstDate, series.input.count - 1, series.input.intervalWeeks),
          )}
        </p>
        <p className="muted">
          Booked by {series.createdByName} · {seriesStamp(series.createdAt)} IST
        </p>
        <p>
          Original fee per visit: {money(series.doctor.fee)} · Original total:{' '}
          {money(series.doctor.fee * series.input.count)}
        </p>
        <p className="appointment-series-note">
          <strong>Shared reason: </strong>
          {series.input.reason}
        </p>
        {series.privateNote && (
          <p className="appointment-series-note">
            <strong>Internal booking note: </strong>
            {series.privateNote}
          </p>
        )}
        <p className="notice">
          Every listed date and time was confirmed with the patient when booked. Changes below show
          individual visits. Future scheduled visits may also be selected and reviewed for
          cancellation together. The original booking and internal note remain unchanged; no future
          visits are generated automatically.
        </p>
      </Card>
      {series.bookedAppointments.map((original, index) => {
        const current = appointments[index];
        return (
          <article className="appointment-series-visit" key={original.id}>
            <h3>Visit {index + 1}</h3>
            <Badge
              tone={
                current.status === 'cancelled' || current.status === 'no-show'
                  ? 'neutral'
                  : current.status === 'completed'
                    ? 'green'
                    : 'blue'
              }
            >
              {current.status.replaceAll('-', ' ')}
            </Badge>
            <div className="appointment-series-visit-columns">
              <div>
                <h4>Originally booked</h4>
                <p>
                  {formatDate(original.date)} ·{' '}
                  {visitInterval(original.time, visitMinutes(original))}
                </p>
                <p>{original.doctorName}</p>
                <p>{original.mode === 'online' ? 'Online consultation' : 'In clinic'}</p>
                <p>
                  {visitMinutes(original)} minutes ·{' '}
                  {visitPolicy(original) === 'custom' ? 'Custom length' : 'Default consultation'} ·{' '}
                  {money(original.fee)}
                </p>
              </div>
              <div>
                <h4>Current appointment</h4>
                <p>
                  {formatDate(current.date)} · {visitInterval(current.time, visitMinutes(current))}
                </p>
                <p>{current.doctorName}</p>
                <p>{current.mode === 'online' ? 'Online consultation' : 'In clinic'}</p>
                <p>
                  {visitMinutes(current)} minutes ·{' '}
                  {visitPolicy(current) === 'custom' ? 'Custom length' : 'Default consultation'} ·{' '}
                  {money(current.fee)}
                </p>
              </div>
            </div>
            <div className="appointment-series-actions">
              <Link
                className="button button-secondary"
                to={`/clinic/appointments?date=${current.date}&patientId=${encodeURIComponent(current.patientId)}&doctorId=${encodeURIComponent(current.doctorId)}`}
              >
                Open appointment
              </Link>
            </div>
          </article>
        );
      })}
      <SeriesCancellationHistory series={series} />
    </div>
  );
}
