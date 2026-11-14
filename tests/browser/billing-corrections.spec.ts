import { test, expect, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import type { Invoice, InvoiceDetail, InvoiceItem } from '../../shared/operations';
import type { ClinicInsights } from '../../shared/insights';
import type { CareSummary } from '../../shared/care-summary';

const clinicDate = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
const amount = (paise: number) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: paise % 100 ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(paise / 100);

async function audit(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  const notices = page.getByRole('button', { name: 'Dismiss notification', exact: true });
  while (await notices.count()) await notices.first().click();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
}

async function loseCorrectionResponse(page: Page, path: string) {
  let release!: () => void, arrived!: () => void, finished!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  let body: Record<string, unknown> | undefined;
  let used = false;
  const handler = async (route: Route) => {
    if (used || route.request().method() !== 'POST') return route.continue();
    used = true;
    try {
      body = route.request().postDataJSON();
      const response = await route.fetch();
      expect(response.status(), await response.text()).toBe(200);
      arrived();
      await gate;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Synthetic lost response after charge correction.' }),
      });
    } finally {
      finished();
    }
  };
  await page.route(`**${path}`, handler);
  return {
    ready,
    body: () => body,
    release: async () => {
      release();
      if (used) await done;
      await page.unroute(`**${path}`, handler);
    },
  };
}

