import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { Doctor, Appointment } from '../../shared/types';
import type { WaitlistEntry } from '../../shared/waitlist';

const clinicToday = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
function shiftDate(value: string, days: number) {
  const date = new Date(`${value}T12:00:00Z`);
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

test('reception records a waitlist request, confirms a slot, and preserves booked and withdrawn history', async ({
  page,
}, testInfo) => {
  test.setTimeout(60000);
  const login = await page.request.post('/api/auth/login', {
    data: { email: 'reception@derma.demo', password: 'DemoClinic2026!' },
  });
  expect(login.ok()).toBeTruthy();
  const session = await login.json();
  const headers = { 'X-CSRF-Token': session.csrfToken };
  const doctors: Doctor[] = await (await page.request.get('/api/doctors')).json();
  const doctor = doctors[0];
  let date = '';
  for (let offset = 20; offset < 32; offset++) {
    const candidate = shiftDate(clinicToday(), offset);
    const slots: string[] = await (
      await page.request.get(`/api/slots?doctorId=${doctor.id}&date=${candidate}&mode=online`)
    ).json();
    if (slots.length >= 2) {
      date = candidate;
      break;
    }
  }
  expect(date).not.toBe('');
  const endDate = shiftDate(date, 2);
  const patientResponse = await page.request.post('/api/patients', {
    headers,
    data: {
      name: `Waitlist Patient ${Date.now()}`,
      email: '',
      phone: '+91 9000000008',
      dob: '',
      gender: 'Not specified',
    },
  });
  expect(patientResponse.status()).toBe(201);
  const patient = await patientResponse.json();
  const reason = `Synthetic waitlist visit ${Date.now()}`;
  await page.goto('/clinic/waitlist');
  async function requestVisit(visitReason: string) {
    await page.getByRole('button', { name: 'Add to waitlist', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Patient', { exact: true }).selectOption(patient.id);
    await dialog.getByLabel('Requested doctor', { exact: true }).selectOption(doctor.id);
    await dialog.getByLabel('Consultation mode', { exact: true }).selectOption('online');
    await dialog.getByLabel('Earliest acceptable date', { exact: true }).fill(date);
    await dialog.getByLabel('Latest acceptable date', { exact: true }).fill(endDate);
    await dialog.getByLabel('Reason for requested visit', { exact: true }).fill(visitReason);
    await dialog.getByRole('button', { name: 'Save waitlist request', exact: true }).click();
    await expect(dialog).toBeHidden();
  }
  await requestVisit(reason);
  const row = page.getByRole('row').filter({ hasText: reason });
  await expect(row.getByText('Waiting', { exact: true })).toBeVisible();
  await page.getByLabel('Search waitlist', { exact: true }).fill(patient.name);
  await page.getByLabel('Filter by doctor', { exact: true }).selectOption(doctor.id);
  await expect(row).toBeVisible();
  await expect(page.getByRole('link', { name: /Open record/ })).toHaveCount(0);
  expect((await page.request.get(`/api/patients/${patient.id}`)).status()).toBe(403);
  await row.getByRole('button', { name: 'Find a slot', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Book a confirmed waitlist visit', exact: true });
  await expect(dialog.getByLabel('Patient', { exact: true })).toBeDisabled();
  await expect(dialog.getByLabel('Doctor', { exact: true })).toBeDisabled();
  await expect(dialog.getByLabel('Consultation mode', { exact: true })).toBeDisabled();
  await expect(dialog.getByLabel('Date', { exact: true })).toHaveAttribute('min', date);
  await expect(dialog.getByLabel('Date', { exact: true })).toHaveAttribute('max', endDate);
  await dialog.locator('.clinic-time-slot').first().click();
  await expect(
    dialog.getByRole('button', { name: 'Book confirmed visit', exact: true }),
  ).toBeDisabled();
  const confirmation = dialog.getByRole('checkbox', { name: /confirmed this specific date/ });
  await confirmation.check();
  await expect(
    dialog.getByRole('button', { name: 'Book confirmed visit', exact: true }),
  ).toBeEnabled();
  await dialog.locator('.clinic-time-slot').nth(1).click();
  await expect(confirmation).not.toBeChecked();
  await expect(
    dialog.getByRole('button', { name: 'Book confirmed visit', exact: true }),
  ).toBeDisabled();
  await confirmation.check();
  await audit(page);
  await dialog.getByRole('button', { name: 'Book confirmed visit', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(row.getByText('Booked', { exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Find a slot', exact: true })).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Withdraw request', exact: true })).toHaveCount(0);
  const entries: WaitlistEntry[] = await (await page.request.get('/api/waitlist')).json();
  const booked = entries.find((entry) => entry.reason === reason)!;
  expect(booked).toMatchObject({
    status: 'booked',
    doctorId: doctor.id,
    mode: 'online',
    patientId: patient.id,
  });
  expect(booked.appointmentId).toBeTruthy();
  const appointments: Appointment[] = await (await page.request.get('/api/appointments')).json();
  const appointment = appointments.find((value) => value.id === booked.appointmentId)!;
  expect(appointment).toMatchObject({
    patientId: patient.id,
    doctorId: doctor.id,
    date,
    mode: 'online',
    status: 'scheduled',
  });
  await row.getByRole('button', { name: 'Request details', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(
    dialog.getByText('Booked after patient confirmation', { exact: true }),
  ).toBeVisible();
  await dialog.getByRole('link', { name: 'Open appointment day', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/clinic/appointments\\?date=${date}`));
  await expect(page.getByRole('row').filter({ hasText: reason })).toBeVisible();
  const cancelled = await page.request.patch(`/api/appointments/${appointment.id}`, {
    headers,
    data: { status: 'cancelled' },
  });
  expect(cancelled.ok()).toBeTruthy();
  await page.goto('/clinic/waitlist');
  await page.getByRole('button', { name: 'Booked', exact: true }).click();
  await row.getByRole('button', { name: 'Request details', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByText('cancelled', { exact: true })).toBeVisible();
  await expect(
    dialog.getByText(/Later appointment changes do not reopen this request/),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await requestVisit(`${reason} withdrawn`);
  const withdrawalRow = page.getByRole('row').filter({ hasText: `${reason} withdrawn` });
  await withdrawalRow.getByRole('button', { name: 'Withdraw request', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog
    .getByLabel('Reason for withdrawal', { exact: true })
    .fill('The test patient no longer needs this requested window.');
  await dialog.getByRole('button', { name: 'Confirm withdrawal', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Withdrawn', exact: true }).click();
  await expect(withdrawalRow.getByText('Withdrawn', { exact: true })).toBeVisible();
  await expect(withdrawalRow.getByRole('button', { name: 'Find a slot', exact: true })).toHaveCount(
    0,
  );
  await audit(page);
  await page.screenshot({
    path: testInfo.outputPath('clinic-waitlist-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await audit(page);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  await withdrawalRow.getByRole('button', { name: 'Request details', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(
    dialog.getByText('The test patient no longer needs this requested window.', { exact: true }),
  ).toBeVisible();
  await audit(page);
  await page.screenshot({
    path: testInfo.outputPath('clinic-waitlist-mobile.png'),
    fullPage: true,
  });
});
