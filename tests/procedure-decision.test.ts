import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { openDatabase, type DB } from '../server/db.ts';
import type { ProcedureRecord } from '../shared/clinical.ts';
import type { ProcedureDecisionCommand } from '../shared/procedure-decision.ts';
import {
  beforeTransaction,
  careApiFixture,
  changeUser,
  simultaneousCareRequests,
  type Client,
} from './fixtures/care-api.ts';

const patientId = 'patient-ananya';
const note = 'Synthetic patient decision note.';
const completion = { outcome: 'Synthetic outcome.', aftercare: 'Synthetic aftercare.' };

async function fixture(t: TestContext) {
  const f = await careApiFixture(t);
  const doctor = await f.login('doctor'),
    patient = await f.login('patient'),
    admin = await f.login('admin');
  changeUser(f.db, admin.user, { doctorId: 'doctor-arjun' });
  const createPlan = async (target = patientId) => {
    const response = await f.call('/procedures', doctor, {
      patientId: target,
      title: 'Synthetic procedure',
      indication: 'Indication',
      benefits: 'Benefits',
      risks: 'Risks',
      alternatives: 'Alternatives',
      aftercare: 'Aftercare',
    });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return response.data as ProcedureRecord;
  };
  const plan = await createPlan(),
    base = '/procedures/' + plan.id;
  const input = (patch: Partial<ProcedureDecisionCommand> = {}): ProcedureDecisionCommand => ({
    requestId: randomUUID(),
    patientId,
    procedureId: plan.id,
    recordedByRole: 'patient',
    expectedLatestDecisionId: null,
    decision: 'agreed',
    method: 'portal',
    note,
    patientDecisionConfirmed: false,
    reviewedConfirmed: true,
    ...patch,
  });
  const staffInput = (patch: Partial<ProcedureDecisionCommand> = {}) =>
    input({
      recordedByRole: 'doctor',
      method: 'phone',
      patientDecisionConfirmed: true,
      decision: 'declined',
      note: 'The patient communicated this decision by phone.',
      ...patch,
    });
  const workflow = async (who = patient) => {
    const response = await f.call('/patients/' + patientId + '/clinical-workflows', who);
    assert.equal(response.status, 200);
    return (response.data.procedures as ProcedureRecord[]).find((row) => row.id === plan.id)!;
  };
  return {
    ...f,
    doctor,
    patient,
    admin,
    input,
    staffInput,
    createPlan,
    workflow,
    plan,
    base,
    legacy: base + '/agreements',
    record: base + '/agreements/record',
  };
}

function effects(db: DB) {
  const count = (sql: string) => Number(db.prepare(sql).get()!.n);
  return {
    agreements: count('SELECT COUNT(*) n FROM procedureAgreements'),
    commands: count('SELECT COUNT(*) n FROM procedureDecisionCommands'),
    notices: count("SELECT COUNT(*) n FROM activity WHERE eventKey LIKE 'procedure-decision:%'"),
    audits: count(
      "SELECT COUNT(*) n FROM audit WHERE json_extract(data,'$.action') LIKE 'recorded procedure decision:%'",
    ),
  };
}
type Result = { status: number; data: Record<string, unknown> };
function unmarked(r: Result, status: number) {
  assert.equal(r.status, status, JSON.stringify(r.data));
  assert.deepEqual(Object.keys(r.data), ['error']);
}
function refused(r: Result, who: Client, command: ProcedureDecisionCommand) {
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.deepEqual(r.data, {
    code: 'PROCEDURE_DECISION_NOT_RECORDED',
    actorId: who.user.id,
    command,
    message: r.data.message,
  });
  assert.ok(typeof r.data.message === 'string' && r.data.message.trim());
}

