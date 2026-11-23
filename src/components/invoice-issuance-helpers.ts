import type { InvoiceIssuanceCommand } from '../../shared/invoice-issuance';
import type { ProcedureBillingItem } from '../../shared/operations';

export interface InvoiceIssuanceAttempt {
  command: InvoiceIssuanceCommand;
  patientName: string;
  procedureTitle?: string;
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const named = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

export function checkedBillingPatients(value: unknown): { id: string; name: string }[] {
  if (
    !Array.isArray(value) ||
    !value.every((row) => record(row) && named(row.id) && named(row.name)) ||
    new Set(value.map((row) => row.id)).size !== value.length
  )
    throw new Error('The patient list could not be verified. Refresh to try again.');
  return value;
}

export function checkedBillingProcedures(
  value: unknown,
  patientId?: string,
): ProcedureBillingItem[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (row) =>
        record(row) &&
        named(row.id) &&
        named(row.title) &&
        named(row.patientId) &&
        named(row.patientName) &&
        (!patientId || row.patientId === patientId) &&
        typeof row.estimatedCost === 'string' &&
        ['planned', 'completed', 'cancelled'].includes(String(row.status)) &&
        ((row.invoiceId === null && row.invoiceNumber === null) ||
          (named(row.invoiceId) && named(row.invoiceNumber))),
    ) ||
    new Set(value.map((row) => row.id)).size !== value.length
  )
    throw new Error('The procedure list could not be verified. Refresh to try again.');
  return value;
}
