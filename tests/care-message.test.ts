import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { get, openDatabase, type DB } from '../server/db.ts';
import type { User } from '../shared/types.ts';
import type { CareMessageCommand } from '../shared/care-message.ts';

import { beforeTransaction, careApiFixture as fixture, changeUser } from './fixtures/care-api.ts';
const patientId = 'patient-ananya';
const sendPath = '/messages/send';
function command(body = 'Synthetic private message'): CareMessageCommand {
  return { requestId: randomUUID(), patientId, body };
}

function counts(db: DB) {
  return Object.fromEntries(
    ['messages', 'activity', 'audit', 'careMessageCommands'].map((table) => [
      table,
      Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n),
    ]),
  );
}

function followUp(db: DB, enabled: boolean) {
  db.prepare(
    "UPDATE meta SET value=json_set(value,'$.modules.followUp',json(?)) WHERE key='settings'",
  ).run(JSON.stringify(enabled));
}

test('patient and clinic messages bind original authors and exact normalized text, with one audit and the existing in-app recipients', async (t) => {
  const f = await fixture(t);
  const patient = await f.login('patient'),
    doctor = await f.login('doctor'),
    admin = await f.login('admin');
  const reception = await f.login('reception');
  for (const [actor, recipients] of [
    [patient, [doctor, admin]],
    [doctor, [patient]],
    [admin, [patient]],
  ] as const) {
    const input = command('  Synthetic private\nmessage for ' + actor.user.role + '  ');
    const before = counts(f.db);
    const saved = await f.call(sendPath, actor, {
      ...input,
      patientId: ' ' + patientId + ' ',
      requestId: input.requestId.toUpperCase(),
    });
    assert.equal(saved.status, 201, JSON.stringify(saved.data));
    const msg = saved.data.receipt.message;
    assert.deepEqual(saved.data, {
      receipt: {
        requestId: input.requestId,
        actorId: actor.user.id,
        actorName: actor.user.name,
        actorRole: actor.user.role,
        patientId,
        message: {
          id: msg.id,
          patientId,
          body: input.body.trim(),
          authorRole: actor.user.role,
          authorName: actor.user.name,
          createdAt: msg.createdAt,
        },
      },
    });
    assert.match(msg.id, /^[a-f0-9-]{36}$/);
    assert.equal(new Date(msg.createdAt).toISOString(), msg.createdAt);
    assert.deepEqual(counts(f.db), {
      messages: before.messages + 1,
      activity: before.activity + recipients.length,
      audit: before.audit + 1,
      careMessageCommands: before.careMessageCommands + 1,
    });
    const notices = f.db
      .prepare('SELECT userId,data FROM activity WHERE eventKey=? ORDER BY userId')
      .all('message:' + msg.id);
    assert.deepEqual(
      notices.map((n) => n.userId),
      recipients.map((u) => u.user.id).sort(),
    );
    for (const notice of notices) {
      const data = JSON.parse(String(notice.data));
      assert.equal(data.kind, 'message');
      assert.equal(
        data.href,
        actor === patient ? '/clinic/patients/' + patientId + '?tab=messages' : '/my-care/messages',
      );
      assert.equal(String(notice.data).includes(input.body.trim()), false);
    }
    const audit = f.db
      .prepare("SELECT data FROM audit WHERE json_extract(data,'$.entityId')=?")
      .all(msg.id);
    assert.equal(JSON.parse(String(audit[0].data)).action, 'sent care message');
    assert.equal(JSON.parse(String(audit[0].data)).actorName, actor.user.name);
    const state = counts(f.db);
    const replay = await f.call(sendPath, actor, { ...input, body: input.body.trim() });
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.data, saved.data);
    assert.deepEqual(counts(f.db), state);
    const thread = await f.call('/messages?patientId=' + patientId, patient);
    assert.deepEqual(thread.data.at(-1), msg);
    assert.equal(JSON.stringify(thread.data).includes(input.requestId), false);
    const summary = await f.call('/patients/' + patientId + '/care-summary', patient);
    assert.equal(summary.status, 200);
    assert.equal(JSON.stringify(summary.data).includes('Synthetic private'), false);
    assert.equal(JSON.stringify(summary.data).includes(input.requestId), false);
  }
  assert.equal((await f.call('/messages?patientId=' + patientId, reception)).status, 403);
  assert.equal((await f.call('/messages?patientId=patient-2', patient)).status, 403);
  assert.equal((await f.call('/messages?patientId=' + patientId)).status, 401);
});

