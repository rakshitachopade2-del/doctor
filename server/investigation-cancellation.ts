import { createHash } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import type { Investigation } from '../shared/clinical.ts';
import {
  investigationCancellationCommand,
  investigationCancellationReason,
  type InvestigationCancellationResponse,
  type InvestigationNotCancelled,
} from '../shared/investigation-cancellation.ts';
import type { AuthRequest } from './app.ts';
import { notifyPatient } from './activity.ts';
import { nowISO, type DB } from './db.ts';

type Order = Omit<Investigation, 'results' | 'reviews'>;
type Clinician = Pick<Order, 'doctorId' | 'doctorName'>;
type Cancellation = Clinician & { reason: string; createdAt: string };
interface Dependencies {
  db: DB;
  transaction: <T>(work: () => T) => T;
  authorize: (req: AuthRequest) => { actorId: string; role: string; clinician: Clinician };
  investigationAccess: (req: AuthRequest, investigationId: string) => Order;
  view: (order: Order) => Investigation;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
}

const legacy = z.object({ reason: investigationCancellationReason });
const noQuery = z.strictObject({});
export const cancelledInvestigation =
  'This investigation is cancelled. Create a new order if further testing is needed.';
function blocked(order: Investigation) {
  if (order.status === 'cancelled') return cancelledInvestigation;
  if (order.status === 'reviewed')
    return 'A reviewed investigation is already documented. Create a new order for further testing.';
  return null;
}
function requireWrite(changes: number | bigint) {
  if (Number(changes) !== 1) throw new Error('Investigation cancellation could not be saved.');
}
export function registerInvestigationCancellations(
  app: Express,
  { db, transaction, authorize, investigationAccess, view, audit, fail }: Dependencies,
) {
  db.exec(`CREATE TABLE IF NOT EXISTS investigationCancellationCommands (
    requestId TEXT PRIMARY KEY, actorId TEXT NOT NULL REFERENCES users(id),
    investigationId TEXT NOT NULL REFERENCES investigations(id), commandHash TEXT NOT NULL,
    cancellationId TEXT UNIQUE REFERENCES investigationCancellations(id), refusal TEXT,
    CHECK ((cancellationId IS NOT NULL AND cancellationId=investigationId AND refusal IS NULL)
        OR (cancellationId IS NULL AND refusal IS NOT NULL))
  );
  CREATE TRIGGER IF NOT EXISTS investigationCancellationCommands_no_update BEFORE UPDATE ON investigationCancellationCommands
    BEGIN SELECT RAISE(ABORT,'Investigation cancellation evidence is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS investigationCancellationCommands_no_delete BEFORE DELETE ON investigationCancellationCommands
    BEGIN SELECT RAISE(ABORT,'Investigation cancellation evidence is immutable'); END;`);

  function cancel(
    req: AuthRequest,
    order: Order,
    clinician: Clinician,
    reason: string,
  ): Cancellation {
    const entry = { reason, createdAt: nowISO(), ...clinician };
    requireWrite(
      db
        .prepare('INSERT INTO investigationCancellations(id,data) VALUES (?,?)')
        .run(order.id, JSON.stringify(entry)).changes,
    );
    audit(req, 'cancelled investigation', 'investigation', order.id);
    requireWrite(Number(db.prepare('SELECT changes() AS n').get()!.n));
    if (
      !notifyPatient(db, order.patientId, 'investigation-cancelled:' + order.id, {
        kind: 'investigation',
        title: 'An investigation request was cancelled',
        detail: order.title,
        href: '/my-care/record?tab=workflows',
      })
    )
      throw new Error('Investigation cancellation notice could not be saved.');
    return entry;
  }
  app.post('/api/investigations/:id/cancel', (req: AuthRequest, res) => {
    const result = transaction(() => {
      const { clinician } = authorize(req);
      const order = investigationAccess(req, String(req.params.id));
      const { reason } = legacy.parse(req.body);
      const current = view(order);
      const denial = blocked(current);
      if (denial) return fail(409, denial);
      cancel(req, order, clinician, reason);
      return { ...current, status: 'cancelled', cancellationReason: reason };
    });
    res.json(result);
  });
  app.post('/api/investigations/:id/cancellation', (req: AuthRequest, res) => {
    const result = transaction(() => {
      const { actorId, role, clinician } = authorize(req);
      const order = investigationAccess(req, String(req.params.id));
      noQuery.parse(req.query);
      const command = investigationCancellationCommand.parse(req.body);
      const {
        requestId,
        investigationId,
        patientId,
        doctorId,
        cancelledByRole,
        expectedLatestResultId,
      } = command;
      if (role !== cancelledByRole || clinician.doctorId !== doctorId)
        return fail(403, 'The reviewed clinician and role must match the current account.');
      if (order.id !== investigationId || order.patientId !== patientId)
        return fail(409, 'The reviewed patient and investigation must match this order.');
      const commandHash = createHash('sha256').update(JSON.stringify(command)).digest('hex');
      const accepted = (entry: Cancellation): InvestigationCancellationResponse => ({
        receipt: {
          requestId,
          actorId,
          investigationId,
          patientId,
          doctorId: entry.doctorId,
          doctorName: entry.doctorName,
          cancelledByRole,
          expectedLatestResultId,
          reason: entry.reason,
          title: order.title,
          cancelledAt: entry.createdAt,
        },
      });
      const refused = (message: string): InvestigationNotCancelled => ({
        code: 'INVESTIGATION_NOT_CANCELLED',
        actorId,
        command,
        message,
      });
      const prior = db
        .prepare(
          'SELECT c.actorId,c.investigationId,c.commandHash,c.refusal,x.data FROM investigationCancellationCommands c LEFT JOIN investigationCancellations x ON x.id=c.cancellationId WHERE c.requestId=?',
        )
        .get(requestId);
      if (prior) {
        if (
          prior.actorId !== actorId ||
          prior.investigationId !== investigationId ||
          prior.commandHash !== commandHash
        )
          return fail(
            409,
            'This request ID was already used for another investigation cancellation.',
          );
        if (typeof prior.refusal === 'string') return { status: 409, body: refused(prior.refusal) };
        return { status: 200, body: accepted(JSON.parse(String(prior.data)) as Cancellation) };
      }
      const current = view(order);
      const denial =
        blocked(current) ??
        ((current.results.at(-1)?.id ?? null) !== expectedLatestResultId
          ? 'The latest result changed. Review the current investigation before cancelling it.'
          : null);
      const store = db.prepare(
        'INSERT INTO investigationCancellationCommands(requestId,actorId,investigationId,commandHash,cancellationId,refusal) VALUES (?,?,?,?,?,?)',
      );
      if (denial) {
        requireWrite(
          store.run(requestId, actorId, investigationId, commandHash, null, denial).changes,
        );
        return { status: 409, body: refused(denial) };
      }
      const entry = cancel(req, order, clinician, command.reason);
      requireWrite(
        store.run(requestId, actorId, investigationId, commandHash, investigationId, null).changes,
      );
      return { status: 201, body: accepted(entry) };
    });
    res.status(result.status).json(result.body);
  });
}
