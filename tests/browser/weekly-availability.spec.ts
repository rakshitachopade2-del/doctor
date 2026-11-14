import { test, expect, type APIRequestContext, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import type { Appointment, Doctor, Session } from '../../shared/types';
import type { DoctorSchedule } from '../../shared/scheduling';
import type { VisitDurationMutation } from '../../shared/visit-duration';
import type {
  WeeklyAvailabilityContext,
  WeeklyAvailabilityHistory,
  WeeklyAvailabilityInput,
  WeeklyAvailabilityMutation,
  WeeklyAvailabilityValues,
} from '../../shared/weekly-availability';

const reviewLabel = 'I reviewed these weekly hours and appointment length.';
const keepDraft = 'I reviewed the latest availability; keep my draft';
const path = (doctorId: string) => `/api/schedules/${doctorId}/availability`;
const form = (page: Page) => page.locator('.weekly-availability-form');
const futureMonday = () => {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const value = new Date(Date.parse(`${today}T12:00:00Z`) + 28 * 86400000);
  while (value.getUTCDay() !== 1) value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
};
async function login(request: APIRequestContext, email = 'admin@derma.demo') {
  const response = await request.post('/api/auth/login', {
    data: { email, password: 'DemoClinic2026!' },
  });
  expect(response.status(), await response.text()).toBe(200);
  const session = (await response.json()) as Session;
  return { session, headers: { 'X-CSRF-Token': session.csrfToken! } };
}
async function get<T>(request: APIRequestContext, endpoint: string): Promise<T> {
  const response = await request.get(endpoint);
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}
async function post<T>(
  request: APIRequestContext,
  headers: Record<string, string>,
  endpoint: string,
  data: unknown,
  status = 201,
): Promise<T> {
  const response = await request.post(endpoint, { headers, data });
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}
async function createDoctor(request: APIRequestContext, headers: Record<string, string>) {
  return post<Doctor>(request, headers, '/api/doctors', {
    name: `Dr. Weekly ${randomUUID().slice(0, 8)}`,
    title: 'Dermatologist',
    qualifications: 'Synthetic profile',
    specialties: ['General dermatology'],
    experience: 5,
    fee: 650,
    bio: 'Synthetic weekly availability verification.',
    languages: ['English'],
  });
}
async function book(
  request: APIRequestContext,
  headers: Record<string, string>,
  doctorId: string,
  date: string,
  time: string,
) {
  return post<Appointment>(request, headers, '/api/appointments', {
    doctorId,
    patientId: 'patient-ananya',
    date,
    time,
    mode: 'in-person',
    reason: 'Synthetic existing default-length visit.',
  });
}
async function custom(
  request: APIRequestContext,
  headers: Record<string, string>,
  doctorId: string,
  date: string,
  time: string,
) {
  return post<VisitDurationMutation>(request, headers, '/api/visit-duration/bookings', {
    doctorId,
    patientId: 'patient-ananya',
    date,
    time,
    durationMinutes: 60,
    mode: 'in-person',
    reason: 'Synthetic existing custom-length visit.',
    requestId: randomUUID(),
  });
}
async function reviewDraft(page: Page, reason: string) {
  await form(page).getByLabel('Reason for availability change', { exact: true }).fill(reason);
  await form(page).getByLabel(reviewLabel, { exact: true }).check();
}
const responseFor = (page: Page, endpoint: string) =>
  page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === endpoint && response.request().method() === 'POST',
  );