test('strict new commands, current patient access and legacy plain responses retain distinct contracts', async (t) => {
  const f = await fixture(t),
    patient = await f.login('patient'),
    admin = await f.login('admin'),
    reception = await f.login('reception');
  const input = command();
  const initial = counts(f.db);
  for (const patch of [
    { unexpected: true },
    { authorRole: 'doctor' },
    { actorId: 'user-admin' },
    { patientId: undefined },
    { requestId: undefined },
    { requestId: 'text' },
    { body: '  ' },
    { body: 'x'.repeat(4001) },
  ]) {
    const response = await f.call(sendPath, patient, { ...input, ...patch });
    assert.equal(response.status, 400);
    assert.equal(response.data.code, undefined);
  }
  assert.equal((await f.call(sendPath + '?extra=true', patient, input)).status, 400);
  for (const [who, target, status] of [
    [patient, 'patient-2', 403],
    [reception, patientId, 403],
    [undefined, patientId, 401],
    [{ ...patient, csrf: 'bad' }, patientId, 403],
    [admin, 'missing-patient', 404],
  ] as const) {
    const result = await f.call(sendPath, who, { ...input, patientId: target });
    assert.equal(result.status, status);
    assert.equal(result.data.code, undefined);
  }
  assert.deepEqual(counts(f.db), initial);
  const legacy = await f.call('/messages?ignored=1', patient, {
    body: ' Legacy hello ',
    authorName: 'wrong',
    requestId: 'ignored',
  });
  assert.equal(legacy.status, 201);
  assert.equal(legacy.data.body, 'Legacy hello');
  assert.equal(legacy.data.authorName, patient.user.name);
  assert.equal(legacy.data.receipt, undefined);
  assert.equal(legacy.data.requestId, undefined);
  assert.equal((await f.call('/messages', patient)).data.at(-1).id, legacy.data.id);
  assert.equal(counts(f.db).careMessageCommands, initial.careMessageCommands);
  // Messaging permits clinical staff without a linked professional profile.
  changeUser(f.db, admin.user, { doctorId: undefined });
  assert.equal((await f.call(sendPath, admin, { ...input, body: 'x'.repeat(4000) })).status, 201);
});

test('paused new commands stay rejected after resumption, existing commits survive pause and rename, and collisions reveal neither message nor terminal outcome', async (t) => {
  const f = await fixture(t),
    doctor = await f.login('doctor'),
    admin = await f.login('admin');
  const input = command('Private original wording');
  const saved = await f.call(sendPath, doctor, input);
  assert.equal(saved.status, 201);
  followUp(f.db, false);
  changeUser(f.db, doctor.user, {
    name: 'New doctor name',
    doctorId: 'doctor-arjun',
    role: 'admin',
  });
  const previous = counts(f.db);
  const replay = await f.call(sendPath, doctor, input);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data, saved.data);
  assert.deepEqual(counts(f.db), previous);
  const rejectedInput = command('Private rejected wording');
  const rejected = await f.call(sendPath, doctor, {
    ...rejectedInput,
    body: ' ' + rejectedInput.body + ' ',
  });
  assert.equal(rejected.status, 403);
  assert.deepEqual(rejected.data, {
    ...rejectedInput,
    actorId: doctor.user.id,
    code: 'MESSAGE_NOT_SENT',
    message: 'This module is currently disabled by the clinic.',
  });
  assert.deepEqual(counts(f.db), {
    ...previous,
    careMessageCommands: previous.careMessageCommands + 1,
  });
  assert.equal((await f.call('/messages', doctor, input)).data.code, undefined);
  assert.equal(
    (await f.call('/messages?patientId=' + patientId, doctor)).data.at(-1).id,
    saved.data.receipt.message.id,
  );
  followUp(f.db, true);
  const replayRejected = await f.call(sendPath, doctor, rejectedInput);
  assert.equal(replayRejected.status, 403);
  assert.deepEqual(replayRejected.data, rejected.data);
  const state = counts(f.db);
  for (const original of [input, rejectedInput]) {
    for (const [who, changed] of [
      [admin, original],
      [doctor, { ...original, patientId: 'patient-2' }],
      [doctor, { ...original, body: original.body + '!' }],
    ] as const) {
      const collision = await f.call(sendPath, who, changed);
      assert.equal(collision.status, 409);
      assert.equal(collision.data.code, undefined);
      assert.equal(JSON.stringify(collision.data).includes(original.body), false);
    }
  }
  assert.deepEqual(counts(f.db), state);
  const fresh = await f.call(sendPath, doctor, command(rejectedInput.body));
  assert.equal(fresh.status, 201);
  assert.equal(fresh.data.receipt.message.authorName, 'New doctor name');
  assert.equal(fresh.data.receipt.message.authorRole, 'admin');
});

