import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PatientRegistrationCommand } from '../shared/patient-registration.ts';
import { addDays, clinicToday, openDatabase, type DB } from '../server/db.ts';
import {
  beforeTransaction,
  careApiFixture,
  changeUser,
  simultaneousCareRequests,
} from './fixtures/care-api.ts';

const path = '/patients/register';
const patientFields = {
  name: 'Synthetic chart patient',
  email: 'chart@example.test',
  phone: '9000000910',
  dob: '2000-02-29',
  gender: 'Not specified',
  allergies: '',
};
function command(
  role: PatientRegistrationCommand['registeredByRole'] = 'doctor',
  patch: Partial<PatientRegistrationCommand> = {},
): PatientRegistrationCommand {
  return {
    ...patientFields,
    requestId: randomUUID(),
    registeredByRole: role,
    reviewedConfirmed: true,
    ...patch,
  };
}
function counts(db: DB) {
  const row = db
    .prepare(
      `SELECT
    (SELECT COUNT(*) FROM patients) patients,
    (SELECT COUNT(*) FROM audit WHERE json_extract(data,'$.action')='created patient') audits,
    (SELECT COUNT(*) FROM patientRegistrationCommands) commands,
    (SELECT COUNT(*) FROM users) users`,
    )
    .get()!;
  return {
    patients: Number(row.patients),
    audits: Number(row.audits),
    commands: Number(row.commands),
    users: Number(row.users),
  };
}
function unconfirmed(result: { status: number; data: Record<string, unknown> }, status: number) {
  assert.equal(result.status, status, JSON.stringify(result.data));
  for (const key of ['receipt', 'patient', 'actorId', 'requestId', 'command', 'registeredByRole'])
    assert.ok(!Object.hasOwn(result.data, key));
}

test('clinical registration returns the original normalized chart after demographic and allergy corrections, account renaming and reopening', async (t) => {
  const f = await careApiFixture(t),
    doctor = await f.login('doctor'),
    reception = await f.login('reception');
  const cmd = command('doctor', { allergies: 'Synthetic initial allergy' });
  const submitted = await f.call(path, doctor, {
    ...cmd,
    requestId: cmd.requestId.toUpperCase(),
    name: '  ' + cmd.name + '  ',
    email: '  CHART@EXAMPLE.TEST ',
    phone: ' ' + cmd.phone + ' ',
    gender: cmd.gender + ' ',
    allergies: ' ' + cmd.allergies + ' ',
  });
  assert.equal(submitted.status, 201, JSON.stringify(submitted.data));
  const original = submitted.data.receipt.patient;
  assert.match(original.id, /^[a-f0-9-]{36}$/);
  assert.notEqual(original.id, cmd.requestId);
  assert.equal(new Date(original.createdAt).toISOString(), original.createdAt);
  assert.deepEqual(submitted.data, {
    receipt: {
      requestId: cmd.requestId,
      actorId: doctor.user.id,
      registeredByRole: 'doctor',
      patient: {
        ...patientFields,
        allergies: cmd.allergies,
        id: original.id,
        createdAt: original.createdAt,
        allergyStatus: 'recorded',
      },
    },
  });
  const base = '/patients/' + original.id;
  const profile = (await f.call(base + '/profile', reception)).data;
  const patch = await fetch(f.base + base + '/profile', {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Cookie: reception.cookie,
      'X-CSRF-Token': reception.csrf,
    },
    body: JSON.stringify({
      ...profile.demographics,
      name: 'Corrected synthetic name',
      expectedRevision: profile.revision,
      reason: 'Synthetic correction',
      requestId: randomUUID(),
    }),
  });
  assert.equal(patch.status, 200, await patch.text());
  const allergies = (await f.call(base + '/allergies', doctor)).data;
  assert.equal(
    (
      await f.call(base + '/allergies', doctor, {
        status: 'none-known',
        text: '',
        reason: 'Reported correction',
        expectedRevision: allergies.revision,
        requestId: randomUUID(),
      })
    ).status,
    200,
  );
  const stored = (await f.call(base, doctor)).data.patient;
  assert.equal(stored.name, 'Corrected synthetic name');
  assert.equal(stored.allergyStatus, 'none-known');
  assert.equal(stored.allergies, '');
  changeUser(f.db, doctor.user, { name: 'Updated recording account display' });
  const baseline = counts(f.db);
  const retry = await f.call(path, doctor, Object.fromEntries(Object.entries(cmd).reverse()));
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.data, submitted.data);
  await f.close();
  const reopened = await careApiFixture(t, f.databasePath);
  const recovered = await reopened.call(path, doctor, cmd);
  assert.equal(recovered.status, 200);
  assert.deepEqual(recovered.data, submitted.data);
  assert.deepEqual((await reopened.call(base, doctor)).data.patient, stored);
  assert.deepEqual(counts(reopened.db), baseline);
  for (const projection of [
    stored,
    (await reopened.call('/patients?search=Corrected', reception)).data,
    (await reopened.call(base + '/profile', doctor)).data,
  ])
    assert.ok(!JSON.stringify(projection).includes(cmd.requestId));
});

