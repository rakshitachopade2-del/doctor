import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';

const app = createApp({ databasePath: ':memory:', demoMode: true });
let server: Server;
let base: string;
type Client = { cookie?: string; csrf?: string };
const doctor: Client = {},
  patient: Client = {},
  reception: Client = {},
  admin: Client = {},
  other: Client = {};
async function call(
  path: string,
  { method = 'GET', body, client = {} }: { method?: string; body?: unknown; client?: Client } = {},
) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(client.cookie ? { Cookie: client.cookie } : {}),
      ...(client.csrf ? { 'X-CSRF-Token': client.csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const cookie = response.headers.get('set-cookie');
  if (cookie) client.cookie = cookie.split(';')[0];
  const data = await response.json();
  if (data.csrfToken) client.csrf = data.csrfToken;
  return { status: response.status, data };
}
before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  for (const [role, client] of [
    ['doctor', doctor],
    ['patient', patient],
    ['reception', reception],
    ['admin', admin],
  ] as const) {
    assert.equal(
      (
        await call('/auth/login', {
          method: 'POST',
          client,
          body: { email: `${role}@derma.demo`, password: 'DemoClinic2026!' },
        })
      ).status,
      200,
    );
  }
  assert.equal(
    (
      await call('/auth/register', {
        method: 'POST',
        client: other,
        body: {
          name: 'Other Patient',
          email: 'other@example.test',
          password: 'OtherPassword2026!',
          phone: '9000000088',
          dob: '1990-01-02',
          gender: 'Other',
        },
      })
    ).status,
    201,
  );
});
after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  app.locals.close();
});

