import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Invoice, InvoiceDetail, Payment } from '../shared/operations.ts';
import type { PaymentRecordingCommand } from '../shared/payment-recording.ts';
import type { User } from '../shared/types.ts';
import { get, openDatabase, type DB } from '../server/db.ts';
import { invoiceDetail } from '../server/billing-corrections.ts';
import {
  beforeTransaction,
  careApiFixture,
  changeUser,
  simultaneousCareRequests,
  type Client,
} from './fixtures/care-api.ts';

type Fixture = Awaited<ReturnType<typeof careApiFixture>>;
const patientId = 'patient-ananya';

async function invoice(f: Fixture, staff: Client, total = 1000, patient = patientId) {
  const response = await f.call('/invoices', staff, {
    patientId: patient,
    items: [{ description: 'Synthetic service', quantity: 1, unitAmountPaise: total }],
  });
  assert.equal(response.status, 201);
  return response.data as Invoice;
}
function paths(bill: Invoice) {
  const read = '/invoices/' + bill.id,
    legacy = read + '/payments';
  return { read, legacy, reviewed: legacy + '/record' };
}
function live(db: DB, bill: Invoice): InvoiceDetail {
  return invoiceDetail(db, get<Invoice>(db, 'invoices', bill.id)!);
}
function command(db: DB, bill: Invoice, amountPaise = 101): PaymentRecordingCommand {
  return {
    requestId: randomUUID(),
    patientId: bill.patientId,
    amountPaise,
    reference: 'Synthetic receipt',
    method: 'upi',
    expectedRevision: live(db, bill).revision,
    receivedExternallyConfirmed: true,
  };
}
function legacyBody({ amountPaise, method, reference, requestId }: PaymentRecordingCommand) {
  return { amountPaise, method, reference, requestId };
}
function state(db: DB, bill: Invoice) {
  const count = (table: string) => Number(db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n);
  return {
    paidPaise: live(db, bill).invoice.paidPaise,
    payments: count('payments'),
    commands: count('paymentRecordingCommands'),
    activity: count('activity'),
    audits: count('audit'),
  };
}
function unmarked(response: { status: number; data: unknown }, status: number) {
  assert.equal(response.status, status, JSON.stringify(response.data));
  assert.deepEqual(Object.keys(response.data as object), ['error']);
}

test('recording a reviewed receipt binds its recorder and invoice, balances and exact paise; private commands stay out of ordinary records', async (t) => {
  const f = await careApiFixture(t),
    staff = await f.login('reception'),
    patient = await f.login('patient'),
    doctor = await f.login('doctor'),
    admin = await f.login('admin');
  const bill = await invoice(f, staff),
    p = paths(bill);
  for (const [recorder, method] of [
    [staff, 'upi'],
    [doctor, 'bank'],
    [admin, 'card'],
    [staff, 'cash'],
  ] as const) {
    const input = {
      ...command(f.db, bill),
      method,
      reference: method === 'cash' ? '' : 'Synthetic receipt',
    };
    const before = state(f.db, bill);
    const result = await f.call(p.reviewed, recorder, {
      ...input,
      requestId: input.requestId.toUpperCase(),
      reference: ' ' + input.reference + ' ',
    });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    const { payment } = result.data.receipt;
    assert.match(payment.id, /^[a-f0-9-]{36}$/);
    assert.equal(new Date(payment.createdAt).toISOString(), payment.createdAt);
    assert.deepEqual(result.data, {
      receipt: {
        requestId: input.requestId,
        actorId: recorder.user.id,
        invoiceId: bill.id,
        patientId,
        expectedRevision: input.expectedRevision,
        invoiceNumber: bill.number,
        totalPaise: 1000,
        beforePaidPaise: before.paidPaise,
        afterPaidPaise: before.paidPaise + 101,
        payment: {
          id: payment.id,
          createdAt: payment.createdAt,
          amountPaise: 101,
          method,
          reference: input.reference,
          invoiceId: bill.id,
        },
      },
    });
    const replay = await f.call(p.reviewed, recorder, input);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.data, result.data);
    assert.deepEqual(state(f.db, bill), {
      paidPaise: before.paidPaise + 101,
      payments: before.payments + 1,
      commands: before.commands + 1,
      activity: before.activity + 1,
      audits: before.audits + 1,
    });
    const current = await f.call(p.read, patient);
    assert.equal(current.status, 200);
    const entry: Payment = current.data.payments.find((x: Payment) => x.id === payment.id);
    assert.equal(entry.amountPaise, 101);
    assert.notEqual(entry.requestId, input.requestId);
    const activity = await f.call('/activity?limit=100', patient);
    assert.equal(
      activity.data.items.filter(
        (x: { title: string; href: string }) =>
          x.title === 'Your clinic recorded a received payment' && x.href.endsWith(bill.id),
      ).length,
      current.data.payments.length,
    );
    for (const projection of [
      current.data,
      activity.data,
      (await f.call('/patients/' + patientId + '/care-summary', patient)).data,
    ]) {
      const json = JSON.stringify(projection);
      for (const privateValue of [
        input.requestId,
        'receivedExternallyConfirmed',
        'beforePaidPaise',
        'expectedRevision',
      ])
        assert.ok(!json.includes(privateValue), privateValue);
    }
  }
});