test('reception registers demographics and recovers a reception-safe original after a clinician records an allergy', async (t) => {
  const f = await careApiFixture(t),
    reception = await f.login('reception'),
    clinician = await f.login('doctor');
  const cmd = command('receptionist', { email: '', dob: '', gender: '' });
  const before = counts(f.db),
    created = await f.call(path, reception, cmd);
  assert.equal(created.status, 201);
  const { patient } = created.data.receipt,
    base = '/patients/' + patient.id;
  assert.deepEqual(created.data.receipt, {
    requestId: cmd.requestId,
    actorId: reception.user.id,
    registeredByRole: 'receptionist',
    patient: {
      id: patient.id,
      createdAt: patient.createdAt,
      name: cmd.name,
      email: '',
      phone: cmd.phone,
      dob: '',
      gender: '',
      allergies: '',
    },
  });
  const history = (await f.call(base + '/allergies', clinician)).data;
  const updated = await f.call(base + '/allergies', clinician, {
    expectedRevision: history.revision,
    reason: 'Reported at visit',
    text: 'Synthetic private allergy',
    status: 'recorded',
    requestId: randomUUID(),
  });
  assert.equal(updated.status, 200);
  const retry = await f.call(path, reception, cmd);
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.data, created.data);
  for (const route of [path, '/patients']) {
    const denied = await f.call(route, reception, {
      ...cmd,
      allergies: 'Synthetic forbidden clinical field',
    });
    unconfirmed(denied, 403);
    assert.ok(!JSON.stringify(denied.data).includes('Synthetic forbidden'));
  }
  const after = counts(f.db);
  assert.deepEqual(after, {
    ...before,
    patients: before.patients + 1,
    audits: before.audits + 1,
    commands: before.commands + 1,
  });
  assert.equal((await f.call(base + '/allergies', reception)).status, 403);
  assert.ok(
    !JSON.stringify(
      (await f.call('/patients?search=' + encodeURIComponent(cmd.name), reception)).data,
    ).includes('Synthetic private allergy'),
  );
});

test('UUID binds the actor, role and all reviewed fields; distinct reviews can create two people with identical details', async (t) => {
  const f = await careApiFixture(t),
    doctor = await f.login('doctor'),
    admin = await f.login('admin'),
    patient = await f.login('patient');
  const cmd = command(),
    saved = await f.call(path, doctor, cmd);
  assert.equal(saved.status, 201);
  const baseline = counts(f.db);
  for (const patch of [
    { name: 'Different person' },
    { email: 'different@example.test' },
    { phone: '9000000550' },
    { dob: '1992-01-02' },
    { gender: 'Other' },
    { allergies: 'Private detail' },
  ])
    unconfirmed(await f.call(path, doctor, { ...cmd, ...patch }), 409);
  unconfirmed(await f.call(path, admin, cmd), 403);
  unconfirmed(await f.call(path, admin, { ...cmd, registeredByRole: 'admin' }), 409);
  unconfirmed(await f.call(path, patient, cmd), 403);
  unconfirmed(await f.call(path, undefined, cmd), 401);
  unconfirmed(await f.call(path, { ...doctor, csrf: 'invalid' }, cmd), 403);
  changeUser(f.db, admin.user, { role: 'doctor' });
  unconfirmed(await f.call(path, admin, cmd), 409);
  changeUser(f.db, doctor.user, { role: 'receptionist' });
  unconfirmed(await f.call(path, doctor, cmd), 403);
  unconfirmed(await f.call(path, doctor, { ...cmd, registeredByRole: 'receptionist' }), 409);
  changeUser(f.db, doctor.user, {});
  assert.deepEqual(counts(f.db), baseline);
  const twin = await f.call(path, doctor, { ...cmd, requestId: randomUUID() });
  assert.equal(twin.status, 201);
  assert.notEqual(twin.data.receipt.patient.id, saved.data.receipt.patient.id);
  assert.deepEqual(
    (await f.call('/patients?search=' + encodeURIComponent(patientFields.name), doctor)).data
      .map((p: { id: string }) => p.id)
      .sort(),
    [saved.data.receipt.patient.id, twin.data.receipt.patient.id].sort(),
  );
  assert.deepEqual(counts(f.db), {
    ...baseline,
    patients: baseline.patients + 1,
    audits: baseline.audits + 1,
    commands: baseline.commands + 1,
  });
});

