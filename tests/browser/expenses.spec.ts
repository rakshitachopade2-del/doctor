import { test, expect, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { ClinicExpense } from '../../shared/insights';

const clinicToday = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
function dateAfter(days: number) {
  const date = new Date(`${clinicToday()}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
async function audit(page: Page) {
  await page.waitForLoadState('networkidle');
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
}

async function holdPostResponse(page: Page, url: string, loseResponse = false) {
  let release!: () => void, arrived!: () => void, finished!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const handled = new Promise<void>((resolve) => {
    finished = resolve;
  });
  let body: Record<string, unknown> | undefined;
  let responseData: ClinicExpense | undefined;
  let used = false;
  const handler = async (route: Route) => {
    if (used || route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    used = true;
    try {
      body = route.request().postDataJSON();
      const response = await route.fetch();
      expect(response.ok()).toBeTruthy();
      responseData = await response.json();
      arrived();
      await gate;
      if (loseResponse)
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'Synthetic lost response after the expense was recorded.',
          }),
        });
      else await route.fulfill({ response });
    } finally {
      finished();
    }
  };
  await page.route(url, handler);
  return {
    ready,
    body: () => body,
    result: () => responseData,
    release: async () => {
      release();
      if (used) await handled;
      await page.unroute(url, handler);
    },
  };
}

test('admin records exact expenses, safely retries a lost response, filters the register and preserves a void history', async ({
  page,
}, testInfo) => {
  test.setTimeout(60000);
  const login = await page.request.post('/api/auth/login', {
    data: { email: 'admin@derma.demo', password: 'DemoClinic2026!' },
  });
  expect(login.ok()).toBeTruthy();
  const description = `Synthetic operating expense ${Date.now()}`;
  const reference = `TEST-RECEIPT-${Date.now()}`;
  const date = dateAfter(-3);
  await page.goto('/clinic/expenses');
  await expect(page.getByRole('link', { name: 'Clinic insights', exact: true })).toHaveAttribute(
    'href',
    '/clinic/insights',
  );
  await page.getByRole('button', { name: 'Record expense', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Record a clinic expense', exact: true });
  await expect(dialog.getByLabel('Incurred date', { exact: true })).toHaveAttribute(
    'max',
    clinicToday(),
  );
  await dialog.getByLabel('Incurred date', { exact: true }).fill(date);
  await dialog.getByLabel('Category', { exact: true }).selectOption('equipment');
  await dialog.getByLabel('Description', { exact: true }).fill(description);
  await dialog.getByLabel('Amount (₹)', { exact: true }).fill('1250.005');
  await dialog.getByLabel('Reference / receipt number', { exact: true }).fill(reference);
  await dialog.getByRole('button', { name: 'Save expense record', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('no more than two decimal places');
  await dialog.getByLabel('Amount (₹)', { exact: true }).fill('1250.05');
  await audit(page);
  const creation = await holdPostResponse(page, '**/api/expenses', true);
  try {
    await dialog.getByRole('button', { name: 'Save expense record', exact: true }).click();
    await creation.ready;
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Amount (₹)', { exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Close for now', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await expect(dialog).toBeVisible();
  } finally {
    await creation.release();
  }
  await expect(dialog.getByRole('alert')).toContainText('Synthetic lost response');
  await expect(dialog.getByLabel('Reference / receipt number', { exact: true })).toBeDisabled();
  expect(creation.body()).toMatchObject({
    amountPaise: 125005,
    reference,
    description,
    incurredDate: date,
  });
  expect(creation.body()?.requestId).toMatch(/^[0-9a-f-]{36}$/);
  const list = async () =>
    (await (
      await page.request.get(`/api/expenses?from=${date}&to=${date}`)
    ).json()) as ClinicExpense[];
  expect((await list()).filter((expense) => expense.description === description)).toHaveLength(1);
  await dialog.getByRole('button', { name: 'Close for now', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Resume expense entry', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Record a clinic expense', exact: true });
  await expect(dialog.getByLabel('Reference / receipt number', { exact: true })).toHaveValue(
    reference,
  );
  await expect(dialog.getByLabel('Amount (₹)', { exact: true })).toHaveValue('1250.05');
  const retryRequest = page.waitForRequest(
    (request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/expenses',
  );
  const retryResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/expenses',
  );
  await dialog.getByRole('button', { name: 'Retry recording expense', exact: true }).click();
  expect((await retryRequest).postDataJSON()).toEqual(creation.body());
  expect((await retryResponse).status()).toBe(200);
  dialog = page.getByRole('dialog', { name: 'Expense record', exact: true });
  await expect(dialog.getByText('₹1,250.05', { exact: true })).toBeVisible();
  await expect(dialog.getByText(reference, { exact: true })).toBeVisible();
  expect((await list()).filter((expense) => expense.description === description)).toHaveLength(1);
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByLabel('Search expenses', { exact: true }).fill(description);
  const row = page.getByRole('row').filter({ hasText: description });
  await expect(row).toBeVisible();
  await page.getByLabel('Expense category', { exact: true }).selectOption('rent');
  await expect(row).toHaveCount(0);
  await page.getByLabel('Expense category', { exact: true }).selectOption('equipment');
  await page.getByRole('button', { name: 'Recorded', exact: true }).click();
  await expect(row.getByText('₹1,250.05', { exact: true })).toBeVisible();
  const failedLoad = async (route: Route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Synthetic expense register outage.' }),
    });
  };
  await page.route('**/api/expenses?*', failedLoad);
  await page.getByRole('button', { name: 'Refresh register', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Synthetic expense register outage.');
  await expect(page.locator('.expense-metrics .card > strong')).toHaveText(['—', '—', '—']);
  await expect(page.getByText('Totals unavailable', { exact: true })).toBeVisible();
  await page.unroute('**/api/expenses?*', failedLoad);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(row).toBeVisible();
  await expect(
    page
      .locator('.expense-metrics .card')
      .filter({ hasText: 'Recorded amount' })
      .getByText('₹1,250.05', { exact: true }),
  ).toBeVisible();
  await page.getByLabel('From date', { exact: true }).fill(dateAfter(-366));
  await page.getByLabel('To date', { exact: true }).fill(clinicToday());
  await page.getByRole('button', { name: 'Apply dates', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('366 days or fewer');
  await page.getByLabel('From date', { exact: true }).fill(clinicToday());
  await page.getByRole('button', { name: 'Apply dates', exact: true }).click();
  await expect(row).toHaveCount(0);
  await page.getByLabel('From date', { exact: true }).fill(dateAfter(-10));
  await page.getByRole('button', { name: 'Apply dates', exact: true }).click();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'View expense', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Expense record', exact: true });
  await dialog.getByRole('button', { name: 'Void this expense', exact: true }).click();
  const reason = 'Synthetic duplicate receipt entered in error; the original record must remain.';
  await dialog.getByLabel('Reason for voiding', { exact: true }).fill(reason);
  const expense = (await list()).find((value) => value.description === description)!;
  const voiding = await holdPostResponse(page, `**/api/expenses/${expense.id}/void`);
  try {
    await dialog.getByRole('button', { name: 'Confirm void', exact: true }).click();
    await voiding.ready;
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Keep expense', exact: true })).toBeDisabled();
    await expect(dialog.getByLabel('Reason for voiding', { exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await expect(dialog).toBeVisible();
  } finally {
    await voiding.release();
  }
  await expect(dialog.getByText('Voided', { exact: true })).toBeVisible();
  await expect(dialog.getByText(reason, { exact: true })).toBeVisible();
  await expect(dialog.getByText(reference, { exact: true })).toBeVisible();
  await expect(dialog.getByText('₹1,250.05', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Void this expense', exact: true })).toHaveCount(
    0,
  );
  const original = (await list()).find((value) => value.id === expense.id)!;
  expect(original).toMatchObject({
    amountPaise: 125005,
    reference,
    description,
    incurredDate: date,
    status: 'voided',
  });
  expect(original.void?.reason).toBe(reason);
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(row).toHaveCount(0);
  await page.getByRole('button', { name: 'Voided', exact: true }).click();
  await expect(row.getByText('Voided', { exact: true })).toBeVisible();
  await expect(
    page
      .locator('.expense-metrics .card')
      .filter({ hasText: 'Recorded amount' })
      .getByText('₹0.00', { exact: true }),
  ).toBeVisible();
  await audit(page);
  await page.screenshot({
    path: testInfo.outputPath('expense-register-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 320, height: 740 });
  await audit(page);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  await row.getByRole('button', { name: 'View expense', exact: true }).click();
  await expect(page.getByRole('dialog').getByText(reason, { exact: true })).toBeVisible();
  await audit(page);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('expense-void-mobile.png'), fullPage: true });
});
