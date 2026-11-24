import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { Download, FileText } from 'lucide-react';
import type { Investigation, InvestigationResult } from '../../shared/clinical';
import type { InvestigationReviewContext } from '../../shared/investigation-worklist';
import type { InvestigationReviewCommand } from '../../shared/investigation-review-recording';
import type { PatientDocument } from '../../shared/documents';
import { api, ApiError, formatDate, useSession, useToast } from '../lib';
import { Badge, ErrorState, Field, Loading, Modal } from './ui';
import {
  useAppointmentBookingData,
  useAppointmentBookingGuard,
} from './appointment-booking-helpers';
import { usePendingCareSubmissions } from './pending-care-submissions';
import './investigation-review.css';

export type InvestigationReviewAttempt = {
  actorId: string;
  source: InvestigationReviewContext;
  command: InvestigationReviewCommand;
};
type Props = {
  investigationId: string;
  patientId?: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
};
const errorText = (problem: unknown) =>
  problem instanceof Error
    ? problem.message
    : 'The record could not be confirmed. Please try again.';
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const nonempty = (value: unknown): value is string => text(value) && value.trim().length > 0;
const date = (value: unknown) => nonempty(value) && Number.isFinite(Date.parse(value));
const stamp = (value: string) =>
  new Date(value).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

function checkedInvestigation(value: unknown, id: string): Investigation {
  if (
    !record(value) ||
    value.id !== id ||
    !nonempty(value.patientId) ||
    !nonempty(value.title) ||
    !nonempty(value.doctorId) ||
    !nonempty(value.doctorName) ||
    !['laboratory', 'pathology', 'imaging', 'other'].includes(value.kind as string) ||
    !['ordered', 'result-received', 'reviewed', 'cancelled'].includes(value.status as string) ||
    !text(value.reason) ||
    !text(value.instructions) ||
    !date(value.createdAt) ||
    !(value.dueDate === null || date(value.dueDate)) ||
    !(value.cancellationReason === null || text(value.cancellationReason)) ||
    !Array.isArray(value.results) ||
    !Array.isArray(value.reviews)
  )
    throw new Error(
      'The response did not include a complete investigation. Try again to load the record.',
    );
  const results = value.results;
  if (
    !results.every(
      (result) =>
        record(result) &&
        nonempty(result.id) &&
        result.investigationId === id &&
        text(result.note) &&
        nonempty(result.submittedByName) &&
        nonempty(result.submittedById) &&
        ['doctor', 'admin', 'patient', 'receptionist'].includes(result.submittedByRole as string) &&
        date(result.createdAt) &&
        Array.isArray(result.documentIds) &&
        result.documentIds.every(nonempty),
    ) ||
    new Set(results.map((result) => result.id)).size !== results.length ||
    !value.reviews.every(
      (review) =>
        record(review) &&
        nonempty(review.id) &&
        review.investigationId === id &&
        results.some((result) => result.id === review.resultId) &&
        nonempty(review.summary) &&
        text(review.followUp) &&
        nonempty(review.doctorId) &&
        nonempty(review.doctorName) &&
        date(review.createdAt) &&
        (review.publishedAt === null || date(review.publishedAt)),
    ) ||
    new Set(value.reviews.map((review) => review.id)).size !== value.reviews.length
  )
    throw new Error(
      'The response did not include complete result and review history. Try again to load the record.',
    );
  return value as unknown as Investigation;
}
export function checkedInvestigationContext(
  value: unknown,
  id: string,
): InvestigationReviewContext {
  if (!record(value)) throw new Error('The review context could not be loaded. Try again.');
  const investigation = checkedInvestigation(value.investigation, id);
  if (
    value.investigationId !== id ||
    value.patientId !== investigation.patientId ||
    !nonempty(value.patientName) ||
    !nonempty(value.ownerDoctorName) ||
    !nonempty(value.ownerDoctorId) ||
    typeof value.ownerAvailable !== 'boolean' ||
    value.latestResultId !== (investigation.results.at(-1)?.id ?? null) ||
    value.status !== investigation.status ||
    !text(value.revision) ||
    !/^[a-f0-9]{64}$/.test(value.revision)
  )
    throw new Error('The response did not include consistent review context. Try again.');
  return value as unknown as InvestigationReviewContext;
}

