import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { CarePlanCreationCommand, CarePlanFields } from '../shared/care-plan-creation.ts';
import type { CarePlan, User } from '../shared/types.ts';
import { get, openDatabase, type DB } from '../server/db.ts';
import {
  beforeTransaction,
  careApiFixture,
  changeUser,
  simultaneousCareRequests,
} from './fixtures/care-api.ts';

const patientId = 'patient-ananya',
  doctorId = 'doctor-meera',
  otherDoctor = 'doctor-arjun';
const path = '/care-plans/create';
const fields: CarePlanFields = {
  title: 'Synthetic plan',
  instructions: 'Reviewed line one\nReviewed line two',
  expectations: 'Expected outcome',
  warnings: 'Reviewed precautions',
  cost: 'Cost discussed',
  startDate: '2028-02-29',
  endDate: '2028-03-02',
  followUpDate: '2028-03-10',
  medications: [
    {
      name: 'Synthetic item',
      instructions: 'Synthetic directions',
      schedule: 'Patient-entered schedule',
      duration: 'Documented duration',
      warnings: 'Item warning',
    },
    {
      name: 'Second item',
      instructions: 'Other directions',
      schedule: 'Other schedule',
      duration: 'Other duration',
      warnings: '',
    },
  ],
};
function command(): CarePlanCreationCommand {
  return { requestId: randomUUID(), patientId, doctorId, reviewedConfirmed: true, ...fields };
}
function counts(db: DB) {
  return Object.fromEntries(
    [
      'carePlans',
      'carePlanCreationCommands',
      'audit',
      'activity',
      'appointments',
      'invoices',
      'followUpAssignments',
      'followUpReviews',
    ].map((table) => [table, Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n)]),
  );
}

