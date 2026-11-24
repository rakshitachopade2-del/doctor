import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { openDatabase, type DB } from '../server/db.ts';
import type { Investigation } from '../shared/clinical.ts';
import type { InvestigationCancellationCommand } from '../shared/investigation-cancellation.ts';
import {
  beforeTransaction,
  careApiFixture,
  changeUser,
  simultaneousCareRequests,
  type Client,
} from './fixtures/care-api.ts';

const patientId = 'patient-ananya';
const doctorId = 'doctor-meera';
const title = 'Synthetic investigation';
const reason = 'Replaced after discussion with the patient.';
const route = (id: string) => '/investigations/' + id;
async function fixture(t: TestContext) {
  const f = await careApiFixture(t);
  const doctor = await f.login('doctor'),
    patient = await f.login('patient'),
    admin = await f.login('admin');
  const order = async (target = patientId) => {
    const reply = await f.call('/investigations', doctor, {
      patientId: target,
      title,
      kind: 'other',
      reason: 'Synthetic request',
      instructions: 'Synthetic instructions.',
    });
    assert.equal(reply.status, 201);
    return reply.data as Investigation;
  };
  const first = await order();
  const base = route(first.id);
  const result = async (note: string, documentIds: string[] = []) => {
    const reply = await f.call(base + '/results', patient, { note, documentIds });
    assert.equal(reply.status, 201, JSON.stringify(reply.data));
    return (reply.data as Investigation).results.at(-1)!;
  };
  const review = async (resultId: string, summary: string, publishToPatient: boolean) => {
    const reply = await f.call(base + '/reviews', doctor, { resultId, summary, publishToPatient });
    assert.equal(reply.status, 201, JSON.stringify(reply.data));
    return (reply.data as Investigation).reviews.at(-1)!;
  };
  const current = async (who: Client) => {
    const r = await f.call('/patients/' + patientId + '/clinical-workflows', who);
    assert.equal(r.status, 200);
    return (r.data.investigations as Investigation[]).find((x) => x.id === first.id)!;
  };
  const command = (
    patch: Partial<InvestigationCancellationCommand> = {},
  ): InvestigationCancellationCommand => ({
    requestId: randomUUID(),
    patientId,
    investigationId: first.id,
    doctorId,
    cancelledByRole: 'doctor',
    expectedLatestResultId: null,
    reason,
    reviewedConfirmed: true,
    ...patch,
  });
  return {
    ...f,
    doctor,
    patient,
    admin,
    order,
    first,
    base,
    reviewed: base + '/cancellation',
    legacy: base + '/cancel',
    result,
    review,
    current,
    command,
  };
}
function effects(db: DB) {
  const count = (sql: string) => Number(db.prepare(sql).get()!.n);
  return {
    cancellations: count('SELECT count(*) n FROM investigationCancellations'),
    commands: count('SELECT count(*) n FROM investigationCancellationCommands'),
    audits: count(
      "SELECT count(*) n FROM audit WHERE json_extract(data,'$.action')='cancelled investigation'",
    ),
    notices: count(
      "SELECT count(*) n FROM activity WHERE eventKey LIKE 'investigation-cancelled:%'",
    ),
  };
}
function unmarked(reply: { status: number; data: Record<string, unknown> }, status: number) {
  assert.equal(reply.status, status, JSON.stringify(reply.data));
  assert.deepEqual(Object.keys(reply.data), ['error']);
}
function refused(
  reply: { status: number; data: Record<string, unknown> },
  who: Client,
  command: InvestigationCancellationCommand,
) {
  assert.equal(reply.status, 409, JSON.stringify(reply.data));
  assert.equal(typeof reply.data.message, 'string');
  assert.deepEqual(reply.data, {
    code: 'INVESTIGATION_NOT_CANCELLED',
    actorId: who.user.id,
    command,
    message: reply.data.message,
  });
}

