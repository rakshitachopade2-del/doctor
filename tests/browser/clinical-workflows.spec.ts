import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { PatientClinicalWorkflows } from '../../shared/clinical';
import { syntheticPdf } from '../fixtures/report';

async function audit(page: Page) {
  await page.waitForLoadState('networkidle');
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

test('clinician preserves amendments, reviews attached results, and documents a patient decision before procedure completion', async ({
  page,
}, testInfo) => {
  test.setTimeout(60000);
  const login = await page.request.post('/api/auth/login', {
    data: { email: 'doctor@derma.demo', password: 'DemoClinic2026!' },
  });
  expect(login.ok()).toBeTruthy();
  const session = await login.json();
  const headers = { 'X-CSRF-Token': session.csrfToken };
  const name = `Clinical Workflow ${Date.now()}`;
  const patientResponse = await page.request.post('/api/patients', {
    headers,
    data: {
      name,
      email: '',
      phone: '+91 9000000004',
      dob: '',
      gender: 'Not specified',
      allergies: '',
    },
  });
  expect(patientResponse.ok()).toBeTruthy();
  const patient = await patientResponse.json();
  const originalAssessment =
    'Original synthetic assessment preserved for documentation verification.';
  const encounterResponse = await page.request.post('/api/encounters', {
    headers,
    data: {
      patientId: patient.id,
      assessment: originalAssessment,
      plan: 'Synthetic plan for testing only.',
    },
  });
  expect(encounterResponse.ok()).toBeTruthy();
  const encounter = await encounterResponse.json();
  const readWorkflow = async (): Promise<PatientClinicalWorkflows> => {
    const response = await page.request.get(`/api/patients/${patient.id}/clinical-workflows`);
    expect(response.ok()).toBeTruthy();
    return response.json();
  };

  await page.goto(`/clinic/patients/${patient.id}`);
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await page.getByRole('tab', { name: /^Visits/ }).click();
  await expect(page.getByText(originalAssessment, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add amendment', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog
    .getByLabel('Reason for amendment', { exact: true })
    .fill('Clarify the source of the history');
  const correction =
    'Additional synthetic history was supplied by the patient after the initial note.';
  await dialog.getByLabel('Correction or additional information', { exact: true }).fill(correction);
  await dialog.getByRole('button', { name: 'Save amendment', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(correction, { exact: true })).toBeVisible();
  await expect(page.getByText(originalAssessment, { exact: true })).toBeVisible();

  await page.getByRole('tab', { name: 'Clinical workup', exact: true }).click();
  await page.getByRole('button', { name: 'Order investigation', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Investigation name', { exact: true }).fill('Synthetic investigation');
  await dialog.getByLabel('Investigation type', { exact: true }).selectOption('other');
  await dialog
    .getByLabel('Clinical question / reason', { exact: true })
    .fill('Verify structured documentation with a synthetic report.');
  await dialog
    .getByLabel('Instructions for the patient', { exact: true })
    .fill('Upload the synthetic report through the portal. No real investigation requested.');
  await dialog.getByRole('button', { name: 'Save investigation order', exact: true }).click();
  await expect(dialog).toBeHidden();
  const investigation = page
    .locator('.cw-investigation')
    .filter({ has: page.getByRole('heading', { name: 'Synthetic investigation', exact: true }) });
  await expect(investigation).toBeVisible();
  await investigation.getByRole('button', { name: 'Add result', exact: true }).click();
  dialog = page.getByRole('dialog');
  const sourceNote =
    'Received a synthetic PDF from the test patient. Interpretation is recorded separately.';
  await dialog.getByLabel('Result entry / source note', { exact: true }).fill(sourceNote);
  await dialog.getByRole('button', { name: 'Upload report', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Upload PDF report', exact: true });
  await dialog.getByLabel('PDF file', { exact: true }).setInputFiles({
    name: 'synthetic-clinical-report.pdf',
    mimeType: 'application/pdf',
    buffer: syntheticPdf(),
  });
  await dialog.getByLabel('Report title', { exact: true }).fill('Synthetic source report');
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Add report to record', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Add an investigation result', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Result entry / source note', { exact: true })).toHaveValue(
    sourceNote,
  );
  await expect(dialog.getByRole('checkbox', { name: /Synthetic source report/ })).toBeChecked();
  await dialog.getByRole('button', { name: 'Save result entry', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(
    investigation.getByRole('link', { name: 'Synthetic source report', exact: true }),
  ).toBeVisible();
  await investigation.getByRole('button', { name: 'Review this result', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog
    .getByLabel('Reviewed findings', { exact: true })
    .fill('Clinician-entered synthetic review. This document contains no real clinical findings.');
  await dialog
    .getByLabel('Follow-up and next steps', { exact: true })
    .fill('Discuss the synthetic documentation workflow at the next visit.');
  await expect(dialog.getByRole('checkbox')).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Save clinical review', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(investigation.getByText('Clinic only', { exact: true })).toBeVisible();
  expect((await readWorkflow()).investigations[0].reviews[0].publishedAt).toBeNull();
  await investigation.getByRole('button', { name: 'Share reviewed findings', exact: true }).click();
  await expect(investigation.getByText('Shared with patient', { exact: true })).toBeVisible();
  expect((await readWorkflow()).investigations[0].reviews[0].publishedAt).toBeTruthy();
  await expect(
    investigation.getByRole('button', { name: 'Cancel order', exact: true }),
  ).toHaveCount(0);

  await page.getByRole('button', { name: 'Plan procedure', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Procedure name', { exact: true }).fill('Synthetic procedure workflow');
  await dialog
    .getByLabel('Indication / reason', { exact: true })
    .fill('Synthetic indication for end-to-end documentation testing.');
  await dialog
    .getByLabel('Expected benefits', { exact: true })
    .fill('Verify the clinician can record the discussion.');
  await dialog
    .getByLabel('Risks to discuss', { exact: true })
    .fill('Synthetic risk discussion; no real procedure is proposed.');
  await dialog
    .getByLabel('Alternatives to discuss', { exact: true })
    .fill('Synthetic alternative discussed with the test patient.');
  await dialog
    .getByLabel('Planned aftercare instructions', { exact: true })
    .fill('Synthetic aftercare instructions; no treatment advice.');
  await dialog
    .getByLabel('Estimated cost', { exact: true })
    .fill('No charge for this synthetic test');
  await dialog.getByRole('button', { name: 'Save procedure plan', exact: true }).click();
  await expect(dialog).toBeHidden();
  const procedure = page.locator('.cw-procedure').filter({
    has: page.getByRole('heading', { name: 'Synthetic procedure workflow', exact: true }),
  });
  await expect(
    procedure.getByRole('button', { name: 'Document completion', exact: true }),
  ).toBeDisabled();
  for (const decision of ['declined', 'agreed']) {
    await procedure.getByRole('button', { name: 'Record patient decision', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('Patient decision', { exact: true }).selectOption(decision);
    await dialog
      .getByLabel('Discussion method', { exact: true })
      .selectOption(decision === 'declined' ? 'phone' : 'in-person');
    await dialog
      .getByLabel('Discussion and decision notes', { exact: true })
      .fill(`The test patient ${decision} after the synthetic discussion.`);
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: 'Save patient decision', exact: true }).click();
    await expect(dialog).toBeHidden();
    if (decision === 'declined')
      await expect(
        procedure.getByRole('button', { name: 'Document completion', exact: true }),
      ).toBeDisabled();
  }
  await expect(procedure.locator('.cw-decision')).toHaveCount(2);
  await procedure.getByRole('button', { name: 'Document completion', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog
    .getByLabel('Procedure outcome and notes', { exact: true })
    .fill('Synthetic workflow completed. No actual procedure was performed.');
  await dialog
    .getByLabel('Final aftercare instructions', { exact: true })
    .fill('Synthetic final instructions recorded and shared with the test patient.');
  await dialog.getByRole('button', { name: 'Save procedure completion', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(procedure.getByText('Completed', { exact: true })).toBeVisible();
  await expect(
    procedure.getByRole('button', { name: 'Record patient decision', exact: true }),
  ).toHaveCount(0);

  await page.reload();
  await page.getByRole('tab', { name: 'Clinical workup', exact: true }).click();
  await expect(procedure.getByText('Completed', { exact: true })).toBeVisible();
  await expect(investigation.getByText('Shared with patient', { exact: true })).toBeVisible();
  const stored = await readWorkflow();
  expect(stored.procedures[0].agreements.map((record) => record.decision)).toEqual([
    'declined',
    'agreed',
  ]);
  expect(stored.investigations[0].results[0].documentIds).toHaveLength(1);
  expect(stored.amendments[0]).toMatchObject({ encounterId: encounter.id, text: correction });
  const record = await (await page.request.get(`/api/patients/${patient.id}`)).json();
  expect(record.encounters[0].assessment).toBe(originalAssessment);

  await audit(page);
  await page.screenshot({
    path: testInfo.outputPath('clinical-workup-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await audit(page);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  await page.screenshot({
    path: testInfo.outputPath('clinical-workup-mobile.png'),
    fullPage: true,
  });
  await page.getByRole('tab', { name: /^Visits/ }).click();
  await expect(page.getByText(originalAssessment, { exact: true })).toBeVisible();
  await expect(page.getByText(correction, { exact: true })).toBeVisible();
  await audit(page);
});
