import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardPlus,
  ImagePlus,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  Send,
  UserPlus,
  Video,
  X,
} from 'lucide-react';
import type {
  Appointment,
  AppointmentStatus,
  CarePlan,
  ClinicSettings,
  Doctor,
  Medication,
  Message,
  Patient,
  PatientRecord,
} from '../../shared/types';
import type { PatientClinicalWorkflows } from '../../shared/clinical';
import type { WaitlistEntry } from '../../shared/waitlist';
import type { PatientDirectoryItem } from '../../shared/record-search';
import { useSearchPage } from '../record-search';
import { Pagination } from '../components/Pagination';
import { ClinicalWorkflowPanel, EncounterAmendments } from './ClinicalWorkflowPanel';
import { DocumentsPanel } from '../components/DocumentsPanel';
import { AppointmentResourcesModal } from '../components/AppointmentResourcesModal';
import { VisitDurationModal } from '../components/VisitDurationModal';
import { AppointmentSeriesModal } from '../components/AppointmentSeriesModal';
import {
  checkedCustomBooking,
  checkedVisitSlots,
  isVisitRequestCollision,
  useVisitData,
  validCustomMinutes,
  visitInterval,
  visitMinutes,
  type CustomVisitAttempt,
} from '../components/visit-duration-helpers';
import { ImageAnnotationModal } from '../components/ImageAnnotations';
import { FollowUpPlanSection } from './FollowUpPages';
import { api, ApiError, formatDate, money, today, useResource, useSession, useToast } from '../lib';
import {
  Avatar,
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  Modal,
  PageHeader,
} from '../components/ui';
import './clinic.css';
import './clinic-search.css';

