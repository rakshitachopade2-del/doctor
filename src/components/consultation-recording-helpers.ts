import type { Encounter, PatientRecord } from '../../shared/types';
import type { EncounterAmendment, PatientClinicalWorkflows } from '../../shared/clinical';
import type {
  ConsultationNoteInput,
  ConsultationAmendmentInput,
  ConsultationRecordingResult,
} from '../../shared/consultation-recording';
import { ApiError } from '../lib';
import { checkedVisitAppointment } from './visit-duration-helpers';

type RecordingActor = { actorId: string; doctorId: string; patientId: string };
export type ConsultationAttempt = RecordingActor &
  (
    | { operation: 'create'; source: null; body: ConsultationNoteInput }
    | { operation: 'amend'; source: Encounter; body: ConsultationAmendmentInput }
  );
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const identifier = (value: unknown): value is string => text(value) && value.length <= 300;
const content = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 8000;
const uuid = (value: unknown) =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const timestamp = (value: unknown): value is string =>
  text(value) && Number.isFinite(Date.parse(value));
const bad = () =>
  new Error(
    'The response did not confirm this clinical record. Retry the same submitted request or reopen the patient record.',
  );
export const recordingFailure = (error: unknown) =>
  error instanceof Error ? error.message : 'The clinical record could not be confirmed.';
export function checkedEncounter(
  value: unknown,
  patientId: string,
  encounterId?: string,
): Encounter {
  if (
    !object(value) ||
    !identifier(value.id) ||
    (encounterId !== undefined && value.id !== encounterId) ||
    value.patientId !== patientId ||
    !identifier(value.doctorId) ||
    !text(value.doctorName) ||
    !timestamp(value.createdAt) ||
    (value.appointmentId !== undefined && !identifier(value.appointmentId)) ||
    !['history', 'examination', 'assessment', 'investigations', 'plan'].every((key) =>
      content(value[key]),
    ) ||
    !text(value.assessment) ||
    !text(value.plan)
  )
    throw bad();
  return value as unknown as Encounter;
}
export function checkedEncounterAmendment(
  value: unknown,
  patientId: string,
  encounterId?: string,
): EncounterAmendment {
  if (
    !object(value) ||
    !identifier(value.id) ||
    value.patientId !== patientId ||
    !identifier(value.encounterId) ||
    (encounterId !== undefined && value.encounterId !== encounterId) ||
    !identifier(value.doctorId) ||
    !text(value.doctorName) ||
    !timestamp(value.createdAt) ||
    !text(value.reason) ||
    !content(value.reason) ||
    !text(value.text) ||
    !content(value.text)
  )
    throw bad();
  return value as unknown as EncounterAmendment;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
export function checkedConsultationResult(
  value: unknown,
  attempt: ConsultationAttempt,
): ConsultationRecordingResult {
  if (!object(value) || !object(value.receipt)) throw bad();
  const encounter = checkedEncounter(value.encounter, attempt.patientId, attempt.source?.id),
    receipt = value.receipt;
  if (
    receipt.requestId !== attempt.body.requestId ||
    !uuid(receipt.requestId) ||
    receipt.actorId !== attempt.actorId ||
    receipt.operation !== attempt.operation ||
    receipt.patientId !== attempt.patientId ||
    receipt.encounterId !== encounter.id ||
    receipt.doctorId !== attempt.doctorId
  )
    throw bad();
  if (attempt.operation === 'create') {
    if (
      !uuid(encounter.id) ||
      value.amendment !== null ||
      receipt.amendmentId !== null ||
      encounter.doctorId !== attempt.doctorId ||
      encounter.appointmentId !== attempt.body.appointmentId ||
      !(['history', 'examination', 'assessment', 'investigations', 'plan'] as const).every(
        (key) => encounter[key] === (attempt.body[key] ?? '').trim(),
      )
    )
      throw bad();
    return { encounter, amendment: null, receipt } as unknown as ConsultationRecordingResult;
  }
  const amendment = checkedEncounterAmendment(value.amendment, attempt.patientId, encounter.id);
  if (
    JSON.stringify(canonical(encounter)) !== JSON.stringify(canonical(attempt.source)) ||
    !uuid(amendment.id) ||
    receipt.amendmentId !== amendment.id ||
    amendment.doctorId !== attempt.doctorId ||
    amendment.reason !== attempt.body.reason.trim() ||
    amendment.text !== attempt.body.text.trim()
  )
    throw bad();
  return { encounter, amendment, receipt } as unknown as ConsultationRecordingResult;
}
export function consultationNotRecorded(error: unknown, attempt: ConsultationAttempt) {
  if (
    !(error instanceof ApiError) ||
    ![400, 404, 409].includes(error.status) ||
    !object(error.responseData)
  )
    return false;
  const value = error.responseData;
  return (
    text(value.error) &&
    value.consultationOutcome === 'not-recorded' &&
    value.requestId === attempt.body.requestId &&
    value.actorId === attempt.actorId &&
    value.operation === attempt.operation &&
    value.patientId === attempt.patientId &&
    value.encounterId === (attempt.source?.id ?? null)
  );
}
export function checkedConsultationRecord(value: unknown, patientId: string): PatientRecord {
  if (
    !object(value) ||
    !object(value.patient) ||
    value.patient.id !== patientId ||
    !text(value.patient.name) ||
    !['appointments', 'intakes', 'encounters', 'carePlans', 'checkIns', 'images', 'messages'].every(
      (key) => Array.isArray(value[key]),
    )
  )
    throw bad();
  const encounters = (value.encounters as unknown[]).map((entry) =>
    checkedEncounter(entry, patientId),
  );
  const appointments = (value.appointments as unknown[]).map((entry) => {
    const appointment = checkedVisitAppointment(entry);
    if (appointment.patientId !== patientId) throw bad();
    return appointment;
  });
  return { ...value, encounters, appointments } as unknown as PatientRecord;
}
export function checkedConsultationWorkflows(
  value: unknown,
  patientId: string,
): PatientClinicalWorkflows {
  if (
    !object(value) ||
    !['investigations', 'procedures', 'amendments'].every((key) => Array.isArray(value[key]))
  )
    throw bad();
  const procedures = value.procedures as unknown[];
  if (
    !procedures.every((entry) => object(entry) && text(entry.id) && entry.patientId === patientId)
  )
    throw bad();
  const amendments = (value.amendments as unknown[]).map((entry) =>
    checkedEncounterAmendment(entry, patientId),
  );
  return { ...value, amendments } as unknown as PatientClinicalWorkflows;
}
