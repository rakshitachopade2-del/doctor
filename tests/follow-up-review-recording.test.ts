import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import type {
  FollowUpReviewCommand,
  FollowUpReviewContext,
} from '../shared/follow-up-review-recording.ts';
import { addDays, clinicToday, openDatabase, type DB } from '../server/db.ts';
import {
  beforeTransaction,
  careApiFixture,
  changeUser,
  simultaneousCareRequests,
  type Client,
} from './fixtures/care-api.ts';

const carePlanId = 'plan-1',
  patientId = 'patient-ananya';
const root = '/care-plans/' + carePlanId,
  contextPath = root + '/review-context',
  legacyPath = root + '/reviews',
  recordPath = legacyPath + '/record';
const assessment = 'Private synthetic clinician assessment.',
  instructions = 'Synthetic patient instructions.';

async function fixture(t: TestContext) {
  const f = await careApiFixture(t);
  const doctor = await f.login('doctor'),
    patient = await f.login('patient');
  async function context() {
    const r = await f.call(contextPath, doctor);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data as FollowUpReviewContext;
  }
  function input(
    c: FollowUpReviewContext,
    changes: Partial<FollowUpReviewCommand> = {},
  ): FollowUpReviewCommand {
    return {
      patientId,
      carePlanId,
      requestId: randomUUID(),
      doctorId: c.doctorId,
      expectedRevision: c.item.revision,
      assessment,
      patientInstructions: instructions,
      disposition: 'continue',
      nextReviewDate: addDays(clinicToday(), 7),
      reviewedConfirmed: true,
      ...changes,
    };
  }
  async function report(note: string, first: boolean) {
    const r = await f.call('/check-ins', patient, {
      carePlanId,
      date: clinicToday(),
      adherence: 'partial',
      feeling: 'same',
      note,
    });
    assert.equal(r.status, first ? 201 : 200, JSON.stringify(r.data));
    return r.data;
  }
  return { ...f, patient, doctor, context, input, report };
}
function legacyBody(command: FollowUpReviewCommand) {
  const { assessment, patientInstructions, disposition, nextReviewDate, expectedRevision } =
    command;
  return { assessment, patientInstructions, disposition, nextReviewDate, expectedRevision };
}
function setEnabled(db: DB, enabled: boolean) {
  db.prepare(
    "UPDATE meta SET value=json_set(value,'$.modules.followUp',json(?)) WHERE key='settings'",
  ).run(JSON.stringify(enabled));
}
function effects(db: DB) {
  const count = (sql: string) => Number(db.prepare(sql).get()!.n);
  return {
    reviews: count('SELECT COUNT(*) n FROM followUpReviews'),
    commands: count('SELECT COUNT(*) n FROM followUpReviewCommands'),
    audits: count(
      "SELECT COUNT(*) n FROM audit WHERE json_extract(data,'$.action')='reviewed follow-up and shared patient instructions'",
    ),
    notices: count("SELECT COUNT(*) n FROM activity WHERE eventKey LIKE 'follow-up-review:%'"),
    appointments: count('SELECT COUNT(*) n FROM appointments'),
  };
}
function unmarked(r: { status: number; data: Record<string, unknown> }, status: number) {
  assert.equal(r.status, status, JSON.stringify(r.data));
  for (const key of ['code', 'command', 'review', 'receipt', 'item', 'checkInSnapshots'])
    assert.ok(!(key in r.data), key);
  assert.ok(!JSON.stringify(r.data).includes(assessment));
}
function definitive(
  r: { status: number; data: unknown },
  command: FollowUpReviewCommand,
  actor: Client,
  status: number,
) {
  assert.equal(r.status, status);
  assert.deepEqual(r.data, {
    code: 'FOLLOW_UP_REVIEW_NOT_RECORDED',
    actorId: actor.user.id,
    command,
    message: (r.data as { message: string }).message,
  });
  assert.ok((r.data as { message: string }).message.trim());
}

