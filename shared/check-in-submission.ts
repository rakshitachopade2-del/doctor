import type { CheckIn } from './types';

export type CheckInFields = Pick<CheckIn, 'carePlanId' | 'date' | 'adherence' | 'feeling' | 'note'>;

export interface CheckInSubmissionCommand extends CheckInFields {
  requestId: string;
  patientId: string;
  expectedUpdatedAt: string | null;
  reviewedConfirmed: true;
}

export interface CheckInSubmissionReceipt {
  requestId: string;
  actorId: string;
  patientId: string;
  carePlanId: string;
  date: string;
  expectedUpdatedAt: string | null;
  operation: 'created' | 'corrected';
  checkIn: CheckIn;
}

export interface CheckInSubmissionResult {
  receipt: CheckInSubmissionReceipt;
}

export interface CheckInNotSaved {
  code: 'CHECK_IN_NOT_SAVED';
  actorId: string;
  command: CheckInSubmissionCommand;
  message: string;
}