test('cancelling a supplemental result retains PDF links and published and private reviews, and recovers the cancelling clinician after a rename and restart', async (t) => {
  const f = await fixture(t);
  changeUser(f.db, f.admin.user, { doctorId: 'doctor-arjun' });
  const document = await f.call('/documents', f.doctor, {
    patientId,
    title: 'Synthetic PDF',
    originalName: 'synthetic.pdf',
    consent: true,
    dataUrl:
      'data:application/pdf;base64,' +
      Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n').toString('base64'),
  });
  assert.equal(document.status, 201);
  const earlier = await f.result('Synthetic original report', [document.data.id]);
  const hidden = await f.review(earlier.id, 'Staff interpretation only.', false);
  const published = await f.review(earlier.id, 'Shared interpretation.', true);
  const latest = await f.result('Synthetic supplement');
  const before = await f.current(f.doctor),
    portal = await f.current(f.patient);
  assert.deepEqual(
    before.reviews.map((r) => r.id),
    [hidden.id, published.id],
  );
  assert.deepEqual(
    portal.reviews.map((r) => r.id),
    [published.id],
  );
  const cmd = f.command({
    doctorId: 'doctor-arjun',
    cancelledByRole: 'admin',
    expectedLatestResultId: latest.id,
  });
  const saved = await f.call(f.reviewed, f.admin, {
    ...cmd,
    requestId: cmd.requestId.toUpperCase(),
    reason: '  ' + reason + ' ',
  });
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  const name = JSON.parse(
    String(f.db.prepare('SELECT data FROM doctors WHERE id=?').get(cmd.doctorId)!.data),
  ).name;
  const at = saved.data.receipt.cancelledAt;
  assert.equal(new Date(at).toISOString(), at);
  assert.deepEqual(saved.data, {
    receipt: {
      requestId: cmd.requestId,
      actorId: f.admin.user.id,
      investigationId: f.first.id,
      patientId,
      doctorId: cmd.doctorId,
      doctorName: name,
      cancelledByRole: 'admin',
      expectedLatestResultId: latest.id,
      reason,
      title,
      cancelledAt: at,
    },
  });
  assert.equal(before.doctorId, doctorId);
  for (const [who, prior] of [
    [f.doctor, before],
    [f.patient, portal],
  ] as const) {
    assert.deepEqual(await f.current(who), {
      ...prior,
      status: 'cancelled',
      cancellationReason: reason,
    });
  }
  const feed = (await f.call('/activity', f.patient)).data.items.filter(
    (x: { title: string }) => x.title === 'An investigation request was cancelled',
  );
  assert.equal(feed.length, 1);
  assert.equal(feed[0].detail, title);
  assert.equal(feed[0].href, '/my-care/record?tab=workflows');
  assert.ok(!JSON.stringify(feed).includes(reason));
  for (const projection of [
    portal,
    saved.data,
    await f.current(f.patient),
    (await f.call('/patients/' + patientId + '/care-summary', f.patient)).data,
    feed,
  ])
    assert.ok(!JSON.stringify(projection).includes(hidden.summary));
  for (const who of [f.patient, await f.login('reception')])
    unmarked(await f.call(f.reviewed, who, cmd), 403);
  unmarked(await f.call(f.base + '/reviews/' + hidden.id + '/publish', f.admin, {}), 409);
  const baseline = effects(f.db);
  assert.deepEqual(baseline, { cancellations: 1, audits: 1, notices: 1, commands: 1 });
  f.db
    .prepare("UPDATE doctors SET data=json_set(data,'$.name',?) WHERE id=?")
    .run('Renamed cancelling clinician', cmd.doctorId);
  await f.close();
  const next = await careApiFixture(t, f.databasePath);
  const recovered = await next.call(
    f.reviewed,
    f.admin,
    Object.fromEntries(Object.entries(cmd).reverse()),
  );
  assert.equal(recovered.status, 200);
  assert.deepEqual(recovered.data, saved.data);
  assert.deepEqual(effects(next.db), baseline);
});

