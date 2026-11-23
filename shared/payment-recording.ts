import type { Payment } from './operations';

export interface PaymentRecordingCommand {
  requestId: string;
  patientId: string;
  expectedRevision: string;
  amountPaise: number;
  method: Payment['method'];
  reference: string;
  receivedExternallyConfirmed: true;
}

export interface PaymentRecordingReceipt {
  requestId: string;
  actorId: string;
  invoiceId: string;
  patientId: string;
  expectedRevision: string;
  invoiceNumber: string;
  totalPaise: number;
  beforePaidPaise: number;
  afterPaidPaise: number;
  payment: Omit<Payment, 'requestId'>;
}

export interface PaymentRecordingResult {
  receipt: PaymentRecordingReceipt;
}

export interface PaymentNotRecorded {
  code: 'PAYMENT_NOT_RECORDED';
  actorId: string;
  invoiceId: string;
  command: PaymentRecordingCommand;
  message: string;
}