test('recovering an earlier agreement preserves the newer decline, both authors and the completion gate', async (t) => {
  const f = await fixture(t),
    patientCommand = f.input();
  const first = await f.call(f.record, f.patient, {
    ...patientCommand,
    note: ' ' + note + ' ',
    requestId: patientCommand.requestId.toUpperCase(),
  });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const agreement = first.data.receipt.agreement;
  assert.deepEqual(first.data, {
    receipt: {
      requestId: patientCommand.requestId,
      actorId: f.patient.user.id,
      patientId,
      procedureId: f.plan.id,
      expectedLatestDecisionId: null,
      agreement: {
        id: agreement.id,
        createdAt: agreement.createdAt,
        procedureId: f.plan.id,
        decision: 'agreed',
        method: 'portal',
        note,
        recordedById: f.patient.user.id,
        recordedByName: f.patient.user.name,
        recordedByRole: 'patient',
      },
    },
  });
  assert.match(agreement.id, /^[a-f0-9-]{36}$/);
  assert.equal(new Date(agreement.createdAt).toISOString(), agreement.createdAt);
  const staffCommand = f.staffInput({ expectedLatestDecisionId: agreement.id });
  const second = await f.call(f.record, f.doctor, staffCommand);
  assert.equal(second.status, 201);
  const decline = second.data.receipt.agreement;
  assert.deepEqual(second.data.receipt, {
    requestId: staffCommand.requestId,
    actorId: f.doctor.user.id,
    patientId,
    procedureId: f.plan.id,
    expectedLatestDecisionId: agreement.id,
    agreement: {
      id: decline.id,
      createdAt: decline.createdAt,
      procedureId: f.plan.id,
      decision: 'declined',
      method: 'phone',
      note: staffCommand.note,
      recordedById: f.doctor.user.id,
      recordedByName: f.doctor.user.name,
      recordedByRole: 'doctor',
    },
  });
  const before = effects(f.db);
  changeUser(f.db, f.patient.user, { name: 'Renamed patient account' });
  const replay = await f.call(
    f.record,
    f.patient,
    Object.fromEntries(Object.entries(patientCommand).reverse()),
  );
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data, first.data);
  assert.deepEqual(effects(f.db), before);
  unmarked(await f.call(f.base + '/complete', f.doctor, completion), 409);
  assert.deepEqual(await f.workflow(), { ...f.plan, agreements: [agreement, decline] });
  assert.deepEqual(await f.workflow(f.doctor), await f.workflow());
  for (const [event, who] of [
    [agreement, f.doctor],
    [decline, f.patient],
  ] as const) {
    const rows = f.db
      .prepare('SELECT userId,data FROM activity WHERE eventKey=?')
      .all('procedure-decision:' + event.id);
    assert.deepEqual(
      rows.map((r) => r.userId),
      [who.user.id],
    );
    assert.ok(!String(rows[0].data).includes(event.note));
  }
  const returned = await f.call(
    f.record,
    f.patient,
    f.input({ expectedLatestDecisionId: decline.id }),
  );
  assert.equal(returned.status, 201);
  assert.equal(returned.data.receipt.agreement.recordedByName, 'Renamed patient account');
  assert.notEqual(returned.data.receipt.agreement.id, agreement.id);
  const completed = await f.call(f.base + '/complete', f.doctor, completion);
  assert.equal(completed.status, 200);
  assert.deepEqual(completed.data.agreements, [
    agreement,
    decline,
    returned.data.receipt.agreement,
  ]);
  const closed = await f.workflow(),
    after = effects(f.db);
  const retry = await f.call(f.record, f.doctor, staffCommand);
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.data, second.data);
  assert.deepEqual(await f.workflow(), closed);
  assert.deepEqual(effects(f.db), after);
  for (const path of [
    '/patients/' + patientId + '/clinical-workflows',
    '/patients/' + patientId + '/care-summary',
    '/activity',
  ]) {
    const response = await f.call(path, f.patient);
    assert.equal(response.status, 200);
    assert.ok(!JSON.stringify(response.data).includes(staffCommand.requestId));
  }
});

