import type { Appointment } from './types';

export interface AppointmentReminderPolicy {
  enabled: boolean;
  leadHours: number;
}
export interface AppointmentReminderPolicyChange {
  id: string;
  requestId: string;
  expectedRevision: string;
  before: AppointmentReminderPolicy;
  after: AppointmentReminderPolicy;
  reason: string;
  createdById: string;
  createdByName: string;
  createdByRole: 'admin';
  createdAt: string;
}
export interface AppointmentReminderWorker {
  automaticEnabled: boolean;
  intervalSeconds: 300;
  batchLimit: 200;
  lastCheckedAt: string | null;
  lastRunId: string | null;
  lastErrorAt: string | null;
}
export interface AppointmentReminderPolicyContext {
  policy: AppointmentReminderPolicy;
  revision: string;
  latestChange: AppointmentReminderPolicyChange | null;
  worker: AppointmentReminderWorker;
}
export interface AppointmentReminderPolicyMutation {
  context: AppointmentReminderPolicyContext;
  change: AppointmentReminderPolicyChange;
}
/** Operational projection only. No shared visit reason, fee or clinical record content. */
export interface AppointmentReminderSnapshot {
  id: string;
  patientId: string;
  patientName: string;
  doctorId: string;
  doctorName: string;
  date: string;
  time: string;
  mode: Appointment['mode'];
  durationMinutes: number;
  status: Appointment['status'];
}
export interface AppointmentReminderRecipient {
  id: string;
  name: string;
}
export interface AppointmentReminderCandidate {
  episodeId: string;
  appointment: AppointmentReminderSnapshot;
  recipient: AppointmentReminderRecipient;
  startAt: string;
  dueAt: string;
}
export interface AppointmentReminderPreview {
  policy: AppointmentReminderPolicy;
  policyRevision: string;
  revision: string;
  status: 'ready' | 'disabled';
  generatedAt: string;
  windowEndAt: string;
  clinicDate: string;
  batchLimit: 200;
  upcomingAppointmentTotal: number;
  readyTotal: number;
  unroutableTotal: number;
  alreadyRecordedTotal: number;
  items: AppointmentReminderCandidate[];
}
export interface AppointmentReminderEvent extends AppointmentReminderCandidate {
  id: string;
  runId: string;
  source: 'manual' | 'automatic';
  policy: AppointmentReminderPolicy;
  policyRevision: string;
  createdAt: string;
}
export interface AppointmentReminderRun {
  id: string;
  requestId: string | null;
  source: 'manual' | 'automatic';
  createdById: string | null;
  createdByName: string;
  createdAt: string;
  previewRevision: string;
  policyRevision: string;
  policy: AppointmentReminderPolicy;
  checkedAt: string;
  noticeCount: number;
  remainingReady: number;
  unroutableTotal: number;
  alreadyRecordedTotal: number;
  events: AppointmentReminderEvent[];
}
export type AppointmentReminderRunSummary = Omit<AppointmentReminderRun, 'events'>;
export interface AppointmentReminderPage<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
export interface AppointmentReminderHistory extends AppointmentReminderPage<AppointmentReminderEvent> {
  appointment: AppointmentReminderSnapshot;
  current: {
    state:
      'disabled' | 'not-scheduled' | 'past' | 'not-due' | 'no-recipient' | 'recorded' | 'ready';
    episodeId: string;
    startAt: string;
    dueAt: string;
    recipient: AppointmentReminderRecipient | null;
    recordedAt: string | null;
  };
}
