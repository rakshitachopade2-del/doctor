import type {
  EscalationCandidate,
  EscalationEvent,
  EscalationHistory,
  EscalationPolicy,
  EscalationPolicyChange,
  EscalationPolicyContext,
  EscalationPolicyMutation,
  EscalationPreview,
  EscalationRecipient,
  EscalationRun,
  FollowUpEscalationState,
} from '../../shared/follow-up-escalation';
import { visitDate } from './visit-duration-helpers';

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
const token = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const uuid = (v: unknown) =>
  typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const stamp = (v: unknown) => text(v) && Number.isFinite(Date.parse(v));
const count = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
const maybeId = (v: unknown) => v === null || text(v);
const maybeTime = (v: unknown) => v === null || stamp(v);
const bad = () =>
  new Error(
    'The escalation response could not be confirmed. Refresh the view or retry the exact submitted request.',
  );
const days = (date: string, from: string) =>
  Math.round((Date.parse(date + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);
export const escalationFailure = (v: unknown) =>
  v instanceof Error ? v.message : 'Unable to confirm the request. Please try again.';
export function checkedEscalationPolicy(v: unknown): EscalationPolicy {
  if (
    !object(v) ||
    typeof v.enabled !== 'boolean' ||
    !Number.isSafeInteger(v.ownerAfterDays) ||
    Number(v.ownerAfterDays) < 1 ||
    Number(v.ownerAfterDays) > 30 ||
    !Number.isSafeInteger(v.clinicAfterDays) ||
    Number(v.clinicAfterDays) <= Number(v.ownerAfterDays) ||
    Number(v.clinicAfterDays) > 90
  )
    throw bad();
  return v as unknown as EscalationPolicy;
}
export const sameEscalationPolicy = (a: EscalationPolicy, b: EscalationPolicy) =>
  a.enabled === b.enabled &&
  a.ownerAfterDays === b.ownerAfterDays &&
  a.clinicAfterDays === b.clinicAfterDays;
function checkedChange(v: unknown): EscalationPolicyChange {
  if (
    !object(v) ||
    !text(v.id) ||
    !uuid(v.requestId) ||
    !token(v.expectedRevision) ||
    !text(v.reason) ||
    v.reason.length > 1000 ||
    !text(v.createdById) ||
    !text(v.createdByName) ||
    !stamp(v.createdAt)
  )
    throw bad();
  const before = checkedEscalationPolicy(v.before),
    after = checkedEscalationPolicy(v.after);
  if (sameEscalationPolicy(before, after)) throw bad();
  return v as unknown as EscalationPolicyChange;
}
const sameChange = (a: EscalationPolicyChange, b: EscalationPolicyChange) =>
  [
    'id',
    'requestId',
    'expectedRevision',
    'reason',
    'createdById',
    'createdByName',
    'createdAt',
  ].every((k) => a[k as keyof EscalationPolicyChange] === b[k as keyof EscalationPolicyChange]) &&
  sameEscalationPolicy(a.before, b.before) &&
  sameEscalationPolicy(a.after, b.after);
export function checkedEscalationPolicyContext(v: unknown): EscalationPolicyContext {
  if (
    !object(v) ||
    !token(v.revision) ||
    typeof v.followUpEnabled !== 'boolean' ||
    !Array.isArray(v.history) ||
    !object(v.worker)
  )
    throw bad();
  const policy = checkedEscalationPolicy(v.policy),
    history = v.history.map(checkedChange),
    w = v.worker;
  if (
    typeof w.automaticEnabled !== 'boolean' ||
    w.intervalSeconds !== 900 ||
    !maybeTime(w.lastCheckedAt) ||
    !maybeTime(w.lastErrorAt) ||
    !maybeId(w.lastRunId) ||
    new Set(history.map((c) => c.id)).size !== history.length ||
    new Set(history.map((c) => c.requestId)).size !== history.length ||
    history.some(
      (c, i) => i < history.length - 1 && !sameEscalationPolicy(c.before, history[i + 1].after),
    ) ||
    (history.length && !sameEscalationPolicy(policy, history[0].after)) ||
    (!history.length &&
      !sameEscalationPolicy(policy, { enabled: false, ownerAfterDays: 3, clinicAfterDays: 7 }))
  )
    throw bad();
  return v as unknown as EscalationPolicyContext;
}
export type PolicyPayload = EscalationPolicy & {
  reason: string;
  expectedRevision: string;
  requestId: string;
};
export type PolicyAttempt = {
  body: PolicyPayload;
  source: EscalationPolicyContext;
  actorId: string;
};
export function checkedEscalationPolicyMutation(
  v: unknown,
  a: PolicyAttempt,
): EscalationPolicyMutation {
  if (!object(v)) throw bad();
  const context = checkedEscalationPolicyContext(v.context),
    change = checkedChange(v.change);
  if (
    change.requestId !== a.body.requestId ||
    change.expectedRevision !== a.body.expectedRevision ||
    change.createdById !== a.actorId ||
    change.reason !== a.body.reason.trim() ||
    context.revision === a.source.revision ||
    !sameEscalationPolicy(change.before, a.source.policy) ||
    !sameEscalationPolicy(change.after, a.body) ||
    a.source.history.some((c) => c.id === change.id || c.requestId === change.requestId) ||
    !context.history.some((c) => sameChange(c, change))
  )
    throw bad();
  return { context, change };
}
function checkedRecipients(v: unknown): EscalationRecipient[] {
  if (!Array.isArray(v) || !v.length) throw bad();
  for (const r of v)
    if (
      !object(r) ||
      !['userId', 'name', 'doctorId'].every((k) => text(r[k])) ||
      !['admin', 'doctor'].includes(r.role as string)
    )
      throw bad();
  const recipients = v as EscalationRecipient[];
  if (
    new Set(recipients.map((r) => r.userId)).size !== recipients.length ||
    recipients.some((r, i) => i > 0 && recipients[i - 1].userId > r.userId)
  )
    throw bad();
  return recipients;
}
function checkedCandidate(v: unknown): EscalationCandidate {
  if (
    !object(v) ||
    !['carePlanId', 'patientId', 'patientName', 'title', 'ownerDoctorId', 'ownerDoctorName'].every(
      (k) => text(v[k]),
    ) ||
    !token(v.episodeId) ||
    !maybeId(v.latestReviewId) ||
    !maybeId(v.latestAssignmentId) ||
    !visitDate(v.reviewDate) ||
    !count(v.overdueDays) ||
    !['owner', 'clinic'].includes(v.stage as string) ||
    !['owner', 'owner-unavailable-fallback', 'clinic'].includes(v.routing as string) ||
    (v.stage === 'clinic') !== (v.routing === 'clinic')
  )
    throw bad();
  const recipients = checkedRecipients(v.recipients);
  if (v.routing === 'owner' && recipients.some((r) => r.doctorId !== v.ownerDoctorId)) throw bad();
  return v as unknown as EscalationCandidate;
}
const candidateKeys = [
  'carePlanId',
  'patientId',
  'patientName',
  'title',
  'episodeId',
  'latestReviewId',
  'latestAssignmentId',
  'reviewDate',
  'overdueDays',
  'ownerDoctorId',
  'ownerDoctorName',
  'stage',
  'routing',
] as const;
const sameCandidate = (a: EscalationCandidate, b: EscalationCandidate) =>
  candidateKeys.every((k) => a[k] === b[k]) &&
  a.recipients.length === b.recipients.length &&
  a.recipients.every((r, i) =>
    ['userId', 'name', 'role', 'doctorId'].every(
      (k) => r[k as keyof EscalationRecipient] === b.recipients[i][k as keyof EscalationRecipient],
    ),
  );
function eligible(c: EscalationCandidate, policy: EscalationPolicy, date: string) {
  return (
    c.overdueDays === days(date, c.reviewDate) &&
    (c.stage === 'clinic'
      ? c.overdueDays >= policy.clinicAfterDays
      : c.overdueDays >= policy.ownerAfterDays && c.overdueDays < policy.clinicAfterDays)
  );
}
export function checkedEscalationPreview(v: unknown): EscalationPreview {
  if (
    !object(v) ||
    !token(v.revision) ||
    !token(v.policyRevision) ||
    !visitDate(v.clinicDate) ||
    !['ready', 'disabled', 'paused'].includes(v.status as string) ||
    v.batchLimit !== 200 ||
    !['readyTotal', 'unroutableTotal', 'alreadyNotifiedTotal'].every((k) => count(v[k])) ||
    !Array.isArray(v.items) ||
    v.items.length !== Math.min(200, Number(v.readyTotal))
  )
    throw bad();
  const policy = checkedEscalationPolicy(v.policy),
    items = v.items.map(checkedCandidate);
  if (
    (v.status === 'disabled') === policy.enabled ||
    new Set(items.map((c) => c.carePlanId)).size !== items.length ||
    items.some((c) => !eligible(c, policy, v.clinicDate as string)) ||
    items.some(
      (c, i) =>
        i > 0 &&
        (items[i - 1].reviewDate > c.reviewDate ||
          (items[i - 1].reviewDate === c.reviewDate && items[i - 1].carePlanId > c.carePlanId)),
    )
  )
    throw bad();
  return v as unknown as EscalationPreview;
}
function checkedEvent(v: unknown): EscalationEvent {
  const candidate = checkedCandidate(v);
  if (
    !object(v) ||
    !['id', 'runId'].every((k) => text(v[k])) ||
    !['manual', 'automatic'].includes(v.source as string) ||
    !token(v.policyRevision) ||
    !visitDate(v.clinicDate) ||
    !stamp(v.createdAt)
  )
    throw bad();
  const policy = checkedEscalationPolicy(v.policy);
  if (!policy.enabled || !eligible(candidate, policy, v.clinicDate)) throw bad();
  return v as unknown as EscalationEvent;
}
export type RunPayload = {
  expectedPreviewRevision: string;
  expectedPolicyRevision: string;
  requestId: string;
};
export type RunAttempt = { body: RunPayload; preview: EscalationPreview; actorId: string };
export function checkedEscalationRun(v: unknown, a: RunAttempt): EscalationRun {
  if (
    !object(v) ||
    !text(v.id) ||
    v.requestId !== a.body.requestId ||
    v.source !== 'manual' ||
    v.createdById !== a.actorId ||
    !text(v.createdByName) ||
    v.previewRevision !== a.body.expectedPreviewRevision ||
    v.policyRevision !== a.body.expectedPolicyRevision ||
    v.clinicDate !== a.preview.clinicDate ||
    !stamp(v.createdAt) ||
    ![
      'notifiedPlans',
      'recipientCount',
      'unroutableTotal',
      'alreadyNotifiedTotal',
      'remainingReady',
    ].every((k) => count(v[k])) ||
    !Array.isArray(v.events)
  )
    throw bad();
  const events = v.events.map(checkedEvent),
    p = a.preview;
  if (
    events.length !== p.items.length ||
    v.notifiedPlans !== p.items.length ||
    v.recipientCount !== p.items.reduce((n, c) => n + c.recipients.length, 0) ||
    v.unroutableTotal !== p.unroutableTotal ||
    v.alreadyNotifiedTotal !== p.alreadyNotifiedTotal ||
    v.remainingReady !== p.readyTotal - p.items.length ||
    new Set(events.map((e) => e.id)).size !== events.length ||
    events.some(
      (e, i) =>
        !sameCandidate(e, p.items[i]) ||
        e.runId !== v.id ||
        e.source !== 'manual' ||
        e.policyRevision !== p.policyRevision ||
        e.clinicDate !== p.clinicDate ||
        e.createdAt !== v.createdAt ||
        !sameEscalationPolicy(e.policy, p.policy),
    )
  )
    throw bad();
  return v as unknown as EscalationRun;
}
export function checkedEscalationState(v: unknown): FollowUpEscalationState {
  if (
    !object(v) ||
    !(v.episodeId === null || token(v.episodeId)) ||
    !(v.reviewDate === null || visitDate(v.reviewDate)) ||
    !(v.overdueDays === null || count(v.overdueDays)) ||
    !(v.eligibleStage === null || ['owner', 'clinic'].includes(v.eligibleStage as string)) ||
    !maybeTime(v.ownerNoticeAt) ||
    !maybeTime(v.clinicNoticeAt) ||
    !['not-due', 'disabled', 'paused', 'ready', 'no-recipients', 'recorded', 'completed'].includes(
      v.state as string,
    ) ||
    !count(v.historyCount)
  )
    throw bad();
  if (
    (v.episodeId === null &&
      (v.overdueDays !== null ||
        v.eligibleStage !== null ||
        v.ownerNoticeAt !== null ||
        v.clinicNoticeAt !== null)) ||
    (v.episodeId !== null && (v.reviewDate === null || v.overdueDays === null))
  )
    throw bad();
  return v as unknown as FollowUpEscalationState;
}
export function checkedEscalationHistory(v: unknown, id: string): EscalationHistory {
  if (
    !object(v) ||
    v.carePlanId !== id ||
    !['patientId', 'patientName', 'title'].every((k) => text(v[k])) ||
    !Array.isArray(v.events)
  )
    throw bad();
  const current = checkedEscalationState(v.current),
    events = v.events.map(checkedEvent);
  if (
    current.historyCount !== events.length ||
    new Set(events.map((e) => e.id)).size !== events.length ||
    new Set(events.map((e) => `${e.episodeId}:${e.stage}`)).size !== events.length ||
    events.some((e) => e.carePlanId !== id || e.patientId !== v.patientId) ||
    current.ownerNoticeAt !==
      (events.find((e) => e.episodeId === current.episodeId && e.stage === 'owner')?.createdAt ??
        null) ||
    current.clinicNoticeAt !==
      (events.find((e) => e.episodeId === current.episodeId && e.stage === 'clinic')?.createdAt ??
        null)
  )
    throw bad();
  return v as unknown as EscalationHistory;
}
