import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarDays, CheckCircle2, History, MessageCircle } from 'lucide-react';
import type { CarePlan } from '../../shared/types';
import type { PatientFollowUpReview } from '../../shared/follow-up';
import { formatDate, useResource } from '../lib';
import { Badge, EmptyState, ErrorState, Loading, Modal } from './ui';
import './patient-follow-up.css';

export const effectivePlanStatus = (plan: CarePlan) => plan.effectiveStatus ?? plan.status;
export function effectiveReviewDate(plan: CarePlan) {
  if (effectivePlanStatus(plan) === 'completed') return null;
  return plan.effectiveFollowUpDate === undefined ? plan.followUpDate : plan.effectiveFollowUpDate;
}

export function PatientFollowUp({ plan }: { plan: CarePlan }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const reviews = useResource<PatientFollowUpReview[]>(
    historyOpen ? `/api/care-plans/${encodeURIComponent(plan.id)}/reviews` : null,
  );
  const latest = plan.latestReview;
  return (
    <section className="patient-follow-up" aria-label={`Follow-up reviews for ${plan.title}`}>
      {latest ? (
        <PatientReview review={latest} latest />
      ) : (
        <div className="patient-review-empty">
          <MessageCircle size={17} />
          <span>Your clinician’s follow-up updates will appear here when shared.</span>
        </div>
      )}
      <div className="patient-review-actions">
        <button className="button button-ghost button-small" onClick={() => setHistoryOpen(true)}>
          <History size={14} /> Review history
        </button>
        {latest?.disposition === 'visit-requested' && effectivePlanStatus(plan) !== 'completed' && (
          <Link
            className="button button-secondary button-small"
            to={`/book?doctor=${encodeURIComponent(plan.doctorId)}`}
          >
            <CalendarDays size={14} /> Book requested visit
          </Link>
        )}
      </div>
      {historyOpen && (
        <Modal title="Your follow-up review history" onClose={() => setHistoryOpen(false)}>
          <p className="muted">{plan.title} · Updates shared by your clinic, newest first.</p>
          {reviews.loading ? (
            <Loading />
          ) : reviews.error ? (
            <ErrorState message={reviews.error} retry={reviews.reload} />
          ) : reviews.data?.length ? (
            <div className="patient-review-history">
              {reviews.data.map((review) => (
                <PatientReview key={review.id} review={review} />
              ))}
            </div>
          ) : (
            <EmptyState
              title="No follow-up reviews shared yet"
              description="Your original treatment plan remains available in your care record."
            />
          )}
        </Modal>
      )}
    </section>
  );
}

function PatientReview({
  review,
  latest = false,
}: {
  review: PatientFollowUpReview;
  latest?: boolean;
}) {
  const clinicalReview = review.source === 'clinical-review';
  const label =
    review.disposition === 'complete'
      ? 'Plan completed'
      : review.disposition === 'visit-requested'
        ? 'Visit requested'
        : 'Care continues';
  return (
    <article className={`patient-shared-review ${latest ? 'patient-latest-review' : ''}`}>
      <div className="patient-review-heading">
        <div>
          <span className="patient-review-icon">
            <CheckCircle2 size={18} />
          </span>
          <h3>
            {clinicalReview
              ? latest
                ? 'Latest review from your clinician'
                : 'Clinician follow-up review'
              : 'Plan status update'}
          </h3>
        </div>
        <Badge
          tone={
            review.disposition === 'complete'
              ? 'green'
              : review.disposition === 'visit-requested'
                ? 'blue'
                : 'neutral'
          }
        >
          {label}
        </Badge>
      </div>
      <p className="patient-review-attribution">
        {review.doctorName || 'Your clinic'} · {formatDate(review.createdAt)}
      </p>
      {review.patientInstructions && (
        <p className="patient-review-instructions">{review.patientInstructions}</p>
      )}
      {review.disposition === 'complete' ? (
        <p className="patient-review-next-step">
          Your clinic has marked this plan complete. Its treatment instructions and review history
          remain in your record.
        </p>
      ) : (
        review.nextReviewDate && (
          <div className="patient-review-date">
            <CalendarDays size={16} />
            <span>
              Review requested by <strong>{formatDate(review.nextReviewDate)}</strong>
            </span>
          </div>
        )
      )}
      {review.disposition === 'visit-requested' && (
        <p className="patient-review-next-step">
          Your clinician has requested a visit. Choose an appointment separately; this review does
          not reserve a slot.
        </p>
      )}
    </article>
  );
}
