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
import type { PaymentRefundInput, PaymentRefundMutation } from '../shared/billing-corrections.ts';
import type { User } from '../shared/types.ts';

type Client = { cookie: string; csrf: string; user: User };
const path = (invoiceId: string, paymentId: string) =>
  `/invoices/${invoiceId}/payments/${paymentId}/refunds`;
const items = (amount = 10000) => [
  { description: 'Synthetic service charge', quantity: 1, unitAmountPaise: amount },
];
async function fixture(t: TestContext, database?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'derma-payment-refunds-')),
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
  function state(invoiceId: string) {
    return {
      invoice: db.prepare('SELECT data FROM invoices WHERE id=?').get(invoiceId)!.data,
      ...Object.fromEntries(
        [
          'paymentRefunds',
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
    close,
  };
}

test('partial/full external refunds reduce paid balance while preserving original payments, charges and invoice identity', async (t) => {
  const f = await fixture(t),
    created = await f.invoice(),
    inv = created.value,
    paid = await f.pay(inv.id);
  const paymentSource = f.db
    .prepare('SELECT data FROM payments WHERE id=?')
    .get(paid.payment.id)!.data;
  const first = await f.refund(inv.id, paid.payment.id, {
    amountPaise: 3500,
    method: 'upi',
    reference: '  external-upi-confirmation  ',
    reason: '  Shared return explanation  ',
  });
  assert.deepEqual(first.value.refund, {
    id: first.value.refund.id,
    invoiceId: inv.id,
    paymentId: paid.payment.id,
    amountPaise: 3500,
    method: 'upi',
    reference: 'external-upi-confirmation',
    reason: 'Shared return explanation',
    refundedExternallyConfirmed: true,
    beforePaidPaise: 10000,
    afterPaidPaise: 6500,
    createdByName: f.admin.user.name,
    createdAt: first.value.refund.createdAt,
  });
  assert.deepEqual(first.value.receipt, {
    requestId: first.body.requestId,
    actorId: f.admin.user.id,
    invoiceId: inv.id,
    paymentId: paid.payment.id,
    expectedRevision: first.body.expectedRevision,
    refundId: first.value.refund.id,
  });
  assert.equal(first.value.detail.invoice.paidPaise, 6500);
  assert.equal(first.value.detail.invoice.status, 'partial');
  assert.equal(first.value.detail.invoice.totalPaise, 10000);
  const final = await f.refund(inv.id, paid.payment.id, {
    amountPaise: 6500,
    method: 'bank',
    reference: 'external-bank-receipt',
  });
  assert.equal(final.value.detail.invoice.paidPaise, 0);
  assert.equal(final.value.detail.invoice.status, 'unpaid');
  assert.equal(final.value.detail.refunds.length, 2);
  assert.equal(final.value.detail.invoice.id, inv.id);
  assert.equal(final.value.detail.invoice.number, inv.number);
  assert.equal(final.value.detail.invoice.patientName, inv.patientName);
  assert.deepEqual(final.value.detail.invoice.items, inv.items);
  assert.equal(final.value.detail.corrections.length, 0);
  assert.equal(final.value.detail.reversals.length, 0);
  assert.equal(
    f.db.prepare('SELECT data FROM payments WHERE id=?').get(paid.payment.id)!.data,
    paymentSource,
  );
  const issuedReplay = await f.call('/invoices', f.admin, 'POST', created.body);
  assert.equal(issuedReplay.status, 200);
  assert.equal(issuedReplay.data.id, inv.id);
  const paymentReplay = await f.call(`/invoices/${inv.id}/payments`, f.admin, 'POST', paid.body);
  assert.equal(paymentReplay.status, 200);
  assert.equal(paymentReplay.data.invoice.paidPaise, 0);
});

test('administrator-only strict monetary input, confirmation, reference and query validation leave balances unchanged', async (t) => {
  const f = await fixture(t),
    inv = (await f.invoice()).value,
    payment = (await f.pay(inv.id)).payment,
    body = await f.input(inv.id);
  for (const role of ['doctor', 'reception', 'patient']) {
    const who = await f.login(role);
    assert.equal((await f.call(path(inv.id, payment.id), who, 'POST', body)).status, 403);
  }
  assert.equal((await f.call(path(inv.id, payment.id), undefined, 'POST', body)).status, 401);
  for (const change of [
    { amountPaise: 0 },
    { amountPaise: -1 },
    { amountPaise: 1.1 },
    { amountPaise: 1000000001 },
    { amountPaise: '100' },
    { amountPaise: null },
    { method: 'crypto' },
    { method: 'card', reference: ' ' },
    { method: 'upi', reference: '' },
    { method: 'bank', reference: '' },
    { reference: 'x'.repeat(201) },
    { reason: ' ' },
    { reason: 'x'.repeat(1001) },
    { refundedExternallyConfirmed: false },
    { expectedRevision: 'invalid' },
    { requestId: 'invalid' },
    { extra: true },
  ]) {
    const before = f.state(inv.id),
      r = await f.call(path(inv.id, payment.id), f.admin, 'POST', { ...body, ...change });
    assert.equal(r.status, 400, JSON.stringify(change));
    assert.deepEqual(f.state(inv.id), before);
  }
  assert.equal(
    (await f.call(`${path(inv.id, payment.id)}?ignored=1`, f.admin, 'POST', body)).status,
    400,
  );
  const withoutCsrf = { ...f.admin, csrf: '' };
  assert.equal((await f.call(path(inv.id, payment.id), withoutCsrf, 'POST', body)).status, 403);
  const before = f.state(inv.id);
  assert.equal((await f.call(path(inv.id, 'missing-payment'), f.admin, 'POST', body)).status, 404);
  assert.deepEqual(f.state(inv.id), before);
});

test('remaining amount is capped per source payment, not by invoice-wide balance; cross-invoice payments are rejected', async (t) => {
  const f = await fixture(t),
    inv = (await f.invoice(20000)).value,
    p1 = (await f.pay(inv.id, 5000)).payment,
    p2 = (await f.pay(inv.id, 15000)).payment;
  await f.refund(inv.id, p1.id, { amountPaise: 4000 });
  let body = await f.input(inv.id, { amountPaise: 1001 });
  const before = f.state(inv.id);
  assert.equal((await f.call(path(inv.id, p1.id), f.admin, 'POST', body)).status, 409);
  assert.deepEqual(f.state(inv.id), before);
  await f.refund(inv.id, p1.id, { amountPaise: 1000 });
  body = await f.input(inv.id, { amountPaise: 1 });
  assert.equal((await f.call(path(inv.id, p1.id), f.admin, 'POST', body)).status, 409);
  await f.refund(inv.id, p2.id, { amountPaise: 15000 });
  assert.equal((await f.detail(inv.id)).invoice.paidPaise, 0);
  const other = (await f.invoice()).value;
  body = await f.input(other.id);
  assert.equal((await f.call(path(other.id, p2.id), f.admin, 'POST', body)).status, 404);
});

test('refunds and erroneous-entry reversals are mutually exclusive; separate charge corrections and later receipts use net balance', async (t) => {
  const f = await fixture(t),
    inv = (await f.invoice()).value,
    p1 = (await f.pay(inv.id)).payment;
  await f.refund(inv.id, p1.id, { amountPaise: 4000 });
  assert.equal((await f.reverse(inv.id, p1.id)).status, 409);
  assert.equal((await f.correct(inv.id, 5000)).status, 409);
  let corrected = await f.correct(inv.id, 6000);
  assert.equal(corrected.status, 200);
  assert.equal(corrected.data.invoice.status, 'paid');
  await f.refund(inv.id, p1.id, { amountPaise: 6000 });
  corrected = await f.correct(inv.id, 0);
  assert.equal(corrected.status, 200);
  assert.equal(corrected.data.invoice.status, 'no-charge');
  assert.equal(corrected.data.issuedCharges.totalPaise, 10000);
  assert.equal(corrected.data.refunds.length, 2);
  const other = (await f.invoice()).value,
    paid = await f.pay(other.id);
  assert.equal((await f.reverse(other.id, paid.payment.id)).status, 200);
  const body = await f.input(other.id);
  assert.equal((await f.call(path(other.id, paid.payment.id), f.admin, 'POST', body)).status, 409);
  const fresh = (await f.invoice()).value,
    payment = (await f.pay(fresh.id)).payment;
  await f.refund(fresh.id, payment.id, { amountPaise: 3000 });
  const replacement = await f.pay(fresh.id, 3000);
  assert.equal(replacement.detail.invoice.paidPaise, 10000);
  assert.equal(replacement.detail.invoice.status, 'paid');
  assert.equal(replacement.detail.payments.length, 2);
  assert.equal(replacement.detail.refunds.length, 1);
});

test('exact actor-bound receipt survives later state and account-name changes; collisions include source, operation and expected revision', async (t) => {
  const f = await fixture(t),
    inv = (await f.invoice()).value,
    p = (await f.pay(inv.id)).payment,
    first = await f.refund(inv.id, p.id);
  await f.refund(inv.id, p.id, { amountPaise: 1000 });
  await f.correct(inv.id, 6000);
  const account = get<User>(f.db, 'users', f.admin.user.id)!;
  f.db
    .prepare('UPDATE users SET data=? WHERE id=?')
    .run(JSON.stringify({ ...account, name: 'Renamed administrator' }), account.id);
  const retry = await f.call(path(inv.id, p.id), f.admin, 'POST', {
    ...first.body,
    requestId: first.body.requestId.toUpperCase(),
  });
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.data.refund, first.value.refund);
  assert.deepEqual(retry.data.receipt, first.value.receipt);
  assert.equal(retry.data.detail.invoice.totalPaise, 6000);
  assert.equal(retry.data.detail.refunds.length, 2);
  for (const change of [
    { amountPaise: 2000 },
    { reason: 'Other reason' },
    { method: 'card', reference: 'external-reference' },
    { expectedRevision: retry.data.detail.revision },
  ])
    assert.equal(
      (await f.call(path(inv.id, p.id), f.admin, 'POST', { ...first.body, ...change })).status,
      409,
    );
  const doctor = await f.login('doctor'),
    other = get<User>(f.db, 'users', doctor.user.id)!;
  f.db
    .prepare("UPDATE users SET role='admin',data=? WHERE id=?")
    .run(JSON.stringify({ ...other, role: 'admin' }), other.id);
  assert.equal((await f.call(path(inv.id, p.id), doctor, 'POST', first.body)).status, 409);
  const otherInvoice = (await f.invoice()).value,
    p2 = (await f.pay(otherInvoice.id)).payment;
  assert.equal(
    (await f.call(path(otherInvoice.id, p2.id), f.admin, 'POST', first.body)).status,
    409,
  );
  assert.equal((await f.reverse(inv.id, p.id, { requestId: first.body.requestId })).status, 409);
  assert.equal((await f.correct(inv.id, 7000, { requestId: first.body.requestId })).status, 409);
});

test('stale revision after payment or charge changes prevents refund; exact original retry precedes current remaining-cap checks', async (t) => {
  const f = await fixture(t),
    inv = (await f.invoice(20000)).value,
    p = (await f.pay(inv.id, 10000)).payment;
  const stale = await f.input(inv.id);
  await f.pay(inv.id, 5000);
  const before = f.state(inv.id);
  assert.equal((await f.call(path(inv.id, p.id), f.admin, 'POST', stale)).status, 409);
  assert.deepEqual(f.state(inv.id), before);
  const staleCharges = await f.input(inv.id);
  await f.correct(inv.id, 15000);
  assert.equal((await f.call(path(inv.id, p.id), f.admin, 'POST', staleCharges)).status, 409);
  const saved = await f.refund(inv.id, p.id, { amountPaise: 10000 });
  const replay = await f.call(path(inv.id, p.id), f.admin, 'POST', saved.body);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data.refund, saved.value.refund);
  assert.equal(
    (await f.call(path(inv.id, p.id), f.admin, 'POST', await f.input(inv.id, { amountPaise: 1 })))
      .status,
    409,
  );
});

