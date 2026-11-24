import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { addDays, clinicToday, get, openDatabase, type DB } from '../server/db.ts';
import type { ProcedureRecord } from '../shared/clinical.ts';
import type {
  ProcedureCancellationCommand,
  ProcedureCancellationContext,
} from '../shared/procedure-cancellation.ts';
import type { Appointment } from '../shared/types.ts';
import {
  beforeTransaction,
  careApiFixture,
  changeUser,
  simultaneousCareRequests,
  type Client,
} from './fixtures/care-api.ts';

const patientId = 'patient-ananya',
  reason = 'The patient and clinic agreed to close this plan.';
function futureVisit(db: DB): Appointment {
  const visit: Appointment = {
    id: randomUUID(),
    patientId,
    doctorId: 'doctor-meera',
    date: addDays(clinicToday(), 12),
    time: '08:05',
    status: 'scheduled',
    mode: 'in-person',
    patientName: 'Synthetic patient',
    doctorName: 'Dr. Meera Shah',
    reason: 'Private visit details',
    fee: 800,
    createdAt: new Date().toISOString(),
  };
  db.prepare(
    'INSERT INTO appointments(id,patientId,doctorId,date,time,status,data) VALUES (?,?,?,?,?,?,?)',
  ).run(
    visit.id,
    patientId,
    visit.doctorId,
    visit.date,
    visit.time,
    visit.status,
    JSON.stringify(visit),
  );
  return visit;
}
function visitStatus(db: DB, visit: Appointment, status: Appointment['status']) {
  db.prepare('UPDATE appointments SET status=?,data=? WHERE id=?').run(
    status,
    JSON.stringify({ ...visit, status }),
    visit.id,
  );
}
async function fixture(t: TestContext) {
  const f = await careApiFixture(t),
    doctor = await f.login('doctor'),
    admin = await f.login('admin'),
    patient = await f.login('patient');
  changeUser(f.db, admin.user, { doctorId: 'doctor-arjun' });
  const create = async (appointmentId: string | null = null, chart = patientId) => {
    const made = await f.call('/procedures', doctor, {
      patientId: chart,
      appointmentId,
      title: 'Synthetic plan',
      indication: 'Discussion',
      benefits: 'Benefits',
      risks: 'Risks',
      alternatives: 'Alternatives',
      aftercare: 'Aftercare',
      estimatedCost: 'Synthetic estimate',
    });
    assert.equal(made.status, 201, JSON.stringify(made.data));
    const plan: ProcedureRecord = made.data,
      base = '/procedures/' + plan.id,
      contextPath = base + '/cancellation-context',
      path = base + '/cancellation',
      legacy = base + '/cancel';
    const context = async (who = doctor): Promise<ProcedureCancellationContext> => {
      const res = await f.call(contextPath, who);
      assert.equal(res.status, 200, JSON.stringify(res.data));
      return res.data;
    };
    const command = async (who = doctor): Promise<ProcedureCancellationCommand> => {
      const c = await context(who);
      return {
        requestId: randomUUID(),
        patientId: chart,
        procedureId: plan.id,
        doctorId: c.doctorId,
        cancelledByRole: who.user.role as 'doctor' | 'admin',
        expectedRevision: c.revision,
        expectedDecisionId: c.procedure.agreements.at(-1)?.id ?? null,
        reason,
        reviewedConfirmed: true,
      };
    };
    const decide = async (decision: 'agreed' | 'declined') => {
      const res = await f.call(base + '/agreements', patient, { method: 'portal', decision });
      assert.equal(res.status, 201);
      return (res.data as ProcedureRecord).agreements.at(-1)!;
    };
    return { plan, base, path, contextPath, legacy, context, command, decide };
  };
  return { ...f, doctor, admin, patient, create };
}
function effects(db: DB) {
  const count = (sql: string) => Number(db.prepare(sql).get()!.n);
  return {
    cancellations: count('SELECT COUNT(*) n FROM procedureCancellations'),
    commands: count('SELECT COUNT(*) n FROM procedureCancellationCommands'),
    audits: count(
      "SELECT COUNT(*) n FROM audit WHERE json_extract(data,'$.action')='cancelled procedure'",
    ),
    notices: count("SELECT COUNT(*) n FROM activity WHERE eventKey LIKE 'procedure-cancelled:%'"),
  };
}
type Reply = { status: number; data: Record<string, unknown> };
function unmarked(reply: Reply, status: number) {
  assert.equal(reply.status, status, JSON.stringify(reply.data));
  assert.deepEqual(Object.keys(reply.data), ['error']);
}
function refused(reply: Reply, who: Client, cmd: ProcedureCancellationCommand) {
  assert.equal(reply.status, 409, JSON.stringify(reply.data));
  assert.equal(typeof reply.data.message, 'string');
  assert.deepEqual(reply.data, {
    code: 'PROCEDURE_NOT_CANCELLED',
    actorId: who.user.id,
    command: cmd,
    message: reply.data.message,
  });
}

