import { randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type {
  InvoiceIssuanceCommand,
  InvoiceIssuanceResult,
  InvoiceNotIssued,
} from '../../shared/invoice-issuance';
import type { Invoice, InvoiceDetail, InvoiceItem } from '../../shared/operations';
import type { Session } from '../../shared/types';
import type { ActivityFeed } from '../../shared/activity';

const path = '/api/invoices/issue';
const billing = '/clinic/billing';
const patientId = 'patient-ananya';
const issue = 'Issue invoice';
const retry = 'Retry exact issuance';
const ackLabel = 'I reviewed the patient and charges and confirm this invoice is ready to issue.';
const dialog = (page: Page) => page.getByRole('dialog');
const action = (page: Page, name: string) =>
  dialog(page).getByRole('button', { name, exact: true });
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const field = (page: Page, name: string) => dialog(page).getByLabel(name, { exact: true });
const acknowledgment = (page: Page) =>
  dialog(page).getByRole('checkbox', { name: ackLabel, exact: true });
const newLines = (marker: string): InvoiceItem[] => [
  { description: marker + ' visit', quantity: 2, unitAmountPaise: 12345 },
  { description: marker + ' follow-up', quantity: 1, unitAmountPaise: 203 },
];
async function login(api: APIRequestContext, role: 'admin' | 'patient' | 'doctor' | 'reception') {
  const res = await api.post('/api/auth/login', {
    data: { email: role + '@derma.demo', password: 'DemoClinic2026!' },
  });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as Session;
}
async function read<T>(api: APIRequestContext, url: string) {
  const res = await api.get(url);
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as T;
}
async function post<T>(
  api: APIRequestContext,
  session: Session,
  url: string,
  data: unknown,
  status: number,
) {
  const res = await api.post(url, { headers: { 'X-CSRF-Token': session.csrfToken! }, data });
  expect(res.status(), await res.text()).toBe(status);
  return (await res.json()) as T;
}
async function openBilling(page: Page) {
  await page.getByRole('link', { name: 'Billing', exact: true }).click();
  await expect(page).toHaveURL(billing);
}
async function fillLines(page: Page, items: InvoiceItem[]) {
  for (const [index, item] of items.entries()) {
    if (index) await action(page, 'Add line item').click();
    await field(page, 'Service or item')
      .nth(index)
      .fill(' ' + item.description + ' ');
    await field(page, 'Quantity').nth(index).fill(String(item.quantity));
    await field(page, 'Unit price (₹)')
      .nth(index)
      .fill((item.unitAmountPaise / 100).toFixed(2));
  }
}
async function startStandalone(page: Page, items: InvoiceItem[]) {
  await button(page, 'Create invoice').click();
  await field(page, 'Patient').selectOption(patientId);
  await fillLines(page, items);
}
async function review(page: Page) {
  await action(page, 'Review invoice').click();
  await expect(acknowledgment(page)).not.toBeChecked();
  await expect(action(page, issue)).toBeDisabled();
  await acknowledgment(page).check();
}
async function send(page: Page, name: string) {
  const ready = page.waitForResponse(
    (r) => new URL(r.url()).pathname === path && r.request().method() === 'POST',
  );
  await action(page, name).click();
  return await ready;
}
async function mobile(page: Page, name: string, screenshot: string) {
  await page.setViewportSize({ width: 320, height: 860 });
  // Every line has a visible unit price and extended amount on a narrow screen.
  // Checking the text bounds catches a table scroller that hides the monetary columns.
  for (const amount of ['₹123.45', '₹246.90']) {
    const text = dialog(page).getByText(amount, { exact: true }).filter({ visible: true }).first();
    const bounds = await text.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const rect = range.getBoundingClientRect();
      const frame = element.closest('[role="dialog"]')!.getBoundingClientRect();
      return { left: rect.left, right: rect.right, min: frame.left, max: frame.right };
    });
    expect(bounds.left).toBeGreaterThanOrEqual(bounds.min);
    expect(bounds.right).toBeLessThanOrEqual(bounds.max);
  }
  const control = action(page, name);
  await control.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await expect(control).toBeInViewport({ ratio: 1 });
  expect(
    await control.evaluate((el) => {
      const { x, y, width, height } = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(x + width / 2, y + height / 2));
    }),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const check = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(check.violations).toEqual([]);
  await page.screenshot({ path: screenshot });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

