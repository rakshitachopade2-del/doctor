import { useRef, useState, type FormEvent } from 'react';
import type { Appointment, Encounter, Patient } from '../../shared/types';
import type { ConsultationRecordingResult } from '../../shared/consultation-recording';
import { api, formatDate, useSession } from '../lib';
import { ErrorState, Field, Modal } from './ui';
import { useAppointmentBookingGuard } from './appointment-booking-helpers';
import {
  checkedConsultationResult,
  checkedEncounter,
  consultationNotRecorded,
  recordingFailure,
  type ConsultationAttempt,
} from './consultation-recording-helpers';
import './consultation-recording.css';

const noteFields = [
  ['history', 'History'],
  ['examination', 'Examination'],
  ['assessment', 'Assessment'],
  ['investigations', 'Investigations'],
  ['plan', 'Plan and next steps'],
] as const;
const appointmentStatusLabels: Record<Appointment['status'], string> = {
  scheduled: 'Scheduled',
  'checked-in': 'Checked in',
  'in-consultation': 'In consultation',
  completed: 'Completed',
  cancelled: 'Cancelled',
  'no-show': 'No-show',
};
type NoteFields = Record<(typeof noteFields)[number][0], string> & { appointmentId: string };
function EncounterDetails({ encounter }: { encounter: Encounter }) {
  return (
    <div className="consultation-recording-encounter">
      <p className="muted">
        {encounter.doctorName} · {formatDate(encounter.createdAt)}
      </p>
      {noteFields.map(([field, label]) => (
        <section key={field}>
          <h4>{label}</h4>
          <p>{encounter[field] || 'Not recorded'}</p>
        </section>
      ))}
    </div>
  );
}
export function ConsultationNoteModal({
  patient,
  appointments,
  source,
  pendingAttempt,
  onPendingAttemptChange,
  onClose,
}: {
  patient: Pick<Patient, 'id' | 'name'>;
  appointments: Appointment[];
  source: Encounter | null;
  pendingAttempt: ConsultationAttempt | null;
  onPendingAttemptChange: (attempt: ConsultationAttempt | null) => void;
  onClose: (saved: ConsultationRecordingResult | null) => void;
}) {
  const { session } = useSession(),
    capture = useAppointmentBookingGuard();
  const initial = pendingAttempt?.operation === 'create' ? pendingAttempt.body : null;
  const [note, setNote] = useState<NoteFields>({
    appointmentId: initial?.appointmentId ?? '',
    history: initial?.history ?? '',
    examination: initial?.examination ?? '',
    assessment: initial?.assessment ?? '',
    investigations: initial?.investigations ?? '',
    plan: initial?.plan ?? '',
  });
  const [reason, setReason] = useState(
      pendingAttempt?.operation === 'amend' ? pendingAttempt.body.reason : '',
    ),
    [additional, setAdditional] = useState(
      pendingAttempt?.operation === 'amend' ? pendingAttempt.body.text : '',
    ),
    [attempt, setAttempt] = useState<ConsultationAttempt | null>(pendingAttempt),
    [phase, setPhase] = useState<'editing' | 'conflict' | 'uncertain'>(
      pendingAttempt ? 'uncertain' : 'editing',
    ),
    [reviewed, setReviewed] = useState(!!pendingAttempt),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [result, setResult] = useState<ConsultationRecordingResult | null>(null);
  const working = useRef(false);
  const operation = source ? 'amend' : 'create';
  const allowed = !!session.user?.doctorId && ['admin', 'doctor'].includes(session.user.role);
  const locked = busy || !!attempt || phase === 'conflict';
  function close() {
    if (!working.current) onClose(result);
  }
  function updateNote(field: keyof NoteFields, value: string) {
    setNote((previous) => ({ ...previous, [field]: value }));
    setReviewed(false);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (
      working.current ||
      !session.user?.doctorId ||
      !allowed ||
      (!attempt && (!reviewed || phase !== 'editing'))
    )
      return;
    let sent = attempt;
    if (!sent) {
      const actor = {
        actorId: session.user.id,
        doctorId: session.user.doctorId,
        patientId: patient.id,
      };
      try {
        if (source) {
          checkedEncounter(source, patient.id);
          if (!reason.trim() || !additional.trim())
            throw new Error('Enter the reason and the correction or additional information.');
          sent = {
            ...actor,
            operation: 'amend',
            source,
            body: {
              reason: reason.trim(),
              text: additional.trim(),
              reviewedConfirmed: true,
              requestId: crypto.randomUUID(),
            },
          };
        } else {
          if (!note.assessment.trim() || !note.plan.trim())
            throw new Error('Enter an assessment and plan before recording the note.');
          const fields = Object.fromEntries(
            noteFields.map(([key]) => [key, note[key].trim()]),
          ) as Omit<NoteFields, 'appointmentId'>;
          sent = {
            ...actor,
            operation: 'create',
            source: null,
            body: {
              ...fields,
              patientId: patient.id,
              ...(note.appointmentId ? { appointmentId: note.appointmentId } : {}),
              reviewedConfirmed: true,
              requestId: crypto.randomUUID(),
            },
          };
        }
      } catch (problem) {
        setError(recordingFailure(problem));
        return;
      }
    }
    const current = capture();
    working.current = true;
    setBusy(true);
    setAttempt(sent);
    onPendingAttemptChange(sent);
    setError('');
    try {
      const path =
        sent.operation === 'create'
          ? '/api/consultation-notes'
          : `/api/encounters/${encodeURIComponent(sent.source.id)}/amendment-recordings`;
      const saved = checkedConsultationResult(
        await api<unknown>(path, { method: 'POST', body: sent.body, isCurrent: current }),
        sent,
      );
      if (!current()) return;
      setResult(saved);
      setAttempt(null);
      onPendingAttemptChange(null);
      setPhase('editing');
    } catch (problem) {
      if (!current()) return;
      setError(recordingFailure(problem));
      if (consultationNotRecorded(problem, sent)) {
        setAttempt(null);
        onPendingAttemptChange(null);
        setPhase('conflict');
        setReviewed(false);
      } else setPhase('uncertain');
    } finally {
      if (current()) {
        working.current = false;
        setBusy(false);
      }
    }
  }
  const inconsistent =
    attempt &&
    (attempt.actorId !== session.user?.id ||
      attempt.patientId !== patient.id ||
      attempt.operation !== operation ||
      attempt.source?.id !== source?.id);
  return (
    <Modal
      title={source ? 'Amend the consultation record' : 'Document consultation'}
      onClose={close}
    >
      {!allowed ? (
        <ErrorState message="A linked clinician account is required to record clinical notes or amendments." />
      ) : inconsistent ? (
        <ErrorState message="This pending clinical record belongs to a different patient or original note. Resume its original recording." />
      ) : result ? (
        <div className="stack consultation-recording-result">
          <h2 className="section-title">
            {result.amendment ? 'Amendment recorded' : 'Clinical note recorded'}
          </h2>
          <p className="notice">
            The exact record below was saved once. Retrying does not create another entry. It
            remains private to authorized clinicians; no patient instructions or appointment status
            were changed.
          </p>
          {result.amendment && (
            <section className="consultation-recording-amendment">
              <h3>Recorded amendment</h3>
              <p className="muted">
                {result.amendment.doctorName} · {formatDate(result.amendment.createdAt)}
              </p>
              <h4>Reason for amendment</h4>
              <p>{result.amendment.reason}</p>
              <h4>Correction or additional information</h4>
              <p>{result.amendment.text}</p>
            </section>
          )}
          <section className="consultation-recording-source">
            <h3>
              {result.amendment
                ? 'Original consultation note — unchanged'
                : 'Recorded consultation note'}
            </h3>
            <EncounterDetails encounter={result.encounter} />
          </section>
          <div className="modal-actions">
            <button type="button" className="button button-secondary" onClick={close}>
              Close clinical record
            </button>
          </div>
        </div>
      ) : (
        <form className="stack consultation-recording-form" onSubmit={submit}>
          <p className="muted">
            Patient: <strong>{patient.name}</strong>
          </p>
          {source && (
            <section className="consultation-recording-source">
              <h3>Original consultation note</h3>
              <EncounterDetails encounter={source} />
            </section>
          )}
          {operation === 'create' ? (
            <>
              <Field
                label="Linked appointment"
                hint="Optional. Linking documents context; it does not change the appointment."
              >
                <select
                  value={note.appointmentId}
                  disabled={locked}
                  onChange={(event) => updateNote('appointmentId', event.target.value)}
                >
                  <option value="">Standalone clinical note</option>
                  {note.appointmentId &&
                    !appointments.some((entry) => entry.id === note.appointmentId) && (
                      <option value={note.appointmentId}>Previously selected appointment</option>
                    )}
                  {appointments.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {formatDate(entry.date)} · {entry.time} · {entry.doctorName} ·{' '}
                      {appointmentStatusLabels[entry.status]} · {entry.reason}
                    </option>
                  ))}
                </select>
              </Field>
              {noteFields.map(([field, label]) => (
                <Field key={field} label={label}>
                  <textarea
                    value={note[field]}
                    required={field === 'assessment' || field === 'plan'}
                    disabled={locked}
                    rows={field === 'investigations' ? 2 : 3}
                    maxLength={8000}
                    onChange={(event) => updateNote(field, event.target.value)}
                  />
                </Field>
              ))}
            </>
          ) : (
            <>
              <Field label="Reason for amendment">
                <textarea
                  value={reason}
                  required
                  maxLength={8000}
                  rows={2}
                  disabled={locked}
                  onChange={(event) => {
                    setReason(event.target.value);
                    setReviewed(false);
                  }}
                />
              </Field>
              <Field label="Correction or additional information">
                <textarea
                  value={additional}
                  required
                  maxLength={8000}
                  rows={5}
                  disabled={locked}
                  onChange={(event) => {
                    setAdditional(event.target.value);
                    setReviewed(false);
                  }}
                />
              </Field>
            </>
          )}
          <p className="notice">
            {source
              ? 'This adds a dated, attributed amendment. The original note stays unchanged. Neither entry can be edited or deleted after saving.'
              : 'This becomes an immutable clinical note. A later correction is a separate attributed amendment. Add a care plan separately for patient-facing instructions.'}
          </p>
          {error && <ErrorState message={error} />}
          {phase === 'uncertain' && !busy && (
            <div className="notice notice-warning">
              <strong>The clinical record outcome could not be confirmed.</strong>
              <p>
                Your exact text and request are retained and locked. Retry the same request before
                recording another note or amendment. Leaving or reloading this page clears this
                in-memory draft; check the record before starting again.
              </p>
            </div>
          )}
          {phase === 'conflict' && (
            <div className="notice">
              <p>
                This request did not record a note or amendment and cannot do so later. Your draft
                is preserved. Review it again before making a new request.
              </p>
              <button
                type="button"
                className="button button-secondary"
                onClick={() => {
                  setPhase('editing');
                  setReviewed(false);
                  setError('');
                }}
              >
                Review draft again
              </button>
            </div>
          )}
          <label className="consultation-recording-confirm">
            <input
              type="checkbox"
              required
              checked={reviewed}
              disabled={locked}
              onChange={(event) => setReviewed(event.target.checked)}
            />
            <span>
              {source
                ? 'I reviewed the original note and this amendment before recording it.'
                : 'I reviewed this clinical note and confirm it is ready to record.'}
            </span>
          </label>
          <div className="modal-actions">
            <button
              type="button"
              className="button button-secondary"
              disabled={busy}
              onClick={close}
            >
              {attempt ? 'Close for now' : 'Cancel'}
            </button>
            <button
              className="button button-primary"
              disabled={busy || phase === 'conflict' || (!attempt && !reviewed)}
            >
              {busy
                ? 'Saving…'
                : attempt
                  ? 'Retry same request'
                  : source
                    ? 'Save amendment'
                    : 'Save clinical note'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
