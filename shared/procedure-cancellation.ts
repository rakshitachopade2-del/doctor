import { z } from 'zod';
import type { ProcedureRecord } from './clinical';
import type { ProcedureAppointmentSnapshot } from './procedure-scheduling';
import { required, text } from './validation.ts';

export interface ProcedureCancellationContext {
  procedure: ProcedureRecord;
  doctorId: string;
  doctorName: string;
  revision: string;
  allowed: boolean;
  blockedReason: string | null;
}
export const procedureCancellationReason = text.min(1);
export const procedureCancellationCommand = z.strictObject({
  requestId: z.uuid().transform((value) => value.toLowerCase()),
  patientId: required,
  procedureId: required,
  doctorId: required,
  cancelledByRole: z.enum(['doctor', 'admin']),
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  expectedDecisionId: required.nullable(),
  reason: procedureCancellationReason,
  reviewedConfirmed: z.literal(true),
});
export type ProcedureCancellationCommand = z.infer<typeof procedureCancellationCommand>;
export type ProcedureCancellationReceipt = Omit<
  ProcedureCancellationCommand,
  'reviewedConfirmed'
> & {
  actorId: string;
  doctorName: string;
  title: string;
  appointment: ProcedureAppointmentSnapshot | null;
  cancelledAt: string;
};
export interface ProcedureCancellationResponse {
  receipt: ProcedureCancellationReceipt;
}
export interface ProcedureNotCancelled {
  code: 'PROCEDURE_NOT_CANCELLED';
  actorId: string;
  command: ProcedureCancellationCommand;
  message: string;
}
