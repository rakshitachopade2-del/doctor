import { test, expect, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { WaitlistEntry } from '../../shared/waitlist';

const future = (days: number) => {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const value = new Date(`${today}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

async function pauseResponse(page: Page, url: string, method: string) {
  let release!: () => void;
  let arrived!: () => void;
  let finished!: () => void;
  let used = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const handled = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const handler = async (route: Route) => {
    if (used || route.request().method() !== method) {
      await route.continue();
      return;
    }
    used = true;
    try {
      const response = await route.fetch();
      arrived();
      await gate;
      await route.fulfill({ response });
    } finally {
      finished();
    }
  };
  await page.route(url, handler);
  return {
    ready,
    release: async () => {
      release();
      if (used) await handled;
      await page.unroute(url, handler);
    },
  };
}

test('patient joins and withdraws a waitlist, then confirms a slot from a new request', async ({
  page,
}, testInfo) => {
  test.setTimeout(60000);
  const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  await page.goto('/register');
  await page.getByLabel('Full name', { exact: true }).fill(`Waitlist Patient ${suffix}`);
  await page.getByLabel('Email address', { exact: true }).fill(`waitlist-${suffix}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill('WaitlistPatient2026!');
  await page.getByLabel('Phone number', { exact: true }).fill('+91 9000000123');
  await page.getByLabel('Date of birth', { exact: true }).fill('1993-05-21');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/\/my-care$/);
  const doctors = await (await page.request.get('/api/doctors')).json();
  const doctor = doctors[0];
  const session = await (await page.request.get('/api/session')).json();
  const headers = { 'X-CSRF-Token': session.csrfToken };
  let available: { date: string; time: string } | undefined;
  for (let offset = 45; offset < 55; offset++) {
    const date = future(offset);
    const slots = (await (
      await page.request.get(`/api/slots?doctorId=${doctor.id}&date=${date}&mode=in-person`)
    ).json()) as string[];
    if (slots.length >= 2) {
      available = { date, time: slots[0] };
      break;
    }
  }
  expect(available).toBeDefined();
  const visit = available!;
  const reason = `Patient waitlist request ${suffix}`;
  await page.goto(`/book?doctor=${doctor.id}`);
  await page.getByLabel('Appointment date', { exact: true }).fill(visit.date);
  await page.getByRole('button', { name: 'Join waitlist', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Preferred clinician', { exact: true })).toHaveValue(doctor.id);
  await expect(dialog.getByLabel('Earliest date', { exact: true })).toHaveValue(visit.date);
  await dialog.getByLabel('Latest date', { exact: true }).fill(future(60));
  await dialog.getByLabel('Reason for your waitlist request', { exact: true }).fill(reason);
  await dialog.getByRole('button', { name: 'Join waitlist', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status')).toContainText(
    'Your waitlist request is saved. No appointment is reserved.',
  );
  const readRequests = async () => {
    const response = await page.request.get('/api/waitlist');
    expect(response.ok()).toBeTruthy();
    return (await response.json()) as WaitlistEntry[];
  };
  const first = (await readRequests()).find((entry) => entry.reason === reason)!;
  expect(first.status).toBe('waiting');
  expect(first.appointmentId).toBeNull();
  expect(first).not.toHaveProperty('patientPhone');
  expect(await (await page.request.get('/api/appointments')).json()).toEqual([]);
  await page.getByRole('link', { name: 'View your request →', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Your appointment waitlist', exact: true });
  await expect(panel).toBeFocused();
  const firstCard = page.locator(`[data-waitlist-id="${first.id}"]`);
  await expect(firstCard.getByText('Waiting', { exact: true })).toBeVisible();

  const refreshGate = await pauseResponse(page, '**/api/waitlist', 'GET');
  try {
    await panel.getByRole('button', { name: 'Refresh requests', exact: true }).click();
    await refreshGate.ready;
    await panel.getByRole('button', { name: 'Join waitlist', exact: true }).click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: 'Close dialog', exact: true })).toBeFocused();
  } finally {
    await refreshGate.release();
  }
  await expect(panel.getByRole('button', { name: 'Refresh requests', exact: true })).toBeEnabled();
  await expect(dialog.getByRole('button', { name: 'Close dialog', exact: true })).toBeFocused();
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();

  await panel.getByRole('button', { name: 'Join waitlist', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Preferred clinician', { exact: true }).selectOption(doctor.id);
  await dialog
    .getByLabel('Reason for your waitlist request', { exact: true })
    .fill('Duplicate request should be rejected');
  await dialog.getByRole('button', { name: 'Join waitlist', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('already has a waiting request');
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await firstCard.getByRole('button', { name: 'Withdraw request', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog
    .getByLabel('Withdrawal note', { exact: true })
    .fill('I need a different date range.');
  const withdrawalGate = await pauseResponse(page, `**/api/waitlist/${first.id}/cancel`, 'POST');
  try {
    await dialog.getByRole('button', { name: 'Confirm withdrawal', exact: true }).click();
    await withdrawalGate.ready;
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Withdrawal note', { exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Keep request', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await expect(dialog).toBeVisible();
    await page.locator('.modal-overlay').click({ position: { x: 4, y: 4 } });
    await expect(dialog).toBeVisible();
  } finally {
    await withdrawalGate.release();
  }
  await expect(dialog).toBeHidden();
  await expect(firstCard.getByText('Withdrawn', { exact: true })).toBeVisible();
  await expect(
    firstCard.getByRole('link', { name: 'Choose an available time', exact: true }),
  ).toHaveCount(0);
  expect((await readRequests()).find((entry) => entry.id === first.id)?.status).toBe('cancelled');

  await panel.getByRole('button', { name: 'Join waitlist', exact: true }).click();
  dialog = page.getByRole('dialog');
  const bookingReason = `Patient request to book ${suffix}`;
  await dialog.getByLabel('Preferred clinician', { exact: true }).selectOption(doctor.id);
  await dialog.getByLabel('Earliest date', { exact: true }).fill(visit.date);
  await dialog.getByLabel('Latest date', { exact: true }).fill(future(60));
  await dialog.getByLabel('Reason for your waitlist request', { exact: true }).fill(bookingReason);
  const joinGate = await pauseResponse(page, '**/api/waitlist', 'POST');
  try {
    await dialog.getByRole('button', { name: 'Join waitlist', exact: true }).click();
    await joinGate.ready;
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Preferred clinician', { exact: true })).toBeDisabled();
    await expect(dialog.getByLabel('Earliest date', { exact: true })).toBeDisabled();
    await expect(
      dialog.getByLabel('Reason for your waitlist request', { exact: true }),
    ).toBeDisabled();
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await expect(dialog).toBeVisible();
    await page.locator('.modal-overlay').click({ position: { x: 4, y: 4 } });
    await expect(dialog).toBeVisible();
  } finally {
    await joinGate.release();
  }
  await expect(dialog).toBeHidden();
  const second = (await readRequests()).find((entry) => entry.reason === bookingReason)!;
  const secondCard = page.locator(`[data-waitlist-id="${second.id}"]`);
  await secondCard.getByRole('link', { name: 'Choose an available time', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/book\\?waitlist=${second.id}$`));
  await expect(page.getByRole('radio')).toHaveCount(1);
  await expect(page.getByRole('radio')).toBeChecked();
  await expect(page.getByRole('radio')).toBeDisabled();
  await expect(page.getByLabel('Consultation mode', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Appointment date', { exact: true })).toHaveAttribute(
    'min',
    visit.date,
  );
  await expect(page.getByLabel('Appointment date', { exact: true })).toHaveAttribute(
    'max',
    future(60),
  );
  await expect(page.getByLabel('Main reason for your visit', { exact: true })).toHaveValue(
    bookingReason,
  );
  await page.getByRole('button', { name: visit.time, exact: true }).click();
  // A real second booking takes the displayed slot after the form loaded.
  const competingResponse = await page.request.post('/api/appointments', {
    headers,
    data: {
      doctorId: doctor.id,
      date: visit.date,
      time: visit.time,
      mode: 'in-person',
      reason: 'Synthetic competing appointment for a booking conflict.',
    },
  });
  expect(competingResponse.status()).toBe(201);
  const competing = await competingResponse.json();
  const conflict = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/appointments' &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Confirm appointment', exact: true }).click();
  expect((await conflict).status()).toBe(409);
  await expect(
    page.getByRole('heading', { name: 'Let’s plan your visit', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Confirm appointment', exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole('button', { name: visit.time, exact: true })).toHaveCount(0);
  const cancelled = await page.request.patch(`/api/appointments/${competing.id}`, {
    headers,
    data: { status: 'cancelled' },
  });
  expect(cancelled.ok()).toBeTruthy();
  const replacementSlot = page.locator('.time-slot').first();
  const replacementTime = (await replacementSlot.textContent())!.trim();
  expect(replacementTime).not.toBe(visit.time);
  await replacementSlot.click();
  const bookingRequest = page.waitForRequest(
    (request) =>
      request.method() === 'POST' && new URL(request.url()).pathname === '/api/appointments',
  );
  await page.getByRole('button', { name: 'Confirm appointment', exact: true }).click();
  expect((await bookingRequest).postDataJSON()).toMatchObject({
    waitlistId: second.id,
    patientConfirmed: true,
    doctorId: doctor.id,
    mode: 'in-person',
    date: visit.date,
    time: replacementTime,
  });
  await expect(page.getByRole('heading', { name: 'You’re booked in.', exact: true })).toBeVisible();
  const saved = (await readRequests()).find((entry) => entry.id === second.id)!;
  expect(saved.status).toBe('booked');
  expect(saved.appointmentId).toBeTruthy();
  const appointments = await (await page.request.get('/api/appointments')).json();
  expect(appointments).toHaveLength(2);
  expect(
    appointments.filter((appointment: { status: string }) => appointment.status === 'scheduled'),
  ).toHaveLength(1);
  expect(
    appointments.find((appointment: { id: string }) => appointment.id === saved.appointmentId).time,
  ).toBe(replacementTime);
  await page.goto(`/book?waitlist=${second.id}`);
  await expect(
    page.getByRole('heading', { name: 'This waitlist request cannot be booked', exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/my-care?waitlist=${second.id}`);
  await expect(panel).toBeFocused();
  await expect(secondCard.getByText('Booked', { exact: true })).toBeVisible();
  await expect(firstCard.getByText('Withdrawn', { exact: true })).toBeVisible();
  await expect(
    secondCard.getByRole('link', { name: 'View appointment record →', exact: true }),
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
    path: testInfo.outputPath('patient-waitlist-mobile.png'),
    fullPage: true,
  });
});
