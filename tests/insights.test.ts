import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import { escapeCsvCell } from '../server/insights.ts';
import { addDays, clinicToday, openDatabase, seedDemo } from '../server/db.ts';
import type { Appointment, AppointmentStatus } from '../shared/types.ts';
import type { Invoice, Payment } from '../shared/operations.ts';
import type { ClinicExpense, ClinicInsights } from '../shared/insights.ts';

const app = createApp({ databasePath: ':memory:', demoMode: true });
let server: Server, base: string;
type Client = { cookie?: string; csrf?: string };
const admin: Client = {},
  doctor: Client = {},
  reception: Client = {},
  patient: Client = {};
async function call(
  path: string,
  client: Client = {},
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
  const data = response.headers.get('content-type')?.includes('application/json')
    ? await response.json()
    : await response.text();
  if (data?.csrfToken) client.csrf = data.csrfToken;
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
const expenseInput = (overrides: Record<string, unknown> = {}) => ({
  incurredDate: clinicToday(),
  category: 'supplies',
  description: 'Synthetic clinic supplies',
  amountPaise: 12505,
  reference: 'Offline receipt fixture',
  requestId: randomUUID(),
  ...overrides,
});
async function newExpense(overrides: Record<string, unknown> = {}): Promise<ClinicExpense> {
  const result = await call('/expenses', admin, 'POST', expenseInput(overrides));
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data;
}
async function report(from = '2024-02-28', to = '2024-03-01'): Promise<ClinicInsights> {
  const result = await call(`/insights?from=${from}&to=${to}`, admin);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data;
}
function storedInvoice(createdAt: string, totalPaise: number, paidPaise: number): Invoice {
  const serial = Number(
    app.locals.db.prepare('SELECT nextValue FROM invoiceSequence').get().nextValue,
  );
  const invoice: Invoice = {
    id: randomUUID(),
    patientId: 'patient-ananya',
    patientName: 'Synthetic private patient name',
    number: `INV-${String(serial).padStart(6, '0')}`,
    items: [
      { description: 'Private invoice description', quantity: 1, unitAmountPaise: totalPaise },
    ],
    totalPaise,
    paidPaise,
    status: paidPaise === totalPaise ? 'paid' : paidPaise ? 'partial' : 'unpaid',
    createdAt,
  };
  app.locals.db
    .prepare('INSERT INTO invoices(id,patientId,invoiceNumber,data) VALUES (?,?,?,?)')
    .run(invoice.id, invoice.patientId, serial, JSON.stringify(invoice));
  app.locals.db.prepare('UPDATE invoiceSequence SET nextValue=nextValue+1').run();
  return invoice;
}
function storedPayment(
  invoice: Invoice,
  createdAt: string,
  amountPaise: number,
  method: Payment['method'],
) {
  const payment: Payment = {
    id: randomUUID(),
    invoiceId: invoice.id,
    amountPaise,
    method,
    reference: 'Private receipt reference',
    requestId: randomUUID(),
    createdAt,
  };
  app.locals.db
    .prepare('INSERT INTO payments(id,invoiceId,requestId,data) VALUES (?,?,?,?)')
    .run(payment.id, invoice.id, payment.requestId, JSON.stringify(payment));
  return payment;
}
function storedAppointment(
  date: string,
  time: string,
  patientId: string,
  status: AppointmentStatus,
  mode: Appointment['mode'],
): Appointment {
  const appointment: Appointment = {
    id: randomUUID(),
    patientId,
    patientName: 'Private appointment name',
    doctorId: 'doctor-meera',
    doctorName: 'Dr. Meera Shah',
    date,
    time,
    mode,
    status,
    reason: 'Private appointment concern',
    fee: 1500,
    durationMinutes: 30,
    createdAt: '2024-01-10T10:00:00.000Z',
  };
  app.locals.db
    .prepare(
      'INSERT INTO appointments(id,patientId,doctorId,date,time,status,data) VALUES (?,?,?,?,?,?,?)',
    )
    .run(
      appointment.id,
      patientId,
      appointment.doctorId,
      date,
      time,
      status,
      JSON.stringify(appointment),
    );
  return appointment;
}
let cohortInvoice: Invoice, scheduledAppointment: Appointment, rentExpense: ClinicExpense;
before(async () => {
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
  cohortInvoice = storedInvoice('2024-02-28T18:29:59.999Z', 10001, 3001);
  const nextDayInvoice = storedInvoice('2024-02-28T18:30:00.000Z', 20002, 10002);
  const oldInvoice = storedInvoice('2024-02-27T10:00:00.000Z', 4000, 4000);
  storedPayment(cohortInvoice, '2024-02-28T18:30:00.000Z', 2000, 'cash');
  storedPayment(cohortInvoice, '2024-03-01T18:30:00.000Z', 1001, 'upi');
  storedPayment(nextDayInvoice, '2024-02-29T18:29:59.999Z', 5001, 'card');
  storedPayment(nextDayInvoice, '2024-02-29T18:30:00.000Z', 5001, 'bank');
  storedPayment(oldInvoice, '2024-03-01T10:00:00.000Z', 4000, 'upi');
  storedAppointment('2024-02-28', '09:00', 'patient-ananya', 'completed', 'in-person');
  storedAppointment('2024-02-28', '10:00', 'patient-2', 'cancelled', 'online');
  storedAppointment('2024-02-29', '09:00', 'patient-ananya', 'no-show', 'in-person');
  scheduledAppointment = storedAppointment(
    '2024-02-29',
    '10:00',
    'patient-ananya',
    'scheduled',
    'online',
  );
  storedAppointment('2024-03-01', '09:00', 'patient-2', 'checked-in', 'in-person');
  await newExpense({
    incurredDate: '2024-02-28',
    amountPaise: 1001,
    description: '=HYPERLINK("private-patient-id")',
    reference: '@private-expense-reference',
  });
  rentExpense = await newExpense({
    incurredDate: '2024-02-29',
    category: 'rent',
    amountPaise: 2002,
  });
  const excluded = await newExpense({
    incurredDate: '2024-03-01',
    category: 'services',
    amountPaise: 3003,
  });
  assert.equal(
    (
      await call(`/expenses/${excluded.id}/void`, admin, 'POST', {
        reason: 'Private correction reason',
      })
    ).status,
    200,
  );
});
after(async () => {
  await close(server);
  app.locals.close();
});

test('expenses, financial insights and exports are restricted to administrators', async () => {
  const range = `from=${clinicToday()}&to=${clinicToday()}`;
  const entry = await newExpense();
  for (const client of [{}, doctor, reception, patient]) {
    const expected = client === doctor || client === reception || client === patient ? 403 : 401;
    for (const path of [`/expenses?${range}`, `/insights?${range}`, `/insights/export?${range}`])
      assert.equal((await call(path, client)).status, expected);
    assert.equal((await call('/expenses', client, 'POST', expenseInput())).status, expected);
    assert.equal(
      (await call(`/expenses/${entry.id}/void`, client, 'POST', { reason: 'Attempted change' }))
        .status,
      expected,
    );
  }
  assert.equal((await call(`/expenses?${range}`, admin)).headers.get('cache-control'), 'no-store');
  assert.equal((await call(`/insights?${range}`, admin)).headers.get('cache-control'), 'no-store');
});

test('date filters require real ordered dates and accept at most 366 inclusive days', async () => {
  for (const path of ['/expenses', '/insights', '/insights/export']) {
    for (const query of [
      '',
      '?from=2024-01-01',
      '?from=2024-02-30&to=2024-03-01',
      '?from=2023-02-29&to=2023-03-01',
      '?from=2024-03-01&to=2024-02-29',
      '?from=2024-01-01&to=2025-01-01',
    ])
      assert.equal((await call(`${path}${query}`, admin)).status, 400, `${path}${query}`);
    assert.equal((await call(`${path}?from=2024-01-01&to=2024-12-31`, admin)).status, 200);
    assert.equal((await call(`${path}?from=2024-02-29&to=2024-02-29`, admin)).status, 200);
  }
  assert.equal(
    (await call(`/expenses?from=${clinicToday()}&to=${clinicToday()}&category=unknown`, admin))
      .status,
    400,
  );
  assert.equal(
    (await call(`/expenses?from=${clinicToday()}&to=${clinicToday()}&status=deleted`, admin))
      .status,
    400,
  );
});

test('expense inputs reject future dates, noninteger money, invalid categories and forged provenance', async () => {
  for (const overrides of [
    { incurredDate: addDays(clinicToday(), 1) },
    { incurredDate: '2024-02-30' },
    { amountPaise: 0 },
    { amountPaise: -1 },
    { amountPaise: 1.25 },
    { amountPaise: 1_000_000_001 },
    { category: 'unknown' },
    { description: '' },
    { description: 'x'.repeat(301) },
    { reference: 'x'.repeat(201) },
    { requestId: undefined },
    { requestId: 'not-a-uuid' },
    { createdById: 'forged' },
    { status: 'voided' },
  ])
    assert.equal((await call('/expenses', admin, 'POST', expenseInput(overrides))).status, 400);
  const minimal = await newExpense({ amountPaise: 1, reference: undefined });
  assert.equal(minimal.reference, '');
  assert.equal(minimal.createdById, 'user-admin');
  assert.equal(minimal.createdByName, 'Clinic administrator');
  assert.equal(minimal.status, 'recorded');
  assert.equal(minimal.void, null);
  assert.equal((await newExpense({ amountPaise: 1_000_000_000 })).amountPaise, 1_000_000_000);
});

test('concurrent expense retries record one immutable expense and changed requests conflict', async () => {
  const input = expenseInput({
    description: '  Same normalized expense  ',
    reference: ' receipt ',
  });
  const outcomes = await Promise.all([
    call('/expenses', admin, 'POST', input),
    call('/expenses', admin, 'POST', input),
  ]);
  assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), [200, 201]);
  assert.equal(outcomes[0].data.id, outcomes[1].data.id);
  const repeated = await call('/expenses', admin, 'POST', {
    ...input,
    description: 'Same normalized expense',
    reference: 'receipt',
  });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.data.id, outcomes[0].data.id);
  for (const changes of [
    { amountPaise: 100 },
    { description: 'Changed' },
    { incurredDate: addDays(clinicToday(), -1) },
    { reference: 'other' },
    { category: 'rent' },
  ])
    assert.equal((await call('/expenses', admin, 'POST', { ...input, ...changes })).status, 409);
  assert.equal(
    app.locals.db
      .prepare('SELECT count(*) AS n FROM expenses WHERE requestId=?')
      .get(input.requestId).n,
    1,
  );
  const audit = app.locals.db
    .prepare(
      "SELECT count(*) AS n FROM audit WHERE json_extract(data,'$.entityId')=? AND json_extract(data,'$.action')='recorded clinic expense'",
    )
    .get(repeated.data.id);
  assert.equal(audit.n, 1);
  assert.throws(
    () =>
      app.locals.db.prepare('UPDATE expenses SET data=? WHERE id=?').run('{}', repeated.data.id),
    /immutable/,
  );
  assert.throws(
    () => app.locals.db.prepare('DELETE FROM expenses WHERE id=?').run(repeated.data.id),
    /immutable/,
  );
});

