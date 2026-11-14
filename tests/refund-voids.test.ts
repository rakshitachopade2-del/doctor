import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import { get, openDatabase, type DB } from '../server/db.ts';
import type { Invoice, InvoiceDetail, Payment } from '../shared/operations.ts';
import type {
  PaymentRefundInput,
  PaymentRefundMutation,
  PaymentRefundVoidInput,
  PaymentRefundVoidMutation,
} from '../shared/billing-corrections.ts';
import type { User } from '../shared/types.ts';

type Client = { cookie: string; csrf: string; user: User };
const path = (invoiceId: string, paymentId: string) =>
  `/invoices/${invoiceId}/payments/${paymentId}/refunds`;
const voidPath = (invoiceId: string, refundId: string) =>
  `/invoices/${invoiceId}/refunds/${refundId}/void`;
const items = (amount = 10000) => [
  { description: 'Synthetic service charge', quantity: 1, unitAmountPaise: amount },
];
async function fixture(t: TestContext, database?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'derma-refund-voids-')),
    databasePath = database ?? join(directory, 'clinic.sqlite');
  const app = createApp({ databasePath, demoMode: true, production: false }),
    db = app.locals.db as DB;
  let server: Server;
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server!.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    app.locals.close();
  }
  t.after(async () => {
    await close();
    rmSync(directory, { recursive: true, force: true });
  });
  async function call(url: string, who?: Client, method = 'GET', body?: unknown) {
    const response = await fetch(`${base}/api${url}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(who ? { Cookie: who.cookie, 'X-CSRF-Token': who.csrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  async function login(role: string) {
    const r = await call('/auth/login', undefined, 'POST', {
      email: `${role}@derma.demo`,
      password: 'DemoClinic2026!',
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return {
      cookie: r.headers.get('set-cookie')!.split(';')[0],
      csrf: r.data.csrfToken,
      user: r.data.user,
    } as Client;
  }
  const admin = await login('admin');
  async function invoice(amount = 10000, patientId = 'patient-ananya') {
    const body = { patientId, items: items(amount), requestId: randomUUID() },
      r = await call('/invoices', admin, 'POST', body);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return { value: r.data as Invoice, body };
  }
  async function detail(invoiceId: string, who = admin): Promise<InvoiceDetail> {
    const r = await call(`/invoices/${invoiceId}`, who);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  }
  async function pay(invoiceId: string, amountPaise = 10000) {
    const body = {
      amountPaise,
      method: 'cash',
      reference: 'Synthetic payment receipt',
      requestId: randomUUID(),
    };
    const r = await call(`/invoices/${invoiceId}/payments`, admin, 'POST', body);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return { payment: r.data.payments.at(-1) as Payment, body, detail: r.data as InvoiceDetail };
  }
  async function input(
    invoiceId: string,
    fields: Record<string, unknown> = {},
  ): Promise<PaymentRefundInput> {
    return {
      amountPaise: 3000,
      method: 'cash',
      reference: '',
      reason: 'Patient-shared explanation of a refund already completed elsewhere',
      refundedExternallyConfirmed: true,
      expectedRevision: (await detail(invoiceId)).revision,
      requestId: randomUUID(),
      ...fields,
    } as PaymentRefundInput;
  }
  async function refund(
    invoiceId: string,
    paymentId: string,
    fields: Record<string, unknown> = {},
  ) {
    const body = await input(invoiceId, fields),
      r = await call(path(invoiceId, paymentId), admin, 'POST', body);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return { value: r.data as PaymentRefundMutation, body };
  }
  async function reverse(
    invoiceId: string,
    paymentId: string,
    fields: Record<string, unknown> = {},
  ) {
    return call(`/invoices/${invoiceId}/payments/${paymentId}/reverse`, admin, 'POST', {
      reason: 'Erroneous payment record',
      entryErrorConfirmed: true,
      expectedRevision: (await detail(invoiceId)).revision,
      requestId: randomUUID(),
      ...fields,
    });
  }
  async function correct(invoiceId: string, amount: number, fields: Record<string, unknown> = {}) {
    return call(`/invoices/${invoiceId}/corrections`, admin, 'POST', {
      items: amount ? items(amount) : [],
      ...(amount ? {} : { removeAllChargesConfirmed: true }),
      reason: 'Patient-shared charge correction',
      expectedRevision: (await detail(invoiceId)).revision,
      requestId: randomUUID(),
      ...fields,
    });
  }
  async function voidInput(
    invoiceId: string,
    fields: Record<string, unknown> = {},
  ): Promise<PaymentRefundVoidInput> {
    return {
      reason: 'Patient-shared correction of an erroneous refund entry',
      entryErrorConfirmed: true,
      expectedRevision: (await detail(invoiceId)).revision,
      requestId: randomUUID(),
      ...fields,
    } as PaymentRefundVoidInput;
  }
  async function voidRefund(
    invoiceId: string,
    refundId: string,
    fields: Record<string, unknown> = {},
  ) {
    const body = await voidInput(invoiceId, fields),
      result = await call(voidPath(invoiceId, refundId), admin, 'POST', body);
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return { value: result.data as PaymentRefundVoidMutation, body };
  }
  function state(invoiceId: string) {
    return {
      invoice: db.prepare('SELECT data FROM invoices WHERE id=?').get(invoiceId)!.data,
      ...Object.fromEntries(
        [
          'paymentRefunds',
          'paymentRefundVoids',
          'billingCorrectionCommands',
          'invoiceCorrections',
          'paymentReversals',
          'payments',
          'activity',
          'audit',
        ].map((table) => [
          table,
          Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n),
        ]),
      ),
    };
  }
  return {
    app,
    db,
    databasePath,
    admin,
    call,
    login,
    invoice,
    detail,
    pay,
    input,
    refund,
    reverse,
    correct,
    state,
    voidInput,
    voidRefund,
    close,
  };
}

test('void restores the exact recorded amount and preserves original refund, payment, charges and attribution', async (t) => {
  const f = await fixture(t),
    inv = (await f.invoice()).value,
    p = (await f.pay(inv.id)).payment,
    r = await f.refund(inv.id, p.id, { amountPaise: 3000 });
  const source = f.db
    .prepare('SELECT data FROM paymentRefunds WHERE id=?')
    .get(r.value.refund.id)!.data;
  const originalPayment = f.db.prepare('SELECT data FROM payments WHERE id=?').get(p.id)!.data;
  const saved = await f.voidRefund(inv.id, r.value.refund.id, {
    reason: '  Refund was entered against the wrong receipt  ',
  });
  assert.deepEqual(saved.value.void, {
    id: saved.value.void.id,
    invoiceId: inv.id,
    refundId: r.value.refund.id,
    paymentId: p.id,
    amountPaise: 3000,
    beforePaidPaise: 7000,
    afterPaidPaise: 10000,
    entryErrorConfirmed: true,
    reason: 'Refund was entered against the wrong receipt',
    createdByName: f.admin.user.name,
    createdAt: saved.value.void.createdAt,
  });
  assert.deepEqual(saved.value.receipt, {
    requestId: saved.body.requestId,
    actorId: f.admin.user.id,
    invoiceId: inv.id,
    refundId: r.value.refund.id,
    expectedRevision: saved.body.expectedRevision,
    voidId: saved.value.void.id,
  });
  assert.equal(saved.value.detail.invoice.paidPaise, 10000);
  assert.equal(saved.value.detail.invoice.status, 'paid');
  assert.deepEqual(saved.value.detail.invoice.items, inv.items);
  assert.equal(saved.value.detail.invoice.number, inv.number);
  assert.deepEqual(saved.value.detail.refunds, [r.value.refund]);
  assert.deepEqual(saved.value.detail.refundVoids, [saved.value.void]);
  assert.equal(saved.value.detail.corrections.length, 0);
  assert.equal(saved.value.detail.reversals.length, 0);
  assert.equal(
    f.db.prepare('SELECT data FROM paymentRefunds WHERE id=?').get(r.value.refund.id)!.data,
    source,
  );
  assert.equal(
    f.db.prepare('SELECT data FROM payments WHERE id=?').get(p.id)!.data,
    originalPayment,
  );
  assert.equal(
    (await f.call(voidPath(inv.id, r.value.refund.id), f.admin, 'POST', await f.voidInput(inv.id)))
      .status,
    409,
  );
});

test('active refund totals exclude voided entries; payment reversal is permitted only after every refund on that payment is voided', async (t) => {
  const f = await fixture(t),
    inv = (await f.invoice()).value,
    p = (await f.pay(inv.id)).payment;
  const first = await f.refund(inv.id, p.id, { amountPaise: 4000 }),
    second = await f.refund(inv.id, p.id, { amountPaise: 6000 });
  await f.voidRefund(inv.id, first.value.refund.id);
  assert.equal((await f.detail(inv.id)).invoice.paidPaise, 4000);
  assert.equal((await f.reverse(inv.id, p.id)).status, 409);
  const excess = await f.input(inv.id, { amountPaise: 4001 });
  assert.equal((await f.call(path(inv.id, p.id), f.admin, 'POST', excess)).status, 409);
  const replacement = await f.refund(inv.id, p.id, { amountPaise: 4000 });
  assert.equal(replacement.value.detail.invoice.paidPaise, 0);
  await f.voidRefund(inv.id, second.value.refund.id);
  assert.equal((await f.reverse(inv.id, p.id)).status, 409);
  const last = await f.voidRefund(inv.id, replacement.value.refund.id);
  assert.equal(last.value.detail.invoice.paidPaise, 10000);
  assert.equal((await f.reverse(inv.id, p.id)).status, 200);
  assert.equal((await f.detail(inv.id)).invoice.paidPaise, 0);
  assert.equal(
    (await f.call(path(inv.id, p.id), f.admin, 'POST', await f.input(inv.id))).status,
    409,
  );
  const replay = await f.call(
    voidPath(inv.id, replacement.value.refund.id),
    f.admin,
    'POST',
    last.body,
  );
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data.void, last.value.void);
  assert.equal(replay.data.detail.invoice.paidPaise, 0);
  const refundReplay = await f.call(path(inv.id, p.id), f.admin, 'POST', replacement.body);
  assert.equal(refundReplay.status, 200);
  assert.deepEqual(refundReplay.data.refund, replacement.value.refund);
});

test('restoration cannot overpay reduced charges or later receipts; separate explicit corrections resolve the conflict', async (t) => {
  const f = await fixture(t),
    inv = (await f.invoice()).value,
    p = (await f.pay(inv.id)).payment,
    r = await f.refund(inv.id, p.id, { amountPaise: 4000 });
  assert.equal((await f.correct(inv.id, 6000)).status, 200);
  let body = await f.voidInput(inv.id),
    before = f.state(inv.id);
  assert.equal(
    (await f.call(voidPath(inv.id, r.value.refund.id), f.admin, 'POST', body)).status,
    409,
  );
  assert.deepEqual(f.state(inv.id), before);
  assert.equal((await f.correct(inv.id, 10000)).status, 200);
  await f.voidRefund(inv.id, r.value.refund.id);
  assert.equal((await f.detail(inv.id)).invoice.paidPaise, 10000);
  const another = await f.refund(inv.id, p.id, { amountPaise: 3000 }),
    later = (await f.pay(inv.id, 3000)).payment;
  body = await f.voidInput(inv.id);
  before = f.state(inv.id);
  assert.equal(
    (await f.call(voidPath(inv.id, another.value.refund.id), f.admin, 'POST', body)).status,
    409,
  );
  assert.deepEqual(f.state(inv.id), before);
  assert.equal((await f.reverse(inv.id, later.id)).status, 200);
  await f.voidRefund(inv.id, another.value.refund.id);
  assert.equal((await f.detail(inv.id)).invoice.status, 'paid');
  const zero = (await f.invoice()).value,
    zp = (await f.pay(zero.id)).payment,
    zr = await f.refund(zero.id, zp.id, { amountPaise: 10000 });
  await f.correct(zero.id, 0);
  assert.equal(
    (
      await f.call(
        voidPath(zero.id, zr.value.refund.id),
        f.admin,
        'POST',
        await f.voidInput(zero.id),
      )
    ).status,
    409,
  );
});

test('void inputs are strict, admin-only, scoped to the source invoice, and require explicit error confirmation', async (t) => {
  const f = await fixture(t),
    inv = (await f.invoice()).value,
    p = (await f.pay(inv.id)).payment,
    r = await f.refund(inv.id, p.id),
    body = await f.voidInput(inv.id);
  for (const role of ['doctor', 'reception', 'patient'])
    assert.equal(
      (await f.call(voidPath(inv.id, r.value.refund.id), await f.login(role), 'POST', body)).status,
      403,
    );
  assert.equal(
    (await f.call(voidPath(inv.id, r.value.refund.id), undefined, 'POST', body)).status,
    401,
  );
  assert.equal(
    (await f.call(voidPath(inv.id, r.value.refund.id), { ...f.admin, csrf: '' }, 'POST', body))
      .status,
    403,
  );
  for (const extra of [
    { reason: '' },
    { reason: ' ' },
    { reason: 'x'.repeat(1001) },
    { entryErrorConfirmed: false },
    { expectedRevision: 'BAD' },
    { requestId: 'bad' },
    { amountPaise: 1 },
    { refundedExternallyConfirmed: true },
  ]) {
    const before = f.state(inv.id);
    assert.equal(
      (await f.call(voidPath(inv.id, r.value.refund.id), f.admin, 'POST', { ...body, ...extra }))
        .status,
      400,
    );
    assert.deepEqual(f.state(inv.id), before);
  }
  assert.equal(
    (await f.call(`${voidPath(inv.id, r.value.refund.id)}?extra=1`, f.admin, 'POST', body)).status,
    400,
  );
  assert.equal((await f.call(voidPath(inv.id, 'missing'), f.admin, 'POST', body)).status, 404);
  const other = (await f.invoice()).value;
  assert.equal(
    (
      await f.call(
        voidPath(other.id, r.value.refund.id),
        f.admin,
        'POST',
        await f.voidInput(other.id),
      )
    ).status,
    404,
  );
});

test('void receipt binds actor, source, payload and revision, and exact retry returns original evidence plus later current detail', async (t) => {
  const f = await fixture(t),
    inv = (await f.invoice()).value,
    p = (await f.pay(inv.id)).payment,
    r = await f.refund(inv.id, p.id),
    saved = await f.voidRefund(inv.id, r.value.refund.id);
  const next = await f.refund(inv.id, p.id, { amountPaise: 1000 });
  const user = get<User>(f.db, 'users', f.admin.user.id)!;
  f.db
    .prepare('UPDATE users SET data=? WHERE id=?')
    .run(JSON.stringify({ ...user, name: 'Updated administrator name' }), user.id);
  const retry = await f.call(voidPath(inv.id, r.value.refund.id), f.admin, 'POST', {
    ...saved.body,
    requestId: saved.body.requestId.toUpperCase(),
  });
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.data.void, saved.value.void);
  assert.deepEqual(retry.data.receipt, saved.value.receipt);
  assert.equal(retry.data.detail.invoice.paidPaise, 9000);
  for (const extra of [
    { reason: 'Different correction' },
    { expectedRevision: retry.data.detail.revision },
  ])
    assert.equal(
      (
        await f.call(voidPath(inv.id, r.value.refund.id), f.admin, 'POST', {
          ...saved.body,
          ...extra,
        })
      ).status,
      409,
    );
  assert.equal(
    (await f.call(voidPath(inv.id, next.value.refund.id), f.admin, 'POST', saved.body)).status,
    409,
  );
  const doctor = await f.login('doctor'),
    account = get<User>(f.db, 'users', doctor.user.id)!;
  f.db
    .prepare("UPDATE users SET role='admin',data=? WHERE id=?")
    .run(JSON.stringify({ ...account, role: 'admin' }), account.id);
  assert.equal(
    (await f.call(voidPath(inv.id, r.value.refund.id), doctor, 'POST', saved.body)).status,
    409,
  );
  assert.equal(
    (
      await f.call(
        path(inv.id, p.id),
        f.admin,
        'POST',
        await f.input(inv.id, { requestId: saved.body.requestId }),
      )
    ).status,
    409,
  );
  assert.equal((await f.reverse(inv.id, p.id, { requestId: saved.body.requestId })).status, 409);
  assert.equal((await f.correct(inv.id, 9000, { requestId: saved.body.requestId })).status, 409);
  assert.equal(
    (
      await f.call(
        voidPath(inv.id, next.value.refund.id),
        f.admin,
        'POST',
        await f.voidInput(inv.id, { requestId: r.body.requestId }),
      )
    ).status,
    409,
  );
});

test('new payment and charge corrections stale pending voids; committed source update before BEGIN is never overwritten', async (t) => {
  const f = await fixture(t),
    inv = (await f.invoice()).value,
    p = (await f.pay(inv.id)).payment,
    r = await f.refund(inv.id, p.id);
  let input = await f.voidInput(inv.id);
  const later = (await f.pay(inv.id, 1000)).payment;
  assert.equal(
    (await f.call(voidPath(inv.id, r.value.refund.id), f.admin, 'POST', input)).status,
    409,
  );
  await f.reverse(inv.id, later.id);
  input = await f.voidInput(inv.id);
  await f.correct(inv.id, 12000);
  assert.equal(
    (await f.call(voidPath(inv.id, r.value.refund.id), f.admin, 'POST', input)).status,
    409,
  );
  input = await f.voidInput(inv.id);
  const external = openDatabase(f.databasePath),
    original = f.db.exec.bind(f.db);
  let fired = false;
  f.db.exec = ((sql: string) => {
    if (sql === 'BEGIN IMMEDIATE' && !fired) {
      fired = true;
      external
        .prepare(
          "UPDATE invoices SET data=json_set(data,'$.items',json(?),'$.totalPaise',13000) WHERE id=?",
        )
        .run(JSON.stringify(items(13000)), inv.id);
    }
    return original(sql);
  }) as typeof f.db.exec;
  try {
    assert.equal(
      (await f.call(voidPath(inv.id, r.value.refund.id), f.admin, 'POST', input)).status,
      409,
    );
    assert.ok(fired);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM paymentRefundVoids').get()!.n, 0);
  } finally {
    f.db.exec = original;
    external.close();
  }
  const saved = await f.voidRefund(inv.id, r.value.refund.id);
  assert.equal(saved.value.detail.invoice.totalPaise, 13000);
  assert.equal(saved.value.detail.invoice.paidPaise, 10000);
});

test('fresh session, role, MFA and active-password state are revalidated under lock on new and replayed voids', async (t) => {
  const f = await fixture(t),
    inv = (await f.invoice()).value,
    p = (await f.pay(inv.id)).payment,
    r = await f.refund(inv.id, p.id),
    saved = await f.voidRefund(inv.id, r.value.refund.id),
    second = await f.refund(inv.id, p.id);
  const requests = [
    { id: r.value.refund.id, body: saved.body },
    { id: second.value.refund.id, body: await f.voidInput(inv.id) },
  ];
  const external = openDatabase(f.databasePath),
    original = f.db.exec.bind(f.db),
    account = external.prepare('SELECT role,data FROM users WHERE id=?').get(f.admin.user.id)!;
  const session = external.prepare('SELECT * FROM sessions WHERE userId=?').get(f.admin.user.id)!,
    columns = Object.keys(session);
  try {
    for (const change of ['revoked', 'expired', 'csrf', 'inactive', 'temporary', 'role', 'mfa'])
      for (const request of requests) {
        let fired = false;
        f.db.exec = ((sql: string) => {
          if (sql === 'BEGIN IMMEDIATE' && !fired) {
            fired = true;
            if (change === 'revoked')
              external.prepare('DELETE FROM sessions WHERE userId=?').run(f.admin.user.id);
            if (change === 'expired')
              external
                .prepare('UPDATE sessions SET expiresAt=0 WHERE userId=?')
                .run(f.admin.user.id);
            if (change === 'csrf')
              external
                .prepare("UPDATE sessions SET csrfToken='changed' WHERE userId=?")
                .run(f.admin.user.id);
            if (change === 'inactive')
              external
                .prepare("UPDATE users SET data=json_set(data,'$.active',json('false')) WHERE id=?")
                .run(f.admin.user.id);
            if (change === 'temporary')
              external
                .prepare(
                  "UPDATE users SET data=json_set(data,'$.mustChangePassword',json('true')) WHERE id=?",
                )
                .run(f.admin.user.id);
            if (change === 'role')
              external
                .prepare(
                  "UPDATE users SET role='doctor',data=json_set(data,'$.role','doctor') WHERE id=?",
                )
                .run(f.admin.user.id);
            if (change === 'mfa')
              external
                .prepare(
                  'INSERT INTO mfaCredentials(userId,id,secret,enabledAt,lastStep) VALUES (?,?,?,?,?)',
                )
                .run(
                  f.admin.user.id,
                  randomUUID(),
                  'synthetic-fixture',
                  new Date().toISOString(),
                  -1,
                );
          }
          return original(sql);
        }) as typeof f.db.exec;
        const before = f.state(inv.id),
          result = await f.call(voidPath(inv.id, request.id), f.admin, 'POST', request.body);
        assert.ok(fired);
        assert.ok([401, 403].includes(result.status), `${change}:${result.status}`);
        assert.deepEqual(f.state(inv.id), before);
        f.db.exec = original;
        external
          .prepare('UPDATE users SET role=?,data=? WHERE id=?')
          .run(account.role as string, account.data as string, f.admin.user.id);
        external.prepare('DELETE FROM mfaCredentials WHERE userId=?').run(f.admin.user.id);
        external
          .prepare(
            `INSERT OR REPLACE INTO sessions(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
          )
          .run(...columns.map((key) => session[key]));
      }
  } finally {
    f.db.exec = original;
    external.close();
  }
});