test('the original clinician, report versions and patient instructions survive later corrections, handover, completion and a clinic pause', async (t) => {
  const f = await fixture(t),
    admin = await f.login('admin');
  const first = await f.report('First synthetic report version', true);
  const reviewedContext = await f.context();
  assert.equal(reviewedContext.item.patient.id, patientId);
  assert.equal(reviewedContext.item.carePlan.id, carePlanId);
  assert.equal(reviewedContext.item.revision, reviewedContext.item.carePlan.followUpRevision);
  assert.ok(reviewedContext.followUpEnabled);
  assert.equal(reviewedContext.latestAssignmentId, null);
  const plan = reviewedContext.item.carePlan;
  // Validate parity with the pre-v1.47 revision, independently of the shared helper.
  assert.equal(
    reviewedContext.item.revision,
    createHash('sha256')
      .update(
        JSON.stringify({
          id: plan.id,
          patientId: plan.patientId,
          doctorId: plan.doctorId,
          status: plan.status,
          startDate: plan.startDate,
          endDate: plan.endDate,
          followUpDate: plan.followUpDate,
          latestReviewId: reviewedContext.item.latestReview?.id ?? null,
          latestAssignmentId: null,
          checkIns: reviewedContext.checkInSnapshots.map((s) => ({
            id: s.id,
            contentHash: s.contentHash,
          })),
        }),
      )
      .digest('hex'),
  );
  const snap = reviewedContext.checkInSnapshots.find((s) => s.id === first.id)!;
  assert.deepEqual(snap.snapshot, first);
  assert.equal(snap.updatedAt, first.createdAt);
  assert.equal(
    snap.contentHash,
    createHash('sha256').update(JSON.stringify(snap.snapshot)).digest('hex'),
  );
  const input = f.input(reviewedContext, { disposition: 'visit-requested' }),
    before = effects(f.db);
  const saved = await f.call(recordPath, f.doctor, {
    ...input,
    requestId: input.requestId.toUpperCase(),
    assessment: '  ' + assessment + ' ',
    patientInstructions: instructions + ' ',
  });
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  const review = saved.data.receipt.review;
  assert.match(review.id, /^[a-f0-9-]{36}$/);
  assert.equal(new Date(review.createdAt).toISOString(), review.createdAt);
  assert.deepEqual(saved.data, {
    receipt: {
      requestId: input.requestId,
      actorId: f.doctor.user.id,
      patientId,
      carePlanId,
      doctorId: reviewedContext.doctorId,
      expectedRevision: input.expectedRevision,
      review: {
        id: review.id,
        createdAt: review.createdAt,
        carePlanId,
        doctorId: reviewedContext.doctorId,
        doctorName: reviewedContext.doctorName,
        source: 'clinical-review',
        assessment,
        patientInstructions: instructions,
        disposition: 'visit-requested',
        nextReviewDate: input.nextReviewDate,
        checkInSnapshots: reviewedContext.checkInSnapshots,
      },
    },
  });
  assert.equal((await f.context()).item.unreviewedCount, 0);
  assert.deepEqual(effects(f.db), {
    ...before,
    reviews: before.reviews + 1,
    commands: before.commands + 1,
    audits: before.audits + 1,
    notices: before.notices + 1,
  });
  const second = await f.report('Corrected report still awaiting review', false);
  assert.equal(second.id, first.id);
  const newer = await f.context();
  assert.deepEqual(newer.item.unreviewedCheckIns, [second]);
  assert.deepEqual(
    (await f.call(recordPath, f.doctor, Object.fromEntries(Object.entries(input).reverse()))).data,
    saved.data,
  );
  assert.deepEqual(await f.context(), newer);
  changeUser(f.db, admin.user, { doctorId: 'doctor-arjun' });
  const handover = await f.call(root + '/assignment', f.doctor, {
    expectedRevision: newer.item.revision,
    doctorId: 'doctor-arjun',
    reason: 'Synthetic reason',
  });
  assert.equal(handover.status, 201);
  const assigned = await f.context();
  assert.equal(assigned.item.ownerDoctorId, 'doctor-arjun');
  assert.equal(
    assigned.latestAssignmentId,
    (await f.call(root + '/assignments', f.doctor)).data[0].id,
  );
  const complete = f.input(assigned, {
    disposition: 'complete',
    nextReviewDate: null,
    assessment: 'Private second assessment',
    patientInstructions: 'Second public instructions',
  });
  const secondReview = await f.call(recordPath, f.doctor, complete);
  assert.equal(secondReview.status, 201, JSON.stringify(secondReview.data)); // Authorized nonowner may review.
  assert.equal(
    secondReview.data.receipt.review.checkInSnapshots.find((s: { id: string }) => s.id === first.id)
      .snapshot.note,
    second.note,
  );
  const done = await f.context();
  assert.equal(done.item.carePlan.effectiveStatus, 'completed');
  assert.equal(done.item.unreviewedCount, 0);
  f.db
    .prepare(
      "UPDATE doctors SET data=json_set(data,'$.name','New current professional name') WHERE id=?",
    )
    .run(input.doctorId);
  changeUser(f.db, f.doctor.user, { doctorId: 'doctor-arjun' });
  setEnabled(f.db, false);
  const frozen = effects(f.db);
  for (const [command, expected] of [
    [input, saved],
    [complete, secondReview],
  ] as const) {
    const replay = await f.call(recordPath, f.doctor, command);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.data, expected.data);
  }
  const paused = await f.context();
  assert.equal(paused.followUpEnabled, false);
  assert.equal(paused.doctorId, 'doctor-arjun');
  assert.deepEqual(paused.item.latestReview, secondReview.data.receipt.review);
  assert.deepEqual(effects(f.db), frozen);
  for (const url of [
    legacyPath,
    '/patients/' + patientId,
    '/patients/' + patientId + '/care-summary',
    '/care-plans',
    '/activity',
  ]) {
    const r = await f.call(url, f.patient);
    assert.equal(r.status, 200, url);
    const json = JSON.stringify(r.data);
    for (const marker of [
      assessment,
      complete.assessment,
      input.requestId,
      complete.requestId,
      'checkInSnapshots',
      'reviewedConfirmed',
      'payloadHash',
    ])
      assert.ok(!json.includes(marker), url + ' ' + marker);
    if (url === legacyPath) {
      assert.equal(r.data[0].patientInstructions, complete.patientInstructions);
      assert.equal(r.data[1].patientInstructions, instructions);
    }
  }
  const notices = (await f.call('/activity', f.patient)).data.items.filter(
    (row: { title: string; href: string }) =>
      row.title === 'Your clinic reviewed your follow-up' &&
      row.href === '/my-care?plan=' + carePlanId,
  );
  assert.equal(notices.length, 2);
});

