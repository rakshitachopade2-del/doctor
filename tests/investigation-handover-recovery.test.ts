import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  careApiFixture,
  changeUser,
  beforeTransaction,
  simultaneousCareRequests,
} from './fixtures/care-api.ts';
import { createUser, openDatabase } from '../server/db.ts';
import type {
  InvestigationHandoverCommand,
  InvestigationReviewContext,
} from '../shared/investigation-worklist.ts';

const reason = 'Private synthetic handover.';
async function fixture(t: TestContext) {
  const f = await careApiFixture(t),
    admin = await f.login('admin'),
    doctor = await f.login('doctor'),
    patient = await f.login('patient');
  const recipient = {
    ...doctor.user,
    id: 'handover-recipient',
    name: 'Synthetic recipient',
    email: 'handover-recipient@example.test',
    doctorId: 'doctor-arjun',
  };
  createUser(f.db, recipient, 'Synthetic testing phrase!');
  const patientId = patient.user.patientId!;
  const order = await f.call('/investigations', doctor, {
    patientId,
    title: 'Synthetic handover',
    kind: 'other',
    reason: 'Synthetic',
    instructions: 'Synthetic',
  });
  assert.equal(order.status, 201);
  const investigationId = order.data.id,
    base = '/investigations/' + investigationId,
    path = base + '/assignment';
  const context = () =>
    f.call(base + '/review-context', admin).then((r) => r.data as InvestigationReviewContext);
  const command = async (
    patch: Partial<InvestigationHandoverCommand> = {},
  ): Promise<InvestigationHandoverCommand> => ({
    requestId: randomUUID(),
    expectedRevision: (await context()).revision,
    doctorId: recipient.doctorId,
    reason,
    recoverable: true,
    ...patch,
  });
  return {
    ...f,
    admin,
    doctor,
    patient,
    recipient,
    patientId,
    investigationId,
    base,
    path,
    context,
    command,
  };
}
type DB = Awaited<ReturnType<typeof fixture>>['db'];
function counts(db: DB) {
  return [
    'SELECT count(*) n FROM investigationAssignments',
    "SELECT count(*) n FROM investigationCommands WHERE operation='assignment'",
    "SELECT count(*) n FROM audit WHERE json_extract(data,'$.action')='assigned investigation responsibility'",
    "SELECT count(*) n FROM activity WHERE eventKey LIKE 'investigation-assignment:%'",
  ].map((sql) => Number(db.prepare(sql).get()!.n));
}
function plain(r: { status: number; data: unknown }, status: number) {
  assert.equal(r.status, status);
  assert.deepEqual(Object.keys(r.data as object), ['error']);
}

test('an original owner recovers the historical private handover after later ownership, profile changes and restart while tied active clinicians each receive one notice', async (t) => {
  const f = await fixture(t);
  const twin = { ...f.recipient, id: 'handover-colleague', email: 'colleague@example.test' };
  createUser(f.db, twin, 'Synthetic testing phrase!');
  const cmd = await f.command();
  const first = await f.call(f.path, f.doctor, cmd);
  assert.equal(first.status, 201);
  const event = first.data.assignments[0];
  assert.deepEqual(first.data.receipt, {
    requestId: cmd.requestId,
    actorId: f.doctor.user.id,
    investigationId: f.investigationId,
    expectedRevision: cmd.expectedRevision,
    assignment: event,
  });
  assert.equal(event.previousDoctorId, f.doctor.user.doctorId);
  assert.equal(event.doctorId, f.recipient.doctorId);
  assert.equal(event.assignedById, f.doctor.user.id);
  assert.equal(event.reason, reason);
  assert.deepEqual(counts(f.db), [1, 1, 1, 2]);
  plain(await f.call(f.path, f.doctor, await f.command({ doctorId: 'doctor-meera' })), 403);
  const returnCmd = await f.command({
    doctorId: 'doctor-meera',
    reason: 'Separate private return.',
  });
  const back = await f.call(f.path, f.admin, returnCmd);
  assert.equal(back.status, 201);
  f.db
    .prepare("UPDATE doctors SET data=json_set(data,'$.name','Renamed clinician') WHERE id=?")
    .run(f.recipient.doctorId);
  changeUser(f.db, f.doctor.user, { name: 'Renamed author' });
  const before = counts(f.db);
  await f.close();
  const reopened = await careApiFixture(t, f.databasePath),
    r = await reopened.call(f.path, f.doctor, cmd);
  assert.equal(r.status, 200);
  assert.equal(r.data.ownerDoctorId, 'doctor-meera');
  assert.equal(r.data.assignments.length, 2);
  assert.deepEqual(r.data.receipt, first.data.receipt);
  assert.deepEqual(counts(reopened.db), before);
  for (const path of [
    '/patients/' + f.patientId + '/clinical-workflows',
    '/patients/' + f.patientId + '/care-summary',
    '/activity',
  ]) {
    const view = await reopened.call(path, f.patient);
    assert.equal(view.status, 200);
    for (const hidden of [cmd.requestId, reason, event.id])
      assert.ok(!JSON.stringify(view.data).includes(hidden));
  }
  plain(await reopened.call(f.path, f.patient, cmd), 403);
});

