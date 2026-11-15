import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import type { Appointment, Doctor, Session } from '../../shared/types';
import type { DoctorBookingContext } from '../../shared/doctor-booking';
import type { WaitlistEntry } from '../../shared/waitlist';
import type {
  AppointmentBookingInput,
  AppointmentBookingResult,
} from '../../shared/appointment-booking';

const endpoint = '/api/appointment-bookings';
const future = (days = 45) => {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
};
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
async function post<T>(
  request: APIRequestContext,
  headers: Record<string, string>,
  path: string,
  data: unknown,
  code = 201,
): Promise<T> {
  const response = await request.post(path, { headers, data });
  expect(response.status(), await response.text()).toBe(code);
  return response.json();
}
async function doctor(request: APIRequestContext, headers: Record<string, string>) {
  const value = await post<Doctor>(request, headers, '/api/doctors', {
    name: `Dr. Safe Booking ${randomUUID().slice(0, 8)}`,
    title: 'Dermatologist',
    qualifications: 'Synthetic profile',
    specialties: ['General dermatology'],
    experience: 5,
    fee: 700,
    bio: 'Synthetic booking receipt verification.',
    languages: ['English'],
  });
  const saved = await request.put(`/api/schedules/${value.id}`, {
    headers,
    data: {
      durationMinutes: 30,
      windows: Array.from({ length: 7 }, (_, day) => ({
        day,
        start: '09:00',
        end: '18:00',
        mode: 'both',
      })),
    },
  });
  expect(saved.status(), await saved.text()).toBe(200);
  return value;
}
async function pause(
  request: APIRequestContext,
  headers: Record<string, string>,
  doctorId: string,
  acceptingNewBookings: boolean,
) {
  const path = `/api/doctors/${doctorId}/booking-status`;
  const context = await get<DoctorBookingContext>(request, path);
  return post(request, headers, path, {
    acceptingNewBookings,
    reason: 'Synthetic booking replay check.',
    expectedRevision: context.revision,
    requestId: randomUUID(),
  });
}
async function patch(
  request: APIRequestContext,
  headers: Record<string, string>,
  id: string,
  data: unknown,
) {
  const response = await request.patch(`/api/appointments/${id}`, { headers, data });
  expect(response.status(), await response.text()).toBe(200);
  return response.json() as Promise<Appointment>;
}
async function patientDraft(
  page: Page,
  doctorId: string,
  date: string,
  reason: string,
  waitlistId?: string,
) {
  await page.goto(`/book?${waitlistId ? `waitlist=${waitlistId}` : `doctor=${doctorId}`}`);
  await page.getByLabel('Appointment date', { exact: true }).fill(date);
  await page.getByRole('button', { name: '09:00', exact: true }).click();
  await page.getByLabel('Main reason for your visit', { exact: true }).fill(reason);
}
async function submit(page: Page, label = 'Confirm appointment') {
  const response = page.waitForResponse(
    (value) => new URL(value.url()).pathname === endpoint && value.request().method() === 'POST',
  );
  await page.getByRole('button', { name: label, exact: true }).click();
  return response;
}
async function uncertain(page: Page) {
  await expect(
    page.getByText('The booking outcome could not be confirmed.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry same request', exact: true })).toBeEnabled();
  await expect(page.getByLabel('Appointment date', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Main reason for your visit', { exact: true })).toBeDisabled();
}
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
async function navigate(page: Page, path: string) {
  await page.evaluate((path) => {
    window.history.pushState({ key: crypto.randomUUID() }, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}
async function observeConsumedResponses(page: Page) {
  await page.evaluate(() => {
    const original = window.fetch.bind(window);
    const observed = window as Window & { bookingResponses?: string[] };
    observed.bookingResponses = [];
    window.fetch = async (...args) => {
      const response = await original(...args);
      const marker = response.headers.get('X-Test-Booking-Settled');
      if (marker) {
        const json = response.json.bind(response);
        response.json = async () => {
          try {
            return await json();
          } finally {
            observed.bookingResponses!.push(marker);
          }
        };
      }
      return response;
    };
  });
}
async function consumed(page: Page, marker: string) {
  await expect
    .poll(() =>
      page.evaluate(
        (marker) =>
          (window as Window & { bookingResponses?: string[] }).bookingResponses?.includes(marker),
        marker,
      ),
    )
    .toBe(true);
}

test('patient retries the original booking after malformed confirmations, later errors and a moved cancelled appointment without duplicating it', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const admin = await login(page.request),
    clinician = await doctor(page.request, admin.headers);
  const context = await browser.newContext({ baseURL });
  try {
    const portal = await context.newPage(),
      patient = await login(portal.request, 'patient@derma.demo');
    const reason = `Synthetic ordinary booking ${randomUUID()}`;
    await patientDraft(portal, clinician.id, future(45), reason);
    const attempts: AppointmentBookingInput[] = [];
    let original!: AppointmentBookingResult;
    await portal.route(`**${endpoint}`, async (route) => {
      attempts.push(route.request().postDataJSON());
      if (attempts.length === 1) {
        const response = await route.fetch();
        expect(response.status()).toBe(201);
        original = await response.json();
        await route.fulfill({ status: 200, json: { ...original, appointment: null } });
      } else if (attempts.length === 2) {
        await route.fulfill({
          status: 400,
          json: { error: 'Synthetic later validation failure.' },
        });
      } else if (attempts.length === 3) {
        const response = await route.fetch();
        const value = await response.json();
        await route.fulfill({
          status: 200,
          json: { ...value, receipt: { ...value.receipt, actorId: admin.session.user!.id } },
        });
      } else if (attempts.length === 4) {
        await route.fulfill({
          status: 409,
          json: { error: 'This request ID was already used for a different booking command.' },
        });
      } else await route.continue();
    });
    await portal.getByLabel('Main reason for your visit', { exact: true }).fill('   ');
    await portal.getByRole('button', { name: 'Confirm appointment', exact: true }).click();
    await expect(
      portal.getByText('Enter a reason for your visit using 1 to 300 characters.', { exact: true }),
    ).toBeVisible();
    expect(attempts).toHaveLength(0);
    await portal.getByLabel('Main reason for your visit', { exact: true }).fill(reason);
    expect((await submit(portal)).status()).toBe(200);
    await uncertain(portal);
    await expect(portal.getByRole('button', { name: '09:00', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await audit(portal);
    await portal.screenshot({
      path: testInfo.outputPath('patient-booking-uncertain-mobile.png'),
      fullPage: true,
    });
    await pause(page.request, admin.headers, clinician.id, false);
    await patch(page.request, admin.headers, original.appointment.id, {
      date: future(46),
      time: '11:00',
    });
    await patch(page.request, admin.headers, original.appointment.id, { status: 'cancelled' });
    for (const code of [400, 200, 409]) {
      expect((await submit(portal, 'Retry same request')).status()).toBe(code);
      await uncertain(portal);
    }
    expect((await submit(portal, 'Retry same request')).status()).toBe(200);
    await expect(
      portal.getByRole('heading', { name: 'Your booking is recorded.', exact: true }),
    ).toBeVisible();
    const current = portal.locator('.patient-booking-current');
    await expect(current.getByText('cancelled', { exact: true })).toBeVisible();
    await expect(current).toContainText('11:00–11:30');
    await expect(portal.getByRole('link', { name: 'Add to calendar', exact: true })).toHaveCount(0);
    await portal.getByText('Original booking confirmation', { exact: true }).click();
    await expect(portal.locator('.patient-booking-original')).toContainText('09:00–09:30');
    expect(attempts).toHaveLength(5);
    for (const attempt of attempts) expect(attempt).toEqual(attempts[0]);
    expect(attempts[0]).toMatchObject({ patientId: patient.session.user!.patientId, reason });
    const own = (await get<Appointment[]>(portal.request, '/api/appointments')).filter(
      (value) => value.reason === reason,
    );
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({
      id: original.appointment.id,
      status: 'cancelled',
      date: future(46),
      time: '11:00',
    });
    expect(JSON.stringify(own)).not.toContain(attempts[0].requestId);
    expect(JSON.stringify(own)).not.toContain('createdById');
    await audit(portal);
    await portal.screenshot({
      path: testInfo.outputPath('patient-booking-current-cancelled-mobile.png'),
      fullPage: true,
    });
  } finally {
    await context.close();
  }
});

test('a proven uncommitted patient waitlist booking preserves edited dates and reason through rejection and creates a fresh command', async ({
  page,
  browser,
  baseURL,
}) => {
  const admin = await login(page.request),
    clinician = await doctor(page.request, admin.headers);
  const context = await browser.newContext({ baseURL });
  try {
    const portal = await context.newPage(),
      patient = await login(portal.request, 'patient@derma.demo');
    const reason = `Synthetic absent booking ${randomUUID()}`;
    const entry = await post<WaitlistEntry>(portal.request, patient.headers, '/api/waitlist', {
      doctorId: clinician.id,
      mode: 'in-person',
      startDate: future(54),
      endDate: future(56),
      reason: 'Original waiting request before the patient edits booking details.',
    });
    await patientDraft(portal, clinician.id, future(55), reason, entry.id);
    const attempts: AppointmentBookingInput[] = [];
    await portal.route(`**${endpoint}`, async (route) => {
      attempts.push(route.request().postDataJSON());
      if (attempts.length === 1) await route.abort('failed');
      else if (attempts.length === 2)
        await route.fulfill({
          status: 409,
          json: {
            error: 'Synthetic marker for a different account.',
            bookingOutcome: 'not-created',
            requestId: attempts[0].requestId,
            actorId: admin.session.user!.id,
            patientId: patient.session.user!.patientId,
          },
        });
      else await route.continue();
    });
    await portal.getByRole('button', { name: 'Confirm appointment', exact: true }).click();
    await uncertain(portal);
    await pause(page.request, admin.headers, clinician.id, false);
    expect((await submit(portal, 'Retry same request')).status()).toBe(409);
    await uncertain(portal);
    const refused = await submit(portal, 'Retry same request');
    expect(refused.status()).toBe(409);
    expect(await refused.json()).toMatchObject({
      bookingOutcome: 'not-created',
      actorId: patient.session.user!.id,
      requestId: attempts[0].requestId,
    });
    await expect(
      portal.getByRole('button', { name: 'Retry same request', exact: true }),
    ).toHaveCount(0);
    await expect(portal.getByLabel('Main reason for your visit', { exact: true })).toBeEnabled();
    await expect(portal.getByLabel('Main reason for your visit', { exact: true })).toHaveValue(
      reason,
    );
    await expect(portal.getByLabel('Appointment date', { exact: true })).toHaveValue(future(55));
    await expect(portal.getByRole('region', { name: 'Doctor booking status' })).toBeVisible();
    await pause(page.request, admin.headers, clinician.id, true);
    // The rejected UUID stays rejected even after its original slot becomes bookable again.
    const replay = await portal.request.post(endpoint, {
      headers: patient.headers,
      data: attempts[0],
    });
    expect(replay.status()).toBe(409);
    expect(await replay.json()).toMatchObject({
      bookingOutcome: 'not-created',
      requestId: attempts[0].requestId,
    });
    await portal.getByRole('button', { name: 'Refresh booking status', exact: true }).click();
    await portal.getByRole('button', { name: '09:30', exact: true }).click();
    const created = await submit(portal);
    expect(created.status()).toBe(201);
    await expect(
      portal.getByRole('heading', { name: 'You’re booked in.', exact: true }),
    ).toBeVisible();
    expect(attempts.slice(0, 3)).toEqual([attempts[0], attempts[0], attempts[0]]);
    expect(attempts[3].requestId).not.toBe(attempts[0].requestId);
    expect(attempts[3]).toMatchObject({
      reason,
      time: '09:30',
      date: future(55),
      waitlistId: entry.id,
      patientConfirmed: true,
    });
    expect(
      (await get<WaitlistEntry[]>(portal.request, '/api/waitlist')).find(
        (value) => value.id === entry.id,
      ),
    ).toMatchObject({ status: 'booked' });
    expect(
      (await get<Appointment[]>(portal.request, '/api/appointments')).filter(
        (value) => value.reason === reason,
      ),
    ).toHaveLength(1);
  } finally {
    await context.close();
  }
});

test('reception resumes an uncertain waitlist booking and patients see only its current visit after the doctor pauses and the request closes', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const admin = await login(page.request),
    clinician = await doctor(page.request, admin.headers);
  const reason = `Synthetic waitlist receipt ${randomUUID()}`;
  const entry = await post<WaitlistEntry>(page.request, admin.headers, '/api/waitlist', {
    patientId: 'patient-ananya',
    doctorId: clinician.id,
    mode: 'online',
    startDate: future(50),
    endDate: future(51),
    reason,
  });
  const context = await browser.newContext({ baseURL }),
    patientContext = await browser.newContext({ baseURL });
  try {
    const reception = await context.newPage(),
      receptionist = await login(reception.request, 'reception@derma.demo');
    await reception.goto('/clinic/waitlist');
    await reception
      .getByRole('row')
      .filter({ hasText: reason })
      .getByRole('button', { name: 'Find a slot', exact: true })
      .click();
    const dialog = reception.getByRole('dialog', {
      name: 'Book a confirmed waitlist visit',
      exact: true,
    });
    await dialog.getByLabel('Date', { exact: true }).fill(future(50));
    await dialog.locator('.clinic-time-slot').first().click();
    await dialog.getByRole('checkbox', { name: /confirmed this specific date/ }).check();
    const attempts: AppointmentBookingInput[] = [];
    let original!: AppointmentBookingResult;
    await reception.route(`**${endpoint}`, async (route) => {
      attempts.push(route.request().postDataJSON());
      if (attempts.length === 1) {
        const response = await route.fetch();
        expect(response.status()).toBe(201);
        original = await response.json();
        await route.abort('failed');
      } else await route.continue();
    });
    await dialog.getByRole('button', { name: 'Book confirmed visit', exact: true }).click();
    await expect(
      dialog.getByRole('button', { name: 'Retry same request', exact: true }),
    ).toBeEnabled();
    await expect(dialog.getByLabel('Reason for visit', { exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Close for now', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(
      reception.getByRole('button', { name: 'Resume booking', exact: true }),
    ).toBeVisible();
    await pause(page.request, admin.headers, clinician.id, false);
    await patch(page.request, admin.headers, original.appointment.id, {
      date: future(51),
      time: '10:00',
    });
    await patch(page.request, admin.headers, original.appointment.id, { status: 'cancelled' });
    const currentRequests = await get<WaitlistEntry[]>(reception.request, '/api/waitlist');
    expect(currentRequests.find((value) => value.id === entry.id)).toMatchObject({
      status: 'booked',
      appointmentId: original.appointment.id,
    });
    await reception.getByRole('button', { name: 'Resume booking', exact: true }).click();
    await expect(
      dialog.getByRole('checkbox', { name: /confirmed this specific date/ }),
    ).toBeChecked();
    const retry = reception.waitForResponse(
      (value) => new URL(value.url()).pathname === endpoint && value.request().method() === 'POST',
    );
    await dialog.getByRole('button', { name: 'Retry same request', exact: true }).click();
    expect((await retry).status()).toBe(200);
    const confirmation = reception.getByRole('dialog', {
      name: 'Booking confirmed — current appointment',
      exact: true,
    });
    await expect(confirmation).toBeVisible();
    await expect(confirmation.getByText('Cancelled', { exact: true })).toBeVisible();
    await expect(confirmation).toContainText('10:00 AM');
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(original.receipt.actorId).toBe(receptionist.session.user!.id);
    expect(original.booking).toMatchObject({ waitlistId: entry.id, patientConfirmed: true });
    await audit(reception);
    await reception.screenshot({
      path: testInfo.outputPath('staff-waitlist-booking-confirmation-mobile.png'),
      fullPage: true,
    });
    const patient = await patientContext.newPage();
    await login(patient.request, 'patient@derma.demo');
    const own = (await get<Appointment[]>(patient.request, '/api/appointments')).filter(
      (value) => value.reason === reason,
    );
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({
      id: original.appointment.id,
      status: 'cancelled',
      time: '10:00',
      mode: 'online',
    });
    expect(JSON.stringify(own)).not.toContain(original.receipt.requestId);
    expect(JSON.stringify(own)).not.toContain('createdByRole');
    await patient.goto(`/my-care?appointment=${original.appointment.id}`);
    await expect(
      patient.getByRole('region', { name: 'Current appointment details', exact: true }),
    ).toContainText('cancelled');
  } finally {
    await context.close();
    await patientContext.close();
  }
});

test('obsolete patient and staff booking responses cannot revive confirmation or expire another route after navigation and Back', async ({
  page,
  browser,
  baseURL,
}) => {
  const admin = await login(page.request),
    clinician = await doctor(page.request, admin.headers);
  const context = await browser.newContext({ baseURL });
  try {
    const portal = await context.newPage();
    await login(portal.request, 'patient@derma.demo');
    const reason = `Synthetic navigation booking ${randomUUID()}`;
    await patientDraft(portal, clinician.id, future(60), reason);
    await observeConsumedResponses(portal);
    const committed = deferred(),
      release = deferred(),
      delivered = deferred();
    let original!: AppointmentBookingResult;
    await portal.route(`**${endpoint}`, async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      original = await response.json();
      committed.resolve();
      await release.promise;
      await route
        .fulfill({
          response,
          headers: { ...response.headers(), 'X-Test-Booking-Settled': 'patient-save' },
        })
        .catch(() => undefined);
      delivered.resolve();
    });
    await portal.getByRole('button', { name: 'Confirm appointment', exact: true }).click();
    await committed.promise;
    await navigate(portal, '/my-care');
    await expect(
      portal.getByRole('heading', { name: 'Your treatment plans', exact: true }),
    ).toBeVisible();
    await portal.goBack();
    await expect(
      portal.getByRole('heading', { name: 'Let’s plan your visit', exact: true }),
    ).toBeVisible();
    release.resolve();
    await delivered.promise;
    await consumed(portal, 'patient-save');
    await expect.poll(() => portal.locator('.booking-success').count()).toBe(0);
    await expect(portal.getByLabel('Main reason for your visit', { exact: true })).toHaveValue('');
    await expect(
      portal.getByRole('button', { name: 'Retry same request', exact: true }),
    ).toHaveCount(0);
    expect(
      (await get<Appointment[]>(portal.request, '/api/appointments')).filter(
        (value) => value.reason === reason,
      ),
    ).toHaveLength(1);
    await portal.unroute(`**${endpoint}`);
    // A supporting read's late401 must not clear the session on the new page.
    const seen = deferred(),
      releaseRead = deferred(),
      readDone = deferred();
    await portal.route('**/api/slots?**', async (route) => {
      seen.resolve();
      await releaseRead.promise;
      await route
        .fulfill({
          status: 401,
          headers: { 'X-Test-Booking-Settled': 'patient-slots' },
          json: { error: 'Synthetic obsolete slots response.' },
        })
        .catch(() => undefined);
      readDone.resolve();
    });
    await portal.getByLabel('Appointment date', { exact: true }).fill(future(61));
    await seen.promise;
    await navigate(portal, `/my-care?appointment=${original.appointment.id}`);
    await expect(
      portal.getByRole('region', { name: 'Current appointment details', exact: true }),
    ).toBeVisible();
    releaseRead.resolve();
    await readDone.promise;
    await consumed(portal, 'patient-slots');
    await expect(portal).toHaveURL(
      (url) =>
        url.pathname === '/my-care' &&
        url.searchParams.get('appointment') === original.appointment.id,
    );
    expect((await get<Session>(portal.request, '/api/session')).user?.role).toBe('patient');

    await page.goto('/clinic/appointments?new=1');
    await observeConsumedResponses(page);
    const dialog = page.getByRole('dialog', { name: 'New appointment', exact: true });
    await expect(dialog).toBeVisible();
    await expect(page).toHaveURL(
      (url) => url.pathname === '/clinic/appointments' && url.search === '',
    );
    const appointmentsUrl = page.url();
    await dialog.getByLabel('Patient', { exact: true }).selectOption('patient-ananya');
    await dialog.getByLabel('Doctor', { exact: true }).selectOption(clinician.id);
    await dialog.getByLabel('Date', { exact: true }).fill(future(65));
    await dialog.locator('.clinic-time-slot').first().click();
    await dialog
      .getByLabel('Reason for visit', { exact: true })
      .fill('Synthetic late staff authorization response.');
    const staffSeen = deferred(),
      staffRelease = deferred(),
      staffDone = deferred();
    await page.route(`**${endpoint}`, async (route) => {
      staffSeen.resolve();
      await staffRelease.promise;
      await route
        .fulfill({
          status: 401,
          headers: { 'X-Test-Booking-Settled': 'staff-save' },
          json: { error: 'Synthetic obsolete booking response.' },
        })
        .catch(() => undefined);
      staffDone.resolve();
    });
    await dialog.getByRole('button', { name: 'Book appointment', exact: true }).click();
    await staffSeen.promise;
    await navigate(page, '/clinic');
    await expect(page.getByRole('heading', { name: /A good day for better care/ })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Appointments', exact: true })).toBeVisible();
    staffRelease.resolve();
    await staffDone.promise;
    await consumed(page, 'staff-save');
    await expect(page).toHaveURL(appointmentsUrl);
    await expect(page.getByRole('button', { name: 'Resume booking', exact: true })).toHaveCount(0);
    await expect(
      page.getByText('Synthetic obsolete booking response.', { exact: true }),
    ).toHaveCount(0);
    expect((await get<Session>(page.request, '/api/session')).user?.id).toBe(
      admin.session.user!.id,
    );
  } finally {
    await context.close();
  }
});
