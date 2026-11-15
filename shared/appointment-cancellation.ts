import type { Appointment, Role } from './types';

export interface AppointmentCancellationContext {
  appointment: Appointment;
  revision: string;
  canCancel: boolean;
  blockedReason: string | null;
}
export interface AppointmentCancellationInput {
  expectedRevision: string;
  /** The actor has reviewed this specific cancellation; no patient-consent claim. */
  cancellationConfirmed: true;
  requestId: string;
}
export interface AppointmentCancellationEvent {
  id: string;
  appointmentId: string;
  requestId: string;
  expectedRevision: string;
  before: Appointment;
  after: Appointment;
  cancellationConfirmed: true;
  createdById: string;
  createdByName: string;
  createdByRole: Role;
  createdAt: string;
}
export interface AppointmentCancellationResult {
  appointment: Appointment;
  /** Immutable original cancellation evidence, independently of later current state. */
  event: AppointmentCancellationEvent;
  receipt: {
    requestId: string;
    actorId: string;
    patientId: string;
    appointmentId: string;
    eventId: string;
    expectedRevision: string;
  };
}
/** Persisted terminal rejection; this exact command can never apply later. */
export interface AppointmentCancellationNotApplied {
  error: string;
  cancellationOutcome: 'not-applied';
  requestId: string;
  actorId: string;
  patientId: string;
  appointmentId: string;
}
