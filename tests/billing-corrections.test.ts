import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import { addDays, clinicToday, createUser, get, openDatabase, seedDemo } from '../server/db.ts';
import { reversedPaymentIds, safeInvoiceHistory } from '../server/billing-corrections.ts';
import type { Invoice, InvoiceDetail, InvoiceItem, Payment } from '../shared/operations.ts';

const app = createApp({ databasePath: ':memory:', demoMode: true });
type Client = { cookie?: string; csrf?: string };
const admin: Client = {},
  secondAdmin: Client = {},
  doctor: Client = {},
  reception: Client = {},
  patient: Client = {},
  otherPatient: Client = {},
  temporary: Client = {};
let server: Server, base: string;
async function call(
  path: string,
  client: Client = admin,
  method = 'GET',
  body?: unknown,
  target = base,
) {
  const response = await fetch(`${target}/api${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(client.cookie ? { Cookie: client.cookie } : {}),
      ...(client.csrf ? { 'X-CSRF-Token': client.csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const cookie = response.headers.get('set-cookie');
  if (cookie) client.cookie = cookie.split(';')[0];
  const data = await response.json();
  if (data.csrfToken) client.csrf = data.csrfToken;
  return { status: response.status, data, headers: response.headers };
}
async function listen(application: ReturnType<typeof createApp>) {
  let instance: Server;
  await new Promise<void>((resolve) => {
    instance = application.listen(0, '127.0.0.1', () => resolve());
  });
  const address = instance!.address();
  assert.ok(address && typeof address !== 'string');
  return { server: instance!, base: `http://127.0.0.1:${address.port}` };
}
async function close(instance: Server) {
  await new Promise<void>((resolve, reject) =>
    instance.close((error) => (error ? reject(error) : resolve())),
  );
}
const items = (amount = 10000, description = 'Synthetic clinic charge'): InvoiceItem[] => [
  { description, quantity: 1, unitAmountPaise: amount },
];
async function invoice(overrides: Record<string, unknown> = {}): Promise<Invoice> {
  const result = await call('/invoices', reception, 'POST', {
    patientId: 'patient-ananya',
    items: items(),
    requestId: randomUUID(),
    ...overrides,
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data;
}
async function detail(invoiceId: string, client = admin): Promise<InvoiceDetail> {
  const result = await call(`/invoices/${invoiceId}`, client);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data;
}
async function correctionBody(invoiceId: string, overrides: Record<string, unknown> = {}) {
  return {
    items: items(12000),
    reason: 'Corrected a clerical charge entry',
    expectedRevision: (await detail(invoiceId)).revision,
    requestId: randomUUID(),
    ...overrides,
  };
}
async function reversalBody(invoiceId: string, overrides: Record<string, unknown> = {}) {
  return {
    reason: 'The payment entry was recorded in error',
    entryErrorConfirmed: true,
    expectedRevision: (await detail(invoiceId)).revision,
    requestId: randomUUID(),
    ...overrides,
  };
}
async function pay(invoiceId: string, amount = 4000, overrides: Record<string, unknown> = {}) {
  const body = {
    amountPaise: amount,
    method: 'cash',
    reference: 'synthetic receipt',
    requestId: randomUUID(),
    ...overrides,
  };
  const result = await call(`/invoices/${invoiceId}/payments`, reception, 'POST', body);
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return {
    body,
    detail: result.data as InvoiceDetail,
    payment: result.data.payments.at(-1) as Payment,
  };
}
async function correct(invoiceId: string, overrides: Record<string, unknown> = {}) {
  return call(
    `/invoices/${invoiceId}/corrections`,
    admin,
    'POST',
    await correctionBody(invoiceId, overrides),
  );
}
async function reverse(
  invoiceId: string,
  paymentId: string,
  overrides: Record<string, unknown> = {},
) {
  return call(
    `/invoices/${invoiceId}/payments/${paymentId}/reverse`,
    admin,
    'POST',
    await reversalBody(invoiceId, overrides),
  );
}
before(async () => {
  createUser(
    app.locals.db,
    {
      id: 'billing-other-admin',
      name: 'Second administrator',
      email: 'billing-admin@example.test',
      role: 'admin',
    },
    'BillingAdmin2026!',
  );
  createUser(
    app.locals.db,
    {
      id: 'billing-temp-admin',
      name: 'Temporary administrator',
      email: 'billing-temp@example.test',
      role: 'admin',
      mustChangePassword: true,
    },
    'BillingTemporary2026!',
  );
  createUser(
    app.locals.db,
    {
      id: 'billing-other-patient',
      name: 'Other patient',
      email: 'billing-patient@example.test',
      role: 'patient',
      patientId: 'patient-2',
    },
    'BillingPatient2026!',
  );
  ({ server, base } = await listen(app));
  for (const [role, client] of [
    ['admin', admin],
    ['doctor', doctor],
    ['reception', reception],
    ['patient', patient],
  ] as const)
    assert.equal(
      (
        await call('/auth/login', client, 'POST', {
          email: `${role}@derma.demo`,
          password: 'DemoClinic2026!',
        })
      ).status,
      200,
    );
  for (const [client, email, password] of [
    [secondAdmin, 'billing-admin@example.test', 'BillingAdmin2026!'],
    [temporary, 'billing-temp@example.test', 'BillingTemporary2026!'],
    [otherPatient, 'billing-patient@example.test', 'BillingPatient2026!'],
  ] as const)
    assert.equal((await call('/auth/login', client, 'POST', { email, password })).status, 200);
});
after(async () => {
  await close(server);
  app.locals.close();
});

test('only administrators can correct charges or reverse entries, while safe histories remain available to authorized invoice readers', async () => {
  const created = await invoice(),
    paid = await pay(created.id);
  const correction = await correctionBody(created.id),
    reversal = await reversalBody(created.id);
  const paths = [
    `/invoices/${created.id}/corrections`,
    `/invoices/${created.id}/payments/${paid.payment.id}/reverse`,
  ];
  for (const [index, path] of paths.entries()) {
    const body = index === 0 ? correction : reversal;
    assert.equal((await call(path, {}, 'POST', body)).status, 401);
    for (const client of [doctor, reception, patient, otherPatient, temporary])
      assert.equal((await call(path, client, 'POST', body)).status, 403);
    assert.equal((await call(path, { cookie: admin.cookie }, 'POST', body)).status, 403);
  }
  assert.equal((await call(paths[0], secondAdmin, 'POST', correction)).status, 200);
  assert.equal((await reverse(created.id, paid.payment.id)).status, 200);
  const expected = await detail(created.id);
  for (const client of [admin, secondAdmin, doctor, reception, patient]) {
    const response = await call(`/invoices/${created.id}`, client);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(response.data, expected);
  }
  assert.equal((await call(`/invoices/${created.id}`, otherPatient)).status, 403);
  for (const event of [...expected.corrections, ...expected.reversals]) {
    assert.equal('createdById' in event, false);
    assert.equal('requestId' in event, false);
    assert.ok(event.createdByName);
  }
});

test('corrections preserve initial charges, identity snapshots and original issue timestamp while retaining immutable before/after states', async () => {
  const created = await invoice(),
    paid = await pay(created.id);
  const original = await detail(created.id);
  assert.deepEqual(original.issuedCharges, {
    items: created.items,
    totalPaise: created.totalPaise,
  });
  assert.deepEqual(original.corrections, []);
  assert.deepEqual(original.reversals, []);
  const first = await correct(created.id, { items: items(8000) });
  assert.equal(first.status, 200);
  const event = first.data.corrections[0];
  assert.deepEqual(event.before, {
    items: created.items,
    totalPaise: 10000,
    paidPaise: 4000,
    status: 'partial',
  });
  assert.deepEqual(event.after, {
    items: items(8000),
    totalPaise: 8000,
    paidPaise: 4000,
    status: 'partial',
  });
  const second = await correct(created.id, { items: items(4000) });
  assert.equal(second.status, 200);
  assert.equal(second.data.invoice.status, 'paid');
  assert.deepEqual(second.data.issuedCharges, original.issuedCharges);
  assert.deepEqual(second.data.corrections[1], event);
  for (const field of ['id', 'number', 'patientId', 'patientName', 'createdAt'] as const)
    assert.equal(second.data.invoice[field], created[field]);
  assert.deepEqual(second.data.payments, [paid.payment]);
  assert.deepEqual(safeInvoiceHistory(app.locals.db, created.id), {
    invoiceId: created.id,
    issuedCharges: original.issuedCharges,
    corrections: second.data.corrections,
    reversals: [],
    refunds: [],
  });
});

test('zero-item corrections require explicit confirmation and zero net payments, and no-charge invoices reject new payments', async () => {
  const created = await invoice(),
    paid = await pay(created.id);
  assert.equal((await correct(created.id, { items: [] })).status, 400);
  assert.equal(
    (await correct(created.id, { items: [], removeAllChargesConfirmed: true })).status,
    409,
  );
  assert.equal((await correct(created.id, { items: items(3999) })).status, 409);
  assert.equal((await reverse(created.id, paid.payment.id)).status, 200);
  const zero = await correct(created.id, { items: [], removeAllChargesConfirmed: true });
  assert.equal(zero.status, 200);
  assert.equal(zero.data.invoice.status, 'no-charge');
  assert.equal(zero.data.invoice.totalPaise, 0);
  assert.equal(zero.data.invoice.paidPaise, 0);
  assert.deepEqual(zero.data.invoice.items, []);
  assert.equal(
    (
      await call(`/invoices/${created.id}/payments`, reception, 'POST', {
        ...paid.body,
        requestId: randomUUID(),
        amountPaise: 1,
      })
    ).status,
    409,
  );
  const restored = await correct(created.id, { items: items(1000) });
  assert.equal(restored.status, 200);
  assert.equal(restored.data.invoice.status, 'unpaid');
  assert.equal((await pay(created.id, 1000)).detail.invoice.status, 'paid');
});

test('full entry reversals preserve the source payment and recalculate net balance without replaying an erroneous receipt', async () => {
  const created = await invoice(),
    first = await pay(created.id, 4000),
    second = await pay(created.id, 6000);
  const originalRows = app.locals.db
    .prepare('SELECT * FROM payments WHERE invoiceId=? ORDER BY rowid')
    .all(created.id);
  const result = await reverse(created.id, first.payment.id);
  assert.equal(result.status, 200);
  assert.equal(result.data.invoice.paidPaise, 6000);
  assert.equal(result.data.invoice.status, 'partial');
  assert.equal(result.data.reversals[0].amountPaise, 4000);
  assert.equal(result.data.reversals[0].beforePaidPaise, 10000);
  assert.equal(result.data.reversals[0].afterPaidPaise, 6000);
  assert.equal(result.data.reversals[0].entryErrorConfirmed, true);
  assert.deepEqual(
    app.locals.db
      .prepare('SELECT * FROM payments WHERE invoiceId=? ORDER BY rowid')
      .all(created.id),
    originalRows,
  );
  assert.deepEqual(result.data.payments, [first.payment, second.payment]);
  const retry = await call(`/invoices/${created.id}/payments`, reception, 'POST', first.body);
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.data, result.data);
  assert.equal((await reverse(created.id, first.payment.id)).status, 409);
  assert.equal(
    (
      await call(`/invoices/${created.id}/payments`, reception, 'POST', {
        ...first.body,
        requestId: randomUUID(),
        amountPaise: 4001,
      })
    ).status,
    409,
  );
  const replacement = await pay(created.id, 4000, {
    method: 'upi',
    reference: 'Correct independently verified receipt',
  });
  assert.equal(replacement.detail.invoice.paidPaise, 10000);
  assert.equal(replacement.detail.invoice.status, 'paid');
  assert.equal(replacement.detail.payments.length, 3);
  assert.ok(reversedPaymentIds(app.locals.db).has(first.payment.id));
  assert.equal(reversedPaymentIds(app.locals.db).has(second.payment.id), false);
});

test('invoice creation retries compare issued charges after corrections and preserve procedure linkage through cancellation', async () => {
  const procedure = await call('/procedures', doctor, 'POST', {
    patientId: 'patient-ananya',
    title: 'Synthetic procedure',
    indication: 'Documented discussion',
    benefits: 'Discussed',
    risks: 'Discussed',
    alternatives: 'Discussed',
    aftercare: 'Clinic instructions',
    estimatedCost: 'Discussed separately',
  });
  assert.equal(procedure.status, 201, JSON.stringify(procedure.data));
  const body = {
    patientId: 'patient-ananya',
    items: items(),
    requestId: randomUUID(),
    procedureId: procedure.data.id,
  };
  const created = await call('/invoices', reception, 'POST', body);
  assert.equal(created.status, 201);
  const serialBefore = app.locals.db.prepare('SELECT nextValue FROM invoiceSequence').get()!
    .nextValue;
  const corrected = await correct(created.data.id, { items: items(15000) });
  assert.equal(corrected.status, 200);
  assert.equal(
    (
      await call(`/procedures/${procedure.data.id}/cancel`, doctor, 'POST', {
        reason: 'Synthetic cancellation',
      })
    ).status,
    200,
  );
  const retry = await call('/invoices', reception, 'POST', body);
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.data, corrected.data.invoice);
  assert.equal(
    app.locals.db.prepare('SELECT nextValue FROM invoiceSequence').get()!.nextValue,
    serialBefore,
  );
  assert.equal(
    (await call('/invoices', reception, 'POST', { ...body, items: items(15000) })).status,
    409,
  );
  assert.equal(corrected.data.invoice.procedureId, procedure.data.id);
  assert.equal(
    app.locals.db
      .prepare('SELECT invoiceId FROM procedureInvoiceLinks WHERE procedureId=?')
      .get(procedure.data.id)!.invoiceId,
    created.data.id,
  );
});

test('correction retries are actor-bound and return current detail before stale checks after later changes', async () => {
  const created = await invoice(),
    another = await invoice();
  const body = await correctionBody(created.id);
  const simultaneous = await Promise.all(
    [1, 2].map(() => call(`/invoices/${created.id}/corrections`, admin, 'POST', body)),
  );
  assert.deepEqual(
    simultaneous.map((result) => result.status),
    [200, 200],
  );
  assert.equal((await detail(created.id)).corrections.length, 1);
  const later = await correct(created.id, { items: items(14000) });
  assert.equal(later.status, 200);
  const retry = await call(`/invoices/${created.id}/corrections`, admin, 'POST', {
    ...body,
    expectedRevision: '0'.repeat(64),
  });
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.data, later.data);
  assert.equal(
    (await call(`/invoices/${created.id}/corrections`, secondAdmin, 'POST', body)).status,
    409,
  );
  assert.equal(
    (
      await call(`/invoices/${created.id}/corrections`, admin, 'POST', {
        ...body,
        reason: 'Different reason',
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call(`/invoices/${another.id}/corrections`, admin, 'POST', {
        ...body,
        expectedRevision: (await detail(another.id)).revision,
      })
    ).status,
    409,
  );
  const paid = await pay(created.id);
  assert.equal(
    (await reverse(created.id, paid.payment.id, { requestId: body.requestId })).status,
    409,
  );
});

test('reversal retries cannot cross actor, invoice, payment or reason and remain idempotent after later payments', async () => {
  const created = await invoice(),
    another = await invoice();
  const first = await pay(created.id, 3000),
    second = await pay(created.id, 2000),
    other = await pay(another.id);
  const body = await reversalBody(created.id);
  const path = `/invoices/${created.id}/payments/${first.payment.id}/reverse`;
  assert.equal((await call(path, admin, 'POST', body)).status, 200);
  await pay(created.id, 3000);
  const current = await detail(created.id);
  assert.deepEqual((await call(path, admin, 'POST', body)).data, current);
  assert.equal((await call(path, secondAdmin, 'POST', body)).status, 409);
  assert.equal(
    (await call(path, admin, 'POST', { ...body, reason: 'Different reason' })).status,
    409,
  );
  assert.equal(
    (await reverse(created.id, second.payment.id, { requestId: body.requestId })).status,
    409,
  );
  assert.equal(
    (await reverse(another.id, other.payment.id, { requestId: body.requestId })).status,
    409,
  );
  assert.equal((await reverse(created.id, other.payment.id)).status, 404);
  assert.equal((await reverse(created.id, 'missing')).status, 404);
  assert.equal((await correct(created.id, { requestId: body.requestId })).status, 409);
});

test('payment changes stale correction/reversal forms and competing corrections cannot overwrite one another', async () => {
  const created = await invoice(),
    paid = await pay(created.id);
  const correction = await correctionBody(created.id),
    reversal = await reversalBody(created.id);
  await pay(created.id, 1000);
  assert.equal(
    (await call(`/invoices/${created.id}/corrections`, admin, 'POST', correction)).status,
    409,
  );
  assert.equal(
    (
      await call(
        `/invoices/${created.id}/payments/${paid.payment.id}/reverse`,
        admin,
        'POST',
        reversal,
      )
    ).status,
    409,
  );
  const fresh = await correctionBody(created.id);
  const competing = await Promise.all([
    call(`/invoices/${created.id}/corrections`, admin, 'POST', fresh),
    call(`/invoices/${created.id}/corrections`, admin, 'POST', {
      ...fresh,
      items: items(13000),
      requestId: randomUUID(),
    }),
  ]);
  assert.deepEqual(competing.map((result) => result.status).sort(), [200, 409]);
  assert.equal((await detail(created.id)).corrections.length, 1);
});

test('concurrent payment versus charge reduction cannot produce an overpaid invoice and concurrent reversal cannot subtract twice', async () => {
  const created = await invoice();
  const body = await correctionBody(created.id, { items: items(6000) });
  const results = await Promise.all([
    call(`/invoices/${created.id}/corrections`, admin, 'POST', body),
    call(`/invoices/${created.id}/payments`, reception, 'POST', {
      amountPaise: 8000,
      method: 'cash',
      reference: '',
      requestId: randomUUID(),
    }),
  ]);
  assert.equal(results.filter((result) => result.status === 409).length, 1);
  assert.equal(results.filter((result) => [200, 201].includes(result.status)).length, 1);
  const current = await detail(created.id);
  assert.ok(current.invoice.paidPaise <= current.invoice.totalPaise);
  const next = await invoice(),
    paid = await pay(next.id),
    reversal = await reversalBody(next.id);
  const reversed = await Promise.all([
    call(`/invoices/${next.id}/payments/${paid.payment.id}/reverse`, admin, 'POST', reversal),
    call(`/invoices/${next.id}/payments/${paid.payment.id}/reverse`, admin, 'POST', {
      ...reversal,
      requestId: randomUUID(),
    }),
  ]);
  assert.deepEqual(reversed.map((result) => result.status).sort(), [200, 409]);
  const actual = await detail(next.id);
  assert.equal(actual.invoice.paidPaise, 0);
  assert.equal(actual.reversals.length, 1);
});

test('strict financial validation rejects fractional, negative, oversized, no-op and unconfirmed corrections without consuming retry keys', async () => {
  const created = await invoice(),
    paid = await pay(created.id),
    valid = await correctionBody(created.id);
  const badItems = [
    items(-1),
    items(1.5),
    items(1_000_000_001),
    [{ ...items()[0], quantity: 0 }],
    [{ ...items()[0], quantity: 1.5 }],
    [{ ...items()[0], quantity: 1001 }],
    [{ ...items()[0], quantity: 2, unitAmountPaise: 1_000_000_000 }],
    [{ ...items()[0], description: '' }],
    Array.from({ length: 101 }, () => items()[0]),
  ];
  for (const invalid of [
    ...badItems.map((lines) => ({ items: lines })),
    { items: created.items },
    { items: [] },
    { reason: '' },
    { reason: 'x'.repeat(1001) },
    { requestId: 'invalid' },
    { expectedRevision: 'bad' },
    { removeAllChargesConfirmed: true },
    { totalPaise: 0 },
    { patientId: 'patient-2' },
    { createdByName: 'Forged' },
  ])
    assert.equal(
      (await call(`/invoices/${created.id}/corrections`, admin, 'POST', { ...valid, ...invalid }))
        .status,
      400,
    );
  assert.equal(
    (await call(`/invoices/${created.id}/corrections`, admin, 'POST', valid)).status,
    200,
  );
  const reversal = await reversalBody(created.id);
  for (const invalid of [
    { entryErrorConfirmed: false },
    { entryErrorConfirmed: undefined },
    { reason: '' },
    { reason: 'x'.repeat(1001) },
    { amountPaise: 1 },
    { createdById: 'forged' },
  ])
    assert.equal(
      (
        await call(`/invoices/${created.id}/payments/${paid.payment.id}/reverse`, admin, 'POST', {
          ...reversal,
          ...invalid,
        })
      ).status,
      400,
    );
  assert.equal(
    (
      await call(
        `/invoices/${created.id}/payments/${paid.payment.id}/reverse`,
        admin,
        'POST',
        reversal,
      )
    ).status,
    200,
  );
});

test('audit or activity failure rolls back original snapshots, events, balances and retry receipts for both correction types', async () => {
  for (const failure of ['audit', 'activity']) {
    const created = await invoice(),
      paid = await pay(created.id);
    for (const kind of ['charges', 'reversal']) {
      const path =
        kind === 'charges'
          ? `/invoices/${created.id}/corrections`
          : `/invoices/${created.id}/payments/${paid.payment.id}/reverse`;
      const body =
        kind === 'charges' ? await correctionBody(created.id) : await reversalBody(created.id);
      const before = await detail(created.id);
      const action =
        kind === 'charges' ? 'corrected invoice charges' : 'reversed erroneous payment entry';
      const predicate =
        failure === 'audit'
          ? `json_extract(NEW.data,'$.action')='${action}'`
          : "NEW.eventKey LIKE 'billing-corrected:%'";
      app.locals.db.exec(
        `CREATE TRIGGER fail_billing_correction BEFORE INSERT ON ${failure} WHEN ${predicate} BEGIN SELECT RAISE(ABORT,'synthetic billing correction failure'); END;`,
      );
      try {
        assert.equal((await call(path, admin, 'POST', body)).status, 500);
      } finally {
        app.locals.db.exec('DROP TRIGGER fail_billing_correction');
      }
      assert.deepEqual(await detail(created.id), before);
      assert.equal(
        app.locals.db
          .prepare('SELECT COUNT(*) AS n FROM billingCorrectionCommands WHERE requestId=?')
          .get(body.requestId)!.n,
        0,
      );
      if (kind === 'charges')
        assert.equal(
          app.locals.db
            .prepare('SELECT COUNT(*) AS n FROM invoiceIssuedCharges WHERE id=?')
            .get(created.id)!.n,
          0,
        );
      assert.equal((await call(path, admin, 'POST', body)).status, 200);
    }
  }
});

test('billing notifications are generic, recipient-owned and deduplicated across exact retries', async () => {
  const created = await invoice(),
    paid = await pay(created.id);
  const reason = 'PATIENT_SHARED_REASON_NOT_NOTIFICATION_DETAIL';
  const correction = await correctionBody(created.id, { reason });
  const path = `/invoices/${created.id}/corrections`;
  await call(path, admin, 'POST', correction);
  await call(path, admin, 'POST', correction);
  const reversal = await reversalBody(created.id, { reason });
  const reversalPath = `/invoices/${created.id}/payments/${paid.payment.id}/reverse`;
  await call(reversalPath, admin, 'POST', reversal);
  await call(reversalPath, admin, 'POST', reversal);
  const all = app.locals.db
    .prepare("SELECT userId,data FROM activity WHERE eventKey LIKE 'billing-corrected:%'")
    .all();
  const rows = all.filter(
    (row: { data: string }) =>
      (JSON.parse(row.data) as { href: string }).href === `/my-care/invoices?invoice=${created.id}`,
  );
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.userId, 'user-patient');
    assert.equal(String(row.data).includes(reason), false);
    assert.equal(String(row.data).toLowerCase().includes('refund'), false);
  }
});