test('event, command, balance, audit, notification and response failures roll back the complete void and permit exact retry', async (t) => {
  for (const point of ['void', 'command', 'invoice', 'audit', 'activity', 'response']) {
    const f = await fixture(t),
      inv = (await f.invoice()).value,
      p = (await f.pay(inv.id)).payment,
      r = await f.refund(inv.id, p.id),
      body = await f.voidInput(inv.id),
      original = f.db.prepare.bind(f.db);
    if (point === 'response')
      f.db.prepare = ((sql: string) => {
        const statement = original(sql);
        if (sql === 'SELECT data FROM paymentRefundVoids WHERE invoiceId=? ORDER BY rowid DESC') {
          const all = statement.all.bind(statement);
          statement.all = ((...params: Parameters<typeof statement.all>) => {
            const rows = all(...params);
            if (rows.length) throw new Error('Synthetic void response failure');
            return rows;
          }) as typeof statement.all;
        }
        return statement;
      }) as typeof f.db.prepare;
    else {
      const table =
        point === 'void'
          ? 'paymentRefundVoids'
          : point === 'command'
            ? 'billingCorrectionCommands'
            : point === 'invoice'
              ? 'invoices'
              : point;
      const condition =
        point === 'audit'
          ? "json_extract(NEW.data,'$.action')='voided erroneous refund entry'"
          : point === 'activity'
            ? "NEW.eventKey LIKE 'billing-corrected:%'"
            : '1';
      f.db.exec(
        `CREATE TRIGGER fail_void BEFORE ${point === 'invoice' ? 'UPDATE' : 'INSERT'} ON ${table} WHEN ${condition} BEGIN SELECT RAISE(ABORT,'Synthetic void rollback'); END`,
      );
    }
    const before = f.state(inv.id);
    try {
      assert.equal(
        (await f.call(voidPath(inv.id, r.value.refund.id), f.admin, 'POST', body)).status,
        500,
        point,
      );
      assert.deepEqual(f.state(inv.id), before, point);
    } finally {
      f.db.prepare = original;
      if (point !== 'response') f.db.exec('DROP TRIGGER fail_void');
    }
    assert.equal(
      (await f.call(voidPath(inv.id, r.value.refund.id), f.admin, 'POST', body)).status,
      201,
    );
    await f.close();
  }
});

