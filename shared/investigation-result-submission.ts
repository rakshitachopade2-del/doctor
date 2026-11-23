import type { InvestigationResult } from './clinical';

export interface InvestigationResultCommand extends Pick<
  InvestigationResult,
  'investigationId' | 'note' | 'documentIds'
> {
  requestId: string;
  patientId: string;
  submittedByRole: 'patient' | 'doctor' | 'admin';
  reviewedConfirmed: true;
}

export interface InvestigationResultReceipt {
  requestId: string;
  actorId: string;
  patientId: string;
  investigationId: string;
  result: InvestigationResult;
}

export interface InvestigationResultResponse {
  receipt: InvestigationResultReceipt;
}

export interface InvestigationResultNotSubmitted {
  code: 'INVESTIGATION_RESULT_NOT_SUBMITTED';
  actorId: string;
  command: InvestigationResultCommand;
  message: string;
}
