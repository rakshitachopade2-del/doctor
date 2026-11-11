import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Archive,
  ArrowLeft,
  ArrowUpRight,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  DoorOpen,
  History,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Wrench,
} from 'lucide-react';
import type {
  ClinicResource,
  ResourceAuthor,
  ResourceChange,
  ResourceClosure,
  ResourceDetail,
  ResourceMetadata,
  ResourceReservation,
  ResourceReservations,
} from '../../shared/clinic-resources';
import { api, ApiError, formatDate, today, useResource, useSession, useToast } from '../lib';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  Modal,
  PageHeader,
} from '../components/ui';
import './clinic-resources.css';

const failure = (error: unknown) =>
  error instanceof Error
    ? error.message
    : 'The save outcome could not be confirmed. Please retry the same request.';
const kindLabel = (kind: ResourceMetadata['kind']) => (kind === 'room' ? 'Room' : 'Equipment');
const stamp = (date: string) =>
  new Date(date).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
const realDate = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T12:00:00Z`)) &&
  new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
const shiftDate = (day: string, count: number) => {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
};
const timeValue = (value: unknown): value is string =>
  typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const timeLabel = (value: string) => {
  const [hour, minute] = value.split(':').map(Number);
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}`;
};
const endTime = (time: string, duration: number) => {
  const [hour, minute] = time.split(':').map(Number),
    end = hour * 60 + minute + duration;
  return `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
};
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const dated = (value: unknown): value is string =>
  nonempty(value) && Number.isFinite(Date.parse(value));
const revision = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const requestId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
function metadata(value: unknown): value is ResourceMetadata {
  return (
    record(value) &&
    nonempty(value.name) &&
    value.name.length <= 100 &&
    ['room', 'equipment'].includes(value.kind as string) &&
    value.capacity === 1 &&
    typeof value.location === 'string' &&
    value.location.length <= 200 &&
    typeof value.notes === 'string' &&
    value.notes.length <= 1000 &&
    typeof value.active === 'boolean'
  );
}
function author(value: unknown): value is ResourceAuthor {
  return (
    record(value) &&
    nonempty(value.createdById) &&
    nonempty(value.createdByName) &&
    ['admin', 'doctor', 'receptionist', 'patient'].includes(value.createdByRole as string) &&
    dated(value.createdAt)
  );
}
function checkedResource(value: unknown, id?: string): ClinicResource {
  if (
    !record(value) ||
    !metadata(value) ||
    !nonempty(value.id) ||
    (id && value.id !== id) ||
    !dated(value.createdAt) ||
    !dated(value.updatedAt) ||
    !revision(value.revision)
  )
    throw new Error(
      'The response did not contain a complete resource record. Refresh to try again.',
    );
  return value as unknown as ClinicResource;
}
function checkedCatalogue(value: unknown): ClinicResource[] {
  if (!Array.isArray(value))
    throw new Error('The resource catalogue could not be confirmed. Refresh to try again.');
  const items = value.map((entry) => checkedResource(entry));
  if (new Set(items.map((entry) => entry.id)).size !== items.length)
    throw new Error('The catalogue contained duplicate resource records. Refresh to try again.');
  return items;
}
function checkedDetail(value: unknown, id?: string): ResourceDetail {
  if (!record(value))
    throw new Error('The resource details could not be confirmed. Refresh to try again.');
  const resource = checkedResource(value.resource, id);
  if (
    !Array.isArray(value.changes) ||
    !value.changes.every(
      (entry) =>
        record(entry) &&
        author(entry) &&
        nonempty(entry.id) &&
        requestId(entry.requestId) &&
        entry.resourceId === resource.id &&
        (entry.before === null || metadata(entry.before)) &&
        metadata(entry.after) &&
        nonempty(entry.reason),
    ) ||
    new Set(value.changes.map((entry) => entry.id)).size !== value.changes.length ||
    !Array.isArray(value.closures) ||
    !value.closures.every(
      (entry) =>
        record(entry) &&
        author(entry) &&
        nonempty(entry.id) &&
        requestId(entry.requestId) &&
        entry.resourceId === resource.id &&
        realDate(entry.startDate) &&
        realDate(entry.endDate) &&
        entry.startDate <= entry.endDate &&
        ((entry.startTime === null && entry.endTime === null) ||
          (timeValue(entry.startTime) &&
            timeValue(entry.endTime) &&
            entry.startTime < entry.endTime)) &&
        nonempty(entry.reason) &&
        (entry.cancellation === null ||
          (record(entry.cancellation) &&
            author(entry.cancellation) &&
            nonempty(entry.cancellation.id) &&
            requestId(entry.cancellation.requestId) &&
            nonempty(entry.cancellation.reason))),
    ) ||
    new Set(value.closures.map((entry) => entry.id)).size !== value.closures.length
  )
    throw new Error(
      'The resource history or maintenance details were incomplete. Refresh or retry the same submitted request.',
    );
  return value as unknown as ResourceDetail;
}
function checkedReservations(
  value: unknown,
  day: string,
  resourceId?: string,
): ResourceReservations {
  if (
    !record(value) ||
    value.from !== day ||
    value.to !== day ||
    value.timezone !== 'Asia/Kolkata' ||
    !Array.isArray(value.reservations) ||
    !value.reservations.every((entry) => {
      if (
        !record(entry) ||
        !record(entry.resource) ||
        !nonempty(entry.resource.id) ||
        (resourceId && entry.resource.id !== resourceId) ||
        !nonempty(entry.resource.name) ||
        !['room', 'equipment'].includes(entry.resource.kind as string) ||
        typeof entry.resource.location !== 'string' ||
        !record(entry.appointment)
      )
        return false;
      const appointment = entry.appointment;
      return (
        ['id', 'patientId', 'patientName', 'doctorId', 'doctorName'].every((key) =>
          nonempty(appointment[key]),
        ) &&
        appointment.date === day &&
        timeValue(appointment.time) &&
        ['in-person', 'online'].includes(appointment.mode as string) &&
        [
          'scheduled',
          'checked-in',
          'in-consultation',
          'completed',
          'cancelled',
          'no-show',
        ].includes(appointment.status as string) &&
        typeof appointment.durationMinutes === 'number' &&
        Number.isInteger(appointment.durationMinutes) &&
        appointment.durationMinutes > 0 &&
        appointment.durationMinutes <= 1440
      );
    })
  )
    throw new Error(
      'The reservations response could not be confirmed for this date. Refresh to try again.',
    );
  if (
    new Set(value.reservations.map((entry) => `${entry.resource.id}:${entry.appointment.id}`))
      .size !== value.reservations.length
  )
    throw new Error('The diary contained duplicate reservation records. Refresh to try again.');
  return value as unknown as ResourceReservations;
}
const resourceHref = (id: string, date: string) =>
  `/clinic/resources?resource=${encodeURIComponent(id)}&date=${date}`;
const appointmentHref = (reservation: ResourceReservation) =>
  `/clinic/appointments?date=${reservation.appointment.date}&resources=${encodeURIComponent(reservation.appointment.id)}`;
const statusName = (status: string) =>
  ({
    scheduled: 'Scheduled',
    'checked-in': 'Checked in',
    'in-consultation': 'In consultation',
    completed: 'Completed',
    cancelled: 'Cancelled',
    'no-show': 'No-show',
  })[status] ?? status;
const maintenanceDates = (closure: Pick<ResourceClosure, 'startDate' | 'endDate'>) =>
  closure.startDate === closure.endDate
    ? formatDate(closure.startDate)
    : `${formatDate(closure.startDate)} – ${formatDate(closure.endDate)}`;
const maintenanceTimes = (closure: Pick<ResourceClosure, 'startTime' | 'endTime'>) =>
  closure.startTime === null
    ? 'All day on each included date'
    : `${timeLabel(closure.startTime)} – ${timeLabel(closure.endTime!)} IST on each included date`;

type Operation = 'create' | 'edit' | 'archive' | 'restore' | 'maintenance' | 'cancel-maintenance';
type Values = {
  name: string;
  kind: ResourceMetadata['kind'];
  location: string;
  notes: string;
  active: boolean;
  reason: string;
  startDate: string;
  endDate: string;
  allDay: boolean;
  startTime: string;
  endTime: string;
};
type Attempt = { path: string; method: 'POST' | 'PATCH'; body: Record<string, unknown> };
type ResourceDraft = {
  operation: Operation;
  source: ResourceDetail | null;
  closureId: string | null;
  values: Values;
  requestId: string;
  attempt: Attempt | null;
  phase: 'editing' | 'conflict' | 'uncertain';
  error: string;
  reviewed: ResourceDetail | null;
};
function newDraft(
  operation: Operation,
  source: ResourceDetail | null,
  day: string,
  closureId: string | null = null,
): ResourceDraft {
  const date =
    day < today() ? today() : day > shiftDate(today(), 365) ? shiftDate(today(), 365) : day;
  return {
    operation,
    source,
    closureId,
    values: {
      name: source?.resource.name ?? '',
      kind: source?.resource.kind ?? 'room',
      location: source?.resource.location ?? '',
      notes: source?.resource.notes ?? '',
      active:
        operation === 'archive'
          ? false
          : operation === 'restore'
            ? true
            : (source?.resource.active ?? true),
      reason: '',
      startDate: date,
      endDate: date,
      allDay: true,
      startTime: '09:00',
      endTime: '18:00',
    },
    requestId: crypto.randomUUID(),
    attempt: null,
    phase: 'editing',
    error: '',
    reviewed: null,
  };
}
function ResourceBadges({ resource }: { resource: ResourceMetadata }) {
  return (
    <div className="crp-badges">
      <Badge tone={resource.kind === 'room' ? 'green' : 'blue'}>{kindLabel(resource.kind)}</Badge>
      <Badge>{resource.active ? 'Active' : 'Archived'}</Badge>
      <span className="crp-help">Single unit</span>
    </div>
  );
}
function ResourceSnapshot({ value, title }: { value: ResourceMetadata; title: string }) {
  return (
    <section className="crp-snapshot">
      <h3>{title}</h3>
      <dl>
        <div>
          <dt>Name & type</dt>
          <dd>
            {value.name} · {kindLabel(value.kind)}
          </dd>
        </div>
        <div>
          <dt>Location</dt>
          <dd>{value.location || 'Not recorded'}</dd>
        </div>
        <div>
          <dt>Operational notes</dt>
          <dd>{value.notes || 'Not recorded'}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{value.active ? 'Active' : 'Archived'}</dd>
        </div>
      </dl>
    </section>
  );
}
function ReservationCard({ reservation }: { reservation: ResourceReservation }) {
  const appointment = reservation.appointment;
  return (
    <article className="crp-day-event crp-reservation">
      <div className="crp-event-heading">
        <span className="crp-event-time">
          {timeLabel(appointment.time)} –{' '}
          {timeLabel(endTime(appointment.time, appointment.durationMinutes))} IST
        </span>
        <Badge tone={appointment.status === 'completed' ? 'green' : 'neutral'}>
          {statusName(appointment.status)}
        </Badge>
      </div>
      <h4>{appointment.patientName}</h4>
      <p className="crp-help">
        {appointment.doctorName} ·{' '}
        {appointment.mode === 'online' ? 'Online appointment' : 'In-clinic appointment'} ·{' '}
        {appointment.durationMinutes} minutes
      </p>
      <Link className="button button-secondary button-small" to={appointmentHref(reservation)}>
        View appointment resources <ArrowUpRight size={13} />
      </Link>
    </article>
  );
}
function DateNavigator({ date, onChange }: { date: string; onChange: (date: string) => void }) {
  return (
    <div className="crp-date-nav">
      <Field label="Diary date">
        <input
          type="date"
          required
          value={date}
          onChange={(event) => {
            if (realDate(event.target.value)) onChange(event.target.value);
          }}
        />
      </Field>
      <button
        className="button button-secondary"
        aria-label="Previous diary day"
        onClick={() => onChange(shiftDate(date, -1))}
      >
        <ChevronLeft size={16} />
      </button>
      <button className="button button-secondary" onClick={() => onChange(today())}>
        Today
      </button>
      <button
        className="button button-secondary"
        aria-label="Next diary day"
        onClick={() => onChange(shiftDate(date, 1))}
      >
        <ChevronRight size={16} />
      </button>
    </div>
  );
}

export function ClinicResourcesPage() {
  const { session } = useSession();
  const admin = session.user?.role === 'admin';
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('resource');
  const requestedDate = params.get('date');
  const day = realDate(requestedDate) ? requestedDate : today();
  const view = params.get('view') === 'catalogue' ? 'catalogue' : 'diary';
  const [search, setSearch] = useState(''),
    [kind, setKind] = useState('all'),
    [active, setActive] = useState('active');
  const [draft, setDraft] = useState<ResourceDraft | null>(null),
    [open, setOpen] = useState(false),
    [generation, setGeneration] = useState(0);
  const catalogue = useResource<ClinicResource[]>('/api/clinic-resources?active=all');
  const diary = useResource<ResourceReservations>(
    selectedId || view !== 'diary' ? null : `/api/resource-reservations?from=${day}&to=${day}`,
  );
  function query(key: string, value: string | null) {
    setParams(
      (old) => {
        const next = new URLSearchParams(old);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  }
  useEffect(() => {
    const refresh = () => {
      if (!document.hidden) {
        void catalogue.reload();
        void diary.reload();
      }
    };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [catalogue.reload, diary.reload]);
  let resources: ClinicResource[] = [],
    reservations: ResourceReservation[] = [],
    catalogueError = catalogue.error,
    diaryError = diary.error;
  if (!catalogue.loading && !catalogueError) {
    try {
      resources = checkedCatalogue(catalogue.data);
    } catch (problem) {
      catalogueError = failure(problem);
    }
  }
  if (!selectedId && view === 'diary' && !diary.loading && !diaryError) {
    try {
      reservations = checkedReservations(diary.data, day).reservations;
    } catch (problem) {
      diaryError = failure(problem);
    }
  }
  const visible = resources.filter(
    (resource) =>
      (kind === 'all' || resource.kind === kind) &&
      (active === 'all' || resource.active === (active === 'active')) &&
      `${resource.name} ${resource.location} ${resource.notes}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  function start(
    operation: Operation,
    source: ResourceDetail | null = null,
    closureId: string | null = null,
  ) {
    if (!admin) return;
    if (!draft) setDraft(newDraft(operation, source, day, closureId));
    setOpen(true);
  }
  return (
    <div className="crp-workspace">
      {!selectedId && (
        <PageHeader
          eyebrow="CLINIC OPERATIONS"
          title="Rooms & equipment"
          description="Plan the use of individual physical resources around existing appointments."
          actions={
            admin ? (
              <button
                className="button button-primary"
                disabled={!!draft}
                onClick={() => start('create')}
              >
                <Plus size={16} />
                Add resource
              </button>
            ) : undefined
          }
        />
      )}
      {draft && !open && (
        <div className="notice crp-pending">
          <div>
            <strong>A resource update is unfinished.</strong>
            <p>
              {draft.source?.resource.name || draft.values.name || 'New resource'} · Your draft and
              any submitted request are retained while this page stays open.
            </p>
          </div>
          <button className="button button-secondary" onClick={() => setOpen(true)}>
            Resume pending resource update
          </button>
        </div>
      )}
      {selectedId ? (
        <ResourceDetailPage
          key={selectedId}
          id={selectedId}
          day={day}
          admin={admin}
          pending={!!draft}
          generation={generation}
          onDate={(value) => query('date', value)}
          onBack={() => query('resource', null)}
          onStart={start}
        />
      ) : (
        <>
          <div className="crp-switcher" role="group" aria-label="Resource views">
            <button
              className={`button ${view === 'diary' ? 'button-primary' : 'button-secondary'}`}
              aria-pressed={view === 'diary'}
              onClick={() => query('view', 'diary')}
            >
              <CalendarDays size={16} />
              Reservations diary
            </button>
            <button
              className={`button ${view === 'catalogue' ? 'button-primary' : 'button-secondary'}`}
              aria-pressed={view === 'catalogue'}
              onClick={() => query('view', 'catalogue')}
            >
              <DoorOpen size={16} />
              Resource catalogue
            </button>
          </div>
          <div className="crp-intro">
            <ShieldCheck size={21} />
            <div>
              <h2>One physical unit, one reservation at a time.</h2>
              <p>
                Reservations cover the appointment’s recorded duration. Staff choose resources
                explicitly for existing visits, including online appointments. These records do not
                report live occupancy, equipment suitability or required clinical equipment.
              </p>
            </div>
          </div>
          {view === 'diary' && (
            <DateNavigator date={day} onChange={(value) => query('date', value)} />
          )}
          <Card>
            <div className="crp-toolbar">
              <div className="field crp-search-field">
                <Field label="Search resources">
                  <div className="crp-search">
                    <Search size={16} />
                    <input
                      aria-label="Search resources"
                      value={search}
                      maxLength={300}
                      placeholder="Name, location or operational notes"
                      onChange={(event) => setSearch(event.target.value)}
                    />
                  </div>
                </Field>
              </div>
              <Field label="Resource type">
                <select value={kind} onChange={(event) => setKind(event.target.value)}>
                  <option value="all">All resources</option>
                  <option value="room">Rooms</option>
                  <option value="equipment">Equipment</option>
                </select>
              </Field>
              <Field label="Resource status">
                <select value={active} onChange={(event) => setActive(event.target.value)}>
                  <option value="active">Active</option>
                  <option value="archived">Archived</option>
                  <option value="all">All</option>
                </select>
              </Field>
            </div>
          </Card>
          {catalogue.loading || (view === 'diary' && diary.loading) ? (
            <Loading />
          ) : catalogueError || (view === 'diary' && diaryError) ? (
            <ErrorState
              message={catalogueError || diaryError}
              retry={() => {
                void catalogue.reload();
                void diary.reload();
              }}
            />
          ) : !visible.length ? (
            <Card>
              <EmptyState
                title={
                  resources.length ? 'No resources match this view' : 'No clinic resources yet'
                }
                description={
                  resources.length
                    ? 'Try another type, status or search term. Archived resources remain available in the catalogue.'
                    : admin
                      ? 'Add each room or individual equipment unit that staff need to reserve.'
                      : 'An administrator can add the clinic’s rooms and shared equipment.'
                }
                action={
                  admin && !resources.length ? (
                    <button
                      className="button button-secondary"
                      disabled={!!draft}
                      onClick={() => start('create')}
                    >
                      Add the first resource
                    </button>
                  ) : undefined
                }
              />
            </Card>
          ) : (
            <>
              {view === 'diary' && (
                <p className="crp-help">
                  Reservations for {formatDate(day)} · Asia/Kolkata. Open a resource’s details to
                  inspect maintenance. An empty diary is not a confirmation of availability or
                  suitability.
                </p>
              )}
              <div className={view === 'diary' ? 'crp-diary' : 'crp-grid'}>
                {visible.map((resource) => {
                  const rows = reservations
                    .filter((entry) => entry.resource.id === resource.id)
                    .sort((a, b) => a.appointment.time.localeCompare(b.appointment.time));
                  const Icon = resource.kind === 'room' ? DoorOpen : Wrench;
                  return (
                    <Card
                      key={resource.id}
                      className={view === 'diary' ? 'crp-day-card' : 'crp-resource-card'}
                    >
                      <div className="crp-resource-heading">
                        <div>
                          <h2>
                            <Link to={resourceHref(resource.id, day)}>{resource.name}</Link>
                          </h2>
                          <ResourceBadges resource={resource} />
                        </div>
                        <span className="crp-resource-icon">
                          <Icon size={20} />
                        </span>
                      </div>
                      <p className="crp-help">{resource.location || 'Location not recorded'}</p>
                      {view === 'catalogue' ? (
                        <>
                          {resource.notes && <p className="crp-prose">{resource.notes}</p>}
                          <div className="crp-row-actions">
                            <Link
                              className="button button-secondary button-small"
                              to={resourceHref(resource.id, day)}
                            >
                              View resource <ArrowUpRight size={13} />
                            </Link>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="crp-day-events">
                            {rows.length ? (
                              rows.map((entry) => (
                                <ReservationCard key={entry.appointment.id} reservation={entry} />
                              ))
                            ) : (
                              <p className="crp-help">No retained reservations on this date.</p>
                            )}
                          </div>
                          <div className="crp-row-actions">
                            <Link className="text-link" to={resourceHref(resource.id, day)}>
                              Maintenance & history <ArrowUpRight size={13} />
                            </Link>
                          </div>
                        </>
                      )}
                    </Card>
                  );
                })}
              </div>
              <p className="crp-result-count">
                {visible.length} {visible.length === 1 ? 'resource' : 'resources'} shown
                {view === 'diary'
                  ? ` · ${reservations.filter((entry) => visible.some((resource) => resource.id === entry.resource.id)).length} recorded reservations`
                  : ''}
              </p>
            </>
          )}
          {!admin && (
            <p className="notice">
              Staff can read the catalogue, maintenance and history. Administrators manage resource
              details and maintenance. Appointment resources are assigned from the appointment list.
            </p>
          )}
        </>
      )}
      {open && draft && (
        <ResourceEditorModal
          draft={draft}
          onChange={setDraft}
          onClose={() => setOpen(false)}
          onDiscard={() => {
            setDraft(null);
            setOpen(false);
          }}
          onSaved={(detail) => {
            setDraft(null);
            setOpen(false);
            setGeneration((value) => value + 1);
            query('resource', detail.resource.id);
            void catalogue.reload();
            void diary.reload();
          }}
        />
      )}
    </div>
  );
}

