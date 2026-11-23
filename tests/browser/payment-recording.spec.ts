import { randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Invoice, InvoiceDetail, Payment } from '../../shared/operations';
import type { ActivityFeed } from '../../shared/activity';
import type { Session } from '../../shared/types';
import type {
  PaymentRecordingCommand,
  PaymentRecordingResult,
  PaymentNotRecorded,
} from '../../shared/payment-recording';

const billing = '/clinic/billing';
const patientId = 'patient-ananya';
const record = 'Record received payment';
const retry = 'Retry exact payment';
const resume = 'Resume payment entry';
const dialog = (page: Page) => page.getByRole('dialog');
const action = (page: Page, name: string) =>
  dialog(page).getByRole('button', { name, exact: true });
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const field = (page: Page, name: string) => dialog(page).getByLabel(name, { exact: true });
const ack = (page: Page) =>
  dialog(page).getByRole('checkbox', {
    name: 'I confirm this money was already received outside Derma.',
    exact: true,
  });
const detailUrl = (invoice: Invoice) => '/api/invoices/' + invoice.id;
const paymentUrl = (invoice: Invoice) => detailUrl(invoice) + '/payments/record';
async function login(api: APIRequestContext, role: 'admin' | 'reception' | 'doctor' | 'patient') {
  const r = await api.post('/api/auth/login', {
    data: { email: role + '@derma.demo', password: 'DemoClinic2026!' },
  });
  expect(r.status(), await r.text()).toBe(200);
  return (await r.json()) as Session;
}
async function post<T>(
  api: APIRequestContext,
  session: Session,
  path: string,
  data: unknown,
  status: number,
) {
  const r = await api.post(path, { data, headers: { 'X-CSRF-Token': session.csrfToken! } });
  expect(r.status(), await r.text()).toBe(status);
  return (await r.json()) as T;
}
async function read<T>(api: APIRequestContext, path: string) {
  const r = await api.get(path);
  expect(r.status(), await r.text()).toBe(200);
  return (await r.json()) as T;
}
function newInvoice(api: APIRequestContext, session: Session, amount = 24681) {
  return post<Invoice>(
    api,
    session,
    '/api/invoices',
    {
      requestId: randomUUID(),
      patientId,
      items: [
        { description: 'Payment recording ' + randomUUID(), quantity: 1, unitAmountPaise: amount },
      ],
    },
    201,
  );
}
async function openInvoice(page: Page, invoice: Invoice) {
  await page.goto(billing + '?invoice=' + invoice.id);
  await expect(
    dialog(page).getByRole('heading', { name: 'Invoice ' + invoice.number, exact: true }),
  ).toBeVisible();
}
async function fill(page: Page, amount: string, method: Payment['method'], reference: string) {
  await field(page, 'Amount received (₹)').fill(amount);
  await field(page, 'Payment method').selectOption(method);
  await field(page, 'Reference / receipt number').fill(reference);
}
async function review(page: Page) {
  await action(page, 'Review payment').click();
  await expect(
    dialog(page).getByRole('heading', { name: 'Review received payment', exact: true }),
  ).toBeVisible();
  await expect(ack(page)).not.toBeChecked();
  await expect(action(page, record)).toBeDisabled();
  await ack(page).check();
}
async function send(page: Page, invoice: Invoice, name: string) {
  const response = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === paymentUrl(invoice),
  );
  await action(page, name).click();
  return await response;
}
async function mobile(page: Page, name: string, screenshot: string, amount: string) {
  await page.setViewportSize({ width: 320, height: 860 });
  const value = dialog(page).getByText(amount, { exact: true }).first();
  const bounds = await value.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const rect = range.getBoundingClientRect(),
      container = el.closest('[role="dialog"]')!.getBoundingClientRect();
    return { left: rect.left, right: rect.right, min: container.left, max: container.right };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(bounds.min);
  expect(bounds.right).toBeLessThanOrEqual(bounds.max);
  const control = action(page, name);
  await control.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await expect(control).toBeInViewport({ ratio: 1 });
  expect(
    await control.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    }),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(scan.violations).toEqual([]);
  await page.screenshot({ path: screenshot });
}
async function noticeCount(api: APIRequestContext, invoice: Invoice) {
  const feed = await read<ActivityFeed>(api, '/api/activity?limit=100');
  return feed.items.filter(
    (i) =>
      i.title === 'Your clinic recorded a received payment' &&
      i.href === '/my-care/invoices?invoice=' + invoice.id,
  ).length;
}

