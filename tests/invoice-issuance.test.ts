import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { InvoiceIssuanceCommand } from '../shared/invoice-issuance.ts';
import type { Patient, User } from '../shared/types.ts';
import { get, openDatabase, type DB } from '../server/db.ts';
import {
  beforeTransaction,
  careApiFixture,
  changeUser,
  simultaneousCareRequests,
  type Client,
} from './fixtures/care-api.ts';

const path = '/invoices/issue',
  legacy = '/invoices',
  patientId = 'patient-ananya';
function command(procedureId?: string): InvoiceIssuanceCommand {
  return {
    requestId: randomUUID(),
    patientId,
    reviewedConfirmed: true,
    ...(procedureId ? { procedureId } : {}),
    items: [
      { description: 'Synthetic visit fee', quantity: 2, unitAmountPaise: 14550 },
      { description: 'Synthetic record copy', quantity: 3, unitAmountPaise: 3 },
    ],
  };
}
function oldBody({ reviewedConfirmed, ...fields }: InvoiceIssuanceCommand) {
  return fields;
}
async function procedure(f: Awaited<ReturnType<typeof careApiFixture>>, doctor: Client) {
  const response = await f.call('/procedures', doctor, {
    patientId,
    title: 'Synthetic billing procedure',
    indication: 'Private indication',
    benefits: 'Discussed',
    risks: 'Reviewed',
    alternatives: 'Reviewed',
    aftercare: 'Discussion',
    estimatedCost: 'Individual estimate',
  });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  return response.data;
}
function counts(db: DB) {
  const count = (table: string) => Number(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n);
  return {
    invoices: count('invoices'),
    links: count('procedureInvoiceLinks'),
    audits: count('audit'),
    activity: count('activity'),
    commands: count('invoiceIssuanceCommands'),
    serial: Number(db.prepare('SELECT nextValue FROM invoiceSequence WHERE id=1').get()!.nextValue),
  };
}

test('staff issue, recover and view an invoice with one sequence number, creation audit and owning-patient notice', async (t) => {
  const f = await careApiFixture(t),
    reception = await f.login('reception'),
    doctor = await f.login('doctor'),
    admin = await f.login('admin'),
    patient = await f.login('patient');
  assert.equal((await f.call(path, undefined, command())).status, 401);
  assert.equal((await f.call(path, patient, command())).status, 403);
  for (const [issuer, other] of [
    [reception, doctor],
    [doctor, admin],
    [admin, reception],
  ]) {
    const input = command(),
      before = counts(f.db);
    const response = await f.call(path, issuer, {
      ...input,
      requestId: input.requestId.toUpperCase(),
      items: input.items.map((line) => ({ ...line, description: '  ' + line.description + ' ' })),
    });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    const invoice = response.data.receipt.invoice;
    assert.match(invoice.id, /^[a-f0-9-]{36}$/);
    assert.equal(new Date(invoice.createdAt).toISOString(), invoice.createdAt);
    assert.deepEqual(response.data, {
      receipt: {
        requestId: input.requestId,
        actorId: issuer.user.id,
        patientId,
        invoice: {
          id: invoice.id,
          number: `INV-${String(before.serial).padStart(6, '0')}`,
          patientId,
          patientName: get<Patient>(f.db, 'patients', patientId)!.name,
          items: input.items,
          totalPaise: 29109,
          paidPaise: 0,
          status: 'unpaid',
          createdAt: invoice.createdAt,
        },
      },
    });
    const retry = await f.call(path, issuer, input);
    assert.equal(retry.status, 200);
    assert.deepEqual(retry.data, response.data);
    assert.deepEqual((await f.call(legacy, issuer, oldBody(input))).data, invoice);
    for (const endpoint of [legacy, path]) {
      const denied = await f.call(endpoint, other, input);
      assert.equal(denied.status, 409);
      assert.deepEqual(Object.keys(denied.data), ['error']);
    }
    for (const different of [
      { ...input, patientId: 'patient-2' },
      { ...input, procedureId: 'other' },
      { ...input, items: input.items.slice().reverse() },
      { ...input, items: [{ ...input.items[0], quantity: 1 }] },
      { ...input, items: [{ ...input.items[0], description: 'Different' }] },
      { ...input, items: [{ ...input.items[0], unitAmountPaise: 1 }] },
    ])
      assert.equal((await f.call(path, issuer, different)).status, 409);
    assert.deepEqual(counts(f.db), {
      ...before,
      invoices: before.invoices + 1,
      commands: before.commands + 1,
      activity: before.activity + 1,
      audits: before.audits + 1,
      serial: before.serial + 1,
    });
    const detail = await f.call('/invoices/' + invoice.id, patient);
    assert.deepEqual(detail.data.invoice, invoice);
    assert.deepEqual(detail.data.payments, []);
    for (const projection of [
      detail.data,
      (await f.call('/activity', patient)).data,
      (await f.call('/patients/' + patientId + '/care-summary', patient)).data,
    ]) {
      for (const secret of [
        input.requestId,
        'invoiceIssuanceCommands',
        'payloadHash',
        'originalInvoice',
      ])
        assert.ok(!JSON.stringify(projection).includes(secret));
    }
  }
});