test('review context, new submissions and old UUIDs require a real linked clinician and matching plan/patient; malformed commands have no definitive outcome', async (t) => {
  const f = await fixture(t),
    input = f.input(await f.context()),
    before = effects(f.db);
  const admin = await f.login('admin'),
    reception = await f.login('reception');
  const saved = await f.call(recordPath, f.doctor, input);
  assert.equal(saved.status, 201);
  for (const who of [undefined, reception, f.patient]) {
    for (const url of [contextPath, recordPath])
      unmarked(await f.call(url, who, url === recordPath ? input : undefined), who ? 403 : 401);
  }
  changeUser(f.db, admin.user, { doctorId: undefined });
  for (const url of [contextPath, recordPath])
    unmarked(await f.call(url, admin, url === recordPath ? input : undefined), 400);
  changeUser(f.db, admin.user, { doctorId: f.doctor.user.doctorId });
  unmarked(await f.call(recordPath, admin, input), 409);
  unmarked(await f.call(recordPath, { ...f.doctor, csrf: 'wrong' }, input), 403);
  unmarked(await f.call(contextPath + '?include=all', f.doctor), 400);
  unmarked(await f.call(recordPath + '?include=all', f.doctor, input), 400);
  for (const patch of [
    { reviewedConfirmed: false },
    { requestId: 'unsafe' },
    { expectedRevision: 'wrong' },
    { assessment: '  ' },
    { patientInstructions: '  ' },
    { disposition: 'invalid' },
    { nextReviewDate: '2026-02-31' },
    { nextReviewDate: null },
    { disposition: 'complete' },
    { checkInSnapshots: [] },
    { source: 'status-change' },
  ])
    unmarked(await f.call(recordPath, f.doctor, { ...input, ...patch }), 400);
  for (const key of Object.keys(input)) {
    const partial = { ...input };
    delete partial[key as keyof typeof partial];
    unmarked(await f.call(recordPath, f.doctor, partial), 400);
  }
  for (const patch of [
    { expectedRevision: '0'.repeat(64) },
    { assessment: 'Different' },
    { patientInstructions: 'Other' },
    { disposition: 'visit-requested' },
    { nextReviewDate: addDays(input.nextReviewDate!, 3) },
    { doctorId: 'doctor-arjun' },
    { carePlanId: 'plan-2' },
    { patientId: 'patient-2' },
  ])
    unmarked(await f.call(recordPath, f.doctor, { ...input, ...patch }), 409);
  unmarked(await f.call('/care-plans/missing/reviews/record', f.doctor, input), 404);
  assert.deepEqual(effects(f.db), {
    ...before,
    reviews: before.reviews + 1,
    commands: before.commands + 1,
    audits: before.audits + 1,
    notices: before.notices + 1,
  });
});

