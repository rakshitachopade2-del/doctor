import type { ProcedureAgreement, ProcedureCompletion } from '../../shared/clinical';
import type {
  ProcedureCompletionCommand,
  ProcedureCompletionContext,
  ProcedureCompletionNotRecorded,
} from '../../shared/procedure-completion';
import type { ProcedureAppointmentSnapshot } from '../../shared/procedure-scheduling';
import { ApiError } from '../lib';
import { checkedProcedureRecord } from './procedure-decision-helpers';
import { checkedProcedureAppointment } from './procedure-scheduling-helpers';

export interface CompletionAttempt {
  command: ProcedureCompletionCommand;
  patientName: string;
  procedureTitle: string;
  doctorName: string;
  agreement: ProcedureAgreement;
  appointment: ProcedureAppointmentSnapshot | null;
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const bad = () => new Error('The current procedure completion details could not be verified.');

function checkedCompletion(value: unknown, patientId: string): ProcedureCompletion {
  if (
    !object(value) ||
    !text(value.outcome) ||
    !text(value.aftercare) ||
    !text(value.doctorId) ||
    !text(value.doctorName) ||
    !text(value.completedAt) ||
    !Number.isFinite(Date.parse(value.completedAt)) ||
    new Date(value.completedAt).toISOString() !== value.completedAt
  )
    throw bad();
  if (value.appointment != null)
    checkedProcedureAppointment(value.appointment, undefined, patientId);
  return value as unknown as ProcedureCompletion;
}

export function checkedCompletionContext(
  value: unknown,
  patientId: string,
  procedureId: string,
  doctorId: string,
) {
  if (
    !object(value) ||
    value.doctorId !== doctorId ||
    !text(value.doctorName) ||
    !text(value.revision) ||
    !/^[a-f0-9]{64}$/.test(value.revision) ||
    typeof value.allowed !== 'boolean' ||
    (value.allowed ? value.blockedReason !== null : !text(value.blockedReason))
  )
    throw bad();
  const p = checkedProcedureRecord(value.procedure, patientId, procedureId);
  if (
    !(p.effectiveAppointmentId === null || text(p.effectiveAppointmentId)) ||
    p.scheduledAppointment === undefined ||
    (p.status === 'cancelled' ? !text(p.cancellationReason) : p.cancellationReason !== null)
  )
    throw bad();
  if (p.status === 'completed') checkedCompletion(p.completion, patientId);
  else if (p.completion !== null) throw bad();
  if (
    value.allowed &&
    (p.status !== 'planned' ||
      p.agreements.at(-1)?.decision !== 'agreed' ||
      (p.effectiveAppointmentId &&
        (!p.scheduledAppointment ||
          ['cancelled', 'no-show'].includes(p.scheduledAppointment.status))))
  )
    throw bad();
  return value as unknown as ProcedureCompletionContext;
}

function sameVisit(
  a: ProcedureAppointmentSnapshot | null | undefined,
  b: ProcedureAppointmentSnapshot | null | undefined,
) {
  if (!a || !b) return a === b;
  return Object.entries(a).every(
    ([key, value]) => b[key as keyof ProcedureAppointmentSnapshot] === value,
  );
}

export function confirmedCompletion(value: unknown, attempt: CompletionAttempt, actorId: string) {
  if (!object(value) || !object(value.receipt)) return null;
  const { receipt } = value,
    { command } = attempt;
  if (
    receipt.requestId !== command.requestId ||
    receipt.actorId !== actorId ||
    receipt.patientId !== command.patientId ||
    receipt.procedureId !== command.procedureId ||
    receipt.expectedRevision !== command.expectedRevision ||
    receipt.decisionId !== command.expectedDecisionId
  )
    return null;
  const completion = checkedCompletion(receipt.completion, command.patientId);
  if (
    completion.doctorId !== command.doctorId ||
    completion.doctorName !== attempt.doctorName ||
    completion.outcome !== command.outcome ||
    completion.aftercare !== command.aftercare ||
    !sameVisit(attempt.appointment, completion.appointment)
  )
    return null;
  return completion;
}

export function requireOriginalCompletion(
  current: ProcedureCompletionContext,
  attempt: CompletionAttempt,
  saved: ProcedureCompletion,
) {
  const p = current.procedure,
    completion = p.completion,
    latest = p.agreements.at(-1);
  if (
    p.status !== 'completed' ||
    current.allowed ||
    !latest ||
    !Object.entries(attempt.agreement).every(
      ([key, value]) => latest[key as keyof ProcedureAgreement] === value,
    ) ||
    !completion ||
    completion.outcome !== saved.outcome ||
    completion.aftercare !== saved.aftercare ||
    completion.doctorId !== saved.doctorId ||
    completion.doctorName !== saved.doctorName ||
    completion.completedAt !== saved.completedAt ||
    !sameVisit(saved.appointment, completion.appointment)
  )
    throw bad();
}

export function requireObservedProcedure(
  current: ProcedureCompletionContext,
  reviewed: ProcedureAgreement,
  observed: ProcedureCompletionNotRecorded['observed'],
) {
  const { agreements, status } = current.procedure;
  const reviewedPosition = agreements.findIndex((entry) => entry.id === reviewed.id);
  const original = agreements[reviewedPosition];
  if (
    !original ||
    !Object.entries(reviewed).every(
      ([key, value]) => original[key as keyof ProcedureAgreement] === value,
    ) ||
    (observed.status !== 'planned' && status !== observed.status)
  )
    throw bad();
  // Choices are append-only, even if the visit or performing clinician later changes back.
  const observedPosition = agreements.findIndex((entry) => entry.id === observed.decisionId);
  if (observedPosition < reviewedPosition) throw bad();
}

export function completionRefusal(
  error: unknown,
  command: ProcedureCompletionCommand,
  actorId: string,
) {
  if (!(error instanceof ApiError) || error.status !== 409 || !object(error.responseData))
    return null;
  const { code, actorId: returnedActor, message, command: returned, observed } = error.responseData;
  return code === 'PROCEDURE_COMPLETION_NOT_RECORDED' &&
    returnedActor === actorId &&
    text(message) &&
    object(observed) &&
    (observed.decisionId === null || text(observed.decisionId)) &&
    (observed.status === 'planned' ||
      observed.status === 'completed' ||
      observed.status === 'cancelled') &&
    object(returned) &&
    Object.keys(returned).length === Object.keys(command).length &&
    Object.entries(command).every(([key, value]) => returned[key] === value)
    ? { message, observed: observed as ProcedureCompletionNotRecorded['observed'] }
    : null;
}
