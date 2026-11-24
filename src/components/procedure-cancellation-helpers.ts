import { z } from 'zod';
import type { ProcedureAgreement } from '../../shared/clinical';
import type {
  ProcedureCancellationCommand,
  ProcedureCancellationContext,
  ProcedureCancellationReceipt,
} from '../../shared/procedure-cancellation';
import type { ProcedureAppointmentSnapshot } from '../../shared/procedure-scheduling';
import { ApiError } from '../lib';
import { checkedProcedureRecordingContext, sameVisit } from './procedure-completion-helpers';
import { checkedProcedureAppointment } from './procedure-scheduling-helpers';

export interface ProcedureCancellationAttempt {
  command: ProcedureCancellationCommand;
  patientName: string;
  procedureTitle: string;
  doctorName: string;
  agreement: ProcedureAgreement | null;
  appointment: ProcedureAppointmentSnapshot | null;
  linked: boolean;
}

export function cancellationContext(
  value: unknown,
  patientId: string,
  procedureId: string,
  doctorId: string,
  previous: ProcedureCancellationAttempt | null,
): ProcedureCancellationContext {
  const context = checkedProcedureRecordingContext(value, patientId, procedureId, doctorId);
  const plan = context.procedure;
  if (context.allowed !== (plan.status === 'planned'))
    throw new Error('The procedure status could not be verified.');
  if (previous) {
    const decision = previous.agreement;
    const original = decision && plan.agreements.find((a) => a.id === decision.id);
    if (
      plan.title !== previous.procedureTitle ||
      context.revision === previous.command.expectedRevision ||
      (decision &&
        (!original ||
          !Object.entries(decision).every(
            ([k, v]) => original[k as keyof ProcedureAgreement] === v,
          )))
    ) {
      throw new Error(
        'The updated decision and visit could not be verified. Refresh the procedure to try again.',
      );
    }
  }
  return context;
}
const confirmation = z.strictObject({
  receipt: z.strictObject({
    requestId: z.string(),
    actorId: z.string(),
    patientId: z.string(),
    procedureId: z.string(),
    doctorId: z.string(),
    doctorName: z.string().min(1),
    cancelledByRole: z.enum(['admin', 'doctor']),
    expectedRevision: z.string(),
    expectedDecisionId: z.string().nullable(),
    reason: z.string(),
    title: z.string(),
    appointment: z.unknown(),
    cancelledAt: z.iso.datetime(),
  }),
});
export function confirmedCancellation(
  value: unknown,
  attempt: ProcedureCancellationAttempt,
  actorId: string,
): ProcedureCancellationReceipt | null {
  const parsed = confirmation.safeParse(value);
  if (!parsed.success) return null;
  const receipt = parsed.data.receipt,
    { command } = attempt;
  if (
    receipt.actorId !== actorId ||
    receipt.requestId !== command.requestId ||
    receipt.patientId !== command.patientId ||
    receipt.procedureId !== command.procedureId ||
    receipt.doctorId !== command.doctorId ||
    receipt.doctorName !== attempt.doctorName ||
    receipt.cancelledByRole !== command.cancelledByRole ||
    receipt.expectedRevision !== command.expectedRevision ||
    receipt.expectedDecisionId !== command.expectedDecisionId ||
    receipt.reason !== command.reason ||
    receipt.title !== attempt.procedureTitle
  )
    return null;
  const appointment =
    receipt.appointment === null
      ? null
      : checkedProcedureAppointment(
          receipt.appointment,
          attempt.appointment?.id,
          command.patientId,
        );
  return sameVisit(attempt.appointment, appointment) ? { ...receipt, appointment } : null;
}
const refusal = z.strictObject({
  code: z.literal('PROCEDURE_NOT_CANCELLED'),
  actorId: z.string(),
  message: z.string().trim().min(1),
  command: z.record(z.string(), z.unknown()),
});
export function cancellationRefusal(
  error: unknown,
  command: ProcedureCancellationCommand,
  actorId: string,
) {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const parsed = refusal.safeParse(error.responseData);
  if (!parsed.success) return null;
  const r = parsed.data;
  return r.actorId === actorId &&
    Object.keys(r.command).length === Object.keys(command).length &&
    Object.entries(command).every(([k, v]) => r.command[k] === v)
    ? r.message
    : null;
}