test('financial changes and later procedure cancellation preserve original issuance; the legacy route still returns the current invoice', async (t) => {
  const f = await careApiFixture(t),
    staff = await f.login('reception'),
    doctor = await f.login('doctor');
  const source = await procedure(f, doctor),
    input = command(source.id);
  const first = await f.call(legacy, staff, oldBody(input));
  assert.equal(first.status, 201);
  const original = first.data,
    read = '/invoices/' + original.id;
  assert.equal(original.procedureId, source.id);
  assert.equal(original.procedureTitle, source.title);
  const receipt = {
    receipt: { requestId: input.requestId, actorId: staff.user.id, patientId, invoice: original },
  };
  const issued = await f.call(path, staff, input);
  assert.equal(issued.status, 200);
  assert.deepEqual(issued.data, receipt);
  const paid = await f.call(read + '/payments', staff, {
    requestId: randomUUID(),
    method: 'cash',
    amountPaise: 100,
  });
  assert.equal(paid.status, 201);
  const corrected = await f.call(read + '/corrections', await f.login('admin'), {
    requestId: randomUUID(),
    items: [{ description: 'Corrected charges', quantity: 1, unitAmountPaise: 100 }],
    expectedRevision: paid.data.revision,
    reason: 'Synthetic correction',
  });
  assert.equal(corrected.status, 200, JSON.stringify(corrected.data));
  assert.equal(corrected.data.invoice.status, 'paid');
  assert.equal(
    (
      await f.call('/procedures/' + source.id + '/cancel', doctor, {
        reason: 'Synthetic procedure cancellation',
      })
    ).status,
    200,
  );
  f.db
    .prepare("UPDATE patients SET data=json_set(data,'$.name','Updated patient') WHERE id=?")
    .run(patientId);
  changeUser(f.db, get<User>(f.db, 'users', staff.user.id)!, { name: 'New issuer name' });
  assert.deepEqual((await f.call(path, staff, input)).data, receipt);
  assert.deepEqual((await f.call(legacy, staff, input)).data, corrected.data.invoice);
  const projection = (await f.call('/procedure-billing?patientId=' + patientId, staff)).data.find(
    (row: { id: string }) => row.id === source.id,
  );
  assert.equal(projection.invoiceId, original.id);
  assert.equal(projection.status, 'cancelled');
});

