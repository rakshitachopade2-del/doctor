import type { ProcedureCompletion, ProcedureRecord } from './clinical';

export interface ProcedureCompletionContext {
  procedure: ProcedureRecord;
  doctorId: string;
  doctorName: string;
  revision: string;
  allowed: boolean;
  blockedReason: string | null;
}

export interface ProcedureCompletionCommand {
  requestId: string;
  patientId: string;
  procedureId: string;
  doctorId: string;
  recordedByRole: 'doctor' | 'admin';
  expectedRevision: string;
  expectedDecisionId: string;
  outcome: string;
  aftercare: string;
  reviewedConfirmed: true;
}

export interface ProcedureCompletionReceipt {
  requestId: string;
  actorId: string;
  patientId: string;
  procedureId: string;
  expectedRevision: string;
  decisionId: string;
  completion: ProcedureCompletion;
}

export interface ProcedureCompletionResponse {
  receipt: ProcedureCompletionReceipt;
}

export interface ProcedureCompletionNotRecorded {
  code: 'PROCEDURE_COMPLETION_NOT_RECORDED';
  observed: { decisionId: string | null; status: ProcedureRecord['status'] };
  actorId: string;
  command: ProcedureCompletionCommand;
  message: string;
}