test('staff review ordered charges in paise and explicitly open the current invoice; the patient receives one issued bill', async ({
  page,
  playwright,
  baseURL,
}, info) => {
  const session = await login(page.request, 'admin');
  const own = await playwright.request.newContext({ baseURL });
  try {
    await login(own, 'patient');
    const lines = newLines('Review ' + randomUUID());
    await page.goto(billing);
    await startStandalone(page, lines);
    await review(page);
    await expect(dialog(page)).toContainText('Ananya');
    await expect(dialog(page)).toContainText('₹248.93');
    await expect(dialog(page)).toContainText(lines[1].description);
    await action(page, 'Edit invoice').click();
    lines[1].quantity = 2;
    await field(page, 'Quantity').nth(1).fill('2');
    await review(page);
    await expect(dialog(page)).toContainText('₹250.96');
    await mobile(page, issue, info.outputPath('invoice-review-320.png'));
    const issued = await send(page, issue);
    expect(issued.status()).toBe(201);
    const command = issued.request().postDataJSON() as InvoiceIssuanceCommand;
    expect(command).toEqual({
      patientId,
      requestId: expect.any(String),
      reviewedConfirmed: true,
      items: lines,
    });
    const { receipt } = (await issued.json()) as InvoiceIssuanceResult;
    expect(receipt).toMatchObject({
      actorId: session.user!.id,
      patientId,
      requestId: command.requestId,
      invoice: { items: lines, totalPaise: 25096, paidPaise: 0, status: 'unpaid' },
    });
    await expect(
      dialog(page).getByRole('heading', { name: 'Invoice issued', exact: true }),
    ).toBeVisible();
    await expect(dialog(page)).toContainText(receipt.invoice.number);
    await expect(dialog(page)).toContainText('₹250.96');
    await mobile(page, 'Open current invoice', info.outputPath('invoice-confirmed-320.png'));
    await action(page, 'Open current invoice').click();
    await expect(
      dialog(page).getByRole('heading', { name: 'Invoice ' + receipt.invoice.number, exact: true }),
    ).toBeVisible();
    const detail = await read<InvoiceDetail>(own, '/api/invoices/' + receipt.invoice.id);
    expect(detail.invoice).toEqual(receipt.invoice);
    expect(detail.payments).toEqual([]);
    const feed = await read<ActivityFeed>(own, '/api/activity');
    expect(
      feed.items.filter(
        (item) =>
          item.href === '/my-care/invoices?invoice=' + receipt.invoice.id &&
          item.title === 'Your clinic created an invoice',
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(detail)).not.toContain(command.requestId);
  } finally {
    await own.dispose();
  }
});

test('after a lost creation, uncertain replies cannot release the request and recovery shows the issued charges after correction and payment', async ({
  page,
  request,
}, info) => {
  test.setTimeout(60000);
  const session = await login(page.request, 'admin');
  const lines = newLines('Recover ' + randomUUID());
  await page.goto('/clinic');
  await openBilling(page);
  await startStandalone(page, lines);
  await review(page);
  const commands: InvoiceIssuanceCommand[] = [];
  let original!: InvoiceIssuanceResult;
  await page.route('**' + path, async (route) => {
    commands.push(route.request().postDataJSON());
    const attempt = commands.length;
    if (attempt === 2)
      return route.fulfill({ status: 403, json: { error: 'Synthetic access reply.' } });
    const upstream = await route.fetch();
    expect(upstream.status()).toBe(attempt === 1 ? 201 : 200);
    const result = (await upstream.json()) as InvoiceIssuanceResult;
    if (attempt === 1) {
      original = result;
      return route.abort('connectionreset');
    }
    if (attempt === 3) result.receipt.actorId = 'different-account';
    if (attempt === 4) result.receipt.invoice.patientId = 'different-patient';
    if (attempt === 5) result.receipt.invoice.items.reverse();
    if (attempt === 6) result.receipt.invoice.totalPaise++;
    if (attempt === 7) result.receipt.invoice.createdAt = 'not-a-date';
    if (attempt === 8) result.receipt.requestId = randomUUID();
    await route.fulfill({ response: upstream, json: result });
  });
  await action(page, issue).click();
  await expect(action(page, retry)).toBeEnabled();
  await mobile(page, retry, info.outputPath('invoice-pending-320.png'));
  await page.setViewportSize({ width: 1280, height: 720 });
  await action(page, 'Close for now').click();
  await page.goBack();
  await expect(page).toHaveURL('/clinic');
  await openBilling(page);
  await button(page, 'Resume invoice entry').click();
  const invoice = original.receipt.invoice;
  const url = '/api/invoices/' + invoice.id;
  const before = await read<InvoiceDetail>(page.request, url);
  const correctedItems = [
    { description: 'Current charge ' + randomUUID(), quantity: 1, unitAmountPaise: 18000 },
  ];
  await post(
    page.request,
    session,
    url + '/corrections',
    {
      items: correctedItems,
      reason: 'Synthetic agreed correction',
      expectedRevision: before.revision,
      requestId: randomUUID(),
    },
    200,
  );
  await post(
    page.request,
    session,
    url + '/payments',
    { amountPaise: 4000, method: 'cash', requestId: randomUUID() },
    201,
  );
  for (let attempt = 2; attempt <= 8; attempt++) {
    await send(page, retry);
    await expect(action(page, retry)).toBeEnabled();
    await expect(action(page, 'Review draft')).toHaveCount(0);
    await expect(action(page, 'Edit invoice')).toHaveCount(0);
    await expect(dialog(page).getByRole('textbox')).toHaveCount(0);
  }
  const recovered = await send(page, retry);
  expect(await recovered.json()).toEqual(original);
  expect(commands).toHaveLength(9);
  expect(commands.every((cmd) => JSON.stringify(cmd) === JSON.stringify(commands[0]))).toBe(true);
  await expect(dialog(page)).toContainText('₹248.93');
  await expect(dialog(page)).toContainText(lines[0].description);
  await expect(dialog(page)).not.toContainText(correctedItems[0].description);
  await action(page, 'Open current invoice').click();
  await expect(dialog(page).locator('.invoice-totals')).toContainText('₹140');
  const live = await read<InvoiceDetail>(page.request, url);
  expect(live.invoice).toMatchObject({
    items: correctedItems,
    totalPaise: 18000,
    paidPaise: 4000,
    status: 'partial',
  });
  const audits = await read<{ items: { action: string }[] }>(
    page.request,
    '/api/search/audit?entityType=invoice&entityId=' + invoice.id,
  );
  expect(audits.items.filter((row) => row.action === 'created invoice')).toHaveLength(1);
  await login(request, 'patient');
  const feed = await read<ActivityFeed>(request, '/api/activity');
  expect(
    feed.items.filter(
      (item) =>
        item.href === '/my-care/invoices?invoice=' + invoice.id &&
        item.title === 'Your clinic created an invoice',
    ),
  ).toHaveLength(1);

  const records = await read<Invoice[]>(page.request, '/api/invoices');
  expect(records.filter((row) => row.id === invoice.id)).toHaveLength(1);
  expect(
    records.filter((row) => row.items.some((item) => item.description === lines[0].description)),
  ).toHaveLength(0);
});

test('a competing procedure invoice releases a deep-linked draft only after the matching durable rejection and fresh review', async ({
  page,
  playwright,
  baseURL,
}) => {
  const issuer = await login(page.request, 'reception');
  const other = await playwright.request.newContext({ baseURL });
  try {
    const doctor = await login(other, 'doctor');
    const title = 'Procedure ' + randomUUID();
    const procedure = await post<{ id: string }>(
      other,
      doctor,
      '/api/procedures',
      {
        patientId,
        title,
        indication: 'Synthetic',
        benefits: 'Synthetic',
        risks: 'Synthetic',
        alternatives: 'Synthetic',
        aftercare: 'Synthetic',
        estimatedCost: 'Estimate only',
      },
      201,
    );
    await page.goto(billing + '?procedure=' + procedure.id);
    await expect(field(page, 'Link a procedure (optional)')).toHaveValue(procedure.id);
    const originalLines = newLines('Reviewed ' + randomUUID());
    await fillLines(page, originalLines);
    await review(page);
    await expect(dialog(page)).toContainText(title);
    const linked = await post<Invoice>(
      other,
      doctor,
      '/api/invoices',
      {
        requestId: randomUUID(),
        patientId,
        procedureId: procedure.id,
        items: [{ description: 'Separate entry', quantity: 1, unitAmountPaise: 6000 }],
      },
      201,
    );
    const commands: InvoiceIssuanceCommand[] = [];
    let rejected!: InvoiceNotIssued;
    await page.route('**' + path, async (route) => {
      const command = route.request().postDataJSON() as InvoiceIssuanceCommand;
      commands.push(command);
      if (commands.length === 1) {
        const upstream = await route.fetch();
        expect(upstream.status()).toBe(409);
        rejected = (await upstream.json()) as InvoiceNotIssued;
        expect(rejected).toMatchObject({
          code: 'INVOICE_NOT_ISSUED',
          actorId: issuer.user!.id,
          command,
        });
        return route.abort('connectionreset');
      }
      if (commands.length === 2)
        return route.fulfill({ status: 409, json: { error: rejected.message } });
      if (commands.length === 3)
        return route.fulfill({
          status: 409,
          json: { ...rejected, command: { ...command, procedureId: 'another-procedure' } },
        });
      if (commands.length === 4)
        return route.fulfill({ status: 409, json: { ...rejected, actorId: 'another-issuer' } });
      if (commands.length === 5)
        return route.fulfill({
          status: 409,
          json: { ...rejected, command: { ...command, items: [...command.items].reverse() } },
        });
      return route.continue();
    });
    await action(page, issue).click();
    await expect(action(page, retry)).toBeEnabled();
    for (let attempt = 2; attempt <= 5; attempt++) {
      await send(page, retry);
      await expect(action(page, retry)).toBeEnabled();
      await expect(action(page, 'Review draft')).toHaveCount(0);
    }
    expect(await (await send(page, retry)).json()).toEqual(rejected);
    await expect(dialog(page)).toContainText('Invoice was not issued');
    await action(page, 'Review draft').click();
    await expect(field(page, 'Patient')).toHaveValue(patientId);
    await expect(field(page, 'Link a procedure (optional)')).toBeEnabled();
    await expect(field(page, 'Link a procedure (optional)')).toHaveValue('');
    await expect(field(page, 'Service or item').nth(0)).toHaveValue(originalLines[0].description);
    await expect(field(page, 'Service or item').nth(1)).toHaveValue(originalLines[1].description);
    await review(page);
    const response = await send(page, issue);
    expect(response.status()).toBe(201);
    const result = (await response.json()) as InvoiceIssuanceResult;
    expect(result.receipt.invoice.items).toEqual(originalLines);
    expect(result.receipt.invoice.procedureId).toBeUndefined();
    expect(commands.at(-1)!.requestId).not.toBe(commands[0].requestId);
    expect(
      commands.slice(0, -1).every((cmd) => JSON.stringify(cmd) === JSON.stringify(commands[0])),
    ).toBe(true);
    const invoices = await read<Invoice[]>(other, '/api/invoices');
    expect(invoices.filter((i) => i.procedureId === procedure.id)).toEqual([linked]);
    expect(
      invoices.filter((i) =>
        i.items.some((item) => item.description === originalLines[0].description),
      ),
    ).toEqual([result.receipt.invoice]);
  } finally {
    await other.dispose();
  }
});

type LateEvents = Window & { invoiceReplies?: string[]; invoiceExpirations?: number };
async function observeReplies(page: Page) {
  await page.evaluate(() => {
    const state = window as LateEvents;
    state.invoiceReplies = [];
    state.invoiceExpirations = 0;
    window.addEventListener('derma:session-expired', () => state.invoiceExpirations!++);
    const original = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await original(...args);
      const marker = response.headers.get('X-Test-Invoice-Reply');
      if (marker) {
        const decode = response.json.bind(response);
        response.json = async () => {
          try {
            return await decode();
          } finally {
            state.invoiceReplies!.push(marker);
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
      page.evaluate((key) => (window as LateEvents).invoiceReplies?.includes(key), marker),
    )
    .toBe(true);
  expect(await page.evaluate(() => (window as LateEvents).invoiceExpirations)).toBe(0);
}
test('late patient lookup and issuance replies cannot replace a later billing screen or expire its session', async ({
  page,
}) => {
  await login(page.request, 'doctor');
  await page.goto('/clinic');
  await openBilling(page);
  await observeReplies(page);
  const readSeen = deferred(),
    readRelease = deferred();
  await page.route(
    '**/api/patients',
    async (route) => {
      readSeen.resolve();
      await readRelease.promise;
      return route.fulfill({
        status: 401,
        headers: { 'X-Test-Invoice-Reply': 'patients' },
        json: { error: 'Obsolete patient lookup.' },
      });
    },
    { times: 1 },
  );
  await button(page, 'Create invoice').click();
  await readSeen.promise;
  try {
    await page.goBack();
    await expect(page).toHaveURL('/clinic');
    await openBilling(page);
    await startStandalone(page, newLines('Guard ' + randomUUID()));
  } finally {
    readRelease.resolve();
  }
  await consumed(page, 'patients');
  await review(page);
  const seen = deferred(),
    release = deferred();
  let original!: InvoiceIssuanceResult;
  let command!: InvoiceIssuanceCommand;
  await page.route(
    '**' + path,
    async (route) => {
      command = route.request().postDataJSON();
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      original = (await response.json()) as InvoiceIssuanceResult;
      seen.resolve();
      await release.promise;
      await route.fulfill({
        status: 401,
        headers: { 'X-Test-Invoice-Reply': 'issue' },
        json: { error: 'Obsolete issuance response.' },
      });
    },
    { times: 1 },
  );
  await action(page, issue).click();
  await seen.promise;
  try {
    await page.goBack();
    await expect(page).toHaveURL('/clinic');
    await openBilling(page);
    await button(page, 'Resume invoice entry').click();
    await expect(action(page, retry)).toBeEnabled();
  } finally {
    release.resolve();
  }
  await consumed(page, 'issue');
  await expect(action(page, retry)).toBeEnabled();
  const response = await send(page, retry);
  expect(response.request().postDataJSON()).toEqual(command);
  expect(await response.json()).toEqual(original);
  await expect(
    dialog(page).getByRole('heading', { name: 'Invoice issued', exact: true }),
  ).toBeVisible();
});

test('reloading or signing out clears the retained charge details in the tab', async ({ page }) => {
  await login(page.request, 'admin');
  await page.goto(billing);
  await page.route('**' + path, (route) =>
    route.fulfill({ status: 500, json: { error: 'Synthetic unavailable response.' } }),
  );
  for (const reset of ['reload', 'logout']) {
    const lines = newLines('Private ' + reset + ' ' + randomUUID());
    await startStandalone(page, lines);
    await review(page);
    await send(page, issue);
    await expect(action(page, retry)).toBeEnabled();
    await action(page, 'Close for now').click();
    await expect(button(page, 'Resume invoice entry')).toBeEnabled();
    if (reset === 'reload') await page.reload();
    else {
      await page.getByTitle('Sign out', { exact: true }).click();
      await expect(page).toHaveURL(/\/login|\/$/);
      await expect(button(page, 'Resume invoice entry')).toHaveCount(0);
      await page.goto('/login');
      await page.getByLabel('Email address', { exact: true }).fill('reception@derma.demo');
      await page.getByLabel('Password', { exact: true }).fill('DemoClinic2026!');
      await button(page, 'Sign in').click();
      await expect(page).toHaveURL('/clinic');
      await openBilling(page);
    }
    await expect(button(page, 'Create invoice')).toBeEnabled();
    await expect(button(page, 'Resume invoice entry')).toHaveCount(0);
    await expect(page.getByText(lines[0].description, { exact: true })).toHaveCount(0);
  }
});
