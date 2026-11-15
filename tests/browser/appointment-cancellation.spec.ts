import { test, expect, type APIRequestContext, type Page, type Locator } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import type { Appointment, Doctor, PatientRecord, Session } from '../../shared/types';
import type {
  AppointmentCancellationContext,
  AppointmentCancellationInput,
  AppointmentCancellationResult,
} from '../../shared/appointment-cancellation';
import type { AppointmentResourceContext, ResourceDetail } from '../../shared/clinic-resources';
import type { PatientClinicalWorkflows, ProcedureRecord } from '../../shared/clinical';
import type { Invoice, InvoiceDetail } from '../../shared/operations';
import type { ActivityFeed } from '../../shared/activity';

const base = (id: string) => `/api/appointments/${id}`;
const patientAgreement = 'I agree to cancel this appointment.';
const staffAgreement = 'I reviewed this appointment and confirm its cancellation.';
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
    name: `Dr. Reviewed Cancellation ${randomUUID().slice(0, 8)}`,
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
    reason: `Synthetic reviewed cancellation ${randomUUID()}`,
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
async function confirm(
  page: Page,
  scope: Page | Locator,
  id: string,
  code = 201,
  label = 'Confirm cancellation',
) {
  const waiting = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `${base(id)}/cancellations` &&
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
    .getByRole('button', { name: 'Cancel appointment', exact: true })
    .click();
  return page.getByRole('dialog', { name: 'Cancel appointment', exact: true });
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
      state = window as Window & { cancellationConsumed?: string[]; cancellationExpired?: number };
    state.cancellationConsumed = [];
    state.cancellationExpired = 0;
    window.addEventListener('derma:session-expired', () => state.cancellationExpired!++);
    window.fetch = async (...args) => {
      const response = await original(...args),
        marker = response.headers.get('X-Test-Cancellation-Settled');
      if (marker) {
        const json = response.json.bind(response);
        response.json = async () => {
          try {
            return await json();
          } finally {
            state.cancellationConsumed!.push(marker);
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
          (window as Window & { cancellationConsumed?: string[] }).cancellationConsumed?.includes(
            marker,
          ),
        marker,
      ),
    )
    .toBe(true);
}

async function openPatient(page: Page, appointment: Appointment) {
  await page.goto(`/my-care?appointment=${appointment.id}`);
  const selected = page.locator('.patient-selected-appointment');
  await expect(selected).toContainText(appointment.doctorName);
  await selected.getByRole('button', { name: 'Cancel', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Cancel appointment', exact: true });
  await expect(dialog.locator('.appointment-cancellation-source')).toBeVisible();
  return dialog;
}

test('patient reviews source and allocation ABA before cancellation releases resources without altering clinical or billing records', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const admin = await login(page.request),
    clinician = await doctor(page.request, admin.headers);
  const original = await book(page.request, admin.headers, clinician.id, future(30));
  const allocated = await room(page.request, admin.headers);
  await resources(page.request, admin.headers, original.id, allocated.resource.id);
  const procedure = await post<ProcedureRecord>(page.request, admin.headers, '/api/procedures', {
    patientId: original.patientId,
    appointmentId: original.id,
    title: `Unchanged cancellation plan ${randomUUID()}`,
    indication: 'Patient-specific clinical indication',
    benefits: 'Reviewed benefits',
    risks: 'Reviewed risks',
    alternatives: 'Reviewed alternatives',
    aftercare: 'Reviewed aftercare',
    estimatedCost: 'Estimate only',
  });
  const invoice = await post<Invoice>(page.request, admin.headers, '/api/invoices', {
    patientId: original.patientId,
    procedureId: procedure.id,
    requestId: randomUUID(),
    items: [
      { description: 'Unchanged explicit procedure charge', quantity: 1, unitAmountPaise: 14000 },
    ],
  });
  const invoiceBefore = await get<InvoiceDetail>(page.request, `/api/invoices/${invoice.id}`);
  const own = await browser.newContext({ baseURL });
  try {
    const portal = await own.newPage();
    await login(portal.request, 'patient@derma.demo');
    const dialog = await openPatient(portal, original);
    await expect(
      dialog.getByRole('button', { name: 'Confirm cancellation', exact: true }),
    ).toBeDisabled();
    await dialog.getByLabel(patientAgreement, { exact: true }).check();
    // Return to identical public fields; source counters still invalidate the old review.
    await patch(page.request, admin.headers, original.id, { time: '10:00' });
    await patch(page.request, admin.headers, original.id, { time: original.time });
    const stale = await confirm(portal, dialog, original.id, 409);
    expect(await stale.json()).toMatchObject({
      cancellationOutcome: 'not-applied',
      appointmentId: original.id,
    });
    await dialog.getByRole('button', { name: 'Refresh current visit', exact: true }).click();
    await expect(dialog.getByLabel(patientAgreement, { exact: true })).toBeEnabled();
    await expect(dialog.getByLabel(patientAgreement, { exact: true })).not.toBeChecked();
    await dialog.getByLabel(patientAgreement, { exact: true }).check();
    // Even restoring the same resource selection requires reviewing the new source.
    const beforeClear = await get<AppointmentResourceContext>(
      page.request,
      `${base(original.id)}/resources`,
    );
    const clear = await page.request.put(`${base(original.id)}/resources`, {
      headers: admin.headers,
      data: {
        resourceIds: [],
        reason: 'PRIVATE resource ABA',
        expectedRevision: beforeClear.revision,
        requestId: randomUUID(),
      },
    });
    expect(clear.status(), await clear.text()).toBe(200);
    await resources(page.request, admin.headers, original.id, allocated.resource.id);
    await confirm(portal, dialog, original.id, 409);
    await dialog.getByRole('button', { name: 'Refresh current visit', exact: true }).click();
    await expect(dialog.getByLabel(patientAgreement, { exact: true })).toBeEnabled();
    const source = await get<AppointmentCancellationContext>(
      portal.request,
      `${base(original.id)}/cancellation-context`,
    );
    expect(source.appointment).toEqual(original);
    expect(JSON.stringify(source)).not.toContain(allocated.resource.id);
    expect(JSON.stringify(source)).not.toContain('PRIVATE');
    await dialog.getByLabel(patientAgreement, { exact: true }).check();
    await audit(portal);
    const confirmButton = dialog.getByRole('button', { name: 'Confirm cancellation', exact: true });
    await confirmButton.scrollIntoViewIfNeeded();
    await expect(confirmButton).toBeInViewport();
    await expect(dialog.getByLabel(patientAgreement, { exact: true })).toBeInViewport();
    await portal.screenshot({
      path: testInfo.outputPath('patient-cancellation-review-mobile.png'),
      fullPage: false,
    });
    const activityBefore = await get<ActivityFeed>(portal.request, '/api/activity?limit=100');
    const saved = (await (
      await confirm(portal, dialog, original.id)
    ).json()) as AppointmentCancellationResult;
    await expect(
      dialog.getByRole('heading', { name: 'Cancellation confirmed', exact: true }),
    ).toBeVisible();
    expect(saved.event.before).toEqual(original);
    expect(saved.event.after).toEqual({ ...original, status: 'cancelled' });
    const released = await get<AppointmentResourceContext>(
      page.request,
      `${base(original.id)}/resources`,
    );
    expect(released.resourceIds).toEqual([]);
    expect(released.history[0].source).toBe('appointment-status');
    expect(await get<InvoiceDetail>(page.request, `/api/invoices/${invoice.id}`)).toEqual(
      invoiceBefore,
    );
    const retained = (
      await get<PatientClinicalWorkflows>(
        page.request,
        `/api/patients/${original.patientId}/clinical-workflows`,
      )
    ).procedures.find((value) => value.id === procedure.id)!;
    expect(retained.appointmentId).toBe(original.id);
    expect(retained.effectiveAppointmentId).toBe(original.id);
    expect(retained.scheduledAppointment?.status).toBe('cancelled');
    for (const field of [
      'title',
      'indication',
      'benefits',
      'risks',
      'alternatives',
      'aftercare',
      'estimatedCost',
      'agreements',
      'completion',
    ] as const)
      expect(retained[field]).toEqual(procedure[field]);
    const notices = (
      await get<ActivityFeed>(portal.request, '/api/activity?limit=100')
    ).items.filter((value) => !activityBefore.items.some((before) => before.id === value.id));
    expect(notices).toHaveLength(1);
    expect(JSON.stringify(notices)).not.toContain('PRIVATE');
    expect(JSON.stringify(notices)).not.toContain(saved.receipt.requestId);
    await dialog.getByRole('button', { name: 'Close cancellation', exact: true }).click();
    await expect(portal.locator('.patient-selected-appointment')).toContainText('cancelled');
    await expect(
      portal
        .locator('.patient-selected-appointment')
        .getByRole('button', { name: 'Cancel', exact: true }),
    ).toHaveCount(0);
    const calendar = await portal.request.get(`${base(original.id)}/calendar`);
    expect(calendar.status()).toBe(200);
    expect(await calendar.text()).toContain('STATUS:CANCELLED');
    // The released room can be assigned to a new visit in the original interval.
    const replacement = await book(
      page.request,
      admin.headers,
      clinician.id,
      original.date,
      original.time,
    );
    expect(
      (await resources(page.request, admin.headers, replacement.id, allocated.resource.id))
        .resourceIds,
    ).toEqual([allocated.resource.id]);
  } finally {
    await own.close();
  }
});

test('patients can cancel scheduled visits displayed in the past, but a stale scheduled card cannot cancel a checked-in visit that reception may cancel', async ({
  page,
  browser,
  baseURL,
}) => {
  const admin = await login(page.request),
    clinician = await doctor(page.request, admin.headers);
  const all = await get<Appointment[]>(page.request, '/api/appointments');
  const checkedIn = all.find((value) => value.status === 'checked-in')!;
  expect(checkedIn).toBeTruthy();
  const email = `cancel-owner-${randomUUID()}@example.test`;
  await post(page.request, admin.headers, `/api/patients/${checkedIn.patientId}/portal-account`, {
    email,
    password: 'DemoClinic2026!',
    identityVerified: true,
  });
  const later = await book(
    page.request,
    admin.headers,
    clinician.id,
    future(45),
    '09:00',
    checkedIn.patientId,
  );
  const own = await browser.newContext({ baseURL }),
    reception = await browser.newContext({ baseURL });
  try {
    const portal = await own.newPage(),
      patient = await login(portal.request, email);
    await post(
      portal.request,
      patient.headers,
      '/api/auth/password',
      { currentPassword: 'DemoClinic2026!', newPassword: 'PersonalCancel2026!' },
      200,
    );
    // Simulate a previously loaded scheduled card; the current context must govern permission.
    await portal.route(`**/api/patients/${checkedIn.patientId}`, async (route) => {
      const response = await route.fetch(),
        record = (await response.json()) as PatientRecord;
      await route.fulfill({
        response,
        json: {
          ...record,
          appointments: record.appointments.map((value) =>
            value.id === checkedIn.id ? { ...value, status: 'scheduled' } : value,
          ),
        },
      });
    });
    const dialog = await openPatient(portal, checkedIn);
    await expect(
      dialog.getByRole('heading', { name: 'This visit cannot be cancelled here', exact: true }),
    ).toBeVisible();
    await expect(dialog.locator('.appointment-cancellation-source')).toContainText('checked in');
    await expect(
      dialog.getByRole('button', { name: 'Confirm cancellation', exact: true }),
    ).toHaveCount(0);
    const blocked = await get<AppointmentCancellationContext>(
      portal.request,
      `${base(checkedIn.id)}/cancellation-context`,
    );
    expect(blocked.canCancel).toBe(false);
    const denied = await portal.request.post(`${base(checkedIn.id)}/cancellations`, {
      headers: patient.headers,
      data: {
        expectedRevision: blocked.revision,
        cancellationConfirmed: true,
        requestId: randomUUID(),
      },
    });
    expect(denied.status()).toBe(409);
    expect(await denied.json()).toMatchObject({ cancellationOutcome: 'not-applied' });
    const foreign = all.find((value) => value.patientId !== checkedIn.patientId)!;
    expect((await portal.request.get(`${base(foreign.id)}/cancellation-context`)).status()).toBe(
      403,
    );
    await portal.unroute(`**/api/patients/${checkedIn.patientId}`);
    await dialog.getByRole('button', { name: 'Keep appointment', exact: true }).click();

    const desk = await reception.newPage();
    await login(desk.request, 'reception@derma.demo');
    const staffDialog = await openStaff(desk, checkedIn);
    await expect(staffDialog.locator('.appointment-cancellation-source')).toContainText(
      'checked in',
    );
    await staffDialog.getByLabel(staffAgreement, { exact: true }).check();
    const saved = (await (
      await confirm(desk, staffDialog, checkedIn.id)
    ).json()) as AppointmentCancellationResult;
    expect(saved.event.before.status).toBe('checked-in');
    expect(saved.appointment.status).toBe('cancelled');
    await expect(
      staffDialog.getByRole('heading', { name: 'Cancellation confirmed', exact: true }),
    ).toBeVisible();
    await staffDialog.getByRole('button', { name: 'Close cancellation', exact: true }).click();

    // Browser time is beyond this recorded visit. The patient card must keep cancellation,
    // while hiding the future-only reschedule/calendar controls. Server past-policy has API coverage.
    await portal.clock.setFixedTime(new Date(`${future(46)}T12:00:00+05:30`));
    await portal.goto(`/my-care?appointment=${later.id}`);
    const selected = portal.locator('.patient-selected-appointment');
    await expect(selected.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
    await expect(selected.getByRole('link', { name: 'Reschedule', exact: true })).toHaveCount(0);
    await expect(selected.getByRole('link', { name: 'Add to calendar', exact: true })).toHaveCount(
      0,
    );
    await selected.getByRole('button', { name: 'Cancel', exact: true }).click();
    await dialog.getByLabel(patientAgreement, { exact: true }).check();
    await confirm(portal, dialog, later.id);
    await expect(
      dialog.getByRole('heading', { name: 'Cancellation confirmed', exact: true }),
    ).toBeVisible();
    await dialog.getByRole('button', { name: 'Close cancellation', exact: true }).click();
    await expect(selected).toContainText('cancelled');
  } finally {
    await own.close();
    await reception.close();
  }
});

test('staff retain exact cancellation evidence through malformed and wrong-actor receipts, later errors and close/resume without duplicate effects', async ({
  page,
}, testInfo) => {
  const admin = await login(page.request),
    clinician = await doctor(page.request, admin.headers);
  const original = await book(page.request, admin.headers, clinician.id, future(55));
  const assigned = await room(page.request, admin.headers);
  await resources(page.request, admin.headers, original.id, assigned.resource.id);
  let dialog = await openStaff(page, original);
  await dialog.getByLabel(staffAgreement, { exact: true }).check();
  const attempts: AppointmentCancellationInput[] = [];
  let committed!: AppointmentCancellationResult;
  await page.route(`**${base(original.id)}/cancellations`, async (route) => {
    attempts.push(route.request().postDataJSON());
    if (attempts.length === 1) {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      committed = await response.json();
      await route.fulfill({
        status: 200,
        json: { ...committed, event: { ...committed.event, after: null } },
      });
    } else if (attempts.length === 2) {
      await route.fulfill({
        status: 400,
        json: { error: 'Synthetic later validation response must not discard the command.' },
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
        json: { error: 'This request ID was already used for a different cancellation command.' },
      });
    } else await route.continue();
  });
  await confirm(page, dialog, original.id, 200);
  await expect(
    dialog.getByRole('button', { name: 'Retry same request', exact: true }),
  ).toBeEnabled();
  await expect(dialog.getByLabel(staffAgreement, { exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Close for now', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Resume cancellation', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Cancel appointment', exact: true });
  // The appointment is already cancelled and absent from a future eligible context; resume
  // must still use the original retained command, not require a new cancellation review.
  expect(
    (
      await get<AppointmentCancellationContext>(
        page.request,
        `${base(original.id)}/cancellation-context`,
      )
    ).canCancel,
  ).toBe(false);
  for (const status of [400, 200, 409]) {
    await confirm(page, dialog, original.id, status, 'Retry same request');
    await expect(
      dialog.getByRole('button', { name: 'Retry same request', exact: true }),
    ).toBeEnabled();
    await expect(dialog.getByLabel(staffAgreement, { exact: true })).toBeDisabled();
  }
  const replay = (await (
    await confirm(page, dialog, original.id, 200, 'Retry same request')
  ).json()) as AppointmentCancellationResult;
  expect(replay).toEqual(committed);
  expect(attempts).toHaveLength(5);
  for (const attempt of attempts) expect(attempt).toEqual(attempts[0]);
  await expect(
    dialog.getByRole('heading', { name: 'Cancellation confirmed', exact: true }),
  ).toBeVisible();
  await expect(dialog.locator('.appointment-cancellation-current')).toContainText('cancelled');
  await dialog.locator('.appointment-cancellation-original summary').click();
  await expect(dialog.locator('.appointment-cancellation-original')).toContainText(
    'Before cancellation',
  );
  const retained = await get<AppointmentResourceContext>(
    page.request,
    `${base(original.id)}/resources`,
  );
  expect(retained.resourceIds).toEqual([]);
  expect(
    retained.history.filter(
      (event) =>
        event.source === 'appointment-status' && event.after.appointment.status === 'cancelled',
    ),
  ).toHaveLength(1);
  await dialog.locator('.appointment-cancellation-original summary').click();
  await audit(page);
  const closeButton = dialog.getByRole('button', { name: 'Close cancellation', exact: true });
  await closeButton.scrollIntoViewIfNeeded();
  await expect(closeButton).toBeInViewport();
  await expect(
    dialog.locator('.appointment-cancellation-current').getByText('cancelled', { exact: true }),
  ).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath('staff-cancellation-confirmed-mobile.png'),
    fullPage: false,
  });
  await dialog.getByRole('button', { name: 'Close cancellation', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: original.reason })).toContainText(
    'Cancelled',
  );
});

test('patient resumes an uncommitted cancellation and only an identity-matched durable rejection unlocks fresh review and a new request', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const admin = await login(page.request),
    clinician = await doctor(page.request, admin.headers);
  const original = await book(page.request, admin.headers, clinician.id, future(65));
  const own = await browser.newContext({ baseURL });
  try {
    const portal = await own.newPage(),
      patient = await login(portal.request, 'patient@derma.demo');
    let dialog = await openPatient(portal, original);
    await dialog.getByLabel(patientAgreement, { exact: true }).check();
    const attempts: AppointmentCancellationInput[] = [];
    await portal.route(`**${base(original.id)}/cancellations`, async (route) => {
      attempts.push(route.request().postDataJSON());
      if (attempts.length === 1) await route.abort('failed');
      else if (attempts.length === 2)
        await route.fulfill({
          status: 409,
          json: {
            error: 'A terminal rejection for another account must not unlock this request.',
            cancellationOutcome: 'not-applied',
            requestId: attempts[0].requestId,
            actorId: admin.session.user!.id,
            patientId: original.patientId,
            appointmentId: original.id,
          },
        });
      else await route.continue();
    });
    await dialog.getByRole('button', { name: 'Confirm cancellation', exact: true }).click();
    await expect(
      dialog.getByRole('button', { name: 'Retry same request', exact: true }),
    ).toBeEnabled();
    await audit(portal);
    const retryButton = dialog.getByRole('button', { name: 'Retry same request', exact: true });
    await retryButton.scrollIntoViewIfNeeded();
    await expect(retryButton).toBeInViewport();
    await expect(dialog.locator('.notice-warning')).toBeInViewport();
    await portal.screenshot({
      path: testInfo.outputPath('patient-cancellation-pending-mobile.png'),
      fullPage: false,
    });
    await dialog.getByRole('button', { name: 'Close for now', exact: true }).click();
    await expect(
      portal
        .locator('.patient-selected-appointment')
        .getByRole('button', { name: 'Cancel', exact: true }),
    ).toBeDisabled();
    await portal.getByRole('button', { name: 'Resume cancellation', exact: true }).click();
    dialog = portal.getByRole('dialog', { name: 'Cancel appointment', exact: true });
    const moved = await patch(page.request, admin.headers, original.id, {
      date: future(66),
      time: '10:00',
    });
    await confirm(portal, dialog, original.id, 409, 'Retry same request');
    await expect(
      dialog.getByRole('button', { name: 'Retry same request', exact: true }),
    ).toBeEnabled();
    await expect(dialog.getByLabel(patientAgreement, { exact: true })).toBeDisabled();
    const refused = await confirm(portal, dialog, original.id, 409, 'Retry same request');
    expect(await refused.json()).toMatchObject({
      cancellationOutcome: 'not-applied',
      requestId: attempts[0].requestId,
      actorId: patient.session.user!.id,
    });
    await expect(
      dialog.getByRole('button', { name: 'Retry same request', exact: true }),
    ).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Refresh current visit', exact: true }).click();
    await expect(dialog.getByLabel(patientAgreement, { exact: true })).toBeEnabled();
    await expect(dialog.getByLabel(patientAgreement, { exact: true })).not.toBeChecked();
    const current = await get<AppointmentCancellationContext>(
      portal.request,
      `${base(original.id)}/cancellation-context`,
    );
    expect(current.appointment).toEqual(moved);
    const rejectedReplay = await portal.request.post(`${base(original.id)}/cancellations`, {
      headers: patient.headers,
      data: attempts[0],
    });
    expect(rejectedReplay.status()).toBe(409);
    expect(await rejectedReplay.json()).toMatchObject({
      cancellationOutcome: 'not-applied',
      requestId: attempts[0].requestId,
    });
    await dialog.getByLabel(patientAgreement, { exact: true }).check();
    const saved = (await (
      await confirm(portal, dialog, original.id)
    ).json()) as AppointmentCancellationResult;
    expect(saved.event.before).toEqual(moved);
    expect(attempts.slice(0, 3)).toEqual([attempts[0], attempts[0], attempts[0]]);
    expect(attempts[3].requestId).not.toBe(attempts[0].requestId);
    expect(attempts[3].expectedRevision).toBe(current.revision);
    await expect(
      dialog.getByRole('heading', { name: 'Cancellation confirmed', exact: true }),
    ).toBeVisible();
    await dialog.getByRole('button', { name: 'Close cancellation', exact: true }).click();
    await expect(
      portal.getByRole('button', { name: 'Resume cancellation', exact: true }),
    ).toHaveCount(0);
    await expect(portal.locator('.patient-selected-appointment')).toContainText('cancelled');
  } finally {
    await own.close();
  }
});

test('source retry and native navigation isolate late cancellation replies and obsolete authorization errors, including returning to the same history entry', async ({
  page,
  browser,
  baseURL,
}) => {
  const admin = await login(page.request),
    clinician = await doctor(page.request, admin.headers);
  const original = await book(page.request, admin.headers, clinician.id, future(75));
  const another = await book(page.request, admin.headers, clinician.id, future(76));
  const own = await browser.newContext({ baseURL });
  try {
    const portal = await own.newPage(),
      patient = await login(portal.request, 'patient@derma.demo');
    const contextRoute = `**${base(original.id)}/cancellation-context`;
    let failRead = true;
    await portal.route(contextRoute, (route) =>
      failRead
        ? route.fulfill({
            status: 503,
            json: { error: 'Synthetic cancellation review is temporarily unavailable.' },
          })
        : route.continue(),
    );
    await portal.goto(`/my-care?appointment=${original.id}`);
    await portal
      .locator('.patient-selected-appointment')
      .getByRole('button', { name: 'Cancel', exact: true })
      .click();
    const dialog = portal.getByRole('dialog', { name: 'Cancel appointment', exact: true });
    await expect(
      dialog.getByText('Synthetic cancellation review is temporarily unavailable.', {
        exact: true,
      }),
    ).toBeVisible();
    failRead = false;
    await dialog.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(dialog.locator('.appointment-cancellation-source')).toBeVisible();
    await portal.unroute(contextRoute);
    await observeResponses(portal);

    const seen = deferred(),
      release = deferred();
    let saved!: AppointmentCancellationResult;
    await portal.route(`**${base(original.id)}/cancellations`, async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      saved = await response.json();
      seen.resolve();
      await release.promise;
      await route
        .fulfill({
          response,
          headers: { ...response.headers(), 'X-Test-Cancellation-Settled': 'committed-old-view' },
        })
        .catch(() => undefined);
    });
    await dialog.getByLabel(patientAgreement, { exact: true }).check();
    await dialog.getByRole('button', { name: 'Confirm cancellation', exact: true }).click();
    await seen.promise;
    await expect(dialog.getByRole('button', { name: 'Close for now', exact: true })).toBeDisabled();
    await navigate(portal, '/my-care/record?tab=visits');
    await expect(
      portal.getByRole('heading', { name: 'My health record', exact: true }),
    ).toBeVisible();
    await portal.goBack();
    await expect(portal.locator('.patient-selected-appointment')).toContainText('cancelled');
    const returnedUrl = portal.url();
    release.resolve();
    await consumed(portal, 'committed-old-view');
    await expect(portal).toHaveURL(returnedUrl);
    await expect(dialog).toHaveCount(0);
    await expect(
      portal.getByRole('heading', { name: 'Cancellation confirmed', exact: true }),
    ).toHaveCount(0);
    await expect(
      portal.getByRole('button', { name: 'Resume cancellation', exact: true }),
    ).toHaveCount(0);
    const replay = await post<AppointmentCancellationResult>(
      portal.request,
      patient.headers,
      `${base(original.id)}/cancellations`,
      {
        expectedRevision: saved.receipt.expectedRevision,
        cancellationConfirmed: true,
        requestId: saved.receipt.requestId,
      },
      200,
    );
    expect(replay).toEqual(saved);
    await portal.unroute(`**${base(original.id)}/cancellations`);

    const contextSeen = deferred(),
      contextRelease = deferred();
    await portal.route(`**${base(another.id)}/cancellation-context`, async (route) => {
      contextSeen.resolve();
      await contextRelease.promise;
      await route
        .fulfill({
          status: 401,
          json: { error: 'Obsolete cancellation review must not expire this session.' },
          headers: { 'X-Test-Cancellation-Settled': 'old-context-401' },
        })
        .catch(() => undefined);
    });
    await navigate(portal, `/my-care?appointment=${another.id}`);
    await portal
      .locator('.patient-selected-appointment')
      .getByRole('button', { name: 'Cancel', exact: true })
      .click();
    await contextSeen.promise;
    await navigate(portal, '/my-care/record?tab=visits');
    await expect(
      portal.getByRole('heading', { name: 'My health record', exact: true }),
    ).toBeVisible();
    contextRelease.resolve();
    await consumed(portal, 'old-context-401');
    await expect(portal).toHaveURL(/\/my-care\/record\?tab=visits$/);
    expect(
      await portal.evaluate(
        () => (window as Window & { cancellationExpired?: number }).cancellationExpired,
      ),
    ).toBe(0);
    await expect(
      portal.getByText('Obsolete cancellation review must not expire this session.', {
        exact: true,
      }),
    ).toHaveCount(0);
    await portal.unroute(`**${base(another.id)}/cancellation-context`);
    await portal.goBack();
    await expect(portal.locator('.patient-selected-appointment')).toContainText(another.doctorName);
    await expect(dialog).toHaveCount(0);

    // The enclosing patient record read is also navigation-bound, not just modal requests.
    const recordSeen = deferred(),
      recordRelease = deferred();
    await portal.route(`**/api/patients/${original.patientId}`, async (route) => {
      recordSeen.resolve();
      await recordRelease.promise;
      await route
        .fulfill({
          status: 401,
          json: { error: 'Obsolete care-record response must not expire this session.' },
          headers: { 'X-Test-Cancellation-Settled': 'old-record-401' },
        })
        .catch(() => undefined);
    });
    await navigate(portal, `/my-care?appointment=${original.id}`);
    await recordSeen.promise;
    await navigate(portal, '/account');
    await expect(
      portal.getByRole('heading', { name: 'Your account & security', exact: true }),
    ).toBeVisible();
    recordRelease.resolve();
    await consumed(portal, 'old-record-401');
    expect(
      await portal.evaluate(
        () => (window as Window & { cancellationExpired?: number }).cancellationExpired,
      ),
    ).toBe(0);
    await expect(portal).toHaveURL(/\/account$/);
    expect((await get<Session>(portal.request, '/api/session')).user?.id).toBe(
      patient.session.user!.id,
    );
  } finally {
    await own.close();
  }
});
