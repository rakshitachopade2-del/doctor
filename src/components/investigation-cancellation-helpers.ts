import { z } from 'zod';
import type { InvestigationResult } from '../../shared/clinical';
import type { InvestigationCancellationCommand } from '../../shared/investigation-cancellation';
import { ApiError } from '../lib';
import { checkedInvestigationContext } from './InvestigationReviewModal';

export interface CancellationAttempt {
  command: InvestigationCancellationCommand;
  title: string;
  patientName: string;
  doctorName: string;
  orderedByName: string;
  orderedById: string;
  latestResult: InvestigationResult | null;
}

export function cancellationContext(
  value: unknown,
  patientId: string,
  id: string,
  refused: CancellationAttempt | null,
) {
  const { investigation, patientName } = checkedInvestigationContext(value, id);
  const latestResult = investigation.results.at(-1) ?? null;
  const reviewed = investigation.reviews.some((r) => r.resultId === latestResult?.id);
  const expectedStatus = investigation.cancellationReason?.trim()
    ? 'cancelled'
    : !latestResult
      ? 'ordered'
      : reviewed
        ? 'reviewed'
        : 'result-received';
  if (investigation.patientId !== patientId || investigation.status !== expectedStatus)
    throw new Error(
      'The response did not identify this patient and the current investigation status.',
    );
  if (refused) {
    const previous = refused.command.expectedLatestResultId;
    if (
      investigation.title !== refused.title ||
      investigation.doctorId !== refused.orderedById ||
      (previous !== null && !investigation.results.some((result) => result.id === previous)) ||
      ((expectedStatus === 'ordered' || expectedStatus === 'result-received') &&
        previous === (latestResult?.id ?? null))
    )
      throw new Error(
        'The updated investigation could not be verified. Refresh to see its latest result and status.',
      );
  }
  return { investigation, patientName, latestResult };
}

const confirmation = z.strictObject({
  receipt: z.strictObject({
    requestId: z.string(),
    actorId: z.string(),
    investigationId: z.string(),
    patientId: z.string(),
    doctorId: z.string(),
    doctorName: z.string().trim().min(1).max(300),
    cancelledByRole: z.enum(['admin', 'doctor']),
    expectedLatestResultId: z.string().nullable(),
    reason: z.string(),
    title: z.string(),
    cancelledAt: z.iso.datetime(),
  }),
});
const refusal = z.strictObject({
  code: z.literal('INVESTIGATION_NOT_CANCELLED'),
  actorId: z.string(),
  command: z.record(z.string(), z.unknown()),
  message: z.string().trim().min(1),
});
export function confirmedCancellation(
  value: unknown,
  attempt: CancellationAttempt,
  actorId: string,
) {
  const parsed = confirmation.safeParse(value);
  if (!parsed.success) return null;
  const { receipt } = parsed.data,
    { command } = attempt;
  if (
    receipt.actorId !== actorId ||
    receipt.requestId !== command.requestId ||
    receipt.patientId !== command.patientId ||
    receipt.investigationId !== command.investigationId ||
    receipt.doctorId !== command.doctorId ||
    receipt.cancelledByRole !== command.cancelledByRole ||
    receipt.expectedLatestResultId !== command.expectedLatestResultId ||
    receipt.reason !== command.reason ||
    receipt.title !== attempt.title
  )
    return null;
  return receipt;
}
export function cancellationRefusal(error: unknown, attempt: CancellationAttempt, actorId: string) {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const parsed = refusal.safeParse(error.responseData);
  if (!parsed.success) return null;
  const { command, message, actorId: returnedActor } = parsed.data;
  return returnedActor === actorId &&
    Object.keys(command).length === Object.keys(attempt.command).length &&
    Object.entries(attempt.command).every(([key, value]) => command[key] === value)
    ? message
    : null;
}