test('reception reviews external receipt details in paise and the patient sees one recorded payment', async ({
  page,
  playwright,
  baseURL,
}, info) => {
  const staff = await login(page.request, 'reception'),
    invoice = await newInvoice(page.request, staff);
  const patient = await playwright.request.newContext({ baseURL });
  try {
    await login(patient, 'patient');
    const before = await read<InvoiceDetail>(page.request, detailUrl(invoice));
    await openInvoice(page, invoice);
    await fill(page, '110.09', 'upi', ' Reception receipt ');
    await review(page);
    await expect(dialog(page)).toContainText(invoice.number);
    await expect(dialog(page)).toContainText('Reception receipt');
    await action(page, 'Edit payment').click();
    await fill(page, '101.03', 'bank', ' Bank receipt ');
    await review(page);
    await expect(dialog(page)).toContainText('₹145.78');
    await mobile(page, record, info.outputPath('payment-review-320.png'), '₹101.03');
    const response = await send(page, invoice, record);
    expect(response.status()).toBe(201);
    const command = response.request().postDataJSON() as PaymentRecordingCommand;
    expect(command).toEqual({
      requestId: expect.any(String),
      patientId,
      expectedRevision: before.revision,
      receivedExternallyConfirmed: true,
      amountPaise: 10103,
      method: 'bank',
      reference: 'Bank receipt',
    });
    const { receipt } = (await response.json()) as PaymentRecordingResult;
    expect(receipt).toMatchObject({
      requestId: command.requestId,
      actorId: staff.user!.id,
      patientId,
      invoiceId: invoice.id,
      invoiceNumber: invoice.number,
      expectedRevision: before.revision,
      totalPaise: 24681,
      beforePaidPaise: 0,
      afterPaidPaise: 10103,
      payment: {
        id: expect.any(String),
        invoiceId: invoice.id,
        createdAt: expect.any(String),
        amountPaise: 10103,
        method: 'bank',
        reference: 'Bank receipt',
      },
    });
    await expect(
      dialog(page).getByRole('heading', { name: 'Payment recorded', exact: true }),
    ).toBeVisible();
    await expect(dialog(page)).toContainText('Bank receipt');
    await mobile(
      page,
      'Open current invoice',
      info.outputPath('payment-confirmation-320.png'),
      '₹101.03',
    );
    await action(page, 'Open current invoice').click();
    await expect(dialog(page).locator('.invoice-totals')).toContainText('₹145.78');
    const detail = await read<InvoiceDetail>(patient, detailUrl(invoice));
    expect(detail.invoice).toMatchObject({ status: 'partial', paidPaise: 10103 });
    expect(detail.payments).toHaveLength(1);
    expect(detail.payments[0]).toMatchObject(receipt.payment);
    expect(JSON.stringify(detail)).not.toContain(command.requestId);
    expect(await noticeCount(patient, invoice)).toBe(1);
  } finally {
    await patient.dispose();
  }
});

