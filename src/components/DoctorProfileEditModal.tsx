import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import {
  doctorProfileFields,
  type DoctorProfileFields,
} from '../../shared/doctor-profile-creation';
import type { DoctorProfileEditContext } from '../../shared/doctor-profile-edit';
import { api } from '../lib';
import {
  useAppointmentBookingData,
  useAppointmentBookingGuard,
} from './appointment-booking-helpers';
import { DoctorProfileForm, profileLabels, readDoctorProfile } from './DoctorProfileForm';
import { DoctorProfileHistory, ProfileDifferences, ProfileValue } from './DoctorProfileHistory';
import {
  checkedEditReceipt,
  checkedEditRefusal,
  checkedProfileContext,
  differentFields,
  rebaseProfile,
  type ProfileEditAttempt,
  type ProfileKey,
} from './doctor-profile-edit-helpers';
import { usePendingCareSubmissions } from './pending-care-submissions';
import { ErrorState, Loading, Modal } from './ui';
import './patient-registration.css';

const titles = {
  edit: 'Edit doctor profile',
  review: 'Confirm profile changes',
  pending: 'Profile edit awaiting confirmation',
  stale: 'Profile changed since review',
  conflicts: 'Resolve profile changes',
  saved: 'Doctor profile updated',
};
export function DoctorProfileEditControls({
  doctorId,
  name,
  actorId,
  onSaved,
}: {
  doctorId: string;
  name: string;
  actorId: string;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState<'edit' | 'history' | null>(null);
  const { doctorProfileEdits } = usePendingCareSubmissions();
  return (
    <>
      <button className="button button-secondary button-small" onClick={() => setOpen('edit')}>
        {doctorProfileEdits.has(doctorId) ? 'Resume profile edit' : 'Edit profile'}
      </button>
      <button className="button button-secondary button-small" onClick={() => setOpen('history')}>
        Profile history
      </button>
      {open === 'edit' && (
        <DoctorProfileEditModal
          doctorId={doctorId}
          actorId={actorId}
          onClose={(saved) => {
            setOpen(null);
            if (saved) onSaved();
          }}
        />
      )}
      {open === 'history' && (
        <DoctorProfileHistory doctorId={doctorId} name={name} onClose={() => setOpen(null)} />
      )}
    </>
  );
}
function DoctorProfileEditModal({
  doctorId,
  actorId,
  onClose,
}: {
  doctorId: string;
  actorId: string;
  onClose: (saved: boolean) => void;
}) {
  const { doctorProfileEdits: pending } = usePendingCareSubmissions();
  const [attempt, setAttempt] = useState<ProfileEditAttempt | null>(
    () => pending.get(doctorId) ?? null,
  );
  const [phase, setPhase] = useState<keyof typeof titles>(attempt ? 'pending' : 'edit');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<DoctorProfileFields | null>(null);
  const [latest, setLatest] = useState<DoctorProfileEditContext | null>(null);
  const [conflicts, setConflicts] = useState<ProfileKey[]>([]);
  const [choices, setChoices] = useState<Partial<Record<ProfileKey, 'mine' | 'current'>>>({});
  const capture = useAppointmentBookingGuard();
  const origin = useRef<() => boolean>(() => false);
  const sending = useRef(false);
  const content = useRef<HTMLDivElement>(null);
  const previousPhase = useRef(phase);
  const contextPath = '/api/doctors/' + encodeURIComponent(doctorId) + '/profile-context';
  const initial = useAppointmentBookingData(
    phase === 'edit' && !latest && !attempt ? contextPath : null,
    (raw) => checkedProfileContext(raw, doctorId),
  );
  const source = latest ?? attempt?.source ?? initial.data;
  useLayoutEffect(() => {
    origin.current = capture();
    return () => {
      origin.current = () => false;
    };
  }, [capture]);
  useLayoutEffect(() => {
    if (previousPhase.current !== phase) content.current?.focus();
    previousPhase.current = phase;
  }, [phase]);
  function close() {
    origin.current = () => false;
    onClose(phase === 'saved');
  }
  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!origin.current() || !source || pending.has(doctorId)) return;
    const parsed = doctorProfileFields.safeParse(
      readDoctorProfile(event.currentTarget, draft ?? source.doctor),
    );
    if (!parsed.success) {
      const issue = parsed.error.issues[0],
        key = issue.path[0] as ProfileKey;
      setError(profileLabels[key] + ' · ' + issue.message);
      const input = event.currentTarget.elements.namedItem(key);
      if (input instanceof HTMLElement) input.focus();
      return;
    }
    if (!differentFields(source.doctor, parsed.data).length) {
      setError('Change a profile field before reviewing.');
      return;
    }
    const command = {
      profile: parsed.data,
      expectedRevision: source.revision,
      requestId: crypto.randomUUID(),
      reviewedConfirmed: true as const,
    };
    setAttempt({ source, command });
    setDraft(parsed.data);
    setError('');
    setConfirmed(false);
    setPhase('review');
  }
  async function save() {
    if (!attempt || sending.current || !origin.current()) return;
    if (
      phase === 'review'
        ? !confirmed || pending.has(doctorId)
        : phase !== 'pending' || pending.get(doctorId) !== attempt
    )
      return;
    pending.set(doctorId, attempt);
    const current = () => origin.current() && pending.get(doctorId) === attempt;
    sending.current = true;
    setBusy(true);
    setPhase('pending');
    try {
      const data = await api<unknown>(
        '/api/doctors/' + encodeURIComponent(doctorId) + '/profile-changes',
        { method: 'POST', body: attempt.command, isCurrent: current },
      );
      if (!current() || !checkedEditReceipt(data, attempt, actorId)) return;
      pending.delete(doctorId);
      setPhase('saved');
    } catch (e) {
      if (!current()) return;
      const reason = checkedEditRefusal(e, attempt, actorId);
      if (!reason) return;
      pending.delete(doctorId);
      setError(
        reason === 'DOCTOR_PROFILE_CHANGED'
          ? 'Someone updated this profile after you opened it. Refresh the current profile to review your draft again.'
          : 'This edit already matches the saved profile. Refresh to see the current fields.',
      );
      setPhase('stale');
    } finally {
      if (origin.current()) {
        sending.current = false;
        setBusy(false);
      }
    }
  }
  async function refresh() {
    if (!attempt || sending.current || !origin.current()) return;
    sending.current = true;
    setBusy(true);
    try {
      const raw = await api<unknown>(contextPath, { isCurrent: () => origin.current() });
      if (!origin.current()) return;
      const next = checkedProfileContext(raw, doctorId);
      const merged = rebaseProfile(attempt, next);
      setLatest(next);
      setDraft(merged.draft);
      setConflicts(merged.conflicts);
      setChoices({});
      setConfirmed(false);
      setError('');
      setPhase(merged.conflicts.length ? 'conflicts' : 'edit');
    } catch (e) {
      if (origin.current())
        setError(
          e instanceof Error ? e.message : 'The current doctor profile could not be loaded.',
        );
    } finally {
      if (origin.current()) {
        sending.current = false;
        setBusy(false);
      }
    }
  }
  function resolve() {
    if (!draft || !attempt || !conflicts.every((key) => choices[key])) return;
    let resolved = draft;
    for (const key of conflicts) {
      if (choices[key] === 'mine') resolved = { ...resolved, [key]: attempt.command.profile[key] };
    }
    setDraft(resolved);
    setPhase('edit');
  }
  return (
    <Modal title={titles[phase]} onClose={close}>
      <div className="stack doctor-profile-edit" tabIndex={-1} ref={content}>
        {phase === 'edit' &&
          (source ? (
            <DoctorProfileForm values={draft ?? source.doctor} onSubmit={review}>
              {error && (
                <p role="alert" className="notice notice-error">
                  {error}
                </p>
              )}
              <div className="modal-actions">
                <button type="button" className="button button-secondary" onClick={close}>
                  Cancel
                </button>
                <button className="button button-primary">Review changes</button>
              </div>
            </DoctorProfileForm>
          ) : initial.error ? (
            <ErrorState message={initial.error} retry={() => void initial.reload()} />
          ) : (
            <Loading />
          ))}
        {attempt && phase !== 'edit' && (
          <>
            {phase === 'saved' && <h3>Original saved change</h3>}
            <p className="muted small">
              {attempt.source.doctor.name} · {doctorId}
            </p>
            {phase === 'pending' && (
              <p className="notice" role="status">
                {busy
                  ? 'Confirming profile changes…'
                  : 'The server response could not be confirmed. Retry the exact edit to recover its outcome. After a reload or sign-out, check Profile history before editing again.'}
              </p>
            )}
            {phase === 'stale' && (
              <p className="notice" role="alert">
                {error}
              </p>
            )}
            {phase !== 'conflicts' && (
              <ProfileDifferences before={attempt.source.doctor} after={attempt.command.profile} />
            )}
            {phase === 'review' && (
              <>
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  <span>I reviewed these changes to the public doctor profile.</span>
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
                    onClick={() => void save()}
                  >
                    Save profile changes
                  </button>
                </div>
              </>
            )}
            {phase === 'pending' && (
              <div className="modal-actions">
                <button className="button button-secondary" onClick={close}>
                  Close for now
                </button>
                <button
                  className="button button-primary"
                  disabled={busy}
                  onClick={() => void save()}
                >
                  Retry exact edit
                </button>
              </div>
            )}
            {phase === 'saved' && (
              <div className="modal-actions">
                <button className="button button-primary" onClick={close}>
                  Done
                </button>
              </div>
            )}
            {phase === 'stale' && (
              <div className="modal-actions">
                <button className="button button-secondary" onClick={close}>
                  Close
                </button>
                <button
                  className="button button-primary"
                  disabled={busy}
                  onClick={() => void refresh()}
                >
                  Refresh current profile
                </button>
              </div>
            )}
            {phase === 'conflicts' && latest && (
              <>
                <p>Choose a value for each field that changed in both edits.</p>
                {conflicts.map((key) => (
                  <fieldset className="stack profile-choice" key={key}>
                    <legend>{profileLabels[key]}</legend>
                    <div>
                      <span className="muted small">Originally reviewed</span>
                      <div>
                        <ProfileValue value={attempt.source.doctor[key]} />
                      </div>
                    </div>
                    <label className="checkbox-field">
                      <input
                        type="radio"
                        name={key}
                        checked={choices[key] === 'current'}
                        onChange={() => setChoices({ ...choices, [key]: 'current' })}
                      />
                      <span>Use current value</span>
                    </label>
                    <div>
                      <ProfileValue value={latest.doctor[key]} />
                    </div>
                    <label className="checkbox-field">
                      <input
                        type="radio"
                        name={key}
                        checked={choices[key] === 'mine'}
                        onChange={() => setChoices({ ...choices, [key]: 'mine' })}
                      />
                      <span>Keep my edit</span>
                    </label>
                    <div>
                      <ProfileValue value={attempt.command.profile[key]} />
                    </div>
                  </fieldset>
                ))}
                <div className="modal-actions">
                  <button className="button button-secondary" onClick={close}>
                    Cancel
                  </button>
                  <button
                    className="button button-primary"
                    disabled={!conflicts.every((key) => choices[key])}
                    onClick={resolve}
                  >
                    Continue editing
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
