import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Appointment } from '../../shared/types';
import type { AppointmentSeries } from '../../shared/appointment-series';
import type {
  SeriesCancellationPreview,
  SeriesCancellationResult,
  SeriesCancellationVisit,
} from '../../shared/appointment-series-cancellations';
import { api, ApiError, formatDate, money, useSession } from '../lib';
import { Badge, EmptyState, ErrorState, Field, Loading, Modal } from './ui';
import { Pagination } from './Pagination';
import { seriesStamp } from './appointment-series-helpers';
import { visitInterval, visitMinutes, visitPolicy } from './visit-duration-helpers';
import {
  cancellationFailure,
  checkedCancellationContext,
  checkedCancellationPage,
  checkedCancellationPreview,
  checkedCancellationResult,
  useCancellationData,
  useCancellationGuard,
  type CancellationAttempt,
} from './series-cancellation-helpers';
import './series-cancellation.css';

function VisitFacts({ appointment }: { appointment: Appointment }) {
  return (
    <div className="series-cancel-facts">
      <p>
        {formatDate(appointment.date)} ·{' '}
        {visitInterval(appointment.time, visitMinutes(appointment))}
      </p>
      <p>
        {appointment.doctorName} ·{' '}
        {appointment.mode === 'online' ? 'Online consultation' : 'In clinic'}
      </p>
      <p>
        {visitMinutes(appointment)} minutes ·{' '}
        {visitPolicy(appointment) === 'custom' ? 'Custom length' : 'Default consultation'} ·{' '}
        {money(appointment.fee)}
      </p>
    </div>
  );
}
function PreviewVisit({ visit }: { visit: SeriesCancellationVisit }) {
  return (
    <article className="series-cancel-preview-visit">
      <h4>Visit {visit.position}</h4>
      <VisitFacts appointment={visit.appointment} />
      <p>Reserved resources: {visit.reservationCount}</p>
      {!visit.eligible && <p className="series-cancel-blocked">{visit.blockedReason}</p>}
    </article>
  );
}
export function SeriesCancellationModal({
  series,
  onClose,
  onSaved,
}: {
  series: AppointmentSeries;
  onClose: () => void;
  onSaved: (result: SeriesCancellationResult) => Promise<void>;
}) {
  const { session } = useSession(),
    begin = useCancellationGuard();
  const resource = useCancellationData(
    `/api/appointment-series/${encodeURIComponent(series.id)}/cancellations/context`,
    (value) => checkedCancellationContext(value, series),
  );
  const [selection, setSelection] = useState<string[]>([]),
    [reason, setReason] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  const [preview, setPreview] = useState<SeriesCancellationPreview | null>(null),
    [phase, setPhase] = useState<'editing' | 'review' | 'conflict' | 'uncertain'>('editing');
  const [busy, setBusy] = useState<'preview' | 'save' | 'refresh' | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const pending = useRef(false),
    attempt = useRef<CancellationAttempt | null>(null),
    selected = useRef(selection);
  selected.current = selection;
  const locked = !!busy || phase === 'uncertain',
    context = resource.data;
  const selectedIneligible =
    context?.visits.some((visit) => selection.includes(visit.appointment.id) && !visit.eligible) ??
    false;
  const selectionValid = !!context && selection.length > 0 && !selectedIneligible;
  function close() {
    if (!pending.current && phase !== 'uncertain') onClose();
  }
  function choose(id: string, checked: boolean) {
    setSelection((previous) =>
      checked
        ? [...previous.filter((value) => value !== id), id]
        : previous.filter((value) => value !== id),
    );
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
          'Current visits refreshed. Review every selected visit, remove any that are no longer eligible, then create a new preview. Your internal reason and selection were kept.',
        );
      }
    } finally {
      pending.current = false;
      if (current()) setBusy(null);
    }
  }
  async function prepare() {
    if (pending.current || !selectionValid || !reason.trim()) return;
    const ids = [...selection],
      guard = begin(),
      current = () =>
        guard() &&
        ids.length === selected.current.length &&
        ids.every((id) => selected.current.includes(id));
    pending.current = true;
    setBusy('preview');
    setError('');
    setNotice('');
    setConfirmed(false);
    try {
      const response = await api<unknown>(
        `/api/appointment-series/${encodeURIComponent(series.id)}/cancellations/preview`,
        { method: 'POST', body: { appointmentIds: ids }, isCurrent: current },
      );
      if (!current()) return;
      const latest = checkedCancellationPreview(response, series, ids);
      setPreview(latest);
      setPhase('review');
    } catch (problem) {
      if (current()) setError(cancellationFailure(problem));
    } finally {
      pending.current = false;
      if (current()) setBusy(null);
    }
  }
  async function commit(sent: CancellationAttempt) {
    if (pending.current) return;
    const current = begin(),
      unknown = phase === 'uncertain';
    pending.current = true;
    setBusy('save');
    setError('');
    try {
      const response = await api<unknown>(
        `/api/appointment-series/${encodeURIComponent(series.id)}/cancellations`,
        { method: 'POST', body: sent.body, isCurrent: current },
      );
      if (!current()) return;
      const result = checkedCancellationResult(response, sent);
      await onSaved(result);
    } catch (problem) {
      if (!current()) return;
      setError(cancellationFailure(problem));
      if (unknown) setPhase('uncertain');
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
      !preview?.canCancel ||
      !confirmed ||
      !session.user ||
      session.user.role === 'patient'
    )
      return;
    const sent: CancellationAttempt = {
      series,
      preview,
      actorId: session.user.id,
      actorRole: session.user.role,
      body: {
        appointmentIds: preview.appointmentIds,
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
    <Modal title="Cancel remaining visits" onClose={close}>
      <form className="series-cancel-form" onSubmit={submit}>
        <div className="notice series-cancel-boundary">
          Cancel selected future scheduled visits from this series. Their room and equipment
          reservations will be released. Procedure plans, invoices and payments stay unchanged. This
          does not record a refund or send an external message.
        </div>
        {context && (
          <div className="series-cancel-patient">
            <strong>{context.patient.name}</strong>
            <span>{context.patient.phone || 'Phone not recorded'}</span>
            <span>Current visits checked {seriesStamp(context.generatedAt)} IST</span>
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
            The cancellation outcome could not be confirmed. Retry the same request to retrieve its
            saved result without cancelling another selection. Keep this dialog open until the
            outcome is confirmed.
          </div>
        )}
        {phase === 'conflict' && (
          <div className="notice">
            <p>
              These visits changed after your preview. Refresh their current details and review your
              selection again. Nothing is silently removed from your selection.
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
                  <div className="series-cancel-selection-actions">
                    <button
                      type="button"
                      className="button button-secondary button-small"
                      disabled={locked || !context.visits.some((v) => v.eligible)}
                      onClick={() => {
                        setSelection((previous) => [
                          ...new Set([
                            ...previous,
                            ...context.visits
                              .filter((v) => v.eligible)
                              .map((v) => v.appointment.id),
                          ]),
                        ]);
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
                  <fieldset className="series-cancel-selection" disabled={locked}>
                    <legend className="sr-only">Select current appointments to cancel</legend>
                    {context.visits.map((visit) => {
                      const checked = selection.includes(visit.appointment.id),
                        reasonId = `series-cancel-reason-${visit.position}`;
                      return (
                        <article className="series-cancel-visit" key={visit.appointment.id}>
                          <label className="series-cancel-checkbox">
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={!visit.eligible && !checked}
                              aria-describedby={!visit.eligible ? reasonId : undefined}
                              aria-label={`Select visit ${visit.position} · ${visit.appointment.date} · ${visit.appointment.time} IST`}
                              onChange={(event) =>
                                choose(visit.appointment.id, event.target.checked)
                              }
                            />
                            <strong>Visit {visit.position}</strong>
                            <Badge>{visit.appointment.status.replaceAll('-', ' ')}</Badge>
                          </label>
                          <VisitFacts appointment={visit.appointment} />
                          <p>Reserved resources: {visit.reservationCount}</p>
                          {!visit.eligible && (
                            <p id={reasonId} className="series-cancel-blocked">
                              {visit.blockedReason}
                              {checked && ' Remove this selection before making a new preview.'}
                            </p>
                          )}
                        </article>
                      );
                    })}
                  </fieldset>
                  {selectedIneligible && (
                    <p className="series-cancel-blocked" role="alert">
                      A selected visit is no longer eligible. Uncheck it explicitly before
                      previewing.
                    </p>
                  )}
                  {!context.visits.some((v) => v.eligible) && (
                    <p className="muted">
                      No future scheduled visits are eligible for cancellation together. You can
                      still read this series and its history.
                    </p>
                  )}
                </>
              )}
              <Field
                label="Internal cancellation reason"
                hint="Required staff-only history. This does not replace the reason for the patient's visits."
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
                  className="series-cancel-preview"
                  aria-labelledby="series-cancel-preview-heading"
                >
                  <h3 id="series-cancel-preview-heading">Review selected cancellations</h3>
                  <p>
                    {preview.visits.length} {preview.visits.length === 1 ? 'visit' : 'visits'}{' '}
                    selected · Patient: {preview.patient.name} ·{' '}
                    {preview.patient.phone || 'Phone not recorded'}
                  </p>
                  <p className="muted small">
                    Preview checked {seriesStamp(preview.generatedAt)} IST. Availability and status
                    are checked again when you confirm.
                  </p>
                  {preview.visits.map((visit) => (
                    <PreviewVisit key={visit.appointment.id} visit={visit} />
                  ))}
                  {!preview.canCancel && phase === 'review' && (
                    <div className="notice">
                      <p>
                        At least one selected visit is no longer eligible. No visits will be
                        cancelled.
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
                  <label className="series-cancel-checkbox series-cancel-confirm">
                    <input
                      type="checkbox"
                      required
                      checked={confirmed}
                      disabled={locked || phase !== 'review' || !preview.canCancel}
                      onChange={(event) => setConfirmed(event.target.checked)}
                    />
                    I confirmed these exact cancellations with the patient.
                  </label>
                </section>
              )}
            </>
          )
        )}
        <div className="modal-actions series-cancel-actions">
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
              Change selection
            </button>
          )}
          {phase !== 'conflict' && (
            <button
              className={`button ${phase === 'editing' ? 'button-primary' : 'button-danger'}`}
              disabled={
                !!busy ||
                resource.loading ||
                !!resource.error ||
                (phase === 'editing'
                  ? !selectionValid || !reason.trim()
                  : phase === 'review'
                    ? !preview?.canCancel || !confirmed
                    : false)
              }
            >
              {busy === 'preview'
                ? 'Preparing preview…'
                : busy === 'save'
                  ? 'Cancelling visits…'
                  : phase === 'uncertain'
                    ? 'Retry same request'
                    : phase === 'editing'
                      ? 'Preview cancellation'
                      : 'Cancel selected visits'}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}

export function SeriesCancellationHistory({ series }: { series: AppointmentSeries }) {
  const [page, setPage] = useState(1);
  const history = useCancellationData(
    `/api/appointment-series/${encodeURIComponent(series.id)}/cancellations?page=${page}&pageSize=25`,
    (value) => checkedCancellationPage(value, series, page),
  );
  useEffect(() => {
    if (history.data && !history.loading && !history.error && history.data.page !== page)
      setPage(history.data.page);
  }, [history.data, history.loading, history.error, page]);
  return (
    <section
      className="series-cancellation-history"
      aria-labelledby="series-cancellation-history-title"
    >
      <h2 id="series-cancellation-history-title">Cancellation history</h2>
      <p className="muted">
        Staff-only records of visits cancelled together. Individual appointment changes remain
        visible above; the original recurring booking stays unchanged.
      </p>
      {history.loading ? (
        <Loading />
      ) : history.error ? (
        <ErrorState message={history.error} retry={() => void history.reload()} />
      ) : history.data ? (
        <>
          {history.data.items.length ? (
            history.data.items.map((event) => (
              <article className="series-cancellation-event" key={event.id}>
                <h3>
                  {event.visits.length}{' '}
                  {event.visits.length === 1 ? 'visit cancelled' : 'visits cancelled'}
                </h3>
                <p className="muted small">
                  {event.createdByName} ({event.createdByRole}) · {seriesStamp(event.createdAt)} IST
                </p>
                <p className="series-cancel-internal">
                  <strong>Internal cancellation reason: </strong>
                  {event.reason}
                </p>
                <p>
                  Patient confirmation recorded. Released reservations:{' '}
                  {event.visits.reduce((sum, visit) => sum + visit.releasedReservationCount, 0)}
                </p>
                <details>
                  <summary>View cancelled visits</summary>
                  {event.visits.map((visit) => (
                    <div className="series-cancel-history-visit" key={visit.before.id}>
                      <h4>Visit {visit.position}</h4>
                      <div className="series-cancel-history-columns">
                        <div>
                          <h5>Before cancellation</h5>
                          <Badge>{visit.before.status.replaceAll('-', ' ')}</Badge>
                          <VisitFacts appointment={visit.before} />
                        </div>
                        <div>
                          <h5>Recorded cancellation</h5>
                          <Badge tone="neutral">Cancelled</Badge>
                          <VisitFacts appointment={visit.after} />
                        </div>
                      </div>
                      <p>Released reservations: {visit.releasedReservationCount}</p>
                    </div>
                  ))}
                </details>
              </article>
            ))
          ) : (
            <EmptyState
              title="No group cancellations recorded"
              description="This history records the visits explicitly cancelled together from this screen."
            />
          )}
          <Pagination
            {...history.data}
            label="Series cancellation history pagination"
            onPageChange={setPage}
          />
        </>
      ) : null}
    </section>
  );
}
