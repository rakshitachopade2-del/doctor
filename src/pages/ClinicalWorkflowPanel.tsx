import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  ClipboardCheck,
  CalendarDays,
  FileCheck2,
  FilePlus2,
  FileText,
  History,
  ListChecks,
  MessageSquareText,
  Plus,
  Send,
  ShieldCheck,
  Stethoscope,
  X,
} from 'lucide-react';
import type { Appointment } from '../../shared/types';
import type {
  EncounterAmendment,
  Investigation,
  InvestigationResult,
  PatientClinicalWorkflows,
  ProcedureRecord,
} from '../../shared/clinical';
import { api, formatDate, useSession, useToast } from '../lib';
import { Badge, Card, EmptyState, ErrorState, Field, Loading, Modal } from '../components/ui';
import { useInvestigationCancellation } from '../components/InvestigationCancellationModal';
import { useInvestigationOrder } from '../components/InvestigationOrderModal';
import { useInvestigationResultSubmission } from '../components/InvestigationResultModal';
import { usePatientDocuments } from '../components/private-upload-helpers';
import { InvestigationReviewModal } from '../components/InvestigationReviewModal';
import { ProcedureAppointmentModal } from '../components/ProcedureAppointmentModal';
import { useProcedureCompletionRecording } from '../components/ProcedureCompletionModal';
import { useProcedureDecisionRecording } from '../components/ProcedureDecisionModal';
import { decisionMethods } from '../components/procedure-decision-helpers';
import { ProcedurePlanModal } from '../components/ProcedurePlanModal';
import { ProcedureTemplateSource } from '../components/ProcedureTemplateSource';
import './clinical-workflows.css';

type ClinicalResource = {
  data: PatientClinicalWorkflows | null;
  loading: boolean;
  error: string;
  reload: () => Promise<void>;
};
type WorkflowAction =
  | { kind: 'procedure' }
  | { kind: 'review'; investigation: Investigation; result: InvestigationResult }
  | {
      kind: 'cancel-procedure' | 'scheduling';
      procedure: ProcedureRecord;
    };