function ResultSource({
  result,
  investigation,
  documents,
}: {
  result: InvestigationResult;
  investigation: Investigation;
  documents: PatientDocument[];
}) {
  const reviews = investigation.reviews.filter((review) => review.resultId === result.id);
  return (
    <article className="irm-result-source">
      <p className="irm-attribution">
        Submitted by {result.submittedByName} ({result.submittedByRole}) · {stamp(result.createdAt)}{' '}
        IST
      </p>
      <p className="pre-line">{result.note || 'No text note; see the attached report.'}</p>
      {result.documentIds.length > 0 && (
        <div className="irm-documents">
          {result.documentIds.map((id) => {
            const document = documents.find((entry) => entry.id === id);
            return document ? (
              <a
                key={id}
                className="button button-secondary button-small"
                href={`/api/documents/${encodeURIComponent(id)}/file`}
                download
              >
                <Download size={14} /> {document.title}
                <span className="sr-only"> PDF report</span>
              </a>
            ) : (
              <span key={id} className="muted small">
                <FileText size={14} /> Attached report metadata unavailable
              </span>
            );
          })}
        </div>
      )}
      {reviews.length > 0 && (
        <section className="irm-prior-reviews" aria-label="Existing reviews of this result">
          <h4>Existing reviews of this result</h4>
          {reviews.map((review) => (
            <article key={review.id} className="irm-prior-review">
              <div className="row between">
                <strong>{review.doctorName}</strong>
                <Badge tone={review.publishedAt ? 'green' : 'neutral'}>
                  {review.publishedAt ? 'Shared with patient' : 'Clinic only'}
                </Badge>
              </div>
              <p className="irm-attribution">
                Recorded {stamp(review.createdAt)} IST
                {review.publishedAt ? ` · Shared ${stamp(review.publishedAt)} IST` : ''}
              </p>
              <p className="pre-line">{review.summary}</p>
              {review.followUp && (
                <p className="pre-line">
                  <strong>Next steps: </strong>
                  {review.followUp}
                </p>
              )}
            </article>
          ))}
        </section>
      )}
    </article>
  );
}