test('corrections, subsequent collections, refunds, refund voids and reversal cannot alter or reapply the original confirmation', async (t) => {
  const f = await careApiFixture(t),
    staff = await f.login('doctor'),
    admin = await f.login('admin'),
    bill = await invoice(f, staff),
    p = paths(bill),
    input = command(f.db, bill, 125);
  const result = await f.call(p.reviewed, staff, input),
    paymentId = result.data.receipt.payment.id;
  assert.equal(result.status, 201);
  const other = await f.call(p.legacy, admin, {
    amountPaise: 50,
    method: 'cash',
    requestId: randomUUID(),
  });
  assert.equal(other.status, 201);
  async function replay() {
    const before = state(f.db, bill);
    assert.deepEqual((await f.call(p.reviewed, staff, input)).data, result.data);
    assert.deepEqual(state(f.db, bill), before);
  }
  await replay();
  const refunded = await f.call(p.legacy + '/' + paymentId + '/refunds', admin, {
    expectedRevision: other.data.revision,
    requestId: randomUUID(),
    amountPaise: 25,
    method: 'cash',
    reference: '',
    reason: 'Synthetic return',
    refundedExternallyConfirmed: true,
  });
  assert.equal(refunded.status, 201, JSON.stringify(refunded.data));
  await replay();
  const voided = await f.call(p.read + '/refunds/' + refunded.data.refund.id + '/void', admin, {
    expectedRevision: refunded.data.detail.revision,
    requestId: randomUUID(),
    reason: 'Synthetic adjustment',
    entryErrorConfirmed: true,
  });
  assert.equal(voided.status, 201, JSON.stringify(voided.data));
  await replay();
  const reversed = await f.call(p.legacy + '/' + paymentId + '/reverse', admin, {
    expectedRevision: voided.data.detail.revision,
    requestId: randomUUID(),
    reason: 'Synthetic error',
    entryErrorConfirmed: true,
  });
  assert.equal(reversed.status, 200, JSON.stringify(reversed.data));
  await replay();
  const correction = await f.call(p.read + '/corrections', admin, {
    expectedRevision: reversed.data.revision,
    requestId: randomUUID(),
    reason: 'Corrected synthetic charge',
    items: [{ description: 'Corrected charge', quantity: 1, unitAmountPaise: 50 }],
  });
  assert.equal(correction.status, 200, JSON.stringify(correction.data));
  assert.equal(correction.data.invoice.status, 'paid');
  await replay();
  assert.deepEqual(live(f.db, bill), correction.data);
});

