import { createHash } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import {
  procedureCancellationCommand,
  procedureCancellationReason,
  type ProcedureCancellationContext,
  type ProcedureCancellationReceipt,
  type ProcedureCancellationResponse,
  type ProcedureNotCancelled,
} from '../shared/procedure-cancellation.ts';
import type { User } from '../shared/types.ts';
import type { AuthRequest } from './app.ts';
import { notifyPatient } from './activity.ts';
import { nowISO, type DB } from './db.ts';

type Source = Pick<ProcedureCancellationContext, 'procedure' | 'doctorId' | 'doctorName'> & {
  user: User;
};
type StoredCancellation = Pick<
  ProcedureCancellationReceipt,
  'reason' | 'doctorId' | 'doctorName' | 'appointment'
> & { createdAt: string };
interface Dependencies {
  db: DB;
  transaction: <T>(work: () => T) => T;
  authorize: (req: AuthRequest) => Source;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
}
export const closedProcedure =
  'This procedure is already completed or cancelled. Its documentation cannot be changed.';
const legacy = z.object({ reason: procedureCancellationReason });
const noQuery = z.strictObject({});
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function requireWrite(changes: number | bigint) {
  if (Number(changes) !== 1) throw new Error('Procedure cancellation could not be recorded.');
}
export function registerProcedureCancellation(
  app: Express,
  { db, transaction, authorize, audit, fail }: Dependencies,
) {
  db.exec(`CREATE TABLE IF NOT EXISTS procedureCancellationCommands (
    requestId TEXT PRIMARY KEY, actorId TEXT NOT NULL REFERENCES users(id),
    procedureId TEXT NOT NULL REFERENCES procedures(id), commandHash TEXT NOT NULL,
    cancellationId TEXT UNIQUE REFERENCES procedureCancellations(id), refusal TEXT,
    CHECK ((cancellationId IS NOT NULL AND cancellationId=procedureId AND refusal IS NULL)
        OR (cancellationId IS NULL AND refusal IS NOT NULL))
  );
  CREATE TRIGGER IF NOT EXISTS procedureCancellationCommands_no_update BEFORE UPDATE ON procedureCancellationCommands
    BEGIN SELECT RAISE(ABORT,'Procedure cancellation evidence is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS procedureCancellationCommands_no_delete BEFORE DELETE ON procedureCancellationCommands
    BEGIN SELECT RAISE(ABORT,'Procedure cancellation evidence is immutable'); END;`);
  function context({ procedure, doctorId, doctorName }: Source): ProcedureCancellationContext {
    const link = db
      .prepare(
        'SELECT id FROM procedureScheduleEvents WHERE procedureId=? ORDER BY rowid DESC LIMIT 1',
      )
      .get(procedure.id);
    const allowed = procedure.status === 'planned';
    return {
      procedure,
      doctorId,
      doctorName,
      allowed,
      blockedReason: allowed ? null : closedProcedure,
      // Including the link event detects a visit that was unlinked and then restored.
      revision: hash([
        procedure.id,
        procedure.patientId,
        doctorId,
        doctorName,
        procedure.status,
        procedure.agreements.at(-1)?.id ?? null,
        link?.id ?? null,
        procedure.effectiveAppointmentId,
        procedure.scheduledAppointment,
      ]),
    };
  }
  function audited(req: AuthRequest, action: string, procedureId: string) {
    audit(req, action, 'procedure', procedureId);
    requireWrite(Number(db.prepare('SELECT changes() AS n').get()!.n));
  }
  function cancel(
    req: AuthRequest,
    { procedure, doctorId, doctorName }: Source,
    reason: string,
  ): StoredCancellation {
    const entry = {
      reason,
      createdAt: nowISO(),
      doctorId,
      doctorName,
      appointment: procedure.scheduledAppointment ?? null,
    };
    requireWrite(
      db
        .prepare('INSERT INTO procedureCancellations(id,data) VALUES (?,?)')
        .run(procedure.id, JSON.stringify(entry)).changes,
    );
    audited(req, 'cancelled procedure', procedure.id);
    if (
      !notifyPatient(db, procedure.patientId, 'procedure-cancelled:' + procedure.id, {
        kind: 'procedure',
        title: 'A procedure plan was cancelled',
        detail: procedure.title,
        href: '/my-care/record?tab=workflows',
      })
    )
      throw new Error('Procedure cancellation notice could not be recorded.');
    return entry;
  }
  app.get('/api/procedures/:id/cancellation-context', (req: AuthRequest, res) => {
    const result = transaction(() => {
      const source = authorize(req);
      noQuery.parse(req.query);
      audited(req, 'viewed procedure cancellation context', source.procedure.id);
      return context(source);
    });
    res.json(result);
  });
  app.post('/api/procedures/:id/cancel', (req: AuthRequest, res) => {
    const result = transaction(() => {
      const source = authorize(req);
      const { reason } = legacy.parse(req.body);
      if (source.procedure.status !== 'planned') return fail(409, closedProcedure);
      cancel(req, source, reason);
      return { ...source.procedure, status: 'cancelled', cancellationReason: reason };
    });
    res.json(result);
  });
  app.post('/api/procedures/:id/cancellation', (req: AuthRequest, res) => {
    const result = transaction(() => {
      const source = authorize(req);
      noQuery.parse(req.query);
      const command = procedureCancellationCommand.parse(req.body);
      const { procedure, user } = source;
      const {
        requestId,
        patientId,
        procedureId,
        doctorId,
        cancelledByRole,
        expectedRevision,
        expectedDecisionId,
      } = command;
      if (doctorId !== source.doctorId || cancelledByRole !== user.role)
        return fail(403, 'The reviewed clinician and role must match the current account.');
      if (procedureId !== procedure.id || patientId !== procedure.patientId)
        return fail(409, 'The reviewed patient and procedure must match this record.');
      const digest = hash(command);
      const refused = (message: string): ProcedureNotCancelled => ({
        code: 'PROCEDURE_NOT_CANCELLED',
        actorId: user.id,
        command,
        message,
      });
      const success = (entry: StoredCancellation): ProcedureCancellationResponse => ({
        receipt: {
          requestId,
          actorId: user.id,
          patientId,
          procedureId,
          doctorId: entry.doctorId,
          doctorName: entry.doctorName,
          cancelledByRole,
          expectedRevision,
          expectedDecisionId,
          reason: entry.reason,
          title: procedure.title,
          appointment: entry.appointment,
          cancelledAt: entry.createdAt,
        },
      });
      const prior = db
        .prepare(
          'SELECT c.actorId,c.procedureId,c.commandHash,c.refusal,x.data FROM procedureCancellationCommands c LEFT JOIN procedureCancellations x ON x.id=c.cancellationId WHERE c.requestId=?',
        )
        .get(requestId);
      if (prior) {
        if (
          prior.actorId !== user.id ||
          prior.procedureId !== procedureId ||
          prior.commandHash !== digest
        )
          return fail(409, 'This request ID was already used for another procedure cancellation.');
        if (typeof prior.refusal === 'string') return { status: 409, body: refused(prior.refusal) };
        return { status: 200, body: success(JSON.parse(String(prior.data)) as StoredCancellation) };
      }
      const current = context(source);
      const denial =
        current.blockedReason ??
        (current.revision !== expectedRevision ||
        (procedure.agreements.at(-1)?.id ?? null) !== expectedDecisionId
          ? 'The procedure decision, visit or clinician details changed. Review the current procedure before cancelling it.'
          : null);
      const store = db.prepare(
        'INSERT INTO procedureCancellationCommands(requestId,actorId,procedureId,commandHash,cancellationId,refusal) VALUES (?,?,?,?,?,?)',
      );
      if (denial) {
        requireWrite(store.run(requestId, user.id, procedureId, digest, null, denial).changes);
        return { status: 409, body: refused(denial) };
      }
      const entry = cancel(req, source, command.reason);
      requireWrite(store.run(requestId, user.id, procedureId, digest, procedureId, null).changes);
      return { status: 201, body: success(entry) };
    });
    res.status(result.status).json(result.body);
  });
}