test('reviewed plan creation commits one ordered regimen, audit and notice and returns a private unchanged original', async (t) => {
  const f = await careApiFixture(t),
    author = await f.login('doctor'),
    patient = await f.login('patient');
  const input = command(),
    before = counts(f.db);
  // The follow-up module gates reports and reviews, not sharing a new regimen.
  f.db
    .prepare(
      "UPDATE meta SET value=json_set(value,'$.modules.followUp',json('false')) WHERE key='settings'",
    )
    .run();
  const result = await f.call(path, author, {
    ...input,
    requestId: input.requestId.toUpperCase(),
    title: ' ' + fields.title + ' ',
    medications: fields.medications.map((m) => ({ ...m, instructions: m.instructions + '  ' })),
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const plan = result.data.receipt.plan;
  assert.match(plan.id, /^[a-f0-9-]{36}$/);
  assert.equal(new Date(plan.createdAt).toISOString(), plan.createdAt);
  assert.deepEqual(plan, {
    ...fields,
    id: plan.id,
    patientId,
    doctorId,
    patientName: patient.user.name,
    doctorName: author.user.name,
    status: 'active',
    createdAt: plan.createdAt,
  });
  assert.deepEqual(result.data.receipt, {
    requestId: input.requestId,
    actorId: author.user.id,
    doctorId,
    patientId,
    plan,
  });
  const reordered = Object.fromEntries(
    Object.entries({
      ...input,
      medications: input.medications.map((m) => Object.fromEntries(Object.entries(m).reverse())),
    }).reverse(),
  );
  const retry = await f.call(path, author, reordered);
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.data, result.data);
  assert.deepEqual(counts(f.db), {
    ...before,
    carePlans: before.carePlans + 1,
    carePlanCreationCommands: before.carePlanCreationCommands + 1,
    audit: before.audit + 1,
    activity: before.activity + 1,
  });
  const notice = f.db
    .prepare('SELECT userId,data FROM activity WHERE eventKey=?')
    .all('care-plan-created:' + plan.id);
  assert.equal(notice.length, 1);
  assert.equal(notice[0].userId, patient.user.id);
  const { href, title, detail } = JSON.parse(String(notice[0].data));
  assert.deepEqual(
    { href, title, detail },
    { href: '/my-care?plan=' + plan.id, title: 'Your care plan is ready', detail: fields.title },
  );
  for (const [route, who] of [
    ['/care-plans', patient],
    ['/patients/' + patientId, author],
    ['/patients/' + patientId + '/care-summary', patient],
    ['/activity', patient],
  ] as const) {
    const seen = await f.call(route, who);
    assert.equal(seen.status, 200);
    const json = JSON.stringify(seen.data);
    assert.ok(json.includes(plan.id));
    for (const hidden of [input.requestId, 'reviewedConfirmed', 'payloadHash', 'originalPlan'])
      assert.ok(!json.includes(hidden));
  }
  const again = await f.call(path, author, { ...input, requestId: randomUUID() });
  assert.equal(again.status, 201);
  assert.notEqual(again.data.receipt.plan.id, plan.id);
});

test('strict review validates dates, all plan fields and medication rows; legacy clients keep their defaults and plain response', async (t) => {
  const f = await careApiFixture(t),
    doctor = await f.login('doctor'),
    admin = await f.login('admin'),
    input = command();
  for (const key of Object.keys(input)) {
    const missing: Record<string, unknown> = { ...input };
    delete missing[key];
    assert.equal((await f.call(path, doctor, missing)).status, 400, key);
  }
  for (const patch of [
    { requestId: 'bad' },
    { reviewedConfirmed: false },
    { title: ' ' },
    { instructions: '  ' },
    { cost: 'x'.repeat(301) },
    { expectations: 'x'.repeat(8001) },
    { actorId: 'supplied' },
    { startDate: '2027-02-29' },
    { endDate: '2028-02-28' },
    { followUpDate: '2028-02-27' },
    { medications: Array(31).fill(fields.medications[0]) },
  ]) {
    assert.equal((await f.call(path, doctor, { ...input, ...patch })).status, 400);
  }
  for (const key of Object.keys(fields.medications[0])) {
    const missing: Record<string, unknown> = { ...fields.medications[0] };
    delete missing[key];
    assert.equal(
      (await f.call(path, doctor, { ...input, medications: [missing] })).status,
      400,
      key,
    );
  }
  for (const patch of [
    { unknown: true },
    { schedule: ' ' },
    { duration: 'x'.repeat(301) },
    { name: '' },
    { warnings: 'x'.repeat(8001) },
    { instructions: ' ' },
  ])
    assert.equal(
      (
        await f.call(path, doctor, {
          ...input,
          medications: [{ ...fields.medications[0], ...patch }],
        })
      ).status,
      400,
    );
  assert.equal((await f.call(path + '?extra=1', doctor, input)).status, 400);
  assert.equal((await f.call(path, admin, { ...input, medications: [] })).status, 201);
  const old = await f.call('/care-plans?ignored=1', admin, {
    patientId,
    title: fields.title,
    instructions: fields.instructions,
    startDate: fields.startDate,
    endDate: fields.startDate,
    followUpDate: fields.startDate,
    requestId: input.requestId,
    reviewedConfirmed: false,
    doctorId: otherDoctor,
    medications: [
      {
        name: 'Legacy',
        instructions: 'Legacy directions',
        schedule: 'Schedule',
        duration: 'Duration',
        extraneous: 1,
      },
    ],
  });
  assert.equal(old.status, 201);
  assert.equal(old.data.doctorId, admin.user.doctorId);
  for (const key of ['receipt', 'requestId', 'reviewedConfirmed'])
    assert.equal(key in old.data, false);
  for (const key of ['warnings', 'cost', 'expectations']) assert.equal(old.data[key], '');
  assert.deepEqual(old.data.medications, [
    {
      name: 'Legacy',
      instructions: 'Legacy directions',
      schedule: 'Schedule',
      duration: 'Duration',
      warnings: '',
    },
  ]);
  assert.equal(counts(f.db).carePlanCreationCommands, 1);
  for (const who of ['patient', 'reception']) {
    const denied = await f.call(path, await f.login(who), input);
    assert.equal(denied.status, 403);
    assert.equal(denied.data.code, undefined);
  }
  assert.equal((await f.call(path, undefined, input)).status, 401);
  assert.equal(
    (await f.call(path, doctor, { ...input, patientId: 'missing-patient' })).status,
    404,
  );
});

test('successful and rejected commands bind actor, reviewed author, patient, every field and medication order', async (t) => {
  const f = await careApiFixture(t),
    doctor = await f.login('doctor'),
    admin = await f.login('admin');
  const accepted = command(),
    rejected = { ...command(), doctorId: otherDoctor };
  const original = await f.call(path, doctor, accepted),
    rejection = await f.call(path, doctor, rejected);
  assert.equal(rejection.status, 409);
  assert.deepEqual(rejection.data, {
    code: 'CARE_PLAN_NOT_CREATED',
    actorId: doctor.user.id,
    command: rejected,
    message: rejection.data.message,
  });
  assert.ok(rejection.data.message);
  const state = counts(f.db);
  const alternatives = {
    ...fields,
    title: 'Other title',
    instructions: 'Other text',
    warnings: 'Caution',
    expectations: 'Other expectations',
    cost: 'Other cost',
    startDate: '2028-02-28',
    endDate: '2028-04-01',
    followUpDate: '2028-04-05',
    medications: [],
  };
  for (const source of [accepted, rejected]) {
    const variants: Record<string, unknown>[] = [
      ...Object.entries(alternatives).map(([key, value]) => ({ [key]: value })),
      { doctorId: source.doctorId === doctorId ? otherDoctor : doctorId },
      { patientId: 'patient-2' },
      { medications: [...fields.medications].reverse() },
      ...Object.keys(fields.medications[0]).map((key) => ({
        medications: [{ ...fields.medications[0], [key]: 'Changed' }, fields.medications[1]],
      })),
    ];
    for (const variant of variants) {
      const res = await f.call(path, doctor, { ...source, ...variant });
      assert.equal(res.status, 409);
      assert.equal(res.data.code, undefined);
      assert.equal(res.data.receipt, undefined);
      assert.equal(res.data.command, undefined);
    }
    assert.equal((await f.call(path, admin, source)).status, 409);
  }
  changeUser(f.db, doctor.user, { doctorId: otherDoctor });
  assert.deepEqual((await f.call(path, doctor, accepted)).data, original.data);
  assert.deepEqual((await f.call(path, doctor, rejected)).data, rejection.data);
  assert.deepEqual(counts(f.db), state);
  const fresh = await f.call(path, doctor, { ...rejected, requestId: randomUUID() });
  assert.equal(fresh.status, 201);
  assert.equal(fresh.data.receipt.plan.doctorId, otherDoctor);
});

test('review, handover, completion and renamed profiles change current care without changing the original creation confirmation', async (t) => {
  const f = await careApiFixture(t),
    doctor = await f.login('doctor'),
    admin = await f.login('admin'),
    patient = await f.login('patient');
  const input = command(),
    saved = await f.call(path, doctor, input),
    plan = saved.data.receipt.plan;
  changeUser(f.db, admin.user, { doctorId: otherDoctor });
  const current = async () =>
    (await f.call('/care-plans', doctor)).data.find((c: CarePlan) => c.id === plan.id);
  const assignment = await f.call('/care-plans/' + plan.id + '/assignment', doctor, {
    doctorId: otherDoctor,
    reason: 'Private synthetic handover',
    expectedRevision: (await current()).followUpRevision,
  });
  assert.equal(assignment.status, 201, JSON.stringify(assignment.data));
  const review = await f.call('/care-plans/' + plan.id + '/reviews', admin, {
    assessment: 'Private synthetic assessment',
    patientInstructions: 'Reviewed synthetic update',
    disposition: 'complete',
    expectedRevision: (await current()).followUpRevision,
  });
  assert.equal(review.status, 201, JSON.stringify(review.data));
  const latest = await current();
  assert.equal(latest.status, 'completed');
  assert.equal(latest.effectiveStatus, 'completed');
  assert.ok(latest.latestReview);
  f.db
    .prepare("UPDATE doctors SET data=json_set(data,'$.name','Later doctor name') WHERE id=?")
    .run(doctorId);
  f.db
    .prepare("UPDATE patients SET data=json_set(data,'$.name','Later patient name') WHERE id=?")
    .run(patientId);
  const before = counts(f.db);
  const retry = await f.call(path, doctor, input);
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.data, saved.data);
  assert.deepEqual(counts(f.db), before);
  const publicSummary = await f.call('/patients/' + patientId + '/care-summary', patient);
  assert.equal(
    publicSummary.data.carePlans.find((c: CarePlan) => c.id === plan.id).status,
    'completed',
  );
  assert.ok(!JSON.stringify(publicSummary.data).includes(input.requestId));
  assert.ok(!JSON.stringify(publicSummary.data).includes('Private synthetic'));
});

