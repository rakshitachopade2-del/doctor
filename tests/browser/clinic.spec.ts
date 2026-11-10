import { test, expect, type Page } from '@playwright/test';

const demoPassword = 'DemoClinic2026!';
const unique = () => `${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
const dateAfter = (days: number) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
async function login(page: Page, email = 'doctor@derma.demo') {
  await page.goto('/login');
  await page.getByLabel('Email address', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(demoPassword);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/clinic$/);
}
async function availableDate(page: Page, doctorId: string, start: number) {
  for (let offset = start; offset < start + 10; offset++) {
    const date = dateAfter(offset);
    const response = await page.request.get(`/api/slots?doctorId=${doctorId}&date=${date}`);
    const slots: string[] = await response.json();
    if (slots.length) return date;
  }
  throw new Error('No available appointment date found for browser fixture');
}

test('clinician documents a full longitudinal care journey with private images and patient messaging', async ({
  page,
}) => {
  await login(page);
  const patientName = `Browser Patient ${unique()}`;
  await page.goto('/clinic/patients');
  await page.getByRole('button', { name: 'Add patient', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Full name', { exact: true }).fill(patientName);
  await dialog.getByLabel('Phone number', { exact: true }).fill('+91 9000000000');
  await dialog
    .getByLabel('Known allergies', { exact: true })
    .fill('Patient reports no known allergies. Verify during consultation.');
  await dialog.getByRole('button', { name: 'Register patient', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('link', { name: patientName, exact: true }).click();
  await expect(page.getByRole('heading', { name: patientName, exact: true })).toBeVisible();
  const patientUrl = page.url();

  await page.getByRole('button', { name: 'Add visit note', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog
    .getByLabel('History', { exact: true })
    .fill('Synthetic patient history for automated verification.');
  await dialog
    .getByLabel('Examination', { exact: true })
    .fill('Synthetic examination observation.');
  await dialog
    .getByLabel('Assessment', { exact: true })
    .fill('Documentation workflow test; no diagnosis.');
  await dialog
    .getByLabel('Investigations', { exact: true })
    .fill('No investigations requested in this test.');
  await dialog
    .getByLabel('Plan and next steps', { exact: true })
    .fill('Review patient-reported progress at follow-up.');
  await dialog.getByRole('button', { name: 'Save clinical note', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByText('Documentation workflow test; no diagnosis.', { exact: true }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Care plan', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Plan title', { exact: true }).fill('Browser-tested care plan');
  await dialog
    .getByLabel('Instructions', { exact: true })
    .fill('Synthetic instructions: follow the clinic-reviewed plan.');
  await dialog
    .getByLabel('What to expect', { exact: true })
    .fill('A clinician will review reported progress.');
  await dialog
    .getByLabel('Precautions and when to contact the clinic', { exact: true })
    .fill('Test documentation only. Contact the clinic for clarification.');
  await dialog.getByRole('button', { name: 'Add item', exact: true }).click();
  await dialog
    .getByLabel('Medication / treatment name', { exact: true })
    .fill('Synthetic treatment step');
  await dialog
    .getByLabel('Dose and instructions', { exact: true })
    .fill('No medicine prescribed in this test.');
  await dialog.getByLabel('Schedule', { exact: true }).fill('As discussed with the clinician');
  await dialog.getByLabel('Duration', { exact: true }).fill('Until next review');
  await dialog.getByRole('button', { name: 'Save and share care plan', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole('heading', { name: 'Browser-tested care plan', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Synthetic treatment step', { exact: true })).toBeVisible();

  await page.getByRole('tab', { name: 'Images & reports', exact: true }).click();
  for (const caption of ['Baseline synthetic image', 'Follow-up synthetic image']) {
    await page.getByRole('button', { name: 'Add image', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.locator('input[type=file]').setInputFiles({
      name: 'test-image.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cWb0AAAAASUVORK5CYII=',
        'base64',
      ),
    });
    await dialog.getByLabel('Caption', { exact: true }).fill(caption);
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: 'Upload privately', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: new RegExp(caption) })).toBeVisible();
  }
  await page.getByRole('button', { name: /Baseline synthetic image/ }).click();
  await page.getByRole('button', { name: /Follow-up synthetic image/ }).click();
  await expect(page.locator('.clinic-image-comparison figure')).toHaveCount(2);
  await page.getByRole('button', { name: 'Clear comparison', exact: true }).click();
  await expect(page.locator('.clinic-image-comparison')).toHaveCount(0);

  await page.getByRole('tab', { name: 'Messages', exact: true }).click();
  await page
    .getByLabel('Message to patient', { exact: true })
    .fill('Your test care plan is ready for review in the patient portal.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(
    page.getByText('Your test care plan is ready for review in the patient portal.', {
      exact: true,
    }),
  ).toBeVisible();
  await page.goto(patientUrl);
  await page.getByRole('tab', { name: 'Care plans', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Browser-tested care plan', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Mark plan complete', exact: true }).click();
  await expect(page.getByText('Completed', { exact: true })).toBeVisible();
});

test('clinic appointment booking, rescheduling, calendar download and cancellation persist', async ({
  page,
}) => {
  await login(page);
  const doctors = await (await page.request.get('/api/doctors')).json();
  const patients = await (await page.request.get('/api/patients')).json();
  const session = await (await page.request.get('/api/session')).json();
  const patientName = `Booking Patient ${unique()}`;
  const patientResponse = await page.request.post('/api/patients', {
    headers: { 'X-CSRF-Token': session.csrfToken },
    data: {
      name: patientName,
      phone: '+91 9000000001',
      email: '',
      dob: '',
      gender: 'Not specified',
      allergies: '',
    },
  });
  expect(patientResponse.ok()).toBeTruthy();
  const patient = await patientResponse.json();
  const date = await availableDate(page, doctors[0].id, 4);
  const newDate = await availableDate(page, doctors[0].id, 12);
  const reason = `Booking workflow ${unique()}`;
  await page.goto('/clinic/appointments?new=1');
  let dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox', { name: 'Patient', exact: true }).selectOption(patient.id);
  await dialog.getByRole('combobox', { name: 'Doctor', exact: true }).selectOption(doctors[0].id);
  await dialog.getByLabel('Date', { exact: true }).fill(date);
  await dialog.locator('.clinic-time-slot').first().click();
  await dialog.getByLabel('Reason for visit', { exact: true }).fill(reason);
  await dialog.getByRole('button', { name: 'Book appointment', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel('Appointment date', { exact: true })).toHaveValue(date);
  const row = page.getByRole('row').filter({ hasText: reason });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: `More actions for ${patientName}`, exact: true }).click();
  dialog = page.getByRole('dialog');
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('link', { name: 'Download calendar event', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('appointment.ics');
  await dialog.getByRole('button', { name: 'Reschedule appointment', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Date', { exact: true }).fill(newDate);
  await dialog.locator('.clinic-time-slot').first().click();
  await dialog.getByRole('button', { name: 'Save new time', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel('Appointment date', { exact: true })).toHaveValue(newDate);
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: `More actions for ${patientName}`, exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Cancel appointment', exact: true })
    .click();
  await expect(row.getByText('Cancelled', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByLabel('Appointment date', { exact: true }).fill(newDate);
  await expect(row.getByText('Cancelled', { exact: true })).toBeVisible();
  expect(patients.length).toBeGreaterThan(0);
});

test('reception is limited to demographics and dialogs support keyboard dismissal and focus return', async ({
  page,
}) => {
  await login(page, 'reception@derma.demo');
  await page.goto('/clinic/patients');
  await expect(page.getByText('Demographics only', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open record', exact: false })).toHaveCount(0);
  const addButton = page.getByRole('button', { name: 'Add patient', exact: true });
  await addButton.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Known allergies', { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Close dialog', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Register patient', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(addButton).toBeFocused();
  const patients = await (await page.request.get('/api/patients')).json();
  const denied = await page.request.get(`/api/patients/${patients[0].id}`);
  expect(denied.status()).toBe(403);
  await page.goto(`/clinic/patients/${patients[0].id}`);
  await expect(page).toHaveURL(/\/clinic$/);
});
