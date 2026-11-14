import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  CalendarDays,
  CheckCircle2,
  ClipboardCheck,
  Download,
  FileText,
  FlaskConical,
  RefreshCw,
  ShieldCheck,
  Upload,
} from 'lucide-react';
import type {
  Investigation,
  PatientClinicalWorkflows,
  ProcedureRecord,
} from '../../shared/clinical';
import type { PatientDocument } from '../../shared/documents';
import type { ProcedureAppointmentSnapshot } from '../../shared/procedure-scheduling';
import { api, formatDate, useResource, useToast } from '../lib';
import { Badge, Card, EmptyState, ErrorState, Field, Loading, Modal } from '../components/ui';
import { DocumentUploadModal } from '../components/DocumentsPanel';
import { ProcedureTemplateSource } from '../components/ProcedureTemplateSource';
import './patient-workflows.css';

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Your update could not be saved. Please try again.';
const investigationKinds: Record<Investigation['kind'], string> = {
  laboratory: 'Laboratory',
  pathology: 'Pathology',
  imaging: 'Imaging',
  other: 'Investigation',
};
const investigationStatuses: Record<Investigation['status'], string> = {
  ordered: 'Awaiting result',
  'result-received': 'With your care team',
  reviewed: 'Reviewed by clinician',
  cancelled: 'Cancelled',
};