test('a recoverable refusal stays final after a destination becomes eligible and a request ID cannot cross legacy handovers or clinical reviews', async (t) => {
  const f = await fixture(t);
  const result = await f.call(f.base + '/results', f.patient, {
    note: 'Synthetic attached result',
  });
  const resultId = result.data.results[0].id;
  const cmd = await f.command();
  const other = openDatabase(f.databasePath);
  t.after(() => other.close());
  const declined = await beforeTransaction(
    f.db,
    'BEGIN IMMEDIATE',
    () => changeUser(other, f.recipient, { active: false }),
    () => f.call(f.path, f.doctor, cmd),
  );
  assert.equal(declined.status, 400);
  assert.deepEqual(declined.data, {
    code: 'INVESTIGATION_HANDOVER_NOT_RECORDED',
    actorId: f.doctor.user.id,
    investigationId: f.investigationId,
    command: cmd,
    message: 'Choose a clinician with an active linked account.',
  });
  changeUser(f.db, f.recipient, {});
  assert.deepEqual((await f.call(f.path, f.doctor, cmd)).data, declined.data);
  const legacy = { ...cmd, recoverable: undefined };
  plain(await f.call(f.path, f.doctor, legacy), 409);
  plain(await f.call(f.path, f.admin, cmd), 409);
  plain(await f.call(f.path, f.doctor, { ...cmd, reason: 'Different' }), 409);
  const review = {
    requestId: cmd.requestId,
    expectedRevision: cmd.expectedRevision,
    doctorId: f.doctor.user.doctorId,
    patientId: f.patientId,
    investigationId: f.investigationId,
    reviewedByRole: 'doctor',
    resultId,
    summary: 'Synthetic findings',
    followUp: 'Synthetic follow up',
    publishToPatient: false,
  };
  plain(await f.call(f.base + '/reviews', f.doctor, review), 409);
  const staleReview = { ...review, requestId: randomUUID(), expectedRevision: '0'.repeat(64) };
  assert.equal(
    (await f.call(f.base + '/reviews', f.doctor, staleReview)).data.code,
    'INVESTIGATION_REVIEW_NOT_RECORDED',
  );
  plain(await f.call(f.path, f.doctor, { ...cmd, requestId: staleReview.requestId }), 409);
  const acceptedReview = { ...review, requestId: randomUUID() };
  assert.equal((await f.call(f.base + '/reviews', f.doctor, acceptedReview)).status, 201);
  plain(await f.call(f.path, f.doctor, { ...cmd, requestId: acceptedReview.requestId }), 409);
  for (const patch of [{ expectedRevision: cmd.expectedRevision }, { doctorId: 'doctor-meera' }]) {
    const proposal = await f.command(patch);
    const denied = await f.call(f.path, f.doctor, proposal);
    assert.equal(denied.status, 409);
    assert.equal(denied.data.code, 'INVESTIGATION_HANDOVER_NOT_RECORDED');
    assert.deepEqual(denied.data.command, proposal);
  }
  assert.deepEqual(counts(f.db), [0, 0, 0, 0]);
  const again = await f.call(f.path, f.doctor, await f.command());
  assert.equal(again.status, 201);
  await f.close();
  const reopened = await careApiFixture(t, f.databasePath);
  assert.deepEqual((await reopened.call(f.path, f.doctor, cmd)).data, declined.data);
  assert.throws(
    () =>
      reopened.db
        .prepare('UPDATE investigationHandoverRefusals SET message=? WHERE requestId=?')
        .run('changed', cmd.requestId),
    /immutable/,
  );
});
test('worklist reads, destinations and new and recovered handovers use the current account and clinician under the transaction lock', async (t) => {
  const f = await fixture(t),
    other = openDatabase(f.databasePath);
  t.after(() => other.close());
  const denied = await f.command({ doctorId: 'missing' });
  assert.equal((await f.call(f.path, f.doctor, denied)).status, 400);
  const saved = await f.command();
  assert.equal((await f.call(f.path, f.doctor, saved)).status, 201);
  const original = f.doctor.user,
    newCmd = await f.command({ doctorId: 'doctor-meera' }),
    baseline = counts(f.db);
  for (const request of [
    () => f.call('/investigation-owners', f.doctor),
    () => f.call('/investigation-worklist?scope=all', f.doctor),
    () => f.call(f.base + '/review-context', f.doctor),
    () => f.call(f.path, f.doctor, saved),
    () => f.call(f.path, f.doctor, denied),
    () => f.call(f.path, f.doctor, newCmd),
  ]) {
    for (const [patch, status] of [
      [{ active: false }, 401],
      [{ role: 'receptionist' as const }, 403],
      [{ mustChangePassword: true }, 403],
    ] as const) {
      const r = await beforeTransaction(
        f.db,
        'BEGIN IMMEDIATE',
        () => changeUser(other, original, patch),
        request,
      );
      plain(r, status);
      changeUser(other, original, {});
    }
  }
  for (const command of [saved, denied]) {
    plain(
      await beforeTransaction(
        f.db,
        'BEGIN IMMEDIATE',
        () => changeUser(other, original, { doctorId: f.recipient.doctorId }),
        () => f.call(f.path, f.doctor, command),
      ),
      409,
    );
    changeUser(other, original, {});
  }
  plain(await f.call(f.path, f.doctor, newCmd), 403);
  changeUser(other, f.admin.user, { doctorId: undefined });
  assert.equal((await f.call('/investigation-owners', f.admin)).status, 200);
  assert.deepEqual(counts(f.db), baseline);
  assert.equal((await f.call(f.path, f.admin, newCmd)).status, 201);
});
test('independent simultaneous handovers publish one historical event per winning request and retain the losing administrator proposal', async (t) => {
  const f = await fixture(t),
    command = await f.command();
  const exact = await simultaneousCareRequests(f, f.path, f.doctor, command);
  assert.deepEqual(exact.map((r) => r.status).sort(), [200, 201]);
  assert.deepEqual(exact[0].data.receipt, exact[1].data.receipt);
  assert.deepEqual(counts(f.db), [1, 1, 1, 1]);
  const back = await f.command({ doctorId: 'doctor-meera' }),
    other = { ...back, reason: 'Different private instructions', requestId: randomUUID() };
  const race = await simultaneousCareRequests(f, f.path, f.admin, back, {
    who: f.admin,
    body: other,
  });
  assert.deepEqual(race.map((r) => r.status).sort(), [201, 409]);
  const loser = race.find((r) => r.status === 409)!.data;
  assert.equal(loser.code, 'INVESTIGATION_HANDOVER_NOT_RECORDED');
  assert.deepEqual((await f.call(f.path, f.admin, loser.command)).data, loser);
  assert.equal((await f.context()).ownerDoctorId, 'doctor-meera');
  assert.deepEqual(counts(f.db), [2, 2, 2, 2]);
});
test('silently skipped handover event, evidence, audit, recipient notice or refusal rolls back the entire operation', async (t) => {
  const f = await fixture(t);
  for (const recoverable of [true, undefined]) {
    const cmd = { ...(await f.command()), recoverable };
    for (const table of [
      'investigationAssignments',
      'investigationCommands',
      'audit',
      'activity',
    ]) {
      const before = counts(f.db);
      f.db.exec(
        'CREATE TRIGGER synthetic_ignore BEFORE INSERT ON ' +
          table +
          ' BEGIN SELECT RAISE(IGNORE); END;',
      );
      assert.equal((await f.call(f.path, f.doctor, cmd)).status, 500, table);
      f.db.exec('DROP TRIGGER synthetic_ignore');
      assert.deepEqual(counts(f.db), before);
    }
  }
  f.db.exec(
    'CREATE TRIGGER ignored_read_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(IGNORE); END;',
  );
  plain(await f.call('/investigation-worklist?scope=all', f.admin), 500);
  plain(await f.call(f.base + '/review-context', f.admin), 500);
  f.db.exec('DROP TRIGGER ignored_read_audit');

  const refused = await f.command({ doctorId: 'missing' });
  f.db.exec(
    'CREATE TRIGGER synthetic_refusal BEFORE INSERT ON investigationHandoverRefusals BEGIN SELECT RAISE(IGNORE); END;',
  );
  assert.equal((await f.call(f.path, f.doctor, refused)).status, 500);
  f.db.exec('DROP TRIGGER synthetic_refusal');
  assert.equal((await f.call(f.path, f.doctor, refused)).status, 400);
  assert.deepEqual(counts(f.db), [0, 0, 0, 0]);
  assert.equal((await f.call(f.path, f.doctor, await f.command())).status, 201);
});
