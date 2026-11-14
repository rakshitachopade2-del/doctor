import type { Appointment, Role } from './types';
import type { AppointmentSeriesDetail } from './appointment-series';

export interface SeriesCancellationVisit {
  position: number;
  appointment: Appointment;
  eligible: boolean;
  blockedReason: string | null;
  reservationCount: number;
}

export interface SeriesCancellationContext {
  seriesId: string;
  /** Current demographics, distinct from the original series booking labels. */
  patient: { id: string; name: string; phone: string };
  visits: SeriesCancellationVisit[];
  generatedAt: string;
}

export interface SeriesCancellationPreview extends SeriesCancellationContext {
  /** Selected members only, normalized into original series order. */
  appointmentIds: string[];
  canCancel: boolean;
  revision: string;
}

export interface SeriesCancellationInput {
  appointmentIds: string[];
  /** Staff-only cancellation reason; never replaces the shared visit reason. */
  reason: string;
  expectedRevision: string;
  patientConfirmed: true;
  requestId: string;
}

/** Immutable staff-only command evidence; individual appointments remain the patient projection. */
export interface SeriesCancellationEvent {
  id: string;
  seriesId: string;
  appointmentIds: string[];
  reason: string;
  patientConfirmed: true;
  requestId: string;
  expectedRevision: string;
  createdById: string;
  createdByName: string;
  createdByRole: Exclude<Role, 'patient'>;
  createdAt: string;
  visits: {
    position: number;
    before: Appointment;
    after: Appointment;
    releasedReservationCount: number;
  }[];
}

export interface SeriesCancellationPage {
  items: SeriesCancellationEvent[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface SeriesCancellationResult {
  event: SeriesCancellationEvent;
  /** Original booking plus later-current members; may have advanced on exact retry. */
  detail: AppointmentSeriesDetail;
}
