import type { Appointment, Role } from './types';

/** Schedule-default booking. Custom lengths retain their separate staff command. */
export interface AppointmentBookingInput {
  requestId: string;
  patientId: string;
  doctorId: string;
  date: string;
  time: string;
  mode: 'in-person' | 'online';
  reason: string;
  waitlistId?: string;
  /** Required when fulfilling a waitlist request. */
  patientConfirmed?: true;
}

export interface AppointmentBooking {
  id: string;
  /** Immutable original confirmation, regardless of later appointment changes. */
  appointment: Appointment;
  waitlistId: string | null;
  patientConfirmed: boolean;
  createdById: string;
  createdByName: string;
  createdByRole: Role;
  createdAt: string;
}

export interface AppointmentBookingReceipt {
  requestId: string;
  actorId: string;
  patientId: string;
  bookingId: string;
  appointmentId: string;
}

export interface AppointmentBookingResult {
  /** Current record; exact retries may return a moved or cancelled appointment. */
  appointment: Appointment;
  booking: AppointmentBooking;
  receipt: AppointmentBookingReceipt;
}

/** Only emitted for a verified, uncommitted command after its transaction rolls back. */
export interface AppointmentBookingNotCreated {
  error: string;
  bookingOutcome: 'not-created';
  requestId: string;
  actorId: string;
  patientId: string;
}