test('voiding preserves the original, is retry-safe and keeps creation replay linked to its voided history', async () => {
  const input = expenseInput({ category: 'equipment' });
  const created = (await call('/expenses', admin, 'POST', input)).data as ClinicExpense;
  for (const reason of ['', 'x'.repeat(1001)])
    assert.equal(
      (await call(`/expenses/${created.id}/void`, admin, 'POST', { reason })).status,
      400,
    );
  const voided = await call(`/expenses/${created.id}/void`, admin, 'POST', {
    reason: 'Duplicate receipt entry.',
  });
  assert.equal(voided.status, 200);
  assert.equal(voided.data.status, 'voided');
  assert.equal(voided.data.amountPaise, created.amountPaise);
  assert.equal(voided.data.createdAt, created.createdAt);
  assert.equal(voided.data.void.voidedById, 'user-admin');
  const repeated = await call(`/expenses/${created.id}/void`, admin, 'POST', {
    reason: ' Duplicate receipt entry. ',
  });
  assert.deepEqual(repeated.data, voided.data);
  assert.equal(
    (await call(`/expenses/${created.id}/void`, admin, 'POST', { reason: 'Replacement reason' }))
      .status,
    409,
  );
  assert.equal(
    (await call('/expenses/missing-expense/void', admin, 'POST', { reason: 'Missing' })).status,
    404,
  );
  const creationReplay = await call('/expenses', admin, 'POST', input);
  assert.equal(creationReplay.status, 200);
  assert.deepEqual(creationReplay.data, voided.data);
  assert.throws(
    () =>
      app.locals.db
        .prepare('UPDATE expenseVoids SET data=? WHERE expenseId=?')
        .run('{}', created.id),
    /immutable/,
  );
  assert.throws(
    () => app.locals.db.prepare('DELETE FROM expenseVoids WHERE expenseId=?').run(created.id),
    /immutable/,
  );
  const filtered = await call(
    `/expenses?from=${clinicToday()}&to=${clinicToday()}&category=equipment&status=voided`,
    admin,
  );
  assert.ok(filtered.data.some((entry: ClinicExpense) => entry.id === created.id));
  assert.ok(
    filtered.data.every(
      (entry: ClinicExpense) => entry.status === 'voided' && entry.category === 'equipment',
    ),
  );
});

