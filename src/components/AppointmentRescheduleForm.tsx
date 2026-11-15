import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Appointment, Doctor } from '../../shared/types';
import type {
  AppointmentRescheduleContext,
  AppointmentReschedulePreview,
  AppointmentRescheduleResult,
  AppointmentRescheduleTarget,
} from '../../shared/appointment-rescheduling';
import { api, ApiError, formatDate, money, useSession } from '../lib';
import { Badge, EmptyState, ErrorState, Field, Loading } from './ui';
import {
  useAppointmentBookingData,
  useAppointmentBookingGuard,
} from './appointment-booking-helpers';
import {
  checkedVisitSlots,
  visitDate,
  visitMinutes,
  visitPolicy,
  visitTime,
} from './visit-duration-helpers';
import {
  checkedRescheduleContext,
  checkedReschedulePreview,
  checkedRescheduleResult,
  rescheduleEnd,
  rescheduleFailure,
  rescheduleNotApplied,
  sameRescheduleAppointment,
  sameRescheduleTarget,
  type RescheduleAttempt,
} from './appointment-rescheduling-helpers';
import './appointment-rescheduling.css';

function VisitFacts({ appointment }: { appointment: Appointment }) {
  const end = rescheduleEnd(appointment);
  return (
    <div className="appointment-reschedule-facts">
      <strong>{appointment.doctorName}</strong>
      <p>
        Start: {formatDate(appointment.date)} · {appointment.time} IST
      </p>
      <p>
        End: {formatDate(end.date)} · {end.time} IST
      </p>
      <p>
        {appointment.mode === 'online' ? 'Online consultation' : 'In clinic'} ·{' '}
        {visitMinutes(appointment)} minutes
      </p>
      <p>
        {visitPolicy(appointment) === 'custom' ? 'Custom length' : 'Default consultation'} · Visit
        fee: {money(appointment.fee)}
      </p>
      <Badge>{appointment.status.replaceAll('-', ' ')}</Badge>
    </div>
  );
}

