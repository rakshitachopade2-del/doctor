import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { addDays, clinicToday, get, openDatabase, type DB } from '../server/db.ts';
import type { Appointment } from '../shared/types.ts';
import type { ProcedureRecord } from '../shared/clinical.ts';
import type {
  ProcedureCompletionCommand,
  ProcedureCompletionContext,
} from '../shared/procedure-completion.ts';
import {
  careApiFixture,
  beforeTransaction,
  changeUser,
  simultaneousCareRequests,
  type Client,
} from './fixtures/care-api.ts';

const patientId = 'patient-ananya';
const narrative = { outcome: 'Synthetic outcome.', aftercare: 'Synthetic final aftercare.' };
function visit(db: DB, offset: number, time = '08:05'): Appointment {
  const a: Appointment = {
    id: randomUUID(),
    patientId,
    doctorId: 'doctor-meera',
    date: addDays(clinicToday(), offset),
    time,
    status: 'scheduled',
    mode: 'in-person',
    patientName: 'Synthetic patient',
    doctorName: 'Dr. Meera Shah',
    reason: 'Private visit reason',
    fee: 800,
    createdAt: new Date().toISOString(),
  };
  db.prepare(
    'INSERT INTO appointments(id,patientId,doctorId,date,time,status,data) VALUES (?,?,?,?,?,?,?)',
  ).run(a.id, patientId, a.doctorId, a.date, a.time, a.status, JSON.stringify(a));
  return a;
}
function changeVisit(db: DB, original: Appointment, patch: Partial<Appointment>) {
  const a = { ...original, ...patch };
  db.prepare(
    'UPDATE appointments SET patientId=?,doctorId=?,date=?,time=?,status=?,data=? WHERE id=?',
  ).run(a.patientId, a.doctorId, a.date, a.time, a.status, JSON.stringify(a), a.id);
  return a;
}
async function fixture(t: TestContext) {
  const f = await careApiFixture(t);
  const doctor = await f.login('doctor'),
    patient = await f.login('patient'),
    admin = await f.login('admin');
  changeUser(f.db, admin.user, { doctorId: 'doctor-arjun' });
  const create = async (appointmentId: string | null = null) => {
    const r = await f.call('/procedures', doctor, {
      patientId,
      appointmentId,
      title: 'Synthetic procedure',
      indication: 'Indication',
      benefits: 'Benefits',
      risks: 'Risks',
      alternatives: 'Alternatives',
      aftercare: 'Planned aftercare',
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const plan: ProcedureRecord = r.data,
      base = '/procedures/' + plan.id,
      contextPath = base + '/completion-context',
      path = base + '/completions';
    const context = async (who = doctor): Promise<ProcedureCompletionContext> => {
      const r = await f.call(contextPath, who);
      assert.equal(r.status, 200, JSON.stringify(r.data));
      return r.data;
    };
    const decide = async (decision: 'agreed' | 'declined' = 'agreed') => {
      const d = await f.call(base + '/agreements', patient, { method: 'portal', decision });
      assert.equal(d.status, 201, JSON.stringify(d.data));
      return (d.data as ProcedureRecord).agreements.at(-1)!;
    };
    const command = async (who = doctor): Promise<ProcedureCompletionCommand> => {
      const c = await context(who);
      const latest = c.procedure.agreements.at(-1);
      assert.ok(latest);
      return {
        requestId: randomUUID(),
        patientId,
        procedureId: plan.id,
        recordedByRole: who.user.role as 'doctor' | 'admin',
        doctorId: c.doctorId,
        expectedRevision: c.revision,
        expectedDecisionId: latest.id,
        ...narrative,
        reviewedConfirmed: true,
      };
    };
    return { plan, base, path, contextPath, context, decide, command };
  };
  return { ...f, doctor, patient, admin, create };
}
function effects(db: DB) {
  const count = (sql: string) => Number(db.prepare(sql).get()!.n);
  return {
    completions: count('SELECT COUNT(*) n FROM procedureCompletions'),
    commands: count('SELECT COUNT(*) n FROM procedureCompletionCommands'),
    notices: count("SELECT COUNT(*) n FROM activity WHERE eventKey LIKE 'procedure-completed:%'"),
    audits: count(
      "SELECT COUNT(*) n FROM audit WHERE json_extract(data,'$.action')='completed procedure and recorded aftercare'",
    ),
  };
}
type Result = { status: number; data: Record<string, unknown> };
function unmarked(r: Result, status: number) {
  assert.equal(r.status, status, JSON.stringify(r.data));
  assert.deepEqual(Object.keys(r.data), ['error']);
}
function refused(r: Result, who: Client, command: ProcedureCompletionCommand) {
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.equal(typeof r.data.message, 'string');
  const observed = r.data.observed as { decisionId: string | null; status: string };
  assert.ok(observed.decisionId === null || typeof observed.decisionId === 'string');
  assert.ok(['planned', 'completed', 'cancelled'].includes(observed.status));
  assert.deepEqual(r.data, {
    code: 'PROCEDURE_COMPLETION_NOT_RECORDED',
    observed,
    actorId: who.user.id,
    command,
    message: r.data.message,
  });
}

test('a reviewed completion recovers the original clinician, visit and aftercare after a lost reply and later profile or visit changes', async (t) => {
  const f = await fixture(t),
    a = visit(f.db, -10),
    p = await f.create(a.id),
    initial = await p.context();
  assert.equal(initial.allowed, false);
  assert.match(initial.blockedReason!, /agreement/);
  const agreed = await p.decide(),
    c = await p.context(f.admin),
    cmd = await p.command(f.admin);
  assert.equal(c.allowed, true);
  assert.equal(c.blockedReason, null);
  assert.match(c.revision, /^[a-f0-9]{64}$/);
  assert.notEqual(c.revision, initial.revision);
  const stored = await f.call(p.path, f.admin, {
    ...cmd,
    requestId: cmd.requestId.toUpperCase(),
    outcome: ' ' + cmd.outcome + ' ',
  });
  assert.equal(stored.status, 201, JSON.stringify(stored.data));
  const completion = stored.data.receipt.completion;
  assert.equal(new Date(completion.completedAt).toISOString(), completion.completedAt);
  assert.deepEqual(stored.data, {
    receipt: {
      requestId: cmd.requestId,
      actorId: f.admin.user.id,
      patientId,
      procedureId: p.plan.id,
      expectedRevision: c.revision,
      decisionId: agreed.id,
      completion: {
        ...narrative,
        doctorId: c.doctorId,
        doctorName: c.doctorName,
        completedAt: completion.completedAt,
        appointment: c.procedure.scheduledAppointment,
      },
    },
  });
  assert.deepEqual(get(f.db, 'appointments', a.id), a);
  const after = effects(f.db);
  assert.deepEqual(after, { completions: 1, commands: 1, notices: 1, audits: 1 });
  const notices = f.db
    .prepare('SELECT userId,data FROM activity WHERE eventKey=?')
    .all('procedure-completed:' + p.plan.id);
  assert.deepEqual(
    notices.map((row) => row.userId),
    [f.patient.user.id],
  );
  assert.ok(!String(notices[0].data).includes(cmd.outcome));
  f.db
    .prepare("UPDATE doctors SET data=json_set(data,'$.name','Renamed clinician') WHERE id=?")
    .run(c.doctorId);
  changeVisit(f.db, a, { mode: 'online', status: 'completed' });
  const again = await f.call(p.path, f.admin, Object.fromEntries(Object.entries(cmd).reverse()));
  assert.equal(again.status, 200);
  assert.deepEqual(again.data, stored.data);
  const current = await p.context(f.admin);
  assert.equal(current.allowed, false);
  assert.deepEqual(current.procedure.completion, completion);
  assert.equal(current.procedure.scheduledAppointment?.mode, 'online');
  assert.equal(current.doctorName, 'Renamed clinician');
  assert.deepEqual(effects(f.db), after);
  for (const path of [
    '/patients/' + patientId + '/clinical-workflows',
    '/patients/' + patientId + '/care-summary',
    '/activity',
  ]) {
    const shared = await f.call(path, f.patient);
    assert.equal(shared.status, 200);
    assert.ok(!JSON.stringify(shared.data).includes(cmd.requestId));
    assert.ok(!JSON.stringify(shared.data).includes(c.revision));
  }
  const patientView = await f.call('/patients/' + patientId + '/clinical-workflows', f.patient);
  assert.deepEqual(
    patientView.data.procedures.find((row: ProcedureRecord) => row.id === p.plan.id).completion,
    completion,
  );
});

test('a new decision invalidates a reviewed completion even when the patient agrees again, and refused commands cannot later complete it', async (t) => {
  const f = await fixture(t),
    p = await f.create();
  await p.decide();
  const withdrawn = await p.command();
  const decline = await p.decide('declined');
  const first = await f.call(p.path, f.doctor, withdrawn);
  refused(first, f.doctor, withdrawn);
  assert.deepEqual(first.data.observed, { decisionId: decline.id, status: 'planned' });
  assert.equal((await p.context()).allowed, false);
  await p.decide();
  const beforeRepeat = await p.command();
  const reaffirmed = await p.decide();
  const stale = await f.call(p.path, f.doctor, beforeRepeat);
  refused(stale, f.doctor, beforeRepeat);
  assert.deepEqual(stale.data.observed, { decisionId: reaffirmed.id, status: 'planned' });
  assert.equal((await p.context()).allowed, true);
  const forged = { ...(await p.command()), expectedDecisionId: beforeRepeat.expectedDecisionId };
  refused(await f.call(p.path, f.doctor, forged), f.doctor, forged);
  assert.deepEqual(effects(f.db), { completions: 0, commands: 3, notices: 0, audits: 0 });
  const fresh = await p.command();
  const saved = await f.call(p.path, f.doctor, fresh);
  assert.equal(saved.status, 201);
  assert.equal(saved.data.receipt.decisionId, reaffirmed.id);
  assert.equal(saved.data.receipt.completion.appointment, null);
  for (const [cmd, original] of [
    [withdrawn, first],
    [beforeRepeat, stale],
  ] as const)
    assert.deepEqual((await f.call(p.path, f.doctor, cmd)).data, original.data);
  const closed = { ...fresh, requestId: randomUUID() };
  refused(await f.call(p.path, f.doctor, closed), f.doctor, closed);
  unmarked(await f.call(p.base + '/complete', f.doctor, narrative), 409);
});

test('scheduling a visit and removing its link invalidates a prior unlinked review, including after both look identical', async (t) => {
  const f = await fixture(t),
    p = await f.create(),
    a = visit(f.db, 12);
  await p.decide();
  const original = await p.command();
  const route = p.base + '/scheduling';
  const schedule = async () => (await f.call(route, f.admin)).data;
  const choices = await f.call(route + '/candidates?from=' + a.date + '&to=' + a.date, f.admin);
  assert.equal(choices.status, 200);
  const target = choices.data.items.find(
    (x: { appointment: Appointment }) => x.appointment.id === a.id,
  );
  assert.ok(target);
  const made = await f.call(route, f.admin, {
    requestId: randomUUID(),
    expectedRevision: (await schedule()).revision,
    appointmentId: a.id,
    expectedAppointmentRevision: target.revision,
    reason: 'Synthetic private link',
  });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  assert.equal((await p.context()).allowed, false);
  const removed = await f.call(route, f.admin, {
    requestId: randomUUID(),
    expectedRevision: (await schedule()).revision,
    appointmentId: null,
    expectedAppointmentRevision: null,
    reason: 'Synthetic private unlink',
    removeConfirmed: true,
  });
  assert.equal(removed.status, 200);
  const current = await p.context();
  assert.deepEqual(current.procedure.effectiveAppointmentId, null);
  assert.deepEqual(current.procedure.scheduledAppointment, null);
  assert.equal(current.allowed, true);
  assert.notEqual(current.revision, original.expectedRevision);
  assert.ok(!JSON.stringify(current).includes('Synthetic private'));
  refused(await f.call(p.path, f.doctor, original), f.doctor, original);
  assert.equal((await f.call(p.path, f.doctor, await p.command())).status, 201);
});

test('visit changes and the clinic-time start boundary are checked at submission, and the outcome remains bound to the original request', async (t) => {
  const f = await fixture(t),
    a = visit(f.db, 1),
    p = await f.create(a.id);
  await p.decide();
  const startsAt = Date.parse(a.date + 'T' + a.time + ':00+05:30');
  let clock = startsAt - 1;
  t.mock.method(Date, 'now', () => clock);
  const before = await p.context(),
    tooEarly = await p.command();
  assert.match(before.blockedReason!, /future/);
  const refusal = await f.call(p.path, f.doctor, tooEarly);
  refused(refusal, f.doctor, tooEarly);
  clock = startsAt;
  const started = await p.context(),
    previous = await p.command();
  assert.equal(started.allowed, true);
  assert.notEqual(started.revision, before.revision);
  assert.deepEqual((await f.call(p.path, f.doctor, tooEarly)).data, refusal.data);
  const other = openDatabase(f.databasePath);
  t.after(() => other.close());
  const changed: Appointment = {
    ...a,
    mode: 'online',
    durationPolicy: 'custom',
    durationMinutes: 45,
  };
  const staleVisit = await beforeTransaction(
    f.db,
    'BEGIN IMMEDIATE',
    () => changeVisit(other, a, changed),
    () => f.call(p.path, f.doctor, previous),
  );
  refused(staleVisit, f.doctor, previous);
  assert.notEqual((await p.context()).revision, started.revision);
  for (const status of ['cancelled', 'no-show'] as const) {
    const c = await beforeTransaction(
      f.db,
      'BEGIN IMMEDIATE',
      () => changeVisit(other, changed, { status }),
      () => p.context(),
    );
    const cmd = await p.command();
    assert.match(c.blockedReason!, /cancelled or marked as a no-show/);
    refused(await f.call(p.path, f.doctor, cmd), f.doctor, cmd);
  }
  changeVisit(f.db, changed, { patientId: 'patient-2', reason: 'Cross-patient private text' });
  const wrongPatient = await p.context();
  assert.equal(wrongPatient.procedure.scheduledAppointment, null);
  assert.match(wrongPatient.blockedReason!, /missing/);
  assert.ok(!JSON.stringify(wrongPatient).includes('Cross-patient'));
  // An older database can retain a link to a visit that is no longer available.
  f.db.exec('PRAGMA foreign_keys=OFF');
  f.db.prepare('DELETE FROM appointments WHERE id=?').run(a.id);
  f.db.exec('PRAGMA foreign_keys=ON');
  const missing = await p.command();
  refused(await f.call(p.path, f.doctor, missing), f.doctor, missing);
  assert.equal(effects(f.db).completions, 0);
});

test('parallel exact retries record once, competing clinicians receive separate results and both outcomes survive reopening', async (t) => {
  const f = await fixture(t),
    p = await f.create();
  await p.decide();
  const cmd = await p.command(),
    twins = await simultaneousCareRequests(f, p.path, f.doctor, cmd);
  assert.deepEqual(twins.map((r) => r.status).sort(), [200, 201]);
  assert.deepEqual(twins[0].data, twins[1].data);
  const other = await f.create();
  await other.decide();
  const pair = [
    { who: f.doctor, cmd: await other.command() },
    {
      who: f.admin,
      cmd: { ...(await other.command(f.admin)), outcome: 'Second clinician outcome' },
    },
  ];
  const competing = await simultaneousCareRequests(f, other.path, pair[0].who, pair[0].cmd, {
    who: pair[1].who,
    body: pair[1].cmd,
  });
  assert.deepEqual(competing.map((r) => r.status).sort(), [201, 409]);
  const winner = competing.findIndex((r) => r.status === 201);
  refused(competing[1 - winner], pair[1 - winner].who, pair[1 - winner].cmd);
  assert.equal((await other.context()).procedure.completion?.outcome, pair[winner].cmd.outcome);
  assert.throws(() => f.db.exec('DELETE FROM procedureCompletionCommands'), /append-only/);
  assert.throws(
    () => f.db.exec('UPDATE procedureCompletionCommands SET rowid=rowid'),
    /append-only/,
  );
  const effectsBefore = effects(f.db);
  assert.deepEqual(effectsBefore, { completions: 2, commands: 3, notices: 2, audits: 2 });
  await f.close();
  const reopened = await careApiFixture(t, f.databasePath);
  assert.deepEqual((await reopened.call(p.path, f.doctor, cmd)).data, twins[0].data);
  for (const [i, x] of pair.entries()) {
    const replay = await reopened.call(other.path, x.who, x.cmd);
    assert.equal(replay.status, i === winner ? 200 : 409);
    assert.deepEqual(replay.data, competing[i].data);
  }
  assert.deepEqual(effects(reopened.db), effectsBefore);
});

test('only the current clinical account and profile can read or recover the exact authorized command under the lock', async (t) => {
  const f = await fixture(t),
    p = await f.create(),
    other = openDatabase(f.databasePath);
  t.after(() => other.close());
  await p.decide();
  const cmd = await p.command(),
    saved = await f.call(p.path, f.doctor, cmd);
  assert.equal(saved.status, 201);
  const denied = { ...cmd, requestId: randomUUID() };
  refused(await f.call(p.path, f.doctor, denied), f.doctor, denied);
  const effectsBefore = effects(f.db);
  for (const who of [f.patient, await f.login('reception')]) {
    unmarked(await f.call(p.contextPath, who), 403);
    unmarked(await f.call(p.path, who, cmd), 403);
  }
  unmarked(await f.call(p.path, f.admin, cmd), 403);
  unmarked(
    await f.call(p.path, f.admin, { ...cmd, doctorId: 'doctor-arjun', recordedByRole: 'admin' }),
    409,
  );
  unmarked(await f.call(p.path, f.doctor, { ...cmd, expectedRevision: 'f'.repeat(64) }), 409);
  unmarked(await f.call(p.path, f.doctor, { ...cmd, patientId: 'patient-2' }), 409);
  unmarked(await f.call(p.path, f.doctor, { ...cmd, procedureId: randomUUID() }), 409);
  unmarked(await f.call(p.path + '?revision=x', f.doctor, cmd), 400);
  unmarked(await f.call(p.contextPath + '?patientId=x', f.doctor), 400);
  for (const patch of [
    { aftercare: '   ' },
    { outcome: 'a'.repeat(8001) },
    { reviewedConfirmed: false },
    { additional: 1 },
    { expectedDecisionId: null },
    { expectedRevision: 'not-a-revision' },
  ])
    unmarked(await f.call(p.path, f.doctor, { ...cmd, ...patch }), 400);
  const original = f.doctor.user,
    reset = () => changeUser(other, original, {});
  const token = other.prepare('SELECT expiresAt FROM sessions WHERE userId=?').get(original.id)!;
  const suspended = () => changeUser(other, original, { active: false });
  const cases: [number, () => unknown, () => unknown][] = [
    [401, suspended, reset],
    [403, () => changeUser(other, original, { mustChangePassword: true }), reset],
    [403, () => changeUser(other, original, { role: 'patient' }), reset],
    [400, () => changeUser(other, original, { doctorId: 'missing-clinician' }), reset],
    [
      401,
      () => other.prepare('UPDATE sessions SET expiresAt=0 WHERE userId=?').run(original.id),
      () =>
        other
          .prepare('UPDATE sessions SET expiresAt=? WHERE userId=?')
          .run(token.expiresAt, original.id),
    ],
  ];
  for (const [route, body] of [
    [p.contextPath, undefined],
    [p.path, cmd],
    [p.path, denied],
    [p.path, { ...cmd, requestId: randomUUID() }],
    [p.base + '/complete', narrative],
  ] as const) {
    for (const [status, change, restore] of cases) {
      const result = await beforeTransaction(f.db, 'BEGIN IMMEDIATE', change, () =>
        f.call(route, f.doctor, body),
      );
      restore();
      unmarked(result, status);
    }
  }
  for (const patch of [{ doctorId: 'doctor-arjun' }, { role: 'admin' as const }]) {
    for (const input of [cmd, denied]) {
      const result = await beforeTransaction(
        f.db,
        'BEGIN IMMEDIATE',
        () => changeUser(other, original, patch),
        () => f.call(p.path, f.doctor, input),
      );
      reset();
      unmarked(result, 403);
    }
  }
  assert.deepEqual(effects(f.db), effectsBefore);
});

test('compatibility completions preserve old response and historical records without inventing a linked visit or receipt', async (t) => {
  const f = await fixture(t),
    p = await f.create();
  await p.decide();
  const cmd = await p.command();
  const old = await f.call(p.base + '/complete?ignored=1', f.doctor, {
    ...narrative,
    ignored: true,
  });
  assert.equal(old.status, 200);
  assert.deepEqual(old.data, {
    ...p.plan,
    agreements: old.data.agreements,
    status: 'completed',
    completion: old.data.completion,
  });
  assert.equal(old.data.completion.appointment, null);
  assert.ok(!Object.hasOwn(old.data, 'receipt'));
  const denial = await f.call(p.path, f.doctor, cmd);
  refused(denial, f.doctor, cmd);
  assert.deepEqual(denial.data.observed, {
    decisionId: cmd.expectedDecisionId,
    status: 'completed',
  });
  const older = await f.create();
  const historic = {
    ...narrative,
    doctorId: 'doctor-meera',
    doctorName: 'Original doctor',
    completedAt: '2020-01-01T00:00:00.000Z',
  };
  f.db
    .prepare('INSERT INTO procedureCompletions(id,data) VALUES(?,?)')
    .run(older.plan.id, JSON.stringify(historic));
  assert.deepEqual((await older.context()).procedure.completion, historic);
  const refusedCurrent = { ...cmd, requestId: randomUUID(), procedureId: older.plan.id };
  refused(await f.call(older.path, f.doctor, refusedCurrent), f.doctor, refusedCurrent);
  const cancelled = await f.create();
  await cancelled.decide();
  const pending = await cancelled.command();
  assert.equal(
    (await f.call(cancelled.base + '/cancel', f.doctor, { reason: 'Cancelled by clinician' }))
      .status,
    200,
  );
  refused(await f.call(cancelled.path, f.doctor, pending), f.doctor, pending);
  assert.equal((await cancelled.context()).procedure.completion, null);
});

test('failed writes roll back the completion, audit, patient notice and command, including failure to store a refusal', async (t) => {
  const f = await fixture(t),
    p = await f.create();
  await p.decide();
  const cmd = await p.command();
  const failStep = async (table: string, path: string, body: unknown) => {
    const baseline = effects(f.db);
    f.db.exec(
      `CREATE TRIGGER synthetic_failure BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'Synthetic completion storage failure'); END`,
    );
    try {
      unmarked(await f.call(path, f.doctor, body), 500);
    } finally {
      f.db.exec('DROP TRIGGER synthetic_failure');
    }
    assert.deepEqual(effects(f.db), baseline);
  };
  for (const [path, body] of [
    [p.path, cmd],
    [p.base + '/complete', narrative],
  ] as const)
    for (const table of [
      'procedureCompletions',
      'audit',
      'activity',
      ...(path === p.path ? ['procedureCompletionCommands'] : []),
    ])
      await failStep(table, path, body);
  const stale = { ...cmd, expectedRevision: 'a'.repeat(64) };
  await failStep('procedureCompletionCommands', p.path, stale);
  refused(await f.call(p.path, f.doctor, stale), f.doctor, stale);
  assert.equal((await f.call(p.path, f.doctor, { ...cmd, requestId: randomUUID() })).status, 201);
  assert.deepEqual(effects(f.db), { completions: 1, commands: 2, notices: 1, audits: 1 });
});
