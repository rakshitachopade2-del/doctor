import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import type { Doctor } from '../../shared/types';
import type { DoctorBookingContext } from '../../shared/doctor-booking';
import { api, ApiError, useSession, useToast } from '../lib';
import { Badge, ErrorState, Field, Loading, Modal } from './ui';
import { Pagination } from './Pagination';
import {
  checkedDoctorBookingContext,
  checkedDoctorBookingHistory,
  checkedDoctorBookingMutation,
  doctorBookingFailure,
  doctorBookingLabel,
  doctorBookingStale,
  doctorBookingStamp,
  useDoctorBookingData,
  useDoctorBookingGuard,
  type DoctorBookingAttempt,
} from './doctor-booking-helpers';
import './doctor-booking.css';

export function DoctorBookingBadge({ accepting }: { accepting: boolean }) {
  return <Badge tone={accepting ? 'green' : 'amber'}>{doctorBookingLabel(accepting)}</Badge>;
}

function BookingSource({ context }: { context: DoctorBookingContext }) {
  return (
    <div className="doctor-booking-source stack">
      <h3>{context.doctor.name}</h3>
      <div>
        <DoctorBookingBadge accepting={context.acceptingNewBookings} />
      </div>
      {context.latestChange ? (
        <>
          <p className="muted small">
            Last changed by {context.latestChange.createdByName} ·{' '}
            {doctorBookingStamp(context.latestChange.createdAt)} IST
          </p>
          <p className="doctor-booking-reason">{context.latestChange.reason}</p>
        </>
      ) : (
        <p className="muted small">
          This profile uses the default accepting status. No booking-status changes have been
          recorded.
        </p>
      )}
    </div>
  );
}

/** The safe badge is public information; context, controls and history are administrator-only. */
export function DoctorBookingStatusControls({
  doctor,
  onSaved,
}: {
  doctor: Doctor;
  onSaved: () => void;
}) {
  const location = useLocation(),
    { session } = useSession();
  const [action, setAction] = useState<{
    kind: 'edit' | 'history';
    key: string;
    desired: boolean;
  } | null>(null);
  useLayoutEffect(() => setAction(null), [doctor.id, location.key]);
  const accepting = doctor.acceptingNewBookings !== false;
  return (
    <div className="doctor-booking-controls">
      <DoctorBookingBadge accepting={accepting} />
      {session.user?.role === 'admin' && (
        <>
          <div className="doctor-booking-actions">
            <button
              type="button"
              className="button button-secondary button-small"
              onClick={() => setAction({ kind: 'edit', key: location.key, desired: !accepting })}
            >
              {accepting ? 'Pause new bookings' : 'Resume new bookings'}
            </button>
            <button
              type="button"
              className="button button-ghost button-small"
              onClick={() => setAction({ kind: 'history', key: location.key, desired: accepting })}
            >
              Booking-status history
            </button>
          </div>
          {action?.key === location.key &&
            (action.kind === 'edit' ? (
              <DoctorBookingEditor
                key={`booking-editor:${doctor.id}:${action.key}`}
                doctorId={doctor.id}
                desired={action.desired}
                onClose={() => setAction(null)}
                onSaved={() => {
                  setAction(null);
                  onSaved();
                }}
              />
            ) : (
              <DoctorBookingHistory
                key={`booking-history:${doctor.id}:${action.key}`}
                doctorId={doctor.id}
                onClose={() => setAction(null)}
              />
            ))}
        </>
      )}
    </div>
  );
}

