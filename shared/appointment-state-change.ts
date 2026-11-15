import type { Appointment, Role } from './types';

export type AppointmentStateChangeStatus =
  'checked-in' | 'in-consultation' | 'completed' | 'no-show';

export interface AppointmentStateChangeAction {
  status: AppointmentStateChangeStatus;
  allowed: boolean;
  blockedReason: string | null;
}
export interface AppointmentStateChangeContext {
  appointment: Appointment;
  revision: string;
  actions: AppointmentStateChangeAction[];
  generatedAt: string;
  clinicDate: string;
}
export interface AppointmentStateChangeInput {
  status: AppointmentStateChangeStatus;
  expectedRevision: string;
  /** The staff member reviewed this specific action; no clinical consent claim. */
  changeConfirmed: true;
  requestId: string;
}
export interface AppointmentStateChangeEvent {
  id: string;
  appointmentId: string;
  requestId: string;
  expectedRevision: string;
  before: Appointment;
  after: Appointment;
  changeConfirmed: true;
  createdById: string;
  createdByName: string;
  createdByRole: Exclude<Role, 'patient'>;
  createdAt: string;
}
export interface AppointmentStateChangeResult {
  appointment: Appointment;
  /** Original immutable evidence, independently of later appointment progression. */
  event: AppointmentStateChangeEvent;
  receipt: {
    requestId: string;
    actorId: string;
    patientId: string;
    appointmentId: string;
    eventId: string;
    expectedRevision: string;
    status: AppointmentStateChangeStatus;
  };
}
/** Persisted terminal rejection; this exact command can never apply later. */
export interface AppointmentStateChangeNotApplied {
  error: string;
  stateChangeOutcome: 'not-applied';
  requestId: string;
  actorId: string;
  patientId: string;
  appointmentId: string;
}
