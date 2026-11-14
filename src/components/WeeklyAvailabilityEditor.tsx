import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock, Check, Clock3, Plus, Save, X } from 'lucide-react';
import type { DoctorSchedule, ScheduleWindow } from '../../shared/scheduling';
import type {
  WeeklyAvailabilityContext,
  WeeklyAvailabilitySnapshot,
  WeeklyAvailabilityValues,
} from '../../shared/weekly-availability';
import { api, ApiError, useSession, useToast } from '../lib';
import { Badge, Card, EmptyState, ErrorState, Field, Loading, Modal } from './ui';
import { Pagination } from './Pagination';
import {
  checkedWeeklyContext,
  checkedWeeklyHistory,
  checkedWeeklyMutation,
  clock,
  minutes,
  sameWeeklyValues,
  sortedWindows,
  useWeeklyData,
  useWeeklyGuard,
  validateWeeklyDraft,
  weekdays,
  weeklyFailure,
  weeklyStamp,
  weeklyValues,
  type WeeklyAttempt,
} from './weekly-availability-helpers';
import './weekly-availability.css';

function WeeklyFields({
  value,
  disabled,
  editable,
  onChange,
}: {
  value: WeeklyAvailabilityValues;
  disabled: boolean;
  editable: boolean;
  onChange: (value: WeeklyAvailabilityValues) => void;
}) {
  function updateWindow(index: number, changes: Partial<ScheduleWindow>) {
    onChange({
      ...value,
      windows: value.windows.map((window, i) => (i === index ? { ...window, ...changes } : window)),
    });
  }
  function addWindow(day: number) {
    if (value.windows.length >= 70) return;
    const windows = value.windows.filter((window) => window.day === day);
    const start = windows.length
      ? Math.min(22 * 60, Math.max(...windows.map((window) => minutes(window.end))) + 60)
      : 9 * 60;
    onChange({
      ...value,
      windows: [
        ...value.windows,
        {
          day,
          start: clock(start),
          end: clock(windows.length ? Math.min(23 * 60 + 59, start + 120) : 18 * 60),
          mode: 'both',
        },
      ],
    });
  }
  return (
    <>
      <div className="schedule-duration">
        <Field label="Appointment length">
          <select
            disabled={disabled}
            value={value.durationMinutes}
            onChange={(event) =>
              onChange({
                ...value,
                durationMinutes: Number(event.target.value) as DoctorSchedule['durationMinutes'],
              })
            }
          >
            {[15, 20, 30, 45, 60].map((duration) => (
              <option key={duration} value={duration}>
                {duration} minutes
              </option>
            ))}
          </select>
        </Field>
        <p>Applies to new appointments. Existing bookings keep their recorded duration.</p>
      </div>
      <div className="schedule-weekdays">
        {weekdays.map((weekday) => {
          const windows = value.windows
            .map((window, index) => ({ ...window, index }))
            .filter((window) => window.day === weekday.day);
          return (
            <section
              className={`schedule-day ${windows.length ? '' : 'schedule-day-closed'}`}
              key={weekday.day}
              aria-label={`${weekday.name} availability`}
            >
              <div className="schedule-day-heading">
                <label>
                  <input
                    type="checkbox"
                    aria-label={`Open ${weekday.name}`}
                    checked={windows.length > 0}
                    disabled={disabled || (!windows.length && value.windows.length >= 70)}
                    onChange={(event) =>
                      event.target.checked
                        ? addWindow(weekday.day)
                        : onChange({
                            ...value,
                            windows: value.windows.filter((window) => window.day !== weekday.day),
                          })
                    }
                  />
                  <span>{weekday.name}</span>
                </label>
                {!windows.length && <span className="schedule-closed-label">Closed</span>}
              </div>
              <div className="schedule-day-windows">
                {windows.map((window, position) => (
                  <div className="schedule-window" key={window.index}>
                    <div className="schedule-time-range">
                      <Field label={`${weekday.name} session ${position + 1} start`}>
                        <input
                          type="time"
                          step="60"
                          value={window.start}
                          required
                          disabled={disabled}
                          onChange={(event) =>
                            updateWindow(window.index, { start: event.target.value })
                          }
                        />
                      </Field>
                      <span aria-hidden="true">–</span>
                      <Field label={`${weekday.name} session ${position + 1} end`}>
                        <input
                          type="time"
                          step="60"
                          value={window.end}
                          required
                          disabled={disabled}
                          onChange={(event) =>
                            updateWindow(window.index, { end: event.target.value })
                          }
                        />
                      </Field>
                    </div>
                    <Field label={`${weekday.name} session ${position + 1} consultation mode`}>
                      <select
                        disabled={disabled}
                        value={window.mode}
                        onChange={(event) =>
                          updateWindow(window.index, {
                            mode: event.target.value as ScheduleWindow['mode'],
                          })
                        }
                      >
                        <option value="both">In clinic & online</option>
                        <option value="in-person">In clinic only</option>
                        <option value="online">Online only</option>
                      </select>
                    </Field>
                    {editable && (
                      <button
                        disabled={disabled}
                        type="button"
                        className="icon-button"
                        aria-label={`Remove ${weekday.name} session ${position + 1}`}
                        onClick={() =>
                          onChange({
                            ...value,
                            windows: value.windows.filter((_, index) => index !== window.index),
                          })
                        }
                      >
                        <X size={16} />
                      </button>
                    )}
                  </div>
                ))}
                {editable && windows.length > 0 && (
                  <button
                    type="button"
                    className="button button-ghost button-small schedule-add-session"
                    disabled={disabled || value.windows.length >= 70}
                    onClick={() => addWindow(weekday.day)}
                    aria-label={`Add ${weekday.name} session`}
                  >
                    <Plus size={14} /> Add session
                  </button>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}
function WeeklyFrame({
  value,
  dirty,
  children,
}: {
  value: WeeklyAvailabilityValues;
  dirty: boolean;
  children: ReactNode;
}) {
  const openDays = new Set(value.windows.map((window) => window.day)).size;
  const weeklyMinutes = value.windows.reduce(
    (sum, window) => sum + Math.max(0, minutes(window.end) - minutes(window.start)),
    0,
  );
  return (
    <div className="schedule-workspace">
      <Card className="weekly-schedule">{children}</Card>
      <aside className="schedule-aside">
        <Card className="availability-summary">
          <span className="availability-summary-icon">
            <Clock3 size={23} />
          </span>
          <h2>A week with intention.</h2>
          <p>
            Give each visit the time it needs. Keep breaks and non-clinical work outside bookable
            sessions.
          </p>
          <dl>
            <div>
              <dt>Open days</dt>
              <dd>
                {openDays}
                <span> / week</span>
              </dd>
            </div>
            <div>
              <dt>Weekly bookable hours</dt>
              <dd>
                {Number((weeklyMinutes / 60).toFixed(1))}
                <span> hours</span>
              </dd>
            </div>
            <div>
              <dt>Appointment length</dt>
              <dd>
                {value.durationMinutes}
                <span> minutes</span>
              </dd>
            </div>
          </dl>
          {dirty && <small>Summary reflects your unsaved draft.</small>}
        </Card>
        <Card className="schedule-principles">
          <h3>Every booking stays protected</h3>
          <p>
            Hours and time off cannot be changed in a way that invalidates existing future
            appointments.
          </p>
          <p>
            Online sessions reserve a time only. Your clinic still shares the joining details
            separately.
          </p>
          <Link className="text-link" to="/clinic/appointments">
            Review appointments <CalendarClock size={15} />
          </Link>
        </Card>
      </aside>
    </div>
  );
}
export function WeeklyAvailabilityReadonly({ schedule }: { schedule: DoctorSchedule }) {
  return (
    <WeeklyFrame value={schedule} dirty={false}>
      <div className="schedule-editor-heading">
        <div>
          <h2>Weekly availability</h2>
          <p>Patients can book only within these hours.</p>
        </div>
        <Badge tone="green">
          <Check size={12} /> Current schedule
        </Badge>
      </div>
      <WeeklyFields value={schedule} editable={false} disabled onChange={() => {}} />
    </WeeklyFrame>
  );
}
function SnapshotView({ snapshot }: { snapshot: WeeklyAvailabilitySnapshot }) {
  return (
    <div className="weekly-availability-snapshot">
      <p>
        <strong>{snapshot.schedule.durationMinutes} minutes</strong> per default appointment ·{' '}
        {snapshot.source === 'inherited' ? 'Inherited defaults' : 'Explicitly saved hours'}
      </p>
      <dl>
        {weekdays.map((day) => (
          <div key={day.day}>
            <dt>{day.name}</dt>
            <dd>
              {snapshot.schedule.windows
                .filter((window) => window.day === day.day)
                .map(
                  (window) =>
                    `${window.start}–${window.end} IST · ${window.mode === 'both' ? 'In clinic & online' : window.mode === 'online' ? 'Online only' : 'In clinic only'}`,
                )
                .join('; ') || 'Closed'}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
function SourceAttribution({ source }: { source: WeeklyAvailabilityContext }) {
  return (
    <div className="weekly-availability-source">
      <strong>{source.doctor.name}</strong>
      {source.source === 'inherited' ? (
        <p>
          Inherited default availability. These hours have not been explicitly saved for this
          doctor. Review them before confirming the first saved schedule.
        </p>
      ) : source.latestChange ? (
        <p>
          Last changed by {source.latestChange.createdByName} ({source.latestChange.createdByRole})
          · {weeklyStamp(source.latestChange.createdAt)} IST
          {source.latestChange.source === 'legacy' ? ' · Earlier schedule update' : ''}
        </p>
      ) : (
        <p>
          Existing saved availability. No attributed change history is available for this earlier
          schedule.
        </p>
      )}
    </div>
  );
}
function WeeklyHistory({ doctorId, onClose }: { doctorId: string; onClose: () => void }) {
  const [page, setPage] = useState(1);
  const resource = useWeeklyData(
    `/api/schedules/${encodeURIComponent(doctorId)}/availability/history?page=${page}&pageSize=25`,
    (value) => checkedWeeklyHistory(value, doctorId, page),
  );
  useEffect(() => {
    if (!resource.loading && !resource.error && resource.data && resource.data.page !== page)
      setPage(resource.data.page);
  }, [resource.data, resource.loading, resource.error, page]);
  return (
    <Modal title="Weekly availability history" onClose={onClose}>
      <section className="weekly-availability-history stack">
        <p className="muted">
          Private changes to this doctor's weekly hours. Appointment records and time-off entries
          are separate.
        </p>
        <button
          type="button"
          className="button button-secondary"
          disabled={resource.loading}
          onClick={() => void resource.reload()}
        >
          Refresh availability history
        </button>
        {resource.loading ? (
          <Loading />
        ) : resource.error ? (
          <ErrorState message={resource.error} retry={() => void resource.reload()} />
        ) : (
          resource.data && (
            <>
              {resource.data.items.length ? (
                resource.data.items.map((change) => (
                  <article className="weekly-availability-change" key={change.id}>
                    <div className="row between">
                      <strong>{change.doctorName}</strong>
                      <Badge tone={change.source === 'reviewed' ? 'green' : 'neutral'}>
                        {change.source === 'reviewed'
                          ? 'Reviewed change'
                          : 'Earlier schedule update'}
                      </Badge>
                    </div>
                    <p>
                      {change.createdByName} ({change.createdByRole}) ·{' '}
                      {weeklyStamp(change.createdAt)} IST
                    </p>
                    <p className="weekly-availability-reason">
                      {change.reason ||
                        'No private reason was recorded by the earlier availability workflow.'}
                    </p>
                    <details>
                      <summary>View previous and saved hours</summary>
                      <div className="weekly-availability-comparison">
                        <section>
                          <h3>Previous hours</h3>
                          <SnapshotView snapshot={change.before} />
                        </section>
                        <section>
                          <h3>Saved hours</h3>
                          <SnapshotView snapshot={change.after} />
                        </section>
                      </div>
                    </details>
                  </article>
                ))
              ) : (
                <EmptyState
                  title="No weekly changes recorded"
                  description="No weekly availability changes have been recorded for this doctor."
                />
              )}
              <Pagination
                {...resource.data}
                label="Weekly availability history pagination"
                onPageChange={setPage}
              />
            </>
          )
        )}
      </section>
    </Modal>
  );
}

export function WeeklyAvailabilityEditor({
  doctorId,
  onLockChange,
  onSaved,
}: {
  doctorId: string;
  onLockChange: (locked: boolean) => void;
  onSaved: () => void;
}) {
  const resource = useWeeklyData(
    `/api/schedules/${encodeURIComponent(doctorId)}/availability`,
    (value) => checkedWeeklyContext(value, doctorId),
  );
  const [initial, setInitial] = useState<WeeklyAvailabilityContext | null>(null);
  useEffect(() => {
    if (!initial && resource.data) setInitial(resource.data);
  }, [initial, resource.data]);
  return initial ? (
    <WeeklyDraft initial={initial} onLockChange={onLockChange} onSaved={onSaved} />
  ) : resource.loading ? (
    <Loading />
  ) : (
    <ErrorState
      message={resource.error || 'Weekly availability is unavailable.'}
      retry={() => void resource.reload()}
    />
  );
}
function WeeklyDraft({
  initial,
  onLockChange,
  onSaved,
}: {
  initial: WeeklyAvailabilityContext;
  onLockChange: (locked: boolean) => void;
  onSaved: () => void;
}) {
  const { session } = useSession(),
    toast = useToast(),
    begin = useWeeklyGuard();
  const [source, setSource] = useState(initial),
    [draft, setDraft] = useState(() => weeklyValues(initial.schedule));
  const [reason, setReason] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [phase, setPhase] = useState<'editing' | 'conflict' | 'uncertain'>('editing'),
    [reviewed, setReviewed] = useState<WeeklyAvailabilityContext | null>(null),
    [history, setHistory] = useState(false),
    [bookingConflict, setBookingConflict] = useState(false);
  const attempt = useRef<WeeklyAttempt | null>(null),
    pending = useRef(false),
    lockCallback = useRef(onLockChange);
  lockCallback.current = onLockChange;
  const locked = busy || phase === 'uncertain';
  useLayoutEffect(() => {
    lockCallback.current(locked);
    return () => lockCallback.current(false);
  }, [locked]);
  const dirty = !sameWeeklyValues(draft, source.schedule),
    canSave = dirty || source.source === 'inherited';
  function update(value: WeeklyAvailabilityValues) {
    if (pending.current || phase !== 'editing') return;
    setDraft(value);
    setConfirmed(false);
    setError('');
    setBookingConflict(false);
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      pending.current ||
      phase === 'conflict' ||
      !session.user ||
      !['admin', 'doctor'].includes(session.user.role)
    )
      return;
    const wasUncertain = phase === 'uncertain';
    if (!wasUncertain && (!confirmed || !reason.trim() || !canSave)) return;
    const invalid = validateWeeklyDraft(draft);
    if (!wasUncertain && invalid) {
      setError(invalid);
      return;
    }
    const sent = attempt.current ?? {
      source,
      actorId: session.user.id,
      actorRole: session.user.role as 'admin' | 'doctor',
      body: {
        schedule: weeklyValues(draft),
        reason: reason.trim(),
        expectedRevision: source.revision,
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
    try {
      const response = await api<unknown>(
        `/api/schedules/${encodeURIComponent(initial.doctor.id)}/availability`,
        { method: 'POST', body: sent.body, isCurrent: current },
      );
      if (!current()) return;
      const result = checkedWeeklyMutation(response, sent);
      setSource(result.context);
      setDraft(weeklyValues(result.context.schedule));
      setReason('');
      setConfirmed(false);
      setReviewed(null);
      attempt.current = null;
      setPhase('editing');
      onSaved();
      toast('Availability saved. New bookings now use this schedule.');
    } catch (problem) {
      if (!current()) return;
      setError(weeklyFailure(problem));
      if (
        problem instanceof ApiError &&
        problem.status === 409 &&
        problem.message ===
          "Weekly availability changed. Refresh and review this doctor's latest schedule before saving."
      ) {
        setPhase('conflict');
        setReviewed(null);
        setConfirmed(false);
        attempt.current = null;
      } else if (
        problem instanceof ApiError &&
        problem.status === 409 &&
        /^This schedule would invalidate \d+ booked appointments?\. Reschedule or cancel the affected appointments first\.$/.test(
          problem.message,
        )
      ) {
        setPhase('editing');
        setConfirmed(false);
        setBookingConflict(true);
        attempt.current = null;
      } else if (
        !wasUncertain &&
        problem instanceof ApiError &&
        [400, 403, 404, 413, 422, 429].includes(problem.status)
      ) {
        setPhase('editing');
        setConfirmed(false);
        attempt.current = null;
      }
    } finally {
      pending.current = false;
      if (current()) setBusy(false);
    }
  }
  async function refresh() {
    if (pending.current) return;
    const current = begin();
    pending.current = true;
    setBusy(true);
    setError('');
    setReviewed(null);
    try {
      const response = await api<unknown>(
        `/api/schedules/${encodeURIComponent(initial.doctor.id)}/availability`,
        { isCurrent: current },
      );
      if (current()) setReviewed(checkedWeeklyContext(response, initial.doctor.id));
    } catch (problem) {
      if (current()) setError(weeklyFailure(problem));
    } finally {
      pending.current = false;
      if (current()) setBusy(false);
    }
  }
  return (
    <>
      <WeeklyFrame value={draft} dirty={dirty}>
        <form className="weekly-availability-form" onSubmit={save}>
          <div className="schedule-editor-heading">
            <div>
              <h2>Weekly availability</h2>
              <p>Patients can book only within these hours.</p>
            </div>
            {dirty ? (
              <Badge tone="amber">Unsaved changes</Badge>
            ) : (
              <Badge tone={source.source === 'inherited' ? 'neutral' : 'green'}>
                {source.source === 'inherited' ? (
                  'Inherited defaults'
                ) : (
                  <>
                    <Check size={12} /> Current schedule
                  </>
                )}
              </Badge>
            )}
          </div>
          <SourceAttribution source={source} />
          <button
            type="button"
            className="button button-secondary button-small weekly-history-button"
            disabled={locked}
            onClick={() => setHistory(true)}
          >
            Weekly change history
          </button>
          {error && (
            <div className="notice notice-error schedule-error" role="alert">
              <strong>{error}</strong>
              {bookingConflict && (
                <p>
                  Existing bookings have not been changed. Adjust these draft hours or{' '}
                  <Link to="/clinic/appointments">review affected appointments</Link> before
                  submitting again.
                </p>
              )}
            </div>
          )}
          {phase === 'uncertain' && !busy && (
            <div className="notice weekly-availability-notice">
              The save outcome could not be confirmed. Your exact request is retained. Retry the
              same request before editing or selecting another doctor.
            </div>
          )}
          {phase === 'conflict' && (
            <section className="weekly-availability-conflict stack">
              <p>
                Your draft and private reason are retained. Review the latest saved hours before
                confirming a new attempt.
              </p>
              <button
                type="button"
                className="button button-secondary"
                disabled={busy}
                onClick={() => void refresh()}
              >
                {busy ? 'Refreshing…' : 'Refresh latest availability'}
              </button>
              {reviewed && (
                <div className="weekly-availability-latest stack">
                  <h3>Latest saved availability</h3>
                  <SourceAttribution source={reviewed} />
                  <SnapshotView snapshot={reviewed} />
                  {reviewed.latestChange?.reason && <p>{reviewed.latestChange.reason}</p>}
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={busy}
                    onClick={() => {
                      setSource(reviewed);
                      setReviewed(null);
                      attempt.current = null;
                      setConfirmed(false);
                      setPhase('editing');
                      setError('');
                    }}
                  >
                    I reviewed the latest availability; keep my draft
                  </button>
                </div>
              )}
            </section>
          )}
          <WeeklyFields
            value={draft}
            editable
            disabled={busy || phase !== 'editing'}
            onChange={update}
          />
          <div className="weekly-availability-review stack">
            <Field
              label="Reason for availability change"
              hint="Private to administrators and this doctor. Patients see bookable hours, not this reason."
            >
              <textarea
                value={reason}
                required
                maxLength={1000}
                disabled={busy || phase !== 'editing'}
                onChange={(event) => {
                  setReason(event.target.value);
                  setConfirmed(false);
                }}
              />
            </Field>
            <label className="weekly-availability-confirm">
              <input
                type="checkbox"
                required
                checked={confirmed}
                disabled={busy || phase !== 'editing'}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <span>I reviewed these weekly hours and appointment length.</span>
            </label>
          </div>
          <div className="schedule-save">
            <span>
              {dirty
                ? 'Your changes are not yet available to patients.'
                : source.source === 'inherited'
                  ? 'Confirming saves these inherited defaults as this doctor’s explicit schedule.'
                  : 'Your weekly hours are up to date.'}
            </span>
            <div>
              <button
                type="button"
                className="button button-secondary"
                disabled={busy || phase !== 'editing'}
                onClick={() => {
                  setDraft(weeklyValues(source.schedule));
                  setReason('');
                  setConfirmed(false);
                  setError('');
                  setBookingConflict(false);
                }}
              >
                Reset changes
              </button>
              <button
                className="button button-primary"
                disabled={busy || phase === 'conflict' || (phase !== 'uncertain' && !canSave)}
              >
                <Save size={16} />
                {busy
                  ? 'Saving…'
                  : phase === 'uncertain'
                    ? 'Retry same request'
                    : 'Save availability'}
              </button>
            </div>
          </div>
        </form>
      </WeeklyFrame>
      {history && <WeeklyHistory doctorId={initial.doctor.id} onClose={() => setHistory(false)} />}
    </>
  );
}
