import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { addDays, clinicToday, openDatabase, type DB } from '../server/db.ts';
import type {
  DoctorProfileCreationCommand,
  DoctorProfileFields,
} from '../shared/doctor-profile-creation.ts';
import type { Doctor, User } from '../shared/types.ts';
import {
  beforeTransaction,
  careApiFixture,
  changeUser,
  simultaneousCareRequests,
  type Client,
} from './fixtures/care-api.ts';

const createPath = '/doctors/create';
const fields: DoctorProfileFields = {
  name: 'Dr. Synthetic Profile',
  title: 'Consultant',
  qualifications: 'Synthetic qualification',
  specialties: ['General dermatology', 'Hair'],
  experience: 4,
  fee: 450.5,
  bio: 'Synthetic professional biography.',
  languages: ['Marathi', 'English'],
  color: '#b3c7aa',
};
function command(): DoctorProfileCreationCommand {
  return { ...fields, requestId: randomUUID(), reviewedConfirmed: true };
}
function counts(db: DB) {
  return {
    ...db
      .prepare(
        `SELECT
    (SELECT COUNT(*) FROM doctors) profiles,
    (SELECT COUNT(*) FROM audit WHERE json_extract(data,'$.action')='created doctor profile') audits,
    (SELECT COUNT(*) FROM doctorProfileCreationCommands) commands`,
      )
      .get()!,
  };
}
function failed(reply: { status: number; data: Record<string, unknown> }, status: number) {
  assert.equal(reply.status, status, JSON.stringify(reply.data));
  for (const key of [
    'receipt',
    'command',
    'requestId',
    'actorId',
    'doctor',
    'doctorId',
    'originalDoctor',
  ])
    assert.ok(!Object.hasOwn(reply.data, key));
}
async function edit(
  base: string,
  route: string,
  who: Client,
  method: 'PATCH' | 'PUT',
  body: unknown,
) {
  const reply = await fetch(base + route, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: who.cookie, 'X-CSRF-Token': who.csrf },
    body: JSON.stringify(body),
  });
  assert.equal(reply.status, 200, await reply.text());
}