test('reviewed validation requires explicit reviewed fields and preserves compatibility defaults, empty values and staff roles', async (t) => {
  const f = await careApiFixture(t),
    doctor = await f.login('doctor'),
    admin = await f.login('admin'),
    reception = await f.login('reception');
  const cmd = command(),
    baseline = counts(f.db);
  for (const patch of [
    { registeredByRole: 'patient' },
    { name: ' ' },
    { name: 'a'.repeat(301) },
    { phone: '123456' },
    { phone: '0'.repeat(31) },
    { dob: '2001-02-29' },
    { dob: addDays(clinicToday(), 1) },
    { email: 'bad' },
    { gender: 'a'.repeat(51) },
    { allergies: 'x'.repeat(8001) },
    { reviewedConfirmed: false },
    { requestId: 'invalid' },
    { unknown: true },
  ]) {
    unconfirmed(await f.call(path, doctor, { ...cmd, ...patch }), 400);
  }
  for (const field of Object.keys(cmd)) {
    const partial: Partial<PatientRegistrationCommand> = { ...cmd };
    delete partial[field as keyof typeof cmd];
    unconfirmed(await f.call(path, doctor, partial), 400);
  }
  unconfirmed(await f.call(path + '?role=admin', doctor, cmd), 400);
  assert.deepEqual(counts(f.db), baseline);
  const legacy = await f.call('/patients?compatibility=true', reception, {
    name: ' Synthetic legacy chart ',
    phone: '9000000777',
    extra: 'legacy accepted',
  });
  assert.equal(legacy.status, 201);
  assert.deepEqual(legacy.data, {
    id: legacy.data.id,
    name: 'Synthetic legacy chart',
    email: '',
    phone: '9000000777',
    dob: '',
    gender: 'Prefer not to say',
    allergies: '',
    createdAt: legacy.data.createdAt,
  });
  changeUser(f.db, admin.user, { doctorId: undefined });
  const reviewed = await f.call(path, admin, command('admin', { allergies: 'Initial report' }));
  assert.equal(reviewed.status, 201);
  assert.equal(reviewed.data.receipt.patient.allergyStatus, 'recorded');
  changeUser(f.db, doctor.user, { doctorId: undefined });
  const plain = await f.call('/patients', doctor, patientFields);
  assert.equal(plain.status, 201);
  assert.equal(plain.data.allergyStatus, 'not-recorded');
  assert.equal(counts(f.db).commands, baseline.commands + 1);
});

test('independent writers resolve identical and colliding registrations once and keep separate commands distinct', async (t) => {
  const f = await careApiFixture(t),
    doctor = await f.login('doctor'),
    cmd = command(),
    baseline = counts(f.db);
  const duplicates = await simultaneousCareRequests(f, path, doctor, cmd);
  assert.deepEqual(duplicates.map((v) => v.status).sort(), [200, 201]);
  assert.deepEqual(duplicates[0].data, duplicates[1].data);
  const sameId = command(),
    other = { ...sameId, name: 'Synthetic competing command' };
  const competing = await simultaneousCareRequests(f, path, doctor, sameId, {
    who: doctor,
    body: other,
  });
  assert.deepEqual(competing.map((v) => v.status).sort(), [201, 409]);
  const winner = competing.findIndex((r) => r.status === 201);
  unconfirmed(competing[1 - winner], 409);
  const candidates = [sameId, other];
  assert.equal(competing[winner].data.receipt.patient.name, candidates[winner].name);
  assert.deepEqual((await f.call(path, doctor, candidates[winner])).data, competing[winner].data);
  const separate = await simultaneousCareRequests(f, path, doctor, command(), {
    who: doctor,
    body: command(),
  });
  assert.deepEqual(
    separate.map((v) => v.status),
    [201, 201],
  );
  assert.notEqual(separate[0].data.receipt.patient.id, separate[1].data.receipt.patient.id);
  assert.deepEqual(counts(f.db), {
    ...baseline,
    patients: baseline.patients + 4,
    audits: baseline.audits + 4,
    commands: baseline.commands + 4,
  });
});

