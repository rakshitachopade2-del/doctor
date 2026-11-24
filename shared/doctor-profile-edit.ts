import type { DoctorProfileFields } from './doctor-profile-creation.ts';

export type DoctorProfileSnapshot = DoctorProfileFields & { id: string };

export interface DoctorProfileEditContext {
  doctor: DoctorProfileSnapshot;
  revision: string;
}
export interface DoctorProfileEditCommand {
  profile: DoctorProfileFields;
  expectedRevision: string;
  requestId: string;
  reviewedConfirmed: true;
}
export interface DoctorProfileEditReceipt {
  actorId: string;
  doctorId: string;
  requestId: string;
  expectedRevision: string;
  revision: string;
  before: DoctorProfileSnapshot;
  after: DoctorProfileSnapshot;
}
export interface DoctorProfileEditResponse {
  receipt: DoctorProfileEditReceipt;
}
export interface DoctorProfileEditRefusal {
  code: 'DOCTOR_PROFILE_CHANGED' | 'DOCTOR_PROFILE_UNCHANGED';
  actorId: string;
  doctorId: string;
  requestId: string;
  expectedRevision: string;
  profile: DoctorProfileFields;
}
export interface DoctorProfileEditChange {
  id: string;
  doctorId: string;
  actorId: string;
  actorName: string;
  createdAt: string;
  source: 'reviewed' | 'legacy';
  before: DoctorProfileSnapshot;
  after: DoctorProfileSnapshot;
}
export interface DoctorProfileEditHistory {
  items: DoctorProfileEditChange[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
