import { test, expect, type Page } from '@playwright/test';

const unique = () => `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const futureDate = (days: number) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
async function loginPatient(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email address', { exact: true }).fill('patient@derma.demo');
  await page.getByLabel('Password', { exact: true }).fill('DemoClinic2026!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/my-care$/);
}
async function availableVisit(page: Page, doctorId: string, days: number) {
  for (let offset = days; offset < days + 10; offset++) {
    const date = futureDate(offset);
    const response = await page.request.get(`/api/slots?doctorId=${doctorId}&date=${date}`);
    const slots: string[] = await response.json();
    if (slots.length) return { date, time: slots[0] };
  }
  throw new Error('No available visit found');
}

test('public discovery filters real profiles and renders on a narrow viewport', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Care that stays with you.' })).toBeVisible();
  const doctors = await (await page.request.get('/api/doctors')).json();
  expect(doctors.length).toBeGreaterThan(0);
  await expect(page.locator('.doctor-profile-card')).toHaveCount(doctors.length);
  await page
    .getByRole('textbox', { name: 'Search doctors, concerns, or languages' })
    .fill('no-such-dermatologist');
  await expect(page.getByRole('heading', { name: 'No matching doctors' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.locator('.doctor-profile-card')).toHaveCount(doctors.length);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Care that stays with you.' })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
});

test('a new patient registers, books a slot, reschedules, downloads a calendar event, and cancels', async ({
  page,
}) => {
  const suffix = unique();
  await page.goto('/register');
  await page.getByLabel('Full name', { exact: true }).fill(`Patient Browser ${suffix}`);
  await page.getByLabel('Email address', { exact: true }).fill(`browser-${suffix}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill('BrowserPatient2026!');
  await page.getByLabel('Phone number', { exact: true }).fill('+91 9000000100');
  await page.getByLabel('Date of birth', { exact: true }).fill('1992-04-14');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page).toHaveURL(/\/my-care$/);
  const doctors = await (await page.request.get('/api/doctors')).json();
  const first = await availableVisit(page, doctors[0].id, 21);
  await page.goto(`/book?doctor=${doctors[0].id}`);
  await page.getByLabel('Appointment date', { exact: true }).fill(first.date);
  await page.getByRole('button', { name: first.time, exact: true }).click();
  await page
    .getByLabel('Main reason for your visit', { exact: true })
    .fill('New patient synthetic booking test');
  await page.getByRole('button', { name: 'Confirm appointment', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'You’re booked in.' })).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Add to calendar', exact: true }).click();
  expect((await downloadPromise).suggestedFilename()).toBe('appointment.ics');
  await page.getByRole('link', { name: 'View my care', exact: true }).click();
  await page.getByRole('link', { name: 'Reschedule', exact: true }).click();
  const second = await availableVisit(page, doctors[0].id, 32);
  await page.getByLabel('Appointment date', { exact: true }).fill(second.date);
  await page.getByRole('button', { name: second.time, exact: true }).click();
  await page.getByRole('button', { name: 'Confirm new time', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Appointment rescheduled.' })).toBeVisible();
  await page.getByRole('link', { name: 'View my care', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Confirm cancellation', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'No upcoming visits' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'No upcoming visits' })).toBeVisible();
});

test('patient history, check-ins, private images and care messages persist across visits', async ({
  page,
}) => {
  await loginPatient(page);
  const suffix = unique();
  const concern = `Patient-entered concern ${suffix}`;
  await page.goto('/intake');
  await page.getByLabel('What would you like help with?', { exact: true }).fill(concern);
  await page.getByLabel('Which areas are affected?', { exact: true }).fill('Hands');
  await page.getByLabel('How long has this been present?', { exact: true }).fill('Two weeks');
  await page
    .getByLabel('What changes or symptoms have you noticed?', { exact: true })
    .fill('Synthetic test description, not a clinical condition.');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page
    .getByLabel('Previous treatments or similar episodes', { exact: true })
    .fill('No prior treatment reported in this test.');
  await page.getByLabel('Current medicines or supplements', { exact: true }).fill('None reported.');
  await page.getByLabel('Known allergies or sensitivities', { exact: true }).fill('None reported.');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page
    .getByLabel('Questions, concerns, or goals for your dermatologist', { exact: true })
    .fill('Discuss the care record during a visit.');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByText(concern, { exact: true })).toBeVisible();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Share with my clinic', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your story is ready.' })).toBeVisible();
  await page.getByRole('link', { name: 'View my record', exact: true }).click();
  await page.getByRole('tab', { name: 'Shared history', exact: true }).click();
  await expect(page.getByRole('heading', { name: concern, exact: true })).toBeVisible();

  await page.goto('/my-care');
  await page
    .getByRole('button', { name: /Daily check-in|Update check-in/ })
    .first()
    .click();
  let dialog = page.getByRole('dialog');
  await dialog
    .getByLabel('How did your routine go today?', { exact: true })
    .selectOption('partial');
  await dialog
    .getByLabel('How are you feeling compared with before?', { exact: true })
    .selectOption('same');
  await dialog
    .getByLabel('Anything you want your clinic to know?', { exact: true })
    .fill(`Routine update ${suffix}`);
  await dialog.getByRole('button', { name: 'Save check-in', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Today’s check-in is saved', { exact: true }).first()).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Update check-in', exact: false }).first().click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('How did your routine go today?', { exact: true })).toHaveValue(
    'partial',
  );
  await expect(
    dialog.getByLabel('Anything you want your clinic to know?', { exact: true }),
  ).toHaveValue(`Routine update ${suffix}`);
  await page.keyboard.press('Escape');

  await page.goto('/my-care/record');
  await page.getByRole('tab', { name: 'Images & reports', exact: true }).click();
  await page.getByRole('button', { name: 'Add image', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Choose image', { exact: true }).setInputFiles({
    name: 'synthetic.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cWb0AAAAASUVORK5CYII=',
      'base64',
    ),
  });
  await dialog.getByLabel('Description', { exact: true }).fill(`Patient synthetic image ${suffix}`);
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Upload to my record', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole('img', { name: `Patient synthetic image ${suffix}`, exact: true }),
  ).toBeVisible();

  await page.goto('/my-care/messages');
  await page.getByLabel('Your message', { exact: true }).fill(`Patient care inbox test ${suffix}`);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText(`Patient care inbox test ${suffix}`, { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText(`Patient care inbox test ${suffix}`, { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  await page.goto('/my-care');
  await expect(page.getByRole('heading', { name: /Hello,/ })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
});

test('pausing optional modules preserves patient images and messages without write controls', async ({
  page,
  playwright,
  baseURL,
}) => {
  await loginPatient(page);
  const patientSession = await (await page.request.get('/api/session')).json();
  const suffix = unique();
  const caption = `Historical private image ${suffix}`;
  const body = `Historical care message ${suffix}`;
  const headers = { 'X-CSRF-Token': patientSession.csrfToken };
  const upload = await page.request.post('/api/images', {
    headers,
    data: {
      caption,
      category: 'clinical',
      consent: true,
      dataUrl:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cWb0AAAAASUVORK5CYII=',
    },
  });
  expect(upload.ok()).toBeTruthy();
  const message = await page.request.post('/api/messages', { headers, data: { body } });
  expect(message.ok()).toBeTruthy();
  const admin = await playwright.request.newContext({ baseURL });
  let originalModules: { intake: boolean; images: boolean; followUp: boolean } | undefined;
  let adminCsrf = '';
  try {
    const login = await admin.post('/api/auth/login', {
      data: { email: 'admin@derma.demo', password: 'DemoClinic2026!' },
    });
    expect(login.ok()).toBeTruthy();
    adminCsrf = (await login.json()).csrfToken;
    originalModules = (await (await admin.get('/api/settings')).json()).modules;
    const paused = await admin.patch('/api/settings', {
      headers: { 'X-CSRF-Token': adminCsrf },
      data: { modules: { intake: false, images: false, followUp: false } },
    });
    expect(paused.ok()).toBeTruthy();

    await page.goto('/my-care/record');
    await page.getByRole('tab', { name: 'Images & reports', exact: true }).click();
    await expect(
      page.getByText(
        'Image uploads are paused. Your existing images and reports remain available.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.getByRole('img', { name: caption, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add image', exact: true })).toHaveCount(0);
    const imageUrl = await page
      .getByRole('img', { name: caption, exact: true })
      .getAttribute('src');
    expect((await page.request.get(imageUrl!)).ok()).toBeTruthy();

    await page.goto('/my-care/messages');
    await expect(page.getByText(body, { exact: true })).toBeVisible();
    await expect(
      page.getByText(
        'Messaging is paused. Your existing conversation remains available. Contact the clinic directly for new questions.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.getByLabel('Your message', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toHaveCount(0);

    await page.goto('/my-care');
    await expect(page.getByRole('button', { name: /Daily check-in|Update check-in/ })).toHaveCount(
      0,
    );
  } finally {
    if (originalModules) {
      const restored = await admin.patch('/api/settings', {
        headers: { 'X-CSRF-Token': adminCsrf },
        data: { modules: originalModules },
      });
      expect(restored.ok()).toBeTruthy();
    }
    await admin.dispose();
  }
});
