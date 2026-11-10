import type { CarePlan, CheckIn, Patient } from './types';

export interface CheckInSnapshot {
  id: string;
  updatedAt: string;
  contentHash: string;
  snapshot: CheckIn;
}
export interface FollowUpReview {
  id: string;
  carePlanId: string;
  doctorId: string;
  doctorName: string;
  source: 'clinical-review' | 'status-change';
  assessment: string;
  patientInstructions: string;
  disposition: 'continue' | 'visit-requested' | 'complete';
  nextReviewDate: string | null;
  checkInSnapshots: CheckInSnapshot[];
  createdAt: string;
}
export type PatientFollowUpReview = Omit<FollowUpReview, 'assessment' | 'checkInSnapshots'>;
export interface FollowUpSummary {
  effectiveStatus: 'active' | 'completed';
  effectiveFollowUpDate: string | null;
  followUpRevision: string;
  latestReview: FollowUpReview | PatientFollowUpReview | null;
}
export interface FollowUpWorkItem {
  carePlan: CarePlan & FollowUpSummary;
  patient: Patient;
  ownerDoctorId: string;
  ownerDoctorName: string;
  revision: string;
  latestReview: FollowUpReview | null;
  unreviewedCheckIns: CheckIn[];
  unreviewedCount: number;
  due: boolean;
}

export interface FollowUpOwner {
  doctorId: string;
  doctorName: string;
  activeAccounts: number;
}

export interface FollowUpAssignment {
  id: string;
  carePlanId: string;
  doctorId: string;
  doctorName: string;
  previousDoctorId: string;
  previousDoctorName: string;
  reason: string;
  assignedById: string;
  assignedByName: string;
  createdAt: string;
}
