import { createHash } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import type { ProcedureCompletion, ProcedureRecord } from '../shared/clinical.ts';
import type {
  ProcedureCompletionCommand,
  ProcedureCompletionContext,
  ProcedureCompletionNotRecorded,
  ProcedureCompletionResponse,
} from '../shared/procedure-completion.ts';
import type { User } from '../shared/types.ts';
import type { AuthRequest } from './app.ts';
import { notifyPatient } from './activity.ts';
import { type DB, nowISO } from './db.ts';

type Source = Pick<ProcedureCompletionContext, 'procedure' | 'doctorId' | 'doctorName'> & {
  user: User;
};
interface Dependencies {
  db: DB;
  transaction: <T>(work: () => T) => T;
  authorize: (req: AuthRequest) => Source;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
}
const identifier = z.string().trim().min(1).max(300);
const narrative = z.string().trim().min(1).max(8000);
const fields = z.object({ outcome: narrative, aftercare: narrative });
const reviewed = fields
  .extend({
    requestId: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
    patientId: identifier,
    procedureId: identifier,
    doctorId: identifier,
    recordedByRole: z.enum(['doctor', 'admin']),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
    expectedDecisionId: identifier,
    reviewedConfirmed: z.literal(true),
  })
  .strict();
const noQuery = z.object({}).strict();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function blockedReason(procedure: ProcedureRecord): string | null {
  if (procedure.status !== 'planned')
    return 'This procedure is already completed or cancelled. Its documentation cannot be changed.';
  if (procedure.agreements.at(-1)?.decision !== 'agreed')
    return 'Record the patient agreement before completing this procedure. The latest recorded decision must be agreed.';
  if (!procedure.effectiveAppointmentId) return null;
  const appointment = procedure.scheduledAppointment;
  if (!appointment)
    return 'The linked appointment is missing. Review the procedure appointment association.';
  if (['cancelled', 'no-show'].includes(appointment.status))
    return 'The linked appointment is cancelled or marked as a no-show. Update the procedure appointment association.';
  const start = Date.parse(`${appointment.date}T${appointment.time}:00+05:30`);
  if (!Number.isFinite(start))
    return 'The linked visit start could not be verified. Review the procedure appointment association.';
  if (start > Date.now())
    return 'The linked appointment is in the future. Complete the procedure after the visit starts.';
  return null;
}

