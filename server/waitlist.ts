import type { Express } from 'express';
import { z } from 'zod';
import type { AuthRequest } from './app.ts';
import type { Appointment, Doctor, Patient, User } from '../shared/types.ts';
import type { WaitlistEntry } from '../shared/waitlist.ts';
import { addDays, clinicToday, get, id, nowISO, type DB } from './db.ts';
import { notifyPatient } from './activity.ts';

interface WaitlistContext {
  db: DB;
  actor: (req: AuthRequest, roles?: User['role'][]) => User;
  ownPatient: (req: AuthRequest, patientId?: string) => string;
  patientAccess: (req: AuthRequest, patientId: string, allowReception?: boolean) => Patient;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
}
type WaitlistRequest = Pick<
  WaitlistEntry,
  | 'id'
  | 'patientId'
  | 'patientName'
  | 'doctorId'
  | 'doctorName'
  | 'mode'
  | 'startDate'
  | 'endDate'
  | 'reason'
  | 'createdAt'
>;
interface WaitlistEvent {
  id: string;
  waitlistId: string;
  kind: 'booked' | 'cancelled';
  appointmentId: string | null;
  reason: string;
  patientConfirmed: boolean;
  actorId: string;
  actorName: string;
  actorRole: User['role'];
  createdAt: string;
}
const key = z.string().trim().min(1).max(300);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      !Number.isNaN(Date.parse(`${value}T12:00:00Z`)) &&
      new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value,
    'Use a real calendar date.',
  );