async function audit(page: Page) {
  await page.setViewportSize({ width: 320, height: 860 });
  await page.evaluate(() => document.fonts.ready);
  const dismiss = page.getByRole('button', { name: 'Dismiss notification', exact: true });
  while (await dismiss.count()) await dismiss.first().click();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const values = (schedule: DoctorSchedule): WeeklyAvailabilityValues => ({
  durationMinutes: schedule.durationMinutes,
  windows: schedule.windows,
});
async function saveSchedule(
  request: APIRequestContext,
  headers: Record<string, string>,
  doctorId: string,
  schedule: WeeklyAvailabilityValues,
  reason: string,
) {
  const context = await get<WeeklyAvailabilityContext>(request, path(doctorId));
  return post<WeeklyAvailabilityMutation>(request, headers, path(doctorId), {
    schedule,
    reason,
    expectedRevision: context.revision,
    requestId: randomUUID(),
  });
}
async function openEditor(page: Page, doctorId: string) {
  await page.goto('/clinic/scheduling');
  await page.getByRole('combobox', { name: 'Doctor schedule', exact: true }).selectOption(doctorId);
  await expect(
    form(page).getByRole('combobox', { name: 'Appointment length', exact: true }),
  ).toBeEnabled();
}
async function submit(page: Page, doctorId: string, status = 201) {
  const waiting = responseFor(page, path(doctorId));
  await form(page).getByRole('button', { name: 'Save availability', exact: true }).click();
  const response = await waiting;
  expect(response.status(), await response.text()).toBe(status);
  return response;
}

test('the first reviewed default becomes explicit and later weekly changes preserve booked lengths while driving patient availability', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const admin = await login(page.request);
  const doctor = await createDoctor(page.request, admin.headers);
  const inherited = await get<WeeklyAvailabilityContext>(page.request, path(doctor.id));
  expect(inherited.source).toBe('inherited');
  expect(inherited.latestChange).toBeNull();
  expect(inherited.schedule.updatedAt).toBe('');
  const firstReason = `Private confirmation of inherited defaults ${randomUUID()}`;
  await openEditor(page, doctor.id);
  await reviewDraft(page, firstReason);
  const first = (await (await submit(page, doctor.id)).json()) as WeeklyAvailabilityMutation;
  expect(first.context.source).toBe('explicit');
  expect(first.change.before).toEqual({ source: 'inherited', schedule: inherited.schedule });
  expect(first.change.after.schedule.durationMinutes).toBe(30);
  expect(first.change.after.schedule.windows).toEqual(inherited.schedule.windows);
  await expect(
    form(page).getByRole('button', { name: 'Save availability', exact: true }),
  ).toBeDisabled();
  expect(
    (await get<WeeklyAvailabilityHistory>(page.request, `${path(doctor.id)}/history`)).items,
  ).toEqual([first.change]);
  const monday = futureMonday();
  const ordinary = await book(page.request, admin.headers, doctor.id, monday, '09:00');
  const longer = await custom(page.request, admin.headers, doctor.id, monday, '11:00');
  const closuresBefore = (await get<{ closures: unknown[] }>(page.request, '/api/scheduling'))
    .closures;
  const invalidReason = `Private unavailable early closing ${randomUUID()}`;
  await form(page).getByLabel('Monday session 1 end', { exact: true }).fill('11:30');
  await reviewDraft(page, invalidReason);
  const rejected = await submit(page, doctor.id, 409);
  expect((await rejected.json()).error).toContain('would invalidate 1 booked appointment');
  expect(await get<WeeklyAvailabilityContext>(page.request, path(doctor.id))).toEqual(
    first.context,
  );
  await expect(form(page).getByLabel('Monday session 1 end', { exact: true })).toBeEnabled();
  await expect(form(page).getByLabel(reviewLabel, { exact: true })).not.toBeChecked();
  await expect(form(page).getByLabel('Monday session 1 end', { exact: true })).toHaveValue('11:30');
  await form(page).getByLabel('Monday session 1 end', { exact: true }).fill('17:00');
  await form(page)
    .getByRole('combobox', { name: 'Appointment length', exact: true })
    .selectOption('20');
  const reason = `Private reviewed twenty-minute default ${randomUUID()}`;
  await reviewDraft(page, reason);
  const saved = (await (await submit(page, doctor.id)).json()) as WeeklyAvailabilityMutation;
  expect(saved.context.schedule.durationMinutes).toBe(20);
  expect((await get<{ closures: unknown[] }>(page.request, '/api/scheduling')).closures).toEqual(
    closuresBefore,
  );
  const appointments = await get<Appointment[]>(
    page.request,
    '/api/appointments?patientId=patient-ananya',
  );
  expect(appointments.find((entry) => entry.id === ordinary.id)).toEqual(ordinary);
  expect(appointments.find((entry) => entry.id === longer.appointment.id)).toEqual(
    longer.appointment,
  );
  expect(ordinary.durationMinutes).toBe(30);
  expect(longer.appointment.durationMinutes).toBe(60);
  expect(JSON.stringify(await get(page.request, `/api/schedules/${doctor.id}`))).not.toContain(
    reason,
  );
  await audit(page);
  await page.screenshot({
    path: testInfo.outputPath('weekly-availability-mobile.png'),
    fullPage: true,
  });

  const patient = await browser.newContext({ baseURL });
  try {
    await login(patient.request, 'patient@derma.demo');
    const portal = await patient.newPage();
    await portal.goto(`/book?doctor=${doctor.id}`);
    await portal.getByLabel('Appointment date', { exact: true }).fill(monday);
    const slots = portal.getByRole('group', { name: 'Available appointment times', exact: true });
    await expect(slots.getByRole('button', { name: '09:40', exact: true })).toBeVisible();
    await expect(slots.getByRole('button', { name: '09:00', exact: true })).toHaveCount(0);
    await expect(slots.getByRole('button', { name: '09:20', exact: true })).toHaveCount(0);
    for (const time of ['11:00', '11:20', '11:40'])
      await expect(slots.getByRole('button', { name: time, exact: true })).toHaveCount(0);
    await expect(slots.getByRole('button', { name: '12:00', exact: true })).toBeVisible();
    await slots.getByRole('button', { name: '09:40', exact: true }).click();
    await portal
      .getByLabel('Main reason for your visit', { exact: true })
      .fill('Synthetic booking under the reviewed weekly schedule.');
    const booking = responseFor(portal, '/api/appointments');
    await portal.getByRole('button', { name: 'Confirm appointment', exact: true }).click();
    const response = await booking;
    expect(response.status()).toBe(201);
    const booked = (await response.json()) as Appointment;
    expect(booked).toMatchObject({
      doctorId: doctor.id,
      date: monday,
      time: '09:40',
      durationMinutes: 20,
    });
    await expect(
      portal.getByRole('heading', { name: 'You’re booked in.', exact: true }),
    ).toBeVisible();
    for (const endpoint of [path(doctor.id), `${path(doctor.id)}/history`])
      expect((await patient.request.get(endpoint)).status()).toBe(403);
    const summary = await get<unknown>(
      patient.request,
      '/api/patients/patient-ananya/care-summary',
    );
    for (const privateReason of [firstReason, invalidReason, reason])
      expect(JSON.stringify(summary)).not.toContain(privateReason);
  } finally {
    await patient.close();
  }
});