test('immutable source events and payment/invoice ownership constraints protect history', async () => {
  const created = await invoice(),
    paid = await pay(created.id),
    other = await invoice();
  await correct(created.id);
  await reverse(created.id, paid.payment.id);
  for (const table of [
    'invoiceIssuedCharges',
    'invoiceCorrections',
    'paymentReversals',
    'billingCorrectionCommands',
    'payments',
  ]) {
    const row = app.locals.db.prepare(`SELECT rowid FROM ${table} LIMIT 1`).get()!;
    const column = table === 'billingCorrectionCommands' ? 'payload' : 'data';
    assert.throws(
      () =>
        app.locals.db
          .prepare(`UPDATE ${table} SET ${column}=${column} WHERE rowid=?`)
          .run(row.rowid),
      /immutable|append-only/,
    );
    assert.throws(
      () => app.locals.db.prepare(`DELETE FROM ${table} WHERE rowid=?`).run(row.rowid),
      /immutable|append-only/,
    );
  }
  const unmatched = await pay(other.id);
  assert.throws(
    () =>
      app.locals.db
        .prepare('INSERT INTO paymentReversals(id,invoiceId,paymentId,data) VALUES (?,?,?,?)')
        .run(randomUUID(), created.id, unmatched.payment.id, '{}'),
    /FOREIGN KEY/,
  );
});