function reviewConfirmed(value: unknown, attempt: InvestigationReviewAttempt) {
  const { command, source, actorId } = attempt;
  const current = checkedInvestigation(value, command.investigationId);
  const receipt = record(value) && record(value.receipt) ? value.receipt : null;
  const original = receipt?.review;
  if (!receipt || !record(original)) return false;
  const live = current.reviews.find((review) => review.id === original.id);
  return (
    current.patientId === command.patientId &&
    current.doctorId === source.investigation.doctorId &&
    receipt.actorId === actorId &&
    receipt.requestId === command.requestId &&
    receipt.investigationId === command.investigationId &&
    receipt.patientId === command.patientId &&
    receipt.expectedRevision === command.expectedRevision &&
    receipt.reviewedByRole === command.reviewedByRole &&
    live !== undefined &&
    !source.investigation.reviews.some((previous) => previous.id === live.id) &&
    live.investigationId === original.investigationId &&
    live.resultId === original.resultId &&
    live.resultId === command.resultId &&
    live.summary === original.summary &&
    live.summary === command.summary &&
    live.followUp === original.followUp &&
    live.followUp === command.followUp &&
    live.doctorId === original.doctorId &&
    live.doctorId === command.doctorId &&
    live.doctorName === original.doctorName &&
    live.createdAt === original.createdAt &&
    (command.publishToPatient
      ? date(original.publishedAt) && original.publishedAt === live.publishedAt
      : original.publishedAt === null)
  );
}
function refusalMessage(problem: unknown, attempt: InvestigationReviewAttempt) {
  if (!(problem instanceof ApiError) || problem.status !== 409) return null;
  const report = problem.responseData;
  if (
    !record(report) ||
    report.code !== 'INVESTIGATION_REVIEW_NOT_RECORDED' ||
    report.actorId !== attempt.actorId ||
    !nonempty(report.message) ||
    !record(report.command)
  )
    return null;
  const received = report.command;
  return Object.keys(received).length === Object.keys(attempt.command).length &&
    Object.entries(attempt.command).every(([key, value]) => received[key] === value)
    ? report.message
    : null;
}
export function PendingInvestigationReviews({
  patientId,
  open,
}: {
  patientId?: string;
  open: (id: string) => void;
}) {
  const {
    session: { user },
  } = useSession();
  const { investigationReviews } = usePendingCareSubmissions();
  if (!user?.doctorId || user.mustChangePassword) return null;
  return (
    <>
      {Array.from(investigationReviews.values())
        .filter(
          ({ actorId, command }) =>
            actorId === user.id &&
            command.reviewedByRole === user.role &&
            command.doctorId === user.doctorId &&
            (!patientId || command.patientId === patientId),
        )
        .map(({ command, source }) => (
          <button
            key={command.investigationId}
            type="button"
            className="button button-secondary"
            onClick={() => open(command.investigationId)}
          >
            Resume clinical review: {source.investigation.title}
          </button>
        ))}
    </>
  );
}
export function InvestigationReviewModal(props: Props) {
  const { session } = useSession();
  const location = useLocation();
  return (
    <ReviewDialog
      key={JSON.stringify([
        session.user?.id,
        session.user?.role,
        session.user?.doctorId,
        session.csrfToken,
        location.key,
        props.investigationId,
        props.patientId,
      ])}
      {...props}
    />
  );
}
function ReviewDialog({ investigationId, patientId, onClose, onSaved }: Props) {
  const {
    session: { user },
  } = useSession();
  const toast = useToast();
  const capture = useAppointmentBookingGuard();
  const { investigationReviews } = usePendingCareSubmissions();
  const [stored] = useState(() => {
    const entry = investigationReviews.get(investigationId);
    return entry &&
      entry.actorId === user?.id &&
      entry.command.doctorId === user.doctorId &&
      entry.command.reviewedByRole === user.role &&
      (!patientId || entry.command.patientId === patientId)
      ? entry
      : null;
  });
  const role = user?.role === 'doctor' || user?.role === 'admin' ? user.role : null;
  const canReview = !user?.mustChangePassword && !!user?.doctorId && !!role;
  const [source, setSource] = useState<InvestigationReviewContext | null>(stored?.source ?? null);
  const [loading, setLoading] = useState(!stored);
  const [loadError, setLoadError] = useState('');
  const [summary, setSummary] = useState(stored?.command.summary ?? '');
  const [followUp, setFollowUp] = useState(stored?.command.followUp ?? '');
  const [publish, setPublish] = useState(stored?.command.publishToPatient ?? false);
  const [phase, setPhase] = useState<'editing' | 'conflict' | 'uncertain' | 'saved'>(
    stored ? 'uncertain' : 'editing',
  );
  const [reviewed, setReviewed] = useState<InvestigationReviewContext | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [closeBlocked, setCloseBlocked] = useState(false);
  const dismissed = useRef(false);
  const pending = useRef(false);
  const loadSequence = useRef(0);
  const path = `/api/investigations/${encodeURIComponent(investigationId)}/review-context`;
  const documentsResource = useAppointmentBookingData<unknown>(
    source ? `/api/documents?patientId=${encodeURIComponent(source.patientId)}` : null,
    (value) => value,
  );
  let documents: PatientDocument[] = [];
  let documentsError = documentsResource.error;
  if (documentsResource.data !== null && !documentsError) {
    if (
      Array.isArray(documentsResource.data) &&
      documentsResource.data.every(
        (entry) =>
          record(entry) &&
          nonempty(entry.id) &&
          entry.patientId === source?.patientId &&
          nonempty(entry.title),
      )
    ) {
      documents = documentsResource.data as PatientDocument[];
    } else
      documentsError = 'Attached report metadata could not be read. Retry loading the reports.';
  }
  function origin() {
    const isCurrent = capture();
    return () => isCurrent() && !dismissed.current;
  }
  async function readContext(isCurrent: () => boolean) {
    const result = checkedInvestigationContext(
      await api<unknown>(path, { isCurrent }),
      investigationId,
    );
    if (
      (patientId && result.patientId !== patientId) ||
      (source &&
        (result.patientId !== source.patientId ||
          result.investigation.doctorId !== source.investigation.doctorId))
    )
      throw new Error('The response did not confirm the reviewed patient and investigation.');
    return result;
  }
  async function loadInitial() {
    const sequence = ++loadSequence.current,
      isOrigin = origin();
    const current = () => isOrigin() && sequence === loadSequence.current;
    setLoading(true);
    setLoadError('');
    try {
      const next = await readContext(current);
      if (current()) setSource(next);
    } catch (problem) {
      if (current()) setLoadError(errorText(problem));
    } finally {
      if (current()) setLoading(false);
    }
  }
  useEffect(() => {
    if (!stored) void loadInitial();
    return () => {
      loadSequence.current++;
    };
  }, []);
  function dismiss() {
    dismissed.current = true;
    onClose();
  }
  function close() {
    if (pending.current || phase === 'uncertain') {
      setCloseBlocked(true);
      return;
    }
    dismiss();
  }
  async function refreshContext() {
    if (pending.current || refreshing) return;
    const current = origin();
    setRefreshing(true);
    setError('');
    try {
      const next = await readContext(current);
      if (
        next.revision === source?.revision &&
        next.latestResultId === source.latestResultId &&
        next.status !== 'cancelled'
      )
        throw new Error(
          'The response did not confirm the changed investigation. Refresh the latest record again.',
        );
      if (current()) {
        setReviewed(next);
        setPublish(false);
      }
    } catch (problem) {
      if (current()) setError(errorText(problem));
    } finally {
      if (current()) setRefreshing(false);
    }
  }
  function acceptContext() {
    if (!reviewed) return;
    setSource(reviewed);
    setReviewed(null);
    setPublish(false);
    setError('');
    setPhase('editing');
    setCloseBlocked(false);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (
      !canReview ||
      !role ||
      !user?.doctorId ||
      !source?.latestResultId ||
      pending.current ||
      phase === 'conflict' ||
      phase === 'saved'
    )
      return;
    const existing = investigationReviews.get(investigationId);
    if (!existing && (!summary.trim() || !followUp.trim())) {
      setError('Enter your reviewed findings and next steps before saving.');
      return;
    }
    if (
      existing &&
      (existing.actorId !== user.id ||
        existing.command.reviewedByRole !== user.role ||
        existing.command.doctorId !== user.doctorId ||
        existing.command.patientId !== source.patientId)
    )
      return;
    const attempt: InvestigationReviewAttempt = existing ?? {
      source,
      actorId: user.id,
      command: {
        resultId: source.latestResultId,
        summary: summary.trim(),
        followUp: followUp.trim(),
        publishToPatient: publish,
        expectedRevision: source.revision,
        requestId: crypto.randomUUID(),
        doctorId: user.doctorId,
        reviewedByRole: role,
        patientId: source.patientId,
        investigationId,
      },
    };
    investigationReviews.set(investigationId, attempt);
    const isOrigin = origin();
    const current = () => isOrigin() && investigationReviews.get(investigationId) === attempt;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const response = await api<unknown>(
        `/api/investigations/${encodeURIComponent(investigationId)}/reviews`,
        {
          method: 'POST',
          body: attempt.command,
          isCurrent: current,
        },
      );
      if (!current()) return;
      if (!reviewConfirmed(response, attempt))
        throw new Error(
          'The response did not confirm this new review. Retry the same request to check its outcome.',
        );
    } catch (problem) {
      if (current()) {
        const refused = refusalMessage(problem, attempt);
        setError(refused ?? errorText(problem));
        if (refused) {
          investigationReviews.delete(investigationId);
          setPhase('conflict');
          setReviewed(null);
          setPublish(false);
          setCloseBlocked(false);
        } else setPhase('uncertain');
      }
      return;
    } finally {
      pending.current = false;
      if (isOrigin()) setBusy(false);
    }
    if (!current()) return;
    investigationReviews.delete(investigationId);
    setPhase('saved');
    setCloseBlocked(false);
    toast(
      attempt.command.publishToPatient
        ? 'Clinical review saved and shared with the patient.'
        : 'Clinical review saved in the clinic workspace.',
    );
    try {
      await onSaved();
    } catch {
      if (isOrigin())
        setError('The review was saved. Close this dialog and refresh the record to see it.');
    }
  }
  const displayed = reviewed ?? source;
  const investigation = displayed?.investigation;
  const latest = investigation?.results.at(-1);
  const locked = busy || phase !== 'editing';
  return (
    <Modal title="Review investigation findings" onClose={close}>
      <div className="stack investigation-review-dialog">
        {loading ? (
          <Loading />
        ) : loadError || !source ? (
          <ErrorState
            message={loadError || 'The review context is unavailable.'}
            retry={loadInitial}
          />
        ) : (
          <>
            {displayed && investigation && (
              <section
                className="irm-context"
                aria-label={reviewed ? 'Latest record to review' : 'Investigation review context'}
              >
                {reviewed && <h3>Latest record to review</h3>}
                <h3>{investigation.title}</h3>
                <p>
                  <strong>{displayed.patientName}</strong> · Requested by {investigation.doctorName}
                </p>
                <p className="muted small">
                  Current owner: {displayed.ownerDoctorName}
                  {displayed.ownerAvailable ? '' : ' · No active linked account'}
                </p>
                <p className="pre-line">
                  <strong>Reason: </strong>
                  {investigation.reason}
                </p>
                {investigation.instructions && (
                  <p className="pre-line">
                    <strong>Patient instructions: </strong>
                    {investigation.instructions}
                  </p>
                )}
                {investigation.dueDate && (
                  <p className="irm-attribution">
                    Original requested result date: {formatDate(investigation.dueDate)}. This is not
                    a clinical urgency rating or a review deadline.
                  </p>
                )}
                {latest ? (
                  <>
                    <h4>Latest submitted result</h4>
                    <ResultSource
                      result={latest}
                      investigation={investigation}
                      documents={documents}
                    />
                  </>
                ) : (
                  <p className="notice">No result has been submitted for review.</p>
                )}
                {investigation.results.length > 1 && (
                  <details className="irm-earlier-results">
                    <summary>Earlier result history ({investigation.results.length - 1})</summary>
                    {investigation.results
                      .slice(0, -1)
                      .reverse()
                      .map((result) => (
                        <ResultSource
                          key={result.id}
                          result={result}
                          investigation={investigation}
                          documents={documents}
                        />
                      ))}
                  </details>
                )}
                {documentsResource.loading &&
                  investigation.results.some((result) => result.documentIds.length > 0) && (
                    <p role="status" className="muted small">
                      Loading attached report details…
                    </p>
                  )}
                {documentsError && (
                  <ErrorState message={documentsError} retry={documentsResource.reload} />
                )}
              </section>
            )}
            {source.investigation.status === 'cancelled' && (
              <p className="notice">
                This order is cancelled. Its existing result and review history remain available;
                new reviews cannot be saved.
              </p>
            )}
            {!canReview ? (
              <p className="notice">
                A linked clinician account is required to record a clinical review. You can read the
                existing record.
              </p>
            ) : source.latestResultId &&
              source.investigation.status !== 'cancelled' &&
              phase !== 'saved' ? (
              <form className="stack irm-review-form" onSubmit={save}>
                <Field label="Reviewed findings">
                  <textarea
                    required
                    rows={4}
                    maxLength={8000}
                    value={summary}
                    disabled={locked}
                    onChange={(event) => setSummary(event.target.value)}
                  />
                </Field>
                <Field label="Follow-up and next steps">
                  <textarea
                    required
                    rows={3}
                    maxLength={8000}
                    value={followUp}
                    disabled={locked}
                    onChange={(event) => setFollowUp(event.target.value)}
                  />
                </Field>
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    checked={publish}
                    disabled={locked}
                    onChange={(event) => setPublish(event.target.checked)}
                  />
                  <span>
                    Share this clinician-reviewed summary and next steps with the patient now.
                  </span>
                </label>
                <p className="muted small">
                  Leave unchecked to keep this review in the clinic workspace. The original result
                  and earlier reviews remain unchanged.
                </p>
                {error && (
                  <p className="form-error" role="alert">
                    {error}
                  </p>
                )}
                {phase === 'conflict' && (
                  <div className="notice irm-conflict">
                    <strong>Review the latest record before saving.</strong>
                    <p>
                      A result, review, publication or owner may have changed. Your written findings
                      and next steps are preserved.
                    </p>
                    {reviewed ? (
                      <>
                        <p>
                          Read the latest context above before applying this draft. Sharing with the
                          patient is unchecked again.
                        </p>
                        <button
                          type="button"
                          className="button button-secondary"
                          onClick={acceptContext}
                        >
                          I reviewed the latest record; keep my draft
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="button button-secondary"
                        onClick={refreshContext}
                        disabled={refreshing}
                      >
                        {refreshing ? 'Loading latest record…' : 'Refresh latest investigation'}
                      </button>
                    )}
                  </div>
                )}
                {phase === 'uncertain' && (
                  <div className="notice irm-uncertain">
                    <strong>The save outcome could not be confirmed.</strong>
                    <p>
                      Your exact request is locked. Retry it to confirm whether the review was saved
                      without creating it twice. You can resume it from the investigation worklist
                      or this patient's chart during this signed-in session.
                    </p>
                  </div>
                )}
                {closeBlocked && (
                  <p className="notice" role="status">
                    {busy
                      ? 'Wait for the save response before closing.'
                      : 'Confirm the pending save with Retry same request before closing this dialog.'}
                  </p>
                )}
                <div className="irm-actions">
                  <button
                    type="submit"
                    className="button button-primary"
                    disabled={busy || phase === 'conflict'}
                  >
                    {busy
                      ? 'Saving clinical review…'
                      : phase === 'uncertain'
                        ? 'Retry same request'
                        : 'Save clinical review'}
                  </button>
                  {busy || phase === 'uncertain' ? (
                    <button type="button" className="button button-secondary" onClick={dismiss}>
                      Close for now
                    </button>
                  ) : (
                    <button type="button" className="button button-secondary" onClick={close}>
                      Cancel review
                    </button>
                  )}
                </div>
              </form>
            ) : null}
            {phase === 'saved' && (
              <div className="notice" role="status">
                <strong>Clinical review saved.</strong>
                <p>{error || 'The review is part of the clinical record.'}</p>
                <button className="button button-secondary" onClick={onClose}>
                  Close review
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