test('weekly ABA conflicts preserve the draft and uncertain replies retain one command after later errors and newer schedules', async ({
  page,
}) => {
  const admin = await login(page.request);
  const doctor = await createDoctor(page.request, admin.headers);
  const inherited = await get<WeeklyAvailabilityContext>(page.request, path(doctor.id));
  const initial = await saveSchedule(
    page.request,
    admin.headers,
    doctor.id,
    values(inherited.schedule),
    'First explicit synthetic baseline.',
  );
  const reason = `Private retained weekly intent ${randomUUID()}`;
  const restoredReason = `Private restored same values ${randomUUID()}`;
  await openEditor(page, doctor.id);
  await form(page)
    .getByRole('combobox', { name: 'Appointment length', exact: true })
    .selectOption('20');
  await reviewDraft(page, reason);
  await saveSchedule(
    page.request,
    admin.headers,
    doctor.id,
    { ...values(initial.context.schedule), durationMinutes: 45 },
    'Private intervening synthetic schedule.',
  );
  const restored = await saveSchedule(
    page.request,
    admin.headers,
    doctor.id,
    values(initial.context.schedule),
    restoredReason,
  );
  expect(values(restored.context.schedule)).toEqual(values(initial.context.schedule));
  expect(restored.context.revision).not.toBe(initial.context.revision);
  const stale = await submit(page, doctor.id, 409);
  const staleBody = stale.request().postDataJSON() as WeeklyAvailabilityInput;
  await expect(
    form(page).getByRole('combobox', { name: 'Appointment length', exact: true }),
  ).toHaveValue('20');
  await expect(
    form(page).getByLabel('Reason for availability change', { exact: true }),
  ).toHaveValue(reason);
  await form(page)
    .getByRole('button', { name: 'Refresh latest availability', exact: true })
    .click();
  await expect(form(page).getByText(restoredReason, { exact: false })).toBeVisible();
  await form(page).getByRole('button', { name: keepDraft, exact: true }).click();
  await expect(form(page).getByLabel(reviewLabel, { exact: true })).not.toBeChecked();
  await form(page).getByLabel(reviewLabel, { exact: true }).check();

  const attempts: WeeklyAvailabilityInput[] = [];
  let committed: WeeklyAvailabilityMutation | undefined;
  const intercept = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.continue();
    attempts.push(route.request().postDataJSON() as WeeklyAvailabilityInput);
    if (attempts.length === 2)
      return route.fulfill({
        status: 400,
        json: { error: 'Synthetic later rejection must retain the weekly command.' },
      });
    const response = await route.fetch();
    expect(response.status(), await response.text()).toBe(attempts.length === 1 ? 201 : 200);
    const result = (await response.json()) as WeeklyAvailabilityMutation;
    if (attempts.length === 1) {
      committed = result;
      return route.fulfill({ response, json: { ...result, change: null } });
    }
    if (attempts.length === 3)
      return route.fulfill({
        response,
        json: { ...result, receipt: { ...result.receipt, actorId: randomUUID() } },
      });
    return route.fulfill({ response });
  };
  await page.route(`**${path(doctor.id)}`, intercept);
  try {
    await submit(page, doctor.id);
    await expect(
      form(page).getByRole('button', { name: 'Retry same request', exact: true }),
    ).toBeEnabled();
    await expect(
      form(page).getByRole('combobox', { name: 'Appointment length', exact: true }),
    ).toBeDisabled();
    await expect(
      form(page).getByLabel('Reason for availability change', { exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole('combobox', { name: 'Doctor schedule', exact: true }),
    ).toBeDisabled();
    expect(committed).toBeDefined();
    expect(attempts[0].requestId).not.toBe(staleBody.requestId);
    expect(attempts[0].expectedRevision).toBe(restored.context.revision);
    const newer = await saveSchedule(
      page.request,
      admin.headers,
      doctor.id,
      { ...values(committed!.context.schedule), durationMinutes: 60 },
      'Private later current sixty-minute schedule.',
    );
    for (const count of [2, 3]) {
      const waiting = responseFor(page, path(doctor.id));
      await form(page).getByRole('button', { name: 'Retry same request', exact: true }).click();
      expect((await waiting).status()).toBe(count === 2 ? 400 : 200);
      await expect(
        form(page).getByRole('button', { name: 'Retry same request', exact: true }),
      ).toBeEnabled();
      await expect(
        form(page).getByRole('combobox', { name: 'Appointment length', exact: true }),
      ).toHaveValue('20');
      await expect(
        form(page).getByLabel('Reason for availability change', { exact: true }),
      ).toBeDisabled();
      expect(attempts).toHaveLength(count);
    }
    const final = responseFor(page, path(doctor.id));
    await form(page).getByRole('button', { name: 'Retry same request', exact: true }).click();
    const response = await final;
    expect(response.status()).toBe(200);
    const replay = (await response.json()) as WeeklyAvailabilityMutation;
    expect(replay.change).toEqual(committed!.change);
    expect(replay.context).toEqual(newer.context);
    await expect(
      form(page).getByRole('combobox', { name: 'Appointment length', exact: true }),
    ).toHaveValue('60');
    await expect(
      form(page).getByLabel('Reason for availability change', { exact: true }),
    ).toHaveValue('');
    await expect(
      page.getByRole('combobox', { name: 'Doctor schedule', exact: true }),
    ).toBeEnabled();
    expect(attempts).toHaveLength(4);
    for (const attempt of attempts) expect(attempt).toEqual(attempts[0]);
    const history = await get<WeeklyAvailabilityHistory>(
      page.request,
      `${path(doctor.id)}/history?pageSize=50`,
    );
    expect(history.items.filter((change) => change.reason === reason)).toEqual([committed!.change]);
  } finally {
    await page.unroute(`**${path(doctor.id)}`, intercept);
  }
});

test('an unsent weekly change can recover from a definitive stale retry without losing the reviewed draft', async ({
  page,
}) => {
  const admin = await login(page.request);
  const doctor = await createDoctor(page.request, admin.headers);
  const initial = await get<WeeklyAvailabilityContext>(page.request, path(doctor.id));
  const reason = `Private unsent weekly intent ${randomUUID()}`;
  const concurrentReason = `Private other administrator change ${randomUUID()}`;
  const attempts: WeeklyAvailabilityInput[] = [];
  const intercept = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.continue();
    attempts.push(route.request().postDataJSON() as WeeklyAvailabilityInput);
    if (attempts.length === 1) return route.abort('failed');
    return route.continue();
  };
  await openEditor(page, doctor.id);
  await form(page)
    .getByRole('combobox', { name: 'Appointment length', exact: true })
    .selectOption('20');
  await reviewDraft(page, reason);
  await page.route(`**${path(doctor.id)}`, intercept);
  try {
    const failed = page.waitForEvent(
      'requestfailed',
      (request) =>
        new URL(request.url()).pathname === path(doctor.id) && request.method() === 'POST',
    );
    await form(page).getByRole('button', { name: 'Save availability', exact: true }).click();
    await failed;
    await expect(
      form(page).getByRole('button', { name: 'Retry same request', exact: true }),
    ).toBeEnabled();
    expect(await get<WeeklyAvailabilityContext>(page.request, path(doctor.id))).toEqual(initial);
    const changed = await saveSchedule(
      page.request,
      admin.headers,
      doctor.id,
      { ...values(initial.schedule), durationMinutes: 45 },
      concurrentReason,
    );
    const retry = responseFor(page, path(doctor.id));
    await form(page).getByRole('button', { name: 'Retry same request', exact: true }).click();
    expect((await retry).status()).toBe(409);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    await expect(
      form(page).getByRole('button', { name: 'Retry same request', exact: true }),
    ).toHaveCount(0);
    await expect(
      form(page).getByRole('combobox', { name: 'Appointment length', exact: true }),
    ).toHaveValue('20');
    await expect(
      form(page).getByLabel('Reason for availability change', { exact: true }),
    ).toHaveValue(reason);
    await form(page)
      .getByRole('button', { name: 'Refresh latest availability', exact: true })
      .click();
    await expect(form(page).getByText(concurrentReason, { exact: false })).toBeVisible();
    await form(page).getByRole('button', { name: keepDraft, exact: true }).click();
    await expect(form(page).getByLabel(reviewLabel, { exact: true })).not.toBeChecked();
    await expect(
      form(page).getByRole('combobox', { name: 'Appointment length', exact: true }),
    ).toHaveValue('20');
    await form(page).getByLabel(reviewLabel, { exact: true }).check();
    const result = (await (await submit(page, doctor.id)).json()) as WeeklyAvailabilityMutation;
    await expect(
      form(page).getByLabel('Reason for availability change', { exact: true }),
    ).toHaveValue('');
    expect(attempts).toHaveLength(3);
    expect(attempts[2].requestId).not.toBe(attempts[0].requestId);
    expect(attempts[2].expectedRevision).toBe(changed.context.revision);
    expect(attempts[2].schedule).toEqual(attempts[0].schedule);
    expect(attempts[2].reason).toBe(reason);
    expect(result.change.before).toEqual({
      source: 'explicit',
      schedule: changed.context.schedule,
    });
    const history = await get<WeeklyAvailabilityHistory>(
      page.request,
      `${path(doctor.id)}/history`,
    );
    expect(history.total).toBe(2);
    expect(history.items.filter((change) => change.reason === reason)).toEqual([result.change]);
  } finally {
    await page.unroute(`**${path(doctor.id)}`, intercept);
  }
});

