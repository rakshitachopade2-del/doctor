import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { SQLInputValue } from 'node:sqlite';
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
import type { Appointment, AuditEntry, Patient } from '../shared/types.ts';

const app = createApp({ databasePath: ':memory:', demoMode: true });
type Client = { cookie?: string; csrf?: string };
const admin: Client = {},
  doctor: Client = {},
  reception: Client = {},
  patient: Client = {},
  temporary: Client = {};
let server: Server, base: string;
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
  const data = await response.json();
  if (data.csrfToken) client.csrf = data.csrfToken;
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
function insertPatient(fields: Partial<Patient> = {}, db: DB = app.locals.db): Patient {
  const value: Patient = {
    id: randomUUID(),
    name: 'Search fixture patient',
    email: '',
    phone: '9000000000',
    dob: '',
    gender: '',
    allergies: 'Private allergy sentinel',
    allergyStatus: 'recorded',
    createdAt: new Date().toISOString(),
    ...fields,
  };
  db.prepare('INSERT INTO patients(id,data) VALUES (?,?)').run(value.id, JSON.stringify(value));
  return value;
}
let daySequence = 190;
function insertAppointment(fields: Partial<Appointment> = {}, db: DB = app.locals.db): Appointment {
  const value: Appointment = {
    id: randomUUID(),
    patientId: 'patient-ananya',
    patientName: 'Saved original name',
    doctorId: 'doctor-meera',
    doctorName: 'Saved clinician',
    date: addDays(clinicToday(), daySequence++),
    time: '09:00',
    durationMinutes: 30,
    status: 'scheduled',
    mode: 'in-person',
    reason: 'Private reason sentinel',
    fee: 800,
    createdAt: new Date().toISOString(),
    ...fields,
  };
  db.prepare(
    'INSERT INTO appointments(id,patientId,doctorId,date,time,status,data) VALUES (?,?,?,?,?,?,?)',
  ).run(
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
function insertAudit(fields: Partial<AuditEntry> = {}, db: DB = app.locals.db): AuditEntry {
  const value: AuditEntry = {
    id: randomUUID(),
    actorName: 'Search actor',
    action: 'synthetic audit event',
    entityType: 'search-fixture',
    entityId: 'fixture-record',
    createdAt: new Date().toISOString(),
    ...fields,
  };
  db.prepare('INSERT INTO audit(id,data) VALUES (?,?)').run(value.id, JSON.stringify(value));
  return value;
}
function query(values: Record<string, string | number>) {
  return new URLSearchParams(
    Object.entries(values).map(([key, value]) => [key, String(value)]),
  ).toString();
}
function expectedPage(result: any, count: number, pageSize: number, page: number) {
  assert.equal(result.total, count);
  assert.equal(result.totalPages, Math.max(1, Math.ceil(count / pageSize)));
  assert.equal(result.page, page);
  assert.equal(result.pageSize, pageSize);
  assert.equal(result.items.length, Math.max(0, Math.min(pageSize, count - (page - 1) * pageSize)));
}
before(async () => {
  createUser(
    app.locals.db,
    {
      id: 'search-temporary',
      name: 'Temporary administrator',
      email: 'search-temp@example.test',
      role: 'admin',
      mustChangePassword: true,
    },
    'SearchTemporary2026!',
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
        email: 'search-temp@example.test',
        password: 'SearchTemporary2026!',
      })
    ).status,
    200,
  );
});
after(async () => {
  await close(server);
  app.locals.close();
});

test('search endpoints enforce staff and administrator boundaries before evaluating filters', async () => {
  for (const path of ['/search/patients', '/search/appointments', '/search/audit']) {
    assert.equal((await call(path, {})).status, 401);
    for (const client of [patient, temporary]) {
      assert.equal((await call(path, client)).status, 403);
      assert.equal((await call(`${path}?page=invalid`, client)).status, 403);
    }
    const result = await call(path);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('cache-control'), 'no-store');
  }
  for (const client of [doctor, reception]) {
    assert.equal((await call('/search/patients', client)).status, 200);
    assert.equal((await call('/search/appointments', client)).status, 200);
    assert.equal((await call('/search/audit', client)).status, 403);
  }
});

