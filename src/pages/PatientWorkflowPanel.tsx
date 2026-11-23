import {
  CalendarDays,
  CheckCircle2,
  ClipboardCheck,
  Download,
  FileText,
  FlaskConical,
  RefreshCw,
  Upload,
} from 'lucide-react';
import type { Investigation, ProcedureRecord } from '../../shared/clinical';
import type { PatientDocument } from '../../shared/documents';
import { formatDate } from '../lib';
import { Badge, Card, EmptyState, ErrorState, Loading } from '../components/ui';
import { checkedConsultationWorkflows } from '../components/consultation-recording-helpers';
import { useAppointmentBookingData } from '../components/appointment-booking-helpers';
import { useInvestigationResultSubmission } from '../components/InvestigationResultModal';
import { usePatientDocuments } from '../components/private-upload-helpers';
import {
  CurrentProcedureVisit,
  ProcedureDetails,
  ProcedureVisit,
} from '../components/PatientProcedureInformation';
import { useProcedureDecisionRecording } from '../components/ProcedureDecisionModal';
import { decisionMethods } from '../components/procedure-decision-helpers';
import './patient-workflows.css';

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

export function PatientWorkflowPanel({
  patientId,
  patientName,
}: {
  patientId: string;
  patientName: string;
}) {
  const workflows = useAppointmentBookingData(
    `/api/patients/${encodeURIComponent(patientId)}/clinical-workflows`,
    (value) => checkedConsultationWorkflows(value, patientId),
  );
  const documents = usePatientDocuments(patientId);
  const resultSubmission = useInvestigationResultSubmission(patientId, patientName, () => {
    void workflows.reload();
    void documents.reload();
  });
  const decisions = useProcedureDecisionRecording(patientId, patientName, workflows.reload);
  const waiting =
    workflows.data?.investigations.filter((item) => item.status === 'ordered').length ?? 0;
  const withClinic =
    workflows.data?.investigations.filter((item) => item.status === 'result-received').length ?? 0;
  const planned =
    workflows.data?.procedures.filter((item) => item.status === 'planned').length ?? 0;
  if (workflows.loading && !workflows.data)
    return (
      <div>
        {resultSubmission.controls}
        {decisions.controls}
        <Loading />
      </div>
    );
  if (workflows.error || !workflows.data)
    return (
      <div>
        {resultSubmission.controls}
        {decisions.controls}
        <ErrorState
          message={workflows.error || 'Your next steps could not be loaded.'}
          retry={workflows.reload}
        />
      </div>
    );
  return (
    <div className="patient-workflows">
      {resultSubmission.controls}
      {decisions.controls}
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
                onShare={
                  resultSubmission.hasPending(investigation.id)
                    ? undefined
                    : () => resultSubmission.open(investigation.id)
                }
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
          <h2 id="patient-procedures-heading" data-procedure-decisions-heading tabIndex={-1}>
            Your procedures
          </h2>
          <span className="muted small">Information and recorded choices</span>
        </div>
        {workflows.data.procedures.length ? (
          <div className="stack">
            {workflows.data.procedures.map((procedure) => (
              <ProcedureCard
                key={procedure.id}
                procedure={procedure}
                onDecision={
                  decisions.hasPending(procedure.id)
                    ? undefined
                    : () => decisions.open(procedure.id)
                }
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
  onShare?: () => void;
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
      {investigation.status !== 'cancelled' && onShare && (
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

function ProcedureCard({
  procedure,
  onDecision,
}: {
  procedure: ProcedureRecord;
  onDecision?: () => void;
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
              Recorded by {latest.recordedByName} · {latest.recordedByRole} ·{' '}
              {decisionMethods[latest.method]} · {formatDate(latest.createdAt)}
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
                  {formatDate(agreement.createdAt)} · Recorded by {agreement.recordedByName} ·{' '}
                  {agreement.recordedByRole} · {decisionMethods[agreement.method]}
                </span>
                {agreement.note && <p className="pre-line">{agreement.note}</p>}
              </li>
            ))}
          </ol>
        </details>
      )}
      {procedure.status === 'planned' && onDecision && (
        <div className="patient-workflow-card-footer">
          <span className="muted small">
            Your choice is recorded for the clinic. This is not a legal e-signature.
          </span>
          <button
            data-procedure-decision={procedure.id}
            className="button button-primary"
            onClick={onDecision}
          >
            <ClipboardCheck size={15} />
            {latest ? 'Update my decision' : 'Review and decide'}
          </button>
        </div>
      )}
    </Card>
  );
}
