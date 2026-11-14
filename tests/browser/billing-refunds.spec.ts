import {
  test,
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
  type Route,
} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Session } from '../../shared/types';
import type { Invoice, InvoiceDetail, Payment } from '../../shared/operations';
import type { PaymentRefundInput, PaymentRefundMutation } from '../../shared/billing-corrections';
import type { CareSummary } from '../../shared/care-summary';
import type { ProcedureRecord, PatientClinicalWorkflows } from '../../shared/clinical';
import type { ClinicInsights } from '../../shared/insights';
import type {
  CareSummaryCopyDetail,
  CareSummaryCopyResult,
} from '../../shared/care-summary-copies';

const confirmed = 'I confirm this money has already been returned to the patient outside Derma.';
const path = (invoiceId: string, paymentId: string) =>
  `/api/invoices/${invoiceId}/payments/${paymentId}/refunds`;
const amount = (paise: number) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: paise % 100 ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(paise / 100);
async function login(request: APIRequestContext, email = 'admin@derma.demo') {
  const response = await request.post('/api/auth/login', {
    data: { email, password: 'DemoClinic2026!' },
  });
  expect(response.status(), await response.text()).toBe(200);
  const session = (await response.json()) as Session;
  return { session, headers: { 'X-CSRF-Token': session.csrfToken! } };
}
async function get<T>(request: APIRequestContext, endpoint: string): Promise<T> {
  const response = await request.get(endpoint);
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}
async function post<T>(
  request: APIRequestContext,
  headers: Record<string, string>,
  endpoint: string,
  body: unknown,
  status = 201,
): Promise<T> {
  const response = await request.post(endpoint, { headers, data: body });
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}
async function fixture(
  request: APIRequestContext,
  headers: Record<string, string>,
  totalPaise = 10000,
  paidPaise = totalPaise,
  procedureId?: string,
) {
  const invoice = await post<Invoice>(request, headers, '/api/invoices', {
    patientId: 'patient-ananya',
    ...(procedureId ? { procedureId } : {}),
    requestId: randomUUID(),
    items: [
      {
        description: `Original refund fixture service ${randomUUID().slice(0, 8)}`,
        quantity: 1,
        unitAmountPaise: totalPaise,
      },
    ],
  });
  const detail = await post<InvoiceDetail>(
    request,
    headers,
    `/api/invoices/${invoice.id}/payments`,
    {
      amountPaise: paidPaise,
      method: 'upi',
      reference: `RECEIPT-${randomUUID()}`,
      requestId: randomUUID(),
    },
  );
  return { invoice, detail, payment: detail.payments[0] };
}
const invoiceDialog = (page: Page, invoice: Invoice) =>
  page.getByRole('dialog', { name: `Invoice ${invoice.number}`, exact: true });
const responseFor = (page: Page, endpoint: string, method = 'POST') =>
  page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === endpoint && response.request().method() === method,
  );
