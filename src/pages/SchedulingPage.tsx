import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { CalendarClock, CalendarOff, Globe2, Plus, Trash2 } from 'lucide-react';
import type { Doctor } from '../../shared/types';
import type { ScheduleClosure, SchedulingData } from '../../shared/scheduling';
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
import {
  WeeklyAvailabilityEditor,
  WeeklyAvailabilityReadonly,
} from '../components/WeeklyAvailabilityEditor';

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Please try again.';
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
  const location = useLocation();
  const scheduling = useResource<SchedulingData>('/api/scheduling');
  const doctors = useResource<Doctor[]>('/api/doctors');
  const toast = useToast();
  const [doctorId, setDoctorId] = useState(session.user?.doctorId || '');
  const [saving, setSaving] = useState(false);
  const [addingClosure, setAddingClosure] = useState(false);
  const [removing, setRemoving] = useState<ScheduleClosure | null>(null);
  const [removalBusy, setRemovalBusy] = useState(false);
  const [removalError, setRemovalError] = useState('');
  const isAdmin = session.user?.role === 'admin';
  const canEdit =
    isAdmin || (session.user?.role === 'doctor' && session.user.doctorId === doctorId);
  const selectedDoctor = doctors.data?.find((d) => d.id === doctorId);
  const savedSchedule = scheduling.data?.schedules.find((s) => s.doctorId === doctorId);
  useEffect(() => {
    if (!doctorId && doctors.data?.length) setDoctorId(doctors.data[0].id);
  }, [doctorId, doctors.data]);
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
  if ((!scheduling.data && scheduling.error) || (!doctors.data && doctors.error))
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
      {(scheduling.error || doctors.error) && (
        <ErrorState
          message={scheduling.error || doctors.error}
          retry={() => {
            void scheduling.reload();
            void doctors.reload();
          }}
        />
      )}
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
                  onChange={(e) => {
                    if (!saving) setDoctorId(e.target.value);
                  }}
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
          {!selectedDoctor ? (
            <Loading />
          ) : canEdit ? (
            <WeeklyAvailabilityEditor
              key={`${doctorId}:${location.key}`}
              doctorId={doctorId}
              onLockChange={setSaving}
              onSaved={() => {
                void scheduling.reload();
                void doctors.reload();
              }}
            />
          ) : savedSchedule ? (
            <WeeklyAvailabilityReadonly schedule={savedSchedule} />
          ) : (
            <EmptyState
              title="No schedule available"
              description="Refresh to load this doctor's availability."
            />
          )}
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