test('plan, audit, recipient notice and receipt roll back together on writer failure in the reviewed and legacy paths', async (t) => {
  const f = await careApiFixture(t),
    doctor = await f.login('doctor');
  for (const endpoint of [path, '/care-plans']) {
    for (const table of [
      'carePlans',
      'audit',
      'activity',
      ...(endpoint === path ? ['carePlanCreationCommands'] : []),
    ]) {
      const before = counts(f.db),
        input = command();
      f.db.exec(
        `CREATE TRIGGER fail_creation BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'Synthetic care plan creation failure'); END`,
      );
      const res = await f.call(endpoint, doctor, input);
      f.db.exec('DROP TRIGGER fail_creation');
      assert.equal(res.status, 500, table);
      assert.equal(res.data.receipt, undefined);
      assert.equal(res.data.code, undefined);
      assert.deepEqual(counts(f.db), before);
      assert.equal((await f.call(endpoint, doctor, input)).status, 201);
    }
  }
  const before = counts(f.db),
    stale = { ...command(), doctorId: otherDoctor };
  f.db.exec(
    "CREATE TRIGGER fail_rejection BEFORE INSERT ON carePlanCreationCommands BEGIN SELECT RAISE(ABORT,'Synthetic care plan rejection failure'); END",
  );
  assert.equal((await f.call(path, doctor, stale)).status, 500);
  assert.deepEqual(counts(f.db), before);
  f.db.exec('DROP TRIGGER fail_rejection');
  changeUser(f.db, doctor.user, { doctorId: otherDoctor });
  assert.equal((await f.call(path, doctor, stale)).status, 201);
});

