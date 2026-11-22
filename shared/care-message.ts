import type { Message } from './types';

export interface CareMessageCommand {
  requestId: string;
  patientId: string;
  body: string;
}

export interface CareMessageReceipt {
  requestId: string;
  actorId: string;
  actorName: string;
  actorRole: Message['authorRole'];
  patientId: string;
  message: Message;
}

export interface CareMessageResult {
  receipt: CareMessageReceipt;
}

export interface CareMessageNotSent extends CareMessageCommand {
  code: 'MESSAGE_NOT_SENT';
  actorId: string;
  message: string;
}