function ResourceDetailPage({
  id,
  day,
  admin,
  pending,
  generation,
  onDate,
  onBack,
  onStart,
}: {
  id: string;
  day: string;
  admin: boolean;
  pending: boolean;
  generation: number;
  onDate: (date: string) => void;
  onBack: () => void;
  onStart: (operation: Operation, source: ResourceDetail, closureId?: string | null) => void;
}) {
  const resource = useResource<ResourceDetail>(`/api/clinic-resources/${encodeURIComponent(id)}`);
  const diary = useResource<ResourceReservations>(
    `/api/resource-reservations?from=${day}&to=${day}&resourceId=${encodeURIComponent(id)}`,
  );
  const [tab, setTab] = useState('diary');
  const lastGeneration = useRef(generation);
  useEffect(() => {
    if (lastGeneration.current !== generation) {
      lastGeneration.current = generation;
      void resource.reload();
      void diary.reload();
    }
  }, [generation, resource.reload, diary.reload]);
  useEffect(() => {
    const refresh = () => {
      if (!document.hidden) {
        void resource.reload();
        void diary.reload();
      }
    };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [resource.reload, diary.reload]);
  let detail: ResourceDetail | null = null,
    rows: ResourceReservation[] = [],
    detailError = resource.error,
    diaryError = diary.error;
  if (!resource.loading && !detailError) {
    try {
      detail = checkedDetail(resource.data, id);
    } catch (problem) {
      detailError = failure(problem);
    }
  }
  if (!diary.loading && !diaryError) {
    try {
      rows = checkedReservations(diary.data, day, id).reservations.sort((a, b) =>
        a.appointment.time.localeCompare(b.appointment.time),
      );
    } catch (problem) {
      diaryError = failure(problem);
    }
  }
  if (resource.loading) return <Loading />;
  if (detailError || !detail)
    return (
      <>
        <button className="button button-ghost" onClick={onBack}>
          <ArrowLeft size={15} />
          Back to resources
        </button>
        <ErrorState
          message={detailError || 'Resource details are unavailable.'}
          retry={resource.reload}
        />
      </>
    );
  const value = detail.resource;
  const dayClosures = detail.closures.filter(
    (closure) => !closure.cancellation && closure.startDate <= day && closure.endDate >= day,
  );
  return (
    <>
      <button className="button button-ghost crp-back" onClick={onBack}>
        <ArrowLeft size={15} />
        Back to resources
      </button>
      <PageHeader
        eyebrow="RESOURCE DETAILS"
        title={value.name}
        description={`${kindLabel(value.kind)} · One physical unit · ${value.location || 'Location not recorded'}`}
        actions={
          admin ? (
            <>
              <button
                className="button button-secondary"
                disabled={pending}
                onClick={() => onStart('edit', detail)}
              >
                <Pencil size={15} />
                Edit resource
              </button>
              <button
                className="button button-secondary"
                disabled={pending}
                onClick={() => onStart(value.active ? 'archive' : 'restore', detail)}
              >
                <Archive size={15} />
                {value.active ? 'Archive resource' : 'Restore resource'}
              </button>
              <button
                className="button button-primary"
                disabled={pending || !value.active}
                onClick={() => onStart('maintenance', detail)}
              >
                <Wrench size={15} />
                Add maintenance
              </button>
            </>
          ) : undefined
        }
      />
      <Card>
        <div className="crp-resource-summary">
          <div>
            <ResourceBadges resource={value} />
            <p className="crp-prose">{value.notes || 'No operational notes recorded.'}</p>
            {!value.active && (
              <p className="crp-help">
                Archived resources remain readable. New allocations are closed.
              </p>
            )}
          </div>
          <dl>
            <div>
              <dt>Created</dt>
              <dd>{stamp(value.createdAt)} IST</dd>
            </div>
            <div>
              <dt>Latest catalogue update</dt>
              <dd>{stamp(value.updatedAt)} IST</dd>
            </div>
          </dl>
        </div>
      </Card>
      <div className="crp-switcher" role="group" aria-label="Resource detail views">
        <button
          className={`button ${tab === 'diary' ? 'button-primary' : 'button-secondary'}`}
          aria-pressed={tab === 'diary'}
          onClick={() => setTab('diary')}
        >
          Maintenance & reservations
        </button>
        <button
          className={`button ${tab === 'history' ? 'button-primary' : 'button-secondary'}`}
          aria-pressed={tab === 'history'}
          onClick={() => setTab('history')}
        >
          <History size={15} />
          Resource history
        </button>
      </div>
      {tab === 'history' ? (
        <Card>
          <div className="crp-section-heading">
            <h2>Catalogue history</h2>
          </div>
          <p className="crp-help">
            Original values and reasons remain available. Maintenance and appointment allocations
            have their own preserved histories.
          </p>
          <div className="crp-history-list">
            {detail.changes.map((change: ResourceChange) => (
              <article className="crp-history-entry" key={change.id}>
                <h3>
                  {change.before === null
                    ? 'Resource created'
                    : change.before.active && !change.after.active
                      ? 'Resource archived'
                      : !change.before.active && change.after.active
                        ? 'Resource restored'
                        : 'Resource details changed'}
                </h3>
                <p className="crp-prose">{change.reason}</p>
                <small>
                  {change.createdByName} · {stamp(change.createdAt)} IST
                </small>
                <details>
                  <summary>View preserved values</summary>
                  {change.before && (
                    <ResourceSnapshot value={change.before} title="Before this change" />
                  )}
                  <ResourceSnapshot
                    value={change.after}
                    title={change.before ? 'After this change' : 'Original resource values'}
                  />
                </details>
              </article>
            ))}
          </div>
        </Card>
      ) : (
        <>
          <Card>
            <div className="crp-section-heading">
              <h2>Reservations on {formatDate(day)}</h2>
              <button
                className="button button-secondary button-small"
                disabled={diary.loading}
                onClick={diary.reload}
              >
                <RefreshCw size={15} />
                Refresh reservations
              </button>
            </div>
            <DateNavigator date={day} onChange={onDate} />
            <p className="crp-help">
              Times are in Asia/Kolkata. Reservations use the appointment’s recorded interval,
              including completed visits. Cancelled and no-show visits release capacity; their
              allocation history stays with the appointment.
            </p>
            {diary.loading ? (
              <Loading />
            ) : diaryError ? (
              <ErrorState message={diaryError} retry={diary.reload} />
            ) : (
              <div className="crp-day-events">
                {rows.length ? (
                  rows.map((entry) => (
                    <ReservationCard key={entry.appointment.id} reservation={entry} />
                  ))
                ) : (
                  <p className="crp-help">No retained reservations on this date.</p>
                )}
              </div>
            )}
            {dayClosures.length > 0 && (
              <div className="crp-day-events">
                {dayClosures.map((closure) => (
                  <article className="crp-day-event crp-maintenance-event" key={closure.id}>
                    <div className="crp-event-heading">
                      <strong className="crp-event-time">{maintenanceTimes(closure)}</strong>
                      <Badge tone="amber">Maintenance block</Badge>
                    </div>
                    <p className="crp-prose">{closure.reason}</p>
                  </article>
                ))}
              </div>
            )}
          </Card>
          <Card>
            <div className="crp-section-heading">
              <h2>Maintenance history</h2>
              <span className="crp-help">All dates · cancelled entries retained</span>
            </div>
            {detail.closures.length ? (
              <div className="crp-maintenance-list">
                {detail.closures.map((closure) => (
                  <article className="crp-maintenance-card" key={closure.id}>
                    <div className="crp-event-heading">
                      <strong>{maintenanceDates(closure)}</strong>
                      <Badge tone={closure.cancellation ? 'neutral' : 'amber'}>
                        {closure.cancellation ? 'Cancelled maintenance' : 'Recorded maintenance'}
                      </Badge>
                    </div>
                    <p className="crp-help">{maintenanceTimes(closure)}</p>
                    <p className="crp-prose">{closure.reason}</p>
                    <small>
                      {closure.createdByName} · Recorded {stamp(closure.createdAt)} IST
                    </small>
                    {closure.cancellation ? (
                      <div className="crp-cancellation">
                        <strong>Cancellation reason</strong>
                        <p className="crp-prose">{closure.cancellation.reason}</p>
                        <small>
                          {closure.cancellation.createdByName} ·{' '}
                          {stamp(closure.cancellation.createdAt)} IST
                        </small>
                      </div>
                    ) : (
                      admin && (
                        <div className="crp-row-actions">
                          <button
                            className="button button-secondary button-small"
                            disabled={pending}
                            onClick={() => onStart('cancel-maintenance', detail, closure.id)}
                          >
                            Cancel maintenance
                          </button>
                        </div>
                      )
                    )}
                  </article>
                ))}
              </div>
            ) : (
              <p className="crp-help">
                No maintenance blocks have been recorded. This does not confirm equipment
                suitability or live availability.
              </p>
            )}
          </Card>
        </>
      )}
      {!admin && (
        <p className="notice">
          You have read-only access to this resource’s catalogue and maintenance history. Assign or
          release appointment resources from the appointment list.
        </p>
      )}
    </>
  );
}

const operationTitles: Record<Operation, string> = {
  create: 'Add a clinic resource',
  edit: 'Edit clinic resource',
  archive: 'Archive clinic resource',
  restore: 'Restore clinic resource',
  maintenance: 'Schedule resource maintenance',
  'cancel-maintenance': 'Cancel resource maintenance',
};
const operationActions: Record<Operation, string> = {
  create: 'Save resource',
  edit: 'Save resource changes',
  archive: 'Confirm resource archive',
  restore: 'Restore resource',
  maintenance: 'Save maintenance',
  'cancel-maintenance': 'Confirm maintenance cancellation',
};
function ResourceEditorModal({
  draft,
  onChange,
  onClose,
  onDiscard,
  onSaved,
}: {
  draft: ResourceDraft;
  onChange: (draft: ResourceDraft) => void;
  onClose: () => void;
  onDiscard: () => void;
  onSaved: (detail: ResourceDetail) => void;
}) {
  const { session } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false),
    saving = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { operation, source, values, phase } = draft;
  const locked = busy || phase !== 'editing';
  const closure = source?.closures.find((entry) => entry.id === draft.closureId);
  const metadataForm = operation === 'create' || operation === 'edit';
  const normalized = {
    name: values.name.trim(),
    location: values.location.trim(),
    notes: values.notes.trim(),
  };
  const changed =
    operation !== 'edit' ||
    !source ||
    Object.entries(normalized).some(
      ([key, value]) => value !== source.resource[key as keyof typeof normalized],
    );
  const blocked =
    (operation === 'maintenance' && source?.resource.active === false) ||
    (operation === 'cancel-maintenance' && (!closure || !!closure.cancellation)) ||
    (operation === 'archive' && source?.resource.active === false) ||
    (operation === 'restore' && source?.resource.active === true);
  function update(change: Partial<Values>) {
    onChange({ ...draft, values: { ...values, ...change }, error: '' });
  }
  function prepare(): Attempt {
    if (operation === 'create') {
      if (!normalized.name) throw new Error('Enter a resource name.');
      return {
        path: '/api/clinic-resources',
        method: 'POST',
        body: {
          name: normalized.name,
          kind: values.kind,
          location: normalized.location,
          notes: normalized.notes,
          requestId: draft.requestId,
        },
      };
    }
    if (!source) throw new Error('Refresh the resource before saving.');
    if (!values.reason.trim() || values.reason.trim().length > 1000)
      throw new Error('Enter a reason of 1–1,000 characters.');
    if (blocked)
      throw new Error(
        'The resource or maintenance status changed. Cancel this draft and review its latest history.',
      );
    const base = `/api/clinic-resources/${encodeURIComponent(source.resource.id)}`;
    const common = {
      reason: values.reason.trim(),
      expectedRevision: source.resource.revision,
      requestId: draft.requestId,
    };
    if (operation === 'maintenance') {
      if (
        !realDate(values.startDate) ||
        !realDate(values.endDate) ||
        values.startDate < today() ||
        values.endDate < values.startDate ||
        values.endDate > shiftDate(today(), 365)
      )
        throw new Error('Choose ordered maintenance dates from today through one year ahead.');
      if (
        !values.allDay &&
        (!timeValue(values.startTime) ||
          !timeValue(values.endTime) ||
          values.startTime >= values.endTime)
      )
        throw new Error(
          'Choose a daily end time later than its start time. Overnight intervals are not supported.',
        );
      return {
        path: `${base}/closures`,
        method: 'POST',
        body: {
          ...common,
          startDate: values.startDate,
          endDate: values.endDate,
          startTime: values.allDay ? null : values.startTime,
          endTime: values.allDay ? null : values.endTime,
        },
      };
    }
    if (operation === 'cancel-maintenance')
      return {
        path: `${base}/closures/${encodeURIComponent(draft.closureId!)}/cancel`,
        method: 'POST',
        body: common,
      };
    if (operation === 'edit') {
      if (!normalized.name) throw new Error('Enter a resource name.');
      if (!changed) throw new Error('Change at least one resource detail before saving.');
      return { path: base, method: 'PATCH', body: { ...normalized, ...common } };
    }
    return { path: base, method: 'PATCH', body: { ...common, active: operation === 'restore' } };
  }
  function confirm(value: unknown, submitted: Attempt) {
    const detail = checkedDetail(value, source?.resource.id);
    const body = submitted.body;
    const matchingMetadata = (snapshot: ResourceMetadata) =>
      ['name', 'kind', 'location', 'notes', 'active'].every(
        (key) => !(key in body) || snapshot[key as keyof ResourceMetadata] === body[key],
      );
    if (
      source &&
      (detail.resource.kind !== source.resource.kind ||
        detail.resource.revision === source.resource.revision)
    )
      throw new Error(
        'The response did not confirm a new change to this resource. Retry the same request.',
      );
    if (operation === 'create' || ['edit', 'archive', 'restore'].includes(operation)) {
      if (
        !detail.changes.some(
          (entry) =>
            (operation === 'create'
              ? entry.before === null
              : !source!.changes.some((previous) => previous.id === entry.id) &&
                entry.reason === body.reason) &&
            entry.createdById === session.user?.id &&
            entry.requestId === body.requestId &&
            matchingMetadata(entry.after),
        )
      )
        throw new Error(
          'The response did not confirm the submitted resource values. Retry the same request.',
        );
    } else if (operation === 'maintenance') {
      if (
        !detail.closures.some(
          (entry) =>
            !source!.closures.some((previous) => previous.id === entry.id) &&
            entry.createdById === session.user?.id &&
            entry.requestId === body.requestId &&
            ['startDate', 'endDate', 'startTime', 'endTime', 'reason'].every(
              (key) => entry[key as keyof ResourceClosure] === body[key],
            ),
        )
      )
        throw new Error(
          'The response did not confirm the submitted maintenance block. Retry the same request.',
        );
    } else {
      const cancelled = detail.closures.find((entry) => entry.id === draft.closureId)?.cancellation;
      if (
        !cancelled ||
        cancelled.reason !== body.reason ||
        cancelled.createdById !== session.user?.id ||
        cancelled.requestId !== body.requestId ||
        cancelled.id === closure?.cancellation?.id
      )
        throw new Error(
          'The response did not confirm the maintenance cancellation. Retry the same request.',
        );
    }
    return detail;
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving.current || phase === 'conflict') return;
    let attempt: Attempt;
    try {
      attempt = draft.attempt ?? prepare();
    } catch (problem) {
      onChange({ ...draft, error: failure(problem) });
      return;
    }
    saving.current = true;
    setBusy(true);
    onChange({ ...draft, attempt, error: '' });
    try {
      const detail = confirm(
        await api<unknown>(attempt.path, { method: attempt.method, body: attempt.body }),
        attempt,
      );
      if (!mounted.current) return;
      toast(
        operation === 'maintenance'
          ? 'Maintenance recorded. Existing appointments were preserved.'
          : operation === 'cancel-maintenance'
            ? 'Maintenance cancelled. Its original record remains in history.'
            : 'Resource record saved.',
      );
      onSaved(detail);
    } catch (problem) {
      if (!mounted.current) return;
      const error = failure(problem);
      if (problem instanceof ApiError && [400, 403, 404, 422].includes(problem.status))
        onChange({ ...draft, phase: 'editing', attempt: null, error });
      else if (
        problem instanceof ApiError &&
        problem.status === 409 &&
        !/request.*(?:used|different|already)|idempot/i.test(error)
      )
        onChange({
          ...draft,
          phase: source ? 'conflict' : 'editing',
          attempt: source ? attempt : null,
          reviewed: null,
          error,
        });
      else onChange({ ...draft, phase: 'uncertain', attempt, error });
    } finally {
      saving.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function refresh() {
    if (saving.current || !source) return;
    saving.current = true;
    setBusy(true);
    try {
      const reviewed = checkedDetail(
        await api<unknown>(`/api/clinic-resources/${encodeURIComponent(source.resource.id)}`),
        source.resource.id,
      );
      if (mounted.current) onChange({ ...draft, reviewed, error: '' });
    } catch (problem) {
      if (mounted.current) onChange({ ...draft, error: failure(problem) });
    } finally {
      saving.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <Modal
      title={operationTitles[operation]}
      onClose={() => {
        if (!saving.current) onClose();
      }}
    >
      <form className="stack crp-entry-form" onSubmit={submit}>
        {source && (
          <p className="notice">
            <strong>{source.resource.name}</strong>
          </p>
        )}
        {metadataForm && (
          <>
            <Field label="Resource name">
              <input
                required
                maxLength={100}
                disabled={locked}
                value={values.name}
                onChange={(event) => update({ name: event.target.value })}
              />
            </Field>
            {operation === 'create' ? (
              <Field
                label="Resource type"
                hint="Each entry represents one physical room or equipment unit. Type stays fixed after creation."
              >
                <select
                  value={values.kind}
                  disabled={locked}
                  onChange={(event) => update({ kind: event.target.value as Values['kind'] })}
                >
                  <option value="room">Room</option>
                  <option value="equipment">Equipment</option>
                </select>
              </Field>
            ) : (
              <p className="crp-help">
                {kindLabel(values.kind)} · Single unit. Resource type remains unchanged.
              </p>
            )}
            <Field label="Location">
              <input
                maxLength={200}
                disabled={locked}
                value={values.location}
                onChange={(event) => update({ location: event.target.value })}
                placeholder="e.g. Ground floor, consultation area"
              />
            </Field>
            <Field
              label="Operational notes"
              hint="Location, setup or handling information for clinic staff."
            >
              <textarea
                rows={3}
                maxLength={1000}
                disabled={locked}
                value={values.notes}
                onChange={(event) => update({ notes: event.target.value })}
              />
            </Field>
          </>
        )}
        {(operation === 'archive' || operation === 'restore') && (
          <p className="crp-help">
            {operation === 'archive'
              ? 'Archiving stops new allocations and preserves this resource’s history. Open allocations must first be released or moved, including stale past visits; retained future completed intervals also prevent archiving.'
              : 'Restoring allows staff to select this resource again. Existing maintenance blocks still apply.'}
          </p>
        )}
        {operation === 'maintenance' && (
          <>
            <div className="form-grid">
              <Field label="Start date">
                <input
                  required
                  type="date"
                  min={today()}
                  max={shiftDate(today(), 365)}
                  value={values.startDate}
                  disabled={locked}
                  onChange={(event) => update({ startDate: event.target.value })}
                />
              </Field>
              <Field label="End date">
                <input
                  required
                  type="date"
                  min={values.startDate > today() ? values.startDate : today()}
                  max={shiftDate(today(), 365)}
                  value={values.endDate}
                  disabled={locked}
                  onChange={(event) => update({ endDate: event.target.value })}
                />
              </Field>
            </div>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={values.allDay}
                disabled={locked}
                onChange={(event) => update({ allDay: event.target.checked })}
              />
              All day on each included date
            </label>
            {!values.allDay && (
              <div className="form-grid">
                <Field label="Daily start time">
                  <input
                    required
                    type="time"
                    value={values.startTime}
                    disabled={locked}
                    onChange={(event) => update({ startTime: event.target.value })}
                  />
                </Field>
                <Field label="Daily end time">
                  <input
                    required
                    type="time"
                    value={values.endTime}
                    disabled={locked}
                    onChange={(event) => update({ endTime: event.target.value })}
                  />
                </Field>
              </div>
            )}
            <p className="notice">
              The same time interval repeats on every included date, in Asia/Kolkata. Maintenance
              cannot replace an existing reservation. No appointment is automatically cancelled or
              rescheduled.
            </p>
          </>
        )}
        {operation === 'cancel-maintenance' && closure && (
          <section className="crp-snapshot">
            <h3>{maintenanceDates(closure)}</h3>
            <p className="crp-help">{maintenanceTimes(closure)}</p>
            <p className="crp-prose">{closure.reason}</p>
            <p className="crp-help">
              Cancellation removes this block while preserving its original details and the
              cancellation reason.
            </p>
          </section>
        )}
        {operation !== 'create' && (
          <Field
            label={
              operation === 'maintenance'
                ? 'Reason for maintenance'
                : operation === 'cancel-maintenance'
                  ? 'Reason for cancelling maintenance'
                  : operation === 'archive'
                    ? 'Reason for archiving'
                    : operation === 'restore'
                      ? 'Reason for restoring'
                      : 'Reason for change'
            }
            hint="Preserved in the resource’s staff-visible history."
          >
            <textarea
              required
              rows={3}
              maxLength={1000}
              disabled={locked}
              value={values.reason}
              onChange={(event) => update({ reason: event.target.value })}
            />
          </Field>
        )}
        {draft.error && (
          <div className="notice notice-error" role="alert">
            {draft.error}
          </div>
        )}
        {blocked && (
          <p className="notice">
            The resource or maintenance status has changed. Cancel this draft and inspect the latest
            history before preparing another change.
          </p>
        )}
        {operation === 'edit' && !changed && phase === 'editing' && (
          <p className="crp-help">
            Change a resource detail before saving. A reason alone does not create an update.
          </p>
        )}
        {phase === 'uncertain' && (
          <div className="notice crp-retry">
            <strong>The save outcome could not be confirmed.</strong>
            <p>
              Your exact submitted values and request ID are retained. Retry the same request to
              check its outcome without creating another change. You can close for now and resume
              while this page remains open.
            </p>
          </div>
        )}
        {phase === 'conflict' && (
          <div className="notice crp-conflict">
            <strong>Review the resource before trying again.</strong>
            <p>
              Your draft is preserved. The catalogue, maintenance or reservations may have changed.
              Resolve conflicting appointment allocations before archiving or adding maintenance.
            </p>
            {draft.reviewed ? (
              <>
                <ResourceSnapshot value={draft.reviewed.resource} title="Latest saved resource" />
                <p className="crp-help">
                  {draft.reviewed.closures.filter((entry) => !entry.cancellation).length}{' '}
                  uncancelled maintenance blocks are recorded. Inspect the resource diary for their
                  dates and reservations.
                </p>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={busy}
                  onClick={() =>
                    onChange({
                      ...draft,
                      source: draft.reviewed,
                      reviewed: null,
                      phase: 'editing',
                      attempt: null,
                      requestId: crypto.randomUUID(),
                      error: '',
                    })
                  }
                >
                  I reviewed the latest resource; keep my draft
                </button>
              </>
            ) : (
              <button
                type="button"
                className="button button-secondary"
                disabled={busy}
                onClick={refresh}
              >
                <RefreshCw size={15} />
                Refresh resource context
              </button>
            )}
            {source && (
              <p>
                <Link
                  className="text-link"
                  to={resourceHref(
                    source.resource.id,
                    operation === 'maintenance' ? values.startDate : today(),
                  )}
                  onClick={onClose}
                >
                  Review reservations and maintenance <ArrowUpRight size={13} />
                </Link>
              </p>
            )}
          </div>
        )}
        <div className="crp-form-actions">
          <button
            type="button"
            className="button button-secondary"
            disabled={busy}
            onClick={onClose}
          >
            Close for now
          </button>
          {phase === 'editing' && !draft.attempt && (
            <button
              type="button"
              className="button button-ghost"
              disabled={busy}
              onClick={onDiscard}
            >
              Cancel draft
            </button>
          )}
          <button
            className="button button-primary"
            disabled={
              busy ||
              phase === 'conflict' ||
              (phase === 'editing' &&
                (blocked || !changed || (operation !== 'create' && !values.reason.trim())))
            }
          >
            {busy
              ? 'Saving…'
              : phase === 'uncertain'
                ? 'Retry same request'
                : operationActions[operation]}
          </button>
        </div>
      </form>
    </Modal>
  );
}
