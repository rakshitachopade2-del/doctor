import type { Appointment, AppointmentStatus, AuditEntry, Patient } from './types';

/** Each request reflects current records; pages are not a frozen historical snapshot. */
export interface SearchPage<T> {
  items: T[];
  /** Effective page after clamping to the last available page. */
  page: number;
  pageSize: number;
  total: number;
  /** At least one, including an empty result. */
  totalPages: number;
}

/** Directory information only; clinical allergy values/status are never included. */
export type PatientDirectoryItem = Pick<
  Patient,
  'id' | 'name' | 'email' | 'phone' | 'dob' | 'gender' | 'createdAt'
>;
export type PatientSearchPage = SearchPage<PatientDirectoryItem>;
export type AppointmentSearchPage = SearchPage<Appointment>;
export type AuditSearchPage = SearchPage<AuditEntry>;
export type AppointmentSearchStatus = AppointmentStatus | 'waiting';

export interface SearchPagination {
  page?: number;
  pageSize?: number;
}
export interface PatientSearchFilters extends SearchPagination {
  q?: string;
}
export interface AppointmentSearchFilters extends SearchPagination {
  q?: string;
  from?: string;
  to?: string;
  doctorId?: string;
  patientId?: string;
  status?: AppointmentSearchStatus;
  mode?: Appointment['mode'];
}
export interface AuditSearchFilters extends SearchPagination {
  q?: string;
  actor?: string;
  action?: string;
  entityType?: string;
  entityId?: string;
  /** Inclusive Asia/Kolkata calendar dates for the audit timestamp. */
  from?: string;
  to?: string;
}
