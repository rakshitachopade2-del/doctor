import { test, expect, type APIRequestContext, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Session } from '../../shared/types';
import type { Invoice, InvoiceDetail } from '../../shared/operations';
import type {
  PaymentRefund,
  PaymentRefundMutation,
  PaymentRefundVoidInput,
  PaymentRefundVoidMutation,
} from '../../shared/billing-corrections';
import type { CareSummary } from '../../shared/care-summary';
import type {
  CareSummaryCopyDetail,
  CareSummaryCopyResult,
} from '../../shared/care-summary-copies';

const confirmation =
  'I confirm this refund was recorded in error; this correction does not move money.';
const path = (invoiceId: string, refundId: string) =>
  `/api/invoices/${invoiceId}/refunds/${refundId}/void`;
const money = (paise: number) =>
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
  patientId = 'patient-ananya',
) {
  const invoice = await post<Invoice>(request, headers, '/api/invoices', {
    patientId,
    requestId: randomUUID(),
    items: [
      {
        description: `Original void fixture service ${randomUUID().slice(0, 8)}`,
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
      amountPaise: totalPaise,
      method: 'upi',
      reference: `PAID-${randomUUID()}`,
      requestId: randomUUID(),
    },
  );
  return { invoice, detail, payment: detail.payments[0] };
}
async function refund(
  request: APIRequestContext,
  headers: Record<string, string>,
  source: InvoiceDetail,
  amountPaise: number,
  reason = `Shared original refund ${randomUUID()}`,
) {
  return post<PaymentRefundMutation>(
    request,
    headers,
    `/api/invoices/${source.invoice.id}/payments/${source.payments[0].id}/refunds`,
    {
      amountPaise,
      method: 'cash',
      reference: '',
      reason,
      refundedExternallyConfirmed: true,
      expectedRevision: source.revision,
      requestId: randomUUID(),
    },
  );
}
async function charges(
  request: APIRequestContext,
  headers: Record<string, string>,
  source: InvoiceDetail,
  totalPaise: number,
) {
  return post<InvoiceDetail>(
    request,
    headers,
    `/api/invoices/${source.invoice.id}/corrections`,
    {
      items: [{ ...source.invoice.items[0], unitAmountPaise: totalPaise }],
      reason: `Shared independently reviewed charges ${randomUUID()}`,
      expectedRevision: source.revision,
      requestId: randomUUID(),
    },
    200,
  );
}
const dialogFor = (page: Page, invoice: Invoice) =>
  page.getByRole('dialog', { name: `Invoice ${invoice.number}`, exact: true });
const responseFor = (page: Page, endpoint: string) =>
  page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === endpoint && response.request().method() === 'POST',
  );
async function openVoid(page: Page, invoice: Invoice, original: PaymentRefund) {
  const dialog = dialogFor(page, invoice);
  await dialog
    .locator('.billing-refund-entry')
    .filter({ hasText: original.reason })
    .getByRole('button', { name: 'Void refund entry', exact: true })
    .click();
  const form = dialog.locator('.billing-refund-void-form');
  await expect(
    form.getByRole('heading', { name: 'Void an erroneous refund entry', exact: true }),
  ).toBeVisible();
  return form;
}
async function saveVoid(page: Page, invoice: Invoice, original: PaymentRefund, reason: string) {
  const form = dialogFor(page, invoice).locator('.billing-refund-void-form');
  await form.getByLabel('Reason for voiding refund', { exact: true }).fill(reason);
  await form.getByLabel(confirmation, { exact: true }).check();
  const waiting = responseFor(page, path(invoice.id, original.id));
  await form.getByRole('button', { name: 'Confirm refund entry void', exact: true }).click();
  const response = await waiting;
  expect(response.status(), await response.text()).toBe(201);
  const result = (await response.json()) as PaymentRefundVoidMutation;
  await expect(form).toHaveCount(0);
  await expect(
    dialogFor(page, invoice).locator('.billing-refund-void-entry').filter({ hasText: reason }),
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

test('voiding erroneous refunds restores net paid without changing original charges, payments or refunds and shares attributed correction history with the patient', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(120000);
  const { headers, session } = await login(page.request),
    { invoice, detail: original, payment } = await fixture(page.request, headers, 12005);
  const first = await refund(page.request, headers, original, 3005);
  const second = await refund(page.request, headers, first.detail, 2000);
  const before = await get<CareSummary>(page.request, '/api/patients/patient-ananya/care-summary');
  await page.goto(`/clinic/billing?invoice=${invoice.id}`);
  const dialog = dialogFor(page, invoice),
    firstReason = `Shared erroneous refund correction ${randomUUID()}`;
  const form = await openVoid(page, invoice, first.refund);
  await expect(form.getByLabel(confirmation, { exact: true })).not.toBeChecked();
  await expect(
    form.getByRole('button', { name: 'Confirm refund entry void', exact: true }),
  ).toBeDisabled();
  const partial = await saveVoid(page, invoice, first.refund, firstReason);
  expect(partial.void).toMatchObject({
    invoiceId: invoice.id,
    refundId: first.refund.id,
    paymentId: payment.id,
    amountPaise: 3005,
    beforePaidPaise: 7000,
    afterPaidPaise: 10005,
    entryErrorConfirmed: true,
    reason: firstReason,
    createdByName: session.user!.name,
  });
  expect(partial.receipt).toMatchObject({
    actorId: session.user!.id,
    invoiceId: invoice.id,
    refundId: first.refund.id,
    expectedRevision: second.detail.revision,
    voidId: partial.void.id,
  });
  expect(partial.detail.refunds).toEqual(second.detail.refunds);
  expect(partial.detail.payments).toEqual(original.payments);
  expect(partial.detail.invoice).toEqual({
    ...original.invoice,
    paidPaise: 10005,
    status: 'partial',
  });
  await expect(
    dialog
      .locator('.billing-refund-entry')
      .filter({ hasText: first.refund.reason })
      .getByText('Refund entry voided', { exact: true }),
  ).toBeVisible();
  await expect(
    dialog
      .locator('.billing-refund-entry')
      .filter({ hasText: first.refund.reason })
      .getByRole('button', { name: 'Void refund entry', exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole('button', { name: 'Reverse erroneous entry', exact: true }),
  ).toBeDisabled();
  await expect(dialog.locator('.payment-row')).toContainText(money(10005));
  const secondReason = `Shared second refund correction ${randomUUID()}`;
  await openVoid(page, invoice, second.refund);
  const restored = await saveVoid(page, invoice, second.refund, secondReason);
  expect(restored.detail.invoice).toEqual(original.invoice);
  expect(restored.detail.issuedCharges).toEqual(original.issuedCharges);
  expect(restored.detail.refunds).toEqual(second.detail.refunds);
  expect(restored.detail.payments).toEqual(original.payments);
  expect(restored.detail.refundVoids).toHaveLength(2);
  expect(restored.detail.reversals).toEqual([]);
  expect(restored.detail.corrections).toEqual([]);
  await expect(
    dialog.getByRole('button', { name: 'Reverse erroneous entry', exact: true }),
  ).toBeEnabled();
  await expect(
    dialog.getByRole('button', { name: 'Record external refund', exact: true }),
  ).toBeEnabled();
  await expect(dialog.locator('.payment-row')).toContainText(money(12005));
  expect(
    (
      await page.request.get(
        `/api/patients/patient-ananya/care-summary/download?revision=${before.revision}`,
      )
    ).status(),
  ).toBe(409);
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  await page.emulateMedia({ media: 'print' });
  try {
    await expect(dialog.locator('.billing-current-charges')).toContainText(
      invoice.items[0].description,
    );
    await expect(dialog.locator('.billing-refund-history')).toContainText(first.refund.reason);
    await expect(dialog.locator('.billing-refund-history')).toContainText(second.refund.reason);
    await expect(dialog.locator('.billing-refund-void-history')).toContainText(firstReason);
    await expect(dialog.locator('.billing-refund-void-history')).toContainText(secondReason);
    await expect(
      dialog
        .locator('.billing-refund-history')
        .getByRole('button', { name: 'Void refund entry', exact: true })
        .first(),
    ).toBeHidden();
  } finally {
    await page.emulateMedia({ media: 'screen' });
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  }
  await audit(page);
  await page.screenshot({
    path: testInfo.outputPath('refund-voids-admin-mobile.png'),
    fullPage: true,
  });
  const own = await browser.newContext({ baseURL });
  try {
    const { headers: patientHeaders } = await login(own.request, 'patient@derma.demo');
    const patient = await own.newPage();
    await patient.goto(`/my-care/invoices?invoice=${invoice.id}`);
    const patientDialog = dialogFor(patient, invoice);
    await expect(patientDialog.locator('.billing-refund-void-history')).toContainText(firstReason);
    await expect(patientDialog.locator('.billing-refund-void-history')).toContainText(secondReason);
    await expect(patientDialog.locator('.billing-refund-entry')).toHaveCount(2);
    await expect(
      patientDialog.getByRole('button', { name: 'Void refund entry', exact: true }),
    ).toHaveCount(0);
    const shared = await get<InvoiceDetail>(own.request, `/api/invoices/${invoice.id}`);
    expect(shared.refundVoids).toEqual(restored.detail.refundVoids);
    expect(shared.refunds).toEqual(second.detail.refunds);
    for (const row of shared.refundVoids)
      for (const key of ['requestId', 'actorId', 'createdById', 'expectedRevision', 'receipt'])
        expect(row).not.toHaveProperty(key);
    expect(
      (
        await own.request.post(path(invoice.id, first.refund.id), {
          headers: patientHeaders,
          data: {
            reason: 'Unauthorized patient void',
            entryErrorConfirmed: true,
            expectedRevision: shared.revision,
            requestId: randomUUID(),
          },
        })
      ).status(),
    ).toBe(403);
    await audit(patient);
    await patient.screenshot({
      path: testInfo.outputPath('refund-voids-patient-mobile.png'),
      fullPage: true,
    });
    await patientDialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await patient.goto('/my-care/summary');
    const entry = patient
      .locator('.care-summary-entry')
      .filter({ has: patient.getByRole('heading', { name: invoice.number, exact: true }) });
    await expect(entry).toContainText(firstReason);
    await expect(entry).toContainText(secondReason);
    await expect(entry).toContainText(first.refund.reason);
    const summary = await get<CareSummary>(
      own.request,
      '/api/patients/patient-ananya/care-summary',
    );
    const history = summary.invoiceHistories.find((row) => row.invoiceId === invoice.id)!;
    expect(history.refunds).toEqual(second.detail.refunds);
    expect(history.refundVoids).toEqual(restored.detail.refundVoids);
    for (const key of ['requestId', 'actorId', 'createdById', 'expectedRevision'])
      expect(JSON.stringify(history)).not.toContain(`"${key}"`);
    await patient.emulateMedia({ media: 'print' });
    try {
      await expect(entry).toContainText(firstReason);
      await expect(entry).toContainText(secondReason);
    } finally {
      await patient.emulateMedia({ media: 'screen' });
    }
  } finally {
    await own.close();
  }
  const reversed = await post<InvoiceDetail>(
    page.request,
    headers,
    `/api/invoices/${invoice.id}/payments/${payment.id}/reverse`,
    {
      reason: 'Separately corrected mistaken original payment after no active refunds remain',
      entryErrorConfirmed: true,
      expectedRevision: restored.detail.revision,
      requestId: randomUUID(),
    },
    200,
  );
  expect(reversed.invoice.paidPaise).toBe(0);
  expect(reversed.refundVoids).toEqual(restored.detail.refundVoids);
  expect(reversed.refunds).toEqual(second.detail.refunds);
});

test('restoration cannot exceed charges and stale or uncertain voids preserve the original draft and exact command identity', async ({
  page,
}) => {
  test.setTimeout(120000);
  const { headers, session } = await login(page.request),
    { invoice, detail: paid } = await fixture(page.request, headers);
  const returned = await refund(page.request, headers, paid, 4000);
  const lowered = await charges(page.request, headers, returned.detail, 7000);
  const endpoint = path(invoice.id, returned.refund.id),
    detailPath = `/api/invoices/${invoice.id}`;
  const reason = `Shared preserved void reason ${randomUUID()}`;
  await page.goto(`/clinic/billing?invoice=${invoice.id}`);
  const dialog = dialogFor(page, invoice);
  let form = await openVoid(page, invoice, returned.refund);
  await form.getByLabel('Reason for voiding refund', { exact: true }).fill(reason);
  await expect(form.getByLabel(confirmation, { exact: true })).toBeDisabled();
  await expect(
    form.getByRole('button', { name: 'Confirm refund entry void', exact: true }),
  ).toBeDisabled();
  const blocked = await page.request.post(endpoint, {
    headers,
    data: {
      reason,
      entryErrorConfirmed: true,
      expectedRevision: lowered.revision,
      requestId: randomUUID(),
    },
  });
  expect(blocked.status()).toBe(409);
  expect((await get<InvoiceDetail>(page.request, detailPath)).refundVoids).toEqual([]);
  const corrected = await charges(page.request, headers, lowered, 10000);
  await form.getByRole('button', { name: 'Refresh invoice for review', exact: true }).click();
  await form
    .getByRole('button', { name: 'I reviewed the latest invoice; keep my draft', exact: true })
    .click();
  await expect(form.getByLabel('Reason for voiding refund', { exact: true })).toHaveValue(reason);
  await expect(form.getByLabel(confirmation, { exact: true })).toBeEnabled();
  await expect(form.getByLabel(confirmation, { exact: true })).not.toBeChecked();
  await form.getByLabel(confirmation, { exact: true }).check();
  const concurrent = await refund(
    page.request,
    headers,
    corrected,
    1000,
    'Shared later refund requiring a fresh source review',
  );
  const staleResponse = responseFor(page, endpoint);
  await form.getByRole('button', { name: 'Confirm refund entry void', exact: true }).click();
  const stale = await staleResponse;
  expect(stale.status()).toBe(409);
  const staleBody = stale.request().postDataJSON() as PaymentRefundVoidInput;
  await form.getByRole('button', { name: 'Refresh invoice for review', exact: true }).click();
  await expect(dialog.locator('.billing-refund-history')).toContainText(concurrent.refund.reason);
  await form
    .getByRole('button', { name: 'I reviewed the latest invoice; keep my draft', exact: true })
    .click();
  await expect(form.getByLabel('Reason for voiding refund', { exact: true })).toHaveValue(reason);
  await expect(form.getByLabel(confirmation, { exact: true })).not.toBeChecked();
  const bodies: PaymentRefundVoidInput[] = [];
  let committed: PaymentRefundVoidMutation | undefined;
  const uncertain = async (route: Route) => {
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 2) {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Synthetic later rejection must preserve this committed void request.',
        }),
      });
      return;
    }
    const response = await route.fetch();
    expect(response.status()).toBe(bodies.length === 1 ? 201 : 200);
    const result = (await response.json()) as PaymentRefundVoidMutation;
    if (bodies.length === 1) {
      committed = result;
      await route.fulfill({
        response,
        json: { ...result, detail: { ...result.detail, refundVoids: [null] } },
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
    await form.getByLabel(confirmation, { exact: true }).check();
    await form.getByRole('button', { name: 'Confirm refund entry void', exact: true }).click();
    await expect(
      form.getByRole('button', { name: 'Retry same request', exact: true }),
    ).toBeEnabled();
    await expect(form.getByLabel('Reason for voiding refund', { exact: true })).toBeDisabled();
    await expect(form.getByLabel(confirmation, { exact: true })).toBeDisabled();
    await form.getByRole('button', { name: 'Retry same request', exact: true }).click();
    await expect(form.getByRole('alert')).toContainText('Synthetic later rejection');
    await expect(form.getByLabel('Reason for voiding refund', { exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: 'Resume pending update', exact: true }).click();
    form = dialog.locator('.billing-refund-void-form');
    await expect(form.getByLabel('Reason for voiding refund', { exact: true })).toHaveValue(reason);
    await expect(form.getByLabel('Reason for voiding refund', { exact: true })).toBeDisabled();
    const advanced = await charges(page.request, headers, committed!.detail, 12000);
    await form.getByRole('button', { name: 'Retry same request', exact: true }).click();
    await expect(
      form.getByRole('button', { name: 'Retry same request', exact: true }),
    ).toBeEnabled();
    await expect(form).toBeVisible();
    const retryResponse = responseFor(page, endpoint);
    await form.getByRole('button', { name: 'Retry same request', exact: true }).click();
    const replay = await retryResponse;
    expect(replay.status()).toBe(200);
    const result = (await replay.json()) as PaymentRefundVoidMutation;
    expect(result.void).toEqual(committed!.void);
    expect(result.receipt).toEqual(committed!.receipt);
    expect(result.receipt.actorId).toBe(session.user!.id);
    expect(result.detail.invoice).toEqual(advanced.invoice);
    await expect(form).toHaveCount(0);
    await expect(
      dialog.locator('.billing-refund-void-entry').filter({ hasText: reason }),
    ).toHaveCount(1);
    expect(bodies).toHaveLength(4);
    for (const body of bodies) expect(body).toEqual(bodies[0]);
    expect(bodies[0].requestId).not.toBe(staleBody.requestId);
    expect(bodies[0].expectedRevision).toBe(concurrent.detail.revision);
    const final = await get<InvoiceDetail>(page.request, detailPath);
    expect(final.refundVoids).toHaveLength(1);
    expect(final.refunds).toEqual(concurrent.detail.refunds);
    expect(final.invoice.paidPaise).toBe(9000);
    expect(final.invoice.totalPaise).toBe(12000);
  } finally {
    await page.unroute(`**${endpoint}`, uncertain);
  }
});

test('void history reads recover and late mutation or unauthorized responses cannot affect a returned screen while reception remains read-only', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(120000);
  const { headers } = await login(page.request),
    { invoice, detail: paid } = await fixture(page.request, headers, 5000);
  const returned = await refund(page.request, headers, paid, 2000);
  const detailPath = `/api/invoices/${invoice.id}`,
    endpoint = path(invoice.id, returned.refund.id),
    url = `/clinic/billing?invoice=${invoice.id}`;
  let malformed = true;
  const corruptRead = async (route: Route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    if (malformed)
      await route.fulfill({ response, json: { ...(await response.json()), refundVoids: [null] } });
    else await route.fulfill({ response });
  };
  await page.route(`**${detailPath}`, corruptRead);
  try {
    await page.goto(url);
    const loadingDialog = page.getByRole('dialog');
    await expect(loadingDialog.getByRole('alert')).toBeVisible();
    malformed = false;
    await loadingDialog.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(dialogFor(page, invoice)).toBeVisible();
    await expect(dialogFor(page, invoice).getByRole('alert')).toHaveCount(0);
  } finally {
    await page.unroute(`**${detailPath}`, corruptRead);
  }
  await page.evaluate((prefix) => {
    const state = window as unknown as { voidBodies: Record<string, number>; voidExpired: number };
    state.voidBodies = {};
    state.voidExpired = 0;
    window.addEventListener('derma:session-expired', () => state.voidExpired++);
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
            state.voidBodies[key] = (state.voidBodies[key] ?? 0) + 1;
          }
        };
      }
      return response;
    };
  }, detailPath);
  const ready = deferred(),
    release = deferred(),
    done = deferred();
  let committed: PaymentRefundVoidMutation | undefined;
  const held = async (route: Route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    committed = (await response.json()) as PaymentRefundVoidMutation;
    ready.resolve();
    await release.promise;
    try {
      await route.fulfill({ response });
    } finally {
      done.resolve();
    }
  };
  const reason = `Shared delayed void receipt ${randomUUID()}`;
  await page.route(`**${endpoint}`, held);
  try {
    const form = await openVoid(page, invoice, returned.refund);
    await form.getByLabel('Reason for voiding refund', { exact: true }).fill(reason);
    await form.getByLabel(confirmation, { exact: true }).check();
    await form.getByRole('button', { name: 'Confirm refund entry void', exact: true }).click();
    await ready.promise;
    await expect(form.getByLabel('Reason for voiding refund', { exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialogFor(page, invoice)).toBeVisible();
    await page.evaluate(() => {
      window.history.pushState({ key: 'refund-void-away' }, '', '/clinic');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.getByRole('heading', { name: /^A good day for better care/ })).toBeVisible();
    await page.goBack();
    await expect(dialogFor(page, invoice).locator('.billing-refund-void-history')).toContainText(
      reason,
    );
    await expect(page.locator('.billing-refund-void-form')).toHaveCount(0);
    release.resolve();
    await done.promise;
    await page.waitForFunction(
      (key) => (window as unknown as { voidBodies: Record<string, number> }).voidBodies[key] >= 1,
      `POST ${endpoint} 201`,
    );
    await expect(page).toHaveURL(new RegExp(`invoice=${invoice.id}$`));
    await expect(page.locator('.billing-refund-void-form')).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Dismiss notification', exact: true }),
    ).toHaveCount(0);
    expect((await get<InvoiceDetail>(page.request, detailPath)).refundVoids).toEqual([
      committed!.void,
    ]);
  } finally {
    release.resolve();
    await page.unroute(`**${endpoint}`, held);
  }
  await page.evaluate(() => {
    window.history.pushState({ key: 'void-history-away' }, '', '/clinic');
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
        body: JSON.stringify({
          error: 'Discarded void history must not expire the current session.',
        }),
      });
    } finally {
      settledReads++;
    }
  };
  await page.route(`**${detailPath}`, lateRead);
  try {
    await page.evaluate((url) => {
      window.history.pushState({ key: 'void-history-source' }, '', url);
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
        (window as unknown as { voidBodies: Record<string, number> }).voidBodies[key] >= count,
      { key: `GET ${detailPath} 401`, count },
    );
    expect(
      await page.evaluate(() => (window as unknown as { voidExpired: number }).voidExpired),
    ).toBe(0);
    expect((await get<Session>(page.request, '/api/session')).user?.role).toBe('admin');
  } finally {
    releaseRead.resolve();
    await page.unroute(`**${detailPath}`, lateRead);
  }
  const reception = await browser.newContext({ baseURL });
  try {
    const { headers: staffHeaders } = await login(reception.request, 'reception@derma.demo');
    const staff = await reception.newPage();
    await staff.goto(url);
    const dialog = dialogFor(staff, invoice);
    await expect(dialog.locator('.billing-refund-void-history')).toContainText(reason);
    await expect(
      dialog.getByRole('button', { name: 'Void refund entry', exact: true }),
    ).toHaveCount(0);
    const current = await get<InvoiceDetail>(reception.request, detailPath);
    expect(current.refundVoids).toEqual([committed!.void]);
    expect(
      (
        await reception.request.post(endpoint, {
          headers: staffHeaders,
          data: {
            reason: 'Unauthorized staff correction',
            entryErrorConfirmed: true,
            expectedRevision: current.revision,
            requestId: randomUUID(),
          },
        })
      ).status(),
    ).toBe(403);
    await audit(staff);
    await staff.screenshot({
      path: testInfo.outputPath('refund-voids-reception-mobile.png'),
      fullPage: true,
    });
  } finally {
    await reception.close();
  }
});

