import { test, expect, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import type { PatientProfile, PatientAllergyHistory } from '../../shared/patient-profile';
import type { CarePlan, PatientRecord, Session } from '../../shared/types';
import type { Invoice } from '../../shared/operations';
import type { CareSummary } from '../../shared/care-summary';

const today = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
const after = (days: number) =>
  new Date(Date.parse(`${today()}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

async function loseProfileResponse(page: Page, path: string) {
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
    if (used || route.request().method() !== 'PATCH') return route.continue();
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
        body: JSON.stringify({
          error: 'Synthetic lost response after patient details were corrected.',
        }),
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

async function audit(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  const notifications = page.getByRole('button', { name: 'Dismiss notification', exact: true });
  while (await notifications.count()) await notifications.first().click();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
}

test('staff correct current patient details with safe retries while patients read shared allergy history and retain their login and original record names', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(120000);
  const suffix = randomUUID().slice(0, 8);
  const originalName = `Original Patient ${suffix}`;
  const correctedName = `Corrected Patient ${suffix}`;
  const loginEmail = `profile-login-${suffix}@example.test`;
  const contactEmail = `profile-contact-${suffix}@example.test`;
  const password = 'PatientProfile2026!';
  const registered = await page.request.post('/api/auth/register', {
    data: {
      name: originalName,
      email: loginEmail,
      phone: '+91 90000 11111',
      dob: '1994-05-03',
      gender: 'Prefer not to say',
      password,
    },
  });
  expect(registered.status()).toBe(201);
  const registration = (await registered.json()) as Session;
  const patientId = registration.user!.patientId!;
  const profilePath = `/api/patients/${patientId}/profile`;
  const allergyPath = `/api/patients/${patientId}/allergies`;
  const summaryPath = `/api/patients/${patientId}/care-summary`;
  const intakeReport = `Patient-reported allergy history ${suffix}`;
  const intake = await page.request.post('/api/intakes', {
    headers: { 'X-CSRF-Token': registration.csrfToken! },
    data: {
      concern: 'Synthetic documentation test',
      location: 'Synthetic area',
      duration: 'One week',
      allergies: intakeReport,
      consent: true,
    },
  });
  expect(intake.status()).toBe(201);
  const clinician = await browser.newContext({ baseURL });
  const patient = await browser.newContext({ baseURL });
  try {
    const doctorLogin = await clinician.request.post('/api/auth/login', {
      data: { email: 'doctor@derma.demo', password: 'DemoClinic2026!' },
    });
    expect(doctorLogin.ok()).toBeTruthy();
    const doctorHeaders = { 'X-CSRF-Token': (await doctorLogin.json()).csrfToken };
    async function profile(): Promise<PatientProfile> {
      const response = await clinician.request.get(profilePath);
      expect(response.ok()).toBeTruthy();
      return response.json();
    }
    async function allergies(): Promise<PatientAllergyHistory> {
      const response = await clinician.request.get(allergyPath);
      expect(response.ok()).toBeTruthy();
      return response.json();
    }
    const originalProfile = await profile();
    expect(originalProfile.changes).toEqual([]);
    expect((await allergies()).current).toEqual({ status: 'not-recorded', text: '' });
    expect((await allergies()).changes).toEqual([]);
    const initialClinicalText = `Synthetic clinician-recorded allergy information ${suffix}`;
    const initialReason = `Shared initial clinician documentation ${suffix}`;
    const initialUpdate = await clinician.request.post(allergyPath, {
      headers: doctorHeaders,
      data: {
        status: 'recorded',
        text: initialClinicalText,
        reason: initialReason,
        expectedRevision: (await allergies()).revision,
        requestId: randomUUID(),
      },
    });
    expect(initialUpdate.status()).toBe(200);
    const beforeDemographics = await allergies();
    const planResponse = await clinician.request.post('/api/care-plans', {
      headers: doctorHeaders,
      data: {
        patientId,
        title: `Original name plan ${suffix}`,
        instructions: 'Synthetic unchanged care instructions.',
        startDate: today(),
        endDate: after(10),
        followUpDate: after(7),
        medications: [],
      },
    });
    expect(planResponse.status()).toBe(201);
    const plan = (await planResponse.json()) as CarePlan;
    const invoiceResponse = await clinician.request.post('/api/invoices', {
      headers: doctorHeaders,
      data: {
        patientId,
        requestId: randomUUID(),
        items: [
          { description: 'Synthetic original-name invoice', quantity: 1, unitAmountPaise: 12005 },
        ],
      },
    });
    expect(invoiceResponse.status()).toBe(201);
    const invoice = (await invoiceResponse.json()) as Invoice;
    expect(plan.patientName).toBe(originalName);
    expect(invoice.patientName).toBe(originalName);
    const originalSummary = (await (
      await clinician.request.get(summaryPath)
    ).json()) as CareSummary;

    const receptionLogin = await page.request.post('/api/auth/login', {
      data: { email: 'reception@derma.demo', password: 'DemoClinic2026!' },
    });
    expect(receptionLogin.ok()).toBeTruthy();
    const receptionHeaders = { 'X-CSRF-Token': (await receptionLogin.json()).csrfToken };
    const receptionReads: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'GET') receptionReads.push(new URL(request.url()).pathname);
    });
    await page.goto(`/clinic/patients/${patientId}/details`);
    await expect(page.getByRole('heading', { name: 'Patient details', exact: true })).toBeVisible();
    await expect(
      page.locator('.patient-profile-current').getByText(originalName, { exact: true }),
    ).toBeVisible();
    await expect(page.locator('.patient-allergy-current')).toHaveCount(0);
    await expect(page.locator('.patient-allergy-history')).toHaveCount(0);
    await expect(page.getByText(initialClinicalText, { exact: true })).toHaveCount(0);
    expect(receptionReads).not.toContain(allergyPath);
    expect((await page.request.get(allergyPath)).status()).toBe(403);
    await page.getByRole('button', { name: 'Edit patient details', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'Correct patient details', exact: true });
    await dialog.getByLabel('Full name', { exact: true }).fill(correctedName);
    await dialog.getByLabel('Contact email', { exact: true }).fill(contactEmail);
    await dialog.getByLabel('Phone number', { exact: true }).fill('+91 90000 22222');
    await dialog.getByLabel('Date of birth', { exact: true }).fill('');
    await dialog.getByLabel('Gender', { exact: true }).fill('');
    const privateReason = `Staff-only identity correction context ${suffix}`;
    await dialog.getByLabel('Reason for correction', { exact: true }).fill(privateReason);
    const lost = await loseProfileResponse(page, profilePath);
    try {
      await dialog.getByRole('button', { name: 'Save patient details', exact: true }).click();
      await lost.ready;
      await expect(dialog.getByLabel('Full name', { exact: true })).toBeDisabled();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
      await expect(dialog).toBeVisible();
    } finally {
      await lost.release();
    }
    await expect(dialog.getByRole('alert')).toContainText('Synthetic lost response');
    await expect(dialog.getByLabel('Full name', { exact: true })).toHaveValue(correctedName);
    await expect(dialog.getByLabel('Full name', { exact: true })).toBeDisabled();
    await expect(dialog.getByLabel('Reason for correction', { exact: true })).toBeDisabled();
    expect((await profile()).changes).toHaveLength(1);
    expect((await profile()).demographics).toMatchObject({
      name: correctedName,
      email: contactEmail,
      phone: '+91 90000 22222',
      dob: '',
      gender: '',
    });
    expect((await allergies()).revision).toBe(beforeDemographics.revision);
    expect(lost.body()).toMatchObject({
      expectedRevision: originalProfile.revision,
      name: correctedName,
      email: contactEmail,
      dob: '',
      gender: '',
      reason: privateReason,
    });
    expect(lost.body()?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    await dialog.getByRole('button', { name: 'Close for now', exact: true }).click();
    await page.getByRole('button', { name: 'Resume pending update', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Correct patient details', exact: true });
    const retryRequest = page.waitForRequest(
      (request) => request.method() === 'PATCH' && new URL(request.url()).pathname === profilePath,
    );
    const retryResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' && new URL(response.url()).pathname === profilePath,
    );
    await dialog.getByRole('button', { name: 'Retry same request', exact: true }).click();
    expect((await retryRequest).postDataJSON()).toEqual(lost.body());
    expect((await retryResponse).status()).toBe(200);
    await expect(dialog).toBeHidden();
    await expect(
      page.locator('.patient-profile-current').getByText(correctedName, { exact: true }),
    ).toBeVisible();
    await expect(
      page.locator('.patient-profile-history').getByText(privateReason, { exact: true }),
    ).toBeVisible();
    await page
      .locator('.patient-profile-change')
      .getByText('View before and after', { exact: true })
      .click();
    await expect(
      page.locator('.patient-profile-change').getByText(originalName, { exact: true }),
    ).toBeVisible();
    await expect(
      page.locator('.patient-profile-change').getByText(correctedName, { exact: true }),
    ).toBeVisible();
    expect((await profile()).changes).toHaveLength(1);
    expect(
      (
        await clinician.request.get(`${summaryPath}/download?revision=${originalSummary.revision}`)
      ).status(),
    ).toBe(409);
    await page.setViewportSize({ width: 320, height: 780 });
    await audit(page);
    await page.screenshot({
      path: testInfo.outputPath('patient-details-reception-mobile.png'),
      fullPage: true,
    });

    const doctorPage = await clinician.newPage();
    await doctorPage.goto(`/clinic/patients/${patientId}/details`);
    await expect(
      doctorPage
        .locator('.patient-allergy-current')
        .getByText(initialClinicalText, { exact: true }),
    ).toBeVisible();
    await doctorPage.getByRole('button', { name: 'Update allergy record', exact: true }).click();
    const allergyDialog = doctorPage.getByRole('dialog', {
      name: 'Update allergy record',
      exact: true,
    });
    await allergyDialog.getByLabel('Allergy status', { exact: true }).selectOption('none-known');
    const sharedReason = `Clinician-reviewed update shared with patient ${suffix}`;
    await allergyDialog
      .getByLabel('Reason shared with patient', { exact: true })
      .fill(sharedReason);
    const concurrentText = `Concurrent synthetic allergy documentation ${suffix}`;
    const concurrentReason = `Shared concurrent review context ${suffix}`;
    const concurrent = await clinician.request.post(allergyPath, {
      headers: doctorHeaders,
      data: {
        status: 'recorded',
        text: concurrentText,
        reason: concurrentReason,
        expectedRevision: (await allergies()).revision,
        requestId: randomUUID(),
      },
    });
    expect(concurrent.status()).toBe(200);
    const staleRequest = doctorPage.waitForRequest(
      (request) => request.method() === 'POST' && new URL(request.url()).pathname === allergyPath,
    );
    const staleResponse = doctorPage.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && new URL(response.url()).pathname === allergyPath,
    );
    await allergyDialog.getByRole('button', { name: 'Save allergy update', exact: true }).click();
    const staleBody = (await staleRequest).postDataJSON();
    expect((await staleResponse).status()).toBe(409);
    await expect(allergyDialog.getByLabel('Allergy status', { exact: true })).toHaveValue(
      'none-known',
    );
    await expect(
      allergyDialog.getByLabel('Reason shared with patient', { exact: true }),
    ).toHaveValue(sharedReason);
    await expect(
      allergyDialog.getByRole('button', { name: 'Save allergy update', exact: true }),
    ).toBeDisabled();
    await allergyDialog
      .getByRole('button', { name: 'Refresh allergy record', exact: true })
      .click();
    await expect(allergyDialog.getByText(concurrentText, { exact: true })).toBeVisible();
    await allergyDialog
      .getByRole('button', { name: 'I reviewed the latest record; keep my draft', exact: true })
      .click();
    await expect(allergyDialog.getByLabel('Allergy status', { exact: true })).toHaveValue(
      'none-known',
    );
    await expect(
      allergyDialog.getByLabel('Reason shared with patient', { exact: true }),
    ).toHaveValue(sharedReason);
    const correctionRequest = doctorPage.waitForRequest(
      (request) => request.method() === 'POST' && new URL(request.url()).pathname === allergyPath,
    );
    await allergyDialog.getByRole('button', { name: 'Save allergy update', exact: true }).click();
    const correctionBody = (await correctionRequest).postDataJSON();
    expect(correctionBody).toMatchObject({ status: 'none-known', text: '', reason: sharedReason });
    expect(correctionBody.requestId).not.toBe(staleBody.requestId);
    expect(correctionBody.expectedRevision).not.toBe(staleBody.expectedRevision);
    await expect(allergyDialog).toBeHidden();
    await expect(
      doctorPage
        .locator('.patient-allergy-current')
        .getByText('No known allergies recorded', { exact: true }),
    ).toBeVisible();
    const finalAllergies = await allergies();
    expect(finalAllergies.changes).toHaveLength(3);
    expect(finalAllergies.current).toEqual({ status: 'none-known', text: '' });
    expect(finalAllergies.changes[0]).toMatchObject({
      before: { status: 'recorded', text: concurrentText },
      after: { status: 'none-known', text: '' },
      reason: sharedReason,
    });
    expect((await profile()).changes).toHaveLength(1);
    await page.getByRole('button', { name: 'Refresh details', exact: true }).click();
    await expect(
      page.locator('.patient-profile-current').getByText(correctedName, { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(sharedReason, { exact: true })).toHaveCount(0);
    expect(
      (
        await page.request.post(allergyPath, {
          headers: receptionHeaders,
          data: {
            ...correctionBody,
            requestId: randomUUID(),
            expectedRevision: finalAllergies.revision,
          },
        })
      ).status(),
    ).toBe(403);

    const patientPage = await patient.newPage();
    await patientPage.goto('/login');
    await patientPage.getByLabel('Email address', { exact: true }).fill(loginEmail);
    await patientPage.getByLabel('Password', { exact: true }).fill(password);
    await patientPage.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(patientPage).toHaveURL(/\/my-care$/);
    const currentSession = (await (await patient.request.get('/api/session')).json()) as Session;
    expect(currentSession.user).toMatchObject({ name: originalName, email: loginEmail, patientId });
    await patientPage.getByRole('link', { name: 'View patient details', exact: true }).click();
    await expect(patientPage).toHaveURL(/\/my-care\/details$/);
    await expect(
      patientPage.locator('.patient-profile-current').getByText(correctedName, { exact: true }),
    ).toBeVisible();
    await expect(
      patientPage.locator('.patient-profile-current').getByText(contactEmail, { exact: true }),
    ).toBeVisible();
    await expect(
      patientPage
        .locator('.patient-allergy-current')
        .getByText('No known allergies recorded', { exact: true }),
    ).toBeVisible();
    await expect(
      patientPage.getByRole('button', { name: 'Edit patient details', exact: true }),
    ).toHaveCount(0);
    await expect(
      patientPage.getByRole('button', { name: 'Update allergy record', exact: true }),
    ).toHaveCount(0);
    await expect(patientPage.locator('.patient-profile-history')).toHaveCount(0);
    await expect(patientPage.getByText(privateReason, { exact: true })).toHaveCount(0);
    await expect(patientPage.locator('.patient-allergy-change')).toHaveCount(3);
    const newest = patientPage.locator('.patient-allergy-change').first();
    await expect(newest.getByText(sharedReason, { exact: true })).toBeVisible();
    await newest.getByText('View before and after', { exact: true }).click();
    await expect(newest.getByText(concurrentText, { exact: true })).toBeVisible();
    await expect(
      newest.getByText(finalAllergies.changes[0].doctorName, { exact: true }),
    ).toBeVisible();
    const patientProfile = (await (
      await patient.request.get(profilePath)
    ).json()) as PatientProfile;
    expect(patientProfile.revision).toBeNull();
    expect(patientProfile.changes).toEqual([]);
    expect(JSON.stringify(patientProfile)).not.toContain(privateReason);
    const patientAllergies = (await (
      await patient.request.get(allergyPath)
    ).json()) as PatientAllergyHistory;
    expect(patientAllergies.revision).toBeNull();
    expect(patientAllergies.changes).toHaveLength(3);
    for (const change of patientAllergies.changes) {
      expect(change).not.toHaveProperty('createdById');
      expect(change).not.toHaveProperty('requestId');
    }
    const patientHeaders = { 'X-CSRF-Token': currentSession.csrfToken! };
    expect(
      (
        await patient.request.patch(profilePath, {
          headers: patientHeaders,
          data: { ...lost.body(), requestId: randomUUID() },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await patient.request.post(allergyPath, {
          headers: patientHeaders,
          data: { ...correctionBody, requestId: randomUUID() },
        })
      ).status(),
    ).toBe(403);
    await patientPage.setViewportSize({ width: 320, height: 780 });
    await audit(patientPage);
    await patientPage.screenshot({
      path: testInfo.outputPath('patient-details-own-history-mobile.png'),
      fullPage: true,
    });
    await patientPage.getByRole('link', { name: 'Back to health record', exact: true }).click();
    await expect(
      patientPage.locator('.patient-record-profile').getByText(correctedName, { exact: true }),
    ).toBeVisible();
    await expect(
      patientPage
        .locator('.patient-allergies')
        .getByText('No known allergies recorded', { exact: true }),
    ).toBeVisible();
    await patientPage.getByRole('link', { name: 'View care summary', exact: true }).click();
    await expect(
      patientPage
        .locator('.care-summary-identity')
        .getByRole('heading', { name: correctedName, exact: true }),
    ).toBeVisible();
    await expect(
      patientPage
        .locator('.care-summary-allergies')
        .getByText('No known allergies recorded', { exact: true }),
    ).toBeVisible();
    await expect(
      patientPage.locator('#summary-allergies').getByText(sharedReason, { exact: true }),
    ).toBeVisible();
    await expect(
      patientPage.locator('#summary-allergies').getByText(concurrentReason, { exact: true }),
    ).toBeVisible();
    await expect(
      patientPage.locator('#summary-history').getByText(intakeReport, { exact: true }),
    ).toBeVisible();
    await expect(patientPage.getByText(privateReason, { exact: true })).toHaveCount(0);
    const summary = (await (await patient.request.get(summaryPath)).json()) as CareSummary;
    expect(summary.patient).toMatchObject({
      name: correctedName,
      email: contactEmail,
      dob: '',
      allergyStatus: 'none-known',
      allergies: '',
    });
    expect(summary.allergyHistory).toHaveLength(3);
    expect(summary.carePlans.find((entry) => entry.id === plan.id)?.patientName).toBe(originalName);
    expect(summary.invoices.find((entry) => entry.id === invoice.id)?.patientName).toBe(
      originalName,
    );
    expect(JSON.stringify(summary)).not.toContain(privateReason);
    const record = (await (
      await patient.request.get(`/api/patients/${patientId}`)
    ).json()) as PatientRecord;
    expect(record.patient.name).toBe(correctedName);
    expect(record.carePlans.find((entry) => entry.id === plan.id)?.patientName).toBe(originalName);
    await audit(patientPage);
    await patientPage.screenshot({
      path: testInfo.outputPath('patient-allergy-summary-mobile.png'),
      fullPage: true,
    });
  } finally {
    await clinician.close();
    await patient.close();
  }
});
