import { createHash } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import type {
  CareMessageCommand,
  CareMessageNotSent,
  CareMessageResult,
} from '../shared/care-message.ts';
import type { Message, User } from '../shared/types.ts';
import { notifyClinicians, notifyPatient } from './activity.ts';
import type { AuthRequest } from './app.ts';
import { get, id, insert, list, nowISO, settings, type DB } from './db.ts';

interface Dependencies {
  db: DB;
  authorizePatientRecord: (
    req: AuthRequest,
    patientId?: string,
  ) => { user: User; patientId: string };
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
}

const patientId = z.string().trim().min(1).max(300);
const fields = z.object({
  patientId: patientId.optional(),
  body: z.string().trim().min(1).max(4000),
});
const commandSchema = fields
  .extend({
    patientId,
    requestId: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase()),
  })
  .strict();
const emptyQuery = z.object({}).strict();
const paused = 'This module is currently disabled by the clinic.';

export function registerCareMessages(
  app: Express,
  { db, authorizePatientRecord, audit, fail }: Dependencies,
) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS careMessageCommands (
      requestId TEXT PRIMARY KEY, actorId TEXT NOT NULL REFERENCES users(id),
      patientId TEXT NOT NULL REFERENCES patients(id), bodyHash TEXT NOT NULL,
      messageId TEXT UNIQUE REFERENCES messages(id), rejection TEXT,
      CHECK ((messageId IS NULL) <> (rejection IS NULL))
    );
  `);
  for (const table of ['messages', 'careMessageCommands'])
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS ${table}_immutable_update BEFORE UPDATE ON ${table}
        BEGIN SELECT RAISE(ABORT,'Care message records are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS ${table}_immutable_delete BEFORE DELETE ON ${table}
        BEGIN SELECT RAISE(ABORT,'Care message records are immutable'); END;
    `);

  function transaction<T>(mode: 'read' | 'write', work: () => T): T {
    db.exec(mode === 'read' ? 'BEGIN' : 'BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function send(req: AuthRequest, user: User, patientId: string, body: string): Message {
    const message: Message = {
      id: id(),
      patientId,
      body,
      authorName: user.name,
      authorRole: user.role,
      createdAt: nowISO(),
    };
    insert(db, 'messages', message);
    audit(req, 'sent care message', 'message', message.id);
    if (user.role === 'patient')
      notifyClinicians(
        db,
        patientId,
        `message:${message.id}`,
        {
          kind: 'message',
          title: 'A patient sent a message',
          detail: user.name,
          href: `/clinic/patients/${patientId}?tab=messages`,
        },
        { excludeActorId: user.id },
      );
    else
      notifyPatient(db, patientId, `message:${message.id}`, {
        kind: 'message',
        title: 'Your clinic sent a message',
        detail: 'Open your private conversation to read it.',
        href: '/my-care/messages',
      });
    return message;
  }

  function execute(
    req: AuthRequest,
    command: CareMessageCommand,
  ): {
    status: number;
    body: CareMessageResult | CareMessageNotSent;
  } {
    const { requestId, body } = command;
    const { user, patientId } = authorizePatientRecord(req, command.patientId);
    const actorId = user.id;
    const bodyHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const stored = db.prepare('SELECT * FROM careMessageCommands WHERE requestId=?').get(requestId);
    const success = (message: Message): CareMessageResult => ({
      receipt: {
        requestId,
        actorId,
        actorName: message.authorName,
        actorRole: message.authorRole,
        patientId,
        message,
      },
    });
    const rejection = (reason: string): CareMessageNotSent => ({
      code: 'MESSAGE_NOT_SENT',
      requestId,
      actorId,
      patientId,
      body,
      message: reason,
    });
    if (stored) {
      if (
        stored.actorId !== actorId ||
        stored.patientId !== patientId ||
        stored.bodyHash !== bodyHash
      )
        return fail(409, 'This request ID was already used for a different care message.');
      if (typeof stored.rejection === 'string')
        return { status: 403, body: rejection(stored.rejection) };
      const message = get<Message>(db, 'messages', String(stored.messageId));
      if (!message) throw new Error('Missing original care message.');
      return { status: 200, body: success(message) };
    }
    const saveCommand = db.prepare(
      'INSERT INTO careMessageCommands(requestId,actorId,patientId,bodyHash,messageId,rejection) VALUES (?,?,?,?,?,?)',
    );
    if (!settings(db).modules.followUp) {
      saveCommand.run(requestId, actorId, patientId, bodyHash, null, paused);
      return { status: 403, body: rejection(paused) };
    }
    const message = send(req, user, patientId, body);
    saveCommand.run(requestId, actorId, patientId, bodyHash, message.id, null);
    return { status: 201, body: success(message) };
  }

  app.get('/api/messages', (req: AuthRequest, res) => {
    const query = z.object({ patientId: patientId.optional() }).parse(req.query);
    res.json(
      transaction('read', () => {
        const scope = authorizePatientRecord(req, query.patientId);
        return list<Message>(db, 'messages', scope.patientId).reverse();
      }),
    );
  });
  app.post('/api/messages/send', (req: AuthRequest, res) => {
    emptyQuery.parse(req.query);
    const command = commandSchema.parse(req.body);
    const result = transaction('write', () => execute(req, command));
    res.status(result.status).json(result.body);
  });
  app.post('/api/messages', (req: AuthRequest, res) => {
    const message = transaction('write', () => {
      if (!settings(db).modules.followUp) return fail(403, paused);
      const input = fields.parse(req.body);
      const { user, patientId } = authorizePatientRecord(req, input.patientId);
      return send(req, user, patientId, input.body);
    });
    res.status(201).json(message);
  });
}
