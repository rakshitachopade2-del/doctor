import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { Doctor, Session } from '../../shared/types';
import type { DoctorSchedule, SchedulingData } from '../../shared/scheduling';

const unique = () => `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const futureWeekday = (weekday: number, weeksAhead = 4) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + weeksAhead * 7);
  while (date.getUTCDay() !== weekday) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
};
async function signIn(page: Page, role: 'admin' | 'doctor' | 'reception') {
  const response = await page.request.post('/api/auth/login', {
    data: { email: `${role}@derma.demo`, password: 'DemoClinic2026!' },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Session;
}
async function createDoctor(page: Page, session: Session) {
  const response = await page.request.post('/api/doctors', {
    headers: { 'X-CSRF-Token': session.csrfToken! },
    data: {
      name: `Dr. Schedule ${unique()}`,
      title: 'Consultant Dermatologist',
      qualifications: 'Synthetic test profile',
      specialties: ['General dermatology'],
      experience: 5,
      fee: 800,
      bio: 'Fictional clinician for automated scheduling verification.',
      languages: ['English'],
      color: '#e0ede6',
    },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Doctor;
}

test('weekly sessions, consultation modes and duration drive bookings; time off protects existing visits', async ({
  page,
}) => {
  const session = await signIn(page, 'admin');
  const doctor = await createDoctor(page, session);
  const monday = futureWeekday(1);
  const tuesday = futureWeekday(2);
  const wednesday = futureWeekday(3);
  await page.goto('/clinic/scheduling');
  await page
    .getByRole('combobox', { name: 'Doctor schedule', exact: true })
    .selectOption(doctor.id);
  await page.getByRole('combobox', { name: 'Appointment length', exact: true }).selectOption('20');
  await page.getByLabel('Monday session 1 end', { exact: true }).fill('12:00');
  await page
    .getByRole('combobox', { name: 'Monday session 1 consultation mode', exact: true })
    .selectOption('online');
  await page.getByRole('button', { name: 'Add Monday session', exact: true }).click();
  await page.getByLabel('Monday session 2 start', { exact: true }).fill('13:00');
  await page.getByLabel('Monday session 2 end', { exact: true }).fill('17:00');
  await page
    .getByRole('combobox', { name: 'Monday session 2 consultation mode', exact: true })
    .selectOption('in-person');
  await page.getByRole('checkbox', { name: 'Open Wednesday', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Save availability', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save availability', exact: true })).toBeDisabled();
  await expect(
    page.getByText('Availability saved. New bookings now use this schedule.', { exact: true }),
  ).toBeVisible();
  const saved: DoctorSchedule = await (
    await page.request.get(`/api/schedules/${doctor.id}`)
  ).json();
  expect(saved.durationMinutes).toBe(20);
  expect(saved.windows.filter((window) => window.day === 1)).toEqual([
    { day: 1, start: '09:00', end: '12:00', mode: 'online' },
    { day: 1, start: '13:00', end: '17:00', mode: 'in-person' },
  ]);
  expect(
    await (
      await page.request.get(`/api/slots?doctorId=${doctor.id}&date=${wednesday}&mode=in-person`)
    ).json(),
  ).toEqual([]);
  const inClinic: string[] = await (
    await page.request.get(`/api/slots?doctorId=${doctor.id}&date=${monday}&mode=in-person`)
  ).json();
  expect(inClinic[0]).toBe('13:00');
  expect(inClinic[1]).toBe('13:20');
  expect(inClinic).not.toContain('09:00');

  const patientResponse = await page.request.post('/api/patients', {
    headers: { 'X-CSRF-Token': session.csrfToken! },
    data: {
      name: `Schedule Patient ${unique()}`,
      phone: '+91 9000000003',
      email: '',
      dob: '',
      gender: 'Not specified',
      allergies: '',
    },
  });
  expect(patientResponse.ok()).toBeTruthy();
  const patient = await patientResponse.json();
  await page.goto('/clinic/appointments?new=1');
  let dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Patient', exact: true }).selectOption(patient.id);
  await dialog.getByRole('combobox', { name: 'Doctor', exact: true }).selectOption(doctor.id);
  await dialog.getByLabel('Date', { exact: true }).fill(monday);
  await expect(dialog.getByText('20-minute in-clinic appointment', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '9:00 AM', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: '1:00 PM', exact: true }).click();
  await dialog
    .getByRole('combobox', { name: 'Consultation mode', exact: true })
    .selectOption('online');
  await expect(
    dialog.getByRole('button', { name: 'Book appointment', exact: true }),
  ).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '9:00 AM', exact: true })).toBeVisible();
  await dialog
    .getByRole('combobox', { name: 'Consultation mode', exact: true })
    .selectOption('in-person');
  await dialog.getByRole('button', { name: '1:00 PM', exact: true }).click();
  await dialog
    .getByLabel('Reason for visit', { exact: true })
    .fill('Availability integration test');
  await dialog.getByRole('button', { name: 'Book appointment', exact: true }).click();
  await expect(dialog).toBeHidden();
  const row = page.getByRole('row').filter({ hasText: patient.name });
  await expect(row.getByText('20 min', { exact: true })).toBeVisible();

  // Rescheduling can retain the current slot using the selected doctor’s current appointment length.
  await row.getByRole('button', { name: `More actions for ${patient.name}`, exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Reschedule appointment', exact: true })
    .click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: '1:00 PM', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();

  await page.goto('/clinic/scheduling');
  await page
    .getByRole('combobox', { name: 'Doctor schedule', exact: true })
    .selectOption(doctor.id);
  await page.getByRole('button', { name: 'Add time off', exact: true }).first().click();
  dialog = page.getByRole('dialog');
  const closureReason = `Synthetic leave ${unique()}`;
  await dialog.getByLabel('Reason', { exact: true }).fill(closureReason);
  await dialog.getByLabel('First day', { exact: true }).fill(monday);
  await dialog.getByLabel('Last day', { exact: true }).fill(monday);
  await dialog.getByRole('button', { name: 'Save time off', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('No bookings have been cancelled.');
  await dialog.getByLabel('First day', { exact: true }).fill(tuesday);
  await dialog.getByLabel('Last day', { exact: true }).fill(tuesday);
  await dialog.getByRole('button', { name: 'Save time off', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { name: closureReason, exact: true })).toBeVisible();
  expect(
    await (
      await page.request.get(`/api/slots?doctorId=${doctor.id}&date=${tuesday}&mode=in-person`)
    ).json(),
  ).toEqual([]);
  await page
    .getByRole('button', { name: `Remove time off: ${closureReason}`, exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Remove time off', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toBeHidden();
  const restored: string[] = await (
    await page.request.get(`/api/slots?doctorId=${doctor.id}&date=${tuesday}&mode=in-person`)
  ).json();
  expect(restored.length).toBeGreaterThan(0);
  await page.waitForLoadState('networkidle');
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
});

test('doctors edit only their own availability and reception can only view schedules', async ({
  page,
  browser,
}) => {
  const doctorSession = await signIn(page, 'doctor');
  const doctors: Doctor[] = await (await page.request.get('/api/doctors')).json();
  const otherDoctor = doctors.find((doctor) => doctor.id !== doctorSession.user?.doctorId)!;
  await page.goto('/clinic/scheduling');
  await expect(page.getByRole('combobox', { name: 'Doctor schedule', exact: true })).toHaveValue(
    doctorSession.user!.doctorId!,
  );
  await expect(
    page.getByRole('combobox', { name: 'Appointment length', exact: true }),
  ).toBeEnabled();
  await page
    .getByRole('combobox', { name: 'Doctor schedule', exact: true })
    .selectOption(otherDoctor.id);
  await expect(
    page.getByRole('combobox', { name: 'Appointment length', exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save availability', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add time off', exact: true })).toHaveCount(0);
  const scheduling: SchedulingData = await (await page.request.get('/api/scheduling')).json();
  const own = scheduling.schedules.find((schedule) => schedule.doctorId === otherDoctor.id)!;
  const denied = await page.request.put(`/api/schedules/${otherDoctor.id}`, {
    headers: { 'X-CSRF-Token': doctorSession.csrfToken! },
    data: { durationMinutes: own.durationMinutes, windows: own.windows },
  });
  expect(denied.status()).toBe(403);

  const receptionContext = await browser.newContext();
  const receptionPage = await receptionContext.newPage();
  const login = await receptionPage.request.post(`${new URL(page.url()).origin}/api/auth/login`, {
    data: { email: 'reception@derma.demo', password: 'DemoClinic2026!' },
  });
  expect(login.ok()).toBeTruthy();
  await receptionPage.goto(`${new URL(page.url()).origin}/clinic/scheduling`);
  await expect(
    receptionPage.getByText(
      'You have read-only access to availability. A doctor or administrator can update it.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    receptionPage.getByRole('combobox', { name: 'Appointment length', exact: true }),
  ).toBeDisabled();
  await expect(
    receptionPage.getByRole('button', { name: 'Save availability', exact: true }),
  ).toHaveCount(0);
  await expect(
    receptionPage.getByRole('button', { name: 'Add time off', exact: true }),
  ).toHaveCount(0);
  await receptionContext.close();
});