test('independent applications serialize duplicate and competing voids, and prevent over-restoration against concurrent payments', async (t) => {
  const f = await fixture(t),
    inv = (await f.invoice()).value,
    p = (await f.pay(inv.id)).payment,
    r = await f.refund(inv.id, p.id),
    g = await fixture(t, f.databasePath),
    input = await f.voidInput(inv.id);
  const duplicates = await Promise.all([
    f.call(voidPath(inv.id, r.value.refund.id), f.admin, 'POST', input),
    g.call(voidPath(inv.id, r.value.refund.id), f.admin, 'POST', input),
  ]);
  assert.deepEqual(duplicates.map((x) => x.status).sort(), [200, 201]);
  assert.deepEqual(duplicates[0].data, duplicates[1].data);
  const second = await f.refund(inv.id, p.id),
    body = await f.voidInput(inv.id);
  const competing = await Promise.all([
    f.call(voidPath(inv.id, second.value.refund.id), f.admin, 'POST', body),
    g.call(voidPath(inv.id, second.value.refund.id), f.admin, 'POST', {
      ...body,
      requestId: randomUUID(),
    }),
  ]);
  assert.deepEqual(competing.map((x) => x.status).sort(), [201, 409]);
  assert.equal((await f.detail(inv.id)).invoice.paidPaise, 10000);
  const third = await f.refund(inv.id, p.id),
    next = await f.voidInput(inv.id);
  const payment = {
    amountPaise: 3000,
    method: 'cash',
    reference: 'Later payment fixture',
    requestId: randomUUID(),
  };
  const race = await Promise.all([
    f.call(voidPath(inv.id, third.value.refund.id), f.admin, 'POST', next),
    g.call(`/invoices/${inv.id}/payments`, f.admin, 'POST', payment),
  ]);
  assert.deepEqual(race.map((x) => x.status).sort(), [201, 409]);
  assert.equal((await f.detail(inv.id)).invoice.paidPaise, 10000);
});

