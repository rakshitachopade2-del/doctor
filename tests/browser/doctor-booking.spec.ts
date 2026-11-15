import { test, expect, type APIRequestContext, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import type { Appointment, Doctor, Session } from '../../shared/types';
import type {
  DoctorBookingContext,
  DoctorBookingHistory,
  DoctorBookingMutation,
} from '../../shared/doctor-booking';
import type {
  AppointmentSeriesDetail,
  AppointmentSeriesInput,
  AppointmentSeriesPreview,
} from '../../shared/appointment-series';
import type { VisitDurationMutation } from '../../shared/visit-duration';
import type { WaitlistEntry } from '../../shared/waitlist';
import type { AppointmentResourceContext } from '../../shared/clinic-resources';

const path = (id: string) => `/api/doctors/${id}/booking-status`;
const review = 'I reviewed this booking-status change.';
const acknowledgement = 'I reviewed the latest status; keep my draft';
const pausedMessage =
  'This doctor is not accepting new bookings. Choose another doctor or contact the clinic.';
const modal = (page: Page) =>
  page.getByRole('dialog', { name: 'Manage booking status', exact: true });
const future = (days = 35) => {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return new Date(Date.parse(`${today}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
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
  status = 201,
): Promise<T> {
  const response = await request.post(url, { headers, data });
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}
async function createDoctor(request: APIRequestContext, headers: Record<string, string>) {
  const doctor = await post<Doctor>(request, headers, '/api/doctors', {
    name: `Dr. Booking ${randomUUID().slice(0, 8)}`,
    title: 'Dermatologist',
    qualifications: 'Synthetic profile',
    specialties: ['General dermatology'],
    experience: 5,
    fee: 700,
    bio: 'Synthetic doctor lifecycle verification.',
    languages: ['English'],
  });
  const response = await request.put(`/api/schedules/${doctor.id}`, {
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
  expect(response.status(), await response.text()).toBe(200);
  return doctor;
}
async function status(
  request: APIRequestContext,
  headers: Record<string, string>,
  doctorId: string,
  acceptingNewBookings: boolean,
  reason: string,
) {
  const current = await get<DoctorBookingContext>(request, path(doctorId));
  return post<DoctorBookingMutation>(request, headers, path(doctorId), {
    acceptingNewBookings,
    reason,
    expectedRevision: current.revision,
    requestId: randomUUID(),
  });
}
async function openStatus(page: Page, doctorId: string, action = 'Pause new bookings') {
  await page.goto('/clinic/settings?tab=team');
  await page
    .locator(`.doctor-booking-team-row[data-doctor-id="${doctorId}"]`)
    .getByRole('button', { name: action, exact: true })
    .click();
  await expect(
    modal(page).getByLabel('Reason for booking-status change', { exact: true }),
  ).toBeEnabled();
}
async function draft(page: Page, reason: string) {
  await modal(page).getByLabel('Reason for booking-status change', { exact: true }).fill(reason);
  await modal(page).getByLabel(review, { exact: true }).check();
}
async function submit(page: Page, doctorId: string, label = 'Save booking status', code = 201) {
  const waiting = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === path(doctorId) && response.request().method() === 'POST',
  );
  await modal(page).getByRole('button', { name: label, exact: true }).click();
  const response = await waiting;
  expect(response.status(), await response.text()).toBe(code);
  return response;
}
async function refresh(page: Page) {
  await modal(page)
    .getByRole('button', { name: 'Refresh latest booking status', exact: true })
    .click();
  await modal(page).getByRole('button', { name: acknowledgement, exact: true }).click();
  await expect(modal(page).getByLabel(review, { exact: true })).not.toBeChecked();
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

test('paused public profiles block new patient bookings and requests while existing visits, reservations and waitlist withdrawal remain usable', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const admin = await login(page.request);
  const doctor = await createDoctor(page.request, admin.headers);
  const alternate = await createDoctor(page.request, admin.headers);
  const date = future();
  const original = await post<VisitDurationMutation>(
    page.request,
    admin.headers,
    '/api/visit-duration/bookings',
    {
      patientId: 'patient-ananya',
      doctorId: doctor.id,
      date,
      time: '09:00',
      mode: 'in-person',
      durationMinutes: 60,
      reason: 'Existing visit must remain usable during a booking pause.',
      requestId: randomUUID(),
    },
  );
  const waiting = await post<WaitlistEntry>(page.request, admin.headers, '/api/waitlist', {
    patientId: 'patient-ananya',
    doctorId: doctor.id,
    startDate: date,
    endDate: future(40),
    mode: 'online',
    reason: 'Existing waiting request remains available.',
  });
  const room = await post<{ resource: { id: string } }>(
    page.request,
    admin.headers,
    '/api/clinic-resources',
    { name: `Synthetic retained room ${randomUUID()}`, kind: 'room', requestId: randomUUID() },
  );
  const resourcePath = `/api/appointments/${original.appointment.id}/resources`;
  const resources = await get<AppointmentResourceContext>(page.request, resourcePath);
  const allocated = await page.request.put(resourcePath, {
    headers: admin.headers,
    data: {
      resourceIds: [room.resource.id],
      reason: 'Retained allocation before pause.',
      expectedRevision: resources.revision,
      requestId: randomUUID(),
    },
  });
  expect(allocated.status(), await allocated.text()).toBe(200);
  const privateReason = `Private booking pause ${randomUUID()}`;
  await openStatus(page, doctor.id);
  await draft(page, privateReason);
  const paused = (await (await submit(page, doctor.id)).json()) as DoctorBookingMutation;
  await expect(modal(page)).toBeHidden();
  expect(paused.context.acceptingNewBookings).toBe(false);
  expect(
    (await get<Appointment[]>(page.request, '/api/appointments?patientId=patient-ananya')).find(
      (item) => item.id === original.appointment.id,
    ),
  ).toEqual(original.appointment);
  expect((await get<AppointmentResourceContext>(page.request, resourcePath)).resourceIds).toEqual([
    room.resource.id,
  ]);
  const guest = await browser.newContext({ baseURL });
  try {
    const publicPage = await guest.newPage();
    await publicPage.goto('/');
    const card = publicPage
      .locator('.doctor-profile-card')
      .filter({ has: publicPage.getByRole('heading', { name: doctor.name, exact: true }) });
    await expect(card.getByText('New bookings paused', { exact: true })).toBeVisible();
    await expect(card.getByRole('link', { name: 'View availability', exact: true })).toHaveCount(0);
    const publicDoctors = await get<Doctor[]>(guest.request, '/api/doctors');
    expect(publicDoctors.find((item) => item.id === doctor.id)?.acceptingNewBookings).toBe(false);
    expect(JSON.stringify(publicDoctors)).not.toContain(privateReason);
    expect(JSON.stringify(publicDoctors)).not.toContain(paused.receipt.requestId);
  } finally {
    await guest.close();
  }
  const patient = await browser.newContext({ baseURL });
  try {
    await login(patient.request, 'patient@derma.demo');
    const portal = await patient.newPage();
    await portal.goto(`/book?doctor=${doctor.id}`);
    await expect(
      portal.getByRole('region', { name: 'Doctor booking status', exact: true }),
    ).toContainText('not accepting new bookings or new waitlist requests');
    await expect(portal.locator(`input[name="doctor"][value="${doctor.id}"]`)).toBeChecked();
    await expect(
      portal.getByRole('button', { name: 'Confirm appointment', exact: true }),
    ).toBeDisabled();
    await expect(portal.getByRole('button', { name: 'Join waitlist', exact: true })).toBeDisabled();
    await portal.locator(`input[name="doctor"][value="${alternate.id}"]`).check();
    await portal.getByLabel('Appointment date', { exact: true }).fill(date);
    await expect(
      portal
        .getByRole('group', { name: 'Available appointment times', exact: true })
        .getByRole('button', { name: '11:00', exact: true }),
    ).toBeVisible();
    await portal.goto(`/book?appointmentId=${original.appointment.id}`);
    await expect(
      portal.getByRole('region', { name: 'Doctor booking status', exact: true }),
    ).toContainText('Your existing visit can still be rescheduled with the same doctor');
    await portal
      .getByRole('group', { name: 'Available appointment times', exact: true })
      .getByRole('button', { name: '10:00', exact: true })
      .click();
    await portal.getByRole('button', { name: 'Review change', exact: true }).click();
    await portal.getByLabel('I agree to this exact appointment change.', { exact: true }).check();
    await portal.getByRole('button', { name: 'Confirm reschedule', exact: true }).click();
    await expect(
      portal.getByRole('heading', { name: 'Reschedule confirmed', exact: true }),
    ).toBeVisible();
    const moved = (await get<Appointment[]>(patient.request, '/api/appointments')).find(
      (item) => item.id === original.appointment.id,
    )!;
    expect(moved).toMatchObject({
      doctorId: doctor.id,
      time: '10:00',
      durationPolicy: 'custom',
      durationMinutes: 60,
      status: 'scheduled',
    });
    expect((await get<AppointmentResourceContext>(page.request, resourcePath)).resourceIds).toEqual(
      [room.resource.id],
    );
    const calendar = await patient.request.get(`/api/appointments/${moved.id}/calendar`);
    expect(calendar.status()).toBe(200);
    expect(await calendar.text()).toContain('DTSTART:');
    expect(await calendar.text()).toContain(doctor.name);
    await portal.goto(`/my-care?appointment=${moved.id}`);
    await expect(portal.locator(`[data-appointment-id="${moved.id}"]`)).toContainText(
      '10:00–11:00',
    );
    await expect(
      portal
        .locator(`[data-appointment-id="${moved.id}"]`)
        .getByRole('link', { name: 'Add to calendar', exact: true }),
    ).toBeVisible();
    await portal.goto(`/book?waitlist=${waiting.id}`);
    await expect(
      portal.getByRole('region', { name: 'Doctor booking status', exact: true }),
    ).toContainText('Your waiting request is retained');
    await expect(
      portal.getByRole('button', { name: 'Confirm appointment', exact: true }),
    ).toBeDisabled();
    await portal.getByRole('link', { name: 'View my waitlist requests', exact: true }).click();
    const request = portal.locator(`[data-waitlist-id="${waiting.id}"]`);
    await expect(request).toContainText('New bookings paused');
    await expect(
      request.getByRole('link', { name: 'Choose an available time', exact: true }),
    ).toHaveCount(0);
    await request.getByRole('button', { name: 'Withdraw request', exact: true }).click();
    await portal
      .getByRole('dialog')
      .getByRole('button', { name: 'Confirm withdrawal', exact: true })
      .click();
    await expect(portal.getByRole('dialog')).toBeHidden();
    expect(
      (await get<WaitlistEntry[]>(patient.request, '/api/waitlist')).find(
        (item) => item.id === waiting.id,
      )?.status,
    ).toBe('cancelled');
    await portal
      .getByRole('region', { name: 'Your appointment waitlist', exact: true })
      .getByRole('button', { name: 'Join waitlist', exact: true })
      .click();
    const join = portal.getByRole('dialog', { name: 'Join the appointment waitlist', exact: true });
    await expect(
      join
        .getByLabel('Preferred clinician', { exact: true })
        .locator(`option[value="${doctor.id}"]`),
    ).toBeDisabled();
    await join.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await portal.goto(`/book?doctor=${doctor.id}`);
    const pausedStatus = portal.getByRole('region', {
      name: 'Doctor booking status',
      exact: true,
    });
    await expect(pausedStatus).toBeVisible();
    await expect(pausedStatus).toContainText(doctor.name);
    await expect(pausedStatus).toContainText('not accepting new bookings or new waitlist requests');
    await expect(portal.locator(`input[name="doctor"][value="${doctor.id}"]`)).toBeChecked();
    await expect(
      portal.getByRole('button', { name: 'Confirm appointment', exact: true }),
    ).toBeDisabled();
    await audit(portal);
    await portal.screenshot({
      path: testInfo.outputPath('doctor-booking-paused-mobile.png'),
      fullPage: true,
    });
    expect((await patient.request.get(path(doctor.id))).status()).toBe(403);
    const summary = JSON.stringify(
      await get(patient.request, '/api/patients/patient-ananya/care-summary'),
    );
    expect(summary).not.toContain(privateReason);
    await openStatus(page, doctor.id, 'Resume new bookings');
    await draft(page, 'Private reviewed resumption.');
    await submit(page, doctor.id);
    await expect(modal(page)).toBeHidden();
    await portal.getByRole('button', { name: 'Refresh booking status', exact: true }).click();
    await expect(
      portal.getByRole('region', { name: 'Doctor booking status', exact: true }),
    ).toHaveCount(0);
    await portal.getByLabel('Appointment date', { exact: true }).fill(date);
    await expect(
      portal
        .getByRole('group', { name: 'Available appointment times', exact: true })
        .getByRole('button', { name: '11:00', exact: true }),
    ).toBeVisible();
  } finally {
    await patient.close();
  }
});

test('staff cannot add paused bookings through custom visits, recurring series or waitlists while old committed receipts remain valid', async ({
  page,
}) => {
  const admin = await login(page.request);
  const doctor = await createDoctor(page.request, admin.headers);
  const alternate = await createDoctor(page.request, admin.headers);
  const customInput = {
    patientId: 'patient-ananya',
    doctorId: doctor.id,
    date: future(42),
    time: '09:00',
    mode: 'in-person',
    durationMinutes: 60,
    reason: 'Committed custom booking before pause.',
    requestId: randomUUID(),
  };
  const booked = await post<VisitDurationMutation>(
    page.request,
    admin.headers,
    '/api/visit-duration/bookings',
    customInput,
  );
  const seriesInput: AppointmentSeriesInput = {
    patientId: 'patient-ananya',
    doctorId: doctor.id,
    firstDate: future(60),
    time: '11:00',
    mode: 'in-person',
    durationPolicy: 'schedule',
    count: 2,
    intervalWeeks: 1,
    reason: 'Committed series before pause.',
  };
  const preview = await post<AppointmentSeriesPreview>(
    page.request,
    admin.headers,
    '/api/appointment-series/preview',
    seriesInput,
    200,
  );
  const seriesCommand = {
    input: seriesInput,
    expectedRevision: preview.revision,
    patientConfirmed: true,
    privateNote: 'Synthetic preserved series origin.',
    requestId: randomUUID(),
  };
  const series = await post<AppointmentSeriesDetail>(
    page.request,
    admin.headers,
    '/api/appointment-series',
    seriesCommand,
  );
  const freshInput: AppointmentSeriesInput = { ...seriesInput, firstDate: future(84) };
  const beforeABA = await post<AppointmentSeriesPreview>(
    page.request,
    admin.headers,
    '/api/appointment-series/preview',
    freshInput,
    200,
  );
  const waiting = await post<WaitlistEntry>(page.request, admin.headers, '/api/waitlist', {
    patientId: 'patient-ananya',
    doctorId: doctor.id,
    startDate: future(42),
    endDate: future(45),
    mode: 'online',
    reason: `Preserved staff waitlist ${randomUUID()}`,
  });
  const different = await post<Appointment>(page.request, admin.headers, '/api/appointments', {
    patientId: 'patient-ananya',
    doctorId: alternate.id,
    date: future(42),
    time: '15:00',
    mode: 'in-person',
    reason: 'Existing visit with another doctor.',
  });
  await status(page.request, admin.headers, doctor.id, false, 'Pause before stale preview.');
  await status(page.request, admin.headers, doctor.id, true, 'Resume without changing hours.');
  const stale = await page.request.post('/api/appointment-series', {
    headers: admin.headers,
    data: {
      ...seriesCommand,
      input: freshInput,
      expectedRevision: beforeABA.revision,
      requestId: randomUUID(),
    },
  });
  expect(stale.status(), await stale.text()).toBe(409);
  expect((await stale.json()).error).toContain('preview changed');
  await status(
    page.request,
    admin.headers,
    doctor.id,
    false,
    'Pause new assignments across every booking path.',
  );
  const newOrdinary = {
    patientId: 'patient-ananya',
    doctorId: doctor.id,
    date: future(42),
    time: '13:00',
    mode: 'in-person',
    reason: 'Blocked new appointment.',
  };
  for (const [url, body] of [
    ['/api/appointments', newOrdinary],
    ['/api/visit-duration/bookings', { ...customInput, time: '13:00', requestId: randomUUID() }],
    [
      '/api/appointments',
      { ...newOrdinary, mode: 'online', waitlistId: waiting.id, patientConfirmed: true },
    ],
    [
      '/api/waitlist',
      {
        patientId: 'patient-ananya',
        doctorId: doctor.id,
        startDate: future(50),
        endDate: future(52),
        mode: 'in-person',
        reason: 'Blocked new waiting request.',
      },
    ],
  ] as const) {
    const denied = await page.request.post(url, { headers: admin.headers, data: body });
    expect(denied.status(), await denied.text()).toBe(409);
    expect((await denied.json()).error).toBe(pausedMessage);
  }
  const deniedTransfer = await page.request.patch(`/api/appointments/${different.id}`, {
    headers: admin.headers,
    data: { doctorId: doctor.id },
  });
  expect(deniedTransfer.status()).toBe(409);
  expect((await deniedTransfer.json()).error).toBe(pausedMessage);
  expect(
    await get(
      page.request,
      `/api/slots?doctorId=${doctor.id}&date=${future(42)}&mode=in-person&excludeAppointmentId=${different.id}`,
    ),
  ).toEqual([]);
  expect(
    (
      await get<string[]>(
        page.request,
        `/api/slots?doctorId=${doctor.id}&date=${future(42)}&mode=in-person&excludeAppointmentId=${booked.appointment.id}`,
      )
    ).length,
  ).toBeGreaterThan(0);
  const blockedPreview = await post<AppointmentSeriesPreview>(
    page.request,
    admin.headers,
    '/api/appointment-series/preview',
    freshInput,
    200,
  );
  expect(blockedPreview.canBook).toBe(false);
  expect(blockedPreview.visits).toHaveLength(2);
  for (const visit of blockedPreview.visits) expect(visit.blockedReason).toBe(pausedMessage);
  expect(
    await post<VisitDurationMutation>(
      page.request,
      admin.headers,
      '/api/visit-duration/bookings',
      customInput,
      200,
    ),
  ).toEqual(booked);
  expect(
    await post<AppointmentSeriesDetail>(
      page.request,
      admin.headers,
      '/api/appointment-series',
      seriesCommand,
      200,
    ),
  ).toEqual(series);
  expect(
    (await get<WaitlistEntry[]>(page.request, '/api/waitlist')).find(
      (item) => item.id === waiting.id,
    )?.status,
  ).toBe('waiting');
  const profileEdit = await page.request.patch(`/api/doctors/${doctor.id}`, {
    headers: admin.headers,
    data: { ...doctor, bio: 'Updated public bio without reopening new bookings.' },
  });
  expect(profileEdit.status()).toBe(200);
  expect(
    (await get<DoctorBookingContext>(page.request, path(doctor.id))).acceptingNewBookings,
  ).toBe(false);

  await page.goto('/clinic/appointments?new=1');
  const appointmentForm = page.getByRole('dialog');
  await expect(
    appointmentForm.getByLabel('Doctor', { exact: true }).locator(`option[value="${doctor.id}"]`),
  ).toBeDisabled();
  await appointmentForm.getByLabel('Visit length', { exact: true }).selectOption('custom');
  await expect(
    appointmentForm.getByLabel('Doctor', { exact: true }).locator(`option[value="${doctor.id}"]`),
  ).toBeDisabled();
  await appointmentForm.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.goto('/clinic/appointment-series');
  await page.getByRole('button', { name: 'Book recurring visits', exact: true }).click();
  const seriesForm = page.getByRole('dialog', { name: 'Book recurring visits', exact: true });
  await expect(
    seriesForm.getByLabel('Doctor', { exact: true }).locator(`option[value="${doctor.id}"]`),
  ).toBeDisabled();
  await seriesForm.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.goto('/clinic/waitlist');
  await page.getByRole('button', { name: 'Add to waitlist', exact: true }).click();
  await expect(
    page
      .getByRole('dialog')
      .getByLabel('Requested doctor', { exact: true })
      .locator(`option[value="${doctor.id}"]`),
  ).toBeDisabled();
  await page.getByRole('dialog').getByRole('button', { name: 'Close dialog', exact: true }).click();
  const waitingRow = page.getByRole('row').filter({ hasText: waiting.reason });
  await expect(waitingRow).toContainText('New bookings paused');
  await expect(waitingRow.getByRole('button', { name: 'Find a slot', exact: true })).toBeDisabled();
  await page.goto(`/clinic/appointment-series?series=${series.series.id}`);
  await expect(page.locator('.appointment-series-visit')).toHaveCount(2);
  await expect(
    page.getByRole('button', { name: 'Reschedule visits together', exact: true }),
  ).toBeEnabled();
  expect(
    (await get<Appointment[]>(page.request, '/api/appointments?patientId=patient-ananya'))
      .filter((item) => item.doctorId === doctor.id)
      .map((item) => item.id)
      .sort(),
  ).toEqual([booked.appointment.id, ...series.appointments.map((item) => item.id)].sort());

  // A definitive paused response after replay lookup proves this aborted command was never saved.
  const recoveryDoctor = await createDoctor(page.request, admin.headers);
  await page.goto('/clinic/appointments?new=1');
  const customForm = page.getByRole('dialog');
  const customReason = `Recovered uncommitted custom visit ${randomUUID()}`;
  await customForm.getByLabel('Patient', { exact: true }).selectOption('patient-ananya');
  await customForm.getByLabel('Doctor', { exact: true }).selectOption(alternate.id);
  await customForm.getByLabel('Date', { exact: true }).fill(future(100));
  await customForm.getByLabel('Visit length', { exact: true }).selectOption('custom');
  await customForm.getByRole('button', { name: '9:00 AM', exact: true }).click();
  await customForm.getByLabel('Reason for visit', { exact: true }).fill(customReason);
  const customAttempts: { requestId: string; doctorId: string }[] = [];
  const abortCustom = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.continue();
    customAttempts.push(route.request().postDataJSON());
    return customAttempts.length === 1 ? route.abort('failed') : route.continue();
  };
  await page.route('**/api/visit-duration/bookings', abortCustom);
  try {
    const aborted = page.waitForEvent(
      'requestfailed',
      (request) => new URL(request.url()).pathname === '/api/visit-duration/bookings',
    );
    await customForm.getByRole('button', { name: 'Book appointment', exact: true }).click();
    await aborted;
    await expect(
      customForm.getByRole('button', { name: 'Retry same request', exact: true }),
    ).toBeEnabled();
    await status(
      page.request,
      admin.headers,
      alternate.id,
      false,
      'Pause after a custom booking did not reach the server.',
    );
    const denied = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/visit-duration/bookings' &&
        response.request().method() === 'POST',
    );
    await customForm.getByRole('button', { name: 'Retry same request', exact: true }).click();
    expect((await denied).status()).toBe(409);
    expect(customAttempts[1]).toEqual(customAttempts[0]);
    await expect(customForm.getByLabel('Doctor', { exact: true })).toBeEnabled();
    await expect(customForm.getByLabel('Doctor', { exact: true })).toHaveValue(alternate.id);
    await expect(customForm.getByLabel('Date', { exact: true })).toHaveValue(future(100));
    await expect(customForm.getByLabel('Reason for visit', { exact: true })).toHaveValue(
      customReason,
    );
    await expect(
      customForm.getByRole('button', { name: 'Book appointment', exact: true }),
    ).toBeDisabled();
    await customForm.getByLabel('Doctor', { exact: true }).selectOption(recoveryDoctor.id);
    await customForm.getByRole('button', { name: '9:00 AM', exact: true }).click();
    const saved = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/visit-duration/bookings' &&
        response.request().method() === 'POST',
    );
    await customForm.getByRole('button', { name: 'Book appointment', exact: true }).click();
    expect((await saved).status()).toBe(201);
    await expect(customForm).toBeHidden();
    expect(customAttempts).toHaveLength(3);
    expect(customAttempts[2].requestId).not.toBe(customAttempts[0].requestId);
    expect(customAttempts[2].doctorId).toBe(recoveryDoctor.id);
    expect(
      (await get<Appointment[]>(page.request, '/api/appointments?patientId=patient-ananya')).filter(
        (item) => item.reason === customReason,
      ),
    ).toHaveLength(1);
  } finally {
    await page.unroute('**/api/visit-duration/bookings', abortCustom);
  }

  // The same absent-command proof permits a fresh review after a series pause/resume ABA.
  await page.goto('/clinic/appointment-series');
  await page.getByRole('button', { name: 'Book recurring visits', exact: true }).click();
  const recoveringSeries = page.getByRole('dialog', { name: 'Book recurring visits', exact: true });
  const seriesReason = `Recovered uncommitted series ${randomUUID()}`;
  await recoveringSeries.getByLabel('Patient', { exact: true }).selectOption('patient-ananya');
  await recoveringSeries.getByLabel('Doctor', { exact: true }).selectOption(recoveryDoctor.id);
  await recoveringSeries.getByLabel('First visit date', { exact: true }).fill(future(120));
  await recoveringSeries.getByLabel('Start time · IST', { exact: true }).fill('11:00');
  await recoveringSeries.getByLabel('Number of visits', { exact: true }).fill('2');
  await recoveringSeries.getByLabel('Reason for visits', { exact: true }).fill(seriesReason);
  await recoveringSeries.getByRole('button', { name: 'Preview visits', exact: true }).click();
  await expect(recoveringSeries.locator('.appointment-series-preview-card')).toHaveCount(2);
  const confirm = recoveringSeries.getByLabel(
    'I confirmed every listed date and time with the patient.',
    { exact: true },
  );
  await confirm.check();
  const seriesAttempts: { requestId: string; expectedRevision: string }[] = [];
  const abortSeries = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.continue();
    seriesAttempts.push(route.request().postDataJSON());
    return seriesAttempts.length === 1 ? route.abort('failed') : route.continue();
  };
  await page.route('**/api/appointment-series', abortSeries);
  try {
    const aborted = page.waitForEvent(
      'requestfailed',
      (request) => new URL(request.url()).pathname === '/api/appointment-series',
    );
    await recoveringSeries.getByRole('button', { name: 'Confirm all visits', exact: true }).click();
    await aborted;
    await expect(
      recoveringSeries.getByRole('button', { name: 'Retry same request', exact: true }),
    ).toBeEnabled();
    await status(
      page.request,
      admin.headers,
      recoveryDoctor.id,
      false,
      'Pause after the recurring request did not reach the server.',
    );
    await status(
      page.request,
      admin.headers,
      recoveryDoctor.id,
      true,
      'Resume before replay of the absent recurring command.',
    );
    const stale = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/appointment-series' &&
        response.request().method() === 'POST',
    );
    await recoveringSeries.getByRole('button', { name: 'Retry same request', exact: true }).click();
    expect((await stale).status()).toBe(409);
    expect(seriesAttempts[1]).toEqual(seriesAttempts[0]);
    await expect(recoveringSeries.getByLabel('Reason for visits', { exact: true })).toHaveValue(
      seriesReason,
    );
    await expect(recoveringSeries.getByLabel('First visit date', { exact: true })).toHaveValue(
      future(120),
    );
    await recoveringSeries
      .getByRole('button', { name: 'Refresh series preview', exact: true })
      .click();
    await recoveringSeries
      .getByRole('button', {
        name: 'I reviewed the updated dates, visit length and fees',
        exact: true,
      })
      .click();
    await expect(confirm).not.toBeChecked();
    await confirm.check();
    const saved = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/appointment-series' &&
        response.request().method() === 'POST',
    );
    await recoveringSeries.getByRole('button', { name: 'Confirm all visits', exact: true }).click();
    expect((await saved).status()).toBe(201);
    await expect(recoveringSeries).toBeHidden();
    expect(seriesAttempts).toHaveLength(3);
    expect(seriesAttempts[2].requestId).not.toBe(seriesAttempts[0].requestId);
    expect(seriesAttempts[2].expectedRevision).not.toBe(seriesAttempts[0].expectedRevision);
    expect(
      (await get<Appointment[]>(page.request, '/api/appointments?patientId=patient-ananya')).filter(
        (item) => item.reason === seriesReason,
      ),
    ).toHaveLength(2);
  } finally {
    await page.unroute('**/api/appointment-series', abortSeries);
  }
});

test('administrator status drafts survive ABA conflicts and uncertain outcomes without losing exact request identity', async ({
  page,
}) => {
  const admin = await login(page.request);
  const doctor = await createDoctor(page.request, admin.headers);
  const reason = `Private retained pause draft ${randomUUID()}`;
  await openStatus(page, doctor.id);
  await draft(page, reason);
  const original = await get<DoctorBookingContext>(page.request, path(doctor.id));
  await status(page.request, admin.headers, doctor.id, false, 'Competing pause.');
  const resumed = await status(
    page.request,
    admin.headers,
    doctor.id,
    true,
    'Competing resume returns the original boolean.',
  );
  expect(resumed.context.revision).not.toBe(original.revision);
  await submit(page, doctor.id, 'Save booking status', 409);
  await expect(
    modal(page).getByLabel('Reason for booking-status change', { exact: true }),
  ).toHaveValue(reason);
  await refresh(page);
  await expect(modal(page).getByLabel('New booking availability', { exact: true })).toHaveValue(
    'paused',
  );
  await modal(page).getByLabel(review, { exact: true }).check();
  const attempts: unknown[] = [];
  let committed: DoctorBookingMutation | undefined;
  const fault = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.continue();
    attempts.push(route.request().postDataJSON());
    if (attempts.length === 2)
      return route.fulfill({
        status: 400,
        json: { error: 'A later validation failure cannot disprove an earlier status save.' },
      });
    const response = await route.fetch();
    expect(response.status()).toBe(attempts.length === 1 ? 201 : 200);
    const body = (await response.json()) as DoctorBookingMutation;
    if (attempts.length === 1) {
      committed = body;
      return route.fulfill({
        response,
        json: { ...body, change: { ...body.change, after: null } },
      });
    }
    if (attempts.length === 3)
      return route.fulfill({
        response,
        json: { ...body, receipt: { ...body.receipt, actorId: 'another-account' } },
      });
    return route.fulfill({ response, json: body });
  };
  await page.route(`**${path(doctor.id)}`, fault);
  try {
    await submit(page, doctor.id);
    await expect(
      modal(page).getByRole('button', { name: 'Retry same request', exact: true }),
    ).toBeEnabled();
    await expect(
      modal(page).getByLabel('Reason for booking-status change', { exact: true }),
    ).toBeDisabled();
    await modal(page).getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(modal(page)).toBeVisible();
    await submit(page, doctor.id, 'Retry same request', 400);
    await expect(
      modal(page).getByRole('button', { name: 'Retry same request', exact: true }),
    ).toBeEnabled();
    await submit(page, doctor.id, 'Retry same request', 200);
    await expect(
      modal(page).getByRole('button', { name: 'Retry same request', exact: true }),
    ).toBeEnabled();
    await status(
      page.request,
      admin.headers,
      doctor.id,
      true,
      'Later resumption must remain current on an exact pause replay.',
    );
    await submit(page, doctor.id, 'Retry same request', 200);
    await expect(modal(page)).toBeHidden();
    const card = page.locator(`.doctor-booking-team-row[data-doctor-id="${doctor.id}"]`);
    await expect(card.getByText('Accepting new bookings', { exact: true })).toBeVisible();
    expect(attempts).toHaveLength(4);
    for (const attempt of attempts) expect(attempt).toEqual(attempts[0]);
    expect(
      (await get<DoctorBookingHistory>(page.request, `${path(doctor.id)}/history`)).items.filter(
        (item) => item.reason === reason,
      ),
    ).toEqual([committed!.change]);
  } finally {
    await page.unroute(`**${path(doctor.id)}`, fault);
  }

  const abortReason = `Uncommitted pause recovered after stale retry ${randomUUID()}`;
  await openStatus(page, doctor.id);
  await draft(page, abortReason);
  const beforeAbort = await get<DoctorBookingHistory>(page.request, `${path(doctor.id)}/history`);
  const aborted: { requestId: string; expectedRevision: string }[] = [];
  const abortFirst = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.continue();
    aborted.push(route.request().postDataJSON());
    return aborted.length === 1 ? route.abort('failed') : route.continue();
  };
  await page.route(`**${path(doctor.id)}`, abortFirst);
  try {
    const failed = page.waitForEvent(
      'requestfailed',
      (request) => new URL(request.url()).pathname === path(doctor.id),
    );
    await modal(page).getByRole('button', { name: 'Save booking status', exact: true }).click();
    await failed;
    await expect(
      modal(page).getByRole('button', { name: 'Retry same request', exact: true }),
    ).toBeEnabled();
    expect(await get<DoctorBookingHistory>(page.request, `${path(doctor.id)}/history`)).toEqual(
      beforeAbort,
    );
    await status(
      page.request,
      admin.headers,
      doctor.id,
      false,
      'Pause after an uncommitted request.',
    );
    const newer = await status(
      page.request,
      admin.headers,
      doctor.id,
      true,
      'Resume before the original request reaches the server.',
    );
    await submit(page, doctor.id, 'Retry same request', 409);
    expect(aborted[1]).toEqual(aborted[0]);
    await expect(
      modal(page).getByLabel('Reason for booking-status change', { exact: true }),
    ).toHaveValue(abortReason);
    await refresh(page);
    await modal(page).getByLabel(review, { exact: true }).check();
    const saved = (await (await submit(page, doctor.id)).json()) as DoctorBookingMutation;
    await expect(modal(page)).toBeHidden();
    expect(aborted).toHaveLength(3);
    expect(aborted[2].requestId).not.toBe(aborted[0].requestId);
    expect(aborted[2].expectedRevision).toBe(newer.context.revision);
    expect(
      (await get<DoctorBookingHistory>(page.request, `${path(doctor.id)}/history`)).items.filter(
        (item) => item.reason === abortReason,
      ),
    ).toEqual([saved.change]);
  } finally {
    await page.unroute(`**${path(doctor.id)}`, abortFirst);
  }
});

test('private booking-status history is paginated and protected, and obsolete reads or writes cannot change a later page', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const admin = await login(page.request);
  const doctor = await createDoctor(page.request, admin.headers);
  const other = await createDoctor(page.request, admin.headers);
  const secret = `Private booking history ${randomUUID()}`;
  for (let index = 0; index < 26; index++)
    await status(page.request, admin.headers, doctor.id, index % 2 === 1, `${secret} ${index}`);
  const historyDialog = () =>
    page.getByRole('dialog', { name: 'Booking-status history', exact: true });
  const row = (id: string) => page.locator(`.doctor-booking-team-row[data-doctor-id="${id}"]`);
  const pattern = `**${path(doctor.id)}/history?*`;
  let unavailable = true;
  const readFault = async (route: Route) =>
    unavailable
      ? route.fulfill({
          status: 503,
          json: { error: 'Synthetic booking-status history is unavailable.' },
        })
      : route.continue();
  await page.route(pattern, readFault);
  try {
    await page.goto('/clinic/settings?tab=team');
    await row(doctor.id)
      .getByRole('button', { name: 'Booking-status history', exact: true })
      .click();
    await expect(historyDialog().getByRole('alert')).toContainText(
      'Synthetic booking-status history',
    );
    unavailable = false;
    await historyDialog().getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(historyDialog().locator('.doctor-booking-change')).toHaveCount(25);
  } finally {
    await page.unroute(pattern, readFault);
  }
  const pagination = historyDialog().getByRole('navigation', {
    name: 'Booking-status history pagination',
    exact: true,
  });
  await pagination.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(historyDialog().locator('.doctor-booking-change')).toHaveCount(1);
  await pagination.getByRole('button', { name: 'Previous page', exact: true }).click();
  await expect(historyDialog().locator('.doctor-booking-change')).toHaveCount(25);
  await audit(page);
  await page.screenshot({
    path: testInfo.outputPath('doctor-booking-history-mobile.png'),
    fullPage: true,
  });
  await historyDialog().getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 900 });

  for (const role of ['doctor', 'reception']) {
    const context = await browser.newContext({ baseURL });
    try {
      const identity = await login(context.request, `${role}@derma.demo`);
      for (const endpoint of [path(doctor.id), `${path(doctor.id)}/history`])
        expect((await context.request.get(endpoint)).status()).toBe(403);
      const latest = await get<DoctorBookingContext>(page.request, path(doctor.id));
      const denied = await context.request.post(path(doctor.id), {
        headers: identity.headers,
        data: {
          acceptingNewBookings: false,
          reason: 'Unauthorized private status update.',
          expectedRevision: latest.revision,
          requestId: randomUUID(),
        },
      });
      expect(denied.status()).toBe(403);
      const staff = await context.newPage();
      await staff.goto('/clinic/scheduling');
      await staff.getByLabel('Doctor schedule', { exact: true }).selectOption(doctor.id);
      for (const action of ['Pause new bookings', 'Resume new bookings', 'Booking-status history'])
        await expect(staff.getByRole('button', { name: action, exact: true })).toHaveCount(0);
      expect(JSON.stringify(await get(context.request, '/api/doctors'))).not.toContain(secret);
      expect((await get<Session>(context.request, '/api/session')).user?.id).toBe(
        identity.session.user!.id,
      );
    } finally {
      await context.close();
    }
  }
  await page.evaluate(() => {
    const state = window as unknown as {
      bookingBodies: Record<string, number>;
      bookingExpired: number;
    };
    state.bookingBodies = {};
    state.bookingExpired = 0;
    window.addEventListener('derma:session-expired', () => state.bookingExpired++);
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const response = await original(input, init);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const pathname = new URL(url, window.location.origin).pathname;
      if (pathname.includes('/booking-status')) {
        const json = response.json.bind(response);
        response.json = async () => {
          try {
            return await json();
          } finally {
            const key = `${init?.method ?? 'GET'} ${pathname} ${response.status}`;
            state.bookingBodies[key] = (state.bookingBodies[key] ?? 0) + 1;
          }
        };
      }
      return response;
    };
  });
  const arrived = deferred(),
    releaseRead = deferred();
  let held = 0,
    settled = 0;
  const staleRead = async (route: Route) => {
    held++;
    arrived.resolve();
    await releaseRead.promise;
    try {
      await route.fulfill({
        status: 401,
        json: { error: 'Obsolete private history must not sign out a current session.' },
      });
    } finally {
      settled++;
    }
  };
  await page.route(pattern, staleRead);
  try {
    await row(doctor.id)
      .getByRole('button', { name: 'Booking-status history', exact: true })
      .click();
    await arrived.promise;
    await historyDialog().getByRole('button', { name: 'Close dialog', exact: true }).click();
    await row(other.id).getByRole('button', { name: 'Pause new bookings', exact: true }).click();
    await expect(modal(page).locator('.doctor-booking-source')).toContainText(other.name);
    const count = held;
    releaseRead.resolve();
    await expect.poll(() => settled).toBe(count);
    await page.waitForFunction(
      ({ key, count }) =>
        (window as unknown as { bookingBodies: Record<string, number> }).bookingBodies[key] >=
        count,
      { key: `GET ${path(doctor.id)}/history 401`, count },
    );
    expect(
      await page.evaluate(() => (window as unknown as { bookingExpired: number }).bookingExpired),
    ).toBe(0);
    await expect(modal(page).locator('.doctor-booking-source')).toContainText(other.name);
    expect((await get<Session>(page.request, '/api/session')).user?.id).toBe(
      admin.session.user!.id,
    );
  } finally {
    releaseRead.resolve();
    await page.unroute(pattern, staleRead);
  }

  const delayedReason = `Delayed source save ${randomUUID()}`;
  await draft(page, delayedReason);
  const ready = deferred(),
    release = deferred(),
    done = deferred();
  let committed: DoctorBookingMutation | undefined;
  const holdSave = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    committed = (await response.json()) as DoctorBookingMutation;
    ready.resolve();
    await release.promise;
    try {
      await route.fulfill({ response });
    } finally {
      done.resolve();
    }
  };
  await page.route(`**${path(other.id)}`, holdSave);
  try {
    await modal(page).getByRole('button', { name: 'Save booking status', exact: true }).click();
    await ready.promise;
    await page.evaluate(() => {
      window.history.pushState({ key: 'doctor-status-away' }, '', '/clinic');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.getByRole('heading', { name: /^A good day for better care/ })).toBeVisible();
    await page.goBack();
    await expect(row(doctor.id).getByText('Accepting new bookings', { exact: true })).toBeVisible();
    release.resolve();
    await done.promise;
    await page.waitForFunction(
      (key) =>
        (window as unknown as { bookingBodies: Record<string, number> }).bookingBodies[key] >= 1,
      `POST ${path(other.id)} 201`,
    );
    await expect(modal(page)).toHaveCount(0);
    await expect(page.getByText('Doctor booking status saved.', { exact: true })).toHaveCount(0);
    await expect(page).toHaveURL(/\/clinic\/settings\?tab=team$/);
    expect(
      (await get<DoctorBookingHistory>(page.request, `${path(other.id)}/history`)).items,
    ).toEqual([committed!.change]);
  } finally {
    release.resolve();
    await page.unroute(`**${path(other.id)}`, holdSave);
  }
});
