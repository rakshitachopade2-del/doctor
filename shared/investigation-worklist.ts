import type { Investigation } from './clinical';

export interface InvestigationOwner {
  doctorId: string;
  doctorName: string;
  activeAccounts: number;
}
export interface InvestigationAssignment {
  id: string;
  investigationId: string;
  doctorId: string;
  doctorName: string;
  previousDoctorId: string;
  previousDoctorName: string;
  /** Internal clinical handover, never part of the patient projection. */
  reason: string;
  assignedById: string;
  assignedByName: string;
  createdAt: string;
}
export interface InvestigationHandoverCommand {
  requestId: string;
  expectedRevision: string;
  doctorId: string;
  reason: string;
  recoverable: true;
}
export interface InvestigationHandoverReceipt {
  requestId: string;
  actorId: string;
  investigationId: string;
  expectedRevision: string;
  assignment: InvestigationAssignment;
}
export interface InvestigationHandoverNotRecorded {
  code: 'INVESTIGATION_HANDOVER_NOT_RECORDED';
  actorId: string;
  investigationId: string;
  command: InvestigationHandoverCommand;
  message: string;
}
export interface InvestigationWorkItem {
  investigationId: string;
  patientId: string;
  patientName: string;
  title: string;
  kind: Investigation['kind'];
  orderedByDoctorId: string;
  orderedByDoctorName: string;
  ownerDoctorId: string;
  ownerDoctorName: string;
  ownerAvailable: boolean;
  status: Investigation['status'];
  /** Original requested result date; never a clinical review deadline. */
  dueDate: string | null;
  createdAt: string;
  latestResultId: string | null;
  latestResultAt: string | null;
  /** Most recent review of the latest submitted result, if any. */
  latestReviewId: string | null;
  latestReviewAt: string | null;
  needsReview: boolean;
  awaitingPublication: boolean;
  pastRequestedDate: boolean;
  revision: string;
}
export interface InvestigationReviewContext extends InvestigationWorkItem {
  investigation: Investigation;
  assignments: InvestigationAssignment[];
}
