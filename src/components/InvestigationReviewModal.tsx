import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Download, FileText } from 'lucide-react';
import type { Investigation, InvestigationResult } from '../../shared/clinical';
import type { InvestigationReviewContext } from '../../shared/investigation-worklist';
import type { PatientDocument } from '../../shared/documents';
import { api, ApiError, formatDate, useResource, useSession, useToast } from '../lib';
import { Badge, ErrorState, Field, Loading, Modal } from './ui';
import './investigation-review.css';

type ReviewBody = {
  resultId: string;
  summary: string;
  followUp: string;
  publishToPatient: boolean;
  expectedRevision: string;
  requestId: string;
};
type Props = {
  investigationId: string;
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
function checkedContext(value: unknown, id: string): InvestigationReviewContext {
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

export function InvestigationReviewModal(props: Props) {
  const { session } = useSession();
  return <ReviewDialog key={`${session.user?.id}:${props.investigationId}`} {...props} />;
}

function ReviewDialog({ investigationId, onClose, onSaved }: Props) {
  const { session } = useSession();
  const toast = useToast();
  const canReview = !!session.user?.doctorId && ['doctor', 'admin'].includes(session.user.role);
  const [source, setSource] = useState<InvestigationReviewContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [summary, setSummary] = useState('');
  const [followUp, setFollowUp] = useState('');
  const [publish, setPublish] = useState(false);
  const [phase, setPhase] = useState<'editing' | 'conflict' | 'uncertain' | 'saved'>('editing');
  const [attempt, setAttempt] = useState<ReviewBody | null>(null);
  const [reviewed, setReviewed] = useState<InvestigationReviewContext | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [closeBlocked, setCloseBlocked] = useState(false);
  const mounted = useRef(false);
  const pending = useRef(false);
  const loadSequence = useRef(0);
  const path = `/api/investigations/${encodeURIComponent(investigationId)}/review-context`;
  const documentsResource = useResource<unknown>(
    source ? `/api/documents?patientId=${encodeURIComponent(source.patientId)}` : null,
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
  async function loadInitial() {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setLoadError('');
    try {
      const next = checkedContext(await api<unknown>(path), investigationId);
      if (mounted.current && sequence === loadSequence.current) setSource(next);
    } catch (problem) {
      if (mounted.current && sequence === loadSequence.current) setLoadError(errorText(problem));
    } finally {
      if (mounted.current && sequence === loadSequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    void loadInitial();
    return () => {
      mounted.current = false;
      loadSequence.current++;
    };
  }, []);
  function close() {
    if (pending.current || phase === 'uncertain') {
      setCloseBlocked(true);
      return;
    }
    onClose();
  }
  async function refreshContext() {
    if (pending.current || refreshing) return;
    setRefreshing(true);
    setError('');
    try {
      const current = checkedContext(await api<unknown>(path), investigationId);
      if (mounted.current) {
        setReviewed(current);
        setPublish(false);
      }
    } catch (problem) {
      if (mounted.current) setError(errorText(problem));
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }
  function acceptContext() {
    if (!reviewed) return;
    setSource(reviewed);
    setReviewed(null);
    setAttempt(null);
    setPublish(false);
    setError('');
    setPhase('editing');
    setCloseBlocked(false);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (
      !canReview ||
      !source?.latestResultId ||
      pending.current ||
      phase === 'conflict' ||
      phase === 'saved'
    )
      return;
    if (!attempt && (!summary.trim() || !followUp.trim())) {
      setError('Enter your reviewed findings and next steps before saving.');
      return;
    }
    const submitted = attempt ?? {
      resultId: source.latestResultId,
      summary: summary.trim(),
      followUp: followUp.trim(),
      publishToPatient: publish,
      expectedRevision: source.revision,
      requestId: crypto.randomUUID(),
    };
    setAttempt(submitted);
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const response = checkedInvestigation(
        await api<unknown>(`/api/investigations/${encodeURIComponent(investigationId)}/reviews`, {
          method: 'POST',
          body: submitted,
        }),
        investigationId,
      );
      if (
        response.patientId !== source.patientId ||
        response.doctorId !== source.investigation.doctorId ||
        !response.reviews.some(
          (review) =>
            !source.investigation.reviews.some((previous) => previous.id === review.id) &&
            review.resultId === submitted.resultId &&
            review.summary === submitted.summary &&
            review.followUp === submitted.followUp &&
            review.doctorId === session.user?.doctorId &&
            (!submitted.publishToPatient || review.publishedAt !== null),
        )
      )
        throw new Error(
          'The response did not confirm this new review. Retry the same request to check its outcome.',
        );
    } catch (problem) {
      if (mounted.current) {
        setError(errorText(problem));
        if (
          problem instanceof ApiError &&
          problem.status === 409 &&
          !/request.*(?:already|different|used)|idempot/i.test(errorText(problem))
        ) {
          setPhase('conflict');
          setReviewed(null);
          setPublish(false);
        } else if (
          problem instanceof ApiError &&
          [400, 403, 404, 422, 429].includes(problem.status)
        ) {
          setPhase('editing');
          setAttempt(null);
        } else setPhase('uncertain');
      }
      return;
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
    if (!mounted.current) return;
    setAttempt(null);
    setPhase('saved');
    setCloseBlocked(false);
    toast(
      submitted.publishToPatient
        ? 'Clinical review saved and shared with the patient.'
        : 'Clinical review saved in the clinic workspace.',
    );
    try {
      await onSaved();
    } catch {
      if (mounted.current)
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
                      without creating it twice. This draft is held only while this page remains
                      open; keep the page open until the outcome is confirmed.
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
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={close}
                    disabled={busy || phase === 'uncertain'}
                  >
                    Cancel review
                  </button>
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
