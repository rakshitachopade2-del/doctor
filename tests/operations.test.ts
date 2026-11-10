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