export function registerProcedureCompletion(
  app: Express,
  { db, transaction, authorize, audit, fail }: Dependencies,
) {
  db.exec(`CREATE TABLE IF NOT EXISTS procedureCompletionCommands (
    requestId TEXT PRIMARY KEY, actorId TEXT NOT NULL REFERENCES users(id),
    procedureId TEXT NOT NULL REFERENCES procedures(id), commandHash TEXT NOT NULL,
    completionId TEXT UNIQUE REFERENCES procedureCompletions(id), rejection TEXT,
    CHECK ((completionId IS NOT NULL AND completionId=procedureId AND rejection IS NULL)
        OR (completionId IS NULL AND rejection IS NOT NULL))
  );
  CREATE TRIGGER IF NOT EXISTS immutable_procedureCompletionCommands_update BEFORE UPDATE ON procedureCompletionCommands
    BEGIN SELECT RAISE(ABORT,'Procedure completion commands are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_procedureCompletionCommands_delete BEFORE DELETE ON procedureCompletionCommands
    BEGIN SELECT RAISE(ABORT,'Procedure completion commands are append-only'); END;`);

  function projection({ procedure, doctorId, doctorName }: Source): ProcedureCompletionContext {
    // The link can be removed and restored to the same visit between two reads.
    const link = db
      .prepare(
        'SELECT id FROM procedureScheduleEvents WHERE procedureId=? ORDER BY rowid DESC LIMIT 1',
      )
      .get(procedure.id);
    const reason = blockedReason(procedure);
    return {
      procedure,
      doctorId,
      doctorName,
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
        reason,
      ]),
      allowed: reason === null,
      blockedReason: reason,
    };
  }

  function complete(
    req: AuthRequest,
    { procedure, doctorId, doctorName }: Source,
    { outcome, aftercare }: z.infer<typeof fields>,
  ): ProcedureCompletion {
    const completion = {
      outcome,
      aftercare,
      doctorId,
      doctorName,
      completedAt: nowISO(),
      appointment: procedure.scheduledAppointment ?? null,
    };
    db.prepare('INSERT INTO procedureCompletions(id,data) VALUES (?,?)').run(
      procedure.id,
      JSON.stringify(completion),
    );
    audit(req, 'completed procedure and recorded aftercare', 'procedure', procedure.id);
    notifyPatient(db, procedure.patientId, `procedure-completed:${procedure.id}`, {
      kind: 'procedure',
      title: 'Your procedure aftercare is available',
      detail: procedure.title,
      href: '/my-care/record?tab=workflows',
    });
    return completion;
  }
  app.post('/api/procedures/:id/complete', (req: AuthRequest, res) => {
    const record = transaction(() => {
      const source = authorize(req);
      const input = fields.parse(req.body);
      const reason = blockedReason(source.procedure);
      if (reason) return fail(409, reason);
      const completion = complete(req, source, input);
      return { ...source.procedure, status: 'completed', completion };
    });
    res.json(record);
  });
  app.get('/api/procedures/:id/completion-context', (req: AuthRequest, res) => {
    const record = transaction(() => {
      const source = authorize(req);
      noQuery.parse(req.query);
      const result = projection(source);
      audit(req, 'viewed procedure completion context', 'procedure', source.procedure.id);
      return result;
    });
    res.json(record);
  });
  app.post('/api/procedures/:id/completions', (req: AuthRequest, res) => {
    const result = transaction(() => {
      const source = authorize(req);
      const { user, procedure } = source;
      noQuery.parse(req.query);
      const command: ProcedureCompletionCommand = reviewed.parse(req.body);
      const { requestId, patientId, procedureId, expectedRevision, expectedDecisionId } = command;
      if (command.recordedByRole !== user.role || command.doctorId !== source.doctorId)
        return fail(403, 'The reviewed clinician and role must match the current account.');
      if (procedureId !== procedure.id || patientId !== procedure.patientId)
        return fail(409, 'The reviewed patient and procedure must match this record.');
      const commandHash = hash(command);
      const success = (completion: ProcedureCompletion): ProcedureCompletionResponse => ({
        receipt: {
          requestId,
          actorId: user.id,
          patientId,
          procedureId,
          expectedRevision,
          decisionId: expectedDecisionId,
          completion,
        },
      });
      type Refusal = Pick<ProcedureCompletionNotRecorded, 'message' | 'observed'>;
      const rejected = (refusal: Refusal): ProcedureCompletionNotRecorded => ({
        code: 'PROCEDURE_COMPLETION_NOT_RECORDED',
        actorId: user.id,
        command,
        ...refusal,
      });
      const prior = db
        .prepare('SELECT * FROM procedureCompletionCommands WHERE requestId=?')
        .get(requestId);
      if (prior) {
        if (
          prior.actorId !== user.id ||
          prior.procedureId !== procedureId ||
          prior.commandHash !== commandHash
        )
          return fail(409, 'This request ID was already used for another procedure completion.');
        if (typeof prior.rejection === 'string')
          return { status: 409, body: rejected(JSON.parse(prior.rejection) as Refusal) };
        if (!procedure.completion) throw new Error('Stored procedure completion is missing.');
        return { status: 200, body: success(procedure.completion) };
      }
      const current = projection(source);
      const denial =
        current.blockedReason ??
        (current.revision !== expectedRevision ||
        procedure.agreements.at(-1)?.id !== expectedDecisionId
          ? 'The procedure decision, visit or clinician details changed. Review the procedure again before recording completion.'
          : null);
      const store = db.prepare(
        'INSERT INTO procedureCompletionCommands(requestId,actorId,procedureId,commandHash,completionId,rejection) VALUES (?,?,?,?,?,?)',
      );
      if (denial) {
        const refusal: Refusal = {
          message: denial,
          observed: {
            decisionId: procedure.agreements.at(-1)?.id ?? null,
            status: procedure.status,
          },
        };
        store.run(requestId, user.id, procedureId, commandHash, null, JSON.stringify(refusal));
        return { status: 409, body: rejected(refusal) };
      }
      const completion = complete(req, source, command);
      store.run(requestId, user.id, procedureId, commandHash, procedureId, null);
      return { status: 201, body: success(completion) };
    });
    res.status(result.status).json(result.body);
  });
}
