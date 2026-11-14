import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ClinicInsights } from '../../shared/insights';

const clinicToday = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
const shift = (date: string, days: number) =>
  new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const currency = (paise: number) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: paise % 100 ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(paise / 100);

test('administrator reports distinct financial date scopes, appointment states, and a checked aggregate export', async ({
  page,
}, testInfo) => {
  const today = clinicToday();
  const earlier = shift(today, -41);
  const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  await page.goto('/login');
  await page.getByLabel('Email address', { exact: true }).fill('admin@derma.demo');
  await page.getByLabel('Password', { exact: true }).fill('DemoClinic2026!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/clinic$/);
  const session = await (await page.request.get('/api/session')).json();
  const headers = { 'X-CSRF-Token': session.csrfToken };
  async function reportOn(date: string) {
    const response = await page.request.get(`/api/insights?from=${date}&to=${date}`);
    expect(response.ok()).toBeTruthy();
    return (await response.json()) as ClinicInsights;
  }
  const baseline = await reportOn(today);
  const earlierBaseline = await reportOn(earlier);
  const invoice = await page.request.post('/api/invoices', {
    headers,
    data: {
      requestId: randomUUID(),
      patientId: 'patient-ananya',
      items: [
        { description: `Private billing fixture ${suffix}`, quantity: 2, unitAmountPaise: 123455 },
      ],
    },
  });
  expect(invoice.status()).toBe(201);
  const issued = await invoice.json();
  const payment = await page.request.post(`/api/invoices/${issued.id}/payments`, {
    headers,
    data: {
      requestId: randomUUID(),
      amountPaise: 75025,
      method: 'upi',
      reference: `Private reference ${suffix}`,
    },
  });
  expect(payment.status()).toBe(201);
  async function expense(incurredDate: string, amountPaise: number) {
    const response = await page.request.post('/api/expenses', {
      headers,
      data: {
        requestId: randomUUID(),
        incurredDate,
        category: 'supplies',
        description: `Private expense fixture ${suffix}`,
        amountPaise,
        reference: '',
      },
    });
    expect(response.status()).toBe(201);
    return response.json();
  }
  await expense(today, 12345);
  await expense(earlier, 54321);
  const voided = await expense(today, 9999);
  expect(
    (
      await page.request.post(`/api/expenses/${voided.id}/void`, {
        headers,
        data: { reason: 'Synthetic duplicate excluded from reporting' },
      })
    ).ok(),
  ).toBeTruthy();

  await page.goto(`/clinic/insights?from=${today}&to=${today}`);
  await expect(page.getByRole('heading', { name: 'Clinic insights', exact: true })).toBeVisible();
  const metric = (name: string) =>
    page.getByRole('group', { name, exact: true }).locator('.insights-metric-value');
  await expect(metric('Invoices issued')).toHaveText(
    currency(baseline.totals.invoicedPaise + 246910),
  );
  await expect(metric('Recorded collections')).toHaveText(
    currency(baseline.totals.collectionsPaise + 75025),
  );
  await expect(metric('Recorded expenses')).toHaveText(
    currency(baseline.totals.expensesPaise + 12345),
  );
  await expect(metric('Outstanding on period invoices')).toHaveText(
    currency(baseline.totals.issuedInvoiceOutstandingPaise + 171885),
  );
  await expect(page.getByText(/actual receipt dates are not stored separately/)).toBeVisible();
  await expect(page.getByRole('group', { name: 'Recorded expenses', exact: true })).toContainText(
    'currently voided entries excluded',
  );
  await expect(
    page.getByRole('img', { name: 'Recorded collections by day', exact: true }),
  ).toBeVisible();
  const todayReport = await reportOn(today);
  expect(todayReport.totals.expenseCount).toBe(baseline.totals.expenseCount + 1);
  expect(todayReport.daily).toHaveLength(1);
  const daily = page.getByRole('table', {
    name: 'Daily metrics · Indian rupees for financial amounts',
    exact: true,
  });
  await expect(daily.locator('tbody tr')).toHaveCount(1);
  const columns = await daily.locator('thead th').allTextContents();
  for (const [label, paise] of [
    ['Invoiced', todayReport.totals.invoicedPaise],
    ['Collections', todayReport.totals.collectionsPaise],
    ['Refunds', todayReport.totals.refundsPaise],
    ['Net collections', todayReport.totals.netCollectionsPaise],
    ['Expenses', todayReport.totals.expensesPaise],
  ] as const) {
    const index = columns.indexOf(label);
    expect(index).toBeGreaterThan(0);
    await expect(daily.locator('tbody tr td').nth(index - 1)).toHaveText(currency(paise));
  }

  await page.getByLabel('Report start date', { exact: true }).fill(earlier);
  await page.getByLabel('Report end date', { exact: true }).fill(earlier);
  await page.getByRole('button', { name: 'Apply dates', exact: true }).click();
  await expect(metric('Recorded expenses')).toHaveText(
    currency(earlierBaseline.totals.expensesPaise + 54321),
  );
  await expect(metric('Invoices issued')).toHaveText(
    currency(earlierBaseline.totals.invoicedPaise),
  );
  await expect(metric('Recorded collections')).toHaveText(
    currency(earlierBaseline.totals.collectionsPaise),
  );
  await page.getByLabel('Chart measure', { exact: true }).selectOption('expensesPaise');
  await expect(
    page.getByRole('img', { name: 'Recorded expenses by day', exact: true }),
  ).toBeVisible();

  const doctors = await (await page.request.get('/api/doctors')).json();
  let visit: { date: string; time: string } | undefined;
  for (let offset = 70; offset < 80; offset++) {
    const date = shift(today, offset);
    const slots = (await (
      await page.request.get(`/api/slots?doctorId=${doctors[0].id}&date=${date}&mode=in-person`)
    ).json()) as string[];
    if (slots.length) {
      visit = { date, time: slots[0] };
      break;
    }
  }
  expect(visit).toBeDefined();
  const beforeAppointment = await reportOn(visit!.date);
  const appointment = await page.request.post('/api/appointments', {
    headers,
    data: {
      patientId: 'patient-ananya',
      doctorId: doctors[0].id,
      date: visit!.date,
      time: visit!.time,
      mode: 'in-person',
      reason: `Synthetic report appointment ${suffix}`,
    },
  });
  expect(appointment.status()).toBe(201);
  const booked = await appointment.json();
  expect(
    (
      await page.request.patch(`/api/appointments/${booked.id}`, {
        headers,
        data: { status: 'cancelled' },
      })
    ).ok(),
  ).toBeTruthy();
  await page.getByLabel('Report start date', { exact: true }).fill(visit!.date);
  await page.getByLabel('Report end date', { exact: true }).fill(visit!.date);
  await page.getByRole('button', { name: 'Apply dates', exact: true }).click();
  const cancelledCount =
    beforeAppointment.appointmentsByStatus.find((row) => row.status === 'cancelled')!.count + 1;
  const statuses = page
    .locator('.insights-breakdown')
    .filter({ has: page.getByRole('heading', { name: 'Appointments by status', exact: true }) });
  await expect(
    statuses
      .locator('dl > div')
      .filter({ has: page.getByText('Cancelled', { exact: true }) })
      .locator('dd'),
  ).toHaveText(String(cancelledCount));
  await expect(daily.locator('tbody tr td').nth(0)).toHaveText(
    String(beforeAppointment.totals.appointmentCount + 1),
  );
  await page.getByLabel('Chart measure', { exact: true }).selectOption('appointmentCount');
  await expect(page.getByRole('img', { name: 'Appointments by day', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Last 7 days', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Last 7 days', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(daily.locator('tbody tr')).toHaveCount(7);
  await page.getByLabel('Report start date', { exact: true }).fill(shift(today, -366));
  await page.getByRole('button', { name: 'Apply dates', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('366 days or fewer');
  await expect(daily.locator('tbody tr')).toHaveCount(7);
  await page.getByRole('button', { name: 'Last 7 days', exact: true }).click();
  await expect(page.getByLabel('Report start date', { exact: true })).toHaveValue(shift(today, -6));
  await expect(page.getByRole('alert')).toHaveCount(0);

  let downloads = 0;
  page.on('download', () => {
    downloads++;
  });
  await page.route(
    '**/api/insights/export?*',
    (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'CSV export temporarily unavailable.' }),
      }),
    { times: 1 },
  );
  await page.getByRole('button', { name: 'Export aggregate CSV', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('CSV export temporarily unavailable.');
  expect(downloads).toBe(0);
  await expect(metric('Recorded collections')).toBeVisible();

  // A slow export belongs to the range that started it. Changing ranges must
  // release the new range's export control before the old response arrives.
  for (const delayed of [
    {
      nextPreset: 'Last 30 days',
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Stale range export failure.' }),
    },
    {
      nextPreset: 'Last 7 days',
      status: 200,
      contentType: 'text/csv',
      body: 'stale,range,export\r\n',
    },
  ]) {
    let release!: () => void;
    let received!: () => void;
    let handled!: () => void;
    const responseGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requestReceived = new Promise<void>((resolve) => {
      received = resolve;
    });
    const responseHandled = new Promise<void>((resolve) => {
      handled = resolve;
    });
    await page.route(
      '**/api/insights/export?*',
      async (route) => {
        received();
        await responseGate;
        try {
          await route.fulfill({
            status: delayed.status,
            contentType: delayed.contentType,
            body: delayed.body,
          });
        } catch {
          // The browser may have already cancelled this intercepted request.
        } finally {
          handled();
        }
      },
      { times: 1 },
    );
    try {
      await page.getByRole('button', { name: 'Export aggregate CSV', exact: true }).click();
      await requestReceived;
      await expect(
        page.getByRole('button', { name: 'Preparing CSV…', exact: true }),
      ).toBeDisabled();
      await page.getByRole('button', { name: delayed.nextPreset, exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Export aggregate CSV', exact: true }),
      ).toBeEnabled();
    } finally {
      release();
    }
    await responseHandled;
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(downloads).toBe(0);
  }

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export aggregate CSV', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`clinic-insights-${shift(today, -6)}-to-${today}.csv`);
  const path = await download.path();
  expect(path).toBeTruthy();
  const csv = await readFile(path!, 'utf8');
  expect(csv).toContain('"section","date","metric","dimension","count","amountPaise"');
  expect(csv).toContain('Asia/Kolkata');
  expect(csv).not.toContain('Ananya');
  expect(csv).not.toContain(suffix);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  await page.waitForLoadState('networkidle');
  const audit = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(audit.violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('clinic-insights-320px.png'), fullPage: true });
});