test('unknown pre-upgrade UUIDs are never adopted or reissued, even across upper/lower case and ambiguous historical rows', async (t) => {
  const f = await careApiFixture(t),
    issuer = await f.login('admin'),
    patient = await f.login('patient');
  const input = command(),
    ids: string[] = [];
  for (const spelling of [input.requestId.toUpperCase(), input.requestId.toLowerCase()]) {
    const { requestId, ...body } = oldBody(input);
    const row = await f.call(legacy, issuer, body);
    assert.equal(row.status, 201);
    f.db.prepare('UPDATE invoices SET requestId=? WHERE id=?').run(spelling, row.data.id);
    ids.push(row.data.id);
    const before = counts(f.db);
    for (const endpoint of [legacy, path])
      for (const requestId of [input.requestId, input.requestId.toUpperCase()]) {
        const denied = await f.call(endpoint, issuer, { ...input, requestId });
        assert.equal(denied.status, 409);
        assert.deepEqual(Object.keys(denied.data), ['error']);
      }
    assert.deepEqual(counts(f.db), before);
  }
  assert.equal(counts(f.db).commands, 0);
  for (const id of ids) assert.equal((await f.call('/invoices/' + id, patient)).status, 200);
  const deliberate = await f.call(path, issuer, { ...input, requestId: randomUUID() });
  assert.equal(deliberate.status, 201);
  assert.ok(!ids.includes(deliberate.data.receipt.invoice.id));
});

test('procedure rejections bind actor, patient and exact charges, survive new eligibility, and only a new request can issue', async (t) => {
  const f = await careApiFixture(t),
    reception = await f.login('reception'),
    doctor = await f.login('doctor');
  const first = await procedure(f, doctor),
    second = await procedure(f, doctor);
  assert.equal(
    (await f.call('/procedures/' + first.id + '/cancel', doctor, { reason: 'Synthetic change' }))
      .status,
    200,
  );
  assert.equal((await f.call(path, reception, command(second.id))).status, 201);
  const missingId = randomUUID(),
    missing = command(missingId);
  const before = counts(f.db);
  for (const [input, status] of [
    [missing, 400],
    [{ ...command(first.id), patientId: 'patient-2' }, 400],
    [command(first.id), 409],
    [command(second.id), 409],
  ] as const) {
    const denied = await f.call(path, reception, input);
    assert.equal(denied.status, status);
    assert.deepEqual(denied.data, {
      code: 'INVOICE_NOT_ISSUED',
      actorId: reception.user.id,
      command: input,
      message: denied.data.message,
    });
    assert.equal(typeof denied.data.message, 'string');
    assert.deepEqual((await f.call(path, reception, input)).data, denied.data);
    const old = await f.call(legacy, reception, oldBody(input));
    assert.equal(old.status, status);
    assert.equal(old.data.code, undefined);
    for (const different of [
      { ...input, procedureId: undefined },
      { ...input, items: input.items.slice().reverse() },
    ]) {
      const changed = await f.call(path, reception, different);
      assert.equal(changed.status, 409);
      assert.equal(changed.data.code, undefined);
    }
    assert.equal((await f.call(path, doctor, input)).data.code, undefined);
  }
  assert.deepEqual(counts(f.db), { ...before, commands: before.commands + 4 });
  const data = { ...second, id: missingId, title: 'Now available' };
  f.db
    .prepare('INSERT INTO procedures(id,patientId,data) VALUES (?,?,?)')
    .run(missingId, patientId, JSON.stringify(data));
  assert.equal((await f.call(path, reception, missing)).status, 400);
  assert.equal(
    (await f.call(path, reception, { ...missing, requestId: randomUUID() })).status,
    201,
  );
});

test('strict review validates the complete command and integer charges while the legacy parser preserves older input shapes', async (t) => {
  const f = await careApiFixture(t),
    staff = await f.login('reception'),
    input = command(),
    before = counts(f.db);
  for (const bad of [
    { ...input, reviewedConfirmed: false },
    { ...input, reviewedConfirmed: undefined },
    { ...input, requestId: undefined },
    { ...input, requestId: 'bad' },
    { ...input, patientId: ' ' },
    { ...input, procedureId: '' },
    { ...input, extra: true },
    { ...input, items: [{ ...input.items[0], extra: true }] },
    { ...input, items: [] },
    { ...input, items: Array.from({ length: 101 }, () => input.items[0]) },
    { ...input, items: [{ ...input.items[0], description: '  ' }] },
    { ...input, items: [{ ...input.items[0], quantity: 1001 }] },
    { ...input, items: [{ ...input.items[0], unitAmountPaise: 1.5 }] },
    { ...input, items: [{ ...input.items[0], unitAmountPaise: 1_000_000_000, quantity: 2 }] },
  ]) {
    const error = await f.call(path, staff, bad);
    assert.equal(error.status, 400, JSON.stringify(error.data));
    assert.equal(error.data.code, undefined);
  }
  assert.equal((await f.call(path + '?noncanonical=1', staff, input)).status, 400);
  const noPatient = await f.call(path, staff, { ...input, patientId: 'missing' });
  assert.equal(noPatient.status, 404);
  assert.equal(noPatient.data.code, undefined);
  assert.deepEqual(counts(f.db), before);
  const compat = await f.call(legacy, staff, {
    ...oldBody(input),
    extra: 'strip',
    items: [{ ...input.items[0], extra: 0 }],
  });
  assert.equal(compat.status, 201);
  assert.equal(compat.data.items[0].extra, undefined);
  const limit = await f.call(path, staff, {
    ...command(),
    items: [{ description: 'Boundary', quantity: 1000, unitAmountPaise: 1_000_000 }],
  });
  assert.equal(limit.status, 201);
  assert.equal(limit.data.receipt.invoice.totalPaise, 1_000_000_000);
});