test('durable stale and over-balance decisions survive renewed eligibility, while unknown outcomes reveal no command evidence', async (t) => {
  const f = await careApiFixture(t),
    staff = await f.login('reception'),
    admin = await f.login('admin'),
    bill = await invoice(f, staff),
    p = paths(bill);
  const amount = command(f.db, bill, 1010),
    stale = { ...command(f.db, bill), expectedRevision: 'a'.repeat(64) };
  const before = state(f.db, bill);
  const rejected = [];
  for (const input of [stale, amount]) {
    const response = await f.call(p.reviewed, staff, input);
    assert.equal(response.status, 409);
    assert.deepEqual(response.data, {
      code: 'PAYMENT_NOT_RECORDED',
      actorId: staff.user.id,
      invoiceId: bill.id,
      command: input,
      message: response.data.message,
    });
    assert.ok(response.data.message);
    rejected.push(response.data);
    unmarked(await f.call(p.reviewed, admin, input), 409);
    unmarked(await f.call(p.reviewed, staff, { ...input, amountPaise: 1 }), 409);
    unmarked(await f.call(p.reviewed, staff, { ...input, expectedRevision: 'b'.repeat(64) }), 409);
    unmarked(await f.call(p.legacy, staff, legacyBody(input)), 409);
  }
  assert.deepEqual(state(f.db, bill), { ...before, commands: before.commands + 2 });
  const correction = await f.call(p.read + '/corrections', admin, {
    expectedRevision: amount.expectedRevision,
    requestId: randomUUID(),
    reason: 'Synthetic new agreed charges',
    items: [{ description: 'Updated', quantity: 1, unitAmountPaise: 1010 }],
  });
  assert.equal(correction.status, 200);
  assert.deepEqual((await f.call(p.reviewed, staff, stale)).data, rejected[0]);
  assert.deepEqual((await f.call(p.reviewed, staff, amount)).data, rejected[1]);
  const refreshed = await f.call(p.reviewed, staff, command(f.db, bill, 1010));
  assert.equal(refreshed.status, 201);
  assert.equal(live(f.db, bill).invoice.status, 'paid');
});

test('request identity covers both writers, recording staff, invoice and reviewed values, while older record UUIDs are never adopted', async (t) => {
  const f = await careApiFixture(t),
    staff = await f.login('reception'),
    other = await f.login('doctor'),
    patient = await f.login('patient'),
    a = await invoice(f, staff),
    b = await invoice(f, staff),
    pa = paths(a),
    pb = paths(b);
  const original = command(f.db, a),
    saved = await f.call(pa.reviewed, staff, original);
  assert.equal(saved.status, 201);
  const legacy = legacyBody(command(f.db, a, 22));
  legacy.requestId = legacy.requestId.toUpperCase();
  const old = await f.call(pa.legacy, staff, { ...legacy, strip: 'extra' });
  assert.equal(old.status, 201);
  assert.equal(old.data.payments[1].requestId, legacy.requestId);
  assert.deepEqual(
    (await f.call(pa.legacy, staff, { ...legacy, requestId: legacy.requestId.toLowerCase() })).data,
    old.data,
  );
  const before = state(f.db, a);
  for (const changes of [
    { amountPaise: 99 },
    { method: 'card' },
    { reference: 'Different' },
    { patientId: 'patient-2' },
    { expectedRevision: 'b'.repeat(64) },
  ]) {
    unmarked(await f.call(pa.reviewed, staff, { ...original, ...changes }), 409);
  }
  unmarked(await f.call(pa.reviewed, other, original), 409);
  unmarked(await f.call(pb.reviewed, staff, original), 409);
  unmarked(await f.call(pa.legacy, staff, legacyBody(original)), 409);
  unmarked(await f.call(pa.reviewed, staff, { ...original, requestId: legacy.requestId }), 409);
  unmarked(await f.call(pa.legacy, other, legacy), 409);
  unmarked(await f.call(pb.legacy, staff, legacy), 409);
  unmarked(await f.call(pa.reviewed, patient, original), 403);
  unmarked(await f.call(pa.reviewed, undefined, original), 401);
  unmarked(await f.call('/invoices/missing/payments/record', staff, original), 404);
  assert.deepEqual(state(f.db, a), before);
  const key = randomUUID().toUpperCase();
  for (const [bill, requestId] of [
    [a, key],
    [b, key.toLowerCase()],
  ] as const) {
    const row = {
      requestId,
      id: randomUUID(),
      invoiceId: bill.id,
      reference: '',
      createdAt: new Date().toISOString(),
      amountPaise: 1,
      method: 'cash',
    };
    f.db
      .prepare('INSERT INTO payments(id,invoiceId,requestId,data) VALUES (?,?,?,?)')
      .run(row.id, bill.id, requestId, JSON.stringify(row));
    f.db
      .prepare(
        "UPDATE invoices SET data=json_set(data,'$.paidPaise',json_extract(data,'$.paidPaise')+1,'$.status','partial') WHERE id=?",
      )
      .run(bill.id);
  }
  const afterSeed = state(f.db, a);
  for (const p of [pa, pb]) {
    const historical = {
      ...command(f.db, a, 1),
      requestId: key.toLowerCase(),
      method: 'cash',
      reference: '',
    };
    unmarked(await f.call(p.legacy, staff, historical), 409);
    unmarked(await f.call(p.reviewed, staff, historical), 409);
    const records = await f.call(p.read, patient);
    assert.ok(records.data.payments.some((row: Payment) => row.requestId.toUpperCase() === key));
  }
  assert.equal(state(f.db, a).commands, afterSeed.commands);
  assert.equal(state(f.db, a).payments, afterSeed.payments);
});

