import { test, expect, type APIRequestContext, type Page, type Locator } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import type { Appointment, Doctor, Session } from '../../shared/types';
import type {
  AppointmentRescheduleContext,
  AppointmentReschedulePreview,
  AppointmentRescheduleInput,
  AppointmentRescheduleResult,
} from '../../shared/appointment-rescheduling';
import type { AppointmentResourceContext, ResourceDetail } from '../../shared/clinic-resources';
import type { VisitDurationMutation } from '../../shared/visit-duration';
import type { DoctorBookingContext } from '../../shared/doctor-booking';

const base = (id: string) => `/api/appointments/${id}`;
const patientAgreement = 'I agree to this exact appointment change.';
const staffAgreement = 'I confirmed this exact appointment change with the patient.';
const future = (days: number) => {
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
async function get<T>(request: APIRequestContext, url: string): Promise<T> {
  const response = await request.get(url);
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}
async function post<T>(
  request: APIRequestContext,
  headers: Record<string, string>,
  url: string,
  data: unknown,
  code = 201,
): Promise<T> {
  const response = await request.post(url, { headers, data });
  expect(response.status(), await response.text()).toBe(code);
  return response.json();
}
async function schedule(
  request: APIRequestContext,
  headers: Record<string, string>,
  id: string,
  minutes: number,
) {
  const response = await request.put(`/api/schedules/${id}`, {
    headers,
    data: {
      durationMinutes: minutes,
      windows: Array.from({ length: 7 }, (_, day) => ({
        day,
        start: '08:00',
        end: '18:00',
        mode: 'both',
      })),
    },
  });
  expect(response.status(), await response.text()).toBe(200);
}
async function doctor(request: APIRequestContext, headers: Record<string, string>, minutes = 30) {
  const value = await post<Doctor>(request, headers, '/api/doctors', {
    name: `Dr. Reviewed Move ${randomUUID().slice(0, 8)}`,
    title: 'Dermatologist',
    qualifications: 'Synthetic profile',
    specialties: ['General dermatology'],
    experience: 4,
    fee: 600,
    bio: 'Synthetic reviewed appointment fixture.',
    languages: ['English'],
  });
  await schedule(request, headers, value.id, minutes);
  return value;
}
async function book(
  request: APIRequestContext,
  headers: Record<string, string>,
  doctorId: string,
  date: string,
  time = '09:00',
  patientId = 'patient-ananya',
) {
  return post<Appointment>(request, headers, '/api/appointments', {
    doctorId,
    patientId,
    date,
    time,
    mode: 'in-person',
    reason: `Synthetic reviewed move ${randomUUID()}`,
  });
}
async function patch(
  request: APIRequestContext,
  headers: Record<string, string>,
  id: string,
  data: unknown,
) {
  const response = await request.patch(base(id), { headers, data });
  expect(response.status(), await response.text()).toBe(200);
  return response.json() as Promise<Appointment>;
}
async function changeDoctor(
  request: APIRequestContext,
  headers: Record<string, string>,
  value: Doctor,
  fee: number,
) {
  const response = await request.patch(`/api/doctors/${value.id}`, {
    headers,
    data: { ...value, name: `${value.name} Updated`, fee },
  });
  expect(response.status(), await response.text()).toBe(200);
  return response.json() as Promise<Doctor>;
}
async function pause(request: APIRequestContext, headers: Record<string, string>, id: string) {
  const url = `/api/doctors/${id}/booking-status`,
    context = await get<DoctorBookingContext>(request, url);
  await post(request, headers, url, {
    acceptingNewBookings: false,
    reason: 'Synthetic pause during a retained visit.',
    expectedRevision: context.revision,
    requestId: randomUUID(),
  });
}
async function room(request: APIRequestContext, headers: Record<string, string>) {
  return post<ResourceDetail>(request, headers, '/api/clinic-resources', {
    name: `PRIVATE room ${randomUUID()}`,
    kind: 'room',
    location: 'PRIVATE operational location',
    notes: 'PRIVATE reservation notes',
    requestId: randomUUID(),
  });
}
async function resources(
  request: APIRequestContext,
  headers: Record<string, string>,
  appointmentId: string,
  resourceId: string,
) {
  const context = await get<AppointmentResourceContext>(
    request,
    `${base(appointmentId)}/resources`,
  );
  const response = await request.put(`${base(appointmentId)}/resources`, {
    headers,
    data: {
      resourceIds: [resourceId],
      reason: 'PRIVATE allocation context',
      expectedRevision: context.revision,
      requestId: randomUUID(),
    },
  });
  expect(response.status(), await response.text()).toBe(200);
  return response.json() as Promise<AppointmentResourceContext>;
}
async function target(scope: Page | Locator, date: string, time: string, doctorId?: string) {
  if (doctorId) await scope.getByLabel('New doctor', { exact: true }).selectOption(doctorId);
  await scope.getByLabel('New date', { exact: true }).fill(date);
  await scope.getByLabel('New time · IST', { exact: true }).fill(time);
}
async function preview(page: Page, scope: Page | Locator, id: string, code = 200) {
  const waiting = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `${base(id)}/reschedule-preview` &&
      response.request().method() === 'POST',
  );
  await scope.getByRole('button', { name: 'Review change', exact: true }).click();
  const response = await waiting;
  expect(response.status(), await response.text()).toBe(code);
  return response.json() as Promise<AppointmentReschedulePreview>;
}
async function confirm(
  page: Page,
  scope: Page | Locator,
  id: string,
  code = 201,
  label = 'Confirm reschedule',
) {
  const waiting = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `${base(id)}/reschedules` &&
      response.request().method() === 'POST',
  );
  await scope.getByRole('button', { name: label, exact: true }).click();
  const response = await waiting;
  expect(response.status(), await response.text()).toBe(code);
  return response;
}
async function openStaff(page: Page, appointment: Appointment) {
  await page.goto(`/clinic/appointments?date=${appointment.date}`);
  const row = page.getByRole('row').filter({ hasText: appointment.reason });
  await row
    .getByRole('button', { name: `More actions for ${appointment.patientName}`, exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Reschedule appointment', exact: true })
    .click();
  return page.getByRole('dialog', { name: 'Reschedule appointment', exact: true });
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
async function navigate(page: Page, url: string) {
  await page.evaluate((url) => {
    window.history.pushState({ key: crypto.randomUUID() }, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, url);
}
async function observeResponses(page: Page) {
  await page.evaluate(() => {
    const original = window.fetch.bind(window),
      state = window as Window & { rescheduleConsumed?: string[]; rescheduleExpired?: number };
    state.rescheduleConsumed = [];
    state.rescheduleExpired = 0;
    window.addEventListener('derma:session-expired', () => state.rescheduleExpired!++);
    window.fetch = async (...args) => {
      const response = await original(...args),
        marker = response.headers.get('X-Test-Reschedule-Settled');
      if (marker) {
        const json = response.json.bind(response);
        response.json = async () => {
          try {
            return await json();
          } finally {
            state.rescheduleConsumed!.push(marker);
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
          (window as Window & { rescheduleConsumed?: string[] }).rescheduleConsumed?.includes(
            marker,
          ),
        marker,
      ),
    )
    .toBe(true);
}

test('patient reviews a changed source, current default length and fee before moving retained resources with a paused doctor', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const admin = await login(page.request),
    clinician = await doctor(page.request, admin.headers);
  const original = await book(page.request, admin.headers, clinician.id, future(30));
  const assigned = await room(page.request, admin.headers);
  await resources(page.request, admin.headers, original.id, assigned.resource.id);
  const owner = await browser.newContext({ baseURL });
  try {
    const portal = await owner.newPage();
    await login(portal.request, 'patient@derma.demo');
    await portal.goto(`/book?appointmentId=${original.id}`);
    await expect(portal.locator('.appointment-reschedule-source')).toContainText('30 minutes');
    await target(portal, future(32), '11:00');
    await patch(page.request, admin.headers, original.id, { date: future(31), time: '10:00' });
    await schedule(page.request, admin.headers, clinician.id, 60);
    const changed = await changeDoctor(page.request, admin.headers, clinician, 900);
    await preview(portal, portal, original.id, 409);
    await expect(
      portal.getByText(
        'The appointment changed. Review the latest visit before previewing a new time.',
        { exact: true },
      ),
    ).toBeVisible();
    await portal.getByRole('button', { name: 'Refresh current visit', exact: true }).click();
    await expect(portal.locator('.appointment-reschedule-source')).toContainText('10:00');
    await expect(portal.getByLabel('New date', { exact: true })).toHaveValue(future(32));
    await expect(portal.getByLabel('New time · IST', { exact: true })).toHaveValue('11:00');
    await pause(page.request, admin.headers, clinician.id);
    const proposed = await preview(portal, portal, original.id);
    expect(proposed.before).toMatchObject({
      date: future(31),
      time: '10:00',
      durationMinutes: 30,
      fee: 600,
    });
    expect(proposed.after).toMatchObject({
      date: future(32),
      time: '11:00',
      durationMinutes: 60,
      fee: 900,
      doctorName: changed.name,
    });
    expect(JSON.stringify(proposed)).not.toContain('PRIVATE');
    expect(JSON.stringify(proposed)).not.toContain(assigned.resource.id);
    await expect(portal.locator('.appointment-reschedule-before')).toContainText('30 minutes');
    await expect(portal.locator('.appointment-reschedule-after')).toContainText('60 minutes');
    await expect(portal.locator('.appointment-reschedule-after')).toContainText('₹900');
    await expect(
      portal.getByRole('button', { name: 'Confirm reschedule', exact: true }),
    ).toBeDisabled();
    await portal.getByLabel(patientAgreement, { exact: true }).check();
    await audit(portal);
    await portal.screenshot({
      path: testInfo.outputPath('patient-reviewed-reschedule-mobile.png'),
      fullPage: true,
    });
    const saved = (await (
      await confirm(portal, portal, original.id)
    ).json()) as AppointmentRescheduleResult;
    await expect(
      portal.getByRole('heading', { name: 'Reschedule confirmed', exact: true }),
    ).toBeVisible();
    await expect(portal.locator('.appointment-reschedule-current')).toContainText('60 minutes');
    expect(saved.event.before).toEqual(proposed.before);
    expect(saved.event.after).toEqual(proposed.after);
    const retained = await get<AppointmentResourceContext>(
      page.request,
      `${base(original.id)}/resources`,
    );
    expect(retained.resourceIds).toEqual([assigned.resource.id]);
    expect(retained.history[0]).toMatchObject({
      source: 'appointment-rescheduled',
      before: { appointment: { time: '10:00', durationMinutes: 30 } },
      after: { appointment: { date: future(32), time: '11:00', durationMinutes: 60 } },
    });
    const calendar = await portal.request.get(`${base(original.id)}/calendar`);
    expect(calendar.status()).toBe(200);
    const raw = await calendar.text();
    expect(raw).toContain(`DTSTART:${future(32).replaceAll('-', '')}T053000Z`);
    expect(raw).toContain(`DTEND:${future(32).replaceAll('-', '')}T063000Z`);
    const own = await get<Appointment[]>(portal.request, '/api/appointments');
    expect(own.find((value) => value.id === original.id)).toMatchObject({
      doctorName: changed.name,
      fee: 900,
      durationMinutes: 60,
    });
    expect(JSON.stringify(own)).not.toContain(saved.receipt.requestId);
    expect(JSON.stringify(own)).not.toContain('expectedRevision');
  } finally {
    await owner.close();
  }
});

test('custom patient visits retain their full length and reject a resource overlap without exposing operational data', async ({
  page,
  browser,
  baseURL,
}) => {
  const admin = await login(page.request),
    clinician = await doctor(page.request, admin.headers),
    otherDoctor = await doctor(page.request, admin.headers);
  const custom = await post<VisitDurationMutation>(
    page.request,
    admin.headers,
    '/api/visit-duration/bookings',
    {
      patientId: 'patient-ananya',
      doctorId: clinician.id,
      date: future(40),
      time: '08:00',
      mode: 'in-person',
      reason: 'Synthetic retained custom duration',
      durationMinutes: 90,
      requestId: randomUUID(),
    },
  );
  const otherPatient = await post<{ id: string }>(page.request, admin.headers, '/api/patients', {
    name: `PRIVATE other patient ${randomUUID()}`,
    email: '',
    phone: '+91 9000000100',
    dob: '',
    gender: '',
  });
  const competing = await book(
    page.request,
    admin.headers,
    otherDoctor.id,
    future(41),
    '11:00',
    otherPatient.id,
  );
  const assigned = await room(page.request, admin.headers);
  await resources(page.request, admin.headers, custom.appointment.id, assigned.resource.id);
  await resources(page.request, admin.headers, competing.id, assigned.resource.id);
  await schedule(page.request, admin.headers, clinician.id, 15);
  await changeDoctor(page.request, admin.headers, clinician, 850);
  const owner = await browser.newContext({ baseURL });
  try {
    const portal = await owner.newPage();
    await login(portal.request, 'patient@derma.demo');
    await portal.goto(`/book?appointmentId=${custom.appointment.id}`);
    await expect(portal.locator('.appointment-reschedule-source')).toContainText('90 minutes');
    await expect(portal.getByLabel('Custom duration (minutes)', { exact: true })).toHaveCount(0);
    await target(portal, future(41), '09:35');
    const times = portal.getByRole('group', { name: 'Available appointment times', exact: true });
    await expect(times.getByRole('button', { name: '09:30', exact: true })).toBeVisible();
    await expect(times.getByRole('button', { name: '09:35', exact: true })).toHaveCount(0);
    const blocked = await preview(portal, portal, custom.appointment.id);
    expect(blocked.canReschedule).toBe(false);
    expect(blocked.after.durationMinutes).toBe(90);
    expect(JSON.stringify(blocked)).not.toContain('PRIVATE');
    expect(JSON.stringify(blocked)).not.toContain(assigned.resource.id);
    await expect(
      portal.getByRole('button', { name: 'Confirm reschedule', exact: true }),
    ).toBeDisabled();
    expect(
      (
        await get<AppointmentRescheduleContext>(
          portal.request,
          `${base(custom.appointment.id)}/reschedule-context`,
        )
      ).appointment,
    ).toEqual(custom.appointment);
    await portal.getByRole('button', { name: 'Change target', exact: true }).click();
    await target(portal, future(41), '09:30');
    const proposed = await preview(portal, portal, custom.appointment.id);
    expect(proposed.canReschedule).toBe(true);
    expect(proposed.after).toMatchObject({
      durationMinutes: 90,
      durationPolicy: 'custom',
      fee: 850,
    });
    await expect(portal.locator('.appointment-reschedule-after')).toContainText('90 minutes');
    await expect(portal.locator('.appointment-reschedule-after')).toContainText('₹850');
    await portal.getByLabel(patientAgreement, { exact: true }).check();
    await confirm(portal, portal, custom.appointment.id);
    await expect(
      portal.getByRole('heading', { name: 'Reschedule confirmed', exact: true }),
    ).toBeVisible();
    const retained = await get<AppointmentResourceContext>(
      page.request,
      `${base(custom.appointment.id)}/resources`,
    );
    expect(retained.resourceIds).toEqual([assigned.resource.id]);
    expect(retained.appointment).toMatchObject({
      date: future(41),
      time: '09:30',
      durationMinutes: 90,
    });
    await expect(portal.getByText(assigned.resource.name, { exact: true })).toHaveCount(0);
  } finally {
    await owner.close();
  }
});

test('staff resume the exact uncertain command through malformed and wrong-actor receipts and see a later cancelled current visit', async ({
  page,
}, testInfo) => {
  const admin = await login(page.request),
    clinician = await doctor(page.request, admin.headers);
  const original = await book(page.request, admin.headers, clinician.id, future(50));
  let dialog = await openStaff(page, original);
  await target(dialog, future(51), '10:00');
  await preview(page, dialog, original.id);
  await dialog.getByLabel(staffAgreement, { exact: true }).check();
  const attempts: AppointmentRescheduleInput[] = [];
  let first!: AppointmentRescheduleResult;
  await page.route(`**${base(original.id)}/reschedules`, async (route) => {
    attempts.push(route.request().postDataJSON());
    if (attempts.length === 1) {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      first = await response.json();
      await route.fulfill({
        status: 200,
        json: { ...first, event: { ...first.event, after: null } },
      });
    } else if (attempts.length === 2) {
      await route.fulfill({
        status: 400,
        json: { error: 'Synthetic later command validation response.' },
      });
    } else if (attempts.length === 3) {
      const response = await route.fetch(),
        value = await response.json();
      await route.fulfill({
        status: 200,
        json: { ...value, receipt: { ...value.receipt, actorId: 'user-reception' } },
      });
    } else if (attempts.length === 4) {
      await route.fulfill({
        status: 409,
        json: { error: 'This request ID was already used for a different reschedule command.' },
      });
    } else await route.continue();
  });
  await confirm(page, dialog, original.id, 200);
  await expect(
    dialog.getByRole('button', { name: 'Retry same request', exact: true }),
  ).toBeEnabled();
  await expect(dialog.getByLabel('New date', { exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Close for now', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Resume reschedule', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Reschedule appointment', exact: true });
  await expect(dialog.getByLabel('New date', { exact: true })).toHaveValue(future(51));
  await patch(page.request, admin.headers, original.id, { date: future(52), time: '12:00' });
  await patch(page.request, admin.headers, original.id, { status: 'cancelled' });
  await pause(page.request, admin.headers, clinician.id);
  for (const code of [400, 200, 409]) {
    await confirm(page, dialog, original.id, code, 'Retry same request');
    await expect(
      dialog.getByRole('button', { name: 'Retry same request', exact: true }),
    ).toBeEnabled();
    await expect(dialog.getByLabel('New time · IST', { exact: true })).toHaveValue('10:00');
    await expect(dialog.getByLabel('New time · IST', { exact: true })).toBeDisabled();
  }
  const last = (await (
    await confirm(page, dialog, original.id, 200, 'Retry same request')
  ).json()) as AppointmentRescheduleResult;
  await expect(
    dialog.getByRole('heading', { name: 'Reschedule confirmed', exact: true }),
  ).toBeVisible();
  await expect(dialog.locator('.appointment-reschedule-current')).toContainText(/cancelled/i);
  await expect(dialog.locator('.appointment-reschedule-current')).toContainText('12:00');
  expect(last.event).toEqual(first.event);
  expect(last.receipt).toEqual(first.receipt);
  expect(last.event.after).toMatchObject({ date: future(51), time: '10:00', status: 'scheduled' });
  expect(last.appointment).toMatchObject({ date: future(52), time: '12:00', status: 'cancelled' });
  expect(attempts).toHaveLength(5);
  for (const attempt of attempts) expect(attempt).toEqual(attempts[0]);
  await expect(
    dialog.getByRole('link', { name: 'Download calendar event', exact: true }),
  ).toHaveCount(0);
  await audit(page);
  await page.screenshot({
    path: testInfo.outputPath('staff-reschedule-current-cancelled-mobile.png'),
    fullPage: true,
  });
});

test('a patient preserves the intended target after an uncommitted attempt and only a matching terminal rejection permits a fresh preview and UUID', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const admin = await login(page.request),
    clinician = await doctor(page.request, admin.headers);
  const original = await book(page.request, admin.headers, clinician.id, future(60));
  const owner = await browser.newContext({ baseURL });
  try {
    const portal = await owner.newPage(),
      patient = await login(portal.request, 'patient@derma.demo');
    await portal.goto(`/book?appointmentId=${original.id}`);
    await target(portal, future(62), '11:00');
    await preview(portal, portal, original.id);
    await portal.getByLabel(patientAgreement, { exact: true }).check();
    const attempts: AppointmentRescheduleInput[] = [];
    await portal.route(`**${base(original.id)}/reschedules`, async (route) => {
      attempts.push(route.request().postDataJSON());
      if (attempts.length === 1) await route.abort('failed');
      else if (attempts.length === 2)
        await route.fulfill({
          status: 409,
          json: {
            error: 'Synthetic rejection for another account.',
            rescheduleOutcome: 'not-applied',
            requestId: attempts[0].requestId,
            actorId: admin.session.user!.id,
            patientId: 'patient-ananya',
            appointmentId: original.id,
          },
        });
      else await route.continue();
    });
    await portal.getByRole('button', { name: 'Confirm reschedule', exact: true }).click();
    await expect(
      portal.getByRole('button', { name: 'Retry same request', exact: true }),
    ).toBeEnabled();
    await audit(portal);
    await portal.screenshot({
      path: testInfo.outputPath('patient-reschedule-uncertain-mobile.png'),
      fullPage: true,
    });
    await patch(page.request, admin.headers, original.id, { date: future(61), time: '10:00' });
    await confirm(portal, portal, original.id, 409, 'Retry same request');
    await expect(
      portal.getByRole('button', { name: 'Retry same request', exact: true }),
    ).toBeEnabled();
    await expect(portal.getByLabel('New date', { exact: true })).toBeDisabled();
    const refused = await confirm(portal, portal, original.id, 409, 'Retry same request');
    expect(await refused.json()).toMatchObject({
      rescheduleOutcome: 'not-applied',
      requestId: attempts[0].requestId,
      actorId: patient.session.user!.id,
      appointmentId: original.id,
    });
    await expect(
      portal.getByRole('button', { name: 'Retry same request', exact: true }),
    ).toHaveCount(0);
    await portal.getByRole('button', { name: 'Refresh current visit', exact: true }).click();
    await expect(portal.locator('.appointment-reschedule-source')).toContainText('10:00');
    await expect(portal.getByLabel('New date', { exact: true })).toHaveValue(future(62));
    await expect(portal.getByLabel('New time · IST', { exact: true })).toHaveValue('11:00');
    const rejectedReplay = await portal.request.post(`${base(original.id)}/reschedules`, {
      headers: patient.headers,
      data: attempts[0],
    });
    expect(rejectedReplay.status()).toBe(409);
    expect(await rejectedReplay.json()).toMatchObject({
      rescheduleOutcome: 'not-applied',
      requestId: attempts[0].requestId,
    });
    const fresh = await preview(portal, portal, original.id);
    expect(fresh.before).toMatchObject({ date: future(61), time: '10:00' });
    await expect(portal.getByLabel(patientAgreement, { exact: true })).not.toBeChecked();
    await portal.getByLabel(patientAgreement, { exact: true }).check();
    await confirm(portal, portal, original.id);
    await expect(
      portal.getByRole('heading', { name: 'Reschedule confirmed', exact: true }),
    ).toBeVisible();
    expect(attempts.slice(0, 3)).toEqual([attempts[0], attempts[0], attempts[0]]);
    expect(attempts[3].requestId).not.toBe(attempts[0].requestId);
    expect(attempts[3].expectedRevision).toBe(fresh.revision);
    const own = await get<Appointment[]>(portal.request, '/api/appointments');
    expect(own.filter((value) => value.id === original.id)).toHaveLength(1);
    expect(own.find((value) => value.id === original.id)).toMatchObject({
      date: future(62),
      time: '11:00',
    });
  } finally {
    await owner.close();
  }
});

test('read recovery and real navigation isolate old previews, committed replies and late authorization errors from a newer patient view', async ({
  page,
  browser,
  baseURL,
}) => {
  const admin = await login(page.request),
    clinician = await doctor(page.request, admin.headers);
  const original = await book(page.request, admin.headers, clinician.id, future(70));
  const owner = await browser.newContext({ baseURL });
  try {
    const portal = await owner.newPage(),
      patient = await login(portal.request, 'patient@derma.demo');
    let failRead = true;
    const contextRoute = `**${base(original.id)}/reschedule-context`;
    await portal.route(contextRoute, (route) =>
      failRead
        ? route.fulfill({
            status: 503,
            json: { error: 'Synthetic current visit is temporarily unavailable.' },
          })
        : route.continue(),
    );
    await portal.goto(`/book?appointmentId=${original.id}`);
    await expect(
      portal.getByText('Synthetic current visit is temporarily unavailable.', { exact: true }),
    ).toBeVisible();
    failRead = false;
    await portal.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(portal.locator('.appointment-reschedule-source')).toContainText('09:00');
    await portal.unroute(contextRoute);
    await observeResponses(portal);
    const seenPreview = deferred(),
      releasePreview = deferred();
    await portal.route(`**${base(original.id)}/reschedule-preview`, async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      seenPreview.resolve();
      await releasePreview.promise;
      await route
        .fulfill({
          response,
          headers: { ...response.headers(), 'X-Test-Reschedule-Settled': 'old-preview' },
        })
        .catch(() => undefined);
    });
    await target(portal, future(71), '10:00');
    await portal.getByRole('button', { name: 'Review change', exact: true }).click();
    await seenPreview.promise;
    await navigate(portal, '/my-care');
    await expect(
      portal.getByRole('heading', { name: 'Your treatment plans', exact: true }),
    ).toBeVisible();
    await portal.goBack();
    await expect(portal.locator('.appointment-reschedule-source')).toContainText('09:00');
    releasePreview.resolve();
    await consumed(portal, 'old-preview');
    await expect(portal.locator('.appointment-reschedule-preview')).toHaveCount(0);
    await expect(portal.getByLabel('New date', { exact: true })).toHaveValue(original.date);
    await portal.unroute(`**${base(original.id)}/reschedule-preview`);
    await target(portal, future(71), '10:00');
    await preview(portal, portal, original.id);
    await portal.getByLabel(patientAgreement, { exact: true }).check();
    const committed = deferred(),
      releaseCommand = deferred();
    let saved!: AppointmentRescheduleResult;
    await portal.route(`**${base(original.id)}/reschedules`, async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      saved = await response.json();
      committed.resolve();
      await releaseCommand.promise;
      await route
        .fulfill({
          response,
          headers: { ...response.headers(), 'X-Test-Reschedule-Settled': 'old-command' },
        })
        .catch(() => undefined);
    });
    await portal.getByRole('button', { name: 'Confirm reschedule', exact: true }).click();
    await committed.promise;
    await navigate(portal, `/my-care?appointment=${original.id}`);
    await expect(
      portal.getByRole('region', { name: 'Current appointment details', exact: true }),
    ).toContainText('10:00');
    await portal.goBack();
    await expect(portal.locator('.appointment-reschedule-source')).toContainText('10:00');
    releaseCommand.resolve();
    await consumed(portal, 'old-command');
    await expect(
      portal.getByRole('heading', { name: 'Reschedule confirmed', exact: true }),
    ).toHaveCount(0);
    await expect(
      portal.getByRole('button', { name: 'Retry same request', exact: true }),
    ).toHaveCount(0);
    await expect(portal.getByLabel('New date', { exact: true })).toHaveValue(
      saved.appointment.date,
    );
    await portal.unroute(`**${base(original.id)}/reschedules`);
    await navigate(portal, '/my-care');
    await expect(
      portal.getByRole('heading', { name: 'Your treatment plans', exact: true }),
    ).toBeVisible();
    const seenRead = deferred(),
      releaseRead = deferred();
    await portal.route(contextRoute, async (route) => {
      seenRead.resolve();
      await releaseRead.promise;
      await route
        .fulfill({
          status: 401,
          headers: { 'X-Test-Reschedule-Settled': 'old-context' },
          json: { error: 'Synthetic obsolete authorization response.' },
        })
        .catch(() => undefined);
    });
    await navigate(portal, `/book?appointmentId=${original.id}`);
    await seenRead.promise;
    await navigate(portal, `/my-care?appointment=${original.id}`);
    await expect(
      portal.getByRole('region', { name: 'Current appointment details', exact: true }),
    ).toBeVisible();
    releaseRead.resolve();
    await consumed(portal, 'old-context');
    await expect(portal).toHaveURL(
      (url) => url.pathname === '/my-care' && url.searchParams.get('appointment') === original.id,
    );
    expect(
      await portal.evaluate(
        () => (window as Window & { rescheduleExpired?: number }).rescheduleExpired,
      ),
    ).toBe(0);
    expect((await get<Session>(portal.request, '/api/session')).user?.id).toBe(
      patient.session.user!.id,
    );
    await expect(
      portal.getByText('Synthetic obsolete authorization response.', { exact: true }),
    ).toHaveCount(0);
    await portal.unroute(contextRoute);
    await portal.goBack();
    await expect(portal.locator('.appointment-reschedule-source')).toContainText('10:00');
  } finally {
    await owner.close();
  }
});
