import { useRef, useState, type FormEvent } from 'react';
import type {
  AppointmentSeriesDetail,
  AppointmentSeriesInput,
  AppointmentSeriesPreview,
} from '../../shared/appointment-series';
import type { Doctor, Patient } from '../../shared/types';
import { api, ApiError, formatDate, money, today, useResource, useSession } from '../lib';
import { Badge, ErrorState, Field, Loading, Modal } from './ui';
import {
  checkedSeriesBooking,
  checkedSeriesPreview,
  seriesCadence,
  seriesFailure,
  seriesInputEqual,
  useSeriesGuard,
  type SeriesAttempt,
} from './appointment-series-helpers';
import { validCustomMinutes, visitClock } from './visit-duration-helpers';
import './appointment-series.css';

export function AppointmentSeriesPreviewView({ preview }: { preview: AppointmentSeriesPreview }) {
  return (
    <section className="appointment-series-preview" aria-label="Requested visit preview">
      <div className="appointment-series-source">
        <strong>
          {preview.patient.name} · {preview.doctor.name}
        </strong>
        <p>
          {seriesCadence(preview.input.intervalWeeks)} · {preview.input.count} visits ·{' '}
          {preview.durationMinutes} minutes each ·{' '}
          {preview.input.mode === 'online' ? 'Online consultation' : 'In clinic'}
        </p>
        <p>
          Consultation fee per visit: {money(preview.doctor.fee)} · Total booked fees:{' '}
          {money(preview.doctor.fee * preview.input.count)}
        </p>
        <p className="muted small">
          No payment or invoice is created here. Preview does not reserve a time. Booking window
          ends {formatDate(preview.horizonEndDate)}.
        </p>
      </div>
      {preview.visits.map((visit) => (
        <article className="appointment-series-preview-card" key={visit.position}>
          <h3>
            Visit {visit.position} · {formatDate(visit.date)}
          </h3>
          <Badge tone={visit.available ? 'green' : 'red'}>
            {visit.available ? 'Available' : 'Unavailable'}
          </Badge>
          <p>
            {visitClock(visit.time)}–{visitClock(visit.endTime)} IST
            {visit.endDate !== visit.date ? ` · Ends ${formatDate(visit.endDate)}` : ''} ·{' '}
            {visit.durationMinutes} minutes
          </p>
          {!visit.available && <p>{visit.blockedReason}</p>}
        </article>
      ))}
      {!preview.canBook && (
        <p className="notice notice-error">
          Every requested visit must be available. No dates will be skipped, shifted or booked
          separately.
        </p>
      )}
    </section>
  );
}
export function AppointmentSeriesModal({
  initialDate = today(),
  onClose,
  onSaved,
}: {
  initialDate?: string;
  onClose: () => void;
  onSaved: (detail: AppointmentSeriesDetail) => void;
}) {
  const { session } = useSession(),
    guard = useSeriesGuard(),
    pending = useRef(false);
  const patients = useResource<Patient[]>('/api/patients'),
    doctors = useResource<Doctor[]>('/api/doctors');
  const [patientId, setPatientId] = useState(''),
    [doctorId, setDoctorId] = useState(''),
    [firstDate, setFirstDate] = useState(initialDate),
    [time, setTime] = useState('09:00'),
    [count, setCount] = useState('4'),
    [intervalWeeks, setIntervalWeeks] = useState<1 | 2 | 4>(1),
    [mode, setMode] = useState<'in-person' | 'online'>('in-person'),
    [reason, setReason] = useState(''),
    [durationPolicy, setDurationPolicy] = useState<'schedule' | 'custom'>('schedule'),
    [durationMinutes, setDurationMinutes] = useState('60'),
    [privateNote, setPrivateNote] = useState('');
  const [preview, setPreview] = useState<AppointmentSeriesPreview | null>(null),
    [attempt, setAttempt] = useState<SeriesAttempt | null>(null),
    [phase, setPhase] = useState<'editing' | 'conflict' | 'uncertain'>('editing'),
    [reviewed, setReviewed] = useState(false),
    [patientConfirmed, setPatientConfirmed] = useState(false),
    [busy, setBusy] = useState<'preview' | 'save' | null>(null),
    [error, setError] = useState('');
  const locked = !!busy || phase !== 'editing';
  function invalidate() {
    setPreview(null);
    setPatientConfirmed(false);
    setReviewed(false);
    setError('');
    setAttempt(null);
  }
  function input(): AppointmentSeriesInput {
    return {
      patientId,
      doctorId,
      firstDate,
      time,
      count: Number(count),
      intervalWeeks,
      mode,
      reason: reason.trim(),
      ...(durationPolicy === 'custom'
        ? { durationPolicy: 'custom', durationMinutes: Number(durationMinutes) }
        : { durationPolicy: 'schedule' }),
    };
  }
  const latestInput = useRef(input());
  latestInput.current = input();
  function close() {
    if (!pending.current && !busy && phase !== 'uncertain') onClose();
  }
  async function prepare() {
    if (pending.current) return;
    if (durationPolicy === 'custom' && !validCustomMinutes(Number(durationMinutes))) {
      setError('Enter a custom length from 15 to 240 minutes, in five-minute steps.');
      return;
    }
    pending.current = true;
    setBusy('preview');
    setError('');
    setPatientConfirmed(false);
    setReviewed(false);
    setPreview(null);
    const routeCurrent = guard(),
      sent = input(),
      current = () => routeCurrent() && seriesInputEqual(latestInput.current, sent);
    try {
      const value = checkedSeriesPreview(
        await api<unknown>('/api/appointment-series/preview', {
          method: 'POST',
          body: sent,
          isCurrent: current,
        }),
        sent,
      );
      if (current()) {
        setPreview(value);
        if (phase === 'conflict') setReviewed(true);
      }
    } catch (cause) {
      if (current()) setError(seriesFailure(cause));
    } finally {
      pending.current = false;
      if (current()) setBusy(null);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || phase === 'conflict') return;
    if (phase === 'uncertain' && attempt) {
      await book(attempt);
      return;
    }
    if (!preview) {
      await prepare();
      return;
    }
    if (!preview.canBook || !patientConfirmed) return;
    const sent: SeriesAttempt = {
      preview,
      actorId: session.user!.id,
      actorRole: session.user!.role as SeriesAttempt['actorRole'],
      body: {
        input: preview.input,
        expectedRevision: preview.revision,
        patientConfirmed: true,
        requestId: crypto.randomUUID(),
        ...(privateNote.trim() ? { privateNote: privateNote.trim() } : {}),
      },
    };
    setAttempt(sent);
    await book(sent);
  }
  async function book(sent: SeriesAttempt) {
    if (pending.current) return;
    pending.current = true;
    setBusy('save');
    setError('');
    const current = guard(),
      unknown = phase === 'uncertain';
    try {
      const value = checkedSeriesBooking(
        await api<unknown>('/api/appointment-series', {
          method: 'POST',
          body: sent.body,
          isCurrent: current,
        }),
        sent,
      );
      if (current()) onSaved(value);
    } catch (cause) {
      if (!current()) return;
      setError(seriesFailure(cause));
      if (unknown) setPhase('uncertain');
      else if (
        cause instanceof ApiError &&
        cause.status === 409 &&
        !/request (?:id|identifier)|idempot|already used|different.*payload/i.test(cause.message)
      ) {
        setPhase('conflict');
        setPatientConfirmed(false);
        setReviewed(false);
      } else if (cause instanceof ApiError && [400, 403, 404, 422, 429].includes(cause.status)) {
        setAttempt(null);
        setPhase('editing');
        setPatientConfirmed(false);
      } else setPhase('uncertain');
    } finally {
      pending.current = false;
      if (current()) setBusy(null);
    }
  }
  return (
    <Modal title="Book recurring visits" onClose={close}>
      <form className="stack appointment-series-booking" onSubmit={submit}>
        <p className="notice">
          Book a fixed set of visits at the same time. Confirm every date with the patient. Each
          visit can be rescheduled or cancelled individually after booking.
        </p>
        {patients.error && <ErrorState message={patients.error} retry={patients.reload} />}{' '}
        {doctors.error && <ErrorState message={doctors.error} retry={doctors.reload} />}
        {(patients.loading || doctors.loading) && <Loading />}
        <fieldset
          className="appointment-series-fields"
          disabled={
            locked || patients.loading || doctors.loading || !!patients.error || !!doctors.error
          }
        >
          <legend className="sr-only">Recurring visit pattern</legend>
          <Field label="Patient">
            <select
              required
              value={patientId}
              onChange={(e) => {
                setPatientId(e.target.value);
                invalidate();
              }}
            >
              <option value="">Select a patient</option>
              {patients.data?.map((patient) => (
                <option key={patient.id} value={patient.id}>
                  {patient.name} · {patient.phone}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Doctor">
            <select
              required
              value={doctorId}
              onChange={(e) => {
                setDoctorId(e.target.value);
                invalidate();
              }}
            >
              <option value="">Select a doctor</option>
              {doctors.data?.map((doctor) => (
                <option key={doctor.id} value={doctor.id}>
                  {doctor.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="appointment-series-field-row">
            <Field label="First visit date">
              <input
                type="date"
                required
                value={firstDate}
                onChange={(e) => {
                  setFirstDate(e.target.value);
                  invalidate();
                }}
              />
            </Field>
            <Field label="Start time · IST">
              <input
                type="time"
                required
                step={60}
                value={time}
                onChange={(e) => {
                  setTime(e.target.value);
                  invalidate();
                }}
              />
            </Field>
          </div>
          <div className="appointment-series-field-row">
            <Field label="Repeat every">
              <select
                value={intervalWeeks}
                onChange={(e) => {
                  setIntervalWeeks(Number(e.target.value) as 1 | 2 | 4);
                  invalidate();
                }}
              >
                <option value={1}>Week</option>
                <option value={2}>Two weeks</option>
                <option value={4}>Four weeks</option>
              </select>
            </Field>
            <Field label="Number of visits">
              <input
                type="number"
                required
                min={2}
                max={12}
                step={1}
                value={count}
                onChange={(e) => {
                  setCount(e.target.value);
                  invalidate();
                }}
              />
            </Field>
          </div>
          <Field label="Consultation mode">
            <select
              value={mode}
              onChange={(e) => {
                setMode(e.target.value as typeof mode);
                invalidate();
              }}
            >
              <option value="in-person">In clinic</option>
              <option value="online">Online consultation</option>
            </select>
          </Field>
          <div className="appointment-series-field-row">
            <Field label="Visit length">
              <select
                value={durationPolicy}
                onChange={(e) => {
                  setDurationPolicy(e.target.value as typeof durationPolicy);
                  invalidate();
                }}
              >
                <option value="schedule">Default consultation</option>
                <option value="custom">Custom length</option>
              </select>
            </Field>
            {durationPolicy === 'custom' && (
              <Field label="Custom duration (minutes)" hint="15–240 minutes, in five-minute steps.">
                <input
                  type="number"
                  required
                  min={15}
                  max={240}
                  step={5}
                  value={durationMinutes}
                  onChange={(e) => {
                    setDurationMinutes(e.target.value);
                    invalidate();
                  }}
                />
              </Field>
            )}
          </div>
          <Field label="Reason for visits" hint="Shared with the patient on every appointment.">
            <textarea
              required
              maxLength={300}
              rows={2}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                invalidate();
              }}
            />
          </Field>
          <Field label="Internal booking note" hint="Optional. Visible only to clinic staff.">
            <textarea
              maxLength={1000}
              rows={2}
              value={privateNote}
              onChange={(e) => {
                setPrivateNote(e.target.value);
                setPatientConfirmed(false);
              }}
            />
          </Field>
        </fieldset>
        {error && (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        )}
        {phase === 'uncertain' && (
          <div className="notice" role="status">
            <div>
              <strong>The booking outcome could not be confirmed.</strong>
              <p>
                The exact submitted pattern and request are retained in this open form. Retry the
                same request to confirm the result without booking the visits again.
              </p>
            </div>
          </div>
        )}
        {phase === 'conflict' && (
          <div className="appointment-series-source">
            <p>
              The preview changed or a requested time is no longer available. Your fields are
              retained. Refresh every date before confirming a new request.
            </p>
            <div className="appointment-series-actions">
              <button
                type="button"
                className="button button-secondary"
                disabled={!!busy}
                onClick={() => void prepare()}
              >
                {busy === 'preview' ? 'Refreshing…' : 'Refresh series preview'}
              </button>
            </div>
          </div>
        )}
        {preview && <AppointmentSeriesPreviewView preview={preview} />}
        {phase === 'conflict' && reviewed && preview && (
          <button
            type="button"
            className="button button-secondary"
            onClick={() => {
              setPhase('editing');
              setAttempt(null);
              setReviewed(false);
              setPatientConfirmed(false);
              setError('');
            }}
          >
            I reviewed the updated dates, visit length and fees
          </button>
        )}
        {preview && (
          <label className="checkbox-field">
            <input
              type="checkbox"
              required
              checked={patientConfirmed}
              disabled={locked || !preview.canBook}
              onChange={(e) => setPatientConfirmed(e.target.checked)}
            />
            <span>I confirmed every listed date and time with the patient.</span>
          </label>
        )}
        <div className="appointment-series-actions">
          <button
            type="button"
            className="button button-ghost"
            disabled={!!busy || phase === 'uncertain'}
            onClick={close}
          >
            Cancel
          </button>
          {preview && phase === 'editing' && (
            <button
              type="button"
              className="button button-secondary"
              disabled={!!busy}
              onClick={() => void prepare()}
            >
              Refresh preview
            </button>
          )}
          <button
            className="button button-primary"
            disabled={
              !!busy ||
              phase === 'conflict' ||
              patients.loading ||
              doctors.loading ||
              !!patients.error ||
              !!doctors.error ||
              (phase === 'editing' && !!preview && !preview.canBook)
            }
          >
            {busy === 'preview'
              ? 'Checking every visit…'
              : busy === 'save'
                ? 'Booking visits…'
                : phase === 'uncertain'
                  ? 'Retry same request'
                  : preview
                    ? 'Confirm all visits'
                    : 'Preview visits'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
