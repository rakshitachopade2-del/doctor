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
  status: 'unpaid' | 'partial' | 'paid';
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
export interface InvoiceDetail {
  invoice: Invoice;
  payments: Payment[];
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