test('strict query validation rejects malformed, repeated, unknown and unbounded pagination filters', async () => {
  const invalid = [
    'page=0',
    'page=-1',
    'page=1.5',
    'page=1e2',
    'page=1000001',
    'page=Infinity',
    'pageSize=0',
    'pageSize=101',
    'pageSize=1.2',
    'page=1&page=2',
    'pageSize[]=25',
    'q=a&q=b',
    'q[]=a',
    'unexpected=true',
    `q=${'a'.repeat(201)}`,
  ];
  for (const path of ['/search/patients', '/search/appointments', '/search/audit']) {
    for (const input of invalid)
      assert.equal((await call(`${path}?${input}`)).status, 400, `${path}?${input}`);
    const defaults = await call(path);
    assert.equal(defaults.data.pageSize, 25);
    assert.equal(defaults.data.page, 1);
    assert.equal((await call(`${path}?pageSize=100&page=1000000`)).status, 200);
  }
  for (const input of [
    'from=2026-02-30',
    'to=2025-02-29',
    'from=2026-13-01',
    'from=0000-01-01',
    'from=2026-11-12&to=2026-11-11',
    'from=2026-01-01&from=2026-01-02',
  ]) {
    assert.equal((await call(`/search/appointments?${input}`)).status, 400);
    assert.equal((await call(`/search/audit?${input}`)).status, 400);
  }
  for (const input of [
    'status=unknown',
    'mode=remote',
    'status=scheduled&status=completed',
    `doctorId=${'x'.repeat(301)}`,
  ])
    assert.equal((await call(`/search/appointments?${input}`)).status, 400);
  assert.equal((await call('/search/audit?actorId=not-stored')).status, 400);
  assert.equal((await call('/search/appointments?from=2024-02-29&to=2024-02-29')).status, 200);
  assert.equal((await call('/search/audit?from=0001-01-01&to=9999-12-31')).status, 200);
});

test('patient directory pagination is deterministic, clamped and excludes all clinical fields for every role', async () => {
  const marker = `directory-${randomUUID()}`,
    expected: Patient[] = [];
  for (let index = 0; index < 53; index++)
    expected.push(
      insertPatient({
        id: `${marker}-${String(index).padStart(3, '0')}`,
        name: `${marker} ${index}`,
        createdAt: index < 26 ? '2020-01-01T12:00:00.000Z' : '2020-01-02T12:00:00.000Z',
      }),
    );
  expected.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const seen: string[] = [];
  for (let page = 1; page <= 3; page++) {
    const result = await call(`/search/patients?${query({ q: marker, page })}`, reception);
    assert.equal(result.status, 200);
    expectedPage(result.data, 53, 25, page);
    seen.push(...result.data.items.map((item: Patient) => item.id));
    for (const item of result.data.items)
      assert.deepEqual(
        Object.keys(item).sort(),
        ['id', 'name', 'email', 'phone', 'dob', 'gender', 'createdAt'].sort(),
      );
  }
  assert.deepEqual(
    seen,
    expected.map((item) => item.id),
  );
  assert.equal(new Set(seen).size, 53);
  expectedPage((await call(`/search/patients?${query({ q: marker, page: 999 })}`)).data, 53, 25, 3);
  expectedPage(
    (await call(`/search/patients?${query({ q: 'no-such-patient-' + randomUUID(), page: 20 })}`))
      .data,
    0,
    25,
    1,
  );
  for (const client of [admin, doctor, reception]) {
    const result = await call(`/search/patients?${query({ q: marker })}`, client);
    assert.equal(JSON.stringify(result.data).includes('allerg'), false);
    assert.equal(
      (await call(`/search/patients?${query({ q: 'Private allergy sentinel' })}`, client)).data
        .total,
      0,
    );
  }
});