export function PatientWorkflowPanel({ patientId }: { patientId: string }) {
  const workflows = useResource<PatientClinicalWorkflows>(
    `/api/patients/${encodeURIComponent(patientId)}/clinical-workflows`,
  );
  const documents = useResource<PatientDocument[]>(
    `/api/documents?patientId=${encodeURIComponent(patientId)}`,
  );
  const [resultFor, setResultFor] = useState<Investigation | null>(null);
  const [resultNote, setResultNote] = useState('');
  const [documentIds, setDocumentIds] = useState<string[]>([]);
  const [uploadReport, setUploadReport] = useState(false);
  const [agreementFor, setAgreementFor] = useState<ProcedureRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();
  function openResult(investigation: Investigation) {
    setResultFor(investigation);
    setResultNote('');
    setDocumentIds([]);
    setError('');
  }
  async function submitResult(event: FormEvent) {
    event.preventDefault();
    if (!resultFor || busy) return;
    if (!resultNote.trim() && !documentIds.length) {
      setError('Add a note or attach a report before sharing your result.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api(`/api/investigations/${resultFor.id}/results`, {
        method: 'POST',
        body: { note: resultNote.trim(), documentIds },
      });
      setResultFor(null);
      await workflows.reload();
      toast('Result shared with your care team for review.');
    } catch (problem) {
      setError(errorMessage(problem));
    } finally {
      setBusy(false);
    }
  }
  const waiting =
    workflows.data?.investigations.filter((item) => item.status === 'ordered').length ?? 0;
  const withClinic =
    workflows.data?.investigations.filter((item) => item.status === 'result-received').length ?? 0;
  const planned =
    workflows.data?.procedures.filter((item) => item.status === 'planned').length ?? 0;
  if (workflows.loading && !workflows.data) return <Loading />;
  if (workflows.error || !workflows.data)
    return (
      <ErrorState
        message={workflows.error || 'Your next steps could not be loaded.'}
        retry={workflows.reload}
      />
    );
  return (
    <div className="patient-workflows">
      <div className="section-heading">
        <div>
          <h2>Clear next steps, together.</h2>
          <p className="muted">
            Tests requested by your clinician, shared results, and procedure decisions.
          </p>
        </div>
        <button
          className="button button-secondary button-small"
          onClick={workflows.reload}
          disabled={workflows.loading}
        >
          <RefreshCw size={14} /> Refresh updates
        </button>
      </div>
      <div className="patient-workflow-overview">
        <div>
          <FlaskConical size={20} />
          <span>
            <strong>{waiting}</strong> awaiting results
          </span>
        </div>
        <div>
          <FileText size={20} />
          <span>
            <strong>{withClinic}</strong> with your care team
          </span>
        </div>
        <div>
          <ClipboardCheck size={20} />
          <span>
            <strong>{planned}</strong> planned procedures
          </span>
        </div>
      </div>
      <section
        aria-labelledby="patient-investigations-heading"
        className="patient-workflow-section"
      >
        <div className="patient-workflow-section-heading">
          <h2 id="patient-investigations-heading">Your investigations</h2>
          <span className="muted small">Requests and clinical reviews</span>
        </div>
        {workflows.data.investigations.length ? (
          <div className="stack">
            {workflows.data.investigations.map((investigation) => (
              <InvestigationCard
                key={investigation.id}
                investigation={investigation}
                documents={documents.data ?? []}
                onShare={() => openResult(investigation)}
              />
            ))}
          </div>
        ) : (
          <Card>
            <EmptyState
              title="No investigations requested"
              description="When your clinician requests a test or report, the details and next steps will appear here."
            />
          </Card>
        )}
      </section>
      <section aria-labelledby="patient-procedures-heading" className="patient-workflow-section">
        <div className="patient-workflow-section-heading">
          <h2 id="patient-procedures-heading">Your procedures</h2>
          <span className="muted small">Information and recorded choices</span>
        </div>
        {workflows.data.procedures.length ? (
          <div className="stack">
            {workflows.data.procedures.map((procedure) => (
              <ProcedureCard
                key={procedure.id}
                procedure={procedure}
                onDecision={() => setAgreementFor(procedure)}
              />
            ))}
          </div>
        ) : (
          <Card>
            <EmptyState
              title="No procedures planned"
              description="Your clinician’s procedure details and information to review will appear here when relevant to your care."
            />
          </Card>
        )}
      </section>
      {resultFor && !uploadReport && (
        <Modal
          title="Share an investigation result"
          onClose={() => {
            if (!busy) setResultFor(null);
          }}
        >
          <form onSubmit={submitResult} className="stack">
            <div>
              <h3>{resultFor.title}</h3>
              <p className="muted">
                Your result is submitted for clinician review. Sharing a report does not interpret
                or confirm its findings.
              </p>
            </div>
            <Field
              label="Result note"
              hint="Optional if you attach a report. Use your own words; your clinician will review the information."
            >
              <textarea
                value={resultNote}
                onChange={(event) => setResultNote(event.target.value)}
                maxLength={8000}
                rows={4}
                disabled={busy}
                placeholder="Share when the test was done or anything you want the clinic to know."
              />
            </Field>
            <div className="patient-result-attachments">
              <div className="row between">
                <h3>Attach PDF reports</h3>
                <button
                  type="button"
                  className="button button-secondary button-small"
                  disabled={busy}
                  onClick={() => setUploadReport(true)}
                >
                  <Upload size={14} /> Upload a PDF report
                </button>
              </div>
              <p className="muted small">Choose up to 10 reports from your private record.</p>
              {documents.loading ? (
                <Loading />
              ) : documents.error ? (
                <ErrorState message={documents.error} retry={documents.reload} />
              ) : documents.data?.length ? (
                <div className="patient-result-document-list">
                  {documents.data.map((document) => (
                    <label className="patient-result-document" key={document.id}>
                      <input
                        type="checkbox"
                        checked={documentIds.includes(document.id)}
                        disabled={
                          busy || (documentIds.length >= 10 && !documentIds.includes(document.id))
                        }
                        onChange={(event) =>
                          setDocumentIds((current) =>
                            event.target.checked
                              ? [...current, document.id]
                              : current.filter((id) => id !== document.id),
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
                  No PDF reports uploaded yet. You can upload one here or share a note on its own.
                </p>
              )}
            </div>
            <div className="notice">
              <ShieldCheck size={18} />
              <span>
                Only you and your clinical team can access these reports. A clinician’s review
                appears separately when they share it with you.
              </span>
            </div>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div className="form-actions">
              <button
                className="button button-secondary"
                type="button"
                disabled={busy}
                onClick={() => setResultFor(null)}
              >
                Cancel
              </button>
              <button
                className="button button-primary"
                disabled={busy || (!resultNote.trim() && !documentIds.length)}
              >
                {busy ? 'Sharing…' : 'Share result with clinic'}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {uploadReport && resultFor && (
        <DocumentUploadModal
          patientId={patientId}
          onClose={() => setUploadReport(false)}
          onUploaded={(document) => {
            setDocumentIds((current) =>
              current.length < 10 ? [...current, document.id] : current,
            );
            setUploadReport(false);
            void documents.reload();
          }}
        />
      )}
      {agreementFor && (
        <ProcedureDecisionModal
          procedure={agreementFor}
          onClose={() => setAgreementFor(null)}
          onSaved={() => {
            setAgreementFor(null);
            void workflows.reload();
          }}
        />
      )}
    </div>
  );
}

function InvestigationCard({
  investigation,
  documents,
  onShare,
}: {
  investigation: Investigation;
  documents: PatientDocument[];
  onShare: () => void;
}) {
  const tone =
    investigation.status === 'reviewed'
      ? 'green'
      : investigation.status === 'cancelled'
        ? 'neutral'
        : 'amber';
  return (
    <Card className="patient-investigation-card">
      <div className="patient-workflow-card-heading">
        <div>
          <span className="eyebrow">{investigationKinds[investigation.kind]}</span>
          <h3>{investigation.title}</h3>
          <p className="muted small">
            Requested by {investigation.doctorName} · {formatDate(investigation.createdAt)}
          </p>
        </div>
        <Badge tone={tone}>{investigationStatuses[investigation.status]}</Badge>
      </div>
      <dl className="patient-workflow-details">
        <div>
          <dt>Why this was requested</dt>
          <dd>{investigation.reason}</dd>
        </div>
        {investigation.instructions && (
          <div>
            <dt>Your clinician’s instructions</dt>
            <dd>{investigation.instructions}</dd>
          </div>
        )}
        {investigation.dueDate && (
          <div>
            <dt>Requested by</dt>
            <dd>
              <CalendarDays size={14} /> {formatDate(investigation.dueDate)}
            </dd>
          </div>
        )}
      </dl>
      {investigation.status === 'cancelled' && (
        <div className="notice">
          <span>
            This request was cancelled.
            {investigation.cancellationReason && <> {investigation.cancellationReason}</>}
          </span>
        </div>
      )}
      {investigation.results.length > 0 && (
        <div className="patient-investigation-results">
          <h4>Shared results & reviews</h4>
          {investigation.results.map((result) => {
            const reviews = investigation.reviews.filter(
              (review) => review.resultId === result.id && review.publishedAt,
            );
            return (
              <article className="patient-investigation-result" key={result.id}>
                <div className="row between">
                  <span className="small">
                    {result.submittedByRole === 'patient'
                      ? 'Patient-submitted result'
                      : `Result recorded by ${result.submittedByName}`}
                  </span>
                  <Badge tone={reviews.length ? 'green' : 'neutral'}>
                    {reviews.length ? 'Review shared' : 'No review shared yet'}
                  </Badge>
                </div>
                <p className="patient-workflow-timestamp">Shared {formatDate(result.createdAt)}</p>
                {result.note && <p className="pre-line">{result.note}</p>}
                {result.documentIds.length > 0 && (
                  <div className="patient-linked-reports">
                    {result.documentIds.map((documentId) => {
                      const document = documents.find((item) => item.id === documentId);
                      return document ? (
                        <a
                          className="button button-secondary button-small"
                          key={documentId}
                          href={document.url}
                          download
                        >
                          <Download size={14} /> {document.title}
                          <span className="sr-only"> PDF report</span>
                        </a>
                      ) : (
                        <span className="muted small" key={documentId}>
                          <FileText size={14} /> Attached report
                        </span>
                      );
                    })}
                  </div>
                )}
                {reviews.map((review) => (
                  <div className="patient-published-review" key={review.id}>
                    <div>
                      <CheckCircle2 size={18} />
                      <h4>Clinician review</h4>
                    </div>
                    <p className="patient-workflow-timestamp">
                      Shared by {review.doctorName} · {formatDate(review.publishedAt!)}
                    </p>
                    <p className="pre-line">{review.summary}</p>
                    {review.followUp && (
                      <>
                        <strong>Next steps from your clinician</strong>
                        <p className="pre-line">{review.followUp}</p>
                      </>
                    )}
                  </div>
                ))}
              </article>
            );
          })}
        </div>
      )}
      {investigation.status !== 'cancelled' && (
        <div className="patient-workflow-card-footer">
          <span className="muted small">A new submission awaits your clinician’s review.</span>
          <button className="button button-primary" onClick={onShare}>
            <Upload size={15} />
            {investigation.results.length ? 'Share another result' : 'Share result'}
          </button>
        </div>
      )}
    </Card>
  );
}

function ProcedureDetails({ procedure }: { procedure: ProcedureRecord }) {
  return (
    <>
      <ProcedureTemplateSource source={procedure.templateSource} />
      <dl className="patient-workflow-details procedure-information">
        {[
          ['Reason for the procedure', procedure.indication],
          ['Expected benefits', procedure.benefits],
          ['Risks and precautions', procedure.risks],
          ['Alternatives', procedure.alternatives],
          ['Planned aftercare', procedure.aftercare],
          ['Estimated cost', procedure.estimatedCost],
        ].map(([label, text]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{text || 'Not recorded. Ask your clinician for clarification.'}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

function ProcedureVisit({
  appointment,
  linked,
  completed = false,
  planned = false,
}: {
  appointment: ProcedureAppointmentSnapshot | null | undefined;
  linked: boolean;
  completed?: boolean;
  planned?: boolean;
}) {
  const [hours, minutes] = (appointment?.time ?? '00:00').split(':').map(Number);
  const end = hours * 60 + minutes + (appointment?.durationMinutes ?? 0);
  const needsAttention =
    planned &&
    appointment &&
    (['cancelled', 'no-show', 'completed'].includes(appointment.status) ||
      (appointment.status === 'scheduled' &&
        Date.parse(`${appointment.date}T${appointment.time}:00+05:30`) <= Date.now()));
  return (
    <div className="patient-procedure-visit">
      <h4>{completed ? 'Visit recorded at completion' : 'Linked visit'}</h4>
      {appointment ? (
        <>
          <p>
            {formatDate(appointment.date)} · {appointment.time}–
            {String(Math.floor(end / 60)).padStart(2, '0')}:{String(end % 60).padStart(2, '0')} IST
            · {appointment.durationMinutes} minutes
          </p>
          <p>
            {appointment.doctorName} ·{' '}
            {appointment.mode === 'online' ? 'Online visit' : 'In-person visit'}
            {appointment.durationPolicy === 'custom' && ' · Custom length'}
          </p>
          <p>Appointment status: {appointment.status.replaceAll('-', ' ')}</p>
          {needsAttention && (
            <p>Contact the clinic to confirm the visit for this planned procedure.</p>
          )}
        </>
      ) : (
        <p>
          {completed
            ? 'No appointment was linked when completion was recorded.'
            : linked
              ? 'The linked visit details are unavailable. Contact the clinic for confirmation.'
              : 'No appointment is currently linked to this procedure.'}
        </p>
      )}
      {!completed && (
        <p className="small muted">
          A visit link does not change your recorded procedure decision.
          {appointment && (
            <>
              {' '}
              <Link to="/my-care" className="text-link">
                View your appointments
              </Link>
            </>
          )}
        </p>
      )}
    </div>
  );
}

function CurrentProcedureVisit({ procedure }: { procedure: ProcedureRecord }) {
  const effectiveId =
    procedure.effectiveAppointmentId === undefined
      ? procedure.appointmentId
      : procedure.effectiveAppointmentId;
  return (
    <ProcedureVisit
      appointment={procedure.scheduledAppointment}
      linked={effectiveId !== null}
      planned={procedure.status === 'planned'}
    />
  );
}

function ProcedureCard({
  procedure,
  onDecision,
}: {
  procedure: ProcedureRecord;
  onDecision: () => void;
}) {
  const latest = procedure.agreements.at(-1);
  return (
    <Card className="patient-procedure-card">
      <div className="patient-workflow-card-heading">
        <div>
          <span className="eyebrow">PROCEDURE INFORMATION</span>
          <h3>{procedure.title}</h3>
          <p className="muted small">
            Planned by {procedure.doctorName} · {formatDate(procedure.createdAt)}
          </p>
        </div>
        <Badge tone={procedure.status === 'completed' ? 'green' : 'neutral'}>
          {procedure.status}
        </Badge>
      </div>
      <CurrentProcedureVisit procedure={procedure} />
      <ProcedureDetails procedure={procedure} />
      {procedure.status === 'cancelled' && (
        <div className="notice">
          <span>
            This procedure was cancelled.
            {procedure.cancellationReason && <> {procedure.cancellationReason}</>}
          </span>
        </div>
      )}
      {procedure.completion && (
        <div className="patient-published-review">
          <div>
            <CheckCircle2 size={18} />
            <h4>Procedure completed</h4>
          </div>
          <p className="patient-workflow-timestamp">
            {procedure.completion.doctorName} · {formatDate(procedure.completion.completedAt)}
          </p>
          <strong>Clinician’s outcome record</strong>
          <p className="pre-line">{procedure.completion.outcome}</p>
          <strong>Aftercare from your clinician</strong>
          <p className="pre-line">{procedure.completion.aftercare}</p>
          {procedure.completion.appointment !== undefined && (
            <ProcedureVisit
              appointment={procedure.completion.appointment}
              linked={procedure.completion.appointment !== null}
              completed
            />
          )}
        </div>
      )}
      {latest && (
        <div className="patient-latest-decision">
          <ClipboardCheck size={19} />
          <div>
            <strong>
              Latest recorded choice: {latest.decision === 'agreed' ? 'Agreed' : 'Declined'}
            </strong>
            <p>
              {latest.method === 'portal'
                ? 'Shared through the patient portal'
                : `Recorded by ${latest.recordedByName} · ${latest.method === 'phone' ? 'By phone' : 'In person'}`}{' '}
              · {formatDate(latest.createdAt)}
            </p>
            {latest.note && <p className="pre-line">{latest.note}</p>}
          </div>
        </div>
      )}
      {procedure.agreements.length > 1 && (
        <details className="patient-decision-history">
          <summary>View previous recorded choices</summary>
          <ol>
            {procedure.agreements.slice(0, -1).map((agreement) => (
              <li key={agreement.id}>
                <strong>{agreement.decision === 'agreed' ? 'Agreed' : 'Declined'}</strong>
                <span>
                  {formatDate(agreement.createdAt)} · Recorded by {agreement.recordedByName}
                </span>
                {agreement.note && <p className="pre-line">{agreement.note}</p>}
              </li>
            ))}
          </ol>
        </details>
      )}
      {procedure.status === 'planned' && (
        <div className="patient-workflow-card-footer">
          <span className="muted small">
            Your choice is recorded for the clinic. This is not a legal e-signature.
          </span>
          <button className="button button-primary" onClick={onDecision}>
            <ClipboardCheck size={15} />
            {latest ? 'Update my decision' : 'Review and decide'}
          </button>
        </div>
      )}
    </Card>
  );
}

function ProcedureDecisionModal({
  procedure,
  onClose,
  onSaved,
}: {
  procedure: ProcedureRecord;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [decision, setDecision] = useState<'agreed' | 'declined' | ''>('');
  const [reviewed, setReviewed] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!decision || !reviewed || busy) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/procedures/${procedure.id}/agreements`, {
        method: 'POST',
        body: { decision, method: 'portal', note: note.trim() },
      });
      toast('Your decision has been recorded for your clinic.');
      onSaved();
    } catch (problem) {
      setError(errorMessage(problem));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Review your procedure decision"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form onSubmit={submit} className="stack">
        <div>
          <h3>{procedure.title}</h3>
          <p className="muted">
            Review the information your clinician shared. Contact the clinic if you need anything
            explained before making a choice.
          </p>
        </div>
        <CurrentProcedureVisit procedure={procedure} />
        <ProcedureDetails procedure={procedure} />
        <Field label="Your decision">
          <select
            required
            value={decision}
            disabled={busy}
            onChange={(event) => setDecision(event.target.value as typeof decision)}
          >
            <option value="">Choose your decision</option>
            <option value="agreed">I agree to the proposed procedure</option>
            <option value="declined">I decline the proposed procedure</option>
          </select>
        </Field>
        <Field
          label="Note for your clinic"
          hint="Optional. Include any questions or context for your choice."
        >
          <textarea
            rows={3}
            maxLength={8000}
            value={note}
            disabled={busy}
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
        <label className="checkbox-field">
          <input
            type="checkbox"
            required
            checked={reviewed}
            disabled={busy}
            onChange={(event) => setReviewed(event.target.checked)}
          />
          <span>
            I have reviewed the information above and want to record this choice for my clinic.
          </span>
        </label>
        <div className="notice">
          <ShieldCheck size={18} />
          <span>
            This records a choice and its history. It is not a legal e-signature or a substitute for
            a discussion with your clinician. You can update your decision while the procedure is
            planned.
          </span>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button
            className="button button-secondary"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            Decide later
          </button>
          <button className="button button-primary" disabled={busy || !decision || !reviewed}>
            {busy ? 'Saving…' : 'Record my decision'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