test('administrators correct charges and reverse erroneous entries once while patients retain shared originals and accurate current balances', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(120000);
  const login = await page.request.post('/api/auth/login', {
    data: { email: 'admin@derma.demo', password: 'DemoClinic2026!' },
  });
  expect(login.ok()).toBeTruthy();
  const headers = { 'X-CSRF-Token': (await login.json()).csrfToken };
  const suffix = randomUUID().slice(0, 8);
  const date = clinicDate();
  const reportPath = `/api/insights?from=${date}&to=${date}`;
  async function report(): Promise<ClinicInsights> {
    const response = await page.request.get(reportPath);
    expect(response.ok()).toBeTruthy();
    return response.json();
  }
  const baseline = await report();
  const procedureResponse = await page.request.post('/api/procedures', {
    headers,
    data: {
      patientId: 'patient-ananya',
      title: `Correction fixture procedure ${suffix}`,
      indication: 'Synthetic indication',
      benefits: 'Synthetic benefits',
      risks: 'Synthetic risks',
      alternatives: 'Synthetic alternatives',
      aftercare: 'Synthetic aftercare',
      estimatedCost: 'Estimate only; charges entered separately.',
    },
  });
  expect(procedureResponse.status()).toBe(201);
  const procedure = await procedureResponse.json();
  const originalDescription = `Original issued service ${suffix}`;
  const originalItems: InvoiceItem[] = [
    { description: originalDescription, quantity: 1, unitAmountPaise: 12005 },
  ];
  const createdResponse = await page.request.post('/api/invoices', {
    headers,
    data: {
      patientId: 'patient-ananya',
      procedureId: procedure.id,
      requestId: randomUUID(),
      items: originalItems,
    },
  });
  expect(createdResponse.status()).toBe(201);
  const original = (await createdResponse.json()) as Invoice;
  const detailPath = `/api/invoices/${original.id}`;
  const correctionPath = `${detailPath}/corrections`;
  async function detail(): Promise<InvoiceDetail> {
    const response = await page.request.get(detailPath);
    expect(response.ok()).toBeTruthy();
    return response.json();
  }
  const paymentResponse = await page.request.post(`${detailPath}/payments`, {
    headers,
    data: {
      amountPaise: 3005,
      method: 'cash',
      reference: `ERRONEOUS-RECORD-${suffix}`,
      requestId: randomUUID(),
    },
  });
  expect(paymentResponse.status()).toBe(201);
  const paid = (await paymentResponse.json()) as InvoiceDetail;
  const payment = paid.payments[0];
  const reversalPath = `${detailPath}/payments/${payment.id}/reverse`;
  const initialReport = await report();
  expect(initialReport.totals.invoicedPaise).toBe(baseline.totals.invoicedPaise + 12005);
  expect(initialReport.totals.collectionsPaise).toBe(baseline.totals.collectionsPaise + 3005);
  const originalSummary = (await (
    await page.request.get('/api/patients/patient-ananya/care-summary')
  ).json()) as CareSummary;

  await page.goto(`/clinic/billing?invoice=${original.id}`);
  let dialog = page.getByRole('dialog', { name: `Invoice ${original.number}`, exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Correct charges', exact: true }).click();
  let form = dialog.locator('.billing-correction-form');
  const correctionReason = `Shared charge correction reason ${suffix}`;
  await form.getByLabel('Service or item', { exact: true }).fill(`Corrected service ${suffix}`);
  await form.getByLabel('Unit price (₹)', { exact: true }).fill('90.05');
  await form.getByLabel('Reason shared with patient', { exact: true }).fill(correctionReason);
  const lost = await loseCorrectionResponse(page, correctionPath);
  try {
    await form.getByRole('button', { name: 'Save charge correction', exact: true }).click();
    await lost.ready;
    await expect(form.getByLabel('Unit price (₹)', { exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await expect(dialog).toBeVisible();
  } finally {
    await lost.release();
  }
  await expect(form.getByRole('alert')).toContainText('Synthetic lost response');
  await expect(form.getByLabel('Unit price (₹)', { exact: true })).toHaveValue('90.05');
  await expect(form.getByLabel('Unit price (₹)', { exact: true })).toBeDisabled();
  await expect(form.getByLabel('Reason shared with patient', { exact: true })).toBeDisabled();
  expect((await detail()).corrections).toHaveLength(1);
  expect((await detail()).invoice.totalPaise).toBe(9005);
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Resume pending update', exact: true }).click();
  await expect(form.getByLabel('Unit price (₹)', { exact: true })).toHaveValue('90.05');
  await expect(form.getByLabel('Unit price (₹)', { exact: true })).toBeDisabled();
  const retryRequest = page.waitForRequest(
    (request) => request.method() === 'POST' && new URL(request.url()).pathname === correctionPath,
  );
  const retryResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === correctionPath,
  );
  await form.getByRole('button', { name: 'Retry same request', exact: true }).click();
  expect((await retryRequest).postDataJSON()).toEqual(lost.body());
  expect((await retryResponse).status()).toBe(200);
  await expect(form).toHaveCount(0);
  const corrected = await detail();
  expect(corrected.corrections).toHaveLength(1);
  expect(corrected.issuedCharges).toEqual({ items: originalItems, totalPaise: 12005 });
  expect(corrected.invoice).toMatchObject({
    id: original.id,
    number: original.number,
    createdAt: original.createdAt,
    patientId: original.patientId,
    patientName: original.patientName,
    procedureId: procedure.id,
    totalPaise: 9005,
    paidPaise: 3005,
    status: 'partial',
  });
  expect((await report()).totals.invoicedPaise).toBe(baseline.totals.invoicedPaise + 9005);
  expect(
    (
      await page.request.get(
        `/api/patients/patient-ananya/care-summary/download?revision=${originalSummary.revision}`,
      )
    ).status(),
  ).toBe(409);

  // A new invoice revision must be reviewed before reversing the old entry.
  await dialog.getByRole('button', { name: 'Reverse erroneous entry', exact: true }).click();
  const reversalForm = dialog.locator('.billing-reversal-form');
  const reversalReason = `Payment entered in error; no money returned ${suffix}`;
  await reversalForm.getByLabel('Reason shared with patient', { exact: true }).fill(reversalReason);
  const confirmation = reversalForm.getByRole('checkbox', {
    name: 'I confirm this payment was recorded in error; this does not return money.',
    exact: true,
  });
  await expect(confirmation).not.toBeChecked();
  expect(
    await confirmation.evaluate((input: HTMLInputElement) => input.validity.valueMissing),
  ).toBeTruthy();
  await confirmation.check();
  const concurrentReason = `Shared concurrent invoice correction ${suffix}`;
  const concurrent = await page.request.post(correctionPath, {
    headers,
    data: {
      items: [
        { description: `Latest corrected service ${suffix}`, quantity: 1, unitAmountPaise: 8005 },
      ],
      reason: concurrentReason,
      expectedRevision: (await detail()).revision,
      requestId: randomUUID(),
    },
  });
  expect(concurrent.status()).toBe(200);
  const staleRequest = page.waitForRequest(
    (request) => request.method() === 'POST' && new URL(request.url()).pathname === reversalPath,
  );
  const staleResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === reversalPath,
  );
  await reversalForm.getByRole('button', { name: 'Confirm entry reversal', exact: true }).click();
  const staleBody = (await staleRequest).postDataJSON();
  expect((await staleResponse).status()).toBe(409);
  await expect(reversalForm.getByLabel('Reason shared with patient', { exact: true })).toHaveValue(
    reversalReason,
  );
  await reversalForm
    .getByRole('button', { name: 'Refresh invoice for review', exact: true })
    .click();
  await reversalForm
    .getByRole('button', { name: 'I reviewed the latest invoice; keep my draft', exact: true })
    .click();
  await expect(reversalForm.getByLabel('Reason shared with patient', { exact: true })).toHaveValue(
    reversalReason,
  );
  await confirmation.check();
  const reversedRequest = page.waitForRequest(
    (request) => request.method() === 'POST' && new URL(request.url()).pathname === reversalPath,
  );
  await reversalForm.getByRole('button', { name: 'Confirm entry reversal', exact: true }).click();
  const reversalBody = (await reversedRequest).postDataJSON();
  expect(reversalBody.requestId).not.toBe(staleBody.requestId);
  expect(reversalBody.expectedRevision).not.toBe(staleBody.expectedRevision);
  expect(reversalBody).toMatchObject({ entryErrorConfirmed: true, reason: reversalReason });
  await expect(reversalForm).toHaveCount(0);
  await expect(dialog.getByText('Entry reversed', { exact: true })).toBeVisible();
  const reversed = await detail();
  expect(reversed.payments).toHaveLength(1);
  expect(reversed.payments[0]).toEqual(payment);
  expect(reversed.reversals).toHaveLength(1);
  expect(reversed.reversals[0]).toMatchObject({
    paymentId: payment.id,
    amountPaise: 3005,
    beforePaidPaise: 3005,
    afterPaidPaise: 0,
    reason: reversalReason,
  });
  expect(reversed.invoice).toMatchObject({ totalPaise: 8005, paidPaise: 0, status: 'unpaid' });
  const afterReversal = await report();
  expect(afterReversal.totals.collectionsPaise).toBe(baseline.totals.collectionsPaise);
  expect(afterReversal.totals.paymentCount).toBe(baseline.totals.paymentCount);

  await dialog.getByRole('button', { name: 'Correct charges', exact: true }).click();
  form = dialog.locator('.billing-correction-form');
  await form.getByRole('button', { name: 'Remove invoice item 1', exact: true }).click();
  const noChargeReason = `All recorded charges removed after review ${suffix}`;
  await form.getByLabel('Reason shared with patient', { exact: true }).fill(noChargeReason);
  const noChargeConfirmation = form.getByRole('checkbox', {
    name: 'I confirm this invoice should have no charges.',
    exact: true,
  });
  await expect(noChargeConfirmation).not.toBeChecked();
  expect(
    await noChargeConfirmation.evaluate((input: HTMLInputElement) => input.validity.valueMissing),
  ).toBeTruthy();
  await noChargeConfirmation.check();
  await form.getByRole('button', { name: 'Save charge correction', exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(dialog.getByText('No charges', { exact: true })).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Record received payment', exact: true }),
  ).toHaveCount(0);
  const final = await detail();
  expect(final.invoice).toMatchObject({
    id: original.id,
    number: original.number,
    createdAt: original.createdAt,
    patientId: original.patientId,
    patientName: original.patientName,
    procedureId: procedure.id,
    items: [],
    totalPaise: 0,
    paidPaise: 0,
    status: 'no-charge',
  });
  expect(final.issuedCharges).toEqual({ items: originalItems, totalPaise: 12005 });
  expect(final.corrections).toHaveLength(3);
  expect(final.reversals).toHaveLength(1);
  await expect(
    dialog.locator('.billing-correction-history').getByText(correctionReason, { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.locator('.billing-correction-history').getByText(noChargeReason, { exact: true }),
  ).toBeVisible();
  await dialog
    .locator('.billing-issued-charges')
    .getByText('View original issued items', { exact: true })
    .click();
  await expect(
    dialog.locator('.billing-issued-charges').getByText(originalDescription, { exact: true }),
  ).toBeVisible();

  // Native disclosure controls belong in the modal's keyboard cycle. Disabled
  // print/save controls and tables inside closed disclosures must be skipped.
  await dialog.getByRole('button', { name: 'Correct charges', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Print invoice', exact: true })).toBeDisabled();
  const openSummaries = dialog.locator('details[open] > summary');
  while (await openSummaries.count()) await openSummaries.first().click();
  const lastHistory = dialog.locator('.billing-correction-history details').last();
  const lastSummary = lastHistory.locator('summary');
  const closeDialog = dialog.getByRole('button', { name: 'Close dialog', exact: true });
  await lastSummary.focus();
  await page.keyboard.press('Tab');
  await expect(closeDialog).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(lastSummary).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(lastHistory).toHaveAttribute('open', '');
  const historyTables = lastHistory.getByRole('region');
  await page.keyboard.press('Tab');
  await expect(historyTables.first()).toBeFocused();
  const lastTable = historyTables.last();
  await lastTable.focus();
  await page.keyboard.press('Tab');
  await expect(closeDialog).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(lastTable).toBeFocused();

  // Browser printing includes the recorded history, never the unfinished draft,
  // and restores the patient's chosen disclosure state afterwards.
  while (await openSummaries.count()) await openSummaries.first().click();
  const historyDisclosures = dialog.locator('details');
  const disclosureStates = await historyDisclosures.evaluateAll((elements) =>
    elements.map((element) => (element as HTMLDetailsElement).open),
  );
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  await page.emulateMedia({ media: 'print' });
  try {
    expect(
      await historyDisclosures.evaluateAll((elements) =>
        elements.every((element) => (element as HTMLDetailsElement).open),
      ),
    ).toBeTruthy();
    await expect(
      dialog.locator('.billing-current-charges').getByRole('heading', {
        name: 'Current invoice charges',
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      dialog
        .locator('.billing-current-charges')
        .getByText('No charges in this version of the invoice.', { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.locator('.billing-issued-charges').getByText(originalDescription, { exact: true }),
    ).toBeVisible();
    await expect(
      lastHistory.getByText(`Corrected service ${suffix}`, { exact: true }),
    ).toBeVisible();
    await expect(dialog.locator('.billing-correction-form')).toBeHidden();
    await expect(dialog.getByRole('button', { name: 'Correct charges', exact: true })).toBeHidden();
    await expect(dialog.getByRole('button', { name: 'Print invoice', exact: true })).toBeHidden();
  } finally {
    await page.emulateMedia({ media: 'screen' });
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  }
  expect(
    await historyDisclosures.evaluateAll((elements) =>
      elements.map((element) => (element as HTMLDetailsElement).open),
    ),
  ).toEqual(disclosureStates);
  await expect(dialog.locator('.billing-correction-form')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel correction', exact: true }).click();
  await expect(dialog.locator('.billing-correction-form')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Print invoice', exact: true })).toBeEnabled();
  expect((await detail()).corrections).toHaveLength(3);

  await page.setViewportSize({ width: 320, height: 780 });
  await audit(page);
  await page.screenshot({
    path: testInfo.outputPath('billing-corrections-admin-mobile.png'),
    fullPage: true,
  });
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.goto(`/clinic/insights?from=${date}&to=${date}`);
  const metric = (label: string) =>
    page.getByRole('group', { name: label, exact: true }).locator('.insights-metric-value');
  await expect(metric('Invoices issued')).toHaveText(amount(baseline.totals.invoicedPaise));
  await expect(metric('Recorded collections')).toHaveText(amount(baseline.totals.collectionsPaise));
  await expect(metric('Outstanding on period invoices')).toHaveText(
    amount(baseline.totals.issuedInvoiceOutstandingPaise),
  );
  await expect(
    page.getByText(/Current corrected invoice amounts use the original issue date/),
  ).toBeVisible();
  await expect(
    page.getByText(/A reversal corrects a recorded entry and does not return money/),
  ).toBeVisible();
  const finalReport = await report();
  expect(finalReport.totals.invoiceCount).toBe(baseline.totals.invoiceCount + 1);
  expect(finalReport.totals.paymentCount).toBe(baseline.totals.paymentCount);

  const reception = await browser.newContext({ baseURL });
  const patient = await browser.newContext({ baseURL });
  try {
    for (const [context, email, path] of [
      [reception, 'reception@derma.demo', `/clinic/billing?invoice=${original.id}`],
      [patient, 'patient@derma.demo', `/my-care/invoices?invoice=${original.id}`],
    ] as const) {
      const loginResponse = await context.request.post('/api/auth/login', {
        data: { email, password: 'DemoClinic2026!' },
      });
      expect(loginResponse.ok()).toBeTruthy();
      const session = await loginResponse.json();
      const member = await context.newPage();
      await member.goto(path);
      const invoiceDialog = member.getByRole('dialog', {
        name: `Invoice ${original.number}`,
        exact: true,
      });
      await expect(invoiceDialog.getByText('No charges', { exact: true })).toBeVisible();
      await expect(
        invoiceDialog.getByRole('button', { name: 'Correct charges', exact: true }),
      ).toHaveCount(0);
      await expect(
        invoiceDialog.getByRole('button', { name: 'Reverse erroneous entry', exact: true }),
      ).toHaveCount(0);
      await expect(invoiceDialog.getByText(reversalReason, { exact: true })).toBeVisible();
      await expect(
        invoiceDialog
          .locator('.billing-correction-history')
          .getByText(noChargeReason, { exact: true }),
      ).toBeVisible();
      await invoiceDialog
        .locator('.billing-issued-charges')
        .getByText('View original issued items', { exact: true })
        .click();
      await expect(
        invoiceDialog
          .locator('.billing-issued-charges')
          .getByText(originalDescription, { exact: true }),
      ).toBeVisible();
      const sharedResponse = await context.request.get(detailPath);
      expect(sharedResponse.ok()).toBeTruthy();
      const shared = (await sharedResponse.json()) as InvoiceDetail;
      expect(shared.issuedCharges).toEqual(final.issuedCharges);
      expect(shared.corrections).toEqual(final.corrections);
      expect(shared.reversals).toEqual(final.reversals);
      for (const event of [...shared.corrections, ...shared.reversals]) {
        expect(event).not.toHaveProperty('requestId');
        expect(event).not.toHaveProperty('createdById');
      }
      const memberHeaders = { 'X-CSRF-Token': session.csrfToken };
      expect(
        (
          await context.request.post(correctionPath, {
            headers: memberHeaders,
            data: {
              items: originalItems,
              reason: 'Unauthorized correction attempt',
              expectedRevision: shared.revision,
              requestId: randomUUID(),
            },
          })
        ).status(),
      ).toBe(403);
      expect(
        (
          await context.request.post(reversalPath, {
            headers: memberHeaders,
            data: {
              entryErrorConfirmed: true,
              reason: 'Unauthorized reversal attempt',
              expectedRevision: shared.revision,
              requestId: randomUUID(),
            },
          })
        ).status(),
      ).toBe(403);
      await member.setViewportSize({ width: 320, height: 780 });
      await audit(member);
      await member.screenshot({
        path: testInfo.outputPath(
          email.startsWith('patient')
            ? 'billing-corrections-patient-mobile.png'
            : 'billing-corrections-reception-mobile.png',
        ),
        fullPage: true,
      });
      if (email.startsWith('patient')) {
        await invoiceDialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
        await member.goto('/my-care/summary');
        const entry = member
          .locator('.care-summary-entry')
          .filter({ has: member.getByRole('heading', { name: original.number, exact: true }) });
        await expect(entry.getByText('No charges', { exact: true })).toBeVisible();
        await expect(entry.getByText(originalDescription, { exact: true }).first()).toBeVisible();
        await expect(entry.getByText(correctionReason, { exact: true })).toBeVisible();
        await expect(entry.getByText(reversalReason, { exact: true })).toBeVisible();
        await expect(entry.getByText(noChargeReason, { exact: true })).toBeVisible();
        await expect(
          entry.getByText(
            'These updates correct erroneous payment records. They do not return money or record a refund.',
            { exact: true },
          ),
        ).toBeVisible();
        const snapshot = (await (
          await context.request.get('/api/patients/patient-ananya/care-summary')
        ).json()) as CareSummary;
        const history = snapshot.invoiceHistories.find((value) => value.invoiceId === original.id)!;
        expect(history).toEqual({
          invoiceId: original.id,
          issuedCharges: final.issuedCharges,
          corrections: final.corrections,
          reversals: final.reversals,
          refunds: final.refunds,
          refundVoids: final.refundVoids,
        });
        for (const privateKey of ['requestId', 'createdById', 'revision'])
          expect(JSON.stringify(history)).not.toContain(`"${privateKey}"`);
        await audit(member);
        await member.screenshot({
          path: testInfo.outputPath('billing-corrections-summary-mobile.png'),
          fullPage: true,
        });
      }
    }
  } finally {
    await reception.close();
    await patient.close();
  }
  expect((await detail()).corrections).toHaveLength(3);
  expect((await detail()).reversals).toHaveLength(1);
});

test('unconfirmed and malformed invoice responses preserve the exact correction request until it is safely confirmed', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const login = await page.request.post('/api/auth/login', {
    data: { email: 'admin@derma.demo', password: 'DemoClinic2026!' },
  });
  expect(login.ok()).toBeTruthy();
  const headers = { 'X-CSRF-Token': (await login.json()).csrfToken };
  const suffix = randomUUID().slice(0, 8);
  const description = `Response validation fixture ${suffix}`;
  const items = (unitAmountPaise: number): InvoiceItem[] => [
    { description, quantity: 1, unitAmountPaise },
  ];
  const create = await page.request.post('/api/invoices', {
    headers,
    data: { patientId: 'patient-ananya', items: items(4500), requestId: randomUUID() },
  });
  expect(create.status()).toBe(201);
  const invoice = (await create.json()) as Invoice;
  const detailPath = `/api/invoices/${invoice.id}`;
  const correctionPath = `${detailPath}/corrections`;
  async function detail(): Promise<InvoiceDetail> {
    const response = await page.request.get(detailPath);
    expect(response.ok()).toBeTruthy();
    return response.json();
  }
  async function seedCorrection(unitAmountPaise: number, reason: string): Promise<InvoiceDetail> {
    const response = await page.request.post(correctionPath, {
      headers,
      data: {
        items: items(unitAmountPaise),
        reason,
        expectedRevision: (await detail()).revision,
        requestId: randomUUID(),
      },
    });
    expect(response.status(), await response.text()).toBe(200);
    return response.json();
  }
  const repeatedReason = `Same intended correction ${suffix}`;
  await seedCorrection(5500, repeatedReason);
  const seeded = await seedCorrection(4500, `Restore original charges ${suffix}`);
  expect(seeded.corrections).toHaveLength(2);

  // A successful HTTP status with malformed nested history is a load failure,
  // not permission to render an incomplete invoice or crash the page.
  const malformedGet = async (route: Route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...seeded, corrections: [{}] }),
    });
  };
  await page.route(`**${detailPath}`, malformedGet);
  await page.goto(`/clinic/billing?invoice=${invoice.id}`);
  const failedDialog = page.getByRole('dialog', { name: 'Invoice', exact: true });
  await expect(failedDialog.getByRole('alert')).toContainText('We couldn’t load this.');
  await expect(failedDialog.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  await expect(failedDialog.locator('.invoice-document')).toHaveCount(0);
  expect(pageErrors).toEqual([]);
  await page.unroute(`**${detailPath}`, malformedGet);
  await failedDialog.getByRole('button', { name: 'Try again', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Invoice ${invoice.number}`, exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Correct charges', exact: true }).click();
  const form = dialog.locator('.billing-correction-form');
  await form.getByLabel('Unit price (₹)', { exact: true }).fill('55.00');
  await form.getByLabel('Reason shared with patient', { exact: true }).fill(repeatedReason);

  // A matching OLD event must not falsely confirm a new A → B attempt after
  // the invoice has already moved A → B → A.
  let oldResponseBody: Record<string, unknown> | undefined;
  const returnOldSuccess = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.continue();
    oldResponseBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(seeded),
    });
  };
  await page.route(`**${correctionPath}`, returnOldSuccess);
  await form.getByRole('button', { name: 'Save charge correction', exact: true }).click();
  await expect(form.getByRole('button', { name: 'Retry same request', exact: true })).toBeVisible();
  await expect(form.getByRole('alert')).toContainText(
    'did not confirm the submitted charge correction',
  );
  await expect(form.getByLabel('Unit price (₹)', { exact: true })).toHaveValue('55.00');
  await expect(form.getByLabel('Unit price (₹)', { exact: true })).toBeDisabled();
  await expect(form.getByLabel('Reason shared with patient', { exact: true })).toBeDisabled();
  expect((await detail()).corrections).toHaveLength(2);
  expect((await detail()).invoice.totalPaise).toBe(4500);
  await page.unroute(`**${correctionPath}`, returnOldSuccess);
  async function retryExact(body: Record<string, unknown> | undefined) {
    expect(body).toBeDefined();
    const request = page.waitForRequest(
      (value) => value.method() === 'POST' && new URL(value.url()).pathname === correctionPath,
    );
    await form.getByRole('button', { name: 'Retry same request', exact: true }).click();
    expect((await request).postDataJSON()).toEqual(body);
    await expect(form).toHaveCount(0);
  }
  await retryExact(oldResponseBody);
  const confirmed = await detail();
  expect(confirmed.corrections).toHaveLength(3);
  expect(confirmed.invoice.totalPaise).toBe(5500);
  expect(confirmed.corrections.filter((entry) => entry.reason === repeatedReason)).toHaveLength(2);
  expect(confirmed.corrections[0].id).not.toBe(seeded.corrections[1].id);

  // The server commits exactly once, but a damaged response must retain the
  // original request UUID and locked draft until its real response is retried.
  await dialog.getByRole('button', { name: 'Correct charges', exact: true }).click();
  await form.getByLabel('Unit price (₹)', { exact: true }).fill('65.00');
  const malformedReason = `Committed correction with damaged response ${suffix}`;
  await form.getByLabel('Reason shared with patient', { exact: true }).fill(malformedReason);
  let malformedBody: Record<string, unknown> | undefined;
  const returnMalformedSuccess = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.continue();
    malformedBody = route.request().postDataJSON();
    const response = await route.fetch();
    expect(response.status(), await response.text()).toBe(200);
    const saved = (await response.json()) as InvoiceDetail;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...saved, invoice: { ...saved.invoice, items: [null] } }),
    });
  };
  await page.route(`**${correctionPath}`, returnMalformedSuccess);
  await form.getByRole('button', { name: 'Save charge correction', exact: true }).click();
  await expect(form.getByRole('button', { name: 'Retry same request', exact: true })).toBeVisible();
  await expect(form.getByRole('alert')).toContainText(
    'did not confirm a complete, consistent invoice',
  );
  await expect(form.getByLabel('Unit price (₹)', { exact: true })).toHaveValue('65.00');
  await expect(form.getByLabel('Unit price (₹)', { exact: true })).toBeDisabled();
  await expect(form.getByLabel('Reason shared with patient', { exact: true })).toBeDisabled();
  const committed = await detail();
  expect(committed.corrections).toHaveLength(4);
  expect(committed.invoice.totalPaise).toBe(6500);
  await page.unroute(`**${correctionPath}`, returnMalformedSuccess);
  await retryExact(malformedBody);
  const final = await detail();
  expect(final.corrections).toEqual(committed.corrections);
  expect(final.invoice.totalPaise).toBe(6500);
  expect(final.issuedCharges).toEqual({ items: items(4500), totalPaise: 4500 });
  expect(pageErrors).toEqual([]);
});
