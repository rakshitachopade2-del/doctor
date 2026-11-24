import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { z } from 'zod';
import {
  staffAccountFields,
  staffInitialPassword,
  type StaffAccountCreationReview,
} from '../../shared/staff-account-creation';
import type { Doctor, User } from '../../shared/types';
import { api, ApiError } from '../lib';
import { useAppointmentBookingGuard } from './appointment-booking-helpers';
import { usePendingCareSubmissions } from './pending-care-submissions';
import { Field, Modal } from './ui';
import './patient-registration.css';

const roleNames = { admin: 'Administrator', doctor: 'Doctor', receptionist: 'Receptionist' };
const titles = {
  edit: 'Add a team member',
  review: 'Confirm staff account',
  pending: 'Account creation awaiting confirmation',
  saved: 'Staff account created',
  refused: 'Staff account not created',
};
const receiptSchema = z.strictObject({
  receipt: z.strictObject({
    actorId: z.string(),
    requestId: z.string(),
    account: z.strictObject({
      id: z.uuidv4(),
      name: z.string(),
      email: z.string(),
      role: staffAccountFields.shape.role,
      doctorId: z.string().optional(),
      active: z.literal(true),
      mustChangePassword: z.literal(true),
    }),
  }),
});
const refusalSchema = z.strictObject({
  code: z.literal('STAFF_ACCOUNT_NOT_CREATED'),
  actorId: z.string(),
  review: z.record(z.string(), z.unknown()),
  message: z.string().trim().min(1),
});

function originalAccount(data: unknown, reviewed: StaffAccountCreationReview, actorId: string) {
  const response = receiptSchema.safeParse(data);
  if (!response.success) return null;
  const receipt = response.data.receipt,
    account = receipt.account;
  if (
    receipt.requestId !== reviewed.requestId ||
    receipt.actorId !== actorId ||
    account.id === actorId ||
    account.id === reviewed.requestId ||
    account.id === reviewed.doctorId ||
    account.name !== reviewed.name ||
    account.email !== reviewed.email ||
    account.role !== reviewed.role ||
    (account.doctorId ?? null) !== reviewed.doctorId
  )
    return null;
  return account;
}

function refusalReason(error: unknown, reviewed: StaffAccountCreationReview, actorId: string) {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const parsed = refusalSchema.safeParse(error.responseData);
  if (!parsed.success) return null;
  const refusal = parsed.data,
    fields = Object.entries(reviewed);
  if (
    refusal.actorId !== actorId ||
    Object.keys(refusal.review).length !== fields.length ||
    !fields.every(([key, value]) => refusal.review[key] === value)
  )
    return null;
  return refusal.message;
}