test('literal patient search matches current names, email, phone and ID without wildcard or SQL interpretation', async () => {
  const unusual = insertPatient({
    name: `Literal_% \\ O'Neil ${randomUUID()}`,
    email: 'literal%_email@example.test',
    phone: '9876543210',
  });
  insertPatient({ name: 'LiteralAB unrelated name' });
  for (const search of [
    'Literal_%',
    "O'Neil",
    '\\',
    'literal%_email',
    '9876543210',
    unusual.id,
    unusual.name.toUpperCase(),
  ]) {
    const result = await call(`/search/patients?${query({ q: search })}`);
    assert.equal(result.status, 200);
    assert.ok(result.data.items.some((entry: Patient) => entry.id === unusual.id));
  }
  assert.equal((await call(`/search/patients?${query({ q: 'Literal_%' })}`)).data.total, 1);
  assert.equal((await call(`/search/patients?${query({ q: "' OR 1=1 --" })}`)).data.total, 0);
  const unicode = insertPatient({ name: `अनन्या Élodie ${randomUUID()}` });
  assert.equal(
    (await call(`/search/patients?${query({ q: 'अनन्या Élodie' })}`)).data.items[0].id,
    unicode.id,
  );
  assert.equal((await call(`/search/patients?${query({ q: 'अनन्या élodie' })}`)).data.total, 0);
  const all = await call('/search/patients'),
    empty = await call('/search/patients?q=%20%20');
  assert.deepEqual(empty.data, all.data);
});

test('appointment filters compose in SQL, preserve saved names and include waiting states across all pages', async () => {
  const person = insertPatient({
    name: `Current_${randomUUID()}`,
    email: 'appointment-current@example.test',
    phone: '9012345678',
  });
  const date = addDays(clinicToday(), 700),
    values: Appointment[] = [];
  const statuses: Appointment['status'][] = [
    'scheduled',
    'checked-in',
    'in-consultation',
    'completed',
    'cancelled',
    'no-show',
  ];
  for (let index = 0; index < 36; index++)
    values.push(
      insertAppointment({
        patientId: person.id,
        patientName: 'Prior appointment-name snapshot',
        date,
        time: `${String(8 + Math.floor(index / 6)).padStart(2, '0')}:${String((index % 6) * 10).padStart(2, '0')}`,
        status: statuses[index % 6],
        doctorId: index % 2 ? 'doctor-arjun' : 'doctor-meera',
        mode: index % 3 ? 'online' : 'in-person',
      }),
    );
  const baseFilters = { patientId: person.id, from: date, to: date };
  const waiting = await call(
    `/search/appointments?${query({ ...baseFilters, status: 'waiting', pageSize: 5, page: 2 })}`,
    reception,
  );
  assert.equal(waiting.status, 200);
  expectedPage(waiting.data, 12, 5, 2);
  assert.deepEqual(
    waiting.data.items.map((entry: Appointment) => entry.id),
    values
      .filter((entry) => ['scheduled', 'checked-in'].includes(entry.status))
      .slice(5, 10)
      .map((entry) => entry.id),
  );
  const filtered = await call(
    `/search/appointments?${query({ ...baseFilters, doctorId: 'doctor-arjun', mode: 'online', status: 'checked-in' })}`,
  );
  assert.equal(filtered.data.total, 6);
  assert.ok(
    filtered.data.items.every(
      (entry: Appointment) =>
        entry.doctorId === 'doctor-arjun' &&
        entry.mode === 'online' &&
        entry.status === 'checked-in',
    ),
  );
  for (const search of [
    person.name,
    person.email,
    person.phone,
    person.id,
    'Prior appointment-name snapshot',
  ]) {
    const found = await call(
      `/search/appointments?${query({ ...baseFilters, q: search, pageSize: 100 })}`,
    );
    assert.equal(found.data.total, 36);
    assert.ok(
      found.data.items.every(
        (entry: Appointment) => entry.patientName === 'Prior appointment-name snapshot',
      ),
    );
  }
  for (const hidden of ['Private reason sentinel', 'Private allergy sentinel', 'Saved clinician'])
    assert.equal(
      (await call(`/search/appointments?${query({ ...baseFilters, q: hidden })}`)).data.total,
      0,
    );
  assert.equal(
    (await call(`/search/appointments?${query({ ...baseFilters, doctorId: 'not-a-doctor' })}`)).data
      .total,
    0,
  );
  assert.equal(
    (await call(`/search/appointments?${query({ patientId: person.id, from: addDays(date, 1) })}`))
      .data.total,
    0,
  );
  assert.equal(
    (await call(`/search/appointments?${query({ patientId: person.id, to: addDays(date, -1) })}`))
      .data.total,
    0,
  );
});