let invoiceId: string;
test('staff create exact integer-money invoices with server-derived totals and patient snapshots', async () => {
  const body = {
    patientId: 'patient-ananya',
    items: [
      { description: 'Consultation', quantity: 1, unitAmountPaise: 80000 },
      { description: 'Procedure supplies', quantity: 2, unitAmountPaise: 12550 },
    ],
    totalPaise: 1,
    paidPaise: 9999999,
  };
  assert.equal((await call('/invoices', { method: 'POST', client: patient, body })).status, 403);
  const result = await call('/invoices', { method: 'POST', client: reception, body });
  assert.equal(result.status, 201);
  invoiceId = result.data.id;
  assert.equal(result.data.totalPaise, 105100);
  assert.equal(result.data.paidPaise, 0);
  assert.equal(result.data.status, 'unpaid');
  assert.equal(result.data.patientName, 'Ananya Sharma');
  assert.equal(result.data.number, 'INV-000001');
  const second = await call('/invoices', {
    method: 'POST',
    client: doctor,
    body: {
      patientId: 'patient-2',
      items: [{ description: 'Consultation', quantity: 1, unitAmountPaise: 70000 }],
    },
  });
  assert.equal(second.status, 201);
  assert.equal(second.data.number, 'INV-000002');
});
test('invoices reject fractional or negative money, invalid quantities and excessive totals', async () => {
  for (const item of [
    { description: 'Test', quantity: 1, unitAmountPaise: 1.5 },
    { description: 'Test', quantity: 1, unitAmountPaise: -100 },
    { description: 'Test', quantity: 0, unitAmountPaise: 100 },
    { description: 'Test', quantity: 1.2, unitAmountPaise: 100 },
    { description: 'Test', quantity: 2, unitAmountPaise: 1_000_000_000 },
  ])
    assert.equal(
      (
        await call('/invoices', {
          method: 'POST',
          client: admin,
          body: { patientId: 'patient-ananya', items: [item] },
        })
      ).status,
      400,
    );
  assert.equal(
    (
      await call('/invoices', {
        method: 'POST',
        client: admin,
        body: {
          patientId: 'missing',
          items: [{ description: 'Test', quantity: 1, unitAmountPaise: 100 }],
        },
      })
    ).status,
    404,
  );
});
test('invoice creation retries do not duplicate charges or consume a second invoice number', async () => {
  const input = {
    patientId: 'patient-3',
    items: [{ description: 'Consultation', quantity: 1, unitAmountPaise: 50000 }],
    requestId: randomUUID(),
  };
  const first = await call('/invoices', { method: 'POST', client: reception, body: input });
  const retry = await call('/invoices', { method: 'POST', client: reception, body: input });
  assert.equal(first.status, 201);
  assert.equal(retry.status, 200);
  assert.equal(retry.data.id, first.data.id);
  assert.equal(retry.data.number, first.data.number);
  assert.equal(
    (
      await call('/invoices', {
        method: 'POST',
        client: reception,
        body: { ...input, patientId: 'patient-4' },
      })
    ).status,
    409,
  );
});
test('patients see only their invoices and cannot see another invoice or enter payments', async () => {
  assert.equal((await call('/invoices')).status, 401);
  const own = await call('/invoices', { client: patient });
  assert.equal(own.data.length, 1);
  assert.equal(own.data[0].id, invoiceId);
  assert.equal((await call(`/invoices/${invoiceId}`, { client: other })).status, 403);
  assert.deepEqual((await call('/invoices', { client: other })).data, []);
  assert.equal(
    (
      await call(`/invoices/${invoiceId}/payments`, {
        method: 'POST',
        client: patient,
        body: { amountPaise: 100, method: 'cash', requestId: randomUUID() },
      })
    ).status,
    403,
  );
});
test('manual payment recording is atomic, idempotent, exact and rejects overpayments', async () => {
  const requestId = randomUUID();
  const input = { amountPaise: 50000, method: 'upi', reference: 'Test offline receipt', requestId };
  const first = await call(`/invoices/${invoiceId}/payments`, {
    method: 'POST',
    client: reception,
    body: input,
  });
  assert.equal(first.status, 201);
  assert.equal(first.data.invoice.paidPaise, 50000);
  assert.equal(first.data.invoice.status, 'partial');
  assert.equal(first.data.payments.length, 1);
  const retry = await call(`/invoices/${invoiceId}/payments`, {
    method: 'POST',
    client: reception,
    body: input,
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.data.invoice.paidPaise, 50000);
  assert.equal(retry.data.payments.length, 1);
  assert.equal(
    (
      await call(`/invoices/${invoiceId}/payments`, {
        method: 'POST',
        client: reception,
        body: { ...input, amountPaise: 50001 },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call(`/invoices/${invoiceId}/payments`, {
        method: 'POST',
        client: reception,
        body: { ...input, amountPaise: 55101, requestId: randomUUID() },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call(`/invoices/${invoiceId}/payments`, {
        method: 'POST',
        client: reception,
        body: { ...input, amountPaise: 0, requestId: randomUUID() },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call(`/invoices/${invoiceId}/payments`, {
        method: 'POST',
        client: reception,
        body: { ...input, requestId: undefined },
      })
    ).status,
    400,
  );
  const balance = await call(`/invoices/${invoiceId}/payments`, {
    method: 'POST',
    client: admin,
    body: { amountPaise: 55100, method: 'cash', requestId: randomUUID() },
  });
  assert.equal(balance.status, 201);
  assert.equal(balance.data.invoice.paidPaise, 105100);
  assert.equal(balance.data.invoice.status, 'paid');
  assert.equal(balance.data.payments.length, 2);
  assert.throws(() => app.locals.db.exec('DELETE FROM payments'), /append-only/);
});
test('concurrent payments cannot exceed the remaining balance', async () => {
  const created = await call('/invoices', {
    method: 'POST',
    client: reception,
    body: {
      patientId: 'patient-ananya',
      items: [{ description: 'Follow-up', quantity: 1, unitAmountPaise: 10000 }],
    },
  });
  const results = await Promise.all(
    [1, 2].map(() =>
      call(`/invoices/${created.data.id}/payments`, {
        method: 'POST',
        client: reception,
        body: { amountPaise: 7000, method: 'card', requestId: randomUUID() },
      }),
    ),
  );
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  const actual = await call(`/invoices/${created.data.id}`, { client: patient });
  assert.equal(actual.data.invoice.paidPaise, 7000);
  assert.equal(actual.data.payments.length, 1);
});
let articleId: string;
test('public knowledge excludes drafts and only clinicians can create or review content', async () => {
  const publicArticles = await call('/knowledge');
  assert.equal(publicArticles.status, 200);
  assert.ok(publicArticles.data.every((a: any) => a.status === 'published'));
  assert.equal((await call('/knowledge/manage', { client: reception })).status, 403);
  assert.equal((await call('/knowledge/manage', { client: patient })).status, 403);
  const input = {
    title: 'Test appointment guide',
    category: 'Clinic information',
    body: 'Contact reception to update your appointment.',
    status: 'published',
  };
  assert.equal(
    (await call('/knowledge', { method: 'POST', client: reception, body: input })).status,
    403,
  );
  const draft = await call('/knowledge', { method: 'POST', client: doctor, body: input });
  assert.equal(draft.status, 201);
  articleId = draft.data.id;
  assert.equal(draft.data.status, 'draft');
  assert.ok(!(await call('/knowledge')).data.some((article: any) => article.id === articleId));
  const published = await call(`/knowledge/${articleId}`, {
    method: 'PATCH',
    client: doctor,
    body: { status: 'published' },
  });
  assert.equal(published.status, 200);
  assert.equal(published.data.status, 'published');
  assert.ok((await call('/knowledge')).data.some((article: any) => article.id === articleId));
});
test('editing approved knowledge requires renewed approval and preserves prior revisions', async () => {
  const changed = await call(`/knowledge/${articleId}`, {
    method: 'PATCH',
    client: doctor,
    body: { body: 'New arrival instructions pending review.' },
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.status, 'draft');
  assert.ok(!(await call('/knowledge')).data.some((article: any) => article.id === articleId));
  assert.equal(
    (
      await call(`/knowledge/${articleId}`, {
        method: 'PATCH',
        client: patient,
        body: { status: 'published' },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call(`/knowledge/${articleId}`, {
        method: 'PATCH',
        client: admin,
        body: { status: 'published' },
      })
    ).status,
    200,
  );
  assert.ok(
    Number(
      app.locals.db
        .prepare('SELECT count(*) AS n FROM knowledgeRevisions WHERE articleId=?')
        .get(articleId).n,
    ) >= 3,
  );
  assert.throws(() => app.locals.db.exec('DELETE FROM knowledgeRevisions'), /append-only/);
});
test('portal account provisioning requires admin identity verification and never relinks existing accounts', async () => {
  const input = {
    email: 'walkin@example.test',
    password: 'WalkInPassword2026!',
    identityVerified: true,
  };
  assert.equal(
    (
      await call('/patients/patient-2/portal-account', {
        method: 'POST',
        client: reception,
        body: input,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call('/patients/patient-2/portal-account', {
        method: 'POST',
        client: admin,
        body: { ...input, identityVerified: false },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call('/patients/patient-2/portal-account', {
        method: 'POST',
        client: admin,
        body: { ...input, email: 'patient@derma.demo' },
      })
    ).status,
    409,
  );
  const created = await call('/patients/patient-2/portal-account', {
    method: 'POST',
    client: admin,
    body: input,
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.patientId, 'patient-2');
  assert.equal(created.data.role, 'patient');
  assert.ok(!('password' in created.data));
  assert.equal(
    (
      await call('/patients/patient-2/portal-account', {
        method: 'POST',
        client: admin,
        body: { ...input, email: 'different@example.test' },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call('/patients/patient-ananya/portal-account', {
        method: 'POST',
        client: admin,
        body: { ...input, email: 'new@example.test' },
      })
    ).status,
    409,
  );
  const portal: Client = {};
  assert.equal(
    (
      await call('/auth/login', {
        method: 'POST',
        client: portal,
        body: { email: input.email, password: input.password },
      })
    ).status,
    200,
  );
  const record = await call('/patients/patient-2', { client: portal });
  assert.equal(record.status, 403);
  assert.equal(
    (
      await call('/auth/password', {
        method: 'POST',
        client: portal,
        body: { currentPassword: input.password, newPassword: 'PersonalWalkIn2026!' },
      })
    ).status,
    200,
  );
  const accessibleRecord = await call('/patients/patient-2', { client: portal });
  assert.equal(accessibleRecord.status, 200);
  assert.equal(accessibleRecord.data.patient.email, input.email);
  assert.ok(accessibleRecord.data.appointments.length > 0);
  assert.equal((await call('/patients/patient-ananya', { client: portal })).status, 403);
});
test('invoice creation, payment recording, publication and portal provisioning leave audit evidence', async () => {
  const audit = (await call('/audit', { client: admin })).data;
  for (const action of [
    'created invoice',
    'recorded manual payment',
    'approved and published knowledge',
    'provisioned patient portal after clinic identity verification',
  ]) {
    assert.ok(
      audit.some((entry: any) => entry.action === action),
      action,
    );
  }
});

async function billingProcedure(patientId = 'patient-ananya') {
  const result = await call('/procedures', {
    method: 'POST',
    client: doctor,
    body: {
      patientId,
      title: 'Synthetic procedure for billing',
      indication: 'Private clinical indication',
      benefits: 'Private discussion benefit',
      risks: 'Private clinical risks',
      alternatives: 'Private alternatives',
      aftercare: 'Private aftercare',
      estimatedCost: '₹1,200 estimated; confirm agreed charges',
    },
  });
  assert.equal(result.status, 201);
  return result.data;
}

test('procedure billing exposes operational fields to reception without clinical discussion or outcomes', async () => {
  const procedure = await billingProcedure();
  const response = await call('/procedure-billing?patientId=patient-ananya', { client: reception });
  assert.equal(response.status, 200);
  const projection = response.data.find((item: any) => item.id === procedure.id);
  assert.equal(projection.title, procedure.title);
  assert.equal(projection.status, 'planned');
  assert.equal(projection.invoiceId, null);
  for (const key of [
    'indication',
    'benefits',
    'risks',
    'alternatives',
    'aftercare',
    'agreements',
    'completion',
  ])
    assert.ok(!(key in projection));
  assert.ok(!JSON.stringify(response.data).includes('Private clinical risks'));
  assert.equal((await call('/procedure-billing', { client: patient })).status, 403);
  assert.equal((await call('/procedure-billing')).status, 401);
});

test('procedure-linked invoices validate patient scope and retain retry-safe immutable linkage', async () => {
  const procedure = await billingProcedure();
  const requestId = randomUUID();
  const body = {
    requestId,
    patientId: 'patient-ananya',
    procedureId: procedure.id,
    items: [
      { description: 'Agreed synthetic procedure fee', quantity: 1, unitAmountPaise: 125050 },
    ],
  };
  assert.equal(
    (
      await call('/invoices', {
        method: 'POST',
        client: reception,
        body: { ...body, patientId: 'patient-2' },
      })
    ).status,
    400,
  );
  const created = await call('/invoices', { method: 'POST', client: reception, body });
  assert.equal(created.status, 201);
  assert.equal(created.data.procedureId, procedure.id);
  assert.equal(created.data.procedureTitle, procedure.title);
  assert.equal(created.data.totalPaise, 125050);
  assert.equal((await call('/invoices', { method: 'POST', client: reception, body })).status, 200);
  assert.equal(
    (
      await call('/invoices', {
        method: 'POST',
        client: reception,
        body: { ...body, procedureId: undefined },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call('/invoices', {
        method: 'POST',
        client: reception,
        body: { ...body, requestId: randomUUID() },
      })
    ).status,
    409,
  );
  const projection = (await call('/procedure-billing', { client: reception })).data.find(
    (item: any) => item.id === procedure.id,
  );
  assert.equal(projection.invoiceId, created.data.id);
  assert.equal(projection.invoiceNumber, created.data.number);
  assert.equal((await call(`/invoices/${created.data.id}`, { client: patient })).status, 200);
  assert.equal((await call(`/invoices/${created.data.id}`, { client: other })).status, 403);
  assert.throws(
    () =>
      app.locals.db
        .prepare('DELETE FROM procedureInvoiceLinks WHERE procedureId=?')
        .run(procedure.id),
    /immutable/,
  );
  assert.throws(
    () =>
      app.locals.db
        .prepare('UPDATE procedureInvoiceLinks SET invoiceId=? WHERE procedureId=?')
        .run(created.data.id, procedure.id),
    /immutable/,
  );
});

test('concurrent procedure invoice creation charges once and consumes only one sequence value', async () => {
  const procedure = await billingProcedure();
  const serial = app.locals.db.prepare('SELECT nextValue FROM invoiceSequence').get().nextValue;
  const body = {
    patientId: 'patient-ananya',
    procedureId: procedure.id,
    items: [{ description: 'Synthetic procedure', quantity: 1, unitAmountPaise: 10000 }],
  };
  const responses = await Promise.all(
    [1, 2].map(() =>
      call('/invoices', {
        method: 'POST',
        client: reception,
        body: { ...body, requestId: randomUUID() },
      }),
    ),
  );
  assert.deepEqual(responses.map((value) => value.status).sort(), [201, 409]);
  assert.equal(
    app.locals.db.prepare('SELECT nextValue FROM invoiceSequence').get().nextValue,
    Number(serial) + 1,
  );
  assert.equal(
    app.locals.db
      .prepare('SELECT count(*) AS n FROM procedureInvoiceLinks WHERE procedureId=?')
      .get(procedure.id).n,
    1,
  );
});

test('cancelled procedures reject new linkage while previously issued invoices and retries remain intact', async () => {
  const cancelled = await billingProcedure();
  assert.equal(
    (
      await call(`/procedures/${cancelled.id}/cancel`, {
        method: 'POST',
        client: doctor,
        body: { reason: 'Synthetic cancellation' },
      })
    ).status,
    200,
  );
  const body = {
    patientId: 'patient-ananya',
    procedureId: cancelled.id,
    items: [{ description: 'Synthetic fee', quantity: 1, unitAmountPaise: 10000 }],
  };
  assert.equal((await call('/invoices', { method: 'POST', client: reception, body })).status, 409);
  const existing = await billingProcedure();
  const retry = { ...body, procedureId: existing.id, requestId: randomUUID() };
  const invoice = (await call('/invoices', { method: 'POST', client: reception, body: retry }))
    .data;
  await call(`/procedures/${existing.id}/cancel`, {
    method: 'POST',
    client: doctor,
    body: { reason: 'Cancellation after invoice; charges reconciled separately' },
  });
  const repeated = await call('/invoices', { method: 'POST', client: reception, body: retry });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.data.id, invoice.id);
  assert.equal(repeated.data.totalPaise, invoice.totalPaise);
  const item = (await call('/procedure-billing', { client: reception })).data.find(
    (row: any) => row.id === existing.id,
  );
  assert.equal(item.status, 'cancelled');
  assert.equal(item.invoiceId, invoice.id);
});

test('invoice and payment activity is patient-scoped and safe to retry', async () => {
  const body = {
    requestId: randomUUID(),
    patientId: 'patient-ananya',
    items: [{ description: 'Synthetic notification test', quantity: 1, unitAmountPaise: 20050 }],
  };
  const invoice = (await call('/invoices', { method: 'POST', client: reception, body })).data;
  await call('/invoices', { method: 'POST', client: reception, body });
  const payment = { requestId: randomUUID(), amountPaise: 10025, method: 'cash' };
  assert.equal(
    (
      await call(`/invoices/${invoice.id}/payments`, {
        method: 'POST',
        client: reception,
        body: payment,
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await call(`/invoices/${invoice.id}/payments`, {
        method: 'POST',
        client: reception,
        body: payment,
      })
    ).status,
    200,
  );
  const href = `/my-care/invoices?invoice=${invoice.id}`;
  const items = (await call('/activity?limit=100', { client: patient })).data.items.filter(
    (item: any) => item.href === href,
  );
  assert.equal(items.length, 2);
  assert.ok(items.every((item: any) => item.kind === 'billing'));
  assert.ok(
    !(await call('/activity?limit=100', { client: other })).data.items.some(
      (item: any) => item.href === href,
    ),
  );
});

test('billing notification failures roll back invoices, procedure links and payments atomically', async () => {
  const procedure = await billingProcedure();
  const body = {
    requestId: randomUUID(),
    patientId: 'patient-ananya',
    procedureId: procedure.id,
    items: [{ description: 'Synthetic rollback fee', quantity: 1, unitAmountPaise: 30000 }],
  };
  const db = app.locals.db;
  const serial = db.prepare('SELECT nextValue FROM invoiceSequence').get().nextValue;
  const failActivity = () =>
    db.exec(
      "CREATE TRIGGER synthetic_billing_activity_failure BEFORE INSERT ON activity WHEN json_extract(NEW.data,'$.kind')='billing' BEGIN SELECT RAISE(ABORT,'Synthetic billing notification failure'); END;",
    );
  failActivity();
  try {
    assert.equal(
      (await call('/invoices', { method: 'POST', client: reception, body })).status,
      500,
    );
  } finally {
    db.exec('DROP TRIGGER synthetic_billing_activity_failure');
  }
  assert.equal(db.prepare('SELECT nextValue FROM invoiceSequence').get().nextValue, serial);
  assert.equal(
    db
      .prepare('SELECT count(*) AS n FROM procedureInvoiceLinks WHERE procedureId=?')
      .get(procedure.id).n,
    0,
  );
  assert.equal(
    db.prepare('SELECT count(*) AS n FROM invoices WHERE requestId=?').get(body.requestId).n,
    0,
  );
  const invoice = (await call('/invoices', { method: 'POST', client: reception, body })).data;
  const payment = { requestId: randomUUID(), amountPaise: 15000, method: 'cash' };
  failActivity();
  try {
    assert.equal(
      (
        await call(`/invoices/${invoice.id}/payments`, {
          method: 'POST',
          client: reception,
          body: payment,
        })
      ).status,
      500,
    );
  } finally {
    db.exec('DROP TRIGGER synthetic_billing_activity_failure');
  }
  const detail = (await call(`/invoices/${invoice.id}`, { client: patient })).data;
  assert.equal(detail.invoice.paidPaise, 0);
  assert.equal(detail.payments.length, 0);
  assert.equal(
    (
      await call(`/invoices/${invoice.id}/payments`, {
        method: 'POST',
        client: reception,
        body: payment,
      })
    ).status,
    201,
  );
});
