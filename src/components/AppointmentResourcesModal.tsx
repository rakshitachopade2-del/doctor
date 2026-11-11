import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Box, DoorOpen, RefreshCw } from 'lucide-react';
import type {
  AppointmentResourceContext,
  ResourceAllocationSnapshot,
  ResourceAppointment,
} from '../../shared/clinic-resources';
import { api, ApiError, formatDate, useSession, useToast } from '../lib';
import { Badge, EmptyState, ErrorState, Field, Loading, Modal } from './ui';
import './appointment-resources.css';

type Props = { appointmentId: string; onClose: () => void; onSaved: () => Promise<void> };
type AllocationBody = {
  resourceIds: string[];
  reason: string;
  expectedRevision: string;
  requestId: string;
};
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const nonempty = (value: unknown): value is string => text(value) && !!value.trim();
const validStamp = (value: unknown) => nonempty(value) && Number.isFinite(Date.parse(value));
const revision = (value: unknown) => text(value) && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown) =>
  text(value) && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const errorText = (problem: unknown) =>
  problem instanceof Error
    ? problem.message
    : 'The resource reservation could not be confirmed. Please try again.';
const sameIds = (a: string[], b: string[]) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const uniqueIds = (values: { id: string }[]) =>
  new Set(values.map((value) => value.id)).size === values.length;
function validAppointment(value: unknown, id: string) {
  return (
    record(value) &&
    value.id === id &&
    ['patientId', 'patientName', 'doctorId', 'doctorName'].every((key) => nonempty(value[key])) &&
    text(value.date) &&
    /^\d{4}-\d{2}-\d{2}$/.test(value.date) &&
    validStamp(value.date) &&
    text(value.time) &&
    /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time) &&
    ['in-person', 'online'].includes(value.mode as string) &&
    ['scheduled', 'checked-in', 'in-consultation', 'completed', 'cancelled', 'no-show'].includes(
      value.status as string,
    ) &&
    Number.isSafeInteger(value.durationMinutes) &&
    Number(value.durationMinutes) > 0 &&
    Number(value.durationMinutes) <= 1440
  );
}
function validSnapshot(value: unknown, id: string) {
  return (
    record(value) &&
    validAppointment(value.appointment, id) &&
    Array.isArray(value.resources) &&
    value.resources.length <= 8 &&
    value.resources.every(
      (resource) =>
        record(resource) &&
        nonempty(resource.id) &&
        nonempty(resource.name) &&
        ['room', 'equipment'].includes(resource.kind as string) &&
        text(resource.location),
    ) &&
    uniqueIds(value.resources)
  );
}
function checkedContext(value: unknown, id: string): AppointmentResourceContext {
  if (
    !record(value) ||
    !validAppointment(value.appointment, id) ||
    !revision(value.revision) ||
    typeof value.canAllocate !== 'boolean' ||
    typeof value.canRelease !== 'boolean' ||
    !Array.isArray(value.resourceIds) ||
    !value.resourceIds.every(nonempty) ||
    value.resourceIds.length > 8 ||
    new Set(value.resourceIds).size !== value.resourceIds.length ||
    !Array.isArray(value.resources) ||
    !value.resources.every(
      (row) =>
        record(row) &&
        record(row.resource) &&
        nonempty(row.resource.id) &&
        nonempty(row.resource.name) &&
        ['room', 'equipment'].includes(row.resource.kind as string) &&
        row.resource.capacity === 1 &&
        text(row.resource.location) &&
        text(row.resource.notes) &&
        typeof row.resource.active === 'boolean' &&
        revision(row.resource.revision) &&
        validStamp(row.resource.createdAt) &&
        validStamp(row.resource.updatedAt) &&
        typeof row.available === 'boolean' &&
        ['available', 'inactive', 'maintenance', 'reserved'].includes(row.reason as string) &&
        row.available === (row.reason === 'available'),
    ) ||
    !uniqueIds(value.resources.map((row) => row.resource)) ||
    !value.resourceIds.every((resourceId) =>
      (value.resources as { resource: { id: string } }[]).some(
        (row) => row.resource.id === resourceId,
      ),
    ) ||
    !Array.isArray(value.history) ||
    !value.history.every(
      (event) =>
        record(event) &&
        nonempty(event.id) &&
        event.appointmentId === id &&
        ['staff-allocation', 'appointment-rescheduled', 'appointment-status'].includes(
          event.source as string,
        ) &&
        validSnapshot(event.before, id) &&
        validSnapshot(event.after, id) &&
        nonempty(event.reason) &&
        nonempty(event.createdById) &&
        nonempty(event.createdByName) &&
        ['admin', 'doctor', 'receptionist', 'patient'].includes(event.createdByRole as string) &&
        validStamp(event.createdAt) &&
        (event.source === 'staff-allocation' ? uuid(event.requestId) : event.requestId === null),
    ) ||
    !uniqueIds(value.history)
  )
    throw new Error(
      'The response did not contain a complete appointment resource record. Retry to check its outcome.',
    );
  return value as unknown as AppointmentResourceContext;
}
const stamp = (value: string) =>
  new Date(value).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
