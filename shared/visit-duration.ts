import type { Appointment, Role } from './types';

export type VisitDurationPolicy = 'schedule' | 'custom';
/** Staff-only evidence; internal duration reasons never enter patient projections. */
export interface VisitDurationEvent {
  id: string;
  appointmentId: string;
  operation: 'custom-booking' | 'duration-change';
  requestId: string;
  expectedRevision: string | null;
  before: Appointment | null;
  after: Appointment;
  reason: string;
  createdById: string;
  createdByName: string;
  createdByRole: Exclude<Role, 'patient'>;
  createdAt: string;
}
export interface VisitDurationContext {
  appointment: Appointment;
  /** Covers the current appointment, selected doctor's schedule, fee and name. */
  revision: string;
  scheduleDurationMinutes: number;
  currentDoctorFee: number;
  currentDoctorName: string;
  canChange: boolean;
  history: VisitDurationEvent[];
}
export interface VisitDurationMutation {
  /** Current appointment; later changes may follow an exact command replay. */
  appointment: Appointment;
  /** Immutable confirmation of the exact submitted operation. */
  event: VisitDurationEvent;
}
