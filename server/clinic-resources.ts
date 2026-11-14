import type { Express } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AuthRequest } from './app.ts';
import type { Appointment, User } from '../shared/types.ts';
import type {
  AppointmentResourceContext,
  ClinicResource,
  ResourceAllocationEvent,
  ResourceAllocationSnapshot,
  ResourceAppointment,
  ResourceAuthor,
  ResourceAvailability,
  ResourceChange,
  ResourceClosure,
  ResourceClosureCancellation,
  ResourceDetail,
  ResourceMetadata,
  ResourceReservation,
  ResourceSnapshot,
} from '../shared/clinic-resources.ts';
import { addDays, clinicToday, get, id, list, nowISO, type DB } from './db.ts';

interface ResourceContext {
  db: DB;
  actor: (req: AuthRequest, roles?: User['role'][]) => User;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
}
interface StoredResource {
  id: string;
  kind: ResourceMetadata['kind'];
  createdAt: string;
}
interface AppointmentMove {
  before: Appointment;
  after: Appointment;
}
type StoredClosure = Omit<ResourceClosure, 'cancellation'>;
type Operation = 'create' | 'metadata' | 'closure' | 'cancel-closure' | 'allocate';
const openStatuses = new Set<Appointment['status']>(['scheduled', 'checked-in', 'in-consultation']);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const reason = z.string().trim().min(1).max(1000);
const revision = z.string().regex(/^[a-f0-9]{64}$/, 'Refresh the resource context before saving.');
const commandFields = { reason, expectedRevision: revision, requestId: uuid };
const name = z.string().trim().min(1).max(100);
const location = z.string().trim().max(200);
const notes = z.string().trim().max(1000);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      !Number.isNaN(Date.parse(`${value}T12:00:00Z`)) &&
      new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value,
    'Use a real calendar date.',
  );
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Use a real 24-hour time.');
const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
const epoch = (date: string, time: string) => Date.parse(`${date}T${time}:00+05:30`);
const interval = (appointment: ResourceAppointment) => ({
  start: epoch(appointment.date, appointment.time),
  end: epoch(appointment.date, appointment.time) + appointment.durationMinutes * 60000,
});
const overlaps = (start: number, end: number, otherStart: number, otherEnd: number) =>
  start < otherEnd && otherStart < end;
const nameKey = (value: string) => value.normalize('NFKC').toLowerCase();
const snapshotAppointment = (value: Appointment): ResourceAppointment => ({
  id: value.id,
  patientId: value.patientId,
  patientName: value.patientName,
  doctorId: value.doctorId,
  doctorName: value.doctorName,
  date: value.date,
  time: value.time,
  durationMinutes: value.durationMinutes ?? 30,
  mode: value.mode,
  status: value.status,
});
const snapshotResource = (value: ClinicResource): ResourceSnapshot => ({
  id: value.id,
  name: value.name,
  kind: value.kind,
  location: value.location,
});
const metadata = (value: ClinicResource): ResourceMetadata => ({
  name: value.name,
  kind: value.kind,
  capacity: 1,
  location: value.location,
  notes: value.notes,
  active: value.active,
});