test('message, audit, recipient activity and command failures roll back the complete send and rejection storage never acknowledges a failed transaction', async (t) => {
  const f = await fixture(t),
    patient = await f.login('patient');
  for (const route of [sendPath, '/messages']) {
    for (const table of [
      'messages',
      'audit',
      'activity',
      ...(route === sendPath ? ['careMessageCommands'] : []),
    ]) {
      // The second clinician notice fails after one recipient has already been processed.
      const where = table === 'activity' ? "WHEN NEW.userId='user-admin'" : '';
      f.db.exec(
        `CREATE TRIGGER fail_send BEFORE INSERT ON ${table} ${where} BEGIN SELECT RAISE(ABORT,'test failure'); END`,
      );
      const initial = counts(f.db),
        body = command();
      const failed = await f.call(route, patient, body);
      f.db.exec('DROP TRIGGER fail_send');
      assert.equal(failed.status, 500);
      assert.equal(failed.data.code, undefined);
      assert.deepEqual(counts(f.db), initial);
      assert.equal((await f.call(route, patient, body)).status, 201);
    }
  }
  followUp(f.db, false);
  const input = command(),
    initial = counts(f.db);
  f.db.exec(
    "CREATE TRIGGER fail_rejection BEFORE INSERT ON careMessageCommands BEGIN SELECT RAISE(ABORT,'test failure'); END",
  );
  const failed = await f.call(sendPath, patient, input);
  f.db.exec('DROP TRIGGER fail_rejection');
  assert.equal(failed.status, 500);
  assert.equal(failed.data.code, undefined);
  assert.deepEqual(counts(f.db), initial);
  followUp(f.db, true);
  assert.equal((await f.call(sendPath, patient, input)).status, 201);
});

test('an immutable send serializes across two application connections; separate intentions remain separate across restart', async (t) => {
  const f = await fixture(t),
    other = await fixture(t, f.databasePath),
    patient = await f.login('patient');
  const input = command();
  const initial = counts(f.db);
  const results = await Promise.all([
    f.call(sendPath, patient, input),
    other.call(sendPath, patient, input),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 201]);
  assert.deepEqual(results[0].data, results[1].data);
  assert.deepEqual(counts(f.db), {
    messages: initial.messages + 1,
    audit: initial.audit + 1,
    activity: initial.activity + 2,
    careMessageCommands: initial.careMessageCommands + 1,
  });
  const another = await other.call(sendPath, patient, command(input.body));
  assert.notEqual(another.data.receipt.message.id, results[0].data.receipt.message.id);
  followUp(f.db, false);
  const rejected = command(),
    denial = await f.call(sendPath, patient, rejected);
  assert.equal(denial.status, 403);
  for (const table of ['messages', 'careMessageCommands']) {
    assert.throws(() => f.db.exec(`UPDATE ${table} SET rowid=rowid`), /immutable/);
    assert.throws(() => f.db.exec(`DELETE FROM ${table}`), /immutable/);
  }
  assert.equal(
    JSON.stringify(f.db.prepare('SELECT * FROM careMessageCommands').all()).includes(input.body),
    false,
  );
  await f.close();
  await other.close();
  const reopened = await fixture(t, f.databasePath),
    previous = counts(reopened.db);
  assert.deepEqual((await reopened.call(sendPath, patient, input)).data, results[0].data);
  followUp(reopened.db, true);
  assert.deepEqual((await reopened.call(sendPath, patient, rejected)).data, denial.data);
  assert.deepEqual(counts(reopened.db), previous);
});