test('stale revisions, paused follow-up, elapsed dates and changed clinicians retain the exact normalized denial after eligibility changes', async (t) => {
  const f = await fixture(t),
    initial = await f.context(),
    before = effects(f.db);
  const past = f.input(initial, { nextReviewDate: addDays(clinicToday(), -1) });
  const elapsed = await f.call(recordPath, f.doctor, past);
  definitive(elapsed, past, f.doctor, 400);
  const mismatched = f.input(initial, { doctorId: 'doctor-arjun' }),
    changed = await f.call(recordPath, f.doctor, mismatched);
  definitive(changed, mismatched, f.doctor, 409);
  setEnabled(f.db, false);
  const pending = f.input(initial);
  const paused = await f.call(recordPath, f.doctor, {
    ...pending,
    assessment: ' ' + assessment + ' ',
    requestId: pending.requestId.toUpperCase(),
  });
  definitive(paused, pending, f.doctor, 403);
  setEnabled(f.db, true);
  await f.report('A new report after the initial review context', true);
  const stale = f.input(initial),
    denied = await f.call(recordPath, f.doctor, stale);
  definitive(denied, stale, f.doctor, 409);
  assert.deepEqual(effects(f.db), { ...before, commands: before.commands + 4 });
  changeUser(f.db, f.doctor.user, { doctorId: 'doctor-arjun' });
  const admin = await f.login('admin');
  for (const [command, expected] of [
    [past, elapsed],
    [mismatched, changed],
    [pending, paused],
    [stale, denied],
  ] as const) {
    const replay = await f.call(recordPath, f.doctor, command);
    assert.equal(replay.status, expected.status);
    assert.deepEqual(replay.data, expected.data);
    unmarked(await f.call(recordPath, admin, command), 409);
    unmarked(await f.call(recordPath, f.doctor, { ...command, assessment: 'Other draft' }), 409);
  }
  const fresh = await f.context();
  const accepted = await f.call(recordPath, f.doctor, f.input(fresh));
  assert.equal(accepted.status, 201);
  assert.equal(accepted.data.receipt.review.doctorId, 'doctor-arjun');
  assert.equal(accepted.data.receipt.review.checkInSnapshots.length, fresh.checkInSnapshots.length);
});

test('calendar rollover preserves a prior success, while a new review must choose a valid next date; current revisions can reopen a completed plan', async (t) => {
  const f = await fixture(t);
  const day = clinicToday(),
    boundary = Date.parse(day + 'T23:59:00+05:30');
  t.mock.timers.enable({ apis: ['Date'], now: boundary });
  const doctor = await f.login('doctor'); // Fresh 12-hour session at the simulated clinic time.
  const context = (await f.call(contextPath, doctor)).data as FollowUpReviewContext;
  const cmd = f.input(context, { nextReviewDate: day }),
    saved = await f.call(recordPath, doctor, cmd);
  assert.equal(saved.status, 201);
  t.mock.timers.setTime(boundary + 120000);
  assert.equal(clinicToday(), addDays(day, 1));
  assert.deepEqual((await f.call(recordPath, doctor, cmd)).data, saved.data);
  const nextContext = async () => (await f.call(contextPath, doctor)).data as FollowUpReviewContext;
  const expired = f.input(await nextContext(), { nextReviewDate: day });
  definitive(await f.call(recordPath, doctor, expired), expired, doctor, 400);
  const completed = f.input(await nextContext(), { disposition: 'complete', nextReviewDate: null });
  // The old client could omit the terminal date and receives its hydrated plan.
  const old = await f.call(legacyPath, doctor, {
    ...legacyBody(completed),
    nextReviewDate: undefined,
  });
  assert.equal(old.status, 201);
  assert.equal(old.data.effectiveStatus, 'completed');
  assert.equal(old.data.latestReview.nextReviewDate, null);
  const reopen = f.input(await nextContext());
  const reopened = await f.call(recordPath, doctor, reopen);
  assert.equal(reopened.status, 201);
  assert.equal((await nextContext()).item.carePlan.effectiveStatus, 'active');
  assert.deepEqual((await f.call(recordPath, doctor, cmd)).data, saved.data);
  t.mock.timers.reset();
});