test('each new or legacy write rolls back invoice, link, sequence number, notice, audit and command together', async (t) => {
  const f = await careApiFixture(t),
    doctor = await f.login('doctor'),
    source = await procedure(f, doctor);
  for (const endpoint of [path, legacy]) {
    const input = command(source.id),
      before = counts(f.db);
    for (const [event, table] of [
      ['INSERT', 'invoices'],
      ['INSERT', 'procedureInvoiceLinks'],
      ['UPDATE', 'invoiceSequence'],
      ['INSERT', 'audit'],
      ['INSERT', 'activity'],
      ['INSERT', 'invoiceIssuanceCommands'],
    ]) {
      f.db.exec(
        `CREATE TRIGGER synthetic_issuance_failure BEFORE ${event} ON ${table} BEGIN SELECT RAISE(ABORT,'Synthetic issuance write failure'); END;`,
      );
      try {
        const failed = await f.call(endpoint, doctor, input);
        assert.equal(failed.status, 500, table);
        assert.equal(failed.data.code, undefined);
        assert.deepEqual(counts(f.db), before, table);
      } finally {
        f.db.exec('DROP TRIGGER synthetic_issuance_failure');
      }
    }
  }
  const denied = command(randomUUID()),
    before = counts(f.db);
  f.db.exec(
    "CREATE TRIGGER synthetic_rejection_failure BEFORE INSERT ON invoiceIssuanceCommands BEGIN SELECT RAISE(ABORT,'Synthetic issuance rejection failure'); END;",
  );
  try {
    const failure = await f.call(path, doctor, denied);
    assert.equal(failure.status, 500);
    assert.equal(failure.data.code, undefined);
    assert.deepEqual(counts(f.db), before);
  } finally {
    f.db.exec('DROP TRIGGER synthetic_rejection_failure');
  }
  assert.equal((await f.call(path, doctor, denied)).status, 400);
  assert.equal((await f.call(path, doctor, command(source.id))).status, 201);
});

test('two server processes issue once, competing procedure claims cannot double-charge and original successes and rejections survive restart', async (t) => {
  const f = await careApiFixture(t),
    doctor = await f.login('doctor'),
    source = await procedure(f, doctor),
    input = command(source.id);
  const before = counts(f.db);
  const results = await simultaneousCareRequests(f, path, doctor, input);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 201]);
  assert.deepEqual(results[0].data, results[1].data);
  assert.deepEqual(counts(f.db), {
    invoices: before.invoices + 1,
    links: before.links + 1,
    commands: before.commands + 1,
    audits: before.audits + 1,
    activity: before.activity + 1,
    serial: before.serial + 1,
  });
  const competing = { ...input, requestId: randomUUID() },
    rejection = await f.call(path, doctor, competing);
  assert.equal(rejection.status, 409);
  assert.equal(rejection.data.code, 'INVOICE_NOT_ISSUED');
  const intentional = command();
  const a = await f.call(path, doctor, intentional),
    b = await f.call(path, doctor, { ...intentional, requestId: randomUUID() });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.notEqual(a.data.receipt.invoice.id, b.data.receipt.invoice.id);
  assert.throws(() => f.db.exec('UPDATE invoiceIssuanceCommands SET rowid=rowid'), /immutable/);
  assert.throws(() => f.db.exec('DELETE FROM invoiceIssuanceCommands'), /immutable/);
  await f.close();
  const next = await careApiFixture(t, f.databasePath);
  const previous = counts(next.db);
  assert.deepEqual((await next.call(path, doctor, input)).data, results[0].data);
  assert.deepEqual((await next.call(path, doctor, competing)).data, rejection.data);
  assert.deepEqual(counts(next.db), previous);
  await next.close();
});