test('a lost full payment can be recovered after reversal and a later payment without recording it twice', async ({
  page,
  playwright,
  baseURL,
}, info) => {
  test.setTimeout(60000);
  const staff = await login(page.request, 'admin'),
    invoice = await newInvoice(page.request, staff, 12345);
  const patient = await playwright.request.newContext({ baseURL });
  try {
    await login(patient, 'patient');
    // Enter from the billing register so Back actually leaves this React route.
    await page.goto('/clinic');
    await page.getByRole('link', { name: 'Billing', exact: true }).click();
    await page
      .getByRole('row')
      .filter({ hasText: invoice.number })
      .getByRole('button', { name: 'View invoice' })
      .click();
    await fill(page, '123.45', 'upi', '');
    await review(page);
    const commands: PaymentRecordingCommand[] = [];
    let original!: PaymentRecordingResult;
    await page.route('**' + paymentUrl(invoice), async (route) => {
      commands.push(route.request().postDataJSON());
      const n = commands.length;
      if (n === 2)
        return route.fulfill({ status: 403, json: { error: 'Unmarked access response.' } });
      const upstream = await route.fetch();
      expect(upstream.status()).toBe(n === 1 ? 201 : 200);
      const result = (await upstream.json()) as PaymentRecordingResult;
      if (n === 1) {
        original = result;
        return route.abort('connectionreset');
      }
      if (n === 3) result.receipt.actorId = 'other-staff';
      if (n === 4) result.receipt.invoiceId = randomUUID();
      if (n === 5) result.receipt.expectedRevision = 'a'.repeat(64);
      if (n === 6) result.receipt.payment.reference = 'unrelated';
      if (n === 7) result.receipt.afterPaidPaise++;
      if (n === 8) result.receipt.payment.amountPaise--;
      if (n === 9) result.receipt.payment.createdAt = 'invalid';
      return route.fulfill({ response: upstream, json: result });
    });
    await action(page, record).click();
    await expect(action(page, retry)).toBeEnabled();
    await mobile(page, retry, info.outputPath('payment-pending-320.png'), '₹123.45');
    await page.setViewportSize({ width: 1280, height: 860 });
    await action(page, 'Close for now').click();
    await page.goBack();
    await expect(page).toHaveURL('/clinic');
    await page.getByRole('link', { name: 'Billing', exact: true }).click();
    const allPaid = await read<InvoiceDetail>(page.request, detailUrl(invoice));
    expect(allPaid.invoice.status).toBe('paid');
    await button(page, resume).click();
    await expect(action(page, retry)).toBeEnabled();
    await post(
      page.request,
      staff,
      detailUrl(invoice) + '/payments/' + original.receipt.payment.id + '/reverse',
      {
        requestId: randomUUID(),
        expectedRevision: allPaid.revision,
        entryErrorConfirmed: true,
        reason: 'Synthetic entry correction',
      },
      200,
    );
    const later = await post<InvoiceDetail>(
      page.request,
      staff,
      detailUrl(invoice) + '/payments',
      { requestId: randomUUID(), amountPaise: 2111, method: 'cash' },
      201,
    );
    for (let n = 2; n <= 9; n++) {
      await send(page, invoice, retry);
      await expect(action(page, retry)).toBeEnabled();
      await expect(action(page, 'Review current invoice')).toHaveCount(0);
      await expect(action(page, 'Edit payment')).toHaveCount(0);
    }
    const recovered = await send(page, invoice, retry);
    expect(recovered.status()).toBe(200);
    expect(await recovered.json()).toEqual(original);
    expect(commands).toHaveLength(10);
    for (const command of commands) expect(command).toEqual(commands[0]);
    await expect(
      dialog(page).getByRole('heading', { name: 'Payment recorded', exact: true }),
    ).toBeVisible();
    await expect(dialog(page)).toContainText('₹123.45');
    await expect(dialog(page)).not.toContainText('₹21.11');
    await action(page, 'Open current invoice').click();
    await expect(dialog(page).locator('.invoice-totals')).toContainText('₹21.11');
    const live = await read<InvoiceDetail>(patient, detailUrl(invoice));
    expect(live.invoice).toEqual(later.invoice);
    expect(live.payments).toHaveLength(2);
    expect(live.reversals).toHaveLength(1);
    expect(await noticeCount(patient, invoice)).toBe(2);
    const audit = await read<{ items: { action: string }[] }>(
      page.request,
      '/api/search/audit?entityType=invoice&entityId=' + invoice.id,
    );
    expect(audit.items.filter((a) => a.action === 'recorded manual payment')).toHaveLength(2);
  } finally {
    await patient.dispose();
  }
});

