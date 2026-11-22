import type { CareMessageCommand } from '../../shared/care-message';
import type { Message } from '../../shared/types';
import { ApiError } from '../lib';
import { useAppointmentBookingData } from './appointment-booking-helpers';
import { checkedModules, checkedProfile } from './clinic-configuration-helpers';

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const uuid = (value: string) =>
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);

function isMessage(value: unknown, patientId: string): value is Message {
  return (
    object(value) &&
    nonempty(value.id) &&
    value.patientId === patientId &&
    nonempty(value.body) &&
    value.body.length <= 4000 &&
    nonempty(value.authorName) &&
    typeof value.authorRole === 'string' &&
    ['patient', 'admin', 'doctor'].includes(value.authorRole) &&
    nonempty(value.createdAt) &&
    Number.isFinite(Date.parse(value.createdAt))
  );
}

export function useCareMessages(patientId: string) {
  return useAppointmentBookingData<Message[]>(
    '/api/messages?patientId=' + encodeURIComponent(patientId),
    (value) => {
      if (!Array.isArray(value) || !value.every((entry) => isMessage(entry, patientId)))
        throw new Error('We could not read this conversation. Refresh to try again.');
      return value;
    },
  );
}

export function checkedMessageSettings(value: unknown) {
  if (!object(value)) throw new Error('We could not read the clinic’s messaging settings.');
  return { ...checkedProfile(value), modules: checkedModules(value.modules) };
}

export function confirmedMessage(
  value: unknown,
  command: CareMessageCommand,
  actorId: string,
): Message | null {
  if (!object(value) || !object(value.receipt)) return null;
  const { receipt } = value;
  const message = receipt.message;
  if (
    receipt.requestId !== command.requestId ||
    receipt.actorId !== actorId ||
    receipt.patientId !== command.patientId ||
    !isMessage(message, command.patientId) ||
    !uuid(message.id) ||
    new Date(message.createdAt).toISOString() !== message.createdAt ||
    message.body !== command.body ||
    message.authorName !== receipt.actorName ||
    message.authorRole !== receipt.actorRole
  )
    return null;
  return message;
}

export function messageNotSent(error: unknown, command: CareMessageCommand, actorId: string) {
  if (!(error instanceof ApiError) || error.status !== 403 || !object(error.responseData))
    return false;
  const result = error.responseData;
  return (
    result.code === 'MESSAGE_NOT_SENT' &&
    result.requestId === command.requestId &&
    result.actorId === actorId &&
    result.patientId === command.patientId &&
    result.body === command.body &&
    nonempty(result.message)
  );
}
