import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import { addDays, clinicToday, createUser, get, openDatabase, seedDemo } from '../server/db.ts';
import {
  patientWithAllergyStatus,
  receptionPatient,
  safeAllergyHistory,
} from '../server/patient-profile.ts';
import type { Patient, User } from '../shared/types.ts';
import type { PatientProfile, PatientAllergyHistory } from '../shared/patient-profile.ts';

const app = createApp({ databasePath: ':memory:', demoMode: true });
type Client = { cookie?: string; csrf?: string };
const admin: Client = {},
  unlinked: Client = {},
  doctor: Client = {},
  reception: Client = {},
  patient: Client = {},
  temporary: Client = {};
let server: Server, base: string, ownId: string;
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
async function profile(patientId: string, client = admin): Promise<PatientProfile> {
  const result = await call(`/patients/${patientId}/profile`, client);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data;
}
async function allergyHistory(patientId: string, client = admin): Promise<PatientAllergyHistory> {
  const result = await call(`/patients/${patientId}/allergies`, client);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data;
}
async function newPatient(overrides: Record<string, unknown> = {}): Promise<Patient> {
  const result = await call('/patients', admin, 'POST', {
    name: 'Synthetic correction patient',
    email: '',
    phone: '9990000001',
    dob: '',
    gender: '',
    allergies: '',
    ...overrides,
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data;
}
async function demographicInput(patientId: string, overrides: Record<string, unknown> = {}) {
  const current = await profile(patientId);
  return {
    ...current.demographics,
    name: 'Corrected synthetic patient',
    reason: 'Corrected the registration details',
    expectedRevision: current.revision,
    requestId: randomUUID(),
    ...overrides,
  };
}
async function allergyInput(patientId: string, overrides: Record<string, unknown> = {}) {
  return {
    status: 'recorded',
    text: 'Synthetic recorded allergy',
    reason: 'Updated after discussion with patient',
    expectedRevision: (await allergyHistory(patientId)).revision,
    requestId: randomUUID(),
    ...overrides,
  };
}
before(async () => {
  createUser(
    app.locals.db,
    {
      id: 'profile-unlinked-admin',
      name: 'Unlinked administrator',
      email: 'profile-admin@example.test',
      role: 'admin',
    },
    'ProfileAdmin2026!',
  );
  createUser(
    app.locals.db,
    {
      id: 'profile-temporary-admin',
      name: 'Temporary administrator',
      email: 'profile-temp@example.test',
      role: 'admin',
      mustChangePassword: true,
    },
    'ProfileTemporary2026!',
  );
  ({ server, base } = await listen(app));
  for (const [role, client] of [
    ['admin', admin],
    ['doctor', doctor],
    ['reception', reception],
    ['patient', patient],
  ] as const) {
    const login = await call('/auth/login', client, 'POST', {
      email: `${role}@derma.demo`,
      password: 'DemoClinic2026!',
    });
    assert.equal(login.status, 200);
    if (role === 'patient') ownId = login.data.user.patientId;
  }
  for (const [client, email, password] of [
    [unlinked, 'profile-admin@example.test', 'ProfileAdmin2026!'],
    [temporary, 'profile-temp@example.test', 'ProfileTemporary2026!'],
  ] as const)
    assert.equal((await call('/auth/login', client, 'POST', { email, password })).status, 200);
});
after(async () => {
  await close(server);
  app.locals.close();
});

test('profile and allergy authorization separates staff demographics, linked clinical writers and own patient reads', async () => {
  const created = await newPatient();
  for (const client of [admin, unlinked, doctor, reception]) {
    const response = await call(`/patients/${created.id}/profile`, client);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  for (const path of [`/patients/${ownId}/profile`, `/patients/${ownId}/allergies`]) {
    assert.equal((await call(path, {})).status, 401);
    assert.equal((await call(path, temporary)).status, 403);
    assert.equal((await call(path, patient)).status, 200);
  }
  assert.equal((await call(`/patients/${created.id}/profile`, patient)).status, 403);
  assert.equal((await call(`/patients/${created.id}/allergies`, patient)).status, 403);
  assert.equal((await call(`/patients/${created.id}/allergies`, reception)).status, 403);
  const body = await demographicInput(created.id);
  assert.equal((await call(`/patients/${created.id}/profile`, patient, 'PATCH', body)).status, 403);
  assert.equal(
    (await call(`/patients/${created.id}/profile`, { cookie: reception.cookie }, 'PATCH', body))
      .status,
    403,
  );
  assert.equal(
    (await call(`/patients/${created.id}/profile`, unlinked, 'PATCH', body)).status,
    200,
  );
  const clinicalBody = await allergyInput(created.id);
  for (const client of [reception, patient])
    assert.equal(
      (await call(`/patients/${created.id}/allergies`, client, 'POST', clinicalBody)).status,
      403,
    );
  assert.equal(
    (await call(`/patients/${created.id}/allergies`, unlinked, 'POST', clinicalBody)).status,
    400,
  );
  assert.equal(
    (await call(`/patients/${created.id}/allergies`, doctor, 'POST', clinicalBody)).status,
    200,
  );
  assert.equal((await call('/patients/not-found/profile', admin)).status, 404);
});

test('legacy allergy strings derive status without fabricating author or historical events', async () => {
  for (const [text, status] of [
    ['', 'not-recorded'],
    ['Legacy synthetic note', 'recorded'],
  ] as const) {
    const created = await newPatient({ allergies: text });
    const current = await allergyHistory(created.id);
    assert.deepEqual(current.current, { status, text });
    assert.deepEqual(current.changes, []);
    assert.equal(patientWithAllergyStatus(created).allergyStatus, status);
    const { allergyStatus: _status, ...legacyFields } = created;
    assert.deepEqual(
      receptionPatient({ ...created, allergies: 'hidden', allergyStatus: 'recorded' } as Patient),
      { ...legacyFields, allergies: '' },
    );
    assert.deepEqual((await profile(created.id)).changes, []);
  }
});

test('demographic corrections preserve login identity, clinical state and historical patient-name snapshots', async () => {
  const original = get<Patient>(app.locals.db, 'patients', ownId)!;
  const usersBefore = app.locals.db.prepare('SELECT * FROM users ORDER BY id').all();
  const historicalTables = ['appointments', 'encounters', 'carePlans', 'invoices', 'intakes'];
  const snapshots = historicalTables.map((table) =>
    app.locals.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
  );
  const body = await demographicInput(ownId, {
    name: 'Corrected portal record name',
    email: 'Record.Contact@Example.test',
    dob: '1990-02-28',
  });
  const response = await call(`/patients/${ownId}/profile`, reception, 'PATCH', body);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.demographics.email, 'record.contact@example.test');
  assert.equal(response.data.changes[0].before.name, original.name);
  assert.equal(response.data.changes[0].createdByRole, 'receptionist');
  assert.equal(response.data.changes[0].after.name, body.name);
  assert.equal(get<Patient>(app.locals.db, 'patients', ownId)!.allergies, original.allergies);
  assert.deepEqual(app.locals.db.prepare('SELECT * FROM users ORDER BY id').all(), usersBefore);
  historicalTables.forEach((table, index) =>
    assert.deepEqual(
      app.locals.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
      snapshots[index],
    ),
  );
  const own = await profile(ownId, patient);
  assert.equal(own.demographics.name, body.name);
  assert.equal(own.revision, null);
  assert.deepEqual(own.changes, []);
  const session = await call('/session', patient);
  assert.equal(session.data.user.name, get<User>(app.locals.db, 'users', 'user-patient')!.name);
  assert.equal(session.data.user.email, 'patient@derma.demo');
  assert.equal(session.data.user.patientId, ownId);
});

test('explicit allergy status updates expose only patient-shared clinical history and preserve each prior state', async () => {
  const baseline = await allergyHistory(ownId);
  const sequence = [
    { status: 'none-known', text: '' },
    { status: 'recorded', text: 'Patient reported synthetic allergy' },
    { status: 'not-recorded', text: '' },
  ];
  let prior = baseline.current;
  for (const entry of sequence) {
    const result = await call(
      `/patients/${ownId}/allergies`,
      doctor,
      'POST',
      await allergyInput(ownId, entry),
    );
    assert.equal(result.status, 200);
    assert.deepEqual(result.data.changes[0].before, prior);
    assert.deepEqual(result.data.changes[0].after, entry);
    assert.equal(result.data.changes[0].doctorId, 'doctor-meera');
    const current = get<Patient>(app.locals.db, 'patients', ownId)!;
    assert.equal(current.allergies, entry.text);
    assert.equal(current.allergyStatus, entry.status);
    prior = result.data.current;
  }
  const shared = await allergyHistory(ownId, patient);
  assert.equal(shared.revision, null);
  assert.equal(shared.changes.length, baseline.changes.length + sequence.length);
  for (const event of shared.changes) {
    assert.equal('createdById' in event, false);
    assert.equal('requestId' in event, false);
    assert.ok(event.doctorName);
    assert.ok(event.reason);
  }
  assert.deepEqual(safeAllergyHistory(app.locals.db, ownId), shared);
});

test('care summaries include current allergy status and safe history, reject stale downloads and exclude demographic correction reasons', async () => {
  const path = `/patients/${ownId}/care-summary`;
  const original = await call(path, patient);
  assert.equal(original.status, 200);
  const clinical = await call(
    `/patients/${ownId}/allergies`,
    doctor,
    'POST',
    await allergyInput(ownId, { text: 'Shared allergy correction for summary' }),
  );
  assert.equal(clinical.status, 200);
  const corrected = await call(path, patient);
  assert.equal(corrected.status, 200);
  assert.equal(corrected.data.patient.allergyStatus, 'recorded');
  assert.equal(corrected.data.patient.allergies, 'Shared allergy correction for summary');
  assert.deepEqual(corrected.data.allergyHistory, clinical.data.changes);
  assert.notEqual(corrected.data.revision, original.data.revision);
  const stale = await call(`${path}/download?revision=${original.data.revision}`, patient);
  assert.equal(stale.status, 409);
  assert.equal(stale.headers.has('content-disposition'), false);
  for (const event of corrected.data.allergyHistory) {
    assert.equal('createdById' in event, false);
    assert.equal('requestId' in event, false);
  }
  const allergyBeforeDemographics = await allergyHistory(ownId);
  const operationalReason = 'INTERNAL_DEMOGRAPHIC_REASON_SUMMARY_TEST';
  assert.equal(
    (
      await call(
        `/patients/${ownId}/profile`,
        reception,
        'PATCH',
        await demographicInput(ownId, {
          phone: '9990000099',
          reason: operationalReason,
        }),
      )
    ).status,
    200,
  );
  assert.deepEqual(await allergyHistory(ownId), allergyBeforeDemographics);
  const latest = await call(path, patient);
  assert.equal(latest.data.patient.phone, '9990000099');
  assert.deepEqual(latest.data.allergyHistory, corrected.data.allergyHistory);
  assert.equal(JSON.stringify(latest.data).includes(operationalReason), false);
  assert.equal(
    (await call(`${path}/download?revision=${corrected.data.revision}`, patient)).status,
    409,
  );
  const download = await call(`${path}/download?revision=${latest.data.revision}`, patient);
  assert.equal(download.status, 200);
  assert.ok(download.headers.get('content-disposition')?.startsWith('attachment;'));
  assert.deepEqual(download.data.allergyHistory, latest.data.allergyHistory);
  assert.equal(download.data.revision, latest.data.revision);
  assert.equal((await call(path, reception)).status, 403);
  const clinicalSummary = await call(path, doctor);
  assert.equal(clinicalSummary.data.revision, latest.data.revision);
  assert.deepEqual(clinicalSummary.data.allergyHistory, latest.data.allergyHistory);
});

test('reception demographic tokens, history and list projections reveal no allergy changes', async () => {
  const created = await newPatient();
  const before = await profile(created.id, reception);
  const listBefore = (await call('/patients', reception)).data;
  const dashboardBefore = (await call('/dashboard', reception)).data;
  const body = await demographicInput(created.id, { phone: '9990000002' });
  assert.equal(
    (
      await call(
        `/patients/${created.id}/allergies`,
        doctor,
        'POST',
        await allergyInput(created.id),
      )
    ).status,
    200,
  );
  const after = await profile(created.id, reception);
  assert.deepEqual(after, before);
  assert.deepEqual((await call('/patients', reception)).data, listBefore);
  assert.deepEqual((await call('/dashboard', reception)).data, dashboardBefore);
  assert.equal(JSON.stringify(after).includes('allerg'), false);
  assert.equal(
    (await call(`/patients/${created.id}/profile`, reception, 'PATCH', body)).status,
    200,
  );
  assert.equal(
    get<Patient>(app.locals.db, 'patients', created.id)!.allergies,
    'Synthetic recorded allergy',
  );
});

test('demographic and allergy revisions are independent, with conflicts for competing changes in the same scope', async () => {
  const created = await newPatient();
  const demographic = await demographicInput(created.id),
    clinical = await allergyInput(created.id);
  assert.equal(
    (await call(`/patients/${created.id}/profile`, reception, 'PATCH', demographic)).status,
    200,
  );
  assert.equal(
    (await call(`/patients/${created.id}/allergies`, doctor, 'POST', clinical)).status,
    200,
  );
  const current = await demographicInput(created.id, { phone: '9990000003' });
  const competing = await Promise.all([
    call(`/patients/${created.id}/profile`, admin, 'PATCH', current),
    call(`/patients/${created.id}/profile`, admin, 'PATCH', {
      ...current,
      phone: '9990000004',
      requestId: randomUUID(),
    }),
  ]);
  assert.deepEqual(competing.map((result) => result.status).sort(), [200, 409]);
  const allergy = await allergyInput(created.id, { text: 'Updated synthetic note' });
  const clinicalCompeting = await Promise.all([
    call(`/patients/${created.id}/allergies`, doctor, 'POST', allergy),
    call(`/patients/${created.id}/allergies`, doctor, 'POST', {
      ...allergy,
      text: 'Competing synthetic note',
      requestId: randomUUID(),
    }),
  ]);
  assert.deepEqual(clinicalCompeting.map((result) => result.status).sort(), [200, 409]);
  assert.equal(
    (
      await call(
        `/patients/${created.id}/profile`,
        admin,
        'PATCH',
        await demographicInput(created.id, {
          expectedRevision: (await allergyHistory(created.id)).revision,
        }),
      )
    ).status,
    409,
  );
});

test('actor-bound command retries return current projections and cannot cross patient, operation or payload', async () => {
  const created = await newPatient(),
    another = await newPatient();
  const body = await demographicInput(created.id);
  const simultaneous = await Promise.all(
    [1, 2].map(() => call(`/patients/${created.id}/profile`, admin, 'PATCH', body)),
  );
  assert.deepEqual(
    simultaneous.map((result) => result.status),
    [200, 200],
  );
  assert.equal((await profile(created.id)).changes.length, 1);
  assert.equal(
    (
      await call(
        `/patients/${created.id}/profile`,
        admin,
        'PATCH',
        await demographicInput(created.id, { phone: '9990000005' }),
      )
    ).status,
    200,
  );
  const latest = await profile(created.id);
  const retry = await call(`/patients/${created.id}/profile`, admin, 'PATCH', {
    ...body,
    expectedRevision: '0'.repeat(64),
  });
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.data, latest);
  assert.equal(
    (await call(`/patients/${created.id}/profile`, unlinked, 'PATCH', body)).status,
    409,
  );
  assert.equal(
    (
      await call(`/patients/${created.id}/profile`, admin, 'PATCH', {
        ...body,
        reason: 'Different correction',
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call(`/patients/${another.id}/profile`, admin, 'PATCH', {
        ...body,
        expectedRevision: (await profile(another.id)).revision,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call(
        `/patients/${created.id}/allergies`,
        admin,
        'POST',
        await allergyInput(created.id, { requestId: body.requestId }),
      )
    ).status,
    409,
  );
  const clinical = await allergyInput(created.id);
  assert.equal(
    (await call(`/patients/${created.id}/allergies`, doctor, 'POST', clinical)).status,
    200,
  );
  assert.equal(
    (
      await call(
        `/patients/${created.id}/allergies`,
        doctor,
        'POST',
        await allergyInput(created.id, { status: 'none-known', text: '' }),
      )
    ).status,
    200,
  );
  assert.deepEqual(
    (await call(`/patients/${created.id}/allergies`, doctor, 'POST', clinical)).data,
    await allergyHistory(created.id),
  );
});

test('date, field, reason, strict payload and status validation reject invalid data without consuming commands', async () => {
  const created = await newPatient();
  const valid = await demographicInput(created.id);
  for (const invalid of [
    { dob: '2025-02-29' },
    { dob: addDays(clinicToday(), 1) },
    { dob: '2000-13-01' },
    { email: 'invalid' },
    { phone: '123' },
    { name: ' ' },
    { gender: 'x'.repeat(51) },
    { reason: '' },
    { reason: 'x'.repeat(1001) },
    { expectedRevision: 'bad' },
    { requestId: 'bad' },
    { allergies: 'forbidden' },
    { allergyStatus: 'none-known' },
    { doctorId: 'doctor-meera' },
  ])
    assert.equal(
      (await call(`/patients/${created.id}/profile`, reception, 'PATCH', { ...valid, ...invalid }))
        .status,
      400,
    );
  const current = await profile(created.id);
  assert.equal(
    (
      await call(`/patients/${created.id}/profile`, reception, 'PATCH', {
        ...valid,
        ...current.demographics,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call(`/patients/${created.id}/profile`, reception, 'PATCH', {
        ...valid,
        dob: '2000-02-29',
      })
    ).status,
    200,
  );
  const clinical = await allergyInput(created.id);
  for (const invalid of [
    { status: 'recorded', text: '' },
    { status: 'none-known', text: 'hidden text' },
    { status: 'not-recorded', text: 'hidden text' },
    { status: 'unknown' },
    { text: 'x'.repeat(8001) },
    { reason: '' },
    { doctorId: 'invented-author' },
    { createdById: 'invented-account' },
  ])
    assert.equal(
      (await call(`/patients/${created.id}/allergies`, doctor, 'POST', { ...clinical, ...invalid }))
        .status,
      400,
    );
  assert.equal(
    (
      await call(`/patients/${created.id}/allergies`, doctor, 'POST', {
        ...clinical,
        status: 'not-recorded',
        text: '',
      })
    ).status,
    400,
  );
  assert.equal(
    (await call(`/patients/${created.id}/allergies`, doctor, 'POST', clinical)).status,
    200,
  );
});

test('source events, current records, command receipts and audit commit or roll back together', async () => {
  const created = await newPatient();
  for (const [path, client, method, body, action] of [
    [
      `/patients/${created.id}/profile`,
      reception,
      'PATCH',
      await demographicInput(created.id),
      'corrected patient demographics',
    ],
    [
      `/patients/${created.id}/allergies`,
      doctor,
      'POST',
      await allergyInput(created.id),
      'updated patient allergy record',
    ],
  ] as const) {
    const original = get<Patient>(app.locals.db, 'patients', created.id);
    app.locals.db.exec(
      `CREATE TRIGGER fail_patient_correction_audit BEFORE INSERT ON audit WHEN json_extract(NEW.data,'$.action')='${action}' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END;`,
    );
    try {
      assert.equal((await call(path, client, method, body)).status, 500);
    } finally {
      app.locals.db.exec('DROP TRIGGER fail_patient_correction_audit');
    }
    assert.deepEqual(get<Patient>(app.locals.db, 'patients', created.id), original);
    assert.equal(
      app.locals.db
        .prepare('SELECT COUNT(*) AS n FROM patientProfileCommands WHERE requestId=?')
        .get(body.requestId)!.n,
      0,
    );
    const table = method === 'PATCH' ? 'patientProfileChanges' : 'patientAllergyChanges';
    assert.equal(
      app.locals.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE patientId=?`).get(created.id)!
        .n,
      0,
    );
    assert.equal((await call(path, client, method, body)).status, 200);
    assert.equal(
      app.locals.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE patientId=?`).get(created.id)!
        .n,
      1,
    );
  }
});

test('immutable correction history rejects database update and deletion', async () => {
  const created = await newPatient();
  await call(
    `/patients/${created.id}/profile`,
    reception,
    'PATCH',
    await demographicInput(created.id),
  );
  await call(`/patients/${created.id}/allergies`, doctor, 'POST', await allergyInput(created.id));
  for (const table of [
    'patientProfileChanges',
    'patientAllergyChanges',
    'patientProfileCommands',
  ]) {
    const row = app.locals.db.prepare(`SELECT rowid FROM ${table} LIMIT 1`).get()!;
    const field = table === 'patientProfileCommands' ? 'payload' : 'data';
    assert.throws(
      () =>
        app.locals.db.prepare(`UPDATE ${table} SET ${field}=${field} WHERE rowid=?`).run(row.rowid),
      /immutable/,
    );
    assert.throws(
      () => app.locals.db.prepare(`DELETE FROM ${table} WHERE rowid=?`).run(row.rowid),
      /immutable/,
    );
  }
});

test('core profile and allergy corrections remain available while optional clinical modules are paused', async () => {
  const created = await newPatient();
  const original = app.locals.db.prepare("SELECT value FROM meta WHERE key='settings'").get()!;
  const settings = JSON.parse(original.value as string);
  app.locals.db
    .prepare("UPDATE meta SET value=? WHERE key='settings'")
    .run(
      JSON.stringify({ ...settings, modules: { intake: false, images: false, followUp: false } }),
    );
  try {
    assert.equal(
      (
        await call(
          `/patients/${created.id}/profile`,
          reception,
          'PATCH',
          await demographicInput(created.id),
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await call(
          `/patients/${created.id}/allergies`,
          doctor,
          'POST',
          await allergyInput(created.id),
        )
      ).status,
      200,
    );
  } finally {
    app.locals.db.prepare("UPDATE meta SET value=? WHERE key='settings'").run(original.value);
  }
});

test('additive initialization preserves legacy records and durable correction history, commands and current state', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'derma-profile-'));
  const databasePath = join(directory, 'clinic.sqlite');
  let application: ReturnType<typeof createApp> | undefined, instance: Server | undefined;
  try {
    const legacy = openDatabase(databasePath);
    seedDemo(legacy);
    const legacyPatient = get<Patient>(legacy, 'patients', ownId)!;
    assert.ok(legacyPatient);
    legacy.close();
    application = createApp({ databasePath, demoMode: true });
    let listening = await listen(application);
    instance = listening.server;
    const client: Client = {};
    await call(
      '/auth/login',
      client,
      'POST',
      { email: 'admin@derma.demo', password: 'DemoClinic2026!' },
      listening.base,
    );
    const path = `/patients/${ownId}/profile`;
    const before = (await call(path, client, 'GET', undefined, listening.base))
      .data as PatientProfile;
    assert.equal(before.demographics.name, legacyPatient.name);
    assert.deepEqual(before.changes, []);
    assert.deepEqual(
      (await call(`/patients/${ownId}/allergies`, client, 'GET', undefined, listening.base)).data
        .changes,
      [],
    );
    const body = {
      ...before.demographics,
      name: 'Persisted corrected name',
      reason: 'Known registration correction',
      expectedRevision: before.revision,
      requestId: randomUUID(),
    };
    const changed = await call(path, client, 'PATCH', body, listening.base);
    assert.equal(changed.status, 200);
    await close(instance);
    instance = undefined;
    application.locals.close();
    application = undefined;
    application = createApp({ databasePath, demoMode: true });
    listening = await listen(application);
    instance = listening.server;
    const restored = await call(path, client, 'GET', undefined, listening.base);
    assert.deepEqual(restored.data, changed.data);
    assert.deepEqual((await call(path, client, 'PATCH', body, listening.base)).data, changed.data);
  } finally {
    if (instance) await close(instance);
    application?.locals.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
