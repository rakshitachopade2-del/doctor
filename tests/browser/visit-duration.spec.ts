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
import type { VisitDurationContext, VisitDurationMutation } from '../../shared/visit-duration';
import type { AppointmentResourceContext, ResourceDetail } from '../../shared/clinic-resources';
import type { PatientClinicalWorkflows } from '../../shared/clinical';
import type { CareSummary } from '../../shared/care-summary';

const future = (days = 30) => {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return new Date(Date.parse(`${today}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
};
const windows = Array.from({ length: 7 }, (_, day) => ({
  day,
  start: '08:00',
  end: '18:00',
  mode: 'both',
}));
async function login(request: APIRequestContext, email = 'admin@derma.demo') {
  const response = await request.post('/api/auth/login', {
    data: { email, password: 'DemoClinic2026!' },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const session = (await response.json()) as Session;
  return { session, headers: { 'X-CSRF-Token': session.csrfToken! } };
}
async function get<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path);
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
async function configure(
  request: APIRequestContext,
  headers: Record<string, string>,
  doctorId: string,
  durationMinutes: number,
) {
  const response = await request.put(`/api/schedules/${doctorId}`, {
    headers,
    data: { durationMinutes, windows },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}
async function doctor(
  request: APIRequestContext,
  headers: Record<string, string>,
  durationMinutes = 20,
) {
  const response = await request.post('/api/doctors', {
    headers,
    data: {
      name: `Dr. Visit ${randomUUID().slice(0, 8)}`,
      title: 'Dermatologist',
      qualifications: 'Synthetic profile',
      specialties: ['General dermatology'],
      experience: 5,
      fee: 600,
      bio: 'Synthetic visit-length verification.',
      languages: ['English'],
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  const value = (await response.json()) as Doctor;
  await configure(request, headers, value.id, durationMinutes);
  return value;
}
async function patient(request: APIRequestContext, headers: Record<string, string>) {
  const response = await request.post('/api/patients', {
    headers,
    data: {
      name: `Visit Patient ${randomUUID().slice(0, 8)}`,
      email: '',
      phone: '+91 9000000240',
      dob: '',
      gender: 'Not specified',
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return response.json() as Promise<{ id: string; name: string }>;
}
async function custom(
  request: APIRequestContext,
  headers: Record<string, string>,
  doctorId: string,
  patientId: string,
  date: string,
  time: string,
  durationMinutes: number,
) {
  const response = await request.post('/api/visit-duration/bookings', {
    headers,
    data: {
      doctorId,
      patientId,
      date,
      time,
      durationMinutes,
      mode: 'in-person',
      reason: 'Synthetic custom-length visit.',
      requestId: randomUUID(),
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return response.json() as Promise<VisitDurationMutation>;
}
async function book(
  request: APIRequestContext,
  headers: Record<string, string>,
  doctorId: string,
  patientId: string,
  date: string,
  time: string,
) {
  const response = await request.post('/api/appointments', {
    headers,
    data: {
      doctorId,
      patientId,
      date,
      time,
      mode: 'in-person',
      reason: 'Synthetic ordinary visit.',
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return response.json() as Promise<Appointment>;
}
const lengthContext = (request: APIRequestContext, id: string) =>
  get<VisitDurationContext>(request, `/api/appointments/${id}/duration`);
const resources = (request: APIRequestContext, id: string) =>
  get<AppointmentResourceContext>(request, `/api/appointments/${id}/resources`);
async function room(request: APIRequestContext, headers: Record<string, string>) {
  const response = await request.post('/api/clinic-resources', {
    headers,
    data: {
      name: `Private visit room ${randomUUID().slice(0, 8)}`,
      kind: 'room',
      location: 'Synthetic clinic area',
      notes: 'PRIVATE operational fixture',
      requestId: randomUUID(),
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return response.json() as Promise<ResourceDetail>;
}
async function allocate(
  request: APIRequestContext,
  headers: Record<string, string>,
  appointmentId: string,
  roomId: string,
) {
  const response = await request.put(`/api/appointments/${appointmentId}/resources`, {
    headers,
    data: {
      resourceIds: [roomId],
      reason: 'PRIVATE room allocation reason',
      expectedRevision: (await resources(request, appointmentId)).revision,
      requestId: randomUUID(),
    },
  });
  expect(response.status(), await response.text()).toBe(200);
  return response.json() as Promise<AppointmentResourceContext>;
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
async function holdCommitted(page: Page, path: string, outcome: 'lost' | 'malformed') {
  let release!: () => void, arrived!: () => void, finished!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    ready = new Promise<void>((r) => {
      arrived = r;
    }),
    done = new Promise<void>((r) => {
      finished = r;
    });
  let body: Record<string, unknown> | undefined,
    saved: VisitDurationMutation | undefined,
    used = false;
  const handler = async (route: Route) => {
    if (used || route.request().method() !== 'POST') return route.continue();
    used = true;
    try {
      body = route.request().postDataJSON();
      const response = await route.fetch();
      expect(response.ok(), await response.text()).toBeTruthy();
      saved = (await response.json()) as VisitDurationMutation;
      arrived();
      await gate;
      await route.fulfill({
        status: outcome === 'lost' ? 503 : 200,
        contentType: 'application/json',
        body: JSON.stringify(
          outcome === 'lost'
            ? { error: 'Synthetic lost response after the visit was saved.' }
            : { ...saved, event: { ...saved.event, after: null } },
        ),
      });
    } finally {
      finished();
    }
  };
  await page.route(`**${path}`, handler);
  return {
    ready,
    body: () => body,
    saved: () => saved!,
    release: async () => {
      release();
      if (used) await done;
      await page.unroute(`**${path}`, handler);
    },
  };
}
async function retry(
  page: Page,
  dialog: Locator,
  path: string,
  body: Record<string, unknown> | undefined,
  closesDialog = true,
) {
  const request = page.waitForRequest(
    (r) => r.method() === 'POST' && new URL(r.url()).pathname === path,
  );
  const response = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === path,
  );
  await dialog.getByRole('button', { name: 'Retry same request', exact: true }).click();
  expect((await request).postDataJSON()).toEqual(body);
  const confirmed = await response;
  expect(confirmed.status()).toBe(200);
  if (closesDialog) await expect(dialog).toHaveCount(0);
  return (await confirmed.json()) as VisitDurationMutation;
}
function stamp(date: string, time: string) {
  return new Date(`${date}T${time}:00+05:30`)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}
async function calendar(request: APIRequestContext, appointment: Appointment, end: string) {
  const response = await request.get(`/api/appointments/${appointment.id}/calendar`);
  expect(response.ok()).toBeTruthy();
  const text = await response.text();
  expect(text).toContain(`DTSTART:${stamp(appointment.date, appointment.time)}`);
  expect(text).toContain(`DTEND:${stamp(appointment.date, end)}`);
  expect(text).not.toContain('PRIVATE');
  return text;
}
async function fillCustom(
  page: Page,
  doctorId: string,
  date: string,
  time: string,
  minutes: number,
  reason: string,
) {
  await page.getByRole('button', { name: 'New appointment', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New appointment', exact: true });
  await dialog.getByLabel('Patient', { exact: true }).selectOption('patient-ananya');
  await dialog.getByLabel('Doctor', { exact: true }).selectOption(doctorId);
  await dialog.getByLabel('Date', { exact: true }).fill(date);
  await dialog.getByRole('combobox', { name: 'Visit length', exact: true }).selectOption('custom');
  await dialog.getByLabel('Custom duration (minutes)', { exact: true }).fill(String(minutes));
  await dialog.getByLabel('Reason for visit', { exact: true }).fill(reason);
  await dialog.getByRole('button', { name: time, exact: true }).click();
  return dialog;
}

test('staff custom bookings retain exact retry receipts and patients see their saved length and calendar interval', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(120000);
  const { headers } = await login(page.request);
  const clinician = await doctor(page.request, headers, 20);
  const date = future(30);
  const suffix = randomUUID().slice(0, 8);
  const beforeInvoices = await get<unknown[]>(page.request, '/api/invoices');
  const beforeWorkflows = await get<PatientClinicalWorkflows>(
    page.request,
    '/api/patients/patient-ananya/clinical-workflows',
  );
  await page.goto(`/clinic/appointments?date=${date}`);
  let dialog = await fillCustom(
    page,
    clinician.id,
    date,
    '9:05 AM',
    90,
    `Extended clinic visit ${suffix}`,
  );
  await expect(dialog.locator('.visit-duration-preview')).toContainText('90');
  const first = await holdCommitted(page, '/api/visit-duration/bookings', 'lost');
  try {
    await dialog.getByRole('button', { name: 'Book appointment', exact: true }).click();
    await first.ready;
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Custom duration (minutes)', { exact: true })).toBeDisabled();
  } finally {
    await first.release();
  }
  await expect(
    dialog.getByRole('button', { name: 'Retry same request', exact: true }),
  ).toBeVisible();
  const saved = first.saved();
  expect(saved.appointment).toMatchObject({
    durationPolicy: 'custom',
    durationMinutes: 90,
    time: '09:05',
    fee: 600,
  });
  await dialog.getByRole('button', { name: 'Close for now', exact: true }).click();
  await page.getByRole('button', { name: 'Resume custom booking', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'New appointment', exact: true });
  await expect(dialog.getByLabel('Custom duration (minutes)', { exact: true })).toHaveValue('90');
  await retry(page, dialog, '/api/visit-duration/bookings', first.body());
  expect((await lengthContext(page.request, saved.appointment.id)).history).toHaveLength(1);
  dialog = await fillCustom(
    page,
    clinician.id,
    date,
    '11:05 AM',
    45,
    `Second extended visit ${suffix}`,
  );
  const malformed = await holdCommitted(page, '/api/visit-duration/bookings', 'malformed');
  try {
    await dialog.getByRole('button', { name: 'Book appointment', exact: true }).click();
    await malformed.ready;
  } finally {
    await malformed.release();
  }
  await expect(
    dialog.getByRole('button', { name: 'Retry same request', exact: true }),
  ).toBeVisible();
  await expect(dialog.getByLabel('Reason for visit', { exact: true })).toBeDisabled();
  await retry(page, dialog, '/api/visit-duration/bookings', malformed.body());
  expect(
    (await lengthContext(page.request, malformed.saved().appointment.id)).history,
  ).toHaveLength(1);
  expect(
    (await get<Appointment[]>(page.request, '/api/appointments')).filter((a) =>
      a.reason.includes(suffix),
    ),
  ).toHaveLength(2);
  expect(await get<unknown[]>(page.request, '/api/invoices')).toEqual(beforeInvoices);
  expect(
    (
      await get<PatientClinicalWorkflows>(
        page.request,
        '/api/patients/patient-ananya/clinical-workflows',
      )
    ).procedures,
  ).toEqual(beforeWorkflows.procedures);
  const owner = await browser.newContext({ baseURL });
  try {
    const patientSession = await login(owner.request, 'patient@derma.demo');
    const ownPage = await owner.newPage();
    await ownPage.goto('/my-care');
    const visit = ownPage.locator('.upcoming-visit').filter({ hasText: '09:05–10:35' });
    await expect(visit).toContainText('90 minutes');
    await expect(visit).toContainText('In-person clinic visit');
    const ics = await calendar(owner.request, saved.appointment, '10:35');
    expect(ics).toContain('SUMMARY:Clinic visit');
    const summary = await get<CareSummary>(
      owner.request,
      '/api/patients/patient-ananya/care-summary',
    );
    expect(summary.appointments.find((a) => a.id === saved.appointment.id)?.durationMinutes).toBe(
      90,
    );
    expect(JSON.stringify(summary)).not.toContain('Booked a custom-length visit.');
    expect(
      (await owner.request.get(`/api/appointments/${saved.appointment.id}/duration`)).status(),
    ).toBe(403);
    const denied = await owner.request.patch(`/api/appointments/${saved.appointment.id}`, {
      headers: patientSession.headers,
      data: { durationMinutes: 15, durationPolicy: 'schedule' },
    });
    expect(denied.status()).toBeGreaterThanOrEqual(400);
    expect(denied.status()).toBeLessThan(500);
    await ownPage.goto('/my-care/record?tab=visits');
    await expect(ownPage.getByRole('row').filter({ hasText: '09:05–10:35' })).toContainText(
      '90 minutes',
    );
    await ownPage.setViewportSize({ width: 320, height: 780 });
    await audit(ownPage);
    await ownPage.screenshot({
      path: testInfo.outputPath('custom-visit-patient-record-mobile.png'),
      fullPage: true,
    });
  } finally {
    await owner.close();
  }
});

test('patient rescheduling retains custom length after defaults change and checks the whole patient and resource interval', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(120000);
  const { headers } = await login(page.request);
  const clinician = await doctor(page.request, headers, 30),
    other = await doctor(page.request, headers, 20);
  const date = future(45);
  const otherPatient = await patient(page.request, headers);
  const original = (
    await custom(page.request, headers, clinician.id, 'patient-ananya', date, '09:05', 90)
  ).appointment;
  const assigned = await room(page.request, headers);
  const originalResources = await allocate(
    page.request,
    headers,
    original.id,
    assigned.resource.id,
  );
  const neighbour = await book(page.request, headers, other.id, otherPatient.id, date, '10:40');
  await allocate(page.request, headers, neighbour.id, assigned.resource.id);
  await book(page.request, headers, other.id, 'patient-ananya', date, '13:00');
  const currentRoom = await get<ResourceDetail>(
    page.request,
    `/api/clinic-resources/${assigned.resource.id}`,
  );
  const maintenance = await page.request.post(
    `/api/clinic-resources/${assigned.resource.id}/closures`,
    {
      headers,
      data: {
        startDate: date,
        endDate: date,
        startTime: '15:00',
        endTime: '15:20',
        reason: 'PRIVATE maintenance interval',
        expectedRevision: currentRoom.resource.revision,
        requestId: randomUUID(),
      },
    },
  );
  expect(maintenance.status(), await maintenance.text()).toBe(201);
  await configure(page.request, headers, clinician.id, 20);
  const owner = await browser.newContext({ baseURL });
  try {
    const patientSession = await login(owner.request, 'patient@derma.demo');
    const before = await resources(page.request, original.id);
    const forced = await owner.request.patch(`/api/appointments/${original.id}`, {
      headers: patientSession.headers,
      data: { time: '09:15' },
    });
    expect(forced.status(), await forced.text()).toBe(409);
    const error = await forced.text();
    expect(error).not.toContain(assigned.resource.name);
    expect(error).not.toContain(otherPatient.name);
    expect(error).not.toContain('PRIVATE');
    const unchanged = await resources(page.request, original.id);
    expect(unchanged.appointment).toEqual(before.appointment);
    expect(unchanged.resourceIds).toEqual(before.resourceIds);
    expect(unchanged.history).toEqual(before.history);
    const ownPage = await owner.newPage();
    await ownPage.goto(`/book?appointmentId=${original.id}`);
    await expect(
      ownPage.locator('.booking-summary').getByText('90 minutes', { exact: true }),
    ).toBeVisible();
    await expect(ownPage.locator('.booking-summary')).toContainText('keeps its booked length');
    await expect(ownPage.getByLabel('Custom duration (minutes)', { exact: true })).toHaveCount(0);
    const times = ownPage.getByRole('group', { name: 'Available appointment times', exact: true });
    await expect(times.getByRole('button', { name: '09:10', exact: true })).toBeVisible();
    await expect(times.getByRole('button', { name: '09:15', exact: true })).toHaveCount(0);
    await expect(times.getByRole('button', { name: '11:30', exact: true })).toBeVisible();
    await expect(times.getByRole('button', { name: '11:35', exact: true })).toHaveCount(0);
    await expect(times.getByRole('button', { name: '13:30', exact: true })).toBeVisible();
    await expect(times.getByRole('button', { name: '13:35', exact: true })).toHaveCount(0);
    await expect(ownPage.getByText(assigned.resource.name, { exact: true })).toHaveCount(0);
    await expect(ownPage.getByText(otherPatient.name, { exact: true })).toHaveCount(0);
    await times.getByRole('button', { name: '11:00', exact: true }).click();
    await ownPage.getByRole('button', { name: 'Confirm new time', exact: true }).click();
    await expect(
      ownPage.getByRole('heading', { name: 'Appointment rescheduled.', exact: true }),
    ).toBeVisible();
    await expect(ownPage.locator('.booking-confirmation-details')).toContainText('11:00–12:30');
    await expect(ownPage.locator('.booking-confirmation-details')).toContainText('90 minutes');
    const moved = await resources(page.request, original.id);
    expect(moved.appointment).toMatchObject({ time: '11:00', durationMinutes: 90 });
    expect(moved.resourceIds).toEqual(originalResources.resourceIds);
    expect(moved.history[0]).toMatchObject({
      source: 'appointment-rescheduled',
      before: { appointment: { time: '09:05', durationMinutes: 90 } },
      after: { appointment: { time: '11:00', durationMinutes: 90 } },
    });
    const ownAppointments = await get<Appointment[]>(owner.request, '/api/appointments');
    const saved = ownAppointments.find((a) => a.id === original.id)!;
    expect(saved.durationPolicy).toBe('custom');
    await calendar(owner.request, saved, '12:30');
    expect(JSON.stringify(ownAppointments)).not.toContain('PRIVATE');
    const freed = await custom(
      page.request,
      headers,
      clinician.id,
      otherPatient.id,
      date,
      '09:05',
      90,
    );
    expect(
      (await resources(page.request, freed.appointment.id)).resources.find(
        (r) => r.resource.id === assigned.resource.id,
      )?.available,
    ).toBe(true);
    await ownPage.setViewportSize({ width: 320, height: 780 });
    await audit(ownPage);
    await ownPage.screenshot({
      path: testInfo.outputPath('retained-visit-confirmation-mobile.png'),
      fullPage: true,
    });
    const cancelled = await owner.request.patch(`/api/appointments/${original.id}`, {
      headers: patientSession.headers,
      data: { status: 'cancelled' },
    });
    expect(cancelled.ok(), await cancelled.text()).toBeTruthy();
    const released = await resources(page.request, original.id);
    expect(released.resourceIds).toEqual([]);
    expect(released.history[0].after.appointment.durationMinutes).toBe(90);
    expect(released.history[0].before.resources).toHaveLength(1);
  } finally {
    await owner.close();
  }
});

test('staff review stale length changes, avoid partial resource resizes, and explicitly restore the schedule default', async ({
  page,
}, testInfo) => {
  test.setTimeout(120000);
  const { headers, session } = await login(page.request);
  const clinician = await doctor(page.request, headers, 20),
    other = await doctor(page.request, headers, 20);
  const patientA = await patient(page.request, headers),
    patientB = await patient(page.request, headers);
  const date = future(60);
  const created = await custom(page.request, headers, clinician.id, patientA.id, date, '09:00', 60);
  const assigned = await room(page.request, headers);
  await allocate(page.request, headers, created.appointment.id, assigned.resource.id);
  const path = `/api/appointments/${created.appointment.id}/duration`;
  await page.goto(`/clinic/appointments?date=${date}&duration=${created.appointment.id}`);
  const dialog = page.getByRole('dialog', { name: 'Visit length', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Custom duration (minutes)', { exact: true }).fill('90');
  await dialog
    .getByRole('group', { name: 'Available visit times', exact: true })
    .getByRole('button', { name: '09:00', exact: true })
    .click();
  const privateReason = `PRIVATE length change ${randomUUID().slice(0, 8)}`;
  await dialog.getByLabel('Reason for length change', { exact: true }).fill(privateReason);
  // The target time was available when this draft began. A later resource claim
  // and changed clinician fee require a fresh review before any interval changes.
  const blocker = await book(page.request, headers, other.id, patientB.id, date, '10:00');
  await allocate(page.request, headers, blocker.id, assigned.resource.id);
  const renamed = { ...clinician, name: `${clinician.name} Updated`, fee: 900 };
  const profile = await page.request.patch(`/api/doctors/${clinician.id}`, {
    headers,
    data: renamed,
  });
  expect(profile.ok(), await profile.text()).toBeTruthy();
  const staleRequest = page.waitForRequest(
    (r) => r.method() === 'POST' && new URL(r.url()).pathname === path,
  );
  const staleResponse = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === path,
  );
  await dialog.getByRole('button', { name: 'Save visit length', exact: true }).click();
  const staleBody = (await staleRequest).postDataJSON();
  expect((await staleResponse).status()).toBe(409);
  await expect(dialog.getByLabel('Custom duration (minutes)', { exact: true })).toHaveValue('90');
  await expect(dialog.getByLabel('Reason for length change', { exact: true })).toHaveValue(
    privateReason,
  );
  const before = await lengthContext(page.request, created.appointment.id),
    beforeResources = await resources(page.request, created.appointment.id);
  const rejected = await page.request.post(path, {
    headers,
    data: {
      durationPolicy: 'custom',
      durationMinutes: 90,
      date,
      time: '09:00',
      reason: 'Forced conflicting resize fixture',
      expectedRevision: before.revision,
      requestId: randomUUID(),
    },
  });
  expect(rejected.status(), await rejected.text()).toBe(409);
  expect((await lengthContext(page.request, created.appointment.id)).history).toEqual(
    before.history,
  );
  expect((await lengthContext(page.request, created.appointment.id)).appointment).toEqual(
    before.appointment,
  );
  expect((await resources(page.request, created.appointment.id)).history).toEqual(
    beforeResources.history,
  );
  await dialog.getByRole('button', { name: 'Refresh latest visit', exact: true }).click();
  await expect(dialog.locator('.visit-duration-reviewed')).toContainText('₹900');
  await dialog
    .getByRole('button', { name: 'I reviewed the latest visit; keep my draft', exact: true })
    .click();
  await expect(dialog.getByLabel('Custom duration (minutes)', { exact: true })).toHaveValue('90');
  await expect(dialog.getByLabel('Reason for length change', { exact: true })).toHaveValue(
    privateReason,
  );
  const times = dialog.getByRole('group', { name: 'Available visit times', exact: true });
  await expect(times.getByRole('button', { name: '09:00', exact: true })).toHaveCount(0);
  await times.getByRole('button', { name: '11:00', exact: true }).click();
  const savedRequest = page.waitForRequest(
    (r) => r.method() === 'POST' && new URL(r.url()).pathname === path,
  );
  const savedResponse = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === path,
  );
  await dialog.getByRole('button', { name: 'Save visit length', exact: true }).click();
  const savedBody = (await savedRequest).postDataJSON();
  expect(savedBody.requestId).not.toBe(staleBody.requestId);
  expect(savedBody.expectedRevision).not.toBe(staleBody.expectedRevision);
  const moved = (await (await savedResponse).json()) as VisitDurationMutation;
  expect(moved.appointment).toMatchObject({
    time: '11:00',
    durationMinutes: 90,
    durationPolicy: 'custom',
    fee: 900,
    doctorName: renamed.name,
  });
  expect(moved.event).toMatchObject({
    reason: privateReason,
    createdById: session.user!.id,
    before: { time: '09:00', durationMinutes: 60 },
    after: { time: '11:00', durationMinutes: 90 },
  });
  await expect(dialog.getByText(privateReason, { exact: true })).toBeVisible();
  const latestProfile = { ...renamed, name: `${clinician.name} Latest`, fee: 1200 };
  const repriced = await page.request.patch(`/api/doctors/${clinician.id}`, {
    headers,
    data: latestProfile,
  });
  expect(repriced.ok()).toBeTruthy();
  await page.reload();
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Custom duration (minutes)', { exact: true }).fill('75');
  await times.getByRole('button', { name: '11:00', exact: true }).click();
  await dialog
    .getByLabel('Reason for length change', { exact: true })
    .fill('PRIVATE duration-only adjustment');
  const malformedLength = await holdCommitted(page, path, 'malformed');
  try {
    await dialog.getByRole('button', { name: 'Save visit length', exact: true }).click();
    await malformedLength.ready;
  } finally {
    await malformedLength.release();
  }
  await expect(
    dialog.getByRole('button', { name: 'Retry same request', exact: true }),
  ).toBeVisible();
  await expect(dialog.getByLabel('Custom duration (minutes)', { exact: true })).toHaveValue('75');
  await expect(dialog.getByLabel('Custom duration (minutes)', { exact: true })).toBeDisabled();
  await expect(dialog.getByLabel('Reason for length change', { exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(dialog).toBeVisible();
  const committedLength = await lengthContext(page.request, created.appointment.id);
  const committedResources = await resources(page.request, created.appointment.id);
  expect(committedLength.history).toHaveLength(3);
  const durationOnly = await retry(page, dialog, path, malformedLength.body(), false);
  expect(durationOnly.event).toEqual(malformedLength.saved().event);
  expect((await lengthContext(page.request, created.appointment.id)).history).toEqual(
    committedLength.history,
  );
  expect((await resources(page.request, created.appointment.id)).history).toEqual(
    committedResources.history,
  );
  expect(durationOnly.appointment).toMatchObject({
    time: '11:00',
    durationMinutes: 75,
    fee: 900,
    doctorName: renamed.name,
  });
  await expect(dialog.getByText('PRIVATE duration-only adjustment', { exact: true })).toBeVisible();
  await expect(dialog.locator('.visit-duration-source')).toContainText('75 minutes');
  await expect(dialog.getByLabel('Custom duration (minutes)', { exact: true })).toHaveValue('75');
  await expect(dialog.getByLabel('Custom duration (minutes)', { exact: true })).toBeEnabled();
  await dialog
    .getByRole('combobox', { name: 'Visit length', exact: true })
    .selectOption('schedule');
  await times.getByRole('button', { name: '11:00', exact: true }).click();
  await dialog
    .getByLabel('Reason for length change', { exact: true })
    .fill('PRIVATE restore ordinary length');
  const lostRestore = await holdCommitted(page, path, 'lost');
  try {
    await dialog.getByRole('button', { name: 'Save visit length', exact: true }).click();
    await lostRestore.ready;
  } finally {
    await lostRestore.release();
  }
  await expect(
    dialog.getByRole('button', { name: 'Retry same request', exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Visit length', exact: true })).toBeDisabled();
  await expect(dialog.getByLabel('Reason for length change', { exact: true })).toBeDisabled();
  const restoreBody = lostRestore.body();
  expect(restoreBody).not.toHaveProperty('durationMinutes');
  const committedRestore = await lengthContext(page.request, created.appointment.id);
  const restoredResources = await resources(page.request, created.appointment.id);
  expect(committedRestore.history).toHaveLength(4);
  const restored = await retry(page, dialog, path, restoreBody, false);
  expect(restored.event).toEqual(lostRestore.saved().event);
  expect((await lengthContext(page.request, created.appointment.id)).history).toEqual(
    committedRestore.history,
  );
  expect((await resources(page.request, created.appointment.id)).history).toEqual(
    restoredResources.history,
  );
  expect(restored.appointment).toMatchObject({
    durationPolicy: 'schedule',
    durationMinutes: 20,
    time: '11:00',
    fee: 900,
    doctorName: renamed.name,
  });
  await expect(dialog.getByText('PRIVATE restore ordinary length', { exact: true })).toBeVisible();
  const final = await lengthContext(page.request, created.appointment.id);
  expect(final.history).toHaveLength(4);
  expect(final.history.find((e) => e.operation === 'custom-booking')).toEqual(created.event);
  expect((await resources(page.request, created.appointment.id)).appointment.durationMinutes).toBe(
    20,
  );
  await page.setViewportSize({ width: 320, height: 780 });
  await audit(page);
  await page.screenshot({
    path: testInfo.outputPath('visit-length-history-mobile.png'),
    fullPage: true,
  });
  const cancelled = await page.request.patch(`/api/appointments/${created.appointment.id}`, {
    headers,
    data: { status: 'cancelled' },
  });
  expect(cancelled.ok()).toBeTruthy();
  await page.reload();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Save visit length', exact: true })).toHaveCount(
    0,
  );
  await expect(dialog.getByText(privateReason, { exact: true })).toBeVisible();
});