interface CreationProps {
  actorId: string;
  doctors: Doctor[];
  onRefreshDoctors: () => void;
}
export function StaffAccountCreationControl({
  onSaved,
  ...props
}: CreationProps & { onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const { staffAccountCreation } = usePendingCareSubmissions();
  return (
    <>
      <button className="button button-secondary" onClick={() => setOpen(true)}>
        <Plus size={16} />
        {staffAccountCreation.current ? 'Resume staff account creation' : 'Add team member'}
      </button>
      {open && (
        <StaffAccountCreationModal
          {...props}
          onClose={(saved) => {
            setOpen(false);
            if (saved) onSaved();
          }}
        />
      )}
    </>
  );
}

function StaffAccountCreationModal({
  actorId,
  doctors,
  onRefreshDoctors,
  onClose,
}: CreationProps & { onClose: (saved: boolean) => void }) {
  const { staffAccountCreation: pending } = usePendingCareSubmissions();
  const [reviewed, setReviewed] = useState(pending.current);
  const [phase, setPhase] = useState<keyof typeof titles>(reviewed ? 'pending' : 'edit');
  const [role, setRole] = useState<StaffAccountCreationReview['role']>(
    reviewed?.role ?? 'receptionist',
  );
  const [doctorId, setDoctorId] = useState(reviewed?.doctorId ?? '');
  const [reviewedDoctorName, setReviewedDoctorName] = useState('');
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [saved, setSaved] = useState<User | null>(null);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const password = useRef('');
  const capture = useAppointmentBookingGuard();
  const origin = useRef<() => boolean>(() => false);
  const content = useRef<HTMLDivElement>(null);
  const previousPhase = useRef(phase);

  useLayoutEffect(() => {
    origin.current = capture();
    return () => {
      password.current = '';
    };
  }, [capture]);
  useLayoutEffect(() => {
    if (previousPhase.current !== phase) content.current?.focus();
    previousPhase.current = phase;
  }, [phase]);

  function close() {
    origin.current = () => false;
    password.current = '';
    onClose(phase === 'saved');
  }
  function edit() {
    password.current = '';
    setError('');
    setConfirmed(false);
    setPhase('edit');
  }
  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!origin.current() || phase !== 'edit' || pending.current) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    const parsed = staffAccountFields.safeParse({
      name: fields.get('name'),
      email: fields.get('email'),
      role,
      doctorId: fields.get('doctorId') || null,
    });
    const input = form.elements.namedItem('password') as HTMLInputElement;
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setError(issue.message);
      const invalid = form.elements.namedItem(String(issue.path[0]));
      if (invalid instanceof HTMLElement) invalid.focus();
      return;
    }
    if (!staffInitialPassword.safeParse(input.value).success) {
      setError('Enter an initial password between 12 and 128 characters.');
      input.focus();
      return;
    }
    const doctor = doctors.find((entry) => entry.id === parsed.data.doctorId);
    if ((role === 'doctor' || parsed.data.doctorId) && !doctor) {
      setError('Choose a listed doctor profile.');
      (form.elements.namedItem('doctorId') as HTMLSelectElement).focus();
      return;
    }
    password.current = input.value;
    input.value = '';
    setReviewed(
      Object.freeze({ ...parsed.data, reviewedConfirmed: true, requestId: crypto.randomUUID() }),
    );
    setReviewedDoctorName(doctor?.name ?? '');
    setError('');
    setConfirmed(false);
    setPhase('review');
  }

  async function submit() {
    if (!origin.current() || !reviewed || sending.current) return;
    const creating = phase === 'review' && confirmed && !!password.current && !pending.current;
    const recovering = phase === 'pending' && pending.current === reviewed;
    if (!creating && !recovering) return;
    const current = () => origin.current() && pending.current === reviewed;
    sending.current = true;
    pending.current = reviewed;
    setBusy(true);
    setPhase('pending');
    try {
      let request: Promise<unknown>;
      if (creating) {
        const body = { ...reviewed, password: password.current };
        password.current = '';
        request = api('/api/users/create', { method: 'POST', body, isCurrent: current });
        // api serializes the body synchronously before waiting for fetch.
        body.password = '';
      } else {
        request = api('/api/users/creation-outcome', {
          method: 'POST',
          body: reviewed,
          isCurrent: current,
        });
      }
      const response = await request;
      if (!current()) return;
      const account = originalAccount(response, reviewed, actorId);
      if (!account) return;
      pending.current = null;
      setSaved(account);
      setPhase('saved');
    } catch (error) {
      if (!current()) return;
      const reason = refusalReason(error, reviewed, actorId);
      if (!reason) return;
      pending.current = null;
      setError(reason);
      setPhase('refused');
      onRefreshDoctors();
    } finally {
      if (origin.current()) {
        sending.current = false;
        setBusy(false);
      }
    }
  }

  return (
    <Modal title={titles[phase]} onClose={close}>
      <div className="stack reviewed-account-form" tabIndex={-1} ref={content}>
        {phase === 'edit' && (
          <form className="stack" onSubmit={review}>
            <Field label="Full name">
              <input name="name" required maxLength={100} defaultValue={reviewed?.name} />
            </Field>
            <Field label="Email address">
              <input
                name="email"
                type="email"
                required
                maxLength={254}
                defaultValue={reviewed?.email}
              />
            </Field>
            <Field
              label="Initial password"
              hint="Use 12–128 characters and share it privately. The team member must change it at first sign-in."
            >
              <input
                name="password"
                type="password"
                minLength={12}
                maxLength={128}
                autoComplete="new-password"
                required
              />
            </Field>
            <Field label="Role">
              <select
                name="role"
                value={role}
                onChange={(event) => {
                  const next = staffAccountFields.shape.role.parse(event.target.value);
                  setRole(next);
                  if (next === 'receptionist') setDoctorId('');
                }}
              >
                <option value="receptionist">Receptionist — appointments and demographics</option>
                <option value="doctor">Doctor — clinical workspace</option>
                <option value="admin">Administrator — full clinic access</option>
              </select>
            </Field>
            <Field
              label="Linked doctor profile"
              hint={
                role === 'doctor'
                  ? 'Required for a doctor account.'
                  : role === 'admin'
                    ? 'Optional for an administrator who also provides care.'
                    : 'Receptionists work without a linked doctor profile.'
              }
            >
              <select
                name="doctorId"
                disabled={role === 'receptionist'}
                required={role === 'doctor'}
                value={doctors.some((entry) => entry.id === doctorId) ? doctorId : ''}
                onChange={(event) => setDoctorId(event.target.value)}
              >
                <option value="">
                  {role === 'doctor' ? 'Choose a doctor profile' : 'No doctor profile'}
                </option>
                {doctors.map((doctor) => (
                  <option key={doctor.id} value={doctor.id}>
                    {doctor.name}
                  </option>
                ))}
              </select>
            </Field>
            {error && (
              <p role="alert" className="notice notice-error">
                {error}
              </p>
            )}
            <div className="modal-actions">
              <button className="button button-secondary" type="button" onClick={close}>
                Cancel
              </button>
              <button className="button button-primary">Review account</button>
            </div>
          </form>
        )}
        {phase !== 'edit' && reviewed && (
          <>
            {phase === 'pending' && (
              <p className="notice" role="status">
                {busy
                  ? 'Confirming this request…'
                  : 'The server response could not be confirmed. Check the outcome to recover the original confirmation or close an attempt that never created an account.'}
              </p>
            )}
            {phase === 'refused' && (
              <p role="alert" className="notice notice-error">
                {error}
              </p>
            )}
            {phase === 'saved' && <h3>Original confirmation</h3>}
            <dl className="registration-details">
              {saved && (
                <div>
                  <dt>Account ID</dt>
                  <dd>{saved.id}</dd>
                </div>
              )}
              <div>
                <dt>Full name</dt>
                <dd>{reviewed.name}</dd>
              </div>
              <div>
                <dt>Email address</dt>
                <dd>{reviewed.email}</dd>
              </div>
              <div>
                <dt>Role</dt>
                <dd>{roleNames[reviewed.role]}</dd>
              </div>
              <div>
                <dt>Linked doctor profile</dt>
                <dd>
                  {reviewedDoctorName && <>{reviewedDoctorName} · </>}
                  {reviewed.doctorId ?? 'No doctor profile'}
                </dd>
              </div>
              {saved && (
                <>
                  <div>
                    <dt>Status at creation</dt>
                    <dd>Active</dd>
                  </div>
                  <div>
                    <dt>First sign-in</dt>
                    <dd>Password change required</dd>
                  </div>
                </>
              )}
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
                    I reviewed the email, role and doctor profile and confirm this person should
                    have workspace access.
                  </span>
                </label>
                <div className="modal-actions">
                  <button className="button button-secondary" onClick={edit}>
                    Edit details
                  </button>
                  <button
                    className="button button-primary"
                    disabled={!confirmed}
                    onClick={() => void submit()}
                  >
                    Create account
                  </button>
                </div>
              </>
            )}
            {phase === 'pending' && (
              <>
                <p className="muted small">
                  You can resume this request in this tab. After a reload or sign-out, check
                  Accounts &amp; access for the email before starting again.
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
                    Check creation outcome
                  </button>
                </div>
              </>
            )}
            {phase === 'refused' && (
              <div className="modal-actions">
                <button className="button button-secondary" onClick={close}>
                  Close
                </button>
                <button className="button button-primary" onClick={edit}>
                  Edit account details
                </button>
              </div>
            )}
            {phase === 'saved' && (
              <div className="modal-actions">
                <Link className="button button-secondary" to="/clinic/accounts">
                  View current accounts
                </Link>
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