test('patient-facing summaries preserve safe correction history and reject stale snapshots after charge or entry corrections', async () => {
  const created = await invoice(),
    paid = await pay(created.id);
  const path = '/patients/patient-ananya/care-summary';
  const before = await call(path, patient);
  const corrected = await correct(created.id);
  assert.equal(corrected.status, 200);
  const middle = await call(path, patient);
  assert.notEqual(middle.data.revision, before.data.revision);
  assert.equal(
    (await call(`${path}/download?revision=${before.data.revision}`, patient)).status,
    409,
  );
  assert.equal((await reverse(created.id, paid.payment.id)).status, 200);
  const latest = await call(path, patient);
  assert.equal(
    (await call(`${path}/download?revision=${middle.data.revision}`, patient)).status,
    409,
  );
  const history = latest.data.invoiceHistories.find(
    (entry: { invoiceId: string }) => entry.invoiceId === created.id,
  );
  assert.deepEqual(history, safeInvoiceHistory(app.locals.db, created.id));
  for (const event of [...history.corrections, ...history.reversals]) {
    assert.equal('createdById' in event, false);
    assert.equal('requestId' in event, false);
  }
  const latestInvoice = latest.data.invoices.find((entry: Invoice) => entry.id === created.id);
  assert.equal(latestInvoice.totalPaise, 12000);
  assert.equal(latestInvoice.paidPaise, 0);
  assert.equal(
    (await call(`${path}/download?revision=${latest.data.revision}`, patient)).status,
    200,
  );
});

