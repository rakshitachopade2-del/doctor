import type { Encounter } from './types';
import type { EncounterAmendment } from './clinical';

export interface ConsultationNoteInput {
  patientId: string;
  appointmentId?: string;
  history?: string;
  examination?: string;
  assessment: string;
  investigations?: string;
  plan: string;
  reviewedConfirmed: true;
  requestId: string;
}
export interface ConsultationAmendmentInput {
  reason: string;
  text: string;
  reviewedConfirmed: true;
  requestId: string;
}
export interface ConsultationRecordingReceipt {
  requestId: string;
  actorId: string;
  operation: 'create' | 'amend';
  patientId: string;
  encounterId: string;
  amendmentId: string | null;
  /** Original recording clinician, which can differ from the original note's author for amendments. */
  doctorId: string;
}
export interface ConsultationRecordingResult {
  encounter: Encounter;
  amendment: EncounterAmendment | null;
  receipt: ConsultationRecordingReceipt;
}
/** Durable terminal rejection; this exact command can never create documentation later. */
export interface ConsultationNotRecorded {
  error: string;
  consultationOutcome: 'not-recorded';
  requestId: string;
  actorId: string;
  operation: 'create' | 'amend';
  patientId: string;
  encounterId: string | null;
}