test('safe patient history and live summaries include voids while immutable saved copies preserve their earlier refund state', async (t) => {
  const f = await fixture(t),
    patient = await f.login('patient'),
    inv = (await f.invoice()).value,
    p = (await f.pay(inv.id)).payment,
    r = await f.refund(inv.id, p.id);
  const before = await f.call(`/patients/${inv.patientId}/care-summary`, patient),
    copy = await f.call(`/patients/${inv.patientId}/care-summary/copies`, patient, 'POST', {
      expectedRevision: before.data.revision,
      requestId: randomUUID(),
    });
  assert.equal(copy.status, 201);
  const saved = await f.voidRefund(inv.id, r.value.refund.id, {
    reason: 'SHARED_REFUND_ENTRY_ERROR',
  });
  for (const who of [patient, await f.login('doctor'), await f.login('reception')]) {
    const d = await f.detail(inv.id, who);
    assert.deepEqual(d.refundVoids, [saved.value.void]);
    assert.equal('createdById' in d.refundVoids[0], false);
    assert.equal('requestId' in d.refundVoids[0], false);
    assert.equal('expectedRevision' in d.refundVoids[0], false);
    assert.equal('receipt' in d, false);
  }
  const after = await f.call(`/patients/${inv.patientId}/care-summary`, patient);
  assert.notEqual(after.data.revision, before.data.revision);
  assert.ok(JSON.stringify(after.data).includes('SHARED_REFUND_ENTRY_ERROR'));
  assert.equal(JSON.stringify(after.data).includes(saved.body.requestId), false);
  const historical = await f.call(
    `/patients/${inv.patientId}/care-summary/copies/${copy.data.copy.id}`,
    patient,
  );
  assert.deepEqual(historical.data.summary, {
    ...before.data,
    generatedAt: copy.data.copy.generatedAt,
  });
  assert.equal(
    JSON.stringify(historical.data.summary).includes('SHARED_REFUND_ENTRY_ERROR'),
    false,
  );
  const activity = await f.call('/activity', patient);
  assert.ok(
    activity.data.items.some(
      (x: { title: string; href: string }) =>
        x.title === 'Your clinic corrected a refund record' &&
        x.href === `/my-care/invoices?invoice=${inv.id}`,
    ),
  );
});

