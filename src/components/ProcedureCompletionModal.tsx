import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { ProcedureAgreement, ProcedureCompletion } from '../../shared/clinical';
import type {
  ProcedureCompletionContext,
  ProcedureCompletionNotRecorded,
} from '../../shared/procedure-completion';
import { api, useSession } from '../lib';
import { useAppointmentBookingGuard } from './appointment-booking-helpers';
import { usePendingCareSubmissions } from './pending-care-submissions';
import { ProcedureVisit } from './PatientProcedureInformation';
import { DecisionEntry } from './ProcedureDecisionModal';
import {
  checkedCompletionContext,
  confirmedCompletion,
  completionRefusal,
  requireOriginalCompletion,
  requireObservedProcedure,
  type CompletionAttempt,
} from './procedure-completion-helpers';
import {
  useProcedureRecording,
  type ProcedureRecordingModalProps,
} from './use-procedure-recording';
import { ErrorState, Field, Loading, Modal } from './ui';
import './procedure-decision.css';

export function useProcedureCompletionRecording(
  patientId: string,
  patientName: string,
  onChange: () => void,
) {
  return useProcedureRecording(
    'completion',
    ProcedureCompletionModal,
    patientId,
    patientName,
    onChange,
  );
}

const titles = {
  edit: 'Document procedure completion',
  review: 'Confirm procedure completion',
  pending: 'Completion awaiting confirmation',
  rejected: 'Completion not recorded',
  saved: 'Completion recorded',
  current: 'Current procedure',
};

function CompletionNotes({ outcome, aftercare }: { outcome: string; aftercare: string }) {
  return (
    <>
      <section>
        <h3>Procedure outcome and notes</h3>
        <p className="pre-line">{outcome}</p>
      </section>
      <section>
        <h3>Final aftercare instructions</h3>
        <p className="pre-line">{aftercare}</p>
      </section>
    </>
  );
}

