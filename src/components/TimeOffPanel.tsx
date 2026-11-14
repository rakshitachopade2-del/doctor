import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { CalendarOff, Plus } from 'lucide-react';
import type { Doctor } from '../../shared/types';
import type { TimeOffContext, TimeOffSnapshot, TimeOffValues } from '../../shared/time-off';
import { api, ApiError, formatDate, today, useSession, useToast } from '../lib';
import { Badge, Card, EmptyState, ErrorState, Field, Loading, Modal } from './ui';
import { Pagination } from './Pagination';
import {
  checkedTimeOffContext,
  checkedTimeOffHistory,
  checkedTimeOffMutation,
  checkedTimeOffPage,
  sameTimeOff,
  timeOffEditValues,
  timeOffFailure,
  timeOffStamp,
  timeOffValidation,
  timeOffValues,
  useTimeOffData,
  useTimeOffGuard,
  type TimeOffAttempt,
  type TimeOffFilter,
} from './time-off-helpers';
import './time-off.css';

function Period({ value }: { value: TimeOffValues }) {
  return (
    <div className="time-off-period">
      <strong>
        {formatDate(value.startDate)}
        {value.endDate !== value.startDate ? ` – ${formatDate(value.endDate)}` : ''}
      </strong>
      <span>
        {value.startTime
          ? `${value.startTime}–${value.endTime} IST on every included date`
          : 'All day on every included date'}
      </span>
    </div>
  );
}
function Snapshot({ value }: { value: TimeOffSnapshot }) {
  return (
    <div className="time-off-snapshot">
      <strong>{value.closure.reason}</strong>
      <Period value={value.closure} />
      <p>
        {value.status === 'cancelled' ? 'Cancelled' : 'Active'} ·{' '}
        {value.closure.doctorId === null ? 'Whole clinic' : 'Doctor time off'}
      </p>
    </div>
  );
}
function Source({ value }: { value: TimeOffContext }) {
  return (
    <div className="time-off-source">
      <strong>{value.doctor?.name || 'Whole clinic · all doctors'}</strong>
      <Snapshot value={value} />
      {value.latestChange ? (
        <p>
          Last changed by {value.latestChange.createdByName} ({value.latestChange.createdByRole}) ·{' '}
          {timeOffStamp(value.latestChange.createdAt)} IST
          {value.latestChange.source === 'legacy' ? ' · Earlier time-off update' : ''}
        </p>
      ) : (
        <p>Existing time-off entry. Earlier saving details are not available.</p>
      )}
    </div>
  );
}

