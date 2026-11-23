import { useState, useRef, useEffect, useLayoutEffect, type FormEvent } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import {
  BookOpen,
  Check,
  CreditCard,
  FileText,
  History,
  Pencil,
  Plus,
  Printer,
  Search,
  Trash2,
  Undo2,
} from 'lucide-react';
import type {
  Invoice,
  InvoiceDetail,
  InvoiceItem,
  KnowledgeArticle,
  Payment,
  ProcedureBillingItem,
} from '../../shared/operations';
import { PaymentRecordingModal, type ReviewedPayment } from '../components/PaymentRecordingModal';
import { usePendingCareSubmissions } from '../components/pending-care-submissions';
import {
  checkedBillingPatients,
  checkedBillingProcedures,
  type InvoiceIssuanceAttempt,
} from '../components/invoice-issuance-helpers';
import {
  useAppointmentBookingData,
  useAppointmentBookingGuard,
} from '../components/appointment-booking-helpers';
import type { PaymentRefund, PaymentRefundVoid } from '../../shared/billing-corrections';
import { api, ApiError, formatDate, money, useResource, useSession, useToast } from '../lib';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  Modal,
  PageHeader,
} from '../components/ui';
import { KnowledgeLibraryManager } from '../components/KnowledgeLibraryManager';
import { useCancellationGuard as useBillingGuard } from '../components/series-cancellation-helpers';

const billingError = (problem: unknown) =>
  problem instanceof Error
    ? problem.message
    : 'The save outcome could not be confirmed. Please retry the same request.';
const invoiceStatus = (value: Invoice['status']) => (value === 'no-charge' ? 'No charges' : value);
const billingStamp = (value: string) =>
  new Date(value).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
function paise(text: string) {
  const value = text.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(value))
    throw new Error('Enter an amount with no more than two decimal places.');
  const [whole, fraction = ''] = value.split('.');
  const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (result < 1n || result > 1_000_000_000n)
    throw new Error('Enter an amount from ₹0.01 to ₹1,00,00,000.00.');
  return Number(result);
}
type LineDraft = { description: string; quantity: string; amount: string };
const draftLines = (items: InvoiceItem[]): LineDraft[] =>
  items.map((item) => ({
    description: item.description,
    quantity: String(item.quantity),
    amount: (item.unitAmountPaise / 100).toFixed(2),
  }));
function invoiceItems(lines: LineDraft[], allowEmpty = false): InvoiceItem[] {
  if ((!allowEmpty && !lines.length) || lines.length > 100)
    throw new Error('Use up to 100 line items. A new invoice needs at least one item.');
  const items = lines.map((line) => {
    const description = line.description.trim();
    if (!description || description.length > 300)
      throw new Error('Each item needs a description of 1–300 characters.');
    if (!/^\d+$/.test(line.quantity.trim()))
      throw new Error('Quantities must be whole numbers from 1 to 1,000.');
    const quantity = Number(line.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000)
      throw new Error('Quantities must be whole numbers from 1 to 1,000.');
    return { description, quantity, unitAmountPaise: paise(line.amount) };
  });
  const total = items.reduce((sum, item) => sum + item.quantity * item.unitAmountPaise, 0);
  if (!Number.isSafeInteger(total) || total > 1_000_000_000)
    throw new Error('The invoice total must be at most ₹1,00,00,000.00.');
  return items;
}
const chargeTotal = (items: InvoiceItem[]) =>
  items.reduce((sum, item) => sum + item.quantity * item.unitAmountPaise, 0);
function billingRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function billingText(value: unknown, max = Infinity): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}
function billingInteger(value: unknown, min = 0, max = 1_000_000_000): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}
function billingDate(value: unknown): value is string {
  return billingText(value) && Number.isFinite(Date.parse(value));
}
function validCharges(
  value: unknown,
): value is Record<string, unknown> & { items: InvoiceItem[]; totalPaise: number } {
  if (
    !billingRecord(value) ||
    !Array.isArray(value.items) ||
    value.items.length > 100 ||
    !billingInteger(value.totalPaise)
  )
    return false;
  if (
    !value.items.every(
      (item) =>
        billingRecord(item) &&
        billingText(item.description, 300) &&
        billingInteger(item.quantity, 1, 1000) &&
        billingInteger(item.unitAmountPaise, 1),
    )
  )
    return false;
  return chargeTotal(value.items as InvoiceItem[]) === value.totalPaise;
}
function validFinancialSnapshot(value: unknown): boolean {
  if (
    !billingRecord(value) ||
    !validCharges(value) ||
    !billingInteger(value.paidPaise) ||
    value.paidPaise > value.totalPaise
  )
    return false;
  const status =
    value.totalPaise === 0
      ? 'no-charge'
      : value.paidPaise === value.totalPaise
        ? 'paid'
        : value.paidPaise > 0
          ? 'partial'
          : 'unpaid';
  return value.status === status;
}
function uniqueBillingIds(values: { id: string }[]) {
  return new Set(values.map((entry) => entry.id)).size === values.length;
}
const refundedAmount = (detail: InvoiceDetail, paymentId: string) =>
  detail.refunds.reduce(
    (sum, refund) =>
      sum +
      (refund.paymentId === paymentId &&
      !detail.refundVoids.some((entry) => entry.refundId === refund.id)
        ? refund.amountPaise
        : 0),
    0,
  );
const remainingRefund = (detail: InvoiceDetail, payment: Payment) =>
  detail.reversals.some((entry) => entry.paymentId === payment.id)
    ? 0
    : payment.amountPaise - refundedAmount(detail, payment.id);
function validRefund(value: unknown, invoiceId: string): value is PaymentRefund {
  return (
    billingRecord(value) &&
    billingText(value.id) &&
    value.invoiceId === invoiceId &&
    billingText(value.paymentId) &&
    billingInteger(value.amountPaise, 1) &&
    ['cash', 'card', 'upi', 'bank'].includes(value.method as string) &&
    typeof value.reference === 'string' &&
    value.reference === value.reference.trim() &&
    value.reference.length <= 200 &&
    (value.method === 'cash' || !!value.reference) &&
    billingText(value.reason, 1000) &&
    value.reason === value.reason.trim() &&
    value.refundedExternallyConfirmed === true &&
    billingInteger(value.beforePaidPaise) &&
    billingInteger(value.afterPaidPaise) &&
    value.beforePaidPaise - value.amountPaise === value.afterPaidPaise &&
    billingText(value.createdByName) &&
    billingDate(value.createdAt)
  );
}
function validRefundVoid(value: unknown, invoiceId: string): value is PaymentRefundVoid {
  return (
    billingRecord(value) &&
    billingText(value.id) &&
    value.invoiceId === invoiceId &&
    billingText(value.refundId) &&
    billingText(value.paymentId) &&
    billingInteger(value.amountPaise, 1) &&
    billingInteger(value.beforePaidPaise) &&
    billingInteger(value.afterPaidPaise) &&
    value.beforePaidPaise + value.amountPaise === value.afterPaidPaise &&
    value.entryErrorConfirmed === true &&
    billingText(value.reason, 1000) &&
    value.reason === value.reason.trim() &&
    billingText(value.createdByName) &&
    billingDate(value.createdAt)
  );
}
const sameBillingValue = (a: unknown, b: unknown): boolean => {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : billingRecord(value)
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, canonical(value[key])]),
          )
        : value;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
};
function checkedInvoice(value: unknown, id?: string): Invoice {
  if (
    !billingRecord(value) ||
    !billingText(value.id) ||
    (id && value.id !== id) ||
    !billingText(value.patientId) ||
    !billingText(value.patientName) ||
    !billingText(value.number) ||
    !billingDate(value.createdAt) ||
    !validFinancialSnapshot(value) ||
    (value.procedureId !== undefined && !billingText(value.procedureId)) ||
    (value.procedureTitle !== undefined && !billingText(value.procedureTitle))
  ) {
    throw new Error(
      'The response did not confirm a complete, consistent invoice. Retry to check its outcome.',
    );
  }
  return value as unknown as Invoice;
}
function checkedInvoiceDetail(value: unknown, id: string): InvoiceDetail {
  const detail = value as InvoiceDetail | null;
  checkedInvoice(detail?.invoice, id);
  const validPayment = (payment: unknown) =>
    billingRecord(payment) &&
    billingText(payment.id) &&
    payment.invoiceId === id &&
    billingText(payment.requestId) &&
    billingInteger(payment.amountPaise, 1) &&
    ['cash', 'card', 'upi', 'bank'].includes(payment.method as string) &&
    typeof payment.reference === 'string' &&
    payment.reference.length <= 200 &&
    billingDate(payment.createdAt);
  const validCorrection = (correction: unknown) =>
    billingRecord(correction) &&
    billingText(correction.id) &&
    correction.invoiceId === id &&
    billingText(correction.reason, 1000) &&
    billingText(correction.createdByName) &&
    billingDate(correction.createdAt) &&
    validFinancialSnapshot(correction.before) &&
    validFinancialSnapshot(correction.after) &&
    (correction.before as { paidPaise: number }).paidPaise ===
      (correction.after as { paidPaise: number }).paidPaise;
  if (
    !detail ||
    detail.invoiceId !== id ||
    typeof detail.revision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(detail.revision) ||
    !Array.isArray(detail.payments) ||
    !detail.payments.every(validPayment) ||
    !uniqueBillingIds(detail.payments) ||
    !Array.isArray(detail.corrections) ||
    !detail.corrections.every(validCorrection) ||
    !uniqueBillingIds(detail.corrections) ||
    !Array.isArray(detail.reversals) ||
    !Array.isArray(detail.refunds) ||
    !detail.refunds.every((refund) => validRefund(refund, id)) ||
    !uniqueBillingIds(detail.refunds) ||
    !Array.isArray(detail.refundVoids) ||
    !detail.refundVoids.every((entry) => validRefundVoid(entry, id)) ||
    !uniqueBillingIds(detail.refundVoids) ||
    new Set(detail.refundVoids.map((entry) => entry.refundId)).size !== detail.refundVoids.length ||
    !validCharges(detail.issuedCharges)
  ) {
    throw new Error(
      'The response did not confirm complete invoice history. Retry to check its outcome.',
    );
  }
  const validReversal = (reversal: unknown) => {
    if (
      !billingRecord(reversal) ||
      !billingText(reversal.id) ||
      reversal.invoiceId !== id ||
      !billingText(reversal.paymentId) ||
      !billingInteger(reversal.amountPaise, 1) ||
      !billingInteger(reversal.beforePaidPaise) ||
      !billingInteger(reversal.afterPaidPaise) ||
      reversal.beforePaidPaise - reversal.amountPaise !== reversal.afterPaidPaise ||
      reversal.entryErrorConfirmed !== true ||
      !billingText(reversal.reason, 1000) ||
      !billingText(reversal.createdByName) ||
      !billingDate(reversal.createdAt)
    )
      return false;
    return detail.payments.some(
      (payment) =>
        payment.id === reversal.paymentId && payment.amountPaise === reversal.amountPaise,
    );
  };
  if (
    !detail.reversals.every(validReversal) ||
    !uniqueBillingIds(detail.reversals) ||
    new Set(detail.reversals.map((reversal) => reversal.paymentId)).size !== detail.reversals.length
  ) {
    throw new Error(
      'The response did not confirm complete payment reversal history. Retry to check its outcome.',
    );
  }
  const reversed = new Set(detail.reversals.map((reversal) => reversal.paymentId));
  const voided = new Set(detail.refundVoids.map((entry) => entry.refundId));
  if (
    detail.refundVoids.some(
      (entry) =>
        !detail.refunds.some(
          (refund) =>
            refund.id === entry.refundId &&
            refund.paymentId === entry.paymentId &&
            refund.amountPaise === entry.amountPaise,
        ),
    ) ||
    detail.refunds.some(
      (refund) =>
        (!voided.has(refund.id) && reversed.has(refund.paymentId)) ||
        !detail.payments.some(
          (payment) => payment.id === refund.paymentId && refund.amountPaise <= payment.amountPaise,
        ),
    ) ||
    detail.payments.some((payment) => refundedAmount(detail, payment.id) > payment.amountPaise)
  )
    throw new Error(
      'The response did not confirm consistent original payments and refunds. Retry to check its outcome.',
    );
  const netPaid =
    detail.payments.reduce(
      (sum, payment) => sum + (reversed.has(payment.id) ? 0 : payment.amountPaise),
      0,
    ) -
    detail.refunds.reduce(
      (sum, refund) => sum + (voided.has(refund.id) ? 0 : refund.amountPaise),
      0,
    );
  if (!Number.isSafeInteger(netPaid) || netPaid !== detail.invoice.paidPaise)
    throw new Error(
      'The response did not confirm consistent net payment totals. Retry to check its outcome.',
    );
  return detail;
}
type CreationDraft = {
  source: ProcedureBillingItem | null;
  patientId: string;
  procedureId: string;
  items: LineDraft[];
  error: string;
};
const createDraft = (source: ProcedureBillingItem | null = null): CreationDraft => ({
  source,
  patientId: source?.patientId ?? '',
  procedureId: source?.id ?? '',
  items: [{ description: source?.title ?? '', quantity: '1', amount: '' }],
  error: '',
});
type BillingDraft = {
  kind: 'charges' | 'reversal' | 'payment' | 'refund' | 'refund-void';
  invoiceId: string;
  source: InvoiceDetail;
  requestId: string;
  paymentId: string | null;
  refundId: string | null;
  actorId: string | null;
  items: LineDraft[];
  reason: string;
  removeAllChargesConfirmed: boolean;
  entryErrorConfirmed: boolean;
  refundedExternallyConfirmed: boolean;
  amount: string;
  method: Payment['method'];
  reference: string;
  phase: 'editing' | 'uncertain' | 'conflict';
  attempt: { path: string; body: Record<string, unknown> } | null;
  reviewed: InvoiceDetail | null;
  error: string;
};
const billingDraft = (
  kind: BillingDraft['kind'],
  source: InvoiceDetail,
  paymentId: string | null = null,
  refundId: string | null = null,
): BillingDraft => ({
  kind,
  source,
  invoiceId: source.invoice.id,
  requestId: crypto.randomUUID(),
  paymentId,
  refundId,
  actorId: null,
  items: draftLines(source.invoice.items),
  reason: '',
  removeAllChargesConfirmed: false,
  entryErrorConfirmed: false,
  refundedExternallyConfirmed: false,
  amount: '',
  method: 'cash',
  reference: '',
  phase: 'editing',
  attempt: null,
  reviewed: null,
  error: '',
});

