import type { Express } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AuthRequest } from './app.ts';
import type { Invoice, InvoiceDetail, Payment } from '../shared/operations.ts';
import type {
  InvoiceCharges,
  InvoiceCorrection,
  InvoiceFinancialSnapshot,
  InvoiceHistory,
  PaymentReversal,
  PaymentRefund,
  PaymentRefundMutation,
  PaymentRefundVoid,
  PaymentRefundVoidMutation,
} from '../shared/billing-corrections.ts';
import type { User } from '../shared/types.ts';
import { get, id, nowISO, type DB } from './db.ts';
import { notifyPatient } from './activity.ts';
import { mfaSessionAllowed } from './mfa.ts';

interface BillingContext {
  db: DB;
  actor: (req: AuthRequest, roles?: User['role'][]) => User;
  invoiceAccess: (req: AuthRequest, invoiceId: string) => Invoice;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
}
type StoredCorrection = InvoiceCorrection & { createdById: string; requestId: string };
type StoredReversal = PaymentReversal & { createdById: string; requestId: string };
type StoredRefund = PaymentRefund & {
  createdById: string;
  requestId: string;
  expectedRevision: string;
};
type StoredRefundVoid = PaymentRefundVoid & {
  createdById: string;
  requestId: string;
  expectedRevision: string;
};
const moneyLimit = 1_000_000_000;
export const invoiceItemSchema = z.object({
  description: z.string().trim().min(1).max(300),
  quantity: z.number().int().min(1).max(1000),
  unitAmountPaise: z.number().int().min(1).max(moneyLimit),
});
const commandFields = {
  reason: z.string().trim().min(1).max(1000),
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/, 'Refresh the invoice before correcting it.'),
  requestId: z
    .string()
    .uuid()
    .transform((value) => value.toLowerCase()),
};
const correctionInput = z
  .object({
    items: z.array(invoiceItemSchema.strict()).max(100),
    ...commandFields,
    removeAllChargesConfirmed: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.items.length === 0
        ? value.removeAllChargesConfirmed === true
        : value.removeAllChargesConfirmed === undefined,
    'Confirm removal of all charges only when the corrected invoice has no items.',
  );
const reversalInput = z.object({ ...commandFields, entryErrorConfirmed: z.literal(true) }).strict();
const refundInput = z
  .object({
    ...commandFields,
    amountPaise: z.number().int().min(1).max(moneyLimit),
    method: z.enum(['cash', 'card', 'upi', 'bank']),
    reference: z.string().trim().max(200).default(''),
    refundedExternallyConfirmed: z.literal(true),
  })
  .strict()
  .refine(
    (value) => value.method === 'cash' || value.reference.length > 0,
    'Record the external refund reference for card, UPI or bank refunds.',
  );
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function safeRefund(value: StoredRefund): PaymentRefund {
  return {
    id: value.id,
    invoiceId: value.invoiceId,
    paymentId: value.paymentId,
    amountPaise: value.amountPaise,
    method: value.method,
    reference: value.reference,
    reason: value.reason,
    refundedExternallyConfirmed: true,
    beforePaidPaise: value.beforePaidPaise,
    afterPaidPaise: value.afterPaidPaise,
    createdByName: value.createdByName,
    createdAt: value.createdAt,
  };
}
function safeRefundVoid(value: StoredRefundVoid): PaymentRefundVoid {
  return {
    id: value.id,
    invoiceId: value.invoiceId,
    refundId: value.refundId,
    paymentId: value.paymentId,
    amountPaise: value.amountPaise,
    beforePaidPaise: value.beforePaidPaise,
    afterPaidPaise: value.afterPaidPaise,
    entryErrorConfirmed: true,
    reason: value.reason,
    createdByName: value.createdByName,
    createdAt: value.createdAt,
  };
}

export function invoicePaymentStatus(totalPaise: number, paidPaise: number): Invoice['status'] {
  return totalPaise === 0
    ? 'no-charge'
    : paidPaise === totalPaise
      ? 'paid'
      : paidPaise
        ? 'partial'
        : 'unpaid';
}
function charges(invoice: Invoice): InvoiceCharges {
  return { items: invoice.items, totalPaise: invoice.totalPaise };
}
function snapshot(invoice: Invoice): InvoiceFinancialSnapshot {
  return { ...charges(invoice), paidPaise: invoice.paidPaise, status: invoice.status };
}
/** Original charge lines remain independent of the mutable current invoice. */
export function issuedInvoiceCharges(db: DB, invoice: Invoice): InvoiceCharges {
  return get<InvoiceCharges>(db, 'invoiceIssuedCharges', invoice.id) ?? charges(invoice);
}
/** Source payment rows remain immutable; these IDs identify erroneous entries to exclude. */
export function reversedPaymentIds(db: DB): Set<string> {
  return new Set(
    db
      .prepare('SELECT paymentId FROM paymentReversals')
      .all()
      .map((row) => String(row.paymentId)),
  );
}
/** Call only after invoice/patient authorization. Reasons are explicitly patient-shared. */
export function safeInvoiceHistory(db: DB, invoiceId: string): InvoiceHistory {
  const invoice = get<Invoice>(db, 'invoices', invoiceId);
  if (!invoice) throw new Error('Invoice not found.');
  const corrections = db
    .prepare('SELECT data FROM invoiceCorrections WHERE invoiceId=? ORDER BY rowid DESC')
    .all(invoiceId)
    .map((row): InvoiceCorrection => {
      const value = JSON.parse(row.data as string) as StoredCorrection;
      return {
        id: value.id,
        invoiceId: value.invoiceId,
        before: value.before,
        after: value.after,
        reason: value.reason,
        createdByName: value.createdByName,
        createdAt: value.createdAt,
      };
    });
  const reversals = db
    .prepare('SELECT data FROM paymentReversals WHERE invoiceId=? ORDER BY rowid DESC')
    .all(invoiceId)
    .map((row): PaymentReversal => {
      const value = JSON.parse(row.data as string) as StoredReversal;
      return {
        id: value.id,
        invoiceId: value.invoiceId,
        paymentId: value.paymentId,
        amountPaise: value.amountPaise,
        beforePaidPaise: value.beforePaidPaise,
        afterPaidPaise: value.afterPaidPaise,
        entryErrorConfirmed: true,
        reason: value.reason,
        createdByName: value.createdByName,
        createdAt: value.createdAt,
      };
    });
  const refunds = db
    .prepare('SELECT data FROM paymentRefunds WHERE invoiceId=? ORDER BY rowid DESC')
    .all(invoiceId)
    .map((row) => safeRefund(JSON.parse(row.data as string) as StoredRefund));
  const refundVoids = db
    .prepare('SELECT data FROM paymentRefundVoids WHERE invoiceId=? ORDER BY rowid DESC')
    .all(invoiceId)
    .map((row) => safeRefundVoid(JSON.parse(row.data as string) as StoredRefundVoid));
  return {
    invoiceId,
    issuedCharges: issuedInvoiceCharges(db, invoice),
    corrections,
    reversals,
    refunds,
    refundVoids,
  };
}
export function invoiceDetail(db: DB, invoice: Invoice): InvoiceDetail {
  const history = safeInvoiceHistory(db, invoice.id);
  const payments = db
    .prepare('SELECT data FROM payments WHERE invoiceId=? ORDER BY rowid')
    .all(invoice.id)
    .map((row) => JSON.parse(row.data as string) as Payment);
  const content = { invoice, payments, ...history };
  return { ...content, revision: digest(content) };
}

export function registerBillingCorrections(app: Express, context: BillingContext) {
  const { db, actor, invoiceAccess, audit, fail } = context;
  db.exec(`
    CREATE TABLE IF NOT EXISTS invoiceIssuedCharges (
      id TEXT PRIMARY KEY REFERENCES invoices(id), data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invoiceCorrections (
      id TEXT PRIMARY KEY, invoiceId TEXT NOT NULL REFERENCES invoices(id), data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS invoice_corrections_invoice ON invoiceCorrections(invoiceId);
    CREATE UNIQUE INDEX IF NOT EXISTS payment_invoice_identity ON payments(id,invoiceId);
    CREATE TABLE IF NOT EXISTS paymentReversals (
      id TEXT PRIMARY KEY, invoiceId TEXT NOT NULL REFERENCES invoices(id),
      paymentId TEXT NOT NULL UNIQUE, data TEXT NOT NULL,
      FOREIGN KEY(paymentId,invoiceId) REFERENCES payments(id,invoiceId)
    );
    CREATE INDEX IF NOT EXISTS payment_reversals_invoice ON paymentReversals(invoiceId);
    CREATE TABLE IF NOT EXISTS paymentRefunds (
      id TEXT PRIMARY KEY, invoiceId TEXT NOT NULL REFERENCES invoices(id),
      paymentId TEXT NOT NULL, amountPaise INTEGER NOT NULL CHECK(amountPaise BETWEEN 1 AND 1000000000),
      createdAt TEXT NOT NULL, data TEXT NOT NULL,
      FOREIGN KEY(paymentId,invoiceId) REFERENCES payments(id,invoiceId)
    );
    CREATE INDEX IF NOT EXISTS payment_refunds_invoice ON paymentRefunds(invoiceId);
    CREATE INDEX IF NOT EXISTS payment_refunds_payment ON paymentRefunds(paymentId);
    CREATE INDEX IF NOT EXISTS payment_refunds_created_at ON paymentRefunds(createdAt);
    CREATE UNIQUE INDEX IF NOT EXISTS payment_refund_source_identity ON paymentRefunds(id,invoiceId,paymentId);
    CREATE TABLE IF NOT EXISTS paymentRefundVoids (
      id TEXT PRIMARY KEY, invoiceId TEXT NOT NULL REFERENCES invoices(id),
      refundId TEXT NOT NULL UNIQUE, paymentId TEXT NOT NULL, createdAt TEXT NOT NULL, data TEXT NOT NULL,
      FOREIGN KEY(refundId,invoiceId,paymentId) REFERENCES paymentRefunds(id,invoiceId,paymentId),
      FOREIGN KEY(paymentId,invoiceId) REFERENCES payments(id,invoiceId)
    );
    CREATE INDEX IF NOT EXISTS payment_refund_voids_invoice ON paymentRefundVoids(invoiceId);
    CREATE INDEX IF NOT EXISTS payment_refund_voids_payment ON paymentRefundVoids(paymentId);
    CREATE INDEX IF NOT EXISTS payment_refund_voids_created_at ON paymentRefundVoids(createdAt);
    CREATE TABLE IF NOT EXISTS billingCorrectionCommands (
      requestId TEXT PRIMARY KEY, actorId TEXT NOT NULL REFERENCES users(id),
      operation TEXT NOT NULL, invoiceId TEXT NOT NULL REFERENCES invoices(id),
      paymentId TEXT REFERENCES payments(id), payload TEXT NOT NULL, eventId TEXT NOT NULL
    );
  `);
  for (const table of [
    'invoiceIssuedCharges',
    'invoiceCorrections',
    'paymentReversals',
    'paymentRefunds',
    'paymentRefundVoids',
    'billingCorrectionCommands',
  ]) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT,'Billing correction source records are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT,'Billing correction source records are immutable'); END;`);
  }
  function transaction<T>(operation: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  function currentInvoice(invoiceId: string) {
    const invoice = get<Invoice>(db, 'invoices', invoiceId);
    if (!invoice) return fail(404, 'Invoice not found.');
    return invoice;
  }
  /** Revalidate the authenticated account and invoice scope after taking the write lock. */
  function authorize(req: AuthRequest, invoiceId: string) {
    const cached = actor(req, ['admin']);
    const user = get<User>(db, 'users', cached.id);
    const session = db
      .prepare('SELECT userId,expiresAt,csrfToken,mfaCredentialId FROM sessions WHERE tokenHash=?')
      .get(req.sessionToken ?? '');
    if (
      !user ||
      user.active === false ||
      !session ||
      session.userId !== user.id ||
      Number(session.expiresAt) <= Date.now() ||
      session.csrfToken !== req.csrfToken ||
      !mfaSessionAllowed(db, user.id, session.mfaCredentialId)
    )
      return fail(401, 'Your session changed. Sign in again.');
    if (user.mustChangePassword || user.role !== 'admin')
      return fail(403, 'Only an active administrator can change these billing records.');
    req.user = user;
    invoiceAccess(req, invoiceId);
    return user;
  }
  function replay(
    requestId: string,
    user: User,
    operation: string,
    invoiceId: string,
    paymentId: string | null,
    payload: unknown,
  ) {
    const prior = db
      .prepare(
        'SELECT actorId,operation,invoiceId,paymentId,payload,eventId FROM billingCorrectionCommands WHERE requestId=?',
      )
      .get(requestId);
    if (!prior) return null;
    if (
      prior.actorId !== user.id ||
      prior.operation !== operation ||
      prior.invoiceId !== invoiceId ||
      prior.paymentId !== paymentId ||
      prior.payload !== JSON.stringify(payload)
    )
      fail(409, 'This billing correction request was already used with different details.');
    return String(prior.eventId);
  }
  function remember(
    requestId: string,
    user: User,
    operation: string,
    invoiceId: string,
    paymentId: string | null,
    payload: unknown,
    eventId: string,
  ) {
    db.prepare(
      'INSERT INTO billingCorrectionCommands(requestId,actorId,operation,invoiceId,paymentId,payload,eventId) VALUES (?,?,?,?,?,?,?)',
    ).run(requestId, user.id, operation, invoiceId, paymentId, JSON.stringify(payload), eventId);
  }
  function requireRevision(invoice: Invoice, expected: string) {
    if (invoiceDetail(db, invoice).revision !== expected)
      fail(
        409,
        'The invoice or its payment records changed. Refresh and review the latest balance before saving.',
      );
  }
  function publish(
    req: AuthRequest,
    invoice: Invoice,
    eventId: string,
    action: string,
    title: string,
  ) {
    db.prepare('UPDATE invoices SET data=? WHERE id=?').run(JSON.stringify(invoice), invoice.id);
    audit(req, action, 'invoice', invoice.id);
    notifyPatient(db, invoice.patientId, `billing-corrected:${eventId}`, {
      kind: 'billing',
      title,
      detail: invoice.number,
      href: `/my-care/invoices?invoice=${invoice.id}`,
    });
  }
  app.post('/api/invoices/:id/corrections', (req: AuthRequest, res) => {
    const invoiceId = String(req.params.id);
    actor(req, ['admin']);
    invoiceAccess(req, invoiceId);
    const { expectedRevision, requestId, ...input } = correctionInput.parse(req.body);
    const totalPaise = input.items.reduce(
      (sum, item) => sum + item.quantity * item.unitAmountPaise,
      0,
    );
    if (!Number.isSafeInteger(totalPaise) || totalPaise > moneyLimit)
      fail(400, 'Invoice total must be at most ₹1,00,00,000.');
    res.json(
      transaction(() => {
        const user = authorize(req, invoiceId);
        if (replay(requestId, user, 'charges', invoiceId, null, input))
          return invoiceDetail(db, currentInvoice(invoiceId));
        const invoice = currentInvoice(invoiceId);
        requireRevision(invoice, expectedRevision);
        if (JSON.stringify(invoice.items) === JSON.stringify(input.items))
          fail(400, 'Change at least one charge item before saving a correction.');
        if (totalPaise < invoice.paidPaise)
          fail(
            409,
            'Corrected charges cannot be less than the net recorded payments. Record a completed external refund or correct an erroneous payment entry first, as applicable.',
          );
        // Existing invoices have never had editable charges before this module. Capture their
        // known original lines lazily, without inventing an issue author or new issue date.
        db.prepare('INSERT OR IGNORE INTO invoiceIssuedCharges(id,data) VALUES (?,?)').run(
          invoice.id,
          JSON.stringify(charges(invoice)),
        );
        const before = snapshot(invoice);
        invoice.items = input.items;
        invoice.totalPaise = totalPaise;
        invoice.status = invoicePaymentStatus(totalPaise, invoice.paidPaise);
        const correction: StoredCorrection = {
          id: id(),
          invoiceId,
          before,
          after: snapshot(invoice),
          reason: input.reason,
          createdByName: user.name,
          createdById: user.id,
          requestId,
          createdAt: nowISO(),
        };
        db.prepare('INSERT INTO invoiceCorrections(id,invoiceId,data) VALUES (?,?,?)').run(
          correction.id,
          invoiceId,
          JSON.stringify(correction),
        );
        remember(requestId, user, 'charges', invoiceId, null, input, correction.id);
        publish(
          req,
          invoice,
          correction.id,
          'corrected invoice charges',
          'Your clinic corrected invoice charges',
        );
        return invoiceDetail(db, invoice);
      }),
    );
  });
  app.post('/api/invoices/:id/payments/:paymentId/reverse', (req: AuthRequest, res) => {
    const invoiceId = String(req.params.id),
      paymentId = String(req.params.paymentId);
    actor(req, ['admin']);
    invoiceAccess(req, invoiceId);
    const { expectedRevision, requestId, ...input } = reversalInput.parse(req.body);
    res.json(
      transaction(() => {
        const user = authorize(req, invoiceId);
        if (replay(requestId, user, 'payment-entry', invoiceId, paymentId, input))
          return invoiceDetail(db, currentInvoice(invoiceId));
        const invoice = currentInvoice(invoiceId);
        const payment = get<Payment>(db, 'payments', paymentId);
        if (!payment || payment.invoiceId !== invoiceId)
          fail(404, 'Payment entry not found on this invoice.');
        requireRevision(invoice, expectedRevision);
        if (db.prepare('SELECT 1 FROM paymentReversals WHERE paymentId=?').get(paymentId))
          fail(409, 'This payment entry has already been reversed.');
        if (
          db
            .prepare(
              `SELECT 1 FROM paymentRefunds r WHERE r.paymentId=?
          AND NOT EXISTS (SELECT 1 FROM paymentRefundVoids v WHERE v.refundId=r.id) LIMIT 1`,
            )
            .get(paymentId)
        )
          fail(
            409,
            'A payment with an active recorded external refund cannot be reversed as an erroneous entry.',
          );
        if (payment!.amountPaise > invoice.paidPaise)
          fail(
            409,
            'The recorded payment balance is inconsistent. Review the invoice before correcting it.',
          );
        const beforePaidPaise = invoice.paidPaise;
        invoice.paidPaise -= payment!.amountPaise;
        invoice.status = invoicePaymentStatus(invoice.totalPaise, invoice.paidPaise);
        const reversal: StoredReversal = {
          id: id(),
          invoiceId,
          paymentId,
          amountPaise: payment!.amountPaise,
          beforePaidPaise,
          afterPaidPaise: invoice.paidPaise,
          entryErrorConfirmed: true,
          reason: input.reason,
          createdByName: user.name,
          createdById: user.id,
          requestId,
          createdAt: nowISO(),
        };
        db.prepare(
          'INSERT INTO paymentReversals(id,invoiceId,paymentId,data) VALUES (?,?,?,?)',
        ).run(reversal.id, invoiceId, paymentId, JSON.stringify(reversal));
        remember(requestId, user, 'payment-entry', invoiceId, paymentId, input, reversal.id);
        publish(
          req,
          invoice,
          reversal.id,
          'reversed erroneous payment entry',
          'Your clinic corrected a payment record',
        );
        return invoiceDetail(db, invoice);
      }),
    );
  });
  app.post('/api/invoices/:id/payments/:paymentId/refunds', (req: AuthRequest, res) => {
    const invoiceId = String(req.params.id),
      paymentId = String(req.params.paymentId);
    const result = transaction(() => {
      const user = authorize(req, invoiceId);
      z.object({}).strict().parse(req.query);
      const { requestId, ...input } = refundInput.parse(req.body);
      const prior = replay(requestId, user, 'external-refund', invoiceId, paymentId, input);
      function response(value: StoredRefund): PaymentRefundMutation {
        return {
          detail: invoiceDetail(db, currentInvoice(invoiceId)),
          refund: safeRefund(value),
          receipt: {
            requestId: value.requestId,
            actorId: value.createdById,
            invoiceId: value.invoiceId,
            paymentId: value.paymentId,
            expectedRevision: value.expectedRevision,
            refundId: value.id,
          },
        };
      }
      if (prior) {
        const value = get<StoredRefund>(db, 'paymentRefunds', prior);
        if (!value) return fail(500, 'The original refund receipt is unavailable.');
        return { status: 200, value: response(value) };
      }
      const invoice = currentInvoice(invoiceId);
      const payment = get<Payment>(db, 'payments', paymentId);
      if (!payment || payment.invoiceId !== invoiceId)
        return fail(404, 'Payment entry not found on this invoice.');
      requireRevision(invoice, input.expectedRevision);
      if (db.prepare('SELECT 1 FROM paymentReversals WHERE paymentId=?').get(paymentId))
        return fail(
          409,
          'An erroneous payment entry that was reversed cannot have an external refund recorded.',
        );
      const refunded = Number(
        db
          .prepare(
            `SELECT COALESCE(SUM(r.amountPaise),0) AS total FROM paymentRefunds r WHERE r.paymentId=?
              AND NOT EXISTS (SELECT 1 FROM paymentRefundVoids v WHERE v.refundId=r.id)`,
          )
          .get(paymentId)!.total,
      );
      if (input.amountPaise > payment.amountPaise - refunded)
        return fail(409, 'The refund exceeds the remaining refundable amount of this payment.');
      if (input.amountPaise > invoice.paidPaise)
        return fail(
          409,
          'The recorded balance is inconsistent. Review the invoice before recording a refund.',
        );
      const beforePaidPaise = invoice.paidPaise;
      invoice.paidPaise -= input.amountPaise;
      invoice.status = invoicePaymentStatus(invoice.totalPaise, invoice.paidPaise);
      const value: StoredRefund = {
        id: id(),
        invoiceId,
        paymentId,
        amountPaise: input.amountPaise,
        method: input.method,
        reference: input.reference,
        reason: input.reason,
        refundedExternallyConfirmed: true,
        beforePaidPaise,
        afterPaidPaise: invoice.paidPaise,
        createdByName: user.name,
        createdById: user.id,
        createdAt: nowISO(),
        requestId,
        expectedRevision: input.expectedRevision,
      };
      db.prepare(
        'INSERT INTO paymentRefunds(id,invoiceId,paymentId,amountPaise,createdAt,data) VALUES (?,?,?,?,?,?)',
      ).run(
        value.id,
        invoiceId,
        paymentId,
        value.amountPaise,
        value.createdAt,
        JSON.stringify(value),
      );
      remember(requestId, user, 'external-refund', invoiceId, paymentId, input, value.id);
      publish(
        req,
        invoice,
        value.id,
        'recorded external payment refund',
        'Your clinic recorded a refund completed outside the app',
      );
      return { status: 201, value: response(value) };
    });
    res.status(result.status).json(result.value);
  });
  app.post('/api/invoices/:id/refunds/:refundId/void', (req: AuthRequest, res) => {
    const invoiceId = String(req.params.id),
      refundId = String(req.params.refundId);
    const result = transaction(() => {
      const user = authorize(req, invoiceId);
      z.object({}).strict().parse(req.query);
      const { requestId, ...input } = reversalInput.parse(req.body);
      // A void targets a refund, rather than a payment. Bind its ID in the canonical payload.
      const payload = { refundId, ...input };
      const prior = replay(requestId, user, 'refund-entry', invoiceId, null, payload);
      function response(value: StoredRefundVoid): PaymentRefundVoidMutation {
        return {
          detail: invoiceDetail(db, currentInvoice(invoiceId)),
          void: safeRefundVoid(value),
          receipt: {
            requestId: value.requestId,
            actorId: value.createdById,
            invoiceId: value.invoiceId,
            refundId: value.refundId,
            expectedRevision: value.expectedRevision,
            voidId: value.id,
          },
        };
      }
      if (prior) {
        const value = get<StoredRefundVoid>(db, 'paymentRefundVoids', prior);
        if (!value) return fail(500, 'The original refund correction receipt is unavailable.');
        return { status: 200, value: response(value) };
      }
      const invoice = currentInvoice(invoiceId),
        refund = get<StoredRefund>(db, 'paymentRefunds', refundId);
      if (!refund || refund.invoiceId !== invoiceId)
        return fail(404, 'Refund entry not found on this invoice.');
      requireRevision(invoice, input.expectedRevision);
      if (db.prepare('SELECT 1 FROM paymentRefundVoids WHERE refundId=?').get(refundId))
        return fail(409, 'This erroneous refund entry has already been voided.');
      if (db.prepare('SELECT 1 FROM paymentReversals WHERE paymentId=?').get(refund.paymentId))
        return fail(
          409,
          'The source payment was reversed. Review the billing records before correcting this refund.',
        );
      const afterPaidPaise = invoice.paidPaise + refund.amountPaise;
      if (afterPaidPaise > invoice.totalPaise)
        return fail(
          409,
          'Restoring this refund would exceed the current invoice charges. Review and separately correct charges or an erroneous later payment first.',
        );
      const value: StoredRefundVoid = {
        id: id(),
        invoiceId,
        refundId,
        paymentId: refund.paymentId,
        amountPaise: refund.amountPaise,
        beforePaidPaise: invoice.paidPaise,
        afterPaidPaise,
        entryErrorConfirmed: true,
        reason: input.reason,
        createdByName: user.name,
        createdAt: nowISO(),
        createdById: user.id,
        requestId,
        expectedRevision: input.expectedRevision,
      };
      db.prepare(
        'INSERT INTO paymentRefundVoids(id,invoiceId,refundId,paymentId,createdAt,data) VALUES (?,?,?,?,?,?)',
      ).run(value.id, invoiceId, refundId, value.paymentId, value.createdAt, JSON.stringify(value));
      invoice.paidPaise = afterPaidPaise;
      invoice.status = invoicePaymentStatus(invoice.totalPaise, invoice.paidPaise);
      remember(requestId, user, 'refund-entry', invoiceId, null, payload, value.id);
      publish(
        req,
        invoice,
        value.id,
        'voided erroneous refund entry',
        'Your clinic corrected a refund record',
      );
      return { status: 201, value: response(value) };
    });
    res.status(result.status).json(result.value);
  });
}
