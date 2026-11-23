import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  staffPatientRegistrationFields,
  type PatientRegistrationCommand,
  type PatientRegistrationFields,
} from '../../shared/patient-registration';
import type { Patient } from '../../shared/types';
import { api, formatDate, today } from '../lib';
import { useAppointmentBookingGuard } from './appointment-booking-helpers';
import { usePendingCareSubmissions } from './pending-care-submissions';
import { Field, Modal } from './ui';
import './patient-registration.css';

const fields = {
  name: 'Full name',
  phone: 'Phone number',
  email: 'Email address',
  dob: 'Date of birth',
  gender: 'Gender',
  allergies: 'Known allergies',
} satisfies Record<keyof PatientRegistrationFields, string>;

const blankFields: PatientRegistrationFields = {
  name: '',
  phone: '',
  email: '',
  dob: '',
  gender: 'Not specified',
  allergies: '',
};

const titles = {
  edit: 'Register a patient',
  review: 'Confirm patient registration',
  pending: 'Registration awaiting confirmation',
  saved: 'Patient registered',
};
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function originalPatient(
  data: unknown,
  command: PatientRegistrationCommand,
  actorId: string,
): Patient | null {
  if (!object(data) || !object(data.receipt)) return null;
  const receipt = data.receipt,
    patient = receipt.patient;
  if (
    receipt.requestId !== command.requestId ||
    receipt.actorId !== actorId ||
    receipt.registeredByRole !== command.registeredByRole ||
    !object(patient) ||
    typeof patient.id !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(patient.id) ||
    patient.id === command.requestId ||
    patient.id === actorId ||
    typeof patient.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(patient.createdAt)) ||
    new Date(patient.createdAt).toISOString() !== patient.createdAt
  )
    return null;
  const keys = Object.keys(fields) as (keyof PatientRegistrationFields)[];
  const clinical = command.registeredByRole !== 'receptionist';
  if (Object.keys(patient).length !== keys.length + (clinical ? 3 : 2)) return null;
  for (const key of keys) {
    if (patient[key] !== command[key]) return null;
  }
  if (
    command.registeredByRole === 'receptionist'
      ? Object.hasOwn(patient, 'allergyStatus') || patient.allergies !== ''
      : patient.allergyStatus !== (command.allergies ? 'recorded' : 'not-recorded')
  )
    return null;
  return patient as unknown as Patient;
}

function RegistrationDetails({
  values,
  clinical,
}: {
  values: PatientRegistrationFields;
  clinical: boolean;
}) {
  return (
    <dl className="registration-details">
      {(Object.keys(fields) as (keyof PatientRegistrationFields)[])
        .filter((key) => clinical || key !== 'allergies')
        .map((key) => (
          <div key={key}>
            <dt>{fields[key]}</dt>
            <dd>{values[key] || 'Not recorded'}</dd>
          </div>
        ))}
    </dl>
  );
}