test('saved copies containing refunds but predating refund voids remain byte-exact while live summaries require complete void history', async ({
  page,
  playwright,
  baseURL,
}) => {
  test.setTimeout(60000);
  const staff = await playwright.request.newContext({ baseURL });
  try {
    const { headers } = await login(staff);
    const session = await post<Session>(page.request, {}, '/api/auth/register', {
      name: `Legacy refund patient ${randomUUID().slice(0, 8)}`,
      email: `legacy-refund-${randomUUID()}@example.test`,
      password: 'LegacyRefund2026!',
      phone: '9000000281',
      dob: '1992-04-14',
      gender: 'Not recorded',
    });
    const patientId = session.user!.patientId!;
    const { invoice, detail: paid } = await fixture(staff, headers, 2505, patientId);
    const returned = await refund(
      staff,
      headers,
      paid,
      505,
      'Original shared refund preserved in an older saved copy',
    );
    const summaryPath = `/api/patients/${patientId}/care-summary`;
    const current = await get<CareSummary>(page.request, summaryPath);
    expect(current.invoiceHistories).toHaveLength(1);
    expect(current.invoiceHistories[0].refunds).toEqual([returned.refund]);
    expect(current.invoiceHistories[0].refundVoids).toEqual([]);
    const saved = await post<CareSummaryCopyResult>(
      page.request,
      { 'X-CSRF-Token': session.csrfToken! },
      `${summaryPath}/copies`,
      { expectedRevision: current.revision, requestId: randomUUID() },
    );
    expect(saved.copy.savedBy.role).toBe('patient');
    const detailPath = `${summaryPath}/copies/${saved.copy.id}`;
    const authentic = await get<CareSummaryCopyDetail>(page.request, detailPath);
    const legacy = {
      ...authentic.summary,
      invoiceHistories: authentic.summary.invoiceHistories.map(
        ({ refundVoids: _voids, ...history }) => history,
      ),
    };
    expect(legacy.schemaVersion).toBe(1);
    const bytes = Buffer.from(JSON.stringify(legacy, null, 2) + '\n', 'utf8'),
      hash = createHash('sha256').update(bytes).digest('hex');
    const copy = { ...authentic.copy, contentSha256: hash, byteLength: bytes.length };
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
          'x-content-sha256': hash,
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
      await expect(entry).toContainText(returned.refund.reason);
      await expect(entry.locator('.care-summary-invoice-totals')).toContainText('Balance ₹5.05');
      await expect(page.getByRole('alert')).toHaveCount(0);
      const waiting = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download saved JSON', exact: true }).click();
      const download = await waiting;
      expect(download.suggestedFilename()).toBe(`care-summary-copy-${saved.copy.id}.json`);
      const actual = await readFile((await download.path())!);
      expect(actual).toEqual(bytes);
      expect(actual.length).toBe(copy.byteLength);
      expect(createHash('sha256').update(actual).digest('hex')).toBe(hash);
      const parsed = JSON.parse(actual.toString('utf8'));
      expect(parsed.invoiceHistories[0].refunds).toEqual([returned.refund]);
      expect(parsed.invoiceHistories[0]).not.toHaveProperty('refundVoids');
      const incompleteLive = async (route: Route) => {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        const summary = (await response.json()) as CareSummary;
        await route.fulfill({
          response,
          json: {
            ...summary,
            invoiceHistories: summary.invoiceHistories.map(
              ({ refundVoids: _voids, ...history }) => history,
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
      await expect(page.locator('.care-summary-document')).toContainText(returned.refund.reason);
      expect(
        (await get<CareSummary>(page.request, summaryPath)).invoiceHistories[0].refundVoids,
      ).toEqual([]);
    } finally {
      await page.unroute(`**${detailPath}`, legacyDetail);
      await page.unroute(`**${detailPath}/download`, legacyDownload);
    }
  } finally {
    await staff.dispose();
  }
});
