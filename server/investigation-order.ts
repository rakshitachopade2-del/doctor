import { createHash } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import {
  investigationOrderFields,
  type InvestigationNotOrdered,
  type InvestigationOrderFields,
  type InvestigationOrderResponse,
} from '../shared/investigation-order.ts';
import type { Investigation } from '../shared/clinical.ts';
import type { AuthRequest } from './app.ts';
import { notifyPatient } from './activity.ts';
import { clinicToday, id, insert, nowISO, type DB } from './db.ts';

type Order = Omit<Investigation, 'results' | 'reviews'>;
type Clinician = Pick<Order, 'doctorId' | 'doctorName'>;
interface Dependencies {
  db: DB;
  transaction: <T>(work: () => T) => T;
  authorize: (req: AuthRequest) => { actorId: string; role: string; clinician: Clinician };
  patientAccess: (req: AuthRequest, patientId: string) => void;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
}

const legacy = investigationOrderFields.extend({
  dueDate: investigationOrderFields.shape.dueDate.default(null),
});
const reviewed = investigationOrderFields
  .extend({
    doctorId: investigationOrderFields.shape.patientId,
    orderedByRole: z.enum(['doctor', 'admin']),
    requestId: z.uuid().transform((value) => value.toLowerCase()),
    reviewedConfirmed: z.literal(true),
  })
  .strict();
const noQuery = z.strictObject({});
const pastDue = 'Choose today or a future due date.';

export function registerInvestigationOrders(
  app: Express,
  { db, transaction, authorize, patientAccess, audit, fail }: Dependencies,
) {
  db.exec(`CREATE TABLE IF NOT EXISTS investigationOrderCommands (
    requestId TEXT PRIMARY KEY, actorId TEXT NOT NULL REFERENCES users(id),
    patientId TEXT NOT NULL REFERENCES patients(id), commandHash TEXT NOT NULL,
    investigationId TEXT UNIQUE REFERENCES investigations(id), refusal TEXT,
    CHECK ((investigationId IS NOT NULL AND refusal IS NULL) OR
           (investigationId IS NULL AND refusal IS NOT NULL))
  );
  CREATE TRIGGER IF NOT EXISTS investigationOrderCommands_no_update BEFORE UPDATE ON investigationOrderCommands
    BEGIN SELECT RAISE(ABORT,'Investigation order evidence is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS investigationOrderCommands_no_delete BEFORE DELETE ON investigationOrderCommands
    BEGIN SELECT RAISE(ABORT,'Investigation order evidence is immutable'); END;`);

  function requireWrite(changes: number | bigint) {
    if (Number(changes) !== 1) throw new Error('Investigation order storage failed.');
  }
  function original(order: Order): Investigation {
    return { ...order, results: [], reviews: [] };
  }
  function create(req: AuthRequest, fields: InvestigationOrderFields, clinician: Clinician): Order {
    const order: Order = {
      ...fields,
      ...clinician,
      id: id(),
      createdAt: nowISO(),
      status: 'ordered',
      cancellationReason: null,
    };
    insert(db, 'investigations', order);
    requireWrite(Number(db.prepare('SELECT changes() AS n').get()!.n));
    audit(req, 'ordered investigation', 'investigation', order.id);
    requireWrite(Number(db.prepare('SELECT changes() AS n').get()!.n));
    const delivered = notifyPatient(db, order.patientId, 'investigation-ordered:' + order.id, {
      kind: 'investigation',
      title: 'Your clinician requested an investigation',
      detail: order.title,
      href: '/my-care/record?tab=workflows',
    });
    if (!delivered) throw new Error('Investigation order notice storage failed.');
    return order;
  }
  app.post('/api/investigations', (req: AuthRequest, res) => {
    const result = transaction(() => {
      const { clinician } = authorize(req);
      const fields = legacy.parse(req.body);
      patientAccess(req, fields.patientId);
      if (fields.dueDate && fields.dueDate < clinicToday()) return fail(400, pastDue);
      return original(create(req, fields, clinician));
    });
    res.status(201).json(result);
  });
  app.post('/api/investigations/order', (req: AuthRequest, res) => {
    const result = transaction(() => {
      const { actorId, role, clinician } = authorize(req);
      noQuery.parse(req.query);
      const command = reviewed.parse(req.body);
      const {
        requestId,
        doctorId,
        orderedByRole,
        reviewedConfirmed: _confirmed,
        ...fields
      } = command;
      if (role !== orderedByRole || clinician.doctorId !== doctorId)
        return fail(
          403,
          'The reviewed ordering clinician must match the current account and role.',
        );
      patientAccess(req, fields.patientId);
      const hash = createHash('sha256').update(JSON.stringify(command)).digest('hex');
      const prior = db
        .prepare(
          'SELECT c.actorId,c.patientId,c.commandHash,c.refusal,i.data AS originalOrder FROM investigationOrderCommands c LEFT JOIN investigations i ON i.id=c.investigationId WHERE c.requestId=?',
        )
        .get(requestId);
      const success = (order: Order): InvestigationOrderResponse => ({
        receipt: { requestId, actorId, orderedByRole, order: original(order) },
      });
      const refused = (message: string): InvestigationNotOrdered => ({
        code: 'INVESTIGATION_NOT_ORDERED',
        actorId,
        command,
        message,
      });
      if (prior) {
        if (
          prior.actorId !== actorId ||
          prior.patientId !== fields.patientId ||
          prior.commandHash !== hash
        )
          return fail(409, 'This request ID was already used for another investigation order.');
        if (typeof prior.refusal === 'string') return { status: 409, body: refused(prior.refusal) };
        return { status: 200, body: success(JSON.parse(String(prior.originalOrder)) as Order) };
      }
      const store = db.prepare(
        'INSERT INTO investigationOrderCommands(requestId,actorId,patientId,commandHash,investigationId,refusal) VALUES (?,?,?,?,?,?)',
      );
      // A previously saved order can always recover, even after its due date.
      if (fields.dueDate && fields.dueDate < clinicToday()) {
        requireWrite(store.run(requestId, actorId, fields.patientId, hash, null, pastDue).changes);
        return { status: 409, body: refused(pastDue) };
      }
      const order = create(req, fields, clinician);
      requireWrite(store.run(requestId, actorId, fields.patientId, hash, order.id, null).changes);
      return { status: 201, body: success(order) };
    });
    res.status(result.status).json(result.body);
  });
}