test('legacy decisions remain readable and order new commands; stale and terminal outcomes stay final for each request', async (t) => {
  const f = await fixture(t),
    stale = f.input(),
    before = effects(f.db);
  const legacy = await f.call(f.legacy + '?legacy=1', f.patient, {
    decision: 'declined',
    method: 'portal',
    patientDecisionConfirmed: true,
    ignored: 'legacy extra',
  });
  assert.equal(legacy.status, 201);
  const first = legacy.data.agreements[0];
  assert.equal(first.note, '');
  assert.deepEqual(legacy.data, { ...f.plan, agreements: [first] });
  const rejected = await f.call(f.record, f.patient, stale);
  refused(rejected, f.patient, stale);
  const staffCommand = f.staffInput({
    recordedByRole: 'admin',
    expectedLatestDecisionId: first.id,
    method: 'in-person',
  });
  const next = await f.call(f.record, f.admin, staffCommand);
  assert.equal(next.status, 201);
  const second = next.data.receipt.agreement;
  assert.equal(second.recordedByRole, 'admin');
  assert.equal(second.recordedById, f.admin.user.id);
  assert.equal(second.method, 'in-person');
  assert.equal(second.decision, first.decision);
  assert.notEqual(second.id, first.id);
  const again = await f.call(f.record, f.patient, stale);
  refused(again, f.patient, stale);
  assert.deepEqual(again.data, rejected.data);
  assert.equal(
    (await f.call(f.base + '/cancel', f.doctor, { reason: 'Synthetic cancellation' })).status,
    200,
  );
  const terminal = f.input({ expectedLatestDecisionId: second.id });
  const denied = await f.call(f.record, f.patient, terminal);
  refused(denied, f.patient, terminal);
  assert.notEqual(denied.data.message, rejected.data.message);
  for (const [cmd, original] of [
    [stale, rejected],
    [terminal, denied],
  ] as const) {
    assert.deepEqual((await f.call(f.record, f.patient, cmd)).data, original.data);
    unmarked(await f.call(f.record, f.patient, { ...cmd, note: 'Changed claim' }), 409);
  }
  unmarked(await f.call(f.legacy, f.patient, { decision: 'agreed', method: 'portal' }), 409);
  assert.deepEqual((await f.call(f.record, f.admin, staffCommand)).data, next.data);
  assert.deepEqual((await f.workflow()).agreements, [first, second]);
  assert.deepEqual(effects(f.db), {
    agreements: before.agreements + 2,
    commands: before.commands + 3,
    audits: before.audits + 2,
    notices: before.notices + 2,
  });
});

test('recording validates the reviewed plan, role, method and explicit communication before issuing proof', async (t) => {
  const f = await fixture(t),
    cmd = f.input(),
    staff = f.staffInput(),
    baseline = effects(f.db);
  for (const key of Object.keys(cmd)) {
    const incomplete = { ...cmd };
    delete incomplete[key as keyof ProcedureDecisionCommand];
    unmarked(await f.call(f.record, f.patient, incomplete), 400);
  }
  for (const patch of [
    { requestId: 'bad' },
    { reviewedConfirmed: false },
    { decision: 'undecided' },
    { note: 'x'.repeat(8001) },
    { expectedLatestDecisionId: '' },
    { extra: true },
  ]) {
    unmarked(await f.call(f.record, f.patient, { ...cmd, ...patch }), 400);
  }
  unmarked(await f.call(f.record + '?mode=test', f.patient, cmd), 400);
  unmarked(await f.call(f.record, f.patient, { ...cmd, method: 'phone' }), 403);
  unmarked(await f.call(f.record, f.patient, { ...cmd, patientDecisionConfirmed: true }), 400);
  unmarked(await f.call(f.record, f.doctor, { ...staff, method: 'portal' }), 403);
  unmarked(await f.call(f.record, f.doctor, { ...staff, note: ' ' }), 400);
  unmarked(await f.call(f.record, f.doctor, { ...staff, patientDecisionConfirmed: false }), 400);
  unmarked(await f.call(f.record, f.doctor, cmd), 403);
  unmarked(await f.call(f.record, f.patient, { ...cmd, patientId: 'patient-2' }), 409);
  const other = await f.createPlan(),
    otherPath = '/procedures/' + other.id + '/agreements/record';
  unmarked(await f.call(otherPath, f.patient, cmd), 409);
  const foreign = await f.createPlan('patient-2');
  unmarked(await f.call('/procedures/' + foreign.id + '/agreements/record', f.patient, cmd), 403);
  unmarked(await f.call('/procedures/missing/agreements/record', f.patient, cmd), 404);
  assert.deepEqual(effects(f.db), baseline);
  assert.equal((await f.call(f.record, f.doctor, staff)).status, 201);
  const frozen = effects(f.db);
  for (const patch of [
    { note: 'different' },
    { decision: 'agreed' },
    { method: 'in-person' },
    { expectedLatestDecisionId: randomUUID() },
  ])
    unmarked(await f.call(f.record, f.doctor, { ...staff, ...patch }), 409);
  unmarked(await f.call(otherPath, f.doctor, { ...staff, procedureId: other.id }), 409);
  unmarked(await f.call(f.record, f.admin, { ...staff, recordedByRole: 'admin' }), 409);
  changeUser(f.db, f.admin.user, { role: 'doctor', doctorId: 'doctor-arjun' });
  unmarked(await f.call(f.record, f.admin, staff), 409);
  unmarked(await f.call(f.record, undefined, staff), 401);
  unmarked(await f.call(f.record, await f.login('reception'), staff), 403);
  unmarked(await f.call(f.record, { ...f.doctor, csrf: 'wrong' }, staff), 403);
  changeUser(f.db, f.admin.user, { doctorId: undefined });
  unmarked(await f.call('/procedures/missing/agreements', f.admin, {}), 404);
  const malformed = await f.call(f.legacy, f.admin, {});
  unmarked(malformed, 400);
  assert.doesNotMatch(malformed.data.error, /linked doctor/);
  const unlinked = await f.call(f.legacy, f.admin, staff);
  unmarked(unlinked, 400);
  assert.match(unlinked.data.error, /linked doctor/);
  assert.deepEqual(effects(f.db), frozen);
});

