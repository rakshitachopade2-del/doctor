import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { FileText } from 'lucide-react';
import type { CareSummary } from '../../shared/care-summary';
import type { CareSummaryCopy } from '../../shared/care-summary-copies';
import type { AllergyStatus } from '../../shared/patient-profile';
import type { InvoiceItem } from '../../shared/operations';
import type { InvoiceHistory } from '../../shared/billing-corrections';
import type { ProcedureAppointmentSnapshot } from '../../shared/procedure-scheduling';
import { formatDate, money } from '../lib';
import { Badge } from './ui';
import { ProcedureTemplateSource } from './ProcedureTemplateSource';

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
const safeValue = (value?: string | null) => value?.trim() || 'Not recorded';
const allergyValue = (status: AllergyStatus | undefined, text: string) =>
  status === 'none-known'
    ? 'No known allergies recorded'
    : status === 'not-recorded'
      ? 'Not recorded'
      : text.trim()
        ? `Recorded allergies: ${text}`
        : 'Not recorded';
const fileSize = (bytes?: number) =>
  bytes === undefined
    ? 'Size not recorded'
    : bytes < 1_048_576
      ? `${Math.max(1, Math.round(bytes / 1024))} KB`
      : `${(bytes / 1_048_576).toFixed(1)} MB`;

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
function SummaryProcedureVisit({
  appointment,
  linked,
  completed = false,
  historical = false,
}: {
  appointment: ProcedureAppointmentSnapshot | null | undefined;
  linked: boolean;
  completed?: boolean;
  historical?: boolean;
}) {
  const [hours, minutes] = (appointment?.time ?? '00:00').split(':').map(Number);
  const end = hours * 60 + minutes + (appointment?.durationMinutes ?? 0);
  return (
    <div className="care-summary-events care-summary-procedure-visit">
      <h4>{completed ? 'Visit recorded at completion' : 'Linked visit at summary generation'}</h4>
      {appointment ? (
        <div className="care-summary-details">
          <Detail
            label="Visit date and time"
            value={`${formatDate(appointment.date)} · ${appointment.time}–${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')} IST · ${appointment.durationMinutes} minutes`}
          />
          <Detail label="Visit clinician" value={appointment.doctorName} />
          <Detail
            label="Visit format"
            value={`${appointment.mode === 'online' ? 'Online visit' : 'In-person visit'}${appointment.durationPolicy === 'custom' ? ' · Custom length' : ''}`}
          />
          <Detail label="Appointment status" value={status(appointment.status)} />
        </div>
      ) : (
        <p>
          {completed
            ? 'No appointment was linked when completion was recorded.'
            : linked
              ? 'Linked visit details were unavailable when this summary was generated.'
              : historical
                ? 'No appointment was linked to this procedure in this copy.'
                : 'No appointment is currently linked to this procedure.'}
        </p>
      )}
      {!completed && <p>A visit link does not change the recorded procedure decision.</p>}
    </div>
  );
}
function SummaryCharges({ items, title }: { items: InvoiceItem[]; title: string }) {
  if (!items.length) return <p className="care-summary-empty">{title}: no charges recorded.</p>;
  return (
    <div className="care-summary-table" role="region" aria-label={title} tabIndex={0}>
      <table>
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col">Quantity</th>
            <th scope="col">Unit price</th>
            <th scope="col">Amount</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
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
  );
}
function SummaryInvoiceHistory({ history }: { history: InvoiceHistory }) {
  return (
    <div className="care-summary-events">
      <h4>Original issued charges</h4>
      <SummaryCharges items={history.issuedCharges.items} title="Originally issued invoice items" />
      <Detail label="Original issued total" value={money(history.issuedCharges.totalPaise / 100)} />
      {history.corrections.length > 0 && (
        <>
          <h4>Shared charge correction history</h4>
          {history.corrections.map((correction) => (
            <div key={correction.id} className="care-summary-event">
              <h5>Charge correction</h5>
              <p className="care-summary-source">
                {correction.createdByName} · {timestamp(correction.createdAt)} IST
              </p>
              <Detail label="Reason shared with patient" value={correction.reason} />
              <SummaryCharges items={correction.before.items} title="Charges before correction" />
              <Detail
                label="Total before correction"
                value={money(correction.before.totalPaise / 100)}
              />
              <SummaryCharges items={correction.after.items} title="Charges after correction" />
              <Detail
                label="Total after correction"
                value={money(correction.after.totalPaise / 100)}
              />
              <Detail
                label="Paid amount recorded at this correction"
                value={money(correction.after.paidPaise / 100)}
              />
            </div>
          ))}
        </>
      )}
      {history.reversals.length > 0 && (
        <>
          <h4>Reversed payment-entry history</h4>
          <p>
            These updates correct erroneous payment records. They do not return money or record a
            refund.
          </p>
          {history.reversals.map((reversal) => (
            <div key={reversal.id} className="care-summary-event">
              <h5>Erroneous payment entry reversed</h5>
              <p className="care-summary-source">
                {reversal.createdByName} · {timestamp(reversal.createdAt)} IST
              </p>
              <Detail label="Reason shared with patient" value={reversal.reason} />
              <div className="care-summary-details">
                <Detail label="Recorded entry amount" value={money(reversal.amountPaise / 100)} />
                <Detail
                  label="Paid total before reversal"
                  value={money(reversal.beforePaidPaise / 100)}
                />
                <Detail
                  label="Paid total after reversal"
                  value={money(reversal.afterPaidPaise / 100)}
                />
              </div>
            </div>
          ))}
        </>
      )}
      {(history.refunds ?? []).length > 0 && (
        <>
          <h4>Recorded external refunds</h4>
          <p>
            These records confirm that staff recorded money returned outside Derma. The application
            did not transfer money. Invoice charges were unchanged by these refund records.
          </p>
          {history.refunds.map((refund) => (
            <div key={refund.id} className="care-summary-event care-summary-refund">
              <h5>External refund recorded</h5>
              <p className="care-summary-source">
                {refund.createdByName} · {timestamp(refund.createdAt)} IST
              </p>
              <Detail label="Reason shared with patient" value={refund.reason} />
              <div className="care-summary-details">
                <Detail label="Recorded refund amount" value={money(refund.amountPaise / 100)} />
                <Detail label="Refund method" value={refund.method.toUpperCase()} />
                <Detail
                  label="Refund reference"
                  value={refund.reference || 'Not recorded (cash)'}
                />
                <Detail label="Original payment entry" value={refund.paymentId.slice(-8)} />
                <Detail
                  label="Net paid before this refund"
                  value={money(refund.beforePaidPaise / 100)}
                />
                <Detail
                  label="Net paid after this refund"
                  value={money(refund.afterPaidPaise / 100)}
                />
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
export function SummaryDocument({
  data,
  recordPath,
  copy,
}: {
  data: CareSummary;
  recordPath: string;
  copy?: CareSummaryCopy;
}) {
  const sections = [
    ['allergies', 'Allergy record history', data.allergyHistory.length],
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
          {copy && (
            <p className="care-summary-snapshot care-summary-copy-provenance">
              Saved copy · {timestamp(copy.savedAt)} IST · Saved by {copy.savedBy.name} (
              {copy.savedBy.role})
            </p>
          )}
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
            <dt>{copy ? 'Allergy record at copy time' : 'Current allergy record'}</dt>
            <dd>{allergyValue(data.patient.allergyStatus, data.patient.allergies)}</dd>
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
          included.{' '}
          {copy
            ? 'This saved copy stays unchanged. Open Current summary to see later updates. Printing keeps this saved copy.'
            : 'Later changes appear after a refresh. Printing keeps the snapshot currently displayed.'}
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

      <SummarySection
        id="allergies"
        title="Allergy record history"
        count={data.allergyHistory.length}
      >
        {data.allergyHistory.map((entry) => (
          <SummaryEntry
            key={entry.id}
            title={allergyValue(entry.after.status, entry.after.text)}
            source={`Allergy record updated · ${entry.doctorName}`}
            date={entry.createdAt}
          >
            <Detail
              label="Previous allergy record"
              value={allergyValue(entry.before.status, entry.before.text)}
            />
            <Detail label="Reason shared with patient" value={entry.reason} />
          </SummaryEntry>
        ))}
      </SummarySection>

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
                  label={copy ? 'Follow-up recorded in this copy' : 'Current follow-up'}
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
            <ProcedureTemplateSource source={entry.templateSource} />
            <SummaryProcedureVisit
              historical={!!copy}
              appointment={entry.scheduledAppointment}
              linked={
                (entry.effectiveAppointmentId === undefined
                  ? entry.appointmentId
                  : entry.effectiveAppointmentId) !== null
              }
            />
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
                {entry.completion.appointment !== undefined && (
                  <SummaryProcedureVisit
                    appointment={entry.completion.appointment}
                    linked={entry.completion.appointment !== null}
                    completed
                  />
                )}
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
              {copy
                ? 'Open current image record →'
                : 'View original image and shared annotations →'}
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
                    {copy
                      ? 'The saved marker positions are in this copy’s JSON. The current image viewer may include annotations added later.'
                      : 'Marker positions are available in the image viewer and JSON record.'}
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
            source="Clinic billing record · Originally issued"
            date={entry.createdAt}
            badge={entry.status === 'no-charge' ? 'No charges' : entry.status}
          >
            <Detail label="Name recorded on invoice" value={entry.patientName} />
            {entry.procedureTitle && (
              <Detail label="Linked procedure" value={entry.procedureTitle} />
            )}
            <SummaryCharges
              items={entry.items}
              title={`${copy ? 'Charges recorded in this copy' : 'Current charges'} for ${entry.number}`}
            />
            <div className="care-summary-invoice-totals">
              <span>
                Total <strong>{money(entry.totalPaise / 100)}</strong>
              </span>
              <span>
                Recorded paid, excluding reversed entries{' '}
                <strong>{money(entry.paidPaise / 100)}</strong>
              </span>
              <span>
                Balance <strong>{money((entry.totalPaise - entry.paidPaise) / 100)}</strong>
              </span>
            </div>
            {data.invoiceHistories
              .filter((history) => history.invoiceId === entry.id)
              .map((history) => (
                <SummaryInvoiceHistory key={history.invoiceId} history={history} />
              ))}
          </SummaryEntry>
        ))}
      </SummarySection>
      <footer className="care-summary-footer">
        {data.clinic.name} · Patient-facing care summary for {data.patient.name} · Generated{' '}
        {timestamp(data.generatedAt)} IST. This is a snapshot of recorded information, not a new
        clinical assessment.
        {copy && ' This saved copy does not include later changes.'}
      </footer>
    </div>
  );
}
