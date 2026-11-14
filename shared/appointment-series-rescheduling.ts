import type { Appointment, Role } from './types';
import type { AppointmentSeriesDetail } from './appointment-series';

export interface SeriesRescheduleMove {
  appointmentId: string;
  date: string;
  time: string;
}
export interface SeriesRescheduleContext {
  seriesId: string;
  patient: { id: string; name: string; phone: string };
  visits: {
    position: number;
    appointment: Appointment;
    eligible: boolean;
    blockedReason: string | null;
    reservationCount: number;
  }[];
  clinicDate: string;
  horizonEndDate: string;
  generatedAt: string;
}
export interface SeriesReschedulePreview {
  seriesId: string;
  patient: SeriesRescheduleContext['patient'];
  /** Normalized into original series order; no requested member is omitted. */
  moves: SeriesRescheduleMove[];
  visits: {
    position: number;
    before: Appointment;
    after: Appointment;
    endDate: string;
    endTime: string;
    reservationCount: number;
    eligible: boolean;
    blockedReason: string | null;
  }[];
  canReschedule: boolean;
  revision: string;
  clinicDate: string;
  horizonEndDate: string;
  generatedAt: string;
}
export interface SeriesRescheduleInput {
  moves: SeriesRescheduleMove[];
  /** Staff-only; does not replace the shared appointment reason. */
  reason: string;
  expectedRevision: string;
  patientConfirmed: true;
  requestId: string;
}
export interface SeriesRescheduleEvent {
  id: string;
  seriesId: string;
  moves: SeriesRescheduleMove[];
  reason: string;
  expectedRevision: string;
  patientConfirmed: true;
  requestId: string;
  createdById: string;
  createdByName: string;
  createdByRole: Exclude<Role, 'patient'>;
  createdAt: string;
  visits: {
    position: number;
    before: Appointment;
    after: Appointment;
    retainedReservationCount: number;
  }[];
}
export interface SeriesRescheduleResult {
  event: SeriesRescheduleEvent;
  /** Current members can advance after the immutable event, including on exact retry. */
  detail: AppointmentSeriesDetail;
}
export interface SeriesReschedulePage {
  items: SeriesRescheduleEvent[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
