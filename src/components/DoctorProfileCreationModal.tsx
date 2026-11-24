import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Plus } from 'lucide-react';
import { z } from 'zod';
import {
  doctorProfileFields,
  type DoctorProfileCreationCommand,
  type DoctorProfileFields,
} from '../../shared/doctor-profile-creation';
import { api } from '../lib';
import { useAppointmentBookingGuard } from './appointment-booking-helpers';
import { DoctorProfileForm, profileLabels, readDoctorProfile } from './DoctorProfileForm';
import { usePendingCareSubmissions } from './pending-care-submissions';
import { Modal } from './ui';
import './patient-registration.css';

const titles = {
  edit: 'Add a doctor',
  review: 'Confirm doctor profile',
  pending: 'Profile creation awaiting confirmation',
  saved: 'Doctor profile created',
};
const fieldNames = Object.keys(profileLabels) as (keyof DoctorProfileFields)[];
const receiptSchema = z.strictObject({
  receipt: z.strictObject({
    requestId: z.string(),
    actorId: z.string(),
    doctor: z.record(z.string(), z.unknown()),
  }),
});

function originalProfileId(
  response: unknown,
  reviewed: DoctorProfileCreationCommand,
  actorId: string,
) {
  const result = receiptSchema.safeParse(response);
  if (!result.success) return null;
  const { doctor, ...receipt } = result.data.receipt;
  const id = z.uuidv4().safeParse(doctor.id);
  if (
    !id.success ||
    id.data === actorId ||
    id.data === reviewed.requestId ||
    receipt.actorId !== actorId ||
    receipt.requestId !== reviewed.requestId ||
    Object.keys(doctor).length !== fieldNames.length + 1
  )
    return null;
  for (const key of fieldNames) {
    const expected = reviewed[key];
    const value = doctor[key];
    if (Array.isArray(expected)) {
      if (
        !Array.isArray(value) ||
        value.length !== expected.length ||
        expected.some((item, index) => item !== value[index])
      )
        return null;
    } else if (value !== expected) return null;
  }
  return id.data;
}

export function DoctorProfileCreationControl({
  actorId,
  onSaved,
}: {
  actorId: string;
  onSaved: () => void;
}) {
  const { doctorProfileCreation: pending } = usePendingCareSubmissions();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="button button-primary" onClick={() => setOpen(true)}>
        <Plus size={16} />
        {pending.current ? 'Resume doctor profile creation' : 'Add doctor'}
      </button>
      {open && (
        <DoctorProfileCreationModal
          actorId={actorId}
          onClose={(saved) => {
            setOpen(false);
            if (saved) onSaved();
          }}
        />
      )}
    </>
  );
}

function DoctorProfileCreationModal({
  actorId,
  onClose,
}: {
  actorId: string;
  onClose: (saved: boolean) => void;
}) {
  const { doctorProfileCreation: pending } = usePendingCareSubmissions();
  const [command, setCommand] = useState(pending.current);
  const [phase, setPhase] = useState<keyof typeof titles>(command ? 'pending' : 'edit');
  const [profileId, setProfileId] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const capture = useAppointmentBookingGuard();
  const origin = useRef<() => boolean>(() => false);
  const sending = useRef(false);
  const content = useRef<HTMLDivElement>(null);
  const lastPhase = useRef(phase);
  useLayoutEffect(() => {
    origin.current = capture();
    return () => {
      origin.current = () => false;
    };
  }, [capture]);
  useLayoutEffect(() => {
    if (lastPhase.current !== phase) content.current?.focus();
    lastPhase.current = phase;
  }, [phase]);

  function close() {
    origin.current = () => false;
    onClose(phase === 'saved');
  }
  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!origin.current() || phase !== 'edit' || pending.current) return;
    const parsed = doctorProfileFields.safeParse(readDoctorProfile(event.currentTarget));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const key = issue.path[0] as keyof DoctorProfileFields;
      setError(profileLabels[key] + ' · ' + issue.message);
      const input = event.currentTarget.elements.namedItem(key);
      if (input instanceof HTMLElement) input.focus();
      return;
    }
    Object.freeze(parsed.data.languages);
    Object.freeze(parsed.data.specialties);
    setCommand(
      Object.freeze({ ...parsed.data, requestId: crypto.randomUUID(), reviewedConfirmed: true }),
    );
    setConfirmed(false);
    setError('');
    setPhase('review');
  }
  async function submit() {
    if (!command || sending.current || !origin.current()) return;
    const creating = phase === 'review' && confirmed && !pending.current;
    const retrying = phase === 'pending' && pending.current === command;
    if (!creating && !retrying) return;
    pending.current = command;
    sending.current = true;
    setBusy(true);
    setPhase('pending');
    const current = () => origin.current() && pending.current === command;
    try {
      const response = await api<unknown>('/api/doctors/create', {
        method: 'POST',
        body: command,
        isCurrent: current,
      });
      if (!current()) return;
      const id = originalProfileId(response, command, actorId);
      if (!id) return;
      pending.current = null;
      setProfileId(id);
      setPhase('saved');
    } catch {
      // The request may have committed before the response was lost.
    } finally {
      if (origin.current()) {
        sending.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <Modal title={titles[phase]} onClose={close}>
      <div className="stack doctor-profile-creation" ref={content} tabIndex={-1}>
        {phase === 'edit' && (
          <DoctorProfileForm creating values={command ?? undefined} onSubmit={review}>
            {error && (
              <p role="alert" className="notice notice-error">
                {error}
              </p>
            )}
            <div className="modal-actions">
              <button type="button" className="button button-secondary" onClick={close}>
                Cancel
              </button>
              <button className="button button-primary">Review profile</button>
            </div>
          </DoctorProfileForm>
        )}
        {phase !== 'edit' && command && (
          <>
            {phase === 'pending' && (
              <p className="notice" role="status">
                {busy
                  ? 'Confirming profile creation…'
                  : 'The profile could not be confirmed. Retry the same request to recover its original confirmation. If the request never arrived, the retry creates the profile.'}
              </p>
            )}
            {phase === 'saved' && <h3>Original profile</h3>}
            <dl className="registration-details">
              {profileId && (
                <div>
                  <dt>Profile ID</dt>
                  <dd>{profileId}</dd>
                </div>
              )}
              {fieldNames.map((field) => {
                const value = command[field];
                return (
                  <div key={field}>
                    <dt>{profileLabels[field]}</dt>
                    <dd>
                      {Array.isArray(value)
                        ? value.join(', ')
                        : value === ''
                          ? 'Not provided'
                          : value}
                    </dd>
                  </div>
                );
              })}
            </dl>
            {phase === 'review' && (
              <>
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  <span>
                    I reviewed these details and confirm this profile should appear in the public
                    doctor directory.
                  </span>
                </label>
                <div className="modal-actions">
                  <button
                    className="button button-secondary"
                    onClick={() => {
                      setConfirmed(false);
                      setPhase('edit');
                    }}
                  >
                    Edit details
                  </button>
                  <button
                    className="button button-primary"
                    disabled={!confirmed}
                    onClick={() => void submit()}
                  >
                    Create doctor profile
                  </button>
                </div>
              </>
            )}
            {phase === 'pending' && (
              <>
                <p className="muted small">
                  You can resume this request in this tab. After reloading or signing out, check the
                  doctor directory before creating another profile.
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
                    Retry exact creation
                  </button>
                </div>
              </>
            )}
            {phase === 'saved' && (
              <div className="modal-actions">
                <button className="button button-primary" onClick={close}>
                  Done
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
