import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  careApiFixture,
  changeUser,
  simultaneousCareRequests,
  beforeTransaction,
} from './fixtures/care-api.ts';
import { openDatabase } from '../server/db.ts';
const fields = {
  patientId: 'patient-ananya',
  appointmentId: null,
  title: 'Synthetic procedure',
  indication: 'Synthetic indication',
  benefits: 'Synthetic benefits',
  risks: 'Synthetic risks',
  alternatives: 'Synthetic alternatives',
  aftercare: 'Synthetic aftercare',
  estimatedCost: 'Synthetic estimate',
};
const command = () => ({
  ...fields,
  requestId: randomUUID(),
  doctorId: 'doctor-meera',
  plannedByRole: 'doctor',
});
const countEffects = (db: Awaited<ReturnType<typeof careApiFixture>>['db']) =>
  [
    'SELECT count(*) n FROM procedures',
    "SELECT count(*) n FROM procedureCatalogueCommands WHERE operation='plan-created'",
    "SELECT count(*) n FROM activity WHERE eventKey LIKE 'procedure-planned:%'",
    "SELECT count(*) n FROM audit WHERE json_extract(data,'$.action')='planned procedure and documented discussion information'",
  ].map((q) => Number(db.prepare(q).get()!.n));

test('a scoped plan returns its original discussion, visit and clinician across a decision, cancellation, rename and restart; older clients can still read current state', async (t) => {
  const f = await careApiFixture(t),
    doctor = await f.login('doctor'),
    patient = await f.login('patient'),
    cmd = command();
  const created = await f.call('/procedures', doctor, cmd);
  assert.equal(created.status, 201);
  const original = created.data.procedure,
    id = original.id;
  assert.equal(original.status, 'planned');
  assert.deepEqual(original.agreements, []);
  assert.equal(original.doctorId, cmd.doctorId);
  assert.equal(created.data.receipt.plannedByRole, 'doctor');
  assert.equal(created.data.receipt.doctorId, cmd.doctorId);
  assert.equal(
    (
      await f.call('/procedures/' + id + '/agreements', patient, {
        decision: 'agreed',
        method: 'portal',
      })
    ).status,
    201,
  );
  assert.equal(
    (await f.call('/procedures/' + id + '/cancel', doctor, { reason: 'Patient-visible closure.' }))
      .status,
    200,
  );
  f.db
    .prepare("UPDATE doctors SET data=json_set(data,'$.name','Later clinician name') WHERE id=?")
    .run(cmd.doctorId);
  const live = (
    await f.call('/patients/' + fields.patientId + '/clinical-workflows', patient)
  ).data.procedures.find((p: { id: string }) => p.id === id);
  assert.equal(live.status, 'cancelled');
  assert.equal(live.agreements.length, 1);
  assert.equal(JSON.stringify(live).includes(cmd.requestId), false);
  await f.close();
  const reopened = await careApiFixture(t, f.databasePath);
  const replay = await reopened.call('/procedures', doctor, cmd);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data, created.data);
  const legacy = { ...fields, requestId: randomUUID() };
  const second = await reopened.call('/procedures', doctor, legacy);
  assert.equal(second.status, 201);
  await reopened.call('/procedures/' + second.data.procedure.id + '/cancel', doctor, {
    reason: 'Closed',
  });
  const previous = await reopened.call('/procedures', doctor, legacy);
  assert.equal(previous.status, 200);
  assert.equal(previous.data.procedure.status, 'cancelled');
  assert.deepEqual(previous.data.receipt, second.data.receipt);
});

test('bound plan creation and replay verify the latest issuing account profile and role inside the write lock', async (t) => {
  const f = await careApiFixture(t),
    doctor = await f.login('doctor'),
    other = openDatabase(f.databasePath);
  t.after(() => other.close());
  const saved = command();
  assert.equal((await f.call('/procedures', doctor, saved)).status, 201);
  const before = countEffects(f.db);
  for (const input of [command(), saved])
    for (const patch of [{ doctorId: 'doctor-arjun' }, { role: 'admin' as const }]) {
      const r = await beforeTransaction(
        f.db,
        'BEGIN IMMEDIATE',
        () => changeUser(other, doctor.user, patch),
        () => f.call('/procedures', doctor, input),
      );
      assert.equal(r.status, 403);
      assert.deepEqual(Object.keys(r.data), ['error']);
      changeUser(other, doctor.user, {});
    }
  for (const incomplete of [
    { ...command(), requestId: undefined },
    { ...command(), plannedByRole: undefined },
    { ...command(), doctorId: undefined },
  ])
    assert.equal((await f.call('/procedures', doctor, incomplete)).status, 400);
  const changed = await f.call('/procedures', doctor, { ...saved, risks: 'different' });
  assert.equal(changed.status, 409);
  assert.deepEqual(Object.keys(changed.data), ['error']);
  assert.deepEqual(countEffects(f.db), before);
});
test('an unavailable visit refusal survives the visit becoming eligible and independently delivered plans settle once', async (t) => {
  const f = await careApiFixture(t),
    doctor = await f.login('doctor');
  const visit = f.db
    .prepare('SELECT id,data FROM appointments WHERE patientId=? LIMIT 1')
    .get(fields.patientId)!;
  const original = JSON.parse(String(visit.data)),
    set = (status: string) =>
      f.db
        .prepare('UPDATE appointments SET data=?,status=? WHERE id=?')
        .run(JSON.stringify({ ...original, status }), status, visit.id);
  set('cancelled');
  const cmd = { ...command(), appointmentId: visit.id };
  const refusal = await f.call('/procedures', doctor, cmd);
  assert.equal(refusal.status, 409);
  assert.deepEqual(refusal.data.command, cmd);
  assert.equal(refusal.data.code, 'PROCEDURE_PLAN_NOT_SAVED');
  assert.equal(refusal.data.field, 'appointment');
  set('scheduled');
  assert.deepEqual((await f.call('/procedures', doctor, cmd)).data, refusal.data);
  const next = { ...cmd, requestId: randomUUID() };
  const pair = await simultaneousCareRequests(f, '/procedures', doctor, next);
  assert.deepEqual(pair.map((r) => r.status).sort(), [200, 201]);
  assert.deepEqual(pair[0].data, pair[1].data);
  assert.equal(pair[0].data.procedure.appointmentId, visit.id);
  const again = await f.call('/procedures', doctor, { ...next, requestId: randomUUID() });
  assert.equal(again.status, 201);
  assert.notEqual(again.data.procedure.id, pair[0].data.procedure.id);
  assert.deepEqual(countEffects(f.db), [2, 3, 2, 2]);
});
test('silently ignored plan, command, audit or notice rolls back the complete transaction before an exact retry', async (t) => {
  const f = await careApiFixture(t),
    doctor = await f.login('doctor');
  for (const table of ['procedures', 'procedureCatalogueCommands', 'audit', 'activity']) {
    const cmd = command(),
      before = countEffects(f.db);
    f.db.exec(
      'CREATE TRIGGER synthetic_skip BEFORE INSERT ON ' +
        table +
        ' BEGIN SELECT RAISE(IGNORE); END',
    );
    assert.equal((await f.call('/procedures', doctor, cmd)).status, 500, table);
    assert.deepEqual(countEffects(f.db), before);
    f.db.exec('DROP TRIGGER synthetic_skip');
    assert.equal((await f.call('/procedures', doctor, cmd)).status, 201);
    assert.deepEqual(
      countEffects(f.db),
      before.map((n) => n + 1),
    );
  }
});
