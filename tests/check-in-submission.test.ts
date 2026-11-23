import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { CheckInSubmissionCommand } from '../shared/check-in-submission.ts';
import type { CarePlan, CheckIn } from '../shared/types.ts';
import { addDays, clinicToday, openDatabase, type DB } from '../server/db.ts';
import {
  beforeTransaction,
  careApiFixture,
  changeUser,
  simultaneousCareRequests,
} from './fixtures/care-api.ts';

const submit = '/check-ins/submit',
  legacy = '/check-ins',
  patientId = 'patient-ananya',
  carePlanId = 'plan-1';
function command(patch: Partial<CheckInSubmissionCommand> = {}): CheckInSubmissionCommand {
  return {
    requestId: randomUUID(),
    patientId,
    carePlanId,
    date: clinicToday(),
    adherence: 'partial',
    feeling: 'same',
    note: 'Private synthetic report',
    expectedUpdatedAt: null,
    reviewedConfirmed: true,
    ...patch,
  };
}
function followUpEnabled(db: DB, value: boolean) {
  db.prepare(
    "UPDATE meta SET value=json_set(value,'$.modules.followUp',json(?)) WHERE key='settings'",
  ).run(JSON.stringify(value));
}
function counts(db: DB) {
  return {
    checks: Number(db.prepare('SELECT COUNT(*) n FROM checkIns').get()!.n),
    commands: Number(db.prepare('SELECT COUNT(*) n FROM checkInSubmissionCommands').get()!.n),
    audits: Number(
      db
        .prepare("SELECT COUNT(*) n FROM audit WHERE json_extract(data,'$.entityType')='checkIn'")
        .get()!.n,
    ),
    notices: Number(
      db.prepare("SELECT COUNT(*) n FROM activity WHERE eventKey LIKE 'check-in:%'").get()!.n,
    ),
  };
}
function current(db: DB, input: CheckInSubmissionCommand): CheckIn | null {
  const row = db
    .prepare('SELECT data FROM checkIns WHERE carePlanId=? AND date=?')
    .get(input.carePlanId, input.date);
  return row ? JSON.parse(String(row.data)) : null;
}
function unmarked(result: { status: number; data: Record<string, unknown> }, status: number) {
  assert.equal(result.status, status, JSON.stringify(result.data));
  for (const key of ['code', 'command', 'receipt']) assert.ok(!(key in result.data));
}

