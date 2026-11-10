import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { CarePlan } from '../../shared/types';

const clinicDate = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
const after = (days: number) => {
  const date = new Date(`${clinicDate()}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
const displayDate = (date: string) =>
  new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(`${date}T12:00:00+05:30`));

test('patient reads shared follow-up instructions and completion while the original regimen stays intact', async ({
  page,
  playwright,
  baseURL,
}, testInfo) => {
  const doctor = await playwright.request.newContext({ baseURL });
  const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  try {
    const login = await doctor.post('/api/auth/login', {
      data: { email: 'doctor@derma.demo', password: 'DemoClinic2026!' },
    });
    expect(login.ok()).toBeTruthy();
    const headers = { 'X-CSRF-Token': (await login.json()).csrfToken };
    const title = `Patient follow-up journey ${suffix}`;
    const originalInstructions = `Original synthetic treatment instructions ${suffix}`;
    const medicationInstructions = `Original synthetic medication instructions ${suffix}`;
    const originalDate = after(7);
    const revisedDate = after(14);
    const endDate = after(30);
    const created = await doctor.post('/api/care-plans', {
      headers,
      data: {
        patientId: 'patient-ananya',
        title,
        instructions: originalInstructions,
        expectations: 'A synthetic record for workflow testing.',
        warnings: 'Synthetic documentation only.',
        startDate: clinicDate(),
        endDate,
        followUpDate: originalDate,
        medications: [
          {
            name: 'Synthetic regimen entry',
            instructions: medicationInstructions,
            schedule: 'Original recorded schedule',
            duration: 'Original recorded duration',
            warnings: '',
          },
        ],
      },
    });
    expect(created.status()).toBe(201);
    const plan = (await created.json()) as CarePlan;
    const currentPlan = async () => {
      const response = await doctor.get('/api/care-plans');
      expect(response.ok()).toBeTruthy();
      return ((await response.json()) as CarePlan[]).find((value) => value.id === plan.id)!;
    };

    await page.goto('/login');
    await page.getByLabel('Email address', { exact: true }).fill('patient@derma.demo');
    await page.getByLabel('Password', { exact: true }).fill('DemoClinic2026!');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/\/my-care$/);
    await page.goto(`/my-care?plan=${plan.id}`);
    const card = page.locator(`#care-plan-${plan.id}`);
    await expect(card).toBeFocused();
    await card.getByRole('button', { name: 'Daily check-in', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByLabel('Anything you want your clinic to know?', { exact: true })
      .fill(`Patient check-in for review ${suffix}`);
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Save check-in', exact: true })
      .click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(card.getByText('Today’s check-in is saved', { exact: true })).toBeVisible();

    const sharedInstructions = `Shared clinician follow-up instructions ${suffix}`;
    const internalAssessment = `PRIVATE clinician assessment ${suffix}`;
    const reviewed = await doctor.post(`/api/care-plans/${plan.id}/reviews`, {
      headers,
      data: {
        expectedRevision: (await currentPlan()).followUpRevision,
        assessment: internalAssessment,
        patientInstructions: sharedInstructions,
        disposition: 'visit-requested',
        nextReviewDate: revisedDate,
      },
    });
    expect(reviewed.status()).toBe(201);
    await page.reload();
    await expect(card).toBeFocused();
    await expect(card.getByText(sharedInstructions, { exact: true })).toBeVisible();
    await expect(card.getByText(originalInstructions, { exact: true })).toBeVisible();
    await expect(card.getByText(medicationInstructions, { exact: true })).toBeVisible();
    await expect(card.getByText('Original recorded duration', { exact: true })).toBeVisible();
    await expect(
      card.locator('.plan-facts').getByText(displayDate(revisedDate), { exact: true }),
    ).toBeVisible();
    await expect(
      card.locator('.plan-facts').getByText(displayDate(originalDate), { exact: true }),
    ).toHaveCount(0);
    await expect(card.getByText(new RegExp(displayDate(endDate)))).toBeVisible();
    await expect(
      card.getByRole('link', { name: 'Book requested visit', exact: true }),
    ).toHaveAttribute('href', `/book?doctor=${plan.doctorId}`);
    await expect(
      card.getByText(
        'Your clinician has requested a visit. Choose an appointment separately; this review does not reserve a slot.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.getByText(internalAssessment, { exact: true })).toHaveCount(0);

    const patientRecordResponse = await page.request.get('/api/patients/patient-ananya');
    expect(patientRecordResponse.ok()).toBeTruthy();
    const patientRecord = await patientRecordResponse.json();
    const patientPlan = patientRecord.carePlans.find((value: CarePlan) => value.id === plan.id);
    expect(patientPlan.followUpDate).toBe(originalDate);
    expect(patientPlan.effectiveFollowUpDate).toBe(revisedDate);
    expect(patientPlan.endDate).toBe(endDate);
    expect(patientPlan.medications[0].instructions).toBe(medicationInstructions);
    expect(JSON.stringify(patientRecord)).not.toContain(internalAssessment);
    expect(patientPlan.latestReview).not.toHaveProperty('assessment');
    expect(patientPlan.latestReview).not.toHaveProperty('checkInSnapshots');

    const completeInstructions = `Shared completion instructions ${suffix}`;
    const completed = await doctor.post(`/api/care-plans/${plan.id}/reviews`, {
      headers,
      data: {
        expectedRevision: (await currentPlan()).followUpRevision,
        assessment: `PRIVATE completion assessment ${suffix}`,
        patientInstructions: completeInstructions,
        disposition: 'complete',
        nextReviewDate: null,
      },
    });
    expect(completed.status()).toBe(201);
    await page.reload();
    await expect(
      page.getByRole('button', { name: 'Hide completed plans', exact: true }),
    ).toBeVisible();
    await expect(card).toBeFocused();
    await expect(card.getByText('completed', { exact: true })).toBeVisible();
    await expect(card.getByText(completeInstructions, { exact: true })).toBeVisible();
    await expect(card.getByText(medicationInstructions, { exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: /check-in/i })).toHaveCount(0);
    await expect(card.getByRole('link', { name: 'Book requested visit', exact: true })).toHaveCount(
      0,
    );
    await expect(
      card.locator('.plan-facts').getByText(displayDate(revisedDate), { exact: true }),
    ).toHaveCount(0);
    await card.getByRole('button', { name: 'Review history', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(completeInstructions, { exact: true })).toBeVisible();
    await expect(dialog.getByText(sharedInstructions, { exact: true })).toBeVisible();
    await expect(
      dialog
        .locator('.patient-shared-review')
        .first()
        .getByText(completeInstructions, { exact: true }),
    ).toBeVisible();
    const historyResponse = await page.request.get(`/api/care-plans/${plan.id}/reviews`);
    expect(historyResponse.ok()).toBeTruthy();
    const history = await historyResponse.json();
    expect(history).toHaveLength(2);
    for (const review of history) {
      expect(review).not.toHaveProperty('assessment');
      expect(review).not.toHaveProperty('checkInSnapshots');
      expect(review).not.toHaveProperty('assignment');
    }
    expect(JSON.stringify(history)).not.toContain('PRIVATE');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/my-care/record?tab=careplans&plan=${plan.id}`);
    await expect(page.getByLabel('Record section', { exact: true })).toHaveValue('plans');
    await expect(card.getByText(completeInstructions, { exact: true })).toBeVisible();
    await expect(card.getByText(originalInstructions, { exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBeTruthy();
    await page.waitForLoadState('networkidle');
    const audit = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(audit.violations).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath('patient-follow-up-mobile.png'),
      fullPage: true,
    });
  } finally {
    await doctor.dispose();
  }
});
