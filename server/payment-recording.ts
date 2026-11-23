import { createHash } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import type { Invoice, Payment } from '../shared/operations.ts';
import type {
  PaymentNotRecorded,
  PaymentRecordingCommand,
  PaymentRecordingResult,
} from '../shared/payment-recording.ts';
import type { User } from '../shared/types.ts';
import { notifyPatient } from './activity.ts';
import type { AuthRequest } from './app.ts';
import { invoiceDetail, invoicePaymentStatus } from './billing-corrections.ts';
import { id, nowISO, type DB } from './db.ts';

interface Dependencies {
  db: DB;
  authorizeBillingStaff: (req: AuthRequest) => User;
  invoiceAccess: (req: AuthRequest, invoiceId: string) => Invoice;
  transaction: <T>(work: () => T) => T;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
}

const reference = z.string().trim().max(200);
const legacy = z.object({
  amountPaise: z.number().int().min(1).max(1_000_000_000),
  method: z.enum(['cash', 'card', 'upi', 'bank']),
  reference: reference.default(''),
  requestId: z.string().uuid(),
});
const reviewed = legacy
  .extend({
    requestId: z
      .string()
      .uuid()
      .transform((v) => v.toLowerCase()),
    patientId: z.string().trim().min(1),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
    reference,
    receivedExternallyConfirmed: z.literal(true),
  })
  .strict();
const emptyQuery = z.object({}).strict();