test('strict payment review validates invoice state, confirmed receipt, integer paise and supported methods before reserving any key', async (t) => {
  const f = await careApiFixture(t),
    staff = await f.login('admin'),
    bill = await invoice(f, staff, 1_000_000_000),
    p = paths(bill),
    input = command(f.db, bill);
  const before = state(f.db, bill);
  for (const changes of [
    { receivedExternallyConfirmed: false },
    { receivedExternallyConfirmed: undefined },
    { patientId: '' },
    { patientId: undefined },
    { expectedRevision: 'invalid' },
    { expectedRevision: undefined },
    { expectedRevision: 'A'.repeat(64) },
    { amountPaise: 1.5 },
    { amountPaise: 0 },
    { amountPaise: -1 },
    { amountPaise: 1_000_000_001 },
    { amountPaise: '1' },
    { requestId: 'bad' },
    { requestId: undefined },
    { method: 'transfer' },
    { reference: undefined },
    { reference: 'r'.repeat(201) },
    { extra: true },
  ]) {
    unmarked(await f.call(p.reviewed, staff, { ...input, ...changes }), 400);
  }
  unmarked(await f.call(p.reviewed + '?unexpected=1', staff, input), 400);
  unmarked(await f.call(p.reviewed, staff, { ...input, patientId: 'other' }), 409);
  assert.deepEqual(state(f.db, bill), before);
  const limit = await f.call(p.reviewed, staff, {
    ...input,
    amountPaise: 1_000_000_000,
    reference: '',
    method: 'bank',
  });
  assert.equal(limit.status, 201);
  assert.equal(limit.data.receipt.afterPaidPaise, 1_000_000_000);
  assert.equal(limit.data.receipt.payment.reference, '');
  const legacyInvoice = await invoice(f, staff, 1);
  const plain = await f.call(paths(legacyInvoice).legacy, staff, {
    requestId: randomUUID(),
    method: 'cash',
    amountPaise: 1,
    extra: 'ignored',
  });
  assert.equal(plain.status, 201);
  assert.equal(plain.data.payments[0].reference, '');
  assert.equal(plain.data.invoice.status, 'paid');
});