test('immutable void evidence and exact receipts persist after closing/reopening, with source association and one-void constraints', async (t) => {
  const f = await fixture(t),
    inv = (await f.invoice()).value,
    p = (await f.pay(inv.id)).payment,
    r = await f.refund(inv.id, p.id),
    saved = await f.voidRefund(inv.id, r.value.refund.id);
  await f.close();
  const g = await fixture(t, f.databasePath),
    retry = await g.call(voidPath(inv.id, r.value.refund.id), f.admin, 'POST', saved.body);
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.data, saved.value);
  assert.throws(
    () =>
      g.db.prepare('UPDATE paymentRefundVoids SET data=data WHERE id=?').run(saved.value.void.id),
    /immutable/,
  );
  assert.throws(
    () => g.db.prepare('DELETE FROM paymentRefundVoids WHERE id=?').run(saved.value.void.id),
    /immutable/,
  );
  assert.throws(
    () =>
      g.db
        .prepare(
          'INSERT INTO paymentRefundVoids(id,invoiceId,refundId,paymentId,createdAt,data) VALUES (?,?,?,?,?,?)',
        )
        .run(randomUUID(), inv.id, r.value.refund.id, p.id, new Date().toISOString(), '{}'),
    /UNIQUE/,
  );
  const next = await g.refund(inv.id, p.id),
    other = (await g.invoice()).value;
  assert.throws(
    () =>
      g.db
        .prepare(
          'INSERT INTO paymentRefundVoids(id,invoiceId,refundId,paymentId,createdAt,data) VALUES (?,?,?,?,?,?)',
        )
        .run(randomUUID(), other.id, next.value.refund.id, p.id, new Date().toISOString(), '{}'),
    /FOREIGN KEY/,
  );
  const otherPayment = (await g.pay(other.id)).payment;
  assert.throws(
    () =>
      g.db
        .prepare(
          'INSERT INTO paymentRefundVoids(id,invoiceId,refundId,paymentId,createdAt,data) VALUES (?,?,?,?,?,?)',
        )
        .run(
          randomUUID(),
          inv.id,
          next.value.refund.id,
          otherPayment.id,
          new Date().toISOString(),
          '{}',
        ),
    /FOREIGN KEY/,
  );
});