test('independent SQLite writers converge on one shared review per intention, reject competing revisions, and recover the same evidence after restart', async (t) => {
  const f = await fixture(t),
    ctx = await f.context(),
    a = f.input(ctx),
    baseline = effects(f.db);
  const pair = await simultaneousCareRequests(f, recordPath, f.doctor, a);
  assert.deepEqual(pair.map((r) => r.status).sort(), [200, 201]);
  assert.deepEqual(pair[0].data, pair[1].data);
  const next = await f.context(),
    b = f.input(next),
    c = f.input(next, { assessment: 'Competing assessment' });
  const [left, right] = await Promise.all([
    simultaneousCareRequests(f, recordPath, f.doctor, b),
    simultaneousCareRequests(f, recordPath, f.doctor, c),
  ]);
  const [winner, loser, won, lost] =
    left[0].status === 409 ? ([c, b, right, left] as const) : ([b, c, left, right] as const);
  assert.deepEqual(won.map((r) => r.status).sort(), [200, 201]);
  assert.deepEqual(won[0].data, won[1].data);
  assert.deepEqual(
    lost.map((r) => r.status),
    [409, 409],
  );
  assert.deepEqual(lost[0].data, lost[1].data);
  definitive(lost[0], loser, f.doctor, 409);
  const expected = {
    ...baseline,
    reviews: baseline.reviews + 2,
    commands: baseline.commands + 3,
    audits: baseline.audits + 2,
    notices: baseline.notices + 2,
  };
  assert.deepEqual(effects(f.db), expected);
  assert.throws(() => f.db.exec('UPDATE followUpReviewCommands SET rowid=rowid'), /immutable/);
  assert.throws(() => f.db.exec('DELETE FROM followUpReviewCommands'), /immutable/);
  await f.close();
  const reopened = await careApiFixture(t, f.databasePath);
  for (const [cmd, saved, status] of [
    [a, pair[0], 200],
    [winner, won[0], 200],
    [loser, lost[0], 409],
  ] as const) {
    const response = await reopened.call(recordPath, f.doctor, cmd);
    assert.equal(response.status, status);
    assert.deepEqual(response.data, saved.data);
  }
  const history = await reopened.call(legacyPath, f.doctor);
  assert.deepEqual(history.data.slice(0, 2), [
    won[0].data.receipt.review,
    pair[0].data.receipt.review,
  ]);
  assert.deepEqual(effects(reopened.db), expected);
});

test('review, plan, audit, notice and command failures roll back the complete clinical save on either route; a failed rejection can be retried', async (t) => {
  const f = await fixture(t),
    ctx = await f.context(),
    expected = effects(f.db),
    cmd = f.input(ctx, { disposition: 'complete', nextReviewDate: null });
  for (const path of [legacyPath, recordPath]) {
    const body = path === legacyPath ? legacyBody(cmd) : cmd;
    for (const table of [
      'followUpReviews',
      'carePlans',
      'audit',
      'activity',
      ...(path === recordPath ? ['followUpReviewCommands'] : []),
    ]) {
      const operation = table === 'carePlans' ? 'UPDATE' : 'INSERT';
      f.db.exec(
        `CREATE TRIGGER fail_review_step BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'Synthetic review rollback'); END`,
      );
      try {
        unmarked(await f.call(path, f.doctor, body), 500);
      } finally {
        f.db.exec('DROP TRIGGER fail_review_step');
      }
      assert.deepEqual(await f.context(), ctx);
      assert.deepEqual(effects(f.db), expected, table);
    }
  }
  setEnabled(f.db, false);
  f.db.exec(
    "CREATE TRIGGER fail_review_command BEFORE INSERT ON followUpReviewCommands BEGIN SELECT RAISE(ABORT,'Synthetic rejection rollback'); END",
  );
  unmarked(await f.call(recordPath, f.doctor, cmd), 500);
  f.db.exec('DROP TRIGGER fail_review_command');
  assert.deepEqual(effects(f.db), expected);
  setEnabled(f.db, true);
  assert.equal((await f.call(recordPath, f.doctor, cmd)).status, 201);
  assert.equal((await f.context()).item.carePlan.effectiveStatus, 'completed');
});

