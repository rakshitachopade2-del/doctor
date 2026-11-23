import type { Invoice, InvoiceItem } from './operations';

export interface InvoiceIssuanceCommand {
  requestId: string;
  reviewedConfirmed: true;
  patientId: string;
  procedureId?: string;
  items: InvoiceItem[];
}
export type IssuedInvoice = Invoice & { status: 'unpaid'; paidPaise: 0 };
export interface InvoiceIssuanceResult {
  receipt: {
    requestId: string;
    actorId: string;
    patientId: string;
    invoice: IssuedInvoice;
  };
}
export interface InvoiceNotIssued {
  code: 'INVOICE_NOT_ISSUED';
  actorId: string;
  command: InvoiceIssuanceCommand;
  message: string;
}
