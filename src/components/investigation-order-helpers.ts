import { z } from 'zod';
import type { InvestigationOrderCommand } from '../../shared/investigation-order';
import { ApiError } from '../lib';

export type InvestigationOrderAttempt = {
  command: InvestigationOrderCommand;
  patientName: string;
  doctorName: string;
  priorOrderIds: string[];
};

const original = z.strictObject({
  id: z.uuidv4(),
  patientId: z.string(),
  doctorId: z.string(),
  doctorName: z.string().trim().min(1).max(300),
  title: z.string(),
  kind: z.enum(['laboratory', 'pathology', 'imaging', 'other']),
  reason: z.string(),
  instructions: z.string(),
  dueDate: z.string().nullable(),
  status: z.literal('ordered'),
  cancellationReason: z.null(),
  createdAt: z.iso.datetime(),
  results: z.tuple([]),
  reviews: z.tuple([]),
});
const confirmation = z.strictObject({
  receipt: z.strictObject({
    actorId: z.string(),
    requestId: z.string(),
    orderedByRole: z.enum(['admin', 'doctor']),
    order: original,
  }),
});
const refusal = z.strictObject({
  code: z.literal('INVESTIGATION_NOT_ORDERED'),
  actorId: z.string(),
  command: z.record(z.string(), z.unknown()),
  message: z.string().trim().min(1),
});
export function confirmedInvestigationOrder(
  value: unknown,
  attempt: InvestigationOrderAttempt,
  actorId: string,
) {
  const parsed = confirmation.safeParse(value);
  if (!parsed.success) return null;
  const { receipt } = parsed.data,
    { order } = receipt,
    { command } = attempt;
  if (
    receipt.actorId !== actorId ||
    receipt.requestId !== command.requestId ||
    receipt.orderedByRole !== command.orderedByRole ||
    order.patientId !== command.patientId ||
    order.doctorId !== command.doctorId ||
    order.title !== command.title ||
    order.kind !== command.kind ||
    order.reason !== command.reason ||
    order.instructions !== command.instructions ||
    order.dueDate !== command.dueDate ||
    [actorId, command.requestId, command.doctorId, command.patientId].includes(order.id) ||
    attempt.priorOrderIds.includes(order.id)
  )
    return null;
  return order;
}
export function verifiedOrderRefusal(
  error: unknown,
  command: InvestigationOrderCommand,
  actorId: string,
) {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const parsed = refusal.safeParse(error.responseData);
  if (!parsed.success) return null;
  const response = parsed.data,
    fields = Object.entries(command);
  return response.actorId === actorId &&
    Object.keys(response.command).length === fields.length &&
    fields.every(([key, value]) => response.command[key] === value)
    ? response.message
    : null;
}
