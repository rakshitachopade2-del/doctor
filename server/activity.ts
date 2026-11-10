import type { Express } from 'express';
import { z } from 'zod';
import type { AuthRequest } from './app.ts';
import { id, nowISO, type DB } from './db.ts';
import type { User } from '../shared/types.ts';
import type { ActivityContent, ActivityItem } from '../shared/activity.ts';

export function initializeActivity(db: DB) {
  db.exec(`CREATE TABLE IF NOT EXISTS activity (
    id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id),
    patientId TEXT NOT NULL REFERENCES patients(id), audience TEXT NOT NULL,
    eventKey TEXT NOT NULL, data TEXT NOT NULL, readAt TEXT,
    UNIQUE(userId,eventKey)
  );
  CREATE INDEX IF NOT EXISTS activity_recipient ON activity(userId,readAt);
  CREATE TRIGGER IF NOT EXISTS activity_content_immutable BEFORE UPDATE OF id,userId,patientId,audience,eventKey,data ON activity
    BEGIN SELECT RAISE(ABORT,'Activity contents are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS activity_delete_immutable BEFORE DELETE ON activity
    BEGIN SELECT RAISE(ABORT,'Activity contents are immutable'); END;`);
}

function notify(
  db: DB,
  user: User,
  patientId: string,
  audience: 'patient' | 'clinical',
  eventKey: string,
  input: ActivityContent,
) {
  const value: ActivityItem = { ...input, id: id(), createdAt: nowISO(), readAt: null };
  db.prepare(
    'INSERT OR IGNORE INTO activity(id,userId,patientId,audience,eventKey,data) VALUES (?,?,?,?,?,?)',
  ).run(value.id, user.id, patientId, audience, eventKey, JSON.stringify(value));
}
function activeUsers(db: DB) {
  return db
    .prepare('SELECT data FROM users')
    .all()
    .map((row) => JSON.parse(row.data as string) as User)
    .filter((user) => user.active !== false);
}
export function notifyPatient(
  db: DB,
  patientId: string,
  eventKey: string,
  input: ActivityContent,
  excludeActorId?: string,
) {
  for (const user of activeUsers(db))
    if (user.role === 'patient' && user.patientId === patientId && user.id !== excludeActorId)
      notify(db, user, patientId, 'patient', eventKey, input);
}
export function notifyClinicians(
  db: DB,
  patientId: string,
  eventKey: string,
  input: ActivityContent,
  options: { doctorId?: string; excludeActorId?: string } = {},
) {
  const clinicians = activeUsers(db).filter(
    (user) => ['doctor', 'admin'].includes(user.role) && user.doctorId,
  );
  const owner = options.doctorId
    ? clinicians.filter((user) => user.doctorId === options.doctorId)
    : clinicians;
  for (const user of owner.length ? owner : clinicians)
    if (user.id !== options.excludeActorId)
      notify(db, user, patientId, 'clinical', eventKey, input);
}

interface ActivityContext {
  db: DB;
  actor: (req: AuthRequest, roles?: User['role'][]) => User;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
}
export function registerActivity(app: Express, { db, actor, audit, fail }: ActivityContext) {
  function transaction<T>(work: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  function scope(req: AuthRequest) {
    const user = actor(req);
    if (user.role === 'patient')
      return {
        sql: "userId=? AND audience='patient' AND patientId=?",
        params: [user.id, user.patientId || ''],
      };
    if (user.role === 'doctor' || user.role === 'admin')
      return { sql: "userId=? AND audience='clinical'", params: [user.id] };
    return { sql: 'userId=? AND 0', params: [user.id] };
  }
  app.get('/api/activity', (req: AuthRequest, res) => {
    const access = scope(req);
    const input = z
      .object({
        unread: z.enum(['true', 'false']).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(30),
        cursor: z.string().uuid().optional(),
      })
      .parse(req.query);
    let cursorRow: number | undefined;
    if (input.cursor) {
      const row = db
        .prepare(`SELECT rowid FROM activity WHERE ${access.sql} AND id=?`)
        .get(...access.params, input.cursor);
      if (!row) return fail(400, 'This activity page is no longer available. Refresh the inbox.');
      cursorRow = Number(row.rowid);
    }
    const rows = db
      .prepare(
        `SELECT data,readAt,id FROM activity WHERE ${access.sql}${input.unread === 'true' ? ' AND readAt IS NULL' : ''}${cursorRow === undefined ? '' : ' AND rowid<?'} ORDER BY rowid DESC LIMIT ?`,
      )
      .all(...access.params, ...(cursorRow === undefined ? [] : [cursorRow]), input.limit + 1);
    const hasMore = rows.length > input.limit;
    const visible = rows.slice(0, input.limit);
    const unreadCount = Number(
      db
        .prepare(`SELECT count(*) AS count FROM activity WHERE ${access.sql} AND readAt IS NULL`)
        .get(...access.params)!.count,
    );
    res.json({
      items: visible.map((row) => ({
        ...JSON.parse(row.data as string),
        readAt: row.readAt ?? null,
      })),
      unreadCount,
      nextCursor: hasMore ? visible.at(-1)!.id : null,
    });
  });
  app.post('/api/activity/read-all', (req: AuthRequest, res) => {
    const access = scope(req);
    // Only mark the snapshot explicitly shown to the user. New arrivals stay unread.
    const input = z.object({ throughId: z.string().uuid() }).strict().parse(req.body);
    const row = db
      .prepare(`SELECT rowid FROM activity WHERE ${access.sql} AND id=?`)
      .get(...access.params, input.throughId);
    if (!row) return fail(404, 'Activity item not found.');
    const updated = transaction(() => {
      const result = db
        .prepare(`UPDATE activity SET readAt=? WHERE ${access.sql} AND readAt IS NULL AND rowid<=?`)
        .run(nowISO(), ...access.params, Number(row.rowid));
      audit(req, 'marked activity snapshot read', 'user', req.user!.id);
      return result;
    });
    res.json({ markedRead: Number(updated.changes) });
  });
  app.post('/api/activity/:id/read', (req: AuthRequest, res) => {
    const access = scope(req);
    const key = String(req.params.id);
    const row = db
      .prepare(`SELECT data,readAt FROM activity WHERE ${access.sql} AND id=?`)
      .get(...access.params, key);
    if (!row) return fail(404, 'Activity item not found.');
    const readAt = (row.readAt as string | null) || nowISO();
    if (!row.readAt) {
      transaction(() => {
        db.prepare('UPDATE activity SET readAt=? WHERE id=?').run(readAt, key);
        audit(req, 'marked activity item read', 'activity', key);
      });
    }
    res.json({ ...JSON.parse(row.data as string), readAt });
  });
}