export function createWaitlist({
  db,
  actor,
  ownPatient,
  patientAccess,
  audit,
  fail,
}: WaitlistContext) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS waitlistRequests (
      id TEXT PRIMARY KEY, patientId TEXT NOT NULL REFERENCES patients(id),
      doctorId TEXT NOT NULL REFERENCES doctors(id), mode TEXT NOT NULL,
      startDate TEXT NOT NULL, endDate TEXT NOT NULL, data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS waitlist_patient ON waitlistRequests(patientId);
    CREATE TABLE IF NOT EXISTS waitlistEvents (
      id TEXT PRIMARY KEY, waitlistId TEXT NOT NULL UNIQUE REFERENCES waitlistRequests(id),
      kind TEXT NOT NULL CHECK(kind IN ('booked','cancelled')),
      appointmentId TEXT UNIQUE REFERENCES appointments(id), data TEXT NOT NULL,
      CHECK((kind='booked' AND appointmentId IS NOT NULL) OR (kind='cancelled' AND appointmentId IS NULL))
    );
    CREATE TABLE IF NOT EXISTS waitlistActive (
      waitlistId TEXT PRIMARY KEY REFERENCES waitlistRequests(id),
      patientId TEXT NOT NULL REFERENCES patients(id), doctorId TEXT NOT NULL REFERENCES doctors(id),
      mode TEXT NOT NULL, endDate TEXT NOT NULL, UNIQUE(patientId,doctorId,mode)
    );
    CREATE TRIGGER IF NOT EXISTS waitlist_request_no_update BEFORE UPDATE ON waitlistRequests
      BEGIN SELECT RAISE(ABORT,'Waitlist requests are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS waitlist_request_no_delete BEFORE DELETE ON waitlistRequests
      BEGIN SELECT RAISE(ABORT,'Waitlist requests are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS waitlist_event_no_update BEFORE UPDATE ON waitlistEvents
      BEGIN SELECT RAISE(ABORT,'Waitlist events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS waitlist_event_no_delete BEFORE DELETE ON waitlistEvents
      BEGIN SELECT RAISE(ABORT,'Waitlist events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS waitlist_event_close_claim AFTER INSERT ON waitlistEvents
      BEGIN DELETE FROM waitlistActive WHERE waitlistId=NEW.waitlistId; END;
  `);
  function transaction<T>(operation: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  function hydrate(value: WaitlistRequest, user: User): WaitlistEntry {
    const row = db.prepare('SELECT data FROM waitlistEvents WHERE waitlistId=?').get(value.id);
    const event = row ? (JSON.parse(row.data as string) as WaitlistEvent) : undefined;
    return {
      ...value,
      ...(user.role === 'patient'
        ? {}
        : { patientPhone: get<Patient>(db, 'patients', value.patientId)?.phone ?? '' }),
      status: event?.kind ?? (value.endDate < clinicToday() ? 'expired' : 'waiting'),
      appointmentId: event?.appointmentId ?? null,
      closedAt: event?.createdAt ?? null,
      cancellationReason: event?.kind === 'cancelled' ? event.reason : null,
    };
  }
  function entry(req: AuthRequest, waitlistId: string) {
    const user = actor(req);
    const value = get<WaitlistRequest>(db, 'waitlistRequests', waitlistId);
    if (!value) return fail(404, 'Waitlist request not found.');
    patientAccess(req, value.patientId, true);
    return hydrate(value, user);
  }
  function requireWaiting(value: WaitlistEntry) {
    if (value.status !== 'waiting')
      fail(409, `This waitlist request is ${value.status}. Create a new request if needed.`);
  }
  function recordEvent(
    req: AuthRequest,
    value: WaitlistEntry,
    kind: WaitlistEvent['kind'],
    appointmentId: string | null,
    reason: string,
  ) {
    const user = actor(req);
    const event: WaitlistEvent = {
      id: id(),
      waitlistId: value.id,
      kind,
      appointmentId,
      reason,
      patientConfirmed: kind === 'booked',
      actorId: user.id,
      actorName: user.name,
      actorRole: user.role,
      createdAt: nowISO(),
    };
    db.prepare(
      'INSERT INTO waitlistEvents(id,waitlistId,kind,appointmentId,data) VALUES (?,?,?,?,?)',
    ).run(event.id, value.id, kind, appointmentId, JSON.stringify(event));
    audit(
      req,
      kind === 'booked' ? 'booked confirmed waitlist request' : 'cancelled waitlist request',
      'waitlist',
      value.id,
    );
    return event;
  }
  // The caller must already hold the appointment's immediate transaction. Inserting
  // the appointment first lets the terminal event enforce its foreign-key linkage.
  function book(
    req: AuthRequest,
    waitlistId: string,
    appointment: Appointment,
    patientConfirmed?: true,
  ) {
    const value = entry(req, waitlistId);
    requireWaiting(value);
    if (patientConfirmed !== true)
      fail(
        400,
        'Confirm that the patient agrees to this appointment before booking from the waitlist.',
      );
    if (
      value.patientId !== appointment.patientId ||
      value.doctorId !== appointment.doctorId ||
      value.mode !== appointment.mode
    )
      fail(400, 'The appointment must match the waitlist patient, doctor and consultation mode.');
    if (appointment.date < value.startDate || appointment.date > value.endDate)
      fail(400, 'Choose an appointment date within this waitlist request.');
    recordEvent(req, value, 'booked', appointment.id, '');
    notifyPatient(db, value.patientId, `waitlist-booked:${value.id}`, {
      kind: 'waitlist',
      title: 'Your waitlist request is booked',
      detail: `${appointment.date} at ${appointment.time} IST · ${appointment.doctorName}`,
      href: `/my-care?waitlist=${value.id}`,
    });
  }
  function register(app: Express) {
    app.get('/api/waitlist', (req: AuthRequest, res) => {
      const user = actor(req);
      const query = z
        .object({
          status: z.enum(['waiting', 'booked', 'cancelled', 'expired']).optional(),
          doctorId: key.optional(),
        })
        .parse(req.query);
      const rows =
        user.role === 'patient'
          ? db
              .prepare('SELECT data FROM waitlistRequests WHERE patientId=? ORDER BY rowid DESC')
              .all(user.patientId ?? '')
          : db.prepare('SELECT data FROM waitlistRequests ORDER BY rowid DESC').all();
      const entries = rows
        .map((row) => hydrate(JSON.parse(row.data as string) as WaitlistRequest, user))
        .filter(
          (value) =>
            (!query.status || value.status === query.status) &&
            (!query.doctorId || value.doctorId === query.doctorId),
        );
      res.json(entries);
    });
    app.post('/api/waitlist', (req: AuthRequest, res) => {
      const input = z
        .object({
          patientId: key.optional(),
          doctorId: key,
          mode: z.enum(['in-person', 'online']),
          startDate: date,
          endDate: date,
          reason: key,
        })
        .strict()
        .parse(req.body);
      const patientId = ownPatient(req, input.patientId);
      const patient = patientAccess(req, patientId, true);
      const doctor = get<Doctor>(db, 'doctors', input.doctorId);
      if (!doctor) return fail(404, 'Doctor not found.');
      const today = clinicToday();
      if (
        input.startDate < today ||
        input.endDate < input.startDate ||
        input.endDate > addDays(today, 180)
      )
        fail(400, 'Choose an ordered date window from today through the next 180 days.');
      const value: WaitlistRequest = {
        ...input,
        id: id(),
        patientId,
        patientName: patient.name,
        doctorName: doctor.name,
        createdAt: nowISO(),
      };
      transaction(() => {
        // Expiry is derived from the clinic date; only the operational claim is removed.
        // The original request and its history remain intact.
        db.prepare('DELETE FROM waitlistActive WHERE endDate<?').run(today);
        if (
          db
            .prepare('SELECT 1 FROM waitlistActive WHERE patientId=? AND doctorId=? AND mode=?')
            .get(patientId, doctor.id, input.mode)
        )
          fail(
            409,
            'This patient already has a waiting request for this doctor and consultation mode.',
          );
        db.prepare(
          'INSERT INTO waitlistRequests(id,patientId,doctorId,mode,startDate,endDate,data) VALUES (?,?,?,?,?,?,?)',
        ).run(
          value.id,
          patientId,
          doctor.id,
          input.mode,
          input.startDate,
          input.endDate,
          JSON.stringify(value),
        );
        db.prepare(
          'INSERT INTO waitlistActive(waitlistId,patientId,doctorId,mode,endDate) VALUES (?,?,?,?,?)',
        ).run(value.id, patientId, doctor.id, input.mode, input.endDate);
        audit(req, 'joined appointment waitlist', 'waitlist', value.id);
        notifyPatient(db, patientId, `waitlist-created:${value.id}`, {
          kind: 'waitlist',
          title: 'Your waitlist request is saved',
          detail: `${value.doctorName} · ${value.startDate} to ${value.endDate}`,
          href: `/my-care?waitlist=${value.id}`,
        });
      });
      res.status(201).json(hydrate(value, actor(req)));
    });
    app.post('/api/waitlist/:id/cancel', (req: AuthRequest, res) => {
      const input = z
        .object({ reason: z.string().trim().max(300).default('') })
        .strict()
        .parse(req.body);
      const waitlistId = String(req.params.id);
      const updated = transaction(() => {
        const value = entry(req, waitlistId);
        if (value.status === 'cancelled') return value;
        requireWaiting(value);
        recordEvent(req, value, 'cancelled', null, input.reason);
        notifyPatient(db, value.patientId, `waitlist-cancelled:${value.id}`, {
          kind: 'waitlist',
          title: 'Your waitlist request was cancelled',
          detail: value.doctorName,
          href: `/my-care?waitlist=${value.id}`,
        });
        return entry(req, waitlistId);
      });
      res.json(updated);
    });
  }
  return { register, book };
}
