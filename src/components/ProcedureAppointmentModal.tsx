import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowUpRight, CalendarDays, History, RefreshCw } from 'lucide-react';
import type {
  ProcedureAppointmentCandidate,
  ProcedureAppointmentSnapshot,
  ProcedureScheduleContext,
} from '../../shared/procedure-scheduling';
import { api, ApiError, formatDate, today, useSession, useToast } from '../lib';
import { Badge, EmptyState, ErrorState, Field, Loading, Modal } from './ui';
import { Pagination } from './Pagination';
import {
  isVisitRequestCollision,
  useVisitData,
  visitDate,
  visitFailure,
  visitInterval,
} from './visit-duration-helpers';
import {
  checkedProcedureCandidates,
  checkedProcedureScheduleContext,
  checkedProcedureScheduleMutation,
  type ProcedureLinkAttempt,
} from './procedure-scheduling-helpers';
import './procedure-appointments.css';

const addDays = (day: string, count: number) => {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
};
const stamp = (value: string) =>
  new Date(value).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
const appointmentStatus = (value: string) =>
  ({
    scheduled: 'Scheduled',
    'checked-in': 'Checked in',
    'in-consultation': 'In consultation',
    completed: 'Completed',
    cancelled: 'Cancelled',
    'no-show': 'No-show',
  })[value] ?? value;
function VisitSnapshot({
  appointment,
  interactive = false,
}: {
  appointment: ProcedureAppointmentSnapshot;
  interactive?: boolean;
}) {
  const summary = (
    <>
      {formatDate(appointment.date)} ·{' '}
      {visitInterval(appointment.time, appointment.durationMinutes)}
    </>
  );
  return (
    <div className="procedure-visit-snapshot">
      <strong>
        {interactive ? (
          <Link
            to={`/clinic/appointments?date=${appointment.date}&patientId=${encodeURIComponent(appointment.patientId)}`}
          >
            {summary} <ArrowUpRight size={13} />
          </Link>
        ) : (
          summary
        )}
      </strong>
      <p>
        {appointment.doctorName} · {appointment.mode === 'online' ? 'Online' : 'In clinic'} ·{' '}
        {appointment.durationMinutes} minutes
        {appointment.durationPolicy === 'custom' ? ' · Custom length' : ''}
      </p>
      <Badge
        tone={
          appointment.status === 'cancelled' || appointment.status === 'no-show'
            ? 'amber'
            : 'neutral'
        }
      >
        {appointmentStatus(appointment.status)}
      </Badge>
    </div>
  );
}
function SchedulingHistory({ source }: { source: ProcedureScheduleContext }) {
  return (
    <section className="procedure-link-history">
      <h3>
        <History size={17} />
        Scheduling history
      </h3>
      <p className="muted small">
        Original plan association:{' '}
        {source.procedure.originalAppointmentId
          ? 'an appointment was linked when this plan was created.'
          : 'no appointment was linked when this plan was created.'}{' '}
        The original plan remains unchanged. These events record association changes; appointments
        may be rescheduled separately.
      </p>
      {source.procedure.originalAppointmentId && (
        <details className="procedure-original-reference">
          <summary>Original appointment reference</summary>
          <p>{source.procedure.originalAppointmentId}</p>
        </details>
      )}
      {source.history.length ? (
        source.history.map((event) => (
          <article className="procedure-link-event" key={event.id}>
            <div className="procedure-link-event-heading">
              <strong>
                {event.operation === 'attach'
                  ? 'Appointment linked'
                  : event.operation === 'replace'
                    ? 'Appointment link replaced'
                    : 'Appointment link removed'}
              </strong>
              <span>{stamp(event.createdAt)} IST</span>
            </div>
            <p>
              {event.createdByName} · {event.createdByRole}
            </p>
            <p className="procedure-link-reason">{event.reason}</p>
            <details>
              <summary>View previous and new association</summary>
              <div className="procedure-link-history-pair">
                <section>
                  <h4>Previous association</h4>
                  {event.beforeAppointment ? (
                    <VisitSnapshot appointment={event.beforeAppointment} />
                  ) : (
                    <p>
                      {event.beforeAppointmentId
                        ? 'The previously linked appointment is unavailable.'
                        : 'No appointment link.'}
                    </p>
                  )}
                </section>
                <section>
                  <h4>Saved association</h4>
                  {event.afterAppointment ? (
                    <VisitSnapshot appointment={event.afterAppointment} />
                  ) : (
                    <p>No appointment link.</p>
                  )}
                </section>
              </div>
            </details>
          </article>
        ))
      ) : (
        <EmptyState
          title="No association changes recorded"
          description="The original plan association is retained. There are no recorded link changes for this procedure."
        />
      )}
    </section>
  );
}

