import type { ProcedureAgreement } from './clinical';

export interface ProcedureDecisionCommand extends Pick<
  ProcedureAgreement,
  'procedureId' | 'decision' | 'method' | 'note'
> {
  requestId: string;
  patientId: string;
  recordedByRole: 'patient' | 'doctor' | 'admin';
  expectedLatestDecisionId: string | null;
  patientDecisionConfirmed: boolean;
  reviewedConfirmed: true;
}

export interface ProcedureDecisionReceipt {
  requestId: string;
  actorId: string;
  patientId: string;
  procedureId: string;
  expectedLatestDecisionId: string | null;
  agreement: ProcedureAgreement;
}

export interface ProcedureDecisionResponse {
  receipt: ProcedureDecisionReceipt;
}

export interface ProcedureDecisionNotRecorded {
  code: 'PROCEDURE_DECISION_NOT_RECORDED';
  actorId: string;
  command: ProcedureDecisionCommand;
  message: string;
}