test('recovery preserves the original receipt, clinical review and notice; an intentional correction reaches the current owner', async (t) => {
  const f = await careApiFixture(t),
    patient = await f.login('patient'),
    doctor = await f.login('doctor'),
    admin = await f.login('admin');
  const input = command(),
    before = counts(f.db);
  const first = await f.call(submit, patient, {
    ...input,
    requestId: input.requestId.toUpperCase(),
    note: '  ' + input.note + '  ',
  });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const report = first.data.receipt.checkIn;
  assert.match(report.id, /^[a-f0-9-]{36}$/);
  assert.equal(new Date(report.createdAt).toISOString(), report.createdAt);
  assert.deepEqual(report, {
    id: report.id,
    createdAt: report.createdAt,
    patientId,
    carePlanId,
    date: input.date,
    adherence: input.adherence,
    feeling: input.feeling,
    note: input.note,
  });
  assert.deepEqual(first.data, {
    receipt: {
      requestId: input.requestId,
      actorId: patient.user.id,
      patientId,
      carePlanId,
      date: input.date,
      expectedUpdatedAt: null,
      operation: 'created',
      checkIn: report,
    },
  });
  assert.deepEqual(current(f.db, input), report);
  const work = async () =>
    (await f.call('/follow-up-worklist?scope=all', doctor)).data.find(
      (item: { carePlan: CarePlan }) => item.carePlan.id === carePlanId,
    );
  const review = await f.call('/care-plans/' + carePlanId + '/reviews', doctor, {
    expectedRevision: (await work()).revision,
    assessment: 'Private synthetic assessment',
    patientInstructions: 'Shared update',
    disposition: 'continue',
    nextReviewDate: addDays(input.date, 7),
  });
  assert.equal(review.status, 201);
  const prior = await work();
  assert.equal(prior.unreviewedCount, 0);
  const firstSnapshot = prior.latestReview.checkInSnapshots.find(
    (s: { id: string }) => s.id === report.id,
  );
  assert.deepEqual(firstSnapshot.snapshot, report);
  const recovered = await f.call(
    submit,
    patient,
    Object.fromEntries(Object.entries(input).reverse()),
  );
  assert.equal(recovered.status, 200);
  assert.deepEqual(recovered.data, first.data);
  assert.equal((await work()).revision, prior.revision);
  assert.deepEqual(counts(f.db), {
    checks: before.checks + 1,
    commands: before.commands + 1,
    audits: before.audits + 1,
    notices: before.notices + 2,
  });
  changeUser(f.db, admin.user, { doctorId: 'doctor-arjun' });
  const assigned = await f.call('/care-plans/' + carePlanId + '/assignment', doctor, {
    expectedRevision: prior.revision,
    doctorId: 'doctor-arjun',
    reason: 'Private handover',
  });
  assert.equal(assigned.status, 201);
  const correction = command({
    expectedUpdatedAt: report.createdAt,
    note: 'Revised synthetic report',
    adherence: 'taken',
    feeling: 'better',
  });
  const corrected = await f.call(submit, patient, correction);
  assert.equal(corrected.status, 201);
  const next = corrected.data.receipt.checkIn;
  assert.deepEqual(corrected.data.receipt, {
    requestId: correction.requestId,
    actorId: patient.user.id,
    patientId,
    carePlanId,
    date: input.date,
    expectedUpdatedAt: report.createdAt,
    operation: 'corrected',
    checkIn: next,
  });
  assert.equal(next.id, report.id);
  assert.equal(next.note, correction.note);
  assert.ok(next.createdAt > report.createdAt);
  const after = await work();
  assert.equal(after.unreviewedCount, 1);
  assert.deepEqual(after.unreviewedCheckIns, [next]);
  assert.deepEqual(after.latestReview.checkInSnapshots, prior.latestReview.checkInSnapshots);
  assert.deepEqual(
    f.db
      .prepare(
        "SELECT userId FROM activity WHERE eventKey LIKE ? AND json_extract(data,'$.title')='A patient updated their check-in'",
      )
      .all('check-in:' + report.id + ':%')
      .map((r) => r.userId),
    [admin.user.id],
  );
  assert.deepEqual((await f.call(submit, patient, input)).data, first.data);
  assert.deepEqual((await f.call(submit, patient, correction)).data, corrected.data);
  const completed = await f.call('/care-plans/' + carePlanId + '/reviews', admin, {
    expectedRevision: after.revision,
    assessment: 'Second private assessment',
    patientInstructions: 'Shared completion',
    disposition: 'complete',
  });
  assert.equal(completed.status, 201);
  const history = (await f.call('/care-plans/' + carePlanId + '/reviews', doctor)).data;
  const secondSnapshot = history[0].checkInSnapshots.find((s: { id: string }) => s.id === next.id);
  assert.deepEqual(secondSnapshot.snapshot, next);
  assert.notEqual(secondSnapshot.contentHash, firstSnapshot.contentHash);
  assert.deepEqual(history[1].checkInSnapshots, prior.latestReview.checkInSnapshots);
  const completedInput = command({ expectedUpdatedAt: next.createdAt }),
    denied = await f.call(submit, patient, completedInput);
  assert.equal(denied.status, 409);
  assert.deepEqual(denied.data, {
    code: 'CHECK_IN_NOT_SAVED',
    actorId: patient.user.id,
    command: completedInput,
    message: 'This care plan is completed.',
  });
  followUpEnabled(f.db, false);
  const baseline = counts(f.db);
  for (const [cmd, response] of [
    [input, first],
    [correction, corrected],
    [completedInput, denied],
  ] as const) {
    const res = await f.call(submit, patient, cmd);
    assert.equal(res.status, response === denied ? 409 : 200);
    assert.deepEqual(res.data, response.data);
  }
  assert.deepEqual(current(f.db, input), next);
  assert.deepEqual(counts(f.db), baseline);
  for (const [route, who] of [
    ['/patients/' + patientId, patient],
    ['/patients/' + patientId + '/care-summary', patient],
    ['/care-plans', patient],
    ['/care-plans/' + carePlanId + '/reviews', patient],
    ['/activity', patient],
    ['/activity', doctor],
  ] as const) {
    const result = await f.call(route, who);
    assert.equal(result.status, 200, route);
    const json = JSON.stringify(result.data);
    for (const hidden of [
      input.requestId,
      correction.requestId,
      completedInput.requestId,
      'reviewedConfirmed',
      'originalCheckIn',
      'expectedUpdatedAt',
      'payloadHash',
      'Private handover',
      'Private synthetic assessment',
      'Second private assessment',
    ])
      assert.ok(!json.includes(hidden), route + ' leaks ' + hidden);
    if (route === '/activity')
      assert.ok(!json.includes(input.note) && !json.includes(correction.note));
  }
});