test('appointment ordering uses a stable ID tie-break and supports all historical dates without a fixed span limit', async () => {
  const person = insertPatient({ name: `Historical ${randomUUID()}` });
  const values = [
    insertAppointment({
      patientId: person.id,
      id: `appointment-z-${randomUUID()}`,
      date: '2001-01-01',
      time: '10:00',
      status: 'cancelled',
    }),
    insertAppointment({
      patientId: person.id,
      id: `appointment-a-${randomUUID()}`,
      date: '2001-01-01',
      time: '10:00',
      status: 'no-show',
    }),
    insertAppointment({
      patientId: person.id,
      date: '2031-01-01',
      time: '09:00',
      status: 'cancelled',
    }),
  ];
  const found = await call(
    `/search/appointments?${query({ patientId: person.id, from: '2000-01-01', to: '2040-01-01', pageSize: 2, page: 1 })}`,
  );
  expectedPage(found.data, 3, 2, 1);
  assert.deepEqual(
    found.data.items.map((entry: Appointment) => entry.id),
    [values[1].id, values[0].id],
  );
  assert.equal(
    (await call(`/search/appointments?${query({ patientId: person.id, page: 100, pageSize: 2 })}`))
      .data.items[0].id,
    values[2].id,
  );
  assert.equal(
    (
      await call(
        `/search/appointments?${query({ patientId: person.id, status: '', mode: '', from: '', to: '' })}`,
      )
    ).data.total,
    3,
  );
});

test('patient corrections appear in current-contact appointment search without changing saved appointment names', async () => {
  const person = insertPatient({ name: `Before correction ${randomUUID()}` });
  const visit = insertAppointment({ patientId: person.id, patientName: person.name });
  const initial = await call(`/patients/${person.id}/profile`);
  assert.equal(initial.status, 200);
  const updatedName = `After correction ${randomUUID()}`;
  const corrected = await call(`/patients/${person.id}/profile`, reception, 'PATCH', {
    name: updatedName,
    email: 'corrected-contact@example.test',
    phone: '9000000099',
    dob: '',
    gender: '',
    reason: 'Private demographic correction reason',
    expectedRevision: initial.data.revision,
    requestId: randomUUID(),
  });
  assert.equal(corrected.status, 200, JSON.stringify(corrected.data));
  for (const q of [person.name, updatedName, 'corrected-contact@example.test']) {
    const found = await call(`/search/appointments?${query({ patientId: person.id, q })}`);
    assert.equal(found.data.total, 1);
    assert.equal(found.data.items[0].patientName, person.name);
  }
  assert.equal((await call(`/search/patients?${query({ q: person.name })}`)).data.total, 0);
  assert.equal(
    (await call(`/search/patients?${query({ q: updatedName })}`)).data.items[0].id,
    person.id,
  );
  assert.deepEqual(get(app.locals.db, 'appointments', visit.id), visit);
  assert.equal(
    (
      await call(
        `/search/patients?${query({ q: 'Private demographic correction reason' })}`,
        reception,
      )
    ).data.total,
    0,
  );
});