test('aggregate reports apply corrected charges to original issue dates and exclude reversed entries at their original recorded dates', async () => {
  const created = await invoice();
  const issueDate = addDays(clinicToday(), -30),
    paymentDate = addDays(clinicToday(), -20);
  const historicalInvoice: Invoice = {
    ...created,
    paidPaise: 5000,
    status: 'partial',
    createdAt: `${issueDate}T12:00:00+05:30`,
  };
  app.locals.db
    .prepare('UPDATE invoices SET data=? WHERE id=?')
    .run(JSON.stringify(historicalInvoice), created.id);
  const historicalPayment: Payment = {
    id: randomUUID(),
    invoiceId: created.id,
    amountPaise: 5000,
    method: 'bank',
    reference: 'Historical synthetic record',
    requestId: randomUUID(),
    createdAt: `${paymentDate}T12:00:00+05:30`,
  };
  app.locals.db
    .prepare('INSERT INTO payments(id,invoiceId,requestId,data) VALUES (?,?,?,?)')
    .run(
      historicalPayment.id,
      created.id,
      historicalPayment.requestId,
      JSON.stringify(historicalPayment),
    );
  const issueBefore = (await call(`/insights?from=${issueDate}&to=${issueDate}`)).data;
  const paymentBefore = (await call(`/insights?from=${paymentDate}&to=${paymentDate}`)).data;
  const todayBefore = (await call(`/insights?from=${clinicToday()}&to=${clinicToday()}`)).data;
  assert.equal((await correct(created.id, { items: items(7000) })).status, 200);
  assert.equal((await reverse(created.id, historicalPayment.id)).status, 200);
  const issueAfter = (await call(`/insights?from=${issueDate}&to=${issueDate}`)).data;
  const paymentAfter = (await call(`/insights?from=${paymentDate}&to=${paymentDate}`)).data;
  const todayAfter = (await call(`/insights?from=${clinicToday()}&to=${clinicToday()}`)).data;
  assert.equal(issueAfter.totals.invoicedPaise, issueBefore.totals.invoicedPaise - 3000);
  assert.equal(
    issueAfter.totals.issuedInvoiceOutstandingPaise,
    issueBefore.totals.issuedInvoiceOutstandingPaise + 2000,
  );
  assert.equal(issueAfter.totals.invoiceCount, issueBefore.totals.invoiceCount);
  assert.equal(paymentAfter.totals.collectionsPaise, paymentBefore.totals.collectionsPaise - 5000);
  assert.equal(paymentAfter.totals.paymentCount, paymentBefore.totals.paymentCount - 1);
  assert.equal(
    paymentAfter.collectionsByMethod.find((row: { method: string }) => row.method === 'bank')
      .amountPaise,
    0,
  );
  assert.equal(paymentAfter.daily[0].collectionsPaise, 0);
  assert.equal(todayAfter.totals.collectionsPaise, todayBefore.totals.collectionsPaise);
  assert.equal(todayAfter.totals.invoicedPaise, todayBefore.totals.invoicedPaise);
});

