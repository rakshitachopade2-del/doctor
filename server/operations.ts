import type { Express } from 'express';
import { z } from 'zod';
import type { AuthRequest } from './app.ts';
import { createUser, get, id, insert, list, nowISO, type DB } from './db.ts';
import type { Patient, User } from '../shared/types.ts';
import type { Invoice, KnowledgeArticle, Payment } from '../shared/operations.ts';
import type { ProcedureRecord } from '../shared/clinical.ts';
import { notifyPatient } from './activity.ts';
import {
  invoiceDetail,
  invoiceItemSchema,
  invoicePaymentStatus,
  issuedInvoiceCharges,
  registerBillingCorrections,
} from './billing-corrections.ts';

interface OperationsContext {
  db: DB;
  demoMode: boolean;
  actor: (req: AuthRequest, roles?: User['role'][]) => User;
  patientAccess: (req: AuthRequest, patientId: string, allowReception?: boolean) => Patient;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
}

export function registerOperations(app: Express, context: OperationsContext) {
  const { db, actor, patientAccess, audit, fail, demoMode } = context;
  db.exec(`
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      patientId TEXT NOT NULL REFERENCES patients(id),
      invoiceNumber INTEGER NOT NULL UNIQUE,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invoiceSequence (id INTEGER PRIMARY KEY CHECK(id=1), nextValue INTEGER NOT NULL);
    INSERT OR IGNORE INTO invoiceSequence(id,nextValue) VALUES (1,1);
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      invoiceId TEXT NOT NULL REFERENCES invoices(id),
      requestId TEXT NOT NULL,
      data TEXT NOT NULL,
      UNIQUE(invoiceId,requestId)
    );
    CREATE TABLE IF NOT EXISTS procedureInvoiceLinks (
      procedureId TEXT PRIMARY KEY REFERENCES procedures(id),
      invoiceId TEXT NOT NULL UNIQUE REFERENCES invoices(id)
    );
    CREATE TRIGGER IF NOT EXISTS procedure_invoice_link_update BEFORE UPDATE ON procedureInvoiceLinks BEGIN SELECT RAISE(ABORT,'Procedure invoice links are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS procedure_invoice_link_delete BEFORE DELETE ON procedureInvoiceLinks BEGIN SELECT RAISE(ABORT,'Procedure invoice links are immutable'); END;
    CREATE TABLE IF NOT EXISTS knowledge (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS knowledgeRevisions (id TEXT PRIMARY KEY, articleId TEXT NOT NULL REFERENCES knowledge(id), data TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS unique_patient_portal ON users(json_extract(data,'$.patientId')) WHERE role='patient';
    CREATE TRIGGER IF NOT EXISTS prevent_payment_update BEFORE UPDATE ON payments BEGIN SELECT RAISE(ABORT,'Payment records are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS prevent_payment_delete BEFORE DELETE ON payments BEGIN SELECT RAISE(ABORT,'Payment records are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS prevent_knowledge_revision_update BEFORE UPDATE ON knowledgeRevisions BEGIN SELECT RAISE(ABORT,'Knowledge revisions are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS prevent_knowledge_revision_delete BEFORE DELETE ON knowledgeRevisions BEGIN SELECT RAISE(ABORT,'Knowledge revisions are append-only'); END;
  `);
  if (
    !db
      .prepare('PRAGMA table_info(invoices)')
      .all()
      .some((column) => column.name === 'requestId')
  )
    db.exec('ALTER TABLE invoices ADD COLUMN requestId TEXT');
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS unique_invoice_request ON invoices(requestId) WHERE requestId IS NOT NULL',
  );
  if (demoMode && !db.prepare('SELECT 1 FROM meta WHERE key=?').get('operations-demo-seeded')) {
    const articles: KnowledgeArticle[] = [
      {
        id: 'article-visit',
        title: 'Getting ready for your appointment',
        category: 'Visiting the clinic',
        body: 'You can find your appointment date, time and consultation mode in My care. Bring any records you would like to discuss. If you need to change the time, use the reschedule option before check-in or contact reception. Online joining details are shared separately by the clinic. This is demonstration clinic information.',
        status: 'published',
        authorName: 'Demo clinic team',
        updatedAt: nowISO(),
      },
      {
        id: 'article-care',
        title: 'Finding your care plan',
        category: 'Using your care space',
        body: 'After your consultation, your clinician can add a care plan to My care. Instructions, follow-up dates and clinician-provided warnings appear together. Your daily check-ins record what you report; they do not measure clinical improvement. Use Messages for non-urgent questions. The inbox is not monitored for emergencies.',
        status: 'published',
        authorName: 'Demo clinic team',
        updatedAt: nowISO(),
      },
      {
        id: 'article-draft',
        title: 'Clinic welcome guide',
        category: 'Clinic information',
        body: 'Draft: add clinic-specific arrival instructions and contact details, then review and approve before publishing.',
        status: 'draft',
        authorName: 'Demo clinic team',
        updatedAt: nowISO(),
      },
    ];
    db.exec('BEGIN');
    try {
      for (const article of articles) insert(db, 'knowledge', article);
      db.prepare('INSERT INTO meta(key,value) VALUES (?,?)').run('operations-demo-seeded', 'true');
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  const staff = (req: AuthRequest) => actor(req, ['admin', 'doctor', 'receptionist']);
  const clinician = (req: AuthRequest) => actor(req, ['admin', 'doctor']);
  const invoiceAccess = (req: AuthRequest, invoiceId: string) => {
    const invoice = get<Invoice>(db, 'invoices', invoiceId);
    if (!invoice) return fail(404, 'Invoice not found.');
    patientAccess(req, invoice.patientId, true);
    return invoice;
  };
  registerBillingCorrections(app, { db, actor, invoiceAccess, audit, fail });
  const detail = (invoice: Invoice) => invoiceDetail(db, invoice);
  const item = invoiceItemSchema;
  app.get('/api/invoices', (req: AuthRequest, res) => {
    const user = actor(req);
    const invoices = list<Invoice>(
      db,
      'invoices',
      user.role === 'patient' ? user.patientId : undefined,
    );
    res.json(invoices);
  });
  app.get('/api/procedure-billing', (req: AuthRequest, res) => {
    staff(req);
    const input = z.object({ patientId: z.string().min(1).optional() }).parse(req.query);
    if (input.patientId) patientAccess(req, input.patientId, true);
    res.json(
      list<ProcedureRecord>(db, 'procedures', input.patientId).map((procedure) => {
        const link = db
          .prepare('SELECT invoiceId FROM procedureInvoiceLinks WHERE procedureId=?')
          .get(procedure.id);
        const invoice = link ? get<Invoice>(db, 'invoices', String(link.invoiceId)) : undefined;
        return {
          id: procedure.id,
          patientId: procedure.patientId,
          patientName: get<Patient>(db, 'patients', procedure.patientId)!.name,
          title: procedure.title,
          estimatedCost: procedure.estimatedCost,
          status: db.prepare('SELECT 1 FROM procedureCancellations WHERE id=?').get(procedure.id)
            ? 'cancelled'
            : db.prepare('SELECT 1 FROM procedureCompletions WHERE id=?').get(procedure.id)
              ? 'completed'
              : 'planned',
          invoiceId: invoice?.id ?? null,
          invoiceNumber: invoice?.number ?? null,
        };
      }),
    );
  });
  app.post('/api/invoices', (req: AuthRequest, res) => {
    staff(req);
    const input = z
      .object({
        patientId: z.string().min(1),
        items: z.array(item).min(1).max(100),
        requestId: z.string().uuid().optional(),
        procedureId: z.string().min(1).optional(),
      })
      .parse(req.body);
    const patient = patientAccess(req, input.patientId, true);
    const totalPaise = input.items.reduce(
      (sum, line) => sum + line.quantity * line.unitAmountPaise,
      0,
    );
    if (!Number.isSafeInteger(totalPaise) || totalPaise > 1_000_000_000)
      return fail(400, 'Invoice total must be at most ₹1,00,00,000.');
    let invoice: Invoice;
    let duplicate = false;
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous = input.requestId
        ? (db.prepare('SELECT data FROM invoices WHERE requestId=?').get(input.requestId) as
            { data: string } | undefined)
        : undefined;
      if (previous) {
        invoice = JSON.parse(previous.data) as Invoice;
        if (
          invoice.patientId !== input.patientId ||
          invoice.procedureId !== input.procedureId ||
          JSON.stringify(issuedInvoiceCharges(db, invoice).items) !== JSON.stringify(input.items)
        )
          fail(409, 'This invoice request was already used with different details.');
        duplicate = true;
      } else {
        const procedure = input.procedureId
          ? get<ProcedureRecord>(db, 'procedures', input.procedureId)
          : undefined;
        if (input.procedureId) {
          if (!procedure || procedure.patientId !== input.patientId)
            fail(400, 'The procedure must belong to this patient.');
          if (db.prepare('SELECT 1 FROM procedureCancellations WHERE id=?').get(input.procedureId))
            fail(409, 'A cancelled procedure cannot be linked to a new invoice.');
          if (
            db
              .prepare('SELECT 1 FROM procedureInvoiceLinks WHERE procedureId=?')
              .get(input.procedureId)
          )
            fail(409, 'This procedure already has a linked invoice. Open the existing invoice.');
        }
        const serial = Number(
          db.prepare('SELECT nextValue FROM invoiceSequence WHERE id=1').get()!.nextValue,
        );
        invoice = {
          id: id(),
          patientId: patient.id,
          patientName: patient.name,
          number: `INV-${String(serial).padStart(6, '0')}`,
          items: input.items,
          totalPaise,
          paidPaise: 0,
          status: 'unpaid',
          createdAt: nowISO(),
          ...(procedure ? { procedureId: procedure.id, procedureTitle: procedure.title } : {}),
        };
        db.prepare(
          'INSERT INTO invoices(id,patientId,invoiceNumber,data,requestId) VALUES (?,?,?,?,?)',
        ).run(invoice.id, patient.id, serial, JSON.stringify(invoice), input.requestId ?? null);
        if (procedure)
          db.prepare('INSERT INTO procedureInvoiceLinks(procedureId,invoiceId) VALUES (?,?)').run(
            procedure.id,
            invoice.id,
          );
        db.prepare('UPDATE invoiceSequence SET nextValue=nextValue+1 WHERE id=1').run();
        audit(req, 'created invoice', 'invoice', invoice.id);
        notifyPatient(db, invoice.patientId, `invoice-created:${invoice.id}`, {
          kind: 'billing',
          title: 'Your clinic created an invoice',
          detail: invoice.number,
          href: `/my-care/invoices?invoice=${invoice.id}`,
        });
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    res.status(duplicate ? 200 : 201).json(invoice);
  });
  app.get('/api/invoices/:id', (req: AuthRequest, res) => {
    const invoice = invoiceAccess(req, String(req.params.id));
    audit(req, 'viewed invoice', 'invoice', invoice.id);
    res.json(detail(invoice));
  });
  app.post('/api/invoices/:id/payments', (req: AuthRequest, res) => {
    staff(req);
    const invoiceId = String(req.params.id);
    invoiceAccess(req, invoiceId);
    const input = z
      .object({
        amountPaise: z.number().int().min(1).max(1_000_000_000),
        method: z.enum(['cash', 'card', 'upi', 'bank']),
        reference: z.string().trim().max(200).default(''),
        requestId: z.string().uuid(),
      })
      .parse(req.body);
    let invoice: Invoice;
    let duplicate = false;
    db.exec('BEGIN IMMEDIATE');
    try {
      invoice = get<Invoice>(db, 'invoices', invoiceId)!;
      const previous = db
        .prepare('SELECT data FROM payments WHERE invoiceId=? AND requestId=?')
        .get(invoiceId, input.requestId) as { data: string } | undefined;
      if (previous) {
        const payment = JSON.parse(previous.data) as Payment;
        if (
          payment.amountPaise !== input.amountPaise ||
          payment.method !== input.method ||
          payment.reference !== input.reference
        )
          fail(409, 'This payment request was already used with different details.');
        duplicate = true;
      } else {
        if (input.amountPaise > invoice.totalPaise - invoice.paidPaise)
          fail(409, 'This payment would exceed the outstanding invoice balance.');
        const payment: Payment = { ...input, id: id(), invoiceId, createdAt: nowISO() };
        db.prepare('INSERT INTO payments(id,invoiceId,requestId,data) VALUES (?,?,?,?)').run(
          payment.id,
          invoiceId,
          input.requestId,
          JSON.stringify(payment),
        );
        invoice.paidPaise += input.amountPaise;
        invoice.status = invoicePaymentStatus(invoice.totalPaise, invoice.paidPaise);
        db.prepare('UPDATE invoices SET data=? WHERE id=?').run(JSON.stringify(invoice), invoiceId);
        audit(req, 'recorded manual payment', 'invoice', invoiceId);
        notifyPatient(db, invoice.patientId, `payment-recorded:${payment.id}`, {
          kind: 'billing',
          title: 'Your clinic recorded a received payment',
          detail: invoice.number,
          href: `/my-care/invoices?invoice=${invoice.id}`,
        });
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    res.status(duplicate ? 200 : 201).json(detail(invoice));
  });
  app.get('/api/knowledge', (req, res) => {
    const articles = db
      .prepare(
        `SELECT id, json_extract(data,'$.title') AS title,
        json_extract(data,'$.category') AS category, json_extract(data,'$.body') AS body,
        'published' AS status, json_extract(data,'$.authorName') AS authorName,
        json_extract(data,'$.updatedAt') AS updatedAt FROM knowledge
        WHERE json_extract(data,'$.status')='published' ORDER BY rowid DESC`,
      )
      .all();
    const body = JSON.stringify(articles);
    res.type('json').setHeader('Content-Length', String(Buffer.byteLength(body)));
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  app.get('/api/knowledge/manage', (req: AuthRequest, res) => {
    clinician(req);
    res.json(list<KnowledgeArticle>(db, 'knowledge'));
  });
  const articleFields = z.object({
    title: z.string().trim().min(1).max(300),
    category: z.string().trim().min(1).max(100),
    body: z.string().trim().min(1).max(30000),
  });
  app.post('/api/knowledge', (req: AuthRequest, res) => {
    const user = clinician(req);
    const input = articleFields.parse(req.body);
    const article: KnowledgeArticle = {
      ...input,
      id: id(),
      status: 'draft',
      authorName: user.name,
      updatedAt: nowISO(),
    };
    insert(db, 'knowledge', article);
    audit(req, 'created knowledge draft', 'knowledge', article.id);
    res.status(201).json(article);
  });
  app.patch('/api/knowledge/:id', (req: AuthRequest, res) => {
    const user = clinician(req);
    const articleId = String(req.params.id);
    const original = get<KnowledgeArticle>(db, 'knowledge', articleId);
    if (!original) return fail(404, 'Article not found.');
    const input = articleFields
      .extend({ status: z.enum(['draft', 'published']) })
      .partial()
      .strict()
      .refine((value) => Object.keys(value).length > 0, 'No changes supplied')
      .parse(req.body);
    const contentChanged =
      (input.body !== undefined && input.body !== original.body) ||
      (input.title !== undefined && input.title !== original.title) ||
      (input.category !== undefined && input.category !== original.category);
    const article: KnowledgeArticle = {
      ...original,
      ...input,
      status: input.status ?? (contentChanged ? 'draft' : original.status),
      authorName: user.name,
      updatedAt: nowISO(),
    };
    db.exec('BEGIN');
    try {
      db.prepare('INSERT INTO knowledgeRevisions(id,articleId,data) VALUES (?,?,?)').run(
        id(),
        articleId,
        JSON.stringify(original),
      );
      db.prepare('UPDATE knowledge SET data=? WHERE id=?').run(JSON.stringify(article), articleId);
      audit(
        req,
        article.status === 'published'
          ? 'approved and published knowledge'
          : 'saved knowledge draft',
        'knowledge',
        articleId,
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    res.json(article);
  });
  app.post('/api/patients/:id/portal-account', (req: AuthRequest, res) => {
    actor(req, ['admin']);
    const patientId = String(req.params.id);
    const patient = patientAccess(req, patientId);
    const input = z
      .object({
        email: z
          .string()
          .trim()
          .email()
          .max(254)
          .transform((value) => value.toLowerCase()),
        password: z.string().min(12).max(128),
        identityVerified: z.literal(true),
      })
      .parse(req.body);
    let user: User;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (
        db
          .prepare(
            "SELECT 1 FROM users WHERE role='patient' AND json_extract(data,'$.patientId')=?",
          )
          .get(patientId)
      )
        fail(
          409,
          'This patient already has a portal account. Existing accounts cannot be relinked.',
        );
      if (db.prepare('SELECT 1 FROM users WHERE email=? COLLATE NOCASE').get(input.email))
        fail(409, 'This email already has an account. Existing accounts cannot be relinked.');
      user = {
        id: id(),
        name: patient.name,
        email: input.email,
        role: 'patient',
        patientId,
        active: true,
        mustChangePassword: true,
      };
      createUser(db, user, input.password);
      db.prepare('UPDATE patients SET data=? WHERE id=?').run(
        JSON.stringify({ ...patient, email: input.email }),
        patientId,
      );
      audit(
        req,
        'provisioned patient portal after clinic identity verification',
        'patient',
        patientId,
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    res.status(201).json(user);
  });
}
