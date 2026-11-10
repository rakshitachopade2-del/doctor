import type { Role } from './types';

export interface InvestigationResult {
  id: string;
  investigationId: string;
  note: string;
  documentIds: string[];
  submittedById: string;
  submittedByName: string;
  submittedByRole: Role;
  createdAt: string;
}
export interface InvestigationReview {
  id: string;
  investigationId: string;
  resultId: string;
  summary: string;
  followUp: string;
  doctorId: string;
  doctorName: string;
  publishedAt: string | null;
  createdAt: string;
}
export interface Investigation {
  id: string;
  patientId: string;
  doctorId: string;
  doctorName: string;
  title: string;
  kind: 'laboratory' | 'pathology' | 'imaging' | 'other';
  reason: string;
  instructions: string;
  dueDate: string | null;
  status: 'ordered' | 'result-received' | 'reviewed' | 'cancelled';
  cancellationReason: string | null;
  createdAt: string;
  results: InvestigationResult[];
  reviews: InvestigationReview[];
}
export interface EncounterAmendment {
  id: string;
  encounterId: string;
  patientId: string;
  doctorId: string;
  doctorName: string;
  reason: string;
  text: string;
  createdAt: string;
}
export interface ProcedureAgreement {
  id: string;
  procedureId: string;
  decision: 'agreed' | 'declined';
  method: 'portal' | 'in-person' | 'phone';
  note: string;
  recordedById: string;
  recordedByName: string;
  recordedByRole: Role;
  createdAt: string;
}
export interface ProcedureCompletion {
  outcome: string;
  aftercare: string;
  doctorId: string;
  doctorName: string;
  completedAt: string;
}
export interface ProcedureRecord {
  id: string;
  patientId: string;
  appointmentId: string | null;
  doctorId: string;
  doctorName: string;
  title: string;
  indication: string;
  benefits: string;
  risks: string;
  alternatives: string;
  aftercare: string;
  estimatedCost: string;
  status: 'planned' | 'completed' | 'cancelled';
  cancellationReason: string | null;
  createdAt: string;
  agreements: ProcedureAgreement[];
  completion: ProcedureCompletion | null;
}
export interface PatientClinicalWorkflows {
  investigations: Investigation[];
  procedures: ProcedureRecord[];
  amendments: EncounterAmendment[];
}
