import type { InvoiceHistory } from './billing-corrections';

export interface InvoiceItem {
  description: string;
  quantity: number;
  unitAmountPaise: number;
}
export interface Invoice {
  id: string;
  patientId: string;
  patientName: string;
  number: string;
  items: InvoiceItem[];
  totalPaise: number;
  paidPaise: number;
  status: 'unpaid' | 'partial' | 'paid' | 'no-charge';
  createdAt: string;
  procedureId?: string;
  procedureTitle?: string;
}
export interface ProcedureBillingItem {
  id: string;
  patientId: string;
  patientName: string;
  title: string;
  estimatedCost: string;
  status: 'planned' | 'completed' | 'cancelled';
  invoiceId: string | null;
  invoiceNumber: string | null;
}
export interface Payment {
  id: string;
  invoiceId: string;
  amountPaise: number;
  method: 'cash' | 'card' | 'upi' | 'bank';
  reference: string;
  requestId: string;
  createdAt: string;
}
export interface InvoiceDetail extends InvoiceHistory {
  invoice: Invoice;
  payments: Payment[];
  revision: string;
}
export interface KnowledgeArticle {
  id: string;
  title: string;
  category: string;
  body: string;
  status: 'draft' | 'published';
  authorName: string;
  updatedAt: string;
}