test('expense creation and void records roll back when their audit entry fails', async () => {
  const original = await newExpense();
  const input = expenseInput();
  app.locals.db.exec(
    "CREATE TRIGGER synthetic_expense_audit_failure BEFORE INSERT ON audit WHEN json_extract(NEW.data,'$.action') IN ('recorded clinic expense','voided clinic expense') BEGIN SELECT RAISE(ABORT,'Synthetic expense audit failure'); END;",
  );
  try {
    assert.equal((await call('/expenses', admin, 'POST', input)).status, 500);
    assert.equal(
      app.locals.db
        .prepare('SELECT count(*) AS n FROM expenses WHERE requestId=?')
        .get(input.requestId).n,
      0,
    );
    assert.equal(
      (await call(`/expenses/${original.id}/void`, admin, 'POST', { reason: 'Must roll back' }))
        .status,
      500,
    );
    assert.equal(
      app.locals.db
        .prepare('SELECT count(*) AS n FROM expenseVoids WHERE expenseId=?')
        .get(original.id).n,
      0,
    );
  } finally {
    app.locals.db.exec('DROP TRIGGER synthetic_expense_audit_failure');
  }
  assert.equal((await call('/expenses', admin, 'POST', input)).status, 201);
  assert.equal(
    (await call(`/expenses/${original.id}/void`, admin, 'POST', { reason: 'Retry after failure' }))
      .status,
    200,
  );
});