export function PatientRegistrationModal({
  role,
  actorId,
  onClose,
}: {
  role: PatientRegistrationCommand['registeredByRole'];
  actorId: string;
  onClose: (saved: boolean) => void;
}) {
  const { patientRegistration: pending } = usePendingCareSubmissions();
  const [command, setCommand] = useState<PatientRegistrationCommand | null>(pending.current);
  const [phase, setPhase] = useState<keyof typeof titles>(command ? 'pending' : 'edit');
  const [saved, setSaved] = useState<Patient | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const capture = useAppointmentBookingGuard(),
    dismissed = useRef(false),
    sending = useRef(false);
  const content = useRef<HTMLDivElement>(null),
    previousPhase = useRef(phase);
  const clinical = role !== 'receptionist',
    values = command ?? blankFields;
  useLayoutEffect(() => {
    if (previousPhase.current !== phase) content.current?.focus();
    previousPhase.current = phase;
  }, [phase]);

  function close() {
    dismissed.current = true;
    onClose(phase === 'saved');
  }
  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (phase !== 'edit' || pending.current || dismissed.current) return;
    const form = new FormData(event.currentTarget);
    const parsed = staffPatientRegistrationFields(today).safeParse({
      ...Object.fromEntries(form),
      allergies: clinical ? form.get('allergies') : '',
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const key = issue.path[0] as keyof PatientRegistrationFields;
      setError(fields[key] ? fields[key] + ' · ' + issue.message : issue.message);
      const input = event.currentTarget.elements.namedItem(key);
      if (input instanceof HTMLElement) input.focus();
      return;
    }
    setError('');
    setAcknowledged(false);
    setCommand({
      ...parsed.data,
      requestId: crypto.randomUUID(),
      registeredByRole: role,
      reviewedConfirmed: true,
    });
    setPhase('review');
  }
  async function submit() {
    if (
      !command ||
      sending.current ||
      dismissed.current ||
      (phase === 'pending'
        ? pending.current !== command
        : phase !== 'review' || !acknowledged || pending.current)
    )
      return;
    const origin = capture();
    const current = () => origin() && !dismissed.current && pending.current === command;
    sending.current = true;
    pending.current = command;
    setBusy(true);
    setPhase('pending');
    try {
      const response = await api<unknown>('/api/patients/register', {
        method: 'POST',
        body: command,
        isCurrent: current,
      });
      if (!current()) return;
      const chart = originalPatient(response, command, actorId);
      if (!chart) return;
      pending.current = null;
      setSaved(chart);
      setPhase('saved');
    } catch {
      // A lost reply can follow a committed registration. Keep the reviewed request available.
    } finally {
      if (origin() && !dismissed.current) {
        sending.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <Modal title={titles[phase]} onClose={close}>
      <div className="stack patient-registration" tabIndex={-1} ref={content}>
        {phase === 'edit' && (
          <form className="stack" onSubmit={review}>
            <Field label={fields.name}>
              <input
                name="name"
                required
                maxLength={300}
                autoComplete="name"
                defaultValue={values.name}
              />
            </Field>
            <div className="form-grid">
              <Field label={fields.phone}>
                <input
                  name="phone"
                  type="tel"
                  required
                  minLength={7}
                  maxLength={30}
                  defaultValue={values.phone}
                  placeholder="+91 98765 43210"
                />
              </Field>
              <Field label={fields.email}>
                <input
                  name="email"
                  type="email"
                  maxLength={254}
                  placeholder="Optional"
                  defaultValue={values.email}
                />
              </Field>
            </div>
            <div className="form-grid">
              <Field label={fields.dob}>
                <input name="dob" type="date" max={today()} defaultValue={values.dob} />
              </Field>
              <Field label={fields.gender}>
                <select name="gender" defaultValue={values.gender}>
                  <option>Not specified</option>
                  <option>Female</option>
                  <option>Male</option>
                  <option>Other</option>
                </select>
              </Field>
            </div>
            {clinical && (
              <Field label={fields.allergies}>
                <textarea
                  name="allergies"
                  rows={2}
                  maxLength={8000}
                  defaultValue={values.allergies}
                  placeholder="Record patient-reported allergies, or leave blank if unknown"
                />
              </Field>
            )}
            <p className="muted small">
              Registering here creates a clinic chart. Patient portal access is set up separately.
            </p>
            {error && (
              <p className="notice notice-error" role="alert">
                {error}
              </p>
            )}
            <div className="modal-actions">
              <button className="button button-secondary" type="button" onClick={close}>
                Cancel
              </button>
              <button className="button button-primary">Review registration</button>
            </div>
          </form>
        )}
        {phase === 'review' && command && (
          <>
            <RegistrationDetails values={command} clinical={clinical} />
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              <span>
                I reviewed these details and confirm a new patient chart should be created.
              </span>
            </label>
            <div className="modal-actions">
              <button
                className="button button-secondary"
                onClick={() => {
                  setAcknowledged(false);
                  setPhase('edit');
                }}
              >
                Edit details
              </button>
              <button
                className="button button-primary"
                disabled={!acknowledged}
                onClick={() => void submit()}
              >
                Register patient
              </button>
            </div>
          </>
        )}
        {phase === 'pending' && command && (
          <>
            <p className="notice" role="status">
              {busy
                ? 'Confirming registration…'
                : 'The registration could not be confirmed. Retry the exact request to recover the original chart.'}
            </p>
            <RegistrationDetails values={command} clinical={clinical} />
            <p className="muted small">
              You can resume this request in this tab. After reloading or signing out, check the
              patient directory before entering it again.
            </p>
            <div className="modal-actions">
              <button className="button button-secondary" onClick={close}>
                Close for now
              </button>
              <button
                className="button button-primary"
                disabled={busy}
                onClick={() => void submit()}
              >
                Retry exact registration
              </button>
            </div>
          </>
        )}
        {phase === 'saved' && saved && (
          <>
            <h3>Original registration</h3>
            <dl className="registration-details">
              <div>
                <dt>Chart ID</dt>
                <dd>{saved.id}</dd>
              </div>
              <div>
                <dt>Registered on</dt>
                <dd>
                  <time dateTime={saved.createdAt}>{formatDate(saved.createdAt)}</time>
                </dd>
              </div>
            </dl>
            <RegistrationDetails values={saved} clinical={clinical} />
            <div className="modal-actions">
              <button className="button button-secondary" onClick={close}>
                Done
              </button>
              <Link
                className="button button-primary"
                to={'/clinic/patients/' + saved.id + (clinical ? '' : '/details')}
              >
                {clinical ? 'Open patient record' : 'Open patient details'}
              </Link>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