export function registerPaymentRecording(
  app: Express,
  { db, authorizeBillingStaff, invoiceAccess, transaction, audit, fail }: Dependencies,
) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS paymentRecordingCommands (
      requestId TEXT PRIMARY KEY, actorId TEXT NOT NULL REFERENCES users(id),
      invoiceId TEXT NOT NULL REFERENCES invoices(id), patientId TEXT NOT NULL REFERENCES patients(id),
      adapter TEXT NOT NULL CHECK(adapter IN ('legacy','reviewed')), payloadHash TEXT NOT NULL,
      paymentId TEXT UNIQUE REFERENCES payments(id), originalReceipt TEXT, rejection TEXT,
      CHECK ((paymentId IS NOT NULL AND rejection IS NULL AND ((adapter='legacy' AND originalReceipt IS NULL) OR (adapter='reviewed' AND originalReceipt IS NOT NULL)))
        OR (adapter='reviewed' AND paymentId IS NULL AND originalReceipt IS NULL AND rejection IS NOT NULL))
    );
    CREATE TRIGGER IF NOT EXISTS payment_recording_no_update BEFORE UPDATE ON paymentRecordingCommands
      BEGIN SELECT RAISE(ABORT,'Payment recording outcomes are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS payment_recording_no_delete BEFORE DELETE ON paymentRecordingCommands
      BEGIN SELECT RAISE(ABORT,'Payment recording outcomes are immutable'); END;
    CREATE INDEX IF NOT EXISTS payment_request_casefold ON payments(requestId COLLATE NOCASE);
  `);
  function record(req: AuthRequest, adapter: 'legacy' | 'reviewed') {
    const actorId = authorizeBillingStaff(req).id;
    const invoiceId = String(req.params.id);
    const invoice = invoiceAccess(req, invoiceId);
    const { patientId } = invoice;
    if (adapter === 'reviewed') emptyQuery.parse(req.query);
    const command: PaymentRecordingCommand | null =
      adapter === 'reviewed' ? reviewed.parse(req.body) : null;
    const input = command ?? legacy.parse(req.body);
    if (command && command.patientId !== patientId)
      return fail(409, 'The reviewed patient does not match this invoice.');
    const { amountPaise, method, reference } = input;
    const requestId = input.requestId.toLowerCase();
    const payloadHash = createHash('sha256')
      .update(JSON.stringify([amountPaise, method, reference, command?.expectedRevision]))
      .digest('hex');
    const identity = [requestId, actorId, invoiceId, patientId, adapter, payloadHash];
    const prior = db
      .prepare('SELECT * FROM paymentRecordingCommands WHERE requestId=?')
      .get(requestId);
    function rejected(message: string, recordOutcome: boolean) {
      if (!command) return fail(409, message);
      if (recordOutcome)
        db.prepare(
          'INSERT INTO paymentRecordingCommands(requestId,actorId,invoiceId,patientId,adapter,payloadHash,rejection) VALUES (?,?,?,?,?,?,?)',
        ).run(...identity, message);
      return {
        status: 409,
        body: {
          code: 'PAYMENT_NOT_RECORDED',
          actorId,
          invoiceId,
          command,
          message,
        } satisfies PaymentNotRecorded,
      };
    }
    if (prior) {
      if (
        prior.actorId !== actorId ||
        prior.invoiceId !== invoiceId ||
        prior.patientId !== patientId ||
        prior.adapter !== adapter ||
        prior.payloadHash !== payloadHash
      )
        return fail(
          409,
          'This payment request was already used with different details or by another staff account.',
        );
      if (typeof prior.rejection === 'string') return rejected(prior.rejection, false);
      return {
        status: 200,
        body: command
          ? { receipt: JSON.parse(String(prior.originalReceipt)) }
          : invoiceDetail(db, invoice),
      };
    }
    // Original records from older versions have no verifiable recorder. Reserve their keys.
    if (
      db.prepare('SELECT 1 FROM payments WHERE requestId=? COLLATE NOCASE LIMIT 1').get(requestId)
    )
      return fail(
        409,
        'This payment request already exists. Check the recorded payments on the invoice.',
      );
    if (command && invoiceDetail(db, invoice).revision !== command.expectedRevision)
      return rejected(
        'The invoice changed. Review the current balance before recording the payment.',
        true,
      );
    const beforePaidPaise = invoice.paidPaise;
    if (amountPaise > invoice.totalPaise - beforePaidPaise)
      return rejected('This payment would exceed the outstanding invoice balance.', true);
    const payment = { id: id(), invoiceId, createdAt: nowISO(), amountPaise, method, reference };
    // The historic detail DTO exposes a requestId. Reviewed entries expose only a record-level ID.
    const row: Payment = { ...payment, requestId: command ? payment.id : input.requestId };
    db.prepare('INSERT INTO payments(id,invoiceId,requestId,data) VALUES (?,?,?,?)').run(
      row.id,
      invoiceId,
      row.requestId,
      JSON.stringify(row),
    );
    const afterPaidPaise = beforePaidPaise + amountPaise;
    invoice.paidPaise = afterPaidPaise;
    invoice.status = invoicePaymentStatus(invoice.totalPaise, afterPaidPaise);
    db.prepare('UPDATE invoices SET data=? WHERE id=?').run(JSON.stringify(invoice), invoiceId);
    audit(req, 'recorded manual payment', 'invoice', invoiceId);
    notifyPatient(db, patientId, 'payment-recorded:' + payment.id, {
      kind: 'billing',
      title: 'Your clinic recorded a received payment',
      detail: invoice.number,
      href: `/my-care/invoices?invoice=${invoiceId}`,
    });
    const original = command
      ? ({
          receipt: {
            requestId,
            actorId,
            invoiceId,
            patientId,
            expectedRevision: command.expectedRevision,
            invoiceNumber: invoice.number,
            totalPaise: invoice.totalPaise,
            beforePaidPaise,
            afterPaidPaise,
            payment,
          },
        } satisfies PaymentRecordingResult)
      : null;
    db.prepare(
      'INSERT INTO paymentRecordingCommands(requestId,actorId,invoiceId,patientId,adapter,payloadHash,paymentId,originalReceipt) VALUES (?,?,?,?,?,?,?,?)',
    ).run(...identity, payment.id, original ? JSON.stringify(original.receipt) : null);
    return { status: 201, body: original ?? invoiceDetail(db, invoice) };
  }
  for (const [path, adapter] of [
    ['/api/invoices/:id/payments', 'legacy'],
    ['/api/invoices/:id/payments/record', 'reviewed'],
  ] as const) {
    app.post(path, (req: AuthRequest, res) => {
      const { status, body } = transaction(() => record(req, adapter));
      res.status(status).json(body);
    });
  }
}