test('cancellation recovers the original clinician, reason and visit after restart while preserving decisions, patient notice and the paid invoice', async (t) => {
  const f = await fixture(t),
    visit = futureVisit(f.db),
    p = await f.create(visit.id),
    decision = await p.decide('agreed'),
    c = await p.context(f.admin),
    cmd = await p.command(f.admin);
  assert.equal(c.allowed, true);
  assert.equal(c.blockedReason, null);
  assert.match(c.revision, /^[a-f0-9]{64}$/);
  const invoice = await f.call('/invoices', f.admin, {
    requestId: randomUUID(),
    patientId,
    procedureId: p.plan.id,
    items: [{ description: 'Synthetic service', quantity: 1, unitAmountPaise: 18000 }],
  });
  assert.equal(invoice.status, 201);
  const invoicePath = '/invoices/' + invoice.data.id;
  const payment = await f.call(invoicePath + '/payments', f.admin, {
    requestId: randomUUID(),
    method: 'cash',
    amountPaise: 18000,
  });
  assert.equal(payment.status, 201, JSON.stringify(payment.data));
  const beforeInvoice = await f.call(invoicePath, f.admin);
  assert.equal(beforeInvoice.status, 200);
  const saved = await f.call(p.path, f.admin, {
    ...cmd,
    reason: ' ' + reason + ' ',
    requestId: cmd.requestId.toUpperCase(),
  });
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  const cancelledAt = saved.data.receipt.cancelledAt;
  assert.equal(new Date(cancelledAt).toISOString(), cancelledAt);
  assert.deepEqual(saved.data, {
    receipt: {
      requestId: cmd.requestId,
      actorId: f.admin.user.id,
      patientId,
      procedureId: p.plan.id,
      doctorId: 'doctor-arjun',
      doctorName: c.doctorName,
      cancelledByRole: 'admin',
      expectedRevision: c.revision,
      expectedDecisionId: decision.id,
      reason,
      title: p.plan.title,
      appointment: c.procedure.scheduledAppointment,
      cancelledAt,
    },
  });
  const portal = (
    await f.call('/patients/' + patientId + '/clinical-workflows', f.patient)
  ).data.procedures.find((v: ProcedureRecord) => v.id === p.plan.id);
  assert.deepEqual(portal, { ...c.procedure, status: 'cancelled', cancellationReason: reason });
  const feed = (await f.call('/activity', f.patient)).data.items.filter(
    (item: { title: string }) => item.title === 'A procedure plan was cancelled',
  );
  assert.equal(feed.length, 1);
  assert.equal(feed[0].detail, p.plan.title);
  assert.equal(feed[0].href, '/my-care/record?tab=workflows');
  assert.ok(!JSON.stringify(feed).includes(reason));
  const summary = (await f.call('/patients/' + patientId + '/care-summary', f.patient)).data;
  for (const projected of [feed, portal, summary])
    for (const privateValue of [cmd.requestId, cmd.expectedRevision])
      assert.ok(!JSON.stringify(projected).includes(privateValue));
  assert.deepEqual(get(f.db, 'appointments', visit.id), visit);
  assert.deepEqual((await f.call(invoicePath, f.admin)).data, beforeInvoice.data);
  assert.equal(
    f.db.prepare('SELECT invoiceId FROM procedureInvoiceLinks WHERE procedureId=?').get(p.plan.id)!
      .invoiceId,
    invoice.data.id,
  );
  const denied = { ...cmd, requestId: randomUUID(), reason: 'Another reason' };
  const rejection = await f.call(p.path, f.admin, denied);
  refused(rejection, f.admin, denied);
  f.db
    .prepare("UPDATE doctors SET data=json_set(data,'$.name','Renamed clinician') WHERE id=?")
    .run(cmd.doctorId);
  visitStatus(f.db, visit, 'cancelled');
  assert.equal((await p.context(f.admin)).procedure.scheduledAppointment?.status, 'cancelled');
  assert.deepEqual(effects(f.db), { cancellations: 1, commands: 2, audits: 1, notices: 1 });
  await f.close();
  const reopened = await careApiFixture(t, f.databasePath);
  const replay = await reopened.call(p.path, f.admin, cmd);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data, saved.data);
  assert.deepEqual((await reopened.call(p.path, f.admin, denied)).data, rejection.data);
  assert.throws(
    () => reopened.db.exec('UPDATE procedureCancellationCommands SET rowid=rowid'),
    /immutable/,
  );
  assert.throws(() => reopened.db.exec('DELETE FROM procedureCancellationCommands'), /immutable/);
});

