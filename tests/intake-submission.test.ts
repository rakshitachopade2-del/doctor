import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { get, openDatabase, type DB } from '../server/db.ts';
import type { User } from '../shared/types.ts';
import type { IntakeAnswers } from '../shared/intake-submission.ts';
import { beforeTransaction, careApiFixture, changeUser } from './fixtures/care-api.ts';

const submit = '/intakes/submit';
const patientId = 'patient-ananya';
const answers: IntakeAnswers = {
  concern: 'Synthetic concern',
  location: 'Synthetic location',
  duration: 'A short time',
  symptoms: 'First line\nSecond line',
  triggers: '',
  previousTreatment: 'Reported previous care',
  medications: 'Reported medicines',
  allergies: 'Reported sensitivities',
  goals: 'Synthetic goal',
  consent: true,
};
function command() {
  return { ...answers, requestId: randomUUID(), patientId };
}
function intakeEnabled(db: DB, enabled: boolean) {
  db.prepare(
    "UPDATE meta SET value=json_set(value,'$.modules.intake',json(?)) WHERE key='settings'",
  ).run(JSON.stringify(enabled));
}
function counts(db: DB) {
  return Object.fromEntries(
    ['intakes', 'audit', 'intakeSubmissionCommands', 'activity'].map((table) => [
      table,
      Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n),
    ]),
  );
}

