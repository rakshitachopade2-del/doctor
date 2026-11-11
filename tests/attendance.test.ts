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
import type {
  AttendanceContext,
  AttendanceEvent,
  AttendanceMutation,
  AttendanceShift,
} from '../shared/attendance.ts';
import type { User } from '../shared/types.ts';

const app = createApp({ databasePath: ':memory:', demoMode: true });
type Client = { cookie?: string; csrf?: string; id?: string };
const admin: Client = {},
  doctor: Client = {},
  reception: Client = {},
  patient: Client = {},
  otherAdmin: Client = {},
  temporary: Client = {};
let server: Server, base: string;
let daySequence = 0;
const historical = () => addDays('2000-01-01', daySequence++ * 2);
const at = (date: string, time = '09:00:00.000') => new Date(`${date}T${time}+05:30`).toISOString();
async function call(path: string, client = admin, method = 'GET', body?: unknown, target = base) {
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
  const data = response.headers.get('content-type')?.includes('application/json')
    ? await response.json()
    : await response.text();
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
function query(values: Record<string, string | number>) {
  return new URLSearchParams(
    Object.entries(values).map(([key, value]) => [key, String(value)]),
  ).toString();
}
async function context(client = reception, userId?: string): Promise<AttendanceContext> {
  const response = await call(
    userId ? `/attendance/staff/${userId}/context` : '/attendance/me',
    client,
  );
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return response.data;
}
async function clockIn(client = reception) {
  return call('/attendance/clock-in', client, 'POST', {
    requestId: randomUUID(),
    expectedRevision: (await context(client)).revision,
  });
}
async function clockOut(shiftId: string, client = reception) {
  return call(`/attendance/shifts/${shiftId}/clock-out`, client, 'POST', {
    requestId: randomUUID(),
    expectedRevision: (await context(client)).revision,
  });
}
async function manualBody(
  userId = reception.id!,
  date = historical(),
  fields: Record<string, unknown> = {},
) {
  return {
    userId,
    startedAt: at(date),
    endedAt: at(date, '17:00:00.000'),
    reason: 'Missed entry documented by administrator',
    requestId: randomUUID(),
    expectedRevision: (await context(admin, userId)).revision,
    ...fields,
  };
}
async function manual(
  userId = reception.id!,
  date = historical(),
  fields: Record<string, unknown> = {},
) {
  const response = await call(
    '/attendance/shifts',
    admin,
    'POST',
    await manualBody(userId, date, fields),
  );
  assert.equal(response.status, 201, JSON.stringify(response.data));
  return response.data as AttendanceMutation;
}
async function detail(shiftId: string, client = admin) {
  const response = await call(`/attendance/shifts/${shiftId}`, client);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return response.data as { shift: AttendanceShift; events: AttendanceEvent[] };
}
async function voidEntry(shiftId: string, fields: Record<string, unknown> = {}) {
  return call(`/attendance/shifts/${shiftId}/void`, admin, 'POST', {
    reason: 'Mistaken attendance entry',
    requestId: randomUUID(),
    expectedRevision: (await detail(shiftId)).shift.revision,
    ...fields,
  });
}
async function correctBody(shiftId: string, fields: Record<string, unknown> = {}) {
  const current = (await detail(shiftId)).shift;
  return {
    startedAt: current.startedAt,
    endedAt: current.endedAt ?? new Date().toISOString(),
    reason: 'Verified correction shared with staff',
    requestId: randomUUID(),
    expectedRevision: current.revision,
    ...fields,
  };
}
function sourceCounts(db: DB = app.locals.db) {
  return Object.fromEntries(
    [
      'attendanceShifts',
      'attendanceEvents',
      'attendanceState',
      'attendanceCommands',
      'audit',
      'activity',
    ].map((table) => [table, db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n]),
  );
}
function seedShift(db: DB, userId: string, id: string, startedAt: string, endedAt = startedAt) {
  const origin = {
    id,
    userId,
    staffName: 'Synthetic bulk staff',
    staffRole: 'receptionist',
    source: 'manual',
    createdAt: startedAt,
    original: { startedAt, endedAt, voided: false },
  };
  const event: AttendanceEvent = {
    id: randomUUID(),
    shiftId: id,
    userId,
    operation: 'manual-entry',
    requestId: randomUUID(),
    expectedRevision: '0'.repeat(64),
    before: null,
    after: origin.original,
    reason: 'Synthetic bulk source',
    createdById: userId,
    createdByName: origin.staffName,
    createdByRole: 'receptionist',
    createdAt: startedAt,
  };
  db.prepare('INSERT INTO attendanceShifts(id,userId,data) VALUES (?,?,?)').run(
    id,
    userId,
    JSON.stringify(origin),
  );
  db.prepare('INSERT INTO attendanceEvents(id,shiftId,userId,data) VALUES (?,?,?,?)').run(
    event.id,
    id,
    userId,
    JSON.stringify(event),
  );
  const start = Date.parse(startedAt),
    end = Date.parse(endedAt),
    date = new Date(start + 330 * 60000).toISOString().slice(0, 10);
  db.prepare(
    'INSERT INTO attendanceState(shiftId,userId,startAt,endAt,startDate,status,latestEventId) VALUES (?,?,?,?,?,?,?)',
  ).run(id, userId, start, end, date, 'closed', event.id);
  return event;
}
before(async () => {
  createUser(
    app.locals.db,
    {
      id: 'attendance-admin-two',
      name: 'Second attendance administrator',
      email: 'attendance-admin@example.test',
      role: 'admin',
    },
    'AttendanceAdmin2026!',
  );
  createUser(
    app.locals.db,
    {
      id: 'attendance-temporary',
      name: 'Temporary administrator',
      email: 'attendance-temp@example.test',
      role: 'admin',
      mustChangePassword: true,
    },
    'AttendanceTemporary2026!',
  );
  createUser(
    app.locals.db,
    {
      id: 'attendance-inactive',
      name: 'Inactive former staff',
      email: 'attendance-inactive@example.test',
      role: 'receptionist',
      active: false,
    },
    'AttendanceInactive2026!',
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
      await call('/auth/login', otherAdmin, 'POST', {
        email: 'attendance-admin@example.test',
        password: 'AttendanceAdmin2026!',
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call('/auth/login', temporary, 'POST', {
        email: 'attendance-temp@example.test',
        password: 'AttendanceTemporary2026!',
      })
    ).status,
    200,
  );
});
after(async () => {
  await close(server);
  app.locals.close();
});

test('attendance protects staff privacy, minimal roster fields and administrative commands', async () => {
  const date = historical(),
    entry = await manual(reception.id, date);
  const reportPath = `/attendance?${query({ from: date, to: date })}`;
  const allPaths = [
    '/attendance/me',
    '/attendance/staff',
    `/attendance/staff/${reception.id}/context`,
    `/attendance/shifts/${entry.shift.id}`,
    reportPath,
  ];
  for (const path of allPaths) {
    assert.equal((await call(path, {})).status, 401);
    for (const client of [patient, temporary]) assert.equal((await call(path, client)).status, 403);
  }
  for (const client of [doctor, reception]) {
    assert.equal((await call('/attendance/staff', client)).status, 403);
    assert.equal((await call(`/attendance/staff/${reception.id}/context`, client)).status, 403);
    assert.equal((await call(`${reportPath}&userId=${otherAdmin.id}`, client)).status, 403);
    assert.equal((await call(`${reportPath}&userId=missing`, client)).status, 403);
  }
  assert.equal((await call(`/attendance/shifts/${entry.shift.id}`, doctor)).status, 404);
  assert.equal((await call('/attendance/shifts/missing', doctor)).status, 404);
  const own = await call(reportPath, reception);
  assert.equal(own.status, 200);
  assert.equal(own.data.userId, reception.id);
  assert.equal(own.headers.get('cache-control'), 'no-store');
  const roster = await call('/attendance/staff');
  assert.equal(roster.status, 200);
  assert.ok(
    roster.data.some((member: any) => member.id === 'attendance-inactive' && !member.active),
  );
  for (const member of roster.data)
    assert.deepEqual(Object.keys(member).sort(), ['active', 'id', 'name', 'role']);
  assert.ok(!roster.data.some((member: any) => member.id === patient.id));
  assert.equal((await call(`/attendance/staff/${patient.id}/context`)).status, 404);
  const body = await manualBody();
  for (const client of [doctor, reception, patient, temporary])
    assert.equal((await call('/attendance/shifts', client, 'POST', body)).status, 403);
  assert.equal(
    (await call('/attendance/shifts', { cookie: admin.cookie }, 'POST', body)).status,
    403,
  );
  assert.equal(
    (
      await call(`/attendance/shifts/${entry.shift.id}/clock-out`, admin, 'POST', {
        requestId: randomUUID(),
        expectedRevision: (await context()).revision,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await call(`/attendance/shifts/${entry.shift.id}/void`, reception, 'POST', {
        reason: 'No permission',
        requestId: randomUUID(),
        expectedRevision: entry.shift.revision,
      })
    ).status,
    403,
  );
});

test('server clocking supports zero-duration entries and immutable receipts with canonical exact retries', async (t) => {
  const fixedNow = Date.now();
  t.mock.method(Date, 'now', () => fixedNow);
  const original = await context();
  const input = { requestId: randomUUID(), expectedRevision: original.revision };
  const started = await call('/attendance/clock-in', reception, 'POST', input);
  assert.equal(started.status, 201);
  assert.equal(started.data.shift.source, 'clock');
  assert.equal(started.data.shift.startedAt, new Date(fixedNow).toISOString());
  assert.equal(started.data.shift.recordedSeconds, null);
  assert.equal(started.data.event.createdById, reception.id);
  assert.equal(started.data.event.requestId, input.requestId);
  assert.equal(started.data.event.expectedRevision, input.expectedRevision);
  const afterStart = sourceCounts();
  assert.equal(
    (
      await call('/attendance/clock-in', reception, 'POST', {
        ...input,
        requestId: input.requestId.toUpperCase(),
      })
    ).status,
    200,
  );
  assert.deepEqual(sourceCounts(), afterStart);
  const current = await context();
  assert.notEqual(current.revision, original.revision);
  assert.equal(
    (
      await call('/attendance/clock-in', reception, 'POST', {
        ...input,
        expectedRevision: current.revision,
      })
    ).status,
    409,
  );
  const outInput = { requestId: randomUUID(), expectedRevision: current.revision };
  const ended = await call(
    `/attendance/shifts/${started.data.shift.id}/clock-out`,
    reception,
    'POST',
    outInput,
  );
  assert.equal(ended.status, 200);
  assert.equal(ended.data.shift.recordedSeconds, 0);
  assert.equal(ended.data.shift.endedAt, ended.data.shift.startedAt);
  const receipt = await call('/attendance/clock-in', reception, 'POST', input);
  assert.equal(receipt.status, 200);
  assert.equal(receipt.data.shift.status, 'closed');
  assert.deepEqual(receipt.data.event, started.data.event);
  assert.equal(
    (
      await call(
        `/attendance/shifts/${started.data.shift.id}/clock-out`,
        reception,
        'POST',
        outInput,
      )
    ).status,
    200,
  );
  assert.equal((await context()).openShift, null);
  const history = await detail(started.data.shift.id, reception);
  assert.equal(history.events.length, 2);
});

test('concurrent tabs cannot double clock in or out; stale account revisions do not start a later shift', async () => {
  const before = await context();
  const bodies = [0, 1].map(() => ({ requestId: randomUUID(), expectedRevision: before.revision }));
  const attempts = await Promise.all(
    bodies.map((body) => call('/attendance/clock-in', reception, 'POST', body)),
  );
  assert.deepEqual(attempts.map((entry) => entry.status).sort(), [201, 409]);
  const started = attempts.find((entry) => entry.status === 201)!.data;
  const active = await context();
  assert.equal(
    (
      await call('/attendance/clock-in', reception, 'POST', {
        requestId: randomUUID(),
        expectedRevision: active.revision,
      })
    ).status,
    409,
  );
  const outBody = { requestId: randomUUID(), expectedRevision: active.revision };
  const closed = await Promise.all(
    [0, 1].map(() =>
      call(`/attendance/shifts/${started.shift.id}/clock-out`, reception, 'POST', outBody),
    ),
  );
  assert.deepEqual(
    closed.map((entry) => entry.status),
    [200, 200],
  );
  assert.equal((await detail(started.shift.id)).events.length, 2);
  assert.equal(
    (
      await call(
        '/attendance/clock-in',
        reception,
        'POST',
        bodies.find((body) => body.requestId !== started.event.requestId)!,
      )
    ).status,
    409,
  );
});

test('manual intervals allow adjacency and empty intervals inside existing shifts but reject overlaps and open-ended conflicts', async (t) => {
  const date = historical(),
    first = await manual(reception.id, date, { endedAt: at(date, '10:00:00.000') });
  const adjacent = await manual(reception.id, date, {
    startedAt: first.shift.endedAt,
    endedAt: at(date, '11:00:00.000'),
  });
  assert.equal(adjacent.shift.recordedSeconds, 3600);
  const empty = await manual(reception.id, date, {
    startedAt: at(date, '09:30:00.000'),
    endedAt: at(date, '09:30:00.000'),
  });
  assert.equal(empty.shift.recordedSeconds, 0);
  const overlap = await call(
    '/attendance/shifts',
    admin,
    'POST',
    await manualBody(reception.id, date, {
      startedAt: at(date, '09:59:59.999'),
      endedAt: at(date, '10:30:00.000'),
    }),
  );
  assert.equal(overlap.status, 409);
  const started = await clockIn();
  assert.equal(started.status, 201);
  const clockStart = Date.parse(started.data.shift.startedAt);
  t.mock.method(Date, 'now', () => clockStart + 1000);
  const whileOpen = await call(
    '/attendance/shifts',
    admin,
    'POST',
    await manualBody(reception.id, date, {
      startedAt: started.data.shift.startedAt,
      endedAt: new Date(clockStart + 500).toISOString(),
    }),
  );
  assert.equal(whileOpen.status, 409);
  t.mock.restoreAll();
  const zeroWhileOpen = await manual(reception.id, date, {
    startedAt: started.data.shift.startedAt,
    endedAt: started.data.shift.startedAt,
  });
  assert.equal(zeroWhileOpen.shift.recordedSeconds, 0);
  assert.equal((await clockOut(started.data.shift.id)).status, 200);
});

test('strict timestamps, duration and query validation reject malformed or unbounded input without consuming commands', async () => {
  const date = historical(),
    body = await manualBody(reception.id, date);
  const bad = [
    { startedAt: `${date}T09:00:00+05:30` },
    { startedAt: `${date}T09:00:00Z` },
    { startedAt: '2026-02-30T09:00:00.000Z' },
    { endedAt: null },
    { endedAt: at(addDays(date, -1)) },
    { endedAt: at(addDays(date, 2)) },
    {
      startedAt: new Date(Date.now() + 3600000).toISOString(),
      endedAt: new Date(Date.now() + 7200000).toISOString(),
    },
    { reason: ' ' },
    { reason: 'x'.repeat(1001) },
    { extra: true },
    { requestId: 'not-a-uuid' },
    { expectedRevision: 'not-a-revision' },
  ];
  const counts = sourceCounts();
  for (const fields of bad)
    assert.equal(
      (await call('/attendance/shifts', admin, 'POST', { ...body, ...fields })).status,
      400,
      JSON.stringify(fields),
    );
  assert.deepEqual(sourceCounts(), counts);
  assert.equal((await call('/attendance/shifts', admin, 'POST', body)).status, 201);
  const exactly = await manual(reception.id, historical(), {
    startedAt: '1990-01-01T00:00:00.000Z',
    endedAt: '1990-01-02T12:00:00.000Z',
  });
  assert.equal(exactly.shift.recordedSeconds, 36 * 3600);
  for (const query of [
    '',
    '?from=2024-01-01',
    '?from=2024-02-30&to=2024-03-01',
    '?from=2024-01-02&to=2024-01-01',
    '?from=2024-01-01&to=2025-01-01',
    '?from=2024-01-01&to=2024-01-01&page=0',
    '?from=2024-01-01&to=2024-01-01&pageSize=101',
    '?from=2024-01-01&to=2024-01-01&status=absent',
    '?from=2024-01-01&to=2024-01-01&status=open&status=closed',
    '?from=2024-01-01&to=2024-01-01&unknown=1',
  ])
    assert.equal((await call(`/attendance${query}`)).status, 400, query);
  assert.equal((await call('/attendance?from=2024-01-01&to=2024-12-31')).status, 200);
  assert.equal(
    (
      await call('/attendance/clock-in', reception, 'POST', {
        requestId: randomUUID(),
        expectedRevision: (await context()).revision,
        startedAt: at(date),
      })
    ).status,
    400,
  );
});

test('manual commands bind UUID to actor, operation, target and expected revision even after later changes', async () => {
  const date = historical(),
    body = await manualBody(reception.id, date);
  const created = await call('/attendance/shifts', admin, 'POST', body);
  assert.equal(created.status, 201);
  assert.equal((await call('/attendance/shifts', otherAdmin, 'POST', body)).status, 409);
  assert.equal(
    (await call('/attendance/shifts', admin, 'POST', { ...body, userId: doctor.id })).status,
    409,
  );
  assert.equal(
    (
      await call('/attendance/shifts', admin, 'POST', {
        ...body,
        expectedRevision: (await context(admin, reception.id)).revision,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call(`/attendance/shifts/${created.data.shift.id}/void`, admin, 'POST', {
        reason: 'Different action',
        requestId: body.requestId,
        expectedRevision: created.data.shift.revision,
      })
    ).status,
    409,
  );
  const voided = await voidEntry(created.data.shift.id);
  assert.equal(voided.status, 200);
  const replay = await call('/attendance/shifts', admin, 'POST', body);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.shift.status, 'voided');
  assert.deepEqual(replay.data.event, created.data.event);
});

test('administrator corrections preserve identity and originals, share reasons with owner and reject stale/terminal writes', async () => {
  const date = historical(),
    initial = await manual(reception.id, date),
    before = get(app.locals.db, 'attendanceShifts', initial.shift.id);
  const input = await correctBody(initial.shift.id, { startedAt: at(date, '10:00:00.000') });
  const corrected = await call(
    `/attendance/shifts/${initial.shift.id}/corrections`,
    admin,
    'POST',
    input,
  );
  assert.equal(corrected.status, 200);
  assert.equal(corrected.data.shift.source, 'manual');
  assert.equal(corrected.data.shift.userId, reception.id);
  assert.equal(corrected.data.event.before.startedAt, initial.shift.startedAt);
  assert.equal(corrected.data.shift.recordedSeconds, 7 * 3600);
  assert.deepEqual(get(app.locals.db, 'attendanceShifts', initial.shift.id), before);
  assert.equal((await detail(initial.shift.id, reception)).events[0].reason, input.reason);
  assert.equal(
    (await call(`/attendance/shifts/${initial.shift.id}/corrections`, doctor, 'POST', input))
      .status,
    403,
  );
  assert.equal(
    (
      await call(`/attendance/shifts/${initial.shift.id}/corrections`, admin, 'POST', {
        ...input,
        requestId: randomUUID(),
        endedAt: at(date, '16:00:00.000'),
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call(
        `/attendance/shifts/${initial.shift.id}/corrections`,
        admin,
        'POST',
        await correctBody(initial.shift.id),
      )
    ).status,
    400,
  );
  const voided = await voidEntry(initial.shift.id);
  assert.equal(voided.status, 200);
  assert.equal(
    (await call(`/attendance/shifts/${initial.shift.id}/corrections`, admin, 'POST', input)).status,
    200,
  );
  assert.equal(
    (
      await call(
        `/attendance/shifts/${initial.shift.id}/corrections`,
        admin,
        'POST',
        await correctBody(initial.shift.id, { endedAt: at(date, '15:00:00.000') }),
      )
    ).status,
    409,
  );
  assert.equal((await voidEntry(initial.shift.id)).status, 409);
  assert.equal(voided.data.shift.recordedSeconds, null);
});

test('forgotten open entries require explicit administrator repair or void and remain visible', async (t) => {
  const actualNow = Date.now(),
    old = actualNow - 40 * 3600000;
  t.mock.method(Date, 'now', () => old);
  const opened = await clockIn(doctor);
  assert.equal(opened.status, 201);
  t.mock.restoreAll();
  const active = await context(doctor);
  assert.equal(active.openShift?.id, opened.data.shift.id);
  const failed = await clockOut(opened.data.shift.id, doctor);
  assert.equal(failed.status, 409);
  assert.match(failed.data.error, /36 hours.*administrator/i);
  assert.equal((await detail(opened.data.shift.id)).events.length, 1);
  const input = await correctBody(opened.data.shift.id, {
    endedAt: new Date(old + 8 * 3600000).toISOString(),
  });
  const fixed = await call(
    `/attendance/shifts/${opened.data.shift.id}/corrections`,
    admin,
    'POST',
    input,
  );
  assert.equal(fixed.status, 200);
  assert.equal(fixed.data.shift.recordedSeconds, 8 * 3600);
  assert.equal((await context(doctor)).openShift, null);
  const fresh = await clockIn(doctor);
  assert.equal(fresh.status, 201);
  assert.equal((await voidEntry(fresh.data.shift.id)).status, 200);
  assert.equal((await context(doctor)).openShift, null);
  const another = await clockIn(doctor);
  assert.equal(another.status, 201);
  assert.equal((await clockOut(another.data.shift.id, doctor)).status, 200);
});

test('suspension and profile changes preserve open attendance and immutable staff identity; inactive histories remain repairable', async () => {
  const opened = await clockIn(doctor);
  assert.equal(opened.status, 201);
  const beforeEvents = (await detail(opened.data.shift.id)).events.length;
  const original = get<User>(app.locals.db, 'users', doctor.id!)!;
  assert.equal(
    (
      await call(`/accounts/${doctor.id}`, admin, 'PATCH', {
        active: false,
        name: 'Renamed former clinician',
      })
    ).status,
    200,
  );
  assert.equal((await call('/attendance/me', doctor)).status, 401);
  const inactive = await context(admin, doctor.id);
  assert.equal(inactive.staff.active, false);
  assert.equal(inactive.openShift?.id, opened.data.shift.id);
  assert.equal(inactive.openShift?.staffName, opened.data.shift.staffName);
  assert.equal((await detail(opened.data.shift.id)).events.length, beforeEvents);
  const input = await correctBody(opened.data.shift.id);
  assert.equal(
    (await call(`/attendance/shifts/${opened.data.shift.id}/corrections`, admin, 'POST', input))
      .status,
    200,
  );
  const inactiveManual = await manual('attendance-inactive');
  assert.equal(inactiveManual.shift.userId, 'attendance-inactive');
  assert.equal(
    (await call(`/accounts/${doctor.id}`, admin, 'PATCH', { active: true, name: original.name }))
      .status,
    200,
  );
  assert.equal(
    (
      await call('/auth/login', doctor, 'POST', {
        email: 'doctor@derma.demo',
        password: 'DemoClinic2026!',
      })
    ).status,
    200,
  );
});

test('concurrent admin correction and self clock-out or void keep one consistent effective result', async () => {
  const opened = await clockIn();
  assert.equal(opened.status, 201);
  const correction = await correctBody(opened.data.shift.id);
  const out = { requestId: randomUUID(), expectedRevision: (await context()).revision };
  const outcomes = await Promise.all([
    call(`/attendance/shifts/${opened.data.shift.id}/corrections`, admin, 'POST', correction),
    call(`/attendance/shifts/${opened.data.shift.id}/clock-out`, reception, 'POST', out),
  ]);
  assert.deepEqual(outcomes.map((entry) => entry.status).sort(), [200, 409]);
  assert.equal((await detail(opened.data.shift.id)).events.length, 2);
  const existing = await manual(),
    revision = existing.shift.revision;
  const attempts = await Promise.all(
    [0, 1].map(() =>
      call(`/attendance/shifts/${existing.shift.id}/void`, admin, 'POST', {
        reason: 'Duplicate resolution attempt',
        expectedRevision: revision,
        requestId: randomUUID(),
      }),
    ),
  );
  assert.deepEqual(attempts.map((entry) => entry.status).sort(), [200, 409]);
});

test('timesheets use effective IST start dates and full shift seconds, excluding open/voided durations', async () => {
  const date = historical();
  const overnight = await manual(reception.id, date, {
    startedAt: at(date, '23:00:00.100'),
    endedAt: at(addDays(date, 1), '02:00:00.999'),
  });
  const next = await manual(reception.id, addDays(date, 1), {
    startedAt: at(addDays(date, 1), '03:00:00.000'),
    endedAt: at(addDays(date, 1), '03:00:00.999'),
  });
  assert.equal(overnight.shift.recordedSeconds, 10800);
  assert.equal(next.shift.recordedSeconds, 0);
  const report = await call(
    `/attendance?${query({ from: date, to: date, userId: reception.id! })}`,
  );
  assert.equal(report.status, 200);
  assert.equal(report.data.total, 1);
  assert.equal(report.data.totals.recordedSeconds, 10800);
  const nextReport = await call(
    `/attendance?${query({ from: addDays(date, 1), to: addDays(date, 1), userId: reception.id! })}`,
  );
  assert.equal(nextReport.data.total, 1);
  assert.equal(nextReport.data.items[0].id, next.shift.id);
  assert.equal((await voidEntry(overnight.shift.id)).status, 200);
  const voidReport = await call(
    `/attendance?${query({ from: date, to: date, userId: reception.id! })}`,
  );
  assert.equal(voidReport.data.totals.recordedSeconds, 0);
  assert.equal(voidReport.data.totals.voidedShiftCount, 1);
  const moved = await call(
    `/attendance/shifts/${next.shift.id}/corrections`,
    admin,
    'POST',
    await correctBody(next.shift.id, {
      startedAt: at(date, '08:00:00.000'),
      endedAt: at(date, '09:00:00.000'),
    }),
  );
  assert.equal(moved.status, 200);
  const oldPeriod = await call(
    `/attendance?${query({ from: addDays(date, 1), to: addDays(date, 1), userId: reception.id! })}`,
  );
  assert.equal(oldPeriod.data.total, 0);
  assert.notEqual(oldPeriod.data.revision, nextReport.data.revision);
  const opened = await clockIn();
  assert.equal(opened.status, 201);
  const current = await call(
    `/attendance?${query({ from: clinicToday(), to: clinicToday(), userId: reception.id!, status: 'open' })}`,
  );
  assert.equal(current.data.totals.openShiftCount, 1);
  assert.equal(current.data.totals.recordedSeconds, 0);
  assert.equal((await clockOut(opened.data.shift.id)).status, 200);
});

test('full-result revisions cover off-page changes, are independent of pagination and do not move with generated time', async (t) => {
  const date = historical(),
    entries: AttendanceMutation[] = [];
  for (let index = 0; index < 27; index++)
    entries.push(
      await manual(reception.id, date, {
        startedAt: at(date, `09:${String(index).padStart(2, '0')}:00.000`),
        endedAt: at(date, `09:${String(index).padStart(2, '0')}:30.000`),
      }),
    );
  const path = `/attendance?${query({ from: date, to: date, userId: reception.id! })}`;
  const first = await call(path),
    second = await call(`${path}&page=2`);
  assert.equal(first.data.total, 27);
  assert.equal(first.data.items.length, 25);
  assert.equal(second.data.items.length, 2);
  assert.equal(first.data.revision, second.data.revision);
  assert.equal(first.data.totals.recordedSeconds, 27 * 30);
  assert.equal((await call(`${path}&page=999`)).data.page, 2);
  const initialRevision = first.data.revision,
    later = Date.now() + 60000;
  t.mock.method(Date, 'now', () => later);
  const unchanged = await call(path);
  assert.equal(unchanged.data.revision, initialRevision);
  assert.notEqual(unchanged.data.generatedAt, first.data.generatedAt);
  t.mock.restoreAll();
  const hidden = entries[0];
  assert.ok(!first.data.items.some((entry: AttendanceShift) => entry.id === hidden.shift.id));
  assert.equal((await voidEntry(hidden.shift.id)).status, 200);
  const after = await call(path);
  assert.notEqual(after.data.revision, initialRevision);
  assert.equal(after.data.total, 27);
  const changedFilter = await call(`${path}&status=closed`);
  assert.notEqual(changedFilter.data.revision, after.data.revision);
  assert.equal(changedFilter.data.total, 26);
});

test('CSV exports require admin and exact current filters/revision, escape formulas and omit contact data and reasons', async () => {
  const userId = `attendance-formula-${randomUUID()}`,
    date = historical();
  createUser(
    app.locals.db,
    {
      id: userId,
      name: '=SUM(1,2)',
      email: 'private-attendance-contact@example.test',
      role: 'receptionist',
      active: false,
    },
    'AttendanceFormula2026!',
  );
  const entry = await manual(userId, date, {
    reason: 'Private correction discussion omitted from CSV',
  });
  const input = { from: date, to: date, userId },
    report = await call(`/attendance?${query(input)}`);
  const path = `/attendance/export.csv?${query({ ...input, expectedRevision: report.data.revision })}`;
  for (const client of [reception, doctor, patient, temporary])
    assert.equal((await call(path, client)).status, 403);
  const exported = await call(path);
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-type')!, /^text\/csv/);
  assert.match(exported.headers.get('content-disposition')!, /attachment; filename="attendance-/);
  assert.equal(exported.headers.get('x-attendance-revision'), report.data.revision);
  assert.equal(exported.headers.get('cache-control'), 'no-store');
  assert.ok(exported.data.includes('"\'=SUM(1,2)"'));
  assert.ok(exported.data.includes(entry.shift.id));
  assert.ok(!exported.data.includes('private-attendance-contact'));
  assert.ok(!exported.data.includes(entry.event.reason));
  assert.equal((await call(`${path}&page=1`)).status, 400);
  assert.equal(
    (
      await call(
        `/attendance/export.csv?${query({ ...input, status: 'closed', expectedRevision: report.data.revision })}`,
      )
    ).status,
    409,
  );
  assert.equal((await voidEntry(entry.shift.id)).status, 200);
  assert.equal((await call(path)).status, 409);
  const fresh = await call(`/attendance?${query(input)}`);
  const finalExport = await call(
    `/attendance/export.csv?${query({ ...input, expectedRevision: fresh.data.revision })}`,
  );
  assert.equal(finalExport.status, 200);
  assert.ok(finalExport.data.includes('"voided"'));
});

test('attendance writes and exports roll back completely when the audit insert fails', async () => {
  const manualInput = await manualBody(),
    initial = await manual(),
    clock = await clockIn();
  assert.equal(clock.status, 201);
  const inputs: [string, string, unknown, string, Client][] = [
    ['/attendance/shifts', 'POST', manualInput, 'attendance manual-entry', admin],
    [
      `/attendance/shifts/${initial.shift.id}/corrections`,
      'POST',
      await correctBody(initial.shift.id, {
        endedAt: new Date(Date.parse(initial.shift.endedAt!) - 3600000).toISOString(),
      }),
      'attendance correction',
      admin,
    ],
    [
      `/attendance/shifts/${initial.shift.id}/void`,
      'POST',
      {
        reason: 'Rollback void',
        requestId: randomUUID(),
        expectedRevision: initial.shift.revision,
      },
      'attendance void',
      admin,
    ],
    [
      `/attendance/shifts/${clock.data.shift.id}/clock-out`,
      'POST',
      { requestId: randomUUID(), expectedRevision: (await context()).revision },
      'attendance clock-out',
      reception,
    ],
  ];
  // manualInput predates creation of other entries, so refresh its account revision.
  manualInput.expectedRevision = (await context(admin, reception.id)).revision;
  for (const [path, method, body, action, client] of inputs) {
    const before = sourceCounts();
    app.locals.db.exec(
      `CREATE TRIGGER attendance_test_audit_failure BEFORE INSERT ON audit WHEN json_extract(NEW.data,'$.action')='${action}' BEGIN SELECT RAISE(ABORT,'Synthetic attendance audit failure'); END;`,
    );
    try {
      assert.equal((await call(path, client, method, body)).status, 500);
      assert.deepEqual(sourceCounts(), before);
    } finally {
      app.locals.db.exec('DROP TRIGGER attendance_test_audit_failure');
    }
  }
  assert.equal((await clockOut(clock.data.shift.id)).status, 200);
  const input = { requestId: randomUUID(), expectedRevision: (await context()).revision },
    before = sourceCounts();
  app.locals.db.exec(
    "CREATE TRIGGER attendance_test_audit_failure BEFORE INSERT ON audit WHEN json_extract(NEW.data,'$.action')='attendance clock-in' BEGIN SELECT RAISE(ABORT,'Synthetic attendance audit failure'); END;",
  );
  try {
    assert.equal((await call('/attendance/clock-in', reception, 'POST', input)).status, 500);
    assert.deepEqual(sourceCounts(), before);
  } finally {
    app.locals.db.exec('DROP TRIGGER attendance_test_audit_failure');
  }
  const reportInput = { from: '2000-01-01', to: '2000-12-31' },
    report = await call(`/attendance?${query(reportInput)}`);
  const exportBefore = sourceCounts();
  app.locals.db.exec(
    "CREATE TRIGGER attendance_test_audit_failure BEFORE INSERT ON audit WHEN json_extract(NEW.data,'$.action')='exported attendance timesheet' BEGIN SELECT RAISE(ABORT,'Synthetic attendance audit failure'); END;",
  );
  try {
    const failed = await call(
      `/attendance/export.csv?${query({ ...reportInput, expectedRevision: report.data.revision })}`,
    );
    assert.equal(failed.status, 500);
    assert.match(failed.headers.get('content-type')!, /application\/json/);
    assert.deepEqual(sourceCounts(), exportBefore);
  } finally {
    app.locals.db.exec('DROP TRIGGER attendance_test_audit_failure');
  }
});

test('source rows are immutable and SQL guards reject overlap while preserving empty interval semantics', async () => {
  const date = historical(),
    entry = await manual(reception.id, date),
    adjacent = await manual(reception.id, addDays(date, 1));
  for (const [table, column] of [
    ['attendanceShifts', 'data'],
    ['attendanceEvents', 'data'],
    ['attendanceCommands', 'payload'],
  ]) {
    assert.throws(() => app.locals.db.exec(`UPDATE ${table} SET ${column}=${column}`), /immutable/);
    assert.throws(() => app.locals.db.exec(`DELETE FROM ${table}`), /immutable/);
  }
  assert.throws(
    () =>
      app.locals.db
        .prepare('UPDATE attendanceState SET startAt=?,endAt=? WHERE shiftId=?')
        .run(
          Date.parse(entry.shift.startedAt) + 1000,
          Date.parse(entry.shift.endedAt!),
          adjacent.shift.id,
        ),
    /overlap/,
  );
  const zero = await manual(reception.id, date, {
    startedAt: at(date, '10:00:00.000'),
    endedAt: at(date, '10:00:00.000'),
  });
  assert.equal(zero.shift.recordedSeconds, 0);
  assert.equal(app.locals.db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
});

test('large timesheets decode only the bounded page and oversized CSV is explicitly refused', async (t) => {
  const userId = `attendance-bulk-${randomUUID()}`,
    prefix = `attendance-source-${randomUUID()}`,
    date = '1995-01-01';
  createUser(
    app.locals.db,
    {
      id: userId,
      name: 'Bulk synthetic staff',
      email: `${userId}@example.test`,
      role: 'receptionist',
      active: false,
    },
    'AttendanceBulk2026!',
  );
  app.locals.db.exec('BEGIN');
  try {
    for (let index = 0; index < 10001; index++)
      seedShift(app.locals.db, userId, `${prefix}-${String(index).padStart(5, '0')}`, at(date));
    app.locals.db.exec('COMMIT');
  } catch (error) {
    app.locals.db.exec('ROLLBACK');
    throw error;
  }
  const parse = JSON.parse;
  let decodedRows = 0;
  t.mock.method(JSON, 'parse', (value: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
    if (typeof value === 'string' && value.startsWith(`{"id":"${prefix}`)) decodedRows++;
    return parse(value, reviver);
  });
  const input = { from: date, to: date, userId },
    response = await call(`/attendance?${query({ ...input, pageSize: 17, page: 121 })}`);
  assert.equal(response.status, 200);
  assert.equal(response.data.total, 10001);
  assert.equal(response.data.items.length, 17);
  assert.equal(decodedRows, 17);
  assert.equal(response.data.totals.closedShiftCount, 10001);
  assert.equal(response.data.totals.recordedSeconds, 0);
  const exportResult = await call(
    `/attendance/export.csv?${query({ ...input, expectedRevision: response.data.revision })}`,
  );
  assert.equal(exportResult.status, 422);
  assert.match(exportResult.data.error, /10,000/);
  const plan = app.locals.db
    .prepare(
      'EXPLAIN QUERY PLAN SELECT shiftId FROM attendanceState WHERE userId=? AND startDate>=? AND startDate<=? ORDER BY startAt DESC,shiftId DESC LIMIT 25',
    )
    .all(userId, date, date);
  assert.match(
    plan.map((row: { detail: string }) => row.detail).join(' '),
    /attendance_state_user_dates/,
  );
});

test('legacy migration preserves accounts and attendance persists with exact retries across restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'derma-attendance-')),
    databasePath = join(directory, 'clinic.sqlite');
  let application: ReturnType<typeof createApp> | undefined, instance: Server | undefined;
  try {
    const legacy = openDatabase(databasePath);
    seedDemo(legacy);
    const originals = legacy.prepare('SELECT id,data FROM users ORDER BY id').all();
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
    const initial = await call('/attendance/me', client, 'GET', undefined, listening.base);
    assert.equal(initial.data.openShift, null);
    const input = { requestId: randomUUID(), expectedRevision: initial.data.revision };
    const opened = await call('/attendance/clock-in', client, 'POST', input, listening.base);
    assert.equal(opened.status, 201);
    await close(instance);
    instance = undefined;
    application.locals.close();
    application = undefined;
    application = createApp({ databasePath, demoMode: true });
    listening = await listen(application);
    instance = listening.server;
    const restored = await call('/attendance/me', client, 'GET', undefined, listening.base);
    assert.deepEqual(restored.data.openShift, opened.data.shift);
    assert.equal(
      (await call('/attendance/clock-in', client, 'POST', input, listening.base)).status,
      200,
    );
    assert.equal(
      application.locals.db.prepare('SELECT count(*) n FROM attendanceEvents').get()!.n,
      1,
    );
    assert.deepEqual(
      application.locals.db.prepare('SELECT id,data FROM users ORDER BY id').all(),
      originals,
    );
  } finally {
    if (instance) await close(instance);
    application?.locals.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('report counts, totals, page and revision share a snapshot during a concurrent SQLite write', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'derma-attendance-snapshot-')),
    databasePath = join(directory, 'clinic.sqlite');
  const application = createApp({ databasePath, demoMode: true });
  let instance: Server | undefined, writer: DB | undefined;
  try {
    const listening = await listen(application);
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
    const date = '1990-04-01';
    seedShift(application.locals.db, client.id!, randomUUID(), at(date), at(date, '10:00:00.000'));
    writer = openDatabase(databasePath);
    const database: DB = application.locals.db,
      prepare = database.prepare.bind(database);
    let injected = false;
    t.mock.method(database, 'prepare', (sql: string) => {
      const statement = prepare(sql);
      if (sql.startsWith('SELECT count(*) total,')) {
        const read = statement.get.bind(statement);
        t.mock.method(statement, 'get', (...values: SQLInputValue[]) => {
          const result = read(...values);
          if (!injected) {
            injected = true;
            seedShift(
              writer!,
              client.id!,
              randomUUID(),
              at(date, '11:00:00.000'),
              at(date, '12:00:00.000'),
            );
          }
          return result;
        });
      }
      return statement;
    });
    const path = `/attendance?${query({ from: date, to: date })}`;
    const first = await call(path, client, 'GET', undefined, listening.base);
    assert.equal(first.status, 200);
    assert.equal(injected, true);
    assert.equal(first.data.total, 1);
    assert.equal(first.data.items.length, 1);
    assert.equal(first.data.totals.recordedSeconds, 3600);
    const next = await call(path, client, 'GET', undefined, listening.base);
    assert.equal(next.data.total, 2);
    assert.equal(next.data.items.length, 2);
    assert.equal(next.data.totals.recordedSeconds, 7200);
    assert.notEqual(next.data.revision, first.data.revision);
  } finally {
    t.mock.restoreAll();
    if (instance) await close(instance);
    writer?.close();
    application.locals.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
