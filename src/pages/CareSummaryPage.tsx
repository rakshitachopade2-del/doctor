import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { ArrowDownToLine, ArrowLeft, FileText, Printer, RefreshCw } from 'lucide-react';
import type { CareSummary } from '../../shared/care-summary';
import { formatDate, money, useResource, useSession } from '../lib';
import { Badge, EmptyState, ErrorState, Loading, PageHeader } from '../components/ui';
import './care-summary.css';

const status = (value: string) => value.replaceAll('-', ' ');
const timestamp = (value: string) =>
  new Date(value).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
const snapshotDate = (value: string) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value));
const safeValue = (value?: string | null) => value?.trim() || 'Not recorded';
const fileSize = (bytes?: number) =>
  bytes === undefined
    ? 'Size not recorded'
    : bytes < 1_048_576
      ? `${Math.max(1, Math.round(bytes / 1024))} KB`
      : `${(bytes / 1_048_576).toFixed(1)} MB`;

export function CareSummaryPage() {
  const { id } = useParams();
  const { session } = useSession();
  if (!session.user) return <Navigate to="/login" replace />;
  if (session.user.role === 'receptionist') return <Navigate to="/clinic" replace />;
  const patient = session.user.role === 'patient';
  const patientId = patient ? session.user.patientId : id;
  if (!patientId)
    return (
      <EmptyState
        title="Choose a patient to view a care summary"
        action={
          <Link to={patient ? '/my-care' : '/clinic/patients'} className="button button-secondary">
            Return to records
          </Link>
        }
      />
    );
  return <SummaryWorkspace key={patientId} patientId={patientId} patient={patient} />;
}