export function TimeOffPanel({
  doctor,
  createRequested,
  onCreate,
  onCreateHandled,
  onLockChange,
  onSaved,
}: {
  doctor: Doctor;
  createRequested: boolean;
  onCreate: () => void;
  onCreateHandled: () => void;
  onLockChange: (locked: boolean) => void;
  onSaved: () => void;
}) {
  const { session } = useSession();
  const [filter, setFilter] = useState<TimeOffFilter>('upcoming'),
    [page, setPage] = useState(1);
  const [action, setAction] = useState<{
    operation: 'edit' | 'cancel' | 'history';
    id: string;
  } | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const resource = useTimeOffData(
    `/api/time-off?doctorId=${encodeURIComponent(doctor.id)}&filter=${filter}&page=${page}&pageSize=25`,
    (value) => checkedTimeOffPage(value, doctor.id, filter, page),
  );
  const seenRefresh = useRef(refreshVersion);
  useEffect(() => {
    if (seenRefresh.current !== refreshVersion) {
      seenRefresh.current = refreshVersion;
      void resource.reload();
    }
  }, [refreshVersion, resource.reload]);
  useEffect(() => {
    if (!resource.loading && !resource.error && resource.data && resource.data.page !== page)
      setPage(resource.data.page);
  }, [resource.data, resource.loading, resource.error, page]);
  const isAdmin = session.user?.role === 'admin',
    mayCreate = isAdmin || (session.user?.role === 'doctor' && session.user.doctorId === doctor.id);
  function saved(context: TimeOffContext) {
    setAction(null);
    onCreateHandled();
    setPage(1);
    setFilter(
      context.status === 'cancelled'
        ? 'cancelled'
        : context.closure.endDate < today()
          ? 'past'
          : 'upcoming',
    );
    setRefreshVersion((value) => value + 1);
    onSaved();
  }
  return (
    <>
      <Card className="schedule-closures time-off-panel">
        <div className="schedule-editor-heading">
          <div>
            <h2>Time off</h2>
            <p>
              Exceptions for {doctor.name} and the whole clinic. Cancelled entries remain in
              history.
            </p>
          </div>
          {mayCreate && (
            <button className="button button-secondary" onClick={onCreate}>
              <Plus size={16} /> Add time off
            </button>
          )}
        </div>
        <div className="time-off-toolbar">
          <Field label="Time-off view">
            <select
              value={filter}
              onChange={(event) => {
                setFilter(event.target.value as TimeOffFilter);
                setPage(1);
              }}
            >
              <option value="upcoming">Upcoming</option>
              <option value="past">Past</option>
              <option value="cancelled">Cancelled</option>
              <option value="all">All</option>
            </select>
          </Field>
          <button
            className="button button-secondary button-small"
            disabled={resource.loading}
            onClick={() => void resource.reload()}
          >
            Refresh time off
          </button>
        </div>
        {resource.loading ? (
          <Loading />
        ) : resource.error ? (
          <ErrorState message={resource.error} retry={() => void resource.reload()} />
        ) : (
          resource.data && (
            <>
              {resource.data.items.length ? (
                <div className="time-off-list">
                  {resource.data.items.map((row) => {
                    const editable =
                      isAdmin ||
                      (session.user?.role === 'doctor' &&
                        row.closure.doctorId === session.user.doctorId);
                    return (
                      <article
                        className="time-off-entry"
                        data-closure-id={row.closure.id}
                        key={row.closure.id}
                      >
                        <div className="time-off-entry-heading">
                          <CalendarOff size={20} aria-hidden="true" />
                          <div>
                            <h3>{row.closure.reason}</h3>
                            <Period value={row.closure} />
                          </div>
                          <Badge tone={row.status === 'cancelled' ? 'neutral' : 'amber'}>
                            {row.status === 'cancelled'
                              ? 'Cancelled'
                              : row.closure.endDate < today()
                                ? 'Past'
                                : 'Upcoming'}
                          </Badge>
                        </div>
                        <p className="muted small">
                          {row.closure.doctorId === null
                            ? 'Whole clinic · all doctors'
                            : doctor.name}
                        </p>
                        {editable && (
                          <div className="time-off-actions">
                            {row.status === 'active' && (
                              <>
                                <button
                                  className="button button-secondary button-small"
                                  onClick={() =>
                                    setAction({ operation: 'edit', id: row.closure.id })
                                  }
                                >
                                  Edit time off
                                </button>
                                <button
                                  className="button button-secondary button-small"
                                  onClick={() =>
                                    setAction({ operation: 'cancel', id: row.closure.id })
                                  }
                                >
                                  Cancel time off
                                </button>
                              </>
                            )}
                            <button
                              className="button button-ghost button-small"
                              onClick={() =>
                                setAction({ operation: 'history', id: row.closure.id })
                              }
                            >
                              View time-off history
                            </button>
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              ) : (
                <EmptyState
                  title={filter === 'upcoming' ? 'No upcoming time off' : 'No matching time off'}
                  description={
                    filter === 'upcoming'
                      ? 'Weekly hours apply unless another time-off entry blocks them.'
                      : 'Change the view to see other retained entries.'
                  }
                />
              )}
              <Pagination {...resource.data} label="Time-off pagination" onPageChange={setPage} />
            </>
          )
        )}
      </Card>
      {createRequested && mayCreate ? (
        <TimeOffEditor
          key="create"
          operation="create"
          doctor={doctor}
          onClose={onCreateHandled}
          onLockChange={onLockChange}
          onSaved={saved}
        />
      ) : action?.operation === 'history' ? (
        <TimeOffHistory key={action.id} closureId={action.id} onClose={() => setAction(null)} />
      ) : action ? (
        <TimeOffEditor
          key={`${action.operation}:${action.id}`}
          operation={action.operation}
          closureId={action.id}
          doctor={doctor}
          onClose={() => setAction(null)}
          onLockChange={onLockChange}
          onSaved={saved}
        />
      ) : null}
    </>
  );
}
function TimeOffHistory({ closureId, onClose }: { closureId: string; onClose: () => void }) {
  const [page, setPage] = useState(1);
  const context = useTimeOffData(`/api/time-off/${encodeURIComponent(closureId)}`, (value) =>
    checkedTimeOffContext(value, closureId),
  );
  const history = useTimeOffData(
    `/api/time-off/${encodeURIComponent(closureId)}/history?page=${page}&pageSize=25`,
    (value) => checkedTimeOffHistory(value, closureId, page),
  );
  useEffect(() => {
    if (!history.loading && !history.error && history.data && history.data.page !== page)
      setPage(history.data.page);
  }, [history.data, history.loading, history.error, page]);
  return (
    <Modal title="Time-off history" onClose={onClose}>
      <section className="time-off-history stack">
        <p className="muted">
          Private change reasons and previous details are visible only to authorized managers. The
          operational time-off reason remains visible to staff.
        </p>
        {context.loading ? (
          <Loading />
        ) : context.error ? (
          <ErrorState message={context.error} retry={() => void context.reload()} />
        ) : (
          context.data && <Source value={context.data} />
        )}
        <button
          className="button button-secondary"
          disabled={history.loading}
          onClick={() => {
            void history.reload();
            void context.reload();
          }}
        >
          Refresh time-off history
        </button>
        {history.loading ? (
          <Loading />
        ) : history.error ? (
          <ErrorState message={history.error} retry={() => void history.reload()} />
        ) : (
          history.data && (
            <>
              {history.data.items.length ? (
                history.data.items.map((change) => (
                  <article className="time-off-change" key={change.id}>
                    <div className="row between">
                      <h3>
                        {change.action === 'created'
                          ? 'Time off created'
                          : change.action === 'edited'
                            ? 'Time off edited'
                            : 'Time off cancelled'}
                      </h3>
                      <Badge tone={change.source === 'reviewed' ? 'green' : 'neutral'}>
                        {change.source === 'reviewed'
                          ? 'Reviewed change'
                          : 'Earlier time-off update'}
                      </Badge>
                    </div>
                    <p>
                      {change.createdByName} ({change.createdByRole}) ·{' '}
                      {timeOffStamp(change.createdAt)} IST
                    </p>
                    {change.changeReason ? (
                      <p className="time-off-change-reason">{change.changeReason}</p>
                    ) : (
                      change.action !== 'created' && (
                        <p className="muted small">
                          No private change reason was recorded by the earlier workflow.
                        </p>
                      )
                    )}
                    <details>
                      <summary>View previous and saved details</summary>
                      <div className="time-off-comparison">
                        <section>
                          <h4>Previous details</h4>
                          {change.before ? <Snapshot value={change.before} /> : <p>New entry</p>}
                        </section>
                        <section>
                          <h4>Saved details</h4>
                          <Snapshot value={change.after} />
                        </section>
                      </div>
                    </details>
                  </article>
                ))
              ) : (
                <EmptyState
                  title="No changes recorded"
                  description="This existing entry has no earlier saving details available."
                />
              )}
              <Pagination
                {...history.data}
                label="Time-off history pagination"
                onPageChange={setPage}
              />
            </>
          )
        )}
      </section>
    </Modal>
  );
}
function TimeOffEditor({
  operation,
  closureId,
  doctor,
  onClose,
  onLockChange,
  onSaved,
}: {
  operation: 'create' | 'edit' | 'cancel';
  closureId?: string;
  doctor: Doctor;
  onClose: () => void;
  onLockChange: (locked: boolean) => void;
  onSaved: (context: TimeOffContext) => void;
}) {
  const context = useTimeOffData(
    operation === 'create' ? null : `/api/time-off/${encodeURIComponent(closureId!)}`,
    (value) => checkedTimeOffContext(value, closureId!),
  );
  return operation === 'create' || (context.data && !context.loading && !context.error) ? (
    <TimeOffDraft
      operation={operation}
      initial={operation === 'create' ? null : context.data}
      doctor={doctor}
      onClose={onClose}
      onLockChange={onLockChange}
      onSaved={onSaved}
    />
  ) : (
    <Modal title={operation === 'edit' ? 'Edit time off' : 'Cancel time off'} onClose={onClose}>
      {context.loading ? (
        <Loading />
      ) : (
        <ErrorState
          message={context.error || 'This time-off entry is unavailable.'}
          retry={() => void context.reload()}
        />
      )}
    </Modal>
  );
}
function TimeOffDraft({
  operation,
  initial,
  doctor,
  onClose,
  onLockChange,
  onSaved,
}: {
  operation: 'create' | 'edit' | 'cancel';
  initial: TimeOffContext | null;
  doctor: Doctor;
  onClose: () => void;
  onLockChange: (locked: boolean) => void;
  onSaved: (context: TimeOffContext) => void;
}) {
  const { session } = useSession(),
    toast = useToast(),
    begin = useTimeOffGuard();
  const [source, setSource] = useState(initial),
    [draft, setDraft] = useState<TimeOffValues>(() =>
      initial
        ? timeOffValues(initial.closure)
        : {
            doctorId: doctor.id,
            startDate: today(),
            endDate: today(),
            startTime: null,
            endTime: null,
            reason: '',
          },
    );
  const [reason, setReason] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [bookingConflict, setBookingConflict] = useState(false);
  const [phase, setPhase] = useState<'editing' | 'conflict' | 'uncertain'>('editing'),
    [reviewed, setReviewed] = useState<TimeOffContext | null>(null);
  const attempt = useRef<TimeOffAttempt | null>(null),
    pending = useRef(false),
    lockCallback = useRef(onLockChange);
  lockCallback.current = onLockChange;
  const terminal = source?.status === 'cancelled' || reviewed?.status === 'cancelled',
    locked = busy || phase !== 'editing' || terminal;
  useLayoutEffect(() => {
    lockCallback.current(busy || phase === 'uncertain');
    return () => lockCallback.current(false);
  }, [busy, phase]);
  const changed =
    operation !== 'edit' ||
    (source && !sameTimeOff(timeOffValues(source.closure), timeOffValues(draft)));
  function update(fields: Partial<TimeOffValues>) {
    if (pending.current || phase !== 'editing' || terminal) return;
    setDraft((value) => ({ ...value, ...fields }));
    setConfirmed(false);
    setError('');
    setBookingConflict(false);
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      pending.current ||
      phase === 'conflict' ||
      terminal ||
      !session.user ||
      !['admin', 'doctor'].includes(session.user.role)
    )
      return;
    const uncertain = phase === 'uncertain';
    if (!uncertain && (!changed || (operation !== 'create' && (!confirmed || !reason.trim()))))
      return;
    const invalid = operation === 'cancel' ? '' : timeOffValidation(draft, today());
    if (!uncertain && invalid) {
      setError(invalid);
      return;
    }
    const sent: TimeOffAttempt = attempt.current ?? {
      operation,
      actorId: session.user.id,
      actorRole: session.user.role as 'admin' | 'doctor',
      source,
      body:
        operation === 'create'
          ? { closure: timeOffValues(draft), requestId: crypto.randomUUID() }
          : operation === 'edit'
            ? {
                closure: timeOffEditValues(draft),
                changeReason: reason.trim(),
                expectedRevision: source!.revision,
                requestId: crypto.randomUUID(),
              }
            : {
                changeReason: reason.trim(),
                expectedRevision: source!.revision,
                requestId: crypto.randomUUID(),
              },
    };
    attempt.current = sent;
    const current = begin();
    pending.current = true;
    setBusy(true);
    setError('');
    setBookingConflict(false);
    setPhase('uncertain');
    const path =
      operation === 'create'
        ? '/api/time-off'
        : `/api/time-off/${encodeURIComponent(source!.closure.id)}/${operation === 'edit' ? 'changes' : 'cancel'}`;
    try {
      const response = await api<unknown>(path, {
        method: 'POST',
        body: sent.body,
        isCurrent: current,
      });
      if (!current()) return;
      const result = checkedTimeOffMutation(response, sent);
      onSaved(result.context);
      toast(
        operation === 'create'
          ? 'Time off saved.'
          : operation === 'edit'
            ? 'Time off updated.'
            : 'Time off cancelled. Its history is retained.',
      );
    } catch (problem) {
      if (!current()) return;
      setError(timeOffFailure(problem));
      if (
        problem instanceof ApiError &&
        problem.status === 409 &&
        (problem.message ===
          'Time off changed. Refresh and review the latest record before saving.' ||
          problem.message === 'This time-off record has already been cancelled.')
      ) {
        attempt.current = null;
        setPhase('conflict');
        setReviewed(null);
        setConfirmed(false);
      } else if (
        problem instanceof ApiError &&
        problem.status === 409 &&
        /^This closure would affect \d+ booked appointments?\. Reschedule or cancel the affected appointments first\.$/.test(
          problem.message,
        )
      ) {
        attempt.current = null;
        setPhase('editing');
        setConfirmed(false);
        setBookingConflict(true);
      } else if (
        problem instanceof ApiError &&
        problem.status === 400 &&
        [
          'Closures must include today or a future date.',
          'This time off is already saved. Change its details before saving.',
        ].includes(problem.message)
      ) {
        attempt.current = null;
        setPhase('editing');
        setConfirmed(false);
      } else if (
        !uncertain &&
        problem instanceof ApiError &&
        [400, 403, 404, 413, 422, 429].includes(problem.status)
      ) {
        attempt.current = null;
        setPhase('editing');
        setConfirmed(false);
      }
    } finally {
      pending.current = false;
      if (current()) setBusy(false);
    }
  }
  async function refresh() {
    if (pending.current || !source) return;
    const current = begin();
    pending.current = true;
    setBusy(true);
    setError('');
    setReviewed(null);
    try {
      const response = await api<unknown>(
        `/api/time-off/${encodeURIComponent(source.closure.id)}`,
        { isCurrent: current },
      );
      if (current()) setReviewed(checkedTimeOffContext(response, source.closure.id));
    } catch (problem) {
      if (current()) setError(timeOffFailure(problem));
    } finally {
      pending.current = false;
      if (current()) setBusy(false);
    }
  }
  return (
    <Modal
      title={
        operation === 'create'
          ? 'Add time off'
          : operation === 'edit'
            ? 'Edit time off'
            : 'Cancel time off'
      }
      onClose={() => {
        if (!pending.current && phase !== 'uncertain') onClose();
      }}
    >
      <form className="time-off-editor stack" onSubmit={save}>
        {source && <Source value={source} />}
        {error && (
          <div role="alert" className="notice notice-error time-off-error">
            <strong>{error}</strong>
            {bookingConflict && (
              <p>
                Choose a different period or resolve the affected appointments first. No bookings
                have been cancelled. <Link to="/clinic/appointments">Review appointments</Link>
              </p>
            )}
          </div>
        )}
        {phase === 'uncertain' && !busy && (
          <div className="notice time-off-notice">
            The save outcome could not be confirmed. Your exact request is retained. Retry the same
            request before changing or closing this form.
          </div>
        )}
        {phase === 'conflict' && (
          <section className="time-off-conflict stack">
            <p>
              Your entries are retained. Review the latest record before starting a new attempt.
            </p>
            <button
              type="button"
              className="button button-secondary"
              disabled={busy}
              onClick={() => void refresh()}
            >
              {busy ? 'Refreshing…' : 'Refresh latest time off'}
            </button>
            {reviewed && (
              <div className="time-off-latest stack">
                <h3>Latest time-off record</h3>
                <Source value={reviewed} />
                {reviewed.latestChange?.changeReason && <p>{reviewed.latestChange.changeReason}</p>}
                {reviewed.status === 'active' && (
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={busy}
                    onClick={() => {
                      setSource(reviewed);
                      setReviewed(null);
                      attempt.current = null;
                      setPhase('editing');
                      setConfirmed(false);
                      setError('');
                    }}
                  >
                    I reviewed the latest time off; keep my draft
                  </button>
                )}
              </div>
            )}
          </section>
        )}
        {terminal && (
          <div className="notice time-off-notice">
            This time-off entry has been cancelled and cannot be changed again. Close this dialog to
            view its retained history.
          </div>
        )}
        {operation !== 'cancel' && (
          <>
            <Field label="Applies to">
              {operation === 'create' ? (
                <select
                  value={draft.doctorId || 'clinic'}
                  disabled={locked || session.user?.role !== 'admin'}
                  onChange={(event) =>
                    update({
                      doctorId: event.target.value === 'clinic' ? null : event.target.value,
                    })
                  }
                >
                  <option value={doctor.id}>{doctor.name}</option>
                  {session.user?.role === 'admin' && (
                    <option value="clinic">Whole clinic · all doctors</option>
                  )}
                </select>
              ) : (
                <input readOnly value={source?.doctor?.name || 'Whole clinic · all doctors'} />
              )}
            </Field>
            <Field
              label="Reason"
              hint="This operational time-off reason is visible to clinic staff."
            >
              <input
                required
                maxLength={300}
                value={draft.reason}
                disabled={locked}
                placeholder="For example, annual leave or clinic holiday"
                onChange={(event) => update({ reason: event.target.value })}
              />
            </Field>
            <div className="form-grid">
              <Field label="First day">
                <input
                  type="date"
                  required
                  value={draft.startDate}
                  disabled={locked}
                  onChange={(event) =>
                    update({
                      startDate: event.target.value,
                      endDate:
                        event.target.value > draft.endDate ? event.target.value : draft.endDate,
                    })
                  }
                />
              </Field>
              <Field label="Last day">
                <input
                  type="date"
                  required
                  min={draft.startDate > today() ? draft.startDate : today()}
                  value={draft.endDate}
                  disabled={locked}
                  onChange={(event) => update({ endDate: event.target.value })}
                />
              </Field>
            </div>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={draft.startTime === null}
                disabled={locked}
                onChange={(event) =>
                  update({
                    startTime: event.target.checked ? null : '13:00',
                    endTime: event.target.checked ? null : '14:00',
                  })
                }
              />
              <span>All day</span>
            </label>
            {draft.startTime !== null && (
              <>
                <div className="form-grid">
                  <Field label="Unavailable from">
                    <input
                      type="time"
                      step="60"
                      required
                      value={draft.startTime}
                      disabled={locked}
                      onChange={(event) => update({ startTime: event.target.value })}
                    />
                  </Field>
                  <Field label="Unavailable until">
                    <input
                      type="time"
                      step="60"
                      required
                      value={draft.endTime || ''}
                      disabled={locked}
                      onChange={(event) => update({ endTime: event.target.value })}
                    />
                  </Field>
                </div>
                <p className="muted small">
                  This time range applies on every included date, in India Standard Time.
                </p>
              </>
            )}
          </>
        )}
        {operation !== 'create' && (
          <>
            <Field
              label="Reason for change"
              hint="Private to administrators and the doctor who owns this entry; not shown to patients or other staff."
            >
              <textarea
                required
                maxLength={1000}
                value={reason}
                disabled={locked}
                onChange={(event) => {
                  setReason(event.target.value);
                  setConfirmed(false);
                }}
              />
            </Field>
            <label className="time-off-confirm">
              <input
                type="checkbox"
                required
                checked={confirmed}
                disabled={locked}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <span>
                {operation === 'cancel'
                  ? 'I understand this cancels the time-off entry while weekly hours and other closures still apply.'
                  : 'I reviewed this time-off change.'}
              </span>
            </label>
          </>
        )}
        <div className="notice time-off-notice">
          {operation === 'cancel'
            ? 'Cancellation stops this entry blocking future slots. It keeps the original details and does not change any appointments. Weekly hours and other time off still apply.'
            : 'Existing appointments remain protected. Time-off changes never reschedule or cancel a booking.'}
        </div>
        <div className="modal-actions">
          <button
            type="button"
            className="button button-secondary"
            disabled={busy || phase === 'uncertain'}
            onClick={onClose}
          >
            {operation === 'create'
              ? 'Cancel'
              : operation === 'cancel' && !terminal
                ? 'Keep time off'
                : 'Close'}
          </button>
          {!terminal && (
            <button
              className="button button-primary"
              disabled={busy || phase === 'conflict' || (phase !== 'uncertain' && !changed)}
            >
              {busy
                ? 'Saving…'
                : phase === 'uncertain'
                  ? 'Retry same request'
                  : operation === 'create'
                    ? 'Save time off'
                    : operation === 'edit'
                      ? 'Save time-off changes'
                      : 'Cancel time off'}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