test('strict command and private access errors never claim a final outcome; legacy defaults and same-day replacements keep their contract', async (t) => {
  const f = await careApiFixture(t),
    patient = await f.login('patient'),
    input = command();
  for (const key of Object.keys(input)) {
    const value: Record<string, unknown> = { ...input };
    delete value[key];
    unmarked(await f.call(submit, patient, value), 400);
  }
  for (const patch of [
    { requestId: 'invalid' },
    { actorId: patient.user.id },
    { reviewedConfirmed: false },
    { expectedUpdatedAt: ' ' },
    { expectedUpdatedAt: '2026-04-31T12:00:00.000Z' },
    { expectedUpdatedAt: '2026-10-21T12:00:00+05:30' },
    { patientId: ' ' },
    { carePlanId: '' },
    { date: '2027-02-29' },
    { adherence: 'other' },
    { feeling: 'other' },
    { note: 'x'.repeat(8001) },
  ])
    unmarked(await f.call(submit, patient, { ...input, ...patch }), 400);
  unmarked(await f.call(submit + '?extra=1', patient, input), 400);
  unmarked(await f.call(submit, undefined, input), 401);
  for (const role of ['admin', 'doctor', 'reception'])
    unmarked(await f.call(submit, await f.login(role), input), 403);
  unmarked(await f.call(submit, { ...patient, csrf: 'incorrect' }, input), 403);
  unmarked(await f.call(submit, patient, { ...input, patientId: 'patient-2' }), 403);
  unmarked(await f.call(submit, patient, { ...input, carePlanId: 'plan-2' }), 403);
  unmarked(await f.call(submit, patient, { ...input, carePlanId: 'missing' }), 404);
  assert.equal(counts(f.db).commands, 0);
  const old = {
    carePlanId,
    date: input.date,
    adherence: input.adherence,
    feeling: input.feeling,
    requestId: input.requestId,
    reviewedConfirmed: false,
    unknown: 1,
  };
  const first = await f.call(legacy + '?ignored=1', patient, old);
  assert.equal(first.status, 201);
  assert.deepEqual(
    Object.keys(first.data).sort(),
    ['id', 'createdAt', 'patientId', 'carePlanId', 'date', 'adherence', 'feeling', 'note'].sort(),
  );
  assert.equal(first.data.note, '');
  const next = await f.call(legacy, patient, old);
  assert.equal(next.status, 200);
  assert.equal(next.data.id, first.data.id);
  assert.ok(next.data.createdAt > first.data.createdAt);
  assert.equal(counts(f.db).commands, 0);
  const priorDate = addDays(input.date, -1),
    prior = current(f.db, command({ date: priorDate }))!;
  const corrected = await f.call(
    submit,
    patient,
    command({ date: priorDate, expectedUpdatedAt: prior.createdAt }),
  );
  assert.equal(corrected.status, 201);
  assert.equal(corrected.data.receipt.checkIn.id, prior.id);
  assert.deepEqual(current(f.db, input), next.data);
});

