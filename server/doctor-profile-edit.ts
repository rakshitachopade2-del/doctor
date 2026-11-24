import { createHash } from 'node:crypto';
import type { Express } from 'express';
import { z } from 'zod';
import { doctorProfileFields } from '../shared/doctor-profile-creation.ts';
import type {
  DoctorProfileSnapshot,
  DoctorProfileEditChange,
  DoctorProfileEditContext,
  DoctorProfileEditCommand,
  DoctorProfileEditHistory,
  DoctorProfileEditRefusal,
  DoctorProfileEditResponse,
} from '../shared/doctor-profile-edit.ts';
import type { User } from '../shared/types.ts';
import type { AuthRequest } from './app.ts';
import { get, id, nowISO, type DB } from './db.ts';

interface Dependencies {
  db: DB;
  currentSessionUser: (req: AuthRequest) => User;
  transaction: <T>(work: () => T) => T;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
}

const commandSchema = z.strictObject({
  profile: doctorProfileFields
    .extend({ color: doctorProfileFields.shape.color.removeDefault() })
    .strict(),
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  requestId: z.uuid().transform((value) => value.toLowerCase()),
  reviewedConfirmed: z.literal(true),
});
const noQuery = z.strictObject({});
const historyQuery = z.strictObject({
  page: z
    .string()
    .regex(/^[1-9]\d{0,6}$/)
    .transform(Number)
    .refine((value) => value <= 1000000)
    .default(1),
  pageSize: z.enum(['10', '25', '50']).transform(Number).default(10),
});
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function registerDoctorProfileEdits(
  app: Express,
  { db, currentSessionUser, transaction, audit, fail }: Dependencies,
) {
  db.exec(`CREATE TABLE IF NOT EXISTS doctorProfileChanges(
    id TEXT PRIMARY KEY, doctorId TEXT NOT NULL REFERENCES doctors(id), data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS doctor_profile_change_order ON doctorProfileChanges(doctorId);
  CREATE TABLE IF NOT EXISTS doctorProfileEditCommands(
    requestId TEXT PRIMARY KEY, doctorId TEXT NOT NULL REFERENCES doctors(id),
    actorId TEXT NOT NULL REFERENCES users(id), commandHash TEXT NOT NULL,
    changeId TEXT UNIQUE REFERENCES doctorProfileChanges(id), refusal TEXT,
    CHECK ((changeId IS NOT NULL AND refusal IS NULL) OR
      (changeId IS NULL AND refusal IS NOT NULL AND refusal IN ('DOCTOR_PROFILE_CHANGED','DOCTOR_PROFILE_UNCHANGED')))
  );`);
  for (const table of ['doctorProfileChanges', 'doctorProfileEditCommands'])
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT,'Doctor profile edit evidence is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT,'Doctor profile edit evidence is immutable'); END;`);

  function administrator(req: AuthRequest) {
    const user = currentSessionUser(req);
    if (user.role !== 'admin' || user.mustChangePassword)
      return fail(403, 'A current administrator is required to manage doctor profiles.');
    return user;
  }
  function stored(doctorId: string): DoctorProfileSnapshot {
    const profile = get<DoctorProfileSnapshot>(db, 'doctors', doctorId);
    if (!profile) return fail(404, 'Doctor not found.');
    return { ...doctorProfileFields.parse(profile), id: doctorId };
  }
  function context(doctorId: string): DoctorProfileEditContext {
    const doctor = stored(doctorId);
    const head = db
      .prepare('SELECT id FROM doctorProfileChanges WHERE doctorId=? ORDER BY rowid DESC LIMIT 1')
      .get(doctorId);
    return { doctor, revision: digest([doctor, head?.id ?? null]) };
  }
  function expectWrite(changes: number | bigint) {
    if (Number(changes) !== 1) throw new Error('The doctor profile write did not complete.');
  }
  function writeProfile(doctor: DoctorProfileSnapshot) {
    expectWrite(
      db.prepare('UPDATE doctors SET data=? WHERE id=?').run(JSON.stringify(doctor), doctor.id)
        .changes,
    );
  }
  function auditProfile(req: AuthRequest, action: string, doctorId: string) {
    audit(req, action, 'doctor', doctorId);
    // The shared audit writer inserts one row. SQLite can suppress an insert without throwing.
    expectWrite(Number(db.prepare('SELECT changes() AS n').get()!.n));
  }
  function record(
    req: AuthRequest,
    actor: User,
    before: DoctorProfileSnapshot,
    after: DoctorProfileSnapshot,
    source: DoctorProfileEditChange['source'],
  ) {
    const change: DoctorProfileEditChange = {
      id: id(),
      doctorId: before.id,
      actorId: actor.id,
      actorName: actor.name,
      createdAt: nowISO(),
      source,
      before,
      after,
    };
    writeProfile(after);
    expectWrite(
      db
        .prepare('INSERT INTO doctorProfileChanges(id,doctorId,data) VALUES (?,?,?)')
        .run(change.id, before.id, JSON.stringify(change)).changes,
    );
    auditProfile(req, 'updated doctor profile', before.id);
    return change;
  }
  function response(
    command: DoctorProfileEditCommand,
    change: DoctorProfileEditChange,
  ): DoctorProfileEditResponse {
    return {
      receipt: {
        actorId: change.actorId,
        doctorId: change.doctorId,
        requestId: command.requestId,
        expectedRevision: command.expectedRevision,
        revision: digest([change.after, change.id]),
        before: change.before,
        after: change.after,
      },
    };
  }
  const base = '/api/doctors/:id';
  app.get(base + '/profile-context', (req: AuthRequest, res) => {
    const result = transaction(() => {
      administrator(req);
      noQuery.parse(req.query);
      return context(String(req.params.id));
    });
    res.json(result);
  });
  app.get(base + '/profile-history', (req: AuthRequest, res) => {
    const result = transaction((): DoctorProfileEditHistory => {
      administrator(req);
      const doctorId = String(req.params.id);
      const query = historyQuery.parse(req.query);
      stored(doctorId);
      const total = Number(
        db.prepare('SELECT COUNT(*) AS n FROM doctorProfileChanges WHERE doctorId=?').get(doctorId)!
          .n,
      );
      const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
      const page = Math.min(query.page, totalPages);
      const rows = db
        .prepare(
          'SELECT data FROM doctorProfileChanges WHERE doctorId=? ORDER BY rowid DESC LIMIT ? OFFSET ?',
        )
        .all(doctorId, query.pageSize, (page - 1) * query.pageSize);
      const items = rows.map((row) => JSON.parse(String(row.data)) as DoctorProfileEditChange);
      auditProfile(req, 'viewed doctor profile history', doctorId);
      return { items, page, pageSize: query.pageSize, total, totalPages };
    });
    res.json(result);
  });
  app.patch(base, (req: AuthRequest, res) => {
    const result = transaction(() => {
      const actor = administrator(req);
      const doctorId = String(req.params.id);
      const before = stored(doctorId);
      const after = { ...doctorProfileFields.parse(req.body), id: doctorId };
      if (JSON.stringify(before) !== JSON.stringify(after))
        record(req, actor, before, after, 'legacy');
      else {
        writeProfile(after);
        auditProfile(req, 'updated doctor profile', doctorId);
      }
      return after;
    });
    res.json(result);
  });
  app.post(base + '/profile-changes', (req: AuthRequest, res) => {
    const result = transaction(() => {
      const actor = administrator(req);
      noQuery.parse(req.query);
      const doctorId = String(req.params.id);
      const command = commandSchema.parse(req.body);
      const source = context(doctorId);
      const { profile, expectedRevision, requestId } = command;
      const hash = digest([expectedRevision, profile]);
      const prior = db
        .prepare(
          'SELECT actorId,doctorId,commandHash,changeId,refusal FROM doctorProfileEditCommands WHERE requestId=?',
        )
        .get(requestId);
      const refused = (code: DoctorProfileEditRefusal['code']): DoctorProfileEditRefusal => ({
        code,
        actorId: actor.id,
        doctorId,
        requestId,
        expectedRevision,
        profile,
      });
      if (prior) {
        if (prior.actorId !== actor.id || prior.doctorId !== doctorId || prior.commandHash !== hash)
          return fail(409, 'This request ID was already used for another doctor profile edit.');
        if (prior.refusal)
          return { status: 409, body: refused(prior.refusal as DoctorProfileEditRefusal['code']) };
        const change = get<DoctorProfileEditChange>(
          db,
          'doctorProfileChanges',
          String(prior.changeId),
        )!;
        return { status: 200, body: response(command, change) };
      }
      const after = { ...profile, id: doctorId };
      const refusal =
        expectedRevision !== source.revision
          ? 'DOCTOR_PROFILE_CHANGED'
          : JSON.stringify(source.doctor) === JSON.stringify(after)
            ? 'DOCTOR_PROFILE_UNCHANGED'
            : null;
      const store = db.prepare(
        'INSERT INTO doctorProfileEditCommands(requestId,doctorId,actorId,commandHash,changeId,refusal) VALUES (?,?,?,?,?,?)',
      );
      if (refusal) {
        expectWrite(store.run(requestId, doctorId, actor.id, hash, null, refusal).changes);
        return { status: 409, body: refused(refusal) };
      }
      const change = record(req, actor, source.doctor, after, 'reviewed');
      expectWrite(store.run(requestId, doctorId, actor.id, hash, change.id, null).changes);
      return { status: 201, body: response(command, change) };
    });
    res.status(result.status).json(result.body);
  });
}