test('insights aggregate exact paise across independent IST issue, recording, incurred and scheduled dates', async () => {
  const result = await report();
  assert.equal(result.timezone, 'Asia/Kolkata');
  assert.ok(result.generatedAt);
  assert.deepEqual(result.totals, {
    appointmentCount: 5,
    patientsWithAppointments: 2,
    invoiceCount: 2,
    invoicedPaise: 30003,
    issuedInvoiceOutstandingPaise: 17000,
    paymentCount: 4,
    refundCount: 0,
    collectionsPaise: 16002,
    refundsPaise: 0,
    netCollectionsPaise: 16002,
    expenseCount: 2,
    expensesPaise: 3003,
  });
  assert.deepEqual(result.daily, [
    {
      date: '2024-02-28',
      appointmentCount: 2,
      completedAppointments: 1,
      cancelledAppointments: 1,
      noShowAppointments: 0,
      invoicedPaise: 10001,
      collectionsPaise: 0,
      refundsPaise: 0,
      netCollectionsPaise: 0,
      expensesPaise: 1001,
    },
    {
      date: '2024-02-29',
      appointmentCount: 2,
      completedAppointments: 0,
      cancelledAppointments: 0,
      noShowAppointments: 1,
      invoicedPaise: 20002,
      collectionsPaise: 7001,
      refundsPaise: 0,
      netCollectionsPaise: 7001,
      expensesPaise: 2002,
    },
    {
      date: '2024-03-01',
      appointmentCount: 1,
      completedAppointments: 0,
      cancelledAppointments: 0,
      noShowAppointments: 0,
      invoicedPaise: 0,
      collectionsPaise: 9001,
      refundsPaise: 0,
      netCollectionsPaise: 9001,
      expensesPaise: 0,
    },
  ]);
  assert.deepEqual(
    Object.fromEntries(result.appointmentsByStatus.map((row) => [row.status, row.count])),
    {
      scheduled: 1,
      'checked-in': 1,
      'in-consultation': 0,
      completed: 1,
      cancelled: 1,
      'no-show': 1,
    },
  );
  assert.deepEqual(result.appointmentsByMode, [
    { mode: 'in-person', count: 3 },
    { mode: 'online', count: 2 },
  ]);
  assert.deepEqual(
    Object.fromEntries(result.collectionsByMethod.map((row) => [row.method, row.amountPaise])),
    { cash: 2000, card: 5001, upi: 4000, bank: 5001 },
  );
  assert.equal(result.expensesByCategory.length, 7);
  assert.deepEqual(
    result.expensesByCategory.find((row) => row.category === 'services'),
    { category: 'services', count: 0, amountPaise: 0 },
  );
  const boundary = await report('2024-02-28', '2024-02-28');
  assert.equal(boundary.totals.invoiceCount, 1);
  assert.equal(boundary.totals.collectionsPaise, 0);
  assert.equal(boundary.totals.issuedInvoiceOutstandingPaise, 7000);
});

