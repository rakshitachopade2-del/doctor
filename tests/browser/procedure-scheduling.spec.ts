import {
  test,
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
  type Route,
} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import type { Appointment, Doctor, Session } from '../../shared/types';
import type { PatientClinicalWorkflows, ProcedureRecord } from '../../shared/clinical';
import type { CareSummary } from '../../shared/care-summary';
import type {
  ProcedureCandidatePage,
  ProcedureScheduleContext,
  ProcedureScheduleMutation,
  ProcedureSchedulePage,
} from '../../shared/procedure-scheduling';
import type { AppointmentResourceContext, ResourceDetail } from '../../shared/clinic-resources';
import type { Invoice } from '../../shared/operations';

const day = (offset: number) => {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return new Date(Date.parse(`${today}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
};
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
async function post<T>(
  request: APIRequestContext,
  headers: Record<string, string>,
  path: string,
  data: unknown,
  status = 201,
): Promise<T> {
  const response = await request.post(path, { headers, data });
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}
async function doctor(request: APIRequestContext, headers: Record<string, string>) {
  const value = await post<Doctor>(request, headers, '/api/doctors', {
    name: `Dr. Procedure ${randomUUID().slice(0, 8)}`,
    title: 'Dermatologist',
    qualifications: 'Synthetic profile',
    specialties: ['General dermatology'],
    experience: 5,
    fee: 600,
    bio: 'Synthetic procedure scheduling verification.',
    languages: ['English'],
  });
  const schedule = await request.put(`/api/schedules/${value.id}`, {
    headers,
    data: {
      durationMinutes: 30,
      windows: Array.from({ length: 7 }, (_, weekday) => ({
        day: weekday,
        start: '08:00',
        end: '18:00',
        mode: 'both',
      })),
    },
  });
  expect(schedule.ok(), await schedule.text()).toBeTruthy();
  return value;
}
async function patient(request: APIRequestContext, headers: Record<string, string>) {
  return post<{ id: string; name: string }>(request, headers, '/api/patients', {
    name: `Procedure Patient ${randomUUID().slice(0, 8)}`,
    email: '',
    phone: '+91 9000000241',
    dob: '',
    gender: 'Not specified',
  });
}
async function book(
  request: APIRequestContext,
  headers: Record<string, string>,
  doctorId: string,
  patientId: string,
  date: string,
  time: string,
  durationMinutes?: number,
) {
  const data = {
    doctorId,
    patientId,
    date,
    time,
    mode: 'in-person',
    reason: `PRIVATE appointment reason ${randomUUID()}`,
  };
  return durationMinutes
    ? (
        await post<{ appointment: Appointment }>(request, headers, '/api/visit-duration/bookings', {
          ...data,
          durationMinutes,
          requestId: randomUUID(),
        })
      ).appointment
    : post<Appointment>(request, headers, '/api/appointments', data);
}
async function plan(
  request: APIRequestContext,
  headers: Record<string, string>,
  title: string,
  patientId = 'patient-ananya',
  appointmentId: string | null = null,
) {
  return post<ProcedureRecord>(request, headers, '/api/procedures', {
    patientId,
    appointmentId,
    title,
    indication: `CLINICAL indication ${title}`,
    benefits: `CLINICAL benefits ${title}`,
    risks: `CLINICAL risks ${title}`,
    alternatives: `CLINICAL alternatives ${title}`,
    aftercare: `CLINICAL aftercare ${title}`,
    estimatedCost: 'Discuss charges with the clinic.',
  });
}
const scheduling = (request: APIRequestContext, id: string) =>
  get<ProcedureScheduleContext>(request, `/api/procedures/${id}/scheduling`);
async function assign(
  request: APIRequestContext,
  headers: Record<string, string>,
  id: string,
  appointment: Appointment | null,
  reason: string,
) {
  const source = await scheduling(request, id);
  const target = appointment
    ? (
        await get<ProcedureCandidatePage>(
          request,
          `/api/procedures/${id}/scheduling/candidates?from=${appointment.date}&to=${appointment.date}`,
        )
      ).items.find((item) => item.appointment.id === appointment.id)
    : null;
  if (appointment) expect(target).toBeTruthy();
  return post<ProcedureScheduleMutation>(
    request,
    headers,
    `/api/procedures/${id}/scheduling`,
    {
      appointmentId: appointment?.id ?? null,
      expectedAppointmentRevision: target?.revision ?? null,
      expectedRevision: source.revision,
      requestId: randomUUID(),
      reason,
      ...(!appointment ? { removeConfirmed: true } : {}),
    },
    200,
  );
}
async function agreed(request: APIRequestContext, headers: Record<string, string>, id: string) {
  return post<ProcedureRecord>(request, headers, `/api/procedures/${id}/agreements`, {
    decision: 'agreed',
    method: 'in-person',
    patientDecisionConfirmed: true,
    note: 'CLINICAL discussion recorded separately from scheduling.',
  });
}
function modal(page: Page) {
  return page.getByRole('dialog', { name: 'Procedure appointment', exact: true });
}
async function choose(dialog: Locator, appointment: Appointment) {
  await dialog
    .getByRole('radio', {
      name: `Select appointment ${appointment.date} at ${appointment.time} with ${appointment.doctorName}`,
      exact: true,
    })
    .check();
}
async function save(page: Page, id: string, label: string) {
  const response = page.waitForResponse(
    (value) =>
      new URL(value.url()).pathname === `/api/procedures/${id}/scheduling` &&
      value.request().method() === 'POST',
  );
  await modal(page).getByRole('button', { name: label, exact: true }).click();
  const value = await response;
  expect(value.status(), await value.text()).toBe(200);
  return value.json() as Promise<ProcedureScheduleMutation>;
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
function patientCard(page: Page, title: string) {
  return page
    .locator('.patient-procedure-card')
    .filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}
function summaryCard(page: Page, title: string) {
  return page
    .locator('.care-summary-entry')
    .filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

test('reception replaces and removes procedure links without changing visits, resources, decisions or invoices; patients see the effective visit', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(150000);
  const admin = await browser.newContext({ baseURL });
  const own = await browser.newContext({ baseURL });
  try {
    const { headers } = await login(admin.request);
    const { headers: receptionHeaders } = await login(page.request, 'reception@derma.demo');
    const { headers: ownHeaders } = await login(own.request, 'patient@derma.demo');
    const clinician = await doctor(admin.request, headers);
    const original = await book(
      admin.request,
      headers,
      clinician.id,
      'patient-ananya',
      day(70),
      '09:00',
      60,
    );
    const replacement = await book(
      admin.request,
      headers,
      clinician.id,
      'patient-ananya',
      day(70),
      '11:00',
      90,
    );
    const title = `Procedure link journey ${randomUUID().slice(0, 8)}`;
    const created = await plan(admin.request, headers, title, 'patient-ananya', original.id);
    const withDecision = await agreed(admin.request, headers, created.id);
    const invoice = await post<Invoice>(admin.request, headers, '/api/invoices', {
      patientId: 'patient-ananya',
      procedureId: created.id,
      items: [{ description: title, quantity: 1, unitAmountPaise: 125000 }],
      requestId: randomUUID(),
    });
    const room = await post<ResourceDetail>(admin.request, headers, '/api/clinic-resources', {
      name: `Procedure room ${randomUUID().slice(0, 8)}`,
      kind: 'room',
      location: 'Synthetic room',
      requestId: randomUUID(),
    });
    const resourceSource = await get<AppointmentResourceContext>(
      admin.request,
      `/api/appointments/${original.id}/resources`,
    );
    const reservedResponse = await admin.request.put(`/api/appointments/${original.id}/resources`, {
      headers,
      data: {
        resourceIds: [room.resource.id],
        reason: 'PRIVATE room allocation retained independently.',
        expectedRevision: resourceSource.revision,
        requestId: randomUUID(),
      },
    });
    expect(reservedResponse.status()).toBe(200);
    const reserved = await reservedResponse.json();
    const before = await get<CareSummary>(own.request, '/api/patients/patient-ananya/care-summary');
    await page.goto(`/clinic/procedures?procedure=${created.id}`);
    const dialog = modal(page);
    await expect(dialog.locator('.procedure-link-current')).toContainText('9:00 AM–10:00 AM IST');
    await expect(dialog).not.toContainText(`CLINICAL indication ${title}`);
    expect(
      (await page.request.get('/api/patients/patient-ananya/clinical-workflows')).status(),
    ).toBe(403);
    const operational = await scheduling(page.request, created.id);
    expect(JSON.stringify(operational)).not.toContain('CLINICAL');
    for (const field of [
      'indication',
      'benefits',
      'risks',
      'alternatives',
      'aftercare',
      'agreements',
      'completion',
    ])
      expect(operational.procedure).not.toHaveProperty(field);
    await dialog.getByRole('button', { name: 'Link a booked visit', exact: true }).click();
    await choose(dialog, replacement);
    const replaceReason = `PRIVATE reassignment reason ${randomUUID()}`;
    await dialog.getByLabel('Reason for appointment link', { exact: true }).fill(replaceReason);
    const replaced = await save(page, created.id, 'Replace appointment');
    expect(replaced.event).toMatchObject({
      operation: 'replace',
      beforeAppointmentId: original.id,
      afterAppointmentId: replacement.id,
      reason: replaceReason,
    });
    await expect(dialog.locator('.procedure-link-current')).toContainText('11:00');
    await expect(dialog.locator('.procedure-link-history')).toContainText(replaceReason);
    const patientPage = await own.newPage();
    await patientPage.goto('/my-care/record?tab=workflows');
    const card = patientCard(patientPage, title);
    await expect(card.locator('.patient-procedure-visit')).toContainText(
      '11:00–12:30 IST · 90 minutes',
    );
    await expect(card).not.toContainText(replaceReason);
    await card.getByRole('button', { name: 'Update my decision', exact: true }).click();
    await expect(patientPage.getByRole('dialog').locator('.patient-procedure-visit')).toContainText(
      '11:00–12:30',
    );
    await patientPage
      .getByRole('dialog')
      .getByRole('button', { name: 'Close dialog', exact: true })
      .click();
    expect((await own.request.get(`/api/procedures/${created.id}/scheduling`)).status()).toBe(403);
    expect((await own.request.get('/api/procedure-scheduling')).status()).toBe(403);
    expect(
      (
        await own.request.post(`/api/procedures/${created.id}/scheduling`, {
          headers: ownHeaders,
          data: {
            appointmentId: null,
            expectedAppointmentRevision: null,
            expectedRevision: replaced.context.revision,
            requestId: randomUUID(),
            reason: 'Patient cannot change procedure associations.',
            removeConfirmed: true,
          },
        })
      ).status(),
    ).toBe(403);
    expect(
      (await own.request.get(`/api/procedures/${created.id}/scheduling/candidates`)).status(),
    ).toBe(403);
    expect(
      (
        await own.request.get(
          `/api/patients/patient-ananya/care-summary/download?revision=${before.revision}`,
        )
      ).status(),
    ).toBe(409);
    await patientPage.goto('/my-care/summary');
    await expect(
      summaryCard(patientPage, title).locator('.care-summary-procedure-visit'),
    ).toContainText('11:00–12:30');
    await dialog.getByRole('button', { name: 'Remove current link', exact: true }).click();
    await dialog
      .getByLabel('Reason for appointment link', { exact: true })
      .fill('PRIVATE remove only association.');
    await expect(dialog.getByRole('button', { name: 'Remove link', exact: true })).toBeDisabled();
    await dialog
      .getByLabel(
        'I confirm this only removes the procedure link and leaves the appointment booked',
        { exact: true },
      )
      .check();
    const removed = await save(page, created.id, 'Remove link');
    expect(removed.context.procedure.effectiveAppointmentId).toBeNull();
    expect(removed.context.procedure.originalAppointmentId).toBe(original.id);
    await patientPage.goto('/my-care/record?tab=workflows');
    await expect(
      patientCard(patientPage, title).getByText(
        'No appointment is currently linked to this procedure.',
        { exact: true },
      ),
    ).toBeVisible();
    const ownWorkflows = await get<PatientClinicalWorkflows>(
      own.request,
      '/api/patients/patient-ananya/clinical-workflows',
    );
    const current = ownWorkflows.procedures.find((entry) => entry.id === created.id)!;
    expect(current).toMatchObject({
      appointmentId: original.id,
      effectiveAppointmentId: null,
      scheduledAppointment: null,
      status: 'planned',
    });
    expect(current.agreements).toEqual(withDecision.agreements);
    expect(JSON.stringify(current)).not.toContain('PRIVATE');
    expect(current).not.toHaveProperty('history');
    expect(current).not.toHaveProperty('revision');
    const appointments = await get<Appointment[]>(admin.request, '/api/appointments');
    expect(appointments.find((entry) => entry.id === original.id)).toEqual(original);
    expect(appointments.find((entry) => entry.id === replacement.id)).toEqual(replacement);
    expect(await get(admin.request, `/api/appointments/${original.id}/resources`)).toEqual(
      reserved,
    );
    expect(
      (await get<{ invoice: Invoice }>(admin.request, `/api/invoices/${invoice.id}`)).invoice,
    ).toEqual(invoice);
    await assign(
      page.request,
      receptionHeaders,
      created.id,
      replacement,
      'PRIVATE reconnect booked visit.',
    );
    const cancelled = await admin.request.patch(`/api/appointments/${replacement.id}`, {
      headers,
      data: { status: 'cancelled' },
    });
    expect(cancelled.status()).toBe(200);
    await patientPage.reload();
    await expect(patientCard(patientPage, title).locator('.patient-procedure-visit')).toContainText(
      'Appointment status: cancelled',
    );
    await expect(patientCard(patientPage, title)).toContainText(
      'Contact the clinic to confirm the visit for this planned procedure.',
    );
    await expect(
      patientCard(patientPage, title).getByRole('button', {
        name: 'Update my decision',
        exact: true,
      }),
    ).toBeVisible();
    await patientPage.setViewportSize({ width: 320, height: 900 });
    await audit(patientPage);
    await patientPage.screenshot({
      path: testInfo.outputPath('patient-procedure-link-mobile.png'),
      fullPage: true,
    });
  } finally {
    await admin.close();
    await own.close();
  }
});

test('procedure assignment keeps stale drafts and retries uncertain saves against the original receipt even after current state advances', async ({
  page,
}, testInfo) => {
  test.setTimeout(120000);
  const { headers } = await login(page.request);
  const clinician = await doctor(page.request, headers);
  const owner = await patient(page.request, headers);
  const first = await book(page.request, headers, clinician.id, owner.id, day(75), '09:00');
  const second = await book(page.request, headers, clinician.id, owner.id, day(75), '11:00');
  const created = await plan(
    page.request,
    headers,
    `Retry procedure ${randomUUID().slice(0, 8)}`,
    owner.id,
  );
  await page.goto(`/clinic/procedures?procedure=${created.id}`);
  const dialog = modal(page);
  await dialog.getByRole('button', { name: 'Link a booked visit', exact: true }).click();
  await choose(dialog, first);
  const reason = `PRIVATE retained scheduling draft ${randomUUID()}`;
  await dialog.getByLabel('Reason for appointment link', { exact: true }).fill(reason);
  await assign(page.request, headers, created.id, second, 'PRIVATE concurrent source change.');
  const conflict = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/procedures/${created.id}/scheduling` &&
      response.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Link appointment', exact: true }).click();
  expect((await conflict).status()).toBe(409);
  await expect(dialog.getByLabel('Reason for appointment link', { exact: true })).toHaveValue(
    reason,
  );
  await dialog.getByRole('button', { name: 'Refresh latest scheduling', exact: true }).click();
  await expect(dialog).toContainText('PRIVATE concurrent source change.');
  await dialog
    .getByRole('button', { name: 'I reviewed the latest scheduling; keep my draft', exact: true })
    .click();
  await choose(dialog, first);
  const moved = await page.request.patch(`/api/appointments/${first.id}`, {
    headers,
    data: { time: '14:00' },
  });
  expect(moved.status(), await moved.text()).toBe(200);
  const updated = (await moved.json()) as Appointment;
  const targetConflict = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/procedures/${created.id}/scheduling` &&
      response.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Replace appointment', exact: true }).click();
  expect((await targetConflict).status()).toBe(409);
  await dialog.getByRole('button', { name: 'Refresh latest scheduling', exact: true }).click();
  await dialog
    .getByRole('button', { name: 'I reviewed the latest scheduling; keep my draft', exact: true })
    .click();
  await expect(
    dialog.getByRole('radio', {
      name: `Select appointment ${first.date} at 09:00 with ${first.doctorName}`,
      exact: true,
    }),
  ).toHaveCount(0);
  await choose(dialog, updated);
  await expect(dialog.getByLabel('Reason for appointment link', { exact: true })).toHaveValue(
    reason,
  );
  const path = `/api/procedures/${created.id}/scheduling`;
  let attempt: unknown;
  let originalReceipt: ProcedureScheduleMutation | undefined;
  const lost = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.continue();
    attempt = route.request().postDataJSON();
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    originalReceipt = await response.json();
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Synthetic lost save response.' }),
    });
  };
  await page.route(`**${path}`, lost);
  await dialog.getByRole('button', { name: 'Replace appointment', exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: 'Retry same request', exact: true }),
  ).toBeVisible();
  await expect(dialog.getByLabel('Reason for appointment link', { exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(dialog).toBeVisible();
  await page.unroute(`**${path}`, lost);
  await assign(page.request, headers, created.id, null, 'PRIVATE later unlink before exact retry.');
  const retryResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === path && response.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Retry same request', exact: true }).click();
  const replay = await retryResponse;
  expect(replay.status()).toBe(200);
  expect(replay.request().postDataJSON()).toEqual(attempt);
  const replayed = (await replay.json()) as ProcedureScheduleMutation;
  expect(replayed.event).toEqual(originalReceipt!.event);
  expect(replayed.context.procedure.effectiveAppointmentId).toBeNull();
  expect(replayed.context.history).toHaveLength(3);
  await expect(dialog.locator('.procedure-link-current')).toContainText(/No appointment/i);
  await dialog.getByRole('button', { name: 'Link a booked visit', exact: true }).click();
  await choose(dialog, second);
  await dialog
    .getByLabel('Reason for appointment link', { exact: true })
    .fill('PRIVATE malformed attributed receipt.');
  let malformedAttempt: unknown;
  let committed: ProcedureScheduleMutation | undefined;
  const malformed = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.continue();
    malformedAttempt = route.request().postDataJSON();
    const response = await route.fetch();
    committed = await response.json();
    await route.fulfill({
      response,
      json: { ...committed, event: { ...committed!.event, createdById: 'different-account' } },
    });
  };
  await page.route(`**${path}`, malformed);
  await dialog.getByRole('button', { name: 'Link appointment', exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: 'Retry same request', exact: true }),
  ).toBeVisible();
  await expect(dialog.getByLabel('Reason for appointment link', { exact: true })).toBeDisabled();
  await page.unroute(`**${path}`, malformed);
  const validResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === path && response.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Retry same request', exact: true }).click();
  const valid = await validResponse;
  expect(valid.status()).toBe(200);
  expect(valid.request().postDataJSON()).toEqual(malformedAttempt);
  expect(((await valid.json()) as ProcedureScheduleMutation).event).toEqual(committed!.event);
  await expect(dialog.locator('.procedure-link-current')).toContainText('11:00');
  expect((await scheduling(page.request, created.id)).history).toHaveLength(4);
  await page.setViewportSize({ width: 320, height: 900 });
  await audit(page);
  await page.screenshot({
    path: testInfo.outputPath('procedure-assignment-history-mobile.png'),
    fullPage: true,
  });
});

test('procedure worklists and candidates page through existing visits while terminal histories and completion snapshots remain readable', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(180000);
  const { headers } = await login(page.request);
  const own = await browser.newContext({ baseURL });
  try {
    await login(own.request, 'patient@derma.demo');
    const clinician = await doctor(page.request, headers);
    const owner = await patient(page.request, headers);
    const marker = `Paged procedure ${randomUUID().slice(0, 8)}`;
    const plans: ProcedureRecord[] = [];
    const visits: Appointment[] = [];
    for (let index = 0; index < 26; index++) {
      plans.push(
        await plan(page.request, headers, `${marker} ${String(index).padStart(2, '0')}`, owner.id),
      );
      visits.push(
        await book(page.request, headers, clinician.id, owner.id, day(100 + index), '09:00'),
      );
    }
    await page.goto('/clinic/procedures');
    await page.getByLabel('Search procedure appointments', { exact: true }).fill(marker);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.locator('.procedure-schedule-row')).toHaveCount(25);
    const pagination = page.getByRole('navigation', {
      name: 'Procedure appointments pagination',
      exact: true,
    });
    await pagination.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(page.locator('.procedure-schedule-row')).toHaveCount(1);
    await page.goBack();
    await expect(page.locator('.procedure-schedule-row')).toHaveCount(25);
    // Exact records remain available even when the active worklist filters exclude them.
    await page.goto(`/clinic/procedures?search=non-matching&procedure=${plans[0].id}`);
    const dialog = modal(page);
    await expect(dialog).toContainText(plans[0].title);
    await dialog.getByRole('button', { name: 'Link a booked visit', exact: true }).click();
    await expect(dialog.locator('.procedure-candidate')).toHaveCount(25);
    await dialog
      .getByRole('navigation', { name: 'Procedure appointment candidates', exact: true })
      .getByRole('button', { name: 'Next page', exact: true })
      .click();
    await expect(dialog.locator('.procedure-candidate')).toHaveCount(1);
    await dialog.getByLabel('Appointments from', { exact: true }).fill(visits[25].date);
    await dialog.getByLabel('Appointments to', { exact: true }).fill(visits[25].date);
    await dialog.getByRole('button', { name: 'Apply appointment dates', exact: true }).click();
    await expect(
      dialog
        .getByRole('navigation', { name: 'Procedure appointment candidates', exact: true })
        .getByRole('button', { name: 'Previous page', exact: true }),
    ).toBeDisabled();
    await expect(dialog.locator('.procedure-candidate')).toHaveCount(1);
    await choose(dialog, visits[25]);
    await dialog
      .getByLabel('Reason for appointment link', { exact: true })
      .fill('PRIVATE paged candidate selection.');
    await save(page, plans[0].id, 'Link appointment');
    const cancelledVisit = await page.request.patch(`/api/appointments/${visits[25].id}`, {
      headers,
      data: { status: 'cancelled' },
    });
    expect(cancelledVisit.status()).toBe(200);
    await page.goto(`/clinic/procedures?search=${encodeURIComponent(marker)}&booking=attention`);
    await expect(page.locator('.procedure-schedule-row')).toHaveCount(1);
    await expect(page.locator('.procedure-schedule-row')).toContainText(plans[0].title);
    expect(
      (
        await get<ProcedureSchedulePage>(
          page.request,
          `/api/procedure-scheduling?search=${encodeURIComponent(marker)}&booking=unlinked`,
        )
      ).total,
    ).toBe(25);
    await post(
      page.request,
      headers,
      `/api/procedures/${plans[0].id}/cancel`,
      { reason: 'Clinical plan cancelled independently of its appointment.' },
      200,
    );
    await page.goto(`/clinic/procedures?procedure=${plans[0].id}`);
    await expect(modal(page).locator('.procedure-link-history')).toContainText(
      'PRIVATE paged candidate selection.',
    );
    await expect(
      modal(page).getByRole('button', { name: 'Link a booked visit', exact: true }),
    ).toHaveCount(0);
    await expect(
      modal(page).getByRole('button', { name: 'Remove current link', exact: true }),
    ).toHaveCount(0);
    const earlier = (await get<Appointment[]>(page.request, '/api/appointments')).find(
      (entry) =>
        entry.patientId === 'patient-ananya' && entry.status === 'completed' && entry.date < day(0),
    )!;
    expect(earlier).toBeTruthy();
    const completedPlan = await plan(
      page.request,
      headers,
      `Completed snapshot ${marker}`,
      'patient-ananya',
      earlier.id,
    );
    await agreed(page.request, headers, completedPlan.id);
    const completed = await post<ProcedureRecord>(
      page.request,
      headers,
      `/api/procedures/${completedPlan.id}/complete`,
      {
        outcome: 'Recorded synthetic completion.',
        aftercare: 'Patient-shared completion instructions.',
      },
      200,
    );
    expect(completed.completion?.appointment).toMatchObject({
      id: earlier.id,
      date: earlier.date,
      time: earlier.time,
      durationMinutes: earlier.durationMinutes ?? 30,
    });
    expect(completed.completion?.appointment).not.toHaveProperty('reason');
    expect(completed.completion?.appointment).not.toHaveProperty('fee');
    const futureVisit = await book(
      page.request,
      headers,
      clinician.id,
      'patient-ananya',
      day(90),
      '15:00',
    );
    const unlinkedPlan = await plan(
      page.request,
      headers,
      `Unlinked completion ${marker}`,
      'patient-ananya',
      futureVisit.id,
    );
    await agreed(page.request, headers, unlinkedPlan.id);
    expect(
      (
        await page.request.post(`/api/procedures/${unlinkedPlan.id}/complete`, {
          headers,
          data: { outcome: 'Too early.', aftercare: 'Too early.' },
        })
      ).status(),
    ).toBe(409);
    await assign(
      page.request,
      headers,
      unlinkedPlan.id,
      null,
      'PRIVATE original future appointment removed.',
    );
    const unlinkedCompletion = await post<ProcedureRecord>(
      page.request,
      headers,
      `/api/procedures/${unlinkedPlan.id}/complete`,
      {
        outcome: 'Unlinked documentation remains supported.',
        aftercare: 'Patient-shared unlinked aftercare.',
      },
      200,
    );
    expect(unlinkedCompletion.appointmentId).toBe(futureVisit.id);
    expect(unlinkedCompletion.effectiveAppointmentId).toBeNull();
    expect(unlinkedCompletion.completion?.appointment).toBeNull();
    const patientPage = await own.newPage();
    await patientPage.goto('/my-care/record?tab=workflows');
    const completedCard = patientCard(patientPage, completedPlan.title);
    await expect(
      completedCard.getByRole('heading', { name: 'Visit recorded at completion', exact: true }),
    ).toBeVisible();
    await expect(
      completedCard.locator('.patient-published-review .patient-procedure-visit'),
    ).toContainText(earlier.doctorName);
    await expect(patientCard(patientPage, unlinkedPlan.title)).toContainText(
      'No appointment was linked when completion was recorded.',
    );
    await expect(
      patientCard(patientPage, unlinkedPlan.title).getByRole('button', {
        name: 'Update my decision',
        exact: true,
      }),
    ).toHaveCount(0);
    await patientPage.goto('/my-care/summary');
    await expect(
      summaryCard(patientPage, completedPlan.title).getByRole('heading', {
        name: 'Visit recorded at completion',
        exact: true,
      }),
    ).toBeVisible();
    await expect(summaryCard(patientPage, unlinkedPlan.title)).toContainText(
      'No appointment was linked when completion was recorded.',
    );
    const summary = await get<CareSummary>(
      own.request,
      '/api/patients/patient-ananya/care-summary',
    );
    expect(JSON.stringify(summary.procedures)).not.toContain(
      'PRIVATE original future appointment removed.',
    );
    expect(
      summary.procedures.find((entry) => entry.id === unlinkedPlan.id)?.completion?.appointment,
    ).toBeNull();
    await patientPage.setViewportSize({ width: 320, height: 900 });
    await audit(patientPage);
    await patientPage.screenshot({
      path: testInfo.outputPath('procedure-completion-summary-mobile.png'),
      fullPage: true,
    });
  } finally {
    await own.close();
  }
});
