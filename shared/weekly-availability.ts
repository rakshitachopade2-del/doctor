import type { DoctorSchedule } from './scheduling';

export type WeeklyAvailabilityValues = Pick<DoctorSchedule, 'durationMinutes' | 'windows'>;
export interface WeeklyAvailabilitySnapshot {
  source: 'inherited' | 'explicit';
  schedule: DoctorSchedule;
}
/** Private to administrators and the doctor who owns this schedule. */
export interface WeeklyAvailabilityChange {
  id: string;
  doctorId: string;
  doctorName: string;
  source: 'reviewed' | 'legacy';
  before: WeeklyAvailabilitySnapshot;
  after: WeeklyAvailabilitySnapshot & { source: 'explicit' };
  reason: string | null;
  createdByName: string;
  createdByRole: 'admin' | 'doctor';
  createdAt: string;
}
export interface WeeklyAvailabilityContext extends WeeklyAvailabilitySnapshot {
  doctor: { id: string; name: string };
  revision: string;
  /** Existing saved schedules without new events have no invented saving actor. */
  latestChange: WeeklyAvailabilityChange | null;
}
export interface WeeklyAvailabilityInput {
  schedule: WeeklyAvailabilityValues;
  reason: string;
  expectedRevision: string;
  requestId: string;
}
export interface WeeklyAvailabilityMutation {
  context: WeeklyAvailabilityContext;
  change: WeeklyAvailabilityChange;
  receipt: {
    requestId: string;
    actorId: string;
    doctorId: string;
    expectedRevision: string;
    changeId: string;
  };
}
export interface WeeklyAvailabilityHistory {
  items: WeeklyAvailabilityChange[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