test('shares the exact normalized history once, keeps the original receipt and exposes only the agreed intake in patient records and summaries', async (t) => {
  const f = await careApiFixture(t),
    patient = await f.login('patient'),
    doctor = await f.login('doctor');
  const input = command();
  const before = counts(f.db);
  const result = await f.call(submit, patient, {
    ...input,
    requestId: input.requestId.toUpperCase(),
    patientId: ' ' + patientId + ' ',
    concern: '  ' + answers.concern,
    symptoms: answers.symptoms + '\n ',
    triggers: ' ',
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const { id, createdAt } = result.data.receipt.intake;
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(new Date(createdAt).toISOString(), createdAt);
  const intake = { ...answers, patientId, id, createdAt };
  assert.deepEqual(result.data, {
    receipt: { requestId: input.requestId, actorId: patient.user.id, patientId, intake },
  });
  const replay = await f.call(submit, patient, Object.fromEntries(Object.entries(input).reverse()));
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data, result.data);
  assert.deepEqual(counts(f.db), {
    ...before,
    intakes: before.intakes + 1,
    audit: before.audit + 1,
    intakeSubmissionCommands: before.intakeSubmissionCommands + 1,
  });
  for (const actor of [patient, doctor]) {
    for (const path of ['/patients/' + patientId, '/patients/' + patientId + '/care-summary']) {
      const seen = await f.call(path, actor);
      assert.equal(seen.status, 200);
      assert.deepEqual(
        seen.data.intakes.filter((row: { id: string }) => row.id === id),
        [intake],
      );
      assert.equal(JSON.stringify(seen.data).includes(input.requestId), false);
    }
  }
  assert.equal((await f.call('/patients/' + patientId, await f.login('reception'))).status, 403);
});

test('new submissions require all reviewed fields and exact consent; legacy defaults and unlinked clinician access remain compatible', async (t) => {
  const f = await careApiFixture(t),
    patient = await f.login('patient'),
    admin = await f.login('admin'),
    doctor = await f.login('doctor'),
    reception = await f.login('reception');
  const input = command();
  for (const key of Object.keys(input)) {
    const omitted: Record<string, unknown> = { ...input };
    delete omitted[key];
    assert.equal((await f.call(submit, patient, omitted)).status, 400, key);
  }
  for (const patch of [
    { consent: false },
    { consent: 'true' },
    { concern: ' ' },
    { location: 'x'.repeat(301) },
    { duration: ' ' },
    { allergies: 'x'.repeat(8001) },
    { symptoms: null },
    { requestId: 'malformed' },
    { actorId: patient.user.id },
  ])
    assert.equal((await f.call(submit, patient, { ...input, ...patch })).status, 400);
  assert.equal((await f.call(submit + '?unknown=x', patient, input)).status, 400);
  assert.equal((await f.call(submit, patient, { ...input, patientId: 'patient-2' })).status, 403);
  assert.equal((await f.call(submit, reception, input)).status, 403);
  assert.equal((await f.call(submit, undefined, input)).status, 401);
  assert.equal((await f.call(submit, { ...patient, csrf: 'wrong' }, input)).status, 403);
  assert.equal((await f.call(submit, admin, { ...input, patientId: 'missing' })).status, 404);
  assert.equal(counts(f.db).intakeSubmissionCommands, 0);
  for (const clinician of [doctor, admin]) {
    changeUser(f.db, clinician.user, { doctorId: undefined });
    assert.equal(
      (await f.call(submit, clinician, { ...command(), goals: 'x'.repeat(8000) })).status,
      201,
    );
  }
  const legacy = await f.call('/intakes?ignored=1', patient, {
    concern: '  Legacy ',
    location: 'Hands',
    duration: 'Weeks',
    consent: true,
    requestId: 'ignored',
    id: 'ignored',
  });
  assert.equal(legacy.status, 201);
  assert.deepEqual(legacy.data, {
    ...answers,
    concern: 'Legacy',
    location: 'Hands',
    duration: 'Weeks',
    symptoms: '',
    triggers: '',
    previousTreatment: '',
    medications: '',
    allergies: '',
    goals: '',
    patientId,
    id: legacy.data.id,
    createdAt: legacy.data.createdAt,
  });
  assert.equal(counts(f.db).intakeSubmissionCommands, 2);
  intakeEnabled(f.db, false);
  const paused = await f.call('/intakes', patient, {});
  assert.equal(paused.status, 403);
  assert.equal(paused.data.code, undefined);
});

test('paused submissions persist an exact rejection, while previous confirmations remain recoverable and changed answers, actors and patients collide', async (t) => {
  const f = await careApiFixture(t),
    admin = await f.login('admin'),
    doctor = await f.login('doctor');
  const original = command(),
    saved = await f.call(submit, admin, original);
  assert.equal(saved.status, 201);
  const rejected = { ...command(), goals: 'Private unsubmitted goal' };
  const before = counts(f.db);
  intakeEnabled(f.db, false);
  const replay = await f.call(submit, admin, original);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data, saved.data);
  const denial = await f.call(submit, admin, {
    ...rejected,
    concern: ' ' + rejected.concern + ' ',
  });
  assert.equal(denial.status, 403);
  assert.deepEqual(denial.data, {
    code: 'INTAKE_NOT_SUBMITTED',
    requestId: rejected.requestId,
    patientId,
    actorId: admin.user.id,
    answers: { ...answers, goals: rejected.goals },
    message: 'This module is currently disabled by the clinic.',
  });
  assert.deepEqual(counts(f.db), {
    ...before,
    intakeSubmissionCommands: before.intakeSubmissionCommands + 1,
  });
  intakeEnabled(f.db, true);
  assert.deepEqual((await f.call(submit, admin, rejected)).data, denial.data);
  for (const used of [original, rejected]) {
    for (const key of Object.keys(answers).filter((x) => x !== 'consent')) {
      const collides = await f.call(submit, admin, { ...used, [key]: 'Other answer' });
      assert.equal(collides.status, 409, key);
      assert.equal(collides.data.code, undefined);
      assert.equal(collides.data.receipt, undefined);
      assert.equal(JSON.stringify(collides.data).includes(answers.concern), false);
    }
    assert.equal((await f.call(submit, doctor, used)).status, 409);
    assert.equal((await f.call(submit, admin, { ...used, patientId: 'patient-2' })).status, 409);
  }
  const evidence = JSON.stringify(f.db.prepare('SELECT * FROM intakeSubmissionCommands').all());
  assert.equal(evidence.includes(answers.concern), false);
  assert.equal(evidence.includes(rejected.goals), false);
  const summary = await f.call('/patients/' + patientId + '/care-summary', admin);
  assert.equal(JSON.stringify(summary.data).includes(rejected.goals), false);
  assert.equal(JSON.stringify(summary.data).includes(rejected.requestId), false);
  assert.equal((await f.call(submit, admin, { ...rejected, requestId: randomUUID() })).status, 201);
});