test('audit search retrieves older than 500 records with deterministic pages and no self-generated read events', async () => {
  const entity = `long-audit-${randomUUID()}`,
    expected: AuditEntry[] = [];
  app.locals.db.exec('BEGIN');
  try {
    for (let index = 0; index < 725; index++)
      expected.push(
        insertAudit({
          id: `${entity}-${String(index).padStart(4, '0')}`,
          entityType: entity,
          createdAt: `${addDays('2001-01-01', Math.floor(index / 3))}T12:00:00.000Z`,
        }),
      );
    app.locals.db.exec('COMMIT');
  } catch (error) {
    app.locals.db.exec('ROLLBACK');
    throw error;
  }
  expected.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  const totalBefore = app.locals.db.prepare('SELECT count(*) n FROM audit').get()!.n;
  const seen: string[] = [];
  for (let page = 1; page <= 8; page++) {
    const found = await call(`/search/audit?${query({ entityType: entity, page, pageSize: 100 })}`);
    assert.equal(found.status, 200);
    expectedPage(found.data, 725, 100, page);
    seen.push(...found.data.items.map((entry: AuditEntry) => entry.id));
  }
  assert.deepEqual(
    seen,
    expected.map((entry) => entry.id),
  );
  assert.equal(new Set(seen).size, 725);
  const oldest = await call(
    `/search/audit?${query({ entityType: entity, entityId: 'fixture-record', page: 99, pageSize: 100 })}`,
  );
  assert.equal(oldest.data.page, 8);
  assert.equal(oldest.data.items.at(-1).id, expected.at(-1)!.id);
  assert.equal(app.locals.db.prepare('SELECT count(*) n FROM audit').get()!.n, totalBefore);
  const legacy = await call('/audit');
  assert.equal(legacy.data.length, 500);
});

test('audit text filters are literal, compose with exact entity identity and do not invent actor IDs', async () => {
  const marker = randomUUID();
  const match = insertAudit({
    actorName: `Dr. Case_% Élodie ${marker}`,
    action: `Reviewed O'Neil \\ report ${marker}`,
    entityType: `report_${marker}`,
    entityId: `case%_${marker}`,
  });
  insertAudit({
    actorName: `Dr. CaseXY ${marker}`,
    action: match.action,
    entityType: `${match.entityType}-extra`,
    entityId: `${match.entityId}-extra`,
  });
  for (const q of [marker, 'Case_%', "O'Neil", '\\', match.id, match.entityId]) {
    const found = await call(`/search/audit?${query({ q })}`);
    assert.ok(found.data.items.some((entry: AuditEntry) => entry.id === match.id));
  }
  const found = await call(
    `/search/audit?${query({ actor: 'case_% Élodie', action: "reviewed o'neil", entityType: match.entityType, entityId: match.entityId })}`,
  );
  assert.equal(found.data.total, 1);
  assert.deepEqual(found.data.items[0], match);
  assert.equal((await call(`/search/audit?${query({ actor: "' OR 1=1 --" })}`)).data.total, 0);
  assert.equal(
    (await call(`/search/audit?${query({ entityType: match.entityType.slice(0, -1) })}`)).data
      .total,
    0,
  );
  assert.equal(
    (await call(`/search/audit?${query({ entityId: match.entityId.slice(0, -1) })}`)).data.total,
    0,
  );
});

test('audit dates use inclusive Asia/Kolkata boundaries, not UTC calendar dates', async () => {
  const entityType = `IST-${randomUUID()}`;
  const times = [
    '2024-02-28T18:29:59.999Z',
    '2024-02-28T18:30:00.000Z',
    '2024-02-29T18:29:59.999Z',
    '2024-02-29T18:30:00.000Z',
  ];
  const entries = times.map((createdAt) => insertAudit({ entityType, createdAt }));
  const found = await call(
    `/search/audit?${query({ entityType, from: '2024-02-29', to: '2024-02-29' })}`,
  );
  assert.equal(found.data.total, 2);
  assert.deepEqual(
    found.data.items.map((entry: AuditEntry) => entry.id),
    [entries[2].id, entries[1].id],
  );
  assert.equal(
    (await call(`/search/audit?${query({ entityType, from: '2024-03-01' })}`)).data.total,
    1,
  );
  assert.equal(
    (await call(`/search/audit?${query({ entityType, to: '2024-02-28' })}`)).data.total,
    1,
  );
});

