import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { openDatabase, verifyPassword, type DB } from '../server/db.ts';
import type { StaffAccountCreationReview } from '../shared/staff-account-creation.ts';
import {
  beforeTransaction,
  careApiFixture,
  changeUser,
  simultaneousCareRequests,
} from './fixtures/care-api.ts';

const create = '/users/create';
const resolve = '/users/creation-outcome';
const initial = ' Synthetic initial secret! ';
const replacement = 'Synthetic replacement secret!';
const different = 'Synthetic alternate secret!';
const closureCode = 'STAFF_ACCOUNT_NOT_CREATED';
function review(patch: Partial<StaffAccountCreationReview> = {}): StaffAccountCreationReview {
  return {
    name: 'Synthetic Staff',
    email: 'staff@example.test',
    role: 'receptionist',
    doctorId: null,
    requestId: randomUUID(),
    reviewedConfirmed: true,
    ...patch,
  };
}

function counts(db: DB) {
  const row = db
    .prepare(
      `SELECT
    (SELECT COUNT(*) FROM users) users,
    (SELECT COUNT(*) FROM audit WHERE json_extract(data,'$.action')='created staff account') audits,
    (SELECT COUNT(*) FROM staffAccountCreationCommands) commands`,
    )
    .get()!;
  return { users: Number(row.users), audits: Number(row.audits), commands: Number(row.commands) };
}

function unmarked(result: { status: number; data: Record<string, unknown> }, status: number) {
  assert.equal(result.status, status);
  for (const key of ['receipt', 'actorId', 'review', 'account', 'requestId']) {
    assert.ok(!Object.hasOwn(result.data, key), key);
  }
  assert.notEqual(result.data.code, closureCode);
}

test('creation normalizes reviewed metadata and recovers the original receipt after rotation, account edits and reopening', async (t) => {
  const f = await careApiFixture(t),
    admin = await f.login('admin');
  const cmd = review({ role: 'doctor', doctorId: 'doctor-meera' });
  const saved = await f.call(create, admin, {
    requestId: cmd.requestId.toUpperCase(),
    password: initial,
    reviewedConfirmed: true,
    role: cmd.role,
    doctorId: ' doctor-meera ',
    email: '  STAFF@EXAMPLE.TEST ',
    name: '  Synthetic Staff  ',
  });
  assert.equal(saved.status, 201);
  const accountId = saved.data.receipt.account.id;
  const original = {
    id: accountId,
    name: cmd.name,
    email: cmd.email,
    role: cmd.role,
    doctorId: cmd.doctorId,
    active: true,
    mustChangePassword: true,
  };
  assert.deepEqual(saved.data, {
    receipt: { actorId: admin.user.id, requestId: cmd.requestId, account: original },
  });
  const row = f.db
    .prepare('SELECT * FROM staffAccountCreationCommands WHERE requestId=?')
    .get(cmd.requestId)!;
  const initialVerifier = String(
    f.db.prepare('SELECT password FROM users WHERE id=?').get(accountId)!.password,
  );
  assert.ok(verifyPassword(initial, initialVerifier));
  assert.deepEqual(
    { ...row },
    {
      requestId: cmd.requestId,
      actorId: admin.user.id,
      reviewHash: createHash('sha256').update(JSON.stringify(cmd)).digest('hex'),
      accountId,
      originalAccount: JSON.stringify(saved.data.receipt.account),
      refusal: null,
    },
  );
  const auth = (password: string) =>
    f.call('/auth/login', undefined, { email: cmd.email, password });
  const signedIn = await auth(initial);
  assert.equal(signedIn.status, 200);
  const staff = {
    user: signedIn.data.user,
    csrf: signedIn.data.csrfToken,
    cookie: signedIn.headers.get('set-cookie')!.split(';')[0],
  };
  assert.equal(
    (await f.call('/auth/password', staff, { currentPassword: initial, newPassword: replacement }))
      .status,
    200,
  );
  const rotated = f.db.prepare('SELECT password FROM users WHERE id=?').get(accountId)!.password;
  assert.notEqual(rotated, initialVerifier);
  const replay = await f.call(create, admin, { ...cmd, password: different });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data, saved.data);
  assert.equal(
    f.db.prepare('SELECT password FROM users WHERE id=?').get(accountId)!.password,
    rotated,
  );
  for (const [password, status] of [
    [initial, 401],
    [different, 401],
    [replacement, 200],
  ] as const) {
    assert.equal((await auth(password)).status, status);
  }
  const updated = await fetch(f.base + '/accounts/' + accountId, {
    method: 'PATCH',
    headers: {
      Cookie: admin.cookie,
      'X-CSRF-Token': admin.csrf,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: 'New name', role: 'receptionist', doctorId: null, active: false }),
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).mustChangePassword, false);
  changeUser(f.db, admin.user, { name: 'Renamed administrator' });
  await f.close();
  const reopened = await careApiFixture(t, f.databasePath);
  const recovered = await reopened.call(resolve, admin, cmd);
  assert.equal(recovered.status, 200);
  assert.deepEqual(recovered.data, saved.data);
  const evidence = JSON.stringify([
    recovered.data,
    row,
    reopened.db.prepare('SELECT data FROM users WHERE id=?').get(accountId),
    reopened.db.prepare('SELECT data FROM audit').all(),
    (await reopened.call('/users', admin)).data,
    (await reopened.call('/accounts', admin)).data,
  ]);
  for (const secret of [initial, replacement, different, initialVerifier, String(rotated)])
    assert.ok(!evidence.includes(secret));
  assert.equal(counts(reopened.db).audits, 1);
});