test('private weekly history is paged and role scoped, and late saves or history reads cannot affect a different doctor or returned page', async ({
  page,
  browser,
  playwright,
  baseURL,
}, testInfo) => {
  test.setTimeout(120000);
  const admin = await login(page.request);
  const doctor = await createDoctor(page.request, admin.headers);
  const other = await createDoctor(page.request, admin.headers);
  const initial = await get<WeeklyAvailabilityContext>(page.request, path(doctor.id));
  const suffix = randomUUID().slice(0, 8);
  let latest: WeeklyAvailabilityMutation | undefined;
  for (let index = 0; index < 26; index++)
    latest = await saveSchedule(
      page.request,
      admin.headers,
      doctor.id,
      {
        ...values(initial.schedule),
        durationMinutes: index % 2 ? 30 : 20,
      },
      `Private weekly history ${suffix} ${index}`,
    );
  let unavailable = true;
  const badRead = async (route: Route) =>
    unavailable
      ? route.fulfill({
          status: 503,
          json: { error: 'Synthetic weekly history is temporarily unavailable.' },
        })
      : route.continue();
  const historyPattern = `**${path(doctor.id)}/history?*`;
  await page.route(historyPattern, badRead);
  const historyDialog = () =>
    page.getByRole('dialog', { name: 'Weekly availability history', exact: true });
  try {
    await openEditor(page, doctor.id);
    await page.getByRole('button', { name: 'Weekly change history', exact: true }).click();
    await expect(historyDialog().getByRole('alert')).toContainText('Synthetic weekly history');
    unavailable = false;
    await historyDialog().getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(historyDialog().locator('.weekly-availability-change')).toHaveCount(25);
  } finally {
    await page.unroute(historyPattern, badRead);
  }
  const pagination = historyDialog().getByRole('navigation', {
    name: 'Weekly availability history pagination',
    exact: true,
  });
  await pagination.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(historyDialog().locator('.weekly-availability-change')).toHaveCount(1);
  await pagination.getByRole('button', { name: 'Previous page', exact: true }).click();
  await expect(historyDialog().locator('.weekly-availability-change')).toHaveCount(25);
  await expect(historyDialog()).toContainText(`Private weekly history ${suffix}`);
  await audit(page);
  await page.screenshot({
    path: testInfo.outputPath('weekly-availability-history-mobile.png'),
    fullPage: true,
  });
  await historyDialog().getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 900 });

  const physician = await playwright.request.newContext({ baseURL });
  try {
    const identity = await login(physician, 'doctor@derma.demo');
    const own = identity.session.user!.doctorId!;
    expect((await physician.get(path(own))).status()).toBe(200);
    expect((await physician.get(`${path(own)}/history`)).status()).toBe(200);
    for (const endpoint of [path(doctor.id), `${path(doctor.id)}/history`])
      expect((await physician.get(endpoint)).status()).toBe(403);
    expect((await physician.get(`/api/schedules/${doctor.id}`)).status()).toBe(200);
    const denied = await physician.post(path(doctor.id), {
      headers: identity.headers,
      data: {
        schedule: { ...values(initial.schedule), durationMinutes: 45 },
        reason: 'Unauthorized private weekly change',
        expectedRevision: latest!.context.revision,
        requestId: randomUUID(),
      },
    });
    expect(denied.status()).toBe(403);
  } finally {
    await physician.dispose();
  }
  const reception = await browser.newContext({ baseURL });
  try {
    await login(reception.request, 'reception@derma.demo');
    const staff = await reception.newPage();
    await staff.goto('/clinic/scheduling');
    await staff
      .getByRole('combobox', { name: 'Doctor schedule', exact: true })
      .selectOption(doctor.id);
    await expect(
      staff.getByRole('combobox', { name: 'Appointment length', exact: true }),
    ).toBeDisabled();
    await expect(
      staff.getByRole('button', { name: 'Weekly change history', exact: true }),
    ).toHaveCount(0);
    await expect(staff.getByLabel('Reason for availability change', { exact: true })).toHaveCount(
      0,
    );
    const schedule = await get<DoctorSchedule>(reception.request, `/api/schedules/${doctor.id}`);
    expect(schedule).toEqual(latest!.context.schedule);
    expect(JSON.stringify(schedule)).not.toContain(`Private weekly history ${suffix}`);
    expect((await reception.request.get(`${path(doctor.id)}/history`)).status()).toBe(403);
  } finally {
    await reception.close();
  }

  await page.evaluate(() => {
    const state = window as unknown as {
      weeklyBodies: Record<string, number>;
      weeklyExpired: number;
    };
    state.weeklyBodies = {};
    state.weeklyExpired = 0;
    window.addEventListener('derma:session-expired', () => state.weeklyExpired++);
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const response = await original(input, init);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const pathname = new URL(url, window.location.origin).pathname;
      if (pathname.startsWith('/api/schedules/') && pathname.includes('/availability')) {
        const json = response.json.bind(response);
        response.json = async () => {
          try {
            return await json();
          } finally {
            const key = `${init?.method ?? 'GET'} ${pathname} ${response.status}`;
            state.weeklyBodies[key] = (state.weeklyBodies[key] ?? 0) + 1;
          }
        };
      }
      return response;
    };
  });
  const arrived = deferred(),
    releaseRead = deferred();
  let heldReads = 0,
    settledReads = 0;
  const staleRead = async (route: Route) => {
    heldReads++;
    arrived.resolve();
    await releaseRead.promise;
    try {
      await route.fulfill({
        status: 401,
        json: { error: 'Obsolete weekly history must not expire a valid session.' },
      });
    } finally {
      settledReads++;
    }
  };
  await page.route(historyPattern, staleRead);
  try {
    await page.getByRole('button', { name: 'Weekly change history', exact: true }).click();
    await arrived.promise;
    await historyDialog().getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page
      .getByRole('combobox', { name: 'Doctor schedule', exact: true })
      .selectOption(other.id);
    await expect(
      form(page).getByRole('combobox', { name: 'Appointment length', exact: true }),
    ).toHaveValue('30');
    const count = heldReads;
    releaseRead.resolve();
    await expect.poll(() => settledReads).toBe(count);
    await page.waitForFunction(
      ({ key, count }) =>
        (window as unknown as { weeklyBodies: Record<string, number> }).weeklyBodies[key] >= count,
      { key: `GET ${path(doctor.id)}/history 401`, count },
    );
    expect(
      await page.evaluate(() => (window as unknown as { weeklyExpired: number }).weeklyExpired),
    ).toBe(0);
    await expect(page.getByRole('combobox', { name: 'Doctor schedule', exact: true })).toHaveValue(
      other.id,
    );
    expect((await get<Session>(page.request, '/api/session')).user?.id).toBe(
      admin.session.user!.id,
    );
  } finally {
    releaseRead.resolve();
    await page.unroute(historyPattern, staleRead);
  }

  await form(page)
    .getByRole('combobox', { name: 'Appointment length', exact: true })
    .selectOption('45');
  const pendingReason = `Private delayed availability command ${suffix}`;
  await reviewDraft(page, pendingReason);
  const ready = deferred(),
    release = deferred(),
    done = deferred();
  let committed: WeeklyAvailabilityMutation | undefined;
  const held = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    committed = (await response.json()) as WeeklyAvailabilityMutation;
    ready.resolve();
    await release.promise;
    try {
      await route.fulfill({ response });
    } finally {
      done.resolve();
    }
  };
  await page.route(`**${path(other.id)}`, held);
  try {
    await form(page).getByRole('button', { name: 'Save availability', exact: true }).click();
    await ready.promise;
    await expect(
      page.getByRole('combobox', { name: 'Doctor schedule', exact: true }),
    ).toBeDisabled();
    await page.evaluate(() => {
      window.history.pushState({ key: 'weekly-save-away' }, '', '/clinic');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.getByRole('heading', { name: /^A good day for better care/ })).toBeVisible();
    await page.goBack();
    await page
      .getByRole('combobox', { name: 'Doctor schedule', exact: true })
      .selectOption(doctor.id);
    await expect(
      form(page).getByRole('combobox', { name: 'Appointment length', exact: true }),
    ).toHaveValue('30');
    release.resolve();
    await done.promise;
    await page.waitForFunction(
      (key) =>
        (window as unknown as { weeklyBodies: Record<string, number> }).weeklyBodies[key] >= 1,
      `POST ${path(other.id)} 201`,
    );
    await expect(page.getByRole('combobox', { name: 'Doctor schedule', exact: true })).toHaveValue(
      doctor.id,
    );
    await expect(
      form(page).getByRole('combobox', { name: 'Appointment length', exact: true }),
    ).toHaveValue('30');
    await expect(
      form(page).getByLabel('Reason for availability change', { exact: true }),
    ).toHaveValue('');
    await expect(
      page.getByRole('button', { name: 'Dismiss notification', exact: true }),
    ).toHaveCount(0);
    const history = await get<WeeklyAvailabilityHistory>(page.request, `${path(other.id)}/history`);
    expect(history.items).toEqual([committed!.change]);
  } finally {
    release.resolve();
    await page.unroute(`**${path(other.id)}`, held);
  }
});