test('changed decisions and visit snapshots require fresh review; a plan with no agreement or a no-show visit is still cancellable', async (t) => {
  const f = await fixture(t),
    visit = futureVisit(f.db),
    p = await f.create(visit.id),
    beforeDecision = await p.command();
  assert.equal(beforeDecision.expectedDecisionId, null);
  await p.decide('agreed');
  const agreed = await p.command();
  const stale = await f.call(p.path, f.doctor, beforeDecision);
  refused(stale, f.doctor, beforeDecision);
  await p.decide('declined');
  const later = await p.command();
  refused(await f.call(p.path, f.doctor, agreed), f.doctor, agreed);
  visitStatus(f.db, visit, 'no-show');
  refused(await f.call(p.path, f.doctor, later), f.doctor, later);
  const current = await p.command();
  assert.notEqual(current.expectedRevision, later.expectedRevision);
  const wrongDecision = { ...current, expectedDecisionId: agreed.expectedDecisionId };
  refused(await f.call(p.path, f.doctor, wrongDecision), f.doctor, wrongDecision);
  const saved = await f.call(p.path, f.doctor, { ...current, requestId: randomUUID() });
  assert.equal(saved.status, 201);
  assert.equal(saved.data.receipt.appointment.status, 'no-show');
  assert.deepEqual((await f.call(p.path, f.doctor, beforeDecision)).data, stale.data);
  const unlinked = await f.create(),
    without = await unlinked.command();
  assert.equal(without.expectedDecisionId, null);
  const fresh = await f.call(unlinked.path, f.doctor, without);
  assert.equal(fresh.status, 201);
  assert.equal(fresh.data.receipt.appointment, null);
});