test('a secret-free check closes an unknown ID and its late creation stays refused after a fresh request succeeds', async (t) => {
  const f = await careApiFixture(t),
    admin = await f.login('admin'),
    cmd = review(),
    baseline = counts(f.db);
  const closed = await f.call(resolve, admin, cmd);
  assert.equal(closed.status, 409);
  assert.deepEqual(closed.data, {
    code: closureCode,
    actorId: admin.user.id,
    review: cmd,
    message: closed.data.message,
  });
  assert.match(closed.data.message, /closed before an account was created/i);
  assert.deepEqual(counts(f.db), { ...baseline, commands: 1 });
  const fresh = review();
  const saved = await f.call(create, admin, { ...fresh, password: different });
  assert.equal(saved.status, 201);
  await f.close();
  const reopened = await careApiFixture(t, f.databasePath);
  for (const [route, body] of [
    [create, { ...cmd, password: initial }],
    [resolve, cmd],
  ] as const) {
    const reply = await reopened.call(route, admin, body);
    assert.equal(reply.status, 409);
    assert.deepEqual(reply.data, closed.data);
  }
  assert.deepEqual(counts(reopened.db), { users: baseline.users + 1, audits: 1, commands: 2 });
  const verifier = String(
    reopened.db.prepare('SELECT password FROM users WHERE email=?').get(cmd.email)!.password,
  );
  assert.ok(verifyPassword(different, verifier));
  assert.ok(!verifyPassword(initial, verifier));
});

test('reviewed eligibility refusals are durable across later changes to email availability or profile linkage', async (t) => {
  const f = await careApiFixture(t),
    admin = await f.login('admin'),
    base = counts(f.db);
  const newProfile = 'new-doctor-profile';
  for (const [cmd, pattern] of [
    [review({ email: 'admin@derma.demo' }), /already exists/],
    [review({ role: 'doctor' }), /link a doctor/i],
    [review({ role: 'doctor', doctorId: newProfile }), /not found/i],
    [review({ doctorId: 'doctor-meera' }), /cannot be linked/i],
  ] as const) {
    const refusal = await f.call(create, admin, { ...cmd, password: initial });
    assert.equal(refusal.status, 409);
    assert.deepEqual(refusal.data, {
      code: closureCode,
      actorId: admin.user.id,
      review: cmd,
      message: refusal.data.message,
    });
    assert.match(refusal.data.message, pattern);
    if (cmd.doctorId === newProfile)
      f.db
        .prepare("INSERT INTO doctors(id,data) VALUES (?,json_object('id',?))")
        .run(newProfile, newProfile);
    if (cmd.email === 'admin@derma.demo')
      f.db.prepare('UPDATE users SET email=? WHERE id=?').run('moved@example.test', admin.user.id);
    assert.deepEqual((await f.call(resolve, admin, cmd)).data, refusal.data);
    assert.deepEqual(
      (await f.call(create, admin, { ...cmd, password: different })).data,
      refusal.data,
    );
  }
  assert.deepEqual(counts(f.db), { ...base, commands: 4 });
});

