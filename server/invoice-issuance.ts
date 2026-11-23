import { createHash } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import type {
  InvoiceNotIssued,
  InvoiceIssuanceResult,
  IssuedInvoice,
} from '../shared/invoice-issuance.ts';
import type { Invoice } from '../shared/operations.ts';
import type { ProcedureRecord } from '../shared/clinical.ts';
import type { Patient, User } from '../shared/types.ts';
import { notifyPatient } from './activity.ts';
import type { AuthRequest } from './app.ts';
import { invoiceItemSchema } from './billing-corrections.ts';
import { get, id, nowISO, type DB } from './db.ts';

interface Dependencies {
  db: DB;
  authorizeBillingStaff: (req: AuthRequest) => User;
  patientAccess: (req: AuthRequest, patientId: string, allowReception: boolean) => Patient;
  transaction: <T>(work: () => T) => T;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
}

const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const recordId = z.string().min(1);
const legacySchema = z.object({
  patientId: recordId,
  items: z.array(invoiceItemSchema).min(1).max(100),
  requestId: uuid.optional(),
  procedureId: recordId.optional(),
});
const reviewedSchema = legacySchema
  .extend({
    patientId: z.string().trim().min(1),
    procedureId: z.string().trim().min(1).optional(),
    items: z.array(invoiceItemSchema.strict()).min(1).max(100),
    requestId: uuid,
    reviewedConfirmed: z.literal(true),
  })
  .strict();
const emptyQuery = z.object({}).strict();
type Input = z.infer<typeof legacySchema>;