test('review reads, both writers and both stored outcomes consult current session, role, and professional linkage inside their transaction', async (t) => {
  const f = await fixture(t),
    other = openDatabase(f.databasePath);
  t.after(() => other.close());
  const ctx = await f.context(),
    saved = f.input(ctx),
    denied = f.input(ctx),
    user = f.doctor.user;
  assert.equal((await f.call(recordPath, f.doctor, saved)).status, 201);
  definitive(await f.call(recordPath, f.doctor, denied), denied, f.doctor, 409);
  const current = f.input(await f.context()),
    baseline = effects(f.db);
  const session = other.prepare('SELECT * FROM sessions WHERE userId=?').get(user.id)!;
  const sessionCols = Object.keys(session);
  const mutations: [string, number, () => void][] = [
    [
      'retired session',
      401,
      () => other.prepare('DELETE FROM sessions WHERE userId=?').run(user.id),
    ],
    [
      'expired session',
      401,
      () => other.prepare('UPDATE sessions SET expiresAt=0 WHERE userId=?').run(user.id),
    ],
    [
      'rotated CSRF',
      401,
      () => other.prepare("UPDATE sessions SET csrfToken='changed' WHERE userId=?").run(user.id),
    ],
    [
      'changed MFA',
      401,
      () =>
        other
          .prepare(
            'INSERT INTO mfaCredentials(userId,id,secret,enabledAt,lastStep) VALUES (?,?,?,?,?)',
          )
          .run(user.id, randomUUID(), 'synthetic', new Date().toISOString(), -1),
    ],
    ['suspended', 401, () => changeUser(other, user, { active: false })],
    ['password change', 403, () => changeUser(other, user, { mustChangePassword: true })],
    ['patient', 403, () => changeUser(other, user, { role: 'patient' })],
    ['reception', 403, () => changeUser(other, user, { role: 'receptionist' })],
    ['unlinked clinician', 400, () => changeUser(other, user, { doctorId: undefined })],
    ['missing professional', 400, () => changeUser(other, user, { doctorId: 'missing-doctor' })],
  ];
  for (const [url, body] of [
    [contextPath, undefined],
    [legacyPath, legacyBody(current)],
    [recordPath, current],
    [recordPath, saved],
    [recordPath, denied],
  ] as const) {
    for (const [label, status, mutate] of mutations) {
      const res = await beforeTransaction(
        f.db,
        url === contextPath ? 'BEGIN' : 'BEGIN IMMEDIATE',
        mutate,
        () => f.call(url, f.doctor, body),
      );
      assert.equal(res.status, status, label + ' ' + url);
      unmarked(res, status);
      assert.deepEqual(effects(f.db), baseline);
      changeUser(other, user, {});
      other.prepare('DELETE FROM mfaCredentials WHERE userId=?').run(user.id);
      other.prepare('DELETE FROM sessions WHERE userId=?').run(user.id);
      other
        .prepare(
          `INSERT INTO sessions(${sessionCols.join(',')}) VALUES (${sessionCols.map(() => '?').join(',')})`,
        )
        .run(...Object.values(session));
    }
  }
  // The linked professional is mutable without changing the actor account.
  const staleProfile = await beforeTransaction(
    f.db,
    'BEGIN IMMEDIATE',
    () => changeUser(other, user, { doctorId: 'doctor-arjun' }),
    () => f.call(recordPath, f.doctor, current),
  );
  definitive(staleProfile, current, f.doctor, 409);
  const relinked = await f.call(legacyPath, f.doctor, legacyBody(current));
  assert.equal(relinked.status, 201);
  assert.equal(relinked.data.latestReview.doctorId, 'doctor-arjun');
  for (const input of [saved, denied, current]) {
    const changedPatient = await beforeTransaction(
      f.db,
      'BEGIN IMMEDIATE',
      () => {
        other
          .prepare(
            "UPDATE carePlans SET patientId='patient-2',data=json_set(data,'$.patientId','patient-2') WHERE id=?",
          )
          .run(carePlanId);
      },
      () => f.call(recordPath, f.doctor, input),
    );
    unmarked(changedPatient, 409);
    other
      .prepare("UPDATE carePlans SET patientId=?,data=json_set(data,'$.patientId',?) WHERE id=?")
      .run(patientId, patientId, carePlanId);
  }
});
