import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { ProcedureCancellationReceipt } from '../../shared/procedure-cancellation';
import { api, useSession } from '../lib';
import {
  useAppointmentBookingData,
  useAppointmentBookingGuard,
} from './appointment-booking-helpers';
import { ProcedureVisit } from './PatientProcedureInformation';
import { DecisionEntry } from './ProcedureDecisionModal';
import {
  cancellationContext,
  cancellationRefusal,
  confirmedCancellation,
  type ProcedureCancellationAttempt,
} from './procedure-cancellation-helpers';
import { usePendingCareSubmissions } from './pending-care-submissions';
import {
  useProcedureRecording,
  type ProcedureRecordingModalProps,
} from './use-procedure-recording';
import { ErrorState, Field, Loading, Modal } from './ui';
import './procedure-decision.css';

export function useProcedureCancellation(
  patientId: string,
  patientName: string,
  onChange: () => void,
) {
  return useProcedureRecording(
    'cancellation',
    ProcedureCancellationModal,
    patientId,
    patientName,
    onChange,
  );
}
const titles = {
  edit: 'Cancel procedure',
  review: 'Review procedure cancellation',
  pending: 'Cancellation awaiting confirmation',
  refused: 'Procedure not cancelled',
  saved: 'Procedure cancelled',
};
function ProcedureCancellationModal({
  patientId,
  patientName,
  procedureId,
  onClose,
}: ProcedureRecordingModalProps) {
  const actor = useSession().session.user!;
  const doctorId = actor.doctorId!;
  const { procedureCancellations: pending } = usePendingCareSubmissions();
  const capture = useAppointmentBookingGuard();
  const [attempt, setAttempt] = useState<ProcedureCancellationAttempt | null>(
    () => pending.get(procedureId) ?? null,
  );
  const [phase, setPhase] = useState<keyof typeof titles>(attempt ? 'pending' : 'edit');
  const [reason, setReason] = useState(attempt?.command.reason ?? '');
  const [ack, setAck] = useState(false),
    [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState(''),
    [saved, setSaved] = useState<ProcedureCancellationReceipt | null>(null);
  const dismissed = useRef(false),
    sending = useRef(false),
    changed = useRef(!!attempt);
  const rejected = useRef<ProcedureCancellationAttempt | null>(null);
  const url = '/api/procedures/' + encodeURIComponent(procedureId);
  const context = useAppointmentBookingData(
    phase === 'edit' ? url + '/cancellation-context' : null,
    (raw) => cancellationContext(raw, patientId, procedureId, doctorId, rejected.current),
  );
  const source = context.data;
  const terminal = source && !source.allowed;
  const title = terminal ? 'Current procedure' : titles[phase];
  const heading = useRef<HTMLDivElement>(null),
    previous = useRef(title);
  useLayoutEffect(() => {
    if (previous.current !== title) heading.current?.focus();
    previous.current = title;
  }, [title]);
  function close() {
    dismissed.current = true;
    onClose(changed.current || !!terminal);
  }
  function review(e: FormEvent) {
    e.preventDefault();
    if (
      phase !== 'edit' ||
      !source?.allowed ||
      !reason.trim() ||
      pending.has(procedureId) ||
      (actor.role !== 'doctor' && actor.role !== 'admin')
    )
      return;
    const procedure = source.procedure,
      agreement = procedure.agreements.at(-1) ?? null;
    setAttempt({
      command: {
        requestId: crypto.randomUUID(),
        patientId,
        procedureId,
        doctorId,
        cancelledByRole: actor.role,
        expectedRevision: source.revision,
        expectedDecisionId: agreement?.id ?? null,
        reason: reason.trim(),
        reviewedConfirmed: true,
      },
      patientName,
      procedureTitle: procedure.title,
      doctorName: source.doctorName,
      agreement,
      appointment: procedure.scheduledAppointment ?? null,
      linked: !!procedure.effectiveAppointmentId,
    });
    setAck(false);
    setPhase('review');
  }
  function edit() {
    setAttempt(null);
    setAck(false);
    setPhase('edit');
  }
  async function submit() {
    if (!attempt || sending.current || dismissed.current) return;
    const creating = phase === 'review' && ack && !pending.has(procedureId);
    const recovering = phase === 'pending' && pending.get(procedureId) === attempt;
    if (!creating && !recovering) return;
    const origin = capture();
    changed.current = true;
    pending.set(procedureId, attempt);
    const current = () => origin() && !dismissed.current && pending.get(procedureId) === attempt;
    sending.current = true;
    setBusy(true);
    setPhase('pending');
    try {
      const value = await api<unknown>(url + '/cancellation', {
        method: 'POST',
        body: attempt.command,
        isCurrent: current,
      });
      if (!current()) return;
      const receipt = confirmedCancellation(value, attempt, actor.id);
      if (receipt) {
        pending.delete(procedureId);
        setSaved(receipt);
        setPhase('saved');
      }
    } catch (e) {
      if (!current()) return;
      const message = cancellationRefusal(e, attempt.command, actor.id);
      if (message) {
        pending.delete(procedureId);
        rejected.current = attempt;
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
  const agreement = attempt?.agreement ?? source?.procedure.agreements.at(-1);
  return (
    <Modal title={title} onClose={close}>
      <div className="stack procedure-decision-form" tabIndex={-1} ref={heading}>
        {phase === 'edit' &&
          !source &&
          (context.error ? (
            <ErrorState message={context.error} retry={() => void context.reload()} />
          ) : (
            <Loading />
          ))}
        {phase === 'pending' && (
          <p className="notice" role="status">
            {busy
              ? 'Confirming the cancellation…'
              : 'Confirmation was interrupted. Retry this exact cancellation to recover the original outcome.'}
          </p>
        )}
        {phase === 'refused' && (
          <p className="notice" role="status">
            {refusal}
          </p>
        )}
        {saved && <h3>Original cancellation confirmation</h3>}
        {(source || attempt) && (
          <>
            <p>
              <strong>{attempt?.procedureTitle ?? source?.procedure.title}</strong> · {procedureId}
            </p>
            <p>
              Patient · {attempt?.patientName ?? patientName} · {patientId}
            </p>
            {!terminal && (
              <p>
                Cancelling clinician ·{' '}
                {saved?.doctorName ?? attempt?.doctorName ?? source?.doctorName} · {doctorId}
              </p>
            )}
            <section>
              <h3>{phase === 'edit' ? 'Latest recorded choice' : 'Patient decision at review'}</h3>
              {agreement ? (
                <DecisionEntry agreement={agreement} />
              ) : (
                <p>No patient decision has been recorded.</p>
              )}
            </section>
            <ProcedureVisit
              appointment={
                saved?.appointment ?? attempt?.appointment ?? source?.procedure.scheduledAppointment
              }
              linked={attempt?.linked ?? !!source?.procedure.effectiveAppointmentId}
              patientView={false}
            />
          </>
        )}
        {attempt && (
          <section>
            <h3>Reason for cancellation</h3>
            <p className="pre-line">{saved?.reason ?? attempt.command.reason}</p>
          </section>
        )}
        {phase === 'edit' &&
          source &&
          (terminal ? (
            <>
              <p role="status">{source.blockedReason}</p>
              {source.procedure.cancellationReason && (
                <p>Recorded cancellation reason · {source.procedure.cancellationReason}</p>
              )}
              {source.procedure.completion && (
                <p>Recorded outcome · {source.procedure.completion.outcome}</p>
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
                  required
                  rows={3}
                  maxLength={8000}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </Field>
              <p className="muted small">
                This permanently closes the procedure plan. Manage appointments and invoices
                separately.
              </p>
              <div className="form-actions">
                <button type="button" className="button button-secondary" onClick={close}>
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
                I reviewed this procedure, the patient’s latest decision, the linked visit and the
                cancellation reason.
              </span>
            </label>
            <div className="form-actions">
              <button className="button button-secondary" onClick={edit}>
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
              Resume from this chart in the same signed-in tab. After reloading or signing out,
              check All records for the procedure’s status.
            </p>
            <div className="form-actions">
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
          <div className="form-actions">
            <button className="button button-secondary" onClick={close}>
              Close
            </button>
            <button className="button button-primary" onClick={edit}>
              Refresh procedure
            </button>
          </div>
        )}
        {saved && (
          <>
            <p>
              Cancelled at ·{' '}
              <time dateTime={saved.cancelledAt}>
                {new Date(saved.cancelledAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}{' '}
                IST
              </time>
            </p>
            <div className="form-actions">
              <button className="button button-primary" onClick={close}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
