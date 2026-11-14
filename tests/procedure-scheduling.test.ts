import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { SQLInputValue } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.ts';
import {
  addDays,
  clinicToday,
  createUser,
  get,
  openDatabase,
  seedDemo,
  type DB,
} from '../server/db.ts';
import type { Appointment } from '../shared/types.ts';
import type { ProcedureRecord } from '../shared/clinical.ts';
import type {
  ProcedureAppointmentCandidate,
  ProcedureScheduleContext,
  ProcedureScheduleMutation,
} from '../shared/procedure-scheduling.ts';

const app = createApp({ databasePath: ':memory:', demoMode: true });
type Client = { cookie?: string; csrf?: string; id?: string };
const admin: Client = {},
  doctor: Client = {},
  reception: Client = {},
  patient: Client = {},
  temporary: Client = {};
let server: Server, base: string, doctorId: string;
let sequence = 25;
const future = () => addDays(clinicToday(), ++sequence);
const privateClinical = 'PRIVATE_CLINICAL_DISCUSSION_739';
const privateReason = 'PRIVATE_OPERATIONAL_REASON_192';
async function call(
  path: string,
  client: Client = admin,
  method = 'GET',
  body?: unknown,
  target = base,
) {
  const response = await fetch(`${target}/api${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(client.cookie ? { Cookie: client.cookie } : {}),
      ...(client.csrf ? { 'X-CSRF-Token': client.csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const cookie = response.headers.get('set-cookie');
  if (cookie) client.cookie = cookie.split(';')[0];
  const data = await response.json();
  if (data.csrfToken) client.csrf = data.csrfToken;
  if (data.user?.id) client.id = data.user.id;
  return { status: response.status, data, headers: response.headers };
}
async function listen(application: ReturnType<typeof createApp>) {
  let server: Server;
  await new Promise<void>((resolve) => {
    server = application.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server!.address();
  assert.ok(address && typeof address !== 'string');
  return { server: server!, base: `http://127.0.0.1:${address.port}` };
}
async function close(server: Server) {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
async function plan(overrides: Record<string, unknown> = {}): Promise<ProcedureRecord> {
  const result = await call('/procedures', doctor, 'POST', {
    patientId: 'patient-ananya',
    title: `Synthetic procedure ${randomUUID()}`,
    indication: privateClinical,
    benefits: privateClinical,
    risks: privateClinical,
    alternatives: privateClinical,
    aftercare: privateClinical,
    estimatedCost: privateClinical,
    ...overrides,
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data;
}
async function book(overrides: Record<string, unknown> = {}): Promise<Appointment> {
  const result = await call('/visit-duration/bookings', reception, 'POST', {
    patientId: 'patient-ananya',
    doctorId,
    date: future(),
    time: '09:05',
    mode: 'in-person',
    reason: 'PRIVATE_APPOINTMENT_REASON',
    durationMinutes: 90,
    requestId: randomUUID(),
    ...overrides,
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data.appointment;
}
async function context(id: string, client = reception): Promise<ProcedureScheduleContext> {
  const result = await call(`/procedures/${id}/scheduling`, client);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data;
}
async function candidate(
  procedureId: string,
  appointment: Appointment,
): Promise<ProcedureAppointmentCandidate> {
  const result = await call(
    `/procedures/${procedureId}/scheduling/candidates?from=${appointment.date}&to=${appointment.date}&pageSize=50`,
    reception,
  );
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const found = result.data.items.find(
    (row: ProcedureAppointmentCandidate) => row.appointment.id === appointment.id,
  );
  assert.ok(found, JSON.stringify(result.data));
  return found;
}
async function command(
  procedureId: string,
  appointment: Appointment | null,
  fields: Record<string, unknown> = {},
) {
  return {
    appointmentId: appointment?.id ?? null,
    expectedAppointmentRevision: appointment
      ? (await candidate(procedureId, appointment)).revision
      : null,
    expectedRevision: (await context(procedureId)).revision,
    requestId: randomUUID(),
    reason: privateReason,
    ...(appointment ? {} : { removeConfirmed: true }),
    ...fields,
  };
}
async function link(
  procedureId: string,
  appointment: Appointment,
  client = reception,
): Promise<ProcedureScheduleMutation> {
  const result = await call(
    `/procedures/${procedureId}/scheduling`,
    client,
    'POST',
    await command(procedureId, appointment),
  );
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data;
}
function fixture(overrides: Partial<Appointment> = {}, application = app): Appointment {
  const value: Appointment = {
    id: randomUUID(),
    patientId: 'patient-ananya',
    patientName: 'Synthetic patient',
    doctorId,
    doctorName: 'Synthetic scheduling clinician',
    date: overrides.date ?? future(),
    time: '09:00',
    mode: 'in-person',
    status: 'scheduled',
    fee: 500,
    reason: 'PRIVATE_APPOINTMENT_REASON',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
  application.locals.db
    .prepare(
      'INSERT INTO appointments(id,patientId,doctorId,date,time,status,data) VALUES (?,?,?,?,?,?,?)',
    )
    .run(
      value.id,
      value.patientId,
      value.doctorId,
      value.date,
      value.time,
      value.status,
      JSON.stringify(value),
    );
  return value;
}
function updateAppointment(visit: Appointment, fields: Partial<Appointment>) {
  const updated = { ...visit, ...fields };
  app.locals.db
    .prepare('UPDATE appointments SET doctorId=?,date=?,time=?,status=?,data=? WHERE id=?')
    .run(
      updated.doctorId,
      updated.date,
      updated.time,
      updated.status,
      JSON.stringify(updated),
      updated.id,
    );
  return updated;
}
function counts() {
  return Object.fromEntries(
    [
      'procedureScheduleEvents',
      'procedureScheduleCommands',
      'appointments',
      'procedures',
      'procedureCompletions',
      'audit',
      'activity',
    ].map((table) => [table, app.locals.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n]),
  );
}
async function agree(procedureId: string) {
  assert.equal(
    (
      await call(`/procedures/${procedureId}/agreements`, patient, 'POST', {
        decision: 'agreed',
        method: 'portal',
        note: 'PRIVATE_AGREEMENT_NOTE',
      })
    ).status,
    201,
  );
}
const complete = (procedureId: string) =>
  call(`/procedures/${procedureId}/complete`, doctor, 'POST', {
    outcome: 'Recorded outcome',
    aftercare: 'Recorded instructions',
  });
before(async () => {
  createUser(
    app.locals.db,
    {
      id: 'procedure-scheduling-temporary',
      name: 'Temporary staff',
      email: 'procedure-scheduling-temp@example.test',
      role: 'admin',
      mustChangePassword: true,
    },
    'TemporarySchedule2026!',
  );
  ({ server, base } = await listen(app));
  for (const [role, client] of [
    ['admin', admin],
    ['doctor', doctor],
    ['reception', reception],
    ['patient', patient],
  ] as const)
    assert.equal(
      (
        await call('/auth/login', client, 'POST', {
          email: `${role}@derma.demo`,
          password: 'DemoClinic2026!',
        })
      ).status,
      200,
    );
  assert.equal(
    (
      await call('/auth/login', temporary, 'POST', {
        email: 'procedure-scheduling-temp@example.test',
        password: 'TemporarySchedule2026!',
      })
    ).status,
    200,
  );
  const created = await call('/doctors', admin, 'POST', {
    name: 'Dr. Procedure Scheduling',
    title: 'Dermatologist',
    qualifications: 'Synthetic profile',
    specialties: ['General dermatology'],
    experience: 2,
    fee: 600,
    bio: 'Synthetic scheduling fixture',
    languages: ['English'],
    color: '#b3c7aa',
  });
  assert.equal(created.status, 201);
  doctorId = created.data.id;
  assert.equal(
    (
      await call(`/schedules/${doctorId}`, admin, 'PUT', {
        durationMinutes: 20,
        windows: Array.from({ length: 7 }, (_, day) => ({
          day,
          start: '09:00',
          end: '18:00',
          mode: 'both',
        })),
      })
    ).status,
    200,
  );
});
after(async () => {
  await close(server);
  app.locals.close();
});

test('attaching, replacing and explicitly removing preserves original plan and complete immutable operational history', async () => {
  const original = await book(),
    next = await book(),
    procedure = await plan({ appointmentId: original.id });
  const stored = get(app.locals.db, 'procedures', procedure.id);
  const initial = await context(procedure.id);
  assert.equal(initial.procedure.originalAppointmentId, original.id);
  assert.equal(initial.procedure.effectiveAppointmentId, original.id);
  assert.deepEqual(initial.history, []);
  const changed = await link(procedure.id, next);
  assert.equal(changed.event.operation, 'replace');
  assert.equal(changed.event.createdById, reception.id);
  assert.equal(changed.event.beforeAppointmentId, original.id);
  assert.equal(changed.event.afterAppointmentId, next.id);
  assert.equal(changed.context.procedure.originalAppointmentId, original.id);
  const removed = await call(
    `/procedures/${procedure.id}/scheduling`,
    reception,
    'POST',
    await command(procedure.id, null),
  );
  assert.equal(removed.status, 200);
  assert.equal(removed.data.event.operation, 'unlink');
  assert.equal(removed.data.context.procedure.effectiveAppointmentId, null);
  assert.equal(removed.data.context.procedure.appointment, null);
  assert.equal(removed.data.context.procedure.schedulingState, 'unlinked');
  assert.equal(removed.data.context.history[0].id, removed.data.event.id);
  const attached = await link(procedure.id, next, doctor);
  assert.equal(attached.event.operation, 'attach');
  assert.deepEqual(get(app.locals.db, 'procedures', procedure.id), stored);
  assert.deepEqual(get(app.locals.db, 'appointments', original.id), original);
  assert.deepEqual(get(app.locals.db, 'appointments', next.id), next);
});

test('patient workflow and summary expose effective link only; reception scheduling projections omit clinical content and fees', async () => {
  const procedure = await plan(),
    visit = await book();
  await agree(procedure.id);
  const saved = await link(procedure.id, visit);
  for (const endpoint of [
    '/procedure-scheduling?status=all',
    `/procedures/${procedure.id}/scheduling`,
    `/procedures/${procedure.id}/scheduling/candidates`,
  ]) {
    const result = await call(endpoint, reception);
    assert.equal(result.status, 200);
    assert.match(result.headers.get('cache-control')!, /no-store/);
    const data = JSON.stringify(result.data);
    for (const privateValue of [
      privateClinical,
      'PRIVATE_AGREEMENT_NOTE',
      'PRIVATE_APPOINTMENT_REASON',
    ])
      assert.ok(!data.includes(privateValue));
    assert.ok(!data.includes('"fee"'));
    assert.ok(!data.includes('"risks"'));
    assert.ok(!data.includes('"agreements"'));
  }
  for (const endpoint of [
    '/patients/patient-ananya/clinical-workflows',
    '/patients/patient-ananya/care-summary',
  ]) {
    const result = await call(endpoint, patient);
    assert.equal(result.status, 200);
    const item = result.data.procedures.find((value: ProcedureRecord) => value.id === procedure.id);
    assert.equal(item.appointmentId, null);
    assert.equal(item.effectiveAppointmentId, visit.id);
    assert.deepEqual(item.scheduledAppointment, saved.event.afterAppointment);
    assert.ok(!JSON.stringify(result.data).includes(privateReason));
    assert.ok(!JSON.stringify(result.data).includes(saved.context.revision));
    assert.equal('history' in item, false);
  }
  const notification = app.locals.db
    .prepare('SELECT data FROM activity WHERE eventKey=?')
    .get(`procedure-scheduling:${saved.event.id}`);
  assert.ok(notification);
  assert.ok(!(notification.data as string).includes(privateReason));
});

test('patients, anonymous and forced-password sessions cannot access staff scheduling routes or mutations', async () => {
  const procedure = await plan(),
    visit = await book(),
    body = await command(procedure.id, visit);
  for (const [client, status] of [
    [patient, 403],
    [temporary, 403],
    [{}, 401],
  ] as const) {
    for (const path of [
      '/procedure-scheduling',
      `/procedures/${procedure.id}/scheduling`,
      `/procedures/${procedure.id}/scheduling/candidates`,
    ])
      assert.equal((await call(path, client)).status, status);
    assert.equal(
      (await call(`/procedures/${procedure.id}/scheduling`, client, 'POST', body)).status,
      status,
    );
  }
  assert.equal((await call('/procedures/missing/scheduling', reception)).status, 404);
  assert.equal((await call('/procedures/missing/scheduling/candidates', reception)).status, 404);
  const noCsrf = { cookie: reception.cookie };
  assert.equal(
    (await call(`/procedures/${procedure.id}/scheduling`, noCsrf, 'POST', body)).status,
    403,
  );
});

test('strict queries, date bounds, pagination choices and explicit removal confirmation are enforced', async () => {
  const procedure = await plan(),
    visit = await book(),
    body = await command(procedure.id, visit);
  for (const query of [
    'page=0',
    'page=1000001',
    'pageSize=100',
    'pageSize=10&pageSize=25',
    'status=unknown',
    'booking=urgent',
    'search=a&search=b',
    'unknown=yes',
  ])
    assert.equal((await call(`/procedure-scheduling?${query}`)).status, 400, query);
  for (const query of [
    `from=${addDays(clinicToday(), -1)}`,
    `to=${addDays(clinicToday(), 181)}`,
    `from=${addDays(clinicToday(), 2)}&to=${clinicToday()}`,
    'from=2026-02-30',
    'pageSize=20',
    'to=x&to=y',
    'unknown=yes',
  ])
    assert.equal(
      (await call(`/procedures/${procedure.id}/scheduling/candidates?${query}`)).status,
      400,
      query,
    );
  assert.equal((await call(`/procedures/${procedure.id}/scheduling?unknown=yes`)).status, 400);
  for (const fields of [
    { removeConfirmed: true },
    { expectedAppointmentRevision: null },
    { reason: '' },
    { extra: true },
    { requestId: 'bad' },
  ])
    assert.equal(
      (
        await call(`/procedures/${procedure.id}/scheduling`, reception, 'POST', {
          ...body,
          ...fields,
        })
      ).status,
      400,
    );
  await link(procedure.id, visit);
  const removal = await command(procedure.id, null);
  assert.equal(
    (
      await call(`/procedures/${procedure.id}/scheduling`, reception, 'POST', {
        ...removal,
        removeConfirmed: undefined,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call(`/procedures/${procedure.id}/scheduling`, reception, 'POST', {
        ...removal,
        expectedAppointmentRevision: body.expectedAppointmentRevision,
      })
    ).status,
    400,
  );
  const same = {
    ...body,
    expectedRevision: (await context(procedure.id)).revision,
    requestId: randomUUID(),
  };
  assert.equal(
    (await call(`/procedures/${procedure.id}/scheduling`, reception, 'POST', same)).status,
    400,
  );
});

test('candidates are same-patient future scheduled visits, exclude current link, and expose default/custom lengths safely', async () => {
  const procedure = await plan(),
    visit = await book();
  await link(procedure.id, visit);
  const date = future(),
    legacy = fixture({ date, time: '09:00' }),
    custom = await book({ date, time: '12:05', mode: 'online' });
  fixture({ date, time: '10:00', status: 'cancelled' });
  fixture({ date, time: '10:30', status: 'no-show' });
  fixture({ date, time: '11:00', status: 'checked-in' });
  fixture({ date, time: '11:30', patientId: 'patient-2' });
  const result = await call(
    `/procedures/${procedure.id}/scheduling/candidates?from=${date}&to=${date}`,
  );
  assert.equal(result.status, 200);
  assert.equal(result.data.from, date);
  assert.equal(result.data.to, date);
  assert.deepEqual(
    result.data.items.map((item: ProcedureAppointmentCandidate) => item.appointment.id),
    [legacy.id, custom.id],
  );
  assert.equal(result.data.items[0].appointment.durationMinutes, 30);
  assert.equal(result.data.items[0].appointment.durationPolicy, 'schedule');
  assert.equal(result.data.items[1].appointment.durationMinutes, 90);
  assert.equal(result.data.items[1].appointment.durationPolicy, 'custom');
  const currentDate = await call(
    `/procedures/${procedure.id}/scheduling/candidates?from=${visit.date}&to=${visit.date}`,
  );
  assert.ok(
    !currentDate.data.items.some(
      (item: ProcedureAppointmentCandidate) => item.appointment.id === visit.id,
    ),
  );
});

test('cancelled, no-show and missing current links can be repaired; started/completed visits and terminal procedures are read-only', async () => {
  for (const status of ['cancelled', 'no-show'] as const) {
    const visit = await book(),
      procedure = await plan({ appointmentId: visit.id });
    updateAppointment(visit, { status });
    const current = await context(procedure.id);
    assert.equal(current.procedure.canChange, true);
    assert.equal(current.procedure.schedulingState, 'attention');
    assert.equal((await link(procedure.id, await book())).event.operation, 'replace');
  }
  const missing = await plan();
  // Immutable legacy fixtures may reference a visit absent from older data.
  const source = get<ProcedureRecord>(app.locals.db, 'procedures', missing.id)!;
  const legacyId = randomUUID();
  app.locals.db
    .prepare('INSERT INTO procedures(id,patientId,data) VALUES (?,?,?)')
    .run(
      legacyId,
      source.patientId,
      JSON.stringify({ ...source, id: legacyId, appointmentId: 'legacy-missing-visit' }),
    );
  const absent = await context(legacyId);
  assert.equal(absent.procedure.canChange, true);
  assert.equal(absent.procedure.appointment, null);
  assert.equal((await link(legacyId, await book())).event.operation, 'replace');
  for (const fields of [
    { status: 'checked-in' },
    { status: 'in-consultation' },
    { status: 'completed' },
    { date: addDays(clinicToday(), -1) },
  ] as Partial<Appointment>[]) {
    const visit = await book(),
      procedure = await plan({ appointmentId: visit.id });
    updateAppointment(visit, fields);
    const current = await context(procedure.id);
    assert.equal(current.procedure.canChange, false);
    assert.ok(current.procedure.blockedReason);
    assert.equal(
      (
        await call(
          `/procedures/${procedure.id}/scheduling`,
          reception,
          'POST',
          await command(procedure.id, null),
        )
      ).status,
      409,
    );
  }
  const cancelled = await plan();
  await call(`/procedures/${cancelled.id}/cancel`, doctor, 'POST', { reason: 'Cancelled plan' });
  assert.equal((await context(cancelled.id)).procedure.canChange, false);
  const completed = await plan();
  await agree(completed.id);
  assert.equal((await complete(completed.id)).status, 200);
  assert.equal((await context(completed.id)).procedure.canChange, false);
});

test('source and target stale revisions reject changes; agreement content does not alter operational revision', async () => {
  const procedure = await plan(),
    first = await book(),
    second = await book();
  const body = await command(procedure.id, first);
  await agree(procedure.id);
  assert.equal((await context(procedure.id)).revision, body.expectedRevision);
  assert.equal(
    (await call(`/appointments/${first.id}`, patient, 'PATCH', { time: '11:05' })).status,
    200,
  );
  assert.equal(
    (await call(`/procedures/${procedure.id}/scheduling`, reception, 'POST', body)).status,
    409,
  );
  const updated = get<Appointment>(app.locals.db, 'appointments', first.id)!;
  await link(procedure.id, updated);
  const replacement = await command(procedure.id, second);
  await call(`/appointments/${first.id}`, patient, 'PATCH', { time: '13:05' });
  assert.equal(
    (await call(`/procedures/${procedure.id}/scheduling`, reception, 'POST', replacement)).status,
    409,
  );
  const wrongPatient = await book({ patientId: 'patient-2' });
  assert.equal(
    (
      await call(`/procedures/${procedure.id}/scheduling`, reception, 'POST', {
        ...replacement,
        appointmentId: wrongPatient.id,
        expectedRevision: (await context(procedure.id)).revision,
        expectedAppointmentRevision: '0'.repeat(64),
        requestId: randomUUID(),
      })
    ).status,
    400,
  );
  const futureBody = await command(procedure.id, second);
  updateAppointment(second, { status: 'cancelled' });
  assert.equal(
    (await call(`/procedures/${procedure.id}/scheduling`, reception, 'POST', futureBody)).status,
    409,
  );
});

test('canonical UUID replay is actor, procedure and full-payload bound and survives procedure cancellation', async () => {
  const procedure = await plan(),
    visit = await book(),
    body = await command(procedure.id, visit);
  const saved = await call(`/procedures/${procedure.id}/scheduling`, reception, 'POST', {
    ...body,
    requestId: body.requestId.toUpperCase(),
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.event.requestId, body.requestId);
  const before = counts();
  const retry = await call(`/procedures/${procedure.id}/scheduling`, reception, 'POST', body);
  assert.deepEqual(retry.data, saved.data);
  assert.deepEqual(counts(), before);
  assert.equal(
    (await call(`/procedures/${procedure.id}/scheduling`, admin, 'POST', body)).status,
    409,
  );
  for (const fields of [
    { reason: 'Changed reason' },
    { expectedRevision: '0'.repeat(64) },
    { expectedAppointmentRevision: '0'.repeat(64) },
  ])
    assert.equal(
      (
        await call(`/procedures/${procedure.id}/scheduling`, reception, 'POST', {
          ...body,
          ...fields,
        })
      ).status,
      409,
    );
  const other = await plan();
  assert.equal(
    (await call(`/procedures/${other.id}/scheduling`, reception, 'POST', body)).status,
    409,
  );
  await call(`/procedures/${procedure.id}/cancel`, doctor, 'POST', { reason: 'Stopped plan' });
  const terminal = counts();
  const later = await call(`/procedures/${procedure.id}/scheduling`, reception, 'POST', body);
  assert.equal(later.status, 200);
  assert.equal(later.data.context.procedure.status, 'cancelled');
  assert.deepEqual(later.data.event, saved.data.event);
  assert.deepEqual(counts(), terminal);
});

test('multiple plans may share one visit, while linking/removal preserves reservations, decisions and invoice originals', async () => {
  const original = await book(),
    next = await book(),
    first = await plan({ appointmentId: original.id }),
    second = await plan();
  await agree(first.id);
  const resource = await call('/clinic-resources', admin, 'POST', {
    name: 'Synthetic procedure room',
    kind: 'room',
    requestId: randomUUID(),
  });
  const resourceContext = await call(`/appointments/${original.id}/resources`);
  assert.equal(
    (
      await call(`/appointments/${original.id}/resources`, reception, 'PUT', {
        resourceIds: [resource.data.resource.id],
        reason: 'Operational fixture',
        expectedRevision: resourceContext.data.revision,
        requestId: randomUUID(),
      })
    ).status,
    200,
  );
  const invoice = await call('/invoices', reception, 'POST', {
    patientId: first.patientId,
    procedureId: first.id,
    requestId: randomUUID(),
    items: [{ description: 'Agreed synthetic charge', quantity: 1, unitAmountPaise: 50000 }],
  });
  assert.equal(invoice.status, 201);
  const sources = () => ({
    plan: get(app.locals.db, 'procedures', first.id),
    agreements: app.locals.db
      .prepare('SELECT * FROM procedureAgreements WHERE procedureId=?')
      .all(first.id),
    invoice: get(app.locals.db, 'invoices', invoice.data.id),
    billingLink: app.locals.db
      .prepare('SELECT * FROM procedureInvoiceLinks WHERE procedureId=?')
      .get(first.id),
    reservations: app.locals.db
      .prepare('SELECT * FROM resourceReservations WHERE appointmentId=?')
      .all(original.id),
    oldVisit: get(app.locals.db, 'appointments', original.id),
    newVisit: get(app.locals.db, 'appointments', next.id),
  });
  const before = sources();
  await link(first.id, next);
  await link(second.id, next);
  assert.equal(
    (
      await call(
        `/procedures/${first.id}/scheduling`,
        reception,
        'POST',
        await command(first.id, null),
      )
    ).status,
    200,
  );
  assert.deepEqual(sources(), before);
});

test('completion uses the effective visit rather than original link and stores an immutable actual-visit snapshot', async () => {
  const original = await book(),
    replacement = await book(),
    procedure = await plan({ appointmentId: original.id });
  await agree(procedure.id);
  const saved = await link(procedure.id, replacement);
  assert.equal((await complete(procedure.id)).status, 409);
  updateAppointment(replacement, { status: 'cancelled' });
  assert.equal((await complete(procedure.id)).status, 409);
  const completedDate = addDays(clinicToday(), -20);
  updateAppointment(replacement, { status: 'scheduled', date: completedDate });
  const completed = await complete(procedure.id);
  assert.equal(completed.status, 200, JSON.stringify(completed.data));
  assert.deepEqual(completed.data.completion.appointment, {
    ...saved.event.afterAppointment,
    date: completedDate,
  });
  const immutableCompletion = get(app.locals.db, 'procedureCompletions', procedure.id);
  assert.equal(
    (
      await call(`/appointments/${replacement.id}`, patient, 'PATCH', {
        date: future(),
        time: '14:05',
      })
    ).status,
    200,
  );
  assert.deepEqual(get(app.locals.db, 'procedureCompletions', procedure.id), immutableCompletion);
  const workflows = (await call('/patients/patient-ananya/clinical-workflows', patient)).data;
  const current = workflows.procedures.find((row: ProcedureRecord) => row.id === procedure.id);
  assert.equal(current.scheduledAppointment.time, '14:05');
  assert.equal(current.completion.appointment.time, '09:05');
  const retry = await call(`/procedures/${procedure.id}/scheduling`, reception, 'POST', {
    appointmentId: replacement.id,
    expectedAppointmentRevision: saved.event.expectedAppointmentRevision,
    expectedRevision: saved.event.expectedRevision,
    requestId: saved.event.requestId,
    reason: saved.event.reason,
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.data.context.procedure.status, 'completed');
  assert.deepEqual(retry.data.event, saved.event);
});

test('explicit removal does not restore original link; unlinked completion remains possible and legacy completions gain no invented snapshot', async () => {
  const visit = await book(),
    procedure = await plan({ appointmentId: visit.id });
  await agree(procedure.id);
  await call(
    `/procedures/${procedure.id}/scheduling`,
    reception,
    'POST',
    await command(procedure.id, null),
  );
  const completed = await complete(procedure.id);
  assert.equal(completed.status, 200);
  assert.equal(completed.data.appointmentId, visit.id);
  assert.equal(completed.data.effectiveAppointmentId, null);
  assert.equal(completed.data.completion.appointment, null);
  assert.equal(completed.data.scheduledAppointment, null);
  const legacy = await plan();
  app.locals.db.prepare('INSERT INTO procedureCompletions(id,data) VALUES (?,?)').run(
    legacy.id,
    JSON.stringify({
      outcome: 'Legacy outcome',
      aftercare: 'Legacy instructions',
      doctorId: 'doctor-meera',
      doctorName: 'Original clinician',
      completedAt: new Date().toISOString(),
    }),
  );
  const result = (
    await call('/patients/patient-ananya/clinical-workflows', patient)
  ).data.procedures.find((p: ProcedureRecord) => p.id === legacy.id);
  assert.equal('appointment' in result.completion, false);
});

test('simultaneous assignments and completion cannot produce an invalid mixed state', async () => {
  const procedure = await plan(),
    one = await book(),
    two = await book();
  const first = await command(procedure.id, one),
    second = await command(procedure.id, two);
  const results = await Promise.all([
    call(`/procedures/${procedure.id}/scheduling`, reception, 'POST', first),
    call(`/procedures/${procedure.id}/scheduling`, reception, 'POST', second),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  const another = await plan();
  await agree(another.id);
  const attach = await command(another.id, one);
  const mixed = await Promise.all([
    call(`/procedures/${another.id}/scheduling`, reception, 'POST', attach),
    complete(another.id),
  ]);
  assert.deepEqual(mixed.map((result) => result.status).sort(), [200, 409]);
  const current = await context(another.id);
  if (current.procedure.status === 'completed')
    assert.equal(current.procedure.effectiveAppointmentId, null);
  else {
    assert.equal(current.procedure.effectiveAppointmentId, one.id);
    assert.equal(get(app.locals.db, 'procedureCompletions', another.id), undefined);
  }
});

test('audit or patient notification failures roll back link events, receipts and all changes', async () => {
  for (const table of ['audit', 'activity']) {
    const procedure = await plan(),
      visit = await book(),
      body = await command(procedure.id, visit),
      before = counts();
    const condition =
      table === 'audit'
        ? "json_extract(NEW.data,'$.action')='procedure appointment attach'"
        : "NEW.eventKey LIKE 'procedure-scheduling:%'";
    app.locals.db.exec(
      `CREATE TRIGGER procedure_schedule_failure BEFORE INSERT ON ${table} WHEN ${condition} BEGIN SELECT RAISE(ABORT,'Synthetic scheduling rollback'); END;`,
    );
    try {
      assert.equal(
        (await call(`/procedures/${procedure.id}/scheduling`, reception, 'POST', body)).status,
        500,
      );
      assert.deepEqual(counts(), before);
    } finally {
      app.locals.db.exec('DROP TRIGGER procedure_schedule_failure');
    }
    assert.equal((await context(procedure.id)).procedure.effectiveAppointmentId, null);
    assert.equal(
      (await call(`/procedures/${procedure.id}/scheduling`, reception, 'POST', body)).status,
      200,
    );
  }
});

test('worklist classification, literal search and ordering do not search private notes and clamp empty/filter-shrunk pages', async () => {
  const title = `Literal %_\\ O'Brien ${randomUUID()}`;
  const unlinked = await plan({ title }),
    linkedVisit = await book(),
    linked = await plan({ title, appointmentId: linkedVisit.id });
  const closedVisit = await book(),
    attention = await plan({ title, appointmentId: closedVisit.id });
  updateAppointment(closedVisit, { status: 'cancelled' });
  const baseQuery = `/procedure-scheduling?search=${encodeURIComponent(title)}`;
  const all = await call(`${baseQuery}&page=999&pageSize=10`);
  assert.equal(all.status, 200);
  assert.equal(all.data.total, 3);
  assert.equal(all.data.page, 1);
  assert.deepEqual(
    new Set(all.data.items.map((row: { id: string }) => row.id)),
    new Set([unlinked.id, linked.id, attention.id]),
  );
  for (const [booking, expected] of [
    ['unlinked', unlinked.id],
    ['linked', linked.id],
    ['attention', attention.id],
  ])
    assert.equal((await call(`${baseQuery}&booking=${booking}`)).data.items[0].id, expected);
  assert.equal((await call(`/procedure-scheduling?search=${privateClinical}`)).data.total, 0);
  const empty = await call('/procedure-scheduling?search=NO_SUCH_PROCEDURE_SCHEDULE_919&page=99');
  assert.equal(empty.data.total, 0);
  assert.equal(empty.data.totalPages, 1);
  assert.equal(empty.data.page, 1);
  assert.deepEqual(empty.data.items, []);
  await call(`/procedures/${unlinked.id}/cancel`, doctor, 'POST', { reason: 'End fixture' });
  assert.equal((await call(`${baseQuery}&status=cancelled`)).data.items[0].id, unlinked.id);
});

test('immutable scheduling sources reject SQL updates/deletes and the database retains referential integrity', async () => {
  for (const table of ['procedureScheduleEvents', 'procedureScheduleCommands']) {
    assert.throws(
      () =>
        app.locals.db.exec(
          `UPDATE ${table} SET ${table === 'procedureScheduleEvents' ? 'data=data' : 'payload=payload'}`,
        ),
      /immutable/,
    );
    assert.throws(() => app.locals.db.exec(`DELETE FROM ${table}`), /immutable/);
  }
  assert.deepEqual(app.locals.db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(app.locals.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});

test('large worklist and candidate fixtures use bounded SQL projections and indexed candidate lookup before decoding', async (t) => {
  const db: DB = app.locals.db,
    scalePatient = 'patient-12',
    scalePrefix = `SCALE_${randomUUID()}`;
  const createdAt = new Date().toISOString(),
    start = future(),
    fixtureSize = 2500;
  db.exec('BEGIN');
  try {
    for (let index = 0; index < fixtureSize; index++) {
      const id = randomUUID();
      const source = {
        id,
        patientId: scalePatient,
        appointmentId: null,
        title: `${scalePrefix} ${index}`,
        doctorId,
        doctorName: 'Synthetic author',
        status: 'planned',
        cancellationReason: null,
        createdAt,
        indication: 'DO_NOT_DECODE_WHOLE_PLAN',
        risks: privateClinical,
        benefits: privateClinical,
        alternatives: privateClinical,
        aftercare: privateClinical,
        estimatedCost: privateClinical,
      };
      db.prepare('INSERT INTO procedures(id,patientId,data) VALUES (?,?,?)').run(
        id,
        scalePatient,
        JSON.stringify(source),
      );
      const minutes = index % 1000;
      fixture({
        patientId: scalePatient,
        doctorName: 'BOUNDED_CANDIDATE_DECODE',
        date: addDays(start, Math.floor(index / 1000)),
        time: `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`,
      });
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  let candidateDecodes = 0,
    sourceDecodes = 0;
  const parse = JSON.parse;
  const parseMock = t.mock.method(
    JSON,
    'parse',
    (value: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
      const parsed = parse(value, reviver);
      if (parsed?.doctorName === 'BOUNDED_CANDIDATE_DECODE' && parsed?.patientId === scalePatient)
        candidateDecodes++;
      if (parsed?.indication === 'DO_NOT_DECODE_WHOLE_PLAN') sourceDecodes++;
      return parsed;
    },
  );
  const captured: { sql: string; values: SQLInputValue[] }[] = [],
    prepare = db.prepare.bind(db);
  const prepareMock = t.mock.method(db, 'prepare', (sql: string) => {
    const statement = prepare(sql);
    if (sql.includes('LIMIT ? OFFSET ?')) {
      const all = statement.all.bind(statement);
      t.mock.method(statement, 'all', (...values: SQLInputValue[]) => {
        captured.push({ sql, values });
        return all(...values);
      });
    }
    return statement;
  });
  const list = await call(
    `/procedure-scheduling?search=${scalePrefix}&pageSize=10&page=2`,
    reception,
  );
  assert.equal(list.status, 200);
  assert.equal(list.data.total, fixtureSize);
  assert.equal(list.data.items.length, 10);
  assert.equal(sourceDecodes, 0);
  const procedureId = list.data.items[0].id;
  const candidates = await call(
    `/procedures/${procedureId}/scheduling/candidates?from=${start}&to=${addDays(start, 2)}&pageSize=10&page=2`,
    reception,
  );
  assert.equal(candidates.status, 200);
  assert.equal(candidates.data.total, fixtureSize);
  assert.equal(candidates.data.items.length, 10);
  assert.equal(candidateDecodes, 10);
  assert.equal(sourceDecodes, 0);
  prepareMock.mock.restore();
  parseMock.mock.restore();
  assert.equal(captured.length, 2);
  const candidateQuery = captured[1];
  const explain = db
    .prepare(`EXPLAIN QUERY PLAN ${candidateQuery.sql}`)
    .all(...candidateQuery.values);
  assert.match(explain.map((row) => row.detail).join(' '), /procedure_schedule_candidates/);
  assert.equal(captured[0].values.at(-2), 10);
  assert.equal(candidateQuery.values.at(-2), 10);
});

test('legacy migration preserves sources, explicit-null assignment and exact retries across restart', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'procedure-scheduling-')),
    databasePath = join(folder, 'clinic.sqlite');
  const legacy = openDatabase(databasePath);
  seedDemo(legacy);
  legacy.close();
  let application = createApp({ databasePath, demoMode: true }),
    running = await listen(application);
  const client: Client = {};
  try {
    await call(
      '/auth/login',
      client,
      'POST',
      { email: 'admin@derma.demo', password: 'DemoClinic2026!' },
      running.base,
    );
    assert.equal(
      application.locals.db.prepare('SELECT count(*) n FROM procedureScheduleEvents').get().n,
      0,
    );
    const visit = fixture({ doctorId: 'doctor-meera' }, application);
    const planned = await call(
      '/procedures',
      client,
      'POST',
      {
        patientId: visit.patientId,
        appointmentId: visit.id,
        title: 'Restart plan',
        indication: 'Recorded',
        benefits: 'Recorded',
        risks: 'Recorded',
        alternatives: 'Recorded',
        aftercare: 'Recorded',
      },
      running.base,
    );
    assert.equal(planned.status, 201);
    const source = await call(
      `/procedures/${planned.data.id}/scheduling`,
      client,
      'GET',
      undefined,
      running.base,
    );
    const body = {
      appointmentId: null,
      expectedAppointmentRevision: null,
      expectedRevision: source.data.revision,
      requestId: randomUUID(),
      reason: privateReason,
      removeConfirmed: true,
    };
    const saved = await call(
      `/procedures/${planned.data.id}/scheduling`,
      client,
      'POST',
      body,
      running.base,
    );
    assert.equal(saved.status, 200);
    await close(running.server);
    application.locals.close();
    application = createApp({ databasePath, demoMode: false });
    running = await listen(application);
    const retry = await call(
      `/procedures/${planned.data.id}/scheduling`,
      client,
      'POST',
      body,
      running.base,
    );
    assert.equal(retry.status, 200);
    assert.deepEqual(retry.data, saved.data);
    assert.equal(retry.data.context.procedure.originalAppointmentId, visit.id);
    assert.equal(retry.data.context.procedure.effectiveAppointmentId, null);
    assert.equal(
      application.locals.db.prepare('PRAGMA integrity_check').get().integrity_check,
      'ok',
    );
  } finally {
    await close(running.server);
    application.locals.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('context, candidate and worklist reads compose a coherent snapshot with their audit against an external writer', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'procedure-scheduling-snapshot-')),
    databasePath = join(folder, 'clinic.sqlite');
  const application = createApp({ databasePath, demoMode: true }),
    running = await listen(application),
    client: Client = {};
  const writer = openDatabase(databasePath);
  writer.exec('PRAGMA busy_timeout=0');
  try {
    await call(
      '/auth/login',
      client,
      'POST',
      { email: 'admin@derma.demo', password: 'DemoClinic2026!' },
      running.base,
    );
    const date = addDays(clinicToday(), 150);
    const visit = fixture({ doctorId: 'doctor-meera', date }, application);
    const planned = await call(
      '/procedures',
      client,
      'POST',
      {
        patientId: visit.patientId,
        title: 'Coherent scheduling snapshot',
        indication: 'Recorded',
        benefits: 'Recorded',
        risks: 'Recorded',
        alternatives: 'Recorded',
        aftercare: 'Recorded',
      },
      running.base,
    );
    assert.equal(planned.status, 201);
    const db: DB = application.locals.db,
      prepare = db.prepare.bind(db);
    const mutation = () =>
      writer
        .prepare('UPDATE appointments SET time=?,data=? WHERE id=?')
        .run('11:00', JSON.stringify({ ...visit, time: '11:00' }), visit.id);
    for (const [path, marker] of [
      [`/procedure-scheduling?search=Coherent`, 'SELECT count(*) total FROM source'],
      [
        `/procedures/${planned.data.id}/scheduling/candidates?from=${date}&to=${date}`,
        'SELECT count(*) total FROM appointments',
      ],
      [`/procedures/${planned.data.id}/scheduling`, 'SELECT * FROM source WHERE id=?'],
    ]) {
      let intercepted = false;
      const mock = t.mock.method(db, 'prepare', (sql: string) => {
        const statement = prepare(sql);
        if (sql.includes(marker)) {
          const read = statement.get.bind(statement);
          t.mock.method(statement, 'get', (...values: SQLInputValue[]) => {
            const value = read(...values);
            if (!intercepted) {
              assert.throws(mutation, /locked/);
              intercepted = true;
            }
            return value;
          });
        }
        return statement;
      });
      const result = await call(path, client, 'GET', undefined, running.base);
      assert.equal(result.status, 200);
      assert.equal(intercepted, true);
      if (path.includes('candidates')) {
        assert.equal(result.data.total, 1);
        assert.equal(result.data.items[0].appointment.time, '09:00');
      }
      mock.mock.restore();
    }
    mutation();
    const refreshed = await call(
      `/procedures/${planned.data.id}/scheduling/candidates?from=${date}&to=${date}`,
      client,
      'GET',
      undefined,
      running.base,
    );
    assert.equal(refreshed.data.items[0].appointment.time, '11:00');
    const count = db.prepare('SELECT count(*) n FROM audit').get()!.n;
    db.exec(
      "CREATE TRIGGER procedure_schedule_read_audit_failure BEFORE INSERT ON audit WHEN json_extract(NEW.data,'$.action') LIKE 'viewed procedure scheduling%' BEGIN SELECT RAISE(ABORT,'Synthetic scheduling read audit failure'); END;",
    );
    try {
      for (const path of [
        '/procedure-scheduling',
        `/procedures/${planned.data.id}/scheduling`,
        `/procedures/${planned.data.id}/scheduling/candidates`,
      ])
        assert.equal((await call(path, client, 'GET', undefined, running.base)).status, 500);
      assert.equal(db.prepare('SELECT count(*) n FROM audit').get()!.n, count);
    } finally {
      db.exec('DROP TRIGGER procedure_schedule_read_audit_failure');
    }
    mutation();
  } finally {
    writer.close();
    await close(running.server);
    application.locals.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