test('intake, audit and command failures roll back both submission paths; rejection-storage failure leaves the same command available', async (t) => {
  const f = await careApiFixture(t),
    patient = await f.login('patient');
  for (const route of [submit, '/intakes']) {
    for (const table of [
      'intakes',
      'audit',
      ...(route === submit ? ['intakeSubmissionCommands'] : []),
    ]) {
      const before = counts(f.db),
        input = command();
      f.db.exec(
        `CREATE TRIGGER fail_intake BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'Synthetic intake failure'); END`,
      );
      const failed = await f.call(route, patient, input);
      f.db.exec('DROP TRIGGER fail_intake');
      assert.equal(failed.status, 500);
      assert.equal(failed.data.code, undefined);
      assert.deepEqual(counts(f.db), before);
      assert.equal((await f.call(route, patient, input)).status, 201);
    }
  }
  const input = command(),
    before = counts(f.db);
  intakeEnabled(f.db, false);
  f.db.exec(
    "CREATE TRIGGER fail_intake BEFORE INSERT ON intakeSubmissionCommands BEGIN SELECT RAISE(ABORT,'Synthetic intake failure'); END",
  );
  const failed = await f.call(submit, patient, input);
  assert.equal(failed.status, 500);
  assert.equal(failed.data.code, undefined);
  assert.deepEqual(counts(f.db), before);
  f.db.exec('DROP TRIGGER fail_intake');
  intakeEnabled(f.db, true);
  assert.equal((await f.call(submit, patient, input)).status, 201);
});

test('independent server processes converge on one intake; deliberate later submissions and immutable success/rejection evidence survive restart', async (t) => {
  const f = await careApiFixture(t),
    patient = await f.login('patient'),
    input = command();
  const initial = counts(f.db);
  // Run the second synchronous SQLite writer on its own event loop.
  const program = `
    import { createApp } from './server/app.ts';
    const app = createApp({databasePath: process.argv[1], demoMode: true, production: false});
    const server = app.listen(0, '127.0.0.1', () => process.send(server.address().port));
    process.on('disconnect', () => { server.close(() => app.locals.close()); server.closeAllConnections(); });
  `;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', program, f.databasePath],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
  );
  const exited = once(child, 'exit');
  let saved;
  try {
    const port = await Promise.race([
      once(child, 'message').then(([port]) => Number(port)),
      exited.then(() => {
        throw new Error('Second intake test server exited before startup.');
      }),
    ]);
    const second = async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/intakes/submit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: patient.cookie,
          'X-CSRF-Token': patient.csrf,
        },
        body: JSON.stringify(input),
      });
      return { status: res.status, data: await res.json() };
    };
    const outcomes = await Promise.all([f.call(submit, patient, input), second()]);
    assert.deepEqual(outcomes.map((x) => x.status).sort(), [200, 201]);
    assert.deepEqual(outcomes[0].data, outcomes[1].data);
    saved = outcomes[0].data;
  } finally {
    if (child.connected) child.disconnect();
    await exited;
  }
  assert.deepEqual(counts(f.db), {
    ...initial,
    intakes: initial.intakes + 1,
    audit: initial.audit + 1,
    intakeSubmissionCommands: initial.intakeSubmissionCommands + 1,
  });
  const later = await f.call(submit, patient, { ...input, requestId: randomUUID() });
  assert.equal(later.status, 201);
  assert.notEqual(later.data.receipt.intake.id, saved.receipt.intake.id);
  for (const table of ['intakes', 'intakeSubmissionCommands']) {
    assert.throws(() => f.db.exec(`UPDATE ${table} SET rowid=rowid`), /immutable/);
    assert.throws(() => f.db.exec(`DELETE FROM ${table}`), /immutable/);
  }
  intakeEnabled(f.db, false);
  const rejected = command(),
    denial = await f.call(submit, patient, rejected);
  assert.equal(denial.status, 403);
  await f.close();
  const restored = await careApiFixture(t, f.databasePath);
  const before = counts(restored.db);
  assert.deepEqual((await restored.call(submit, patient, input)).data, saved);
  intakeEnabled(restored.db, true);
  assert.deepEqual((await restored.call(submit, patient, rejected)).data, denial.data);
  assert.deepEqual(counts(restored.db), before);
  await restored.close();
});