test('migration adds empty void history while preserving legacy refund/payment/invoice bytes and balances', async (t) => {
  const f = await fixture(t),
    inv = (await f.invoice()).value,
    p = (await f.pay(inv.id)).payment,
    r = await f.refund(inv.id, p.id);
  const before = {
    invoice: f.db.prepare('SELECT data FROM invoices WHERE id=?').get(inv.id)!.data,
    payment: f.db.prepare('SELECT data FROM payments WHERE id=?').get(p.id)!.data,
    refund: f.db.prepare('SELECT data FROM paymentRefunds WHERE id=?').get(r.value.refund.id)!.data,
  };
  f.db.exec('DROP TABLE paymentRefundVoids');
  await f.close();
  const g = await fixture(t, f.databasePath),
    detail = await g.detail(inv.id);
  assert.deepEqual(detail.refundVoids, []);
  assert.equal(detail.invoice.paidPaise, 7000);
  assert.equal(
    g.db.prepare('SELECT data FROM invoices WHERE id=?').get(inv.id)!.data,
    before.invoice,
  );
  assert.equal(
    g.db.prepare('SELECT data FROM payments WHERE id=?').get(p.id)!.data,
    before.payment,
  );
  assert.equal(
    g.db.prepare('SELECT data FROM paymentRefunds WHERE id=?').get(r.value.refund.id)!.data,
    before.refund,
  );
  await g.voidRefund(inv.id, r.value.refund.id);
  assert.equal((await g.detail(inv.id)).invoice.paidPaise, 10000);
});

test('active-refund cap uses indexed source-payment lookup and exact refund-void lookup', async (t) => {
  const f = await fixture(t),
    inv = (await f.invoice()).value,
    p = (await f.pay(inv.id)).payment,
    r = await f.refund(inv.id, p.id);
  await f.voidRefund(inv.id, r.value.refund.id);
  const original = f.db.prepare.bind(f.db);
  let capSQL = '';
  f.db.prepare = ((sql: string) => {
    if (sql.includes('SUM(r.amountPaise)') && sql.includes('paymentRefundVoids')) capSQL = sql;
    return original(sql);
  }) as typeof f.db.prepare;
  try {
    await f.refund(inv.id, p.id, { amountPaise: 10000 });
  } finally {
    f.db.prepare = original;
  }
  assert.ok(capSQL);
  const plan = original(`EXPLAIN QUERY PLAN ${capSQL}`).all(p.id);
  assert.match(JSON.stringify(plan), /SEARCH r USING INDEX payment_refunds_payment/);
  assert.match(JSON.stringify(plan), /SEARCH v USING COVERING INDEX [^\"]+\(refundId=\?\)/);
});