export function createClinicResources({ db, actor, audit, fail }: ResourceContext) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS clinicResources (id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS resourceNames (resourceId TEXT PRIMARY KEY REFERENCES clinicResources(id),nameKey TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS resourceChanges (id TEXT PRIMARY KEY,resourceId TEXT NOT NULL REFERENCES clinicResources(id),data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS resource_changes_resource ON resourceChanges(resourceId);
    CREATE TABLE IF NOT EXISTS resourceClosures (id TEXT PRIMARY KEY,resourceId TEXT NOT NULL REFERENCES clinicResources(id),startDate TEXT NOT NULL,endDate TEXT NOT NULL,data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS resource_closures_dates ON resourceClosures(resourceId,startDate,endDate);
    CREATE TABLE IF NOT EXISTS resourceClosureCancellations (id TEXT PRIMARY KEY REFERENCES resourceClosures(id),data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS resourceAllocationEvents (id TEXT PRIMARY KEY,appointmentId TEXT NOT NULL REFERENCES appointments(id),data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS resource_allocation_events_appointment ON resourceAllocationEvents(appointmentId);
    CREATE TABLE IF NOT EXISTS resourceEventLinks (resourceId TEXT NOT NULL REFERENCES clinicResources(id),eventId TEXT NOT NULL REFERENCES resourceAllocationEvents(id),PRIMARY KEY(resourceId,eventId));
    CREATE TABLE IF NOT EXISTS resourceReservations (
      appointmentId TEXT NOT NULL REFERENCES appointments(id),resourceId TEXT NOT NULL REFERENCES clinicResources(id),
      startAt INTEGER NOT NULL,endAt INTEGER NOT NULL CHECK(endAt>startAt),data TEXT NOT NULL,
      PRIMARY KEY(appointmentId,resourceId)
    );
    CREATE INDEX IF NOT EXISTS resource_reservations_window ON resourceReservations(resourceId,startAt,endAt);
    CREATE TRIGGER IF NOT EXISTS resource_reservations_no_overlap BEFORE INSERT ON resourceReservations
      WHEN EXISTS(SELECT 1 FROM resourceReservations WHERE resourceId=NEW.resourceId AND appointmentId!=NEW.appointmentId AND startAt<NEW.endAt AND endAt>NEW.startAt)
      BEGIN SELECT RAISE(ABORT,'Resource reservation overlaps another appointment'); END;
    CREATE TRIGGER IF NOT EXISTS resource_reservations_no_overlap_update BEFORE UPDATE ON resourceReservations
      WHEN EXISTS(SELECT 1 FROM resourceReservations WHERE resourceId=NEW.resourceId AND appointmentId!=NEW.appointmentId AND startAt<NEW.endAt AND endAt>NEW.startAt)
      BEGIN SELECT RAISE(ABORT,'Resource reservation overlaps another appointment'); END;
    CREATE TABLE IF NOT EXISTS resourceCommands (
      requestId TEXT PRIMARY KEY,actorId TEXT NOT NULL REFERENCES users(id),operation TEXT NOT NULL,
      targetId TEXT NOT NULL,payload TEXT NOT NULL,resourceId TEXT REFERENCES clinicResources(id),appointmentId TEXT REFERENCES appointments(id),eventId TEXT NOT NULL
    );
  `);
  for (const table of [
    'clinicResources',
    'resourceChanges',
    'resourceClosures',
    'resourceClosureCancellations',
    'resourceAllocationEvents',
    'resourceEventLinks',
    'resourceCommands',
  ]) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT,'Resource source records are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT,'Resource source records are immutable'); END;`);
  }
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
  const staff = (req: AuthRequest) => actor(req, ['admin', 'doctor', 'receptionist']);
  const administrator = (req: AuthRequest) => actor(req, ['admin']);
  const author = (req: AuthRequest): ResourceAuthor => {
    const user = actor(req);
    return {
      createdById: user.id,
      createdByName: user.name,
      createdByRole: user.role,
      createdAt: nowISO(),
    };
  };
  function resourceDetail(resourceId: string): ResourceDetail {
    const original = get<StoredResource>(db, 'clinicResources', resourceId);
    if (!original) return fail(404, 'Clinic resource not found.');
    const changes = db
      .prepare('SELECT data FROM resourceChanges WHERE resourceId=? ORDER BY rowid DESC')
      .all(resourceId)
      .map((row) => JSON.parse(row.data as string) as ResourceChange);
    if (!changes[0]) return fail(500, 'Resource catalogue history is incomplete.');
    const closures = db
      .prepare('SELECT data FROM resourceClosures WHERE resourceId=? ORDER BY rowid DESC')
      .all(resourceId)
      .map((row): ResourceClosure => {
        const closure = JSON.parse(row.data as string) as StoredClosure;
        return {
          ...closure,
          cancellation:
            get<ResourceClosureCancellation>(db, 'resourceClosureCancellations', closure.id) ??
            null,
        };
      });
    const allocationEvents = db
      .prepare('SELECT eventId FROM resourceEventLinks WHERE resourceId=? ORDER BY rowid')
      .all(resourceId)
      .map((row) => row.eventId);
    return {
      resource: {
        ...changes[0].after,
        id: resourceId,
        createdAt: original.createdAt,
        updatedAt: changes[0].createdAt,
        revision: hash({
          resourceId,
          changeIds: changes.map((entry) => entry.id),
          closures,
          allocationEvents,
        }),
      },
      changes,
      closures,
    };
  }
  function appointmentRecord(appointmentId: string): ResourceAppointment {
    const appointment = get<Appointment>(db, 'appointments', appointmentId);
    if (!appointment) return fail(404, 'Appointment not found.');
    return snapshotAppointment(appointment);
  }
  function reservations(appointmentId: string): ResourceReservation[] {
    return db
      .prepare('SELECT data FROM resourceReservations WHERE appointmentId=? ORDER BY resourceId')
      .all(appointmentId)
      .map((row) => JSON.parse(row.data as string) as ResourceReservation);
  }
  function allocationHistory(appointmentId: string): ResourceAllocationEvent[] {
    return db
      .prepare(
        'SELECT data FROM resourceAllocationEvents WHERE appointmentId=? ORDER BY rowid DESC',
      )
      .all(appointmentId)
      .map((row) => JSON.parse(row.data as string) as ResourceAllocationEvent);
  }
  function closureOverlaps(closure: ResourceClosure, appointment: ResourceAppointment) {
    if (
      closure.cancellation ||
      appointment.date < closure.startDate ||
      appointment.date > closure.endDate
    )
      return false;
    if (closure.startTime === null) return true;
    return overlaps(
      minutes(appointment.time),
      minutes(appointment.time) + appointment.durationMinutes,
      minutes(closure.startTime),
      minutes(closure.endTime!),
    );
  }
  function availability(
    detail: ResourceDetail,
    appointment: ResourceAppointment,
  ): ResourceAvailability {
    const resource = detail.resource;
    let reason: ResourceAvailability['reason'] = 'available';
    if (!resource.active) reason = 'inactive';
    else if (detail.closures.some((closure) => closureOverlaps(closure, appointment)))
      reason = 'maintenance';
    else {
      const window = interval(appointment);
      if (
        db
          .prepare(
            'SELECT 1 FROM resourceReservations WHERE resourceId=? AND appointmentId!=? AND startAt<? AND endAt>?',
          )
          .get(resource.id, appointment.id, window.end, window.start)
      )
        reason = 'reserved';
    }
    return { resource, available: reason === 'available', reason };
  }
  function canAllocate(appointment: ResourceAppointment) {
    const window = interval(appointment);
    return appointment.status === 'scheduled'
      ? window.start > Date.now()
      : ['checked-in', 'in-consultation'].includes(appointment.status) && window.end > Date.now();
  }
  function appointmentContext(appointmentId: string): AppointmentResourceContext {
    const appointment = appointmentRecord(appointmentId),
      claims = reservations(appointmentId),
      history = allocationHistory(appointmentId);
    const resourceIds = claims.map((entry) => entry.resource.id).sort();
    const resources = list<StoredResource>(db, 'clinicResources')
      .map((entry) => availability(resourceDetail(entry.id), appointment))
      .sort(
        (a, b) =>
          a.resource.name.localeCompare(b.resource.name) ||
          a.resource.id.localeCompare(b.resource.id),
      );
    const window = interval(appointment);
    const conflicts = db
      .prepare(
        'SELECT resourceId,appointmentId,startAt,endAt FROM resourceReservations WHERE appointmentId!=? AND startAt<? AND endAt>? ORDER BY resourceId,appointmentId',
      )
      .all(appointmentId, window.end, window.start);
    return {
      appointment,
      resourceIds,
      revision: hash({
        appointment,
        latestEventId: history[0]?.id ?? null,
        resourceIds,
        availability: resources.map((entry) => ({
          resourceId: entry.resource.id,
          metadata: metadata(entry.resource),
          reason: entry.reason,
        })),
        conflicts,
      }),
      canAllocate: canAllocate(appointment),
      canRelease: openStatuses.has(appointment.status) && resourceIds.length > 0,
      resources,
      history,
    };
  }
  function commandReplay(
    user: User,
    operation: Operation,
    targetId: string,
    requestId: string,
    payload: unknown,
  ) {
    const previous = db
      .prepare(
        'SELECT actorId,operation,targetId,payload,resourceId,appointmentId FROM resourceCommands WHERE requestId=?',
      )
      .get(requestId);
    if (!previous) return undefined;
    if (
      previous.actorId !== user.id ||
      previous.operation !== operation ||
      previous.targetId !== targetId ||
      previous.payload !== JSON.stringify(payload)
    )
      fail(409, 'This resource request was already used with different details.');
    return previous;
  }
  function remember(
    user: User,
    operation: Operation,
    targetId: string,
    requestId: string,
    payload: unknown,
    eventId: string,
    resourceId: string | null,
    appointmentId: string | null,
  ) {
    db.prepare(
      'INSERT INTO resourceCommands(requestId,actorId,operation,targetId,payload,eventId,resourceId,appointmentId) VALUES (?,?,?,?,?,?,?,?)',
    ).run(
      requestId,
      user.id,
      operation,
      targetId,
      JSON.stringify(payload),
      eventId,
      resourceId,
      appointmentId,
    );
  }
  function checkResourceRevision(resourceId: string, expected: string) {
    const current = resourceDetail(resourceId);
    if (current.resource.revision !== expected)
      fail(
        409,
        'The resource, maintenance or reservations changed. Refresh and review the current record.',
      );
    return current;
  }
  function ensureUniqueName(value: string, resourceId = '') {
    if (
      db
        .prepare('SELECT 1 FROM resourceNames WHERE nameKey=? AND resourceId!=?')
        .get(nameKey(value), resourceId)
    )
      fail(409, 'A resource already uses this name. Choose a distinct room or equipment name.');
  }
  function currentClaims(resourceId: string) {
    return db
      .prepare('SELECT data,endAt FROM resourceReservations WHERE resourceId=?')
      .all(resourceId)
      .map((row) => ({
        ...(JSON.parse(row.data as string) as ResourceReservation),
        endAt: Number(row.endAt),
      }));
  }
  const conflictTimes = (claims: ResourceReservation[]) =>
    claims
      .slice(0, 3)
      .map(
        (claim) =>
          `${claim.appointment.date} at ${claim.appointment.time} IST (${claim.appointment.durationMinutes} minutes)`,
      )
      .join('; ');
  function recordAllocation(
    req: AuthRequest,
    before: ResourceAllocationSnapshot,
    after: ResourceAllocationSnapshot,
    source: ResourceAllocationEvent['source'],
    reason: string,
    requestId: string | null,
  ) {
    const event: ResourceAllocationEvent = {
      id: id(),
      appointmentId: after.appointment.id,
      source,
      before,
      after,
      reason,
      requestId,
      ...author(req),
    };
    db.prepare('INSERT INTO resourceAllocationEvents(id,appointmentId,data) VALUES (?,?,?)').run(
      event.id,
      event.appointmentId,
      JSON.stringify(event),
    );
    for (const resourceId of new Set(
      [...before.resources, ...after.resources].map((entry) => entry.id),
    ))
      db.prepare('INSERT INTO resourceEventLinks(resourceId,eventId) VALUES (?,?)').run(
        resourceId,
        event.id,
      );
    db.prepare('DELETE FROM resourceReservations WHERE appointmentId=?').run(event.appointmentId);
    const window = interval(after.appointment);
    for (const resource of after.resources) {
      const value: ResourceReservation = { resource, appointment: after.appointment };
      db.prepare(
        'INSERT INTO resourceReservations(appointmentId,resourceId,startAt,endAt,data) VALUES (?,?,?,?,?)',
      ).run(event.appointmentId, resource.id, window.start, window.end, JSON.stringify(value));
    }
    audit(
      req,
      source === 'staff-allocation'
        ? 'changed appointment resources'
        : 'updated resources with appointment',
      'appointment',
      event.appointmentId,
    );
    return event;
  }
  function unavailable(req: AuthRequest, resource: ClinicResource) {
    if (actor(req).role === 'patient')
      fail(
        409,
        'Assigned clinic resources are unavailable at that time. Choose another slot or contact the clinic.',
      );
    fail(
      409,
      `${resource.name} is inactive, reserved or under maintenance for this appointment interval. Choose another resource or time.`,
    );
  }
  /** No transaction here: the appointment caller already holds BEGIN IMMEDIATE. */
  function appointmentChanged(req: AuthRequest, previous: Appointment, next: Appointment) {
    const claims = reservations(previous.id);
    if (!claims.length) return;
    const before = snapshotAppointment(previous),
      after = snapshotAppointment(next);
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    const released = ['cancelled', 'no-show'].includes(after.status);
    const moved =
      before.date !== after.date ||
      before.time !== after.time ||
      before.durationMinutes !== after.durationMinutes ||
      before.mode !== after.mode ||
      before.doctorId !== after.doctorId ||
      before.doctorName !== after.doctorName;
    if (!released && moved) {
      for (const claim of claims) {
        const checked = availability(resourceDetail(claim.resource.id), after);
        if (!checked.available) unavailable(req, checked.resource);
      }
    }
    recordAllocation(
      req,
      { appointment: before, resources: claims.map((entry) => entry.resource) },
      { appointment: after, resources: released ? [] : claims.map((entry) => entry.resource) },
      moved ? 'appointment-rescheduled' : 'appointment-status',
      moved
        ? 'Reservations moved with the appointment.'
        : `Appointment ${after.status}; ${released ? 'reservations released' : 'recorded interval retained'}.`,
      null,
    );
  }
  /** Read-only virtual batch: selected old claims are vacant; selected targets still conflict. */
  function inspectAppointmentMoves(changes: readonly AppointmentMove[]) {
    const selectedIds = changes.map((change) => change.before.id);
    if (
      !selectedIds.length ||
      selectedIds.length > 12 ||
      new Set(selectedIds).size !== selectedIds.length ||
      changes.some((change) => change.before.id !== change.after.id)
    )
      return fail(400, 'Use distinct existing appointments for a resource move.');
    const placeholders = selectedIds.map(() => '?').join(',');
    const claims = db
      .prepare(
        `SELECT appointmentId,resourceId,data FROM resourceReservations WHERE appointmentId IN (${placeholders}) ORDER BY appointmentId,resourceId`,
      )
      .all(...selectedIds)
      .map((row) => ({
        appointmentId: String(row.appointmentId),
        resourceId: String(row.resourceId),
        value: JSON.parse(String(row.data)) as ResourceReservation,
      }));
    const heads = selectedIds.map((appointmentId) => ({
      appointmentId,
      eventId:
        db
          .prepare(
            'SELECT id FROM resourceAllocationEvents WHERE appointmentId=? ORDER BY rowid DESC LIMIT 1',
          )
          .get(appointmentId)?.id ?? null,
    }));
    const targets = changes.map((change) => ({
      appointment: snapshotAppointment(change.after),
      claims: claims.filter((claim) => claim.appointmentId === change.before.id),
      blockedReason: null as string | null,
    }));
    const resourceSources = [...new Set(claims.map((claim) => claim.resourceId))]
      .sort()
      .map((resourceId) => {
        const row = db
          .prepare(
            'SELECT id,data FROM resourceChanges WHERE resourceId=? ORDER BY rowid DESC LIMIT 1',
          )
          .get(resourceId);
        if (!row) return fail(500, 'Resource catalogue history is incomplete.');
        const change = JSON.parse(String(row.data)) as ResourceChange;
        const affected = targets.filter((target) =>
          target.claims.some((claim) => claim.resourceId === resourceId),
        );
        const dateWindows = affected.map((target) => target.appointment.date);
        const closures = db
          .prepare(
            `SELECT c.id,c.data,x.data AS cancellation FROM resourceClosures c LEFT JOIN resourceClosureCancellations x ON x.id=c.id WHERE c.resourceId=? AND (${dateWindows.map(() => '(c.startDate<=? AND c.endDate>=?)').join(' OR ')}) ORDER BY c.id`,
          )
          .all(resourceId, ...dateWindows.flatMap((date) => [date, date]))
          .map((closure) => ({
            ...(JSON.parse(String(closure.data)) as StoredClosure),
            cancellation: closure.cancellation
              ? (JSON.parse(String(closure.cancellation)) as ResourceClosureCancellation)
              : null,
          }));
        const windows = affected.map((target) => interval(target.appointment));
        const conflicts = db
          .prepare(
            `SELECT appointmentId,startAt,endAt FROM resourceReservations WHERE resourceId=? AND appointmentId NOT IN (${placeholders}) AND (${windows.map(() => '(startAt<? AND endAt>?)').join(' OR ')}) ORDER BY appointmentId`,
          )
          .all(
            resourceId,
            ...selectedIds,
            ...windows.flatMap((window) => [window.end, window.start]),
          );
        for (const target of affected) {
          const window = interval(target.appointment);
          if (!change.after.active)
            target.blockedReason ??= 'An assigned clinic resource is inactive.';
          else if (closures.some((closure) => closureOverlaps(closure, target.appointment)))
            target.blockedReason ??=
              'An assigned clinic resource is under maintenance at the target time.';
          else if (
            conflicts.some((claim) =>
              overlaps(window.start, window.end, Number(claim.startAt), Number(claim.endAt)),
            )
          )
            target.blockedReason ??= 'An assigned clinic resource is reserved at the target time.';
        }
        for (let left = 0; left < affected.length; left++) {
          for (let right = left + 1; right < affected.length; right++) {
            const a = interval(affected[left].appointment),
              b = interval(affected[right].appointment);
            if (overlaps(a.start, a.end, b.start, b.end)) {
              affected[left].blockedReason ??=
                'Selected visits overlap on an assigned clinic resource.';
              affected[right].blockedReason ??=
                'Selected visits overlap on an assigned clinic resource.';
            }
          }
        }
        return { resourceId, changeId: row.id, metadata: change.after, closures, conflicts };
      });
    return {
      claims,
      visits: targets.map((target) => ({
        appointmentId: target.appointment.id,
        reservationCount: target.claims.length,
        available: target.blockedReason === null,
        blockedReason: target.blockedReason,
      })),
      revision: hash({
        claims,
        heads,
        resourceSources,
        targets: targets.map((target) => target.appointment),
      }),
    };
  }
  function previewAppointmentMoves(changes: readonly AppointmentMove[]) {
    const { visits, revision } = inspectAppointmentMoves(changes);
    return { visits, revision };
  }
  /** Caller holds BEGIN IMMEDIATE. Capture originals before vacating all selected keys. */
  function applyAppointmentMoves(req: AuthRequest, changes: readonly AppointmentMove[]) {
    const checked = inspectAppointmentMoves(changes);
    const blocked = checked.visits.find((visit) => !visit.available);
    if (blocked) return fail(409, blocked.blockedReason!);
    const selectedIds = changes.map((change) => change.before.id);
    db.prepare(
      `DELETE FROM resourceReservations WHERE appointmentId IN (${selectedIds.map(() => '?').join(',')})`,
    ).run(...selectedIds);
    for (const change of changes) {
      const resources = checked.claims
        .filter((claim) => claim.appointmentId === change.before.id)
        .map((claim) => claim.value.resource);
      if (!resources.length) continue;
      recordAllocation(
        req,
        { appointment: snapshotAppointment(change.before), resources },
        { appointment: snapshotAppointment(change.after), resources },
        'appointment-rescheduled',
        'Reservations moved with the appointment.',
        null,
      );
    }
    return checked.visits;
  }
  function availableForAppointment(
    appointmentId: string,
    date: string,
    time: string,
    durationMinutes: number,
  ) {
    return availableSlotsForAppointment(appointmentId, date, [time], durationMinutes).length === 1;
  }
  function availableSlotsForAppointment(
    appointmentId: string,
    date: string,
    times: string[],
    durationMinutes: number,
  ): string[] {
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1) return [];
    const appointment = appointmentRecord(appointmentId);
    const details = reservations(appointmentId).map((entry) => resourceDetail(entry.resource.id));
    return times.filter((time) => {
      if (!Number.isFinite(epoch(date, time))) return false;
      const candidate = { ...appointment, date, time, durationMinutes };
      return details.every((detail) => availability(detail, candidate).available);
    });
  }
  function register(app: Express) {
    app.get('/api/clinic-resources', (req: AuthRequest, res) => {
      staff(req);
      const input = z
        .object({ active: z.enum(['true', 'false', 'all']).default('all') })
        .strict()
        .parse(req.query);
      res.json(
        transaction(() => {
          const resources = list<StoredResource>(db, 'clinicResources')
            .map((entry) => resourceDetail(entry.id).resource)
            .filter((entry) => input.active === 'all' || entry.active === (input.active === 'true'))
            .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
          audit(req, 'viewed clinic resources', 'resource', 'catalogue');
          return resources;
        }),
      );
    });
    app.get('/api/clinic-resources/:id', (req: AuthRequest, res) => {
      staff(req);
      const resourceId = String(req.params.id);
      res.json(
        transaction(() => {
          const value = resourceDetail(resourceId);
          audit(req, 'viewed resource history', 'resource', resourceId);
          return value;
        }),
      );
    });
    app.post('/api/clinic-resources', (req: AuthRequest, res) => {
      const user = administrator(req);
      const { requestId, ...input } = z
        .object({
          name,
          kind: z.enum(['room', 'equipment']),
          location: location.default(''),
          notes: notes.default(''),
          requestId: uuid,
        })
        .strict()
        .parse(req.body);
      let duplicate = false;
      const value = transaction(() => {
        const prior = commandReplay(user, 'create', 'catalogue', requestId, input);
        if (prior) {
          duplicate = true;
          return resourceDetail(String(prior.resourceId));
        }
        ensureUniqueName(input.name);
        const resourceId = id(),
          createdAt = nowISO();
        const original: StoredResource = { id: resourceId, kind: input.kind, createdAt };
        const after: ResourceMetadata = { ...input, capacity: 1, active: true };
        const change: ResourceChange = {
          id: id(),
          requestId,
          resourceId,
          before: null,
          after,
          reason: 'Resource created.',
          ...author(req),
        };
        db.prepare('INSERT INTO clinicResources(id,data) VALUES (?,?)').run(
          resourceId,
          JSON.stringify(original),
        );
        db.prepare('INSERT INTO resourceNames(resourceId,nameKey) VALUES (?,?)').run(
          resourceId,
          nameKey(input.name),
        );
        db.prepare('INSERT INTO resourceChanges(id,resourceId,data) VALUES (?,?,?)').run(
          change.id,
          resourceId,
          JSON.stringify(change),
        );
        remember(user, 'create', 'catalogue', requestId, input, change.id, resourceId, null);
        audit(req, 'created clinic resource', 'resource', resourceId);
        return resourceDetail(resourceId);
      });
      res.status(duplicate ? 200 : 201).json(value);
    });
    app.patch('/api/clinic-resources/:id', (req: AuthRequest, res) => {
      const user = administrator(req),
        resourceId = String(req.params.id);
      const { expectedRevision, requestId, ...input } = z
        .object({
          name: name.optional(),
          location: location.optional(),
          notes: notes.optional(),
          active: z.boolean().optional(),
          ...commandFields,
        })
        .strict()
        .refine(
          (value) => ['name', 'location', 'notes', 'active'].some((field) => field in value),
          'Provide at least one catalogue change.',
        )
        .parse(req.body);
      res.json(
        transaction(() => {
          if (commandReplay(user, 'metadata', resourceId, requestId, input))
            return resourceDetail(resourceId);
          const current = checkResourceRevision(resourceId, expectedRevision),
            before = metadata(current.resource);
          const { reason: changeReason, ...fields } = input,
            after = { ...before, ...fields };
          if (JSON.stringify(before) === JSON.stringify(after))
            fail(400, 'Change at least one catalogue field.');
          ensureUniqueName(after.name, resourceId);
          if (!after.active && before.active) {
            const affected = currentClaims(resourceId).filter(
              (claim) => openStatuses.has(claim.appointment.status) || claim.endAt > Date.now(),
            );
            if (affected.length)
              fail(
                409,
                `This resource has ${affected.length} open or future appointment reservation${affected.length === 1 ? '' : 's'}: ${conflictTimes(affected)}. Release or reassign open reservations before archiving it.`,
              );
          }
          const change: ResourceChange = {
            id: id(),
            requestId,
            resourceId,
            before,
            after,
            reason: changeReason,
            ...author(req),
          };
          db.prepare('INSERT INTO resourceChanges(id,resourceId,data) VALUES (?,?,?)').run(
            change.id,
            resourceId,
            JSON.stringify(change),
          );
          db.prepare('UPDATE resourceNames SET nameKey=? WHERE resourceId=?').run(
            nameKey(after.name),
            resourceId,
          );
          remember(user, 'metadata', resourceId, requestId, input, change.id, resourceId, null);
          audit(req, 'changed clinic resource', 'resource', resourceId);
          return resourceDetail(resourceId);
        }),
      );
    });
    app.post('/api/clinic-resources/:id/closures', (req: AuthRequest, res) => {
      const user = administrator(req),
        resourceId = String(req.params.id);
      const { expectedRevision, requestId, ...input } = z
        .object({
          startDate: date,
          endDate: date,
          startTime: time.nullable(),
          endTime: time.nullable(),
          ...commandFields,
        })
        .strict()
        .refine(
          (value) =>
            value.endDate >= value.startDate && value.endDate <= addDays(value.startDate, 365),
          'Use an ordered date range of at most 366 days.',
        )
        .refine(
          (value) =>
            (value.startTime === null && value.endTime === null) ||
            (value.startTime !== null && value.endTime !== null && value.startTime < value.endTime),
          'Use both times or neither, with the end after the start. Overnight closures are not supported.',
        )
        .parse(req.body);
      let duplicate = false;
      const value = transaction(() => {
        if (commandReplay(user, 'closure', resourceId, requestId, input)) {
          duplicate = true;
          return resourceDetail(resourceId);
        }
        checkResourceRevision(resourceId, expectedRevision);
        if (input.startDate < clinicToday() || input.endDate > addDays(clinicToday(), 365))
          fail(400, 'Choose maintenance dates from today through the next 365 days.');
        const closure: ResourceClosure = {
          ...input,
          id: id(),
          requestId,
          resourceId,
          cancellation: null,
          ...author(req),
        };
        const affected = currentClaims(resourceId).filter(
          (claim) => claim.endAt > Date.now() && closureOverlaps(closure, claim.appointment),
        );
        if (affected.length)
          fail(
            409,
            `This maintenance would affect ${affected.length} reserved appointment interval${affected.length === 1 ? '' : 's'}: ${conflictTimes(affected)}. Move or release the conflicting reservations first.`,
          );
        const { cancellation: _cancellation, ...stored } = closure;
        db.prepare(
          'INSERT INTO resourceClosures(id,resourceId,startDate,endDate,data) VALUES (?,?,?,?,?)',
        ).run(closure.id, resourceId, input.startDate, input.endDate, JSON.stringify(stored));
        remember(user, 'closure', resourceId, requestId, input, closure.id, resourceId, null);
        audit(req, 'recorded resource maintenance', 'resource', resourceId);
        return resourceDetail(resourceId);
      });
      res.status(duplicate ? 200 : 201).json(value);
    });
    app.post('/api/clinic-resources/:id/closures/:closureId/cancel', (req: AuthRequest, res) => {
      const user = administrator(req),
        resourceId = String(req.params.id),
        closureId = String(req.params.closureId);
      const { expectedRevision, requestId, ...input } = z
        .object(commandFields)
        .strict()
        .parse(req.body);
      const target = `${resourceId}:${closureId}`;
      res.json(
        transaction(() => {
          if (commandReplay(user, 'cancel-closure', target, requestId, input))
            return resourceDetail(resourceId);
          const current = checkResourceRevision(resourceId, expectedRevision),
            closure = current.closures.find((entry) => entry.id === closureId);
          if (!closure) return fail(404, 'Maintenance closure not found for this resource.');
          if (closure.cancellation)
            fail(409, 'This maintenance closure has already been cancelled.');
          const cancellation: ResourceClosureCancellation = {
            id: id(),
            requestId,
            reason: input.reason,
            ...author(req),
          };
          db.prepare('INSERT INTO resourceClosureCancellations(id,data) VALUES (?,?)').run(
            closureId,
            JSON.stringify(cancellation),
          );
          remember(
            user,
            'cancel-closure',
            target,
            requestId,
            input,
            cancellation.id,
            resourceId,
            null,
          );
          audit(req, 'cancelled resource maintenance', 'resource', resourceId);
          return resourceDetail(resourceId);
        }),
      );
    });
    app.get('/api/appointments/:id/resources', (req: AuthRequest, res) => {
      staff(req);
      const appointmentId = String(req.params.id);
      res.json(
        transaction(() => {
          const value = appointmentContext(appointmentId);
          audit(req, 'viewed appointment resources', 'appointment', appointmentId);
          return value;
        }),
      );
    });
    app.put('/api/appointments/:id/resources', (req: AuthRequest, res) => {
      const user = staff(req),
        appointmentId = String(req.params.id);
      const { expectedRevision, requestId, ...input } = z
        .object({
          resourceIds: z
            .array(z.string().trim().min(1).max(300))
            .max(8)
            .refine(
              (values) => new Set(values).size === values.length,
              'Choose each resource only once.',
            )
            .transform((values) => values.sort()),
          ...commandFields,
        })
        .strict()
        .parse(req.body);
      res.json(
        transaction(() => {
          if (commandReplay(user, 'allocate', appointmentId, requestId, input))
            return appointmentContext(appointmentId);
          const current = appointmentContext(appointmentId);
          if (current.revision !== expectedRevision)
            fail(
              409,
              'The appointment or its resource allocation changed. Refresh and review the current interval and reservations.',
            );
          if (JSON.stringify(current.resourceIds) === JSON.stringify(input.resourceIds))
            fail(400, 'Change the selected resources before saving.');
          if (input.resourceIds.length ? !current.canAllocate : !current.canRelease)
            fail(
              409,
              'Resources can be allocated before a scheduled visit or before an in-progress visit’s scheduled end. Only an open appointment can release its remaining reservations.',
            );
          const selected = input.resourceIds.map((resourceId) => {
            const detail = resourceDetail(resourceId),
              available = availability(detail, current.appointment);
            if (!available.available) unavailable(req, available.resource);
            return snapshotResource(detail.resource);
          });
          const before = {
            appointment: current.appointment,
            resources: reservations(appointmentId).map((entry) => entry.resource),
          };
          const after = { appointment: current.appointment, resources: selected };
          const event = recordAllocation(
            req,
            before,
            after,
            'staff-allocation',
            input.reason,
            requestId,
          );
          remember(
            user,
            'allocate',
            appointmentId,
            requestId,
            input,
            event.id,
            null,
            appointmentId,
          );
          return appointmentContext(appointmentId);
        }),
      );
    });
    app.get('/api/resource-reservations', (req: AuthRequest, res) => {
      staff(req);
      const input = z
        .object({ from: date, to: date, resourceId: z.string().min(1).max(300).optional() })
        .strict()
        .refine(
          (value) => value.to >= value.from && value.to <= addDays(value.from, 30),
          'Choose an ordered date range of at most 31 days.',
        )
        .parse(req.query);
      res.json(
        transaction(() => {
          if (input.resourceId) resourceDetail(input.resourceId);
          const rows = db
            .prepare(
              'SELECT data FROM resourceReservations WHERE startAt>=? AND startAt<? ORDER BY startAt,resourceId,appointmentId',
            )
            .all(epoch(input.from, '00:00'), epoch(addDays(input.to, 1), '00:00'))
            .map((row) => JSON.parse(row.data as string) as ResourceReservation)
            .filter((entry) => !input.resourceId || entry.resource.id === input.resourceId);
          audit(req, 'viewed resource reservation diary', 'resource', input.resourceId ?? 'all');
          return { from: input.from, to: input.to, timezone: 'Asia/Kolkata', reservations: rows };
        }),
      );
    });
  }
  return {
    register,
    appointmentChanged,
    availableForAppointment,
    availableSlotsForAppointment,
    previewAppointmentMoves,
    applyAppointmentMoves,
  };
}
