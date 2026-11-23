import type { CheckInSnapshot, FollowUpReview, FollowUpWorkItem } from './follow-up';
import type { CarePlan } from './types';

export interface FollowUpReviewContext {
  item: FollowUpWorkItem;
  checkInSnapshots: CheckInSnapshot[];
  doctorId: string;
  doctorName: string;
  followUpEnabled: boolean;
  latestAssignmentId: string | null;
}

export interface FollowUpReviewCommand extends Pick<
  FollowUpReview,
  | 'carePlanId'
  | 'doctorId'
  | 'assessment'
  | 'patientInstructions'
  | 'disposition'
  | 'nextReviewDate'
> {
  requestId: string;
  patientId: string;
  expectedRevision: string;
  reviewedConfirmed: true;
}

export interface FollowUpReviewReceipt {
  requestId: string;
  actorId: string;
  patientId: string;
  carePlanId: string;
  doctorId: string;
  expectedRevision: string;
  review: FollowUpReview;
}

export interface FollowUpReviewResult {
  receipt: FollowUpReviewReceipt;
}

export interface FollowUpReviewNotRecorded {
  code: 'FOLLOW_UP_REVIEW_NOT_RECORDED';
  actorId: string;
  command: FollowUpReviewCommand;
  message: string;
}

// Preserve the field order used by existing follow-up revisions and clinical drafts.
export function followUpRevisionData(
  plan: Pick<
    CarePlan,
    'id' | 'patientId' | 'doctorId' | 'status' | 'startDate' | 'endDate' | 'followUpDate'
  >,
  latestReviewId: string | null,
  latestAssignmentId: string | null,
  snapshots: CheckInSnapshot[],
) {
  return {
    id: plan.id,
    patientId: plan.patientId,
    doctorId: plan.doctorId,
    status: plan.status,
    startDate: plan.startDate,
    endDate: plan.endDate,
    followUpDate: plan.followUpDate,
    latestReviewId,
    latestAssignmentId,
    checkIns: snapshots.map(({ id, contentHash }) => ({ id, contentHash })),
  };
}
