import type { Appointment, Role } from './types';

export interface AppointmentRescheduleTarget {
  doctorId: string;
  date: string;
  time: string;
  mode: 'in-person' | 'online';
}
export interface AppointmentRescheduleContext {
  appointment: Appointment;
  sourceRevision: string;
  canReschedule: boolean;
  blockedReason: string | null;
  clinicDate: string;
  bookingThroughDate: string;
}
export interface AppointmentReschedulePreviewInput extends AppointmentRescheduleTarget {
  expectedSourceRevision: string;
}
export interface AppointmentReschedulePreview {
  appointmentId: string;
  sourceRevision: string;
  revision: string;
  before: Appointment;
  /** Proposed fields remain visible even when this target is blocked. */
  after: Appointment;
  canReschedule: boolean;
  blockedReason: string | null;
  generatedAt: string;
}
export interface AppointmentRescheduleInput extends AppointmentRescheduleTarget {
  expectedRevision: string;
  patientConfirmed: true;
  requestId: string;
}
export interface AppointmentRescheduleEvent {
  id: string;
  appointmentId: string;
  requestId: string;
  expectedRevision: string;
  before: Appointment;
  after: Appointment;
  patientConfirmed: true;
  createdById: string;
  createdByName: string;
  createdByRole: Role;
  createdAt: string;
}
export interface AppointmentRescheduleResult {
  /** Current appointment may have changed after the immutable reschedule event. */
  appointment: Appointment;
  event: AppointmentRescheduleEvent;
  receipt: {
    requestId: string;
    actorId: string;
    patientId: string;
    appointmentId: string;
    eventId: string;
    expectedRevision: string;
  };
}
/** Persisted terminal rejection; retrying this exact command never applies it later. */
export interface AppointmentRescheduleNotApplied {
  error: string;
  rescheduleOutcome: 'not-applied';
  requestId: string;
  actorId: string;
  patientId: string;
  appointmentId: string;
}