function SummaryWorkspace({ patientId, patient }: { patientId: string; patient: boolean }) {
  const summary = useResource<CareSummary>(
    `/api/patients/${encodeURIComponent(patientId)}/care-summary`,
  );
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');
  const [stale, setStale] = useState(false);
  const request = useRef<AbortController | null>(null);
  const revision = summary.data?.revision;
  const recordPath = patient
    ? '/my-care/record'
    : `/clinic/patients/${encodeURIComponent(patientId)}`;
  useEffect(() => {
    setDownloading(false);
    setDownloadError('');
    setStale(false);
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [revision]);
  function refresh() {
    request.current?.abort();
    request.current = null;
    setDownloading(false);
    setDownloadError('');
    setStale(false);
    void summary.reload();
  }
  async function download() {
    if (!summary.data || summary.loading || summary.error || stale || request.current) return;
    const displayed = summary.data;
    const controller = new AbortController();
    request.current = controller;
    const current = () => request.current === controller && !controller.signal.aborted;
    setDownloading(true);
    setDownloadError('');
    try {
      const response = await fetch(
        `/api/patients/${encodeURIComponent(patientId)}/care-summary/download?revision=${encodeURIComponent(displayed.revision)}`,
        { credentials: 'same-origin', signal: controller.signal },
      );
      if (!current()) return;
      if (response.status === 409) {
        setStale(true);
        setDownloadError(
          'Your shared care record has changed since this summary was loaded. Refresh the summary before downloading the latest version.',
        );
        return;
      }
      if (!response.ok) {
        const problem = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(problem?.error || 'The summary could not be downloaded. Please try again.');
      }
      if (!response.headers.get('content-type')?.includes('application/json'))
        throw new Error('The server did not return a summary file. Please try again.');
      const blob = await response.blob();
      if (!current()) return;
      const saved = JSON.parse(await blob.text()) as CareSummary;
      if (!current()) return;
      if (
        saved.schemaVersion !== 1 ||
        saved.audience !== 'patient' ||
        saved.revision !== displayed.revision ||
        saved.patient?.id !== patientId
      )
        throw new Error('The download did not match the displayed summary. Refresh and try again.');
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `care-summary-${snapshotDate(saved.generatedAt)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (problem) {
      if (current())
        setDownloadError(
          problem instanceof Error ? problem.message : 'The summary could not be downloaded.',
        );
    } finally {
      if (current()) {
        request.current = null;
        setDownloading(false);
      }
    }
  }
  const ready = !!summary.data && !summary.loading && !summary.error;
  return (
    <div className="care-summary-page">
      <div className="care-summary-controls">
        <Link className="text-link" to={recordPath}>
          <ArrowLeft size={15} />
          Back to health record
        </Link>
      </div>
      <PageHeader
        eyebrow="YOUR SHARED CARE RECORD"
        title="Care summary"
        description="A patient-facing snapshot of shared records, ready to read, print or keep."
        actions={
          <>
            <button
              className="button button-secondary"
              disabled={summary.loading}
              onClick={refresh}
            >
              <RefreshCw size={16} />
              Refresh summary
            </button>
            <button
              className="button button-secondary"
              disabled={!ready}
              onClick={() => window.print()}
            >
              <Printer size={16} />
              Print summary
            </button>
            <button
              className="button button-primary"
              disabled={!ready || stale || downloading}
              onClick={download}
            >
              <ArrowDownToLine size={16} />
              {downloading ? 'Preparing summary…' : 'Download JSON'}
            </button>
          </>
        }
      />
      {downloadError && (
        <div className="notice notice-error care-summary-download-error" role="alert">
          <span>{downloadError}</span>
          {stale && (
            <button className="button button-secondary button-small" onClick={refresh}>
              Refresh to download
            </button>
          )}
        </div>
      )}
      {summary.loading ? (
        <Loading />
      ) : summary.error ? (
        <ErrorState message={summary.error} retry={refresh} />
      ) : summary.data ? (
        <SummaryDocument data={summary.data} recordPath={recordPath} />
      ) : (
        <EmptyState title="No summary available" />
      )}
    </div>
  );
}

function SummarySection({
  id,
  title,
  count,
  children,
}: {
  id: string;
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section
      id={`summary-${id}`}
      className="care-summary-section"
      aria-labelledby={`summary-${id}-title`}
    >
      <div className="care-summary-section-heading">
        <h2 id={`summary-${id}-title`}>{title}</h2>
        <span>
          {count} {count === 1 ? 'record' : 'records'}
        </span>
      </div>
      {count ? (
        children
      ) : (
        <p className="care-summary-empty">No {title.toLowerCase()} included in this snapshot.</p>
      )}
    </section>
  );
}
function SummaryEntry({
  title,
  source,
  date,
  badge,
  children,
}: {
  title: string;
  source: string;
  date: string;
  badge?: string;
  children: ReactNode;
}) {
  return (
    <article className="care-summary-entry">
      <div className="care-summary-entry-heading">
        <h3>{title}</h3>
        {badge && <Badge>{badge}</Badge>}
      </div>
      <p className="care-summary-source">
        {source} · {timestamp(date)} IST
      </p>
      {children}
    </article>
  );
}
function Detail({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="care-summary-detail">
      <strong>{label}</strong>
      <p>{safeValue(value)}</p>
    </div>
  );
}
function SummaryDocument({ data, recordPath }: { data: CareSummary; recordPath: string }) {
  const sections = [
    ['history', 'Shared history', data.intakes.length],
    ['appointments', 'Appointments', data.appointments.length],
    ['plans', 'Care plans & reviews', data.carePlans.length],
    ['check-ins', 'Patient check-ins', data.checkIns.length],
    ['investigations', 'Investigations', data.investigations.length],
    ['procedures', 'Procedure records', data.procedures.length],
    ['images', 'Images & shared annotations', data.images.length],
    ['documents', 'PDF report metadata', data.documents.length],
    ['invoices', 'Invoices', data.invoices.length],
  ] as const;
  const documentTitle = (id: string) =>
    data.documents.find((document) => document.id === id)?.title || 'Linked report';
  return (
    <div className="care-summary-document">
      <header className="care-summary-identity">
        <div>
          <span className="eyebrow">{data.clinic.name}</span>
          <h2>{data.patient.name}</h2>
          <p className="care-summary-snapshot">
            Snapshot generated {timestamp(data.generatedAt)} IST
          </p>
        </div>
        <FileText size={31} />
        <dl>
          <div>
            <dt>Date of birth</dt>
            <dd>{data.patient.dob ? formatDate(data.patient.dob) : 'Not recorded'}</dd>
          </div>
          <div>
            <dt>Gender</dt>
            <dd>{safeValue(data.patient.gender)}</dd>
          </div>
          <div>
            <dt>Phone</dt>
            <dd>{safeValue(data.patient.phone)}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{safeValue(data.patient.email)}</dd>
          </div>
          <div className="care-summary-allergies">
            <dt>Recorded allergies</dt>
            <dd>{safeValue(data.patient.allergies)}</dd>
          </div>
        </dl>
        <p className="care-summary-clinic-contact">
          {[data.clinic.address, data.clinic.phone, data.clinic.email]
            .filter(Boolean)
            .join(' · ') || 'Clinic contact details are not recorded.'}
        </p>
      </header>
      <div className="care-summary-scope">
        <strong>Shared records at the time of this snapshot</strong>
        <p>
          This summary reproduces recorded information and shared clinician instructions. Image and
          PDF files are listed as metadata; their original bytes and private messages are not
          included. Later changes appear after a refresh. Printing keeps the snapshot currently
          displayed.
        </p>
      </div>
      <nav className="care-summary-index" aria-label="Care summary sections">
        {sections.map(([id, label, count]) => (
          <a key={id} href={`#summary-${id}`}>
            {label}
            <span>{count}</span>
          </a>
        ))}
      </nav>

      <SummarySection id="history" title="Shared history" count={data.intakes.length}>
        {data.intakes.map((entry) => (
          <SummaryEntry
            key={entry.id}
            title={entry.concern}
            source="Shared history record · author not recorded"
            date={entry.createdAt}
          >
            <div className="care-summary-details">
              <Detail label="Area affected" value={entry.location} />
              <Detail label="Duration" value={entry.duration} />
              <Detail label="Reported changes" value={entry.symptoms} />
              <Detail label="Triggers" value={entry.triggers} />
              <Detail label="Previous treatment" value={entry.previousTreatment} />
              <Detail label="Medicines or supplements" value={entry.medications} />
              <Detail label="Reported allergies" value={entry.allergies} />
              <Detail label="Questions and goals" value={entry.goals} />
            </div>
          </SummaryEntry>
        ))}
      </SummarySection>

      <SummarySection id="appointments" title="Appointments" count={data.appointments.length}>
        {data.appointments.map((entry) => (
          <SummaryEntry
            key={entry.id}
            title={`${formatDate(entry.date)} · ${entry.time} IST`}
            source={`Appointment record · ${entry.doctorName}`}
            date={entry.createdAt}
            badge={status(entry.status)}
          >
            <div className="care-summary-details">
              <Detail
                label="Consultation"
                value={`${entry.mode === 'online' ? 'Online' : 'In person'} · ${entry.durationMinutes || 30} minutes`}
              />
              <Detail label="Reason for visit" value={entry.reason} />
              <Detail label="Recorded consultation fee" value={money(entry.fee)} />
            </div>
          </SummaryEntry>
        ))}
      </SummarySection>

      <SummarySection id="plans" title="Care plans & reviews" count={data.carePlans.length}>
        {data.carePlans.map((entry) => {
          const completed = (entry.effectiveStatus ?? entry.status) === 'completed';
          const reviewDate = completed
            ? null
            : entry.effectiveFollowUpDate === undefined
              ? entry.followUpDate
              : entry.effectiveFollowUpDate;
          return (
            <SummaryEntry
              key={entry.id}
              title={entry.title}
              source={`Care plan · ${entry.doctorName || 'Clinician name not recorded'}`}
              date={entry.createdAt}
              badge={completed ? 'Completed' : 'Active'}
            >
              <div className="care-summary-details">
                <Detail
                  label="Original treatment dates"
                  value={`${formatDate(entry.startDate)} – ${formatDate(entry.endDate)}`}
                />
                <Detail
                  label="Original follow-up date"
                  value={entry.followUpDate ? formatDate(entry.followUpDate) : null}
                />
                <Detail
                  label="Current follow-up"
                  value={
                    completed
                      ? 'Plan completed'
                      : reviewDate
                        ? formatDate(reviewDate)
                        : 'No next review date recorded'
                  }
                />
              </div>
              <Detail label="Original instructions" value={entry.instructions} />
              {entry.medications.length > 0 && (
                <div className="care-summary-medications">
                  <h4>Recorded regimen</h4>
                  {entry.medications.map((medication, index) => (
                    <div key={index}>
                      <strong>
                        {index + 1}. {medication.name}
                      </strong>
                      <p>{medication.instructions}</p>
                      <p className="care-summary-source">
                        {medication.schedule} · {medication.duration}
                      </p>
                      {medication.warnings && (
                        <Detail label="Clinician’s precautions" value={medication.warnings} />
                      )}
                    </div>
                  ))}
                </div>
              )}
              <div className="care-summary-details">
                <Detail label="What to expect" value={entry.expectations} />
                <Detail label="Important instructions" value={entry.warnings} />
                <Detail label="Recorded estimated cost" value={entry.cost} />
              </div>
              {entry.reviews.length > 0 && (
                <div className="care-summary-events">
                  <h4>Shared follow-up history</h4>
                  {entry.reviews.map((review) => (
                    <div key={review.id} className="care-summary-event">
                      <p className="care-summary-source">
                        {review.source === 'clinical-review'
                          ? 'Clinician review'
                          : 'Plan status update'}{' '}
                        · {review.doctorName} · {timestamp(review.createdAt)} IST
                      </p>
                      <Badge>
                        {review.disposition === 'complete'
                          ? 'Plan completed'
                          : review.disposition === 'visit-requested'
                            ? 'Visit requested'
                            : 'Care continues'}
                      </Badge>
                      <p>{review.patientInstructions}</p>
                      {review.nextReviewDate && (
                        <p>Next review requested: {formatDate(review.nextReviewDate)}</p>
                      )}
                      {review.disposition === 'visit-requested' && (
                        <p className="care-summary-source">
                          A requested visit is not an appointment reservation.
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </SummaryEntry>
          );
        })}
      </SummarySection>

      <SummarySection id="check-ins" title="Patient check-ins" count={data.checkIns.length}>
        {data.checkIns.map((entry) => (
          <SummaryEntry
            key={entry.id}
            title={formatDate(entry.date)}
            source="Patient-reported check-in"
            date={entry.createdAt}
          >
            <p className="care-summary-source">
              Plan:{' '}
              {data.carePlans.find((plan) => plan.id === entry.carePlanId)?.title ||
                'Linked care plan'}
            </p>
            <div className="care-summary-details">
              <Detail
                label="Reported routine"
                value={
                  entry.adherence === 'taken'
                    ? 'Followed the plan'
                    : entry.adherence === 'partial'
                      ? 'Partly followed the plan'
                      : 'Missed the plan'
                }
              />
              <Detail label="Reported feeling" value={entry.feeling} />
              <Detail label="Patient note" value={entry.note} />
            </div>
          </SummaryEntry>
        ))}
      </SummarySection>

      <SummarySection id="investigations" title="Investigations" count={data.investigations.length}>
        {data.investigations.map((entry) => (
          <SummaryEntry
            key={entry.id}
            title={entry.title}
            source={`Investigation request · ${entry.doctorName}`}
            date={entry.createdAt}
            badge={status(entry.status)}
          >
            <div className="care-summary-details">
              <Detail label="Type" value={entry.kind} />
              <Detail label="Reason" value={entry.reason} />
              <Detail
                label="Requested date"
                value={entry.dueDate ? formatDate(entry.dueDate) : null}
              />
              <Detail label="Instructions" value={entry.instructions} />
            </div>
            {entry.cancellationReason && (
              <Detail label="Cancellation reason" value={entry.cancellationReason} />
            )}
            {entry.results.length > 0 && (
              <div className="care-summary-events">
                <h4>Submitted results</h4>
                {entry.results.map((result) => (
                  <div key={result.id} className="care-summary-event">
                    <p className="care-summary-source">
                      Submitted by {result.submittedByName} ({result.submittedByRole}) ·{' '}
                      {timestamp(result.createdAt)} IST
                    </p>
                    <p>{safeValue(result.note)}</p>
                    <p className="care-summary-source">
                      Submitted information is not a clinician interpretation.
                    </p>
                    {result.documentIds.length > 0 && (
                      <ul>
                        {result.documentIds.map((id) => (
                          <li key={id}>
                            <a href={`#summary-document-${id}`}>{documentTitle(id)}</a>
                          </li>
                        ))}
                      </ul>
                    )}
                    {entry.reviews
                      .filter((review) => review.resultId === result.id)
                      .map((review) => (
                        <div className="care-summary-published-review" key={review.id}>
                          <h5>Shared clinician review</h5>
                          <p className="care-summary-source">
                            {review.doctorName} · Recorded {timestamp(review.createdAt)} IST
                            {review.publishedAt
                              ? ` · Shared ${timestamp(review.publishedAt)} IST`
                              : ''}
                          </p>
                          <Detail label="Review" value={review.summary} />
                          <Detail label="Follow-up instructions" value={review.followUp} />
                        </div>
                      ))}
                  </div>
                ))}
              </div>
            )}
          </SummaryEntry>
        ))}
      </SummarySection>

      <SummarySection id="procedures" title="Procedure records" count={data.procedures.length}>
        {data.procedures.map((entry) => (
          <SummaryEntry
            key={entry.id}
            title={entry.title}
            source={`Procedure plan · ${entry.doctorName}`}
            date={entry.createdAt}
            badge={status(entry.status)}
          >
            <div className="care-summary-details">
              <Detail label="Indication" value={entry.indication} />
              <Detail label="Expected benefits" value={entry.benefits} />
              <Detail label="Risks discussed" value={entry.risks} />
              <Detail label="Alternatives discussed" value={entry.alternatives} />
              <Detail label="Planned aftercare" value={entry.aftercare} />
              <Detail label="Recorded estimate" value={entry.estimatedCost} />
            </div>
            {entry.cancellationReason && (
              <Detail label="Cancellation reason" value={entry.cancellationReason} />
            )}
            {entry.agreements.length > 0 && (
              <div className="care-summary-events">
                <h4>Recorded decisions</h4>
                <p className="care-summary-source">
                  These entries document decisions; they are not a validated legal electronic
                  signature.
                </p>
                {entry.agreements.map((agreement) => (
                  <div className="care-summary-event" key={agreement.id}>
                    <Badge>{agreement.decision === 'agreed' ? 'Agreed' : 'Declined'}</Badge>
                    <p className="care-summary-source">
                      Recorded by {agreement.recordedByName} ({agreement.recordedByRole}) ·{' '}
                      {agreement.method} · {timestamp(agreement.createdAt)} IST
                    </p>
                    <p>{safeValue(agreement.note)}</p>
                  </div>
                ))}
              </div>
            )}
            {entry.completion && (
              <div className="care-summary-events">
                <h4>Recorded completion</h4>
                <p className="care-summary-source">
                  {entry.completion.doctorName} · {timestamp(entry.completion.completedAt)} IST
                </p>
                <Detail label="Outcome" value={entry.completion.outcome} />
                <Detail label="Aftercare" value={entry.completion.aftercare} />
              </div>
            )}
          </SummaryEntry>
        ))}
      </SummarySection>

      <SummarySection id="images" title="Images & shared annotations" count={data.images.length}>
        {data.images.map((entry) => (
          <SummaryEntry
            key={entry.id}
            title={entry.caption || 'Untitled clinical image'}
            source={`Image uploaded · ${entry.createdByName || 'Uploader not recorded'}`}
            date={entry.createdAt}
          >
            <p className="care-summary-source">
              {entry.category === 'report' ? 'Photographed report' : 'Clinical image'} ·{' '}
              {entry.mimeType} · {fileSize(entry.sizeBytes)} · Original file not embedded
            </p>
            <Link
              className="text-link care-summary-source-link"
              to={`${recordPath}?tab=images&image=${encodeURIComponent(entry.id)}`}
            >
              View original image and shared annotations →
            </Link>
            {data.imageAnnotations
              .filter((version) => version.imageId === entry.id)
              .map((version) => (
                <div className="care-summary-event" key={version.id}>
                  <h4>Shared image annotation</h4>
                  <p className="care-summary-source">
                    Recorded by {version.doctorName} · {timestamp(version.createdAt)} IST
                    {version.publishedAt
                      ? ` · Shared by ${version.publishedByDoctorName || version.doctorName} on ${timestamp(version.publishedAt)} IST`
                      : ''}
                  </p>
                  <p>{safeValue(version.note)}</p>
                  {version.markers.length > 0 && (
                    <ol>
                      {version.markers.map((marker) => (
                        <li key={marker.id}>
                          {marker.label}{' '}
                          <span className="care-summary-source">({marker.type} marker)</span>
                        </li>
                      ))}
                    </ol>
                  )}
                  <p className="care-summary-source">
                    Marker positions are available in the image viewer and JSON record.
                  </p>
                </div>
              ))}
          </SummaryEntry>
        ))}
      </SummarySection>

      <SummarySection id="documents" title="PDF report metadata" count={data.documents.length}>
        {data.documents.map((entry) => (
          <div id={`summary-document-${entry.id}`} key={entry.id}>
            <SummaryEntry
              title={entry.title}
              source={`PDF uploaded · ${entry.createdByName} (${entry.createdByRole})`}
              date={entry.createdAt}
            >
              <p>{entry.originalName}</p>
              <p className="care-summary-source">
                PDF · {fileSize(entry.sizeBytes)} · Original file not embedded
              </p>
              <a className="text-link care-summary-source-link" href={entry.url} download>
                Open original PDF report →
              </a>
            </SummaryEntry>
          </div>
        ))}
      </SummarySection>

      <SummarySection id="invoices" title="Invoices" count={data.invoices.length}>
        {data.invoices.map((entry) => (
          <SummaryEntry
            key={entry.id}
            title={entry.number}
            source="Clinic billing record"
            date={entry.createdAt}
            badge={entry.status}
          >
            {entry.procedureTitle && (
              <Detail label="Linked procedure" value={entry.procedureTitle} />
            )}
            <div
              className="care-summary-table"
              role="region"
              aria-label={`Items for invoice ${entry.number}`}
              tabIndex={0}
            >
              <table>
                <caption>Recorded invoice items</caption>
                <thead>
                  <tr>
                    <th scope="col">Item</th>
                    <th scope="col">Quantity</th>
                    <th scope="col">Unit price</th>
                    <th scope="col">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {entry.items.map((item, index) => (
                    <tr key={index}>
                      <th scope="row">{item.description}</th>
                      <td>{item.quantity}</td>
                      <td>{money(item.unitAmountPaise / 100)}</td>
                      <td>{money((item.quantity * item.unitAmountPaise) / 100)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="care-summary-invoice-totals">
              <span>
                Total <strong>{money(entry.totalPaise / 100)}</strong>
              </span>
              <span>
                Recorded paid <strong>{money(entry.paidPaise / 100)}</strong>
              </span>
              <span>
                Balance <strong>{money((entry.totalPaise - entry.paidPaise) / 100)}</strong>
              </span>
            </div>
          </SummaryEntry>
        ))}
      </SummarySection>
      <footer className="care-summary-footer">
        {data.clinic.name} · Patient-facing care summary for {data.patient.name} · Generated{' '}
        {timestamp(data.generatedAt)} IST. This is a snapshot of recorded information, not a new
        clinical assessment.
      </footer>
    </div>
  );
}