function DoctorBookingEditor({
  doctorId,
  desired,
  onClose,
  onSaved,
}: {
  doctorId: string;
  desired: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const resource = useDoctorBookingData(
    `/api/doctors/${encodeURIComponent(doctorId)}/booking-status`,
    (value) => checkedDoctorBookingContext(value, doctorId),
  );
  if (resource.loading || resource.error || !resource.data)
    return (
      <Modal title="Manage booking status" onClose={onClose}>
        {resource.loading ? (
          <Loading />
        ) : (
          <ErrorState
            message={resource.error || 'Booking status is unavailable.'}
            retry={resource.reload}
          />
        )}
      </Modal>
    );
  return (
    <DoctorBookingDraft
      initial={resource.data}
      desired={desired}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}

function DoctorBookingDraft({
  initial,
  desired,
  onClose,
  onSaved,
}: {
  initial: DoctorBookingContext;
  desired: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { session } = useSession(),
    toast = useToast(),
    guard = useDoctorBookingGuard();
  const pending = useRef(false);
  const [source, setSource] = useState(initial),
    [accepting, setAccepting] = useState(desired),
    [reason, setReason] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [phase, setPhase] = useState<'editing' | 'conflict' | 'uncertain'>('editing'),
    [attempt, setAttempt] = useState<DoctorBookingAttempt | null>(null),
    [reviewed, setReviewed] = useState<DoctorBookingContext | null>(null),
    [busy, setBusy] = useState<'save' | 'refresh' | null>(null),
    [error, setError] = useState('');
  const locked = !!busy || phase !== 'editing';
  const changed = accepting !== source.acceptingNewBookings;
  function close() {
    if (!pending.current && !busy && phase !== 'uncertain') onClose();
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || phase === 'conflict' || session.user?.role !== 'admin') return;
    const uncertain = phase === 'uncertain';
    if (!uncertain && (!confirmed || !reason.trim() || !changed)) return;
    const sent = attempt ?? {
      source,
      actorId: session.user.id,
      body: {
        acceptingNewBookings: accepting,
        reason: reason.trim(),
        expectedRevision: source.revision,
        requestId: crypto.randomUUID(),
      },
    };
    const current = guard();
    pending.current = true;
    setAttempt(sent);
    setPhase('uncertain');
    setBusy('save');
    setError('');
    try {
      const raw = await api<unknown>(
        `/api/doctors/${encodeURIComponent(source.doctor.id)}/booking-status`,
        { method: 'POST', body: sent.body, isCurrent: current },
      );
      if (!current()) return;
      checkedDoctorBookingMutation(raw, sent);
      onSaved();
      toast('Doctor booking status saved.');
    } catch (cause) {
      if (!current()) return;
      setError(doctorBookingFailure(cause));
      if (
        cause instanceof ApiError &&
        cause.status === 409 &&
        cause.message === doctorBookingStale
      ) {
        setPhase('conflict');
        setAttempt(null);
        setReviewed(null);
        setConfirmed(false);
      } else if (
        !uncertain &&
        cause instanceof ApiError &&
        [400, 403, 404, 413, 422, 429].includes(cause.status)
      ) {
        setPhase('editing');
        setAttempt(null);
        setConfirmed(false);
      }
    } finally {
      pending.current = false;
      if (current()) setBusy(null);
    }
  }
  async function refresh() {
    if (pending.current) return;
    const current = guard();
    pending.current = true;
    setBusy('refresh');
    setError('');
    setReviewed(null);
    try {
      const raw = await api<unknown>(
        `/api/doctors/${encodeURIComponent(source.doctor.id)}/booking-status`,
        { isCurrent: current },
      );
      if (current()) setReviewed(checkedDoctorBookingContext(raw, source.doctor.id));
    } catch (cause) {
      if (current()) setError(doctorBookingFailure(cause));
    } finally {
      pending.current = false;
      if (current()) setBusy(null);
    }
  }
  return (
    <Modal title="Manage booking status" onClose={close}>
      <form className="doctor-booking-form stack" onSubmit={save}>
        <BookingSource context={source} />
        <p className="muted">
          This controls new appointments and waitlist requests. Existing visits stay booked and can
          still be managed or rescheduled with the same doctor. Weekly hours, clinical records and
          account access stay unchanged.
        </p>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        {phase === 'uncertain' && !busy && (
          <div className="notice doctor-booking-notice">
            The save outcome could not be confirmed. Your exact submitted request is retained. Retry
            the same request to confirm the result.
          </div>
        )}
        {phase === 'conflict' && (
          <section
            className="doctor-booking-conflict stack"
            aria-label="Review latest booking status"
          >
            <p className="notice doctor-booking-notice">
              Booking status changed after this draft was opened. Your choice and reason are
              retained. Refresh and review the latest saved status before continuing.
            </p>
            <button
              type="button"
              className="button button-secondary"
              disabled={!!busy}
              onClick={() => void refresh()}
            >
              {busy === 'refresh' ? 'Refreshing…' : 'Refresh latest booking status'}
            </button>
            {reviewed && (
              <div className="doctor-booking-latest stack">
                <h3>Latest saved booking status</h3>
                <BookingSource context={reviewed} />
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={!!busy}
                  onClick={() => {
                    setSource(reviewed);
                    setReviewed(null);
                    setAttempt(null);
                    setConfirmed(false);
                    setPhase('editing');
                    setError('');
                  }}
                >
                  I reviewed the latest status; keep my draft
                </button>
              </div>
            )}
          </section>
        )}
        <fieldset disabled={locked} className="doctor-booking-fields stack">
          <legend className="sr-only">Booking-status change</legend>
          <Field label="New booking availability">
            <select
              value={accepting ? 'accepting' : 'paused'}
              onChange={(event) => {
                setAccepting(event.target.value === 'accepting');
                setConfirmed(false);
                setError('');
              }}
            >
              <option value="accepting">Accepting new bookings</option>
              <option value="paused">New bookings paused</option>
            </select>
          </Field>
          <Field
            label="Reason for booking-status change"
            hint="Private administrator history. Patients and other staff see the status, not this reason."
          >
            <textarea
              value={reason}
              required
              maxLength={1000}
              rows={3}
              onChange={(event) => {
                setReason(event.target.value);
                setConfirmed(false);
              }}
            />
          </Field>
          <label className="doctor-booking-confirm">
            <input
              type="checkbox"
              checked={confirmed}
              required
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>I reviewed this booking-status change.</span>
          </label>
        </fieldset>
        {!changed && phase === 'editing' && (
          <p className="muted small">
            This doctor already has the selected booking status. No new change is needed.
          </p>
        )}
        <div className="modal-actions doctor-booking-actions">
          <button
            type="button"
            className="button button-secondary"
            disabled={!!busy || phase === 'uncertain'}
            onClick={close}
          >
            Cancel
          </button>
          <button
            className="button button-primary"
            disabled={!!busy || phase === 'conflict' || (phase !== 'uncertain' && !changed)}
          >
            {busy === 'save'
              ? 'Saving…'
              : phase === 'uncertain'
                ? 'Retry same request'
                : 'Save booking status'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DoctorBookingHistory({ doctorId, onClose }: { doctorId: string; onClose: () => void }) {
  const [page, setPage] = useState(1);
  const context = useDoctorBookingData(
    `/api/doctors/${encodeURIComponent(doctorId)}/booking-status`,
    (value) => checkedDoctorBookingContext(value, doctorId),
  );
  const history = useDoctorBookingData(
    `/api/doctors/${encodeURIComponent(doctorId)}/booking-status/history?page=${page}&pageSize=25`,
    (value) => checkedDoctorBookingHistory(value, doctorId, page),
  );
  return (
    <Modal title="Booking-status history" onClose={onClose}>
      <div className="doctor-booking-history stack">
        <p className="muted">
          Private administrator history. Each change preserves its recorded doctor name, author and
          reason.
        </p>
        {context.loading ? (
          <Loading />
        ) : context.error ? (
          <ErrorState message={context.error} retry={context.reload} />
        ) : (
          context.data && <BookingSource context={context.data} />
        )}
        {history.loading ? (
          <Loading />
        ) : history.error ? (
          <ErrorState message={history.error} retry={history.reload} />
        ) : (
          history.data && (
            <>
              {history.data.items.length ? (
                history.data.items.map((change) => (
                  <article className="doctor-booking-change" key={change.id}>
                    <h3>{doctorBookingLabel(change.after)}</h3>
                    <p className="muted small">
                      {change.doctorName} · {change.createdByName} ·{' '}
                      {doctorBookingStamp(change.createdAt)} IST
                    </p>
                    <p className="doctor-booking-reason">{change.reason}</p>
                    <dl className="doctor-booking-comparison">
                      <div>
                        <dt>Before</dt>
                        <dd>{doctorBookingLabel(change.before)}</dd>
                      </div>
                      <div>
                        <dt>After</dt>
                        <dd>{doctorBookingLabel(change.after)}</dd>
                      </div>
                    </dl>
                  </article>
                ))
              ) : (
                <div className="doctor-booking-empty">
                  <h3>No booking-status changes recorded</h3>
                  <p className="muted">
                    Saved pauses and resumptions will appear here. Existing profiles start by
                    accepting new bookings.
                  </p>
                </div>
              )}
              <Pagination
                {...history.data}
                label="Booking-status history pagination"
                onPageChange={setPage}
              />
            </>
          )
        )}
      </div>
    </Modal>
  );
}
