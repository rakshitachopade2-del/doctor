import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { CarePlan, ClinicSettings, Doctor } from '../../shared/types';
import type { FollowUpAssignment, FollowUpReview, FollowUpWorkItem } from '../../shared/follow-up';

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
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
}

test('follow-up reviews preserve report versions, reject stale context, share next steps, and honor module pauses', async ({
  page,
  playwright,
  baseURL,
}, testInfo) => {
  test.setTimeout(60000);
  const login = await page.request.post('/api/auth/login', {
    data: { email: 'admin@derma.demo', password: 'DemoClinic2026!' },
  });
  expect(login.ok()).toBeTruthy();
  const session = await login.json();
  const headers = { 'X-CSRF-Token': session.csrfToken };
  const originalSettings: ClinicSettings = await (await page.request.get('/api/settings')).json();
  const patient = await playwright.request.newContext({ baseURL });
  let moduleChanged = false;
  try {
    const patientLogin = await patient.post('/api/auth/login', {
      data: { email: 'patient@derma.demo', password: 'DemoClinic2026!' },
    });
    expect(patientLogin.ok()).toBeTruthy();
    const patientSession = await patientLogin.json();
    const patientHeaders = { 'X-CSRF-Token': patientSession.csrfToken };
    const title = `Follow-up loop ${Date.now()}`;
    const originalInstructions =
      'Original synthetic instructions. No treatment recommendations are made in this test.';
    const created = await page.request.post('/api/care-plans', {
      headers,
      data: {
        patientId: 'patient-ananya',
        title,
        instructions: originalInstructions,
        expectations: 'Synthetic documentation only.',
        warnings: 'Synthetic precautions.',
        cost: '',
        startDate: dateAfter(-2),
        endDate: dateAfter(1),
        followUpDate: clinicToday(),
        medications: [],
      },
    });
    expect(created.status()).toBe(201);
    const plan: CarePlan = await created.json();
    const ownerSuffix = Date.now();
    const newDoctorResponse = await page.request.post('/api/doctors', {
      headers,
      data: {
        name: `Dr. Handover ${ownerSuffix}`,
        title: 'Dermatologist',
        qualifications: 'Synthetic profile',
        specialties: ['General dermatology'],
        experience: 4,
        fee: 600,
        bio: 'Synthetic profile for ownership verification.',
        languages: ['English'],
      },
    });
    expect(newDoctorResponse.status()).toBe(201);
    const receivingDoctor: Doctor = await newDoctorResponse.json();
    const newAccount = await page.request.post('/api/users', {
      headers,
      data: {
        name: receivingDoctor.name,
        email: `handover-${ownerSuffix}@example.test`,
        password: 'HandoverFixture2026!',
        role: 'doctor',
        doctorId: receivingDoctor.id,
      },
    });
    expect(newAccount.status()).toBe(201);
    expect((await newAccount.json()).mustChangePassword).toBe(true);
    const checkIn = async (note: string, feeling: 'same' | 'worse' | 'better') => {
      const response = await patient.post('/api/check-ins', {
        headers: patientHeaders,
        data: { carePlanId: plan.id, date: clinicToday(), adherence: 'partial', feeling, note },
      });
      expect(response.ok()).toBeTruthy();
      return response.json();
    };
    const firstCheck = await checkIn('Initial synthetic patient report.', 'same');
    await page.goto('/clinic/follow-ups');
    const row = page.getByRole('row').filter({ hasText: title });
    await expect(row.getByText('1 unreviewed report', { exact: true })).toBeVisible();
    await row.getByRole('button', { name: 'Review progress', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'Review care plan progress', exact: true });
    await expect(
      dialog.getByText('Initial synthetic patient report.', { exact: true }),
    ).toBeVisible();
    const assessment = 'Clinician-only synthetic assessment based on the available patient report.';
    const patientInstructions =
      'Synthetic next steps: review the documented plan with the clinic at the requested follow-up.';
    await dialog.getByLabel('Clinician assessment', { exact: true }).fill(assessment);
    await dialog
      .getByLabel('Instructions for the patient', { exact: true })
      .fill(patientInstructions);
    await dialog.getByLabel('Next review date', { exact: true }).fill(dateAfter(7));
    await audit(page);
    const corrected = await checkIn(
      'Corrected report received while the review was open.',
      'worse',
    );
    expect(corrected.id).toBe(firstCheck.id);
    const rejected = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/care-plans/${plan.id}/reviews`) &&
        response.request().method() === 'POST',
    );
    await dialog
      .getByRole('button', { name: 'Save review & share instructions', exact: true })
      .click();
    expect((await rejected).status()).toBe(409);
    await expect(
      dialog.getByRole('button', { name: 'Save review & share instructions', exact: true }),
    ).toBeDisabled();
    await expect(dialog.getByLabel('Clinician assessment', { exact: true })).toHaveValue(
      assessment,
    );
    await dialog.getByRole('button', { name: 'Refresh review context', exact: true }).click();
    await expect(
      dialog.getByText('Corrected report received while the review was open.', { exact: true }),
    ).toBeVisible();
    await expect(dialog.getByLabel('Instructions for the patient', { exact: true })).toHaveValue(
      patientInstructions,
    );
    await dialog
      .getByRole('button', { name: 'Save review & share instructions', exact: true })
      .click();
    await expect(dialog).toBeHidden();
    await expect(row).toHaveCount(0);
    await page.getByRole('button', { name: 'Upcoming', exact: true }).click();
    await expect(row.getByText('No new reports', { exact: true })).toBeVisible();
    const worklist: FollowUpWorkItem[] = await (
      await page.request.get('/api/follow-up-worklist?scope=all')
    ).json();
    const reviewed = worklist.find((item) => item.carePlan.id === plan.id)!;
    expect(reviewed.carePlan).toMatchObject({
      endDate: dateAfter(1),
      followUpDate: clinicToday(),
      effectiveFollowUpDate: dateAfter(7),
      instructions: originalInstructions,
    });
    expect(reviewed.unreviewedCount).toBe(0);
    expect(reviewed.latestReview?.checkInSnapshots[0].snapshot.note).toBe(
      'Corrected report received while the review was open.',
    );
    const patientReviews = await (await patient.get(`/api/care-plans/${plan.id}/reviews`)).json();
    expect(patientReviews[0].patientInstructions).toBe(patientInstructions);
    expect(patientReviews[0]).not.toHaveProperty('assessment');
    expect(patientReviews[0]).not.toHaveProperty('checkInSnapshots');

    await checkIn('A later same-day update must re-enter the review queue.', 'better');
    await page.getByRole('button', { name: 'Refresh worklist', exact: true }).click();
    await page.getByRole('button', { name: 'New reports', exact: true }).click();
    await expect(row.getByText('1 unreviewed report', { exact: true })).toBeVisible();
    await row.getByRole('button', { name: 'Assign follow-up', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Assign follow-up owner', exact: true });
    await dialog
      .getByLabel('New follow-up owner', { exact: true })
      .selectOption(receivingDoctor.id);
    const handoverReason =
      'Synthetic handover for continuity while the original clinician is away.';
    await dialog.getByLabel('Reason for handover', { exact: true }).fill(handoverReason);
    await audit(page);
    await checkIn('Report amended during handover; still awaits clinical review.', 'better');
    const staleAssignment = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/care-plans/${plan.id}/assignment`) &&
        response.request().method() === 'POST',
    );
    await dialog.getByRole('button', { name: 'Save assignment', exact: true }).click();
    expect((await staleAssignment).status()).toBe(409);
    await expect(
      dialog.getByRole('button', { name: 'Save assignment', exact: true }),
    ).toBeDisabled();
    await dialog.getByRole('button', { name: 'Refresh assignment context', exact: true }).click();
    await expect(dialog.getByLabel('Reason for handover', { exact: true })).toHaveValue(
      handoverReason,
    );
    await dialog.getByRole('button', { name: 'Save assignment', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(row.getByText(`Owner: ${receivingDoctor.name}`, { exact: true })).toBeVisible();
    await expect(row.getByText('1 unreviewed report', { exact: true })).toBeVisible();
    await page.getByLabel('Plan owner', { exact: true }).selectOption('mine');
    await expect(row).toHaveCount(0);
    await page.getByLabel('Plan owner', { exact: true }).selectOption('all');
    await expect(row).toBeVisible();
    const assignedWorklist: FollowUpWorkItem[] = await (
      await page.request.get('/api/follow-up-worklist?scope=all')
    ).json();
    const assignedItem = assignedWorklist.find((item) => item.carePlan.id === plan.id)!;
    expect(assignedItem.ownerDoctorId).toBe(receivingDoctor.id);
    expect(assignedItem.carePlan.doctorId).toBe(plan.doctorId);
    expect(assignedItem.unreviewedCount).toBe(1);
    const assignments: FollowUpAssignment[] = await (
      await page.request.get(`/api/care-plans/${plan.id}/assignments`)
    ).json();
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({
      doctorId: receivingDoctor.id,
      previousDoctorId: plan.doctorId,
      reason: handoverReason,
    });
    expect((await patient.get(`/api/care-plans/${plan.id}/assignments`)).status()).toBe(403);
    const paused = await page.request.patch('/api/settings', {
      headers,
      data: { modules: { ...originalSettings.modules, followUp: false } },
    });
    expect(paused.ok()).toBeTruthy();
    moduleChanged = true;
    await page.reload();
    await page.getByRole('button', { name: 'New reports', exact: true }).click();
    await expect(row.getByRole('button', { name: 'Review progress', exact: true })).toBeDisabled();
    await expect(page.getByText(/Follow-up activity is paused/)).toBeVisible();
    await expect(row.getByRole('button', { name: 'Assign follow-up', exact: true })).toBeEnabled();
    await row.getByRole('link', { name: 'View plan', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`tab=care&plan=${plan.id}`));
    const card = page.locator(`[id="care-plan-${plan.id}"]`);
    await expect(page.getByRole('tab', { name: 'Care plans', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(card.getByText(patientInstructions, { exact: true })).toBeVisible();
    await expect(
      card.locator('.fu-owner-current').getByText(receivingDoctor.name, { exact: true }),
    ).toBeVisible();
    await card
      .locator('.fu-owner-panel')
      .getByText('Responsibility history (1)', { exact: true })
      .click();
    await expect(card.getByText(handoverReason, { exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Review progress', exact: true })).toBeDisabled();
    const blocked = await page.request.post(`/api/care-plans/${plan.id}/reviews`, {
      headers,
      data: {
        expectedRevision: reviewed.revision,
        assessment: 'Blocked draft',
        patientInstructions: 'Blocked instructions',
        disposition: 'complete',
      },
    });
    expect(blocked.status()).toBe(403);
    const resumed = await page.request.patch('/api/settings', {
      headers,
      data: { modules: originalSettings.modules },
    });
    expect(resumed.ok()).toBeTruthy();
    moduleChanged = false;
    await page.reload();
    await card.getByRole('button', { name: 'Review progress', exact: true }).click();
    dialog = page.getByRole('dialog');
    await expect(
      dialog.getByText('Report amended during handover; still awaits clinical review.', {
        exact: true,
      }),
    ).toBeVisible();
    await dialog
      .getByLabel('Clinician assessment', { exact: true })
      .fill('Final synthetic review preserves the updated report.');
    await dialog
      .getByLabel('Instructions for the patient', { exact: true })
      .fill(
        'This synthetic care plan is complete. Contact the clinic to discuss any further care.',
      );
    await dialog.getByLabel('Review outcome', { exact: true }).selectOption('complete');
    await expect(dialog.getByLabel('Next review date', { exact: true })).toHaveCount(0);
    await dialog
      .getByRole('button', { name: 'Save review & share instructions', exact: true })
      .click();
    await expect(dialog).toBeHidden();
    await expect(card.getByText('Completed', { exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Review progress', exact: true })).toHaveCount(0);
    const history: FollowUpReview[] = await (
      await page.request.get(`/api/care-plans/${plan.id}/reviews`)
    ).json();
    expect(history).toHaveLength(2);
    expect(
      history.flatMap((review) =>
        review.checkInSnapshots.map((snapshot) => snapshot.snapshot.note),
      ),
    ).toEqual(
      expect.arrayContaining([
        'Corrected report received while the review was open.',
        'Report amended during handover; still awaits clinical review.',
      ]),
    );
    await audit(page);
    await page.screenshot({
      path: testInfo.outputPath('follow-up-review-history.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await audit(page);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBeTruthy();
    await page.screenshot({
      path: testInfo.outputPath('follow-up-review-mobile.png'),
      fullPage: true,
    });
    await page.goto('/clinic/follow-ups');
    await page.getByRole('button', { name: 'Completed', exact: true }).click();
    await expect(row.getByText('Completed', { exact: true })).toBeVisible();
    await audit(page);
  } finally {
    if (moduleChanged)
      await page.request.patch('/api/settings', {
        headers,
        data: { modules: originalSettings.modules },
      });
    await patient.dispose();
  }
});