test('offset pages honestly reflect current data and clamp after filters or records change', async () => {
  const marker = `moving-${randomUUID()}`;
  const entries = Array.from({ length: 6 }, (_, index) =>
    insertPatient({ name: `${marker} ${index}`, createdAt: `2020-01-0${index + 1}T12:00:00.000Z` }),
  );
  const before = await call(`/search/patients?${query({ q: marker, page: 2, pageSize: 5 })}`);
  expectedPage(before.data, 6, 5, 2);
  const changed = { ...entries[0], name: 'No longer matches current search' };
  app.locals.db
    .prepare('UPDATE patients SET data=? WHERE id=?')
    .run(JSON.stringify(changed), changed.id);
  const after = await call(`/search/patients?${query({ q: marker, page: 2, pageSize: 5 })}`);
  expectedPage(after.data, 5, 5, 1);
  const added = insertPatient({
    name: `${marker} newly registered`,
    createdAt: '2030-01-01T00:00:00.000Z',
  });
  const first = await call(`/search/patients?${query({ q: marker, pageSize: 5 })}`);
  expectedPage(first.data, 6, 5, 1);
  assert.equal(first.data.items[0].id, added.id);
  assert.equal('revision' in first.data, false);
  assert.equal('snapshot' in first.data, false);
});

test('large datasets are filtered and paged by SQLite with at most pageSize server-side JSON decodes', async (t) => {
  const marker = `bulk-search-${randomUUID()}`,
    count = 5000;
  app.locals.db.exec('BEGIN');
  try {
    for (let index = 0; index < count; index++) {
      const patientId = `${marker}-p-${String(index).padStart(5, '0')}`;
      insertPatient({
        id: patientId,
        name: `${marker} Patient ${index}`,
        createdAt: '2020-01-01T00:00:00.000Z',
      });
      insertAppointment({
        id: `${marker}-a-${index}`,
        patientId,
        patientName: `${marker} Original ${index}`,
        date: addDays('1980-01-01', index),
        status: 'cancelled',
      });
      insertAudit({
        id: `${marker}-e-${index}`,
        entityType: marker,
        createdAt: `${addDays('1980-01-01', index)}T00:00:00.000Z`,
      });
    }
    app.locals.db.exec('COMMIT');
  } catch (error) {
    app.locals.db.exec('ROLLBACK');
    throw error;
  }
  const parse = JSON.parse;
  let decodedRows = 0;
  t.mock.method(
    JSON,
    'parse',
    function (value: string, reviver?: Parameters<typeof JSON.parse>[1]) {
      // Count row decodes in the server, not the single browser-shaped response envelope.
      if (typeof value === 'string' && value.startsWith('{"id":"' + marker)) decodedRows++;
      return parse(value, reviver);
    },
  );
  for (const [path, input] of [
    ['/search/patients', { q: marker }],
    ['/search/appointments', { q: marker }],
    ['/search/audit', { entityType: marker }],
  ] as const) {
    decodedRows = 0;
    const found = await call(`${path}?${query({ ...input, page: 121, pageSize: 17 })}`);
    assert.equal(found.status, 200);
    expectedPage(found.data, count, 17, 121);
    assert.equal(decodedRows, 17, `${path} must not decode the full matching collection`);
  }
  const plans = [
    [
      "SELECT id FROM patients ORDER BY json_extract(data,'$.createdAt') DESC,id DESC LIMIT 25",
      'search_patients_created',
    ],
    [
      "SELECT id FROM appointments WHERE doctorId='doctor-meera' AND date>='2020-01-01' ORDER BY date,time,id LIMIT 25",
      'search_appointments_doctor_date',
    ],
    [
      "SELECT id FROM audit WHERE json_extract(data,'$.entityType')='example' ORDER BY json_extract(data,'$.createdAt') DESC,id DESC LIMIT 25",
      'search_audit_entity_created',
    ],
  ];
  for (const [sql, index] of plans)
    assert.match(
      app.locals.db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all()
        .map((row: { detail: string }) => row.detail)
        .join(' '),
      new RegExp(index),
    );
});