test('new issuance, historical-key conflicts and both adapters recheck current staff access under lock before revealing any outcome', async (t) => {
  const f = await careApiFixture(t),
    staff = await f.login('reception'),
    other = openDatabase(f.databasePath);
  t.after(() => other.close());
  const original = command(),
    denied = command(randomUUID()),
    historical = command();
  assert.equal((await f.call(path, staff, original)).status, 201);
  assert.equal((await f.call(path, staff, denied)).status, 400);
  const existing = await f.call(legacy, staff, { patientId, items: historical.items });
  assert.equal(existing.status, 201);
  f.db
    .prepare('UPDATE invoices SET requestId=? WHERE id=?')
    .run(historical.requestId, existing.data.id);
  const user = get<User>(other, 'users', staff.user.id)!,
    session = other.prepare('SELECT * FROM sessions WHERE userId=?').get(user.id)!;
  const cases: [string, number, () => unknown][] = [
    ['revocation', 401, () => other.prepare('DELETE FROM sessions WHERE userId=?').run(user.id)],
    [
      'expiry',
      401,
      () => other.prepare('UPDATE sessions SET expiresAt=0 WHERE userId=?').run(user.id),
    ],
    [
      'CSRF',
      401,
      () => other.prepare("UPDATE sessions SET csrfToken='rotated' WHERE userId=?").run(user.id),
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
    ['suspension', 401, () => changeUser(other, user, { active: false })],
    ['password rotation', 403, () => changeUser(other, user, { mustChangePassword: true })],
    ['role', 403, () => changeUser(other, user, { role: 'patient', patientId: 'patient-2' })],
  ];
  const before = counts(f.db);
  for (const endpoint of [path, legacy])
    for (const input of [command(), original, denied, historical]) {
      for (const [label, status, change] of cases) {
        const result = await beforeTransaction(f.db, 'BEGIN IMMEDIATE', change, () =>
          f.call(endpoint, staff, input),
        );
        assert.equal(result.status, status, endpoint + ' ' + label);
        assert.deepEqual(Object.keys(result.data), ['error']);
        assert.deepEqual(counts(f.db), before);
        changeUser(other, user, {});
        other.prepare('DELETE FROM mfaCredentials WHERE userId=?').run(user.id);
        other.prepare('DELETE FROM sessions WHERE userId=?').run(user.id);
        const columns = Object.keys(session);
        other
          .prepare(
            `INSERT INTO sessions(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
          )
          .run(...Object.values(session));
      }
    }
  const fresh = await beforeTransaction(
    f.db,
    'BEGIN IMMEDIATE',
    () =>
      other
        .prepare(
          "UPDATE patients SET data=json_set(data,'$.name','Current billing name') WHERE id=?",
        )
        .run(patientId),
    () => f.call(path, staff, command()),
  );
  assert.equal(fresh.status, 201);
  assert.equal(fresh.data.receipt.invoice.patientName, 'Current billing name');
  const doctor = await f.login('doctor'),
    source = await procedure(f, doctor),
    input = command(source.id);
  const blocked = await beforeTransaction(
    f.db,
    'BEGIN IMMEDIATE',
    () =>
      other.prepare("INSERT INTO procedureCancellations(id,data) VALUES (?,'{}')").run(source.id),
    () => f.call(path, staff, input),
  );
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.code, 'INVOICE_NOT_ISSUED');
  assert.deepEqual((await f.call(path, staff, input)).data, blocked.data);
});