test('failed payment, balance, audit, notice, receipt and durable rejection writes roll back both adapters completely', async (t) => {
  const f = await careApiFixture(t),
    staff = await f.login('reception'),
    bill = await invoice(f, staff),
    p = paths(bill);
  for (const adapter of ['reviewed', 'legacy'] as const) {
    const input = command(f.db, bill),
      before = state(f.db, bill);
    for (const [op, table] of [
      ['INSERT', 'payments'],
      ['UPDATE', 'invoices'],
      ['INSERT', 'audit'],
      ['INSERT', 'activity'],
      ['INSERT', 'paymentRecordingCommands'],
    ]) {
      f.db.exec(
        `CREATE TRIGGER synthetic_payment_failure BEFORE ${op} ON ${table} BEGIN SELECT RAISE(ABORT,'Synthetic payment write failure'); END;`,
      );
      try {
        unmarked(
          await f.call(p[adapter], staff, adapter === 'reviewed' ? input : legacyBody(input)),
          500,
        );
        assert.deepEqual(state(f.db, bill), before);
      } finally {
        f.db.exec('DROP TRIGGER synthetic_payment_failure');
      }
    }
    assert.equal((await f.call(p[adapter], staff, input)).status, 201);
  }
  const stale = { ...command(f.db, bill), expectedRevision: 'a'.repeat(64) },
    before = state(f.db, bill);
  f.db.exec(
    "CREATE TRIGGER synthetic_payment_rejection BEFORE INSERT ON paymentRecordingCommands BEGIN SELECT RAISE(ABORT,'Synthetic rejection write failure'); END;",
  );
  try {
    unmarked(await f.call(p.reviewed, staff, stale), 500);
    assert.deepEqual(state(f.db, bill), before);
  } finally {
    f.db.exec('DROP TRIGGER synthetic_payment_rejection');
  }
  assert.equal((await f.call(p.reviewed, staff, stale)).data.code, 'PAYMENT_NOT_RECORDED');
});

test('independent writers serialize repeated requests; competing reviewed balances and restart preserve exact outcomes', async (t) => {
  const f = await careApiFixture(t),
    staff = await f.login('doctor'),
    bill = await invoice(f, staff, 1000),
    p = paths(bill);
  const first = command(f.db, bill, 300),
    before = state(f.db, bill);
  const both = await simultaneousCareRequests(f, p.reviewed, staff, first);
  assert.deepEqual(both.map((x) => x.status).sort(), [200, 201]);
  assert.deepEqual(both[0].data, both[1].data);
  assert.deepEqual(state(f.db, bill), {
    paidPaise: 300,
    payments: before.payments + 1,
    commands: before.commands + 1,
    activity: before.activity + 1,
    audits: before.audits + 1,
  });
  const last = command(f.db, bill, 500),
    competitor = { ...last, requestId: randomUUID() };
  const attempts = await Promise.all([
    f.call(p.reviewed, staff, last),
    f.call(p.reviewed, staff, competitor),
  ]);
  assert.deepEqual(attempts.map((x) => x.status).sort(), [201, 409]);
  const winner = attempts.findIndex((x) => x.status === 201);
  const failed = attempts[1 - winner];
  assert.equal(failed.data.code, 'PAYMENT_NOT_RECORDED');
  const rejected = failed.data.command;
  const fresh = await f.call(p.reviewed, staff, command(f.db, bill, 100));
  assert.equal(fresh.status, 201);
  assert.equal(live(f.db, bill).invoice.paidPaise, 900);
  const legacy = legacyBody(command(f.db, bill, 50));
  const older = await simultaneousCareRequests(f, p.legacy, staff, legacy);
  assert.deepEqual(older.map((x) => x.status).sort(), [200, 201]);
  assert.deepEqual(older[0].data, older[1].data);
  assert.throws(() => f.db.exec('UPDATE paymentRecordingCommands SET rowid=rowid'), /immutable/);
  assert.throws(() => f.db.exec('DELETE FROM paymentRecordingCommands'), /immutable/);
  const end = state(f.db, bill);
  await f.close();
  const g = await careApiFixture(t, f.databasePath);
  assert.deepEqual((await g.call(p.reviewed, staff, first)).data, both[0].data);
  assert.deepEqual((await g.call(p.reviewed, staff, rejected)).data, failed.data);
  assert.deepEqual((await g.call(p.legacy, staff, legacy)).data, older[0].data);
  assert.deepEqual(state(g.db, bill), end);
  await g.close();
});