test('durable date, source and pause rejections bind normalized answers and the actor without revealing clinical data on collision', async (t) => {
  const f = await careApiFixture(t),
    patient = await f.login('patient'),
    admin = await f.login('admin');
  const input = command(),
    saved = await f.call(submit, patient, input);
  assert.equal(saved.status, 201);
  const planBefore = counts(f.db);
  // Distinct plan belonging to the same patient permits a genuine plan-field collision.
  const ownPlan = (
    await f.call('/care-plans', admin, {
      patientId,
      title: 'Other plan',
      instructions: 'Synthetic',
      startDate: input.date,
      endDate: input.date,
      followUpDate: input.date,
      medications: [],
    })
  ).data;
  const rejected = [
    [command({ note: 'private rejected content' }), 409],
    [
      command({
        date: addDays(input.date, -14),
        expectedUpdatedAt: saved.data.receipt.checkIn.createdAt,
      }),
      409,
    ],
    [command({ date: addDays(input.date, -15) }), 400],
    [command({ date: addDays(input.date, 1) }), 400],
    [command({ date: addDays(input.date, 29) }), 400],
  ] as const;
  for (const [denial, status] of rejected) {
    const r = await f.call(submit, patient, { ...denial, note: ' ' + denial.note + ' ' });
    assert.equal(r.status, status);
    assert.deepEqual(r.data, {
      code: 'CHECK_IN_NOT_SAVED',
      actorId: patient.user.id,
      command: denial,
      message: r.data.message,
    });
    assert.ok(r.data.message);
    assert.deepEqual((await f.call(submit, patient, denial)).data, r.data);
  }
  const paused = command({
    expectedUpdatedAt: saved.data.receipt.checkIn.createdAt,
    note: 'Not yet submitted',
  });
  followUpEnabled(f.db, false);
  const denial = await f.call(submit, patient, paused);
  assert.equal(denial.status, 403);
  assert.equal(denial.data.code, 'CHECK_IN_NOT_SAVED');
  assert.deepEqual(denial.data.command, paused);
  followUpEnabled(f.db, true);
  const replay = await f.call(submit, patient, paused);
  assert.equal(replay.status, 403);
  assert.deepEqual(replay.data, denial.data);
  for (const original of [input, paused]) {
    for (const patch of [
      { carePlanId: ownPlan.id },
      { date: addDays(input.date, -5) },
      { adherence: 'missed' },
      { feeling: 'worse' },
      { note: 'Different' },
      {
        expectedUpdatedAt:
          original.expectedUpdatedAt === null ? saved.data.receipt.checkIn.createdAt : null,
      },
    ]) {
      const collision = await f.call(submit, patient, { ...original, ...patch });
      unmarked(collision, 409);
      assert.ok(!JSON.stringify(collision.data).includes(original.note));
    }
    unmarked(await f.call(submit, patient, { ...original, patientId: 'patient-2' }), 403);
    changeUser(f.db, patient.user, { patientId: undefined });
    changeUser(f.db, admin.user, { role: 'patient', patientId });
    unmarked(await f.call(submit, admin, original), 409);
    changeUser(f.db, admin.user, {});
    changeUser(f.db, patient.user, {});
  }
  assert.deepEqual(counts(f.db), {
    ...planBefore,
    commands: planBefore.commands + rejected.length + 1,
  });
  assert.ok(
    !JSON.stringify(
      f.db.prepare('SELECT * FROM checkInSubmissionCommands WHERE checkInId IS NULL').all(),
    ).includes('private rejected content'),
  );
  assert.equal((await f.call(submit, patient, { ...paused, requestId: randomUUID() })).status, 201);
});

test('rapid deliberate corrections from both adapters advance the report version even if the system clock stops or moves back', async (t) => {
  const f = await careApiFixture(t),
    patient = await f.login('patient'),
    input = command(),
    before = counts(f.db);
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  const first = await f.call(legacy, patient, input);
  assert.equal(first.status, 201);
  assert.equal(Date.parse(first.data.createdAt), clock);
  const second = await f.call(submit, patient, {
    ...input,
    expectedUpdatedAt: first.data.createdAt,
  });
  assert.equal(second.status, 201);
  assert.equal(Date.parse(second.data.receipt.checkIn.createdAt), clock + 1);
  clock -= 1000;
  const third = await f.call(legacy, patient, input);
  assert.equal(third.status, 200);
  assert.equal(third.data.id, first.data.id);
  assert.equal(Date.parse(third.data.createdAt), Date.parse(first.data.createdAt) + 2);
  assert.deepEqual(counts(f.db), {
    checks: before.checks + 1,
    commands: before.commands + 1,
    audits: before.audits + 3,
    notices: before.notices + 6,
  });
  const stale = await f.call(
    submit,
    patient,
    command({ expectedUpdatedAt: second.data.receipt.checkIn.createdAt }),
  );
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, 'CHECK_IN_NOT_SAVED');
  assert.deepEqual(current(f.db, input), third.data);
});

