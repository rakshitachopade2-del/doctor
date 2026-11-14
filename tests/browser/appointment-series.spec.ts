import {
  test,
  expect,
  type APIRequestContext,
  type Page,
  type Route,
  type Locator,
} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import type { Appointment, Doctor, Session } from '../../shared/types';
import type {
  AppointmentSeriesDetail,
  AppointmentSeriesInput,
  AppointmentSeriesPage,
  AppointmentSeriesPreview,
} from '../../shared/appointment-series';
import type { CareSummary } from '../../shared/care-summary';

const future = (days = 28) => {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return new Date(Date.parse(`${today}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
};
const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
async function login(request: APIRequestContext, email = 'admin@derma.demo') {
  const response = await request.post('/api/auth/login', {
    data: { email, password: 'DemoClinic2026!' },
  });
  expect(response.status(), await response.text()).toBe(200);
  const session = (await response.json()) as Session;
  return { session, headers: { 'X-CSRF-Token': session.csrfToken! } };
}
async function get<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path);
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}
async function doctor(
  request: APIRequestContext,
  headers: Record<string, string>,
  durationMinutes = 20,
) {
  const response = await request.post('/api/doctors', {
    headers,
    data: {
      name: `Dr. Series ${randomUUID().slice(0, 8)}`,
      title: 'Dermatologist',
      qualifications: 'Synthetic profile',
      specialties: ['General dermatology'],
      experience: 5,
      fee: 600,
      bio: 'Synthetic recurring booking verification.',
      languages: ['English'],
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  const value = (await response.json()) as Doctor;
  const schedule = await request.put(`/api/schedules/${value.id}`, {
    headers,
    data: {
      durationMinutes,
      windows: Array.from({ length: 7 }, (_, day) => ({
        day,
        start: '08:00',
        end: '18:00',
        mode: 'both',
      })),
    },
  });
  expect(schedule.status(), await schedule.text()).toBe(200);
  return value;
}
async function patient(request: APIRequestContext, headers: Record<string, string>) {
  const response = await request.post('/api/patients', {
    headers,
    data: {
      name: `Series patient ${randomUUID().slice(0, 8)}`,
      email: '',
      phone: '+91 9000000241',
      dob: '',
      gender: 'Not specified',
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return response.json() as Promise<{ id: string; name: string }>;
}
async function appointment(
  request: APIRequestContext,
  headers: Record<string, string>,
  patientId: string,
  doctorId: string,
  date: string,
  time: string,
) {
  const response = await request.post('/api/appointments', {
    headers,
    data: {
      patientId,
      doctorId,
      date,
      time,
      mode: 'in-person',
      reason: 'Synthetic competing appointment.',
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return response.json() as Promise<Appointment>;
}
async function audit(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  const notices = page.getByRole('button', { name: 'Dismiss notification', exact: true });
  while (await notices.count()) await notices.first().click();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
}
const agreement = 'I confirmed every listed date and time with the patient.';
function response(page: Page, path: string) {
  return page.waitForResponse(
    (r) => new URL(r.url()).pathname === path && r.request().method() === 'POST',
  );
}
async function form(page: Page) {
  await page.getByRole('button', { name: 'Book recurring visits', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Book recurring visits', exact: true });
  await expect(dialog.getByLabel('Patient', { exact: true })).toBeEnabled();
  return dialog;
}
async function pattern(
  dialog: Locator,
  patientId: string,
  doctorId: string,
  date: string,
  count = 3,
  time = '10:00',
) {
  await dialog.getByLabel('Patient', { exact: true }).selectOption(patientId);
  await dialog.getByLabel('Doctor', { exact: true }).selectOption(doctorId);
  await dialog.getByLabel('First visit date', { exact: true }).fill(date);
  await dialog.getByLabel('Start time · IST', { exact: true }).fill(time);
  await dialog.getByLabel('Number of visits', { exact: true }).fill(String(count));
  await dialog
    .getByLabel('Reason for visits', { exact: true })
    .fill('Synthetic recurring appointment request.');
}
async function preview(page: Page, dialog: Locator, label = 'Preview visits') {
  const waiting = response(page, '/api/appointment-series/preview');
  await dialog.getByRole('button', { name: label, exact: true }).click();
  const result = await waiting;
  expect(result.status(), await result.text()).toBe(200);
  const value = (await result.json()) as AppointmentSeriesPreview;
  await expect(dialog.locator('.appointment-series-preview-card')).toHaveCount(value.input.count);
  return value;
}
async function book(page: Page, dialog: Locator) {
  await dialog.getByLabel(agreement, { exact: true }).check();
  const waiting = response(page, '/api/appointment-series');
  await dialog.getByRole('button', { name: 'Confirm all visits', exact: true }).click();
  const result = await waiting;
  expect(result.status(), await result.text()).toBe(201);
  const value = (await result.json()) as AppointmentSeriesDetail;
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`series=${value.series.id}`));
  return value;
}
async function createSeries(
  request: APIRequestContext,
  headers: Record<string, string>,
  input: AppointmentSeriesInput,
) {
  const checking = await request.post('/api/appointment-series/preview', { headers, data: input });
  expect(checking.status(), await checking.text()).toBe(200);
  const preview = (await checking.json()) as AppointmentSeriesPreview;
  expect(preview.canBook, JSON.stringify(preview.visits)).toBe(true);
  const result = await request.post('/api/appointment-series', {
    headers,
    data: {
      input,
      expectedRevision: preview.revision,
      patientConfirmed: true,
      requestId: randomUUID(),
    },
  });
  expect(result.status(), await result.text()).toBe(201);
  return result.json() as Promise<AppointmentSeriesDetail>;
}

test('staff confirm every series visit and individual changes preserve original snapshots without exposing private booking notes', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(120000);
  const { headers } = await login(page.request),
    clinician = await doctor(page.request, headers),
    date = future(28),
    note = `PRIVATE_SERIES_NOTE_${randomUUID()}`;
  await page.goto('/clinic/appointments');
  const dialog = await form(page);
  await pattern(dialog, 'patient-ananya', clinician.id, date);
  await dialog.getByLabel('Internal booking note', { exact: true }).fill(note);
  const projected = await preview(page, dialog);
  expect(projected.visits.map((visit) => visit.date)).toEqual([
    date,
    addDays(date, 7),
    addDays(date, 14),
  ]);
  expect(projected.durationMinutes).toBe(20);
  expect(projected.canBook).toBe(true);
  await expect(dialog.locator('.appointment-series-source')).toContainText('₹1,800');
  await page.setViewportSize({ width: 320, height: 860 });
  await audit(page);
  await page.screenshot({ path: testInfo.outputPath('series-preview-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  const detail = await book(page, dialog);
  expect(detail.series.bookedAppointments).toHaveLength(3);
  await expect(page.locator('.appointment-series-visit')).toHaveCount(3);
  await expect(page).toHaveURL(`/clinic/appointment-series?series=${detail.series.id}`);
  const second = detail.appointments[1],
    third = detail.appointments[2];
  let changed = await page.request.patch(`/api/appointments/${second.id}`, {
    headers,
    data: { date: addDays(second.date, 1), time: '11:00', doctorId: clinician.id, mode: 'online' },
  });
  expect(changed.status(), await changed.text()).toBe(200);
  changed = await page.request.patch(`/api/appointments/${third.id}`, {
    headers,
    data: { status: 'cancelled' },
  });
  expect(changed.status(), await changed.text()).toBe(200);
  await page.reload();
  const rows = page.locator('.appointment-series-visit');
  await expect(
    rows.nth(1).locator('.appointment-series-visit-columns > div').first(),
  ).toContainText('In clinic');
  await expect(rows.nth(1).locator('.appointment-series-visit-columns > div').last()).toContainText(
    'Online consultation',
  );
  await expect(rows.nth(2)).toContainText('cancelled');
  const current = await get<AppointmentSeriesDetail>(
    page.request,
    `/api/appointment-series/${detail.series.id}`,
  );
  expect(current.series).toEqual(detail.series);
  expect(current.appointments[1].date).toBe(addDays(second.date, 1));
  expect(current.appointments[1].mode).toBe('online');
  expect(current.appointments[2].status).toBe('cancelled');
  await rows.nth(1).getByRole('link', { name: 'Open appointment', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`patientId=patient-ananya`));
  await expect(page.getByRole('link', { name: 'Ananya Sharma', exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'More actions for Ananya Sharma', exact: true }),
  ).toBeVisible();
  const receptionContext = await browser.newContext({ baseURL }),
    patientContext = await browser.newContext({ baseURL });
  try {
    await login(receptionContext.request, 'reception@derma.demo');
    const reception = await receptionContext.newPage();
    await reception.goto(`/clinic/appointment-series?series=${detail.series.id}`);
    await expect(reception.locator('.appointment-series-visit')).toHaveCount(3);
    await expect(reception.locator('.appointment-series-note').last()).toContainText(note);
    await login(patientContext.request, 'patient@derma.demo');
    expect(
      (await patientContext.request.get(`/api/appointment-series/${detail.series.id}`)).status(),
    ).toBe(403);
    expect((await patientContext.request.get('/api/appointment-series')).status()).toBe(403);
    const summary = await get<CareSummary>(
      patientContext.request,
      '/api/patients/patient-ananya/care-summary',
    );
    for (const booked of detail.appointments)
      expect(summary.appointments.some((visit) => visit.id === booked.id)).toBe(true);
    expect(JSON.stringify(summary)).not.toContain(note);
    expect(JSON.stringify(summary)).not.toContain(detail.series.requestId);
    expect(JSON.stringify(summary)).not.toContain(detail.series.id);
    await page.goto(`/clinic/appointment-series?series=${detail.series.id}`);
    await page.setViewportSize({ width: 320, height: 860 });
    await audit(page);
    await page.screenshot({
      path: testInfo.outputPath('series-original-current-mobile.png'),
      fullPage: true,
    });
  } finally {
    await Promise.all([receptionContext.close(), patientContext.close()]);
  }
});

test('all requested dates remain visible, conflicts never partly book, and changed fee or availability requires a refreshed preview', async ({
  page,
}) => {
  test.setTimeout(120000);
  const { headers } = await login(page.request),
    clinician = await doctor(page.request, headers),
    person = await patient(page.request, headers),
    other = await patient(page.request, headers),
    date = future(30);
  await page.goto('/clinic/appointment-series');
  const dialog = await form(page);
  await pattern(dialog, person.id, clinician.id, date, 12);
  await dialog.getByLabel('Repeat every', { exact: true }).selectOption('4');
  let projected = await preview(page, dialog);
  expect(projected.visits).toHaveLength(12);
  expect(projected.visits[11].date).toBe(addDays(date, 308));
  expect(projected.canBook).toBe(false);
  await expect(
    dialog.getByRole('button', { name: 'Confirm all visits', exact: true }),
  ).toBeDisabled();
  expect(
    projected.visits.some((visit) => visit.date > projected.horizonEndDate && !visit.available),
  ).toBe(true);
  await dialog.getByLabel('Number of visits', { exact: true }).fill('3');
  await dialog.getByLabel('Repeat every', { exact: true }).selectOption('1');
  projected = await preview(page, dialog);
  expect(projected.canBook).toBe(true);
  const competitor = await appointment(
    page.request,
    headers,
    other.id,
    clinician.id,
    addDays(date, 14),
    '10:00',
  );
  await dialog.getByLabel(agreement, { exact: true }).check();
  const rejected = response(page, '/api/appointment-series');
  await dialog.getByRole('button', { name: 'Confirm all visits', exact: true }).click();
  expect((await rejected).status()).toBe(409);
  expect(
    (
      await get<AppointmentSeriesPage>(
        page.request,
        `/api/appointment-series?patientId=${person.id}`,
      )
    ).total,
  ).toBe(0);
  expect(
    (
      await get<{ items: Appointment[]; total: number }>(
        page.request,
        `/api/search/appointments?patientId=${person.id}`,
      )
    ).total,
  ).toBe(0);
  await expect(dialog.getByLabel('Reason for visits', { exact: true })).toHaveValue(
    'Synthetic recurring appointment request.',
  );
  await expect(dialog.getByLabel(agreement, { exact: true })).not.toBeChecked();
  projected = await preview(page, dialog, 'Refresh series preview');
  expect(projected.canBook).toBe(false);
  expect(projected.visits[2].available).toBe(false);
  expect(JSON.stringify(projected)).not.toContain(other.name);
  await dialog
    .getByRole('button', {
      name: 'I reviewed the updated dates, visit length and fees',
      exact: true,
    })
    .click();
  await expect(
    dialog.getByRole('button', { name: 'Confirm all visits', exact: true }),
  ).toBeDisabled();
  const cancelled = await page.request.patch(`/api/appointments/${competitor.id}`, {
    headers,
    data: { status: 'cancelled' },
  });
  expect(cancelled.status(), await cancelled.text()).toBe(200);
  projected = await preview(page, dialog, 'Refresh preview');
  expect(projected.canBook).toBe(true);
  const fee = await page.request.patch(`/api/doctors/${clinician.id}`, {
    headers,
    data: {
      name: clinician.name,
      title: clinician.title,
      qualifications: clinician.qualifications,
      specialties: clinician.specialties,
      experience: clinician.experience,
      bio: clinician.bio,
      languages: clinician.languages,
      fee: 900,
    },
  });
  expect(fee.status(), await fee.text()).toBe(200);
  await dialog.getByLabel(agreement, { exact: true }).check();
  const stale = response(page, '/api/appointment-series');
  await dialog.getByRole('button', { name: 'Confirm all visits', exact: true }).click();
  expect((await stale).status()).toBe(409);
  projected = await preview(page, dialog, 'Refresh series preview');
  expect(projected.doctor.fee).toBe(900);
  await expect(dialog.locator('.appointment-series-source').last()).toContainText('₹900');
  await dialog
    .getByRole('button', {
      name: 'I reviewed the updated dates, visit length and fees',
      exact: true,
    })
    .click();
  await expect(dialog.getByLabel(agreement, { exact: true })).not.toBeChecked();
  const result = await book(page, dialog);
  expect(result.series.bookedAppointments.every((visit) => visit.fee === 900)).toBe(true);
  expect(
    (await get<{ total: number }>(page.request, `/api/search/appointments?patientId=${person.id}`))
      .total,
  ).toBe(3);
});

test('custom series retain exact uncertain requests after individual edits, reject wrong receipts, and list bounded original records', async ({
  page,
}, testInfo) => {
  test.setTimeout(120000);
  const { headers } = await login(page.request),
    clinician = await doctor(page.request, headers),
    person = await patient(page.request, headers),
    date = future(70);
  const schedule = await page.request.put(`/api/schedules/${clinician.id}`, {
    headers,
    data: {
      durationMinutes: 20,
      windows: Array.from({ length: 7 }, (_, day) => ({
        day,
        start: '09:02',
        end: '18:00',
        mode: 'both',
      })),
    },
  });
  expect(schedule.status(), await schedule.text()).toBe(200);
  await page.goto('/clinic/appointment-series');
  let dialog = await form(page);
  await pattern(dialog, person.id, clinician.id, date, 2, '09:02');
  await dialog.getByLabel('Visit length', { exact: true }).selectOption('custom');
  await dialog.getByLabel('Custom duration (minutes)', { exact: true }).fill('75');
  let projected = await preview(page, dialog);
  expect(projected.canBook).toBe(true);
  expect(projected.visits[0].endTime).toBe('10:17');
  const bodies: unknown[] = [];
  let original: AppointmentSeriesDetail | undefined,
    calls = 0;
  const lose = async (route: Route) => {
    bodies.push(route.request().postDataJSON());
    calls++;
    const result = await route.fetch();
    if (calls === 1) {
      expect(result.status()).toBe(201);
      original = await result.json();
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Synthetic lost series response after commit.' }),
      });
    } else await route.fulfill({ response: result });
  };
  await page.route('**/api/appointment-series', lose);
  await dialog.getByLabel(agreement, { exact: true }).check();
  await dialog.getByRole('button', { name: 'Confirm all visits', exact: true }).click();
  await expect(
    dialog.getByText('The booking outcome could not be confirmed.', { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByLabel('Number of visits', { exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  const member = original!.appointments[0];
  const moved = await page.request.patch(`/api/appointments/${member.id}`, {
    headers,
    data: { date: addDays(member.date, 1), time: '09:02', doctorId: clinician.id, mode: 'online' },
  });
  expect(moved.status(), await moved.text()).toBe(200);
  const retry = response(page, '/api/appointment-series');
  await dialog.getByRole('button', { name: 'Retry same request', exact: true }).click();
  expect((await retry).status()).toBe(200);
  await expect(dialog).toBeHidden();
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  await page.unroute('**/api/appointment-series', lose);
  const saved = await get<AppointmentSeriesDetail>(
    page.request,
    `/api/appointment-series/${original!.series.id}`,
  );
  expect(saved.series).toEqual(original!.series);
  expect(saved.appointments[0].date).toBe(addDays(date, 1));
  expect(saved.appointments[0].durationMinutes).toBe(75);
  await expect(page.locator('.appointment-series-visit').first()).toContainText(
    'Online consultation',
  );
  dialog = await form(page);
  await pattern(dialog, person.id, clinician.id, future(90), 2, '09:02');
  projected = await preview(page, dialog);
  expect(projected.canBook).toBe(true);
  const wrongBodies: unknown[] = [];
  let wrongCalls = 0,
    second: AppointmentSeriesDetail | undefined;
  const malformed = async (route: Route) => {
    wrongBodies.push(route.request().postDataJSON());
    wrongCalls++;
    if (wrongCalls === 2) {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Synthetic later rejection must preserve the uncertain booking.',
        }),
      });
      return;
    }
    const result = await route.fetch();
    if (wrongCalls === 1) {
      expect(result.status()).toBe(201);
      second = await result.json();
      await route.fulfill({
        response: result,
        json: { ...second, series: { ...second!.series, createdById: 'wrong-actor' } },
      });
    } else await route.fulfill({ response: result });
  };
  await page.route('**/api/appointment-series', malformed);
  await dialog.getByLabel(agreement, { exact: true }).check();
  await dialog.getByRole('button', { name: 'Confirm all visits', exact: true }).click();
  await expect(
    dialog.getByText('The booking outcome could not be confirmed.', { exact: true }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Retry same request', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Synthetic later rejection');
  await expect(dialog.getByLabel('First visit date', { exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(dialog).toBeVisible();
  const exact = response(page, '/api/appointment-series');
  await dialog.getByRole('button', { name: 'Retry same request', exact: true }).click();
  expect((await exact).status()).toBe(200);
  await expect(dialog).toBeHidden();
  expect(wrongBodies).toHaveLength(3);
  expect(wrongBodies[1]).toEqual(wrongBodies[0]);
  expect(wrongBodies[2]).toEqual(wrongBodies[0]);
  await page.unroute('**/api/appointment-series', malformed);
  expect(
    (
      await get<AppointmentSeriesPage>(
        page.request,
        `/api/appointment-series?patientId=${person.id}`,
      )
    ).total,
  ).toBe(2);
  dialog = await form(page);
  await pattern(dialog, person.id, clinician.id, future(110), 2, '09:02');
  let releasePreview!: () => void, receivedPreview!: () => void;
  const heldPreview = new Promise<void>((resolve) => {
    releasePreview = resolve;
  });
  const previewReady = new Promise<void>((resolve) => {
    receivedPreview = resolve;
  });
  const holdPreview = async (route: Route) => {
    const result = await route.fetch();
    expect(result.status()).toBe(200);
    receivedPreview();
    await heldPreview;
    try {
      await route.fulfill({ response: result });
    } catch {
      /* Navigation can cancel this read. */
    }
  };
  await page.route('**/api/appointment-series/preview', holdPreview);
  await dialog.getByRole('button', { name: 'Preview visits', exact: true }).click();
  await previewReady;
  await page.evaluate(() => {
    window.history.pushState(
      { key: 'series-query-away' },
      '',
      '/clinic/appointment-series?search=no-match',
    );
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  releasePreview();
  await page.waitForLoadState('networkidle');
  await page.unroute('**/api/appointment-series/preview', holdPreview);
  await page.goBack();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  dialog = await form(page);
  await pattern(dialog, person.id, clinician.id, future(110), 2, '09:02');
  expect((await preview(page, dialog)).canBook).toBe(true);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  for (let i = 0; i < 24; i++) {
    const minutes = 9 * 60 + 2 + i * 20,
      time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    await createSeries(page.request, headers, {
      patientId: person.id,
      doctorId: clinician.id,
      mode: 'in-person',
      reason: 'Synthetic pagination fixture.',
      firstDate: future(140),
      time,
      count: 2,
      intervalWeeks: 1,
      durationPolicy: 'schedule',
    });
  }
  await page.goto('/clinic/appointment-series');
  await page.getByLabel('Series doctor', { exact: true }).selectOption(clinician.id);
  await page.getByRole('button', { name: 'Find series', exact: true }).click();
  await expect(page.locator('.appointment-series-row')).toHaveCount(25);
  await expect(page.getByText('26 series in this view', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.locator('.appointment-series-row')).toHaveCount(1);
  await page.goBack();
  await expect(page.locator('.appointment-series-row')).toHaveCount(25);
  await page.goForward();
  await expect(page.locator('.appointment-series-row')).toHaveCount(1);
  await page.setViewportSize({ width: 320, height: 860 });
  await audit(page);
  await page.screenshot({ path: testInfo.outputPath('series-list-mobile.png'), fullPage: true });
});