test('empty and future reporting ranges are zero-filled rather than inferred from planned fees', async () => {
  const result = await report('2090-01-01', '2090-01-03');
  assert.equal(result.daily.length, 3);
  assert.ok(Object.values(result.totals).every((value) => value === 0));
  assert.ok(
    result.daily.every((day) =>
      Object.entries(day).every(([key, value]) => key === 'date' || value === 0),
    ),
  );
  assert.ok(result.expensesByCategory.every((row) => row.amountPaise === 0 && row.count === 0));
  assert.ok(result.collectionsByMethod.every((row) => row.amountPaise === 0 && row.count === 0));
  const futureAppointment = storedAppointment(
    '2090-01-02',
    '09:00',
    'patient-ananya',
    'scheduled',
    'online',
  );
  const scheduled = await report('2090-01-01', '2090-01-03');
  assert.equal(scheduled.totals.appointmentCount, 1);
  assert.equal(scheduled.totals.invoicedPaise, 0);
  assert.equal(scheduled.totals.collectionsPaise, 0);
  assert.equal(futureAppointment.fee, 1500);
});

function parseCsv(content: string) {
  const rows: string[][] = [];
  let row: string[] = [],
    field = '',
    quoted = false;
  for (let index = 0; index < content.length; index++) {
    const char = content[index];
    if (char === '"') {
      if (quoted && content[index + 1] === '"') {
        field += '"';
        index++;
      } else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(field);
      field = '';
    } else if (char === '\r' && content[index + 1] === '\n' && !quoted) {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      index++;
    } else field += char;
  }
  return rows;
}
test('CSV export matches JSON aggregates, explains date bases and excludes all record identifiers and free text', async () => {
  const expected = await report();
  const exported = await call('/insights/export?from=2024-02-28&to=2024-03-01', admin);
  assert.equal(exported.status, 200);
  assert.ok(exported.headers.get('content-type')?.startsWith('text/csv'));
  assert.equal(
    exported.headers.get('content-disposition'),
    'attachment; filename="clinic-insights-2024-02-28-to-2024-03-01.csv"',
  );
  assert.equal(exported.headers.get('cache-control'), 'no-store');
  assert.equal(exported.headers.get('x-content-type-options'), 'nosniff');
  const rows = parseCsv(exported.data);
  assert.deepEqual(rows[0], ['section', 'date', 'metric', 'dimension', 'count', 'amountPaise']);
  for (const [metric, value] of Object.entries(expected.totals)) {
    const row = rows.find((row) => row[0] === 'totals' && row[2] === metric)!;
    assert.equal(Number(row[4] || row[5]), value);
  }
  assert.equal(rows.filter((row) => row[0] === 'daily').length, expected.daily.length * 9);
  assert.ok(
    rows.some((row) => row[2] === 'collectionsBasis' && row[3].includes('recording timestamp')),
  );
  assert.ok(
    rows.some((row) => row[2] === 'outstandingBasis' && row[3].includes('Current balance')),
  );
  for (const secret of [
    'patient-ananya',
    cohortInvoice.id,
    cohortInvoice.number,
    'Private appointment',
    'Private invoice',
    'Private receipt',
    'private-patient-id',
    '@private-expense-reference',
    'Private correction reason',
    'Clinic administrator',
  ])
    assert.ok(!exported.data.includes(secret), secret);
  assert.ok(!JSON.stringify(expected).includes('patient-ananya'));
});

test('CSV escaping prevents formula interpretation and preserves delimiters, quotes and line breaks', () => {
  for (const value of [
    '=1+1',
    '+SUM(A1)',
    '-2+3',
    '@SUM(A1)',
    '  =cmd()',
    '\t=cmd()',
    '\r=cmd()',
    '\n+cmd()',
    '\uFEFF=cmd()',
  ]) {
    const encoded = escapeCsvCell(value);
    assert.ok(encoded.startsWith('"\''));
    assert.deepEqual(parseCsv(`${encoded}\r\n`), [[`'${value}`]]);
  }
  const description = 'Comma, quote " and\nline break';
  assert.deepEqual(parseCsv(`${escapeCsvCell(description)}\r\n`), [[description]]);
  assert.equal(escapeCsvCell(12505), '"12505"');
  assert.equal(escapeCsvCell(-12505), '"-12505"');
});