test('independent SQLite writers recover one receipt and choose one current decision from competing reviews; outcomes survive reopening', async (t) => {
  const f = await fixture(t),
    cmd = f.input(),
    baseline = effects(f.db);
  const twins = await simultaneousCareRequests(f, f.record, f.patient, cmd);
  assert.deepEqual(twins.map((r) => r.status).sort(), [200, 201]);
  assert.deepEqual(twins[0].data, twins[1].data);
  const initial = twins[0].data.receipt.agreement;
  const a = f.input({ expectedLatestDecisionId: initial.id }),
    b = f.staffInput({ expectedLatestDecisionId: initial.id });
  const competing = await simultaneousCareRequests(f, f.record, f.patient, a, {
    who: f.doctor,
    body: b,
  });
  assert.deepEqual(competing.map((r) => r.status).sort(), [201, 409]);
  const won = competing.find((r) => r.status === 201)!.data.receipt.agreement;
  const contender = [
    { cmd: a, who: f.patient },
    { cmd: b, who: f.doctor },
  ];
  const loser = competing.findIndex((r) => r.status === 409);
  refused(competing[loser], contender[loser].who, contender[loser].cmd);
  const history = await f.workflow(),
    frozen = effects(f.db);
  assert.deepEqual(history.agreements, [initial, won]);
  assert.deepEqual(frozen, {
    agreements: baseline.agreements + 2,
    commands: baseline.commands + 3,
    notices: baseline.notices + 2,
    audits: baseline.audits + 2,
  });
  assert.throws(() => f.db.exec('UPDATE procedureDecisionCommands SET rowid=rowid'), /append-only/);
  assert.throws(() => f.db.exec('DELETE FROM procedureDecisionCommands'), /append-only/);
  await f.close();
  const reopened = await careApiFixture(t, f.databasePath);
  assert.deepEqual((await reopened.call(f.record, f.patient, cmd)).data, twins[0].data);
  for (const [i, { who, cmd }] of contender.entries()) {
    const replay = await reopened.call(f.record, who, cmd);
    assert.equal(replay.status, i === loser ? 409 : 200);
    assert.deepEqual(replay.data, competing[i].data);
  }
  assert.deepEqual(effects(reopened.db), frozen);
});

test('both recording paths recheck the patient, clinical account and session under the writer lock before fresh writes and stored outcomes', async (t) => {
  const f = await fixture(t),
    other = openDatabase(f.databasePath);
  t.after(() => other.close());
  for (const who of [f.patient, f.doctor]) {
    const make = who === f.patient ? f.input : f.staffInput;
    const latest = (await f.workflow()).agreements.at(-1)?.id ?? null;
    const accepted = make({ expectedLatestDecisionId: latest }),
      stale = make({ expectedLatestDecisionId: randomUUID() });
    const saved = await f.call(f.record, who, accepted);
    assert.equal(saved.status, 201);
    refused(await f.call(f.record, who, stale), who, stale);
    const fresh = make({ expectedLatestDecisionId: saved.data.receipt.agreement.id }),
      baseline = effects(f.db);
    const original = who.user,
      restore = () => changeUser(other, original, {});
    const session = other.prepare('SELECT * FROM sessions WHERE userId=?').get(original.id)!;
    const cases: [number, () => unknown, () => unknown][] = [
      [
        401,
        () => other.prepare('UPDATE sessions SET expiresAt=0 WHERE userId=?').run(original.id),
        () =>
          other
            .prepare('UPDATE sessions SET expiresAt=? WHERE userId=?')
            .run(session.expiresAt, original.id),
      ],
      [401, () => changeUser(other, original, { active: false }), restore],
      [403, () => changeUser(other, original, { mustChangePassword: true }), restore],
      [403, () => changeUser(other, original, { role: 'receptionist' }), restore],
    ];
    if (who === f.patient)
      cases.push([403, () => changeUser(other, original, { patientId: 'patient-2' }), restore]);
    else
      cases.push(
        [400, () => changeUser(other, original, { doctorId: 'missing' }), restore],
        [400, () => changeUser(other, original, { doctorId: undefined }), restore],
      );
    for (const [route, body] of [
      [f.record, fresh],
      [f.record, accepted],
      [f.record, stale],
      [f.legacy, fresh],
    ] as const) {
      for (const [status, mutate, reset] of cases) {
        const result = await beforeTransaction(f.db, 'BEGIN IMMEDIATE', mutate, () =>
          f.call(route, who, body),
        );
        reset();
        unmarked(result, status);
        assert.deepEqual(effects(f.db), baseline);
      }
    }
    if (who === f.doctor) {
      changeUser(other, original, { role: 'admin', doctorId: original.doctorId });
      unmarked(await f.call(f.record, who, accepted), 403);
      unmarked(await f.call(f.record, who, { ...accepted, recordedByRole: 'admin' }), 409);
      restore();
    }
  }
});

