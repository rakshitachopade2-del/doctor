import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { useLocation } from 'react-router-dom';
import type { ProcedureAgreement, ProcedureRecord } from '../../shared/clinical';
import { api, useSession } from '../lib';
import { useAppointmentBookingGuard } from './appointment-booking-helpers';
import { usePendingCareSubmissions } from './pending-care-submissions';
import { CurrentProcedureVisit, ProcedureDetails } from './PatientProcedureInformation';
import { ErrorState, Field, Loading, Modal } from './ui';
import {
  checkedDecisionProcedure,
  confirmedDecision,
  decisionChoice,
  decisionMethods,
  decisionRejection,
  requireDecisionHistory,
  type DecisionAttempt,
} from './procedure-decision-helpers';
import './procedure-decision.css';

export function useProcedureDecisionRecording(
  patientId: string,
  patientName: string,
  onChange: () => void,
) {
  const { session } = useSession(),
    location = useLocation(),
    capture = useAppointmentBookingGuard();
  const { procedureDecisions: pending } = usePendingCareSubmissions();
  const [selected, setSelected] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const user = session.user;
  const canRecord =
    user?.role === 'patient'
      ? user.patientId === patientId
      : !!user?.doctorId && (user.role === 'doctor' || user.role === 'admin');
  useLayoutEffect(
    () => setSelected(null),
    [
      patientId,
      user?.id,
      user?.role,
      user?.patientId,
      user?.doctorId,
      session.csrfToken,
      location.key,
    ],
  );
  const attempts = [...pending.values()].filter(
    (a) =>
      canRecord && a.command.patientId === patientId && a.command.recordedByRole === user?.role,
  );
  function open(id: string) {
    if (!canRecord) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSelected(id);
  }
  function close(refresh: boolean) {
    const current = capture(),
      previous = opener.current;
    setSelected(null);
    if (refresh) onChange();
    requestAnimationFrame(() => {
      if (!current()) return;
      if (previous?.isConnected) previous.focus();
      else {
        const trigger =
          selected &&
          document.querySelector<HTMLElement>(
            '[data-procedure-decision="' + CSS.escape(selected) + '"]',
          );
        (
          trigger || document.querySelector<HTMLElement>('[data-procedure-decisions-heading]')
        )?.focus();
      }
    });
  }
  const controls = (
    <Fragment key="procedure-decision-recording">
      {!selected &&
        attempts.map((a) => (
          <div className="notice decision-resume" key={a.command.procedureId}>
            <p>{a.procedureTitle} · Decision awaiting confirmation</p>
            <button
              className="button button-secondary"
              data-procedure-decision={a.command.procedureId}
              onClick={() => open(a.command.procedureId)}
            >
              Resume procedure decision
            </button>
          </div>
        ))}
      {selected && canRecord && (
        <ProcedureDecisionModal
          key={JSON.stringify([
            patientId,
            selected,
            user?.id,
            user?.role,
            user?.doctorId,
            user?.patientId,
            session.csrfToken,
            location.key,
          ])}
          patientId={patientId}
          patientName={patientName}
          procedureId={selected}
          onClose={close}
        />
      )}
    </Fragment>
  );
  return {
    controls,
    open,
    hasPending: (id: string) => attempts.some((a) => a.command.procedureId === id),
  };
}

