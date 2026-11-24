import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { createUser, openDatabase, type DB } from '../server/db.ts';
import type { Investigation } from '../shared/clinical.ts';
import type { InvestigationOrderCommand } from '../shared/investigation-order.ts';
import {
  beforeTransaction,
  careApiFixture,
  changeUser,
  simultaneousCareRequests,
} from './fixtures/care-api.ts';

const reviewed = '/investigations/order';
const legacy = '/investigations';
const patientId = 'patient-ananya';
const doctorId = 'doctor-meera';
const fields = {
  patientId,
  title: 'Synthetic order',
  kind: 'other' as const,
  reason: 'Synthetic clinical question.',
  instructions: 'Synthetic patient instructions.',
  dueDate: null,
};
function command(patch: Partial<InvestigationOrderCommand> = {}): InvestigationOrderCommand {
  return {
    ...fields,
    doctorId,
    orderedByRole: 'doctor',
    requestId: randomUUID(),
    reviewedConfirmed: true,
    ...patch,
  };
}
async function fixture(t: TestContext) {
  const f = await careApiFixture(t);
  const doctor = await f.login('doctor');
  return { ...f, doctor };
}
function count(db: DB, table: string, where = '1') {
  return Number(db.prepare('SELECT count(*) AS n FROM ' + table + ' WHERE ' + where).get()!.n);
}
function effects(db: DB) {
  return {
    orders: count(db, 'investigations'),
    audits: count(db, 'audit', "json_extract(data,'$.action')='ordered investigation'"),
    notices: count(db, 'activity', "eventKey LIKE 'investigation-ordered:%'"),
    commands: count(db, 'investigationOrderCommands'),
  };
}
function unmarked(reply: { status: number; data: Record<string, unknown> }, status: number) {
  assert.equal(reply.status, status);
  for (const key of ['receipt', 'actorId', 'order', 'command', 'message'])
    assert.ok(!Object.hasOwn(reply.data, key), key);
  assert.notEqual(reply.data.code, 'INVESTIGATION_NOT_ORDERED');
}

test('a reviewed order recovers its original author, instructions and status after results, publication, a profile rename and restart', async (t) => {
  const f = await fixture(t),
    patient = await f.login('patient'),
    admin = await f.login('admin');
  const cmd = command();
  const first = await f.call(reviewed, f.doctor, {
    ...cmd,
    requestId: cmd.requestId.toUpperCase(),
    reason: '  ' + cmd.reason + '  ',
  });
  assert.equal(first.status, 201);
  const order = first.data.receipt.order as Investigation;
  assert.match(order.id, /^[a-f\d-]{36}$/);
  assert.ok(Number.isFinite(Date.parse(order.createdAt)));
  assert.deepEqual(first.data, {
    receipt: {
      actorId: f.doctor.user.id,
      requestId: cmd.requestId,
      orderedByRole: 'doctor',
      order: {
        ...fields,
        doctorId,
        doctorName: 'Dr. Meera Shah',
        id: order.id,
        createdAt: order.createdAt,
        status: 'ordered',
        cancellationReason: null,
        results: [],
        reviews: [],
      },
    },
  });
  assert.deepEqual(effects(f.db), { orders: 1, audits: 1, notices: 1, commands: 1 });
  const base = '/investigations/' + order.id;
  const result = await f.call(base + '/results', patient, { note: 'Synthetic later result' });
  assert.equal(result.status, 201);
  const review = await f.call(base + '/reviews', f.doctor, {
    resultId: result.data.results[0].id,
    summary: 'Synthetic later review',
    publishToPatient: false,
  });
  assert.equal(review.status, 201);
  const record = '/patients/' + patientId + '/clinical-workflows';
  const hidden = (await f.call(record, patient)).data.investigations[0];
  assert.equal(hidden.results.length, 1);
  assert.deepEqual(hidden.reviews, []);
  f.db
    .prepare("UPDATE doctors SET data=json_set(data,'$.name',?) WHERE id=?")
    .run('Renamed clinician', doctorId);
  const published = await f.call(
    base + '/reviews/' + review.data.reviews[0].id + '/publish',
    f.doctor,
    {},
  );
  assert.equal(published.status, 200);
  const before = effects(f.db);
  await f.close();
  const next = await careApiFixture(t, f.databasePath);
  const retry = await next.call(
    reviewed,
    f.doctor,
    Object.fromEntries(Object.entries(cmd).reverse()),
  );
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.data, first.data);
  assert.deepEqual(effects(next.db), before);
  const current = (await next.call(record, patient)).data.investigations[0];
  assert.equal(current.status, 'reviewed');
  assert.equal(current.reviews.length, 1);
  assert.equal(current.doctorName, order.doctorName);
  for (const projection of [
    current,
    (await next.call('/activity', patient)).data,
    (await next.call('/audit', admin)).data,
    (await next.call('/patients/' + patientId + '/care-summary', patient)).data,
  ])
    assert.ok(!JSON.stringify(projection).includes(cmd.requestId));
  assert.deepEqual((await next.call(reviewed, f.doctor, cmd)).data, first.data);
});