test('attaching and removing the same visit invalidates an earlier review even when the current visit appears unchanged', async (t) => {
  const f = await fixture(t),
    p = await f.create(),
    visit = futureVisit(f.db),
    original = await p.command(),
    route = p.base + '/scheduling';
  const current = async () => (await f.call(route, f.admin)).data.revision;
  const choices = await f.call(
    route + '/candidates?from=' + visit.date + '&to=' + visit.date,
    f.admin,
  );
  assert.equal(choices.status, 200);
  const target = choices.data.items.find(
    (row: { appointment: Appointment }) => row.appointment.id === visit.id,
  );
  assert.ok(target);
  const linked = await f.call(route, f.admin, {
    requestId: randomUUID(),
    expectedRevision: await current(),
    appointmentId: visit.id,
    expectedAppointmentRevision: target.revision,
    reason: 'Private attach reason',
  });
  assert.equal(linked.status, 200);
  const unlinked = await f.call(route, f.admin, {
    requestId: randomUUID(),
    expectedRevision: await current(),
    appointmentId: null,
    expectedAppointmentRevision: null,
    reason: 'Private removal reason',
    removeConfirmed: true,
  });
  assert.equal(unlinked.status, 200);
  const c = await p.context();
  assert.equal(c.procedure.scheduledAppointment, null);
  assert.notEqual(c.revision, original.expectedRevision);
  assert.ok(!JSON.stringify(c).includes('Private removal reason'));
  refused(await f.call(p.path, f.doctor, original), f.doctor, original);
  assert.equal((await f.call(p.path, f.doctor, await p.command())).status, 201);
  assert.deepEqual(get(f.db, 'appointments', visit.id), visit);
});

test('exact concurrent cancellation records one outcome; different clinicians and competing patient decisions or completion settle only once', async (t) => {
  const f = await fixture(t),
    p = await f.create(),
    cmd = await p.command();
  const twins = await simultaneousCareRequests(f, p.path, f.doctor, cmd);
  assert.deepEqual(twins.map((r) => r.status).sort(), [200, 201]);
  assert.deepEqual(twins[0].data, twins[1].data);
  const second = await f.create(),
    first = await second.command(),
    other = { ...(await second.command(f.admin)), reason: 'Separate clinician reason' };
  const competing = await simultaneousCareRequests(f, second.path, f.doctor, first, {
    who: f.admin,
    body: other,
  });
  assert.deepEqual(competing.map((r) => r.status).sort(), [201, 409]);
  const winner = competing[0].status === 201 ? first : other;
  assert.equal((await second.context()).procedure.cancellationReason, winner.reason);
  const third = await f.create(),
    unchanged = await third.command();
  const [cancel, decision] = await simultaneousCareRequests(f, third.path, f.doctor, unchanged, {
    who: f.patient,
    route: third.base + '/agreements',
    body: { decision: 'agreed', method: 'portal' },
  });
  assert.deepEqual([cancel.status, decision.status].sort(), [201, 409]);
  const current = (await third.context()).procedure;
  assert.equal(current.status, cancel.status === 201 ? 'cancelled' : 'planned');
  assert.equal(current.agreements.length, decision.status === 201 ? 1 : 0);
  const fourth = await f.create();
  await fourth.decide('agreed');
  const checked = await fourth.command();
  const [closure, completed] = await simultaneousCareRequests(f, fourth.path, f.doctor, checked, {
    who: f.admin,
    route: fourth.base + '/complete',
    body: { outcome: 'Synthetic outcome', aftercare: 'Synthetic aftercare' },
  });
  assert.equal(closure.status === 201, completed.status === 409);
  assert.equal(closure.status === 409, completed.status === 200);
  const final = (await fourth.context()).procedure;
  assert.equal(final.status, closure.status === 201 ? 'cancelled' : 'completed');
  assert.equal(final.completion === null, closure.status === 201);
  const cancellations = 2 + Number(cancel.status === 201) + Number(closure.status === 201);
  assert.deepEqual(effects(f.db), {
    cancellations,
    commands: 5,
    audits: cancellations,
    notices: cancellations,
  });
});