test('a newer result or a review of the latest result refuses cancellation permanently for that request, and a fresh reviewed supplement can be cancelled', async (t) => {
  const f = await fixture(t);
  const unseen = f.command();
  const a = await f.result('New evidence');
  const stale = await f.call(f.reviewed, f.doctor, unseen);
  refused(stale, f.doctor, unseen);
  assert.match(stale.data.message, /latest result changed/i);
  const seen = f.command({ expectedLatestResultId: a.id });
  await f.review(a.id, 'Private reviewed result.', false);
  const guarded = await f.call(f.reviewed, f.doctor, seen);
  refused(guarded, f.doctor, seen);
  assert.match(guarded.data.message, /already documented/i);
  unmarked(await f.call(f.legacy, f.doctor, { reason }), 409);
  const newer = await f.result('Supplemental evidence');
  assert.deepEqual((await f.call(f.reviewed, f.doctor, unseen)).data, stale.data);
  assert.deepEqual((await f.call(f.reviewed, f.doctor, seen)).data, guarded.data);
  assert.deepEqual(effects(f.db), { cancellations: 0, commands: 2, audits: 0, notices: 0 });
  const fresh = f.command({ expectedLatestResultId: newer.id });
  assert.equal((await f.call(f.reviewed, f.doctor, fresh)).status, 201);
  const other = f.command({ expectedLatestResultId: newer.id });
  const already = await f.call(f.reviewed, f.doctor, other);
  refused(already, f.doctor, other);
  assert.match(already.data.message, /is cancelled/);
  unmarked(await f.call(f.base + '/results', f.patient, { note: 'Later' }), 409);
  unmarked(
    await f.call(f.base + '/reviews', f.doctor, { resultId: newer.id, summary: 'Later' }),
    409,
  );
  assert.throws(
    () => f.db.exec('UPDATE investigationCancellationCommands SET rowid=rowid'),
    /immutable/,
  );
  assert.throws(() => f.db.exec('DELETE FROM investigationCancellationCommands'), /immutable/);
  await f.close();
  const next = await careApiFixture(t, f.databasePath);
  for (const [cmd, prior] of [
    [unseen, stale],
    [seen, guarded],
    [other, already],
  ] as const)
    assert.deepEqual((await next.call(f.reviewed, f.doctor, cmd)).data, prior.data);
});

test('the reviewed route strictly binds the URL, patient, role, profile, reason and latest result to the original issuing account', async (t) => {
  const f = await fixture(t),
    cmd = f.command(),
    other = await f.order('patient-2');
  for (const key of Object.keys(cmd)) {
    const bad = { ...cmd };
    delete bad[key as keyof InvestigationCancellationCommand];
    unmarked(await f.call(f.reviewed, f.doctor, bad), 400);
  }
  for (const patch of [
    { reason: '   ' },
    { reason: 'x'.repeat(8001) },
    { requestId: 'bad' },
    { doctorId: false },
    { expectedLatestResultId: '' },
    { expectedLatestResultId: [] },
    { reviewedConfirmed: false },
    { cancelledByRole: 'receptionist' },
    { extra: 'extra' },
  ])
    unmarked(await f.call(f.reviewed, f.doctor, { ...cmd, ...patch }), 400);
  unmarked(await f.call(f.reviewed + '?reason=different', f.doctor, cmd), 400);
  unmarked(await f.call(f.reviewed, undefined, cmd), 401);
  unmarked(await f.call(f.reviewed, { ...f.doctor, csrf: 'bad' }, cmd), 403);
  unmarked(await f.call(route('absent') + '/cancellation', f.doctor, cmd), 404);
  unmarked(await f.call(f.reviewed, f.doctor, { ...cmd, investigationId: other.id }), 409);
  unmarked(await f.call(f.reviewed, f.doctor, { ...cmd, patientId: 'patient-2' }), 409);
  unmarked(await f.call(f.reviewed, f.doctor, { ...cmd, doctorId: 'doctor-arjun' }), 403);
  unmarked(await f.call(f.reviewed, f.doctor, { ...cmd, cancelledByRole: 'admin' }), 403);
  assert.equal((await f.call(f.reviewed, f.doctor, cmd)).status, 201);
  const baseline = effects(f.db);
  for (const patch of [{ reason: 'Other' }, { expectedLatestResultId: randomUUID() }])
    unmarked(await f.call(f.reviewed, f.doctor, { ...cmd, ...patch }), 409);
  unmarked(await f.call(f.reviewed, f.admin, { ...cmd, cancelledByRole: 'admin' }), 409);
  unmarked(
    await f.call(route(other.id) + '/cancellation', f.doctor, {
      ...cmd,
      investigationId: other.id,
      patientId: other.patientId,
    }),
    409,
  );
  assert.deepEqual(effects(f.db), baseline);
  const legacy = await f.call(route(other.id) + '/cancel?ignored=1', f.doctor, {
    reason: ' ' + reason + ' ',
    extra: 'ignored',
  });
  assert.equal(legacy.status, 200);
  assert.deepEqual(legacy.data, { ...other, status: 'cancelled', cancellationReason: reason });
  const after = effects(f.db);
  assert.equal(after.notices, 1);
  assert.equal(after.commands, 1);
  const onLegacy = f.command({ investigationId: other.id, patientId: other.patientId });
  refused(await f.call(route(other.id) + '/cancellation', f.doctor, onLegacy), f.doctor, onLegacy);
  unmarked(await f.call(route(other.id) + '/cancel', f.doctor, { reason }), 409);
});