export function AppointmentRescheduleForm({
  appointmentId,
  pendingAttempt,
  onPendingAttemptChange,
  onConfirmed,
  onBusyChange,
}: {
  appointmentId: string;
  pendingAttempt?: RescheduleAttempt | null;
  onPendingAttemptChange?: (attempt: RescheduleAttempt | null) => void;
  onConfirmed?: (result: AppointmentRescheduleResult) => void | Promise<void>;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { session } = useSession(),
    capture = useAppointmentBookingGuard();
  const patient = session.user?.role === 'patient';
  const path = `/api/appointments/${encodeURIComponent(appointmentId)}`;
  function checkedSource(value: unknown) {
    const checked = checkedRescheduleContext(value, appointmentId);
    if (patient && checked.appointment.patientId !== session.user?.patientId)
      throw new Error(
        'The visit could not be confirmed as your appointment. Refresh to try again.',
      );
    return checked;
  }
  const context = useAppointmentBookingData(`${path}/reschedule-context`, (value) =>
    checkedSource(value),
  );
  const doctors = useAppointmentBookingData<Doctor[]>('/api/doctors', (value) => {
    if (
      !Array.isArray(value) ||
      value.some(
        (doctor) =>
          !doctor ||
          typeof doctor.id !== 'string' ||
          !doctor.id ||
          typeof doctor.name !== 'string' ||
          !doctor.name ||
          typeof doctor.fee !== 'number' ||
          !Number.isFinite(doctor.fee) ||
          doctor.fee < 0 ||
          (doctor.acceptingNewBookings !== undefined &&
            typeof doctor.acceptingNewBookings !== 'boolean'),
      )
    )
      throw new Error('The doctor choices could not be confirmed. Refresh to try again.');
    return value as Doctor[];
  });
  const [source, setSource] = useState<AppointmentRescheduleContext | null>(
    pendingAttempt?.source ?? null,
  );
  const [target, setTarget] = useState<AppointmentRescheduleTarget>(() =>
    pendingAttempt
      ? {
          doctorId: pendingAttempt.body.doctorId,
          date: pendingAttempt.body.date,
          time: pendingAttempt.body.time,
          mode: pendingAttempt.body.mode,
        }
      : { doctorId: '', date: '', time: '', mode: 'in-person' },
  );
  const [preview, setPreview] = useState<AppointmentReschedulePreview | null>(
    pendingAttempt?.preview ?? null,
  );
  const [attempt, setAttempt] = useState<RescheduleAttempt | null>(pendingAttempt ?? null);
  const [phase, setPhase] = useState<'editing' | 'review' | 'conflict' | 'uncertain'>(
    pendingAttempt ? 'uncertain' : 'editing',
  );
  const [confirmed, setConfirmed] = useState(!!pendingAttempt),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [result, setResult] = useState<AppointmentRescheduleResult | null>(null);
  const working = useRef(false),
    latest = useRef(target),
    busyCallback = useRef(onBusyChange);
  latest.current = target;
  busyCallback.current = onBusyChange;
  useEffect(
    () => () => {
      busyCallback.current?.(false);
    },
    [],
  );
  useEffect(() => {
    if (!source && context.data) {
      setSource(context.data);
      const a = context.data.appointment;
      setTarget({ doctorId: a.doctorId, date: a.date, time: a.time, mode: a.mode });
    }
  }, [source, context.data]);
  function workingState(value: boolean) {
    working.current = value;
    setBusy(value);
    busyCallback.current?.(value);
  }
  const selectedDoctor = doctors.data?.find((doctor) => doctor.id === target.doctorId);
  const sameDoctor = target.doctorId === source?.appointment.doctorId;
  const paused = selectedDoctor?.acceptingNewBookings === false;
  const locked = busy || phase !== 'editing';
  const slots = useAppointmentBookingData(
    source?.canReschedule &&
      phase === 'editing' &&
      target.doctorId &&
      visitDate(target.date) &&
      (!paused || sameDoctor)
      ? `/api/slots?doctorId=${encodeURIComponent(target.doctorId)}&date=${target.date}&mode=${target.mode}&excludeAppointmentId=${encodeURIComponent(appointmentId)}`
      : null,
    checkedVisitSlots,
  );
  function change(next: Partial<AppointmentRescheduleTarget>) {
    setTarget((value) => ({ ...value, ...next }));
    setPreview(null);
    setConfirmed(false);
    setNotice('');
    setError('');
  }
  async function refresh() {
    if (working.current || attempt) return;
    const current = capture();
    workingState(true);
    setError('');
    try {
      const value = checkedSource(
        await api<unknown>(`${path}/reschedule-context`, { isCurrent: current }),
      );
      if (!current()) return;
      setSource(value);
      setPreview(null);
      setConfirmed(false);
      setPhase('editing');
      setNotice(
        'Current visit refreshed. Your proposed doctor, date, time and mode were kept. Review the current visit and request a new preview before confirming.',
      );
      void doctors.reload();
      void slots.reload();
    } catch (problem) {
      if (current()) setError(rescheduleFailure(problem));
    } finally {
      if (current()) workingState(false);
    }
  }
  async function prepare() {
    if (working.current || !source || phase !== 'editing') return;
    if (
      !source.canReschedule ||
      !target.doctorId ||
      !visitDate(target.date) ||
      !visitTime(target.time)
    ) {
      setError('Choose a doctor, a valid date and a time before reviewing this change.');
      return;
    }
    const requested = { ...target },
      guard = capture(),
      current = () => guard() && sameRescheduleTarget(requested, latest.current);
    workingState(true);
    setError('');
    setNotice('');
    setConfirmed(false);
    try {
      const value = checkedReschedulePreview(
        await api<unknown>(`${path}/reschedule-preview`, {
          method: 'POST',
          body: { ...requested, expectedSourceRevision: source.sourceRevision },
          isCurrent: current,
        }),
        source,
        requested,
      );
      if (!current()) return;
      setPreview(value);
      setPhase('review');
    } catch (problem) {
      if (!current()) return;
      setError(rescheduleFailure(problem));
      if (
        problem instanceof ApiError &&
        problem.status === 409 &&
        problem.message ===
          'The appointment changed. Review the latest visit before previewing a new time.'
      )
        setPhase('conflict');
    } finally {
      if (current()) workingState(false);
    }
  }
  async function save(sent: RescheduleAttempt) {
    if (working.current) return;
    const current = capture();
    workingState(true);
    setAttempt(sent);
    onPendingAttemptChange?.(sent);
    setError('');
    setNotice('');
    try {
      const value = checkedRescheduleResult(
        await api<unknown>(`${path}/reschedules`, {
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
      setPhase('editing');
      try {
        await onConfirmed?.(value);
      } catch {
        if (current())
          setNotice(
            'The reschedule is confirmed. Refresh the appointment list to see its latest details.',
          );
      }
    } catch (problem) {
      if (!current()) return;
      setError(rescheduleFailure(problem));
      if (rescheduleNotApplied(problem, sent)) {
        setAttempt(null);
        onPendingAttemptChange?.(null);
        setPhase('conflict');
        setConfirmed(false);
      } else setPhase('uncertain');
    } finally {
      if (current()) workingState(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (working.current) return;
    if (attempt) {
      await save(attempt);
      return;
    }
    if (phase === 'editing') {
      await prepare();
      return;
    }
    if (phase !== 'review' || !source || !preview?.canReschedule || !confirmed || !session.user)
      return;
    await save({
      actorId: session.user.id,
      source,
      preview,
      body: {
        doctorId: target.doctorId,
        date: target.date,
        time: target.time,
        mode: target.mode,
        expectedRevision: preview.revision,
        patientConfirmed: true,
        requestId: crypto.randomUUID(),
      },
    });
  }
  if (patient && source && source.appointment.patientId !== session.user?.patientId)
    return (
      <ErrorState message="This visit is no longer linked to your account. Open My care to review your current appointments." />
    );
  if (result) {
    const changed = !sameRescheduleAppointment(result.appointment, result.event.after);
    return (
      <div className="stack appointment-reschedule-result">
        <h2 className="section-title">Reschedule confirmed</h2>
        <p className="notice">
          {changed
            ? 'Your reschedule was recorded. The appointment has changed again since then; its current details are shown below. Retrying did not apply another move.'
            : 'The appointment change is recorded. The current details are shown below.'}
        </p>
        <section className="appointment-reschedule-current" aria-label="Current appointment">
          <h3>Current appointment</h3>
          <VisitFacts appointment={result.appointment} />
        </section>
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        <details>
          <summary>Recorded appointment change</summary>
          <div className="appointment-reschedule-columns">
            <section>
              <h3>Before this change</h3>
              <VisitFacts appointment={result.event.before} />
            </section>
            <section>
              <h3>Recorded new time</h3>
              <VisitFacts appointment={result.event.after} />
            </section>
          </div>
        </details>
        {result.appointment.status === 'scheduled' &&
          Date.parse(`${result.appointment.date}T${result.appointment.time}:00+05:30`) >
            Date.now() && (
            <a
              className="button button-secondary"
              href={`/api/appointments/${encodeURIComponent(appointmentId)}/calendar`}
              download
            >
              Download calendar event
            </a>
          )}
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
    <form className="stack appointment-reschedule-form" onSubmit={submit}>
      <section className="appointment-reschedule-source" aria-label="Current visit to review">
        <h3>{source.appointment.patientName}</h3>
        <VisitFacts appointment={source.appointment} />
        <p className="muted small">
          {visitPolicy(source.appointment) === 'custom'
            ? 'This custom visit keeps its booked length when rescheduled.'
            : 'Moving this visit uses the selected doctor’s current default appointment length.'}{' '}
          A move uses the selected doctor’s current fee. Invoices and care records are unchanged.
        </p>
      </section>
      {error && <ErrorState message={error} />}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {phase === 'uncertain' && !busy && (
        <div className="notice notice-warning">
          <strong>The change outcome could not be confirmed.</strong>
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
            The proposed change was not applied. Refresh the current visit; your proposed details
            will be kept for a new review.
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
      {!source.canReschedule && phase === 'editing' ? (
        <EmptyState
          title="This visit cannot be rescheduled here"
          description={source.blockedReason ?? 'Only a future scheduled visit can be moved here.'}
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
          {doctors.error && !attempt && (
            <ErrorState message={doctors.error} retry={doctors.reload} />
          )}
          <div className="form-grid">
            <Field label="New doctor">
              <select
                required
                disabled={locked}
                value={target.doctorId}
                onChange={(event) => change({ doctorId: event.target.value, time: '' })}
              >
                <option value="">Choose a doctor</option>
                {doctors.data?.map((doctor) => (
                  <option
                    key={doctor.id}
                    value={doctor.id}
                    disabled={
                      doctor.acceptingNewBookings === false &&
                      doctor.id !== source.appointment.doctorId
                    }
                  >
                    {doctor.name}
                    {doctor.acceptingNewBookings === false ? ' · New bookings paused' : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Consultation mode">
              <select
                value={target.mode}
                disabled={locked}
                onChange={(event) =>
                  change({ mode: event.target.value as Appointment['mode'], time: '' })
                }
              >
                <option value="in-person">In clinic</option>
                <option value="online">Online consultation</option>
              </select>
            </Field>
            <Field label="New date">
              <input
                type="date"
                min={source.clinicDate}
                max={source.bookingThroughDate}
                required
                value={target.date}
                disabled={locked}
                onChange={(event) => change({ date: event.target.value, time: '' })}
              />
            </Field>
            <Field label="New time · IST">
              <input
                type="time"
                step={60}
                required
                value={target.time}
                disabled={locked}
                onChange={(event) => change({ time: event.target.value })}
              />
            </Field>
          </div>
          {paused && (
            <section className="notice" aria-label="Doctor booking status">
              <strong>New bookings paused</strong>
              <p>
                {sameDoctor
                  ? 'This doctor is not accepting new bookings. Your existing visit can still be rescheduled with the same doctor, subject to available hours and time off.'
                  : 'This doctor is not accepting transfers from another doctor. Your selected doctor has not been changed.'}
              </p>
            </section>
          )}
          {phase === 'editing' && (
            <div>
              <p className="muted small">
                Available start times · IST. You can also enter a proposed time above; the preview
                checks its full interval.
              </p>
              {slots.loading ? (
                <Loading />
              ) : slots.error ? (
                <ErrorState message={slots.error} retry={slots.reload} />
              ) : (
                <div
                  className="appointment-reschedule-slots"
                  role="group"
                  aria-label="Available appointment times"
                >
                  {slots.data?.length ? (
                    slots.data.map((time) => (
                      <button
                        className={`button button-small ${target.time === time ? 'button-primary' : 'button-secondary'}`}
                        type="button"
                        aria-pressed={target.time === time}
                        disabled={busy}
                        key={time}
                        onClick={() => change({ time })}
                      >
                        {time}
                      </button>
                    ))
                  ) : (
                    <p className="muted">
                      No available times for this doctor, date and mode. Review another date or
                      contact the clinic.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
          {preview && phase !== 'editing' && (
            <section
              className="appointment-reschedule-preview"
              aria-label="Review appointment change"
            >
              <h2 className="section-title">Review appointment change</h2>
              <div className="appointment-reschedule-columns">
                <section className="appointment-reschedule-before">
                  <h3>Current appointment</h3>
                  <VisitFacts appointment={preview.before} />
                </section>
                <section className="appointment-reschedule-after">
                  <h3>Proposed appointment</h3>
                  <VisitFacts appointment={preview.after} />
                </section>
              </div>
              <p className="muted small">
                This preview does not hold the time. Availability is checked again when you confirm.
              </p>
              {!preview.canReschedule && (
                <p className="notice notice-warning">{preview.blockedReason}</p>
              )}
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  required
                  checked={confirmed}
                  disabled={busy || phase !== 'review' || !preview.canReschedule}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                <span>
                  {patient
                    ? 'I agree to this exact appointment change.'
                    : 'I confirmed this exact appointment change with the patient.'}
                </span>
              </label>
            </section>
          )}
        </>
      )}
      <div className="appointment-reschedule-actions">
        {phase === 'review' && (
          <button
            className="button button-secondary"
            type="button"
            disabled={busy}
            onClick={() => {
              setPhase('editing');
              setPreview(null);
              setConfirmed(false);
              setError('');
            }}
          >
            Change target
          </button>
        )}
        {((phase === 'editing' && source.canReschedule) ||
          phase === 'review' ||
          phase === 'uncertain') && (
          <button
            className="button button-primary"
            disabled={
              busy ||
              (phase === 'editing' &&
                (!target.doctorId || !visitDate(target.date) || !visitTime(target.time))) ||
              (phase === 'review' && (!preview?.canReschedule || !confirmed))
            }
          >
            {busy
              ? 'Checking…'
              : phase === 'uncertain'
                ? 'Retry same request'
                : phase === 'review'
                  ? 'Confirm reschedule'
                  : 'Review change'}
          </button>
        )}
      </div>
    </form>
  );
}