test('two independent writers commit one original and immutable success and rejection evidence survive reopening the database', async (t) => {
  const f = await careApiFixture(t),
    doctor = await f.login('doctor'),
    input = command(),
    before = counts(f.db);
  const outcomes = await simultaneousCareRequests(f, path, doctor, input);
  assert.deepEqual(outcomes.map((o) => o.status).sort(), [200, 201]);
  assert.deepEqual(outcomes[0].data, outcomes[1].data);
  assert.deepEqual(counts(f.db), {
    ...before,
    carePlans: before.carePlans + 1,
    audit: before.audit + 1,
    activity: before.activity + 1,
    carePlanCreationCommands: before.carePlanCreationCommands + 1,
  });
  const stale = { ...command(), doctorId: otherDoctor },
    denial = await f.call(path, doctor, stale);
  assert.equal(denial.status, 409);
  assert.throws(() => f.db.exec('UPDATE carePlanCreationCommands SET rowid=rowid'), /immutable/);
  assert.throws(() => f.db.exec('DELETE FROM carePlanCreationCommands'), /immutable/);
  await f.close();
  const restarted = await careApiFixture(t, f.databasePath);
  changeUser(restarted.db, doctor.user, { doctorId: otherDoctor });
  const initial = counts(restarted.db);
  assert.deepEqual((await restarted.call(path, doctor, input)).data, outcomes[0].data);
  assert.deepEqual((await restarted.call(path, doctor, stale)).data, denial.data);
  assert.deepEqual(counts(restarted.db), initial);
  await restarted.close();
});