test('independent connections settle exact retries, contesting clinicians and a competing patient report without duplicate cancellation effects', async (t) => {
  const f = await fixture(t);
  const pair = await simultaneousCareRequests(f, f.reviewed, f.doctor, f.command());
  assert.deepEqual(pair.map((x) => x.status).sort(), [200, 201]);
  assert.deepEqual(pair[0].data, pair[1].data);
  const other = await f.order(),
    url = route(other.id) + '/cancellation';
  const a = f.command({ investigationId: other.id }),
    b = f.command({
      investigationId: other.id,
      cancelledByRole: 'admin',
      reason: 'Other clinician',
    });
  const replies = await simultaneousCareRequests(f, url, f.doctor, a, { who: f.admin, body: b });
  assert.deepEqual(replies.map((x) => x.status).sort(), [201, 409]);
  for (const [index, who, cmd] of [
    [0, f.doctor, a],
    [1, f.admin, b],
  ] as const) {
    const outcome = replies[index],
      again = await f.call(url, who, cmd);
    assert.equal(again.status, outcome.status === 201 ? 200 : 409);
    assert.deepEqual(again.data, outcome.data);
    if (outcome.status === 409) refused(outcome, who, cmd);
  }
  const third = await f.order(),
    base = route(third.id);
  const [cancel, submit] = await simultaneousCareRequests(
    f,
    base + '/cancellation',
    f.doctor,
    f.command({ investigationId: third.id }),
    { who: f.patient, body: { note: 'Concurrent patient report' }, route: base + '/results' },
  );
  assert.deepEqual([cancel.status, submit.status].sort(), [201, 409]);
  const received = submit.status === 201;
  const record = (
    await f.call('/patients/' + patientId + '/clinical-workflows', f.patient)
  ).data.investigations.find((x: Investigation) => x.id === third.id);
  assert.equal(record.status, received ? 'result-received' : 'cancelled');
  assert.equal(record.results.length, received ? 1 : 0);
  const number = received ? 2 : 3;
  assert.deepEqual(effects(f.db), {
    cancellations: number,
    commands: 4,
    audits: number,
    notices: number,
  });
});

test('both writers and exact accepted and refused retries recheck account, session and linked clinician while holding the write lock', async (t) => {
  const f = await fixture(t),
    other = openDatabase(f.databasePath);
  t.after(() => other.close());
  const accepted = f.command(),
    denied = f.command({ reason: 'other' });
  assert.equal((await f.call(f.reviewed, f.doctor, accepted)).status, 201);
  refused(await f.call(f.reviewed, f.doctor, denied), f.doctor, denied);
  const baseline = effects(f.db),
    user = f.doctor.user;
  const session = other.prepare('SELECT * FROM sessions WHERE userId=?').get(user.id)!;
  const change = (patch: Parameters<typeof changeUser>[2]) => changeUser(other, user, patch);
  const cases: [number, () => unknown][] = [
    [401, () => change({ active: false })],
    [403, () => change({ mustChangePassword: true })],
    [403, () => change({ role: 'patient', patientId: 'patient-3' })],
    [403, () => change({ role: 'receptionist' })],
    [400, () => change({ doctorId: undefined })],
    [400, () => change({ doctorId: 'absent-doctor' })],
    [401, () => other.prepare('DELETE FROM sessions WHERE userId=?').run(user.id)],
    [401, () => other.prepare('UPDATE sessions SET expiresAt=0 WHERE userId=?').run(user.id)],
    [
      401,
      () => other.prepare("UPDATE sessions SET csrfToken='changed' WHERE userId=?").run(user.id),
    ],
    [
      401,
      () =>
        other
          .prepare('INSERT INTO mfaCredentials VALUES (?,?,?,?,?)')
          .run(user.id, randomUUID(), 'synthetic', '2031-01-01', 0),
    ],
  ];
  const columns = Object.keys(session);
  for (const [path, body] of [
    [f.legacy, { reason }],
    [f.reviewed, f.command()],
    [f.reviewed, accepted],
    [f.reviewed, denied],
  ] as const) {
    for (const [status, mutate] of cases) {
      const reply = await beforeTransaction(f.db, 'BEGIN IMMEDIATE', mutate, () =>
        f.call(path, f.doctor, body),
      );
      unmarked(reply, status);
      change({});
      other.prepare('DELETE FROM mfaCredentials WHERE userId=?').run(user.id);
      other.prepare('DELETE FROM sessions WHERE userId=?').run(user.id);
      other
        .prepare(
          'INSERT INTO sessions(' +
            columns.join(',') +
            ') VALUES (' +
            columns.map(() => '?').join(',') +
            ')',
        )
        .run(...Object.values(session));
    }
    if (path !== f.reviewed) continue;
    for (const patch of [{ role: 'admin' as const }, { doctorId: 'doctor-arjun' }]) {
      const reply = await beforeTransaction(
        f.db,
        'BEGIN IMMEDIATE',
        () => change(patch),
        () => f.call(path, f.doctor, body),
      );
      unmarked(reply, 403);
      change({});
    }
  }
  assert.deepEqual(effects(f.db), baseline);
});