test('historical reports use current appointment status, current void decisions and current issued-cohort balances', async () => {
  assert.equal(
    (
      await call(`/appointments/${scheduledAppointment.id}`, reception, 'PATCH', {
        status: 'cancelled',
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call(`/expenses/${rentExpense.id}/void`, admin, 'POST', {
        reason: 'Corrected historical incurred expense',
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call(`/invoices/${cohortInvoice.id}/payments`, reception, 'POST', {
        amountPaise: 1000,
        method: 'cash',
        requestId: randomUUID(),
        reference: 'Recorded today against older invoice',
      })
    ).status,
    201,
  );
  const current = await report();
  assert.equal(current.totals.appointmentCount, 5);
  assert.equal(current.appointmentsByStatus.find((row) => row.status === 'cancelled')?.count, 2);
  assert.equal(current.appointmentsByStatus.find((row) => row.status === 'scheduled')?.count, 0);
  assert.equal(current.totals.expensesPaise, 1001);
  assert.equal(current.totals.expenseCount, 1);
  assert.equal(current.totals.issuedInvoiceOutstandingPaise, 16000);
  assert.equal(current.totals.collectionsPaise, 16002);
  const list = (await call('/expenses?from=2024-02-28&to=2024-03-01', admin))
    .data as ClinicExpense[];
  assert.deepEqual(
    list.map((row) => row.incurredDate),
    ['2024-03-01', '2024-02-29', '2024-02-28'],
  );
  assert.equal(list.filter((row) => row.status === 'voided').length, 2);
});

test('the reporting API refuses sums that would lose integer paise precision', async () => {
  storedInvoice('2020-01-01T00:00:00.000Z', Number.MAX_SAFE_INTEGER - 1, 0);
  storedInvoice('2020-01-01T01:00:00.000Z', 100, 0);
  for (const path of ['/insights', '/insights/export']) {
    const result = await call(`${path}?from=2020-01-01&to=2020-01-01`, admin);
    assert.equal(result.status, 422);
    assert.match(result.data.error, /integer range/);
  }
});

test('legacy database startup adds reporting storage and preserves invoices and expense history across restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'derma-insights-migration-'));
  const path = join(directory, 'legacy.sqlite');
  const legacy = openDatabase(path);
  seedDemo(legacy);
  legacy.exec(`CREATE TABLE invoices(id TEXT PRIMARY KEY,patientId TEXT NOT NULL REFERENCES patients(id),invoiceNumber INTEGER NOT NULL UNIQUE,data TEXT NOT NULL);
    CREATE TABLE invoiceSequence(id INTEGER PRIMARY KEY CHECK(id=1),nextValue INTEGER NOT NULL);
    INSERT INTO invoiceSequence VALUES(1,42);`);
  const oldInvoice: Invoice = {
    id: 'legacy-invoice',
    patientId: 'patient-ananya',
    patientName: 'Historical invoice',
    number: 'INV-000041',
    items: [{ description: 'Legacy charge', quantity: 1, unitAmountPaise: 5500 }],
    totalPaise: 5500,
    paidPaise: 0,
    status: 'unpaid',
    createdAt: '2023-01-01T10:00:00.000Z',
  };
  legacy
    .prepare('INSERT INTO invoices(id,patientId,invoiceNumber,data) VALUES(?,?,?,?)')
    .run(oldInvoice.id, oldInvoice.patientId, 41, JSON.stringify(oldInvoice));
  legacy.close();
  let migrated: ReturnType<typeof createApp> | undefined, live: Server | undefined;
  try {
    migrated = createApp({ databasePath: path, demoMode: true });
    const started = await listen(migrated);
    live = started.server;
    const client: Client = {};
    assert.equal(
      (
        await call(
          '/auth/login',
          client,
          'POST',
          { email: 'admin@derma.demo', password: 'DemoClinic2026!' },
          started.base,
        )
      ).status,
      200,
    );
    assert.deepEqual(
      JSON.parse(
        migrated.locals.db.prepare('SELECT data FROM invoices WHERE id=?').get(oldInvoice.id).data,
      ),
      oldInvoice,
    );
    assert.equal(
      migrated.locals.db.prepare('SELECT nextValue FROM invoiceSequence').get().nextValue,
      42,
    );
    const input = expenseInput({ incurredDate: '2023-01-02', category: 'services' });
    const created = await call('/expenses', client, 'POST', input, started.base);
    assert.equal(created.status, 201);
    const voided = await call(
      `/expenses/${created.data.id}/void`,
      client,
      'POST',
      { reason: 'Persisted correction' },
      started.base,
    );
    assert.equal(voided.status, 200);
    await close(live);
    live = undefined;
    migrated.locals.close();
    migrated = undefined;
    migrated = createApp({ databasePath: path, demoMode: true });
    const restarted = await listen(migrated);
    live = restarted.server;
    const restored = await call(
      '/expenses?from=2023-01-01&to=2023-01-03',
      client,
      'GET',
      undefined,
      restarted.base,
    );
    assert.equal(restored.status, 200);
    assert.deepEqual(restored.data, [voided.data]);
    const retry = await call('/expenses', client, 'POST', input, restarted.base);
    assert.equal(retry.status, 200);
    assert.equal(retry.data.status, 'voided');
    const summary = await call(
      '/insights?from=2023-01-01&to=2023-01-03',
      client,
      'GET',
      undefined,
      restarted.base,
    );
    assert.equal(summary.data.totals.invoicedPaise, 5500);
    assert.equal(summary.data.totals.expensesPaise, 0);
    assert.equal(migrated.locals.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    if (live) await close(live);
    migrated?.locals.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('billing corrections update the original invoice cohort and exclude erroneous payments at their original recording dates', async () => {
  const invoice = storedInvoice('2011-02-01T06:00:00.000Z', 10000, 4000);
  const payment = storedPayment(invoice, '2011-03-01T06:00:00.000Z', 4000, 'upi');
  let detail = await call(`/invoices/${invoice.id}`, admin);
  assert.equal(detail.status, 200);
  const correction = await call(`/invoices/${invoice.id}/corrections`, admin, 'POST', {
    items: [{ description: 'Corrected synthetic charge', quantity: 1, unitAmountPaise: 8000 }],
    reason: 'Synthetic entry correction',
    expectedRevision: detail.data.revision,
    requestId: randomUUID(),
  });
  assert.equal(correction.status, 200, JSON.stringify(correction.data));
  const february = await report('2011-02-01', '2011-02-28');
  assert.equal(february.totals.invoicedPaise, 8000);
  assert.equal(february.totals.issuedInvoiceOutstandingPaise, 4000);
  assert.equal(february.totals.collectionsPaise, 0);
  assert.equal((await report('2011-03-01', '2011-03-31')).totals.collectionsPaise, 4000);
  const reversal = await call(
    `/invoices/${invoice.id}/payments/${payment.id}/reverse`,
    admin,
    'POST',
    {
      reason: 'Synthetic mistaken payment entry',
      entryErrorConfirmed: true,
      expectedRevision: correction.data.revision,
      requestId: randomUUID(),
    },
  );
  assert.equal(reversal.status, 200, JSON.stringify(reversal.data));
  const march = await report('2011-03-01', '2011-03-31');
  assert.equal(march.totals.collectionsPaise, 0);
  assert.equal(march.totals.paymentCount, 0);
  assert.equal(march.collectionsByMethod.find((row) => row.method === 'upi')!.amountPaise, 0);
  assert.ok(march.daily.every((day) => day.collectionsPaise === 0));
  assert.equal(
    (await report('2011-02-01', '2011-02-28')).totals.issuedInvoiceOutstandingPaise,
    8000,
  );
  const csv = await call('/insights/export?from=2011-03-01&to=2011-03-31', admin);
  assert.equal(csv.status, 200);
  assert.match(csv.data, /erroneous reversed entries excluded/);
  assert.deepEqual(
    parseCsv(csv.data).find((row) => row[0] === 'totals' && row[2] === 'collectionsPaise'),
    ['totals', '', 'collectionsPaise', '', '', '0'],
  );
  assert.equal(
    app.locals.db.prepare('SELECT count(*) AS n FROM payments WHERE id=?').get(payment.id).n,
    1,
  );
});

test('refund reports use their own IST recording dates, preserve gross collections and export negative net amounts', async () => {
  const invoice = storedInvoice('2012-01-01T06:00:00.000Z', 20000, 15995);
  const payment = storedPayment(invoice, '2012-01-01T06:00:00.000Z', 20000, 'card');
  let beforePaidPaise = 20000;
  const fixtures = [
    { createdAt: '2012-02-28T18:29:59.999Z', amountPaise: 1, method: 'cash' },
    { createdAt: '2012-02-28T18:30:00.000Z', amountPaise: 2001, method: 'bank' },
    { createdAt: '2012-02-29T18:29:59.999Z', amountPaise: 2002, method: 'upi' },
    { createdAt: '2012-02-29T18:30:00.000Z', amountPaise: 1, method: 'cash' },
  ];
  for (const fixture of fixtures) {
    const value = {
      ...fixture,
      id: randomUUID(),
      invoiceId: invoice.id,
      paymentId: payment.id,
      reference: '=Private refund reference',
      reason: 'Private synthetic refund reason',
      refundedExternallyConfirmed: true,
      beforePaidPaise,
      afterPaidPaise: beforePaidPaise - fixture.amountPaise,
      createdByName: 'Synthetic private author',
      createdById: 'user-admin',
      requestId: randomUUID(),
    };
    beforePaidPaise = value.afterPaidPaise;
    app.locals.db
      .prepare(
        'INSERT INTO paymentRefunds(id,invoiceId,paymentId,amountPaise,createdAt,data) VALUES (?,?,?,?,?,?)',
      )
      .run(
        value.id,
        invoice.id,
        payment.id,
        value.amountPaise,
        value.createdAt,
        JSON.stringify(value),
      );
  }
  const value = await report('2012-02-29', '2012-02-29');
  assert.equal(value.totals.invoiceCount, 0);
  assert.equal(value.totals.paymentCount, 0);
  assert.equal(value.totals.collectionsPaise, 0);
  assert.equal(value.totals.refundCount, 2);
  assert.equal(value.totals.refundsPaise, 4003);
  assert.equal(value.totals.netCollectionsPaise, -4003);
  assert.equal(value.daily[0].refundsPaise, 4003);
  assert.equal(value.daily[0].netCollectionsPaise, -4003);
  assert.deepEqual(value.refundsByMethod, [
    { method: 'cash', count: 0, amountPaise: 0 },
    { method: 'card', count: 0, amountPaise: 0 },
    { method: 'upi', count: 1, amountPaise: 2002 },
    { method: 'bank', count: 1, amountPaise: 2001 },
  ]);
  const original = await report('2012-01-01', '2012-01-01');
  assert.equal(original.totals.collectionsPaise, 20000);
  assert.equal(original.totals.refundsPaise, 0);
  assert.equal(original.totals.netCollectionsPaise, 20000);
  assert.equal(original.totals.issuedInvoiceOutstandingPaise, 4005);
  const all = await report('2012-01-01', '2012-03-01');
  assert.equal(all.totals.refundCount, 4);
  assert.equal(all.totals.refundsPaise, 4005);
  assert.equal(all.totals.netCollectionsPaise, 15995);
  const csv = await call('/insights/export?from=2012-02-29&to=2012-02-29', admin);
  assert.equal(csv.status, 200);
  const rows = parseCsv(csv.data);
  assert.deepEqual(
    rows.find((row) => row[0] === 'totals' && row[2] === 'netCollectionsPaise'),
    ['totals', '', 'netCollectionsPaise', '', '', '-4003'],
  );
  assert.deepEqual(
    rows.find((row) => row[0] === 'refundsByMethod' && row[3] === 'upi'),
    ['refundsByMethod', '', 'recordedRefunds', 'upi', '1', '2002'],
  );
  for (const privateValue of [
    invoice.id,
    payment.id,
    'Private refund reference',
    'Private synthetic refund reason',
    'Synthetic private author',
  ]) {
    assert.equal(JSON.stringify(value).includes(privateValue), false);
    assert.equal(csv.data.includes(privateValue), false);
  }
  const plan = app.locals.db
    .prepare(
      'EXPLAIN QUERY PLAN SELECT data FROM paymentRefunds WHERE createdAt>=? AND createdAt<=? ORDER BY createdAt,id',
    )
    .all('2012-02-28T18:30:00.000Z', '2012-02-29T18:29:59.999Z');
  assert.match(
    JSON.stringify(plan),
    /SEARCH paymentRefunds USING INDEX payment_refunds_created_at/,
  );
});