test('patient and staff see safe refund history while another patient cannot; live summaries change and saved copies remain frozen', async (t) => {
  const f = await fixture(t),
    patient = await f.login('patient'),
    inv = (await f.invoice()).value,
    p = (await f.pay(inv.id)).payment;
  const before = await f.call(`/patients/${inv.patientId}/care-summary`, patient);
  assert.equal(before.status, 200);
  const savedCopy = await f.call(
    `/patients/${inv.patientId}/care-summary/copies`,
    patient,
    'POST',
    { expectedRevision: before.data.revision, requestId: randomUUID() },
  );
  assert.equal(savedCopy.status, 201);
  const refunded = await f.refund(inv.id, p.id, {
    method: 'bank',
    reference: 'EXTERNAL_REFUND_REFERENCE',
    reason: 'PATIENT_SHARED_REFUND_REASON',
  });
  for (const who of [patient, await f.login('doctor'), await f.login('reception')]) {
    const d = await f.detail(inv.id, who);
    assert.deepEqual(d.refunds, [refunded.value.refund]);
    assert.equal('receipt' in d, false);
    assert.equal('createdById' in d.refunds[0], false);
    assert.equal('requestId' in d.refunds[0], false);
    assert.equal('expectedRevision' in d.refunds[0], false);
  }
  const after = await f.call(`/patients/${inv.patientId}/care-summary`, patient);
  assert.notEqual(after.data.revision, before.data.revision);
  assert.ok(JSON.stringify(after.data).includes('PATIENT_SHARED_REFUND_REASON'));
  assert.equal(JSON.stringify(after.data).includes(refunded.body.requestId), false);
  const copy = await f.call(
    `/patients/${inv.patientId}/care-summary/copies/${savedCopy.data.copy.id}`,
    patient,
  );
  assert.equal(copy.status, 200);
  assert.equal(JSON.stringify(copy.data.summary).includes('PATIENT_SHARED_REFUND_REASON'), false);
  const activity = await f.call('/activity', patient);
  assert.ok(
    activity.data.items.some(
      (item: { title: string; href: string }) =>
        item.title === 'Your clinic recorded a refund completed outside the app' &&
        item.href === `/my-care/invoices?invoice=${inv.id}`,
    ),
  );
  const other = await f.call('/auth/register', undefined, 'POST', {
    name: 'Other refund patient',
    email: `${randomUUID()}@example.test`,
    password: 'OtherPatient2026!',
    phone: '9000000001',
    dob: '1990-01-01',
    gender: 'Other',
  });
  assert.equal(other.status, 201);
  const outsider: Client = {
    cookie: other.headers.get('set-cookie')!.split(';')[0],
    csrf: other.data.csrfToken,
    user: other.data.user,
  };
  assert.equal((await f.call(`/invoices/${inv.id}`, outsider)).status, 403);
  assert.equal((await f.call(path(inv.id, p.id), outsider, 'POST', refunded.body)).status, 403);
});

