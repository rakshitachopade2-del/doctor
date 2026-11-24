import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { Plus } from 'lucide-react';
import {
  investigationOrderFields,
  type InvestigationOrderFields,
} from '../../shared/investigation-order';
import type { Investigation } from '../../shared/clinical';
import { api, today, useSession } from '../lib';
import {
  useAppointmentBookingData,
  useAppointmentBookingGuard,
} from './appointment-booking-helpers';
import { linkedDoctor } from './care-plan-creation-helpers';
import {
  confirmedInvestigationOrder,
  verifiedOrderRefusal,
  type InvestigationOrderAttempt,
} from './investigation-order-helpers';
import { usePendingCareSubmissions } from './pending-care-submissions';
import { ErrorState, Field, Loading, Modal } from './ui';
import './investigation-result.css';
import './patient-registration.css';

const kinds = {
  laboratory: 'Laboratory',
  pathology: 'Pathology',
  imaging: 'Imaging',
  other: 'Other',
};
const titles = {
  edit: 'Order an investigation',
  review: 'Review investigation order',
  pending: 'Order awaiting confirmation',
  saved: 'Investigation ordered',
  rejected: 'Investigation not ordered',
};

export function useInvestigationOrder(
  patientId: string,
  patientName: string,
  investigations: Investigation[],
  reload: () => void,
) {
  const { session } = useSession();
  const { investigationOrders: pending } = usePendingCareSubmissions();
  const { key } = useLocation();
  const user = session.user;
  const scope = JSON.stringify([
    key,
    patientId,
    user?.id,
    user?.role,
    user?.doctorId,
    session.csrfToken,
  ]);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => setOpen(false), [scope]);
  if (
    !user?.doctorId ||
    user.mustChangePassword ||
    (user.role !== 'admin' && user.role !== 'doctor')
  )
    return { button: null, modal: null, hasPending: false };
  const hasPending = pending.has(patientId);
  return {
    hasPending,
    button: (
      <button className="button button-primary" onClick={() => setOpen(true)}>
        <Plus size={16} />
        {hasPending ? 'Resume investigation order' : 'Order investigation'}
      </button>
    ),
    modal: open && (
      <InvestigationOrderModal
        key={scope}
        patientId={patientId}
        patientName={patientName}
        actorId={user.id}
        role={user.role}
        doctorId={user.doctorId}
        investigations={investigations}
        onClose={(saved) => {
          setOpen(false);
          if (saved) reload();
        }}
      />
    ),
  };
}

interface OrderProps {
  actorId: string;
  doctorId: string;
  role: 'doctor' | 'admin';
  patientId: string;
  patientName: string;
  investigations: Investigation[];
  onClose: (saved: boolean) => void;
}