test('retries recover the normalized original after a profile edit, booking pause, schedule change and restart', async (t) => {
  const f = await careApiFixture(t),
    admin = await f.login('admin'),
    patient = await f.login('patient'),
    cmd = command();
  const created = await f.call(createPath, admin, {
    ...cmd,
    name: ' ' + cmd.name,
    specialties: cmd.specialties.map((s) => s + ' '),
    languages: cmd.languages.map((s) => ' ' + s),
    color: undefined,
    requestId: cmd.requestId.toUpperCase(),
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const doctor = created.data.receipt.doctor as Doctor;
  assert.match(doctor.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(created.data, {
    receipt: {
      requestId: cmd.requestId,
      actorId: admin.user.id,
      doctor: { ...fields, id: doctor.id },
    },
  });
  const account = await f.call('/users', admin, {
    name: 'Synthetic doctor login',
    email: 'profile@example.test',
    role: 'doctor',
    doctorId: doctor.id,
    password: 'Synthetic-onboarding-pass',
  });
  assert.equal(account.status, 201);
  await edit(f.base, '/schedules/' + doctor.id, admin, 'PUT', {
    windows: Array.from({ length: 7 }, (_, day) => ({
      day,
      start: '09:00',
      end: '18:00',
      mode: 'both',
    })),
    durationMinutes: 45,
  });
  const booked = await f.call('/appointments', patient, {
    doctorId: doctor.id,
    date: addDays(clinicToday(), 20),
    time: '09:00',
    reason: 'Synthetic booking',
    mode: 'in-person',
  });
  assert.equal(booked.status, 201, JSON.stringify(booked.data));
  assert.equal(booked.data.doctorName, fields.name);
  assert.equal(booked.data.fee, fields.fee);
  const changed = {
    ...fields,
    name: 'Dr. Updated',
    fee: 0,
    specialties: ['Updated specialty'],
    languages: ['Hindi'],
  };
  await edit(f.base, '/doctors/' + doctor.id, admin, 'PATCH', changed);
  const statusPath = '/doctors/' + doctor.id + '/booking-status';
  const status = await f.call(statusPath, admin);
  assert.equal(
    (
      await f.call(statusPath, admin, {
        requestId: randomUUID(),
        expectedRevision: status.data.revision,
        reason: 'Synthetic leave',
        acceptingNewBookings: false,
      })
    ).status,
    201,
  );
  changeUser(f.db, admin.user, { name: 'Renamed administrator' });
  const before = counts(f.db);
  await f.close();
  const reopened = await careApiFixture(t, f.databasePath);
  const retry = await reopened.call(
    createPath,
    admin,
    Object.fromEntries(Object.entries(cmd).reverse()),
  );
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.data, created.data);
  assert.deepEqual(counts(reopened.db), before);
  const directory = await reopened.call('/doctors');
  assert.deepEqual(
    directory.data.filter((d: Doctor) => d.id === doctor.id),
    [{ ...changed, id: doctor.id, appointmentDurationMinutes: 45, acceptingNewBookings: false }],
  );
  const appointments = (await reopened.call('/appointments', patient)).data;
  assert.deepEqual(
    appointments.find((a: { id: string }) => a.id === booked.data.id),
    booked.data,
  );
  const users = (await reopened.call('/users', admin)).data as User[];
  assert.equal(users.find((u) => u.id === account.data.id)?.doctorId, doctor.id);
  for (const projection of [
    directory.data,
    appointments,
    users,
    (await reopened.call('/audit', admin)).data,
  ])
    assert.ok(!JSON.stringify(projection).includes(cmd.requestId));
});

test('the request UUID belongs to one administrator and every ordered profile field', async (t) => {
  const f = await careApiFixture(t),
    admin = await f.login('admin'),
    other = await f.login('reception'),
    cmd = command();
  changeUser(f.db, other.user, { role: 'admin' });
  const original = await f.call(createPath, admin, cmd);
  assert.equal(original.status, 201);
  const baseline = counts(f.db);
  const collision = await f.call(createPath, other, cmd);
  failed(collision, 409);
  assert.ok(!JSON.stringify(collision.data).includes(fields.name));
  for (const patch of [
    { name: 'Renamed' },
    { title: 'Updated' },
    { qualifications: 'Changed' },
    { experience: 5 },
    { fee: 0 },
    { bio: '' },
    { color: '#B3C7AA' },
    { specialties: [...fields.specialties].reverse() },
    { languages: [...fields.languages].reverse() },
    { specialties: [...fields.specialties, fields.specialties[0]] },
  ]) {
    const rejected = await f.call(createPath, admin, { ...cmd, ...patch });
    failed(rejected, 409);
    assert.deepEqual(rejected.data, collision.data);
  }
  assert.deepEqual(counts(f.db), baseline);
  const twin = await f.call(createPath, other, { ...cmd, requestId: randomUUID() });
  assert.equal(twin.status, 201);
  assert.notEqual(twin.data.receipt.doctor.id, original.data.receipt.doctor.id);
  const directory = (await f.call('/doctors')).data as Doctor[];
  assert.equal(directory.filter((d) => d.name === cmd.name).length, 2);
});

test('reviewed input rejects undeclared or malformed fields and legacy creation keeps defaults, precision and response shape', async (t) => {
  const f = await careApiFixture(t),
    admin = await f.login('admin'),
    cmd = command(),
    baseline = counts(f.db);
  for (const key of Object.keys(cmd).filter((k) => k !== 'color')) {
    const partial = Object.fromEntries(Object.entries(cmd).filter(([k]) => k !== key));
    failed(await f.call(createPath, admin, partial), 400);
  }
  for (const patch of [
    { name: ' ' },
    { experience: 80.5 },
    { experience: -1 },
    { fee: 100001 },
    { bio: 'a'.repeat(8001) },
    { languages: [] },
    { specialties: [' '] },
    { languages: Array(21).fill('Synthetic') },
    { color: 'blue' },
    { requestId: 'bad' },
    { reviewedConfirmed: false },
    { appointmentDurationMinutes: 20 },
    { acceptingNewBookings: false },
    { id: 'supplied' },
  ])
    failed(await f.call(createPath, admin, { ...cmd, ...patch }), 400);
  failed(await f.call(createPath + '?extra=true', admin, cmd), 400);
  for (const who of [
    await f.login('patient'),
    await f.login('doctor'),
    await f.login('reception'),
  ]) {
    for (const route of [createPath, '/doctors']) failed(await f.call(route, who, cmd), 403);
  }
  failed(await f.call(createPath, undefined, cmd), 401);
  failed(await f.call(createPath, { ...admin, csrf: 'wrong' }, cmd), 403);
  assert.deepEqual(counts(f.db), baseline);
  const beforeUsers = (await f.call('/users', admin)).data;
  const beforeAppointments = (await f.call('/appointments', admin)).data;
  const legacy = await f.call('/doctors?compat=true', admin, {
    ...cmd,
    color: undefined,
    bio: ' ',
    experience: 80,
    fee: 0,
    id: 'unused',
    acceptingNewBookings: false,
  });
  assert.equal(legacy.status, 201);
  assert.deepEqual(legacy.data, { ...fields, id: legacy.data.id, experience: 80, fee: 0, bio: '' });
  assert.notEqual(legacy.data.id, 'unused');
  assert.deepEqual(counts(f.db), {
    ...baseline,
    profiles: Number(baseline.profiles) + 1,
    audits: Number(baseline.audits) + 1,
  });
  assert.deepEqual((await f.call('/users', admin)).data, beforeUsers);
  assert.deepEqual((await f.call('/appointments', admin)).data, beforeAppointments);
  // The legacy input tolerates unknown fields. It cannot claim a UUID sent to that route.
  assert.equal((await f.call(createPath, admin, cmd)).status, 201);
});

test('independent SQLite writers settle duplicates and collisions, and permit separate identical public profiles', async (t) => {
  const f = await careApiFixture(t),
    admin = await f.login('admin'),
    baseline = counts(f.db);
  const duplicates = await simultaneousCareRequests(f, createPath, admin, command());
  assert.deepEqual(duplicates.map((r) => r.status).sort(), [200, 201]);
  assert.deepEqual(duplicates[0].data, duplicates[1].data);
  const candidate = command(),
    other = { ...candidate, fee: 1 };
  const clash = await simultaneousCareRequests(f, createPath, admin, candidate, {
    who: admin,
    body: other,
  });
  assert.deepEqual(clash.map((r) => r.status).sort(), [201, 409]);
  const winner = clash.findIndex((r) => r.status === 201);
  failed(clash[1 - winner], 409);
  assert.equal(clash[winner].data.receipt.doctor.fee, [candidate, other][winner].fee);
  assert.deepEqual(
    (await f.call(createPath, admin, [candidate, other][winner])).data,
    clash[winner].data,
  );
  const twins = await simultaneousCareRequests(f, createPath, admin, command(), {
    who: admin,
    body: command(),
  });
  assert.deepEqual(
    twins.map((r) => r.status),
    [201, 201],
  );
  assert.notEqual(twins[0].data.receipt.doctor.id, twins[1].data.receipt.doctor.id);
  assert.deepEqual(counts(f.db), {
    profiles: Number(baseline.profiles) + 4,
    commands: 4,
    audits: 4,
  });
});

test('administrator, session, CSRF and MFA authority is checked under the write lock for legacy, new and replayed profiles', async (t) => {
  const f = await careApiFixture(t),
    admin = await f.login('admin'),
    saved = command();
  assert.equal((await f.call(createPath, admin, saved)).status, 201);
  const other = openDatabase(f.databasePath),
    user = admin.user,
    before = counts(f.db);
  t.after(() => other.close());
  const session = other
    .prepare('SELECT csrfToken,expiresAt FROM sessions WHERE userId=?')
    .get(user.id)!;
  const restore = () => changeUser(other, user, {});
  const changes: [number, () => unknown, () => unknown][] = [
    [403, () => changeUser(other, user, { role: 'doctor' }), restore],
    [403, () => changeUser(other, user, { mustChangePassword: true }), restore],
    [401, () => changeUser(other, user, { active: false }), restore],
    [
      401,
      () => other.prepare('UPDATE sessions SET expiresAt=0 WHERE userId=?').run(user.id),
      () =>
        other
          .prepare('UPDATE sessions SET expiresAt=? WHERE userId=?')
          .run(session.expiresAt, user.id),
    ],
    [
      401,
      () => other.prepare("UPDATE sessions SET csrfToken='changed' WHERE userId=?").run(user.id),
      () =>
        other
          .prepare('UPDATE sessions SET csrfToken=? WHERE userId=?')
          .run(session.csrfToken, user.id),
    ],
    [
      401,
      () =>
        other
          .prepare(
            "INSERT INTO mfaCredentials VALUES (?,'new-credential','synthetic','2026-01-01',0)",
          )
          .run(user.id),
      () => other.prepare('DELETE FROM mfaCredentials WHERE userId=?').run(user.id),
    ],
  ];
  for (const [route, body] of [
    ['/doctors', fields],
    [createPath, command()],
    [createPath, saved],
  ] as const) {
    for (const [status, mutate, reset] of changes) {
      const result = await beforeTransaction(f.db, 'BEGIN IMMEDIATE', mutate, () =>
        f.call(route, admin, body),
      );
      reset();
      failed(result, status);
    }
  }
  assert.deepEqual(counts(f.db), before);
});

test('profile, creation audit and receipt roll back together on storage failure for both creation routes', async (t) => {
  const f = await careApiFixture(t),
    admin = await f.login('admin'),
    cmd = command(),
    before = counts(f.db);
  const directory = (await f.call('/doctors')).data;
  for (const route of ['/doctors', createPath]) {
    for (const table of [
      'doctors',
      'audit',
      ...(route === createPath ? ['doctorProfileCreationCommands'] : []),
    ]) {
      f.db.exec(
        'CREATE TRIGGER synthetic_profile_failure BEFORE INSERT ON ' +
          table +
          " BEGIN SELECT RAISE(ABORT,'Synthetic doctor profile failure'); END;",
      );
      try {
        failed(await f.call(route, admin, cmd), 500);
      } finally {
        f.db.exec('DROP TRIGGER synthetic_profile_failure');
      }
      assert.deepEqual(counts(f.db), before);
      assert.deepEqual((await f.call('/doctors')).data, directory);
    }
  }
  const saved = await f.call(createPath, admin, cmd);
  assert.equal(saved.status, 201);
  const retry = await f.call(createPath, admin, cmd);
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.data, saved.data);
  assert.deepEqual(counts(f.db), { profiles: Number(before.profiles) + 1, audits: 1, commands: 1 });
  assert.throws(
    () => f.db.exec('UPDATE doctorProfileCreationCommands SET rowid=rowid'),
    /immutable/,
  );
  assert.throws(() => f.db.exec('DELETE FROM doctorProfileCreationCommands'), /immutable/);
});