test('legacy invoices acquire no fabricated correction history and retain snapshots and retry commands across restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'derma-billing-correction-')),
    databasePath = join(directory, 'clinic.sqlite');
  let application: ReturnType<typeof createApp> | undefined, instance: Server | undefined;
  try {
    const legacy = openDatabase(databasePath);
    seedDemo(legacy);
    legacy.exec(`CREATE TABLE invoices(id TEXT PRIMARY KEY,patientId TEXT NOT NULL REFERENCES patients(id),invoiceNumber INTEGER NOT NULL UNIQUE,data TEXT NOT NULL);
      CREATE TABLE invoiceSequence(id INTEGER PRIMARY KEY CHECK(id=1),nextValue INTEGER NOT NULL);
      INSERT INTO invoiceSequence VALUES(1,43);
      CREATE TABLE payments(id TEXT PRIMARY KEY,invoiceId TEXT NOT NULL REFERENCES invoices(id),requestId TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(invoiceId,requestId));`);
    const original: Invoice = {
      id: randomUUID(),
      patientId: 'patient-ananya',
      patientName: 'Original historical patient snapshot',
      number: 'INV-000042',
      items: items(9000),
      totalPaise: 9000,
      paidPaise: 0,
      status: 'unpaid',
      createdAt: '2025-01-01T12:00:00Z',
    };
    legacy
      .prepare('INSERT INTO invoices(id,patientId,invoiceNumber,data) VALUES (?,?,?,?)')
      .run(original.id, original.patientId, 42, JSON.stringify(original));
    legacy.close();
    application = createApp({ databasePath, demoMode: true });
    let listening = await listen(application);
    instance = listening.server;
    const client: Client = {};
    await call(
      '/auth/login',
      client,
      'POST',
      { email: 'admin@derma.demo', password: 'DemoClinic2026!' },
      listening.base,
    );
    const path = `/invoices/${original.id}`;
    const initial = await call(path, client, 'GET', undefined, listening.base);
    assert.deepEqual(initial.data.invoice, original);
    assert.deepEqual(initial.data.corrections, []);
    assert.deepEqual(initial.data.reversals, []);
    const body = {
      items: items(9500),
      reason: 'Corrected known clerical entry',
      expectedRevision: initial.data.revision,
      requestId: randomUUID(),
    };
    const changed = await call(`${path}/corrections`, client, 'POST', body, listening.base);
    assert.equal(changed.status, 200);
    await close(instance);
    instance = undefined;
    application.locals.close();
    application = undefined;
    application = createApp({ databasePath, demoMode: true });
    listening = await listen(application);
    instance = listening.server;
    assert.deepEqual(
      (await call(path, client, 'GET', undefined, listening.base)).data,
      changed.data,
    );
    assert.deepEqual(
      (await call(`${path}/corrections`, client, 'POST', body, listening.base)).data,
      changed.data,
    );
    assert.equal(
      get<Invoice>(application.locals.db, 'invoices', original.id)!.patientName,
      original.patientName,
    );
    assert.deepEqual(safeInvoiceHistory(application.locals.db, original.id).issuedCharges, {
      items: original.items,
      totalPaise: original.totalPaise,
    });
  } finally {
    if (instance) await close(instance);
    application?.locals.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