function InvestigationOrderModal({
  actorId,
  doctorId,
  role,
  patientId,
  patientName,
  investigations,
  onClose,
}: OrderProps) {
  const { investigationOrders: pending } = usePendingCareSubmissions();
  const [attempt, setAttempt] = useState<InvestigationOrderAttempt | null>(
    () => pending.get(patientId) ?? null,
  );
  const [phase, setPhase] = useState<keyof typeof titles>(attempt ? 'pending' : 'edit');
  const [saved, setSaved] = useState<Investigation | null>(null);
  const [error, setError] = useState('');
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const doctors = useAppointmentBookingData(phase === 'edit' ? '/api/doctors' : null, (raw) =>
    linkedDoctor(raw, doctorId),
  );
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
  function edit() {
    setError('');
    setChecked(false);
    setPhase('edit');
  }
  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!origin.current() || phase !== 'edit' || !doctors.data || pending.has(patientId)) return;
    const form = event.currentTarget,
      values = new FormData(form);
    const parsed = investigationOrderFields.safeParse({
      patientId,
      title: values.get('title'),
      kind: values.get('kind'),
      reason: values.get('reason'),
      instructions: values.get('instructions'),
      dueDate: values.get('dueDate') || null,
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setError(issue.message);
      const invalid = form.elements.namedItem(String(issue.path[0]));
      if (invalid instanceof HTMLElement) invalid.focus();
      return;
    }
    if (parsed.data.dueDate && parsed.data.dueDate < today()) {
      setError('Choose today or a future due date.');
      (form.elements.namedItem('dueDate') as HTMLInputElement).focus();
      return;
    }
    const command = Object.freeze({
      ...parsed.data,
      doctorId,
      orderedByRole: role,
      requestId: crypto.randomUUID(),
      reviewedConfirmed: true as const,
    });
    setAttempt({
      command,
      patientName,
      doctorName: doctors.data.name,
      priorOrderIds: investigations.map((order) => order.id),
    });
    setChecked(false);
    setError('');
    setPhase('review');
  }
  async function submit() {
    if (!attempt || sending.current || !origin.current()) return;
    const creating = phase === 'review' && checked && !pending.has(patientId);
    const recovering = phase === 'pending' && pending.get(patientId) === attempt;
    if (!creating && !recovering) return;
    pending.set(patientId, attempt);
    const current = () => origin.current() && pending.get(patientId) === attempt;
    sending.current = true;
    setBusy(true);
    setPhase('pending');
    try {
      const response = await api<unknown>('/api/investigations/order', {
        method: 'POST',
        body: attempt.command,
        isCurrent: current,
      });
      if (!current()) return;
      const order = confirmedInvestigationOrder(response, attempt, actorId);
      if (!order) return;
      pending.delete(patientId);
      setSaved(order);
      setPhase('saved');
    } catch (e) {
      if (!current()) return;
      const message = verifiedOrderRefusal(e, attempt.command, actorId);
      if (!message) return;
      pending.delete(patientId);
      setError(message);
      setPhase('rejected');
    } finally {
      if (origin.current()) {
        sending.current = false;
        setBusy(false);
      }
    }
  }
  const fields: InvestigationOrderFields | undefined = saved ?? attempt?.command;
  return (
    <Modal title={titles[phase]} onClose={close}>
      <div className="stack result-submission" ref={content} tabIndex={-1}>
        {phase === 'edit' &&
          (doctors.error ? (
            <ErrorState message={doctors.error} retry={() => void doctors.reload()} />
          ) : !doctors.data ? (
            <Loading />
          ) : (
            <form className="stack" onSubmit={review}>
              <p>
                For <strong>{patientName}</strong> · Ordering clinician{' '}
                <strong>{doctors.data.name}</strong>
              </p>
              <Field label="Investigation name">
                <input
                  name="title"
                  required
                  maxLength={300}
                  defaultValue={fields?.title}
                  placeholder="Clinician-selected investigation"
                />
              </Field>
              <div className="form-grid">
                <Field label="Investigation type">
                  <select name="kind" defaultValue={fields?.kind ?? 'laboratory'}>
                    {Object.entries(kinds).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Requested by date" hint="Optional">
                  <input
                    type="date"
                    name="dueDate"
                    min={today()}
                    defaultValue={fields?.dueDate ?? ''}
                  />
                </Field>
              </div>
              <Field label="Clinical question / reason">
                <textarea
                  name="reason"
                  required
                  maxLength={8000}
                  rows={3}
                  defaultValue={fields?.reason}
                />
              </Field>
              <Field label="Instructions for the patient">
                <textarea
                  name="instructions"
                  required
                  maxLength={8000}
                  rows={3}
                  defaultValue={fields?.instructions}
                  placeholder="Preparation and how to share the result"
                />
              </Field>
              <p className="muted small">
                This order appears in the patient’s record. The clinic arranges any laboratory work
                separately.
              </p>
              {error && (
                <p className="notice notice-error" role="alert">
                  {error}
                </p>
              )}
              <div className="result-actions">
                <button type="button" className="button button-secondary" onClick={close}>
                  Cancel
                </button>
                <button className="button button-primary">Review order</button>
              </div>
            </form>
          ))}
        {phase !== 'edit' && attempt && fields && (
          <>
            {phase === 'pending' && (
              <p role="status" className="notice">
                {busy
                  ? 'Confirming the order…'
                  : 'The order could not be confirmed. Retrying this exact request recovers the original order or submits it if the first request never arrived.'}
              </p>
            )}
            {phase === 'rejected' && (
              <p role="alert" className="notice notice-error">
                {error}
              </p>
            )}
            {saved && <h3>Original order</h3>}
            <dl className="registration-details">
              {saved && (
                <div>
                  <dt>Order ID</dt>
                  <dd>{saved.id}</dd>
                </div>
              )}
              <div>
                <dt>Patient</dt>
                <dd>
                  {attempt.patientName} · {patientId}
                </dd>
              </div>
              <div>
                <dt>Ordering clinician</dt>
                <dd>
                  {saved?.doctorName ?? attempt.doctorName} · {doctorId}
                </dd>
              </div>
              <div>
                <dt>Investigation name</dt>
                <dd>{fields.title}</dd>
              </div>
              <div>
                <dt>Investigation type</dt>
                <dd>{kinds[fields.kind]}</dd>
              </div>
              <div>
                <dt>Requested by date</dt>
                <dd>{fields.dueDate ?? 'No due date'}</dd>
              </div>
              <div>
                <dt>Clinical question / reason</dt>
                <dd>{fields.reason}</dd>
              </div>
              <div>
                <dt>Instructions for the patient</dt>
                <dd>{fields.instructions}</dd>
              </div>
              {saved && (
                <div>
                  <dt>Status at creation</dt>
                  <dd>Ordered</dd>
                </div>
              )}
            </dl>
            {phase === 'review' && (
              <>
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => setChecked(event.target.checked)}
                  />
                  <span>
                    I reviewed this investigation and the instructions this patient will see.
                  </span>
                </label>
                <div className="result-actions">
                  <button className="button button-secondary" onClick={edit}>
                    Edit details
                  </button>
                  <button
                    className="button button-primary"
                    disabled={!checked}
                    onClick={() => void submit()}
                  >
                    Save investigation order
                  </button>
                </div>
              </>
            )}
            {phase === 'pending' && (
              <>
                <p className="muted small">
                  You can resume this order in this tab. After a reload or sign-out, check the
                  patient’s investigations before ordering again.
                </p>
                <div className="result-actions">
                  <button className="button button-secondary" onClick={close}>
                    Close for now
                  </button>
                  <button
                    className="button button-primary"
                    disabled={busy}
                    onClick={() => void submit()}
                  >
                    Retry exact order
                  </button>
                </div>
              </>
            )}
            {phase === 'rejected' && (
              <div className="result-actions">
                <button className="button button-secondary" onClick={close}>
                  Close
                </button>
                <button className="button button-primary" onClick={edit}>
                  Edit order details
                </button>
              </div>
            )}
            {phase === 'saved' && (
              <div className="result-actions">
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
