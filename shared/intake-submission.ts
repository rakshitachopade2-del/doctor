import type { Intake } from './types';

export type IntakeAnswers = Omit<Intake, 'id' | 'patientId' | 'createdAt' | 'consent'> & {
  consent: true;
};

export interface IntakeSubmissionCommand extends IntakeAnswers {
  requestId: string;
  patientId: string;
}

export interface IntakeSubmissionResult {
  receipt: {
    requestId: string;
    actorId: string;
    patientId: string;
    intake: Intake;
  };
}

export interface IntakeNotSubmitted {
  code: 'INTAKE_NOT_SUBMITTED';
  requestId: string;
  actorId: string;
  patientId: string;
  answers: IntakeAnswers;
  message: string;
}
