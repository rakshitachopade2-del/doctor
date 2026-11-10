import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { syntheticPdf } from '../fixtures/report';

test('patient shares a private report, reads a published review, and records a procedure decision', async ({
  page,
  playwright,
  baseURL,
}, testInfo) => {
  const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
  const doctor = await playwright.request.newContext({ baseURL });
  try {
    const login = await doctor.post('/api/auth/login', {
      data: { email: 'doctor@derma.demo', password: 'DemoClinic2026!' },
    });
    expect(login.ok()).toBeTruthy();
    const doctorSession = await login.json();
    const headers = { 'X-CSRF-Token': doctorSession.csrfToken };
    const investigationTitle = `Patient report review ${suffix}`;
    const procedureTitle = `Patient procedure discussion ${suffix}`;
    const created = await doctor.post('/api/investigations', {
      headers,
      data: {
        patientId: 'patient-ananya',
        title: investigationTitle,
        kind: 'laboratory',
        reason: 'Synthetic workflow request for a clinician review.',
        instructions: 'Share the synthetic report in your patient record.',
        dueDate: null,
      },
    });
    expect(created.status()).toBe(201);
    const investigation = await created.json();
    const planned = await doctor.post('/api/procedures', {
      headers,
      data: {
        patientId: 'patient-ananya',
        title: procedureTitle,
        indication: 'Synthetic documentation workflow only.',
        benefits: 'Example benefit discussed with the patient.',
        risks: 'Example risks for documentation testing.',
        alternatives: 'Discuss alternatives during the clinic visit.',
        aftercare: 'Original synthetic aftercare instructions.',
        estimatedCost: 'Discuss with the clinic before proceeding.',
      },
    });
    expect(planned.status()).toBe(201);
    const procedure = await planned.json();

    await page.goto('/login');
    await page.getByLabel('Email address', { exact: true }).fill('patient@derma.demo');
    await page.getByLabel('Password', { exact: true }).fill('DemoClinic2026!');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/\/my-care$/);
    await page.goto('/my-care/record');
    await page.getByRole('tab', { name: 'Tests & procedures', exact: true }).click();
    const investigationCard = page
      .locator('.patient-investigation-card')
      .filter({ has: page.getByRole('heading', { name: investigationTitle, exact: true }) });
    await expect(investigationCard.getByText('Awaiting result', { exact: true })).toBeVisible();
    await investigationCard.getByRole('button', { name: 'Share result', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByLabel('Result note', { exact: true })
      .fill(`Patient report context ${suffix}`);
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Upload a PDF report', exact: true })
      .click();
    let dialog = page.getByRole('dialog');
    await expect(
      dialog.getByRole('heading', { name: 'Upload PDF report', exact: true }),
    ).toBeVisible();
    await dialog.getByLabel('PDF file', { exact: true }).setInputFiles({
      name: 'patient-synthetic-report.pdf',
      mimeType: 'application/pdf',
      buffer: syntheticPdf(),
    });
    const reportTitle = `Patient uploaded PDF ${suffix}`;
    await dialog.getByLabel('Report title', { exact: true }).fill(reportTitle);
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: 'Add report to record', exact: true }).click();
    dialog = page.getByRole('dialog');
    await expect(
      dialog.getByRole('heading', { name: 'Share an investigation result', exact: true }),
    ).toBeVisible();
    await expect(dialog.getByLabel('Result note', { exact: true })).toHaveValue(
      `Patient report context ${suffix}`,
    );
    await expect(
      dialog
        .locator('.patient-result-document')
        .filter({ hasText: reportTitle })
        .getByRole('checkbox'),
    ).toBeChecked();
    await dialog.getByRole('button', { name: 'Share result with clinic', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(investigationCard.getByText('With your care team', { exact: true })).toBeVisible();
    await expect(
      investigationCard.getByText('Patient-submitted result', { exact: true }),
    ).toBeVisible();
    await expect(
      investigationCard.getByText('No review shared yet', { exact: true }),
    ).toBeVisible();
    const downloadPromise = page.waitForEvent('download');
    await investigationCard
      .getByRole('link', { name: `${reportTitle} PDF report`, exact: true })
      .click();
    expect((await downloadPromise).suggestedFilename()).toMatch(/^clinic-report-.*\.pdf$/);

    const full = await (await doctor.get(`/api/patients/patient-ananya/clinical-workflows`)).json();
    const savedInvestigation = full.investigations.find(
      (item: { id: string }) => item.id === investigation.id,
    );
    expect(savedInvestigation.results).toHaveLength(1);
    expect(savedInvestigation.results[0].documentIds).toHaveLength(1);
    const reviewSummary = `Clinician-reviewed summary ${suffix}`;
    const review = await doctor.post(`/api/investigations/${investigation.id}/reviews`, {
      headers,
      data: {
        resultId: savedInvestigation.results[0].id,
        summary: reviewSummary,
        followUp: 'Discuss the reviewed report at the next clinic visit.',
        publishToPatient: false,
      },
    });
    expect(review.status()).toBe(201);
    const savedReview = (await review.json()).reviews.at(-1);
    await page.getByRole('button', { name: 'Refresh updates', exact: true }).click();
    await expect(investigationCard.getByText(reviewSummary, { exact: true })).toHaveCount(0);
    const patientAggregate = await (
      await page.request.get('/api/patients/patient-ananya/clinical-workflows')
    ).json();
    expect(JSON.stringify(patientAggregate)).not.toContain(reviewSummary);
    expect(patientAggregate.amendments).toEqual([]);
    const published = await doctor.post(
      `/api/investigations/${investigation.id}/reviews/${savedReview.id}/publish`,
      { headers, data: {} },
    );
    expect(published.ok()).toBeTruthy();
    await page.getByRole('button', { name: 'Refresh updates', exact: true }).click();
    await expect(investigationCard.getByText(reviewSummary, { exact: true })).toBeVisible();
    await expect(
      investigationCard.getByRole('heading', { name: 'Clinician review', exact: true }),
    ).toBeVisible();

    const procedureCard = page
      .locator('.patient-procedure-card')
      .filter({ has: page.getByRole('heading', { name: procedureTitle, exact: true }) });
    await procedureCard.getByRole('button', { name: 'Review and decide', exact: true }).click();
    dialog = page.getByRole('dialog');
    await expect(
      dialog.getByText('Example risks for documentation testing.', { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Record my decision', exact: true }),
    ).toBeDisabled();
    await dialog.getByLabel('Your decision', { exact: true }).selectOption('declined');
    await dialog
      .getByLabel('Note for your clinic', { exact: true })
      .fill('I would like to discuss this first.');
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: 'Record my decision', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(
      procedureCard.getByText('Latest recorded choice: Declined', { exact: true }),
    ).toBeVisible();
    await procedureCard.getByRole('button', { name: 'Update my decision', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('Your decision', { exact: true }).selectOption('agreed');
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: 'Record my decision', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(
      procedureCard.getByText('Latest recorded choice: Agreed', { exact: true }),
    ).toBeVisible();
    await procedureCard.getByText('View previous recorded choices', { exact: true }).click();
    await expect(
      procedureCard.getByText('I would like to discuss this first.', { exact: true }),
    ).toBeVisible();
    const completed = await doctor.post(`/api/procedures/${procedure.id}/complete`, {
      headers,
      data: {
        outcome: 'Synthetic completed procedure record.',
        aftercare: 'Updated synthetic aftercare shared by the clinician.',
      },
    });
    expect(completed.ok()).toBeTruthy();
    await page.getByRole('button', { name: 'Refresh updates', exact: true }).click();
    await expect(
      procedureCard.getByRole('heading', { name: 'Procedure completed', exact: true }),
    ).toBeVisible();
    await expect(
      procedureCard.getByText('Updated synthetic aftercare shared by the clinician.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      procedureCard.getByRole('button', { name: 'Update my decision', exact: true }),
    ).toHaveCount(0);
    await page.reload();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByLabel('Record section', { exact: true }).selectOption('workflows');
    await expect(
      procedureCard.getByText('Latest recorded choice: Agreed', { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBeTruthy();
    await page.waitForLoadState('networkidle');
    const workflowAudit = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(workflowAudit.violations).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath('patient-workflows-mobile.png'),
      fullPage: true,
    });
    await page.getByLabel('Record section', { exact: true }).selectOption('images');
    await expect(
      page.getByRole('heading', { name: 'Private PDF reports', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: reportTitle, exact: true })).toBeVisible();
    await page.waitForLoadState('networkidle');
    const reportsAudit = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(reportsAudit.violations).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath('patient-reports-mobile.png'),
      fullPage: true,
    });
  } finally {
    await doctor.dispose();
  }
});