test('only the matching stale-balance rejection unlocks the draft for a newly reviewed partial payment', async ({
  page,
}) => {
  const staff = await login(page.request, 'admin'),
    invoice = await newInvoice(page.request, staff, 10000);
  await openInvoice(page, invoice);
  await fill(page, '80', 'card', 'Card record A');
  await review(page);
  const competing = await post<InvoiceDetail>(
    page.request,
    staff,
    detailUrl(invoice) + '/payments',
    { requestId: randomUUID(), amountPaise: 4000, method: 'cash' },
    201,
  );
  const commands: PaymentRecordingCommand[] = [];
  let rejected!: PaymentNotRecorded;
  await page.route('**' + paymentUrl(invoice), async (route) => {
    commands.push(route.request().postDataJSON());
    const n = commands.length;
    if (n === 1) {
      const upstream = await route.fetch();
      expect(upstream.status()).toBe(409);
      rejected = (await upstream.json()) as PaymentNotRecorded;
      expect(rejected).toMatchObject({
        code: 'PAYMENT_NOT_RECORDED',
        actorId: staff.user!.id,
        invoiceId: invoice.id,
        command: commands[0],
      });
      return route.abort('connectionreset');
    }
    if (n === 2) return route.fulfill({ status: 409, json: { error: rejected.message } });
    if (n === 3)
      return route.fulfill({ status: 409, json: { ...rejected, actorId: 'other-collector' } });
    if (n === 4)
      return route.fulfill({ status: 409, json: { ...rejected, invoiceId: 'other-invoice' } });
    if (n === 5)
      return route.fulfill({
        status: 409,
        json: { ...rejected, command: { ...commands[0], reference: 'wrong reference' } },
      });
    if (n === 6)
      return route.fulfill({
        status: 409,
        json: { ...rejected, command: { ...commands[0], expectedRevision: competing.revision } },
      });
    return route.continue();
  });
  await action(page, record).click();
  await expect(action(page, retry)).toBeEnabled();
  for (let n = 2; n <= 6; n++) {
    await send(page, invoice, retry);
    await expect(action(page, retry)).toBeEnabled();
    await expect(action(page, 'Review current invoice')).toHaveCount(0);
  }
  const final = await send(page, invoice, retry);
  expect(final.status()).toBe(409);
  expect(await final.json()).toEqual(rejected);
  await expect(
    dialog(page).getByRole('heading', { name: 'Payment not recorded', exact: true }),
  ).toBeVisible();
  await action(page, 'Review current invoice').click();
  await expect(field(page, 'Amount received (₹)')).toHaveValue(/80(?:\.00)?/);
  await expect(field(page, 'Payment method')).toHaveValue('card');
  await expect(field(page, 'Reference / receipt number')).toHaveValue('Card record A');
  await expect(dialog(page).locator('.invoice-totals')).toContainText('₹60');
  await field(page, 'Amount received (₹)').fill('59.55');
  await review(page);
  await expect(dialog(page)).toContainText('₹0.45');
  const fresh = await send(page, invoice, record);
  expect(fresh.status()).toBe(201);
  expect(commands.at(-1)).toMatchObject({
    expectedRevision: competing.revision,
    amountPaise: 5955,
    reference: 'Card record A',
  });
  expect(commands.at(-1)!.requestId).not.toBe(commands[0].requestId);
  for (const command of commands.slice(0, -1)) expect(command).toEqual(commands[0]);
  const finalInvoice = await read<InvoiceDetail>(page.request, detailUrl(invoice));
  expect(finalInvoice.payments.map((row) => row.amountPaise)).toEqual([4000, 5955]);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
type ResponseObserver = Window & { paymentReplies?: string[]; paymentExpirations?: number };
async function observeLateReplies(page: Page) {
  await page.evaluate(() => {
    const state = window as ResponseObserver;
    state.paymentReplies = [];
    state.paymentExpirations = 0;
    window.addEventListener('derma:session-expired', () => state.paymentExpirations!++);
    const fetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await fetch(...args),
        marker = response.headers.get('X-Test-Payment-Reply');
      if (marker) {
        const json = response.json.bind(response);
        response.json = async () => {
          try {
            return await json();
          } finally {
            state.paymentReplies!.push(marker);
          }
        };
      }
      return response;
    };
  });
}
async function consumed(page: Page, marker: string) {
  await expect
    .poll(() =>
      page.evaluate((m) => (window as ResponseObserver).paymentReplies?.includes(m), marker),
    )
    .toBe(true);
  expect(await page.evaluate(() => (window as ResponseObserver).paymentExpirations)).toBe(0);
}
async function openFromRegister(page: Page, invoice: Invoice) {
  await page.getByRole('link', { name: 'Billing', exact: true }).click();
  await page
    .getByRole('row')
    .filter({ hasText: invoice.number })
    .getByRole('button', { name: 'View invoice' })
    .click();
}

test('late invoice reads and payment writes cannot expire a later route or confirm another invoice', async ({
  page,
}) => {
  const staff = await login(page.request, 'doctor'),
    first = await newInvoice(page.request, staff),
    second = await newInvoice(page.request, staff);
  await page.goto('/clinic');
  await observeLateReplies(page);
  const seenRead = deferred(),
    releaseRead = deferred();
  await page.route(
    '**' + detailUrl(first),
    async (route) => {
      seenRead.resolve();
      await releaseRead.promise;
      return route.fulfill({
        status: 401,
        headers: { 'X-Test-Payment-Reply': 'read' },
        json: { error: 'Obsolete read.' },
      });
    },
    { times: 1 },
  );
  await openFromRegister(page, first);
  await seenRead.promise;
  try {
    await page.goBack();
    await expect(page).toHaveURL('/clinic');
    await openFromRegister(page, second);
    await fill(page, '20.34', 'card', 'Second invoice');
    await review(page);
  } finally {
    releaseRead.resolve();
  }
  await consumed(page, 'read');
  await expect(dialog(page)).toContainText(second.number);
  const seen = deferred(),
    release = deferred();
  let original!: PaymentRecordingResult, command!: PaymentRecordingCommand;
  await page.route(
    '**' + paymentUrl(second),
    async (route) => {
      command = route.request().postDataJSON();
      const upstream = await route.fetch();
      expect(upstream.status()).toBe(201);
      original = await upstream.json();
      seen.resolve();
      await release.promise;
      await route.fulfill({
        status: 401,
        headers: { 'X-Test-Payment-Reply': 'write' },
        json: { error: 'Obsolete write.' },
      });
    },
    { times: 1 },
  );
  await action(page, record).click();
  await seen.promise;
  try {
    await page.goBack();
    await expect(page).toHaveURL('/clinic');
    await page.getByRole('link', { name: 'Billing', exact: true }).click();
    await button(page, resume).click();
    await expect(action(page, retry)).toBeEnabled();
  } finally {
    release.resolve();
  }
  await consumed(page, 'write');
  await expect(action(page, retry)).toBeEnabled();
  const replay = await send(page, second, retry);
  expect(replay.request().postDataJSON()).toEqual(command);
  expect(await replay.json()).toEqual(original);
  await expect(
    dialog(page).getByRole('heading', { name: 'Payment recorded', exact: true }),
  ).toBeVisible();
  expect((await read<InvoiceDetail>(page.request, detailUrl(first))).payments).toEqual([]);
});

test('reload and sign-out remove an unresolved payment and its reference from the tab', async ({
  page,
}) => {
  const staff = await login(page.request, 'admin'),
    invoice = await newInvoice(page.request, staff);
  await page.route('**' + paymentUrl(invoice), (route) =>
    route.fulfill({ status: 500, json: { error: 'Synthetic unavailable response.' } }),
  );
  for (const reset of ['reload', 'logout']) {
    await openInvoice(page, invoice);
    const reference = 'Synthetic private ' + randomUUID();
    await fill(page, '15.25', 'bank', reference);
    await review(page);
    await send(page, invoice, record);
    await expect(action(page, retry)).toBeEnabled();
    await action(page, 'Close for now').click();
    if (await dialog(page).isVisible()) await action(page, 'Close dialog').click();
    await expect(button(page, resume)).toBeEnabled();
    if (reset === 'reload') {
      await page.reload();
    } else {
      await page.getByTitle('Sign out', { exact: true }).click();
      await expect(page).toHaveURL(/\/login|\/$/);
      await page.goto('/login');
      await page.getByLabel('Email address', { exact: true }).fill('reception@derma.demo');
      await page.getByLabel('Password', { exact: true }).fill('DemoClinic2026!');
      await button(page, 'Sign in').click();
      await expect(page).toHaveURL('/clinic');
      await page.getByRole('link', { name: 'Billing', exact: true }).click();
    }
    await expect(button(page, resume)).toHaveCount(0);
    await expect(page.getByText(reference, { exact: true })).toHaveCount(0);
  }
  expect((await read<InvoiceDetail>(page.request, detailUrl(invoice))).payments).toEqual([]);
});
