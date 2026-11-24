import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import type { InvestigationResult } from '../../shared/clinical';
import {
  investigationCancellationReason,
  type InvestigationCancellationCommand,
  type InvestigationCancellationReceipt,
} from '../../shared/investigation-cancellation';
import { api, useSession } from '../lib';
import {
  useAppointmentBookingData,
  useAppointmentBookingGuard,
} from './appointment-booking-helpers';
import { linkedDoctor } from './care-plan-creation-helpers';
import {
  cancellationContext,
  cancellationRefusal,
  confirmedCancellation,
  type CancellationAttempt,
} from './investigation-cancellation-helpers';
import { usePendingCareSubmissions } from './pending-care-submissions';
import { ErrorState, Field, Loading, Modal } from './ui';
import './investigation-result.css';
import './patient-registration.css';

const titles = {
  edit: 'Cancel investigation order',
  review: 'Review investigation cancellation',
  pending: 'Cancellation awaiting confirmation',
  refused: 'Investigation not cancelled',
  saved: 'Investigation cancelled',
};
type Role = InvestigationCancellationCommand['cancelledByRole'];
interface Props {
  patientId: string;
  investigationId: string;
  actorId: string;
  doctorId: string;
  role: Role;
  onClose: (refresh: boolean) => void;
}

export function useInvestigationCancellation(patientId: string, onChange: () => void) {
  const { session } = useSession(),
    user = session.user;
  const { key } = useLocation();
  const { investigationCancellations: pending } = usePendingCareSubmissions();
  const [selected, setSelected] = useState<string | null>(null);
  const scope = JSON.stringify([
    key,
    patientId,
    user?.id,
    user?.role,
    user?.doctorId,
    session.csrfToken,
  ]);
  useLayoutEffect(() => setSelected(null), [scope]);
  if (
    !user?.doctorId ||
    user.mustChangePassword ||
    (user.role !== 'doctor' && user.role !== 'admin')
  ) {
    return { controls: null, open: setSelected, hasPending: () => false };
  }
  const attempts = [...pending.values()].filter(
    (attempt) =>
      attempt.command.patientId === patientId &&
      attempt.command.doctorId === user.doctorId &&
      attempt.command.cancelledByRole === user.role,
  );
  const controls = (
    <>
      {!selected &&
        attempts.map((a) => (
          <div className="notice result-resume" key={a.command.investigationId}>
            <span>Order ID · {a.command.investigationId}</span>
            <button
              className="button button-secondary"
              onClick={() => setSelected(a.command.investigationId)}
            >
              Resume cancellation: {a.title}
            </button>
          </div>
        ))}
      {selected && (
        <InvestigationCancellationModal
          key={scope + selected}
          patientId={patientId}
          investigationId={selected}
          actorId={user.id}
          doctorId={user.doctorId}
          role={user.role}
          onClose={(refresh) => {
            setSelected(null);
            if (refresh) onChange();
          }}
        />
      )}
    </>
  );
  return {
    open: setSelected,
    hasPending: (id: string) => attempts.some((a) => a.command.investigationId === id),
    controls,
  };
}
function Time({ value }: { value: string }) {
  return (
    <time dateTime={value}>
      {new Date(value).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
    </time>
  );
}
function LatestResult({ result }: { result: InvestigationResult | null }) {
  return (
    <section>
      <h3>Latest result</h3>
      {!result ? (
        <p>No result has been submitted.</p>
      ) : (
        <>
          <p>
            {result.submittedByName} · <Time value={result.createdAt} />
          </p>
          {result.note && <p className="pre-line">{result.note}</p>}
          {result.documentIds.length > 0 && (
            <ul className="result-report-list">
              {result.documentIds.map((id) => (
                <li key={id}>
                  <a href={'/api/documents/' + encodeURIComponent(id) + '/file'} download>
                    Linked report · {id}
                  </a>
                </li>
              ))}
            </ul>
          )}
          <p className="muted small">Result ID · {result.id}</p>
        </>
      )}
    </section>
  );
}
function InvestigationCancellationModal({
  patientId,
  investigationId,
  actorId,
  doctorId,
  role,
  onClose,
}: Props) {
  const { investigationCancellations: pending } = usePendingCareSubmissions();
  const [attempt, setAttempt] = useState<CancellationAttempt | null>(() => {
    const stored = pending.get(investigationId);
    return stored?.command.patientId === patientId &&
      stored.command.doctorId === doctorId &&
      stored.command.cancelledByRole === role
      ? stored
      : null;
  });
  const [phase, setPhase] = useState<keyof typeof titles>(attempt ? 'pending' : 'edit');
  const [reason, setReason] = useState(attempt?.command.reason ?? '');
  const [ack, setAck] = useState(false),
    [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState('');
  const [saved, setSaved] = useState<InvestigationCancellationReceipt | null>(null);
  const refused = useRef<CancellationAttempt | null>(null),
    dismissed = useRef(false),
    sending = useRef(false),
    refreshOnClose = useRef(!!attempt);
  const capture = useAppointmentBookingGuard();
  const base = '/api/investigations/' + encodeURIComponent(investigationId);
  const context = useAppointmentBookingData(
    phase === 'edit' ? base + '/review-context' : null,
    (raw) => cancellationContext(raw, patientId, investigationId, refused.current),
  );
  const doctors = useAppointmentBookingData(phase === 'edit' ? '/api/doctors' : null, (raw) =>
    linkedDoctor(raw, doctorId),
  );
  const data = context.data,
    order = data?.investigation;
  const terminal = order?.status === 'reviewed' || order?.status === 'cancelled';
  const title = terminal ? 'Current investigation' : titles[phase];
  const content = useRef<HTMLDivElement>(null),
    previousTitle = useRef(title);
  useLayoutEffect(() => {
    if (previousTitle.current !== title) content.current?.focus();
    previousTitle.current = title;
  }, [title]);
  function close() {
    dismissed.current = true;
    onClose(refreshOnClose.current || terminal);
  }
  function review(event: FormEvent) {
    event.preventDefault();
    if (
      phase !== 'edit' ||
      !data ||
      !order ||
      terminal ||
      !doctors.data ||
      pending.has(investigationId)
    )
      return;
    const checked = investigationCancellationReason.safeParse(reason);
    if (!checked.success) return;
    setAttempt({
      command: {
        requestId: crypto.randomUUID(),
        investigationId,
        patientId,
        doctorId,
        cancelledByRole: role,
        expectedLatestResultId: data.latestResult?.id ?? null,
        reason: checked.data,
        reviewedConfirmed: true,
      },
      title: order.title,
      patientName: data.patientName,
      doctorName: doctors.data.name,
      orderedByName: order.doctorName,
      orderedById: order.doctorId,
      latestResult: data.latestResult,
    });
    setAck(false);
    setPhase('review');
  }
  async function submit() {
    if (!attempt || sending.current || dismissed.current) return;
    const first = phase === 'review' && ack && !pending.has(investigationId);
    const retry = phase === 'pending' && pending.get(investigationId) === attempt;
    if (!first && !retry) return;
    const origin = capture();
    sending.current = true;
    refreshOnClose.current = true;
    pending.set(investigationId, attempt);
    const current = () =>
      origin() && !dismissed.current && pending.get(investigationId) === attempt;
    setBusy(true);
    setPhase('pending');
    try {
      const value = await api<unknown>(base + '/cancellation', {
        method: 'POST',
        body: attempt.command,
        isCurrent: current,
      });
      if (!current()) return;
      const receipt = confirmedCancellation(value, attempt, actorId);
      if (receipt) {
        pending.delete(investigationId);
        setSaved(receipt);
        setPhase('saved');
      }
    } catch (e) {
      if (!current()) return;
      const message = cancellationRefusal(e, attempt, actorId);
      if (message) {
        pending.delete(investigationId);
        refused.current = attempt;
        setRefusal(message);
        setAck(false);
        setPhase('refused');
      }
    } finally {
      if (origin() && !dismissed.current) {
        sending.current = false;
        setBusy(false);
      }
    }
  }
  function refresh() {
    setAttempt(null);
    setAck(false);
    setPhase('edit');
  }
  const showOrder = phase === 'edit' ? data && (terminal || doctors.data) : attempt;
  return (
    <Modal title={title} onClose={close}>
      <div className="stack result-submission" tabIndex={-1} ref={content}>
        {phase === 'edit' &&
          !showOrder &&
          (context.error || doctors.error ? (
            <ErrorState
              message={context.error || doctors.error}
              retry={() => {
                void context.reload();
                void doctors.reload();
              }}
            />
          ) : (
            <Loading />
          ))}
        {phase === 'pending' && (
          <p className="notice" role="status">
            {busy
              ? 'Confirming the cancellation…'
              : 'The cancellation could not be confirmed. Retry the exact request to check whether it was recorded.'}
          </p>
        )}
        {phase === 'refused' && (
          <p className="notice" role="status">
            {refusal}
          </p>
        )}
        {saved && <h3>Original confirmation</h3>}
        {showOrder && (
          <>
            <dl className="registration-details">
              <div>
                <dt>Investigation</dt>
                <dd>{order?.title ?? attempt?.title}</dd>
              </div>
              <div>
                <dt>Order ID</dt>
                <dd>{investigationId}</dd>
              </div>
              <div>
                <dt>Patient</dt>
                <dd>
                  {data?.patientName ?? attempt?.patientName} · {patientId}
                </dd>
              </div>
              <div>
                <dt>Ordering clinician</dt>
                <dd>
                  {order?.doctorName ?? attempt?.orderedByName} ·{' '}
                  {order?.doctorId ?? attempt?.orderedById}
                </dd>
              </div>
              {!terminal && (
                <div>
                  <dt>Cancelling clinician</dt>
                  <dd>
                    {saved?.doctorName ?? attempt?.doctorName ?? doctors.data?.name} · {doctorId}
                  </dd>
                </div>
              )}
              {phase !== 'edit' && attempt && (
                <div>
                  <dt>Reason for cancellation</dt>
                  <dd>{saved?.reason ?? attempt.command.reason}</dd>
                </div>
              )}
              {saved && (
                <div>
                  <dt>Cancelled at</dt>
                  <dd>
                    <Time value={saved.cancelledAt} />
                  </dd>
                </div>
              )}
            </dl>
            <LatestResult result={data?.latestResult ?? attempt?.latestResult ?? null} />
          </>
        )}
        {phase === 'edit' &&
          showOrder &&
          (terminal ? (
            <>
              <p role="status">
                {order.status === 'cancelled'
                  ? 'This order has already been cancelled.'
                  : 'The latest result has been reviewed. This order cannot be cancelled.'}
              </p>
              {order.cancellationReason && (
                <p className="pre-line">
                  <strong>Recorded cancellation reason</strong> · {order.cancellationReason}
                </p>
              )}
              <button className="button button-secondary" onClick={close}>
                Close
              </button>
            </>
          ) : (
            <form className="stack" onSubmit={review}>
              <Field
                label="Reason for cancellation"
                hint="The patient will see this reason in their record."
              >
                <textarea
                  name="reason"
                  rows={3}
                  maxLength={8000}
                  required
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </Field>
              <p className="muted small">
                Cancelling closes this order to new results and reviews. Existing reports and
                findings stay in the record.
              </p>
              <div className="result-actions">
                <button className="button button-secondary" type="button" onClick={close}>
                  Close
                </button>
                <button className="button button-primary" disabled={!reason.trim()}>
                  Review cancellation
                </button>
              </div>
            </form>
          ))}
        {phase === 'review' && (
          <>
            <label className="checkbox-field">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              <span>
                I reviewed this order, its latest result and the reason the patient will see. I
                understand the cancellation is permanent.
              </span>
            </label>
            <div className="result-actions">
              <button className="button button-secondary" onClick={refresh}>
                Edit reason
              </button>
              <button
                className="button button-primary"
                disabled={!ack}
                onClick={() => void submit()}
              >
                Confirm cancellation
              </button>
            </div>
          </>
        )}
        {phase === 'pending' && (
          <>
            <p className="muted small">
              You can resume this cancellation in this signed-in tab. After reloading or signing
              out, check the investigation’s status in All records.
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
                Retry exact cancellation
              </button>
            </div>
          </>
        )}
        {phase === 'refused' && (
          <div className="result-actions">
            <button className="button button-secondary" onClick={close}>
              Close
            </button>
            <button className="button button-primary" onClick={refresh}>
              Refresh investigation
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
      </div>
    </Modal>
  );
}