test('independent SQLite writers converge on one report and serialize competing corrections; original receipts survive reopening', async (t) => {
  const f = await careApiFixture(t),
    patient = await f.login('patient'),
    input = command(),
    before = counts(f.db);
  const saved = await simultaneousCareRequests(f, submit, patient, input);
  assert.deepEqual(saved.map((x) => x.status).sort(), [200, 201]);
  assert.deepEqual(saved[0].data, saved[1].data);
  const report = saved[0].data.receipt.checkIn;
  assert.deepEqual(counts(f.db), {
    checks: before.checks + 1,
    commands: before.commands + 1,
    audits: before.audits + 1,
    notices: before.notices + 2,
  });
  const a = command({ expectedUpdatedAt: report.createdAt, note: 'Competing alternative A' }),
    b = command({ expectedUpdatedAt: report.createdAt, note: 'Competing alternative B' });
  const [left, right] = await Promise.all([
    simultaneousCareRequests(f, submit, patient, a),
    simultaneousCareRequests(f, submit, patient, b),
  ]);
  const [winner, loser, won, lost] =
    left[0].status === 409 ? ([b, a, right, left] as const) : ([a, b, left, right] as const);
  assert.deepEqual(won.map((x) => x.status).sort(), [200, 201]);
  assert.deepEqual(
    lost.map((x) => x.status),
    [409, 409],
  );
  assert.deepEqual(won[0].data, won[1].data);
  assert.deepEqual(lost[0].data, lost[1].data);
  assert.deepEqual(lost[0].data.command, loser);
  assert.deepEqual(current(f.db, input), won[0].data.receipt.checkIn);
  assert.deepEqual(counts(f.db), {
    checks: before.checks + 1,
    commands: before.commands + 3,
    audits: before.audits + 2,
    notices: before.notices + 4,
  });
  assert.throws(() => f.db.exec('UPDATE checkInSubmissionCommands SET rowid=rowid'), /immutable/);
  assert.throws(() => f.db.exec('DELETE FROM checkInSubmissionCommands'), /immutable/);
  await f.close();
  const reopened = await careApiFixture(t, f.databasePath),
    state = counts(reopened.db);
  for (const [cmd, expected, status] of [
    [input, saved[0].data, 200],
    [winner, won[0].data, 200],
    [loser, lost[0].data, 409],
  ] as const) {
    const r = await reopened.call(submit, patient, cmd);
    assert.equal(r.status, status);
    assert.deepEqual(r.data, expected);
  }
  assert.deepEqual(counts(reopened.db), state);
  await reopened.close();
});

test('failed report, audit, recipient and receipt writes roll back the version and all effects across both adapters', async (t) => {
  const f = await careApiFixture(t),
    patient = await f.login('patient');
  for (const route of [submit, legacy]) {
    for (const table of [
      'checkIns',
      'audit',
      'activity',
      ...(route === submit ? ['checkInSubmissionCommands'] : []),
    ]) {
      const base = command(),
        last = current(f.db, base),
        input = { ...base, expectedUpdatedAt: last?.createdAt ?? null },
        before = counts(f.db);
      f.db.exec(
        `CREATE TRIGGER fail_check_in BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'Synthetic check-in failure'); END`,
      );
      const failed = await f.call(route, patient, input);
      f.db.exec('DROP TRIGGER fail_check_in');
      unmarked(failed, 500);
      assert.deepEqual(current(f.db, input), last);
      assert.deepEqual(counts(f.db), before);
      assert.equal(
        (await f.call(route, patient, input)).status,
        route === submit || !last ? 201 : 200,
      );
    }
  }
  const input = command({ expectedUpdatedAt: current(f.db, command())!.createdAt }),
    before = counts(f.db);
  followUpEnabled(f.db, false);
  f.db.exec(
    "CREATE TRIGGER fail_check_in BEFORE INSERT ON checkInSubmissionCommands BEGIN SELECT RAISE(ABORT,'Synthetic rejection-storage failure'); END",
  );
  unmarked(await f.call(submit, patient, input), 500);
  f.db.exec('DROP TRIGGER fail_check_in');
  assert.deepEqual(counts(f.db), before);
  followUpEnabled(f.db, true);
  assert.equal((await f.call(submit, patient, input)).status, 201);
});

