import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Appointment } from '../../shared/types';
import type {
  AppointmentStateChangeContext,
  AppointmentStateChangeResult,
  AppointmentStateChangeStatus,
} from '../../shared/appointment-state-change';
import { api, formatDate, money, useSession } from '../lib';
import { Badge, EmptyState, ErrorState, Loading } from './ui';
import {
  useAppointmentBookingData,
  useAppointmentBookingGuard,
} from './appointment-booking-helpers';
import { visitInterval, visitMinutes, visitPolicy } from './visit-duration-helpers';
import {
  checkedStateChangeContext,
  checkedStateChangeResult,
  sameStateChangeAppointment,
  stateChangeFailure,
  stateChangeLabels,
  stateChangeNotApplied,
  type StateChangeAttempt,
} from './appointment-state-change-helpers';
import './appointment-state-change.css';

const consequences: Record<AppointmentStateChangeStatus, string> = {
  'checked-in':
    'This records the patient as checked in. It does not start the consultation. Existing room or equipment reservations keep their recorded time interval.',
  'in-consultation':
    'This records the visit as in consultation. It does not create clinical notes or change the booked length. Existing room or equipment reservations keep their recorded time interval.',
  completed:
    'This records the appointment as completed. Clinical notes and procedure completion are recorded separately. Existing room or equipment reservations retain their recorded interval.',
  'no-show':
    'This records the appointment as a no-show and releases its assigned room or equipment reservations. A waitlist request is not reopened and no replacement visit is created.',
};
function VisitFacts({ appointment }: { appointment: Appointment }) {
  return (
    <div className="appointment-state-change-facts">
      <strong>{appointment.doctorName}</strong>
      <p>
        {formatDate(appointment.date)} ·{' '}
        {visitInterval(appointment.time, visitMinutes(appointment))}
      </p>
      <p>
        {appointment.mode === 'online' ? 'Online consultation' : 'In clinic'} ·{' '}
        {visitMinutes(appointment)} minutes ·{' '}
        {visitPolicy(appointment) === 'custom' ? 'Custom length' : 'Default consultation'}
      </p>
      <p>Recorded visit fee: {money(appointment.fee)}</p>
      <Badge>{stateChangeLabels[appointment.status]}</Badge>
    </div>
  );
}
export function AppointmentStateChangeForm({
  appointmentId,
  status,
  pendingAttempt,
  onPendingAttemptChange,
  onConfirmed,
  onBusyChange,
}: {
  appointmentId: string;
  status: AppointmentStateChangeStatus;
  pendingAttempt?: StateChangeAttempt | null;
  onPendingAttemptChange?: (attempt: StateChangeAttempt | null) => void;
  onConfirmed?: (result: AppointmentStateChangeResult) => void | Promise<void>;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { session } = useSession(),
    capture = useAppointmentBookingGuard();
  const path = `/api/appointments/${encodeURIComponent(appointmentId)}`;
  const checkedSource = (value: unknown) =>
    checkedStateChangeContext(value, appointmentId, session.user?.role ?? 'patient');
  const context = useAppointmentBookingData(
    session.user && session.user.role !== 'patient' ? `${path}/state-context` : null,
    checkedSource,
  );
  const [source, setSource] = useState<AppointmentStateChangeContext | null>(
      pendingAttempt?.source ?? null,
    ),
    [attempt, setAttempt] = useState<StateChangeAttempt | null>(pendingAttempt ?? null),
    [phase, setPhase] = useState<'review' | 'conflict' | 'uncertain'>(
      pendingAttempt ? 'uncertain' : 'review',
    ),
    [confirmed, setConfirmed] = useState(!!pendingAttempt),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [result, setResult] = useState<AppointmentStateChangeResult | null>(null);
  const working = useRef(false),
    busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;
  useEffect(
    () => () => {
      busyCallback.current?.(false);
    },
    [],
  );
  useEffect(() => {
    if (!source && context.data) setSource(context.data);
  }, [source, context.data]);
  const action = source?.actions.find((entry) => entry.status === status);
  function workingState(value: boolean) {
    working.current = value;
    setBusy(value);
    busyCallback.current?.(value);
  }
  async function refresh() {
    if (working.current || attempt) return;
    const current = capture();
    workingState(true);
    setError('');
    setConfirmed(false);
    try {
      const value = checkedSource(
        await api<unknown>(`${path}/state-context`, { isCurrent: current }),
      );
      if (!current()) return;
      setSource(value);
      setPhase('review');
      setNotice(
        'Current visit refreshed. Review these details and confirm again before changing its status.',
      );
    } catch (problem) {
      if (current()) setError(stateChangeFailure(problem));
    } finally {
      if (current()) workingState(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (
      working.current ||
      !source ||
      !session.user ||
      session.user.role === 'patient' ||
      (!attempt && (phase !== 'review' || !action?.allowed || !confirmed))
    )
      return;
    const sent = attempt ?? {
      actorId: session.user.id,
      actorRole: session.user.role,
      source,
      body: {
        status,
        expectedRevision: source.revision,
        changeConfirmed: true as const,
        requestId: crypto.randomUUID(),
      },
    };
    const current = capture();
    workingState(true);
    setAttempt(sent);
    onPendingAttemptChange?.(sent);
    setError('');
    setNotice('');
    try {
      const value = checkedStateChangeResult(
        await api<unknown>(`${path}/state-changes`, {
          method: 'POST',
          body: sent.body,
          isCurrent: current,
        }),
        sent,
      );
      if (!current()) return;
      setResult(value);
      setAttempt(null);
      onPendingAttemptChange?.(null);
      setPhase('review');
      try {
        await onConfirmed?.(value);
      } catch {
        if (current())
          setNotice(
            'The status change is confirmed. Refresh your appointment list to see its latest details.',
          );
      }
    } catch (problem) {
      if (!current()) return;
      setError(stateChangeFailure(problem));
      if (stateChangeNotApplied(problem, sent)) {
        setAttempt(null);
        onPendingAttemptChange?.(null);
        setPhase('conflict');
        setConfirmed(false);
      } else setPhase('uncertain');
    } finally {
      if (current()) workingState(false);
    }
  }
  if (!session.user || session.user.role === 'patient')
    return <ErrorState message="Appointment status updates are available to clinic staff only." />;
  if (
    attempt &&
    (attempt.actorId !== session.user.id ||
      attempt.source.appointment.id !== appointmentId ||
      attempt.body.status !== status)
  )
    return (
      <ErrorState message="This pending update belongs to a different appointment or action. Reopen the original status update." />
    );
  if (result) {
    const changed = !sameStateChangeAppointment(result.appointment, result.event.after);
    return (
      <div className="stack appointment-state-change-result">
        <h2 className="section-title">Status change confirmed</h2>
        <p className="notice">
          {changed
            ? 'The status change was recorded. The appointment has changed since that record; its current details are shown below. Retrying did not apply another status change.'
            : `The appointment was marked ${stateChangeLabels[result.event.after.status].toLowerCase()}. Retrying this request does not create another status change.`}
        </p>
        <section className="appointment-state-change-current" aria-label="Current appointment">
          <h3>Current appointment</h3>
          <VisitFacts appointment={result.appointment} />
        </section>
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        <details className="appointment-state-change-original">
          <summary>Recorded status change</summary>
          <div className="appointment-state-change-columns">
            <section>
              <h3>Before the change</h3>
              <VisitFacts appointment={result.event.before} />
            </section>
            <section>
              <h3>Recorded outcome</h3>
              <VisitFacts appointment={result.event.after} />
            </section>
          </div>
        </details>
        <p className="muted small">
          Clinical records, procedure plans, invoices and payments are unchanged.
        </p>
      </div>
    );
  }
  if (!source)
    return context.error ? (
      <ErrorState message={context.error} retry={context.reload} />
    ) : (
      <Loading />
    );
  return (
    <form className="stack appointment-state-change-form" onSubmit={submit}>
      <h2 className="section-title">Review appointment status change</h2>
      <section className="appointment-state-change-source" aria-label="Current visit to review">
        <h3>{source.appointment.patientName}</h3>
        <VisitFacts appointment={source.appointment} />
      </section>
      <section className="appointment-state-change-target" aria-label="Requested status change">
        <h3>Requested change</h3>
        <p>
          {stateChangeLabels[source.appointment.status]} →{' '}
          <strong>{stateChangeLabels[status]}</strong>
        </p>
      </section>
      <p className="notice">
        {consequences[status]} Clinical records, invoices and payments are unchanged.
      </p>
      {error && <ErrorState message={error} />}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {phase === 'uncertain' && !busy && (
        <div className="notice notice-warning">
          <strong>The status change outcome could not be confirmed.</strong>
          <p>
            Your exact request is retained and locked. Retry the same request before making another
            change. If you leave or reload this page, check the current appointment before starting
            again.
          </p>
        </div>
      )}
      {phase === 'conflict' && (
        <div className="notice">
          <p>
            This request did not change the appointment status. Refresh the current visit and review
            it again before confirming.
          </p>
          <button
            className="button button-secondary"
            type="button"
            disabled={busy}
            onClick={() => void refresh()}
          >
            Refresh current visit
          </button>
        </div>
      )}
      {!action?.allowed && !attempt && phase === 'review' ? (
        <EmptyState
          title="This status change is not available"
          description={
            action?.blockedReason ?? 'Refresh the current visit before changing its status.'
          }
          action={
            <button
              className="button button-secondary"
              type="button"
              disabled={busy}
              onClick={() => void refresh()}
            >
              Refresh current visit
            </button>
          }
        />
      ) : (
        <>
          <label className="appointment-state-change-confirm">
            <input
              type="checkbox"
              required
              checked={confirmed}
              disabled={busy || phase !== 'review'}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>I reviewed this appointment and confirm this status change.</span>
          </label>
          {phase !== 'conflict' && (
            <div className="appointment-state-change-actions">
              <button
                className={`button ${status === 'no-show' ? 'button-danger' : 'button-primary'}`}
                disabled={busy || (!attempt && (!action?.allowed || !confirmed))}
              >
                {busy
                  ? 'Saving status change…'
                  : attempt
                    ? 'Retry same request'
                    : 'Confirm status change'}
              </button>
            </div>
          )}
        </>
      )}
    </form>
  );
}