test('new and historical payments and known outcomes reauthorize active staff, CSRF and MFA inside the transaction', async (t) => {
  const f = await careApiFixture(t),
    staff = await f.login('reception'),
    bill = await invoice(f, staff),
    p = paths(bill),
    other = openDatabase(f.databasePath);
  t.after(() => other.close());
  const original = command(f.db, bill),
    rejected = { ...command(f.db, bill), expectedRevision: 'c'.repeat(64) };
  assert.equal((await f.call(p.reviewed, staff, original)).status, 201);
  assert.equal((await f.call(p.reviewed, staff, rejected)).status, 409);
  const old = legacyBody(command(f.db, bill));
  assert.equal((await f.call(p.legacy, staff, old)).status, 201);
  const historical = command(f.db, bill);
  const historicalPayment = {
    ...legacyBody(historical),
    id: randomUUID(),
    invoiceId: bill.id,
    createdAt: new Date().toISOString(),
  };
  other
    .prepare('INSERT INTO payments(id,invoiceId,requestId,data) VALUES (?,?,?,?)')
    .run(historicalPayment.id, bill.id, historical.requestId, JSON.stringify(historicalPayment));
  other
    .prepare(
      "UPDATE invoices SET data=json_set(data,'$.paidPaise',json_extract(data,'$.paidPaise')+?) WHERE id=?",
    )
    .run(historical.amountPaise, bill.id);
  const before = state(f.db, bill),
    user = get<User>(other, 'users', staff.user.id)!,
    session = other.prepare('SELECT * FROM sessions WHERE userId=?').get(user.id)!;
  const cases: [string, number, () => unknown][] = [
    ['revoked', 401, () => other.prepare('DELETE FROM sessions WHERE userId=?').run(user.id)],
    [
      'expired',
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
    ['suspended', 401, () => changeUser(other, user, { active: false })],
    ['password change', 403, () => changeUser(other, user, { mustChangePassword: true })],
    ['role', 403, () => changeUser(other, user, { role: 'patient', patientId: 'patient-2' })],
  ];
  for (const [endpoint, input] of [
    [p.legacy, legacyBody(command(f.db, bill))],
    [p.legacy, old],
    [p.legacy, legacyBody(historical)],
    [p.reviewed, command(f.db, bill)],
    [p.reviewed, original],
    [p.reviewed, rejected],
    [p.reviewed, historical],
  ] as const) {
    for (const [label, status, change] of cases) {
      const result = await beforeTransaction(f.db, 'BEGIN IMMEDIATE', change, () =>
        f.call(endpoint, staff, input),
      );
      assert.equal(result.status, status, label);
      assert.deepEqual(Object.keys(result.data), ['error']);
      assert.deepEqual(state(f.db, bill), before);
      changeUser(other, user, {});
      other.prepare('DELETE FROM mfaCredentials WHERE userId=?').run(user.id);
      other.prepare('DELETE FROM sessions WHERE userId=?').run(user.id);
      const cols = Object.keys(session);
      other
        .prepare(
          `INSERT INTO sessions(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
        )
        .run(...Object.values(session));
    }
  }
  const input = command(f.db, bill);
  const result = await beforeTransaction(
    f.db,
    'BEGIN IMMEDIATE',
    () =>
      other
        .prepare(
          "UPDATE invoices SET data=json_set(data,'$.patientId','patient-2'),patientId='patient-2' WHERE id=?",
        )
        .run(bill.id),
    () => f.call(p.reviewed, staff, input),
  );
  unmarked(result, 409);
  assert.deepEqual(state(f.db, bill), before);
});
