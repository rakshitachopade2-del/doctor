import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Appointment } from '../../shared/types';
import type { AppointmentSeries } from '../../shared/appointment-series';
import type {
  SeriesRescheduleMove,
  SeriesReschedulePreview,
  SeriesRescheduleResult,
} from '../../shared/appointment-series-rescheduling';
import { api, ApiError, formatDate, money, useSession } from '../lib';
import { Badge, EmptyState, ErrorState, Field, Loading, Modal } from './ui';
import { Pagination } from './Pagination';
import { seriesEnd, seriesStamp } from './appointment-series-helpers';
import {
  visitClock,
  visitDate,
  visitMinutes,
  visitPolicy,
  visitTime,
} from './visit-duration-helpers';
import {
  checkedRescheduleContext,
  checkedReschedulePage,
  checkedReschedulePreview,
  checkedRescheduleResult,
  rescheduleFailure,
  sameRescheduleMoves,
  useRescheduleData,
  useRescheduleGuard,
  type RescheduleAttempt,
} from './series-reschedule-helpers';
import './series-reschedule.css';

function VisitFacts({ appointment }: { appointment: Appointment }) {
  const end = seriesEnd(appointment.date, appointment.time, visitMinutes(appointment));
  return (
    <div className="series-reschedule-facts">
      <p>
        Start: {formatDate(appointment.date)} · {visitClock(appointment.time)} IST
      </p>
      <p>
        End: {formatDate(end.date)} · {visitClock(end.time)} IST
      </p>
      <p>
        {appointment.doctorName} ·{' '}
        {appointment.mode === 'online' ? 'Online consultation' : 'In clinic'}
      </p>
      <p>
        {visitMinutes(appointment)} minutes ·{' '}
        {visitPolicy(appointment) === 'custom' ? 'Custom length' : 'Default consultation'}
      </p>
      <p>Visit fee: {money(appointment.fee)}</p>
    </div>
  );
}
function VisitComparison({
  before,
  after,
  history = false,
}: {
  before: Appointment;
  after: Appointment;
  history?: boolean;
}) {
  return (
    <>
      <div className="series-reschedule-columns">
        <div className="series-reschedule-before">
          <h5>{history ? 'Before rescheduling' : 'Current appointment'}</h5>
          <VisitFacts appointment={before} />
        </div>
        <div className="series-reschedule-after">
          <h5>{history ? 'Recorded appointment change' : 'Proposed appointment'}</h5>
          <VisitFacts appointment={after} />
        </div>
      </div>
      {(before.fee !== after.fee ||
        before.doctorName !== after.doctorName ||
        visitMinutes(before) !== visitMinutes(after)) && (
        <div className="series-reschedule-changes">
          {before.fee !== after.fee && (
            <p>
              Visit fee changes from {money(before.fee)} to {money(after.fee)}.
            </p>
          )}
          {visitMinutes(before) !== visitMinutes(after) && (
            <p>
              Visit length changes from {visitMinutes(before)} to {visitMinutes(after)} minutes.
            </p>
          )}
          {before.doctorName !== after.doctorName && (
            <p>
              Updated clinician name: {after.doctorName} (previously {before.doctorName}).
            </p>
          )}
        </div>
      )}
    </>
  );
}
export function SeriesRescheduleModal({
  series,
  onClose,
  onSaved,
}: {
  series: AppointmentSeries;
  onClose: () => void;
  onSaved: (result: SeriesRescheduleResult) => Promise<void>;
}) {
  const { session } = useSession(),
    begin = useRescheduleGuard();
  const resource = useRescheduleData(
    `/api/appointment-series/${encodeURIComponent(series.id)}/reschedules/context`,
    (value) => checkedRescheduleContext(value, series),
  );
  const [selection, setSelection] = useState<string[]>([]),
    [targets, setTargets] = useState<Record<string, { date: string; time: string }>>({}),
    [reason, setReason] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  const [preview, setPreview] = useState<SeriesReschedulePreview | null>(null),
    [phase, setPhase] = useState<'editing' | 'review' | 'conflict' | 'uncertain'>('editing');
  const [busy, setBusy] = useState<'preview' | 'save' | 'refresh' | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const pending = useRef(false),
    attempt = useRef<RescheduleAttempt | null>(null);
  const locked = !!busy || phase === 'uncertain',
    context = resource.data;
  function moves(): SeriesRescheduleMove[] {
    return series.bookedAppointments
      .filter((a) => selection.includes(a.id))
      .map((a) => ({
        appointmentId: a.id,
        date: targets[a.id]?.date ?? '',
        time: targets[a.id]?.time ?? '',
      }));
  }
  const draft = moves(),
    latestDraft = useRef(draft);
  latestDraft.current = draft;
  const selectedIneligible =
    context?.visits.some((visit) => selection.includes(visit.appointment.id) && !visit.eligible) ??
    false;
  const noChange =
    context?.visits.some(
      (visit) =>
        selection.includes(visit.appointment.id) &&
        targets[visit.appointment.id]?.date === visit.appointment.date &&
        targets[visit.appointment.id]?.time === visit.appointment.time,
    ) ?? false;
  const selectionValid =
    !!context &&
    draft.length > 0 &&
    !selectedIneligible &&
    !noChange &&
    draft.every((move) => visitDate(move.date) && visitTime(move.time));
  function close() {
    if (!pending.current && phase !== 'uncertain') onClose();
  }
  function choose(appointment: Appointment, checked: boolean) {
    if (checked)
      setTargets((previous) => ({
        ...previous,
        [appointment.id]: previous[appointment.id] ?? {
          date: appointment.date,
          time: appointment.time,
        },
      }));
    setSelection((previous) =>
      checked
        ? [...previous.filter((id) => id !== appointment.id), appointment.id]
        : previous.filter((id) => id !== appointment.id),
    );
    setPreview(null);
    setConfirmed(false);
    setError('');
  }
  function changeTarget(id: string, value: { date: string; time: string }) {
    setTargets((previous) => ({ ...previous, [id]: value }));
    setPreview(null);
    setConfirmed(false);
    setError('');
  }
  async function refresh() {
    if (pending.current || phase === 'uncertain') return;
    pending.current = true;
    setBusy('refresh');
    setError('');
    setConfirmed(false);
    const current = begin();
    try {
      const latest = await resource.reload();
      if (current() && latest) {
        setPreview(null);
        setPhase('editing');
        attempt.current = null;
        setNotice(
          'Current visits refreshed. Your selected visits, proposed dates and times, and internal reason were kept. Review the new source, remove any ineligible selections, then create a new preview.',
        );
      }
    } finally {
      pending.current = false;
      if (current()) setBusy(null);
    }
  }
  async function prepare() {
    if (pending.current || !selectionValid || !reason.trim()) return;
    const requested = moves(),
      guard = begin(),
      current = () => guard() && sameRescheduleMoves(requested, latestDraft.current);
    pending.current = true;
    setBusy('preview');
    setError('');
    setNotice('');
    setConfirmed(false);
    try {
      const response = await api<unknown>(
        `/api/appointment-series/${encodeURIComponent(series.id)}/reschedules/preview`,
        { method: 'POST', body: { moves: requested }, isCurrent: current },
      );
      if (!current()) return;
      const next = checkedReschedulePreview(response, series, requested);
      setPreview(next);
      setPhase('review');
    } catch (problem) {
      if (current()) setError(rescheduleFailure(problem));
    } finally {
      pending.current = false;
      if (current()) setBusy(null);
    }
  }
  async function commit(sent: RescheduleAttempt) {
    if (pending.current) return;
    const current = begin(),
      uncertain = phase === 'uncertain';
    pending.current = true;
    setBusy('save');
    setError('');
    try {
      const response = await api<unknown>(
        `/api/appointment-series/${encodeURIComponent(series.id)}/reschedules`,
        { method: 'POST', body: sent.body, isCurrent: current },
      );
      if (!current()) return;
      const result = checkedRescheduleResult(response, sent);
      await onSaved(result);
    } catch (problem) {
      if (!current()) return;
      setError(rescheduleFailure(problem));
      if (uncertain) setPhase('uncertain');
      else if (
        problem instanceof ApiError &&
        problem.status === 409 &&
        !/request.*already|request.*different|idempotency/i.test(problem.message)
      ) {
        setPhase('conflict');
        setConfirmed(false);
      } else if (
        problem instanceof ApiError &&
        [400, 403, 404, 422, 429].includes(problem.status)
      ) {
        attempt.current = null;
        setConfirmed(false);
      } else setPhase('uncertain');
    } finally {
      pending.current = false;
      if (current()) setBusy(null);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    if (phase === 'uncertain' && attempt.current) {
      await commit(attempt.current);
      return;
    }
    if (phase === 'editing') {
      await prepare();
      return;
    }
    if (
      phase !== 'review' ||
      !preview?.canReschedule ||
      !confirmed ||
      !session.user ||
      session.user.role === 'patient'
    )
      return;
    const sent: RescheduleAttempt = {
      series,
      preview,
      actorId: session.user.id,
      actorRole: session.user.role,
      body: {
        moves: preview.moves,
        reason: reason.trim(),
        expectedRevision: preview.revision,
        patientConfirmed: true,
        requestId: crypto.randomUUID(),
      },
    };
    attempt.current = sent;
    await commit(sent);
  }
  return (
    <Modal title="Reschedule visits together" onClose={close}>
      <form className="series-reschedule-form" onSubmit={submit}>
        <div className="notice">
          Choose exact new dates and times for future scheduled visits. The full selection is
          checked together, including swaps. Every selected visit must fit; no conflicts are
          skipped.
        </div>
        <p className="series-reschedule-boundary">
          Each visit keeps its current clinician, consultation mode and length policy. Default
          visits adopt that clinician’s current length; custom visits keep their saved minutes.
          Moved visits use the clinician’s current name and fee. Existing room and equipment
          reservations move with the visit. Procedure links, invoices and payments stay unchanged.
          This does not send an external calendar update.
        </p>
        {context && (
          <div className="series-reschedule-patient">
            <strong>{context.patient.name}</strong>
            <span>{context.patient.phone || 'Phone not recorded'}</span>
            <span>Current visits checked {seriesStamp(context.generatedAt)} IST</span>
            <span>Target dates through {formatDate(context.horizonEndDate)}</span>
          </div>
        )}
        {error && (
          <div className="notice notice-error" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div className="notice" role="status">
            {notice}
          </div>
        )}
        {phase === 'uncertain' && (
          <div className="notice">
            The rescheduling outcome could not be confirmed. Retry the same request to retrieve its
            saved result without moving a different selection. Keep this dialog open until the
            outcome is confirmed.
          </div>
        )}
        {phase === 'conflict' && (
          <div className="notice">
            <p>
              The visits or booking conditions changed after your preview. Refresh and review them
              again. Your selection and proposed dates and times remain in the draft.
            </p>
            <button
              type="button"
              className="button button-secondary"
              disabled={locked}
              onClick={() => void refresh()}
            >
              Refresh current visits
            </button>
          </div>
        )}
        {resource.loading ? (
          <Loading />
        ) : resource.error ? (
          <ErrorState message={resource.error} retry={() => void refresh()} />
        ) : (
          context && (
            <>
              {phase === 'editing' && (
                <>
                  <div className="series-reschedule-selection-actions">
                    <button
                      type="button"
                      className="button button-secondary button-small"
                      disabled={locked || !context.visits.some((v) => v.eligible)}
                      onClick={() => {
                        const eligible = context.visits.filter((v) => v.eligible);
                        setSelection((previous) => [
                          ...new Set([...previous, ...eligible.map((v) => v.appointment.id)]),
                        ]);
                        setTargets((previous) => {
                          const next = { ...previous };
                          for (const visit of eligible)
                            next[visit.appointment.id] ??= {
                              date: visit.appointment.date,
                              time: visit.appointment.time,
                            };
                          return next;
                        });
                        setPreview(null);
                        setConfirmed(false);
                      }}
                    >
                      Select all eligible
                    </button>
                    <button
                      type="button"
                      className="button button-ghost button-small"
                      disabled={locked || !selection.length}
                      onClick={() => {
                        setSelection([]);
                        setPreview(null);
                        setConfirmed(false);
                      }}
                    >
                      Clear selection
                    </button>
                    <span>
                      {selection.length} selected of {context.visits.length} visits
                    </span>
                  </div>
                  <fieldset className="series-reschedule-selection" disabled={locked}>
                    <legend className="sr-only">
                      Choose appointments and proposed dates and times
                    </legend>
                    {context.visits.map((visit) => {
                      const checked = selection.includes(visit.appointment.id),
                        target = targets[visit.appointment.id] ?? {
                          date: visit.appointment.date,
                          time: visit.appointment.time,
                        },
                        reasonId = `series-reschedule-blocked-${visit.position}`,
                        unchanged =
                          target.date === visit.appointment.date &&
                          target.time === visit.appointment.time;
                      return (
                        <article className="series-reschedule-visit" key={visit.appointment.id}>
                          <label className="series-reschedule-checkbox">
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={!visit.eligible && !checked}
                              aria-describedby={!visit.eligible ? reasonId : undefined}
                              aria-label={`Select visit ${visit.position} · ${visit.appointment.date} · ${visit.appointment.time} IST`}
                              onChange={(event) => choose(visit.appointment, event.target.checked)}
                            />
                            <strong>Visit {visit.position}</strong>
                            <Badge>{visit.appointment.status.replaceAll('-', ' ')}</Badge>
                          </label>
                          <VisitFacts appointment={visit.appointment} />
                          <p>Reserved resources: {visit.reservationCount}</p>
                          {!visit.eligible && (
                            <p id={reasonId} className="series-reschedule-blocked">
                              {visit.blockedReason}
                              {checked && ' Remove this selection before making a new preview.'}
                            </p>
                          )}
                          {checked && (
                            <div className="series-reschedule-targets">
                              <Field label={`New date for visit ${visit.position}`}>
                                <input
                                  type="date"
                                  required
                                  min={context.clinicDate}
                                  max={context.horizonEndDate}
                                  value={target.date}
                                  disabled={!visit.eligible}
                                  onChange={(event) =>
                                    changeTarget(visit.appointment.id, {
                                      ...target,
                                      date: event.target.value,
                                    })
                                  }
                                />
                              </Field>
                              <Field label={`New time for visit ${visit.position} · IST`}>
                                <input
                                  type="time"
                                  step={60}
                                  required
                                  value={target.time}
                                  disabled={!visit.eligible}
                                  onChange={(event) =>
                                    changeTarget(visit.appointment.id, {
                                      ...target,
                                      time: event.target.value,
                                    })
                                  }
                                />
                              </Field>
                              {unchanged && (
                                <p className="muted small">
                                  Choose a different date or time for this selected visit.
                                </p>
                              )}
                            </div>
                          )}
                        </article>
                      );
                    })}
                  </fieldset>
                  {selectedIneligible && (
                    <p className="series-reschedule-blocked" role="alert">
                      A selected visit is no longer eligible. Uncheck it explicitly before
                      previewing.
                    </p>
                  )}
                  {!context.visits.some((v) => v.eligible) && (
                    <p className="muted">
                      No future scheduled visits are eligible to move together. This series and its
                      history remain available.
                    </p>
                  )}
                </>
              )}
              <Field
                label="Internal rescheduling reason"
                hint="Required staff-only history. This does not replace the shared reason for the visits."
              >
                <textarea
                  rows={3}
                  required
                  maxLength={1000}
                  value={reason}
                  disabled={locked || phase !== 'editing'}
                  onChange={(event) => setReason(event.target.value)}
                />
              </Field>
              {preview && phase !== 'editing' && (
                <section
                  className="series-reschedule-preview"
                  aria-labelledby="series-reschedule-preview-title"
                >
                  <h3 id="series-reschedule-preview-title">Review proposed appointment changes</h3>
                  <p>
                    {preview.visits.length} {preview.visits.length === 1 ? 'visit' : 'visits'}{' '}
                    selected · Patient: {preview.patient.name} ·{' '}
                    {preview.patient.phone || 'Phone not recorded'}
                  </p>
                  <p className="muted small">
                    Preview checked {seriesStamp(preview.generatedAt)} IST. No times are held; the
                    full selection is checked again when you confirm.
                  </p>
                  {preview.visits.map((visit) => (
                    <article className="series-reschedule-preview-visit" key={visit.before.id}>
                      <h4>Visit {visit.position}</h4>
                      <VisitComparison before={visit.before} after={visit.after} />
                      <p>Retained reservations: {visit.reservationCount}</p>
                      {!visit.eligible && (
                        <p className="series-reschedule-blocked">{visit.blockedReason}</p>
                      )}
                    </article>
                  ))}
                  {!preview.canReschedule && phase === 'review' && (
                    <div className="notice">
                      <p>
                        At least one proposed visit cannot be moved. No appointments will change
                        until every selected target is available.
                      </p>
                      <button
                        type="button"
                        className="button button-secondary"
                        disabled={locked}
                        onClick={() => void refresh()}
                      >
                        Refresh current visits
                      </button>
                    </div>
                  )}
                  <label className="series-reschedule-checkbox series-reschedule-confirm">
                    <input
                      type="checkbox"
                      required
                      checked={confirmed}
                      disabled={locked || phase !== 'review' || !preview.canReschedule}
                      onChange={(event) => setConfirmed(event.target.checked)}
                    />
                    I confirmed these exact appointment changes with the patient.
                  </label>
                </section>
              )}
            </>
          )
        )}
        <div className="modal-actions series-reschedule-actions">
          <button
            type="button"
            className="button button-secondary"
            disabled={locked}
            onClick={close}
          >
            Close
          </button>
          {phase === 'review' && (
            <button
              type="button"
              className="button button-secondary"
              disabled={locked}
              onClick={() => {
                setPreview(null);
                setConfirmed(false);
                attempt.current = null;
                setPhase('editing');
                setError('');
              }}
            >
              Change targets
            </button>
          )}
          {phase !== 'conflict' && (
            <button
              className="button button-primary"
              disabled={
                !!busy ||
                resource.loading ||
                !!resource.error ||
                (phase === 'editing'
                  ? !selectionValid || !reason.trim()
                  : phase === 'review'
                    ? !preview?.canReschedule || !confirmed
                    : false)
              }
            >
              {busy === 'preview'
                ? 'Preparing preview…'
                : busy === 'save'
                  ? 'Rescheduling visits…'
                  : phase === 'uncertain'
                    ? 'Retry same request'
                    : phase === 'editing'
                      ? 'Preview rescheduling'
                      : 'Reschedule selected visits'}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
export function SeriesRescheduleHistory({ series }: { series: AppointmentSeries }) {
  const [page, setPage] = useState(1),
    history = useRescheduleData(
      `/api/appointment-series/${encodeURIComponent(series.id)}/reschedules?page=${page}&pageSize=25`,
      (value) => checkedReschedulePage(value, series, page),
    );
  useEffect(() => {
    if (history.data && !history.loading && !history.error && history.data.page !== page)
      setPage(history.data.page);
  }, [history.data, history.loading, history.error, page]);
  return (
    <section
      className="series-reschedule-history"
      aria-labelledby="series-reschedule-history-title"
    >
      <h2 id="series-reschedule-history-title">Rescheduling history</h2>
      <p className="muted">
        Staff-only records of visits moved together. Each entry preserves the appointments and
        reservations at that change; later updates appear in the current visits above.
      </p>
      {history.loading ? (
        <Loading />
      ) : history.error ? (
        <ErrorState message={history.error} retry={() => void history.reload()} />
      ) : history.data ? (
        <>
          {history.data.items.length ? (
            history.data.items.map((event) => (
              <article className="series-reschedule-event" key={event.id}>
                <h3>
                  {event.visits.length}{' '}
                  {event.visits.length === 1 ? 'visit rescheduled' : 'visits rescheduled'}
                </h3>
                <p className="muted small">
                  {event.createdByName} ({event.createdByRole}) · {seriesStamp(event.createdAt)} IST
                </p>
                <p className="series-reschedule-internal">
                  <strong>Internal rescheduling reason: </strong>
                  {event.reason}
                </p>
                <p>
                  Patient confirmation recorded. Retained reservations:{' '}
                  {event.visits.reduce((sum, visit) => sum + visit.retainedReservationCount, 0)}
                </p>
                <details>
                  <summary>View rescheduled visits</summary>
                  {event.visits.map((visit) => (
                    <div className="series-reschedule-history-visit" key={visit.before.id}>
                      <h4>Visit {visit.position}</h4>
                      <VisitComparison before={visit.before} after={visit.after} history />
                      <p>Retained reservations: {visit.retainedReservationCount}</p>
                    </div>
                  ))}
                </details>
              </article>
            ))
          ) : (
            <EmptyState
              title="No group rescheduling recorded"
              description="This history records appointments explicitly moved together from this screen."
            />
          )}
          <Pagination
            {...history.data}
            label="Series rescheduling history pagination"
            onPageChange={setPage}
          />
        </>
      ) : null}
    </section>
  );
}
