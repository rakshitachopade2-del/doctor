/** Isolated Playwright startup data; never loaded by the application server. */
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../server/app.ts';
import { addDays, clinicToday, type DB } from '../../server/db.ts';
import type { Appointment, Doctor } from '../../shared/types.ts';
import type {
  ResourceAllocationEvent,
  ResourceChange,
  ResourceMetadata,
  ResourceAppointment,
  ResourceSnapshot,
} from '../../shared/clinic-resources.ts';

const path = process.env.DATABASE_PATH;
if (
  process.env.NODE_ENV !== 'test' ||
  process.env.DEMO_MODE !== 'true' ||
  process.env.E2E_APPOINTMENT_STATE_FIXTURES !== '1' ||
  !path ||
  basename(path) !== 'clinic.sqlite' ||
  !basename(realpathSync(dirname(path))).startsWith('derma-browser-') ||
  existsSync(path)
)
  throw new Error('Appointment state fixtures require a new isolated browser database.');

const app = createApp({ databasePath: path, demoMode: true, production: false });
const db = app.locals.db as DB;
const createdAt = new Date(Date.now() - 3 * 86400000).toISOString();
const author = {
  createdById: 'user-admin',
  createdByName: 'Synthetic fixture administrator',
  createdByRole: 'admin' as const,
  createdAt,
};
const doctor: Doctor = {
  id: randomUUID(),
  name: 'Dr. Synthetic State Review',
  title: 'Dermatologist',
  qualifications: 'Synthetic test profile',
  specialties: ['General dermatology'],
  experience: 5,
  fee: 650,
  bio: 'Isolated browser test data.',
  languages: ['English'],
  color: '#b3c7aa',
};
function reserve(appointment: Appointment) {
  const id = randomUUID();
  const metadata: ResourceMetadata = {
    name: `PRIVATE synthetic state room ${appointment.reason}`,
    kind: 'room',
    capacity: 1,
    location: 'PRIVATE operations fixture',
    notes: 'PRIVATE synthetic reservation notes',
    active: true,
  };
  db.prepare('INSERT INTO clinicResources(id,data) VALUES (?,?)').run(
    id,
    JSON.stringify({ id, createdAt }),
  );
  db.prepare('INSERT INTO resourceNames(resourceId,nameKey) VALUES (?,?)').run(
    id,
    metadata.name.toLowerCase(),
  );
  const change: ResourceChange = {
    id: randomUUID(),
    resourceId: id,
    requestId: randomUUID(),
    before: null,
    after: metadata,
    reason: 'PRIVATE startup resource fixture',
    ...author,
  };
  db.prepare('INSERT INTO resourceChanges(id,resourceId,data) VALUES (?,?,?)').run(
    change.id,
    id,
    JSON.stringify(change),
  );
  const resource: ResourceSnapshot = {
    id,
    name: metadata.name,
    kind: metadata.kind,
    location: metadata.location,
  };
  const visit: ResourceAppointment = {
    id: appointment.id,
    patientId: appointment.patientId,
    patientName: appointment.patientName,
    doctorId: appointment.doctorId,
    doctorName: appointment.doctorName,
    date: appointment.date,
    time: appointment.time,
    mode: appointment.mode,
    durationMinutes: appointment.durationMinutes!,
    status: appointment.status,
  };
  const event: ResourceAllocationEvent = {
    id: randomUUID(),
    appointmentId: appointment.id,
    source: 'staff-allocation',
    before: { appointment: visit, resources: [] },
    after: { appointment: visit, resources: [resource] },
    reason: 'PRIVATE historical reservation fixture',
    requestId: randomUUID(),
    ...author,
  };
  db.prepare('INSERT INTO resourceAllocationEvents(id,appointmentId,data) VALUES (?,?,?)').run(
    event.id,
    appointment.id,
    JSON.stringify(event),
  );
  db.prepare('INSERT INTO resourceEventLinks(resourceId,eventId) VALUES (?,?)').run(id, event.id);
  const startAt = Date.parse(`${visit.date}T${visit.time}:00+05:30`);
  db.prepare(
    'INSERT INTO resourceReservations(appointmentId,resourceId,startAt,endAt,data) VALUES (?,?,?,?,?)',
  ).run(
    appointment.id,
    id,
    startAt,
    startAt + visit.durationMinutes * 60000,
    JSON.stringify({ resource, appointment: visit }),
  );
}
db.exec('BEGIN IMMEDIATE');
try {
  db.prepare('INSERT INTO doctors(id,data) VALUES (?,?)').run(doctor.id, JSON.stringify(doctor));
  const rows: Array<{
    tag: string;
    time: string;
    date?: string;
    status?: Appointment['status'];
    resources?: boolean;
  }> = [
    { tag: 'progression', time: '00:00', resources: true },
    { tag: 'no-show', time: '01:00', resources: true },
    { tag: 'retry', time: '02:00', resources: true },
    { tag: 'stale', time: '03:00', resources: true },
    { tag: 'navigation', time: '04:00' },
    { tag: 'read-navigation', time: '05:00' },
    { tag: 'already-started', time: '06:00', status: 'in-consultation' },
    { tag: 'future', time: '09:00', date: addDays(clinicToday(), 10) },
    { tag: 'same-day', time: '23:45', date: clinicToday() },
  ];
  for (const row of rows) {
    const visit: Appointment = {
      id: randomUUID(),
      patientId: 'patient-ananya',
      patientName: 'Ananya Sharma',
      doctorId: doctor.id,
      doctorName: doctor.name,
      date: row.date ?? addDays(clinicToday(), -1),
      time: row.time,
      mode: 'in-person',
      status: row.status ?? 'scheduled',
      fee: doctor.fee,
      durationMinutes: 15,
      durationPolicy: 'schedule',
      reason: `E2E state ${row.tag}`,
      createdAt,
    };
    db.prepare(
      'INSERT INTO appointments(id,patientId,doctorId,date,time,status,data) VALUES (?,?,?,?,?,?,?)',
    ).run(
      visit.id,
      visit.patientId,
      visit.doctorId,
      visit.date,
      visit.time,
      visit.status,
      JSON.stringify(visit),
    );
    if (row.resources) reserve(visit);
  }
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
} finally {
  app.locals.close();
}
