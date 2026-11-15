import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Appointment } from '../../shared/types';
import type {
  AppointmentCancellationContext,
  AppointmentCancellationResult,
} from '../../shared/appointment-cancellation';
import { api, formatDate, money, useSession } from '../lib';
import { Badge, EmptyState, ErrorState, Loading } from './ui';
import {
  useAppointmentBookingData,
  useAppointmentBookingGuard,
} from './appointment-booking-helpers';
import { visitInterval, visitMinutes, visitPolicy } from './visit-duration-helpers';
import {
  cancellationFailure,
  cancellationNotApplied,
  checkedCancellationContext,
  checkedCancellationResult,
  sameCancellationAppointment,
  type CancellationAttempt,
} from './appointment-cancellation-helpers';
import './appointment-cancellation.css';

function VisitFacts({ appointment }: { appointment: Appointment }) {
  return (
    <div className="appointment-cancellation-facts">
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
      <Badge>{appointment.status.replaceAll('-', ' ')}</Badge>
    </div>
  );
}

export function AppointmentCancellationForm({
  appointmentId,
  pendingAttempt,
  onPendingAttemptChange,
  onConfirmed,
  onBusyChange,
}: {
  appointmentId: string;
  pendingAttempt?: CancellationAttempt | null;
  onPendingAttemptChange?: (attempt: CancellationAttempt | null) => void;
  onConfirmed?: (result: AppointmentCancellationResult) => void | Promise<void>;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { session } = useSession(),
    capture = useAppointmentBookingGuard();
  const patient = session.user?.role === 'patient';
  const path = `/api/appointments/${encodeURIComponent(appointmentId)}`;
  const checkedSource = (value: unknown) =>
    checkedCancellationContext(
      value,
      appointmentId,
      patient ? (session.user?.patientId ?? '') : undefined,
    );
  const context = useAppointmentBookingData(`${path}/cancellation-context`, checkedSource);
  const [source, setSource] = useState<AppointmentCancellationContext | null>(
    pendingAttempt?.source ?? null,
  );
  const [attempt, setAttempt] = useState<CancellationAttempt | null>(pendingAttempt ?? null);
  const [phase, setPhase] = useState<'review' | 'conflict' | 'uncertain'>(
    pendingAttempt ? 'uncertain' : 'review',
  );
  const [confirmed, setConfirmed] = useState(!!pendingAttempt),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [result, setResult] = useState<AppointmentCancellationResult | null>(null);
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
        await api<unknown>(`${path}/cancellation-context`, { isCurrent: current }),
      );
      if (!current()) return;
      setSource(value);
      setPhase('review');
      setNotice(
        'Current visit refreshed. Review these details and confirm again before cancelling.',
      );
    } catch (problem) {
      if (current()) setError(cancellationFailure(problem));
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
      (!attempt && (phase !== 'review' || !source.canCancel || !confirmed))
    )
      return;
    const sent = attempt ?? {
      actorId: session.user.id,
      source,
      body: {
        expectedRevision: source.revision,
        cancellationConfirmed: true as const,
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
      const value = checkedCancellationResult(
        await api<unknown>(`${path}/cancellations`, {
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
            'The cancellation is confirmed. Refresh your appointment list to see its latest details.',
          );
      }
    } catch (problem) {
      if (!current()) return;
      setError(cancellationFailure(problem));
      if (cancellationNotApplied(problem, sent)) {
        setAttempt(null);
        onPendingAttemptChange?.(null);
        setPhase('conflict');
        setConfirmed(false);
      } else setPhase('uncertain');
    } finally {
      if (current()) workingState(false);
    }
  }
  if (patient && source && source.appointment.patientId !== session.user?.patientId)
    return (
      <ErrorState message="This visit is no longer linked to your account. Open My care to review your current appointments." />
    );
  if (result) {
    const changed = !sameCancellationAppointment(result.appointment, result.event.after);
    return (
      <div className="stack appointment-cancellation-result">
        <h2 className="section-title">Cancellation confirmed</h2>
        <p className="notice">
          {changed
            ? 'The cancellation was recorded. The appointment has changed since that record; its current details are shown below. Retrying did not cancel another visit.'
            : 'This appointment is cancelled. Retrying this request does not create another cancellation.'}
        </p>
        <section className="appointment-cancellation-current" aria-label="Current appointment">
          <h3>Current appointment</h3>
          <VisitFacts appointment={result.appointment} />
        </section>
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        <details className="appointment-cancellation-original">
          <summary>Recorded cancellation</summary>
          <div className="appointment-cancellation-columns">
            <section>
              <h3>Before cancellation</h3>
              <VisitFacts appointment={result.event.before} />
            </section>
            <section>
              <h3>Recorded outcome</h3>
              <VisitFacts appointment={result.event.after} />
            </section>
          </div>
        </details>
        <p className="muted small">
          Invoices, payments and care records are unchanged. No refund or replacement visit is
          created.
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
    <form className="stack appointment-cancellation-form" onSubmit={submit}>
      <h2 className="section-title">Review appointment cancellation</h2>
      <section className="appointment-cancellation-source" aria-label="Current visit to review">
        <h3>{source.appointment.patientName}</h3>
        <VisitFacts appointment={source.appointment} />
      </section>
      <p className="notice">
        Cancelling releases this visit’s appointment time and any assigned room or equipment
        reservations. Care records, procedure plans, invoices and payments remain unchanged. A
        waitlist request is not reopened and other visits in a series are unchanged. No refund or
        replacement appointment is created.
      </p>
      {error && <ErrorState message={error} />}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {phase === 'uncertain' && !busy && (
        <div className="notice notice-warning">
          <strong>The cancellation outcome could not be confirmed.</strong>
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
            This request did not cancel the appointment. Refresh the current visit and review it
            again before confirming.
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
      {!source.canCancel && !attempt && phase === 'review' ? (
        <EmptyState
          title="This visit cannot be cancelled here"
          description={source.blockedReason ?? 'Contact the clinic for help with this appointment.'}
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
          <label className="appointment-cancellation-confirm">
            <input
              type="checkbox"
              required
              checked={confirmed}
              disabled={busy || phase !== 'review'}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>
              {patient
                ? 'I agree to cancel this appointment.'
                : 'I reviewed this appointment and confirm its cancellation.'}
            </span>
          </label>
          {phase !== 'conflict' && (
            <div className="appointment-cancellation-actions">
              <button
                className="button button-danger"
                disabled={busy || (!attempt && (!source.canCancel || !confirmed))}
              >
                {busy ? 'Cancelling…' : attempt ? 'Retry same request' : 'Confirm cancellation'}
              </button>
            </div>
          )}
        </>
      )}
    </form>
  );
}