test('reviewed commands validate the patient, procedure, reason, role, profile and issuing account; old cancellations retain their stored history', async (t) => {
  const f = await fixture(t),
    p = await f.create(),
    other = await f.create(null, 'patient-2'),
    cmd = await p.command();
  for (const field of Object.keys(cmd)) {
    const bad = { ...cmd };
    delete bad[field as keyof ProcedureCancellationCommand];
    unmarked(await f.call(p.path, f.doctor, bad), 400);
  }
  for (const patch of [
    { reason: '  ' },
    { reason: 'x'.repeat(8001) },
    { expectedDecisionId: '' },
    { expectedRevision: 'bad' },
    { requestId: 'bad' },
    { reviewedConfirmed: false },
    { cancelledByRole: 'receptionist' },
    { extra: true },
  ])
    unmarked(await f.call(p.path, f.doctor, { ...cmd, ...patch }), 400);
  for (const url of [p.contextPath + '?ignored=1', p.path + '?ignored=1'])
    unmarked(await f.call(url, f.doctor, url.startsWith(p.contextPath) ? undefined : cmd), 400);
  unmarked(await f.call('/procedures/missing/cancellation', f.doctor, cmd), 404);
  unmarked(await f.call(p.path, undefined, cmd), 401);
  unmarked(await f.call(p.path, { ...f.doctor, csrf: 'invalid' }, cmd), 403);
  for (const who of [f.patient, await f.login('reception')]) {
    unmarked(await f.call(p.contextPath, who), 403);
    unmarked(await f.call(p.path, who, cmd), 403);
    unmarked(await f.call(p.legacy, who, { reason }), 403);
  }
  unmarked(await f.call(p.path, f.doctor, { ...cmd, patientId: 'patient-2' }), 409);
  unmarked(await f.call(p.path, f.doctor, { ...cmd, procedureId: other.plan.id }), 409);
  unmarked(await f.call(p.path, f.admin, cmd), 403);
  assert.equal((await f.call(p.path, f.doctor, cmd)).status, 201);
  for (const patch of [
    { reason: 'Another reason' },
    { expectedDecisionId: randomUUID() },
    { expectedRevision: '0'.repeat(64) },
  ])
    unmarked(await f.call(p.path, f.doctor, { ...cmd, ...patch }), 409);
  unmarked(
    await f.call(p.path, f.admin, { ...cmd, cancelledByRole: 'admin', doctorId: 'doctor-arjun' }),
    409,
  );
  unmarked(
    await f.call(other.path, f.doctor, {
      ...cmd,
      patientId: 'patient-2',
      procedureId: other.plan.id,
    }),
    409,
  );
  const old = await f.create(null, 'patient-2');
  const historical = JSON.stringify({
    reason: 'Legacy reason',
    createdAt: '2023-02-09T09:30:00.000Z',
  });
  f.db
    .prepare('INSERT INTO procedureCancellations(id,data) VALUES (?,?)')
    .run(old.plan.id, historical);
  const newAttempt = await old.command();
  const denial = await f.call(old.path, f.doctor, newAttempt);
  refused(denial, f.doctor, newAttempt);
  assert.equal((await old.context()).procedure.cancellationReason, 'Legacy reason');
  assert.equal(
    f.db.prepare('SELECT data FROM procedureCancellations WHERE id=?').get(old.plan.id)!.data,
    historical,
  );
  const compat = await f.call(other.legacy + '?ignored=1', f.doctor, {
    reason: ' ' + reason + ' ',
    extra: 'ignored',
  });
  assert.equal(compat.status, 200);
  assert.deepEqual(compat.data, { ...other.plan, status: 'cancelled', cancellationReason: reason });
  unmarked(await f.call(other.legacy, f.doctor, { reason }), 409);
  assert.equal(effects(f.db).notices, 1);
});