test('shape errors, unauthorized accounts and collisions never return account evidence or close another administrator’s ID', async (t) => {
  const f = await careApiFixture(t),
    admin = await f.login('admin'),
    doctor = await f.login('doctor'),
    cmd = review();
  const baseline = counts(f.db);
  for (const [route, body] of [
    [create, { ...cmd, password: 'short' }],
    [create, { ...cmd, password: initial, x: 1 }],
    [create, { ...cmd, password: initial, role: 'patient' }],
    [create, { ...cmd, password: initial, requestId: 'bad' }],
    [create, { ...cmd, password: initial, reviewedConfirmed: false }],
    [resolve, { ...cmd, password: initial }],
    [resolve, { ...cmd, doctorId: undefined }],
    [resolve, { ...cmd, name: ' ' }],
    [resolve + '?password=unexpected', cmd],
  ] as const)
    unmarked(await f.call(route, admin, body), 400);
  for (const [route, body] of [
    [resolve, cmd],
    [create, { ...cmd, password: initial }],
  ] as const) {
    unmarked(await f.call(route, doctor, body), 403);
    unmarked(await f.call(route, undefined, body), 401);
    unmarked(await f.call(route, { ...admin, csrf: 'incorrect' }, body), 403);
  }
  assert.deepEqual(counts(f.db), baseline);
  const closed = review({ email: 'closed@example.test' });
  assert.equal((await f.call(resolve, admin, closed)).status, 409);
  assert.equal((await f.call(create, admin, { ...cmd, password: initial })).status, 201);
  changeUser(f.db, doctor.user, { role: 'admin' });
  for (const original of [cmd, closed]) {
    for (const variant of [
      { name: 'Edited' },
      { role: 'admin' },
      { doctorId: 'doctor-meera' },
      { email: 'other@example.test' },
    ]) {
      unmarked(await f.call(resolve, admin, { ...original, ...variant }), 409);
      unmarked(await f.call(create, admin, { ...original, ...variant, password: different }), 409);
    }
    unmarked(await f.call(resolve, doctor, original), 409);
    unmarked(await f.call(create, doctor, { ...original, password: different }), 409);
  }
  assert.deepEqual(counts(f.db), { users: baseline.users + 1, commands: 2, audits: 1 });
});

test('legacy creation keeps its statuses, optional links, ignored fields and direct account response', async (t) => {
  const f = await careApiFixture(t),
    admin = await f.login('admin');
  const input = {
    name: '  Legacy  ',
    email: '  LEGACY@EXAMPLE.TEST  ',
    role: 'receptionist',
    password: initial,
  };
  for (const [patch, status] of [
    [{ role: 'doctor' }, 400],
    [{ doctorId: null }, 400],
    [{ doctorId: 'doctor-meera' }, 400],
    [{ role: 'doctor', doctorId: 'absent' }, 404],
    [{ role: 'patient' }, 400],
  ] as const)
    unmarked(await f.call('/users', admin, { ...input, ...patch }), status);
  const first = await f.call('/users?ignored=1', admin, {
    ...input,
    unknown: 'ignore',
    active: false,
    mustChangePassword: false,
  });
  assert.equal(first.status, 201);
  assert.deepEqual(first.data, {
    id: first.data.id,
    name: 'Legacy',
    email: 'legacy@example.test',
    role: 'receptionist',
    active: true,
    mustChangePassword: true,
  });
  unmarked(await f.call('/users', admin, input), 409);
  for (const [role, doctorId] of [
    ['doctor', 'doctor-meera'],
    ['admin', 'doctor-arjun'],
    ['admin', undefined],
  ] as const) {
    const created = await f.call('/users', admin, {
      ...input,
      role,
      doctorId,
      email: randomUUID() + '@example.test',
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.doctorId, doctorId);
  }
  assert.equal(counts(f.db).commands, 0);
  assert.equal(counts(f.db).audits, 4);
});

test('independent writers serialize duplicate metadata with competing passwords, competing email and creation versus lookup', async (t) => {
  const f = await careApiFixture(t),
    admin = await f.login('admin'),
    cmd = review(),
    base = counts(f.db);
  const duplicates = await simultaneousCareRequests(
    f,
    create,
    admin,
    { ...cmd, password: initial },
    { who: admin, body: { ...cmd, password: different } },
  );
  assert.deepEqual(duplicates.map((r) => r.status).sort(), [200, 201]);
  assert.deepEqual(duplicates[0].data, duplicates[1].data);
  const verifier = String(
    f.db.prepare('SELECT password FROM users WHERE email=?').get(cmd.email)!.password,
  );
  assert.equal(verifyPassword(initial, verifier), duplicates[0].status === 201);
  assert.equal(verifyPassword(different, verifier), duplicates[1].status === 201);
  const next = review({ email: 'unique@example.test' }),
    competitor = review({ email: next.email });
  const contenders = await simultaneousCareRequests(
    f,
    create,
    admin,
    { ...next, password: initial },
    { who: admin, body: { ...competitor, password: different } },
  );
  assert.deepEqual(contenders.map((r) => r.status).sort(), [201, 409]);
  for (const [index, submitted] of [next, competitor].entries()) {
    const confirmation = await f.call(resolve, admin, submitted);
    assert.equal(confirmation.status, contenders[index].status === 201 ? 200 : 409);
    assert.deepEqual(confirmation.data, contenders[index].data);
  }
  const last = review({ email: 'race@example.test' });
  const [submit, check] = await simultaneousCareRequests(
    f,
    create,
    admin,
    { ...last, password: initial },
    { who: admin, body: last, route: resolve },
  );
  assert.ok(
    (submit.status === 201 && check.status === 200) ||
      (submit.status === 409 && check.status === 409 && check.data.code === closureCode),
  );
  assert.deepEqual(submit.data, check.data);
  assert.deepEqual((await f.call(resolve, admin, last)).data, check.data);
  const created = submit.status === 201 ? 3 : 2;
  assert.deepEqual(counts(f.db), { users: base.users + created, commands: 4, audits: created });
});

test('each write and outcome reauthorizes the current administrator and session under the SQLite writer lock', async (t) => {
  const f = await careApiFixture(t),
    admin = await f.login('admin'),
    cmd = review(),
    closed = review({ email: 'closed@example.test' }),
    fresh = review({ email: 'fresh@example.test' });
  assert.equal((await f.call(create, admin, { ...cmd, password: initial })).status, 201);
  assert.equal((await f.call(resolve, admin, closed)).data.code, closureCode);
  const baseline = counts(f.db),
    other = openDatabase(f.databasePath),
    user = admin.user;
  t.after(() => other.close());
  const session = other
    .prepare('SELECT csrfToken,expiresAt FROM sessions WHERE userId=?')
    .get(user.id)!;
  const restore = () => changeUser(other, user, {});
  const mutations: [number, () => unknown, () => unknown][] = [
    [401, () => changeUser(other, user, { active: false }), restore],
    [403, () => changeUser(other, user, { role: 'doctor' }), restore],
    [403, () => changeUser(other, user, { mustChangePassword: true }), restore],
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
      () => other.prepare("UPDATE sessions SET csrfToken='rotated' WHERE userId=?").run(user.id),
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
    ['/users', { ...fresh, doctorId: undefined, password: initial }],
    [create, { ...fresh, password: initial }],
    [create, { ...cmd, password: different }],
    [create, { ...closed, password: different }],
    [resolve, cmd],
    [resolve, closed],
    [resolve, fresh],
  ] as const) {
    for (const [status, mutate, reset] of mutations) {
      const reply = await beforeTransaction(f.db, 'BEGIN IMMEDIATE', mutate, () =>
        f.call(route, admin, body),
      );
      reset();
      unmarked(reply, status);
      assert.ok(!JSON.stringify(reply.data).includes(cmd.email));
    }
  }
  assert.deepEqual(counts(f.db), baseline);
});

