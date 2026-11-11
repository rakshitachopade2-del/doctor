import type { Invoice, InvoiceItem } from './operations';

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
export interface InvoiceHistory {
  invoiceId: string;
  issuedCharges: InvoiceCharges;
  corrections: InvoiceCorrection[];
  reversals: PaymentReversal[];
}