export function ProcedureAppointmentModal({
  procedureId,
  onClose,
  onSaved,
}: {
  procedureId: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { session } = useSession(),
    toast = useToast(),
    location = useLocation();
  const [source, setSource] = useState<ProcedureScheduleContext | null>(null),
    [reviewed, setReviewed] = useState<ProcedureScheduleContext | null>(null);
  const [mode, setMode] = useState<'link' | 'remove'>('link'),
    [selected, setSelected] = useState<ProcedureAppointmentCandidate | null>(null),
    [previousChoice, setPreviousChoice] = useState<ProcedureAppointmentCandidate | null>(null),
    [reason, setReason] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  const [period, setPeriod] = useState({ from: today(), to: addDays(today(), 180) }),
    [dates, setDates] = useState({ from: today(), to: addDays(today(), 180) }),
    [page, setPage] = useState(1),
    [dateError, setDateError] = useState('');
  const [phase, setPhase] = useState<'editing' | 'conflict' | 'uncertain'>('editing'),
    [attempt, setAttempt] = useState<ProcedureLinkAttempt | null>(null),
    [busy, setBusy] = useState(false),
    [refreshing, setRefreshing] = useState(false),
    [error, setError] = useState(''),
    [success, setSuccess] = useState('');
  const mounted = useRef(false),
    pending = useRef(false),
    currentLocation = useRef(location.key),
    candidatesHeading = useRef<HTMLHeadingElement>(null),
    focusPage = useRef(false);
  currentLocation.current = location.key;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const resource = useVisitData(
    `/api/procedures/${encodeURIComponent(procedureId)}/scheduling`,
    (value) => checkedProcedureScheduleContext(value, procedureId),
  );
  useEffect(() => {
    if (!source && resource.data) setSource(resource.data);
  }, [source, resource.data]);
  const query = new URLSearchParams({
    from: period.from,
    to: period.to,
    page: String(page),
    pageSize: '25',
  });
  const candidates = useVisitData(
    source?.procedure.canChange
      ? `/api/procedures/${encodeURIComponent(procedureId)}/scheduling/candidates?${query}`
      : null,
    (value) => checkedProcedureCandidates(value, source!, { ...period, page }),
  );
  useEffect(() => {
    if (!candidates.loading && !candidates.error && candidates.data) {
      if (candidates.data.page !== page) setPage(candidates.data.page);
      if (focusPage.current) {
        focusPage.current = false;
        candidatesHeading.current?.focus({ preventScroll: true });
      }
    }
  }, [candidates.loading, candidates.error, candidates.data, page]);
  const locked = busy || refreshing || phase !== 'editing',
    p = source?.procedure;
  function refreshCandidates() {
    setPreviousChoice(selected);
    setSelected(null);
    setConfirmed(false);
    void candidates.reload();
  }
  function applyDates() {
    const min = today(),
      max = addDays(min, 180);
    if (
      !visitDate(dates.from) ||
      !visitDate(dates.to) ||
      dates.from < min ||
      dates.to > max ||
      dates.to < dates.from
    ) {
      setDateError('Choose ordered dates from today through the next 180 days.');
      return;
    }
    setDateError('');
    setSelected(null);
    setPreviousChoice(null);
    setPage(1);
    setPeriod({ ...dates });
    if (dates.from === period.from && dates.to === period.to && page === 1)
      void candidates.reload();
  }
  async function refreshLatest() {
    if (pending.current || refreshing) return;
    const key = location.key;
    setRefreshing(true);
    setError('');
    try {
      const value = checkedProcedureScheduleContext(
        await api<unknown>(`/api/procedures/${encodeURIComponent(procedureId)}/scheduling`),
        procedureId,
      );
      if (mounted.current && currentLocation.current === key) setReviewed(value);
    } catch (problem) {
      if (mounted.current) setError(visitFailure(problem));
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }
  function acceptLatest() {
    if (!reviewed) return;
    setSource(reviewed);
    if (reviewed.procedure.effectiveAppointmentId === null) setMode('link');
    setReviewed(null);
    setPhase('editing');
    setAttempt(null);
    setConfirmed(false);
    setPreviousChoice(selected);
    setSelected(null);
    setError('');
    void candidates.reload();
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || refreshing || phase === 'conflict' || !source || !session.user) return;
    if (
      !attempt &&
      (!source.procedure.canChange ||
        !reason.trim() ||
        reason.trim().length > 1000 ||
        (mode === 'link'
          ? !selected
          : !confirmed || source.procedure.effectiveAppointmentId === null))
    ) {
      setError('Choose an eligible appointment or confirm removal, and enter a reason.');
      return;
    }
    const sent: ProcedureLinkAttempt = attempt ?? {
      actorId: session.user.id,
      source,
      target: mode === 'link' ? selected : null,
      body: {
        appointmentId: mode === 'link' ? selected!.appointment.id : null,
        expectedAppointmentRevision: mode === 'link' ? selected!.revision : null,
        expectedRevision: source.revision,
        requestId: crypto.randomUUID(),
        reason: reason.trim(),
        ...(mode === 'remove' ? { removeConfirmed: true } : {}),
      },
    };
    const key = location.key;
    pending.current = true;
    setBusy(true);
    setAttempt(sent);
    setError('');
    setSuccess('');
    try {
      const result = checkedProcedureScheduleMutation(
        await api<unknown>(`/api/procedures/${encodeURIComponent(procedureId)}/scheduling`, {
          method: 'POST',
          body: sent.body,
        }),
        sent,
      );
      if (!mounted.current) return;
      if (currentLocation.current !== key) {
        setPhase('uncertain');
        setError(
          'The page changed before confirmation was displayed. Retry the same request to confirm its outcome.',
        );
        return;
      }
      setSource(result.context);
      setAttempt(null);
      setPhase('editing');
      setReviewed(null);
      setSelected(null);
      setPreviousChoice(null);
      setReason('');
      setConfirmed(false);
      setMode('link');
      setSuccess(
        'Appointment association change confirmed. The current association is shown below.',
      );
      toast('Procedure appointment updated.');
      void candidates.reload();
      void onSaved().catch(() => {
        if (mounted.current)
          setSuccess(
            'Appointment association change confirmed. Refresh the page to update the surrounding list.',
          );
      });
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
        setReviewed(null);
      } else setPhase('uncertain');
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <Modal
      title="Procedure appointment"
      onClose={() => {
        if (!busy && !refreshing && phase !== 'uncertain') onClose();
      }}
    >
      <div className="stack procedure-link-editor">
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
        {source && p && (
          <>
            <div className="procedure-link-plan">
              <h3>{p.title}</h3>
              <p>
                {p.patientName} · Plan by {p.doctorName}
              </p>
              <Badge tone={p.status === 'completed' ? 'green' : 'neutral'}>
                {p.status === 'planned'
                  ? 'Planned'
                  : p.status === 'completed'
                    ? 'Completed'
                    : 'Cancelled'}
              </Badge>
            </div>
            <section className="procedure-link-current" aria-label="Current appointment">
              <h3>Current appointment</h3>
              {p.appointment ? (
                <VisitSnapshot appointment={p.appointment} interactive={!locked} />
              ) : (
                <p>
                  {p.effectiveAppointmentId
                    ? 'The linked appointment is unavailable.'
                    : 'No appointment is currently linked.'}
                </p>
              )}
              {p.schedulingState === 'attention' && (
                <p className="notice notice-warning">
                  The linked visit needs scheduling attention. This is an appointment state, not a
                  clinical urgency assessment.
                </p>
              )}
            </section>
            {!p.canChange && (
              <div className="notice">
                {p.blockedReason || 'This procedure’s appointment association is read-only.'}
              </div>
            )}
            {(p.canChange || phase !== 'editing') && (
              <form className="stack" onSubmit={submit}>
                {error && <ErrorState message={error} />}
                {phase === 'uncertain' && (
                  <div className="notice notice-warning">
                    <strong>The save outcome could not be confirmed.</strong>
                    <p>
                      The exact request and appointment snapshots are retained. Retry the same
                      request before changing or closing this editor.
                    </p>
                  </div>
                )}
                <div
                  className="procedure-link-actions"
                  role="group"
                  aria-label="Appointment link action"
                >
                  <button
                    type="button"
                    className={`button ${mode === 'link' ? 'button-primary' : 'button-secondary'}`}
                    aria-pressed={mode === 'link'}
                    disabled={locked}
                    onClick={() => {
                      setMode('link');
                      setConfirmed(false);
                      setSuccess('');
                    }}
                  >
                    Link a booked visit
                  </button>
                  {p.effectiveAppointmentId && (
                    <button
                      type="button"
                      className={`button ${mode === 'remove' ? 'button-primary' : 'button-secondary'}`}
                      aria-pressed={mode === 'remove'}
                      disabled={locked}
                      onClick={() => {
                        setMode('remove');
                        setConfirmed(false);
                        setSuccess('');
                      }}
                    >
                      Remove current link
                    </button>
                  )}
                </div>
                {mode === 'link' ? (
                  <>
                    <section className="procedure-candidate-section">
                      <h3 tabIndex={-1} ref={candidatesHeading}>
                        Eligible booked appointments
                      </h3>
                      <p className="muted small">
                        Choose a future scheduled visit for this patient. Linking does not change
                        the appointment length, resources, fees, clinical plan or patient decision.
                      </p>
                      <div className="procedure-candidate-filters">
                        <Field label="Appointments from">
                          <input
                            type="date"
                            required
                            min={today()}
                            max={addDays(today(), 180)}
                            disabled={locked}
                            value={dates.from}
                            onChange={(e) => setDates({ ...dates, from: e.target.value })}
                          />
                        </Field>
                        <Field label="Appointments to">
                          <input
                            type="date"
                            required
                            min={today()}
                            max={addDays(today(), 180)}
                            disabled={locked}
                            value={dates.to}
                            onChange={(e) => setDates({ ...dates, to: e.target.value })}
                          />
                        </Field>
                        <button
                          className="button button-secondary"
                          type="button"
                          disabled={locked}
                          onClick={applyDates}
                        >
                          Apply appointment dates
                        </button>
                        <button
                          className="button button-ghost"
                          type="button"
                          disabled={locked || candidates.loading}
                          onClick={refreshCandidates}
                        >
                          <RefreshCw size={14} />
                          Refresh appointments
                        </button>
                      </div>
                      {dateError && (
                        <p className="form-error" role="alert">
                          {dateError}
                        </p>
                      )}
                      {previousChoice && !selected && (
                        <p className="notice">
                          Previous choice: {formatDate(previousChoice.appointment.date)} at{' '}
                          {previousChoice.appointment.time} IST with{' '}
                          {previousChoice.appointment.doctorName}. Select an eligible visit again
                          from the refreshed list.
                        </p>
                      )}
                      {candidates.loading ? (
                        <Loading />
                      ) : candidates.error ? (
                        <ErrorState message={candidates.error} retry={candidates.reload} />
                      ) : candidates.data?.items.length ? (
                        <div
                          className="procedure-candidates"
                          role="group"
                          aria-label="Eligible booked appointments"
                        >
                          {candidates.data.items.map((candidate) => {
                            const a = candidate.appointment;
                            return (
                              <article
                                className={`procedure-candidate ${selected?.appointment.id === a.id ? 'selected' : ''}`}
                                key={a.id}
                              >
                                <label>
                                  <input
                                    type="radio"
                                    name="procedureAppointment"
                                    disabled={locked}
                                    checked={selected?.appointment.id === a.id}
                                    onChange={() => {
                                      setSelected(candidate);
                                      setPreviousChoice(null);
                                      setSuccess('');
                                    }}
                                    aria-label={`Select appointment ${a.date} at ${a.time} with ${a.doctorName}`}
                                  />
                                  <span>
                                    <strong>
                                      {formatDate(a.date)} ·{' '}
                                      {visitInterval(a.time, a.durationMinutes)}
                                    </strong>
                                    <span>
                                      {a.doctorName} ·{' '}
                                      {a.mode === 'online' ? 'Online' : 'In clinic'} ·{' '}
                                      {a.durationMinutes} minutes
                                      {a.durationPolicy === 'custom' ? ' · Custom length' : ''}
                                    </span>
                                  </span>
                                </label>
                              </article>
                            );
                          })}
                        </div>
                      ) : (
                        <EmptyState
                          title="No eligible appointments in this period"
                          description="Book a visit for this patient, then return and refresh this list to link it. Existing visits remain booked until changed separately."
                        />
                      )}
                      {!candidates.loading && !candidates.error && candidates.data && (
                        <Pagination
                          {...candidates.data}
                          label="Procedure appointment candidates"
                          disabled={locked}
                          onPageChange={(value) => {
                            focusPage.current = true;
                            setPage(value);
                          }}
                        />
                      )}
                      {!locked && (
                        <p className="procedure-book-link">
                          <Link className="button button-secondary" to="/clinic/appointments?new=1">
                            <CalendarDays size={15} />
                            Book a visit
                          </Link>
                          <span>
                            Booking is a separate step. Return here to link the saved appointment.
                          </span>
                        </p>
                      )}
                    </section>
                    {selected && (
                      <section className="procedure-selected-visit">
                        <h3>Selected appointment</h3>
                        <VisitSnapshot appointment={selected.appointment} />
                      </section>
                    )}
                  </>
                ) : (
                  <div className="notice notice-warning">
                    <p>
                      Removing the association leaves the appointment booked. It does not cancel the
                      procedure, release resources or change an invoice.
                    </p>
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        required
                        disabled={locked}
                        checked={confirmed}
                        onChange={(e) => setConfirmed(e.target.checked)}
                      />
                      I confirm this only removes the procedure link and leaves the appointment
                      booked
                    </label>
                  </div>
                )}
                <Field
                  label="Reason for appointment link"
                  hint="Staff only. This reason is kept in scheduling history and is not shown to the patient."
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
                {mode === 'link' && p.effectiveAppointmentId && (
                  <p className="notice">
                    Replacing this association leaves the previous appointment booked. Change or
                    cancel that visit separately if needed.
                  </p>
                )}
                {phase === 'conflict' && (
                  <section className="procedure-link-conflict">
                    <h3>Review the latest scheduling</h3>
                    <p>
                      The procedure or chosen appointment changed. Your reason and intended choice
                      are preserved. Review the current state and select a fresh eligible
                      appointment before trying again.
                    </p>
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={refreshing}
                      onClick={refreshLatest}
                    >
                      {refreshing ? 'Refreshing…' : 'Refresh latest scheduling'}
                    </button>
                    {reviewed && (
                      <>
                        <div className="procedure-link-reviewed">
                          <strong>
                            {reviewed.procedure.title} · {reviewed.procedure.patientName}
                          </strong>
                          <p>Procedure status: {reviewed.procedure.status}</p>
                          {reviewed.procedure.appointment ? (
                            <VisitSnapshot appointment={reviewed.procedure.appointment} />
                          ) : (
                            <p>
                              {reviewed.procedure.effectiveAppointmentId
                                ? 'The linked appointment is unavailable.'
                                : 'No current appointment link.'}
                            </p>
                          )}
                          {reviewed.history[0] && (
                            <p>Latest association change: {reviewed.history[0].reason}</p>
                          )}
                          {!reviewed.procedure.canChange && (
                            <p>{reviewed.procedure.blockedReason}</p>
                          )}
                        </div>
                        <button
                          type="button"
                          className="button button-secondary"
                          onClick={acceptLatest}
                        >
                          I reviewed the latest scheduling; keep my draft
                        </button>
                      </>
                    )}
                  </section>
                )}
                <div className="modal-actions">
                  <button
                    className="button button-secondary"
                    type="button"
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
                        (!p.canChange ||
                          (mode === 'link'
                            ? !selected
                            : !confirmed || p.effectiveAppointmentId === null)))
                    }
                  >
                    {busy
                      ? 'Saving…'
                      : phase === 'uncertain'
                        ? 'Retry same request'
                        : mode === 'remove'
                          ? 'Remove link'
                          : p.effectiveAppointmentId
                            ? 'Replace appointment'
                            : 'Link appointment'}
                  </button>
                </div>
              </form>
            )}
            <SchedulingHistory source={source} />
          </>
        )}
      </div>
    </Modal>
  );
}
