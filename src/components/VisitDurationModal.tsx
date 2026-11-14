import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { History, RefreshCw } from 'lucide-react';
import type { VisitDurationContext, VisitDurationPolicy } from '../../shared/visit-duration';
import { api, ApiError, formatDate, money, today, useSession, useToast } from '../lib';
import { Badge, EmptyState, ErrorState, Field, Loading, Modal } from './ui';
import {
  checkedLengthChange,
  checkedVisitContext,
  checkedVisitSlots,
  isVisitRequestCollision,
  useVisitData,
  validCustomMinutes,
  visitDate,
  visitFailure,
  visitInterval,
  visitMinutes,
  visitPolicy,
  visitTime,
  type LengthAttempt,
} from './visit-duration-helpers';
import './visit-duration.css';

export function VisitDurationModal({
  appointmentId,
  onClose,
  onSaved,
}: {
  appointmentId: string;
  onClose: () => void;
  onSaved: (date: string) => Promise<void>;
}) {
  const { session } = useSession(),
    toast = useToast(),
    location = useLocation();
  const [source, setSource] = useState<VisitDurationContext | null>(null),
    [reviewed, setReviewed] = useState<VisitDurationContext | null>(null);
  const [policy, setPolicy] = useState<VisitDurationPolicy>('schedule'),
    [custom, setCustom] = useState('60'),
    [date, setDate] = useState(''),
    [time, setTime] = useState(''),
    [reason, setReason] = useState('');
  const [attempt, setAttempt] = useState<LengthAttempt | null>(null),
    [phase, setPhase] = useState<'editing' | 'uncertain' | 'conflict'>('editing'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [refreshing, setRefreshing] = useState(false),
    [success, setSuccess] = useState('');
  const mounted = useRef(false),
    pending = useRef(false),
    currentLocation = useRef(location.key);
  currentLocation.current = location.key;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const resource = useVisitData(
    `/api/appointments/${encodeURIComponent(appointmentId)}/duration`,
    (value) => checkedVisitContext(value, appointmentId),
  );
  function initialize(value: VisitDurationContext) {
    setSource(value);
    setPolicy(visitPolicy(value.appointment));
    setCustom(
      String(
        visitPolicy(value.appointment) === 'custom'
          ? visitMinutes(value.appointment)
          : value.scheduleDurationMinutes,
      ),
    );
    setDate(value.appointment.date);
    setTime(value.appointment.time);
    setReason('');
  }
  useEffect(() => {
    if (!source && resource.data) initialize(resource.data);
  }, [source, resource.data]);
  const minutes = policy === 'custom' ? Number(custom) : (source?.scheduleDurationMinutes ?? 30);
  const query = new URLSearchParams({
    doctorId: source?.appointment.doctorId ?? '',
    patientId: source?.appointment.patientId ?? '',
    date,
    mode: source?.appointment.mode ?? 'in-person',
    durationPolicy: policy,
    excludeAppointmentId: appointmentId,
  });
  if (policy === 'custom') query.set('durationMinutes', String(minutes));
  const slots = useVisitData(
    source?.canChange && visitDate(date) && (policy === 'schedule' || validCustomMinutes(minutes))
      ? `/api/visit-duration/slots?${query}`
      : null,
    checkedVisitSlots,
  );
  const locked = busy || refreshing || phase !== 'editing',
    a = source?.appointment;
  const moved = !!a && (date !== a.date || (!!time && time !== a.time));
  const unchanged =
    !!a &&
    date === a.date &&
    time === a.time &&
    policy === visitPolicy(a) &&
    minutes === visitMinutes(a);
  async function refreshLatest() {
    if (pending.current) return;
    setRefreshing(true);
    setError('');
    try {
      const value = checkedVisitContext(
        await api<unknown>(`/api/appointments/${encodeURIComponent(appointmentId)}/duration`),
        appointmentId,
      );
      if (mounted.current) setReviewed(value);
    } catch (problem) {
      if (mounted.current) setError(visitFailure(problem));
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || phase === 'conflict' || !source || !session.user) return;
    if (
      !attempt &&
      (!source.canChange ||
        unchanged ||
        !visitDate(date) ||
        !visitTime(time) ||
        !slots.data?.includes(time) ||
        slots.loading ||
        slots.error ||
        !reason.trim() ||
        (policy === 'custom' && !validCustomMinutes(minutes)))
    ) {
      setError('Choose a changed visit length or time, an available slot, and a reason.');
      return;
    }
    const sent = attempt ?? {
      actorId: session.user.id,
      source,
      body: {
        durationPolicy: policy,
        ...(policy === 'custom' ? { durationMinutes: minutes } : {}),
        date,
        time,
        reason: reason.trim(),
        expectedRevision: source.revision,
        requestId: crypto.randomUUID(),
      },
    };
    const key = location.key;
    pending.current = true;
    setBusy(true);
    setAttempt(sent);
    setError('');
    setSuccess('');
    try {
      const result = checkedLengthChange(
        await api<unknown>(`/api/appointments/${encodeURIComponent(appointmentId)}/duration`, {
          method: 'POST',
          body: sent.body,
        }),
        sent,
      );
      if (!mounted.current) return;
      if (currentLocation.current !== key) {
        setPhase('uncertain');
        setError(
          'The page changed before confirmation was displayed. Retry the same request to confirm the recorded outcome.',
        );
        return;
      }
      setAttempt(null);
      setPhase('editing');
      setReviewed(null);
      setSuccess('Visit length update confirmed.');
      toast('Visit length update confirmed.');
      await onSaved(result.appointment.date);
      if (mounted.current) {
        setSource(null);
        void resource.reload();
      }
    } catch (problem) {
      if (!mounted.current) return;
      setError(visitFailure(problem));
      const known =
        phase !== 'uncertain' &&
        !isVisitRequestCollision(problem) &&
        problem instanceof ApiError &&
        [400, 401, 403, 404, 409].includes(problem.status);
      if (known) {
        setAttempt(null);
        setPhase(problem.status === 409 ? 'conflict' : 'editing');
        if (problem.status !== 409) {
          setTime('');
          void slots.reload();
        }
      } else setPhase('uncertain');
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <Modal
      title="Visit length"
      onClose={() => {
        if (!busy && !refreshing && phase !== 'uncertain') onClose();
      }}
    >
      <div className="stack visit-duration-editor">
        {resource.loading && !source ? (
          <Loading />
        ) : resource.error && !source ? (
          <ErrorState message={resource.error} retry={resource.reload} />
        ) : null}
        {success && (
          <div className="notice" role="status">
            {success}
          </div>
        )}
        {source && a && (
          <>
            <section className="visit-duration-source">
              <h3>{a.patientName}</h3>
              <p>
                {a.doctorName} · {a.mode === 'online' ? 'Online' : 'In clinic'} ·{' '}
                <Badge>{a.status.replaceAll('-', ' ')}</Badge>
              </p>
              <strong>
                {formatDate(a.date)} · {visitInterval(a.time, visitMinutes(a))}
              </strong>
              <p>
                {visitMinutes(a)} minutes ·{' '}
                {visitPolicy(a) === 'custom' ? 'Custom length' : 'Schedule default when booked'} ·
                Booked fee {money(a.fee)}
              </p>
            </section>
            {source.canChange || phase !== 'editing' ? (
              <form className="stack" onSubmit={submit}>
                {error && <ErrorState message={error} />}
                {phase === 'uncertain' && (
                  <div className="notice notice-warning">
                    <strong>The save outcome could not be confirmed.</strong>
                    <p>
                      Your exact request is retained and locked. Retry the same request before
                      closing this editor or making another length change.
                    </p>
                  </div>
                )}
                <div className="form-grid">
                  <Field label="Visit length">
                    <select
                      disabled={locked}
                      value={policy}
                      onChange={(e) => {
                        setPolicy(e.target.value as VisitDurationPolicy);
                        setTime('');
                        setSuccess('');
                      }}
                    >
                      <option value="schedule">Default consultation</option>
                      <option value="custom">Custom length</option>
                    </select>
                  </Field>
                  {policy === 'custom' ? (
                    <Field
                      label="Custom duration (minutes)"
                      hint="15–240 minutes, in 5-minute steps."
                    >
                      <input
                        type="number"
                        min={15}
                        max={240}
                        step={5}
                        required
                        disabled={locked}
                        value={custom}
                        onChange={(e) => {
                          setCustom(e.target.value);
                          setTime('');
                          setSuccess('');
                        }}
                      />
                    </Field>
                  ) : (
                    <div className="visit-duration-default">
                      <span>Current schedule default</span>
                      <strong>{source.scheduleDurationMinutes} minutes</strong>
                    </div>
                  )}
                  <Field label="Visit date">
                    <input
                      type="date"
                      required
                      min={today()}
                      disabled={locked}
                      value={date}
                      onChange={(e) => {
                        setDate(e.target.value);
                        setTime('');
                        setSuccess('');
                      }}
                    />
                  </Field>
                </div>
                <Field label="Available visit times · IST">
                  {slots.loading ? (
                    <p className="muted">Checking the full visit interval…</p>
                  ) : slots.error ? (
                    <ErrorState message={slots.error} retry={slots.reload} />
                  ) : (
                    <div
                      className="visit-duration-slots"
                      role="group"
                      aria-label="Available visit times"
                    >
                      {slots.data?.length ? (
                        slots.data.map((slot) => (
                          <button
                            className={`button button-small ${time === slot ? 'button-primary' : 'button-secondary'}`}
                            type="button"
                            key={slot}
                            disabled={locked}
                            aria-pressed={time === slot}
                            onClick={() => {
                              setTime(slot);
                              setSuccess('');
                            }}
                          >
                            {slot}
                          </button>
                        ))
                      ) : (
                        <p className="muted">
                          No fitting times for this date and length. Choose another date or
                          duration.
                        </p>
                      )}
                    </div>
                  )}
                </Field>
                <div className="notice visit-duration-preview">
                  <strong>
                    {time && validCustomMinutes(minutes)
                      ? `${formatDate(date)} · ${visitInterval(time, minutes)} · ${minutes} minutes`
                      : 'Select an available time to preview the full visit.'}
                  </strong>
                  <p>
                    Visit fee: {money(moved ? source.currentDoctorFee : a.fee)}.{' '}
                    {moved
                      ? 'Moving the date or time applies the clinician’s current fee and name.'
                      : 'Changing only the length preserves the booked fee and clinician name.'}{' '}
                    Duration does not multiply fees or change invoices.
                  </p>
                  <p>
                    Assigned rooms and equipment move or resize with this visit. All reservations
                    must fit.
                  </p>
                </div>
                <Field
                  label="Reason for length change"
                  hint="Staff only. This reason is retained in visit length history; it is not sent to the patient."
                >
                  <textarea
                    required
                    maxLength={1000}
                    rows={3}
                    disabled={locked}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </Field>
                {phase === 'conflict' && (
                  <section className="visit-duration-conflict">
                    <h3>Review the latest visit</h3>
                    <p>
                      Your draft is preserved. Refresh the current visit, availability and fee
                      before saving another request.
                    </p>
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={refreshing}
                      onClick={refreshLatest}
                    >
                      <RefreshCw size={15} />
                      {refreshing ? 'Refreshing…' : 'Refresh latest visit'}
                    </button>
                    {reviewed && (
                      <>
                        <div className="visit-duration-reviewed">
                          <strong>
                            {reviewed.appointment.patientName} · {reviewed.appointment.doctorName}
                          </strong>
                          <p>
                            {formatDate(reviewed.appointment.date)} ·{' '}
                            {visitInterval(
                              reviewed.appointment.time,
                              visitMinutes(reviewed.appointment),
                            )}{' '}
                            · {visitMinutes(reviewed.appointment)} minutes ·{' '}
                            {reviewed.appointment.status}
                          </p>
                          <p>
                            Current schedule: {reviewed.scheduleDurationMinutes} minutes · Current
                            fee {money(reviewed.currentDoctorFee)}
                          </p>
                          {reviewed.history[0] && (
                            <p>Latest recorded length change: {reviewed.history[0].reason}</p>
                          )}
                        </div>
                        <button
                          type="button"
                          className="button button-secondary"
                          onClick={() => {
                            setSource(reviewed);
                            setReviewed(null);
                            setPhase('editing');
                            setAttempt(null);
                            setTime('');
                            setError('');
                            // A new resource claim or closure can change availability
                            // without changing any slot query parameters.
                            void slots.reload();
                          }}
                        >
                          I reviewed the latest visit; keep my draft
                        </button>
                      </>
                    )}
                  </section>
                )}
                <div className="modal-actions">
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={busy || refreshing || phase === 'uncertain'}
                    onClick={onClose}
                  >
                    Close
                  </button>
                  <button
                    className="button button-primary"
                    disabled={
                      busy ||
                      refreshing ||
                      phase === 'conflict' ||
                      (phase !== 'uncertain' &&
                        (!source.canChange ||
                          unchanged ||
                          slots.loading ||
                          !!slots.error ||
                          !time ||
                          !slots.data?.includes(time)))
                    }
                  >
                    {busy
                      ? 'Saving…'
                      : phase === 'uncertain'
                        ? 'Retry same request'
                        : 'Save visit length'}
                  </button>
                </div>
              </form>
            ) : (
              <div className="notice">
                Visit length can be changed only for a future scheduled appointment. This visit’s
                saved length and history remain available.
              </div>
            )}
            <section className="visit-duration-history">
              <h3>
                <History size={17} />
                Visit length history
              </h3>
              <p className="muted small">
                This history records custom bookings and explicit length changes from this feature’s
                release. Other appointment edits may occur between these events.
              </p>
              {source.history.length ? (
                source.history.map((event) => (
                  <article key={event.id}>
                    <div className="visit-duration-history-heading">
                      <strong>
                        {event.operation === 'custom-booking'
                          ? 'Custom visit booked'
                          : 'Visit length changed'}
                      </strong>
                      <span>
                        {new Date(event.createdAt).toLocaleString('en-IN', {
                          timeZone: 'Asia/Kolkata',
                        })}{' '}
                        IST
                      </span>
                    </div>
                    <p>
                      {event.createdByName} · {event.createdByRole}
                    </p>
                    <p className="visit-duration-reason">{event.reason}</p>
                    {event.before && (
                      <p>
                        Before: {formatDate(event.before.date)} ·{' '}
                        {visitInterval(event.before.time, visitMinutes(event.before))} ·{' '}
                        {visitMinutes(event.before)} minutes
                      </p>
                    )}
                    <p>
                      Saved: {formatDate(event.after.date)} ·{' '}
                      {visitInterval(event.after.time, visitMinutes(event.after))} ·{' '}
                      {visitMinutes(event.after)} minutes ·{' '}
                      {visitPolicy(event.after) === 'custom' ? 'Custom length' : 'Schedule default'}
                    </p>
                  </article>
                ))
              ) : (
                <EmptyState
                  title="No visit length changes recorded"
                  description="The appointment remains available above. No earlier length history has been invented."
                />
              )}
            </section>
          </>
        )}
      </div>
    </Modal>
  );
}