test('clinic midnight distinguishes an already ordered investigation from an undelivered order with an expired due date', async (t) => {
  const evening = Date.parse('2031-05-12T18:29:59.500Z');
  t.mock.timers.enable({ apis: ['Date'], now: evening });
  const f = await fixture(t),
    cmd = command({ dueDate: '2031-05-12' }),
    missed = command({ dueDate: cmd.dueDate });
  const saved = await f.call(reviewed, f.doctor, cmd);
  assert.equal(saved.status, 201);
  t.mock.timers.setTime(evening + 1000);
  const again = await f.call(reviewed, f.doctor, cmd);
  assert.equal(again.status, 200);
  assert.deepEqual(again.data, saved.data);
  const refusal = await f.call(reviewed, f.doctor, missed);
  assert.equal(refusal.status, 409);
  assert.deepEqual(refusal.data, {
    code: 'INVESTIGATION_NOT_ORDERED',
    actorId: f.doctor.user.id,
    command: missed,
    message: 'Choose today or a future due date.',
  });
  unmarked(await f.call(legacy, f.doctor, missed), 400);
  assert.deepEqual(effects(f.db), { orders: 1, audits: 1, notices: 1, commands: 2 });
  t.mock.timers.setTime(evening);
  const repeat = await f.call(reviewed, f.doctor, missed);
  assert.equal(repeat.status, 409);
  assert.deepEqual(repeat.data, refusal.data);
  assert.equal(
    (await f.call(reviewed, f.doctor, { ...missed, requestId: randomUUID() })).status,
    201,
  );
  assert.throws(() => f.db.exec('DELETE FROM investigationOrderCommands'), /immutable/);
  assert.throws(() => f.db.exec('UPDATE investigationOrderCommands SET rowid=rowid'), /immutable/);
});

test('strict reviewed commands bind the issuer and every normalized field; the compatibility route retains its old shape and defaults', async (t) => {
  const f = await fixture(t),
    cmd = command(),
    admin = await f.login('admin');
  for (const key of Object.keys(cmd)) {
    const incomplete = { ...cmd };
    delete incomplete[key as keyof InvestigationOrderCommand];
    unmarked(await f.call(reviewed, f.doctor, incomplete), 400);
  }
  for (const patch of [
    { title: ' ' },
    { reason: ' ' },
    { instructions: ' ' },
    { dueDate: '2031-02-29' },
    { kind: 'unknown' },
    { requestId: 'x' },
    { extra: false },
    { reviewedConfirmed: false },
  ])
    unmarked(await f.call(reviewed, f.doctor, { ...cmd, ...patch }), 400);
  unmarked(await f.call(reviewed + '?extra=true', f.doctor, cmd), 400);
  unmarked(await f.call(reviewed, f.doctor, { ...cmd, patientId: 'absent' }), 404);
  unmarked(await f.call(reviewed, f.doctor, { ...cmd, doctorId: 'doctor-arjun' }), 403);
  unmarked(await f.call(reviewed, f.doctor, { ...cmd, orderedByRole: 'admin' }), 403);
  unmarked(await f.call(reviewed, await f.login('patient'), cmd), 403);
  unmarked(await f.call(reviewed, await f.login('reception'), cmd), 403);
  unmarked(await f.call(reviewed, undefined, cmd), 401);
  unmarked(await f.call(reviewed, { ...f.doctor, csrf: 'invalid' }, cmd), 403);
  assert.equal((await f.call(reviewed, f.doctor, cmd)).status, 201);
  const baseline = effects(f.db);
  for (const patch of [
    { patientId: 'patient-2' },
    { title: 'Changed' },
    { reason: 'Changed' },
    { instructions: 'Changed' },
    { kind: 'imaging' },
    { dueDate: '2001-01-01' },
  ])
    unmarked(await f.call(reviewed, f.doctor, { ...cmd, ...patch }), 409);
  unmarked(await f.call(reviewed, admin, { ...cmd, orderedByRole: 'admin' }), 409);
  const other = await f.call(reviewed, admin, command({ orderedByRole: 'admin' }));
  assert.equal(other.status, 201);
  assert.equal(other.data.receipt.actorId, admin.user.id);
  assert.equal(other.data.receipt.orderedByRole, 'admin');
  const invalidDate = await f.call(legacy, f.doctor, { ...fields, dueDate: '2031-02-29' });
  assert.equal(invalidDate.status, 400);
  assert.deepEqual(invalidDate.data, { error: 'dueDate: Invalid calendar date.' });
  const older = await f.call(legacy + '?accepted=1', f.doctor, {
    ...cmd,
    title: ' Synthetic legacy ',
    dueDate: undefined,
    extra: 'ignored',
  });
  assert.equal(older.status, 201);
  assert.equal(older.data.title, 'Synthetic legacy');
  assert.equal(older.data.dueDate, null);
  assert.deepEqual(older.data.results, []);
  for (const key of ['reviewedConfirmed', 'orderedByRole', 'extra', 'requestId', 'receipt'])
    assert.ok(!Object.hasOwn(older.data, key));
  assert.deepEqual(effects(f.db), {
    orders: baseline.orders + 2,
    audits: baseline.audits + 2,
    notices: baseline.notices + 2,
    commands: baseline.commands + 1,
  });
});