const statusLabels: Record<AppointmentStatus, string> = {
  scheduled: 'Scheduled',
  'checked-in': 'Checked in',
  'in-consultation': 'In consultation',
  completed: 'Completed',
  cancelled: 'Cancelled',
  'no-show': 'No-show',
};
const statusTones: Record<AppointmentStatus, 'green' | 'amber' | 'red' | 'neutral' | 'blue'> = {
  scheduled: 'neutral',
  'checked-in': 'amber',
  'in-consultation': 'blue',
  completed: 'green',
  cancelled: 'red',
  'no-show': 'neutral',
};
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Please try again.';
function safeQueryDate(value: string | null) {
  return value &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T12:00:00Z`)) &&
    new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value
    ? value
    : today();
}
function shiftDate(date: string, amount: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + amount);
  return d.toISOString().slice(0, 10);
}
function timeLabel(time: string) {
  const [h, m] = time.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}
function FieldValue({ label, value }: { label: string; value?: string }) {
  return (
    <div className="record-field">
      <span>{label}</span>
      <p>{value || 'Not recorded'}</p>
    </div>
  );
}
function Status({ status }: { status: AppointmentStatus }) {
  return <Badge tone={statusTones[status]}>{statusLabels[status]}</Badge>;
}

function queryPage(value: string | null) {
  const parsed = Number(value);
  return value &&
    /^\d+$/.test(value) &&
    Number.isInteger(parsed) &&
    parsed >= 1 &&
    parsed <= 1_000_000
    ? parsed
    : 1;
}
function validDirectoryRow(value: unknown): value is PatientDirectoryItem {
  if (!value || typeof value !== 'object') return false;
  const row = value as PatientDirectoryItem;
  return (
    ['id', 'name', 'phone', 'email', 'gender', 'dob', 'createdAt'].every(
      (key) => typeof row[key as keyof PatientDirectoryItem] === 'string',
    ) &&
    !!row.id &&
    !!row.name.trim() &&
    Number.isFinite(Date.parse(row.createdAt)) &&
    (!row.dob ||
      (/^\d{4}-\d{2}-\d{2}$/.test(row.dob) && Number.isFinite(Date.parse(`${row.dob}T12:00:00Z`))))
  );
}
function validAppointmentRow(value: unknown): value is Appointment {
  if (!value || typeof value !== 'object') return false;
  const row = value as Appointment;
  return (
    [
      'id',
      'patientId',
      'patientName',
      'doctorId',
      'doctorName',
      'reason',
      'date',
      'time',
      'createdAt',
    ].every((key) => typeof row[key as keyof Appointment] === 'string') &&
    !!row.id &&
    !!row.patientId &&
    !!row.doctorId &&
    !!row.patientName.trim() &&
    !!row.doctorName.trim() &&
    /^\d{4}-\d{2}-\d{2}$/.test(row.date) &&
    Number.isFinite(Date.parse(`${row.date}T12:00:00Z`)) &&
    /^([01]\d|2[0-3]):[0-5]\d$/.test(row.time) &&
    typeof row.status === 'string' &&
    Object.hasOwn(statusLabels, row.status) &&
    ['in-person', 'online'].includes(row.mode) &&
    typeof row.fee === 'number' &&
    Number.isFinite(row.fee) &&
    row.fee >= 0 &&
    (row.durationMinutes === undefined ||
      (Number.isInteger(row.durationMinutes) && row.durationMinutes > 0))
  );
}

export function AppointmentsPage() {
  const { session } = useSession();
  const navigate = useNavigate();
  const [seriesBooking, setSeriesBooking] = useState<string | null>(null);
  const clinician = session.user?.role === 'doctor' || session.user?.role === 'admin';
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  useLayoutEffect(() => {
    setSeriesBooking((origin) => (origin === location.key ? origin : null));
  }, [location.key]);
  const date = safeQueryDate(params.get('date'));
  const allDates = params.get('allDates') === '1';
  // Keep the native control responsive while the router commits its transition.
  // A different history entry immediately restores that entry's URL value.
  const [allDatesDraft, setAllDatesDraft] = useState<{
    locationKey: string;
    value: boolean;
  } | null>(null);
  const allDatesChecked =
    allDatesDraft?.locationKey === location.key ? allDatesDraft.value : allDates;
  useEffect(() => {
    setAllDatesDraft(null);
  }, [location.key]);
  const doctorId = params.get('doctorId') || '';
  const patientId = params.get('patientId') || '';
  const requestedStatus = params.get('status') || 'all';
  const filter =
    requestedStatus === 'waiting' || Object.hasOwn(statusLabels, requestedStatus)
      ? requestedStatus
      : 'all';
  const requestedMode = params.get('mode');
  const mode = requestedMode === 'in-person' || requestedMode === 'online' ? requestedMode : 'all';
  const page = queryPage(params.get('page'));
  const query = params.get('search') || '';
  const [search, setSearch] = useState(query);
  const [booking, setBooking] = useState<Appointment | 'new' | null>(
    params.get('new') === '1' ? 'new' : null,
  );
  const [busy, setBusy] = useState('');
  const [pendingCustomBooking, setPendingCustomBooking] = useState<CustomVisitAttempt | null>(null);
  const [moreActions, setMoreActions] = useState<Appointment | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusResults = useRef(false);
  const resourceAppointmentId = params.get('resources');
  const durationAppointmentId = params.get('duration');
  function openDuration(appointmentId: string | null) {
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (appointmentId) next.set('duration', appointmentId);
        else next.delete('duration');
        return next;
      },
      { replace: true },
    );
  }
  function changeFilters(values: Record<string, string | null>) {
    focusResults.current = false;
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.delete('page');
      // Applying another filter also applies text entered before its debounce.
      if (search) next.set('search', search);
      else next.delete('search');
      for (const [key, value] of Object.entries(values)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      return next;
    });
  }
  function setDate(value: string) {
    changeFilters({ date: value, allDates: null });
  }
  function goToPage(nextPage: number) {
    focusResults.current = true;
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (nextPage === 1) next.delete('page');
      else next.set('page', String(nextPage));
      return next;
    });
  }
  const openResources = (appointmentId: string | null) => {
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (appointmentId) next.set('resources', appointmentId);
        else next.delete('resources');
        return next;
      },
      { replace: true },
    );
  };
  useEffect(() => {
    setSearch(query);
  }, [query, location.key]);
  useEffect(() => {
    if (search === query) return;
    const timer = window.setTimeout(() => {
      focusResults.current = false;
      setParams((previous) => {
        const next = new URLSearchParams(previous);
        next.delete('page');
        if (search) next.set('search', search);
        else next.delete('search');
        return next;
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search, query, setParams, location.key]);
  useEffect(() => {
    if (params.get('new') === '1') {
      setBooking('new');
      const next = new URLSearchParams(params);
      next.delete('new');
      setParams(next, { replace: true });
    }
  }, [params, setParams]);
  const request = new URLSearchParams({ page: String(page), pageSize: '25' });
  if (!allDates) {
    request.set('from', date);
    request.set('to', date);
  }
  if (doctorId) request.set('doctorId', doctorId);
  if (patientId) request.set('patientId', patientId);
  if (filter !== 'all') request.set('status', filter);
  if (mode !== 'all') request.set('mode', mode);
  if (query) request.set('q', query);
  const result = useSearchPage<Appointment>(`/api/search/appointments?${request.toString()}`);
  const { data, reload } = result;
  const error =
    result.error ||
    (data &&
    (!data.items.every(validAppointmentRow) ||
      new Set(data.items.map((item) => item.id)).size !== data.items.length)
      ? 'The appointment records could not be confirmed. Refresh to try again.'
      : '');
  const loading = result.loading || search !== query;
  const latestReload = useRef(reload);
  latestReload.current = reload;
  const doctors = useResource<Doctor[]>('/api/doctors');
  const toast = useToast();
  const appointments = !loading && !error ? (data?.items ?? []) : [];
  useEffect(() => {
    if (!loading && !error && data) {
      if (data.page !== page)
        setParams(
          (previous) => {
            const next = new URLSearchParams(previous);
            if (data.page === 1) next.delete('page');
            else next.set('page', String(data.page));
            return next;
          },
          { replace: true },
        );
      if (focusResults.current) {
        focusResults.current = false;
        heading.current?.focus({ preventScroll: true });
      }
    }
  }, [loading, error, data, page, setParams]);
  async function update(appointment: Appointment, status: AppointmentStatus) {
    setBusy(appointment.id);
    try {
      await api(`/api/appointments/${appointment.id}`, { method: 'PATCH', body: { status } });
      toast(`Appointment ${statusLabels[status].toLowerCase()}.`);
      setMoreActions(null);
      void latestReload.current();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy('');
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="CLINIC OPERATIONS"
        title="Appointments"
        description="A clear view of your day, from arrival to follow-up."
        actions={
          <>
            <Link className="button button-secondary" to="/clinic/procedures">
              Procedure appointments
            </Link>
            <Link className="button button-secondary" to="/clinic/appointment-series">
              Appointment series
            </Link>
            <Link className="button button-secondary" to="/clinic/appointment-reminders">
              Appointment reminders
            </Link>
            <button
              className="button button-secondary"
              disabled={!!pendingCustomBooking}
              onClick={() => setSeriesBooking(location.key)}
            >
              Book recurring visits
            </button>
            <button
              className="button button-primary"
              disabled={!!pendingCustomBooking}
              onClick={() => setBooking('new')}
            >
              <Plus size={17} /> New appointment
            </button>
          </>
        }
      />
      {pendingCustomBooking && !booking && (
        <div className="notice visit-duration-pending">
          <div>
            <strong>A custom booking is awaiting confirmation.</strong>
            <p>
              The exact request is retained while this page stays open. Resume it before booking
              another visit.
            </p>
          </div>
          <button className="button button-secondary" onClick={() => setBooking('new')}>
            Resume custom booking
          </button>
        </div>
      )}
      <div className="clinic-toolbar clinic-search-toolbar">
        <div className="row date-navigator">
          <button
            className="button button-ghost button-small"
            aria-label="Previous day"
            onClick={() => setDate(shiftDate(date, -1))}
          >
            <ChevronLeft size={18} />
          </button>
          <input
            aria-label="Appointment date"
            type="date"
            value={date}
            onChange={(e) => e.target.value && setDate(e.target.value)}
          />
          <button
            className="button button-ghost button-small"
            aria-label="Next day"
            onClick={() => setDate(shiftDate(date, 1))}
          >
            <ChevronRight size={18} />
          </button>
          <button className="button button-secondary button-small" onClick={() => setDate(today())}>
            Today
          </button>
        </div>
        <select
          aria-label="Filter by doctor"
          value={doctorId}
          onChange={(e) => changeFilters({ doctorId: e.target.value || null })}
        >
          <option value="">All doctors</option>
          {doctorId && doctors.data && !doctors.data.some((doctor) => doctor.id === doctorId) && (
            <option value={doctorId}>Selected doctor is unavailable</option>
          )}
          {doctors.data?.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </div>
      <div className="clinic-search-controls">
        <Field
          label="Search appointments"
          hint="Find appointments by patient name, email, phone or patient ID."
        >
          <input
            type="search"
            maxLength={200}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Patient name, email or phone"
          />
        </Field>
        <Field label="Appointment status">
          <select
            value={filter}
            onChange={(event) =>
              changeFilters({ status: event.target.value === 'all' ? null : event.target.value })
            }
          >
            <option value="all">All statuses</option>
            <option value="waiting">Waiting</option>
            {Object.entries(statusLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Consultation mode">
          <select
            value={mode}
            onChange={(event) =>
              changeFilters({ mode: event.target.value === 'all' ? null : event.target.value })
            }
          >
            <option value="all">All modes</option>
            <option value="in-person">In clinic</option>
            <option value="online">Online</option>
          </select>
        </Field>
      </div>
      <div className="clinic-search-options">
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={allDatesChecked}
            onChange={(event) => {
              const checked = event.target.checked;
              setAllDatesDraft({ locationKey: location.key, value: checked });
              changeFilters({ allDates: checked ? '1' : null });
            }}
          />
          All dates
        </label>
        <p className="muted small">
          {allDates
            ? 'Searching across appointment dates. Choose a day to return to its schedule.'
            : 'Showing the selected day. Enable All dates to search earlier or future appointments.'}
        </p>
        <button
          className="button button-secondary button-small"
          disabled={loading}
          onClick={reload}
        >
          <RefreshCw size={14} />
          Refresh appointments
        </button>
      </div>
      {patientId && (
        <div className="notice clinic-patient-filter">
          <span>Showing appointments for one patient.</span>
          <button
            className="button button-secondary button-small"
            onClick={() => changeFilters({ patientId: null })}
          >
            Clear patient filter
          </button>
        </div>
      )}
      {doctors.error && <ErrorState message={doctors.error} retry={doctors.reload} />}
      <Card className="appointments-panel">
        <div className="clinic-panel-heading">
          <div>
            <h2 className="section-title" tabIndex={-1} ref={heading}>
              {allDates
                ? 'Appointments across all dates'
                : date === today()
                  ? 'Today’s schedule'
                  : formatDate(date)}
            </h2>
            <p className="muted">
              {loading
                ? 'Loading appointments…'
                : error
                  ? 'Appointment count unavailable'
                  : `${data?.total ?? 0} matching ${(data?.total ?? 0) === 1 ? 'appointment' : 'appointments'}`}{' '}
              · All times in India Standard Time
            </p>
          </div>
          <div
            className="segmented clinic-search-shortcuts"
            role="group"
            aria-label="Quick appointment status filters"
          >
            {[
              ['all', 'All'],
              ['waiting', 'Waiting'],
              ['completed', 'Completed'],
            ].map(([v, label]) => (
              <button
                key={v}
                className={filter === v ? 'active' : ''}
                aria-pressed={filter === v}
                onClick={() => changeFilters({ status: v === 'all' ? null : v })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {loading ? (
          <Loading />
        ) : error ? (
          <ErrorState message={error} retry={reload} />
        ) : appointments.length === 0 ? (
          <EmptyState
            title={
              search || filter !== 'all' || doctorId || mode !== 'all' || allDates || patientId
                ? 'No matching appointments'
                : 'Your schedule is clear'
            }
            description="There are no appointments matching this view."
            action={
              <button
                className="button button-secondary"
                disabled={!!pendingCustomBooking}
                onClick={() => setBooking('new')}
              >
                <Plus size={16} /> Book an appointment
              </button>
            }
          />
        ) : (
          <div
            className="table-wrap clinic-search-table"
            role="region"
            aria-label="Appointments; scroll horizontally for all columns"
            tabIndex={0}
          >
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">{allDates ? 'Date & time' : 'Time'}</th>
                  <th>Patient</th>
                  <th>Consultation</th>
                  <th>Status</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {appointments.map((a) => (
                  <tr key={a.id}>
                    <td>
                      {allDates && (
                        <span className="table-sub clinic-result-date">{formatDate(a.date)}</span>
                      )}
                      <strong className="time-text">{timeLabel(a.time)}</strong>
                      <span className="table-sub">{a.durationMinutes ?? 30} min</span>
                      {a.durationPolicy === 'custom' && (
                        <span className="table-sub">Custom length</span>
                      )}
                    </td>
                    <td>
                      <div className="row">
                        <Avatar name={a.patientName} size="sm" />
                        <div>
                          {clinician ? (
                            <Link className="table-name" to={`/clinic/patients/${a.patientId}`}>
                              {a.patientName}
                            </Link>
                          ) : (
                            <strong>{a.patientName}</strong>
                          )}
                          <span className="table-sub">{a.reason}</span>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="row">
                        {a.mode === 'online' ? <Video size={14} /> : <CalendarDays size={14} />}
                        {a.mode === 'online' ? 'Online' : 'In clinic'}
                      </span>
                      <span className="table-sub">{a.doctorName}</span>
                    </td>
                    <td>
                      <Status status={a.status} />
                    </td>
                    <td>
                      <div className="clinic-appointment-actions">
                        <Link
                          className="button button-secondary button-small"
                          to={`/clinic/appointment-reminders?appointment=${encodeURIComponent(a.id)}`}
                        >
                          Reminder history
                        </Link>
                        <button
                          className="button button-secondary button-small"
                          onClick={() => openDuration(a.id)}
                        >
                          {a.status === 'scheduled' &&
                          Date.parse(`${a.date}T${a.time}:00+05:30`) > Date.now()
                            ? 'Change visit length'
                            : 'Visit length history'}
                        </button>
                        <button
                          className="button button-secondary button-small"
                          aria-label={`Resources for ${a.patientName}`}
                          onClick={() => openResources(a.id)}
                        >
                          Resources
                        </button>
                        {a.status === 'scheduled' && a.date <= today() && (
                          <button
                            disabled={busy === a.id}
                            className="button button-secondary button-small"
                            onClick={() => update(a, 'checked-in')}
                          >
                            Check in
                          </button>
                        )}
                        {a.status === 'checked-in' && clinician && (
                          <button
                            disabled={busy === a.id}
                            className="button button-primary button-small"
                            onClick={() => update(a, 'in-consultation')}
                          >
                            Start visit
                          </button>
                        )}
                        {a.status === 'in-consultation' && clinician && (
                          <button
                            disabled={busy === a.id}
                            className="button button-primary button-small"
                            onClick={() => update(a, 'completed')}
                          >
                            <Check size={14} /> Complete
                          </button>
                        )}
                        {a.status === 'scheduled' && (
                          <button
                            className="button button-ghost button-small"
                            aria-label={`More actions for ${a.patientName}`}
                            onClick={() => setMoreActions(a)}
                          >
                            •••
                          </button>
                        )}
                        {a.status === 'completed' && clinician && (
                          <Link
                            className="button button-ghost button-small"
                            to={`/clinic/patients/${a.patientId}`}
                          >
                            View record <ArrowRight size={14} />
                          </Link>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!loading && !error && data && (
          <Pagination
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            totalPages={data.totalPages}
            onPageChange={goToPage}
            label="Appointment pagination"
          />
        )}
      </Card>
      {durationAppointmentId && (
        <VisitDurationModal
          key={durationAppointmentId}
          appointmentId={durationAppointmentId}
          onClose={() => openDuration(null)}
          onSaved={async () => {
            await latestReload.current();
          }}
        />
      )}
      {resourceAppointmentId && (
        <AppointmentResourcesModal
          key={resourceAppointmentId}
          appointmentId={resourceAppointmentId}
          onClose={() => openResources(null)}
          onSaved={async () => {
            await reload();
          }}
        />
      )}
      {moreActions && (
        <Modal title="Appointment actions" onClose={() => setMoreActions(null)}>
          <div className="stack">
            <div>
              <strong>{moreActions.patientName}</strong>
              <p className="muted">
                {formatDate(moreActions.date)} · {timeLabel(moreActions.time)} ·{' '}
                {moreActions.doctorName}
              </p>
              <p>{moreActions.reason}</p>
            </div>
            <button
              className="button button-secondary"
              disabled={!!pendingCustomBooking}
              onClick={() => {
                setBooking(moreActions);
                setMoreActions(null);
              }}
            >
              Reschedule appointment
            </button>
            <a
              className="button button-secondary"
              href={`/api/appointments/${moreActions.id}/calendar`}
              download
            >
              Download calendar event
            </a>
            {moreActions.date <= today() && (
              <button
                className="button button-secondary"
                disabled={busy === moreActions.id}
                onClick={() => update(moreActions, 'no-show')}
              >
                Mark no-show
              </button>
            )}
            <button
              className="button button-danger"
              disabled={busy === moreActions.id}
              onClick={() => update(moreActions, 'cancelled')}
            >
              Cancel appointment
            </button>
          </div>
        </Modal>
      )}
      {booking && (
        <ClinicBookingModal
          initialDate={date}
          appointment={booking === 'new' ? undefined : booking}
          doctors={doctors.data || []}
          pendingCustomBooking={pendingCustomBooking}
          onPendingCustomBookingChange={setPendingCustomBooking}
          onClose={() => setBooking(null)}
          onSaved={(savedDate) => {
            setBooking(null);
            setSearch('');
            changeFilters({
              date: savedDate,
              allDates: null,
              search: null,
              doctorId: null,
              status: null,
              mode: null,
              patientId: null,
            });
            void latestReload.current();
          }}
        />
      )}
      {seriesBooking === location.key && (
        <AppointmentSeriesModal
          initialDate={date}
          onClose={() => setSeriesBooking(null)}
          onSaved={(detail) => {
            setSeriesBooking(null);
            toast(`${detail.series.input.count} recurring visits booked.`);
            navigate(`/clinic/appointment-series?series=${encodeURIComponent(detail.series.id)}`);
          }}
        />
      )}
    </>
  );
}

export function ClinicBookingModal({
  initialDate,
  appointment,
  waitlist,
  doctors,
  onClose,
  onSaved,
  pendingCustomBooking,
  onPendingCustomBookingChange,
}: {
  initialDate: string;
  appointment?: Appointment;
  waitlist?: WaitlistEntry;
  doctors: Doctor[];
  onClose: () => void;
  onSaved: (savedDate: string) => void;
  pendingCustomBooking?: CustomVisitAttempt | null;
  onPendingCustomBookingChange?: (attempt: CustomVisitAttempt | null) => void;
}) {
  const { session } = useSession();
  const location = useLocation();
  const mounted = useRef(false),
    currentLocation = useRef(location.key);
  currentLocation.current = location.key;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [attempt, setAttempt] = useState<CustomVisitAttempt | null>(pendingCustomBooking ?? null);
  const [uncertain, setUncertain] = useState(!!pendingCustomBooking);
  const [lengthPolicy, setLengthPolicy] = useState<'schedule' | 'custom'>(
    pendingCustomBooking ? 'custom' : 'schedule',
  );
  const [customMinutes, setCustomMinutes] = useState(
    String(pendingCustomBooking?.body.durationMinutes ?? 60),
  );
  const customBooking = !appointment && !waitlist && lengthPolicy === 'custom';
  const [patientId, setPatientId] = useState(
    pendingCustomBooking?.body.patientId || waitlist?.patientId || appointment?.patientId || '',
  );
  const [doctorId, setDoctorId] = useState(
    pendingCustomBooking?.body.doctorId ||
      waitlist?.doctorId ||
      appointment?.doctorId ||
      doctors[0]?.id ||
      '',
  );
  const minimumDate = waitlist && waitlist.startDate > today() ? waitlist.startDate : today();
  const [date, setDate] = useState(
    pendingCustomBooking?.body.date || (initialDate < minimumDate ? minimumDate : initialDate),
  );
  const [time, setTime] = useState(pendingCustomBooking?.body.time ?? '');
  const [mode, setMode] = useState<'in-person' | 'online'>(
    pendingCustomBooking?.body.mode || waitlist?.mode || appointment?.mode || 'in-person',
  );
  const [reason, setReason] = useState(
    pendingCustomBooking?.body.reason || waitlist?.reason || appointment?.reason || '',
  );
  const [patientConfirmed, setPatientConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const locked = saving || uncertain;
  const patients = useResource<Patient[]>('/api/patients');
  const customQuery = new URLSearchParams({
    doctorId,
    patientId,
    date,
    mode,
    durationPolicy: 'custom',
    durationMinutes: customMinutes,
  });
  const slots = useVisitData(
    doctorId && date && (!waitlist || (date >= minimumDate && date <= waitlist.endDate))
      ? customBooking
        ? patientId && validCustomMinutes(Number(customMinutes))
          ? `/api/visit-duration/slots?${customQuery}`
          : null
        : `/api/slots?doctorId=${encodeURIComponent(doctorId)}&date=${date}&mode=${mode}${appointment ? `&excludeAppointmentId=${encodeURIComponent(appointment.id)}` : ''}`
      : null,
    checkedVisitSlots,
  );
  const duration =
    appointment?.durationPolicy === 'custom'
      ? visitMinutes(appointment)
      : customBooking
        ? Number(customMinutes)
        : (doctors.find((d) => d.id === doctorId)?.appointmentDurationMinutes ?? 30);
  const toast = useToast();
  useEffect(() => {
    if (!attempt) setTime('');
  }, [date, doctorId, mode, patientId, lengthPolicy, customMinutes]);
  useEffect(() => {
    setPatientConfirmed(false);
  }, [date, doctorId, mode, time]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    if (!time) return setError('Choose an available appointment time.');
    if (!attempt && (slots.loading || slots.error || !slots.data?.includes(time)))
      return setError('Choose a currently available appointment time.');
    if (waitlist && !patientConfirmed)
      return setError('Confirm this specific appointment with the patient before booking.');
    setSaving(true);
    setError('');
    const submittingLocation = location.key;
    let sent = attempt;
    try {
      if (customBooking) {
        if (!session.user || !validCustomMinutes(duration))
          throw new Error('Enter a custom length from 15 to 240 minutes in 5-minute steps.');
        sent = sent ?? {
          actorId: session.user.id,
          body: {
            patientId,
            doctorId,
            date,
            time,
            mode,
            reason: reason.trim(),
            durationMinutes: duration,
            requestId: crypto.randomUUID(),
          },
        };
        setAttempt(sent);
        onPendingCustomBookingChange?.(sent);
        const result = checkedCustomBooking(
          await api<unknown>('/api/visit-duration/bookings', { method: 'POST', body: sent.body }),
          sent,
        );
        if (!mounted.current) return;
        if (currentLocation.current !== submittingLocation) {
          setUncertain(true);
          setError(
            'The page changed before confirmation was displayed. Retry the same request to confirm the booking.',
          );
          return;
        }
        setAttempt(null);
        setUncertain(false);
        onPendingCustomBookingChange?.(null);
        toast('Custom visit booking confirmed.');
        onSaved(result.appointment.date);
        return;
      }
      await api(appointment ? `/api/appointments/${appointment.id}` : '/api/appointments', {
        method: appointment ? 'PATCH' : 'POST',
        body: appointment
          ? { doctorId, date, time }
          : {
              patientId,
              doctorId,
              date,
              time,
              mode,
              reason,
              ...(waitlist ? { waitlistId: waitlist.id, patientConfirmed } : {}),
            },
      });
      if (!mounted.current || currentLocation.current !== submittingLocation) return;
      toast(appointment ? 'Appointment rescheduled.' : 'Appointment booked.');
      onSaved(date);
    } catch (e) {
      if (!mounted.current) return;
      setError(errorText(e));
      if (customBooking && sent) {
        const known =
          !uncertain &&
          !isVisitRequestCollision(e) &&
          e instanceof ApiError &&
          [400, 401, 403, 404, 409].includes(e.status);
        if (!known) {
          setAttempt(sent);
          setUncertain(true);
          onPendingCustomBookingChange?.(sent);
          return;
        }
        setAttempt(null);
        setUncertain(false);
        onPendingCustomBookingChange?.(null);
      }
      setTime('');
      setPatientConfirmed(false);
      slots.reload();
    } finally {
      if (mounted.current) setSaving(false);
    }
  }
  return (
    <Modal
      title={
        waitlist
          ? 'Book a confirmed waitlist visit'
          : appointment
            ? 'Reschedule appointment'
            : 'New appointment'
      }
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <form className="stack" onSubmit={submit}>
        {uncertain && (
          <div className="notice notice-warning">
            <strong>The save outcome could not be confirmed.</strong>
            <p>
              The exact custom booking is retained and locked. Retry the same request before making
              another booking. Closing for now retains it while the appointments page stays open.
            </p>
          </div>
        )}
        {error && (
          <div className="notice notice-error" role="alert">
            {error}
          </div>
        )}
        <p className="notice">
          Consultation fee:{' '}
          {doctors.find((doctor) => doctor.id === doctorId)
            ? money(doctors.find((doctor) => doctor.id === doctorId)!.fee)
            : 'Not available'}
          .
          {appointment
            ? ' Rescheduling uses the selected clinician’s current fee.'
            : ' Payment is recorded separately.'}
        </p>
        {waitlist && (
          <div className="notice">
            <span>
              <strong>
                Requested window: {formatDate(waitlist.startDate)} – {formatDate(waitlist.endDate)}
              </strong>
              <br />
              {waitlist.doctorName} ·{' '}
              {waitlist.mode === 'online' ? 'Online consultation' : 'In clinic'}. Contact{' '}
              {waitlist.patientName}
              {waitlist.patientPhone ? ` at ${waitlist.patientPhone}` : ''} and confirm the selected
              slot before booking. This request does not hold a slot.
            </span>
          </div>
        )}
        {patients.error && <ErrorState message={patients.error} retry={patients.reload} />}
        <Field label="Patient">
          <select
            required
            disabled={!!appointment || !!waitlist || locked}
            value={patientId}
            onChange={(e) => setPatientId(e.target.value)}
          >
            <option value="">Select a patient</option>
            {patients.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.phone}
              </option>
            ))}
          </select>
        </Field>
        <div className="form-grid">
          <Field label="Doctor">
            <select
              required
              disabled={!!waitlist || locked}
              value={doctorId}
              onChange={(e) => setDoctorId(e.target.value)}
            >
              <option value="">Select a doctor</option>
              {doctors.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Date">
            <input
              required
              type="date"
              min={minimumDate}
              max={waitlist?.endDate}
              disabled={locked}
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </Field>
        </div>
        {!appointment && (
          <Field label="Consultation mode">
            <select
              disabled={!!waitlist || locked}
              value={mode}
              onChange={(e) => setMode(e.target.value as typeof mode)}
            >
              <option value="in-person">In clinic</option>
              <option value="online">Online consultation</option>
            </select>
          </Field>
        )}
        {!appointment && !waitlist && (
          <div className="form-grid">
            <Field label="Visit length">
              <select
                value={lengthPolicy}
                disabled={locked}
                onChange={(event) => setLengthPolicy(event.target.value as 'schedule' | 'custom')}
              >
                <option value="schedule">Default consultation</option>
                <option value="custom">Custom length</option>
              </select>
            </Field>
            {customBooking && (
              <Field label="Custom duration (minutes)" hint="15–240 minutes, in 5-minute steps.">
                <input
                  type="number"
                  min={15}
                  max={240}
                  step={5}
                  required
                  value={customMinutes}
                  disabled={locked}
                  onChange={(event) => setCustomMinutes(event.target.value)}
                />
              </Field>
            )}
          </div>
        )}
        <p className="muted small">
          {duration}-minute {mode === 'online' ? 'online' : 'in-clinic'} appointment
          {appointment
            ? appointment.durationPolicy === 'custom'
              ? ' · This custom visit keeps its saved length when rescheduled. Use Change visit length for a separate length change.'
              : ' · Rescheduling uses the doctor’s current appointment length.'
            : ''}
        </p>
        {time && validCustomMinutes(duration) && (
          <div className="notice visit-duration-preview">
            <strong>
              {formatDate(date)} · {visitInterval(time, duration)} · {duration} minutes
            </strong>
            <p>
              Visit fee:{' '}
              {doctors.find((doctor) => doctor.id === doctorId)
                ? money(doctors.find((doctor) => doctor.id === doctorId)!.fee)
                : 'Not available'}
              . Length does not multiply the fee or create an invoice.
            </p>
          </div>
        )}
        <p className="muted small">
          {appointment
            ? 'Assigned rooms and equipment move with this visit. Available times include those reservations.'
            : 'Book the visit first, then use Resources to reserve any room or equipment it needs.'}
        </p>
        <Field label="Available times · IST">
          {slots.loading ? (
            <p className="muted">Checking availability…</p>
          ) : slots.error ? (
            <ErrorState message={slots.error} retry={slots.reload} />
          ) : (
            <div className="slot-grid">
              {slots.data?.length ? (
                slots.data.map((slot) => (
                  <button
                    key={slot}
                    type="button"
                    className={`clinic-time-slot ${time === slot ? 'selected' : ''}`}
                    aria-pressed={time === slot}
                    disabled={locked}
                    onClick={() => setTime(slot)}
                  >
                    {timeLabel(slot)}
                  </button>
                ))
              ) : (
                <p className="muted">
                  {waitlist
                    ? 'No available slots for this day in the requested window. Choose another date within the request.'
                    : 'No available slots. Choose another date or doctor.'}
                </p>
              )}
            </div>
          )}
        </Field>
        {!appointment && (
          <>
            <Field label="Reason for visit">
              <textarea
                required
                maxLength={300}
                rows={3}
                value={reason}
                disabled={locked}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Briefly describe the reason for the appointment"
              />
            </Field>
          </>
        )}
        {waitlist && (
          <label className="checkbox-field">
            <input
              type="checkbox"
              required
              checked={patientConfirmed}
              disabled={!time || saving}
              onChange={(event) => setPatientConfirmed(event.target.checked)}
            />
            <span>
              I have confirmed this specific date, time, doctor, and consultation mode with the
              patient.
            </span>
          </label>
        )}
        <div className="modal-actions">
          <button
            className="button button-secondary"
            type="button"
            disabled={saving}
            onClick={onClose}
          >
            {uncertain ? 'Close for now' : 'Cancel'}
          </button>
          <button
            className="button button-primary"
            disabled={
              saving ||
              (!uncertain && (slots.loading || !!slots.error)) ||
              !time ||
              !patientId ||
              (!!waitlist && !patientConfirmed)
            }
          >
            {saving
              ? 'Saving…'
              : uncertain
                ? 'Retry same request'
                : appointment
                  ? 'Save new time'
                  : waitlist
                    ? 'Book confirmed visit'
                    : 'Book appointment'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function PatientsPage() {
  const { session } = useSession();
  const clinical = session.user?.role !== 'receptionist';
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const query = params.get('search') || '';
  const page = queryPage(params.get('page'));
  const [search, setSearch] = useState(query);
  const [adding, setAdding] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusResults = useRef(false);
  useEffect(() => {
    setSearch(query);
  }, [query, location.key]);
  useEffect(() => {
    if (search === query) return;
    const timer = window.setTimeout(() => {
      focusResults.current = false;
      setParams((previous) => {
        const next = new URLSearchParams(previous);
        next.delete('page');
        if (search) next.set('search', search);
        else next.delete('search');
        return next;
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search, query, setParams, location.key]);
  const request = new URLSearchParams({ page: String(page), pageSize: '25' });
  if (query) request.set('q', query);
  const result = useSearchPage<PatientDirectoryItem>(`/api/search/patients?${request.toString()}`);
  const { data, reload } = result;
  const loading = result.loading || search !== query;
  const error =
    result.error ||
    (data &&
    (!data.items.every(validDirectoryRow) ||
      new Set(data.items.map((item) => item.id)).size !== data.items.length)
      ? 'The patient directory records could not be confirmed. Refresh to try again.'
      : '');
  useEffect(() => {
    if (!loading && !error && data) {
      if (data.page !== page)
        setParams(
          (previous) => {
            const next = new URLSearchParams(previous);
            if (data.page === 1) next.delete('page');
            else next.set('page', String(data.page));
            return next;
          },
          { replace: true },
        );
      if (focusResults.current) {
        focusResults.current = false;
        heading.current?.focus({ preventScroll: true });
      }
    }
  }, [loading, error, data, page, setParams]);
  function goToPage(nextPage: number) {
    focusResults.current = true;
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (nextPage === 1) next.delete('page');
      else next.set('page', String(nextPage));
      return next;
    });
  }
  return (
    <>
      <PageHeader
        eyebrow="YOUR PRACTICE"
        title="Patients"
        description="Every patient. One continuous care journey."
        actions={
          <button className="button button-primary" onClick={() => setAdding(true)}>
            <UserPlus size={17} />
            Add patient
          </button>
        }
      />
      <Card>
        <div className="clinic-panel-heading clinic-directory-heading">
          <div>
            <h2 className="section-title" tabIndex={-1} ref={heading}>
              Patient directory
            </h2>
            <p className="muted">
              {loading
                ? 'Loading patients…'
                : error
                  ? 'Patient count unavailable'
                  : `${data?.total ?? 0} ${query ? 'matching' : 'registered'} ${(data?.total ?? 0) === 1 ? 'patient' : 'patients'}`}
            </p>
          </div>
          <div className="clinic-search-field">
            <Search size={17} />
            <input
              type="search"
              value={search}
              maxLength={200}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search name, email or phone"
              aria-label="Search patient directory"
            />
          </div>
          <button
            className="button button-secondary button-small"
            disabled={loading}
            onClick={reload}
          >
            <RefreshCw size={14} />
            Refresh patients
          </button>
        </div>
        {loading ? (
          <Loading />
        ) : error ? (
          <ErrorState message={error} retry={reload} />
        ) : !data?.items.length ? (
          <EmptyState
            title={query ? 'No matching patients' : 'A fresh start for your practice'}
            description={
              query
                ? 'Try a different name, phone number or email.'
                : 'Register your first patient to start their care journey.'
            }
          />
        ) : (
          <div
            className="table-wrap clinic-search-table"
            role="region"
            aria-label="Patient directory; scroll horizontally for all columns"
            tabIndex={0}
          >
            <table className="data-table">
              <thead>
                <tr>
                  <th>Patient</th>
                  <th>Contact</th>
                  <th>Date of birth</th>
                  <th>Registered</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <div className="row">
                        <Avatar name={p.name} />
                        <div>
                          {clinical ? (
                            <Link className="table-name" to={`/clinic/patients/${p.id}`}>
                              {p.name}
                            </Link>
                          ) : (
                            <strong>{p.name}</strong>
                          )}
                          <span className="table-sub">{p.gender || 'Not specified'}</span>
                        </div>
                      </div>
                    </td>
                    <td>
                      {p.phone || '—'}
                      <span className="table-sub">{p.email || 'No email recorded'}</span>
                    </td>
                    <td>{p.dob ? formatDate(p.dob) : 'Not recorded'}</td>
                    <td>{formatDate(p.createdAt)}</td>
                    <td>
                      <Link
                        className="button button-secondary button-small"
                        to={`/clinic/patients/${p.id}/details`}
                      >
                        Patient details
                      </Link>
                      {clinical ? (
                        <Link
                          className="button button-ghost button-small"
                          to={`/clinic/patients/${p.id}`}
                        >
                          Open record <ArrowRight size={15} />
                        </Link>
                      ) : (
                        <Badge tone="neutral">Demographics only</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!loading && !error && data && (
          <Pagination
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            totalPages={data.totalPages}
            onPageChange={goToPage}
            label="Patient directory pagination"
          />
        )}
      </Card>
      {adding && (
        <PatientModal
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            setSearch('');
            focusResults.current = false;
            setParams((previous) => {
              const next = new URLSearchParams(previous);
              next.delete('search');
              next.delete('page');
              return next;
            });
            void reload();
          }}
        />
      )}
    </>
  );
}

function PatientModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { session } = useSession();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError('');
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await api('/api/patients', {
        method: 'POST',
        body: { ...values, allergies: values.allergies || '' },
      });
      toast('Patient registered.');
      onSaved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal title="Register a patient" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {error && (
          <div className="notice notice-error" role="alert">
            {error}
          </div>
        )}
        <Field label="Full name">
          <input name="name" required maxLength={120} autoComplete="name" />
        </Field>
        <div className="form-grid">
          <Field label="Phone number">
            <input name="phone" type="tel" required maxLength={20} placeholder="+91 98765 43210" />
          </Field>
          <Field label="Email address">
            <input name="email" type="email" maxLength={254} placeholder="Optional" />
          </Field>
        </div>
        <div className="form-grid">
          <Field label="Date of birth">
            <input name="dob" type="date" max={today()} />
          </Field>
          <Field label="Gender">
            <select name="gender" defaultValue="Not specified">
              <option>Not specified</option>
              <option>Female</option>
              <option>Male</option>
              <option>Other</option>
            </select>
          </Field>
        </div>
        {session.user?.role !== 'receptionist' && (
          <Field label="Known allergies">
            <textarea
              name="allergies"
              rows={2}
              maxLength={2000}
              placeholder="Record patient-reported allergies, or leave blank if unknown"
            />
          </Field>
        )}
        <p className="muted small">
          Registering here creates a clinic record. It does not create a patient sign-in account.
        </p>
        <div className="modal-actions">
          <button className="button button-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="button button-primary" disabled={saving}>
            {saving ? 'Registering…' : 'Register patient'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

type RecordTab = 'overview' | 'visits' | 'care' | 'workup' | 'images' | 'reports' | 'messages';
export function PatientDetailPage() {
  const { id } = useParams();
  const { data, loading, error, reload } = useResource<PatientRecord>(
    id ? `/api/patients/${id}` : null,
  );
  const clinical = useResource<PatientClinicalWorkflows>(
    id ? `/api/patients/${id}/clinical-workflows` : null,
  );
  const settings = useResource<ClinicSettings>('/api/settings');
  const [recordParams, setRecordParams] = useSearchParams();
  const requestedTab = recordParams.get('tab');
  const validTabs: RecordTab[] = [
    'overview',
    'visits',
    'care',
    'workup',
    'images',
    'reports',
    'messages',
  ];
  const tab: RecordTab = validTabs.includes(requestedTab as RecordTab)
    ? (requestedTab as RecordTab)
    : 'overview';
  const selectedPlan = recordParams.get('plan');
  function setTab(value: RecordTab) {
    setRecordParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.set('tab', value);
        if (value !== 'care') next.delete('plan');
        if (value !== 'images') next.delete('image');
        if (value !== 'workup') {
          next.delete('investigation');
          next.delete('result');
        }
        return next;
      },
      { replace: true },
    );
  }
  const [modal, setModal] = useState<'visit' | 'care' | 'image' | null>(null);
  const [selectedImages, setSelectedImages] = useState<string[]>([]);
  useEffect(() => {
    setSelectedImages([]);
    setModal(null);
  }, [id]);
  useEffect(() => {
    if (tab !== 'care' || !selectedPlan || loading) return;
    const frame = window.requestAnimationFrame(() =>
      document.getElementById(`care-plan-${selectedPlan}`)?.scrollIntoView({ block: 'start' }),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [tab, selectedPlan, loading]);
  const imagesEnabled = settings.data?.modules.images !== false;
  function openAnnotations(imageId: string | null) {
    setRecordParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.set('tab', 'images');
        if (imageId) next.set('image', imageId);
        else next.delete('image');
        return next;
      },
      { replace: true },
    );
  }
  if (loading) return <Loading />;
  if (error) return <ErrorState message={error} retry={reload} />;
  if (!data) return <EmptyState title="Patient not found" />;
  const { patient } = data;
  const annotationImage =
    tab === 'images'
      ? data.images.find((image) => image.id === recordParams.get('image'))
      : undefined;
  const activePlans = data.carePlans.filter((p) => (p.effectiveStatus ?? p.status) === 'active');
  const tabs: [RecordTab, string][] = [
    ['overview', 'Overview'],
    ['visits', `Visits (${data.encounters.length})`],
    ['care', 'Care plans'],
    ['workup', 'Clinical workup'],
    ['images', 'Images & reports'],
    ['reports', 'PDF reports'],
    ['messages', 'Messages'],
  ];
  const newestIntake = [...data.intakes].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return (
    <>
      <Link className="back-link" to="/clinic/patients">
        <ArrowLeft size={15} /> All patients
      </Link>
      <PageHeader
        title={patient.name}
        description="Longitudinal patient record"
        actions={
          <>
            <Link className="button button-secondary" to={`/clinic/patients/${patient.id}/details`}>
              Patient details
            </Link>
            <Link className="button button-secondary" to={`/clinic/patients/${patient.id}/summary`}>
              Care summary
            </Link>
            <button className="button button-secondary" onClick={() => setModal('care')}>
              <Plus size={16} /> Care plan
            </button>
            <button className="button button-primary" onClick={() => setModal('visit')}>
              <ClipboardPlus size={16} /> Add visit note
            </button>
          </>
        }
      />
      <div className="patient-summary">
        <Avatar name={patient.name} size="lg" />
        <div>
          <strong>{patient.name}</strong>
          <span className="table-sub">
            {patient.gender || 'Gender not specified'}
            {patient.dob ? ` · Born ${formatDate(patient.dob)}` : ''}
          </span>
        </div>
        <div className="summary-divider" />
        <div>
          <span className="table-sub">Contact</span>
          <strong>{patient.phone || 'Not recorded'}</strong>
          <span className="table-sub">{patient.email}</span>
        </div>
        <div className="summary-divider" />
        <div>
          <span className="table-sub">Known allergies</span>
          <strong className={patient.allergies ? 'allergy-text' : ''}>
            {patient.allergyStatus === 'none-known'
              ? 'No known allergies recorded'
              : patient.allergies || 'Not recorded — confirm with patient'}
          </strong>
        </div>
        <div className="patient-summary-end">
          <Badge tone={activePlans.length ? 'green' : 'neutral'}>
            {activePlans.length
              ? `${activePlans.length} active care plan${activePlans.length > 1 ? 's' : ''}`
              : 'No active care plan'}
          </Badge>
        </div>
      </div>
      <div className="tabs record-tabs" role="tablist" aria-label="Patient record sections">
        {tabs.map(([value, label]) => (
          <button
            key={value}
            role="tab"
            aria-selected={tab === value}
            className={tab === value ? 'active' : ''}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'overview' && (
        <div className="grid-2 record-overview">
          <div className="stack">
            <Card>
              <div className="clinic-panel-heading">
                <h2 className="section-title">Patient-reported intake</h2>
                <Badge tone="neutral">Unverified history</Badge>
              </div>
              {newestIntake ? (
                <>
                  <p className="muted small">Submitted {formatDate(newestIntake.createdAt)}</p>
                  <FieldValue label="Primary concern" value={newestIntake.concern} />
                  <div className="form-grid">
                    <FieldValue label="Area affected" value={newestIntake.location} />
                    <FieldValue label="Duration" value={newestIntake.duration} />
                  </div>
                  <FieldValue label="Symptoms" value={newestIntake.symptoms} />
                  <FieldValue label="Triggers / patterns" value={newestIntake.triggers} />
                  <FieldValue label="Previous treatment" value={newestIntake.previousTreatment} />
                  <FieldValue label="Current medications" value={newestIntake.medications} />
                  <FieldValue label="Patient goals" value={newestIntake.goals} />
                </>
              ) : (
                <EmptyState
                  title="No intake yet"
                  description="A patient’s structured intake will appear here when submitted."
                />
              )}
            </Card>
            <Card>
              <h2 className="section-title">Recent check-ins</h2>
              {data.checkIns.length ? (
                <div className="timeline">
                  {[...data.checkIns]
                    .sort((a, b) => b.date.localeCompare(a.date))
                    .slice(0, 6)
                    .map((c) => (
                      <div className="timeline-item" key={c.id}>
                        <span
                          className={`timeline-dot ${c.feeling === 'worse' ? 'warning' : ''}`}
                        />
                        <div className="row between">
                          <strong>{formatDate(c.date)}</strong>
                          <Badge tone={c.adherence === 'taken' ? 'green' : 'amber'}>
                            {c.adherence === 'taken'
                              ? 'Plan followed'
                              : c.adherence === 'partial'
                                ? 'Partly followed'
                                : 'Missed'}
                          </Badge>
                        </div>
                        <p className="muted">Patient reports feeling {c.feeling}</p>
                        {c.note && <p>{c.note}</p>}
                      </div>
                    ))}
                </div>
              ) : (
                <EmptyState
                  title="No check-ins recorded"
                  description="Patient-reported adherence and progress will appear here."
                />
              )}
            </Card>
          </div>
          <div className="stack">
            <Card>
              <h2 className="section-title">Care at a glance</h2>
              <div className="record-stat-grid">
                <div>
                  <strong>{data.encounters.length}</strong>
                  <span>Documented visits</span>
                </div>
                <div>
                  <strong>{activePlans.length}</strong>
                  <span>Active care plans</span>
                </div>
              </div>
              {activePlans.length ? (
                activePlans.map((p) => (
                  <div className="compact-plan" key={p.id}>
                    <div className="row between">
                      <strong>{p.title}</strong>
                      <Badge tone="green">Active</Badge>
                    </div>
                    <p className="muted">
                      Follow-up {p.followUpDate ? formatDate(p.followUpDate) : 'not scheduled'}
                    </p>
                    <button
                      className="button button-ghost button-small"
                      onClick={() => setTab('care')}
                    >
                      View care plan <ArrowRight size={14} />
                    </button>
                  </div>
                ))
              ) : (
                <p className="muted">Create a care plan after clinical review.</p>
              )}
            </Card>
            <Card>
              <h2 className="section-title">Appointment history</h2>
              {data.appointments.length ? (
                <div className="appointment-history">
                  {[...data.appointments]
                    .sort((a, b) => `${b.date}${b.time}`.localeCompare(`${a.date}${a.time}`))
                    .slice(0, 6)
                    .map((a) => (
                      <div key={a.id}>
                        <div className="row between">
                          <strong>
                            {formatDate(a.date)} · {timeLabel(a.time)}
                          </strong>
                          <Status status={a.status} />
                        </div>
                        <p>{a.reason}</p>
                        <span className="muted small">
                          {a.doctorName} · {a.mode === 'online' ? 'Online' : 'In clinic'}
                        </span>
                      </div>
                    ))}
                </div>
              ) : (
                <p className="muted">No appointments recorded.</p>
              )}
            </Card>
          </div>
        </div>
      )}
      {tab === 'visits' && (
        <div className="stack">
          {clinical.error && <ErrorState message={clinical.error} retry={clinical.reload} />}
          {data.encounters.length ? (
            [...data.encounters]
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
              .map((e) => (
                <Card key={e.id}>
                  <div className="clinic-panel-heading">
                    <div>
                      <h2 className="section-title">Consultation · {formatDate(e.createdAt)}</h2>
                      <p className="muted">{e.doctorName}</p>
                    </div>
                    <Badge tone="green">Saved clinical note</Badge>
                  </div>
                  <div className="grid-2">
                    <FieldValue label="History" value={e.history} />
                    <FieldValue label="Examination" value={e.examination} />
                    <FieldValue label="Assessment" value={e.assessment} />
                    <FieldValue label="Investigations" value={e.investigations} />
                  </div>
                  <FieldValue label="Plan / next steps" value={e.plan} />
                  {clinical.data && (
                    <EncounterAmendments
                      encounterId={e.id}
                      amendments={clinical.data.amendments.filter(
                        (amendment) => amendment.encounterId === e.id,
                      )}
                      onChanged={clinical.reload}
                    />
                  )}
                </Card>
              ))
          ) : (
            <Card>
              <EmptyState
                title="The care story starts here"
                description="Document the history, examination, assessment and next steps after a consultation."
                action={
                  <button className="button button-primary" onClick={() => setModal('visit')}>
                    <Plus size={16} /> Add visit note
                  </button>
                }
              />
            </Card>
          )}
          <p className="muted small">
            Saved visit notes preserve the original clinical record. Add a dated amendment to
            document a correction or additional information without overwriting the note.
          </p>
        </div>
      )}
      {tab === 'care' && (
        <div className="stack">
          {data.carePlans.length ? (
            data.carePlans.map((plan) => (
              <div
                key={plan.id}
                id={`care-plan-${plan.id}`}
                className={
                  selectedPlan === plan.id ? 'fu-selected-plan fu-plan-anchor' : 'fu-plan-anchor'
                }
              >
                <CarePlanCard
                  plan={plan}
                  onChanged={reload}
                  followUpEnabled={settings.data?.modules.followUp === true}
                />
              </div>
            ))
          ) : (
            <Card>
              <EmptyState
                title="No care plans yet"
                description="Give your patient clear instructions, expectations and a follow-up date."
                action={
                  <button className="button button-primary" onClick={() => setModal('care')}>
                    Create a care plan
                  </button>
                }
              />
            </Card>
          )}
        </div>
      )}
      {tab === 'workup' && (
        <ClinicalWorkflowPanel
          key={patient.id}
          patientId={patient.id}
          appointments={data.appointments}
          resource={clinical}
          selectedInvestigationId={recordParams.get('investigation')}
          selectedResultId={recordParams.get('result')}
        />
      )}
      {tab === 'reports' && <DocumentsPanel patientId={patient.id} />}
      {tab === 'images' && (
        <Card>
          <div className="clinic-panel-heading">
            <div>
              <h2 className="section-title">Images & investigation reports</h2>
              <p className="muted">
                Private care documentation. Select two clinical images to compare.
              </p>
            </div>
            <button
              className="button button-secondary"
              disabled={!imagesEnabled}
              onClick={() => setModal('image')}
            >
              <ImagePlus size={16} /> Add image
            </button>
          </div>
          {!imagesEnabled && (
            <div className="notice">
              New image uploads are paused. Existing images and reports remain available for
              continuity of care.
            </div>
          )}
          {selectedImages.length === 2 && (
            <div className="clinic-image-comparison">
              {selectedImages.map((imageId) => {
                const img = data.images.find((i) => i.id === imageId);
                return img ? (
                  <figure key={img.id}>
                    <img src={img.url} alt={img.caption} />
                    <figcaption>
                      {img.caption}
                      <span>{formatDate(img.createdAt)}</span>
                    </figcaption>
                  </figure>
                ) : null;
              })}
              <button
                className="button button-ghost button-small comparison-clear"
                onClick={() => setSelectedImages([])}
              >
                <X size={14} /> Clear comparison
              </button>
            </div>
          )}
          {data.images.length ? (
            <div className="clinic-image-grid">
              {data.images.map((img) => (
                <article
                  className={`clinical-image ia-image-card ${selectedImages.includes(img.id) ? 'selected' : ''}`}
                  key={img.id}
                >
                  <button
                    className="ia-thumbnail"
                    aria-label={`Compare ${img.caption}`}
                    onClick={() =>
                      setSelectedImages((prev) =>
                        prev.includes(img.id)
                          ? prev.filter((i) => i !== img.id)
                          : [...prev.slice(-1), img.id],
                      )
                    }
                    aria-pressed={selectedImages.includes(img.id)}
                  >
                    <img src={img.url} alt={img.caption} loading="lazy" />
                    {selectedImages.includes(img.id) && (
                      <span className="image-selection">
                        <Check size={16} />
                      </span>
                    )}
                  </button>
                  <div>
                    <strong>{img.caption}</strong>
                    <span>
                      {formatDate(img.createdAt)} ·{' '}
                      {img.category === 'report' ? 'Report' : 'Clinical image'}
                    </span>
                  </div>
                  <div className="ia-image-actions">
                    <button
                      className="button button-secondary button-small"
                      onClick={() => openAnnotations(img.id)}
                    >
                      View annotations
                    </button>
                    <span className="muted small">Select image above to compare</span>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState
              title="A clearer picture over time"
              description="Add clinical photographs or image-based investigation reports with the patient’s permission. JPEG, PNG or WebP, up to 5 MB."
              action={
                imagesEnabled ? (
                  <button className="button button-secondary" onClick={() => setModal('image')}>
                    <ImagePlus size={16} /> Upload first image
                  </button>
                ) : undefined
              }
            />
          )}
          <p className="muted small">
            Comparison is visual documentation, not a measure of clinical improvement. Patient
            permission here covers treatment use only.
          </p>
        </Card>
      )}
      {tab === 'messages' && (
        <PatientMessages
          patientId={patient.id}
          patientName={patient.name}
          canSend={settings.data?.modules.followUp !== false}
        />
      )}
      {modal === 'visit' && (
        <VisitModal
          record={data}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            setTab('visits');
            reload();
          }}
        />
      )}
      {modal === 'care' && (
        <CarePlanModal
          patientId={patient.id}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            setTab('care');
            reload();
          }}
        />
      )}
      {modal === 'image' && imagesEnabled && (
        <UploadModal
          patientId={patient.id}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            reload();
          }}
        />
      )}
      {annotationImage && (
        <ImageAnnotationModal
          key={annotationImage.id}
          image={annotationImage}
          enabled={imagesEnabled}
          onClose={() => openAnnotations(null)}
        />
      )}
    </>
  );
}

function VisitModal({
  record,
  onClose,
  onSaved,
}: {
  record: PatientRecord;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    if (!values.appointmentId) delete values.appointmentId;
    setSaving(true);
    setError('');
    try {
      await api('/api/encounters', {
        method: 'POST',
        body: { ...values, patientId: record.patient.id },
      });
      toast('Clinical note saved.');
      onSaved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal title="Document consultation" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {error && (
          <div role="alert" className="notice notice-error">
            {error}
          </div>
        )}
        <Field label="Linked appointment">
          <select name="appointmentId" defaultValue="">
            <option value="">Standalone clinical note</option>
            {record.appointments
              .filter((a) => !['cancelled', 'no-show'].includes(a.status))
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {formatDate(a.date)} · {a.time} · {a.reason}
                </option>
              ))}
          </select>
        </Field>
        <Field label="History">
          <textarea
            name="history"
            required
            rows={3}
            maxLength={8000}
            placeholder="Relevant history and patient-reported symptoms"
          />
        </Field>
        <Field label="Examination">
          <textarea
            name="examination"
            required
            rows={3}
            maxLength={8000}
            placeholder="Your clinical observations"
          />
        </Field>
        <Field label="Assessment">
          <textarea
            name="assessment"
            required
            rows={3}
            maxLength={8000}
            placeholder="Clinical assessment, uncertainty and differential considerations"
          />
        </Field>
        <Field label="Investigations">
          <textarea
            name="investigations"
            rows={2}
            maxLength={8000}
            placeholder="Results reviewed or investigations requested"
          />
        </Field>
        <Field label="Plan and next steps">
          <textarea
            name="plan"
            required
            rows={3}
            maxLength={8000}
            placeholder="Treatment decisions, rationale and follow-up"
          />
        </Field>
        <div className="notice">
          This note becomes part of the permanent visit history. Review it before saving. Add a care
          plan separately to give the patient structured instructions.
        </div>
        <div className="modal-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="button button-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save clinical note'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CarePlanModal({
  patientId,
  onClose,
  onSaved,
}: {
  patientId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const emptyMedication = (): Medication => ({
    name: '',
    instructions: '',
    schedule: '',
    duration: '',
    warnings: '',
  });
  const [medications, setMedications] = useState<Medication[]>([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const [startDate, setStartDate] = useState(today());
  const [endDate, setEndDate] = useState(shiftDate(today(), 30));
  function editMedication(index: number, field: keyof Medication, value: string) {
    setMedications((prev) => prev.map((m, i) => (i === index ? { ...m, [field]: value } : m)));
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    if (endDate < startDate) return setError('The end date must be on or after the start date.');
    setError('');
    setSaving(true);
    try {
      await api('/api/care-plans', { method: 'POST', body: { ...values, patientId, medications } });
      toast('Care plan shared with patient.');
      onSaved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal title="Create a care plan" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {error && (
          <div role="alert" className="notice notice-error">
            {error}
          </div>
        )}
        <Field label="Plan title">
          <input
            name="title"
            required
            maxLength={200}
            placeholder="A clear name for this treatment journey"
          />
        </Field>
        <Field label="Instructions">
          <textarea
            name="instructions"
            required
            rows={3}
            maxLength={8000}
            placeholder="Explain the plan in language the patient can understand"
          />
        </Field>
        <div className="form-grid">
          <Field label="Start date">
            <input
              name="startDate"
              required
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </Field>
          <Field label="End / review date">
            <input
              name="endDate"
              required
              type="date"
              min={startDate}
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </Field>
          <Field label="Follow-up date">
            <input
              name="followUpDate"
              required
              type="date"
              min={startDate}
              defaultValue={shiftDate(today(), 14)}
            />
          </Field>
          <Field label="Expected cost">
            <input
              name="cost"
              maxLength={200}
              placeholder="e.g. ₹800–1,200, confirmed with patient"
            />
          </Field>
        </div>
        <Field label="What to expect">
          <textarea
            name="expectations"
            rows={2}
            maxLength={5000}
            placeholder="Expected duration, review points and realistic expectations"
          />
        </Field>
        <Field label="Precautions and when to contact the clinic">
          <textarea
            name="warnings"
            rows={2}
            required
            maxLength={5000}
            placeholder="Specific clinician-reviewed warnings and escalation instructions"
          />
        </Field>
        <div className="row between">
          <h3 className="section-title">Medications / treatment steps</h3>
          <button
            type="button"
            className="button button-secondary button-small"
            onClick={() => setMedications((prev) => [...prev, emptyMedication()])}
          >
            <Plus size={14} /> Add item
          </button>
        </div>
        {medications.length === 0 && (
          <p className="muted small">
            Add prescribed medications if applicable. No automated medication recommendations are
            generated.
          </p>
        )}
        {medications.map((m, index) => (
          <div className="medication-editor" key={index}>
            <div className="row between">
              <strong>Item {index + 1}</strong>
              <button
                className="button button-ghost button-small"
                type="button"
                aria-label={`Remove medication ${index + 1}`}
                onClick={() => setMedications((prev) => prev.filter((_, i) => i !== index))}
              >
                <X size={16} />
              </button>
            </div>
            <Field label="Medication / treatment name">
              <input
                required
                maxLength={200}
                value={m.name}
                onChange={(e) => editMedication(index, 'name', e.target.value)}
              />
            </Field>
            <Field label="Dose and instructions">
              <textarea
                required
                rows={2}
                maxLength={2000}
                value={m.instructions}
                onChange={(e) => editMedication(index, 'instructions', e.target.value)}
              />
            </Field>
            <div className="form-grid">
              <Field label="Schedule">
                <input
                  required
                  maxLength={200}
                  value={m.schedule}
                  onChange={(e) => editMedication(index, 'schedule', e.target.value)}
                  placeholder="As prescribed"
                />
              </Field>
              <Field label="Duration">
                <input
                  required
                  maxLength={200}
                  value={m.duration}
                  onChange={(e) => editMedication(index, 'duration', e.target.value)}
                />
              </Field>
            </div>
            <Field label="Item-specific warnings">
              <input
                maxLength={2000}
                value={m.warnings}
                onChange={(e) => editMedication(index, 'warnings', e.target.value)}
              />
            </Field>
          </div>
        ))}
        <p className="muted small">
          This plan is visible to the patient immediately after saving. Confirm instructions, risks
          and costs with them.
        </p>
        <div className="modal-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="button button-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save and share care plan'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CarePlanCard({
  plan,
  onChanged,
  followUpEnabled,
}: {
  plan: CarePlan;
  onChanged: () => void;
  followUpEnabled: boolean;
}) {
  const status = plan.effectiveStatus ?? plan.status;
  const followUpDate =
    plan.effectiveFollowUpDate === undefined ? plan.followUpDate : plan.effectiveFollowUpDate;
  return (
    <Card>
      <div className="clinic-panel-heading">
        <div>
          <h2 className="section-title">{plan.title}</h2>
          <p className="muted">
            {formatDate(plan.startDate)} – {formatDate(plan.endDate)}
            {plan.doctorName ? ` · ${plan.doctorName}` : ''}
          </p>
        </div>
        <Badge tone={status === 'active' ? 'green' : 'neutral'}>
          {status === 'active' ? 'Active plan' : 'Completed'}
        </Badge>
      </div>
      <FieldValue label="Instructions" value={plan.instructions} />
      {plan.medications.length > 0 && (
        <div className="treatment-list">
          {plan.medications.map((m, i) => (
            <div key={i}>
              <span className="treatment-number">{i + 1}</span>
              <div>
                <strong>{m.name}</strong>
                <p>{m.instructions}</p>
                <span className="muted small">
                  {m.schedule} · {m.duration}
                </span>
                {m.warnings && <p className="medication-warning">{m.warnings}</p>}
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="grid-2">
        <FieldValue label="What to expect" value={plan.expectations} />
        <FieldValue label="Estimated cost" value={plan.cost} />
      </div>
      {plan.warnings && (
        <div className="notice notice-warning">
          <strong>Precautions</strong>
          <p>{plan.warnings}</p>
        </div>
      )}
      <div className="care-plan-footer">
        <span className="row">
          <CalendarDays size={17} />{' '}
          {status === 'completed'
            ? 'Follow-up completed'
            : `Next review ${followUpDate ? formatDate(followUpDate) : 'not scheduled'}`}
        </span>
        {plan.latestReview && (
          <span className="muted small">Original follow-up: {formatDate(plan.followUpDate)}</span>
        )}
      </div>
      <FollowUpPlanSection plan={plan} enabled={followUpEnabled} onChanged={onChanged} />
    </Card>
  );
}

function UploadModal({
  patientId,
  onClose,
  onSaved,
}: {
  patientId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return setError('Select an image to upload.');
    if (file.size > 5 * 1024 * 1024) return setError('Choose an image smaller than 5 MB.');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type))
      return setError('Choose a JPEG, PNG or WebP image.');
    const values = Object.fromEntries(new FormData(event.currentTarget));
    setSaving(true);
    setError('');
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('The selected file could not be read.'));
        reader.readAsDataURL(file);
      });
      await api('/api/images', {
        method: 'POST',
        body: {
          patientId,
          caption: values.caption,
          category: values.category,
          consent: true,
          dataUrl,
        },
      });
      toast('Private image added to the patient record.');
      onSaved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal title="Add a clinical image" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {error && (
          <div className="notice notice-error" role="alert">
            {error}
          </div>
        )}
        <Field label="Image file" hint="JPEG, PNG or WebP · Maximum 5 MB">
          <input
            required
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
          />
        </Field>
        <Field label="Caption">
          <input
            name="caption"
            required
            maxLength={300}
            placeholder="Area, view and relevant capture details"
          />
        </Field>
        <Field label="Category">
          <select name="category">
            <option value="clinical">Clinical photograph</option>
            <option value="report">Investigation report image</option>
          </select>
        </Field>
        <label className="checkbox-field">
          <input type="checkbox" required />
          <span>
            I have confirmed the patient’s permission to store this image for their treatment and
            clinical record.
          </span>
        </label>
        <div className="notice">
          Images remain private to the patient and authorized clinicians. This permission does not
          authorize teaching, research or public use.
        </div>
        <div className="modal-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="button button-primary" disabled={saving}>
            {saving ? 'Uploading…' : 'Upload privately'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function PatientMessages({
  patientId,
  patientName,
  canSend,
}: {
  patientId: string;
  patientName: string;
  canSend: boolean;
}) {
  const { data, loading, error, reload } = useResource<Message[]>(
    `/api/messages?patientId=${patientId}`,
  );
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  async function send(event: FormEvent) {
    event.preventDefault();
    if (!body.trim()) return;
    setSaving(true);
    try {
      await api('/api/messages', { method: 'POST', body: { patientId, body: body.trim() } });
      setBody('');
      reload();
      toast('Message added to the patient’s inbox.');
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setSaving(false);
    }
  }
  return (
    <Card>
      <div className="clinic-panel-heading">
        <div>
          <h2 className="section-title">Conversation with {patientName}</h2>
          <p className="muted">Messages are available in the patient portal.</p>
        </div>
        <button className="button button-ghost button-small" onClick={reload}>
          Refresh
        </button>
      </div>
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorState message={error} retry={reload} />
      ) : !data?.length ? (
        <EmptyState
          title="Keep the care conversation going"
          description="Send a follow-up question or clarify an instruction for your patient."
        />
      ) : (
        <div className="clinical-messages">
          {data.map((m) => (
            <div
              key={m.id}
              className={`clinical-message ${m.authorRole === 'patient' ? 'from-patient' : 'from-clinic'}`}
            >
              <div className="row between">
                <strong>{m.authorName}</strong>
                <span>{formatDate(m.createdAt)}</span>
              </div>
              <p>{m.body}</p>
            </div>
          ))}
        </div>
      )}
      {canSend ? (
        <form className="stack clinic-message-composer" onSubmit={send}>
          <Field label="Message to patient">
            <textarea
              required
              rows={3}
              value={body}
              maxLength={4000}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write a clear, patient-friendly message…"
            />
          </Field>
          <div className="row between">
            <span className="muted small">In-app delivery. No SMS or WhatsApp is sent.</span>
            <button className="button button-primary" disabled={saving || !body.trim()}>
              <Send size={16} />
              {saving ? 'Sending…' : 'Send message'}
            </button>
          </div>
        </form>
      ) : (
        <div className="notice">
          New messages are paused because the clinic has disabled the follow-up module. Previous
          messages remain available.
        </div>
      )}
    </Card>
  );
}
