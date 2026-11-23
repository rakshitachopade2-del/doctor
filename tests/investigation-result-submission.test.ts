import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { openDatabase, type DB } from '../server/db.ts';
import type { InvestigationResultCommand } from '../shared/investigation-result-submission.ts';
import type { Investigation } from '../shared/clinical.ts';
import type { InvestigationWorkItem } from '../shared/investigation-worklist.ts';
import {
  beforeTransaction,
  careApiFixture,
  changeUser,
  simultaneousCareRequests,
  type Client,
} from './fixtures/care-api.ts';

const patientId = 'patient-ananya';
const note = 'Synthetic investigation result from the submitting account.';
const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
const privateSummary = 'Synthetic private interpretation.';

async function fixture(t: TestContext) {
  const f = await careApiFixture(t);
  const doctor = await f.login('doctor'),
    patient = await f.login('patient'),
    admin = await f.login('admin');
  changeUser(f.db, admin.user, { doctorId: 'doctor-arjun' });
  const order = async (target = patientId) => {
    const r = await f.call('/investigations', doctor, {
      patientId: target,
      kind: 'laboratory',
      title: 'Synthetic investigation',
      reason: 'Synthetic test',
      instructions: 'Supply the synthetic report.',
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return r.data as Investigation;
  };
  const investigation = await order(),
    base = '/investigations/' + investigation.id;
  const command = (
    patch: Partial<InvestigationResultCommand> = {},
  ): InvestigationResultCommand => ({
    requestId: randomUUID(),
    patientId,
    investigationId: investigation.id,
    submittedByRole: 'patient',
    note,
    documentIds: [],
    reviewedConfirmed: true,
    ...patch,
  });
  const document = async (title: string, target = patientId) => {
    const r = await f.call('/documents', doctor, {
      patientId: target,
      title,
      originalName: 'synthetic.pdf',
      consent: true,
      dataUrl: 'data:application/pdf;base64,' + pdf.toString('base64'),
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return String(r.data.id);
  };
  const current = async (who = patient) => {
    const r = await f.call('/patients/' + patientId + '/clinical-workflows', who);
    assert.equal(r.status, 200);
    return (r.data.investigations as Investigation[]).find((x) => x.id === investigation.id)!;
  };
  const work = async () => {
    const r = await f.call('/investigation-worklist?scope=all', doctor);
    assert.equal(r.status, 200);
    return (r.data as InvestigationWorkItem[]).find((x) => x.investigationId === investigation.id)!;
  };
  return {
    ...f,
    doctor,
    patient,
    admin,
    order,
    investigation,
    command,
    document,
    current,
    work,
    base,
    resultPath: base + '/results',
    submit: base + '/results/submit',
  };
}
function counts(db: DB) {
  const count = (sql: string) => Number(db.prepare(sql).get()!.n);
  return {
    results: count('SELECT count(*) n FROM investigationResults'),
    commands: count('SELECT count(*) n FROM investigationResultCommands'),
    audits: count(
      "SELECT count(*) n FROM audit WHERE json_extract(data,'$.action')='submitted unreviewed investigation result'",
    ),
    notices: count("SELECT count(*) n FROM activity WHERE eventKey LIKE 'investigation-result:%'"),
  };
}
function unmarked(response: { status: number; data: Record<string, unknown> }, status: number) {
  assert.equal(response.status, status, JSON.stringify(response.data));
  assert.deepEqual(Object.keys(response.data), ['error']);
}
function definitive(
  response: { status: number; data: Record<string, unknown> },
  status: number,
  who: Client,
  command: InvestigationResultCommand,
) {
  assert.equal(response.status, status, JSON.stringify(response.data));
  assert.deepEqual(response.data, {
    code: 'INVESTIGATION_RESULT_NOT_SUBMITTED',
    actorId: who.user.id,
    command,
    message: response.data.message,
  });
  assert.ok(typeof response.data.message === 'string' && response.data.message.trim());
}

test('an exact patient submission retains ordered links, author and result identity after review and handover; a deliberate supplement reaches the new owner', async (t) => {
  const f = await fixture(t);
  const alpha = await f.document('Synthetic alpha report'),
    beta = await f.document('Synthetic beta report');
  const command = f.command({ documentIds: [beta, alpha] }),
    baseline = counts(f.db);
  const saved = await f.call(f.submit, f.patient, {
    ...command,
    requestId: command.requestId.toUpperCase(),
    note: ' ' + note + ' ',
    documentIds: [' ' + beta + ' ', alpha],
  });
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  const receipt = saved.data.receipt,
    result = receipt.result;
  assert.match(result.id, /^[a-f0-9-]{36}$/);
  assert.equal(new Date(result.createdAt).toISOString(), result.createdAt);
  assert.deepEqual(saved.data, {
    receipt: {
      requestId: command.requestId,
      actorId: f.patient.user.id,
      patientId,
      investigationId: f.investigation.id,
      result: {
        investigationId: f.investigation.id,
        id: result.id,
        createdAt: result.createdAt,
        note,
        documentIds: [beta, alpha],
        submittedById: f.patient.user.id,
        submittedByName: f.patient.user.name,
        submittedByRole: 'patient',
      },
    },
  });
  assert.deepEqual((await f.current()).results, [result]);
  assert.equal((await f.work()).needsReview, true);
  const reviews = await f.call(f.base + '/reviews', f.doctor, {
    resultId: result.id,
    summary: privateSummary,
    publishToPatient: false,
  });
  assert.equal(reviews.status, 201);
  assert.deepEqual((await f.current()).reviews, []);
  assert.equal((await f.current(f.doctor)).reviews[0].summary, privateSummary);
  const beforeHandover = await f.call(f.base + '/review-context', f.doctor);
  const assigned = await f.call(f.base + '/assignment', f.doctor, {
    doctorId: 'doctor-arjun',
    reason: 'Synthetic handover',
    expectedRevision: beforeHandover.data.revision,
    requestId: randomUUID(),
  });
  assert.equal(assigned.status, 201, JSON.stringify(assigned.data));
  const reviewed = await f.work();
  assert.equal(reviewed.needsReview, false);
  const effects = counts(f.db);
  assert.deepEqual(effects, {
    results: baseline.results + 1,
    commands: baseline.commands + 1,
    audits: baseline.audits + 1,
    notices: baseline.notices + 1,
  });
  changeUser(f.db, f.patient.user, { name: 'Renamed synthetic account' });
  const recovered = await f.call(
    f.submit,
    f.patient,
    Object.fromEntries(Object.entries(command).reverse()),
  );
  assert.equal(recovered.status, 200);
  assert.deepEqual(recovered.data, saved.data);
  assert.deepEqual(await f.work(), reviewed);
  assert.deepEqual(counts(f.db), effects);
  const next = f.command({ documentIds: command.documentIds });
  const supplement = await f.call(f.submit, f.patient, next);
  assert.equal(supplement.status, 201);
  assert.notEqual(supplement.data.receipt.result.id, result.id);
  assert.equal(supplement.data.receipt.result.submittedByName, 'Renamed synthetic account');
  const latest = await f.work();
  assert.equal(latest.latestResultId, supplement.data.receipt.result.id);
  assert.equal(latest.needsReview, true);
  const history = await f.current(f.doctor);
  assert.deepEqual(history.results, [result, supplement.data.receipt.result]);
  assert.equal(history.reviews[0].resultId, result.id);
  for (const [key, recipient] of [
    [result.id, f.doctor.user.id],
    [supplement.data.receipt.result.id, f.admin.user.id],
  ]) {
    const recipients = f.db
      .prepare('SELECT userId,data FROM activity WHERE eventKey=?')
      .all('investigation-result:' + key);
    assert.deepEqual(
      recipients.map((x) => x.userId),
      [recipient],
    );
    const notice = JSON.parse(String(recipients[0].data));
    assert.ok(notice.href.endsWith('&result=' + key));
    assert.ok(!JSON.stringify(notice).includes(note));
  }
  const newer = counts(f.db);
  assert.deepEqual((await f.call(f.submit, f.patient, command)).data, saved.data);
  assert.deepEqual(counts(f.db), newer);
  assert.deepEqual(await f.work(), latest);
  for (const url of [
    '/patients/' + patientId + '/clinical-workflows',
    '/patients/' + patientId + '/care-summary',
    '/activity',
  ]) {
    const response = await f.call(url, f.patient);
    assert.equal(response.status, 200);
    const projection = JSON.stringify(response.data);
    for (const secret of [privateSummary, command.requestId, next.requestId])
      assert.equal(projection.includes(secret), false);
  }
});

test('clinical account and patient authority are checked for every replay; legacy DTOs retain patient-only publication visibility and current author roles', async (t) => {
  const f = await fixture(t),
    patientCommand = f.command();
  const doctorCommand = f.command({ submittedByRole: 'doctor' }),
    adminCommand = f.command({ submittedByRole: 'admin' });
  for (const [who, cmd] of [
    [f.doctor, doctorCommand],
    [f.admin, adminCommand],
  ] as const) {
    const saved = await f.call(f.submit, who, cmd);
    assert.equal(saved.status, 201);
    assert.equal(saved.data.receipt.result.submittedByRole, who.user.role);
    assert.equal(saved.data.receipt.result.submittedById, who.user.id);
    assert.deepEqual((await f.call(f.submit, who, cmd)).data, saved.data);
  }
  const saved = await f.call(f.submit, f.patient, patientCommand);
  assert.equal(saved.status, 201);
  assert.equal(
    (
      await f.call(f.base + '/reviews', f.doctor, {
        resultId: saved.data.receipt.result.id,
        summary: privateSummary,
      })
    ).status,
    201,
  );
  const legacy = await f.call(f.resultPath, f.patient, {
    note: '  Supplemental legacy result ',
    extra: 'original path strips unknown properties',
  });
  assert.equal(legacy.status, 201);
  assert.equal(legacy.data.id, f.investigation.id);
  assert.deepEqual(legacy.data.reviews, []);
  assert.equal(legacy.data.results.at(-1).note, 'Supplemental legacy result');
  assert.deepEqual(legacy.data.results.at(-1).documentIds, []);
  const doc = await f.document('Report only');
  const clinicalLegacy = await f.call(f.resultPath, f.doctor, { documentIds: [doc] });
  assert.equal(clinicalLegacy.status, 201);
  assert.equal(clinicalLegacy.data.results.at(-1).note, '');
  assert.equal(clinicalLegacy.data.reviews[0].summary, privateSummary);
  const effects = counts(f.db);
  unmarked(await f.call(f.submit, f.patient, doctorCommand), 403);
  unmarked(await f.call(f.submit, f.admin, { ...doctorCommand, submittedByRole: 'admin' }), 409);
  unmarked(await f.call(f.submit, f.patient, { ...patientCommand, note: 'Changed' }), 409);
  unmarked(await f.call(f.submit, f.doctor, { ...patientCommand, submittedByRole: 'doctor' }), 409);
  // Another currently linked doctor can read this order, but cannot recover this account's outcome.
  changeUser(f.db, f.admin.user, { role: 'doctor', doctorId: 'doctor-arjun' });
  unmarked(await f.call(f.submit, f.admin, doctorCommand), 409);
  changeUser(f.db, f.admin.user, { doctorId: 'doctor-arjun' });
  changeUser(f.db, f.doctor.user, { role: 'admin' });
  unmarked(await f.call(f.submit, f.doctor, doctorCommand), 403);
  unmarked(await f.call(f.submit, f.doctor, { ...doctorCommand, submittedByRole: 'admin' }), 409);
  changeUser(f.db, f.doctor.user, { doctorId: undefined });
  unmarked(await f.call(f.submit, f.doctor, doctorCommand), 400);
  changeUser(f.db, f.patient.user, { patientId: 'patient-2' });
  unmarked(await f.call(f.submit, f.patient, patientCommand), 403);
  const reception = await f.login('reception');
  unmarked(await f.call(f.submit, reception, patientCommand), 403);
  unmarked(await f.call(f.submit, undefined, patientCommand), 401);
  unmarked(await f.call(f.submit, { ...f.admin, csrf: 'wrong' }, adminCommand), 403);
  assert.deepEqual(counts(f.db), effects);
});

test('new commands require explicit normalized fields, ordered unique document links and a matching investigation; malformed requests and UUID collisions do not acquire an outcome', async (t) => {
  const f = await fixture(t),
    a = await f.document('A'),
    b = await f.document('B');
  const input = f.command({ documentIds: [a, b] }),
    before = counts(f.db);
  for (const key of Object.keys(input)) {
    const copy = { ...input };
    delete copy[key as keyof InvestigationResultCommand];
    unmarked(await f.call(f.submit, f.patient, copy), 400);
  }
  for (const patch of [
    { requestId: 'x' },
    { submittedByRole: 'visitor' },
    { note: 'x'.repeat(8001) },
    { note: ' ', documentIds: [] },
    { documentIds: [a, ' ' + a + ' '] },
    { documentIds: Array.from({ length: 11 }, () => randomUUID()) },
    { documentIds: [''] },
    { reviewedConfirmed: false },
    { privateSummary },
  ])
    unmarked(await f.call(f.submit, f.patient, { ...input, ...patch }), 400);
  unmarked(await f.call(f.submit + '?other=1', f.patient, input), 400);
  unmarked(await f.call(f.submit, f.patient, { ...input, patientId: 'patient-2' }), 409);
  unmarked(await f.call('/investigations/missing/results/submit', f.patient, input), 404);
  const second = await f.order();
  unmarked(await f.call('/investigations/' + second.id + '/results/submit', f.patient, input), 409);
  const foreign = await f.order('patient-2');
  unmarked(
    await f.call('/investigations/' + foreign.id + '/results/submit', f.patient, input),
    403,
  );
  assert.deepEqual(counts(f.db), before);
  assert.equal((await f.call(f.submit, f.patient, input)).status, 201);
  const frozen = counts(f.db);
  for (const patch of [{ note: 'different' }, { documentIds: [b, a] }, { documentIds: [] }])
    unmarked(await f.call(f.submit, f.patient, { ...input, ...patch }), 409);
  unmarked(
    await f.call('/investigations/' + second.id + '/results/submit', f.patient, {
      ...input,
      investigationId: second.id,
    }),
    409,
  );
  assert.deepEqual(counts(f.db), frozen);
});

test('closed orders and unavailable report links produce private durable refusals; a success still recovers after cancellation', async (t) => {
  const f = await fixture(t),
    foreign = await f.document('Confidential foreign report title', 'patient-2'),
    missingId = randomUUID();
  const foreignCommand = f.command({ note: '', documentIds: [foreign] }),
    missingCommand = f.command({ documentIds: [missingId] });
  const before = counts(f.db);
  const denied = await f.call(f.submit, f.patient, foreignCommand);
  definitive(denied, 400, f.patient, foreignCommand);
  const unavailable = await f.call(f.submit, f.patient, missingCommand);
  definitive(unavailable, 400, f.patient, missingCommand);
  assert.equal(denied.data.message, unavailable.data.message);
  assert.equal(JSON.stringify(denied.data).includes('Confidential foreign report title'), false);
  unmarked(await f.call(f.resultPath, f.patient, { documentIds: [foreign] }), 400);
  const originalDoc = await f.document('Synthetic available report');
  f.db
    .prepare(
      "INSERT INTO documents(id,patientId,data,bytes) SELECT ?,patientId,json_set(data,'$.id',?,'$.url',?),bytes FROM documents WHERE id=?",
    )
    .run(missingId, missingId, '/api/documents/' + missingId + '/file', originalDoc);
  const retry = await f.call(f.submit, f.patient, missingCommand);
  assert.equal(retry.status, 400);
  assert.deepEqual(retry.data, unavailable.data);
  const fresh = f.command({ note: '', documentIds: [missingId] });
  const saved = await f.call(f.submit, f.patient, fresh);
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  const closed = await f.call(f.base + '/cancel', f.doctor, { reason: 'Synthetic close' });
  assert.equal(closed.status, 200);
  assert.equal((await f.current()).status, 'cancelled');
  const cancelledCommand = f.command(),
    c = await f.call(f.submit, f.patient, cancelledCommand);
  definitive(c, 409, f.patient, cancelledCommand);
  unmarked(await f.call(f.resultPath, f.patient, { note }), 409);
  const frozen = counts(f.db);
  assert.deepEqual(frozen, {
    results: before.results + 1,
    commands: before.commands + 4,
    audits: before.audits + 1,
    notices: before.notices + 1,
  });
  for (const [command, original, status] of [
    [fresh, saved, 200],
    [missingCommand, unavailable, 400],
    [foreignCommand, denied, 400],
    [cancelledCommand, c, 409],
  ] as const) {
    const replay = await f.call(f.submit, f.patient, command);
    assert.equal(replay.status, status);
    assert.deepEqual(replay.data, original.data);
    unmarked(
      await f.call(f.submit, f.patient, { ...command, note: note + ' independently changed' }),
      409,
    );
    unmarked(await f.call(f.submit, f.doctor, { ...command, submittedByRole: 'doctor' }), 409);
  }
  assert.deepEqual(counts(f.db), frozen);
  assert.equal((await f.current()).results.length, 1);
});

test('independent writers serialize identical UUIDs and allow deliberate identical supplements; successes and refusals survive database reopening', async (t) => {
  const f = await fixture(t),
    input = f.command(),
    baseline = counts(f.db);
  const same = await simultaneousCareRequests(f, f.submit, f.patient, input);
  assert.deepEqual(same.map((r) => r.status).sort(), [200, 201]);
  assert.deepEqual(same[0].data, same[1].data);
  const a = f.command(),
    b = f.command();
  const [first, second] = await Promise.all([
    f.call(f.submit, f.patient, a),
    f.call(f.submit, f.patient, b),
  ]);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.notEqual(first.data.receipt.result.id, second.data.receipt.result.id);
  const invalid = f.command({ documentIds: [randomUUID()] });
  const failed = await simultaneousCareRequests(f, f.submit, f.patient, invalid);
  assert.equal(failed[0].status, 400);
  assert.equal(failed[1].status, 400);
  assert.deepEqual(failed[0].data, failed[1].data);
  const expected = {
    results: baseline.results + 3,
    commands: baseline.commands + 4,
    audits: baseline.audits + 3,
    notices: baseline.notices + 3,
  };
  assert.deepEqual(counts(f.db), expected);
  assert.throws(
    () => f.db.exec('UPDATE investigationResultCommands SET rowid=rowid'),
    /append-only/,
  );
  assert.throws(() => f.db.exec('DELETE FROM investigationResultCommands'), /append-only/);
  const history = await f.current();
  await f.close();
  const reopened = await careApiFixture(t, f.databasePath);
  for (const [cmd, original, status] of [
    [input, same[0], 200],
    [a, first, 200],
    [b, second, 200],
    [invalid, failed[0], 400],
  ] as const) {
    const response = await reopened.call(f.submit, f.patient, cmd);
    assert.equal(response.status, status);
    assert.deepEqual(response.data, original.data);
  }
  const latest = await reopened.call('/patients/' + patientId + '/clinical-workflows', f.patient);
  assert.deepEqual(
    (latest.data.investigations as Investigation[]).find((row) => row.id === f.investigation.id),
    history,
  );
  assert.deepEqual(counts(reopened.db), expected);
});

test('failure in result, audit, notification, acceptance or refusal storage leaves the original record and command usable', async (t) => {
  const f = await fixture(t);
  for (const path of [f.resultPath, f.submit]) {
    const input = f.command(),
      body = path === f.submit ? input : { note, documentIds: [] };
    const before = counts(f.db);
    for (const table of [
      'investigationResults',
      'audit',
      'activity',
      ...(path === f.submit ? ['investigationResultCommands'] : []),
    ]) {
      f.db.exec(
        `CREATE TRIGGER fail_investigation_step BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'Synthetic result storage failure'); END`,
      );
      const r = await f.call(path, f.patient, body);
      f.db.exec('DROP TRIGGER fail_investigation_step');
      unmarked(r, 500);
      assert.deepEqual(counts(f.db), before, table);
    }
    assert.equal((await f.call(path, f.patient, body)).status, 201);
  }
  const rejection = f.command({ documentIds: [randomUUID()] }),
    before = counts(f.db);
  f.db.exec(
    "CREATE TRIGGER fail_investigation_step BEFORE INSERT ON investigationResultCommands BEGIN SELECT RAISE(ABORT,'Synthetic refusal storage failure'); END",
  );
  const r = await f.call(f.submit, f.patient, rejection);
  f.db.exec('DROP TRIGGER fail_investigation_step');
  unmarked(r, 500);
  assert.deepEqual(counts(f.db), before);
  definitive(await f.call(f.submit, f.patient, rejection), 400, f.patient, rejection);
});

test('both writers and both stored outcomes reauthorize immediately after taking the writer lock', async (t) => {
  const f = await fixture(t),
    other = openDatabase(f.databasePath);
  t.after(() => other.close());
  for (const who of [f.patient, f.doctor]) {
    const role = who.user.role as InvestigationResultCommand['submittedByRole'];
    const accepted = f.command({ submittedByRole: role }),
      rejected = f.command({ submittedByRole: role, documentIds: [randomUUID()] });
    assert.equal((await f.call(f.submit, who, accepted)).status, 201);
    definitive(await f.call(f.submit, who, rejected), 400, who, rejected);
    const before = counts(f.db),
      user = who.user,
      session = other.prepare('SELECT * FROM sessions WHERE userId=?').get(user.id)!;
    const columns = Object.keys(session),
      mutateUser = (patch: Parameters<typeof changeUser>[2]) => changeUser(other, user, patch);
    const mutations: [string, number, () => unknown][] = [
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
      ['suspended', 401, () => mutateUser({ active: false })],
      ['forced new password', 403, () => mutateUser({ mustChangePassword: true })],
      ['reception', 403, () => mutateUser({ role: 'receptionist' })],
    ];
    if (role === 'patient')
      mutations.push(['relinked patient', 403, () => mutateUser({ patientId: 'patient-2' })]);
    else
      mutations.push(
        ['missing profile', 400, () => mutateUser({ doctorId: 'no-such-profile' })],
        ['unlinked profile', 400, () => mutateUser({ doctorId: undefined })],
      );
    for (const [path, cmd] of [
      [f.resultPath, { note }],
      [f.submit, f.command({ submittedByRole: role })],
      [f.submit, accepted],
      [f.submit, rejected],
    ] as const) {
      for (const [description, status, mutate] of mutations) {
        const r = await beforeTransaction(f.db, 'BEGIN IMMEDIATE', mutate, () =>
          f.call(path, who, cmd),
        );
        assert.equal(r.status, status, description);
        unmarked(r, status);
        assert.deepEqual(counts(f.db), before);
        mutateUser({});
        other.prepare('DELETE FROM mfaCredentials WHERE userId=?').run(user.id);
        other.prepare('DELETE FROM sessions WHERE userId=?').run(user.id);
        other
          .prepare(
            `INSERT INTO sessions(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
          )
          .run(...Object.values(session));
      }
    }
  }
  const fresh = f.command(),
    before = counts(f.db);
  const closed = await beforeTransaction(
    f.db,
    'BEGIN IMMEDIATE',
    () =>
      other
        .prepare('INSERT INTO investigationCancellations(id,data) VALUES (?,?)')
        .run(
          f.investigation.id,
          JSON.stringify({ id: f.investigation.id, reason: 'Synthetic cancellation' }),
        ),
    () => f.call(f.submit, f.patient, fresh),
  );
  definitive(closed, 409, f.patient, fresh);
  assert.deepEqual(counts(f.db), { ...before, commands: before.commands + 1 });
});