function interval(appointment: ResourceAppointment) {
  const startTime = new Date(`${appointment.date}T${appointment.time}:00+05:30`).toLocaleTimeString(
    'en-IN',
    {
      timeZone: 'Asia/Kolkata',
      hour: 'numeric',
      minute: '2-digit',
    },
  );
  const end = new Date(
    Date.parse(`${appointment.date}T${appointment.time}:00+05:30`) +
      appointment.durationMinutes * 60000,
  );
  const endTime = end.toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${formatDate(appointment.date)} · ${startTime}–${endTime} IST · ${appointment.durationMinutes} min`;
}
const availabilityLabels = {
  available: 'Available for this interval',
  inactive: 'Archived resource',
  maintenance: 'Maintenance overlaps this interval',
  reserved: 'Reserved for another appointment',
};
const historyLabels = {
  'staff-allocation': 'Resource allocation updated',
  'appointment-rescheduled': 'Appointment rescheduled',
  'appointment-status': 'Appointment status changed',
};
function Snapshot({ value, label }: { value: ResourceAllocationSnapshot; label: string }) {
  return (
    <section className="ar-snapshot">
      <h4>{label}</h4>
      <p>{interval(value.appointment)}</p>
      <p className="muted small">
        {value.appointment.doctorName} ·{' '}
        {value.appointment.mode === 'online' ? 'Online' : 'In clinic'} ·{' '}
        {value.appointment.status.replaceAll('-', ' ')}
      </p>
      {value.resources.length ? (
        <ul>
          {value.resources.map((resource) => (
            <li key={resource.id}>
              <strong>{resource.name}</strong>
              {resource.location ? ` · ${resource.location}` : ''}
              <span className="muted small"> ({resource.kind})</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">No resources reserved.</p>
      )}
    </section>
  );
}
function AppointmentSnapshot({
  context,
  fresh = false,
}: {
  context: AppointmentResourceContext;
  fresh?: boolean;
}) {
  return (
    <section
      className="ar-appointment"
      aria-label={fresh ? 'Latest appointment resource context' : 'Appointment resource context'}
    >
      {fresh && <h3>Latest appointment and availability</h3>}
      <h3>{context.appointment.patientName}</h3>
      <p>
        {context.appointment.doctorName} ·{' '}
        {context.appointment.mode === 'online' ? 'Online visit' : 'In-clinic visit'}
      </p>
      <p>{interval(context.appointment)}</p>
      <Badge>{context.appointment.status.replaceAll('-', ' ')}</Badge>
      <p className="ar-help">
        Reservations cover the recorded appointment interval. They do not track live room occupancy
        or equipment use.
      </p>
      <p className="ar-help">
        Currently reserved:{' '}
        {context.resourceIds.length
          ? context.resourceIds
              .map((id) => context.resources.find((row) => row.resource.id === id)!.resource.name)
              .join(', ')
          : 'None'}
      </p>
    </section>
  );
}

export function AppointmentResourcesModal(props: Props) {
  const { session } = useSession();
  return <ResourceDialog key={`${session.user?.id}:${props.appointmentId}`} {...props} />;
}
function ResourceDialog({ appointmentId, onClose, onSaved }: Props) {
  const { session } = useSession();
  const toast = useToast();
  const [source, setSource] = useState<AppointmentResourceContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [phase, setPhase] = useState<'editing' | 'conflict' | 'uncertain'>('editing');
  const [attempt, setAttempt] = useState<AllocationBody | null>(null);
  const [reviewed, setReviewed] = useState<AppointmentResourceContext | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [closeBlocked, setCloseBlocked] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(false);
  const loadSequence = useRef(0);
  const path = `/api/appointments/${encodeURIComponent(appointmentId)}/resources`;
  async function initialLoad() {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setLoadError('');
    try {
      const next = checkedContext(await api<unknown>(path), appointmentId);
      if (mounted.current && sequence === loadSequence.current) {
        setSource(next);
        setSelected(next.resourceIds);
      }
    } catch (problem) {
      if (mounted.current && sequence === loadSequence.current) setLoadError(errorText(problem));
    } finally {
      if (mounted.current && sequence === loadSequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    void initialLoad();
    return () => {
      mounted.current = false;
      loadSequence.current++;
    };
  }, []);
  function close() {
    if (pending.current || phase === 'uncertain') {
      setCloseBlocked(true);
      return;
    }
    onClose();
  }
  async function refreshContext() {
    if (pending.current || refreshing) return;
    setRefreshing(true);
    setPhase('conflict');
    setError('');
    try {
      const next = checkedContext(await api<unknown>(path), appointmentId);
      if (mounted.current) setReviewed(next);
    } catch (problem) {
      if (mounted.current) setError(errorText(problem));
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }
  function acceptContext() {
    if (!reviewed) return;
    setSource(reviewed);
    setReviewed(null);
    setPhase('editing');
    setAttempt(null);
    setError('');
    setCloseBlocked(false);
  }
  const editable = !!source && (source.canAllocate || source.canRelease);
  const locked = busy || phase !== 'editing';
  const unchanged = !!source && sameIds(source.resourceIds, selected);
  const selectionAvailable =
    !!source &&
    (selected.length
      ? source.canAllocate &&
        selected.length <= 8 &&
        selected.every((id) =>
          source.resources.some((row) => row.resource.id === id && row.available),
        )
      : source.canRelease);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!source || pending.current || phase === 'conflict') return;
    if (!attempt && (!editable || unchanged || !selectionAvailable || !reason.trim())) {
      setError(
        'Choose an available resource set, or clear the existing reservations, and enter a reason.',
      );
      return;
    }
    const submitted = attempt ?? {
      resourceIds: [...selected].sort(),
      reason: reason.trim(),
      expectedRevision: source.revision,
      requestId: crypto.randomUUID(),
    };
    setAttempt(submitted);
    pending.current = true;
    setBusy(true);
    setError('');
    let saved: AppointmentResourceContext;
    try {
      saved = checkedContext(
        await api<unknown>(path, { method: 'PUT', body: submitted }),
        appointmentId,
      );
      if (
        saved.appointment.patientId !== source.appointment.patientId ||
        !saved.history.some(
          (event) =>
            event.source === 'staff-allocation' &&
            event.requestId === submitted.requestId &&
            event.createdById === session.user?.id &&
            !source.history.some((previous) => previous.id === event.id) &&
            event.reason === submitted.reason &&
            sameIds(
              event.after.resources.map((resource) => resource.id),
              submitted.resourceIds,
            ),
        )
      )
        throw new Error(
          'The response did not confirm this resource allocation. Retry the same request to check its outcome.',
        );
    } catch (problem) {
      if (mounted.current) {
        setError(errorText(problem));
        if (
          problem instanceof ApiError &&
          problem.status === 409 &&
          !/request.*(?:already|different|used)|idempot/i.test(errorText(problem))
        ) {
          setPhase('conflict');
          setReviewed(null);
        } else if (
          problem instanceof ApiError &&
          [400, 403, 404, 422, 429].includes(problem.status)
        ) {
          setPhase('editing');
          setAttempt(null);
        } else setPhase('uncertain');
      }
      return;
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
    if (!mounted.current) return;
    setSource(saved);
    setSelected(saved.resourceIds);
    setReason('');
    setAttempt(null);
    setReviewed(null);
    setPhase('editing');
    setCloseBlocked(false);
    toast(
      submitted.resourceIds.length
        ? 'Appointment resource reservations saved.'
        : 'Appointment resource reservations released.',
    );
    try {
      await onSaved();
    } catch {
      if (mounted.current)
        setError(
          'The reservation update was saved. The appointment list could not be refreshed; reopen it to see the latest state.',
        );
    }
  }
  const display = reviewed ?? source;
  return (
    <Modal title="Appointment resources" onClose={close}>
      <div className="stack appointment-resources-dialog">
        {loading ? (
          <Loading />
        ) : loadError || !source ? (
          <ErrorState
            message={loadError || 'The appointment resource record is unavailable.'}
            retry={initialLoad}
          />
        ) : (
          <>
            {display && <AppointmentSnapshot context={display} fresh={!!reviewed} />}
            {!editable && phase === 'editing' && (
              <p className="notice ar-readonly">
                This appointment is not available for resource changes. Recorded reservations and
                history remain readable.
              </p>
            )}
            {editable && !source.canAllocate && (
              <p className="notice">
                The allocation window has ended. You can clear all reservations on this open
                appointment, but cannot add or replace resources.
              </p>
            )}
            <form className="stack ar-allocation-form" onSubmit={save}>
              <fieldset className="ar-resource-fieldset" disabled={locked || !source.canAllocate}>
                <legend>Rooms and equipment</legend>
                <p className="ar-help">
                  Select up to 8 individual resources. Each room or equipment unit can be reserved
                  for only one appointment at a time.
                </p>
                {display?.resources.length ? (
                  <div className="ar-resource-options">
                    {display.resources.map(({ resource, available, reason: availability }) => {
                      const checked = (editable ? selected : source.resourceIds).includes(
                        resource.id,
                      );
                      return (
                        <label
                          className={`ar-resource-option ${!available ? 'ar-unavailable' : ''}`}
                          key={resource.id}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={
                              locked ||
                              !source.canAllocate ||
                              (!checked && (!available || selected.length >= 8))
                            }
                            onChange={(event) =>
                              setSelected((current) =>
                                event.target.checked
                                  ? [...current, resource.id]
                                  : current.filter((id) => id !== resource.id),
                              )
                            }
                          />
                          <span className="ar-resource-option-copy">
                            <strong>
                              {resource.kind === 'room' ? (
                                <DoorOpen size={16} />
                              ) : (
                                <Box size={16} />
                              )}
                              {resource.name}
                            </strong>
                            <span>
                              {resource.kind === 'room' ? 'Room' : 'Equipment'}
                              {resource.location ? ` · ${resource.location}` : ''}
                            </span>
                            <small>{availabilityLabels[availability]}</small>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                ) : (
                  <EmptyState
                    title="No clinic resources yet"
                    description="An administrator can add individual rooms and equipment units in Rooms & equipment."
                  />
                )}
              </fieldset>
              {editable && (
                <>
                  <div className="ar-selection-actions">
                    <p className="muted small">{selected.length} of 8 selected</p>
                    <button
                      type="button"
                      className="button button-secondary button-small"
                      disabled={locked || !selected.length || !source.canRelease}
                      onClick={() => setSelected([])}
                    >
                      Clear all reservations
                    </button>
                    <button
                      type="button"
                      className="button button-ghost button-small"
                      disabled={locked || refreshing}
                      onClick={refreshContext}
                    >
                      <RefreshCw size={14} />
                      Refresh availability
                    </button>
                  </div>
                  <Field
                    label="Reason for allocation change"
                    hint="Operational context for clinic staff. Do not include clinical findings."
                  >
                    <textarea
                      required
                      rows={3}
                      maxLength={1000}
                      value={reason}
                      disabled={locked}
                      onChange={(event) => setReason(event.target.value)}
                    />
                  </Field>
                </>
              )}
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
              {phase === 'conflict' && (
                <div className="notice ar-conflict">
                  <strong>Review current availability before saving.</strong>
                  <p>
                    Your selected resources and reason are preserved. The appointment, resources,
                    maintenance or another reservation may have changed.
                  </p>
                  {reviewed ? (
                    <>
                      <p>
                        Read the latest appointment and availability above. Remove unavailable
                        selections or clear the set if only releasing remains allowed.
                      </p>
                      <button
                        type="button"
                        className="button button-secondary"
                        onClick={acceptContext}
                      >
                        I reviewed current availability; keep my draft
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={refreshing}
                      onClick={refreshContext}
                    >
                      {refreshing ? 'Refreshing availability…' : 'Refresh allocation context'}
                    </button>
                  )}
                </div>
              )}
              {phase === 'uncertain' && (
                <div className="notice ar-uncertain">
                  <strong>The save outcome could not be confirmed.</strong>
                  <p>
                    The exact resource set and request ID are locked. Retry the same request to
                    check its outcome without saving it twice. This draft is held only while this
                    page stays open; keep it open until the outcome is confirmed.
                  </p>
                </div>
              )}
              {closeBlocked && (
                <p className="notice" role="status">
                  {busy
                    ? 'Wait for the save response before closing.'
                    : 'Retry the pending request to confirm its outcome before closing.'}
                </p>
              )}
              {(editable || phase !== 'editing') && (
                <div className="ar-form-actions">
                  <button
                    className="button button-primary"
                    disabled={
                      busy ||
                      phase === 'conflict' ||
                      (phase === 'editing' && (unchanged || !selectionAvailable || !reason.trim()))
                    }
                  >
                    {busy
                      ? 'Saving reservations…'
                      : phase === 'uncertain'
                        ? 'Retry same request'
                        : 'Save resource reservations'}
                  </button>
                </div>
              )}
            </form>
            <section className="ar-allocation-history" aria-label="Resource reservation history">
              <h3>Reservation history</h3>
              <p className="ar-help">
                Recorded names and intervals are preserved. Newest entries appear first.
              </p>
              {display?.history.length ? (
                display.history.map((event) => (
                  <article key={event.id} className="ar-history-event">
                    <h4>{historyLabels[event.source]}</h4>
                    <p className="ar-attribution">
                      {event.createdByName} · {stamp(event.createdAt)} IST
                    </p>
                    <p className="pre-line">{event.reason}</p>
                    <details>
                      <summary>View reservations before and after</summary>
                      <div className="ar-snapshot-grid">
                        <Snapshot value={event.before} label="Before" />
                        <Snapshot value={event.after} label="After" />
                      </div>
                    </details>
                  </article>
                ))
              ) : (
                <p className="muted small">No resource allocation changes have been recorded.</p>
              )}
            </section>
          </>
        )}
        <button
          type="button"
          className="button button-secondary ar-close"
          disabled={busy || phase === 'uncertain'}
          onClick={close}
        >
          Close resources
        </button>
      </div>
    </Modal>
  );
}
