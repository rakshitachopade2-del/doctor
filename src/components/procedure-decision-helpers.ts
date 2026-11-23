import type { ProcedureAgreement, ProcedureRecord } from '../../shared/clinical';
import type { ProcedureDecisionCommand } from '../../shared/procedure-decision';
import { ApiError } from '../lib';
import { procedureFieldNames } from './procedure-plan-helpers';
import { checkedProcedureAppointment } from './procedure-scheduling-helpers';

export const decisionMethods = {
  portal: 'Patient portal',
  phone: 'By phone',
  'in-person': 'In person',
};
export const decisionChoice = (choice: ProcedureAgreement['decision']) =>
  choice === 'agreed' ? 'Agreed' : 'Declined';
export interface DecisionAttempt {
  command: ProcedureDecisionCommand;
  patientName: string;
  procedureTitle: string;
  actorName: string;
  previous: ProcedureAgreement | null;
  priorIds: string[];
}

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
const timestamp = (v: unknown): v is string =>
  text(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const bad = () => new Error('The current procedure could not be verified. Please try again.');

function isDecision(v: unknown, procedureId: string): v is ProcedureAgreement {
  return (
    object(v) &&
    text(v.id) &&
    v.procedureId === procedureId &&
    ['agreed', 'declined'].includes(String(v.decision)) &&
    typeof v.note === 'string' &&
    text(v.recordedById) &&
    text(v.recordedByName) &&
    (v.recordedByRole === 'patient'
      ? v.method === 'portal'
      : ['doctor', 'admin'].includes(String(v.recordedByRole)) &&
        ['in-person', 'phone'].includes(String(v.method)) &&
        text(v.note)) &&
    timestamp(v.createdAt)
  );
}
export function checkedDecisionProcedure(
  value: unknown,
  patientId: string,
  procedureId: string,
): ProcedureRecord {
  if (
    !object(value) ||
    !Array.isArray(value.procedures) ||
    !value.procedures.every((p) => object(p) && p.patientId === patientId && text(p.id))
  )
    throw bad();
  const matches = value.procedures.filter((p) => p.id === procedureId);
  if (matches.length !== 1) throw bad();
  const p = matches[0] as Record<string, unknown>;
  if (
    !text(p.title) ||
    !text(p.doctorName) ||
    !timestamp(p.createdAt) ||
    [...procedureFieldNames, 'indication'].some((key) => typeof p[key] !== 'string') ||
    !['planned', 'completed', 'cancelled'].includes(String(p.status)) ||
    !Array.isArray(p.agreements) ||
    !p.agreements.every((a) => isDecision(a, procedureId)) ||
    new Set(p.agreements.map((a) => a.id)).size !== p.agreements.length ||
    !(p.appointmentId === null || text(p.appointmentId)) ||
    !(
      p.effectiveAppointmentId === undefined ||
      p.effectiveAppointmentId === null ||
      text(p.effectiveAppointmentId)
    )
  )
    throw bad();
  if (p.scheduledAppointment != null) {
    const link =
      p.effectiveAppointmentId === undefined ? p.appointmentId : p.effectiveAppointmentId;
    if (!text(link)) throw bad();
    checkedProcedureAppointment(p.scheduledAppointment, link, patientId);
  }
  const source = p.templateSource;
  if (
    source != null &&
    (!object(source) ||
      !text(source.templateTitle) ||
      !text(source.reviewedByDoctorName) ||
      !timestamp(source.publishedAt) ||
      !Number.isSafeInteger(source.version) ||
      Number(source.version) < 1)
  )
    throw bad();
  return p as unknown as ProcedureRecord;
}

export function confirmedDecision(value: unknown, attempt: DecisionAttempt, actorId: string) {
  if (!object(value) || !object(value.receipt)) return null;
  const { receipt } = value,
    { command } = attempt,
    agreement = receipt.agreement;
  if (
    receipt.actorId !== actorId ||
    receipt.requestId !== command.requestId ||
    receipt.patientId !== command.patientId ||
    receipt.procedureId !== command.procedureId ||
    receipt.expectedLatestDecisionId !== command.expectedLatestDecisionId ||
    !isDecision(agreement, command.procedureId) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(agreement.id) ||
    agreement.id === command.requestId ||
    attempt.priorIds.includes(agreement.id) ||
    agreement.recordedById !== actorId ||
    agreement.recordedByRole !== command.recordedByRole ||
    agreement.decision !== command.decision ||
    agreement.method !== command.method ||
    agreement.note !== command.note
  )
    return null;
  return agreement;
}

function sameDecision(entry: ProcedureAgreement | undefined, original: ProcedureAgreement) {
  return (
    !!entry &&
    Object.entries(original).every(
      ([key, value]) => entry[key as keyof ProcedureAgreement] === value,
    )
  );
}

// The original sequence is append-only. A receipt or conflict cannot erase the reviewed history.
export function requireDecisionHistory(
  plan: ProcedureRecord,
  attempt: DecisionAttempt,
  saved?: ProcedureAgreement,
) {
  const position = attempt.priorIds.length;
  if (
    !attempt.priorIds.every((id, i) => plan.agreements[i]?.id === id) ||
    (attempt.previous && !sameDecision(plan.agreements[position - 1], attempt.previous))
  )
    throw bad();
  if (saved) {
    if (!sameDecision(plan.agreements[position], saved)) throw bad();
  } else if (plan.status === 'planned' && plan.agreements.length === position) {
    // A still-planned procedure with its original choice cannot explain a verified conflict.
    throw bad();
  }
}
export function decisionRejection(
  error: unknown,
  command: ProcedureDecisionCommand,
  actorId: string,
) {
  if (!(error instanceof ApiError) || error.status !== 409 || !object(error.responseData))
    return null;
  const { code, actorId: respondent, message, command: returned } = error.responseData;
  return code === 'PROCEDURE_DECISION_NOT_RECORDED' &&
    respondent === actorId &&
    text(message) &&
    object(returned) &&
    Object.keys(returned).length === Object.keys(command).length &&
    Object.entries(command).every(([k, v]) => returned[k] === v)
    ? message
    : null;
}