const titles = {
  edit: '',
  review: 'Confirm procedure decision',
  pending: 'Decision awaiting confirmation',
  saved: 'Decision recorded',
  rejected: 'Decision not recorded',
  current: 'Current procedure',
};
function DecisionEntry({ agreement }: { agreement: ProcedureAgreement }) {
  return (
    <div className="decision-entry">
      <strong>{decisionChoice(agreement.decision)}</strong>
      <p>
        Recorded by {agreement.recordedByName} · {agreement.recordedByRole} ·{' '}
        {decisionMethods[agreement.method]}
      </p>
      <time dateTime={agreement.createdAt}>
        {new Date(agreement.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
      </time>
      {agreement.note && <p className="pre-line">{agreement.note}</p>}
    </div>
  );
}

function ProcedureDecisionModal({
  patientId,
  patientName,
  procedureId,
  onClose,
}: {
  patientId: string;
  patientName: string;
  procedureId: string;
  onClose: (refresh: boolean) => void;
}) {
  const { session } = useSession(),
    actor = session.user!,
    isPatient = actor.role === 'patient';
  const { procedureDecisions: pending } = usePendingCareSubmissions();
  const stored = pending.get(procedureId);
  const initial =
    stored?.command.patientId === patientId && stored.command.recordedByRole === actor.role
      ? stored
      : null;
  const [phase, setPhase] = useState<keyof typeof titles>(initial ? 'pending' : 'edit');
  const [plan, setPlan] = useState<ProcedureRecord | null>(null);
  const [attempt, setAttempt] = useState<DecisionAttempt | null>(initial);
  const [saved, setSaved] = useState<ProcedureAgreement | null>(null);
  const [decision, setDecision] = useState<ProcedureAgreement['decision'] | ''>(
    initial?.command.decision ?? '',
  );
  const [method, setMethod] = useState<ProcedureAgreement['method']>(
    initial?.command.method ?? (isPatient ? 'portal' : 'in-person'),
  );
  const [note, setNote] = useState(initial?.command.note ?? '');
  const [attested, setAttested] = useState(false),
    [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(!initial);
  const [error, setError] = useState(''),
    [refusal, setRefusal] = useState('');
  const capture = useAppointmentBookingGuard(),
    version = useRef(0),
    dismissed = useRef(false),
    sending = useRef(false);
  const openedPending = useRef(!!initial),
    refreshOnClose = useRef(!!initial);
  const heading = useRef<HTMLDivElement>(null);
  const load = useCallback(
    async (
      mode: 'edit' | 'current',
      original?: { attempt: DecisionAttempt; saved?: ProcedureAgreement },
    ) => {
      const origin = capture(),
        serial = ++version.current;
      const current = () => origin() && !dismissed.current && version.current === serial;
      setLoading(true);
      setError('');
      try {
        const value = await api<unknown>(
          '/api/patients/' + encodeURIComponent(patientId) + '/clinical-workflows',
          { isCurrent: current },
        );
        if (!current()) return;
        const procedure = checkedDecisionProcedure(value, patientId, procedureId);
        if (original) requireDecisionHistory(procedure, original.attempt, original.saved);
        setPlan(procedure);
        if (mode === 'edit') {
          setAttempt(null);
          setReviewed(false);
          setAttested(false);
        }
        setPhase(mode);
      } catch {
        if (current()) setError('The current procedure could not be verified. Please try again.');
      } finally {
        if (current()) setLoading(false);
      }
    },
    [capture, patientId, procedureId],
  );
  useEffect(() => {
    if (!openedPending.current) void load('edit');
    return () => {
      version.current++;
    };
  }, [load]);
  const previousPhase = useRef(phase);
  useLayoutEffect(() => {
    if (previousPhase.current !== phase) heading.current?.focus();
    previousPhase.current = phase;
  }, [phase]);

  function close() {
    dismissed.current = true;
    onClose(refreshOnClose.current);
  }
  const valid =
    plan?.status === 'planned' && !!decision && (isPatient || (attested && !!note.trim()));
  function review(event: FormEvent) {
    event.preventDefault();
    if (
      !plan ||
      !decision ||
      !valid ||
      phase !== 'edit' ||
      loading ||
      sending.current ||
      pending.has(procedureId) ||
      actor.role === 'receptionist' ||
      (!isPatient && !actor.doctorId)
    )
      return;
    const previous = plan.agreements.at(-1) ?? null;
    setAttempt({
      patientName,
      procedureTitle: plan.title,
      actorName: actor.name,
      previous,
      priorIds: plan.agreements.map((a) => a.id),
      command: {
        requestId: crypto.randomUUID(),
        patientId,
        procedureId,
        recordedByRole: actor.role,
        expectedLatestDecisionId: previous?.id ?? null,
        decision,
        method,
        note: note.trim(),
        patientDecisionConfirmed: !isPatient && attested,
        reviewedConfirmed: true,
      },
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
      const value = await api<unknown>(
        '/api/procedures/' + encodeURIComponent(procedureId) + '/agreements/record',
        { method: 'POST', body: attempt.command, isCurrent: current },
      );
      if (!current()) return;
      const agreement = confirmedDecision(value, attempt, actor.id);
      if (agreement) {
        pending.delete(procedureId);
        setSaved(agreement);
        setPhase('saved');
      }
    } catch (problem) {
      if (!current()) return;
      const message = decisionRejection(problem, attempt.command, actor.id);
      if (message) {
        pending.delete(procedureId);
        setAttested(false);
        setReviewed(false);
        setRefusal(message);
        setPhase('rejected');
      }
    } finally {
      if (origin() && !dismissed.current) {
        sending.current = false;
        setBusy(false);
      }
    }
  }
  const title =
    phase === 'edit'
      ? isPatient
        ? 'Review your procedure decision'
        : 'Record the patient’s decision'
      : titles[phase];
  const latest = plan?.agreements.at(-1),
    previous = phase === 'edit' ? latest : attempt?.previous;
  return (
    <Modal title={title} onClose={close}>
      <div className="stack procedure-decision-form" tabIndex={-1} ref={heading}>
        <p className="muted">
          {attempt?.patientName ?? patientName} · {attempt?.procedureTitle ?? plan?.title}
        </p>
        {phase === 'edit' &&
          (loading ? (
            <Loading />
          ) : error ? (
            <ErrorState message={error} retry={() => load('edit')} />
          ) : (
            plan && (
              <>
                {isPatient && (
                  <>
                    <p>
                      Review the plan your clinician shared. Contact the clinic if you have
                      questions before making a choice.
                    </p>
                    <CurrentProcedureVisit procedure={plan} />
                  </>
                )}
                <ProcedureDetails procedure={plan} />
              </>
            )
          ))}
        {((phase === 'edit' && plan && !loading && !error) || phase === 'review') && (
          <section>
            <h3>Latest recorded choice</h3>
            {previous ? (
              <DecisionEntry agreement={previous} />
            ) : (
              <p>No patient decision has been recorded yet.</p>
            )}
          </section>
        )}
        {phase === 'edit' &&
          plan &&
          !loading &&
          !error &&
          (plan.status !== 'planned' ? (
            <>
              <p className="notice" role="status">
                This procedure is {plan.status}. Its decision history is closed.
              </p>
              <button className="button button-secondary" onClick={close}>
                Close
              </button>
            </>
          ) : (
            <form className="stack" onSubmit={review}>
              <Field label={isPatient ? 'Your decision' : 'Patient decision'}>
                <select
                  required
                  value={decision}
                  onChange={(e) => {
                    setDecision(e.target.value as typeof decision);
                    setAttested(false);
                  }}
                >
                  <option value="">Choose a decision</option>
                  <option value="agreed">
                    {isPatient ? 'I agree to the proposed procedure' : 'Agreed to the plan'}
                  </option>
                  <option value="declined">
                    {isPatient ? 'I decline the proposed procedure' : 'Declined the plan'}
                  </option>
                </select>
              </Field>
              {!isPatient && (
                <Field label="Discussion method">
                  <select
                    value={method}
                    onChange={(e) => {
                      setMethod(e.target.value as typeof method);
                      setAttested(false);
                    }}
                  >
                    <option value="in-person">In person</option>
                    <option value="phone">By phone</option>
                  </select>
                </Field>
              )}
              <Field
                label={isPatient ? 'Note for your clinic' : 'Discussion and decision notes'}
                hint={
                  isPatient ? 'Optional. Include questions or context for your choice.' : undefined
                }
              >
                <textarea
                  rows={4}
                  maxLength={8000}
                  required={!isPatient}
                  value={note}
                  onChange={(e) => {
                    setNote(e.target.value);
                    setAttested(false);
                  }}
                />
              </Field>
              {!isPatient && (
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={attested}
                    onChange={(e) => setAttested(e.target.checked)}
                  />
                  <span>
                    I confirm that this records the patient’s actual communicated decision,
                    including their opportunity to ask questions.
                  </span>
                </label>
              )}
              <p className="muted small">
                This records a choice for the clinic. Follow the clinic’s procedure-specific consent
                process.
              </p>
              <div className="form-actions">
                <button className="button button-secondary" type="button" onClick={close}>
                  {isPatient ? 'Decide later' : 'Cancel'}
                </button>
                <button className="button button-primary" disabled={!valid}>
                  Review decision
                </button>
              </div>
            </form>
          ))}
        {(phase === 'review' || phase === 'pending' || phase === 'rejected') && attempt && (
          <section>
            <h3>{phase === 'rejected' ? 'Reviewed decision' : 'Decision to record'}</h3>
            <strong>{decisionChoice(attempt.command.decision)}</strong>
            <p>
              {attempt.actorName} · {attempt.command.recordedByRole} ·{' '}
              {decisionMethods[attempt.command.method]}
            </p>
            <p className="pre-line">{attempt.command.note || 'No note entered.'}</p>
          </section>
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
                {isPatient
                  ? 'I reviewed this choice and want to record it for my clinic.'
                  : 'I reviewed this decision, discussion method and note for the patient record.'}
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
                Edit decision
              </button>
              <button
                className="button button-primary"
                disabled={!reviewed}
                onClick={() => void submit()}
              >
                {isPatient ? 'Record my decision' : 'Save patient decision'}
              </button>
            </div>
          </>
        )}
        {phase === 'pending' && (
          <>
            <p className="notice" role="status">
              {busy
                ? 'Confirming the decision…'
                : 'The outcome is uncertain. Retry the exact decision to recover its original confirmation.'}
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
                Retry exact decision
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
              Refresh the procedure to review the latest recorded choice before submitting your
              draft again.
            </p>
            <div className="form-actions">
              <button className="button button-secondary" onClick={close}>
                Close
              </button>
              <button
                className="button button-primary"
                disabled={loading}
                onClick={() => attempt && void load('edit', { attempt })}
              >
                Refresh procedure
              </button>
            </div>
          </>
        )}
        {phase === 'saved' && saved && attempt && (
          <>
            <section>
              <h3>Original confirmation</h3>
              <DecisionEntry agreement={saved} />
            </section>
            <p>Open the current procedure to see any decisions recorded since this entry.</p>
            <div className="form-actions">
              <button className="button button-secondary" onClick={close}>
                Done
              </button>
              <button
                className="button button-primary"
                disabled={loading}
                onClick={() => void load('current', { saved, attempt })}
              >
                View current procedure
              </button>
            </div>
          </>
        )}
        {phase === 'current' && plan && latest && (
          <>
            <p>Procedure status · {plan.status}</p>
            <section>
              <h3>Latest recorded choice</h3>
              <DecisionEntry agreement={latest} />
            </section>
            {plan.agreements.length > 1 && (
              <section>
                <h3>Previous recorded choices</h3>
                <ol className="decision-history">
                  {plan.agreements.slice(0, -1).map((a) => (
                    <li key={a.id}>
                      <DecisionEntry agreement={a} />
                    </li>
                  ))}
                </ol>
              </section>
            )}
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