test('count and returned rows share a read snapshot when another connection writes between them', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'derma-search-snapshot-')),
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
    const marker = `Snapshot-${randomUUID()}`;
    insertPatient({ name: `${marker} first` }, application.locals.db);
    insertPatient({ name: `${marker} second` }, application.locals.db);
    writer = openDatabase(databasePath);
    const database: DB = application.locals.db,
      prepare = database.prepare.bind(database);
    let injected = false;
    t.mock.method(database, 'prepare', (sql: string) => {
      const statement = prepare(sql);
      if (sql.startsWith('SELECT count(*) AS total FROM patients')) {
        const read = statement.get.bind(statement);
        t.mock.method(statement, 'get', (...values: SQLInputValue[]) => {
          const result = read(...values);
          if (!injected) {
            injected = true;
            insertPatient({ name: `${marker} committed concurrently` }, writer!);
          }
          return result;
        });
      }
      return statement;
    });
    const during = await call(
      `/search/patients?${query({ q: marker, pageSize: 100 })}`,
      client,
      'GET',
      undefined,
      listening.base,
    );
    assert.equal(during.status, 200);
    assert.equal(injected, true);
    expectedPage(during.data, 2, 100, 1);
    assert.ok(during.data.items.every((entry: Patient) => !entry.name.includes('concurrently')));
    const next = await call(
      `/search/patients?${query({ q: marker, pageSize: 100 })}`,
      client,
      'GET',
      undefined,
      listening.base,
    );
    expectedPage(next.data, 3, 100, 1);
    assert.ok(next.data.items.some((entry: Patient) => entry.name.includes('concurrently')));
  } finally {
    t.mock.restoreAll();
    if (instance) await close(instance);
    writer?.close();
    application.locals.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('legacy databases gain portable indexes without source rewrites, and search survives reopening without custom SQL functions', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'derma-record-search-')),
    databasePath = join(directory, 'clinic.sqlite');
  let application: ReturnType<typeof createApp> | undefined, instance: Server | undefined;
  try {
    const legacy = openDatabase(databasePath);
    seedDemo(legacy);
    const person = insertPatient(
      { name: 'Legacy searchable patient', createdAt: '2000-01-01T00:00:00.000Z' },
      legacy,
    );
    const visit = insertAppointment(
      { patientId: person.id, date: '2000-01-01', patientName: person.name, status: 'completed' },
      legacy,
    );
    const event = insertAudit(
      { entityId: person.id, createdAt: '2000-01-01T00:00:00.000Z' },
      legacy,
    );
    legacy.close();
    const client: Client = {};
    for (let iteration = 0; iteration < 2; iteration++) {
      application = createApp({ databasePath, demoMode: true });
      const listening = await listen(application);
      instance = listening.server;
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
      assert.equal(
        (
          await call(
            `/search/patients?${query({ q: person.id })}`,
            client,
            'GET',
            undefined,
            listening.base,
          )
        ).data.items[0].id,
        person.id,
      );
      assert.deepEqual(
        (
          await call(
            `/search/appointments?${query({ patientId: person.id })}`,
            client,
            'GET',
            undefined,
            listening.base,
          )
        ).data.items,
        [visit],
      );
      assert.deepEqual(
        (
          await call(
            `/search/audit?${query({ entityId: person.id })}`,
            client,
            'GET',
            undefined,
            listening.base,
          )
        ).data.items,
        [event],
      );
      assert.deepEqual(get(application.locals.db, 'patients', person.id), person);
      assert.deepEqual(get(application.locals.db, 'appointments', visit.id), visit);
      assert.deepEqual(get(application.locals.db, 'audit', event.id), event);
      await close(instance);
      instance = undefined;
      application.locals.close();
      application = undefined;
    }
    const standalone = openDatabase(databasePath);
    try {
      assert.equal(standalone.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
      insertPatient({ name: 'Written by standalone tooling' }, standalone);
    } finally {
      standalone.close();
    }
  } finally {
    if (instance) await close(instance);
    application?.locals.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
