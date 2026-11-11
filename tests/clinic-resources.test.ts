import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.ts';
import { addDays, clinicToday, createUser, get, openDatabase, seedDemo } from '../server/db.ts';
import type { Appointment, Doctor } from '../shared/types.ts';
import type { AppointmentResourceContext, ResourceDetail } from '../shared/clinic-resources.ts';

const app = createApp({ databasePath: ':memory:', demoMode: true });
type Client = { cookie?: string; csrf?: string; id?: string };
const admin: Client = {},
  doctor: Client = {},
  reception: Client = {},
  patient: Client = {},
  temporary: Client = {};
let server: Server, base: string, doctorA: string, doctorB: string;
let sequence = 20;
const futureDate = () => addDays(clinicToday(), ++sequence);
const allDays = Array.from({ length: 7 }, (_, day) => ({
  day,
  start: '09:00',
  end: '18:00',
  mode: 'both',
}));
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
  let instance: Server;
  await new Promise<void>((resolve) => {
    instance = application.listen(0, '127.0.0.1', () => resolve());
  });
  const address = instance!.address();
  assert.ok(address && typeof address !== 'string');
  return { server: instance!, base: `http://127.0.0.1:${address.port}` };
}
async function close(instance: Server) {
  await new Promise<void>((resolve, reject) =>
    instance.close((error) => (error ? reject(error) : resolve())),
  );
}
async function newDoctor(durationMinutes = 30) {
  const created = await call('/doctors', admin, 'POST', {
    name: `Dr. Resource ${randomUUID().slice(0, 8)}`,
    title: 'Dermatologist',
    qualifications: 'Synthetic profile',
    specialties: ['General dermatology'],
    experience: 2,
    fee: 600,
    bio: 'Synthetic resource fixture',
    languages: ['English'],
    color: '#b3c7aa',
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(
    (
      await call(`/schedules/${created.data.id}`, admin, 'PUT', {
        durationMinutes,
        windows: allDays,
      })
    ).status,
    200,
  );
  return created.data.id as string;
}
async function book(
  date = futureDate(),
  time = '09:00',
  doctorId = doctorA,
  patientId = 'patient-ananya',
): Promise<Appointment> {
  const result = await call('/appointments', reception, 'POST', {
    patientId,
    doctorId,
    date,
    time,
    mode: 'in-person',
    reason: 'Synthetic resource test',
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data;
}
function fixture(overrides: Partial<Appointment> = {}, application = app): Appointment {
  const value: Appointment = {
    id: randomUUID(),
    patientId: 'patient-ananya',
    patientName: 'Synthetic resource patient',
    doctorId: doctorA,
    doctorName: 'Synthetic clinician',
    date: futureDate(),
    time: '09:00',
    mode: 'in-person',
    status: 'scheduled',
    reason: 'Private appointment reason omitted from resource DTO',
    createdAt: new Date().toISOString(),
    durationMinutes: 30,
    fee: 600,
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
async function resource(fields: Record<string, unknown> = {}): Promise<ResourceDetail> {
  const result = await call('/clinic-resources', admin, 'POST', {
    name: `Resource ${randomUUID()}`,
    kind: 'room',
    requestId: randomUUID(),
    ...fields,
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data;
}
async function detail(id: string): Promise<ResourceDetail> {
  const result = await call(`/clinic-resources/${id}`);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data;
}
async function context(id: string): Promise<AppointmentResourceContext> {
  const result = await call(`/appointments/${id}/resources`);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data;
}
async function allocationBody(
  id: string,
  resourceIds: string[],
  overrides: Record<string, unknown> = {},
) {
  return {
    resourceIds,
    reason: 'Operational allocation',
    expectedRevision: (await context(id)).revision,
    requestId: randomUUID(),
    ...overrides,
  };
}
async function allocate(id: string, ids: string[], client = reception) {
  return call(`/appointments/${id}/resources`, client, 'PUT', await allocationBody(id, ids));
}
async function metadataBody(id: string, fields: Record<string, unknown>) {
  return {
    ...fields,
    reason: 'Catalogue correction',
    expectedRevision: (await detail(id)).resource.revision,
    requestId: randomUUID(),
  };
}
async function closureBody(id: string, date: string, fields: Record<string, unknown> = {}) {
  return {
    startDate: date,
    endDate: date,
    startTime: null,
    endTime: null,
    reason: 'Private equipment maintenance reason',
    expectedRevision: (await detail(id)).resource.revision,
    requestId: randomUUID(),
    ...fields,
  };
}
function sourceCounts() {
  return Object.fromEntries(
    [
      'clinicResources',
      'resourceChanges',
      'resourceClosures',
      'resourceClosureCancellations',
      'resourceAllocationEvents',
      'resourceEventLinks',
      'resourceReservations',
      'resourceCommands',
      'audit',
      'activity',
    ].map((table) => [table, app.locals.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n]),
  );
}
function auditFailure(action: string) {
  assert.match(action, /^[a-z -]+$/);
  app.locals.db.exec(
    `CREATE TRIGGER resource_test_audit_failure BEFORE INSERT ON audit WHEN json_extract(NEW.data,'$.action')='${action}' BEGIN SELECT RAISE(ABORT,'Synthetic resource audit failure'); END;`,
  );
  return () => app.locals.db.exec('DROP TRIGGER resource_test_audit_failure');
}
before(async () => {
  createUser(
    app.locals.db,
    {
      id: 'resource-temporary',
      name: 'Temporary administrator',
      email: 'resource-temp@example.test',
      role: 'admin',
      mustChangePassword: true,
    },
    'ResourceTemporary2026!',
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
        email: 'resource-temp@example.test',
        password: 'ResourceTemporary2026!',
      })
    ).status,
    200,
  );
  doctorA = await newDoctor();
  doctorB = await newDoctor();
});
after(async () => {
  await close(server);
  app.locals.close();
});

test('resources are staff-only, catalogue writes admin-only and all writes require CSRF', async () => {
  const appointment = await book(),
    created = await resource();
  for (const path of [
    '/clinic-resources',
    `/clinic-resources/${created.resource.id}`,
    `/appointments/${appointment.id}/resources`,
    `/resource-reservations?from=${appointment.date}&to=${appointment.date}`,
  ]) {
    assert.equal((await call(path, {})).status, 401);
    for (const client of [patient, temporary]) assert.equal((await call(path, client)).status, 403);
    for (const client of [doctor, reception, admin]) {
      const result = await call(path, client);
      assert.equal(result.status, 200);
      assert.equal(result.headers.get('cache-control'), 'no-store');
    }
  }
  const body = { name: 'Permission fixture', kind: 'room', requestId: randomUUID() };
  for (const client of [doctor, reception, patient, temporary])
    assert.equal((await call('/clinic-resources', client, 'POST', body)).status, 403);
  assert.equal(
    (await call('/clinic-resources', { cookie: admin.cookie }, 'POST', body)).status,
    403,
  );
  const input = await allocationBody(appointment.id, [created.resource.id]);
  assert.equal(
    (await call(`/appointments/${appointment.id}/resources`, patient, 'PUT', input)).status,
    403,
  );
  assert.equal(
    (
      await call(
        `/appointments/${appointment.id}/resources`,
        { cookie: reception.cookie },
        'PUT',
        input,
      )
    ).status,
    403,
  );
  assert.equal((await call('/clinic-resources?active=wrong')).status, 400);
  assert.equal((await call('/clinic-resources/missing')).status, 404);
});

test('catalogue retains attributed snapshots, canonical UUID receipts and unique immutable resource kinds', async () => {
  const requestId = randomUUID(),
    name = `Receipt ${randomUUID()}`;
  const input = {
    name,
    kind: 'equipment',
    location: 'Room A',
    notes: 'Operational note',
    requestId,
  };
  const created = await call('/clinic-resources', admin, 'POST', input);
  assert.equal(created.status, 201);
  const id = created.data.resource.id;
  assert.equal(created.data.resource.capacity, 1);
  assert.equal(created.data.changes.length, 1);
  assert.equal(created.data.changes[0].before, null);
  assert.equal(created.data.changes[0].requestId, requestId);
  assert.equal(created.data.changes[0].createdById, admin.id);
  for (const nameVariant of [name.toUpperCase(), name.replace('Receipt', 'Ｒｅｃｅｉｐｔ')])
    assert.equal(
      (
        await call('/clinic-resources', admin, 'POST', {
          ...input,
          name: nameVariant,
          requestId: randomUUID(),
        })
      ).status,
      409,
    );
  const change = await metadataBody(id, { name: `${name} renamed`, location: '' });
  const updated = await call(`/clinic-resources/${id}`, admin, 'PATCH', change);
  assert.equal(updated.status, 200);
  assert.equal(updated.data.changes.length, 2);
  assert.equal(updated.data.changes[0].before.name, name);
  assert.equal(updated.data.changes[0].requestId, change.requestId);
  const retry = await call('/clinic-resources', admin, 'POST', {
    ...input,
    requestId: requestId.toUpperCase(),
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.data.resource.id, id);
  assert.equal(retry.data.resource.name, `${name} renamed`);
  assert.equal(
    (
      await call(`/clinic-resources/${id}`, admin, 'PATCH', {
        ...change,
        expectedRevision: '0'.repeat(64),
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        `/clinic-resources/${id}`,
        admin,
        'PATCH',
        await metadataBody(id, { kind: 'room' }),
      )
    ).status,
    400,
  );
  assert.equal(
    (await call(`/clinic-resources/${id}`, admin, 'PATCH', await metadataBody(id, { capacity: 2 })))
      .status,
    400,
  );
  assert.equal(
    (
      await call(
        `/clinic-resources/${id}`,
        admin,
        'PATCH',
        await metadataBody(id, { name: `${name} renamed` }),
      )
    ).status,
    400,
  );
  assert.equal(
    (await call('/clinic-resources', admin, 'POST', { ...input, name: 'Different intent' })).status,
    409,
  );
});

test('allocation uses complete bounded sets with immutable actor receipts, safe DTOs and replay before stale state', async () => {
  const appointment = await book(),
    first = await resource(),
    second = await resource({ kind: 'equipment' });
  const before = await context(appointment.id),
    ids = [first.resource.id, second.resource.id];
  const body = await allocationBody(appointment.id, ids);
  const result = await call(`/appointments/${appointment.id}/resources`, reception, 'PUT', body);
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.resourceIds, [...ids].sort());
  assert.equal(result.data.history.length, 1);
  assert.equal(result.data.history[0].requestId, body.requestId);
  assert.equal(result.data.history[0].createdById, reception.id);
  assert.deepEqual(result.data.history[0].before.resources, []);
  assert.equal(result.data.history[0].after.appointment.durationMinutes, 30);
  assert.equal('reason' in result.data.appointment, false);
  assert.ok(
    result.data.resources
      .filter((entry: any) => ids.includes(entry.resource.id))
      .every((entry: any) => entry.available),
  );
  const retry = await call(`/appointments/${appointment.id}/resources`, reception, 'PUT', {
    ...body,
    resourceIds: [...ids].reverse(),
    expectedRevision: before.revision,
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.data.history.length, 1);
  assert.equal(
    (await call(`/appointments/${appointment.id}/resources`, doctor, 'PUT', body)).status,
    409,
  );
  assert.equal(
    (
      await call(`/appointments/${appointment.id}/resources`, reception, 'PUT', {
        ...body,
        reason: 'Different intent',
      })
    ).status,
    409,
  );
  assert.equal((await allocate(appointment.id, ids)).status, 400);
  for (const invalid of [
    [ids[0], ids[0]],
    Array(9)
      .fill('')
      .map(() => randomUUID()),
  ])
    assert.equal((await allocate(appointment.id, invalid)).status, 400);
  assert.equal((await allocate(appointment.id, ['missing-resource'])).status, 404);
  assert.deepEqual(get<Appointment>(app.locals.db, 'appointments', appointment.id), appointment);
  const patientAppointments = await call('/appointments', patient);
  const safe = patientAppointments.data.find((entry: Appointment) => entry.id === appointment.id);
  assert.ok(safe);
  assert.equal('resources' in safe, false);
  assert.equal(JSON.stringify(safe).includes(first.resource.name), false);
});

test('concurrent overlapping allocations produce one winner; adjacent 60 and 20 minute intervals fit exactly', async () => {
  const longDoctor = await newDoctor(60),
    shortDoctor = await newDoctor(20),
    date = futureDate();
  const long = await book(date, '09:00', longDoctor),
    overlap = await book(date, '09:40', shortDoctor, 'patient-2');
  const room = await resource();
  const bodies = await Promise.all([
    allocationBody(long.id, [room.resource.id]),
    allocationBody(overlap.id, [room.resource.id]),
  ]);
  const results = await Promise.all([
    call(`/appointments/${long.id}/resources`, reception, 'PUT', bodies[0]),
    call(`/appointments/${overlap.id}/resources`, reception, 'PUT', bodies[1]),
  ]);
  assert.deepEqual(results.map((entry) => entry.status).sort(), [200, 409]);
  const winner = results[0].status === 200 ? long : overlap;
  const adjacent = await book(date, '10:00', shortDoctor, 'patient-3');
  assert.equal((await allocate(adjacent.id, [room.resource.id])).status, 200);
  const claims = app.locals.db
    .prepare('SELECT startAt,endAt FROM resourceReservations WHERE resourceId=? ORDER BY startAt')
    .all(room.resource.id);
  assert.equal(claims.length, 2);
  assert.equal(Number(claims[0].endAt), Number(claims[1].startAt));
  const exact = await allocationBody(winner.id, []);
  const repeats = await Promise.all([
    call(`/appointments/${winner.id}/resources`, reception, 'PUT', exact),
    call(`/appointments/${winner.id}/resources`, reception, 'PUT', exact),
  ]);
  assert.deepEqual(
    repeats.map((entry) => entry.status),
    [200, 200],
  );
  assert.equal(
    (await context(winner.id)).history.filter((event) => event.requestId === exact.requestId)
      .length,
    1,
  );
});

test('patient reschedule slots omit resource overlaps and forced conflicts reveal no private details or partial moves', async () => {
  const date = futureDate(),
    longDoctor = await newDoctor(60),
    shortDoctor = await newDoctor(20);
  const own = await book(date, '09:00', longDoctor),
    other = await book(date, '10:40', shortDoctor, 'patient-2');
  const room = await resource({ name: `Secret room ${randomUUID()}` }),
    equipment = await resource({ kind: 'equipment' });
  assert.equal((await allocate(own.id, [room.resource.id, equipment.resource.id])).status, 200);
  assert.equal((await allocate(other.id, [room.resource.id])).status, 200);
  const path = `/slots?doctorId=${longDoctor}&date=${date}&mode=in-person&excludeAppointmentId=${own.id}`;
  const slots = await call(path, patient);
  assert.equal(slots.status, 200);
  assert.ok(slots.data.includes('09:00'));
  assert.ok(!slots.data.includes('10:00'));
  assert.ok(slots.data.includes('11:00'));
  const before = await context(own.id),
    counts = sourceCounts();
  const conflict = await call(`/appointments/${own.id}`, patient, 'PATCH', { time: '10:00' });
  assert.equal(conflict.status, 409);
  assert.match(conflict.data.error, /Assigned clinic resources are unavailable/);
  assert.equal(JSON.stringify(conflict.data).includes(room.resource.name), false);
  assert.deepEqual(sourceCounts(), counts);
  assert.deepEqual(await context(own.id), before);
  assert.deepEqual(get(app.locals.db, 'appointments', own.id), own);
  const moved = await call(`/appointments/${own.id}`, patient, 'PATCH', {
    time: '11:00',
    mode: 'online',
  });
  assert.equal(moved.status, 200);
  const after = await context(own.id);
  assert.deepEqual(after.resourceIds, before.resourceIds);
  assert.equal(after.history[0].source, 'appointment-rescheduled');
  assert.equal(after.history[0].createdById, patient.id);
  assert.equal(after.history[0].requestId, null);
  assert.equal(after.history[0].before.appointment.time, '09:00');
  assert.equal(after.history[0].after.appointment.mode, 'online');
  assert.equal(after.history[0].after.appointment.time, '11:00');
  const cancelled = await call(`/appointments/${own.id}`, patient, 'PATCH', {
    status: 'cancelled',
  });
  assert.equal(cancelled.status, 200);
  assert.deepEqual((await context(own.id)).resourceIds, []);
  assert.equal((await context(own.id)).history[0].after.resources.length, 0);
});

test('rescheduling adopts the current duration and protects all allocated intervals; clinician renames are reschedule events', async () => {
  const date = futureDate(),
    ownDoctor = await newDoctor(30),
    otherDoctor = await newDoctor(20);
  const own = await book(date, '09:00', ownDoctor),
    competing = await book(date, '10:40', otherDoctor, 'patient-2');
  const room = await resource();
  assert.equal((await allocate(own.id, [room.resource.id])).status, 200);
  assert.equal((await allocate(competing.id, [room.resource.id])).status, 200);
  assert.equal(
    (await call(`/schedules/${ownDoctor}`, admin, 'PUT', { durationMinutes: 60, windows: allDays }))
      .status,
    200,
  );
  assert.equal(
    (await call(`/appointments/${own.id}`, patient, 'PATCH', { time: '10:00' })).status,
    409,
  );
  const changed = await call(`/appointments/${own.id}`, patient, 'PATCH', { time: '11:00' });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.durationMinutes, 60);
  const profile = get<Doctor>(app.locals.db, 'doctors', ownDoctor)!;
  assert.equal(
    (
      await call(`/doctors/${ownDoctor}`, admin, 'PATCH', {
        ...profile,
        name: 'Dr. Renamed Resource',
      })
    ).status,
    200,
  );
  assert.equal(
    (await call(`/appointments/${own.id}`, patient, 'PATCH', { time: '11:00' })).status,
    200,
  );
  const current = await context(own.id);
  assert.equal(current.history[0].source, 'appointment-rescheduled');
  assert.equal(current.history[0].after.appointment.doctorName, 'Dr. Renamed Resource');
});

test('maintenance validates repeated real intervals, blocks allocation/reschedule, and cancellation retains immutable receipts', async () => {
  const created = await resource(),
    id = created.resource.id,
    date = futureDate();
  const malformed = [
    { startDate: '2026-02-30' },
    { endDate: addDays(date, -1) },
    { endDate: addDays(date, 366) },
    { startDate: addDays(clinicToday(), -1) },
    { endDate: addDays(clinicToday(), 366) },
    { startTime: '09:00' },
    { startTime: '25:00', endTime: '26:00' },
    { startTime: '18:00', endTime: '09:00' },
  ];
  for (const fields of malformed)
    assert.equal(
      (
        await call(
          `/clinic-resources/${id}/closures`,
          admin,
          'POST',
          await closureBody(id, date, fields),
        )
      ).status,
      400,
    );
  const body = await closureBody(id, date, {
    endDate: addDays(date, 1),
    startTime: '10:00',
    endTime: '11:00',
  });
  for (const client of [doctor, reception, patient])
    assert.equal(
      (await call(`/clinic-resources/${id}/closures`, client, 'POST', body)).status,
      403,
    );
  const closed = await call(`/clinic-resources/${id}/closures`, admin, 'POST', body);
  assert.equal(closed.status, 201);
  assert.equal(closed.data.closures[0].requestId, body.requestId);
  const visit = await book(addDays(date, 1), '10:00');
  assert.equal((await allocate(visit.id, [id])).status, 409);
  const adjacent = await book(date, '09:30');
  assert.equal((await allocate(adjacent.id, [id])).status, 200);
  const slots = await call(
    `/slots?doctorId=${doctorA}&date=${date}&mode=in-person&excludeAppointmentId=${adjacent.id}`,
    patient,
  );
  assert.ok(!slots.data.includes('10:00'));
  assert.ok(!slots.data.includes('10:30'));
  assert.ok(slots.data.includes('11:00'));
  const forced = await call(`/appointments/${adjacent.id}`, patient, 'PATCH', { time: '10:00' });
  assert.equal(forced.status, 409);
  assert.equal(JSON.stringify(forced.data).includes(body.reason), false);
  assert.equal((await call(`/clinic-resources/${id}/closures`, admin, 'POST', body)).status, 200);
  const cancellation = {
    reason: 'Maintenance no longer needed',
    expectedRevision: (await detail(id)).resource.revision,
    requestId: randomUUID(),
  };
  const path = `/clinic-resources/${id}/closures/${closed.data.closures[0].id}/cancel`;
  const cancelled = await call(path, admin, 'POST', cancellation);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.closures[0].cancellation.requestId, cancellation.requestId);
  assert.equal((await call(path, admin, 'POST', cancellation)).status, 200);
  assert.equal(
    (
      await call(path, admin, 'POST', {
        ...cancellation,
        expectedRevision: cancelled.data.resource.revision,
        requestId: randomUUID(),
      })
    ).status,
    409,
  );
  assert.equal((await allocate(visit.id, [id])).status, 200);
});

test('maintenance and archive never strand reservations and conflicts identify dates for staff', async () => {
  const visit = await book(),
    created = await resource(),
    id = created.resource.id;
  assert.equal((await allocate(visit.id, [id])).status, 200);
  const before = (await detail(id)).resource.revision;
  const maintenance = await call(
    `/clinic-resources/${id}/closures`,
    admin,
    'POST',
    await closureBody(id, visit.date),
  );
  assert.equal(maintenance.status, 409);
  assert.match(maintenance.data.error, new RegExp(visit.date));
  const archive = await call(
    `/clinic-resources/${id}`,
    admin,
    'PATCH',
    await metadataBody(id, { active: false }),
  );
  assert.equal(archive.status, 409);
  assert.match(archive.data.error, /09:00 IST/);
  assert.equal((await allocate(visit.id, [])).status, 200);
  const after = (await detail(id)).resource.revision;
  assert.notEqual(after, before);
  assert.equal(
    (
      await call(`/clinic-resources/${id}`, admin, 'PATCH', {
        ...(await metadataBody(id, { active: false })),
        expectedRevision: before,
      })
    ).status,
    409,
  );
  const archived = await call(
    `/clinic-resources/${id}`,
    admin,
    'PATCH',
    await metadataBody(id, { active: false }),
  );
  assert.equal(archived.status, 200);
  assert.equal(archived.data.changes.length, 2);
  assert.equal((await allocate(visit.id, [id])).status, 409);
  assert.ok(
    (await call('/clinic-resources?active=false')).data.some((entry: any) => entry.id === id),
  );
  assert.equal(
    (
      await call(
        `/clinic-resources/${id}`,
        admin,
        'PATCH',
        await metadataBody(id, { active: true }),
      )
    ).status,
    200,
  );
  assert.equal((await allocate(visit.id, [id])).status, 200);
});

test('context revisions react to competing allocations and releases while unrelated intervals do not stale a draft', async () => {
  const date = futureDate(),
    own = await book(date),
    other = await book(date, '09:00', doctorB, 'patient-2'),
    later = await book(date, '11:00', doctorB, 'patient-3');
  const room = await resource(),
    equipment = await resource({ kind: 'equipment' });
  const original = await context(own.id);
  assert.equal((await allocate(later.id, [room.resource.id])).status, 200);
  assert.equal((await context(own.id)).revision, original.revision);
  const beforeCompeting = await allocationBody(own.id, [equipment.resource.id]);
  assert.equal((await allocate(other.id, [room.resource.id])).status, 200);
  assert.notEqual((await context(own.id)).revision, original.revision);
  assert.equal(
    (await call(`/appointments/${own.id}/resources`, reception, 'PUT', beforeCompeting)).status,
    409,
  );
  const during = await context(own.id);
  assert.equal((await allocate(other.id, [])).status, 200);
  assert.notEqual((await context(own.id)).revision, during.revision);
  const renamed = await metadataBody(room.resource.id, { name: `Renamed ${randomUUID()}` });
  const beforeRename = (await context(own.id)).revision;
  assert.equal(
    (await call(`/clinic-resources/${room.resource.id}`, admin, 'PATCH', renamed)).status,
    200,
  );
  assert.notEqual((await context(own.id)).revision, beforeRename);
});

test('stale open visits can release but not add; no-show releases capacity with history and closed visits are read-only', async () => {
  const visit = await book(),
    room = await resource();
  assert.equal((await allocate(visit.id, [room.resource.id])).status, 200);
  const past = { ...visit, date: addDays(clinicToday(), -2) };
  // Simulate legacy stale open appointments without rewriting immutable allocation history.
  app.locals.db
    .prepare('UPDATE appointments SET date=?,data=? WHERE id=?')
    .run(past.date, JSON.stringify(past), visit.id);
  let current = await context(visit.id);
  assert.equal(current.canAllocate, false);
  assert.equal(current.canRelease, true);
  assert.equal(
    (
      await call(
        `/clinic-resources/${room.resource.id}`,
        admin,
        'PATCH',
        await metadataBody(room.resource.id, { active: false }),
      )
    ).status,
    409,
  );
  const second = await resource();
  assert.equal((await allocate(visit.id, [room.resource.id, second.resource.id])).status, 409);
  assert.equal((await allocate(visit.id, [])).status, 200);
  current = await context(visit.id);
  assert.equal(current.history[0].after.resources.length, 0);
  const other = await book(),
    another = await resource();
  assert.equal((await allocate(other.id, [another.resource.id])).status, 200);
  const otherPast = { ...other, date: addDays(clinicToday(), -3) };
  app.locals.db
    .prepare('UPDATE appointments SET date=?,data=? WHERE id=?')
    .run(otherPast.date, JSON.stringify(otherPast), other.id);
  assert.equal(
    (await call(`/appointments/${other.id}`, reception, 'PATCH', { status: 'no-show' })).status,
    200,
  );
  const ended = await context(other.id);
  assert.deepEqual(ended.resourceIds, []);
  assert.equal(ended.history[0].after.appointment.status, 'no-show');
  assert.equal(ended.canAllocate, false);
  assert.equal(ended.canRelease, false);
  assert.equal((await allocate(other.id, [another.resource.id])).status, 409);
});

test('ongoing allocations remain editable until scheduled end; completion keeps its recorded interval', async (t) => {
  const local = new Date(Date.now() + 330 * 60000),
    date = local.toISOString().slice(0, 10),
    time = local.toISOString().slice(11, 16);
  const visit = fixture({ date, time, status: 'checked-in', durationMinutes: 60 });
  const room = await resource();
  assert.equal((await allocate(visit.id, [room.resource.id])).status, 200);
  assert.equal(
    (await call(`/appointments/${visit.id}`, doctor, 'PATCH', { status: 'in-consultation' }))
      .status,
    200,
  );
  assert.equal(
    (await call(`/appointments/${visit.id}`, doctor, 'PATCH', { status: 'completed' })).status,
    200,
  );
  const ended = await context(visit.id);
  assert.deepEqual(ended.resourceIds, [room.resource.id]);
  assert.equal(ended.canAllocate, false);
  assert.equal(ended.canRelease, false);
  assert.equal(ended.history[0].after.appointment.status, 'completed');
  assert.equal((await allocate(visit.id, [])).status, 409);
  assert.equal(
    (
      await call(
        `/clinic-resources/${room.resource.id}`,
        admin,
        'PATCH',
        await metadataBody(room.resource.id, { active: false }),
      )
    ).status,
    409,
  );
  const conflict = fixture({
    date,
    time,
    status: 'in-consultation',
    durationMinutes: 60,
    doctorId: doctorB,
    patientId: 'patient-2',
  });
  assert.equal((await allocate(conflict.id, [room.resource.id])).status, 409);
  const diary = await call(
    `/resource-reservations?from=${date}&to=${date}&resourceId=${room.resource.id}`,
    reception,
  );
  assert.equal(diary.status, 200);
  assert.equal(diary.data.reservations[0].appointment.status, 'completed');
  const expired = fixture({ date: addDays(date, -1), time: '09:00', status: 'in-consultation' });
  assert.equal((await context(expired.id)).canAllocate, false);
  const later = Date.now() + 120 * 60000;
  t.mock.method(Date, 'now', () => later);
  assert.equal(
    (
      await call(
        `/clinic-resources/${room.resource.id}`,
        admin,
        'PATCH',
        await metadataBody(room.resource.id, { active: false }),
      )
    ).status,
    200,
  );
  assert.equal((await context(visit.id)).history.length, ended.history.length);
  assert.equal(
    (await call(`/resource-reservations?from=${date}&to=${date}&resourceId=${room.resource.id}`))
      .data.reservations.length,
    1,
  );
});

test('diary has bounded real dates and only operational fields; ordinary booking reserves nothing', async () => {
  const visit = await book(),
    empty = await context(visit.id);
  assert.deepEqual(empty.resourceIds, []);
  assert.deepEqual(empty.history, []);
  for (const query of [
    '',
    `?from=${visit.date}`,
    '?from=2026-02-30&to=2026-03-01',
    `?from=${visit.date}&to=${addDays(visit.date, 31)}`,
    `?from=${visit.date}&to=${addDays(visit.date, -1)}`,
  ])
    assert.equal((await call(`/resource-reservations${query}`)).status, 400);
  assert.equal(
    (await call(`/resource-reservations?from=${visit.date}&to=${visit.date}&resourceId=missing`))
      .status,
    404,
  );
  const room = await resource();
  assert.equal((await allocate(visit.id, [room.resource.id])).status, 200);
  const result = await call(
    `/resource-reservations?from=${visit.date}&to=${visit.date}&resourceId=${room.resource.id}`,
    reception,
  );
  assert.equal(result.status, 200);
  assert.equal(result.data.timezone, 'Asia/Kolkata');
  assert.equal(result.data.reservations.length, 1);
  assert.equal('reason' in result.data.reservations[0].appointment, false);
  assert.equal('notes' in result.data.reservations[0].resource, false);
  assert.equal(
    (await call(`/appointments/${visit.id}`, patient, 'PATCH', { status: 'cancelled' })).status,
    200,
  );
  assert.deepEqual(
    (
      await call(
        `/resource-reservations?from=${visit.date}&to=${visit.date}&resourceId=${room.resource.id}`,
      )
    ).data.reservations,
    [],
  );
});

test('catalogue, closure and allocation audit failures roll back source records, claims, command receipts and unique names', async () => {
  const createInput = { name: `Rollback ${randomUUID()}`, kind: 'room', requestId: randomUUID() };
  let before = sourceCounts(),
    remove = auditFailure('created clinic resource');
  try {
    assert.equal((await call('/clinic-resources', admin, 'POST', createInput)).status, 500);
    assert.deepEqual(sourceCounts(), before);
  } finally {
    remove();
  }
  assert.equal((await call('/clinic-resources', admin, 'POST', createInput)).status, 201);
  const room = await resource(),
    visit = await book(),
    id = room.resource.id;
  const inputs: [string, string, unknown, string][] = [
    [
      `/clinic-resources/${id}`,
      'PATCH',
      await metadataBody(id, { location: 'Changed' }),
      'changed clinic resource',
    ],
    [
      `/clinic-resources/${id}/closures`,
      'POST',
      await closureBody(id, addDays(visit.date, 1)),
      'recorded resource maintenance',
    ],
    [
      `/appointments/${visit.id}/resources`,
      'PUT',
      await allocationBody(visit.id, [id]),
      'changed appointment resources',
    ],
  ];
  for (const [path, method, input, action] of inputs) {
    before = sourceCounts();
    remove = auditFailure(action);
    try {
      assert.equal((await call(path, admin, method, input)).status, 500);
      assert.deepEqual(sourceCounts(), before);
    } finally {
      remove();
    }
  }
  const closeBody = await closureBody(id, addDays(visit.date, 1));
  const closure = await call(`/clinic-resources/${id}/closures`, admin, 'POST', closeBody);
  assert.equal(closure.status, 201);
  const cancelBody = {
    reason: 'Undo maintenance',
    expectedRevision: closure.data.resource.revision,
    requestId: randomUUID(),
  };
  before = sourceCounts();
  remove = auditFailure('cancelled resource maintenance');
  try {
    assert.equal(
      (
        await call(
          `/clinic-resources/${id}/closures/${closure.data.closures[0].id}/cancel`,
          admin,
          'POST',
          cancelBody,
        )
      ).status,
      500,
    );
    assert.deepEqual(sourceCounts(), before);
  } finally {
    remove();
  }
});

test('appointment audit or activity failure rolls back the appointment and every resource move or release', async () => {
  const visit = await book(),
    first = await resource(),
    second = await resource();
  assert.equal((await allocate(visit.id, [first.resource.id, second.resource.id])).status, 200);
  const original = await context(visit.id),
    before = sourceCounts();
  const remove = auditFailure('rescheduled appointment');
  try {
    assert.equal(
      (await call(`/appointments/${visit.id}`, patient, 'PATCH', { time: '10:00' })).status,
      500,
    );
    assert.deepEqual(sourceCounts(), before);
    assert.deepEqual(get(app.locals.db, 'appointments', visit.id), visit);
  } finally {
    remove();
  }
  assert.deepEqual(await context(visit.id), original);
  const beforeActivity = sourceCounts();
  app.locals.db.exec(
    "CREATE TRIGGER resource_test_activity_failure BEFORE INSERT ON activity WHEN NEW.eventKey LIKE 'appointment-changed:%' BEGIN SELECT RAISE(ABORT,'Synthetic resource activity failure'); END;",
  );
  try {
    assert.equal(
      (await call(`/appointments/${visit.id}`, patient, 'PATCH', { status: 'cancelled' })).status,
      500,
    );
    assert.deepEqual(sourceCounts(), beforeActivity);
  } finally {
    app.locals.db.exec('DROP TRIGGER resource_test_activity_failure');
  }
  assert.deepEqual(await context(visit.id), original);
});

test('source history is SQL-immutable and the materialized reservation index rejects overlapping writes', async () => {
  const visit = await book(),
    room = await resource();
  assert.equal((await allocate(visit.id, [room.resource.id])).status, 200);
  const closure = await call(
    `/clinic-resources/${room.resource.id}/closures`,
    admin,
    'POST',
    await closureBody(room.resource.id, addDays(visit.date, 1)),
  );
  assert.equal(closure.status, 201);
  assert.equal(
    (
      await call(
        `/clinic-resources/${room.resource.id}/closures/${closure.data.closures[0].id}/cancel`,
        admin,
        'POST',
        {
          reason: 'Retain cancellation',
          expectedRevision: closure.data.resource.revision,
          requestId: randomUUID(),
        },
      )
    ).status,
    200,
  );
  for (const table of [
    'clinicResources',
    'resourceChanges',
    'resourceClosures',
    'resourceClosureCancellations',
    'resourceAllocationEvents',
    'resourceCommands',
  ]) {
    const column = table === 'resourceCommands' ? 'payload' : 'data';
    assert.throws(() => app.locals.db.exec(`UPDATE ${table} SET ${column}=${column}`), /immutable/);
    assert.throws(() => app.locals.db.exec(`DELETE FROM ${table}`), /immutable/);
  }
  assert.throws(
    () => app.locals.db.exec('UPDATE resourceEventLinks SET eventId=eventId'),
    /immutable/,
  );
  assert.throws(() => app.locals.db.exec('DELETE FROM resourceEventLinks'), /immutable/);
  const other = await book(visit.date, visit.time, doctorB, 'patient-2');
  const row = app.locals.db
    .prepare('SELECT * FROM resourceReservations WHERE appointmentId=?')
    .get(visit.id)!;
  assert.throws(
    () =>
      app.locals.db
        .prepare(
          'INSERT INTO resourceReservations(appointmentId,resourceId,startAt,endAt,data) VALUES (?,?,?,?,?)',
        )
        .run(other.id, room.resource.id, row.startAt!, row.endAt!, row.data!),
    /overlaps/,
  );
  assert.equal((await context(other.id)).history.length, 0);
});

test('twenty minute reschedule candidates remain offered when adjacent to a reservation', async () => {
  const date = futureDate(),
    shortDoctor = await newDoctor(20),
    otherDoctor = await newDoctor(20);
  const own = await book(date, '09:00', shortDoctor),
    other = await book(date, '10:20', otherDoctor, 'patient-2');
  const room = await resource();
  assert.equal((await allocate(own.id, [room.resource.id])).status, 200);
  assert.equal((await allocate(other.id, [room.resource.id])).status, 200);
  const slots = await call(
    `/slots?doctorId=${shortDoctor}&date=${date}&mode=in-person&excludeAppointmentId=${own.id}`,
    patient,
  );
  assert.equal(slots.status, 200);
  assert.ok(slots.data.includes('10:00'));
  assert.ok(!slots.data.includes('10:20'));
  assert.ok(slots.data.includes('10:40'));
  assert.equal(
    (await call(`/appointments/${own.id}`, patient, 'PATCH', { time: '10:00' })).status,
    200,
  );
  assert.equal((await context(own.id)).appointment.durationMinutes, 20);
});

test('resource commands bind actor, action and target; original allocation receipts replay after cancellation', async () => {
  const own = await book(),
    other = await book(),
    room = await resource();
  const body = await allocationBody(own.id, [room.resource.id]);
  const first = await call(`/appointments/${own.id}/resources`, reception, 'PUT', body);
  assert.equal(first.status, 200);
  assert.equal(
    (
      await call(`/appointments/${other.id}/resources`, reception, 'PUT', {
        ...body,
        expectedRevision: (await context(other.id)).revision,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call(`/clinic-resources/${room.resource.id}`, admin, 'PATCH', {
        ...(await metadataBody(room.resource.id, { notes: 'Different command' })),
        requestId: body.requestId,
      })
    ).status,
    409,
  );
  assert.equal(
    (await call(`/appointments/${own.id}`, patient, 'PATCH', { status: 'cancelled' })).status,
    200,
  );
  const retry = await call(`/appointments/${own.id}/resources`, reception, 'PUT', body);
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.data.resourceIds, []);
  assert.equal(
    retry.data.history.filter((event: any) => event.requestId === body.requestId).length,
    1,
  );
  assert.equal(retry.data.history.length, 2);
  assert.equal(retry.data.canAllocate, false);
});

test('concurrent maintenance or archival and allocation cannot leave an unavailable resource reserved', async () => {
  for (const operation of ['closure', 'archive']) {
    const own = await book(),
      room = await resource(),
      id = room.resource.id;
    const allocation = await allocationBody(own.id, [id]);
    const operationInput =
      operation === 'closure'
        ? await closureBody(id, own.date)
        : await metadataBody(id, { active: false });
    const writes = await Promise.all([
      call(`/appointments/${own.id}/resources`, reception, 'PUT', allocation),
      call(
        `/clinic-resources/${id}${operation === 'closure' ? '/closures' : ''}`,
        admin,
        operation === 'closure' ? 'POST' : 'PATCH',
        operationInput,
      ),
    ]);
    assert.equal(writes.filter((entry) => entry.status === 409).length, 1);
    assert.equal(writes.filter((entry) => entry.status === 200 || entry.status === 201).length, 1);
    const current = await context(own.id),
      state = await detail(id);
    if (current.resourceIds.includes(id)) {
      assert.equal(state.resource.active, true);
      assert.equal(state.closures.length, 0);
    } else if (operation === 'closure') assert.equal(state.closures.length, 1);
    else assert.equal(state.resource.active, false);
  }
});

test('legacy database migration leaves appointments unallocated and durable claims and retries survive restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'derma-resource-test-')),
    databasePath = join(directory, 'clinic.sqlite');
  let application: ReturnType<typeof createApp> | undefined, instance: Server | undefined;
  try {
    const legacy = openDatabase(databasePath);
    seedDemo(legacy);
    legacy.close();
    application = createApp({ databasePath, demoMode: true });
    let listening = await listen(application);
    instance = listening.server;
    const client: Client = {};
    assert.equal(
      (
        await call(
          '/auth/login',
          client,
          'POST',
          { email: 'admin@derma.demo', password: 'DemoClinic2026!' },
          listening.base,
        )
      ).status,
      200,
    );
    assert.deepEqual(
      (await call('/clinic-resources', client, 'GET', undefined, listening.base)).data,
      [],
    );
    const visit = fixture(
      { doctorId: 'doctor-meera', date: addDays(clinicToday(), 70) },
      application,
    );
    const initial = await call(
      `/appointments/${visit.id}/resources`,
      client,
      'GET',
      undefined,
      listening.base,
    );
    assert.deepEqual(initial.data.history, []);
    const createInput = { name: 'Durable room', kind: 'room', requestId: randomUUID() };
    const created = await call('/clinic-resources', client, 'POST', createInput, listening.base);
    assert.equal(created.status, 201);
    const ready = await call(
      `/appointments/${visit.id}/resources`,
      client,
      'GET',
      undefined,
      listening.base,
    );
    const input = {
      resourceIds: [created.data.resource.id],
      reason: 'Durable reservation',
      expectedRevision: ready.data.revision,
      requestId: randomUUID(),
    };
    const allocated = await call(
      `/appointments/${visit.id}/resources`,
      client,
      'PUT',
      input,
      listening.base,
    );
    assert.equal(allocated.status, 200);
    await close(instance);
    instance = undefined;
    application.locals.close();
    application = undefined;
    application = createApp({ databasePath, demoMode: true });
    listening = await listen(application);
    instance = listening.server;
    assert.deepEqual(
      (await call(`/appointments/${visit.id}/resources`, client, 'GET', undefined, listening.base))
        .data,
      allocated.data,
    );
    assert.equal(
      (await call(`/appointments/${visit.id}/resources`, client, 'PUT', input, listening.base))
        .status,
      200,
    );
    assert.equal(
      (await call('/clinic-resources', client, 'POST', createInput, listening.base)).status,
      200,
    );
    assert.equal(
      application.locals.db.prepare('SELECT count(*) n FROM resourceAllocationEvents').get()!.n,
      1,
    );
    assert.deepEqual(get(application.locals.db, 'appointments', visit.id), visit);
  } finally {
    if (instance) await close(instance);
    application?.locals.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