export function BillingPage() {
  const { session } = useSession();
  return <BillingRegister key={JSON.stringify([session.user?.id, session.csrfToken])} />;
}

function BillingRegister() {
  const { session } = useSession();
  const { issuance, paymentRecording } = usePendingCareSubmissions();
  const location = useLocation();
  const staff = !!session.user && ['admin', 'doctor', 'receptionist'].includes(session.user.role);
  const invoices = useAppointmentBookingData('/api/invoices', (value) => {
    if (!Array.isArray(value)) throw new Error('The invoice list could not be confirmed.');
    const rows = value.map((invoice) => checkedInvoice(invoice));
    if (!uniqueBillingIds(rows)) throw new Error('The invoice list contains duplicate records.');
    return rows;
  });
  const [creation, setCreation] = useState<CreationDraft | null>(null);
  const [creationOrigin, setCreationOrigin] = useState<string | null>(null);
  const [paymentReview, setPaymentReview] = useState<{
    attempt: ReviewedPayment;
    origin: string;
  } | null>(null);
  const openPayment = paymentReview?.origin === location.key ? paymentReview.attempt : null;
  const pendingPayment = paymentRecording.current;
  const paymentActive = !!openPayment || !!pendingPayment;
  function reviewPayment(attempt: ReviewedPayment) {
    setPaymentReview({ attempt, origin: location.key });
  }
  const creating = creationOrigin === location.key;
  const hasCreation = !!creation || !!issuance.current;
  useLayoutEffect(() => {
    const close = () => {
      setCreationOrigin(null);
      setPaymentReview(null);
    };
    window.addEventListener('popstate', close);
    window.addEventListener('hashchange', close);
    return () => {
      window.removeEventListener('popstate', close);
      window.removeEventListener('hashchange', close);
    };
  }, []);
  const [draft, setDraft] = useState<BillingDraft | null>(null);
  const [selection, setSelection] = useState<{ id: string; origin: string } | null>(null);
  const selected = selection?.origin === location.key ? selection.id : null;
  function setSelected(id: string | null) {
    setSelection(id ? { id, origin: location.key } : null);
  }
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [params, setParams] = useSearchParams();
  const procedureId = params.get('procedure'),
    invoiceId = params.get('invoice');
  const sourceOpened = useRef('');
  useEffect(() => {
    setSelection(invoiceId ? { id: invoiceId, origin: location.key } : null);
  }, [invoiceId, location.key]);
  const procedures = useAppointmentBookingData(
    staff ? '/api/procedure-billing' : null,
    checkedBillingProcedures,
  );
  useEffect(() => {
    if (!procedureId) {
      sourceOpened.current = '';
      return;
    }
    if (
      !staff ||
      invoiceId ||
      !procedures.data ||
      sourceOpened.current === procedureId ||
      draft ||
      paymentActive ||
      hasCreation
    )
      return;
    const procedure = procedures.data.find((item) => item.id === procedureId);
    if (procedure?.invoiceId) {
      sourceOpened.current = procedureId;
      setSelected(procedure.invoiceId);
    } else if (procedure && procedure.status !== 'cancelled') {
      sourceOpened.current = procedureId;
      setCreation(createDraft(procedure));
      setCreationOrigin(location.key);
    }
  }, [
    staff,
    invoiceId,
    procedureId,
    procedures.data,
    draft,
    hasCreation,
    paymentActive,
    location.key,
  ]);
  function closeSource() {
    if (params.size) setParams({}, { replace: true });
  }
  let allInvoices: Invoice[] = [];
  let invoiceListError = invoices.error;
  if (!invoices.loading && !invoiceListError) {
    try {
      if (!Array.isArray(invoices.data))
        throw new Error('The response did not contain a valid invoice list.');
      allInvoices = invoices.data.map((invoice) => checkedInvoice(invoice));
      if (!uniqueBillingIds(allInvoices))
        throw new Error('The response contained duplicate invoice records.');
    } catch (problem) {
      invoiceListError = billingError(problem);
    }
  }
  const rows = allInvoices.filter(
    (invoice) =>
      (filter === 'all' || invoice.status === filter) &&
      `${invoice.number} ${invoice.patientName}`.toLowerCase().includes(search.toLowerCase()),
  );
  const total = allInvoices.reduce((sum, invoice) => sum + invoice.totalPaise, 0),
    paid = allInvoices.reduce((sum, invoice) => sum + invoice.paidPaise, 0);
  const totalsUnavailable = invoices.loading || !!invoiceListError;
  return (
    <>
      <PageHeader
        eyebrow={staff ? 'CLINIC OPERATIONS' : 'YOUR CARE'}
        title={staff ? 'Billing & payments' : 'My invoices'}
        description="Current charges, recorded payments, external refunds and preserved correction history."
        actions={
          staff ? (
            <button
              className="button button-primary"
              disabled={!!draft || paymentActive}
              onClick={() => {
                if (!creation) setCreation(createDraft());
                setCreationOrigin(location.key);
              }}
            >
              <Plus size={17} />
              {hasCreation ? 'Resume invoice entry' : 'Create invoice'}
            </button>
          ) : undefined
        }
      />
      {staff && pendingPayment && !openPayment && !selected && (
        <div className="notice billing-pending">
          <p>
            Payment confirmation pending for {pendingPayment.invoiceNumber} ·{' '}
            {pendingPayment.patientName}.
          </p>
          <button className="button button-secondary" onClick={() => reviewPayment(pendingPayment)}>
            Resume payment entry
          </button>
        </div>
      )}
      {draft && !pendingPayment && !openPayment && !selected && (
        <div className="notice billing-pending">
          <div>
            <strong>An invoice update is unfinished.</strong>
            <p>
              Your entry for {draft.source.invoice.number} is retained while this page stays open.
            </p>
          </div>
          <button className="button button-secondary" onClick={() => setSelected(draft.invoiceId)}>
            Resume pending update
          </button>
        </div>
      )}
      {staff && procedureId && procedures.error && (
        <ErrorState message={procedures.error} retry={procedures.reload} />
      )}
      {staff &&
        procedureId &&
        procedures.data &&
        !procedures.data.some((item) => item.id === procedureId) && (
          <div className="notice notice-error">The linked procedure is not available.</div>
        )}
      {staff &&
        procedureId &&
        procedures.data?.some(
          (item) => item.id === procedureId && item.status === 'cancelled' && !item.invoiceId,
        ) && (
          <div className="notice">
            This procedure is cancelled. A new linked invoice cannot be created.
          </div>
        )}
      <div className="grid-3 billing-metrics">
        <Card>
          <span className="muted">Current charges</span>
          <strong>{totalsUnavailable ? '—' : money(total / 100)}</strong>
        </Card>
        <Card>
          <span className="muted">Net payments recorded</span>
          <strong>{totalsUnavailable ? '—' : money(paid / 100)}</strong>
        </Card>
        <Card>
          <span className="muted">Balance due</span>
          <strong>{totalsUnavailable ? '—' : money((total - paid) / 100)}</strong>
        </Card>
      </div>
      <p className="billing-scope">
        {invoiceListError
          ? 'Totals unavailable until the invoice list loads.'
          : 'Totals cover all accessible invoices. Current charges include corrections; net payments exclude reversed entry errors and active refund records.'}
      </p>
      <Card>
        <div className="section-heading">
          <div className="search-field">
            <Search size={17} />
            <input
              aria-label="Search invoices"
              placeholder="Patient or invoice number"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <select
            className="compact-select"
            aria-label="Invoice status"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            <option value="all">All invoices</option>
            <option value="unpaid">Unpaid</option>
            <option value="partial">Partially paid</option>
            <option value="paid">Paid</option>
            <option value="no-charge">No charges</option>
          </select>
        </div>
        {invoices.loading ? (
          <Loading />
        ) : invoiceListError ? (
          <ErrorState message={invoiceListError} retry={invoices.reload} />
        ) : !rows.length ? (
          <EmptyState
            title="No invoices in this view"
            description={
              staff
                ? 'Create an invoice for a consultation, procedure, or clinic service.'
                : 'Your clinic invoices will appear here.'
            }
          />
        ) : (
          <div
            className="table-wrap billing-register-table"
            role="region"
            aria-label="Invoices; scroll horizontally for all columns"
            tabIndex={0}
          >
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Invoice</th>
                  {staff && <th scope="col">Patient</th>}
                  <th scope="col">Current charges</th>
                  <th scope="col">Balance</th>
                  <th scope="col">Status</th>
                  <th scope="col">Record</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((invoice) => (
                  <tr key={invoice.id}>
                    <td>
                      <strong>{invoice.number}</strong>
                      <small className="table-subtitle">{formatDate(invoice.createdAt)}</small>
                      {invoice.procedureTitle && (
                        <small className="table-subtitle">
                          Procedure · {invoice.procedureTitle}
                        </small>
                      )}
                    </td>
                    {staff && <td>{invoice.patientName}</td>}
                    <td>{money(invoice.totalPaise / 100)}</td>
                    <td>{money((invoice.totalPaise - invoice.paidPaise) / 100)}</td>
                    <td>
                      <Badge
                        tone={
                          invoice.status === 'paid'
                            ? 'green'
                            : invoice.status === 'partial'
                              ? 'amber'
                              : 'neutral'
                        }
                      >
                        {invoice.status === 'partial'
                          ? 'Partially paid'
                          : invoiceStatus(invoice.status)}
                      </Badge>
                    </td>
                    <td>
                      <button
                        className="button button-secondary button-small"
                        disabled={creating}
                        onClick={() => setSelected(invoice.id)}
                      >
                        View invoice
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <div className="notice">
        <CreditCard size={19} />
        <span>
          Payments and external refunds record money received or returned elsewhere. Corrections
          preserve the original records. No payment, refund, bank transfer or UPI transaction is
          initiated here.
        </span>
      </div>
      {staff && creation && creating && (
        <InvoiceForm
          key={location.key}
          draft={creation}
          onChange={setCreation}
          onClose={() => {
            setCreationOrigin(null);
            closeSource();
          }}
          onDiscard={() => {
            setCreationOrigin(null);
            setCreation(null);
            closeSource();
          }}
          onConfirmed={() => {
            void invoices.reload();
            void procedures.reload();
          }}
          onCreated={(id) => {
            setCreationOrigin(null);
            setCreation(null);
            if (params.size) setParams({ invoice: id }, { replace: true });
            else setSelected(id);
            void invoices.reload();
            void procedures.reload();
          }}
        />
      )}
      {staff && openPayment && (
        <PaymentRecordingModal
          key={openPayment.command.requestId + location.key}
          attempt={openPayment}
          checkDetail={checkedInvoiceDetail}
          onEdit={() => {
            setPaymentReview(null);
            setSelected(openPayment.invoiceId);
          }}
          onClose={() => {
            setPaymentReview(null);
            setSelected(null);
            closeSource();
          }}
          onRefresh={(latest) => {
            const command = openPayment.command;
            setDraft({
              ...billingDraft('payment', latest),
              amount: (command.amountPaise / 100).toFixed(2),
              method: command.method,
              reference: command.reference,
            });
            setPaymentReview(null);
            setSelected(openPayment.invoiceId);
          }}
          onConfirmed={() => {
            setDraft(null);
            void invoices.reload();
          }}
          onOpenCurrent={() => {
            setPaymentReview(null);
            if (params.size && invoiceId !== openPayment.invoiceId)
              setParams({ invoice: openPayment.invoiceId }, { replace: true });
            else setSelected(openPayment.invoiceId);
          }}
        />
      )}
      {selected && !openPayment && (
        <InvoiceView
          key={`${selected}:${location.key}`}
          id={selected}
          staff={staff}
          draft={draft}
          onDraftChange={setDraft}
          otherEntryPending={hasCreation || !!pendingPayment}
          pendingPayment={pendingPayment?.invoiceId === selected ? pendingPayment : null}
          onReviewPayment={reviewPayment}
          onClose={() => {
            setSelected(null);
            closeSource();
          }}
          onUpdated={() => {
            void invoices.reload();
          }}
        />
      )}
    </>
  );
}

function InvoiceLineEditor({
  items,
  onChange,
  locked,
  allowEmpty = false,
}: {
  items: LineDraft[];
  onChange: (items: LineDraft[]) => void;
  locked: boolean;
  allowEmpty?: boolean;
}) {
  function update(index: number, key: keyof LineDraft, value: string) {
    onChange(items.map((item, offset) => (offset === index ? { ...item, [key]: value } : item)));
  }
  return (
    <>
      {items.map((item, index) => (
        <div className="invoice-item-editor" key={index}>
          <div className="row between">
            <strong>Item {index + 1}</strong>
            {(allowEmpty || items.length > 1) && (
              <button
                className="icon-button"
                disabled={locked}
                type="button"
                aria-label={`Remove invoice item ${index + 1}`}
                onClick={() => onChange(items.filter((_, offset) => offset !== index))}
              >
                <Trash2 size={16} />
              </button>
            )}
          </div>
          <Field label="Service or item">
            <input
              required
              maxLength={300}
              value={item.description}
              disabled={locked}
              onChange={(event) => update(index, 'description', event.target.value)}
              placeholder="e.g. Dermatology consultation"
            />
          </Field>
          <div className="form-grid">
            <Field label="Quantity">
              <input
                required
                type="number"
                min="1"
                max="1000"
                step="1"
                value={item.quantity}
                disabled={locked}
                onChange={(event) => update(index, 'quantity', event.target.value)}
              />
            </Field>
            <Field label="Unit price (₹)">
              <input
                required
                type="number"
                min="0.01"
                max="10000000"
                step="0.01"
                value={item.amount}
                disabled={locked}
                onChange={(event) => update(index, 'amount', event.target.value)}
              />
            </Field>
          </div>
        </div>
      ))}
      <button
        className="button button-secondary"
        type="button"
        disabled={locked || items.length >= 100}
        onClick={() => onChange([...items, { description: '', quantity: '1', amount: '' }])}
      >
        <Plus size={15} />
        Add line item
      </button>
    </>
  );
}

function originalIssuedInvoice(value: unknown, attempt: InvoiceIssuanceAttempt, actorId: string) {
  const { command } = attempt;
  if (!billingRecord(value) || !billingRecord(value.receipt)) return null;
  const receipt = value.receipt;
  if (
    receipt.actorId !== actorId ||
    receipt.requestId !== command.requestId ||
    receipt.patientId !== command.patientId
  )
    return null;
  const invoice = checkedInvoice(receipt.invoice);
  if (
    invoice.patientId !== command.patientId ||
    invoice.procedureId !== command.procedureId ||
    (command.procedureId
      ? !billingText(invoice.procedureTitle)
      : invoice.procedureTitle !== undefined) ||
    !sameBillingValue(invoice.items, command.items) ||
    invoice.totalPaise !== chargeTotal(command.items) ||
    invoice.status !== 'unpaid' ||
    invoice.paidPaise !== 0 ||
    !/^INV-(?:[0-9]{6}|[1-9][0-9]{6,})$/.test(invoice.number) ||
    invoice.number === 'INV-000000' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(invoice.id) ||
    new Date(invoice.createdAt).toISOString() !== invoice.createdAt
  )
    return null;
  return invoice;
}

function InvoiceForm({
  draft,
  onChange,
  onClose,
  onDiscard,
  onCreated,
  onConfirmed,
}: {
  draft: CreationDraft;
  onChange: (draft: CreationDraft) => void;
  onClose: () => void;
  onDiscard: () => void;
  onCreated: (id: string) => void;
  onConfirmed: () => void;
}) {
  const { session } = useSession();
  const { issuance } = usePendingCareSubmissions();
  const [phase, setPhase] = useState<'edit' | 'review' | 'pending' | 'rejected' | 'saved'>(
    issuance.current ? 'pending' : 'edit',
  );
  const [review, setReview] = useState<InvoiceIssuanceAttempt | null>(issuance.current);
  const [saved, setSaved] = useState<Invoice | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const working = useRef(false),
    dismissed = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const capture = useAppointmentBookingGuard();
  const patients = useAppointmentBookingData(
    phase === 'edit' ? '/api/patients' : null,
    checkedBillingPatients,
  );
  const procedures = useAppointmentBookingData(
    phase === 'edit' && draft.patientId
      ? `/api/procedure-billing?patientId=${encodeURIComponent(draft.patientId)}`
      : null,
    (value) => checkedBillingProcedures(value, draft.patientId),
  );
  const linked = procedures.data?.find((item) => item.id === draft.procedureId);
  const eligibleProcedure = !!linked && !linked.invoiceId && linked.status !== 'cancelled';
  useEffect(() => {
    if (phase !== 'edit') heading.current?.focus();
  }, [phase]);
  function close() {
    dismissed.current = true;
    if (saved) onDiscard();
    else onClose();
  }
  function reviewDraft(event: FormEvent) {
    event.preventDefault();
    if (phase !== 'edit') return;
    const patient = patients.data?.find((row) => row.id === draft.patientId);
    if (!patient) return;
    if (draft.procedureId && !eligibleProcedure) {
      onChange({ ...draft, error: 'Select an available procedure or remove the procedure link.' });
      return;
    }
    try {
      const items = invoiceItems(draft.items);
      setReview({
        patientName: patient.name,
        ...(linked ? { procedureTitle: linked.title } : {}),
        command: {
          requestId: crypto.randomUUID(),
          reviewedConfirmed: true,
          patientId: patient.id,
          ...(draft.procedureId ? { procedureId: draft.procedureId } : {}),
          items,
        },
      });
      setAcknowledged(false);
      setMessage('');
      setPhase('review');
    } catch (problem) {
      onChange({ ...draft, error: billingError(problem) });
    }
  }
  async function issue() {
    const actorId = session.user?.id;
    const attempt =
      phase === 'pending' ? issuance.current : phase === 'review' && acknowledged ? review : null;
    if (
      !attempt ||
      !actorId ||
      working.current ||
      dismissed.current ||
      (issuance.current && issuance.current !== attempt)
    )
      return;
    const origin = capture();
    const current = () => !dismissed.current && origin() && issuance.current === attempt;
    working.current = true;
    issuance.current = attempt;
    setBusy(true);
    setMessage('');
    setPhase('pending');
    try {
      const response = await api<unknown>('/api/invoices/issue', {
        method: 'POST',
        body: attempt.command,
        isCurrent: current,
      });
      if (!current()) return;
      const invoice = originalIssuedInvoice(response, attempt, actorId);
      if (!invoice) return;
      issuance.current = null;
      setSaved(invoice);
      setPhase('saved');
      onConfirmed();
    } catch (problem) {
      if (!current()) return;
      const data = problem instanceof ApiError ? problem.responseData : null;
      if (
        problem instanceof ApiError &&
        [400, 409].includes(problem.status) &&
        billingRecord(data) &&
        data.code === 'INVOICE_NOT_ISSUED' &&
        data.actorId === actorId &&
        billingText(data.message) &&
        sameBillingValue(data.command, attempt.command)
      ) {
        issuance.current = null;
        onChange({
          ...createDraft(),
          patientId: attempt.command.patientId,
          items: draftLines(attempt.command.items),
        });
        setMessage(data.message);
        setPhase('rejected');
      }
    } finally {
      if (!dismissed.current && origin()) {
        working.current = false;
        setBusy(false);
      }
    }
  }

  const snapshot = saved ?? review?.command;
  return (
    <Modal title="Create an invoice" onClose={close}>
      {phase === 'edit' ? (
        <form className="stack billing-create-form" onSubmit={reviewDraft}>
          {draft.error && (
            <p className="form-error" role="alert">
              {draft.error}
            </p>
          )}
          {patients.error && <ErrorState message={patients.error} retry={patients.reload} />}
          <Field label="Patient">
            <select
              required
              value={draft.patientId}
              disabled={!!draft.source}
              onChange={(event) =>
                onChange({
                  ...draft,
                  patientId: event.target.value,
                  procedureId: '',
                  items: [{ description: '', quantity: '1', amount: '' }],
                })
              }
            >
              <option value="">Select a patient</option>
              {patients.data?.map((patient) => (
                <option key={patient.id} value={patient.id}>
                  {patient.name}
                </option>
              ))}
            </select>
          </Field>
          {procedures.error && <ErrorState message={procedures.error} retry={procedures.reload} />}
          {draft.patientId && (
            <Field
              label="Link a procedure (optional)"
              hint="Each procedure can have one linked invoice. Set the agreed charges below; estimates are not charged automatically."
            >
              <select
                value={draft.procedureId}
                disabled={!!draft.source || procedures.loading}
                onChange={(event) => {
                  const procedure = procedures.data?.find((item) => item.id === event.target.value);
                  const line = draft.items[0];
                  const suggestItem =
                    draft.items.length === 1 &&
                    line.quantity === '1' &&
                    !line.amount.trim() &&
                    (!line.description.trim() || line.description === linked?.title);
                  onChange({
                    ...draft,
                    procedureId: event.target.value,
                    ...(procedure && suggestItem
                      ? { items: [{ description: procedure.title, quantity: '1', amount: '' }] }
                      : {}),
                  });
                }}
              >
                <option value="">No procedure link</option>
                {procedures.data?.map((item) => (
                  <option
                    key={item.id}
                    value={item.id}
                    disabled={!!item.invoiceId || item.status === 'cancelled'}
                  >
                    {item.title}
                    {item.invoiceNumber
                      ? ` · ${item.invoiceNumber}`
                      : item.status === 'cancelled'
                        ? ' · cancelled'
                        : ''}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {draft.procedureId && linked && (
            <div className="notice">
              <span>
                Linked procedure: <strong>{linked.title}</strong>
                <br />
                Recorded estimate: {linked.estimatedCost || 'Not recorded'}. Creating an invoice
                records a charge; it does not record a received payment.
              </span>
            </div>
          )}
          <InvoiceLineEditor
            items={draft.items}
            locked={false}
            onChange={(items) => onChange({ ...draft, items })}
          />

          {draft.source && procedures.data && !eligibleProcedure && (
            <button
              type="button"
              className="button button-secondary"
              onClick={() => onChange({ ...draft, source: null, procedureId: '', error: '' })}
            >
              Remove unavailable procedure link
            </button>
          )}
          <div className="billing-form-actions">
            <button type="button" className="button button-secondary" onClick={close}>
              Close for now
            </button>
            <button type="button" className="button button-ghost" onClick={onDiscard}>
              Cancel invoice draft
            </button>
            <button
              className="button button-primary"
              disabled={!patients.data || (!!draft.procedureId && !eligibleProcedure)}
            >
              Review invoice
            </button>
          </div>
        </form>
      ) : (
        snapshot && (
          <div className="stack billing-create-form billing-issue-summary">
            <h3 ref={heading} tabIndex={-1}>
              {saved
                ? 'Invoice issued'
                : phase === 'rejected'
                  ? 'Invoice was not issued'
                  : phase === 'pending'
                    ? 'Invoice confirmation pending'
                    : 'Review invoice'}
            </h3>
            {saved && (
              <p>
                <strong>{saved.number}</strong> · Originally issued {billingStamp(saved.createdAt)}
              </p>
            )}
            <p>
              Patient · <strong>{saved?.patientName ?? review?.patientName}</strong>
              <br />
              Procedure · {saved?.procedureTitle ?? review?.procedureTitle ?? 'No procedure link'}
            </p>
            <ol
              className="billing-issue-items"
              aria-label={saved ? 'Originally issued charges' : 'Invoice line items'}
            >
              {snapshot.items.map((item, index) => (
                <li key={index}>
                  <strong>{item.description}</strong>
                  <dl>
                    <div>
                      <dt>Quantity</dt>
                      <dd>{item.quantity}</dd>
                    </div>
                    <div>
                      <dt>Unit price</dt>
                      <dd>{money(item.unitAmountPaise / 100)}</dd>
                    </div>
                    <div>
                      <dt>Line amount</dt>
                      <dd>{money((item.quantity * item.unitAmountPaise) / 100)}</dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ol>
            <p>
              Total · <strong>{money(chargeTotal(snapshot.items) / 100)}</strong>
            </p>
            {saved && <p>At issuance · Unpaid · {money(0)} paid</p>}
            {phase === 'review' && (
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                />
                <span>
                  I reviewed the patient and charges and confirm this invoice is ready to issue.
                </span>
              </label>
            )}
            {phase === 'pending' && (
              <p role="status">
                {busy
                  ? 'Waiting for the clinic to confirm the invoice.'
                  : 'Retry the same request to confirm issuance. This signed-in tab retains it until you reload or sign out.'}
              </p>
            )}
            {phase === 'rejected' && <p role="status">{message}</p>}
            <div className="billing-form-actions">
              <button type="button" className="button button-secondary" onClick={close}>
                {saved ? 'Close confirmation' : 'Close for now'}
              </button>
              {phase === 'review' && (
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => {
                    setAcknowledged(false);
                    setPhase('edit');
                  }}
                >
                  Edit invoice
                </button>
              )}
              {phase === 'review' || phase === 'pending' ? (
                <button
                  type="button"
                  className="button button-primary"
                  disabled={busy || (phase === 'review' && !acknowledged)}
                  onClick={() => void issue()}
                >
                  {busy
                    ? 'Issuing…'
                    : phase === 'pending'
                      ? 'Retry exact issuance'
                      : 'Issue invoice'}
                </button>
              ) : saved ? (
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => onCreated(saved.id)}
                >
                  Open current invoice
                </button>
              ) : (
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => {
                    setAcknowledged(false);
                    setReview(null);
                    setMessage('');
                    setPhase('edit');
                  }}
                >
                  Review draft
                </button>
              )}
            </div>
          </div>
        )
      )}
    </Modal>
  );
}

function ChargesTable({ items, caption }: { items: InvoiceItem[]; caption: string }) {
  return items.length ? (
    <div
      className="table-wrap billing-charges-table"
      role="region"
      aria-label={`${caption}; scroll horizontally for all columns`}
      tabIndex={0}
    >
      <table className="data-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Description</th>
            <th scope="col">Qty</th>
            <th scope="col">Unit price</th>
            <th scope="col">Amount</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr key={index}>
              <th scope="row">{item.description}</th>
              <td>{item.quantity}</td>
              <td>{money(item.unitAmountPaise / 100)}</td>
              <td>{money((item.quantity * item.unitAmountPaise) / 100)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <p className="notice billing-no-charges">No charges in this version of the invoice.</p>
  );
}
function InvoiceView({
  id,
  staff,
  draft,
  onDraftChange,
  otherEntryPending,
  pendingPayment,
  onReviewPayment,
  onClose,
  onUpdated,
}: {
  id: string;
  staff: boolean;
  draft: BillingDraft | null;
  onDraftChange: (draft: BillingDraft | null) => void;
  otherEntryPending: boolean;
  pendingPayment: ReviewedPayment | null;
  onReviewPayment: (attempt: ReviewedPayment) => void;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const detail = useAppointmentBookingData(`/api/invoices/${encodeURIComponent(id)}`, (value) =>
    checkedInvoiceDetail(value, id),
  );
  const begin = useBillingGuard();
  const { session } = useSession();
  const admin = session.user?.role === 'admin';
  const [busy, setBusy] = useState(false);
  const [reviewedDetail, setReviewedDetail] = useState<InvoiceDetail | null>(null);
  const invoiceElement = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const originalStates = new Map<HTMLDetailsElement, boolean>();
    function expandHistory() {
      invoiceElement.current?.querySelectorAll('details').forEach((element) => {
        if (!originalStates.has(element)) originalStates.set(element, element.open);
        element.open = true;
      });
    }
    function restoreHistory() {
      originalStates.forEach((open, element) => {
        element.open = open;
      });
      originalStates.clear();
    }
    window.addEventListener('beforeprint', expandHistory);
    window.addEventListener('afterprint', restoreHistory);
    return () => {
      window.removeEventListener('beforeprint', expandHistory);
      window.removeEventListener('afterprint', restoreHistory);
      restoreHistory();
    };
  }, []);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const currentDraft = draft?.invoiceId === id ? draft : null;
  const blocked = otherEntryPending || (!!draft && draft.invoiceId !== id);
  let data: InvoiceDetail | null = null,
    error = detail.error;
  if (!detail.loading && !error) {
    try {
      data = checkedInvoiceDetail(reviewedDetail ?? detail.data, id);
    } catch (problem) {
      error = billingError(problem);
    }
  }
  async function updated() {
    const current = begin();
    if (!current()) return;
    onDraftChange(null);
    setReviewedDetail(null);
    await detail.reload();
    if (current()) onUpdated();
  }
  function start(
    kind: 'charges' | 'reversal' | 'refund' | 'refund-void',
    paymentId?: string,
    refundId?: string,
  ) {
    if (admin && data && !draft && !blocked)
      onDraftChange(billingDraft(kind, data, paymentId, refundId));
  }
  return (
    <Modal
      title={data ? `Invoice ${data.invoice.number}` : 'Invoice'}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      {staff && pendingPayment && (
        <div className="notice billing-pending">
          <p>Payment confirmation pending for {pendingPayment.invoiceNumber}.</p>
          <button
            className="button button-secondary"
            onClick={() => onReviewPayment(pendingPayment)}
          >
            Resume payment entry
          </button>
        </div>
      )}
      {detail.loading ? (
        <Loading />
      ) : error ? (
        <ErrorState message={error} retry={detail.reload} />
      ) : (
        data && (
          <div className="stack invoice-document" ref={invoiceElement}>
            {data.invoice.procedureId && (
              <div className="notice">
                <span>
                  Linked procedure: <strong>{data.invoice.procedureTitle}</strong>
                  {session.user?.role !== 'receptionist' && (
                    <>
                      <br />
                      <Link
                        className="text-link"
                        to={
                          staff
                            ? `/clinic/patients/${data.invoice.patientId}?tab=workup`
                            : '/my-care/record?tab=workflows'
                        }
                      >
                        Open procedure record →
                      </Link>
                    </>
                  )}
                </span>
              </div>
            )}
            <div className="row between billing-invoice-heading">
              <div>
                <h2>{data.invoice.patientName}</h2>
                <p className="muted">Issued {formatDate(data.invoice.createdAt)}</p>
              </div>
              <Badge
                tone={
                  data.invoice.status === 'paid'
                    ? 'green'
                    : data.invoice.status === 'partial'
                      ? 'amber'
                      : 'neutral'
                }
              >
                {invoiceStatus(data.invoice.status)}
              </Badge>
            </div>
            <section className="billing-current-charges">
              <h3>Current invoice charges</h3>
              <ChargesTable items={data.invoice.items} caption="Current invoice line items" />
              <div className="invoice-totals">
                <span>
                  Total<strong>{money(data.invoice.totalPaise / 100)}</strong>
                </span>
                <span>
                  Net recorded paid<strong>{money(data.invoice.paidPaise / 100)}</strong>
                </span>
                <span>
                  Balance due
                  <strong>{money((data.invoice.totalPaise - data.invoice.paidPaise) / 100)}</strong>
                </span>
              </div>
            </section>
            {admin && (
              <button
                className="button button-secondary billing-admin-action"
                disabled={!!draft || blocked || busy}
                onClick={() => start('charges')}
              >
                <Pencil size={15} />
                Correct charges
              </button>
            )}
            {blocked && !pendingPayment && (
              <p className="notice billing-no-print">
                Finish or cancel the other pending billing entry before recording another change.
              </p>
            )}
            {currentDraft && currentDraft.kind !== 'payment' && (
              <BillingUpdateForm
                draft={currentDraft}
                onChange={onDraftChange}
                onCancel={() => onDraftChange(null)}
                busy={busy}
                setBusy={setBusy}
                onSaved={updated}
                onReviewed={setReviewedDetail}
              />
            )}
            <section className="billing-payment-history">
              <h3>Payment history</h3>
              {data.payments.length ? (
                data.payments.map((payment) => {
                  const reversal = data!.reversals.find((entry) => entry.paymentId === payment.id);
                  const returned = refundedAmount(data!, payment.id);
                  const refundable = remainingRefund(data!, payment);
                  return (
                    <article
                      className={`payment-row ${reversal ? 'billing-reversed-payment' : ''}`}
                      key={payment.id}
                    >
                      <div className="billing-payment-record">
                        <strong>
                          <Check size={15} />
                          {money(payment.amountPaise / 100)} · {payment.method.toUpperCase()}
                        </strong>
                        <small>
                          {billingStamp(payment.createdAt)} IST
                          {payment.reference ? ` · ${payment.reference}` : ''}
                        </small>
                        <span className="billing-record-id" title={`Payment record ${payment.id}`}>
                          Entry {payment.id.slice(-8)}
                        </span>
                      </div>
                      {reversal ? (
                        <div className="billing-reversal-record">
                          <Badge>Entry reversed</Badge>
                          <p>{reversal.reason}</p>
                          <small>
                            {reversal.createdByName} · {billingStamp(reversal.createdAt)} IST
                          </small>
                          <p className="billing-help">
                            Net recorded paid {money(reversal.beforePaidPaise / 100)} →{' '}
                            {money(reversal.afterPaidPaise / 100)}. Original record retained;
                            excluded from net payments. No money was returned by this entry.
                          </p>
                        </div>
                      ) : returned > 0 ? (
                        <div className="billing-refunded-payment">
                          <Badge tone="amber">
                            {refundable > 0 ? 'Partially refunded' : 'Fully refunded'}
                          </Badge>
                          <p>
                            Active recorded external refunds: {money(returned / 100)}. Available to
                            refund: {money(refundable / 100)}.
                          </p>
                          <p className="billing-help">
                            This original payment is retained. A payment with an active recorded
                            refund cannot be reversed as an entry error.
                          </p>
                        </div>
                      ) : (
                        <p className="billing-help">
                          Available to refund: {money(refundable / 100)}
                        </p>
                      )}
                      {admin && (
                        <div className="billing-payment-actions billing-admin-action">
                          <button
                            className="button button-secondary button-small"
                            disabled={!!draft || blocked || busy || refundable <= 0}
                            onClick={() => start('refund', payment.id)}
                          >
                            Record external refund
                          </button>
                          <button
                            className="button button-ghost button-small"
                            disabled={!!draft || blocked || busy || !!reversal || returned > 0}
                            onClick={() => start('reversal', payment.id)}
                          >
                            <Undo2 size={14} />
                            Reverse erroneous entry
                          </button>
                        </div>
                      )}
                    </article>
                  );
                })
              ) : (
                <p className="muted small">No payments have been recorded.</p>
              )}
            </section>
            {data.refunds.length > 0 && (
              <section className="billing-refund-history">
                <h3>Recorded external refunds</h3>
                <p className="billing-help">
                  Original records of externally returned money, including any subsequently voided
                  entry errors. Reasons, references and attribution are shared with the patient.
                  Newest first.
                </p>
                {data.refunds.map((refund) => {
                  const voidEntry = data.refundVoids.find((entry) => entry.refundId === refund.id);
                  return (
                    <article className="billing-refund-entry" key={refund.id}>
                      <h4>
                        {money(refund.amountPaise / 100)} · {refund.method.toUpperCase()}
                      </h4>
                      <p className="billing-help">
                        Recorded by {refund.createdByName} · {billingStamp(refund.createdAt)} IST ·
                        Refund entry {refund.id.slice(-8)} · Original payment entry{' '}
                        {refund.paymentId.slice(-8)}
                      </p>
                      <p className="billing-shared-reason">{refund.reason}</p>
                      <p>Reference: {refund.reference || 'Not recorded (cash)'}</p>
                      <p className="billing-help">
                        Net recorded paid {money(refund.beforePaidPaise / 100)} →{' '}
                        {money(refund.afterPaidPaise / 100)}. Charges were unchanged.
                      </p>
                      {voidEntry && (
                        <div className="billing-refund-void-record">
                          <Badge>Refund entry voided</Badge>
                          <p>
                            This mistaken refund entry is excluded from net refund totals. Its
                            original record is retained. See the refund entry void history below for
                            the correction reason and attribution.
                          </p>
                        </div>
                      )}
                      {admin && (
                        <button
                          className="button button-ghost button-small billing-admin-action"
                          disabled={!!draft || blocked || busy || !!voidEntry}
                          onClick={() => start('refund-void', refund.paymentId, refund.id)}
                        >
                          <Undo2 size={14} /> Void refund entry
                        </button>
                      )}
                    </article>
                  );
                })}
              </section>
            )}
            {data.refundVoids.length > 0 && (
              <section className="billing-refund-void-history">
                <h3>Refund entry void history</h3>
                <p className="billing-help">
                  Corrections of refunds recorded in error. These entries restore the recorded paid
                  amount; they do not collect or return money. Newest first.
                </p>
                {data.refundVoids.map((entry) => (
                  <article key={entry.id} className="billing-refund-void-entry">
                    <h4>{money(entry.amountPaise / 100)} restored to net recorded paid</h4>
                    <p className="billing-help">
                      {entry.createdByName} · {billingStamp(entry.createdAt)} IST · Refund entry{' '}
                      {entry.refundId.slice(-8)} · Original payment entry{' '}
                      {entry.paymentId.slice(-8)}
                    </p>
                    <p className="billing-shared-reason">{entry.reason}</p>
                    <p className="billing-help">
                      Net recorded paid {money(entry.beforePaidPaise / 100)} →{' '}
                      {money(entry.afterPaidPaise / 100)}. Charges were unchanged.
                    </p>
                  </article>
                ))}
              </section>
            )}
            {staff &&
              !blocked &&
              (!currentDraft || currentDraft.kind === 'payment') &&
              (data.invoice.totalPaise > data.invoice.paidPaise ||
                currentDraft?.kind === 'payment') && (
                <PaymentEntryForm
                  draft={currentDraft ?? billingDraft('payment', data)}
                  onChange={onDraftChange}
                  onReview={onReviewPayment}
                />
              )}
            <section className="billing-issued-charges">
              <h3>
                <History size={17} />
                Original issued charges
              </h3>
              <p className="billing-help">
                Issued total: <strong>{money(data.issuedCharges.totalPaise / 100)}</strong>. The
                invoice number, patient and procedure link stay fixed.
              </p>
              {data.corrections.length ? (
                <details>
                  <summary>View original issued items</summary>
                  <ChargesTable
                    items={data.issuedCharges.items}
                    caption="Original issued line items"
                  />
                </details>
              ) : (
                <p className="billing-help">
                  The current items above are the original issued charges. No charge corrections
                  have been recorded.
                </p>
              )}
            </section>
            {data.corrections.length > 0 && (
              <section className="billing-correction-history">
                <h3>Charge correction history</h3>
                <p className="billing-help">
                  Reasons and before/after values are shared with the patient. Newest first.
                </p>
                {data.corrections.map((correction) => (
                  <article key={correction.id} className="billing-correction-record">
                    <h4>{correction.createdByName}</h4>
                    <p className="billing-help">{billingStamp(correction.createdAt)} IST</p>
                    <p className="billing-shared-reason">{correction.reason}</p>
                    <p className="billing-help">
                      Charges {money(correction.before.totalPaise / 100)} →{' '}
                      {money(correction.after.totalPaise / 100)} · Net recorded paid at the time:{' '}
                      {money(correction.after.paidPaise / 100)}
                    </p>
                    <details>
                      <summary>View charges before and after</summary>
                      <ChargesTable
                        items={correction.before.items}
                        caption="Charges before this correction"
                      />
                      <ChargesTable
                        items={correction.after.items}
                        caption="Charges after this correction"
                      />
                    </details>
                  </article>
                ))}
              </section>
            )}
            <p className="billing-help">
              This invoice shows current charges and net recorded payments after entry reversals and
              active external refund records. Voided refund errors remain in history and are
              excluded from totals. Recording a refund leaves charges unchanged, so a balance may
              reopen. Staff can correct charges separately if intended. Derma does not transfer
              money.
            </p>
            <button
              className="button button-secondary billing-no-print"
              disabled={busy || !!currentDraft}
              onClick={() => window.print()}
            >
              <Printer size={16} />
              Print invoice
            </button>
          </div>
        )
      )}
    </Modal>
  );
}

function PaymentEntryForm({
  draft,
  onChange,
  onReview,
}: {
  draft: BillingDraft;
  onChange: (value: BillingDraft | null) => void;
  onReview: (attempt: ReviewedPayment) => void;
}) {
  const { invoice, revision, payments } = draft.source;
  const due = invoice.totalPaise - invoice.paidPaise;
  function update(change: Partial<BillingDraft>) {
    onChange({ ...draft, ...change, error: '' });
  }
  function review(event: FormEvent) {
    event.preventDefault();
    try {
      const amountPaise = paise(draft.amount);
      if (amountPaise > due) throw new Error('The amount exceeds the outstanding balance.');
      onReview({
        invoiceId: invoice.id,
        invoiceNumber: invoice.number,
        patientName: invoice.patientName,
        totalPaise: invoice.totalPaise,
        beforePaidPaise: invoice.paidPaise,
        previousPaymentIds: payments.map((entry) => entry.id),
        command: {
          requestId: crypto.randomUUID(),
          patientId: invoice.patientId,
          expectedRevision: revision,
          amountPaise,
          method: draft.method,
          reference: draft.reference.trim(),
          receivedExternallyConfirmed: true,
        },
      });
    } catch (problem) {
      onChange({ ...draft, error: billingError(problem) });
    }
  }
  return (
    <form className="stack billing-edit-panel payment-form" onSubmit={review}>
      <h3>Record a received payment</h3>
      <p>Balance available to record: {money(due / 100)}.</p>
      {draft.error && (
        <p className="form-error" role="alert">
          {draft.error}
        </p>
      )}
      <div className="form-grid">
        <Field label="Amount received (₹)">
          <input
            type="number"
            required
            min="0.01"
            step="0.01"
            max={(draft.source.invoice.totalPaise - draft.source.invoice.paidPaise) / 100}
            value={draft.amount}
            onChange={(event) => update({ amount: event.target.value })}
          />
        </Field>
        <Field label="Payment method">
          <select
            value={draft.method}
            onChange={(event) => update({ method: event.target.value as Payment['method'] })}
          >
            <option value="cash">Cash</option>
            <option value="upi">UPI</option>
            <option value="card">Card</option>
            <option value="bank">Bank transfer</option>
          </select>
        </Field>
      </div>
      <Field label="Reference / receipt number">
        <input
          maxLength={200}
          value={draft.reference}
          onChange={(event) => update({ reference: event.target.value })}
        />
      </Field>
      <div className="billing-form-actions">
        <button type="button" className="button button-ghost" onClick={() => onChange(null)}>
          Clear payment draft
        </button>
        <button className="button button-primary" disabled={due <= 0}>
          Review payment
        </button>
      </div>
    </form>
  );
}
function BillingUpdateForm({
  draft,
  onChange,
  onCancel,
  busy,
  setBusy,
  onSaved,
  onReviewed,
}: {
  draft: BillingDraft;
  onChange: (draft: BillingDraft) => void;
  onCancel: () => void;
  busy: boolean;
  setBusy: (value: boolean) => void;
  onSaved: () => Promise<void>;
  onReviewed: (detail: InvoiceDetail) => void;
}) {
  const toast = useToast();
  const { session } = useSession();
  const begin = useBillingGuard();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const locked = busy || draft.phase !== 'editing' || !!draft.attempt;
  const payment = draft.source.payments.find((entry) => entry.id === draft.paymentId);
  const reversed =
    (draft.kind === 'reversal' || draft.kind === 'refund') &&
    draft.source.reversals.some((entry) => entry.paymentId === draft.paymentId);
  const returned = payment ? refundedAmount(draft.source, payment.id) : 0;
  const refundable = payment ? remainingRefund(draft.source, payment) : 0;
  const refund = draft.source.refunds.find((entry) => entry.id === draft.refundId);
  const refundVoid = draft.source.refundVoids.find((entry) => entry.refundId === draft.refundId);
  const restoredPaid = draft.source.invoice.paidPaise + (refund?.amountPaise ?? 0);
  const restorationBlocked = restoredPaid > draft.source.invoice.totalPaise;
  let preview: InvoiceItem[] | null = null;
  try {
    preview = invoiceItems(draft.items, true);
  } catch {
    /* An incomplete line has no valid monetary preview yet. */
  }
  const changed =
    draft.kind !== 'charges' ||
    (preview !== null && JSON.stringify(preview) !== JSON.stringify(draft.source.invoice.items));
  function update(change: Partial<BillingDraft>) {
    onChange({ ...draft, ...change });
  }
  function attempt() {
    const base = `/api/invoices/${draft.invoiceId}`;
    if (!draft.reason.trim())
      throw new Error('Enter the reason that will be shared with the patient.');
    const common = {
      reason: draft.reason.trim(),
      expectedRevision: draft.source.revision,
      requestId: draft.requestId,
    };
    if (draft.kind === 'charges') {
      const items = invoiceItems(draft.items, true);
      if (JSON.stringify(items) === JSON.stringify(draft.source.invoice.items))
        throw new Error('Change at least one charge before saving a correction.');
      if (chargeTotal(items) < draft.source.invoice.paidPaise)
        throw new Error(
          'Corrected charges cannot be less than net recorded payments. Record any completed external refund separately before reducing charges.',
        );
      if (!items.length && !draft.removeAllChargesConfirmed)
        throw new Error('Confirm that this invoice should have no charges.');
      return {
        path: `${base}/corrections`,
        body: { ...common, items, ...(!items.length ? { removeAllChargesConfirmed: true } : {}) },
      };
    }
    if (draft.kind === 'refund-void') {
      if (!refund || refund.paymentId !== draft.paymentId || refundVoid)
        throw new Error(
          'This refund is unavailable or already voided. Review the current invoice.',
        );
      if (restorationBlocked)
        throw new Error(
          'Restoring this refund would exceed current invoice charges. Review charges and payment records before trying again.',
        );
      if (!draft.entryErrorConfirmed)
        throw new Error(
          'Confirm that this refund was recorded in error and this correction does not move money.',
        );
      return {
        path: `${base}/refunds/${refund.id}/void`,
        body: { ...common, entryErrorConfirmed: true },
      };
    }
    if (!payment || reversed)
      throw new Error(
        'This payment is unavailable or already has an entry reversal. Review the current invoice.',
      );
    if (draft.kind === 'refund') {
      const amountPaise = paise(draft.amount),
        reference = draft.reference.trim();
      if (amountPaise > refundable)
        throw new Error(
          'The refund exceeds the remaining amount on this original payment. Review the latest invoice.',
        );
      if (draft.method !== 'cash' && !reference)
        throw new Error('Enter the refund reference for a non-cash refund.');
      if (!draft.refundedExternallyConfirmed)
        throw new Error('Confirm that this money has already been returned outside Derma.');
      return {
        path: `${base}/payments/${payment.id}/refunds`,
        body: {
          ...common,
          amountPaise,
          method: draft.method,
          reference,
          refundedExternallyConfirmed: true,
        },
      };
    }
    if (returned > 0)
      throw new Error('A payment with an active refund cannot be reversed as an entry error.');
    if (!draft.entryErrorConfirmed)
      throw new Error('Confirm that the payment entry was recorded in error.');
    return {
      path: `${base}/payments/${payment.id}/reverse`,
      body: { ...common, entryErrorConfirmed: true },
    };
  }
  function verifyResponse(
    value: unknown,
    submitted: { path: string; body: Record<string, unknown> },
    actorId: string,
  ) {
    const result = checkedInvoiceDetail(
      (draft.kind === 'refund' || draft.kind === 'refund-void') && billingRecord(value)
        ? value.detail
        : value,
      draft.invoiceId,
    );
    if (
      result.invoice.patientId !== draft.source.invoice.patientId ||
      result.invoice.number !== draft.source.invoice.number ||
      result.invoice.procedureId !== draft.source.invoice.procedureId ||
      result.invoice.procedureTitle !== draft.source.invoice.procedureTitle ||
      result.invoice.createdAt !== draft.source.invoice.createdAt ||
      result.invoice.patientName !== draft.source.invoice.patientName ||
      !sameBillingValue(result.issuedCharges, draft.source.issuedCharges)
    )
      throw new Error(
        'The response did not match the original invoice identity. Retry the same request.',
      );
    if (draft.kind === 'refund') {
      if (
        !billingRecord(value) ||
        !validRefund(value.refund, draft.invoiceId) ||
        !billingRecord(value.receipt)
      )
        throw new Error(
          'The response did not confirm the complete external refund receipt. Retry the same request.',
        );
      const refund = value.refund,
        receipt = value.receipt;
      if (
        receipt.requestId !== submitted.body.requestId ||
        receipt.actorId !== actorId ||
        receipt.invoiceId !== draft.invoiceId ||
        receipt.paymentId !== draft.paymentId ||
        receipt.expectedRevision !== submitted.body.expectedRevision ||
        receipt.refundId !== refund.id ||
        refund.paymentId !== draft.paymentId ||
        refund.amountPaise !== submitted.body.amountPaise ||
        refund.method !== submitted.body.method ||
        refund.reference !== submitted.body.reference ||
        refund.reason !== submitted.body.reason ||
        refund.refundedExternallyConfirmed !== true ||
        refund.beforePaidPaise !== draft.source.invoice.paidPaise ||
        refund.afterPaidPaise !== draft.source.invoice.paidPaise - refund.amountPaise ||
        draft.source.refunds.some((prior) => prior.id === refund.id) ||
        result.revision === draft.source.revision ||
        !result.refunds.some((entry) => sameBillingValue(entry, refund))
      )
        throw new Error(
          'The response did not match this exact external refund request and its original payment. Retry the same request.',
        );
    }
    if (draft.kind === 'refund-void') {
      if (
        !refund ||
        !billingRecord(value) ||
        !validRefundVoid(value.void, draft.invoiceId) ||
        !billingRecord(value.receipt)
      )
        throw new Error(
          'The response did not confirm the complete refund void receipt. Retry the same request.',
        );
      const entry = value.void,
        receipt = value.receipt;
      if (
        receipt.requestId !== submitted.body.requestId ||
        receipt.actorId !== actorId ||
        receipt.invoiceId !== draft.invoiceId ||
        receipt.refundId !== refund.id ||
        receipt.expectedRevision !== submitted.body.expectedRevision ||
        receipt.voidId !== entry.id ||
        entry.refundId !== refund.id ||
        entry.paymentId !== refund.paymentId ||
        entry.amountPaise !== refund.amountPaise ||
        entry.reason !== submitted.body.reason ||
        entry.entryErrorConfirmed !== true ||
        entry.beforePaidPaise !== draft.source.invoice.paidPaise ||
        entry.afterPaidPaise !== restoredPaid ||
        draft.source.refundVoids.some((original) => original.id === entry.id) ||
        result.revision === draft.source.revision ||
        !result.refundVoids.some((saved) => sameBillingValue(saved, entry)) ||
        !result.refunds.some((saved) => sameBillingValue(saved, refund))
      )
        throw new Error(
          'The response did not match this exact refund void request and its original refund. Retry the same request.',
        );
    }
    if (
      draft.kind === 'charges' &&
      (result.revision === draft.source.revision ||
        !result.corrections.some(
          (entry) =>
            entry.invoiceId === draft.invoiceId &&
            !draft.source.corrections.some((original) => original.id === entry.id) &&
            entry.reason === submitted.body.reason &&
            JSON.stringify(entry.after.items) === JSON.stringify(submitted.body.items),
        ))
    )
      throw new Error(
        'The response did not confirm the submitted charge correction. Retry the same request.',
      );
    if (
      draft.kind === 'reversal' &&
      !result.reversals.some(
        (entry) =>
          entry.invoiceId === draft.invoiceId &&
          entry.paymentId === draft.paymentId &&
          entry.reason === submitted.body.reason &&
          entry.entryErrorConfirmed &&
          entry.amountPaise === payment?.amountPaise,
      )
    )
      throw new Error(
        'The response did not confirm the submitted entry reversal. Retry the same request.',
      );
    return result;
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || draft.phase === 'conflict') return;
    let submitted: { path: string; body: Record<string, unknown> };
    try {
      submitted = draft.attempt ?? attempt();
    } catch (problem) {
      update({ error: billingError(problem) });
      return;
    }
    const current = begin(),
      actorId = draft.actorId ?? session.user?.id;
    if (!current() || !actorId) return;
    const wasUncertain = draft.phase === 'uncertain';
    onChange({ ...draft, actorId, attempt: submitted, phase: 'uncertain', error: '' });
    setBusy(true);
    try {
      verifyResponse(
        await api<unknown>(submitted.path, {
          method: 'POST',
          body: submitted.body,
          isCurrent: current,
        }),
        submitted,
        actorId,
      );
      if (!current()) return;
      // The saved form unmounts when onSaved clears its draft. Release the parent modal
      // before that unmount so its close/print controls cannot remain stuck busy.
      setBusy(false);
      toast(
        draft.kind === 'charges'
          ? 'Charge correction saved and shared with the patient.'
          : draft.kind === 'reversal'
            ? 'Mistaken payment entry reversed. No money was returned.'
            : draft.kind === 'refund'
              ? 'External refund recorded and shared with the patient. No money was transferred by Derma.'
              : 'Erroneous refund entry voided. Original history retained; no money was moved.',
      );
      await onSaved();
    } catch (problem) {
      if (!current()) return;
      const error = billingError(problem);
      if (wasUncertain)
        onChange({ ...draft, actorId, attempt: submitted, phase: 'uncertain', error });
      else if (problem instanceof ApiError && [400, 403, 404, 422, 429].includes(problem.status))
        onChange({ ...draft, phase: 'editing', attempt: null, error });
      else if (
        problem instanceof ApiError &&
        problem.status === 409 &&
        !/request.*already used|request ID.*used/i.test(error)
      )
        onChange({ ...draft, attempt: submitted, phase: 'conflict', reviewed: null, error });
      else onChange({ ...draft, actorId, attempt: submitted, phase: 'uncertain', error });
    } finally {
      if (current()) setBusy(false);
    }
  }
  async function refreshLatest() {
    if (busy) return;
    const current = begin();
    update({ phase: 'conflict', reviewed: null, error: '' });
    setBusy(true);
    try {
      const reviewed = checkedInvoiceDetail(
        await api<unknown>(`/api/invoices/${draft.invoiceId}`, { isCurrent: current }),
        draft.invoiceId,
      );
      if (current()) {
        update({ phase: 'conflict', reviewed, error: '' });
        onReviewed(reviewed);
      }
    } catch (problem) {
      if (current()) update({ phase: 'conflict', error: billingError(problem), reviewed: null });
    } finally {
      if (current()) setBusy(false);
    }
  }
  const title =
    draft.kind === 'charges'
      ? 'Correct invoice charges'
      : draft.kind === 'reversal'
        ? 'Reverse an erroneous payment entry'
        : draft.kind === 'refund'
          ? 'Record external refund'
          : 'Void an erroneous refund entry';
  return (
    <form
      className={`stack billing-edit-panel ${draft.kind === 'charges' ? 'billing-correction-form' : draft.kind === 'reversal' ? 'billing-reversal-form' : draft.kind === 'refund' ? 'billing-refund-form' : 'billing-refund-void-form'}`}
      onSubmit={save}
    >
      <h3>{title}</h3>
      {draft.error && (
        <p className="form-error" role="alert">
          {draft.error}
        </p>
      )}
      {draft.kind === 'charges' ? (
        <>
          <p className="billing-help">
            Replace the current line items while preserving the invoice number, patient, procedure
            link and original issued charges. The correction reason is visible to the patient.
          </p>
          <InvoiceLineEditor
            items={draft.items}
            locked={locked}
            allowEmpty
            onChange={(items) => update({ items, removeAllChargesConfirmed: false })}
          />
          <div className="billing-correction-preview">
            <span>
              Current charges <strong>{money(draft.source.invoice.totalPaise / 100)}</strong>
            </span>
            <span>
              Corrected charges <strong>{preview ? money(chargeTotal(preview) / 100) : '—'}</strong>
            </span>
            <span>
              Net recorded paid <strong>{money(draft.source.invoice.paidPaise / 100)}</strong>
            </span>
          </div>
          {!draft.items.length && (
            <label className="checkbox-field">
              <input
                type="checkbox"
                required
                checked={draft.removeAllChargesConfirmed}
                disabled={locked}
                onChange={(event) => update({ removeAllChargesConfirmed: event.target.checked })}
              />
              I confirm this invoice should have no charges.
            </label>
          )}
          {preview && chargeTotal(preview) < draft.source.invoice.paidPaise && (
            <p className="notice">
              Corrected charges must cover net recorded payments. If money has been returned, record
              the external refund on the original payment before reducing these charges.
            </p>
          )}
        </>
      ) : draft.kind === 'reversal' ? (
        <>
          <div className="notice">
            <span>
              This corrects a payment that was entered in error. It does not return money or record
              a refund. The original payment and this reason remain visible to the patient.
            </span>
          </div>
          <div className="billing-reversal-target">
            <strong>
              {payment
                ? `${money(payment.amountPaise / 100)} · ${payment.method.toUpperCase()}`
                : 'Payment unavailable'}
            </strong>
            {payment && (
              <p>
                {billingStamp(payment.createdAt)} IST ·{' '}
                {payment.reference || 'No reference recorded'} · Entry {payment.id.slice(-8)}
              </p>
            )}
          </div>
          <label className="checkbox-field">
            <input
              type="checkbox"
              required
              checked={draft.entryErrorConfirmed}
              disabled={locked || reversed || returned > 0}
              onChange={(event) => update({ entryErrorConfirmed: event.target.checked })}
            />
            I confirm this payment was recorded in error; this does not return money.
          </label>
          {reversed && (
            <p className="notice">
              This payment entry has already been reversed. Cancel this draft to return to its
              history.
            </p>
          )}
          {returned > 0 && (
            <p className="notice">
              This payment has an active recorded external refund and cannot be reversed as an entry
              error.
            </p>
          )}
        </>
      ) : draft.kind === 'refund-void' ? (
        <>
          <div className="notice billing-refund-boundary">
            <p>
              Use this only when the original refund was entered by mistake. The original entry and
              this patient-shared correction stay visible. This does not collect or return money.
            </p>
            <p>
              Voiding restores the original refund amount to net recorded paid and leaves invoice
              charges unchanged. Do not use it to record a patient paying money back.
            </p>
          </div>
          <div className="billing-refund-void-source">
            <h4>Original refund entry</h4>
            <strong>
              {refund
                ? `${money(refund.amountPaise / 100)} · ${refund.method.toUpperCase()}`
                : 'Refund unavailable'}
            </strong>
            {refund && (
              <>
                <p>
                  {refund.createdByName} · {billingStamp(refund.createdAt)} IST ·{' '}
                  {refund.reference || 'No reference recorded (cash)'} · Refund entry{' '}
                  {refund.id.slice(-8)}
                </p>
                <p className="billing-shared-reason">{refund.reason}</p>
                <p>Original payment entry {refund.paymentId.slice(-8)}</p>
              </>
            )}
          </div>
          {!refundVoid && (
            <>
              <div className="billing-correction-preview billing-refund-void-preview">
                <span>
                  Current charges<strong>{money(draft.source.invoice.totalPaise / 100)}</strong>
                </span>
                <span>
                  Current net recorded paid
                  <strong>{money(draft.source.invoice.paidPaise / 100)}</strong>
                </span>
                <span>
                  Net paid after this void<strong>{money(restoredPaid / 100)}</strong>
                </span>
              </div>
              <p className="billing-help">
                Available to refund on the original payment: {money(refundable / 100)}. After this
                void: {money((refundable + (refund?.amountPaise ?? 0)) / 100)}.
              </p>
            </>
          )}
          {refundVoid ? (
            <p className="notice">
              This refund entry has already been voided. Cancel this draft to view its preserved
              history.
            </p>
          ) : restorationBlocked ? (
            <div className="notice billing-refund-void-blocked">
              <p>
                Restoring this refund would exceed current invoice charges. Review the charges and
                payment entries first; correct only records that are actually wrong. No charges or
                payments will be changed by this form.
              </p>
              {draft.phase === 'editing' && (
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={busy}
                  onClick={refreshLatest}
                >
                  Refresh invoice for review
                </button>
              )}
            </div>
          ) : null}
          <label className="checkbox-field">
            <input
              type="checkbox"
              required
              checked={draft.entryErrorConfirmed}
              disabled={locked || !refund || !!refundVoid || restorationBlocked}
              onChange={(event) => update({ entryErrorConfirmed: event.target.checked })}
            />
            I confirm this refund was recorded in error; this correction does not move money.
          </label>
        </>
      ) : draft.kind === 'refund' ? (
        <>
          <div className="notice billing-refund-boundary">
            <p>
              Record only money already returned outside Derma. This action does not send money or
              initiate a refund. The reason and reference are shared with the patient.
            </p>
            <p>
              Invoice charges stay unchanged and the balance due increases by the recorded refund.
              Correct charges separately if the clinic intends to reduce them.
            </p>
          </div>
          <div className="billing-refund-source">
            <h4>Original payment</h4>
            <strong>
              {payment
                ? `${money(payment.amountPaise / 100)} · ${payment.method.toUpperCase()}`
                : 'Payment unavailable'}
            </strong>
            {payment && (
              <p>
                {billingStamp(payment.createdAt)} IST ·{' '}
                {payment.reference || 'No reference recorded'} · Entry {payment.id.slice(-8)}
              </p>
            )}
            <p>Active recorded refunds: {money(returned / 100)}</p>
            <p>
              Available to refund: <strong>{money(refundable / 100)}</strong>
            </p>
          </div>
          <div className="form-grid">
            <Field label="Refund amount (₹)">
              <input
                type="number"
                required
                min="0.01"
                max={refundable / 100}
                step="0.01"
                value={draft.amount}
                disabled={locked || refundable <= 0}
                onChange={(event) => update({ amount: event.target.value })}
              />
            </Field>
            <Field label="Refund method">
              <select
                value={draft.method}
                disabled={locked}
                onChange={(event) => update({ method: event.target.value as Payment['method'] })}
              >
                <option value="cash">Cash</option>
                <option value="upi">UPI</option>
                <option value="card">Card</option>
                <option value="bank">Bank transfer</option>
              </select>
            </Field>
          </div>
          <Field
            label="Refund reference"
            hint="Required for non-cash refunds. This reference is visible to the patient; do not enter account secrets."
          >
            <input
              required={draft.method !== 'cash'}
              maxLength={200}
              value={draft.reference}
              disabled={locked}
              onChange={(event) => update({ reference: event.target.value })}
            />
          </Field>
          <label className="checkbox-field">
            <input
              type="checkbox"
              required
              checked={draft.refundedExternallyConfirmed}
              disabled={locked || refundable <= 0}
              onChange={(event) => update({ refundedExternallyConfirmed: event.target.checked })}
            />
            I confirm this money has already been returned to the patient outside Derma.
          </label>
          {refundable <= 0 && (
            <p className="notice">
              No amount remains available to refund on this payment. Cancel this draft to return to
              its preserved history.
            </p>
          )}
        </>
      ) : null}
      <Field
        label={
          draft.kind === 'refund'
            ? 'Reason for refund'
            : draft.kind === 'refund-void'
              ? 'Reason for voiding refund'
              : 'Reason shared with patient'
        }
        hint="This reason becomes part of the invoice history shared with the patient."
      >
        <textarea
          required
          rows={3}
          maxLength={1000}
          value={draft.reason}
          disabled={locked}
          onChange={(event) => update({ reason: event.target.value })}
        />
      </Field>
      {draft.kind === 'charges' && !changed && draft.phase === 'editing' && (
        <p className="billing-help">
          Change the line items before saving. A reason alone does not create a correction.
        </p>
      )}
      {draft.phase === 'uncertain' && (
        <div className="notice billing-retry">
          <strong>The save outcome could not be confirmed.</strong>
          <p>
            The exact submitted entry and request ID are preserved. Retry the same request to check
            its outcome without applying it twice. You may close this invoice and resume the pending
            update from the billing page.
          </p>
        </div>
      )}
      {draft.phase === 'conflict' && (
        <div className="notice billing-conflict">
          <strong>Review the current invoice before saving.</strong>
          <p>
            Your draft is preserved. Charges, payment entries, refunds, refund voids or reversals
            may have changed.
          </p>
          {draft.reviewed ? (
            <>
              <h4>Latest saved invoice</h4>
              <ChargesTable
                items={draft.reviewed.invoice.items}
                caption="Latest saved charges for review"
              />
              <p>
                Current charges: {money(draft.reviewed.invoice.totalPaise / 100)} · Net recorded
                paid: {money(draft.reviewed.invoice.paidPaise / 100)} · Balance:{' '}
                {money(
                  (draft.reviewed.invoice.totalPaise - draft.reviewed.invoice.paidPaise) / 100,
                )}
              </p>
              {draft.kind === 'reversal' &&
                draft.reviewed.reversals.some((entry) => entry.paymentId === draft.paymentId) && (
                  <p>This payment has already been reversed.</p>
                )}
              {(draft.kind === 'refund' ||
                draft.kind === 'reversal' ||
                draft.kind === 'refund-void') &&
                payment && (
                  <div className="billing-refund-reviewed">
                    <p>
                      Latest active recorded external refunds on this payment:{' '}
                      {money(refundedAmount(draft.reviewed, payment.id) / 100)}.
                    </p>
                    <p>
                      Available to refund: {money(remainingRefund(draft.reviewed, payment) / 100)}.
                    </p>
                    {draft.reviewed.reversals.some((entry) => entry.paymentId === payment.id) && (
                      <p>This original payment has been reversed and cannot receive a refund.</p>
                    )}
                    {draft.reviewed.refunds
                      .filter(
                        (entry) =>
                          entry.paymentId === payment.id &&
                          !draft.source.refunds.some((old) => old.id === entry.id),
                      )
                      .map((entry) => (
                        <p key={entry.id}>
                          {entry.createdByName} · {billingStamp(entry.createdAt)} IST ·{' '}
                          {money(entry.amountPaise / 100)} · {entry.reason}
                        </p>
                      ))}
                    {draft.reviewed.refundVoids
                      .filter(
                        (entry) =>
                          entry.paymentId === payment.id &&
                          !draft.source.refundVoids.some((old) => old.id === entry.id),
                      )
                      .map((entry) => (
                        <p key={entry.id}>
                          Refund entry voided: {entry.createdByName} ·{' '}
                          {billingStamp(entry.createdAt)} IST · {money(entry.amountPaise / 100)} ·{' '}
                          {entry.reason}
                        </p>
                      ))}
                  </div>
                )}
              {draft.kind === 'refund-void' && refund && (
                <p className="billing-refund-void-reviewed">
                  {draft.reviewed.refundVoids.some((entry) => entry.refundId === refund.id)
                    ? 'This refund entry has already been voided.'
                    : `Net paid after voiding this refund would be ${money((draft.reviewed.invoice.paidPaise + refund.amountPaise) / 100)} against current charges of ${money(draft.reviewed.invoice.totalPaise / 100)}.`}
                </p>
              )}
              <p>Your draft will be used as shown. Review it before preparing a new request.</p>
              <button
                className="button button-secondary"
                type="button"
                disabled={busy}
                onClick={() =>
                  update({
                    source: draft.reviewed!,
                    reviewed: null,
                    phase: 'editing',
                    attempt: null,
                    requestId: crypto.randomUUID(),
                    removeAllChargesConfirmed: false,
                    entryErrorConfirmed: false,
                    refundedExternallyConfirmed: false,
                    actorId: null,
                    error: '',
                  })
                }
              >
                I reviewed the latest invoice; keep my draft
              </button>
            </>
          ) : (
            <button
              className="button button-secondary"
              type="button"
              disabled={busy}
              onClick={refreshLatest}
            >
              Refresh invoice for review
            </button>
          )}
        </div>
      )}
      <div className="billing-form-actions">
        {draft.phase === 'editing' && !draft.attempt && (
          <button className="button button-ghost" type="button" disabled={busy} onClick={onCancel}>
            {draft.kind === 'charges'
              ? 'Cancel correction'
              : draft.kind === 'reversal'
                ? 'Cancel reversal'
                : draft.kind === 'refund'
                  ? 'Cancel refund draft'
                  : 'Cancel refund void draft'}
          </button>
        )}
        <button
          className="button button-primary"
          disabled={
            busy ||
            draft.phase === 'conflict' ||
            (draft.phase === 'editing' &&
              ((draft.kind === 'charges' &&
                (!changed ||
                  (!draft.items.length && !draft.removeAllChargesConfirmed) ||
                  (preview !== null && chargeTotal(preview) < draft.source.invoice.paidPaise))) ||
                (draft.kind === 'reversal' && (!draft.entryErrorConfirmed || returned > 0)) ||
                (draft.kind === 'refund' &&
                  (!draft.refundedExternallyConfirmed || refundable <= 0)) ||
                (draft.kind === 'refund-void' &&
                  (!draft.entryErrorConfirmed || !refund || !!refundVoid || restorationBlocked)) ||
                reversed))
          }
        >
          {busy
            ? 'Saving…'
            : draft.phase === 'uncertain'
              ? 'Retry same request'
              : draft.kind === 'charges'
                ? 'Save charge correction'
                : draft.kind === 'reversal'
                  ? 'Confirm entry reversal'
                  : draft.kind === 'refund'
                    ? 'Record refund'
                    : 'Confirm refund entry void'}
        </button>
      </div>
    </form>
  );
}

export function LibraryPage({ manage = false }: { manage?: boolean }) {
  return manage ? <KnowledgeLibraryManager /> : <PatientLibraryPage />;
}
function PatientLibraryPage() {
  const articles = useResource<KnowledgeArticle[]>('/api/knowledge');
  const [search, setSearch] = useState('');
  const rows = (articles.data || []).filter((a) =>
    `${a.title} ${a.category} ${a.body}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <div className="library-page">
      <PageHeader
        eyebrow="INFORMATION YOU CAN COME BACK TO"
        title="A little clarity for your care."
        description="Practical information reviewed and shared by your clinic."
      />
      <div className="library-search">
        <Search size={18} />
        <input
          aria-label="Search articles"
          placeholder="Search clinic information…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {articles.loading ? (
        <Loading />
      ) : articles.error ? (
        <ErrorState message={articles.error} retry={articles.reload} />
      ) : !rows.length ? (
        <Card>
          <EmptyState
            title="No articles yet"
            description="Your clinic will share useful information here. You can contact the clinic with any questions."
          />
        </Card>
      ) : (
        <div className="grid-3 knowledge-grid">
          {rows.map((article) => (
            <Card key={article.id}>
              <div className="row between">
                <span className="module-icon">
                  <BookOpen size={22} />
                </span>
                <Badge tone="green">{article.category}</Badge>
              </div>
              <h2>{article.title}</h2>
              <p className="muted article-preview">
                {article.body.slice(0, 180)}
                {article.body.length > 180 ? '…' : ''}
              </p>
              <small>Updated {formatDate(article.updatedAt)}</small>
              <div className="row">
                <a
                  className="button button-secondary button-small"
                  href={`/library/${encodeURIComponent(article.id)}`}
                  aria-label={`Read article: ${article.title}`}
                >
                  Read article
                </a>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