test('thread reads, new and legacy sends and both replay outcomes recheck current session, role, MFA and patient ownership', async (t) => {
  const f = await fixture(t),
    patient = await f.login('patient');
  // Use this synthetic account's actual stored fields for each reset.
  const user = get<User>(f.db, 'users', patient.user.id)!;
  const other = openDatabase(f.databasePath);
  t.after(() => other.close());
  const original = command(),
    rejected = command();
  assert.equal((await f.call(sendPath, patient, original)).status, 201);
  followUp(f.db, false);
  assert.equal((await f.call(sendPath, patient, rejected)).data.code, 'MESSAGE_NOT_SENT');
  followUp(f.db, true);
  const session = other.prepare('SELECT * FROM sessions WHERE userId=?').get(user.id)!;
  const columns = Object.keys(session),
    values = Object.values(session);
  const restoreSession = other.prepare(
    `INSERT INTO sessions(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
  );
  const variations: [string, number, () => void][] = [
    ['signed out', 401, () => other.prepare('DELETE FROM sessions WHERE userId=?').run(user.id)],
    [
      'expired',
      401,
      () => other.prepare('UPDATE sessions SET expiresAt=0 WHERE userId=?').run(user.id),
    ],
    [
      'rotated CSRF',
      401,
      () => other.prepare("UPDATE sessions SET csrfToken='rotated' WHERE userId=?").run(user.id),
    ],
    [
      'new MFA',
      401,
      () =>
        other
          .prepare(
            'INSERT INTO mfaCredentials(userId,id,secret,enabledAt,lastStep) VALUES (?,?,?,?,?)',
          )
          .run(user.id, randomUUID(), 'synthetic', new Date().toISOString(), -1),
    ],
    ['suspended', 401, () => changeUser(other, user, { active: false })],
    ['temporary password', 403, () => changeUser(other, user, { mustChangePassword: true })],
    [
      'receptionist',
      403,
      () => changeUser(other, user, { role: 'receptionist', patientId: undefined }),
    ],
    ['changed patient linkage', 403, () => changeUser(other, user, { patientId: 'patient-2' })],
  ];
  const requests: Array<[string, CareMessageCommand | undefined]> = [
    [sendPath, command()],
    [sendPath, original],
    [sendPath, rejected],
    ['/messages', command()],
    ['/messages?patientId=' + patientId, undefined],
  ];
  const state = counts(f.db);
  for (const [route, input] of requests) {
    for (const [name, status, change] of variations) {
      const response = await beforeTransaction(
        f.db,
        input ? 'BEGIN IMMEDIATE' : 'BEGIN',
        change,
        () => f.call(route, patient, input),
      );
      assert.equal(response.status, status, route + ' / ' + name);
      assert.equal(response.data.code, undefined);
      assert.equal(response.data.receipt, undefined);
      assert.equal(JSON.stringify(response.data).includes(original.body), false);
      assert.deepEqual(counts(f.db), state);
      changeUser(other, user, {});
      other.prepare('DELETE FROM mfaCredentials WHERE userId=?').run(user.id);
      other.prepare('DELETE FROM sessions WHERE userId=?').run(user.id);
      restoreSession.run(...values);
    }
  }
});

test('module eligibility and new author identity use committed values at the writer lock', async (t) => {
  const f = await fixture(t),
    doctor = await f.login('doctor');
  const other = openDatabase(f.databasePath);
  t.after(() => other.close());
  const first = command();
  const response = await beforeTransaction(
    f.db,
    'BEGIN IMMEDIATE',
    () => followUp(other, false),
    () => f.call(sendPath, doctor, first),
  );
  assert.equal(response.status, 403);
  assert.equal(response.data.code, 'MESSAGE_NOT_SENT');
  followUp(other, true);
  const user = get<User>(other, 'users', doctor.user.id)!;
  const fresh = await beforeTransaction(
    f.db,
    'BEGIN IMMEDIATE',
    () => changeUser(other, user, { name: 'Current author name' }),
    () => f.call(sendPath, doctor, command()),
  );
  assert.equal(fresh.status, 201);
  assert.equal(fresh.data.receipt.actorName, 'Current author name');
  assert.equal(fresh.data.receipt.message.authorName, 'Current author name');
  assert.equal(
    JSON.parse(
      String(
        f.db
          .prepare("SELECT data FROM audit WHERE json_extract(data,'$.entityId')=?")
          .get(fresh.data.receipt.message.id)!.data,
      ),
    ).actorName,
    'Current author name',
  );
});
