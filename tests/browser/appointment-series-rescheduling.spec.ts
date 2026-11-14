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
import type {
  AppointmentSeriesDetail,
  AppointmentSeriesInput,
  AppointmentSeriesPreview,
} from '../../shared/appointment-series';
import type {
  SeriesRescheduleContext,
  SeriesRescheduleInput,
  SeriesReschedulePage,
  SeriesReschedulePreview,
  SeriesRescheduleResult,
} from '../../shared/appointment-series-rescheduling';
import type { VisitDurationContext, VisitDurationMutation } from '../../shared/visit-duration';
import type { AppointmentResourceContext, ResourceDetail } from '../../shared/clinic-resources';
import type { PatientClinicalWorkflows, ProcedureRecord } from '../../shared/clinical';
import type { Invoice } from '../../shared/operations';
import type { ActivityFeed } from '../../shared/activity';
import type { CareSummary } from '../../shared/care-summary';

const agreement = 'I confirmed these exact appointment changes with the patient.';
const day = (offset: number) => {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return new Date(Date.parse(`${today}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
};
const nextDay = (date: string) =>
  new Date(Date.parse(`${date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
const endpoint = (id: string) => `/api/appointment-series/${id}/reschedules`;
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
  status = 201,
): Promise<T> {
  const response = await request.post(path, { headers, data });
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}
async function changeAppointment(
  request: APIRequestContext,
  headers: Record<string, string>,
  id: string,
  data: unknown,
): Promise<Appointment> {
  const response = await request.patch(`/api/appointments/${id}`, { headers, data });
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}
async function schedule(
  request: APIRequestContext,
  headers: Record<string, string>,
  id: string,
  durationMinutes: number,
) {
  const response = await request.put(`/api/schedules/${id}`, {
    headers,
    data: {
      durationMinutes,
      windows: Array.from({ length: 7 }, (_, weekday) => ({
        day: weekday,
        start: '08:00',
        end: '18:00',
        mode: 'both',
      })),
    },
  });
  expect(response.status(), await response.text()).toBe(200);
}
async function createDoctor(request: APIRequestContext, headers: Record<string, string>) {
  const doctor = await post<Doctor>(request, headers, '/api/doctors', {
    name: `Dr. Reschedule ${randomUUID().slice(0, 8)}`,
    title: 'Dermatologist',
    qualifications: 'Synthetic profile',
    specialties: ['General dermatology'],
    experience: 5,
    fee: 600,
    bio: 'Synthetic rescheduling verification.',
    languages: ['English'],
  });
  await schedule(request, headers, doctor.id, 20);
  return doctor;
}
async function createPatient(request: APIRequestContext, headers: Record<string, string>) {
  return post<{ id: string }>(request, headers, '/api/patients', {
    name: `Rescheduling patient ${randomUUID().slice(0, 8)}`,
    email: '',
    phone: '9000000251',
    dob: '',
    gender: 'Not recorded',
  });
}
async function fixtures(
  request: APIRequestContext,
  headers: Record<string, string>,
  count = 3,
  own = false,
) {
  const doctor = await createDoctor(request, headers),
    patient = own ? { id: 'patient-ananya' } : await createPatient(request, headers);
  const input: AppointmentSeriesInput = {
    patientId: patient.id,
    doctorId: doctor.id,
    mode: 'in-person',
    reason: 'Shared synthetic series visit',
    firstDate: day(42),
    time: '09:00',
    count,
    intervalWeeks: 1,
    durationPolicy: 'schedule',
  };
  const source = await post<AppointmentSeriesPreview>(
    request,
    headers,
    '/api/appointment-series/preview',
    input,
    200,
  );
  expect(source.canBook).toBe(true);
  const detail = await post<AppointmentSeriesDetail>(request, headers, '/api/appointment-series', {
    input,
    expectedRevision: source.revision,
    patientConfirmed: true,
    privateNote: 'PRIVATE original series reason',
    requestId: randomUUID(),
  });
  return { doctor, patient, detail };
}
async function resource(
  request: APIRequestContext,
  headers: Record<string, string>,
  kind: 'room' | 'equipment' = 'room',
) {
  return post<ResourceDetail>(request, headers, '/api/clinic-resources', {
    name: `Reschedule ${kind} ${randomUUID().slice(0, 8)}`,
    kind,
    location: 'Synthetic clinic area',
    notes: 'PRIVATE resource notes',
    requestId: randomUUID(),
  });
}
async function allocate(
  request: APIRequestContext,
  headers: Record<string, string>,
  id: string,
  ids: string[],
) {
  const current = await get<AppointmentResourceContext>(
    request,
    `/api/appointments/${id}/resources`,
  );
  const response = await request.put(`/api/appointments/${id}/resources`, {
    headers,
    data: {
      resourceIds: ids,
      reason: 'PRIVATE resource assignment',
      expectedRevision: current.revision,
      requestId: randomUUID(),
    },
  });
  expect(response.status(), await response.text()).toBe(200);
  return response.json() as Promise<AppointmentResourceContext>;
}
const chooseVisit = (dialog: Locator, position: number) =>
  dialog.getByRole('checkbox', { name: new RegExp(`^Select visit ${position} ·`) });
async function targets(dialog: Locator, position: number, date: string, time: string) {
  await dialog.getByLabel(`New date for visit ${position}`, { exact: true }).fill(date);
  await dialog.getByLabel(`New time for visit ${position} · IST`, { exact: true }).fill(time);
}
async function open(page: Page) {
  await page.getByRole('button', { name: 'Reschedule visits together', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Reschedule visits together', exact: true });
  await expect(dialog.getByLabel('Internal rescheduling reason', { exact: true })).toBeEnabled();
  return dialog;
}
async function preview(page: Page, dialog: Locator, id: string) {
  const waiting = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `${endpoint(id)}/preview` &&
      response.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Preview rescheduling', exact: true }).click();
  const response = await waiting;
  expect(response.status(), await response.text()).toBe(200);
  const value = (await response.json()) as SeriesReschedulePreview;
  await expect(dialog.locator('.series-reschedule-preview')).toBeVisible();
  return value;
}
async function commit(page: Page, dialog: Locator, id: string) {
  await dialog.getByLabel(agreement, { exact: true }).check();
  const waiting = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === endpoint(id) && response.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Reschedule selected visits', exact: true }).click();
  const response = await waiting;
  expect(response.status(), await response.text()).toBe(201);
  const result = (await response.json()) as SeriesRescheduleResult;
  await expect(dialog).toBeHidden();
  await expect(
    page.locator('.series-reschedule-event').filter({ hasText: result.event.reason }),
  ).toBeVisible();
  return result;
}
async function mobileAudit(page: Page) {
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

test('staff swap selected visit dates with retained resources, current default length and fees while preserving custom length, originals and patient privacy', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(120000);
  const { headers } = await login(page.request),
    { doctor, detail } = await fixtures(page.request, headers, 4, true);
  const own = await browser.newContext({ baseURL });
  try {
    await login(own.request, 'patient@derma.demo');
    const [first, second, terminal, untouched] = detail.appointments;
    const duration = await get<VisitDurationContext>(
      page.request,
      `/api/appointments/${second.id}/duration`,
    );
    const custom = await post<VisitDurationMutation>(
      page.request,
      headers,
      `/api/appointments/${second.id}/duration`,
      {
        durationPolicy: 'custom',
        durationMinutes: 60,
        date: second.date,
        time: second.time,
        reason: 'PRIVATE existing custom visit duration',
        expectedRevision: duration.revision,
        requestId: randomUUID(),
      },
      200,
    );
    await changeAppointment(page.request, headers, terminal.id, { status: 'cancelled' });
    const room = await resource(page.request, headers),
      equipment = await resource(page.request, headers, 'equipment');
    await allocate(page.request, headers, first.id, [room.resource.id]);
    await allocate(page.request, headers, second.id, [room.resource.id, equipment.resource.id]);
    await schedule(page.request, headers, doctor.id, 30);
    const renamedDoctor = `Dr. Updated ${randomUUID().slice(0, 8)}`;
    const profile = await page.request.patch(`/api/doctors/${doctor.id}`, {
      headers,
      data: { ...doctor, name: renamedDoctor, fee: 900 },
    });
    expect(profile.status(), await profile.text()).toBe(200);
    const procedure = await post<ProcedureRecord>(page.request, headers, '/api/procedures', {
      patientId: 'patient-ananya',
      appointmentId: first.id,
      title: `Retained procedure ${randomUUID().slice(0, 8)}`,
      indication: 'Patient-specific recorded indication',
      benefits: 'Recorded benefits',
      risks: 'Recorded risks',
      alternatives: 'Recorded alternatives',
      aftercare: 'Recorded aftercare',
      estimatedCost: 'Estimate only',
    });
    const invoice = await post<Invoice>(page.request, headers, '/api/invoices', {
      patientId: 'patient-ananya',
      procedureId: procedure.id,
      requestId: randomUUID(),
      items: [{ description: 'Explicit unchanged charge', quantity: 1, unitAmountPaise: 14200 }],
    });
    const beforeActivity = await get<ActivityFeed>(own.request, '/api/activity?limit=100'),
      priorNoticeIds = new Set(beforeActivity.items.map((item) => item.id));
    await page.goto(`/clinic/appointment-series?series=${detail.series.id}`);
    const dialog = await open(page);
    const context = await get<SeriesRescheduleContext>(
      page.request,
      `${endpoint(detail.series.id)}/context`,
    );
    for (const position of [1, 2, 3, 4])
      await expect(chooseVisit(dialog, position)).not.toBeChecked();
    await expect(chooseVisit(dialog, 3)).toBeDisabled();
    await expect(dialog).toContainText(context.visits[2].blockedReason!);
    await chooseVisit(dialog, 1).check();
    await chooseVisit(dialog, 2).check();
    await targets(dialog, 1, second.date, second.time);
    await targets(dialog, 2, first.date, first.time);
    const reason = `PRIVATE atomic swap ${randomUUID()}`;
    await dialog.getByLabel('Internal rescheduling reason', { exact: true }).fill(reason);
    const planned = await preview(page, dialog, detail.series.id);
    expect(planned.canReschedule).toBe(true);
    expect(planned.visits.map((visit) => visit.before)).toEqual([first, custom.appointment]);
    expect(
      planned.visits.map((visit) => [
        visit.after.date,
        visit.after.durationMinutes,
        visit.after.fee,
        visit.reservationCount,
      ]),
    ).toEqual([
      [second.date, 30, 900, 1],
      [first.date, 60, 900, 2],
    ]);
    const rows = dialog.locator('.series-reschedule-preview-visit');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0).locator('.series-reschedule-before')).toContainText('20 minutes');
    await expect(rows.nth(0).locator('.series-reschedule-before')).toContainText('₹600');
    await expect(rows.nth(0).locator('.series-reschedule-after')).toContainText('30 minutes');
    await expect(rows.nth(0).locator('.series-reschedule-after')).toContainText('₹900');
    await expect(rows.nth(1).locator('.series-reschedule-after')).toContainText('60 minutes');
    await expect(rows.nth(1)).toContainText('Retained reservations: 2');
    await expect(
      dialog.getByRole('button', { name: 'Reschedule selected visits', exact: true }),
    ).toBeDisabled();
    await mobileAudit(page);
    await page.screenshot({
      path: testInfo.outputPath('series-reschedule-swap-preview-mobile.png'),
      fullPage: true,
    });
    const result = await commit(page, dialog, detail.series.id);
    expect(result.event.visits.map((visit) => visit.retainedReservationCount)).toEqual([1, 2]);
    expect(result.detail.series).toEqual(detail.series);
    expect(result.detail.appointments[0]).toMatchObject({
      id: first.id,
      date: second.date,
      time: second.time,
      durationMinutes: 30,
      durationPolicy: 'schedule',
      fee: 900,
      doctorName: renamedDoctor,
    });
    expect(result.detail.appointments[1]).toMatchObject({
      id: second.id,
      date: first.date,
      time: first.time,
      durationMinutes: 60,
      durationPolicy: 'custom',
      fee: 900,
      doctorName: renamedDoctor,
    });
    expect(result.detail.appointments[2].status).toBe('cancelled');
    expect(result.detail.appointments[3]).toEqual(untouched);
    for (const [index, expectedIds] of [
      [0, [room.resource.id]],
      [1, [room.resource.id, equipment.resource.id]],
    ] as const) {
      const allocation = await get<AppointmentResourceContext>(
        page.request,
        `/api/appointments/${result.detail.appointments[index].id}/resources`,
      );
      expect(allocation.resourceIds).toEqual([...expectedIds].sort());
      expect(allocation.appointment.date).toBe(result.detail.appointments[index].date);
      expect(allocation.appointment.durationMinutes).toBe(
        result.detail.appointments[index].durationMinutes,
      );
      expect(allocation.history).toHaveLength(2);
    }
    expect(
      (await get<{ invoice: Invoice }>(page.request, `/api/invoices/${invoice.id}`)).invoice,
    ).toEqual(invoice);
    const workflows = await get<PatientClinicalWorkflows>(
        page.request,
        '/api/patients/patient-ananya/clinical-workflows',
      ),
      retained = workflows.procedures.find((row) => row.id === procedure.id)!;
    expect(retained.status).toBe(procedure.status);
    expect(retained.appointmentId).toBe(first.id);
    expect(retained.effectiveAppointmentId).toBe(first.id);
    expect(retained.scheduledAppointment!.date).toBe(second.date);
    const notices = await get<ActivityFeed>(own.request, '/api/activity?limit=100');
    expect(
      notices.items.filter((item) => !priorNoticeIds.has(item.id) && item.kind === 'appointment'),
    ).toHaveLength(2);
    const patientAppointments = await get<Appointment[]>(own.request, '/api/appointments'),
      summary = await get<CareSummary>(own.request, '/api/patients/patient-ananya/care-summary');
    for (const value of [patientAppointments, summary, notices]) {
      const text = JSON.stringify(value);
      for (const secret of [
        reason,
        result.event.id,
        result.event.requestId,
        'PRIVATE original series reason',
        'PRIVATE resource assignment',
      ])
        expect(text).not.toContain(secret);
    }
    expect((await own.request.get(endpoint(detail.series.id))).status()).toBe(403);
    expect((await own.request.get(`${endpoint(detail.series.id)}/context`)).status()).toBe(403);
    for (const [appointment, end] of [
      [result.detail.appointments[0], '040000'],
      [result.detail.appointments[1], '043000'],
    ] as const) {
      const calendar = await own.request.get(`/api/appointments/${appointment.id}/calendar`);
      expect(calendar.status()).toBe(200);
      const text = await calendar.text(),
        date = appointment.date.replaceAll('-', '');
      expect(text).toContain(`DTSTART:${date}T033000Z`);
      expect(text).toContain(`DTEND:${date}T${end}Z`);
    }
    const ownPage = await own.newPage();
    await ownPage.goto('/my-care/record?tab=visits');
    const currentRows = ownPage.getByRole('row').filter({ hasText: renamedDoctor });
    await expect(currentRows).toHaveCount(2);
    await expect(currentRows.filter({ hasText: '30 minutes' })).toHaveCount(1);
    await expect(currentRows.filter({ hasText: '60 minutes' })).toHaveCount(1);
    const event = page.locator('.series-reschedule-event').filter({ hasText: reason });
    await event.getByText('View rescheduled visits', { exact: true }).click();
    await expect(event).toContainText('Retained reservations: 2');
    await mobileAudit(page);
    await page.screenshot({
      path: testInfo.outputPath('series-reschedule-history-mobile.png'),
      fullPage: true,
    });
  } finally {
    await own.close();
  }
});

test('target and resource conflicts are atomic, stale sources preserve proposed moves, and uncertain results retain the exact command through later errors', async ({
  page,
}) => {
  test.setTimeout(120000);
  const { headers } = await login(page.request),
    { detail } = await fixtures(page.request, headers);
  const [first, second, third] = detail.appointments,
    path = endpoint(detail.series.id),
    reason = `PRIVATE retained rescheduling ${randomUUID()}`;
  const room = await resource(page.request, headers);
  await allocate(page.request, headers, second.id, [room.resource.id]);
  await page.goto(`/clinic/appointment-series?series=${detail.series.id}`);
  const dialog = await open(page);
  await chooseVisit(dialog, 1).check();
  await chooseVisit(dialog, 2).check();
  await targets(dialog, 1, day(70), '09:00');
  await targets(dialog, 2, day(70), '09:00');
  await dialog.getByLabel('Internal rescheduling reason', { exact: true }).fill(reason);
  const overlap = await preview(page, dialog, detail.series.id);
  expect(overlap.canReschedule).toBe(false);
  expect(overlap.visits).toHaveLength(2);
  expect(overlap.visits.some((visit) => !visit.eligible)).toBe(true);
  await expect(
    dialog.getByRole('button', { name: 'Reschedule selected visits', exact: true }),
  ).toBeDisabled();
  expect(
    (
      await get<AppointmentSeriesDetail>(
        page.request,
        `/api/appointment-series/${detail.series.id}`,
      )
    ).appointments,
  ).toEqual(detail.appointments);

  const otherDoctor = await createDoctor(page.request, headers),
    otherPatient = await createPatient(page.request, headers);
  const reserved = await post<Appointment>(page.request, headers, '/api/appointments', {
    patientId: otherPatient.id,
    doctorId: otherDoctor.id,
    mode: 'in-person',
    reason: 'Independent resource conflict',
    date: day(71),
    time: '09:00',
  });
  await allocate(page.request, headers, reserved.id, [room.resource.id]);
  await dialog.getByRole('button', { name: 'Change targets', exact: true }).click();
  await targets(dialog, 2, day(71), '09:00');
  const resourceConflict = await preview(page, dialog, detail.series.id);
  expect(resourceConflict.canReschedule).toBe(false);
  expect(resourceConflict.visits[0].eligible).toBe(true);
  expect(resourceConflict.visits[1].eligible).toBe(false);
  expect(resourceConflict.visits[1].reservationCount).toBe(1);
  expect(JSON.stringify(resourceConflict)).not.toContain(otherPatient.id);
  expect(JSON.stringify(resourceConflict)).not.toContain(reserved.id);
  await expect(dialog).toContainText(resourceConflict.visits[1].blockedReason!);
  expect(
    (
      await get<AppointmentSeriesDetail>(
        page.request,
        `/api/appointment-series/${detail.series.id}`,
      )
    ).appointments,
  ).toEqual(detail.appointments);
  await allocate(page.request, headers, reserved.id, []);
  await dialog.getByRole('button', { name: 'Change targets', exact: true }).click();
  const originalPreview = await preview(page, dialog, detail.series.id);
  expect(originalPreview.canReschedule).toBe(true);

  const moved = await changeAppointment(page.request, headers, first.id, {
    date: nextDay(first.date),
    time: '11:00',
  });
  const changedRoom = await resource(page.request, headers);
  await allocate(page.request, headers, first.id, [changedRoom.resource.id]);
  await dialog.getByLabel(agreement, { exact: true }).check();
  const staleResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === path && response.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Reschedule selected visits', exact: true }).click();
  const stale = await staleResponse;
  expect(stale.status()).toBe(409);
  const staleBody = stale.request().postDataJSON() as SeriesRescheduleInput;
  expect(
    (
      await get<AppointmentSeriesDetail>(
        page.request,
        `/api/appointment-series/${detail.series.id}`,
      )
    ).appointments.slice(0, 2),
  ).toEqual([moved, second]);
  await dialog.getByRole('button', { name: 'Refresh current visits', exact: true }).click();
  await expect(chooseVisit(dialog, 1)).toHaveAccessibleName(
    `Select visit 1 · ${moved.date} · 11:00 IST`,
  );
  await expect(chooseVisit(dialog, 1)).toBeChecked();
  await expect(chooseVisit(dialog, 2)).toBeChecked();
  await expect(dialog.getByLabel('New date for visit 1', { exact: true })).toHaveValue(day(70));
  await expect(dialog.getByLabel('New date for visit 2', { exact: true })).toHaveValue(day(71));
  await expect(dialog.getByLabel('New time for visit 1 · IST', { exact: true })).toHaveValue(
    '09:00',
  );
  await expect(dialog.getByLabel('Internal rescheduling reason', { exact: true })).toHaveValue(
    reason,
  );
  await expect(dialog.locator('.series-reschedule-visit').first()).toContainText(
    'Reserved resources: 1',
  );
  const refreshed = await preview(page, dialog, detail.series.id);
  expect(refreshed.canReschedule).toBe(true);
  expect(refreshed.revision).not.toBe(originalPreview.revision);
  expect(refreshed.visits[0].before).toEqual(moved);
  await expect(dialog.getByLabel(agreement, { exact: true })).not.toBeChecked();

  const bodies: SeriesRescheduleInput[] = [];
  let committed: SeriesRescheduleResult | undefined;
  const uncertainResponse = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.continue();
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 2) {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Synthetic later rejection must preserve the uncertain move.',
        }),
      });
      return;
    }
    const response = await route.fetch();
    expect(response.status()).toBe(bodies.length === 1 ? 201 : 200);
    const result = (await response.json()) as SeriesRescheduleResult;
    if (bodies.length === 1) {
      committed = result;
      await route.fulfill({
        response,
        json: { ...result, event: { ...result.event, visits: [null] } },
      });
    } else if (bodies.length === 3)
      await route.fulfill({
        response,
        json: { ...result, event: { ...result.event, createdById: 'wrong-current-account' } },
      });
    else await route.fulfill({ response });
  };
  await page.route(`**${path}`, uncertainResponse);
  try {
    await dialog.getByLabel(agreement, { exact: true }).check();
    await dialog.getByRole('button', { name: 'Reschedule selected visits', exact: true }).click();
    await expect(
      dialog.getByText('The rescheduling outcome could not be confirmed.', { exact: false }),
    ).toBeVisible();
    await expect(dialog.getByLabel(agreement, { exact: true })).toBeDisabled();
    await expect(dialog.getByLabel('Internal rescheduling reason', { exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Change targets', exact: true })).toHaveCount(
      0,
    );
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await expect(dialog).toBeVisible();
    const movedThird = await changeAppointment(page.request, headers, third.id, {
      date: nextDay(third.date),
      time: '11:00',
    });
    await dialog.getByRole('button', { name: 'Retry same request', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('Synthetic later rejection');
    await expect(dialog.getByLabel(agreement, { exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Retry same request', exact: true }).click();
    await expect(
      dialog.getByRole('button', { name: 'Retry same request', exact: true }),
    ).toBeEnabled();
    await expect(
      dialog.getByText('The rescheduling outcome could not be confirmed.', { exact: false }),
    ).toBeVisible();
    const replay = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === path && response.request().method() === 'POST',
    );
    await dialog.getByRole('button', { name: 'Retry same request', exact: true }).click();
    const repeated = await replay;
    expect(repeated.status()).toBe(200);
    const result = (await repeated.json()) as SeriesRescheduleResult;
    expect(result.event).toEqual(committed!.event);
    expect(result.detail.appointments[2]).toEqual(movedThird);
    await expect(dialog).toBeHidden();
    await expect(
      page.locator('.series-reschedule-event').filter({ hasText: reason }),
    ).toBeVisible();
    expect(bodies).toHaveLength(4);
    for (const body of bodies) expect(body).toEqual(bodies[0]);
    expect(bodies[0].requestId).not.toBe(staleBody.requestId);
    expect(bodies[0].expectedRevision).toBe(refreshed.revision);
    expect(bodies[0].moves).toEqual(refreshed.moves);
    const history = await get<SeriesReschedulePage>(page.request, path);
    expect(history.total).toBe(1);
    expect(history.items[0]).toEqual(committed!.event);
    for (const [id, resourceId, date] of [
      [first.id, changedRoom.resource.id, day(70)],
      [second.id, room.resource.id, day(71)],
    ]) {
      const allocation = await get<AppointmentResourceContext>(
        page.request,
        `/api/appointments/${id}/resources`,
      );
      expect(allocation.resourceIds).toEqual([resourceId]);
      expect(allocation.appointment.date).toBe(date);
    }
  } finally {
    await page.unroute(`**${path}`, uncertainResponse);
  }
});

test('history failures are recoverable and obsolete previews, committed responses and history errors cannot act after leaving and returning', async ({
  page,
}, testInfo) => {
  test.setTimeout(120000);
  const { headers } = await login(page.request),
    { detail } = await fixtures(page.request, headers, 2);
  const path = endpoint(detail.series.id),
    detailUrl = `/clinic/appointment-series?series=${detail.series.id}`;
  let failHistory = true;
  const failedHistory = async (route: Route) => {
    if (failHistory)
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Synthetic history is temporarily unavailable.' }),
      });
    else await route.continue();
  };
  await page.route(`**${path}?*`, failedHistory);
  try {
    await page.goto(detailUrl);
    const history = page.locator('.series-reschedule-history');
    await expect(history.getByRole('alert')).toContainText(
      'Synthetic history is temporarily unavailable.',
    );
    failHistory = false;
    await history.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(
      history.getByRole('heading', { name: 'No group rescheduling recorded', exact: true }),
    ).toBeVisible();
  } finally {
    await page.unroute(`**${path}?*`, failedHistory);
  }
  await expect(
    page.getByRole('button', { name: 'Reschedule visits together', exact: true }),
  ).toBeEnabled();
  await page.evaluate((prefix) => {
    const state = window as unknown as {
      rescheduleBodies: Record<string, number>;
      rescheduleSessionEvents: number;
    };
    state.rescheduleBodies = {};
    state.rescheduleSessionEvents = 0;
    window.addEventListener('derma:session-expired', () => state.rescheduleSessionEvents++);
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const response = await original(input, init);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const pathname = new URL(url, window.location.origin).pathname;
      if (pathname.startsWith(prefix)) {
        const json = response.json.bind(response);
        response.json = async () => {
          try {
            return await json();
          } finally {
            const key = `${init?.method ?? 'GET'} ${pathname} ${response.status}`;
            state.rescheduleBodies[key] = (state.rescheduleBodies[key] ?? 0) + 1;
          }
        };
      }
      return response;
    };
  }, path);
  const readyPreview = deferred(),
    releasePreview = deferred(),
    donePreview = deferred();
  const heldPreview = async (route: Route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    readyPreview.resolve();
    await releasePreview.promise;
    try {
      await route.fulfill({ response });
    } finally {
      donePreview.resolve();
    }
  };
  await page.route(`**${path}/preview`, heldPreview);
  try {
    const dialog = await open(page);
    await chooseVisit(dialog, 1).check();
    await targets(dialog, 1, nextDay(detail.appointments[0].date), '10:00');
    await dialog
      .getByLabel('Internal rescheduling reason', { exact: true })
      .fill('Discarded rescheduling preview intent');
    await dialog.getByRole('button', { name: 'Preview rescheduling', exact: true }).click();
    await readyPreview.promise;
    await page.evaluate(() => {
      window.history.pushState(
        { key: 'reschedule-preview-away' },
        '',
        '/clinic/appointment-series?search=no-match',
      );
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.getByLabel('Search appointment series', { exact: true })).toBeVisible();
    await page.goBack();
    await expect(
      page.getByRole('button', { name: 'Reschedule visits together', exact: true }),
    ).toBeEnabled();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    releasePreview.resolve();
    await donePreview.promise;
    await page.waitForFunction(
      (key) =>
        (window as unknown as { rescheduleBodies: Record<string, number> }).rescheduleBodies[key] >=
        1,
      `POST ${path}/preview 200`,
    );
    await expect(page.getByRole('dialog')).toHaveCount(0);
  } finally {
    releasePreview.resolve();
    await page.unroute(`**${path}/preview`, heldPreview);
  }

  const dialog = await open(page);
  for (const position of [1, 2]) await expect(chooseVisit(dialog, position)).not.toBeChecked();
  await expect(dialog.getByLabel('Internal rescheduling reason', { exact: true })).toHaveValue('');
  await expect(dialog.locator('.series-reschedule-preview')).toHaveCount(0);
  await chooseVisit(dialog, 1).check();
  await targets(dialog, 1, nextDay(detail.appointments[0].date), '10:00');
  const reason = `PRIVATE held rescheduling ${randomUUID()}`;
  await dialog.getByLabel('Internal rescheduling reason', { exact: true }).fill(reason);
  await preview(page, dialog, detail.series.id);
  const readyCommand = deferred(),
    releaseCommand = deferred(),
    doneCommand = deferred();
  let committed: SeriesRescheduleResult | undefined;
  const heldCommand = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    committed = (await response.json()) as SeriesRescheduleResult;
    readyCommand.resolve();
    await releaseCommand.promise;
    try {
      await route.fulfill({ response });
    } finally {
      doneCommand.resolve();
    }
  };
  await page.route(`**${path}`, heldCommand);
  try {
    await dialog.getByLabel(agreement, { exact: true }).check();
    await dialog.getByRole('button', { name: 'Reschedule selected visits', exact: true }).click();
    await readyCommand.promise;
    await page.evaluate(() => {
      window.history.pushState(
        { key: 'reschedule-command-away' },
        '',
        '/clinic/appointment-series?search=no-match',
      );
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.getByLabel('Search appointment series', { exact: true })).toBeVisible();
    await page.goBack();
    await expect(
      page.getByRole('button', { name: 'Reschedule visits together', exact: true }),
    ).toBeEnabled();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(
      page.locator('.series-reschedule-event').filter({ hasText: reason }),
    ).toBeVisible();
    releaseCommand.resolve();
    await doneCommand.promise;
    await page.waitForFunction(
      (key) =>
        (window as unknown as { rescheduleBodies: Record<string, number> }).rescheduleBodies[key] >=
        1,
      `POST ${path} 201`,
    );
    await expect(page).toHaveURL(new RegExp(`series=${detail.series.id}$`));
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Dismiss notification', exact: true }),
    ).toHaveCount(0);
    const history = await get<SeriesReschedulePage>(page.request, path);
    expect(history.total).toBe(1);
    expect(history.items[0]).toEqual(committed!.event);
  } finally {
    releaseCommand.resolve();
    await page.unroute(`**${path}`, heldCommand);
  }

  const historyReady = deferred(),
    releaseHistory = deferred();
  let heldReads = 0,
    settledReads = 0;
  const staleHistory = async (route: Route) => {
    heldReads++;
    historyReady.resolve();
    await releaseHistory.promise;
    try {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Discarded rescheduling history must not sign out this session.',
        }),
      });
    } finally {
      settledReads++;
    }
  };
  await page.getByRole('button', { name: 'Back to series list', exact: true }).click();
  await expect(page.getByLabel('Search appointment series', { exact: true })).toBeVisible();
  await page.route(`**${path}?*`, staleHistory);
  try {
    await page.evaluate((url) => {
      window.history.pushState({ key: 'reschedule-history-source' }, '', url);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, detailUrl);
    await historyReady.promise;
    await page.getByRole('button', { name: 'Back to series list', exact: true }).click();
    await expect(page.getByLabel('Search appointment series', { exact: true })).toBeVisible();
    const expected = heldReads;
    expect(expected).toBeGreaterThan(0);
    releaseHistory.resolve();
    await expect.poll(() => settledReads).toBe(expected);
    await page.waitForFunction(
      ({ key, count }) =>
        (window as unknown as { rescheduleBodies: Record<string, number> }).rescheduleBodies[key] >=
        count,
      { key: `GET ${path} 401`, count: expected },
    );
    expect(
      await page.evaluate(
        () => (window as unknown as { rescheduleSessionEvents: number }).rescheduleSessionEvents,
      ),
    ).toBe(0);
    await expect(page.getByLabel('Search appointment series', { exact: true })).toBeVisible();
    await expect(
      page.getByText('Discarded rescheduling history must not sign out this session.', {
        exact: true,
      }),
    ).toHaveCount(0);
    expect((await get<Session>(page.request, '/api/session')).user?.role).toBe('admin');
  } finally {
    releaseHistory.resolve();
    await page.unroute(`**${path}?*`, staleHistory);
  }
  await page.goto(detailUrl);
  await expect(page.locator('.series-reschedule-event').filter({ hasText: reason })).toBeVisible();
  await mobileAudit(page);
  await page.screenshot({
    path: testInfo.outputPath('series-reschedule-navigation-history-mobile.png'),
    fullPage: true,
  });
});