test('a review that commits immediately before either writer takes the lock protects the latest result', async (t) => {
  const f = await fixture(t),
    other = openDatabase(f.databasePath);
  t.after(() => other.close());
  for (const path of [f.legacy, f.reviewed]) {
    const latest = await f.result('Synthetic latest result');
    const cmd = f.command({ expectedLatestResultId: latest.id });
    const reviewId = randomUUID();
    const review = {
      id: reviewId,
      investigationId: f.first.id,
      resultId: latest.id,
      summary: 'Private result review',
      followUp: '',
      doctorId,
      doctorName: 'Dr. Meera Shah',
      createdAt: new Date().toISOString(),
    };
    const reply = await beforeTransaction(
      f.db,
      'BEGIN IMMEDIATE',
      () =>
        other
          .prepare(
            'INSERT INTO investigationReviews(id,investigationId,resultId,data) VALUES (?,?,?,?)',
          )
          .run(review.id, review.investigationId, review.resultId, JSON.stringify(review)),
      () => f.call(path, f.doctor, cmd),
    );
    if (path === f.reviewed) refused(reply, f.doctor, cmd);
    else unmarked(reply, 409);
    assert.deepEqual((await f.current(f.patient)).reviews, []);
    assert.equal((await f.current(f.doctor)).status, 'reviewed');
  }
  assert.deepEqual(effects(f.db), { cancellations: 0, commands: 1, audits: 0, notices: 0 });
});

test('cancellation, audit, eligible notice and reviewed outcome all roll back when a write aborts or is silently skipped', async (t) => {
  const f = await fixture(t);
  for (const reviewed of [true, false]) {
    const order = await f.order(),
      path = route(order.id) + (reviewed ? '/cancellation' : '/cancel');
    const cmd = f.command({ investigationId: order.id }),
      before = effects(f.db);
    for (const table of [
      'investigationCancellations',
      'audit',
      'activity',
      ...(reviewed ? ['investigationCancellationCommands'] : []),
    ]) {
      for (const failure of ["RAISE(ABORT,'Synthetic cancellation failure')", 'RAISE(IGNORE)']) {
        f.db.exec(
          'CREATE TRIGGER synthetic_failure BEFORE INSERT ON ' +
            table +
            ' BEGIN SELECT ' +
            failure +
            '; END;',
        );
        try {
          unmarked(await f.call(path, f.doctor, cmd), 500);
        } finally {
          f.db.exec('DROP TRIGGER synthetic_failure');
        }
        assert.deepEqual(effects(f.db), before);
      }
    }
    assert.equal((await f.call(path, f.doctor, cmd)).status, reviewed ? 201 : 200);
  }
  const cmd = f.command({ expectedLatestResultId: 'unseen' }),
    before = effects(f.db);
  f.db.exec(
    'CREATE TRIGGER skip_refusal BEFORE INSERT ON investigationCancellationCommands BEGIN SELECT RAISE(IGNORE); END;',
  );
  try {
    unmarked(await f.call(f.reviewed, f.doctor, cmd), 500);
  } finally {
    f.db.exec('DROP TRIGGER skip_refusal');
  }
  assert.deepEqual(effects(f.db), before);
  refused(await f.call(f.reviewed, f.doctor, cmd), f.doctor, cmd);
});