test('fresh authorization is checked under lock on refund, correction and reversal paths including all exact retries', async (t) => {
  const f = await fixture(t),
    inv = (await f.invoice()).value,
    p = (await f.pay(inv.id)).payment,
    refund = await f.refund(inv.id, p.id);
  const correction = {
    items: items(7000),
    reason: 'Charge correction',
    expectedRevision: (await f.detail(inv.id)).revision,
    requestId: randomUUID(),
  };
  assert.equal(
    (await f.call(`/invoices/${inv.id}/corrections`, f.admin, 'POST', correction)).status,
    200,
  );
  const reversedInvoice = (await f.invoice()).value,
    rp = (await f.pay(reversedInvoice.id)).payment;
  const reversal = {
    reason: 'Entry error',
    entryErrorConfirmed: true,
    expectedRevision: (await f.detail(reversedInvoice.id)).revision,
    requestId: randomUUID(),
  };
  assert.equal(
    (
      await f.call(
        `/invoices/${reversedInvoice.id}/payments/${rp.id}/reverse`,
        f.admin,
        'POST',
        reversal,
      )
    ).status,
    200,
  );
  const routes: [string, unknown][] = [
    [path(inv.id, p.id), refund.body],
    [path(inv.id, p.id), await f.input(inv.id)],
    [`/invoices/${inv.id}/corrections`, correction],
    [`/invoices/${inv.id}/corrections`, { ...correction, requestId: randomUUID() }],
    [`/invoices/${reversedInvoice.id}/payments/${rp.id}/reverse`, reversal],
    [
      `/invoices/${reversedInvoice.id}/payments/${rp.id}/reverse`,
      { ...reversal, requestId: randomUUID() },
    ],
  ];
  const external = openDatabase(f.databasePath),
    original = f.db.exec.bind(f.db);
  const user = external.prepare('SELECT role,data FROM users WHERE id=?').get(f.admin.user.id)!;
  const session = external.prepare('SELECT * FROM sessions WHERE userId=?').get(f.admin.user.id)!,
    columns = Object.keys(session);
  try {
    for (const change of ['revoked', 'expired', 'csrf', 'inactive', 'temporary', 'role', 'mfa'])
      for (const [url, body] of routes) {
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
                .prepare("UPDATE sessions SET csrfToken='replaced-csrf' WHERE userId=?")
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
                  "UPDATE users SET role='receptionist',data=json_set(data,'$.role','receptionist') WHERE id=?",
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
          r = await f.call(url, f.admin, 'POST', body);
        assert.ok(fired);
        assert.ok([401, 403].includes(r.status), `${change}:${url}:${r.status}`);
        assert.deepEqual(f.state(inv.id), before);
        f.db.exec = original;
        external
          .prepare('UPDATE users SET role=?,data=? WHERE id=?')
          .run(user.role as string, user.data as string, f.admin.user.id);
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
  const patient = await f.login('patient');
  assert.equal((await f.call(`/invoices/${inv.id}/corrections`, patient, 'POST', {})).status, 403);
  assert.equal(
    (await f.call(`/invoices/${inv.id}/payments/${p.id}/reverse`, patient, 'POST', {})).status,
    403,
  );
});

test('source updates committed just before BEGIN invalidate a pending refund rather than subtracting from cached invoice state', async (t) => {
  const f = await fixture(t),
    inv = (await f.invoice()).value,
    p = (await f.pay(inv.id)).payment,
    body = await f.input(inv.id);
  const external = openDatabase(f.databasePath),
    original = f.db.exec.bind(f.db);
  let changed = false;
  f.db.exec = ((sql: string) => {
    if (sql === 'BEGIN IMMEDIATE' && !changed) {
      changed = true;
      external
        .prepare(
          "UPDATE invoices SET data=json_set(data,'$.items',json(?),'$.totalPaise',12000,'$.status','partial') WHERE id=?",
        )
        .run(JSON.stringify(items(12000)), inv.id);
    }
    return original(sql);
  }) as typeof f.db.exec;
  try {
    const r = await f.call(path(inv.id, p.id), f.admin, 'POST', body);
    assert.equal(r.status, 409);
    assert.ok(changed);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM paymentRefunds').get()!.n, 0);
  } finally {
    f.db.exec = original;
    external.close();
  }
  const result = await f.refund(inv.id, p.id);
  assert.equal(result.value.detail.invoice.totalPaise, 12000);
  assert.equal(result.value.detail.invoice.paidPaise, 7000);
});

test('refund event, command, invoice, audit, activity and final response failures all roll back without consuming the retry key', async (t) => {
  for (const point of ['refund', 'command', 'invoice', 'audit', 'activity', 'response']) {
    const f = await fixture(t),
      inv = (await f.invoice()).value,
      p = (await f.pay(inv.id)).payment,
      body = await f.input(inv.id);
    const original = f.db.prepare.bind(f.db);
    if (point === 'response')
      f.db.prepare = ((sql: string) => {
        if (sql === 'SELECT data FROM paymentRefunds WHERE invoiceId=? ORDER BY rowid DESC') {
          const statement = original(sql),
            all = statement.all.bind(statement);
          statement.all = ((...params: Parameters<typeof statement.all>) => {
            const rows = all(...params);
            if (rows.length) throw new Error('Synthetic response failure');
            return rows;
          }) as typeof statement.all;
          return statement;
        }
        return original(sql);
      }) as typeof f.db.prepare;
    else {
      const table =
        point === 'refund'
          ? 'paymentRefunds'
          : point === 'command'
            ? 'billingCorrectionCommands'
            : point === 'invoice'
              ? 'invoices'
              : point;
      const operation = point === 'invoice' ? 'UPDATE' : 'INSERT';
      const condition =
        point === 'audit'
          ? "json_extract(NEW.data,'$.action')='recorded external payment refund'"
          : point === 'activity'
            ? "NEW.eventKey LIKE 'billing-corrected:%'"
            : '1';
      f.db.exec(
        `CREATE TRIGGER fail_refund BEFORE ${operation} ON ${table} WHEN ${condition} BEGIN SELECT RAISE(ABORT,'Synthetic refund rollback'); END`,
      );
    }
    const before = f.state(inv.id);
    try {
      assert.equal((await f.call(path(inv.id, p.id), f.admin, 'POST', body)).status, 500, point);
      assert.deepEqual(f.state(inv.id), before, point);
    } finally {
      f.db.prepare = original;
      if (point !== 'response') f.db.exec('DROP TRIGGER fail_refund');
    }
    assert.equal((await f.call(path(inv.id, p.id), f.admin, 'POST', body)).status, 201, point);
    await f.close();
  }
});

test('independent application connections serialize duplicate and competing refunds, and refund versus entry reversal', async (t) => {
  const f = await fixture(t),
    inv = (await f.invoice()).value,
    p = (await f.pay(inv.id)).payment,
    g = await fixture(t, f.databasePath);
  const body = await f.input(inv.id, { amountPaise: 6000 });
  const duplicates = await Promise.all([
    f.call(path(inv.id, p.id), f.admin, 'POST', body),
    g.call(path(inv.id, p.id), f.admin, 'POST', body),
  ]);
  assert.deepEqual(duplicates.map((r) => r.status).sort(), [200, 201]);
  assert.deepEqual(duplicates[0].data, duplicates[1].data);
  const source = await f.input(inv.id, { amountPaise: 4000 });
  const competing = await Promise.all([
    f.call(path(inv.id, p.id), f.admin, 'POST', source),
    g.call(path(inv.id, p.id), f.admin, 'POST', { ...source, requestId: randomUUID() }),
  ]);
  assert.deepEqual(competing.map((r) => r.status).sort(), [201, 409]);
  assert.equal((await f.detail(inv.id)).invoice.paidPaise, 0);
  const another = (await f.invoice()).value,
    p2 = (await f.pay(another.id)).payment,
    refundBody = await f.input(another.id),
    revision = refundBody.expectedRevision;
  const races = await Promise.all([
    f.call(path(another.id, p2.id), f.admin, 'POST', refundBody),
    g.call(`/invoices/${another.id}/payments/${p2.id}/reverse`, f.admin, 'POST', {
      reason: 'Recorded entry error',
      entryErrorConfirmed: true,
      expectedRevision: revision,
      requestId: randomUUID(),
    }),
  ]);
  assert.equal(races.filter((r) => r.status === 409).length, 1);
  assert.equal(races.filter((r) => [200, 201].includes(r.status)).length, 1);
  const d = await f.detail(another.id);
  assert.equal(d.refunds.length + d.reversals.length, 1);
  assert.ok(d.invoice.paidPaise === 0 || d.invoice.paidPaise === 7000);
  if (d.refunds.length) assert.equal((await f.reverse(another.id, p2.id)).status, 409);
  else
    assert.equal(
      (await f.call(path(another.id, p2.id), f.admin, 'POST', await f.input(another.id))).status,
      409,
    );
});

test('append-only refunds and original receipt survive restart; source association and shared command namespace remain enforced', async (t) => {
  const f = await fixture(t),
    inv = (await f.invoice()).value,
    p = (await f.pay(inv.id)).payment,
    first = await f.refund(inv.id, p.id);
  await f.close();
  const second = await fixture(t, f.databasePath);
  const r = await second.call(path(inv.id, p.id), f.admin, 'POST', first.body);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, first.value);
  assert.throws(
    () =>
      second.db
        .prepare('UPDATE paymentRefunds SET amountPaise=1 WHERE id=?')
        .run(first.value.refund.id),
    /immutable/,
  );
  assert.throws(
    () => second.db.prepare('DELETE FROM paymentRefunds WHERE id=?').run(first.value.refund.id),
    /immutable/,
  );
  assert.throws(
    () =>
      second.db
        .prepare('UPDATE billingCorrectionCommands SET payload=? WHERE requestId=?')
        .run('{}', first.body.requestId),
    /immutable/,
  );
  const other = (await second.invoice()).value;
  assert.throws(
    () =>
      second.db
        .prepare(
          'INSERT INTO paymentRefunds(id,invoiceId,paymentId,amountPaise,createdAt,data) VALUES (?,?,?,?,?,?)',
        )
        .run(randomUUID(), other.id, p.id, 1, new Date().toISOString(), '{}'),
    /FOREIGN KEY/,
  );
  const initialCorrection = await second.correct(other.id, 9000);
  assert.equal(initialCorrection.status, 200);
  const command = second.db
    .prepare(
      "SELECT requestId FROM billingCorrectionCommands WHERE invoiceId=? AND operation='charges'",
    )
    .get(other.id)!;
  assert.equal(
    (
      await second.call(path(inv.id, p.id), f.admin, 'POST', {
        ...first.body,
        requestId: command.requestId,
      })
    ).status,
    409,
  );
});

test('legacy database migration adds empty refund history without rewriting invoice/payment JSON or fabricating old refund records', async (t) => {
  const f = await fixture(t),
    inv = (await f.invoice()).value,
    p = (await f.pay(inv.id)).payment;
  const invoiceSource = f.db.prepare('SELECT data FROM invoices WHERE id=?').get(inv.id)!.data,
    paymentSource = f.db.prepare('SELECT data FROM payments WHERE id=?').get(p.id)!.data;
  f.db.exec('DROP TABLE paymentRefunds');
  const g = await fixture(t, f.databasePath);
  const current = await g.detail(inv.id);
  assert.deepEqual(current.refunds, []);
  assert.equal(current.invoice.paidPaise, 10000);
  assert.equal(
    g.db.prepare('SELECT data FROM invoices WHERE id=?').get(inv.id)!.data,
    invoiceSource,
  );
  assert.equal(g.db.prepare('SELECT data FROM payments WHERE id=?').get(p.id)!.data, paymentSource);
  assert.ok(
    g.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='payment_refunds_created_at'",
      )
      .get(),
  );
  await g.refund(inv.id, p.id);
  assert.equal((await g.detail(inv.id)).refunds.length, 1);
});