function SavedCompletion({ completion }: { completion: ProcedureCompletion }) {
  return (
    <>
      <p>
        Performed by {completion.doctorName} ·{' '}
        <time dateTime={completion.completedAt}>
          {new Date(completion.completedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}{' '}
          IST
        </time>
      </p>
      <CompletionNotes outcome={completion.outcome} aftercare={completion.aftercare} />
      {completion.appointment !== undefined && (
        <ProcedureVisit
          appointment={completion.appointment}
          linked={!!completion.appointment}
          completed
          patientView={false}
        />
      )}
    </>
  );
}

function ProcedureCompletionModal({
  patientId,
  patientName,
  procedureId,
  onClose,
}: ProcedureRecordingModalProps) {
  const actor = useSession().session.user!;
  const doctorId = actor.doctorId!;
  const capture = useAppointmentBookingGuard();
  const { procedureCompletions: pending } = usePendingCareSubmissions();
  const entry = pending.get(procedureId);
  const initial =
    entry?.command.patientId === patientId &&
    entry.command.doctorId === doctorId &&
    entry.command.recordedByRole === actor.role
      ? entry
      : null;
  const [phase, setPhase] = useState<keyof typeof titles>(initial ? 'pending' : 'edit');
  const [context, setContext] = useState<ProcedureCompletionContext | null>(null);
  const [attempt, setAttempt] = useState<CompletionAttempt | null>(initial);
  const [outcome, setOutcome] = useState(initial?.command.outcome ?? '');
  const [aftercare, setAftercare] = useState<string | null>(initial?.command.aftercare ?? null);
  const [reviewed, setReviewed] = useState(false);
  const [saved, setSaved] = useState<ProcedureCompletion | null>(null);
  const [refusal, setRefusal] = useState('');
  const knownConflict = useRef<{
    agreement: ProcedureAgreement;
    observed: ProcedureCompletionNotRecorded['observed'];
  } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(!initial);
  const heading = useRef<HTMLDivElement>(null),
    previousPhase = useRef(phase);
  const dismissed = useRef(false),
    sending = useRef(false),
    version = useRef(0);
  const openedPending = useRef(!!initial),
    refreshOnClose = useRef(!!initial);
  const basePath = '/api/procedures/' + encodeURIComponent(procedureId);

  const load = useCallback(
    async (original?: { attempt: CompletionAttempt; saved: ProcedureCompletion }) => {
      const origin = capture(),
        serial = ++version.current;
      const current = () => origin() && !dismissed.current && serial === version.current;
      setLoading(true);
      setError('');
      try {
        const value = await api<unknown>(basePath + '/completion-context', { isCurrent: current });
        if (!current()) return;
        const fresh = checkedCompletionContext(value, patientId, procedureId, doctorId);
        const conflict = knownConflict.current;
        if (conflict) requireObservedProcedure(fresh, conflict.agreement, conflict.observed);
        if (original) {
          requireOriginalCompletion(fresh, original.attempt, original.saved);
          setPhase('current');
        } else {
          setAftercare((draft) => draft ?? fresh.procedure.aftercare);
          setAttempt(null);
          setReviewed(false);
          setPhase('edit');
        }
        setContext(fresh);
      } catch {
        if (current())
          setError(
            'The current procedure completion details could not be verified. Please try again.',
          );
      } finally {
        if (current()) setLoading(false);
      }
    },
    [capture, basePath, patientId, procedureId, doctorId],
  );

  useEffect(() => {
    if (!openedPending.current) void load();
    return () => {
      version.current++;
    };
  }, [load]);
  useLayoutEffect(() => {
    if (previousPhase.current !== phase) heading.current?.focus();
    previousPhase.current = phase;
  }, [phase]);

  function close() {
    dismissed.current = true;
    onClose(refreshOnClose.current);
  }

  function review(event: FormEvent) {
    event.preventDefault();
    const agreement = context?.procedure.agreements.at(-1);
    if (
      phase !== 'edit' ||
      !context?.allowed ||
      agreement?.decision !== 'agreed' ||
      !aftercare?.trim() ||
      !outcome.trim() ||
      loading ||
      pending.has(procedureId) ||
      (actor.role !== 'doctor' && actor.role !== 'admin')
    )
      return;
    setAttempt({
      command: {
        requestId: crypto.randomUUID(),
        patientId,
        procedureId,
        doctorId,
        recordedByRole: actor.role,
        expectedRevision: context.revision,
        expectedDecisionId: agreement.id,
        outcome: outcome.trim(),
        aftercare: aftercare.trim(),
        reviewedConfirmed: true,
      },
      patientName,
      procedureTitle: context.procedure.title,
      doctorName: context.doctorName,
      agreement,
      appointment: context.procedure.scheduledAppointment ?? null,
    });
    setReviewed(false);
    setPhase('review');
  }

  async function submit() {
    if (
      !attempt ||
      dismissed.current ||
      sending.current ||
      (phase === 'pending'
        ? pending.get(procedureId) !== attempt
        : phase !== 'review' || !reviewed || pending.has(procedureId))
    )
      return;
    const origin = capture();
    const current = () => origin() && !dismissed.current && pending.get(procedureId) === attempt;
    sending.current = true;
    refreshOnClose.current = true;
    pending.set(procedureId, attempt);
    setBusy(true);
    setError('');
    setPhase('pending');
    try {
      const value = await api<unknown>(basePath + '/completions', {
        method: 'POST',
        body: attempt.command,
        isCurrent: current,
      });
      if (!current()) return;
      const completion = confirmedCompletion(value, attempt, actor.id);
      if (completion) {
        pending.delete(procedureId);
        setSaved(completion);
        setPhase('saved');
      }
    } catch (problem) {
      if (!current()) return;
      const refusal = completionRefusal(problem, attempt.command, actor.id);
      if (refusal) {
        pending.delete(procedureId);
        knownConflict.current = { agreement: attempt.agreement, observed: refusal.observed };
        setRefusal(refusal.message);
        setReviewed(false);
        setPhase('rejected');
      }
    } finally {
      if (origin() && !dismissed.current) {
        sending.current = false;
        setBusy(false);
      }
    }
  }

  const procedure = context?.procedure;
  const showContext =
    (phase === 'edit' && !loading && !error && !!procedure) || phase === 'current';
  const showReview = !!attempt && ['review', 'pending', 'rejected'].includes(phase);
  const agreement = showReview ? attempt?.agreement : procedure?.agreements.at(-1);
  const appointment = showReview ? attempt?.appointment : procedure?.scheduledAppointment;
  return (
    <Modal title={titles[phase]} onClose={close}>
      <div className="stack procedure-completion-form" tabIndex={-1} ref={heading}>
        <p className="muted">
          {attempt?.patientName ?? patientName} · {attempt?.procedureTitle ?? procedure?.title}
        </p>
        {phase === 'edit' &&
          (loading ? (
            <Loading />
          ) : error ? (
            <ErrorState message={error} retry={() => load()} />
          ) : null)}
        {(showContext || showReview) && (
          <>
            {phase !== 'current' && (
              <p>Performing clinician · {showReview ? attempt?.doctorName : context?.doctorName}</p>
            )}
            <section>
              <h3>Latest recorded choice{showReview ? ' at review' : ''}</h3>
              {agreement ? (
                <DecisionEntry agreement={agreement} />
              ) : (
                <p>No patient decision has been recorded yet.</p>
              )}
            </section>
            <ProcedureVisit
              appointment={appointment}
              linked={showReview ? !!attempt?.appointment : !!procedure?.effectiveAppointmentId}
              patientView={false}
            />
          </>
        )}
        {phase === 'edit' &&
          showContext &&
          context &&
          (context.allowed ? (
            <form className="stack" onSubmit={review}>
              <Field label="Procedure outcome and notes">
                <textarea
                  rows={5}
                  maxLength={8000}
                  required
                  value={outcome}
                  onChange={(e) => setOutcome(e.target.value)}
                />
              </Field>
              <Field label="Final aftercare instructions">
                <textarea
                  rows={4}
                  maxLength={8000}
                  required
                  value={aftercare ?? ''}
                  onChange={(e) => setAftercare(e.target.value)}
                />
              </Field>
              <div className="form-actions">
                <button type="button" className="button button-secondary" onClick={close}>
                  Cancel
                </button>
                <button
                  className="button button-primary"
                  disabled={!outcome.trim() || !aftercare?.trim()}
                >
                  Review completion
                </button>
              </div>
            </form>
          ) : (
            <>
              <p className="notice" role="status">
                {context.blockedReason}
              </p>
              {knownConflict.current && outcome && aftercare && (
                <section aria-label="Your unrecorded draft">
                  <h3>Your unrecorded draft</h3>
                  <p className="pre-line">
                    <strong>Outcome</strong> · {outcome}
                  </p>
                  <p className="pre-line">
                    <strong>Aftercare</strong> · {aftercare}
                  </p>
                </section>
              )}
              {procedure?.completion && (
                <section>
                  <h3>Recorded completion</h3>
                  <SavedCompletion completion={procedure.completion} />
                </section>
              )}
              {procedure?.cancellationReason && (
                <p>Cancellation reason · {procedure.cancellationReason}</p>
              )}
              <div className="form-actions">
                <button className="button button-secondary" onClick={close}>
                  Close
                </button>
                {procedure?.status === 'planned' && (
                  <button className="button button-primary" onClick={() => void load()}>
                    Refresh procedure
                  </button>
                )}
              </div>
            </>
          ))}
        {showReview && attempt && (
          <CompletionNotes
            outcome={attempt.command.outcome}
            aftercare={attempt.command.aftercare}
          />
        )}
        {phase === 'review' && (
          <>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={reviewed}
                onChange={(e) => setReviewed(e.target.checked)}
              />
              <span>
                I reviewed the patient’s agreement, linked visit, outcome and aftercare and am ready
                to record completion.
              </span>
            </label>
            <div className="form-actions">
              <button
                className="button button-secondary"
                onClick={() => {
                  setAttempt(null);
                  setReviewed(false);
                  setPhase('edit');
                }}
              >
                Edit completion
              </button>
              <button
                className="button button-primary"
                disabled={!reviewed}
                onClick={() => void submit()}
              >
                Save procedure completion
              </button>
            </div>
          </>
        )}
        {phase === 'pending' && (
          <>
            <p className="notice" role="status">
              {busy
                ? 'Confirming procedure completion…'
                : 'The outcome is uncertain. Retry the exact completion to recover the original record.'}
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
                Retry exact completion
              </button>
            </div>
          </>
        )}
        {phase === 'rejected' && (
          <>
            <p className="notice" role="status">
              {refusal}
            </p>
            <p>
              Refresh the procedure and review its current agreement and visit before submitting
              this draft again.
            </p>
            <div className="form-actions">
              <button className="button button-secondary" onClick={close}>
                Close
              </button>
              <button
                className="button button-primary"
                disabled={loading}
                onClick={() => void load()}
              >
                Refresh procedure
              </button>
            </div>
          </>
        )}
        {phase === 'saved' && saved && attempt && (
          <>
            <h3>Original confirmation</h3>
            <SavedCompletion completion={saved} />
            <div className="form-actions">
              <button className="button button-secondary" onClick={close}>
                Done
              </button>
              <button
                className="button button-primary"
                disabled={loading}
                onClick={() => void load({ attempt, saved })}
              >
                View current procedure
              </button>
            </div>
          </>
        )}
        {phase === 'current' && procedure?.completion && (
          <>
            <p>Procedure status · {procedure.status}</p>
            <SavedCompletion completion={procedure.completion} />
            <div className="form-actions">
              <button className="button button-secondary" onClick={() => setPhase('saved')}>
                Back to confirmation
              </button>
              <button className="button button-primary" onClick={close}>
                Close
              </button>
            </div>
          </>
        )}
        {phase !== 'edit' && error && (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
