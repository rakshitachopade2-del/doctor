export type EscalationStage = 'owner' | 'clinic';
export interface EscalationPolicy {
  enabled: boolean;
  ownerAfterDays: number;
  clinicAfterDays: number;
}
export interface EscalationPolicyChange {
  id: string;
  requestId: string;
  expectedRevision: string;
  before: EscalationPolicy;
  after: EscalationPolicy;
  reason: string;
  createdById: string;
  createdByName: string;
  createdAt: string;
}
export interface EscalationWorkerState {
  automaticEnabled: boolean;
  intervalSeconds: number;
  lastCheckedAt: string | null;
  lastRunId: string | null;
  lastErrorAt: string | null;
}
export interface EscalationPolicyContext {
  policy: EscalationPolicy;
  revision: string;
  followUpEnabled: boolean;
  history: EscalationPolicyChange[];
  worker: EscalationWorkerState;
}
export interface EscalationPolicyMutation {
  context: EscalationPolicyContext;
  change: EscalationPolicyChange;
}
export interface EscalationRecipient {
  userId: string;
  name: string;
  role: 'admin' | 'doctor';
  doctorId: string;
}
export interface EscalationCandidate {
  carePlanId: string;
  patientId: string;
  patientName: string;
  title: string;
  episodeId: string;
  latestReviewId: string | null;
  latestAssignmentId: string | null;
  reviewDate: string;
  overdueDays: number;
  ownerDoctorId: string;
  ownerDoctorName: string;
  stage: EscalationStage;
  routing: 'owner' | 'owner-unavailable-fallback' | 'clinic';
  recipients: EscalationRecipient[];
}
export interface EscalationPreview {
  revision: string;
  policyRevision: string;
  policy: EscalationPolicy;
  clinicDate: string;
  status: 'ready' | 'disabled' | 'paused';
  batchLimit: number;
  readyTotal: number;
  unroutableTotal: number;
  alreadyNotifiedTotal: number;
  items: EscalationCandidate[];
}
export interface EscalationEvent extends EscalationCandidate {
  id: string;
  runId: string;
  source: 'manual' | 'automatic';
  policy: EscalationPolicy;
  policyRevision: string;
  clinicDate: string;
  createdAt: string;
}
export interface EscalationRun {
  id: string;
  requestId: string | null;
  source: 'manual' | 'automatic';
  createdById: string | null;
  createdByName: string;
  previewRevision: string;
  policyRevision: string;
  clinicDate: string;
  createdAt: string;
  notifiedPlans: number;
  recipientCount: number;
  unroutableTotal: number;
  alreadyNotifiedTotal: number;
  remainingReady: number;
  events: EscalationEvent[];
}
export interface FollowUpEscalationState {
  episodeId: string | null;
  reviewDate: string | null;
  overdueDays: number | null;
  eligibleStage: EscalationStage | null;
  ownerNoticeAt: string | null;
  clinicNoticeAt: string | null;
  state: 'not-due' | 'disabled' | 'paused' | 'ready' | 'no-recipients' | 'recorded' | 'completed';
  historyCount: number;
}
export interface EscalationHistory {
  carePlanId: string;
  patientId: string;
  patientName: string;
  title: string;
  current: FollowUpEscalationState;
  events: EscalationEvent[];
}
