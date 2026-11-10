import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { Invoice, ProcedureBillingItem } from '../../shared/operations';

test('reception bills a procedure with explicit charges and reopens its existing invoice without clinical details', async ({
  page,
  playwright,
  baseURL,
}, testInfo) => {
  const doctor = await playwright.request.newContext({ baseURL });
  const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const title = `Procedure billing journey ${suffix}`;
  const privateMarker = `PRIVATE clinical detail ${suffix}`;
  try {
    const login = await doctor.post('/api/auth/login', {
      data: { email: 'doctor@derma.demo', password: 'DemoClinic2026!' },
    });
    expect(login.ok()).toBeTruthy();
    const headers = { 'X-CSRF-Token': (await login.json()).csrfToken };
    const created = await doctor.post('/api/procedures', {
      headers,
      data: {
        patientId: 'patient-ananya',
        title,
        indication: `${privateMarker}: indication`,
        benefits: `${privateMarker}: benefits`,
        risks: `${privateMarker}: risks`,
        alternatives: `${privateMarker}: alternatives`,
        aftercare: `${privateMarker}: aftercare`,
        estimatedCost: '₹5,000 estimate; confirm agreed charge',
      },
    });
    expect(created.status()).toBe(201);
    const procedure = await created.json();
    const agreed = await doctor.post(`/api/procedures/${procedure.id}/agreements`, {
      headers,
      data: {
        decision: 'agreed',
        method: 'in-person',
        patientDecisionConfirmed: true,
        note: `${privateMarker}: discussion record`,
      },
    });
    expect(agreed.status()).toBe(201);
    const completed = await doctor.post(`/api/procedures/${procedure.id}/complete`, {
      headers,
      data: {
        outcome: `${privateMarker}: outcome`,
        aftercare: `${privateMarker}: completion aftercare`,
      },
    });
    expect(completed.status()).toBe(200);

    await page.goto('/login');
    await page.getByLabel('Email address', { exact: true }).fill('reception@derma.demo');
    await page.getByLabel('Password', { exact: true }).fill('DemoClinic2026!');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/\/clinic$/);
    const billingResponse = await page.request.get(
      '/api/procedure-billing?patientId=patient-ananya',
    );
    expect(billingResponse.ok()).toBeTruthy();
    const projected = ((await billingResponse.json()) as ProcedureBillingItem[]).find(
      (value) => value.id === procedure.id,
    )!;
    expect(projected).toMatchObject({
      title,
      patientId: 'patient-ananya',
      status: 'completed',
      invoiceId: null,
    });
    for (const field of [
      'indication',
      'benefits',
      'risks',
      'alternatives',
      'aftercare',
      'agreements',
      'completion',
      'outcome',
    ])
      expect(projected).not.toHaveProperty(field);
    expect(JSON.stringify(projected)).not.toContain(privateMarker);
    expect(
      (await page.request.get('/api/patients/patient-ananya/clinical-workflows')).status(),
    ).toBe(403);

    await page.goto(`/clinic/billing?procedure=${procedure.id}`);
    let dialog = page.getByRole('dialog');
    await expect(
      dialog.getByRole('heading', { name: 'Create an invoice', exact: true }),
    ).toBeVisible();
    await expect(dialog.getByLabel('Patient', { exact: true })).toHaveValue('patient-ananya');
    await expect(dialog.getByLabel('Patient', { exact: true })).toBeDisabled();
    await expect(dialog.getByLabel('Link a procedure (optional)', { exact: true })).toHaveValue(
      procedure.id,
    );
    await expect(dialog.getByLabel('Link a procedure (optional)', { exact: true })).toBeDisabled();
    await expect(dialog.getByLabel('Service or item', { exact: true })).toHaveValue(title);
    await expect(dialog.getByLabel('Unit price (₹)', { exact: true })).toHaveValue('');
    await expect(
      dialog.getByText(/Recorded estimate: ₹5,000 estimate; confirm agreed charge/),
    ).toBeVisible();
    expect(await dialog.textContent()).not.toContain(privateMarker);
    await dialog.getByRole('button', { name: 'Create invoice', exact: true }).click();
    await expect(
      dialog.getByRole('heading', { name: 'Create an invoice', exact: true }),
    ).toBeVisible();
    expect(
      await dialog
        .getByLabel('Unit price (₹)', { exact: true })
        .evaluate((element: HTMLInputElement) => element.validity.valueMissing),
    ).toBeTruthy();
    await dialog.getByLabel('Quantity', { exact: true }).fill('2');
    await dialog.getByLabel('Unit price (₹)', { exact: true }).fill('1250.55');
    const invoiceResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/invoices' &&
        response.request().method() === 'POST',
    );
    await dialog.getByRole('button', { name: 'Create invoice', exact: true }).click();
    const response = await invoiceResponse;
    expect(response.status()).toBe(201);
    const invoice = (await response.json()) as Invoice;
    expect(invoice).toMatchObject({
      patientId: 'patient-ananya',
      procedureId: procedure.id,
      procedureTitle: title,
      totalPaise: 250110,
      paidPaise: 0,
      status: 'unpaid',
    });
    expect(invoice.items).toEqual([{ description: title, quantity: 2, unitAmountPaise: 125055 }]);
    expect(JSON.stringify(invoice)).not.toContain(privateMarker);
    dialog = page.getByRole('dialog');
    await expect(
      dialog.getByRole('heading', { name: `Invoice ${invoice.number}`, exact: true }),
    ).toBeVisible();
    await expect(dialog.locator('.invoice-totals')).toContainText('₹2,501.10');
    await expect(dialog.getByText('unpaid', { exact: true })).toBeVisible();
    await expect(
      dialog.getByRole('link', { name: 'Open procedure record →', exact: true }),
    ).toHaveCount(0);
    const detail = await (await page.request.get(`/api/invoices/${invoice.id}`)).json();
    expect(detail.payments).toEqual([]);

    const session = await (await page.request.get('/api/session')).json();
    const retried = await page.request.post('/api/invoices', {
      headers: { 'X-CSRF-Token': session.csrfToken },
      data: response.request().postDataJSON(),
    });
    expect(retried.status()).toBe(200);
    expect((await retried.json()).id).toBe(invoice.id);
    await page.goto(`/clinic/billing?procedure=${procedure.id}`);
    dialog = page.getByRole('dialog');
    await expect(
      dialog.getByRole('heading', { name: `Invoice ${invoice.number}`, exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByRole('heading', { name: 'Create an invoice', exact: true }),
    ).toHaveCount(0);
    const invoices = (await (await page.request.get('/api/invoices')).json()) as Invoice[];
    expect(invoices.filter((value) => value.procedureId === procedure.id)).toHaveLength(1);
    const linked = (
      (await (
        await page.request.get('/api/procedure-billing?patientId=patient-ananya')
      ).json()) as ProcedureBillingItem[]
    ).find((value) => value.id === procedure.id)!;
    expect(linked).toMatchObject({ invoiceId: invoice.id, invoiceNumber: invoice.number });
    expect(await dialog.textContent()).not.toContain(privateMarker);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/clinic/billing?invoice=${invoice.id}`);
    await expect(
      page
        .getByRole('dialog')
        .getByRole('heading', { name: `Invoice ${invoice.number}`, exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBeTruthy();
    await page.waitForLoadState('networkidle');
    const audit = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(audit.violations).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath('reception-procedure-invoice-mobile.png'),
      fullPage: true,
    });
  } finally {
    await doctor.dispose();
  }
});
