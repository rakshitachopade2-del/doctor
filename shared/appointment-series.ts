import type { Appointment, Role } from './types';

export type AppointmentSeriesInput = {
  patientId: string;
  doctorId: string;
  mode: 'in-person' | 'online';
  /** Ordinary appointment reason, shared with the patient on every booked visit. */
  reason: string;
  firstDate: string;
  time: string;
  count: number;
  intervalWeeks: 1 | 2 | 4;
} & (
  | { durationPolicy: 'schedule'; durationMinutes?: never }
  | { durationPolicy: 'custom'; durationMinutes: number }
);
export interface AppointmentSeriesVisit {
  position: number;
  date: string;
  time: string;
  endDate: string;
  endTime: string;
  durationMinutes: number;
  available: boolean;
  /** Generic operational reason; never identifies another patient's appointment. */
  blockedReason: string | null;
}
export interface AppointmentSeriesPreview {
  input: AppointmentSeriesInput;
  patient: { id: string; name: string; phone: string };
  doctor: { id: string; name: string; fee: number };
  durationMinutes: number;
  clinicDate: string;
  horizonEndDate: string;
  generatedAt: string;
  visits: AppointmentSeriesVisit[];
  canBook: boolean;
  revision: string;
}
/** Immutable original booking and command receipt. Staff-only. */
export interface AppointmentSeries {
  id: string;
  input: AppointmentSeriesInput;
  patient: AppointmentSeriesPreview['patient'];
  doctor: AppointmentSeriesPreview['doctor'];
  durationMinutes: number;
  bookedAppointments: Appointment[];
  patientConfirmed: true;
  privateNote: string;
  requestId: string;
  expectedRevision: string;
  createdById: string;
  createdByName: string;
  createdByRole: Exclude<Role, 'patient'>;
  createdAt: string;
}
export interface AppointmentSeriesDetail {
  series: AppointmentSeries;
  /** Current visits in original series order; lifecycle changes never rewrite series snapshots. */
  appointments: Appointment[];
}
export interface AppointmentSeriesRow {
  id: string;
  patientId: string;
  patientName: string;
  doctorId: string;
  doctorName: string;
  firstDate: string;
  lastDate: string;
  time: string;
  count: number;
  intervalWeeks: 1 | 2 | 4;
  mode: Appointment['mode'];
  durationPolicy: 'schedule' | 'custom';
  durationMinutes: number;
  createdByName: string;
  createdAt: string;
}
export interface AppointmentSeriesPage {
  items: AppointmentSeriesRow[];
  filters: { q: string; patientId: string | null; doctorId: string | null };
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