test('current account, linked clinician, session and role are rechecked under lock on private reads, both writers and exact recovery', async (t) => {
  const f = await fixture(t),
    p = await f.create(),
    db = openDatabase(f.databasePath);
  t.after(() => db.close());
  const accepted = await p.command(),
    denied = { ...accepted, requestId: randomUUID() };
  assert.equal((await f.call(p.path, f.doctor, accepted)).status, 201);
  refused(await f.call(p.path, f.doctor, denied), f.doctor, denied);
  const before = effects(f.db);
  const original = f.doctor.user,
    reset = () => changeUser(db, original, {}),
    session = db.prepare('SELECT * FROM sessions WHERE userId=?').get(original.id)!;
  const cases: [number, () => unknown, () => unknown][] = [
    [401, () => changeUser(db, original, { active: false }), reset],
    [403, () => changeUser(db, original, { mustChangePassword: true }), reset],
    [403, () => changeUser(db, original, { role: 'receptionist' }), reset],
    [403, () => changeUser(db, original, { role: 'patient', patientId: 'patient-3' }), reset],
    [400, () => changeUser(db, original, { doctorId: 'missing-doctor' }), reset],
    [
      401,
      () => db.prepare('UPDATE sessions SET expiresAt=0 WHERE userId=?').run(original.id),
      () =>
        db
          .prepare('UPDATE sessions SET expiresAt=? WHERE userId=?')
          .run(session.expiresAt, original.id),
    ],
    [
      401,
      () => db.prepare("UPDATE sessions SET csrfToken='changed' WHERE userId=?").run(original.id),
      () =>
        db
          .prepare('UPDATE sessions SET csrfToken=? WHERE userId=?')
          .run(session.csrfToken, original.id),
    ],
    [
      401,
      () =>
        db
          .prepare('INSERT INTO mfaCredentials VALUES (?,?,?,?,?)')
          .run(original.id, randomUUID(), 'synthetic', '2031-01-01', 0),
      () => db.prepare('DELETE FROM mfaCredentials WHERE userId=?').run(original.id),
    ],
  ];
  for (const [path, body] of [
    [p.contextPath, undefined],
    [p.legacy, { reason }],
    [p.path, { ...accepted, requestId: randomUUID() }],
    [p.path, accepted],
    [p.path, denied],
  ] as const) {
    for (const [status, change, restore] of cases) {
      try {
        unmarked(
          await beforeTransaction(f.db, 'BEGIN IMMEDIATE', change, () =>
            f.call(path, f.doctor, body),
          ),
          status,
        );
      } finally {
        restore();
      }
    }
    if (path === p.path)
      for (const patch of [{ doctorId: 'doctor-arjun' }, { role: 'admin' as const }]) {
        try {
          unmarked(
            await beforeTransaction(
              f.db,
              'BEGIN IMMEDIATE',
              () => changeUser(db, original, patch),
              () => f.call(path, f.doctor, body),
            ),
            403,
          );
        } finally {
          reset();
        }
      }
  }
  assert.deepEqual(effects(f.db), before);
});

test('a failure or a skipped write rolls back the cancellation, notice, audit and reviewed outcome on each writer', async (t) => {
  const f = await fixture(t);
  for (const checked of [true, false]) {
    const p = await f.create(),
      cmd = await p.command(),
      path = checked ? p.path : p.legacy,
      before = effects(f.db);
    for (const table of [
      'procedureCancellations',
      'audit',
      'activity',
      ...(checked ? ['procedureCancellationCommands'] : []),
    ]) {
      for (const failure of ["RAISE(ABORT,'Synthetic cancellation failure')", 'RAISE(IGNORE)']) {
        f.db.exec(
          'CREATE TRIGGER fail_cancellation BEFORE INSERT ON ' +
            table +
            ' BEGIN SELECT ' +
            failure +
            '; END;',
        );
        try {
          unmarked(await f.call(path, f.doctor, cmd), 500);
        } finally {
          f.db.exec('DROP TRIGGER fail_cancellation');
        }
        assert.deepEqual(effects(f.db), before);
        assert.equal((await p.context()).procedure.status, 'planned');
      }
    }
    assert.equal((await f.call(path, f.doctor, cmd)).status, checked ? 201 : 200);
  }
  const p = await f.create(),
    cmd = { ...(await p.command()), expectedRevision: '0'.repeat(64) },
    before = effects(f.db);
  f.db.exec(
    'CREATE TRIGGER no_refusal BEFORE INSERT ON procedureCancellationCommands BEGIN SELECT RAISE(IGNORE); END;',
  );
  try {
    unmarked(await f.call(p.path, f.doctor, cmd), 500);
  } finally {
    f.db.exec('DROP TRIGGER no_refusal');
  }
  assert.deepEqual(effects(f.db), before);
  refused(await f.call(p.path, f.doctor, cmd), f.doctor, cmd);
});