test('a decision or completion committed after middleware but before the writer lock makes a fresh reviewed submission ineligible', async (t) => {
  const f = await fixture(t),
    other = openDatabase(f.databasePath);
  t.after(() => other.close());
  const command = f.input();
  const prior = {
    id: randomUUID(),
    procedureId: f.plan.id,
    createdAt: new Date().toISOString(),
    decision: 'agreed',
    method: 'portal',
    note: '',
    recordedById: f.patient.user.id,
    recordedByName: f.patient.user.name,
    recordedByRole: 'patient',
  };
  const rejected = await beforeTransaction(
    f.db,
    'BEGIN IMMEDIATE',
    () =>
      other
        .prepare('INSERT INTO procedureAgreements(id,procedureId,data) VALUES (?,?,?)')
        .run(prior.id, f.plan.id, JSON.stringify(prior)),
    () => f.call(f.record, f.patient, command),
  );
  refused(rejected, f.patient, command);
  const next = f.staffInput({ expectedLatestDecisionId: prior.id });
  const denied = await beforeTransaction(
    f.db,
    'BEGIN IMMEDIATE',
    () =>
      other.prepare('INSERT INTO procedureCompletions(id,data) VALUES (?,?)').run(
        f.plan.id,
        JSON.stringify({
          ...completion,
          doctorId: f.plan.doctorId,
          doctorName: f.plan.doctorName,
          completedAt: new Date().toISOString(),
        }),
      ),
    () => f.call(f.record, f.doctor, next),
  );
  refused(denied, f.doctor, next);
  assert.notEqual(denied.data.message, rejected.data.message);
  for (const [cmd, who, original] of [
    [command, f.patient, rejected],
    [next, f.doctor, denied],
  ] as const)
    assert.deepEqual((await f.call(f.record, who, cmd)).data, original.data);
  const current = await f.workflow();
  assert.equal(current.status, 'completed');
  assert.deepEqual(current.agreements, [prior]);
});

test('agreement, audit, notice and command storage fail atomically; a storage error cannot promise a saved or rejected decision', async (t) => {
  const f = await fixture(t);
  const failStep = async (table: string, path: string, body: ProcedureDecisionCommand) => {
    const baseline = effects(f.db);
    f.db.exec(
      `CREATE TRIGGER synthetic_decision_failure BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'Synthetic decision storage failure'); END`,
    );
    try {
      unmarked(await f.call(path, f.patient, body), 500);
    } finally {
      f.db.exec('DROP TRIGGER synthetic_decision_failure');
    }
    assert.deepEqual(effects(f.db), baseline, table);
  };
  for (const route of [f.legacy, f.record]) {
    const latest = (await f.workflow()).agreements.at(-1)?.id ?? null,
      cmd = f.input({ expectedLatestDecisionId: latest });
    for (const table of [
      'procedureAgreements',
      'audit',
      'activity',
      ...(route === f.record ? ['procedureDecisionCommands'] : []),
    ])
      await failStep(table, route, cmd);
    assert.equal((await f.call(route, f.patient, cmd)).status, 201);
  }
  const stale = f.input();
  await failStep('procedureDecisionCommands', f.record, stale);
  refused(await f.call(f.record, f.patient, stale), f.patient, stale);
});
