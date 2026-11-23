import type { CheckInSnapshot, FollowUpReview } from '../../shared/follow-up';
import type {
  FollowUpReviewCommand,
  FollowUpReviewContext,
} from '../../shared/follow-up-review-recording';
import { followUpRevisionData } from '../../shared/follow-up-review-recording';
import type { CheckIn } from '../../shared/types';
import { ApiError } from '../lib';
import { sha256 } from './care-summary-bundle-helpers';
import { isReport } from './check-in-submission-helpers';
import { visitDate } from './visit-duration-helpers';

export interface ReviewTarget {
  patientId: string;
  carePlanId: string;
}
export interface ReviewAttempt {
  command: FollowUpReviewCommand;
  patientName: string;
  planTitle: string;
  doctorName: string;
  previousReviewId: string | null;
  snapshots: CheckInSnapshot[];
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const timestamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const outcomes = ['continue', 'visit-requested', 'complete'];
const invalid = () =>
  new Error('The current follow-up context could not be confirmed. Please try again.');

function reportFields(report: CheckIn) {
  const { id, carePlanId, patientId, date, adherence, feeling, note, createdAt } = report;
  return { id, carePlanId, patientId, date, adherence, feeling, note, createdAt };
}
function sameReport(a: CheckIn, b: CheckIn) {
  return JSON.stringify(reportFields(a)) === JSON.stringify(reportFields(b));
}
function sameVersions(a: CheckInSnapshot[], b: CheckInSnapshot[]) {
  return (
    a.length === b.length &&
    a.every((v, i) => v.contentHash === b[i].contentHash && sameReport(v.snapshot, b[i].snapshot))
  );
}
export function sameReview(a: FollowUpReview, b: FollowUpReview) {
  const fields = [
    'id',
    'carePlanId',
    'doctorId',
    'doctorName',
    'source',
    'assessment',
    'patientInstructions',
    'disposition',
    'nextReviewDate',
    'createdAt',
  ] as const;
  return (
    fields.every((key) => a[key] === b[key]) && sameVersions(a.checkInSnapshots, b.checkInSnapshots)
  );
}
export function checkReportContinuity(reports: CheckInSnapshot[], known: CheckInSnapshot[]) {
  const current = new Map(reports.map((v) => [v.id, v]));
  for (const old of known) {
    const next = current.get(old.id);
    if (
      !next ||
      next.snapshot.date !== old.snapshot.date ||
      next.updatedAt < old.updatedAt ||
      (next.updatedAt === old.updatedAt &&
        (next.contentHash !== old.contentHash || !sameReport(next.snapshot, old.snapshot)))
    )
      throw invalid();
  }
}
function snapshots(value: unknown, target: ReviewTarget): value is CheckInSnapshot[] {
  if (!Array.isArray(value)) return false;
  const ids = new Set(),
    dates = new Set();
  return value.every((s) => {
    if (
      !object(s) ||
      Object.keys(s).length !== 4 ||
      !isReport(s.snapshot, target.patientId) ||
      Object.keys(s.snapshot).length !== 8 ||
      s.snapshot.carePlanId !== target.carePlanId ||
      s.id !== s.snapshot.id ||
      s.updatedAt !== s.snapshot.createdAt ||
      !hash(s.contentHash) ||
      ids.has(s.id) ||
      dates.has(s.snapshot.date)
    )
      return false;
    ids.add(s.id);
    dates.add(s.snapshot.date);
    return true;
  });
}
function isReview(value: unknown, target: ReviewTarget): value is FollowUpReview {
  return (
    object(value) &&
    text(value.id) &&
    value.carePlanId === target.carePlanId &&
    text(value.doctorId) &&
    text(value.doctorName) &&
    timestamp(value.createdAt) &&
    (value.source === 'clinical-review'
      ? text(value.assessment)
      : value.source === 'status-change' && value.assessment === '') &&
    text(value.patientInstructions) &&
    outcomes.includes(String(value.disposition)) &&
    (value.disposition === 'complete'
      ? value.nextReviewDate === null
      : visitDate(value.nextReviewDate)) &&
    snapshots(value.checkInSnapshots, target)
  );
}
export function checkedReviewHistory(value: unknown, target: ReviewTarget): FollowUpReview[] {
  if (!Array.isArray(value) || !value.every((v) => isReview(v, target))) throw invalid();
  return value;
}

export async function checkedReviewContext(value: unknown, target: ReviewTarget) {
  if (
    !object(value) ||
    !object(value.item) ||
    !text(value.doctorId) ||
    !text(value.doctorName) ||
    !(value.latestAssignmentId === null || text(value.latestAssignmentId)) ||
    typeof value.followUpEnabled !== 'boolean' ||
    !snapshots(value.checkInSnapshots, target)
  )
    throw invalid();
  const item = value.item,
    plan = item.carePlan,
    reports = value.checkInSnapshots;
  if (
    !object(plan) ||
    !object(item.patient) ||
    item.patient.id !== target.patientId ||
    !text(item.patient.name) ||
    plan.id !== target.carePlanId ||
    plan.patientId !== target.patientId ||
    !text(plan.title) ||
    !text(plan.doctorId) ||
    !text(plan.instructions) ||
    typeof plan.warnings !== 'string' ||
    !Array.isArray(plan.medications) ||
    !plan.medications.every(
      (m) =>
        object(m) &&
        ['name', 'instructions', 'schedule', 'duration', 'warnings'].every(
          (k) => typeof m[k] === 'string',
        ),
    ) ||
    !visitDate(plan.startDate) ||
    !visitDate(plan.endDate) ||
    plan.endDate < plan.startDate ||
    !visitDate(plan.followUpDate) ||
    !['active', 'completed'].includes(String(plan.status)) ||
    plan.effectiveStatus !== plan.status ||
    (plan.status === 'active'
      ? !visitDate(plan.effectiveFollowUpDate)
      : plan.effectiveFollowUpDate !== null) ||
    !text(item.ownerDoctorName) ||
    !text(item.ownerDoctorId) ||
    !hash(item.revision) ||
    item.revision !== plan.followUpRevision ||
    !Array.isArray(item.unreviewedCheckIns) ||
    item.unreviewedCount !== item.unreviewedCheckIns.length ||
    !(item.latestReview === null || isReview(item.latestReview, target))
  )
    throw invalid();
  const latest = item.latestReview;
  if (
    latest === null
      ? plan.latestReview !== null
      : !isReview(plan.latestReview, target) || !sameReview(plan.latestReview, latest)
  )
    throw invalid();
  const byId = new Map(reports.map((s) => [s.id, s.snapshot]));
  const seen = new Set<string>();
  for (const report of item.unreviewedCheckIns) {
    if (!isReport(report, target.patientId) || seen.has(report.id)) throw invalid();
    const current = byId.get(report.id);
    if (!current || !sameReport(current, report)) throw invalid();
    seen.add(report.id);
  }
  const revisionData = followUpRevisionData(
    {
      id: target.carePlanId,
      patientId: target.patientId,
      doctorId: plan.doctorId,
      status: plan.status as 'active' | 'completed',
      startDate: plan.startDate,
      endDate: plan.endDate,
      followUpDate: plan.followUpDate,
    },
    latest?.id ?? null,
    value.latestAssignmentId,
    reports,
  );
  if ((await sha256(JSON.stringify(revisionData))) !== item.revision) throw invalid();
  if (latest?.source !== 'status-change') {
    const prior = new Map(latest?.checkInSnapshots.map((v) => [v.id, v.contentHash]));
    if (reports.some((v) => seen.has(v.id) !== (prior.get(v.id) !== v.contentHash)))
      throw invalid();
  }
  // These are the server's canonical fingerprint fields, independent of JSON property order.
  for (const version of [...reports, ...(latest?.checkInSnapshots ?? [])]) {
    if ((await sha256(JSON.stringify(reportFields(version.snapshot)))) !== version.contentHash)
      throw invalid();
  }
  return value as unknown as FollowUpReviewContext;
}

export function confirmedReview(
  value: unknown,
  attempt: ReviewAttempt,
  actorId: string,
): FollowUpReview | null {
  if (!object(value) || Object.keys(value).length !== 1 || !object(value.receipt)) return null;
  const r = value.receipt,
    c = attempt.command,
    review = r.review;
  if (
    Object.keys(r).length !== 7 ||
    r.requestId !== c.requestId ||
    r.actorId !== actorId ||
    r.patientId !== c.patientId ||
    r.carePlanId !== c.carePlanId ||
    r.doctorId !== c.doctorId ||
    r.expectedRevision !== c.expectedRevision ||
    !isReview(review, c) ||
    Object.keys(review).length !== 11 ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(review.id) ||
    review.id === attempt.previousReviewId ||
    review.id === c.requestId ||
    review.doctorId !== c.doctorId ||
    review.source !== 'clinical-review' ||
    review.assessment !== c.assessment ||
    review.patientInstructions !== c.patientInstructions ||
    review.disposition !== c.disposition ||
    review.nextReviewDate !== c.nextReviewDate ||
    !sameVersions(review.checkInSnapshots, attempt.snapshots)
  )
    return null;
  return review;
}

export function reviewRejection(error: unknown, command: FollowUpReviewCommand, actorId: string) {
  if (
    !(error instanceof ApiError) ||
    ![400, 403, 409].includes(error.status) ||
    !object(error.responseData)
  )
    return null;
  const { code, actorId: respondent, command: submitted, message } = error.responseData;
  if (
    code !== 'FOLLOW_UP_REVIEW_NOT_RECORDED' ||
    respondent !== actorId ||
    !text(message) ||
    !object(submitted)
  )
    return null;
  return Object.keys(submitted).length === Object.keys(command).length &&
    Object.entries(command).every(([k, v]) => submitted[k] === v)
    ? message
    : null;
}