export function registerInvoiceIssuance(
  app: Express,
  { db, authorizeBillingStaff, patientAccess, transaction, audit, fail }: Dependencies,
) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS invoiceIssuanceCommands (
      requestId TEXT PRIMARY KEY, actorId TEXT NOT NULL REFERENCES users(id),
      patientId TEXT NOT NULL REFERENCES patients(id), payloadHash TEXT NOT NULL,
      invoiceId TEXT UNIQUE REFERENCES invoices(id), originalInvoice TEXT, rejectionStatus INTEGER, rejection TEXT,
      CHECK ((invoiceId IS NOT NULL AND originalInvoice IS NOT NULL AND rejectionStatus IS NULL AND rejection IS NULL)
          OR (invoiceId IS NULL AND originalInvoice IS NULL AND rejectionStatus IS NOT NULL AND rejectionStatus IN (400,409) AND rejection IS NOT NULL))
    );
    CREATE TRIGGER IF NOT EXISTS invoice_issuance_no_update BEFORE UPDATE ON invoiceIssuanceCommands
      BEGIN SELECT RAISE(ABORT,'Invoice issuance evidence is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS invoice_issuance_no_delete BEFORE DELETE ON invoiceIssuanceCommands
      BEGIN SELECT RAISE(ABORT,'Invoice issuance evidence is immutable'); END;
    CREATE INDEX IF NOT EXISTS invoice_request_casefold ON invoices(requestId COLLATE NOCASE) WHERE requestId IS NOT NULL;
  `);

  function issue(req: AuthRequest, reviewed: boolean) {
    const actorId = authorizeBillingStaff(req).id;
    if (reviewed) emptyQuery.parse(req.query);
    const input: Input = reviewed ? reviewedSchema.parse(req.body) : legacySchema.parse(req.body);
    const { patientId, requestId, procedureId, items } = input;
    const patient = patientAccess(req, patientId, true);
    const totalPaise = items.reduce((sum, item) => sum + item.quantity * item.unitAmountPaise, 0);
    if (!Number.isSafeInteger(totalPaise) || totalPaise > 1_000_000_000)
      return fail(400, 'Invoice total must be at most ₹1,00,00,000.');

    const payloadHash = createHash('sha256')
      .update(JSON.stringify({ procedureId, items }))
      .digest('hex');
    function success(invoice: IssuedInvoice) {
      if (!reviewed || !requestId) return invoice;
      return {
        receipt: { requestId, actorId, patientId, invoice },
      } satisfies InvoiceIssuanceResult;
    }
    function rejected(status: number, message: string) {
      if (!reviewed || !requestId) return fail(status, message);
      const body: InvoiceNotIssued = {
        code: 'INVOICE_NOT_ISSUED',
        actorId,
        command: { ...input, requestId, reviewedConfirmed: true },
        message,
      };
      return { status, body };
    }
    if (requestId) {
      const prior = db
        .prepare('SELECT * FROM invoiceIssuanceCommands WHERE requestId=?')
        .get(requestId);
      if (prior) {
        if (
          prior.actorId !== actorId ||
          prior.patientId !== patientId ||
          prior.payloadHash !== payloadHash
        )
          return fail(
            409,
            'This invoice request was already used with different details or by another staff account.',
          );
        if (typeof prior.rejection === 'string')
          return rejected(Number(prior.rejectionStatus), prior.rejection);
        return {
          status: 200,
          body: reviewed
            ? success(JSON.parse(String(prior.originalInvoice)))
            : get<Invoice>(db, 'invoices', String(prior.invoiceId))!,
        };
      }
      // Older invoices retained their UUID but no verifiable issuing account. Never claim their key.
      if (db.prepare('SELECT 1 FROM invoices WHERE requestId=? COLLATE NOCASE').get(requestId))
        return fail(
          409,
          'This invoice request was already used before issuance confirmations were available. Check the existing invoices.',
        );
    }
    function rejectProcedure(status: number, message: string) {
      if (reviewed && requestId)
        db.prepare(
          'INSERT INTO invoiceIssuanceCommands(requestId,actorId,patientId,payloadHash,rejectionStatus,rejection) VALUES (?,?,?,?,?,?)',
        ).run(requestId, actorId, patientId, payloadHash, status, message);
      return rejected(status, message);
    }
    const procedure = procedureId ? get<ProcedureRecord>(db, 'procedures', procedureId) : undefined;
    if (procedureId) {
      if (!procedure || procedure.patientId !== patientId)
        return rejectProcedure(400, 'The procedure must belong to this patient.');
      if (db.prepare('SELECT 1 FROM procedureCancellations WHERE id=?').get(procedureId))
        return rejectProcedure(409, 'A cancelled procedure cannot be linked to a new invoice.');
      if (db.prepare('SELECT 1 FROM procedureInvoiceLinks WHERE procedureId=?').get(procedureId))
        return rejectProcedure(
          409,
          'This procedure already has a linked invoice. Open the existing invoice.',
        );
    }
    const serial = Number(
      db.prepare('SELECT nextValue FROM invoiceSequence WHERE id=1').get()!.nextValue,
    );
    const invoice: IssuedInvoice = {
      id: id(),
      patientId,
      patientName: patient.name,
      number: `INV-${String(serial).padStart(6, '0')}`,
      items,
      totalPaise,
      paidPaise: 0,
      status: 'unpaid',
      createdAt: nowISO(),
      ...(procedure ? { procedureId: procedure.id, procedureTitle: procedure.title } : {}),
    };
    const original = JSON.stringify(invoice);
    db.prepare(
      'INSERT INTO invoices(id,patientId,invoiceNumber,data,requestId) VALUES (?,?,?,?,?)',
    ).run(invoice.id, patientId, serial, original, requestId ?? null);
    if (procedure)
      db.prepare('INSERT INTO procedureInvoiceLinks(procedureId,invoiceId) VALUES (?,?)').run(
        procedure.id,
        invoice.id,
      );
    db.prepare('UPDATE invoiceSequence SET nextValue=nextValue+1 WHERE id=1').run();
    audit(req, 'created invoice', 'invoice', invoice.id);
    notifyPatient(db, patientId, `invoice-created:${invoice.id}`, {
      kind: 'billing',
      title: 'Your clinic created an invoice',
      detail: invoice.number,
      href: `/my-care/invoices?invoice=${invoice.id}`,
    });
    if (requestId)
      db.prepare(
        'INSERT INTO invoiceIssuanceCommands(requestId,actorId,patientId,payloadHash,invoiceId,originalInvoice) VALUES (?,?,?,?,?,?)',
      ).run(requestId, actorId, patientId, payloadHash, invoice.id, original);
    return { status: 201, body: success(invoice) };
  }
  app.post('/api/invoices', (req: AuthRequest, res) => {
    const { status, body } = transaction(() => issue(req, false));
    res.status(status).json(body);
  });
  app.post('/api/invoices/issue', (req: AuthRequest, res) => {
    const { status, body } = transaction(() => issue(req, true));
    res.status(status).json(body);
  });
}
