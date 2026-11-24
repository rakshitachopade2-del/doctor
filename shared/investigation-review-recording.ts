import { z } from 'zod';
import type { InvestigationReview } from './clinical';
import { required, text } from './validation.ts';

export const reviewFields = z.object({
  resultId: required,
  summary: text.min(1),
  followUp: text,
  publishToPatient: z.boolean(),
});
export const investigationReviewCommand = reviewFields
  .extend({
    requestId: z.uuid().transform((v) => v.toLowerCase()),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
    patientId: required,
    investigationId: required,
    doctorId: required,
    reviewedByRole: z.enum(['admin', 'doctor']),
  })
  .strict();
export type InvestigationReviewCommand = z.infer<typeof investigationReviewCommand>;
export interface InvestigationReviewReceipt {
  requestId: string;
  actorId: string;
  patientId: string;
  investigationId: string;
  expectedRevision: string;
  reviewedByRole: InvestigationReviewCommand['reviewedByRole'];
  review: InvestigationReview;
}
export interface InvestigationReviewNotRecorded {
  code: 'INVESTIGATION_REVIEW_NOT_RECORDED';
  actorId: string;
  command: InvestigationReviewCommand;
  message: string;
}