const failure = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Please try again.';
const timestamp = (value: string) =>
  new Date(value).toLocaleString('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  });
const statusText = {
  ordered: 'Awaiting result',
  'result-received': 'Awaiting review',
  reviewed: 'Reviewed',
  cancelled: 'Cancelled',
  planned: 'Planned',
  completed: 'Completed',
};
function Detail({ label, value }: { label: string; value?: string | null }) {
  return value ? (
    <div className="cw-detail">
      <span>{label}</span>
      <p>{value}</p>
    </div>
  ) : null;
}
function FormFooter({
  busy,
  label,
  onClose,
}: {
  busy: boolean;
  label: string;
  onClose: () => void;
}) {
  return (
    <div className="cw-form-footer">
      <button type="button" className="button button-secondary" onClick={onClose}>
        Cancel
      </button>
      <button className="button button-primary" disabled={busy}>
        {busy ? 'Saving…' : label}
      </button>
    </div>
  );
}

export function ClinicalWorkflowPanel({
  patientId,
  patientName,
  appointments,
  resource,
  selectedInvestigationId,
  selectedResultId,
}: {
  patientId: string;
  patientName: string;
  appointments: Appointment[];
  resource: ClinicalResource;
  selectedInvestigationId?: string | null;
  selectedResultId?: string | null;
}) {
  const { session } = useSession();
  const cancellations = useInvestigationCancellation(patientId, resource.reload);
  const order = useInvestigationOrder(
    patientId,
    patientName,
    resource.data?.investigations ?? [],
    resource.reload,
  );
  const canDocument = !!session.user?.doctorId && ['doctor', 'admin'].includes(session.user.role);
  const documents = usePatientDocuments(patientId);
  const resultSubmission = useInvestigationResultSubmission(patientId, patientName, () => {
    void resource.reload();
    void documents.reload();
  });
  const completions = useProcedureCompletionRecording(patientId, patientName, resource.reload);
  const decisions = useProcedureDecisionRecording(patientId, patientName, resource.reload);
  const [action, setAction] = useState<WorkflowAction | null>(null);
  const [busy, setBusy] = useState('');
  const [filter, setFilter] = useState('active');
  const toast = useToast();
  const data = resource.data;
  const mounted = useRef(false);
  const publishing = useRef(false);
  const focusedTarget = useRef('');
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const selectedInvestigation = data?.investigations.find(
    (entry) => entry.id === selectedInvestigationId,
  );
  const selectedResult = selectedInvestigation?.results.find(
    (entry) => entry.id === selectedResultId,
  );
  useEffect(() => {
    if (!selectedInvestigationId) {
      focusedTarget.current = '';
      return;
    }
    if (resource.loading || resource.error || !selectedInvestigation) return;
    const key = `${patientId}:${selectedInvestigationId}:${selectedResultId ?? ''}`;
    if (focusedTarget.current === key) return;
    const frame = requestAnimationFrame(() => {
      const element = document.getElementById(
        selectedResult
          ? `investigation-result-${selectedResult.id}`
          : `investigation-${selectedInvestigationId}`,
      );
      if (!element) return;
      element.focus({ preventScroll: true });
      element.scrollIntoView({ block: 'start' });
      focusedTarget.current = key;
    });
    return () => cancelAnimationFrame(frame);
  }, [
    patientId,
    selectedInvestigationId,
    selectedResultId,
    selectedInvestigation,
    selectedResult,
    resource.loading,
    resource.error,
  ]);
  async function publish(investigationId: string, reviewId: string) {
    if (publishing.current) return;
    const originalReview = data?.investigations
      .find((entry) => entry.id === investigationId)
      ?.reviews.find((review) => review.id === reviewId);
    if (!originalReview) return;
    publishing.current = true;
    setBusy(reviewId);
    try {
      const saved = await api<Investigation>(
        `/api/investigations/${investigationId}/reviews/${reviewId}/publish`,
        {
          method: 'POST',
        },
      );
      if (
        saved?.id !== investigationId ||
        saved.patientId !== patientId ||
        !Array.isArray(saved.reviews) ||
        !saved.reviews.some(
          (review) =>
            review?.id === reviewId &&
            review.resultId === originalReview.resultId &&
            review.summary === originalReview.summary &&
            review.followUp === originalReview.followUp &&
            typeof review.publishedAt === 'string' &&
            review.publishedAt.trim().length > 0 &&
            Number.isFinite(Date.parse(review.publishedAt)),
        )
      ) {
        throw new Error(
          'Publication could not be confirmed. Retry sharing this same review to check its status.',
        );
      }
      if (!mounted.current) return;
      await resource.reload();
      if (mounted.current) toast('Reviewed findings shared with the patient.');
    } catch (e) {
      if (mounted.current) toast(failure(e), 'error');
    } finally {
      publishing.current = false;
      if (mounted.current) setBusy('');
    }
  }
  const afterSave = async () => {
    if (!mounted.current) return;
    setAction(null);
    await Promise.all([resource.reload(), documents.reload()]);
  };
  if (resource.loading && !data)
    return (
      <div>
        {order.modal}
        {order.hasPending && order.button}
        {cancellations.controls}
        {resultSubmission.controls}
        {decisions.controls}
        {completions.controls}
        <Loading />
      </div>
    );
  if (resource.error)
    return (
      <div>
        {order.modal}
        {order.hasPending && order.button}
        {cancellations.controls}
        {resultSubmission.controls}
        {decisions.controls}
        {completions.controls}
        <ErrorState message={resource.error} retry={resource.reload} />
      </div>
    );
  if (!data)
    return (
      <>
        {order.modal}
        {order.hasPending && order.button}
        {cancellations.controls}
        {resultSubmission.controls}
        {decisions.controls}
        {completions.controls}
      </>
    );
  const investigations = data.investigations.filter(
    (i) => filter === 'all' || i.status !== 'cancelled' || i.id === selectedInvestigationId,
  );
  const procedures = data.procedures.filter((p) => filter === 'all' || p.status !== 'cancelled');
  return (
    <div className="cw-workspace">
      {order.modal}
      {cancellations.controls}
      {resultSubmission.controls}
      {decisions.controls}
      {completions.controls}
      <div className="cw-intro">
        <span className="cw-intro-icon">
          <Stethoscope size={24} />
        </span>
        <div>
          <h2>From question to documented care.</h2>
          <p>
            Track investigations, review findings, and keep procedure decisions connected to this
            patient.
          </p>
        </div>
        <div className="segmented cw-view-filter">
          {[
            ['active', 'Current'],
            ['all', 'All records'],
          ].map(([value, label]) => (
            <button
              key={value}
              className={filter === value ? 'active' : ''}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {!canDocument && (
        <div className="notice">
          <ShieldCheck size={18} />
          <span>
            Reading access is available. Link a doctor profile to this account to document clinical
            work.
          </span>
        </div>
      )}
      {selectedInvestigationId && !selectedInvestigation && (
        <div className="notice" role="status">
          The linked investigation is not available in this patient's record.
        </div>
      )}
      {selectedResultId && selectedInvestigation && !selectedResult && (
        <div className="notice" role="status">
          The linked result is not available on this investigation. The order and its available
          history are shown below.
        </div>
      )}
      {selectedResult && selectedResult.id !== selectedInvestigation?.results.at(-1)?.id && (
        <div className="notice" role="status">
          This link opens an earlier result. A newer submission is available; clinical reviews use
          the latest submission.
        </div>
      )}
      <section className="cw-section">
        <div className="cw-section-heading">
          <div>
            <span className="eyebrow">INVESTIGATIONS</span>
            <h2>
              Orders, results & clinical review{' '}
              <span className="cw-count">{investigations.length}</span>
            </h2>
          </div>
          <div className="cw-record-actions">
            <Link className="button button-secondary" to="/clinic/investigations">
              Investigation review queue
            </Link>
            {order.button}
          </div>
        </div>
        {investigations.length ? (
          <div className="cw-records">
            {investigations.map((investigation) => (
              <div
                key={investigation.id}
                id={`investigation-${investigation.id}`}
                tabIndex={-1}
                role="region"
                aria-labelledby={`investigation-title-${investigation.id}`}
                className={`cw-investigation-target ${investigation.id === selectedInvestigationId ? 'cw-selected-target' : ''}`}
              >
                <Card key={investigation.id} className="cw-investigation">
                  <div className="cw-record-heading">
                    <span className="cw-record-icon">
                      <FileCheck2 size={21} />
                    </span>
                    <div>
                      <h3 id={`investigation-title-${investigation.id}`}>{investigation.title}</h3>
                      <p>
                        {investigation.kind} · {investigation.doctorName} ·{' '}
                        {formatDate(investigation.createdAt)}
                      </p>
                    </div>
                    <Badge
                      tone={
                        investigation.status === 'reviewed'
                          ? 'green'
                          : investigation.status === 'cancelled'
                            ? 'neutral'
                            : investigation.status === 'result-received'
                              ? 'blue'
                              : 'amber'
                      }
                    >
                      {statusText[investigation.status]}
                    </Badge>
                  </div>
                  <Link
                    className="text-link"
                    to={`/clinic/investigations?investigation=${encodeURIComponent(investigation.id)}`}
                  >
                    Review responsibility and handover history
                  </Link>
                  <div className="grid-2">
                    <Detail label="Clinical question / reason" value={investigation.reason} />
                    <Detail
                      label="Instructions shared with patient"
                      value={investigation.instructions}
                    />
                  </div>
                  {investigation.dueDate && (
                    <p className="cw-due">Requested by {formatDate(investigation.dueDate)}</p>
                  )}
                  {investigation.cancellationReason && (
                    <div className="notice cw-block-notice">
                      <strong>Order cancelled</strong>
                      <p>{investigation.cancellationReason}</p>
                    </div>
                  )}
                  {investigation.results.length > 0 && (
                    <div className="cw-results">
                      <h4>Result history</h4>
                      {[...investigation.results]
                        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                        .map((result) => {
                          const reviews = investigation.reviews.filter(
                            (review) => review.resultId === result.id,
                          );
                          return (
                            <article
                              className={`cw-result ${result.id === selectedResultId ? 'cw-selected-target' : ''}`}
                              key={result.id}
                              id={`investigation-result-${result.id}`}
                              tabIndex={-1}
                            >
                              <div className="cw-history-meta">
                                <strong>Result submitted</strong>
                                <span>
                                  {result.submittedByName} · {timestamp(result.createdAt)} IST
                                </span>
                              </div>
                              <p className="cw-prose">{result.note}</p>
                              {result.documentIds.length > 0 && (
                                <div className="cw-attachments">
                                  {result.documentIds.map((documentId) => {
                                    const document = documents.data?.find(
                                      (d) => d.id === documentId,
                                    );
                                    return document ? (
                                      <a
                                        key={documentId}
                                        href={document.url}
                                        className="cw-document-link"
                                        download
                                      >
                                        <FileText size={15} />
                                        {document.title}
                                      </a>
                                    ) : (
                                      <span key={documentId} className="muted small">
                                        Linked report · {documentId.slice(0, 8)}
                                        {documents.error ? ' · Report list unavailable' : ''}
                                      </span>
                                    );
                                  })}
                                </div>
                              )}
                              {reviews.map((review) => (
                                <div className="cw-review" key={review.id}>
                                  <div className="cw-history-meta">
                                    <strong>
                                      <ClipboardCheck size={14} /> Clinician review
                                    </strong>
                                    <Badge tone={review.publishedAt ? 'green' : 'neutral'}>
                                      {review.publishedAt ? 'Shared with patient' : 'Clinic only'}
                                    </Badge>
                                  </div>
                                  <Detail label="Reviewed findings" value={review.summary} />
                                  <Detail label="Follow-up / next steps" value={review.followUp} />
                                  <p className="cw-attribution">
                                    {review.doctorName} · {timestamp(review.createdAt)} IST
                                  </p>
                                  {canDocument &&
                                    !review.publishedAt &&
                                    investigation.status !== 'cancelled' && (
                                      <button
                                        className="button button-secondary button-small"
                                        disabled={!!busy}
                                        onClick={() => publish(investigation.id, review.id)}
                                      >
                                        <Send size={13} />
                                        {busy === review.id
                                          ? 'Sharing…'
                                          : 'Share reviewed findings'}
                                      </button>
                                    )}
                                </div>
                              ))}
                              {canDocument &&
                                investigation.status !== 'cancelled' &&
                                result.id === investigation.results.at(-1)?.id && (
                                  <button
                                    className="button button-ghost button-small"
                                    onClick={() =>
                                      setAction({ kind: 'review', investigation, result })
                                    }
                                  >
                                    <ClipboardCheck size={14} />
                                    {reviews.length ? 'Add another review' : 'Review this result'}
                                  </button>
                                )}
                            </article>
                          );
                        })}
                    </div>
                  )}
                  {canDocument && investigation.status !== 'cancelled' && (
                    <div className="cw-record-actions">
                      {!resultSubmission.hasPending(investigation.id) && (
                        <button
                          className="button button-secondary button-small"
                          onClick={() => resultSubmission.open(investigation.id)}
                        >
                          <FilePlus2 size={15} /> Add result
                        </button>
                      )}
                      {investigation.status !== 'reviewed' &&
                        !cancellations.hasPending(investigation.id) && (
                          <button
                            className="button button-ghost button-small"
                            onClick={() => cancellations.open(investigation.id)}
                          >
                            Cancel order
                          </button>
                        )}
                    </div>
                  )}
                </Card>
              </div>
            ))}
          </div>
        ) : (
          <Card>
            <EmptyState
              title="A clear path to the next answer"
              description="Record an investigation, attach the results, and share your reviewed findings when ready."
            />
          </Card>
        )}
      </section>
      <section className="cw-section">
        <div className="cw-section-heading">
          <div>
            <span className="eyebrow">PROCEDURES</span>
            <h2 tabIndex={-1} data-procedure-decisions-heading>
              A plan, a decision, a documented outcome{' '}
              <span className="cw-count">{procedures.length}</span>
            </h2>
          </div>
          {canDocument && (
            <button
              className="button button-primary"
              onClick={() => setAction({ kind: 'procedure' })}
            >
              <Plus size={16} /> Plan procedure
            </button>
          )}
        </div>
        {procedures.length ? (
          <div className="cw-records">
            {procedures.map((procedure) => {
              const agreements = procedure.agreements;
              const latest = agreements.at(-1);
              const effectiveAppointmentId =
                procedure.effectiveAppointmentId === undefined
                  ? procedure.appointmentId
                  : procedure.effectiveAppointmentId;
              const linkedAppointment =
                procedure.scheduledAppointment === undefined
                  ? (appointments.find((entry) => entry.id === effectiveAppointmentId) ?? null)
                  : procedure.scheduledAppointment;
              return (
                <Card key={procedure.id} className="cw-procedure">
                  <div className="cw-record-heading">
                    <span className="cw-record-icon">
                      <ListChecks size={21} />
                    </span>
                    <div>
                      <h3>{procedure.title}</h3>
                      <p>
                        {procedure.doctorName} · Planned {formatDate(procedure.createdAt)}
                      </p>
                    </div>
                    <Badge
                      tone={
                        procedure.status === 'completed'
                          ? 'green'
                          : procedure.status === 'cancelled'
                            ? 'neutral'
                            : 'blue'
                      }
                    >
                      {statusText[procedure.status]}
                    </Badge>
                  </div>
                  <ProcedureTemplateSource source={procedure.templateSource} />
                  {linkedAppointment ? (
                    <div className="cw-detail">
                      <span>Current linked appointment</span>
                      <p>
                        <Link
                          to={`/clinic/appointments?date=${linkedAppointment.date}&patientId=${encodeURIComponent(patientId)}`}
                        >
                          {formatDate(linkedAppointment.date)} · {linkedAppointment.time} IST ·{' '}
                          {linkedAppointment.durationMinutes ?? 30} minutes
                        </Link>{' '}
                        · {linkedAppointment.doctorName} ·{' '}
                        {linkedAppointment.status.replaceAll('-', ' ')}
                        {linkedAppointment.durationPolicy === 'custom' ? ' · Custom length' : ''}
                      </p>
                    </div>
                  ) : (
                    <Detail
                      label="Current linked appointment"
                      value={
                        effectiveAppointmentId
                          ? 'The linked appointment is unavailable. Review scheduling history.'
                          : 'No appointment is currently linked.'
                      }
                    />
                  )}
                  <div className="grid-2">
                    <Detail label="Indication" value={procedure.indication} />
                    <Detail label="Expected benefits" value={procedure.benefits} />
                    <Detail label="Risks discussed" value={procedure.risks} />
                    <Detail label="Alternatives discussed" value={procedure.alternatives} />
                  </div>
                  <Detail label="Planned aftercare" value={procedure.aftercare} />
                  <div className="cw-procedure-cost">
                    <span>Estimated cost</span>
                    <strong>{procedure.estimatedCost || 'Not recorded'}</strong>
                  </div>
                  <div className="cw-record-actions">
                    <button
                      className="button button-secondary button-small"
                      onClick={() => setAction({ kind: 'scheduling', procedure })}
                    >
                      <CalendarDays size={14} />
                      {procedure.status === 'planned' ? 'Manage appointment' : 'Scheduling history'}
                    </button>
                    <Link
                      className="button button-secondary button-small"
                      to={`/clinic/billing?procedure=${procedure.id}`}
                    >
                      <FileText size={14} />
                      Procedure billing
                    </Link>
                  </div>
                  <div className="cw-decisions">
                    <h4>Patient decision record</h4>
                    {agreements.length ? (
                      agreements.map((agreement) => (
                        <div className="cw-decision" key={agreement.id}>
                          <Badge tone={agreement.decision === 'agreed' ? 'green' : 'amber'}>
                            {agreement.decision === 'agreed' ? 'Agreed' : 'Declined'}
                          </Badge>
                          <div>
                            <p>
                              {agreement.note ||
                                'Patient submitted their decision through the portal.'}
                            </p>
                            <small>
                              {agreement.id === latest?.id && <>Latest recorded choice · </>}
                              {agreement.recordedByName} · {agreement.recordedByRole} ·{' '}
                              {decisionMethods[agreement.method]} · {timestamp(agreement.createdAt)}{' '}
                              IST
                            </small>
                          </div>
                        </div>
                      ))
                    ) : (
                      <p className="muted small">No patient decision has been recorded yet.</p>
                    )}
                    <p className="cw-explanation">
                      This records a communication and decision. It is not an electronic signature
                      or a substitute for any required procedure-specific consent process.
                    </p>
                  </div>
                  {procedure.completion && (
                    <div className="cw-completion">
                      <h4>
                        <CheckIcon /> Procedure documented as complete
                      </h4>
                      <Detail
                        label="Outcome / procedure notes"
                        value={procedure.completion.outcome}
                      />
                      <Detail
                        label="Final aftercare instructions"
                        value={procedure.completion.aftercare}
                      />
                      {procedure.completion.appointment !== undefined && (
                        <Detail
                          label="Appointment recorded at completion"
                          value={
                            procedure.completion.appointment
                              ? `${formatDate(procedure.completion.appointment.date)} · ${procedure.completion.appointment.time} IST · ${procedure.completion.appointment.durationMinutes} minutes · ${procedure.completion.appointment.doctorName} · ${procedure.completion.appointment.status.replaceAll('-', ' ')}`
                              : 'No appointment was linked when completion was recorded.'
                          }
                        />
                      )}
                      <p className="cw-attribution">
                        {procedure.completion.doctorName} ·{' '}
                        {timestamp(procedure.completion.completedAt)} IST
                      </p>
                    </div>
                  )}
                  {procedure.cancellationReason && (
                    <div className="notice cw-block-notice">
                      <strong>Procedure cancelled</strong>
                      <p>{procedure.cancellationReason}</p>
                    </div>
                  )}
                  {canDocument && procedure.status === 'planned' && (
                    <>
                      <div className="cw-record-actions">
                        {!decisions.hasPending(procedure.id) && (
                          <button
                            data-procedure-decision={procedure.id}
                            className="button button-secondary button-small"
                            onClick={() => decisions.open(procedure.id)}
                          >
                            <MessageSquareText size={14} /> Record patient decision
                          </button>
                        )}
                        {!completions.hasPending(procedure.id) && (
                          <button
                            data-procedure-completion={procedure.id}
                            className="button button-primary button-small"
                            disabled={latest?.decision !== 'agreed'}
                            onClick={() => completions.open(procedure.id)}
                          >
                            Document completion
                          </button>
                        )}
                        <button
                          className="button button-ghost button-small"
                          onClick={() => setAction({ kind: 'cancel-procedure', procedure })}
                        >
                          Cancel procedure
                        </button>
                      </div>
                      {latest?.decision !== 'agreed' && (
                        <p className="cw-explanation">
                          Completion requires the most recent recorded patient decision to be
                          agreement.
                        </p>
                      )}
                    </>
                  )}
                </Card>
              );
            })}
          </div>
        ) : (
          <Card>
            <EmptyState
              title="Document the whole procedure journey"
              description="Capture the proposed plan, the patient’s decision, and the clinician-entered outcome together."
            />
          </Card>
        )}
      </section>
      {action?.kind === 'review' && (
        <InvestigationReviewModal
          investigationId={action.investigation.id}
          onClose={() => setAction(null)}
          onSaved={afterSave}
        />
      )}
      {action?.kind === 'procedure' && (
        <ProcedurePlanModal
          patientId={patientId}
          appointments={appointments}
          onClose={() => setAction(null)}
          onSaved={afterSave}
        />
      )}
      {action?.kind === 'scheduling' && (
        <ProcedureAppointmentModal
          key={action.procedure.id}
          procedureId={action.procedure.id}
          onClose={() => setAction(null)}
          onSaved={resource.reload}
        />
      )}
      {action?.kind === 'cancel-procedure' && (
        <CancellationModal
          title={action.procedure.title}
          endpoint={`/api/procedures/${action.procedure.id}/cancel`}
          onClose={() => setAction(null)}
          onSaved={afterSave}
        />
      )}
    </div>
  );
}
function CheckIcon() {
  return <ClipboardCheck size={16} />;
}

function ClinicalForm({
  title,
  endpoint,
  payload,
  children,
  label,
  onClose,
  onSaved,
}: {
  title: string;
  endpoint: string;
  payload: (form: FormData) => unknown;
  children: ReactNode;
  label: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      await api(endpoint, { method: 'POST', body: payload(form) });
      toast('Clinical record saved.');
      onSaved();
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={title} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {children}
        {error && (
          <div className="notice notice-error" role="alert">
            {error}
          </div>
        )}
        <FormFooter busy={busy} label={label} onClose={onClose} />
      </form>
    </Modal>
  );
}
type ModalCallbacks = { onClose: () => void; onSaved: () => void };
function CancellationModal({
  title,
  endpoint,
  ...callbacks
}: ModalCallbacks & { title: string; endpoint: string }) {
  return (
    <ClinicalForm
      title="Cancel this clinical record?"
      endpoint={endpoint}
      payload={(form) => ({ reason: form.get('reason') })}
      label="Confirm cancellation"
      {...callbacks}
    >
      <p>
        <strong>{title}</strong>
      </p>
      <Field label="Reason for cancellation">
        <textarea name="reason" required rows={3} maxLength={8000} />
      </Field>
      <p className="muted small">
        The record and its history remain available. Cancellation cannot be undone.
      </p>
    </ClinicalForm>
  );
}

export function EncounterAmendments({
  amendments,
  recordingPending,
  onAdd,
}: {
  amendments: EncounterAmendment[];
  recordingPending: boolean;
  onAdd: () => void;
}) {
  const { session } = useSession();
  const canDocument = !!session.user?.doctorId && ['doctor', 'admin'].includes(session.user.role);
  return (
    <div className="cw-amendments">
      <div className="row between">
        <h3>
          <History size={16} /> Additions & corrections
        </h3>
        {canDocument && (
          <button
            className="button button-secondary button-small"
            disabled={recordingPending}
            onClick={onAdd}
          >
            <Plus size={14} /> Add amendment
          </button>
        )}
      </div>
      {amendments.length ? (
        [...amendments]
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .map((amendment) => (
            <article className="cw-amendment" key={amendment.id}>
              <div className="cw-history-meta">
                <strong>{amendment.reason}</strong>
                <span>
                  {amendment.doctorName} · {timestamp(amendment.createdAt)} IST
                </span>
              </div>
              <p className="cw-prose">{amendment.text}</p>
            </article>
          ))
      ) : (
        <p className="muted small">
          No amendments. The original consultation note above is preserved.
        </p>
      )}
    </div>
  );
}