test('both writers and both replay outcomes recheck the session, patient link, and plan ownership under the writer lock', async (t) => {
  const f = await careApiFixture(t),
    patient = await f.login('patient'),
    other = openDatabase(f.databasePath);
  t.after(() => other.close());
  const user = patient.user,
    session = other.prepare('SELECT * FROM sessions WHERE userId=?').get(user.id)!;
  const created = command(),
    saved = await f.call(submit, patient, created);
  assert.equal(saved.status, 201);
  const rejected = command(),
    denial = await f.call(submit, patient, rejected);
  assert.equal(denial.status, 409);
  assert.equal(denial.data.code, 'CHECK_IN_NOT_SAVED');
  const baseline = counts(f.db);
  const cases: [string, number, () => unknown][] = [
    ['logout', 401, () => other.prepare('DELETE FROM sessions WHERE userId=?').run(user.id)],
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
    ['password change', 403, () => changeUser(other, user, { mustChangePassword: true })],
    ['doctor', 403, () => changeUser(other, user, { role: 'doctor' })],
    ['administrator', 403, () => changeUser(other, user, { role: 'admin' })],
    ['reception', 403, () => changeUser(other, user, { role: 'receptionist' })],
    ['empty link', 403, () => changeUser(other, user, { patientId: undefined })],
    ['relinked portal', 403, () => changeUser(other, user, { patientId: 'patient-2' })],
    [
      'plan owner changed',
      403,
      () =>
        other
          .prepare(
            "UPDATE carePlans SET patientId='patient-2',data=json_set(data,'$.patientId','patient-2') WHERE id=?",
          )
          .run(carePlanId),
    ],
  ];
  for (const [route, input] of [
    [submit, command({ expectedUpdatedAt: saved.data.receipt.checkIn.createdAt })],
    [submit, created],
    [submit, rejected],
    [legacy, command()],
  ] as const) {
    for (const [label, status, change] of cases) {
      const r = await beforeTransaction(f.db, 'BEGIN IMMEDIATE', change, () =>
        f.call(route, patient, input),
      );
      assert.equal(r.status, status, label);
      unmarked(r, status);
      assert.ok(!JSON.stringify(r.data).includes(created.note));
      assert.deepEqual(counts(f.db), baseline);
      changeUser(other, user, {});
      other
        .prepare("UPDATE carePlans SET patientId=?,data=json_set(data,'$.patientId',?) WHERE id=?")
        .run(patientId, patientId, carePlanId);
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
  for (const route of [submit, legacy]) {
    const input = command({ expectedUpdatedAt: saved.data.receipt.checkIn.createdAt });
    const paused = await beforeTransaction(
      f.db,
      'BEGIN IMMEDIATE',
      () => followUpEnabled(other, false),
      () => f.call(route, patient, input),
    );
    assert.equal(paused.status, 403);
    assert.equal(paused.data.code, route === submit ? 'CHECK_IN_NOT_SAVED' : undefined);
    followUpEnabled(other, true);
    const completed = await beforeTransaction(
      f.db,
      'BEGIN IMMEDIATE',
      () =>
        other
          .prepare("UPDATE carePlans SET data=json_set(data,'$.status','completed') WHERE id=?")
          .run(carePlanId),
      () => f.call(route, patient, command()),
    );
    assert.equal(completed.status, 409);
    assert.equal(completed.data.code, route === submit ? 'CHECK_IN_NOT_SAVED' : undefined);
    other
      .prepare("UPDATE carePlans SET data=json_set(data,'$.status','active') WHERE id=?")
      .run(carePlanId);
  }
});

test('an earlier database opens additively and a correction keeps the visible report identity even after a legacy upsert race', async (t) => {
  const old = await careApiFixture(t),
    patient = await old.login('patient'),
    input = command({ date: addDays(clinicToday(), -1) });
  const previous = current(old.db, input)!;
  const originalKey = previous.id,
    visibleId = randomUUID();
  // Recreate the two v1.45 INSERTs which had independently allocated IDs before taking a lock.
  old.db
    .prepare(
      'INSERT INTO checkIns(id,patientId,carePlanId,date,data) VALUES (?,?,?,?,?) ON CONFLICT(carePlanId,date) DO UPDATE SET data=excluded.data',
    )
    .run(
      visibleId,
      patientId,
      carePlanId,
      input.date,
      JSON.stringify({ ...previous, id: visibleId }),
    );
  const records = old.db.prepare('SELECT id,data FROM checkIns ORDER BY rowid').all();
  old.db.exec('DROP TABLE checkInSubmissionCommands');
  await old.close();
  const migrated = await careApiFixture(t, old.databasePath);
  assert.deepEqual(
    migrated.db.prepare('SELECT id,data FROM checkIns ORDER BY rowid').all(),
    records,
  );
  assert.equal(counts(migrated.db).commands, 0);
  const correction = { ...input, expectedUpdatedAt: previous.createdAt };
  const saved = await migrated.call(submit, patient, correction);
  assert.equal(saved.status, 201);
  assert.equal(saved.data.receipt.checkIn.id, visibleId);
  assert.ok(saved.data.receipt.checkIn.createdAt > previous.createdAt);
  assert.equal(
    migrated.db
      .prepare('SELECT checkInId FROM checkInSubmissionCommands WHERE requestId=?')
      .get(input.requestId)!.checkInId,
    originalKey,
  );
  assert.deepEqual((await migrated.call(submit, patient, correction)).data, saved.data);
  await migrated.close();
});
