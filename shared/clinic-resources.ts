import type { Appointment, User } from './types';

export interface ResourceMetadata {
  name: string;
  kind: 'room' | 'equipment';
  capacity: 1;
  location: string;
  notes: string;
  active: boolean;
}
export interface ClinicResource extends ResourceMetadata {
  id: string;
  createdAt: string;
  updatedAt: string;
  revision: string;
}
export interface ResourceAuthor {
  createdById: string;
  createdByName: string;
  createdByRole: User['role'];
  createdAt: string;
}
export interface ResourceChange extends ResourceAuthor {
  id: string;
  requestId: string;
  resourceId: string;
  before: ResourceMetadata | null;
  after: ResourceMetadata;
  reason: string;
}
export interface ResourceClosureCancellation extends ResourceAuthor {
  id: string;
  requestId: string;
  reason: string;
}
export interface ResourceClosure extends ResourceAuthor {
  id: string;
  requestId: string;
  resourceId: string;
  startDate: string;
  endDate: string;
  /** Both null means all day; otherwise the interval repeats on every included date. */
  startTime: string | null;
  endTime: string | null;
  reason: string;
  cancellation: ResourceClosureCancellation | null;
}
export interface ResourceDetail {
  resource: ClinicResource;
  changes: ResourceChange[];
  closures: ResourceClosure[];
}
export type ResourceAppointment = Pick<
  Appointment,
  | 'id'
  | 'patientId'
  | 'patientName'
  | 'doctorId'
  | 'doctorName'
  | 'date'
  | 'time'
  | 'mode'
  | 'status'
> & {
  durationMinutes: number;
};
export interface ResourceSnapshot {
  id: string;
  name: string;
  kind: ResourceMetadata['kind'];
  location: string;
}
export interface ResourceAllocationSnapshot {
  appointment: ResourceAppointment;
  resources: ResourceSnapshot[];
}
export interface ResourceAllocationEvent extends ResourceAuthor {
  id: string;
  appointmentId: string;
  source: 'staff-allocation' | 'appointment-rescheduled' | 'appointment-status';
  before: ResourceAllocationSnapshot;
  after: ResourceAllocationSnapshot;
  reason: string;
  /** Present only for an explicit staff allocation command; automatic appointment events use null. */
  requestId: string | null;
}
export interface ResourceAvailability {
  resource: ClinicResource;
  available: boolean;
  reason: 'available' | 'inactive' | 'maintenance' | 'reserved';
}
export interface AppointmentResourceContext {
  appointment: ResourceAppointment;
  resourceIds: string[];
  revision: string;
  canAllocate: boolean;
  canRelease: boolean;
  /** Availability for this appointment's recorded interval, excluding its own reservations. */
  resources: ResourceAvailability[];
  history: ResourceAllocationEvent[];
}
export interface ResourceReservation {
  resource: ResourceSnapshot;
  appointment: ResourceAppointment;
}
export interface ResourceReservations {
  from: string;
  to: string;
  timezone: 'Asia/Kolkata';
  reservations: ResourceReservation[];
}
