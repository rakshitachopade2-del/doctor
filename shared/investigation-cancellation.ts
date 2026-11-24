import { z } from 'zod';
import { required, text } from './validation.ts';

export const investigationCancellationReason = text.min(1);
export const investigationCancellationCommand = z.strictObject({
  requestId: z.uuid().transform((value) => value.toLowerCase()),
  investigationId: required,
  patientId: required,
  doctorId: required,
  cancelledByRole: z.enum(['doctor', 'admin']),
  expectedLatestResultId: required.nullable(),
  reason: investigationCancellationReason,
  reviewedConfirmed: z.literal(true),
});

export type InvestigationCancellationCommand = z.infer<typeof investigationCancellationCommand>;
export type InvestigationCancellationReceipt = Omit<
  InvestigationCancellationCommand,
  'reviewedConfirmed'
> & {
  actorId: string;
  doctorName: string;
  title: string;
  cancelledAt: string;
};
export interface InvestigationCancellationResponse {
  receipt: InvestigationCancellationReceipt;
}
export interface InvestigationNotCancelled {
  code: 'INVESTIGATION_NOT_CANCELLED';
  actorId: string;
  command: InvestigationCancellationCommand;
  message: string;
}