test('new submissions, legacy intake and both replays recheck current session, role and ownership under the writer lock', async (t) => {
  const f = await careApiFixture(t),
    patient = await f.login('patient');
  const other = openDatabase(f.databasePath);
  t.after(() => other.close());
  const user = get<User>(other, 'users', patient.user.id)!;
  const session = other.prepare('SELECT * FROM sessions WHERE userId=?').get(user.id)!;
  const original = command(),
    rejected = command();
  assert.equal((await f.call(submit, patient, original)).status, 201);
  intakeEnabled(f.db, false);
  assert.equal((await f.call(submit, patient, rejected)).data.code, 'INTAKE_NOT_SUBMITTED');
  intakeEnabled(f.db, true);
  const before = counts(f.db);
  const variations: [string, number, () => void][] = [
    ['sign out', 401, () => other.prepare('DELETE FROM sessions WHERE userId=?').run(user.id)],
    [
      'expiry',
      401,
      () => other.prepare('UPDATE sessions SET expiresAt=0 WHERE userId=?').run(user.id),
    ],
    [
      'CSRF',
      401,
      () => other.prepare("UPDATE sessions SET csrfToken='rotated' WHERE userId=?").run(user.id),
    ],
    [
      'MFA',
      401,
      () =>
        other
          .prepare(
            'INSERT INTO mfaCredentials(userId,id,secret,enabledAt,lastStep) VALUES (?,?,?,?,?)',
          )
          .run(user.id, randomUUID(), 'synthetic', new Date().toISOString(), -1),
    ],
    ['suspension', 401, () => changeUser(other, user, { active: false })],
    ['required password', 403, () => changeUser(other, user, { mustChangePassword: true })],
    [
      'reception',
      403,
      () => changeUser(other, user, { role: 'receptionist', patientId: undefined }),
    ],
    ['ownership', 403, () => changeUser(other, user, { patientId: 'patient-2' })],
  ];
  for (const [route, body] of [
    [submit, command()],
    [submit, original],
    [submit, rejected],
    ['/intakes', command()],
  ] as const) {
    for (const [label, status, change] of variations) {
      const result = await beforeTransaction(f.db, 'BEGIN IMMEDIATE', change, () =>
        f.call(route, patient, body),
      );
      assert.equal(result.status, status, label);
      assert.equal(result.data.receipt, undefined);
      assert.equal(result.data.code, undefined);
      assert.equal(JSON.stringify(result.data).includes(answers.concern), false);
      assert.deepEqual(counts(f.db), before);
      changeUser(other, user, {});
      other.prepare('DELETE FROM mfaCredentials WHERE userId=?').run(user.id);
      other.prepare('DELETE FROM sessions WHERE userId=?').run(user.id);
      const columns = Object.keys(session);
      other
        .prepare(
          `INSERT INTO sessions(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
        )
        .run(...Object.values(session));
    }
  }
  for (const route of [submit, '/intakes']) {
    const paused = await beforeTransaction(
      f.db,
      'BEGIN IMMEDIATE',
      () => intakeEnabled(other, false),
      () => f.call(route, patient, command()),
    );
    assert.equal(paused.status, 403);
    assert.equal(paused.data.code, route === submit ? 'INTAKE_NOT_SUBMITTED' : undefined);
    intakeEnabled(other, true);
  }
});