async function openRefund(page: Page, invoice: Invoice, payment: Payment) {
  const dialog = invoiceDialog(page, invoice);
  await dialog
    .locator('.payment-row')
    .filter({ hasText: payment.reference })
    .getByRole('button', { name: 'Record external refund', exact: true })
    .click();
  const form = dialog.locator('.billing-refund-form');
  await expect(form.getByLabel('Refund amount (₹)', { exact: true })).toBeEnabled();
  return form;
}
async function fill(
  form: Locator,
  paise: number,
  reason: string,
  method: Payment['method'] = 'cash',
  reference = '',
) {
  await form.getByLabel('Refund amount (₹)', { exact: true }).fill((paise / 100).toFixed(2));
  await form.getByLabel('Refund method', { exact: true }).selectOption(method);
  await form.getByLabel('Refund reference', { exact: true }).fill(reference);
  await form.getByLabel('Reason for refund', { exact: true }).fill(reason);
}
async function save(page: Page, invoice: Invoice, payment: Payment) {
  const form = invoiceDialog(page, invoice).locator('.billing-refund-form');
  await form.getByLabel(confirmed, { exact: true }).check();
  const waiting = responseFor(page, path(invoice.id, payment.id));
  await form.getByRole('button', { name: 'Record refund', exact: true }).click();
  const response = await waiting;
  expect(response.status(), await response.text()).toBe(201);
  const result = (await response.json()) as PaymentRefundMutation;
  await expect(form).toHaveCount(0);
  await expect(
    invoiceDialog(page, invoice)
      .locator('.billing-refund-entry')
      .filter({ hasText: result.refund.reason }),
  ).toBeVisible();
  return result;
}
async function audit(page: Page) {
  await page.setViewportSize({ width: 320, height: 860 });
  await page.evaluate(() => document.fonts.ready);
  const dismiss = page.getByRole('button', { name: 'Dismiss notification', exact: true });
  while (await dismiss.count()) await dismiss.first().click();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('partial and full external refunds preserve original charges and payment records while patients read accurate shared balances, history and print content', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(120000);
  const { headers, session } = await login(page.request);
  const procedure = await post<ProcedureRecord>(page.request, headers, '/api/procedures', {
    patientId: 'patient-ananya',
    title: `Refund linked procedure ${randomUUID().slice(0, 8)}`,
    indication: 'PRIVATE clinical indication',
    benefits: 'Recorded benefits',
    risks: 'Recorded risks',
    alternatives: 'Recorded alternatives',
    aftercare: 'Recorded aftercare',
    estimatedCost: 'Estimate only',
  });
  const {
    invoice,
    detail: original,
    payment,
  } = await fixture(page.request, headers, 12005, 12005, procedure.id);
  const beforeSummary = await get<CareSummary>(
    page.request,
    '/api/patients/patient-ananya/care-summary',
  );
  await page.goto(`/clinic/billing?invoice=${invoice.id}`);
  const dialog = invoiceDialog(page, invoice);
  let form = await openRefund(page, invoice, payment);
  const partialReason = `Shared partial external refund ${randomUUID()}`,
    reference = `BANK-REFUND-${randomUUID()}`;
  await fill(form, 3005, partialReason, 'bank');
  await expect(form.getByLabel(confirmed, { exact: true })).not.toBeChecked();
  expect(
    await form
      .getByLabel('Refund reference', { exact: true })
      .evaluate((input: HTMLInputElement) => input.validity.valueMissing),
  ).toBeTruthy();
  await form.getByLabel('Refund reference', { exact: true }).fill(reference);
  await expect(form.getByRole('button', { name: 'Record refund', exact: true })).toBeDisabled();
  const partial = await save(page, invoice, payment);
  expect(partial.refund).toMatchObject({
    invoiceId: invoice.id,
    paymentId: payment.id,
    amountPaise: 3005,
    method: 'bank',
    reference,
    reason: partialReason,
    refundedExternallyConfirmed: true,
    beforePaidPaise: 12005,
    afterPaidPaise: 9000,
    createdByName: session.user!.name,
  });
  expect(partial.receipt).toMatchObject({
    actorId: session.user!.id,
    invoiceId: invoice.id,
    paymentId: payment.id,
    refundId: partial.refund.id,
    expectedRevision: original.revision,
  });
  expect(partial.detail.payments).toEqual(original.payments);
  expect(partial.detail.invoice).toMatchObject({
    totalPaise: 12005,
    paidPaise: 9000,
    status: 'partial',
    items: invoice.items,
    procedureId: procedure.id,
  });
  await expect(
    dialog.locator('.payment-row').getByText('Partially refunded', { exact: true }),
  ).toBeVisible();
  await expect(dialog.locator('.payment-row')).toContainText('Available to refund');
  await expect(dialog.locator('.payment-row')).toContainText(amount(9000));
  await expect(
    dialog.getByRole('button', { name: 'Reverse erroneous entry', exact: true }),
  ).toBeDisabled();
  expect(
    (
      await page.request.post(`/api/invoices/${invoice.id}/payments/${payment.id}/reverse`, {
        headers,
        data: {
          reason: 'Must not reverse a refunded payment',
          entryErrorConfirmed: true,
          expectedRevision: partial.detail.revision,
          requestId: randomUUID(),
        },
      })
    ).status(),
  ).toBe(409);
  form = await openRefund(page, invoice, payment);
  const fullReason = `Shared final external refund ${randomUUID()}`;
  await fill(form, 9000, fullReason);
  const full = await save(page, invoice, payment);
  expect(full.refund).toMatchObject({
    amountPaise: 9000,
    beforePaidPaise: 9000,
    afterPaidPaise: 0,
    reason: fullReason,
  });
  expect(full.detail.invoice).toEqual({ ...original.invoice, paidPaise: 0, status: 'unpaid' });
  expect(full.detail.payments).toEqual(original.payments);
  expect(full.detail.issuedCharges).toEqual(original.issuedCharges);
  expect(full.detail.refunds).toHaveLength(2);
  expect(full.detail.corrections).toEqual([]);
  expect(full.detail.reversals).toEqual([]);
  await expect(
    dialog.locator('.payment-row').getByText('Fully refunded', { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Record external refund', exact: true }),
  ).toBeDisabled();
  await expect(dialog.locator('.billing-current-charges')).toContainText(amount(12005));
  expect(
    (
      await get<PatientClinicalWorkflows>(
        page.request,
        '/api/patients/patient-ananya/clinical-workflows',
      )
    ).procedures.find((row) => row.id === procedure.id),
  ).toEqual(procedure);
  expect(
    (
      await page.request.get(
        `/api/patients/patient-ananya/care-summary/download?revision=${beforeSummary.revision}`,
      )
    ).status(),
  ).toBe(409);

  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  await page.emulateMedia({ media: 'print' });
  try {
    await expect(
      dialog
        .locator('.billing-current-charges')
        .getByText(invoice.items[0].description, { exact: true }),
    ).toBeVisible();
    await expect(dialog.locator('.billing-refund-history')).toContainText(partialReason);
    await expect(dialog.locator('.billing-refund-history')).toContainText(fullReason);
    await expect(dialog.locator('.payment-row')).toContainText(payment.reference);
    await expect(dialog.locator('.payment-form')).toBeHidden();
    await expect(
      dialog.getByRole('button', { name: 'Record external refund', exact: true }),
    ).toBeHidden();
  } finally {
    await page.emulateMedia({ media: 'screen' });
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  }
  await audit(page);
  await page.screenshot({
    path: testInfo.outputPath('external-refunds-admin-mobile.png'),
    fullPage: true,
  });

  const own = await browser.newContext({ baseURL });
  try {
    const { headers: patientHeaders } = await login(own.request, 'patient@derma.demo');
    const patient = await own.newPage();
    await patient.goto(`/my-care/invoices?invoice=${invoice.id}`);
    const patientDialog = invoiceDialog(patient, invoice);
    await expect(patientDialog.locator('.billing-refund-history')).toContainText(partialReason);
    await expect(patientDialog.locator('.billing-refund-history')).toContainText(fullReason);
    await expect(
      patientDialog.getByRole('button', { name: 'Record external refund', exact: true }),
    ).toHaveCount(0);
    const shared = await get<InvoiceDetail>(own.request, `/api/invoices/${invoice.id}`);
    expect(shared.refunds).toEqual(full.detail.refunds);
    for (const refund of shared.refunds)
      for (const key of ['requestId', 'actorId', 'createdById', 'expectedRevision', 'receipt'])
        expect(refund).not.toHaveProperty(key);
    expect(
      (
        await own.request.post(path(invoice.id, payment.id), {
          headers: patientHeaders,
          data: {
            amountPaise: 1,
            method: 'cash',
            reference: '',
            reason: 'Unauthorized refund',
            refundedExternallyConfirmed: true,
            expectedRevision: shared.revision,
            requestId: randomUUID(),
          },
        })
      ).status(),
    ).toBe(403);
    await audit(patient);
    await patient.screenshot({
      path: testInfo.outputPath('external-refunds-patient-mobile.png'),
      fullPage: true,
    });
    await patientDialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await patient.goto('/my-care/summary');
    const entry = patient
      .locator('.care-summary-entry')
      .filter({ has: patient.getByRole('heading', { name: invoice.number, exact: true }) });
    await expect(entry.getByText(partialReason, { exact: true })).toBeVisible();
    await expect(entry.getByText(fullReason, { exact: true })).toBeVisible();
    const summary = await get<CareSummary>(
      own.request,
      '/api/patients/patient-ananya/care-summary',
    );
    const history = summary.invoiceHistories.find((item) => item.invoiceId === invoice.id)!;
    expect(history.refunds).toEqual(full.detail.refunds);
    expect(summary.invoices.find((item) => item.id === invoice.id)).toEqual(full.detail.invoice);
    for (const key of ['requestId', 'actorId', 'createdById', 'expectedRevision'])
      expect(JSON.stringify(history)).not.toContain(`"${key}"`);
    await patient.emulateMedia({ media: 'print' });
    try {
      await expect(entry.getByText(partialReason, { exact: true })).toBeVisible();
      await expect(entry.getByText(fullReason, { exact: true })).toBeVisible();
    } finally {
      await patient.emulateMedia({ media: 'screen' });
    }
  } finally {
    await own.close();
  }
});

test('refund limits and stale invoices require explicit review while uncertain committed refunds preserve their exact request through later errors', async ({
  page,
}) => {
  test.setTimeout(120000);
  const { headers, session } = await login(page.request),
    { invoice, detail: original, payment } = await fixture(page.request, headers, 10000, 9000);
  const endpoint = path(invoice.id, payment.id),
    detailPath = `/api/invoices/${invoice.id}`;
  await page.goto(`/clinic/billing?invoice=${invoice.id}`);
  let dialog = invoiceDialog(page, invoice),
    form = await openRefund(page, invoice, payment);
  const reason = `Shared retained refund draft ${randomUUID()}`,
    reference = `REFUND-RETRY-${randomUUID()}`;
  await fill(form, 9001, reason, 'card', reference);
  expect(
    await form
      .getByLabel('Refund amount (₹)', { exact: true })
      .evaluate((input: HTMLInputElement) => input.validity.rangeOverflow),
  ).toBeTruthy();
  expect(
    (
      await page.request.post(endpoint, {
        headers,
        data: {
          amountPaise: 9001,
          method: 'card',
          reference,
          reason,
          refundedExternallyConfirmed: true,
          expectedRevision: original.revision,
          requestId: randomUUID(),
        },
      })
    ).status(),
  ).toBe(409);
  expect((await get<InvoiceDetail>(page.request, detailPath)).refunds).toEqual([]);
  await fill(form, 3000, reason, 'card', reference);
  await form.getByLabel(confirmed, { exact: true }).check();
  const external = await post<PaymentRefundMutation>(page.request, headers, endpoint, {
    amountPaise: 2000,
    method: 'cash',
    reference: '',
    reason: 'Shared concurrent refund already completed',
    refundedExternallyConfirmed: true,
    expectedRevision: original.revision,
    requestId: randomUUID(),
  });
  const waitingStale = responseFor(page, endpoint);
  await form.getByRole('button', { name: 'Record refund', exact: true }).click();
  const stale = await waitingStale;
  expect(stale.status()).toBe(409);
  const staleBody = stale.request().postDataJSON() as PaymentRefundInput;
  await expect(form.getByLabel('Refund amount (₹)', { exact: true })).toHaveValue('30.00');
  await expect(form.getByLabel('Reason for refund', { exact: true })).toHaveValue(reason);
  await form.getByRole('button', { name: 'Refresh invoice for review', exact: true }).click();
  await expect(dialog.locator('.billing-refund-entry')).toContainText(external.refund.reason);
  await form
    .getByRole('button', { name: 'I reviewed the latest invoice; keep my draft', exact: true })
    .click();
  await expect(form.getByLabel(confirmed, { exact: true })).not.toBeChecked();
  await expect(form.getByLabel('Refund amount (₹)', { exact: true })).toHaveValue('30.00');
  await expect(form.getByLabel('Refund reference', { exact: true })).toHaveValue(reference);
  await expect(form.getByLabel('Reason for refund', { exact: true })).toHaveValue(reason);
  expect(
    Number(await form.getByLabel('Refund amount (₹)', { exact: true }).getAttribute('max')),
  ).toBe(70);

  const bodies: PaymentRefundInput[] = [];
  let committed: PaymentRefundMutation | undefined;
  const uncertain = async (route: Route) => {
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 2) {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Synthetic later rejection must preserve the committed refund request.',
        }),
      });
      return;
    }
    const response = await route.fetch();
    expect(response.status()).toBe(bodies.length === 1 ? 201 : 200);
    const result = (await response.json()) as PaymentRefundMutation;
    if (bodies.length === 1) {
      committed = result;
      await route.fulfill({
        response,
        json: { ...result, detail: { ...result.detail, refunds: [null] } },
      });
    } else if (bodies.length === 3)
      await route.fulfill({
        response,
        json: { ...result, receipt: { ...result.receipt, actorId: 'wrong-current-account' } },
      });
    else await route.fulfill({ response });
  };
  await page.route(`**${endpoint}`, uncertain);
  try {
    await form.getByLabel(confirmed, { exact: true }).check();
    await form.getByRole('button', { name: 'Record refund', exact: true }).click();
    await expect(
      form.getByRole('button', { name: 'Retry same request', exact: true }),
    ).toBeEnabled();
    await expect(form.getByLabel('Refund amount (₹)', { exact: true })).toBeDisabled();
    await expect(form.getByLabel(confirmed, { exact: true })).toBeDisabled();
    await form.getByRole('button', { name: 'Retry same request', exact: true }).click();
    await expect(form.getByRole('alert')).toContainText('Synthetic later rejection');
    await expect(form.getByLabel('Refund amount (₹)', { exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: 'Resume pending update', exact: true }).click();
    dialog = invoiceDialog(page, invoice);
    form = dialog.locator('.billing-refund-form');
    await expect(form.getByLabel('Refund amount (₹)', { exact: true })).toHaveValue('30.00');
    await expect(form.getByLabel('Refund amount (₹)', { exact: true })).toBeDisabled();
    await expect(form.getByLabel('Refund reference', { exact: true })).toHaveValue(reference);
    const advanced = await post<InvoiceDetail>(
      page.request,
      headers,
      `${detailPath}/corrections`,
      {
        items: [
          {
            description: 'Later independently corrected charge',
            quantity: 1,
            unitAmountPaise: 15000,
          },
        ],
        reason: 'Shared later charge correction',
        expectedRevision: committed!.detail.revision,
        requestId: randomUUID(),
      },
      200,
    );
    await form.getByRole('button', { name: 'Retry same request', exact: true }).click();
    await expect(
      form.getByRole('button', { name: 'Retry same request', exact: true }),
    ).toBeEnabled();
    await expect(form).toBeVisible();
    await expect(form.getByLabel('Refund amount (₹)', { exact: true })).toBeDisabled();
    const waitingRetry = responseFor(page, endpoint);
    await form.getByRole('button', { name: 'Retry same request', exact: true }).click();
    const replay = await waitingRetry;
    expect(replay.status()).toBe(200);
    const result = (await replay.json()) as PaymentRefundMutation;
    expect(result.refund).toEqual(committed!.refund);
    expect(result.receipt).toEqual(committed!.receipt);
    expect(result.detail.invoice).toEqual(advanced.invoice);
    expect(result.receipt.actorId).toBe(session.user!.id);
    await expect(form).toHaveCount(0);
    await expect(dialog.locator('.billing-current-charges')).toContainText(
      'Later independently corrected charge',
    );
    await expect(dialog.locator('.billing-refund-entry').filter({ hasText: reason })).toHaveCount(
      1,
    );
    expect(bodies).toHaveLength(4);
    for (const body of bodies) expect(body).toEqual(bodies[0]);
    expect(bodies[0].requestId).not.toBe(staleBody.requestId);
    expect(bodies[0].expectedRevision).toBe(external.detail.revision);
    const final = await get<InvoiceDetail>(page.request, detailPath);
    expect(final.refunds).toHaveLength(2);
    expect(final.invoice.paidPaise).toBe(4000);
    expect(final.payments).toEqual(original.payments);
  } finally {
    await page.unroute(`**${endpoint}`, uncertain);
  }
});

