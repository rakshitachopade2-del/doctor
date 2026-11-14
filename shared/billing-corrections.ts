import type { Invoice, InvoiceDetail, InvoiceItem, Payment } from './operations';

export interface InvoiceCharges {
  items: InvoiceItem[];
  totalPaise: number;
}
export interface InvoiceFinancialSnapshot extends InvoiceCharges {
  paidPaise: number;
  status: Invoice['status'];
}
export interface InvoiceCorrection {
  id: string;
  invoiceId: string;
  before: InvoiceFinancialSnapshot;
  after: InvoiceFinancialSnapshot;
  /** Shared with the patient and all staff who can read this invoice. */
  reason: string;
  createdByName: string;
  createdAt: string;
}
export interface PaymentReversal {
  id: string;
  invoiceId: string;
  paymentId: string;
  amountPaise: number;
  beforePaidPaise: number;
  afterPaidPaise: number;
  /** A correction of an erroneous record, never a claim that money was refunded. */
  entryErrorConfirmed: true;
  reason: string;
  createdByName: string;
  createdAt: string;
}
/** A record of money already returned outside this application. */
export interface PaymentRefund {
  id: string;
  invoiceId: string;
  paymentId: string;
  amountPaise: number;
  method: Payment['method'];
  reference: string;
  /** Shared with the patient, including the reason for the recorded refund. */
  reason: string;
  refundedExternallyConfirmed: true;
  beforePaidPaise: number;
  afterPaidPaise: number;
  createdByName: string;
  createdAt: string;
}
export interface PaymentRefundInput {
  amountPaise: number;
  method: Payment['method'];
  reference: string;
  reason: string;
  refundedExternallyConfirmed: true;
  expectedRevision: string;
  requestId: string;
}
export interface PaymentRefundMutation {
  detail: InvoiceDetail;
  refund: PaymentRefund;
  /** Returned only to the currently authorized administrator executing this command. */
  receipt: {
    requestId: string;
    actorId: string;
    invoiceId: string;
    paymentId: string;
    expectedRevision: string;
    refundId: string;
  };
}
export interface InvoiceHistory {
  invoiceId: string;
  issuedCharges: InvoiceCharges;
  corrections: InvoiceCorrection[];
  reversals: PaymentReversal[];
  refunds: PaymentRefund[];
}
