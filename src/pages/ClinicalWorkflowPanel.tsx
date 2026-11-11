import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  ClipboardCheck,
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
import type { PatientDocument } from '../../shared/documents';
import { api, formatDate, today, useResource, useSession, useToast } from '../lib';
import { Badge, Card, EmptyState, ErrorState, Field, Loading, Modal } from '../components/ui';
import { DocumentUploadModal } from '../components/DocumentsPanel';
import { InvestigationReviewModal } from '../components/InvestigationReviewModal';
import './clinical-workflows.css';

type ClinicalResource = {
  data: PatientClinicalWorkflows | null;
  loading: boolean;
  error: string;
  reload: () => Promise<void>;
};
type WorkflowAction =
  | { kind: 'order' | 'procedure' }
  | { kind: 'result' | 'cancel-investigation'; investigation: Investigation }
  | { kind: 'review'; investigation: Investigation; result: InvestigationResult }
  | { kind: 'agreement' | 'complete' | 'cancel-procedure'; procedure: ProcedureRecord };
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
  appointments,
  resource,
  selectedInvestigationId,
  selectedResultId,
}: {
  patientId: string;
  appointments: Appointment[];
  resource: ClinicalResource;
  selectedInvestigationId?: string | null;
  selectedResultId?: string | null;
}) {
  const { session } = useSession();
  const canDocument = !!session.user?.doctorId && ['doctor', 'admin'].includes(session.user.role);
  const documents = useResource<PatientDocument[]>(
    `/api/documents?patientId=${encodeURIComponent(patientId)}`,
  );
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
  if (resource.loading && !data) return <Loading />;
  if (resource.error) return <ErrorState message={resource.error} retry={resource.reload} />;
  if (!data) return null;
  const investigations = data.investigations.filter(
    (i) => filter === 'all' || i.status !== 'cancelled' || i.id === selectedInvestigationId,
  );
  const procedures = data.procedures.filter((p) => filter === 'all' || p.status !== 'cancelled');
  return (
    <div className="cw-workspace">
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
            {canDocument && (
              <button
                className="button button-primary"
                onClick={() => setAction({ kind: 'order' })}
              >
                <Plus size={16} /> Order investigation
              </button>
            )}
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
                      <button
                        className="button button-secondary button-small"
                        onClick={() => setAction({ kind: 'result', investigation })}
                      >
                        <FilePlus2 size={15} /> Add result
                      </button>
                      {investigation.status !== 'reviewed' && (
                        <button
                          className="button button-ghost button-small"
                          onClick={() => setAction({ kind: 'cancel-investigation', investigation })}
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
            <h2>
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
              const agreements = [...procedure.agreements].sort((a, b) =>
                a.createdAt.localeCompare(b.createdAt),
              );
              const latest = agreements.at(-1);
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
                              {agreement.recordedByName} ·{' '}
                              {agreement.method === 'portal'
                                ? 'Patient portal'
                                : agreement.method === 'phone'
                                  ? 'By phone'
                                  : 'In person'}{' '}
                              · {timestamp(agreement.createdAt)} IST
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
                        <button
                          className="button button-secondary button-small"
                          onClick={() => setAction({ kind: 'agreement', procedure })}
                        >
                          <MessageSquareText size={14} /> Record patient decision
                        </button>
                        <button
                          className="button button-primary button-small"
                          disabled={latest?.decision !== 'agreed'}
                          onClick={() => setAction({ kind: 'complete', procedure })}
                        >
                          Document completion
                        </button>
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
      {action?.kind === 'order' && (
        <OrderModal patientId={patientId} onClose={() => setAction(null)} onSaved={afterSave} />
      )}
      {action?.kind === 'result' && (
        <ResultModal
          patientId={patientId}
          investigation={action.investigation}
          onClose={() => setAction(null)}
          onSaved={afterSave}
        />
      )}
      {action?.kind === 'review' && (
        <InvestigationReviewModal
          investigationId={action.investigation.id}
          onClose={() => setAction(null)}
          onSaved={afterSave}
        />
      )}
      {action?.kind === 'procedure' && (
        <ProcedureModal
          patientId={patientId}
          appointments={appointments}
          onClose={() => setAction(null)}
          onSaved={afterSave}
        />
      )}
      {action?.kind === 'agreement' && (
        <DecisionModal
          procedure={action.procedure}
          onClose={() => setAction(null)}
          onSaved={afterSave}
        />
      )}
      {action?.kind === 'complete' && (
        <CompletionModal
          procedure={action.procedure}
          onClose={() => setAction(null)}
          onSaved={afterSave}
        />
      )}
      {action?.kind === 'cancel-investigation' && (
        <CancellationModal
          title={action.investigation.title}
          endpoint={`/api/investigations/${action.investigation.id}/cancel`}
          onClose={() => setAction(null)}
          onSaved={afterSave}
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
function OrderModal({ patientId, ...callbacks }: ModalCallbacks & { patientId: string }) {
  return (
    <ClinicalForm
      title="Order an investigation"
      endpoint="/api/investigations"
      payload={(form) => ({
        ...Object.fromEntries(form),
        patientId,
        dueDate: form.get('dueDate') || undefined,
      })}
      label="Save investigation order"
      {...callbacks}
    >
      <Field label="Investigation name">
        <input
          name="title"
          required
          maxLength={300}
          placeholder="Clinician-selected investigation"
        />
      </Field>
      <div className="form-grid">
        <Field label="Investigation type">
          <select name="kind">
            <option value="laboratory">Laboratory</option>
            <option value="pathology">Pathology</option>
            <option value="imaging">Imaging</option>
            <option value="other">Other</option>
          </select>
        </Field>
        <Field label="Requested by date" hint="Optional">
          <input type="date" name="dueDate" min={today()} />
        </Field>
      </div>
      <Field label="Clinical question / reason">
        <textarea name="reason" required maxLength={8000} rows={3} />
      </Field>
      <Field label="Instructions for the patient">
        <textarea
          name="instructions"
          required
          maxLength={8000}
          rows={3}
          placeholder="Preparation and how to share the result"
        />
      </Field>
      <div className="notice">
        This records your order and instructions. It does not send a request to a laboratory or
        interpret a result.
      </div>
    </ClinicalForm>
  );
}

function ResultModal({
  patientId,
  investigation,
  ...callbacks
}: ModalCallbacks & { patientId: string; investigation: Investigation }) {
  const documents = useResource<PatientDocument[]>(
    `/api/documents?patientId=${encodeURIComponent(patientId)}`,
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [note, setNote] = useState('');
  if (uploading)
    return (
      <DocumentUploadModal
        patientId={patientId}
        onClose={() => setUploading(false)}
        onUploaded={(document) => {
          setUploading(false);
          setSelected((ids) => [...ids, document.id]);
          void documents.reload();
        }}
      />
    );
  return (
    <ClinicalForm
      title="Add an investigation result"
      endpoint={`/api/investigations/${investigation.id}/results`}
      payload={(form) => ({ note: form.get('note'), documentIds: selected })}
      label="Save result entry"
      {...callbacks}
    >
      <p className="muted">{investigation.title}</p>
      <Field label="Result entry / source note">
        <textarea
          name="note"
          required={selected.length === 0}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={4}
          maxLength={8000}
          placeholder="Record what was received and where it came from. Add clinical interpretation in a separate review."
        />
      </Field>
      <div className="cw-report-picker">
        <div className="row between">
          <h3>Attach patient reports · up to 10</h3>
          <button
            type="button"
            className="button button-secondary button-small"
            onClick={() => setUploading(true)}
          >
            <Plus size={14} /> Upload report
          </button>
        </div>
        {documents.loading ? (
          <p className="muted small">Loading reports…</p>
        ) : documents.error ? (
          <ErrorState message={documents.error} retry={documents.reload} />
        ) : documents.data?.length ? (
          <div className="cw-document-options">
            {documents.data.map((document) => (
              <label key={document.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(document.id)}
                  disabled={selected.length >= 10 && !selected.includes(document.id)}
                  onChange={(e) =>
                    setSelected((ids) =>
                      e.target.checked
                        ? [...ids, document.id]
                        : ids.filter((id) => id !== document.id),
                    )
                  }
                />
                <span>
                  <strong>{document.title}</strong>
                  <small>
                    {document.originalName} · {formatDate(document.createdAt)}
                  </small>
                </span>
              </label>
            ))}
          </div>
        ) : (
          <p className="muted small">
            No PDF reports yet. You can save a text result or upload a private report.
          </p>
        )}
      </div>
      <div className="notice">
        Result entries are preserved in the record. Sharing clinician findings requires a separate
        review and publication step.
      </div>
    </ClinicalForm>
  );
}

function ProcedureModal({
  patientId,
  appointments,
  ...callbacks
}: ModalCallbacks & { patientId: string; appointments: Appointment[] }) {
  return (
    <ClinicalForm
      title="Plan a procedure"
      endpoint="/api/procedures"
      payload={(form) => ({
        ...Object.fromEntries(form),
        patientId,
        appointmentId: form.get('appointmentId') || undefined,
      })}
      label="Save procedure plan"
      {...callbacks}
    >
      <Field label="Procedure name">
        <input name="title" required maxLength={300} />
      </Field>
      <Field label="Linked appointment">
        <select name="appointmentId">
          <option value="">No linked appointment</option>
          {appointments
            .filter((a) => !['cancelled', 'no-show'].includes(a.status))
            .map((a) => (
              <option key={a.id} value={a.id}>
                {formatDate(a.date)} · {a.time} · {a.reason}
              </option>
            ))}
        </select>
      </Field>
      <Field label="Indication / reason">
        <textarea name="indication" required rows={3} maxLength={8000} />
      </Field>
      <Field label="Expected benefits">
        <textarea name="benefits" required rows={2} maxLength={8000} />
      </Field>
      <Field label="Risks to discuss">
        <textarea name="risks" required rows={3} maxLength={8000} />
      </Field>
      <Field label="Alternatives to discuss">
        <textarea name="alternatives" required rows={2} maxLength={8000} />
      </Field>
      <Field label="Planned aftercare instructions">
        <textarea name="aftercare" required rows={3} maxLength={8000} />
      </Field>
      <Field label="Estimated cost">
        <input
          name="estimatedCost"
          required
          maxLength={300}
          placeholder="Amount or range discussed with the patient"
        />
      </Field>
      <div className="notice">
        This saves an immutable plan for discussion. Record the patient’s decision separately before
        documenting completion. It does not reserve a procedure room or create an invoice.
      </div>
    </ClinicalForm>
  );
}

function DecisionModal({
  procedure,
  ...callbacks
}: ModalCallbacks & { procedure: ProcedureRecord }) {
  return (
    <ClinicalForm
      title="Record the patient’s decision"
      endpoint={`/api/procedures/${procedure.id}/agreements`}
      payload={(form) => ({
        decision: form.get('decision'),
        method: form.get('method'),
        note: form.get('note'),
        patientDecisionConfirmed: true,
      })}
      label="Save patient decision"
      {...callbacks}
    >
      <p className="muted">{procedure.title}</p>
      <div className="form-grid">
        <Field label="Patient decision">
          <select name="decision">
            <option value="agreed">Agreed to the plan</option>
            <option value="declined">Declined the plan</option>
          </select>
        </Field>
        <Field label="Discussion method">
          <select name="method">
            <option value="in-person">In person</option>
            <option value="phone">By phone</option>
          </select>
        </Field>
      </div>
      <Field label="Discussion and decision notes">
        <textarea
          name="note"
          required
          rows={4}
          maxLength={8000}
          placeholder="Record the discussion, questions, and what the patient communicated"
        />
      </Field>
      <label className="checkbox-field">
        <input type="checkbox" required />
        <span>
          I confirm that this records the patient’s actual communicated decision, including their
          opportunity to ask questions.
        </span>
      </label>
      <div className="notice">
        This is a record of communication. It is not a legally validated consent form or electronic
        signature. Follow your clinic’s procedure-specific consent process.
      </div>
    </ClinicalForm>
  );
}

function CompletionModal({
  procedure,
  ...callbacks
}: ModalCallbacks & { procedure: ProcedureRecord }) {
  return (
    <ClinicalForm
      title="Document procedure completion"
      endpoint={`/api/procedures/${procedure.id}/complete`}
      payload={(form) => ({ outcome: form.get('outcome'), aftercare: form.get('aftercare') })}
      label="Save procedure completion"
      {...callbacks}
    >
      <p className="muted">{procedure.title}</p>
      <Field label="Procedure outcome and notes">
        <textarea
          name="outcome"
          required
          rows={5}
          maxLength={8000}
          placeholder="What was performed, observations, and any relevant events"
        />
      </Field>
      <Field label="Final aftercare instructions">
        <textarea
          name="aftercare"
          required
          rows={4}
          maxLength={8000}
          defaultValue={procedure.aftercare}
        />
      </Field>
      <div className="notice">
        Completion is preserved as a clinical record. Review the outcome and aftercare before
        saving.
      </div>
    </ClinicalForm>
  );
}

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
  encounterId,
  amendments,
  onChanged,
}: {
  encounterId: string;
  amendments: EncounterAmendment[];
  onChanged: () => void;
}) {
  const { session } = useSession();
  const [adding, setAdding] = useState(false);
  const canDocument = !!session.user?.doctorId && ['doctor', 'admin'].includes(session.user.role);
  return (
    <div className="cw-amendments">
      <div className="row between">
        <h3>
          <History size={16} /> Additions & corrections
        </h3>
        {canDocument && (
          <button className="button button-secondary button-small" onClick={() => setAdding(true)}>
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
      {adding && (
        <ClinicalForm
          title="Amend the consultation record"
          endpoint={`/api/encounters/${encounterId}/amendments`}
          payload={(form) => ({ reason: form.get('reason'), text: form.get('text') })}
          label="Save amendment"
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            onChanged();
          }}
        >
          <Field label="Reason for amendment">
            <input
              name="reason"
              required
              maxLength={300}
              placeholder="What needs clarification or correction?"
            />
          </Field>
          <Field label="Correction or additional information">
            <textarea name="text" required rows={5} maxLength={8000} />
          </Field>
          <div className="notice">
            This adds a dated, attributed amendment. It does not overwrite or hide the original
            note, and the amendment cannot be edited after saving.
          </div>
        </ClinicalForm>
      )}
    </div>
  );
}
