import type { Appointment, Role } from './types';

export interface ProcedureAppointmentSnapshot {
  id: string;
  patientId: string;
  doctorId: string;
  doctorName: string;
  date: string;
  time: string;
  mode: Appointment['mode'];
  status: Appointment['status'];
  durationMinutes: number;
  durationPolicy: 'schedule' | 'custom';
}
export type ProcedureScheduleState = 'unlinked' | 'linked' | 'attention';
export interface ProcedureScheduleRow {
  id: string;
  patientId: string;
  patientName: string;
  title: string;
  doctorId: string;
  doctorName: string;
  status: 'planned' | 'completed' | 'cancelled';
  createdAt: string;
  originalAppointmentId: string | null;
  effectiveAppointmentId: string | null;
  appointment: ProcedureAppointmentSnapshot | null;
  schedulingState: ProcedureScheduleState;
  canChange: boolean;
  blockedReason: string | null;
}
export interface ProcedureScheduleEvent {
  id: string;
  procedureId: string;
  operation: 'attach' | 'replace' | 'unlink';
  requestId: string;
  expectedRevision: string;
  expectedAppointmentRevision: string | null;
  beforeAppointmentId: string | null;
  afterAppointmentId: string | null;
  beforeAppointment: ProcedureAppointmentSnapshot | null;
  afterAppointment: ProcedureAppointmentSnapshot | null;
  reason: string;
  createdById: string;
  createdByName: string;
  createdByRole: Exclude<Role, 'patient'>;
  createdAt: string;
}
export interface ProcedureScheduleContext {
  procedure: ProcedureScheduleRow;
  revision: string;
  history: ProcedureScheduleEvent[];
}
export interface ProcedureScheduleMutation {
  context: ProcedureScheduleContext;
  event: ProcedureScheduleEvent;
}
export interface ProcedureScheduleFilters {
  search: string;
  status: 'all' | 'planned' | 'completed' | 'cancelled';
  booking: 'all' | ProcedureScheduleState;
}
export interface ProcedureSchedulePage {
  items: ProcedureScheduleRow[];
  filters: ProcedureScheduleFilters;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
export interface ProcedureAppointmentCandidate {
  appointment: ProcedureAppointmentSnapshot;
  revision: string;
}
export interface ProcedureCandidatePage {
  procedureId: string;
  from: string;
  to: string;
  items: ProcedureAppointmentCandidate[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