test('writer-lock authorization covers both adapters and recovery of both outcomes after session, authority and professional changes', async (t) => {
  const f = await careApiFixture(t),
    doctor = await f.login('doctor'),
    other = openDatabase(f.databasePath);
  t.after(() => other.close());
  const user = get<User>(other, 'users', doctor.user.id)!;
  const original = command(),
    rejected = { ...command(), doctorId: otherDoctor };
  assert.equal((await f.call(path, doctor, original)).status, 201);
  assert.equal((await f.call(path, doctor, rejected)).data.code, 'CARE_PLAN_NOT_CREATED');
  const session = other.prepare('SELECT * FROM sessions WHERE userId=?').get(user.id)!;
  const before = counts(f.db);
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
      () => other.prepare("UPDATE sessions SET csrfToken='changed' WHERE userId=?").run(user.id),
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
    ['suspended', 401, () => changeUser(other, user, { active: false })],
    ['required password', 403, () => changeUser(other, user, { mustChangePassword: true })],
    ['reception', 403, () => changeUser(other, user, { role: 'receptionist' })],
    ['patient', 403, () => changeUser(other, user, { role: 'patient', patientId: 'patient-2' })],
    ['no professional', 400, () => changeUser(other, user, { doctorId: undefined })],
    ['invalid professional', 400, () => changeUser(other, user, { doctorId: 'missing' })],
  ];
  for (const [endpoint, input] of [
    [path, command()],
    [path, original],
    [path, rejected],
    ['/care-plans', command()],
  ] as const) {
    for (const [label, status, change] of cases) {
      const res = await beforeTransaction(f.db, 'BEGIN IMMEDIATE', change, () =>
        f.call(endpoint, doctor, input),
      );
      assert.equal(res.status, status, label);
      assert.equal(res.data.code, undefined);
      assert.equal(res.data.receipt, undefined);
      assert.equal(res.data.command, undefined);
      assert.deepEqual(counts(f.db), before);
      changeUser(other, user, {});
      other.prepare('DELETE FROM mfaCredentials WHERE userId=?').run(user.id);
      other.prepare('DELETE FROM sessions WHERE userId=?').run(user.id);
      const cols = Object.keys(session);
      other
        .prepare(
          `INSERT INTO sessions(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
        )
        .run(...Object.values(session));
    }
  }
  const moved = command();
  const raced = await beforeTransaction(
    f.db,
    'BEGIN IMMEDIATE',
    () => changeUser(other, user, { doctorId: otherDoctor }),
    () => f.call(path, doctor, moved),
  );
  assert.equal(raced.status, 409);
  assert.equal(raced.data.code, 'CARE_PLAN_NOT_CREATED');
  changeUser(other, user, {});
  assert.deepEqual((await f.call(path, doctor, moved)).data, raced.data);
  const legacy = await beforeTransaction(
    f.db,
    'BEGIN IMMEDIATE',
    () => {
      changeUser(other, user, { doctorId: otherDoctor });
      other
        .prepare("UPDATE patients SET data=json_set(data,'$.name','Current patient') WHERE id=?")
        .run(patientId);
      other
        .prepare(
          "UPDATE doctors SET data=json_set(data,'$.name','Current professional') WHERE id=?",
        )
        .run(otherDoctor);
    },
    () => f.call('/care-plans', doctor, command()),
  );
  assert.equal(legacy.status, 201);
  assert.equal(legacy.data.doctorId, otherDoctor);
  assert.equal(legacy.data.patientName, 'Current patient');
  assert.equal(legacy.data.doctorName, 'Current professional');
});
