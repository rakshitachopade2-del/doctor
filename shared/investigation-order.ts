import { z } from 'zod';
import type { Investigation } from './clinical';
import { required, text } from './validation.ts';

const dueDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      !Number.isNaN(Date.parse(`${value}T12:00:00Z`)) &&
      new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value,
    'Invalid calendar date.',
  );

export const investigationOrderFields = z.object({
  patientId: required,
  title: required,
  kind: z.enum(['laboratory', 'pathology', 'imaging', 'other']),
  reason: text.min(1),
  instructions: text.min(1),
  dueDate: dueDate.nullable(),
});

export type InvestigationOrderFields = z.infer<typeof investigationOrderFields>;

export interface InvestigationOrderCommand extends InvestigationOrderFields {
  doctorId: string;
  orderedByRole: 'doctor' | 'admin';
  requestId: string;
  reviewedConfirmed: true;
}
export interface InvestigationOrderReceipt {
  actorId: string;
  requestId: string;
  orderedByRole: InvestigationOrderCommand['orderedByRole'];
  order: Investigation;
}
export interface InvestigationOrderResponse {
  receipt: InvestigationOrderReceipt;
}
export interface InvestigationNotOrdered {
  code: 'INVESTIGATION_NOT_ORDERED';
  actorId: string;
  command: InvestigationOrderCommand;
  message: string;
}