test('independent writers settle the same request once and preserve deliberate separately reviewed identical orders', async (t) => {
  const f = await fixture(t),
    cmd = command();
  const same = await simultaneousCareRequests(f, reviewed, f.doctor, cmd);
  assert.deepEqual(same.map((r) => r.status).sort(), [200, 201]);
  assert.deepEqual(same[0].data, same[1].data);
  const id = same[0].data.receipt.order.id;
  assert.equal(
    (await f.call('/investigations/' + id + '/cancel', f.doctor, { reason: 'Synthetic closure' }))
      .status,
    200,
  );
  assert.deepEqual((await f.call(reviewed, f.doctor, cmd)).data, same[0].data);
  const colliding = command();
  const mixed = await simultaneousCareRequests(f, reviewed, f.doctor, colliding, {
    who: f.doctor,
    body: { ...colliding, title: 'Other title' },
  });
  assert.deepEqual(mixed.map((r) => r.status).sort(), [201, 409]);
  const different = await simultaneousCareRequests(f, reviewed, f.doctor, command(), {
    who: f.doctor,
    body: command(),
  });
  assert.deepEqual(
    different.map((r) => r.status),
    [201, 201],
  );
  assert.notEqual(different[0].data.receipt.order.id, different[1].data.receipt.order.id);
  assert.deepEqual(effects(f.db), { orders: 4, audits: 4, notices: 4, commands: 4 });
});

test('both writers and successful and refused retries recheck the current account, session and linked clinician inside the writer lock', async (t) => {
  const f = await fixture(t),
    other = openDatabase(f.databasePath);
  t.after(() => other.close());
  const accepted = command(),
    refused = command({ dueDate: '2000-01-01' });
  assert.equal((await f.call(reviewed, f.doctor, accepted)).status, 201);
  assert.equal((await f.call(reviewed, f.doctor, refused)).status, 409);
  const baseline = effects(f.db),
    user = f.doctor.user;
  const session = other.prepare('SELECT * FROM sessions WHERE userId=?').get(user.id)!;
  const change = (patch: Parameters<typeof changeUser>[2]) => changeUser(other, user, patch);
  const cases: [number, () => unknown][] = [
    [401, () => change({ active: false })],
    [403, () => change({ mustChangePassword: true })],
    [403, () => change({ role: 'patient', patientId: 'patient-3' })],
    [403, () => change({ role: 'receptionist' })],
    [400, () => change({ doctorId: undefined })],
    [400, () => change({ doctorId: 'absent-doctor' })],
    [401, () => other.prepare('DELETE FROM sessions WHERE userId=?').run(user.id)],
    [401, () => other.prepare('UPDATE sessions SET expiresAt=0 WHERE userId=?').run(user.id)],
    [
      401,
      () => other.prepare("UPDATE sessions SET csrfToken='changed' WHERE userId=?").run(user.id),
    ],
    [
      401,
      () =>
        other
          .prepare('INSERT INTO mfaCredentials VALUES (?,?,?,?,?)')
          .run(user.id, randomUUID(), 'synthetic', '2031-01-01', 0),
    ],
  ];
  const cols = Object.keys(session);
  for (const [route, body] of [
    [legacy, fields],
    [reviewed, command()],
    [reviewed, accepted],
    [reviewed, refused],
  ] as const) {
    for (const [status, mutate] of cases) {
      const reply = await beforeTransaction(f.db, 'BEGIN IMMEDIATE', mutate, () =>
        f.call(route, f.doctor, body),
      );
      unmarked(reply, status);
      change({});
      other.prepare('DELETE FROM mfaCredentials WHERE userId=?').run(user.id);
      other.prepare('DELETE FROM sessions WHERE userId=?').run(user.id);
      other
        .prepare(
          'INSERT INTO sessions(' +
            cols.join(',') +
            ') VALUES (' +
            cols.map(() => '?').join(',') +
            ')',
        )
        .run(...Object.values(session));
    }
    if (route === reviewed) {
      for (const mutation of [{ doctorId: 'doctor-arjun' }, { role: 'admin' as const }]) {
        const reply = await beforeTransaction(
          f.db,
          'BEGIN IMMEDIATE',
          () => change(mutation),
          () => f.call(route, f.doctor, body),
        );
        unmarked(reply, 403);
        change({});
      }
    }
  }
  assert.deepEqual(effects(f.db), baseline);
  const renamed = await beforeTransaction(
    f.db,
    'BEGIN IMMEDIATE',
    () =>
      other
        .prepare(
          "UPDATE doctors SET data=json_set(data,'$.name','Current linked doctor') WHERE id=?",
        )
        .run(doctorId),
    () => f.call(legacy, f.doctor, fields),
  );
  assert.equal(renamed.status, 201);
  assert.equal(renamed.data.doctorName, 'Current linked doctor');
});