test('the legacy writer and reviewed create or replay all refresh account authority and session security under the writer lock', async (t) => {
  const f = await careApiFixture(t),
    doctor = await f.login('doctor'),
    cmd = command('doctor', { allergies: 'Synthetic private text' });
  assert.equal((await f.call(path, doctor, cmd)).status, 201);
  const other = openDatabase(f.databasePath);
  t.after(() => other.close());
  const baseline = counts(f.db),
    user = doctor.user;
  const restore = () => changeUser(other, user, {});
  const sess = other.prepare('SELECT * FROM sessions WHERE userId=?').get(user.id)!;
  const changes: [number, () => unknown, () => unknown][] = [
    [401, () => changeUser(other, user, { active: false }), restore],
    [403, () => changeUser(other, user, { role: 'patient' }), restore],
    [403, () => changeUser(other, user, { role: 'receptionist' }), restore],
    [403, () => changeUser(other, user, { mustChangePassword: true }), restore],
    [
      401,
      () =>
        other
          .prepare('UPDATE sessions SET csrfToken=? WHERE userId=?')
          .run('changed token', user.id),
      () =>
        other
          .prepare('UPDATE sessions SET csrfToken=? WHERE userId=?')
          .run(sess.csrfToken, user.id),
    ],
    [
      401,
      () => other.prepare('UPDATE sessions SET expiresAt=0 WHERE userId=?').run(user.id),
      () =>
        other
          .prepare('UPDATE sessions SET expiresAt=? WHERE userId=?')
          .run(sess.expiresAt, user.id),
    ],
  ];
  for (const [route, body] of [
    [path, cmd],
    [path, { ...cmd, requestId: randomUUID() }],
    ['/patients', cmd],
  ] as const) {
    for (const [status, mutate, restoreState] of changes) {
      const reply = await beforeTransaction(f.db, 'BEGIN IMMEDIATE', mutate, () =>
        f.call(route, doctor, body),
      );
      restoreState();
      unconfirmed(reply, status);
      assert.ok(!JSON.stringify(reply.data).includes(cmd.allergies));
    }
  }
  assert.deepEqual(counts(f.db), baseline);
});

test('failed chart, audit or receipt storage rolls back; an authorized retry creates exactly one chart and audit', async (t) => {
  const f = await careApiFixture(t),
    doctor = await f.login('doctor'),
    cmd = command();
  const baseline = counts(f.db);
  for (const route of ['/patients', path]) {
    for (const table of [
      'patients',
      'audit',
      ...(route === path ? ['patientRegistrationCommands'] : []),
    ]) {
      f.db.exec(`CREATE TRIGGER synthetic_registration_failure BEFORE INSERT ON ${table}
        BEGIN SELECT RAISE(ABORT,'Synthetic registration storage failure'); END`);
      try {
        unconfirmed(await f.call(route, doctor, cmd), 500);
      } finally {
        f.db.exec('DROP TRIGGER synthetic_registration_failure');
      }
      assert.deepEqual(counts(f.db), baseline);
    }
  }
  const created = await f.call(path, doctor, cmd);
  assert.equal(created.status, 201);
  const repeat = await f.call(path, doctor, cmd);
  assert.equal(repeat.status, 200);
  assert.deepEqual(repeat.data, created.data);
  assert.deepEqual(counts(f.db), {
    ...baseline,
    patients: baseline.patients + 1,
    audits: baseline.audits + 1,
    commands: baseline.commands + 1,
  });
  assert.throws(() => f.db.exec('DELETE FROM patientRegistrationCommands'), /immutable/);
  assert.throws(() => f.db.exec('UPDATE patientRegistrationCommands SET rowid=rowid'), /immutable/);
});

test('public signup still creates its own chart and session independently of a staff chart with the same email', async (t) => {
  const f = await careApiFixture(t),
    doctor = await f.login('doctor'),
    baseline = counts(f.db);
  const staffChart = await f.call(path, doctor, command());
  assert.equal(staffChart.status, 201);
  assert.equal(counts(f.db).users, baseline.users);
  const userRegistration = await f.call('/auth/register', undefined, {
    ...patientFields,
    password: 'SyntheticSignup2026!',
  });
  assert.equal(userRegistration.status, 201, JSON.stringify(userRegistration.data));
  assert.ok(userRegistration.headers.get('set-cookie'));
  assert.notEqual(userRegistration.data.user.patientId, staffChart.data.receipt.patient.id);
  assert.equal(userRegistration.data.user.role, 'patient');
  assert.ok(!Object.hasOwn(userRegistration.data, 'receipt'));
  assert.equal(counts(f.db).commands, baseline.commands + 1);
  assert.equal(counts(f.db).users, baseline.users + 1);
  assert.equal(counts(f.db).patients, baseline.patients + 2);
});
