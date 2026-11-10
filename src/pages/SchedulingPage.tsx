import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  CalendarClock,
  CalendarOff,
  Check,
  Clock3,
  Globe2,
  Plus,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import type { Doctor } from '../../shared/types';
import type {
  DoctorSchedule,
  ScheduleClosure,
  ScheduleWindow,
  SchedulingData,
} from '../../shared/scheduling';
import { ApiError, api, formatDate, today, useResource, useSession, useToast } from '../lib';
import {
  Avatar,
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  Modal,
  PageHeader,
} from '../components/ui';
import './scheduling.css';

const weekdays = [
  { day: 1, name: 'Monday' },
  { day: 2, name: 'Tuesday' },
  { day: 3, name: 'Wednesday' },
  { day: 4, name: 'Thursday' },
  { day: 5, name: 'Friday' },
  { day: 6, name: 'Saturday' },
  { day: 0, name: 'Sunday' },
];
const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
const clock = (value: number) =>
  `${Math.floor(value / 60)
    .toString()
    .padStart(2, '0')}:${(value % 60).toString().padStart(2, '0')}`;
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Please try again.';
const sortedWindows = (windows: ScheduleWindow[]) =>
  [...windows].sort((a, b) => a.day - b.day || a.start.localeCompare(b.start));
function scheduleSignature(schedule: Pick<DoctorSchedule, 'windows' | 'durationMinutes'>) {
  return JSON.stringify({
    durationMinutes: schedule.durationMinutes,
    windows: sortedWindows(schedule.windows),
  });
}
function ClosurePeriod({ closure }: { closure: ScheduleClosure }) {
  return (
    <>
      <strong>
        {formatDate(closure.startDate)}
        {closure.endDate !== closure.startDate ? ` – ${formatDate(closure.endDate)}` : ''}
      </strong>
      <span>
        {closure.startTime ? `${closure.startTime} – ${closure.endTime} IST each day` : 'All day'}
      </span>
    </>
  );
}

