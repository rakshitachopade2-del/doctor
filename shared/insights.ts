import type { AppointmentStatus } from './types';
import type { Payment } from './operations';

export const expenseCategories = [
  'supplies',
  'equipment',
  'rent',
  'utilities',
  'staff',
  'services',
  'other',
] as const;
export type ExpenseCategory = (typeof expenseCategories)[number];

export interface ExpenseVoid {
  id: string;
  reason: string;
  voidedById: string;
  voidedByName: string;
  createdAt: string;
}

export interface ClinicExpense {
  id: string;
  incurredDate: string;
  category: ExpenseCategory;
  description: string;
  amountPaise: number;
  reference: string;
  requestId: string;
  createdById: string;
  createdByName: string;
  createdAt: string;
  status: 'recorded' | 'voided';
  void: ExpenseVoid | null;
}

export interface InsightsTotals {
  appointmentCount: number;
  patientsWithAppointments: number;
  invoiceCount: number;
  invoicedPaise: number;
  /** Current outstanding balance of invoices issued within the selected period. */
  issuedInvoiceOutstandingPaise: number;
  paymentCount: number;
  refundCount: number;
  /** Manual payment records whose recording timestamp falls within the period. */
  collectionsPaise: number;
  /** Nonvoided refund entries by their original recording date, independent of the receipt date. */
  refundsPaise: number;
  /** Recorded collections less recorded refunds; may be negative. */
  netCollectionsPaise: number;
  expenseCount: number;
  expensesPaise: number;
}

export interface InsightsDay {
  date: string;
  appointmentCount: number;
  completedAppointments: number;
  cancelledAppointments: number;
  noShowAppointments: number;
  invoicedPaise: number;
  collectionsPaise: number;
  /** Nonvoided refund entries by their original recording date, independent of the receipt date. */
  refundsPaise: number;
  /** Recorded collections less recorded refunds; may be negative. */
  netCollectionsPaise: number;
  expensesPaise: number;
}

export interface ClinicInsights {
  from: string;
  to: string;
  timezone: 'Asia/Kolkata';
  generatedAt: string;
  totals: InsightsTotals;
  appointmentsByStatus: { status: AppointmentStatus; count: number }[];
  appointmentsByMode: { mode: 'in-person' | 'online'; count: number }[];
  expensesByCategory: { category: ExpenseCategory; count: number; amountPaise: number }[];
  collectionsByMethod: { method: Payment['method']; count: number; amountPaise: number }[];
  refundsByMethod: { method: Payment['method']; count: number; amountPaise: number }[];
  daily: InsightsDay[];
}