test('failed account, audit, receipt and closure writes roll back completely and allow a later checked creation', async (t) => {
  const f = await careApiFixture(t),
    admin = await f.login('admin'),
    cmd = review(),
    baseline = counts(f.db);
  for (const [route, body, tables] of [
    ['/users', { ...cmd, doctorId: undefined, password: initial }, ['users', 'audit']],
    [create, { ...cmd, password: initial }, ['users', 'audit', 'staffAccountCreationCommands']],
    [resolve, cmd, ['staffAccountCreationCommands']],
    [
      create,
      { ...cmd, email: 'admin@derma.demo', password: initial },
      ['staffAccountCreationCommands'],
    ],
  ] as const) {
    for (const table of tables) {
      f.db.exec(
        'CREATE TRIGGER synthetic_staff_failure BEFORE INSERT ON ' +
          table +
          " BEGIN SELECT RAISE(ABORT,'Synthetic staff storage failure'); END;",
      );
      try {
        unmarked(await f.call(route, admin, body), 500);
      } finally {
        f.db.exec('DROP TRIGGER synthetic_staff_failure');
      }
      assert.deepEqual(counts(f.db), baseline);
    }
  }
  const saved = await f.call(create, admin, { ...cmd, password: initial });
  assert.equal(saved.status, 201);
  assert.deepEqual((await f.call(resolve, admin, cmd)).data, saved.data);
  assert.deepEqual(counts(f.db), { users: baseline.users + 1, audits: 1, commands: 1 });
  assert.throws(() => f.db.exec('DELETE FROM staffAccountCreationCommands'), /immutable/);
  assert.throws(
    () => f.db.exec('UPDATE staffAccountCreationCommands SET rowid=rowid'),
    /immutable/,
  );
});