export function SchedulingPage() {
  const { session } = useSession();
  const scheduling = useResource<SchedulingData>('/api/scheduling');
  const doctors = useResource<Doctor[]>('/api/doctors');
  const toast = useToast();
  const [doctorId, setDoctorId] = useState(session.user?.doctorId || '');
  const [draft, setDraft] = useState<DoctorSchedule | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [addingClosure, setAddingClosure] = useState(false);
  const [removing, setRemoving] = useState<ScheduleClosure | null>(null);
  const [removalBusy, setRemovalBusy] = useState(false);
  const [removalError, setRemovalError] = useState('');
  const isAdmin = session.user?.role === 'admin';
  const canEdit =
    isAdmin || (session.user?.role === 'doctor' && session.user.doctorId === doctorId);
  const selectedDoctor = doctors.data?.find((d) => d.id === doctorId);
  const savedSchedule = scheduling.data?.schedules.find((s) => s.doctorId === doctorId);
  const savedSignature = savedSchedule
    ? `${savedSchedule.doctorId}:${scheduleSignature(savedSchedule)}`
    : '';
  const dirty =
    !!draft && !!savedSchedule && scheduleSignature(draft) !== scheduleSignature(savedSchedule);
  useEffect(() => {
    if (!doctorId && doctors.data?.length) setDoctorId(doctors.data[0].id);
  }, [doctorId, doctors.data]);
  useEffect(() => {
    setDraft(savedSchedule ? structuredClone(savedSchedule) : null);
    setError('');
    setConflict(false);
  }, [savedSignature]);
  const closures = useMemo(
    () =>
      (scheduling.data?.closures || [])
        .filter((c) => c.endDate >= today() && (!c.doctorId || c.doctorId === doctorId))
        .sort(
          (a, b) =>
            a.startDate.localeCompare(b.startDate) ||
            (a.startTime || '').localeCompare(b.startTime || ''),
        ),
    [scheduling.data, doctorId],
  );
  const openDays = new Set(draft?.windows.map((w) => w.day) || []).size;
  const weeklyMinutes = (draft?.windows || []).reduce(
    (sum, w) => sum + Math.max(0, minutes(w.end) - minutes(w.start)),
    0,
  );
  function updateWindow(index: number, changes: Partial<ScheduleWindow>) {
    setDraft((current) =>
      current
        ? {
            ...current,
            windows: current.windows.map((window, i) =>
              i === index ? { ...window, ...changes } : window,
            ),
          }
        : current,
    );
  }
  function addWindow(day: number) {
    setDraft((current) => {
      if (!current) return current;
      const windows = current.windows.filter((w) => w.day === day);
      const start = windows.length
        ? Math.min(22 * 60, Math.max(...windows.map((w) => minutes(w.end))) + 60)
        : 9 * 60;
      return {
        ...current,
        windows: [
          ...current.windows,
          {
            day,
            start: clock(start),
            end: clock(windows.length ? Math.min(23 * 60 + 59, start + 120) : 18 * 60),
            mode: 'both',
          },
        ],
      };
    });
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || !canEdit) return;
    setError('');
    setConflict(false);
    for (const weekday of weekdays) {
      const sessions = sortedWindows(draft.windows.filter((w) => w.day === weekday.day));
      if (
        sessions.some(
          (w) => !w.start || !w.end || minutes(w.end) - minutes(w.start) < draft.durationMinutes,
        )
      ) {
        setError(
          `${weekday.name}: each session must have room for at least one ${draft.durationMinutes}-minute appointment.`,
        );
        return;
      }
      if (sessions.some((w, i) => i > 0 && minutes(w.start) < minutes(sessions[i - 1].end))) {
        setError(
          `${weekday.name}: sessions must not overlap. Leave a gap between sessions for a break.`,
        );
        return;
      }
    }
    setSaving(true);
    try {
      await api(`/api/schedules/${doctorId}`, {
        method: 'PUT',
        body: { durationMinutes: draft.durationMinutes, windows: sortedWindows(draft.windows) },
      });
      await scheduling.reload();
      await doctors.reload();
      toast('Availability saved. New bookings now use this schedule.');
    } catch (e) {
      setError(errorMessage(e));
      setConflict(e instanceof ApiError && e.status === 409);
    } finally {
      setSaving(false);
    }
  }
  async function removeClosure() {
    if (!removing) return;
    setRemovalBusy(true);
    setRemovalError('');
    try {
      await api(`/api/schedule-closures/${removing.id}`, { method: 'DELETE' });
      setRemoving(null);
      await scheduling.reload();
      toast('Time off removed. Available hours are open for booking again.');
    } catch (e) {
      setRemovalError(errorMessage(e));
    } finally {
      setRemovalBusy(false);
    }
  }
  if ((scheduling.loading && !scheduling.data) || (doctors.loading && !doctors.data))
    return <Loading />;
  if (scheduling.error || doctors.error)
    return (
      <ErrorState
        message={scheduling.error || doctors.error}
        retry={() => {
          void scheduling.reload();
          void doctors.reload();
        }}
      />
    );
  return (
    <>
      <PageHeader
        eyebrow="MAKE ROOM FOR BETTER CARE"
        title="Availability & time off"
        description="Set a considered rhythm for each doctor, with space for breaks and time away."
        actions={
          canEdit ? (
            <button
              className="button button-primary"
              disabled={!doctorId}
              onClick={() => setAddingClosure(true)}
            >
              <CalendarOff size={17} /> Add time off
            </button>
          ) : undefined
        }
      />
      {!doctors.data?.length ? (
        <Card>
          <EmptyState
            title="Start with a doctor profile"
            description="Add a doctor to the clinic before setting their bookable hours."
            action={
              isAdmin ? (
                <Link className="button button-primary" to="/clinic/settings">
                  Open clinic settings
                </Link>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <>
          <div className="schedule-selector">
            <div className="schedule-doctor">
              <Avatar name={selectedDoctor?.name || 'Doctor'} color={selectedDoctor?.color} />
              <Field label="Doctor schedule">
                <select
                  value={doctorId}
                  onChange={(e) => setDoctorId(e.target.value)}
                  disabled={saving}
                >
                  {doctors.data.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="schedule-timezone">
              <Globe2 size={16} />
              <span>
                India Standard Time · UTC +05:30
                <br />
                <small>Bookable up to {scheduling.data?.bookingWindowDays || 180} days ahead</small>
              </span>
            </div>
          </div>
          {!canEdit && (
            <div className="notice schedule-readonly">
              <CalendarClock size={18} />
              <span>
                {session.user?.role === 'doctor'
                  ? 'You can view this doctor’s hours. Choose your own profile to manage your availability.'
                  : 'You have read-only access to availability. A doctor or administrator can update it.'}
              </span>
            </div>
          )}
          <div className="schedule-workspace">
            <Card className="weekly-schedule">
              <form onSubmit={save}>
                <div className="schedule-editor-heading">
                  <div>
                    <h2>Weekly availability</h2>
                    <p>Patients can book only within these hours.</p>
                  </div>
                  {dirty ? (
                    <Badge tone="amber">Unsaved changes</Badge>
                  ) : (
                    <Badge tone="green">
                      <Check size={12} /> Current schedule
                    </Badge>
                  )}
                </div>
                {draft ? (
                  <>
                    <div className="schedule-duration">
                      <Field label="Appointment length">
                        <select
                          disabled={!canEdit || saving}
                          value={draft.durationMinutes}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              durationMinutes: Number(
                                e.target.value,
                              ) as DoctorSchedule['durationMinutes'],
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
                      <p>
                        Applies to new appointments. Existing bookings keep their recorded duration.
                      </p>
                    </div>
                    <div className="schedule-weekdays">
                      {weekdays.map((weekday) => {
                        const windows = draft.windows
                          .map((w, index) => ({ ...w, index }))
                          .filter((w) => w.day === weekday.day);
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
                                  disabled={!canEdit || saving}
                                  onChange={(e) =>
                                    e.target.checked
                                      ? addWindow(weekday.day)
                                      : setDraft({
                                          ...draft,
                                          windows: draft.windows.filter(
                                            (w) => w.day !== weekday.day,
                                          ),
                                        })
                                  }
                                />
                                <span>{weekday.name}</span>
                              </label>
                              {!windows.length && (
                                <span className="schedule-closed-label">Closed</span>
                              )}
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
                                        disabled={!canEdit || saving}
                                        onChange={(e) =>
                                          updateWindow(window.index, { start: e.target.value })
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
                                        disabled={!canEdit || saving}
                                        onChange={(e) =>
                                          updateWindow(window.index, { end: e.target.value })
                                        }
                                      />
                                    </Field>
                                  </div>
                                  <Field
                                    label={`${weekday.name} session ${position + 1} consultation mode`}
                                  >
                                    <select
                                      disabled={!canEdit || saving}
                                      value={window.mode}
                                      onChange={(e) =>
                                        updateWindow(window.index, {
                                          mode: e.target.value as ScheduleWindow['mode'],
                                        })
                                      }
                                    >
                                      <option value="both">In clinic & online</option>
                                      <option value="in-person">In clinic only</option>
                                      <option value="online">Online only</option>
                                    </select>
                                  </Field>
                                  {canEdit && (
                                    <button
                                      disabled={saving}
                                      type="button"
                                      className="icon-button"
                                      aria-label={`Remove ${weekday.name} session ${position + 1}`}
                                      onClick={() =>
                                        setDraft({
                                          ...draft,
                                          windows: draft.windows.filter(
                                            (_, index) => index !== window.index,
                                          ),
                                        })
                                      }
                                    >
                                      <X size={16} />
                                    </button>
                                  )}
                                </div>
                              ))}
                              {canEdit && windows.length > 0 && (
                                <button
                                  type="button"
                                  className="button button-ghost button-small schedule-add-session"
                                  disabled={saving}
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
                    {error && (
                      <div className="notice notice-error schedule-error" role="alert">
                        <strong>{error}</strong>
                        {conflict && (
                          <p>
                            Reschedule or cancel affected future appointments before changing these
                            hours. Existing bookings have not been changed.{' '}
                            <Link to="/clinic/appointments">Review appointments</Link>
                          </p>
                        )}
                      </div>
                    )}
                    {canEdit && (
                      <div className="schedule-save">
                        <span>
                          {dirty
                            ? 'Your changes are not yet available to patients.'
                            : 'Your weekly hours are up to date.'}
                        </span>
                        <div>
                          <button
                            type="button"
                            className="button button-secondary"
                            disabled={!dirty || saving}
                            onClick={() => {
                              setDraft(savedSchedule ? structuredClone(savedSchedule) : null);
                              setError('');
                              setConflict(false);
                            }}
                          >
                            Reset changes
                          </button>
                          <button className="button button-primary" disabled={!dirty || saving}>
                            <Save size={16} />
                            {saving ? 'Saving…' : 'Save availability'}
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <EmptyState
                    title="No schedule available"
                    description="Refresh to load this doctor’s availability."
                    action={
                      <button
                        type="button"
                        className="button button-secondary"
                        onClick={scheduling.reload}
                      >
                        Refresh schedule
                      </button>
                    }
                  />
                )}
              </form>
            </Card>
            <aside className="schedule-aside">
              <Card className="availability-summary">
                <span className="availability-summary-icon">
                  <Clock3 size={23} />
                </span>
                <h2>A week with intention.</h2>
                <p>
                  Give each visit the time it needs. Keep breaks and non-clinical work outside
                  bookable sessions.
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
                      {draft?.durationMinutes || 30}
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
          <Card className="schedule-closures">
            <div className="schedule-editor-heading">
              <div>
                <h2>Upcoming time off</h2>
                <p>
                  Exceptions for {selectedDoctor?.name || 'this doctor'} and clinic-wide closures.
                </p>
              </div>
              {canEdit && (
                <button className="button button-secondary" onClick={() => setAddingClosure(true)}>
                  <Plus size={16} /> Add time off
                </button>
              )}
            </div>
            {closures.length ? (
              <div className="schedule-closure-list">
                {closures.map((closure) => {
                  const editable =
                    isAdmin ||
                    (session.user?.role === 'doctor' && closure.doctorId === session.user.doctorId);
                  return (
                    <article className="schedule-closure" key={closure.id}>
                      <span className="schedule-closure-icon">
                        <CalendarOff size={20} />
                      </span>
                      <div className="schedule-closure-copy">
                        <h3>{closure.reason}</h3>
                        <div className="schedule-closure-period">
                          <ClosurePeriod closure={closure} />
                        </div>
                      </div>
                      <Badge tone={closure.doctorId ? 'neutral' : 'amber'}>
                        {closure.doctorId ? 'Doctor time off' : 'Whole clinic'}
                      </Badge>
                      {editable && (
                        <button
                          className="button button-ghost button-small"
                          aria-label={`Remove time off: ${closure.reason}`}
                          onClick={() => {
                            setRemoving(closure);
                            setRemovalError('');
                          }}
                        >
                          <Trash2 size={15} /> Remove
                        </button>
                      )}
                    </article>
                  );
                })}
              </div>
            ) : (
              <EmptyState
                title="No upcoming time off"
                description="Weekly hours apply as usual. Add leave, holidays or a one-off break when needed."
              />
            )}
          </Card>
        </>
      )}
      {addingClosure && selectedDoctor && (
        <ClosureModal
          doctor={selectedDoctor}
          isAdmin={isAdmin}
          onClose={() => setAddingClosure(false)}
          onSaved={async () => {
            setAddingClosure(false);
            await scheduling.reload();
          }}
        />
      )}
      {removing && (
        <Modal title="Remove time off?" onClose={() => setRemoving(null)}>
          <div className="stack">
            <div>
              <h3>{removing.reason}</h3>
              <div className="schedule-closure-period">
                <ClosurePeriod closure={removing} />
              </div>
            </div>
            <p className="muted">
              These hours will become bookable again wherever they fall within the weekly schedule.
            </p>
            {removalError && (
              <div className="notice notice-error" role="alert">
                {removalError}
              </div>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="button button-secondary"
                onClick={() => setRemoving(null)}
              >
                Keep time off
              </button>
              <button
                className="button button-primary"
                disabled={removalBusy}
                onClick={removeClosure}
              >
                {removalBusy ? 'Removing…' : 'Remove time off'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

function ClosureModal({
  doctor,
  isAdmin,
  onClose,
  onSaved,
}: {
  doctor: Doctor;
  isAdmin: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [scope, setScope] = useState(doctor.id);
  const [startDate, setStartDate] = useState(today());
  const [endDate, setEndDate] = useState(today());
  const [allDay, setAllDay] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const toast = useToast();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    setError('');
    setConflict(false);
    if (endDate < startDate) {
      setError('The last day must be on or after the first day.');
      return;
    }
    if (!allDay && String(values.endTime) <= String(values.startTime)) {
      setError('The end time must be later than the start time.');
      return;
    }
    setBusy(true);
    try {
      await api('/api/schedule-closures', {
        method: 'POST',
        body: {
          doctorId: scope === 'clinic' ? null : scope,
          startDate,
          endDate,
          startTime: allDay ? null : values.startTime,
          endTime: allDay ? null : values.endTime,
          reason: values.reason,
        },
      });
      toast('Time off saved. These hours are no longer available for new bookings.');
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
      setConflict(e instanceof ApiError && e.status === 409);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Add time off" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="Applies to">
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            disabled={!isAdmin || busy}
          >
            <option value={doctor.id}>{doctor.name}</option>
            {isAdmin && <option value="clinic">Whole clinic · all doctors</option>}
          </select>
        </Field>
        <Field label="Reason">
          <input
            name="reason"
            required
            maxLength={300}
            placeholder="For example, annual leave or clinic holiday"
          />
        </Field>
        <div className="form-grid">
          <Field label="First day">
            <input
              required
              type="date"
              value={startDate}
              onChange={(e) => {
                setStartDate(e.target.value);
                if (e.target.value > endDate) setEndDate(e.target.value);
              }}
            />
          </Field>
          <Field label="Last day">
            <input
              required
              type="date"
              min={startDate > today() ? startDate : today()}
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </Field>
        </div>
        <label className="checkbox-field">
          <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
          <span>All day</span>
        </label>
        {!allDay && (
          <>
            <div className="form-grid">
              <Field label="Unavailable from">
                <input type="time" name="startTime" defaultValue="13:00" required />
              </Field>
              <Field label="Unavailable until">
                <input type="time" name="endTime" defaultValue="14:00" required />
              </Field>
            </div>
            <p className="muted small">
              This time range applies on every included date, in India Standard Time.
            </p>
          </>
        )}
        <div className="notice">
          Existing appointments remain protected. If there is a conflict, reschedule or cancel the
          affected bookings before adding time off.
        </div>
        {error && (
          <div className="notice notice-error schedule-error" role="alert">
            <strong>{error}</strong>
            {conflict && (
              <p>
                Resolve the affected appointments first, or choose different dates. No bookings have
                been cancelled. <Link to="/clinic/appointments">Review appointments</Link>
              </p>
            )}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="button button-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save time off'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
