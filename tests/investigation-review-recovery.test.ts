import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import type { Investigation } from '../shared/clinical.ts';
import type { InvestigationReviewCommand } from '../shared/investigation-review-recording.ts';
import { openDatabase, type DB } from '../server/db.ts';
import {
  beforeTransaction,
  careApiFixture,
  changeUser,
  simultaneousCareRequests,
} from './fixtures/care-api.ts';

const patientId = 'patient-ananya';
async function setup(t: TestContext) {
  const f = await careApiFixture(t),
    doctor = await f.login('doctor'),
    patient = await f.login('patient');
  const created = await f.call('/investigations', doctor, {
    patientId,
    title: 'Synthetic report review',
    kind: 'laboratory',
    reason: 'Synthetic question',
    instructions: 'Synthetic instructions',
    dueDate: null,
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id: string = created.data.id,
    base = '/investigations/' + id,
    path = base + '/reviews',
    contextPath = base + '/review-context';
  const result = async () => {
    const response = await f.call(base + '/results', patient, {
      note: 'Synthetic report ' + randomUUID(),
      documentIds: [],
    });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return (response.data as Investigation).results.at(-1)!;
  };
  const command = async (publishToPatient = false): Promise<InvestigationReviewCommand> => {
    const context = await f.call(contextPath, doctor);
    assert.equal(context.status, 200, JSON.stringify(context.data));
    return {
      resultId: context.data.latestResultId,
      summary: 'Private reviewed findings',
      followUp: 'Private next steps',
      publishToPatient,
      expectedRevision: context.data.revision,
      requestId: randomUUID(),
      patientId,
      investigationId: id,
      doctorId: doctor.user.doctorId!,
      reviewedByRole: 'doctor',
    };
  };
  await result();
  return { ...f, doctor, patient, id, base, path, contextPath, result, command };
}
function count(db: DB, table: string, condition = '1') {
  return Number(db.prepare('SELECT count(*) n FROM ' + table + ' WHERE ' + condition).get()!.n);
}
function effects(db: DB) {
  return {
    reviews: count(db, 'investigationReviews'),
    publications: count(db, 'investigationPublications'),
    commands: count(db, 'investigationCommands'),
    refusals: count(db, 'investigationReviewRefusals'),
    publicationAudits: count(
      db,
      'audit',
      "json_extract(data,'$.action')='published investigation review to patient'",
    ),
    reviewAudits: count(
      db,
      'audit',
      "json_extract(data,'$.action')='reviewed investigation result'",
    ),
    notices: count(db, 'activity', "eventKey LIKE 'investigation-review:%'"),
  };
}
function unmarked(response: { status: number; data: object }, status: number) {
  assert.equal(response.status, status, JSON.stringify(response.data));
  assert.deepEqual(Object.keys(response.data), ['error']);
}
function refused(
  response: { status: number; data: { message: string } },
  cmd: InvestigationReviewCommand,
  actorId: string,
) {
  assert.equal(response.status, 409, JSON.stringify(response.data));
  assert.ok(response.data.message);
  assert.deepEqual(response.data, {
    code: 'INVESTIGATION_REVIEW_NOT_RECORDED',
    actorId,
    command: cmd,
    message: response.data.message,
  });
}
test('the checked review recovers its original private decision after publication, new reports, cancellation and restart', async (t) => {
  const f = await setup(t),
    cmd = await f.command(),
    saved = await f.call(f.path, f.doctor, cmd);
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  const review = saved.data.reviews[0];
  assert.deepEqual(saved.data.receipt, {
    requestId: cmd.requestId,
    actorId: f.doctor.user.id,
    patientId,
    investigationId: f.id,
    expectedRevision: cmd.expectedRevision,
    reviewedByRole: 'doctor',
    review,
  });
  assert.deepEqual(review, {
    id: review.id,
    investigationId: f.id,
    resultId: cmd.resultId,
    summary: cmd.summary,
    followUp: cmd.followUp,
    doctorId: cmd.doctorId,
    doctorName: f.doctor.user.name,
    createdAt: review.createdAt,
    publishedAt: null,
  });
  const portal = async () =>
    (
      await f.call('/patients/' + patientId + '/clinical-workflows', f.patient)
    ).data.investigations.find((order: Investigation) => order.id === f.id);
  assert.deepEqual((await portal()).reviews, []);
  const published = await f.call(f.path + '/' + review.id + '/publish', f.doctor, {});
  assert.equal(published.status, 200, JSON.stringify(published.data));
  const publication = published.data.reviews[0].publishedAt;
  assert.ok(Date.parse(publication));
  await f.result();
  const other = { ...(await f.command(true)), summary: 'Shared synthetic follow-up' };
  const shared = await f.call(f.path, f.doctor, other);
  assert.equal(shared.status, 201);
  assert.ok(Date.parse(shared.data.receipt.review.publishedAt));
  const before = await portal();
  assert.deepEqual(
    before.reviews.map((r: { id: string }) => r.id),
    [review.id, shared.data.receipt.review.id],
  );
  for (const value of [cmd.requestId, cmd.expectedRevision, 'reviewedByRole', 'receipt'])
    assert.ok(!JSON.stringify(before).includes(value));
  await f.result();
  assert.equal(
    (await f.call(f.base + '/cancel', f.doctor, { reason: 'Synthetic closed order' })).status,
    200,
  );
  const stats = effects(f.db);
  assert.deepEqual(stats, {
    reviews: 2,
    publications: 2,
    commands: 2,
    refusals: 0,
    publicationAudits: 2,
    reviewAudits: 2,
    notices: 2,
  });
  await f.close();
  const reopened = await careApiFixture(t, f.databasePath);
  for (const [body, original] of [
    [cmd, saved.data.receipt],
    [other, shared.data.receipt],
  ] as const) {
    const replay = await reopened.call(f.path, f.doctor, body);
    assert.equal(replay.status, 200, JSON.stringify(replay.data));
    assert.equal(replay.data.status, 'cancelled');
    assert.equal(replay.data.results.length, 3);
    assert.deepEqual(replay.data.receipt, original);
    assert.equal(replay.data.reviews[0].publishedAt, publication);
  }
  assert.deepEqual(effects(reopened.db), stats);
});
test('a source-bound refusal persists after restart and later changes, without disclosing one actor’s command to another', async (t) => {
  const f = await setup(t),
    old = await f.command(true);
  await f.result();
  const first = await f.call(f.path, f.doctor, old);
  refused(first, old, f.doctor.user.id);
  for (const changed of [
    { ...old, summary: 'Changed' },
    { ...old, publishToPatient: false },
    { ...old, expectedRevision: (await f.command()).expectedRevision },
  ])
    unmarked(await f.call(f.path, f.doctor, changed), 409);
  const admin = await f.login('admin');
  changeUser(f.db, admin.user, { doctorId: old.doctorId });
  unmarked(await f.call(f.path, admin, { ...old, reviewedByRole: 'admin' }), 409);
  const assignment = await f.call(f.base + '/assignment', f.doctor, {
    requestId: old.requestId,
    expectedRevision: (await f.command()).expectedRevision,
    doctorId: 'doctor-arjun',
    reason: 'Handover',
  });
  unmarked(assignment, 409);
  assert.equal((await f.call(f.path, f.doctor, await f.command())).status, 201);
  await f.close();
  const reopened = await careApiFixture(t, f.databasePath);
  assert.deepEqual((await reopened.call(f.path, f.doctor, old)).data, first.data);
  assert.equal(count(reopened.db, 'investigationReviewRefusals'), 1);
  assert.throws(
    () => reopened.db.exec('UPDATE investigationReviewRefusals SET rowid=rowid'),
    /immutable/,
  );
  assert.throws(() => reopened.db.exec('DELETE FROM investigationReviewRefusals'), /immutable/);
  assert.equal(effects(reopened.db).notices, 0);
});
test('independent writers recover one immutable review and refuse a competing interpretation of the same source', async (t) => {
  const f = await setup(t),
    cmd = await f.command(true);
  const exact = await simultaneousCareRequests(f, f.path, f.doctor, cmd);
  assert.deepEqual(exact.map((r) => r.status).sort(), [200, 201]);
  assert.deepEqual(exact[0].data.receipt, exact[1].data.receipt);
  await f.result();
  const left = await f.command(true),
    right = { ...left, requestId: randomUUID(), summary: 'Other clinician-authored findings' };
  const raced = await simultaneousCareRequests(f, f.path, f.doctor, left, {
    who: f.doctor,
    body: right,
  });
  assert.deepEqual(raced.map((r) => r.status).sort(), [201, 409]);
  const losing = raced[0].status === 409 ? 0 : 1;
  refused(raced[losing], losing === 0 ? left : right, f.doctor.user.id);
  assert.deepEqual(effects(f.db), {
    reviews: 2,
    publications: 2,
    commands: 2,
    refusals: 1,
    publicationAudits: 2,
    reviewAudits: 2,
    notices: 2,
  });
});
test('checked mode validates doctor, route and session under the write lock and preserves legacy review shapes', async (t) => {
  const f = await setup(t),
    cmd = await f.command();
  const {
    patientId: chart,
    reviewedByRole: role,
    doctorId: clinician,
    investigationId: id,
    ...paired
  } = cmd;
  const incomplete = await f.call(f.path, f.doctor, { ...paired, reviewedByRole: role });
  assert.equal(incomplete.status, 400);
  for (const invalid of [
    { ...cmd, reviewedByRole: 'admin' },
    { ...cmd, doctorId: 'doctor-arjun' },
  ])
    unmarked(await f.call(f.path, f.doctor, invalid), 403);
  unmarked(await f.call(f.path, f.doctor, { ...cmd, patientId: 'other' }), 409);
  unmarked(await f.call(f.path, f.doctor, { ...cmd, investigationId: 'other' }), 409);
  unmarked(await f.call(f.path, f.patient, cmd), 403);
  assert.equal((await f.call(f.path + '?extra=1', f.doctor, cmd)).status, 400);
  const other = openDatabase(f.databasePath);
  t.after(() => other.close());
  for (const endpoint of [f.contextPath, f.path]) {
    const denied = await beforeTransaction(
      f.db,
      'BEGIN IMMEDIATE',
      () => changeUser(other, f.doctor.user, { role: 'receptionist' }),
      () => f.call(endpoint, f.doctor, endpoint === f.path ? cmd : undefined),
    );
    unmarked(denied, 403);
    changeUser(other, f.doctor.user, {});
  }
  assert.equal(effects(f.db).commands, 0);
  const saved = await f.call(f.path, f.doctor, {
    ...paired,
    patientId: chart,
    doctorId: clinician,
    investigationId: id,
  });
  assert.equal(saved.status, 201);
  assert.ok(!('receipt' in saved.data));
  assert.equal(
    (await f.call(f.path, f.doctor, { ...paired, expectedRevision: '0'.repeat(64) })).status,
    200,
  );
  unmarked(await f.call(f.path, f.doctor, cmd), 409);
  const legacy = await f.call(f.path, f.doctor, {
    resultId: cmd.resultId,
    summary: 'Independent legacy interpretation',
    patientId: chart,
  });
  assert.equal(legacy.status, 201);
  assert.ok(!('receipt' in legacy.data));
});
test('ignored review, publication, command, audit, eligible notice or refusal rolls back the entire reviewed outcome', async (t) => {
  const f = await setup(t),
    cmd = await f.command(true),
    baseline = effects(f.db);
  for (const [table, when] of [
    ['investigationReviews', '1'],
    ['investigationPublications', '1'],
    ['investigationCommands', '1'],
    ['audit', "json_extract(NEW.data,'$.action')='reviewed investigation result'"],
    ['audit', "json_extract(NEW.data,'$.action')='published investigation review to patient'"],
    ['activity', "NEW.eventKey LIKE 'investigation-review:%'"],
  ]) {
    f.db.exec(
      'CREATE TRIGGER skip_review_write BEFORE INSERT ON ' +
        table +
        ' WHEN ' +
        when +
        ' BEGIN SELECT RAISE(IGNORE); END;',
    );
    try {
      unmarked(await f.call(f.path, f.doctor, cmd), 500);
    } finally {
      f.db.exec('DROP TRIGGER skip_review_write');
    }
    assert.deepEqual(effects(f.db), baseline, table + when);
  }
  assert.equal((await f.call(f.path, f.doctor, cmd)).status, 201);
  const stale = { ...cmd, requestId: randomUUID() };
  f.db.exec(
    'CREATE TRIGGER skip_refusal BEFORE INSERT ON investigationReviewRefusals BEGIN SELECT RAISE(IGNORE); END;',
  );
  try {
    unmarked(await f.call(f.path, f.doctor, stale), 500);
  } finally {
    f.db.exec('DROP TRIGGER skip_refusal');
  }
  assert.equal(effects(f.db).refusals, 0);
  refused(await f.call(f.path, f.doctor, stale), stale, f.doctor.user.id);
});