test('refund read failures recover, obsolete completion and unauthorized responses cannot affect a returned screen, and reception has shared read-only access', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(120000);
  const { headers } = await login(page.request),
    { invoice, payment } = await fixture(page.request, headers, 5000);
  const detailPath = `/api/invoices/${invoice.id}`,
    endpoint = path(invoice.id, payment.id),
    url = `/clinic/billing?invoice=${invoice.id}`;
  let malformed = true;
  const corruptRead = async (route: Route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    if (malformed)
      await route.fulfill({ response, json: { ...(await response.json()), refunds: [null] } });
    else await route.fulfill({ response });
  };
  await page.route(`**${detailPath}`, corruptRead);
  try {
    await page.goto(url);
    const errorDialog = page.getByRole('dialog');
    await expect(errorDialog.getByRole('alert')).toBeVisible();
    malformed = false;
    await errorDialog.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(invoiceDialog(page, invoice)).toBeVisible();
    await expect(invoiceDialog(page, invoice).getByRole('alert')).toHaveCount(0);
  } finally {
    await page.unroute(`**${detailPath}`, corruptRead);
  }
  await page.evaluate((prefix) => {
    const state = window as unknown as {
      refundBodies: Record<string, number>;
      refundExpired: number;
    };
    state.refundBodies = {};
    state.refundExpired = 0;
    window.addEventListener('derma:session-expired', () => state.refundExpired++);
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const response = await original(input, init),
        url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const pathname = new URL(url, window.location.origin).pathname;
      if (pathname.startsWith(prefix)) {
        const json = response.json.bind(response);
        response.json = async () => {
          try {
            return await json();
          } finally {
            const key = `${init?.method ?? 'GET'} ${pathname} ${response.status}`;
            state.refundBodies[key] = (state.refundBodies[key] ?? 0) + 1;
          }
        };
      }
      return response;
    };
  }, detailPath);
  const ready = deferred(),
    release = deferred(),
    done = deferred();
  let committed: PaymentRefundMutation | undefined;
  const held = async (route: Route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    committed = (await response.json()) as PaymentRefundMutation;
    ready.resolve();
    await release.promise;
    try {
      await route.fulfill({ response });
    } finally {
      done.resolve();
    }
  };
  const reason = `Shared held external refund ${randomUUID()}`;
  await page.route(`**${endpoint}`, held);
  try {
    const form = await openRefund(page, invoice, payment);
    await fill(form, 2000, reason);
    await form.getByLabel(confirmed, { exact: true }).check();
    await form.getByRole('button', { name: 'Record refund', exact: true }).click();
    await ready.promise;
    await expect(form.getByLabel('Refund amount (₹)', { exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(invoiceDialog(page, invoice)).toBeVisible();
    await page.evaluate(() => {
      window.history.pushState({ key: 'refund-command-away' }, '', '/clinic');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.getByRole('heading', { name: /^A good day for better care/ })).toBeVisible();
    await page.goBack();
    await expect(invoiceDialog(page, invoice).locator('.billing-refund-entry')).toContainText(
      reason,
    );
    await expect(page.locator('.billing-refund-form')).toHaveCount(0);
    release.resolve();
    await done.promise;
    await page.waitForFunction(
      (key) =>
        (window as unknown as { refundBodies: Record<string, number> }).refundBodies[key] >= 1,
      `POST ${endpoint} 201`,
    );
    await expect(page).toHaveURL(new RegExp(`invoice=${invoice.id}$`));
    await expect(page.locator('.billing-refund-form')).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Dismiss notification', exact: true }),
    ).toHaveCount(0);
    expect((await get<InvoiceDetail>(page.request, detailPath)).refunds).toEqual([
      committed!.refund,
    ]);
  } finally {
    release.resolve();
    await page.unroute(`**${endpoint}`, held);
  }

  await page.evaluate(() => {
    window.history.pushState({ key: 'refund-read-away' }, '', '/clinic');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByRole('heading', { name: /^A good day for better care/ })).toBeVisible();
  const readReady = deferred(),
    releaseRead = deferred();
  let heldReads = 0,
    settledReads = 0;
  const lateRead = async (route: Route) => {
    heldReads++;
    readReady.resolve();
    await releaseRead.promise;
    try {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Discarded invoice response must not expire this session.' }),
      });
    } finally {
      settledReads++;
    }
  };
  await page.route(`**${detailPath}`, lateRead);
  try {
    await page.evaluate((url) => {
      window.history.pushState({ key: 'refund-read-source' }, '', url);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, url);
    await readReady.promise;
    await page.goBack();
    await expect(page.getByRole('heading', { name: /^A good day for better care/ })).toBeVisible();
    const count = heldReads;
    expect(count).toBeGreaterThan(0);
    releaseRead.resolve();
    await expect.poll(() => settledReads).toBe(count);
    await page.waitForFunction(
      ({ key, count }) =>
        (window as unknown as { refundBodies: Record<string, number> }).refundBodies[key] >= count,
      { key: `GET ${detailPath} 401`, count },
    );
    expect(
      await page.evaluate(() => (window as unknown as { refundExpired: number }).refundExpired),
    ).toBe(0);
    expect((await get<Session>(page.request, '/api/session')).user?.role).toBe('admin');
    await expect(page).toHaveURL(/\/clinic$/);
  } finally {
    releaseRead.resolve();
    await page.unroute(`**${detailPath}`, lateRead);
  }

  const reception = await browser.newContext({ baseURL });
  try {
    const { headers: staffHeaders } = await login(reception.request, 'reception@derma.demo');
    const staff = await reception.newPage();
    await staff.goto(url);
    const dialog = invoiceDialog(staff, invoice);
    await expect(dialog.locator('.billing-refund-entry')).toContainText(reason);
    await expect(
      dialog.getByRole('button', { name: 'Record external refund', exact: true }),
    ).toHaveCount(0);
    await expect(
      dialog.getByRole('button', { name: 'Reverse erroneous entry', exact: true }),
    ).toHaveCount(0);
    const detail = await get<InvoiceDetail>(reception.request, detailPath);
    expect(detail.refunds).toEqual([committed!.refund]);
    expect(
      (
        await reception.request.post(endpoint, {
          headers: staffHeaders,
          data: {
            amountPaise: 1,
            method: 'cash',
            reference: '',
            reason: 'Unauthorized reception refund',
            refundedExternallyConfirmed: true,
            expectedRevision: detail.revision,
            requestId: randomUUID(),
          },
        })
      ).status(),
    ).toBe(403);
    await audit(staff);
    await staff.screenshot({
      path: testInfo.outputPath('external-refunds-reception-mobile.png'),
      fullPage: true,
    });
  } finally {
    await reception.close();
  }
  // A refund recorded today can concern a receipt from an earlier period.
  // Exercise that valid negative-only chart shape without changing the server clock.
  const reportDate = '2040-06-15';
  const negativeOnly = async (route: Route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    const report = (await response.json()) as ClinicInsights;
    expect(report.totals.collectionsPaise).toBe(0);
    await route.fulfill({
      response,
      json: {
        ...report,
        totals: {
          ...report.totals,
          refundCount: 1,
          refundsPaise: 2500,
          netCollectionsPaise: -2500,
        },
        refundsByMethod: report.refundsByMethod.map((row) => ({
          ...row,
          count: row.method === 'cash' ? 1 : 0,
          amountPaise: row.method === 'cash' ? 2500 : 0,
        })),
        daily: report.daily.map((row) => ({
          ...row,
          refundsPaise: 2500,
          netCollectionsPaise: -2500,
        })),
      },
    });
  };
  await page.route('**/api/insights?*', negativeOnly);
  try {
    await page.goto(`/clinic/insights?from=${reportDate}&to=${reportDate}`);
    await expect(page.getByRole('group', { name: 'Recorded refunds', exact: true })).toContainText(
      amount(2500),
    );
    await expect(
      page.getByRole('group', { name: 'Net recorded collections', exact: true }),
    ).toContainText(amount(-2500));
    await page.getByLabel('Chart measure', { exact: true }).selectOption('netCollectionsPaise');
    const chart = page.getByRole('img', { name: 'Net recorded collections by day', exact: true });
    await expect(chart).toBeVisible();
    const zero = Number(await chart.locator('line[stroke-dasharray]').getAttribute('y1'));
    const point = Number(await chart.locator('circle').getAttribute('cy'));
    expect(point).toBeGreaterThan(zero);
    await expect(
      page.getByRole('region', {
        name: 'Daily metrics table; scroll horizontally for all columns',
        exact: true,
      }),
    ).toContainText(amount(-2500));
    await audit(page);
    await page.screenshot({
      path: testInfo.outputPath('external-refunds-negative-period-mobile.png'),
      fullPage: true,
    });
  } finally {
    await page.unroute('**/api/insights?*', negativeOnly);
  }
});

test('saved schema-one copies without refund history retain their original bytes while an incomplete live summary fails closed', async ({
  page,
  playwright,
  baseURL,
}) => {
  test.setTimeout(60000);
  const staff = await playwright.request.newContext({ baseURL });
  try {
    const { headers } = await login(staff);
    const session = await post<Session>(page.request, {}, '/api/auth/register', {
      name: `Legacy summary patient ${randomUUID().slice(0, 8)}`,
      email: `legacy-summary-${randomUUID()}@example.test`,
      password: 'LegacySummary2026!',
      phone: '9000000271',
      dob: '1992-04-14',
      gender: 'Not recorded',
    });
    const patientId = session.user!.patientId!;
    const invoice = await post<Invoice>(staff, headers, '/api/invoices', {
      patientId,
      requestId: randomUUID(),
      items: [
        { description: 'Original retained consultation · ₹', quantity: 1, unitAmountPaise: 2505 },
      ],
    });
    await post<InvoiceDetail>(staff, headers, `/api/invoices/${invoice.id}/payments`, {
      amountPaise: 505,
      method: 'cash',
      reference: 'LEGACY-RECEIPT',
      requestId: randomUUID(),
    });
    const summaryPath = `/api/patients/${patientId}/care-summary`;
    const current = await get<CareSummary>(page.request, summaryPath);
    expect(current.invoiceHistories).toHaveLength(1);
    expect(current.invoiceHistories[0].refunds).toEqual([]);
    const saved = await post<CareSummaryCopyResult>(
      page.request,
      { 'X-CSRF-Token': session.csrfToken! },
      `${summaryPath}/copies`,
      { expectedRevision: current.revision, requestId: randomUUID() },
    );
    expect(saved.copy.savedBy.role).toBe('patient');
    expect(saved.receipt.actorId).toBe(session.user!.id);
    const detailPath = `${summaryPath}/copies/${saved.copy.id}`;
    const authentic = await get<CareSummaryCopyDetail>(page.request, detailPath);
    const legacy = {
      ...authentic.summary,
      invoiceHistories: authentic.summary.invoiceHistories.map(
        ({ refunds: _refunds, ...history }) => history,
      ),
    };
    expect(legacy.schemaVersion).toBe(1);
    const bytes = Buffer.from(JSON.stringify(legacy, null, 2) + '\n', 'utf8');
    const contentSha256 = createHash('sha256').update(bytes).digest('hex');
    const copy = { ...authentic.copy, byteLength: bytes.length, contentSha256 };
    expect(copy.contentSha256).not.toBe(authentic.copy.contentSha256);
    const legacyDetail = async (route: Route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.fulfill({ response, json: { copy, summary: legacy } });
    };
    const legacyDownload = async (route: Route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.fulfill({
        response,
        headers: {
          ...response.headers(),
          'x-content-sha256': contentSha256,
          'content-length': String(bytes.length),
        },
        body: bytes,
      });
    };
    await page.route(`**${detailPath}`, legacyDetail);
    await page.route(`**${detailPath}/download`, legacyDownload);
    try {
      await page.goto(`/my-care/summary?view=copies&copy=${saved.copy.id}`);
      await expect(
        page.getByRole('heading', { name: 'Saved care summary', exact: true }),
      ).toBeVisible();
      const entry = page
        .locator('.care-summary-entry')
        .filter({ has: page.getByRole('heading', { name: invoice.number, exact: true }) });
      await expect(
        entry.getByText(invoice.items[0].description, { exact: true }).first(),
      ).toBeVisible();
      await expect(entry.locator('.care-summary-invoice-totals')).toContainText('Balance ₹20');
      await expect(
        entry.getByRole('heading', { name: 'Recorded external refunds', exact: true }),
      ).toHaveCount(0);
      await expect(page.getByRole('alert')).toHaveCount(0);
      const downloaded = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download saved JSON', exact: true }).click();
      const download = await downloaded;
      expect(download.suggestedFilename()).toBe(`care-summary-copy-${saved.copy.id}.json`);
      const actual = await readFile((await download.path())!);
      expect(actual).toEqual(bytes);
      expect(actual.length).toBe(copy.byteLength);
      expect(createHash('sha256').update(actual).digest('hex')).toBe(copy.contentSha256);
      const parsed = JSON.parse(actual.toString('utf8'));
      expect(parsed).toEqual(legacy);
      expect(parsed.invoiceHistories[0]).not.toHaveProperty('refunds');

      // The exception applies only to immutable historical documents. Keep every
      // initial read malformed until explicit retry, including StrictMode repeats.
      const incompleteLive = async (route: Route) => {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        const summary = (await response.json()) as CareSummary;
        await route.fulfill({
          response,
          json: {
            ...summary,
            invoiceHistories: summary.invoiceHistories.map(
              ({ refunds: _refunds, ...history }) => history,
            ),
          },
        });
      };
      await page.route(`**${summaryPath}`, incompleteLive);
      try {
        await page.getByRole('button', { name: 'Current summary', exact: true }).click();
        await expect(page.getByRole('alert')).toBeVisible();
        await expect(page.locator('.care-summary-document')).toHaveCount(0);
        for (const name of ['Save copy', 'Print summary', 'Download JSON'])
          await expect(page.getByRole('button', { name, exact: true })).toBeDisabled();
      } finally {
        await page.unroute(`**${summaryPath}`, incompleteLive);
      }
      await page.getByRole('button', { name: 'Try again', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Save copy', exact: true })).toBeEnabled();
      await expect(
        page
          .locator('.care-summary-document')
          .getByRole('heading', { name: invoice.number, exact: true }),
      ).toBeVisible();
      expect(
        (await get<CareSummary>(page.request, summaryPath)).invoiceHistories[0].refunds,
      ).toEqual([]);
    } finally {
      await page.unroute(`**${detailPath}`, legacyDetail);
      await page.unroute(`**${detailPath}/download`, legacyDownload);
    }
  } finally {
    await staff.dispose();
  }
});