test('an order, audit, patient notices and exact outcome commit together on both writers or roll back completely', async (t) => {
  const f = await fixture(t);
  for (const route of [legacy, reviewed]) {
    const cmd = command(),
      before = effects(f.db);
    for (const table of [
      'investigations',
      'audit',
      'activity',
      ...(route === reviewed ? ['investigationOrderCommands'] : []),
    ]) {
      for (const failure of ["RAISE(ABORT,'Synthetic order storage failure')", 'RAISE(IGNORE)']) {
        f.db.exec(
          'CREATE TRIGGER synthetic_failure BEFORE INSERT ON ' +
            table +
            ' BEGIN SELECT ' +
            failure +
            '; END;',
        );
        try {
          unmarked(await f.call(route, f.doctor, cmd), 500);
        } finally {
          f.db.exec('DROP TRIGGER synthetic_failure');
        }
        assert.deepEqual(effects(f.db), before);
      }
    }
    assert.equal((await f.call(route, f.doctor, cmd)).status, 201);
  }
  const rejected = command({ dueDate: '2000-01-01' }),
    before = effects(f.db);
  f.db.exec(
    'CREATE TRIGGER skip_refusal BEFORE INSERT ON investigationOrderCommands BEGIN SELECT RAISE(IGNORE); END;',
  );
  try {
    unmarked(await f.call(reviewed, f.doctor, rejected), 500);
  } finally {
    f.db.exec('DROP TRIGGER skip_refusal');
  }
  assert.deepEqual(effects(f.db), before);
  assert.equal((await f.call(reviewed, f.doctor, rejected)).data.code, 'INVESTIGATION_NOT_ORDERED');
});

test('eligible linked portal accounts receive the narrow order notice once; patients without portal access can still have orders', async (t) => {
  const f = await fixture(t),
    patient = await f.login('patient');
  changeUser(f.db, patient.user, { mustChangePassword: true });
  createUser(
    f.db,
    {
      ...patient.user,
      id: 'another-portal',
      email: 'another@example.test',
      patientId: 'patient-2',
    },
    'Synthetic fixture phrase!',
  );
  const cmd = command();
  const saved = await f.call(reviewed, f.doctor, cmd);
  assert.equal(saved.status, 201);
  assert.deepEqual((await f.call(reviewed, f.doctor, cmd)).data, saved.data);
  const event = 'investigation-ordered:' + saved.data.receipt.order.id;
  const notices = f.db
    .prepare('SELECT userId,patientId,audience,data FROM activity WHERE eventKey=? ORDER BY userId')
    .all(event);
  assert.deepEqual(
    notices.map((n) => n.userId),
    [patient.user.id],
  );
  for (const row of notices) {
    assert.equal(row.patientId, patientId);
    assert.equal(row.audience, 'patient');
    const item = JSON.parse(String(row.data));
    assert.equal(item.detail, fields.title);
    assert.equal(item.title, 'Your clinician requested an investigation');
    assert.equal(item.href, '/my-care/record?tab=workflows');
    assert.ok(!JSON.stringify(item).includes(fields.reason));
    assert.ok(!JSON.stringify(item).includes(saved.data.receipt.requestId));
  }
  changeUser(f.db, patient.user, { active: false });
  const before = effects(f.db);
  assert.equal((await f.call(reviewed, f.doctor, command())).status, 201);
  assert.equal((await f.call(legacy, f.doctor, { ...fields, patientId: 'patient-3' })).status, 201);
  assert.deepEqual(effects(f.db), {
    ...before,
    orders: before.orders + 2,
    audits: before.audits + 2,
    commands: before.commands + 1,
  });
});
