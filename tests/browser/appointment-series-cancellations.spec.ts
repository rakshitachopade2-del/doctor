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
  SeriesCancellationContext,
  SeriesCancellationInput,
  SeriesCancellationPage,
  SeriesCancellationPreview,
  SeriesCancellationResult,
} from '../../shared/appointment-series-cancellations';
import type { AppointmentResourceContext, ResourceDetail } from '../../shared/clinic-resources';
import type { PatientClinicalWorkflows, ProcedureRecord } from '../../shared/clinical';
import type { Invoice } from '../../shared/operations';
import type { ActivityFeed } from '../../shared/activity';
import type { CareSummary } from '../../shared/care-summary';

const confirmation = 'I confirmed these exact cancellations with the patient.';
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
const base = (id: string) => `/api/appointment-series/${id}/cancellations`;
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
async function patch(
  request: APIRequestContext,
  headers: Record<string, string>,
  appointmentId: string,
  data: unknown,
): Promise<Appointment> {
  const response = await request.patch(`/api/appointments/${appointmentId}`, { headers, data });
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}
async function fixtures(
  request: APIRequestContext,
  headers: Record<string, string>,
  count = 3,
  own = false,
  custom = false,
) {
  const clinician = await post<Doctor>(request, headers, '/api/doctors', {
    name: `Dr. Cancellation ${randomUUID().slice(0, 8)}`,
    title: 'Dermatologist',
    qualifications: 'Synthetic profile',
    specialties: ['General dermatology'],
    experience: 5,
    fee: 600,
    bio: 'Synthetic cancellation verification.',
    languages: ['English'],
  });
  const schedule = await request.put(`/api/schedules/${clinician.id}`, {
    headers,
    data: {
      durationMinutes: 20,
      windows: Array.from({ length: 7 }, (_, weekday) => ({
        day: weekday,
        start: '08:00',
        end: '18:00',
        mode: 'both',
      })),
    },
  });
  expect(schedule.status(), await schedule.text()).toBe(200);
  const person = own
    ? { id: 'patient-ananya' }
    : await post<{ id: string }>(request, headers, '/api/patients', {
        name: `Cancellation patient ${randomUUID().slice(0, 8)}`,
        email: '',
        phone: '9000000241',
        dob: '',
        gender: 'Not recorded',
      });
  const input: AppointmentSeriesInput = {
    patientId: person.id,
    doctorId: clinician.id,
    mode: 'in-person',
    reason: 'Shared synthetic follow-up visit',
    firstDate: day(42),
    time: custom ? '09:05' : '09:00',
    count,
    intervalWeeks: 1,
    ...(custom
      ? { durationPolicy: 'custom', durationMinutes: 60 }
      : { durationPolicy: 'schedule' }),
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
    privateNote: 'PRIVATE original series booking note',
    requestId: randomUUID(),
  });
  return { clinician, person, detail };
}
async function resource(
  request: APIRequestContext,
  headers: Record<string, string>,
  kind: 'room' | 'equipment' = 'room',
) {
  return post<ResourceDetail>(request, headers, '/api/clinic-resources', {
    name: `Cancellation ${kind} ${randomUUID().slice(0, 8)}`,
    kind,
    location: 'Synthetic room',
    notes: 'PRIVATE operational resource notes',
    requestId: randomUUID(),
  });
}
async function allocate(
  request: APIRequestContext,
  headers: Record<string, string>,
  appointmentId: string,
  resourceIds: string[],
) {
  const current = await get<AppointmentResourceContext>(
    request,
    `/api/appointments/${appointmentId}/resources`,
  );
  const response = await request.put(`/api/appointments/${appointmentId}/resources`, {
    headers,
    data: {
      resourceIds,
      reason: 'PRIVATE allocation reason',
      expectedRevision: current.revision,
      requestId: randomUUID(),
    },
  });
  expect(response.status(), await response.text()).toBe(200);
  return response.json() as Promise<AppointmentResourceContext>;
}
const visitCheckbox = (dialog: Locator, position: number) =>
  dialog.getByRole('checkbox', { name: new RegExp(`^Select visit ${position} ·`) });
async function openCancellation(page: Page) {
  await page.getByRole('button', { name: 'Cancel remaining visits', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Cancel remaining visits', exact: true });
  await expect(dialog.getByLabel('Internal cancellation reason', { exact: true })).toBeEnabled();
  return dialog;
}
async function preview(page: Page, dialog: Locator, seriesId: string) {
  const waiting = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `${base(seriesId)}/preview` &&
      response.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Preview cancellation', exact: true }).click();
  const response = await waiting;
  expect(response.status(), await response.text()).toBe(200);
  const value = (await response.json()) as SeriesCancellationPreview;
  await expect(dialog.locator('.series-cancel-preview')).toBeVisible();
  return value;
}
async function cancel(page: Page, dialog: Locator, seriesId: string) {
  await dialog.getByLabel(confirmation, { exact: true }).check();
  const waiting = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === base(seriesId) && response.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Cancel selected visits', exact: true }).click();
  const response = await waiting;
  expect(response.status(), await response.text()).toBe(201);
  const value = (await response.json()) as SeriesCancellationResult;
  await expect(dialog).toBeHidden();
  await expect(
    page.locator('.series-cancellation-event').filter({ hasText: value.event.reason }),
  ).toBeVisible();
  return value;
}
async function audit(page: Page) {
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

test('staff cancel only confirmed eligible current visits, release reservations and preserve booking, clinical and billing history without private patient disclosure', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(120000);
  const { headers } = await login(page.request),
    { clinician, detail } = await fixtures(page.request, headers, 4, true, true);
  const own = await browser.newContext({ baseURL });
  try {
    await login(own.request, 'patient@derma.demo');
    const [first, movedOriginal, reserved, remaining] = detail.appointments;
    await patch(page.request, headers, first.id, { status: 'cancelled' });
    const moved = await patch(page.request, headers, movedOriginal.id, {
      date: nextDay(movedOriginal.date),
      time: '10:05',
      mode: 'online',
    });
    const room = await resource(page.request, headers),
      equipment = await resource(page.request, headers, 'equipment');
    await allocate(page.request, headers, reserved.id, [room.resource.id, equipment.resource.id]);
    const procedure = await post<ProcedureRecord>(page.request, headers, '/api/procedures', {
      patientId: 'patient-ananya',
      appointmentId: reserved.id,
      title: `Unchanged procedure ${randomUUID().slice(0, 8)}`,
      indication: 'Patient-specific indication',
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
      items: [{ description: 'Explicit unchanged charge', quantity: 1, unitAmountPaise: 14000 }],
    });
    const previousActivity = await get<ActivityFeed>(own.request, '/api/activity?limit=100');
    const previousIds = new Set(previousActivity.items.map((item) => item.id));
    const reason = `PRIVATE cancellation reason ${randomUUID()}`;
    await page.goto(`/clinic/appointment-series?series=${detail.series.id}`);
    const dialog = await openCancellation(page);
    const context = await get<SeriesCancellationContext>(
      page.request,
      `${base(detail.series.id)}/context`,
    );
    await expect(visitCheckbox(dialog, 1)).toBeDisabled();
    await expect(dialog).toContainText(context.visits[0].blockedReason!);
    for (const position of [1, 2, 3, 4])
      await expect(visitCheckbox(dialog, position)).not.toBeChecked();
    await expect(visitCheckbox(dialog, 2)).toHaveAccessibleName(
      `Select visit 2 · ${moved.date} · 10:05 IST`,
    );
    await dialog.getByRole('button', { name: 'Select all eligible', exact: true }).click();
    for (const position of [2, 3, 4]) await expect(visitCheckbox(dialog, position)).toBeChecked();
    await expect(visitCheckbox(dialog, 1)).not.toBeChecked();
    await dialog.getByRole('button', { name: 'Clear selection', exact: true }).click();
    for (const position of [2, 3, 4])
      await expect(visitCheckbox(dialog, position)).not.toBeChecked();
    await visitCheckbox(dialog, 2).check();
    await visitCheckbox(dialog, 3).check();
    await dialog.getByLabel('Internal cancellation reason', { exact: true }).fill(reason);
    const proposed = await preview(page, dialog, detail.series.id);
    expect(proposed.appointmentIds).toEqual([moved.id, reserved.id]);
    expect(proposed.visits.map((visit) => visit.appointment)).toEqual([moved, reserved]);
    await expect(dialog.locator('.series-cancel-preview')).toContainText('Reserved resources: 2');
    await expect(dialog.locator('.series-cancel-preview')).toContainText('60 minutes');
    await expect(
      dialog.getByRole('button', { name: 'Cancel selected visits', exact: true }),
    ).toBeDisabled();
    await page.setViewportSize({ width: 320, height: 860 });
    await audit(page);
    await page.screenshot({
      path: testInfo.outputPath('series-cancellation-preview-mobile.png'),
      fullPage: true,
    });
    const result = await cancel(page, dialog, detail.series.id);
    expect(result.event.appointmentIds).toEqual([moved.id, reserved.id]);
    expect(result.event.visits.map((visit) => visit.releasedReservationCount)).toEqual([0, 2]);
    expect(result.detail.series).toEqual(detail.series);
    expect(result.detail.appointments.map((visit) => visit.status)).toEqual([
      'cancelled',
      'cancelled',
      'cancelled',
      'scheduled',
    ]);
    expect(result.detail.appointments[3]).toEqual(remaining);
    const event = page.locator('.series-cancellation-event').filter({ hasText: reason });
    await event.getByText('View cancelled visits', { exact: true }).click();
    await expect(event).toContainText('Released reservations: 2');
    await expect(event).toContainText('Online');
    const allocation = await get<AppointmentResourceContext>(
      page.request,
      `/api/appointments/${reserved.id}/resources`,
    );
    expect(allocation.resourceIds).toEqual([]);
    expect(allocation.history).toHaveLength(2);
    expect(
      (await get<{ invoice: Invoice }>(page.request, `/api/invoices/${invoice.id}`)).invoice,
    ).toEqual(invoice);
    const workflows = await get<PatientClinicalWorkflows>(
      page.request,
      '/api/patients/patient-ananya/clinical-workflows',
    );
    const retained = workflows.procedures.find((value) => value.id === procedure.id)!;
    expect(retained.status).toBe(procedure.status);
    expect(retained.appointmentId).toBe(reserved.id);
    expect(retained.effectiveAppointmentId).toBe(reserved.id);
    expect(retained.scheduledAppointment!.status).toBe('cancelled');
    const afterActivity = await get<ActivityFeed>(own.request, '/api/activity?limit=100');
    const freshNotices = afterActivity.items.filter(
      (item) => !previousIds.has(item.id) && item.kind === 'appointment',
    );
    expect(freshNotices).toHaveLength(2);
    const patientVisits = await get<Appointment[]>(own.request, '/api/appointments');
    const summary = await get<CareSummary>(
      own.request,
      '/api/patients/patient-ananya/care-summary',
    );
    for (const serialized of [
      JSON.stringify(patientVisits),
      JSON.stringify(summary),
      JSON.stringify(afterActivity),
    ]) {
      expect(serialized).not.toContain(reason);
      expect(serialized).not.toContain(result.event.requestId);
      expect(serialized).not.toContain(result.event.id);
      expect(serialized).not.toContain('PRIVATE allocation reason');
    }
    expect((await own.request.get(`${base(detail.series.id)}/context`)).status()).toBe(403);
    expect((await own.request.get(base(detail.series.id))).status()).toBe(403);
    const patientPage = await own.newPage();
    await patientPage.goto('/my-care/record?tab=visits');
    const rows = patientPage.getByRole('row').filter({ hasText: clinician.name });
    await expect(rows).toHaveCount(4);
    await expect(rows.filter({ hasText: /cancelled/i })).toHaveCount(3);
    await expect(patientPage.getByText(reason, { exact: false })).toHaveCount(0);
    const replacement = await post<Appointment>(page.request, headers, '/api/appointments', {
      patientId: 'patient-ananya',
      doctorId: clinician.id,
      date: reserved.date,
      time: '09:00',
      mode: 'in-person',
      reason: 'Independent new booking after cancellation',
    });
    expect(
      (await allocate(page.request, headers, replacement.id, [room.resource.id])).resourceIds,
    ).toEqual([room.resource.id]);
    await audit(page);
    await page.screenshot({
      path: testInfo.outputPath('series-cancellation-history-mobile.png'),
      fullPage: true,
    });
  } finally {
    await own.close();
  }
});

test('stale selections require fresh review and uncertain cancellations retain their exact command through malformed receipts and later errors', async ({
  page,
}) => {
  test.setTimeout(120000);
  const { headers } = await login(page.request),
    { detail } = await fixtures(page.request, headers);
  const [first, second, third] = detail.appointments,
    reason = `PRIVATE retained cancellation ${randomUUID()}`;
  await page.goto(`/clinic/appointment-series?series=${detail.series.id}`);
  const dialog = await openCancellation(page);
  await visitCheckbox(dialog, 1).check();
  await visitCheckbox(dialog, 2).check();
  await dialog.getByLabel('Internal cancellation reason', { exact: true }).fill(reason);
  const originalPreview = await preview(page, dialog, detail.series.id);
  const moved = await patch(page.request, headers, first.id, {
    date: nextDay(first.date),
    time: '10:00',
    mode: 'online',
  });
  const room = await resource(page.request, headers);
  await allocate(page.request, headers, first.id, [room.resource.id]);
  await patch(page.request, headers, second.id, { status: 'cancelled' });
  await dialog.getByLabel(confirmation, { exact: true }).check();
  const staleResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === base(detail.series.id) &&
      response.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Cancel selected visits', exact: true }).click();
  const stale = await staleResponse;
  expect(stale.status()).toBe(409);
  const staleBody = stale.request().postDataJSON() as SeriesCancellationInput;
  expect(
    (
      await get<AppointmentSeriesDetail>(
        page.request,
        `/api/appointment-series/${detail.series.id}`,
      )
    ).appointments[0].status,
  ).toBe('scheduled');
  await dialog.getByRole('button', { name: 'Refresh current visits', exact: true }).click();
  await expect(visitCheckbox(dialog, 1)).toHaveAccessibleName(
    `Select visit 1 · ${moved.date} · 10:00 IST`,
  );
  await expect(visitCheckbox(dialog, 1)).toBeChecked();
  await expect(visitCheckbox(dialog, 2)).toBeChecked();
  await expect(dialog.getByLabel('Internal cancellation reason', { exact: true })).toHaveValue(
    reason,
  );
  await expect(dialog).toContainText('Reserved resources: 1');
  await expect(dialog).toContainText('Only scheduled appointments can be cancelled together.');
  await expect(
    dialog.getByRole('button', { name: 'Preview cancellation', exact: true }),
  ).toBeDisabled();
  await visitCheckbox(dialog, 2).uncheck();
  const refreshed = await preview(page, dialog, detail.series.id);
  expect(refreshed.appointmentIds).toEqual([first.id]);
  expect(refreshed.revision).not.toBe(originalPreview.revision);
  await expect(dialog.getByLabel(confirmation, { exact: true })).not.toBeChecked();
  const bodies: SeriesCancellationInput[] = [];
  let committed: SeriesCancellationResult | undefined;
  const uncertainResponse = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.continue();
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 2) {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Synthetic later rejection must preserve the uncertain cancellation.',
        }),
      });
      return;
    }
    const response = await route.fetch();
    expect(response.status()).toBe(bodies.length === 1 ? 201 : 200);
    const result = (await response.json()) as SeriesCancellationResult;
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
  await page.route(`**${base(detail.series.id)}`, uncertainResponse);
  try {
    await dialog.getByLabel(confirmation, { exact: true }).check();
    await dialog.getByRole('button', { name: 'Cancel selected visits', exact: true }).click();
    await expect(
      dialog.getByText('The cancellation outcome could not be confirmed.', { exact: false }),
    ).toBeVisible();
    await expect(dialog.getByLabel(confirmation, { exact: true })).toBeDisabled();
    await expect(dialog.getByLabel('Internal cancellation reason', { exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await expect(dialog).toBeVisible();
    const movedThird = await patch(page.request, headers, third.id, {
      date: nextDay(third.date),
      time: '11:00',
    });
    await dialog.getByRole('button', { name: 'Retry same request', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('Synthetic later rejection');
    await expect(dialog.getByLabel(confirmation, { exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Retry same request', exact: true }).click();
    await expect(
      dialog.getByRole('button', { name: 'Retry same request', exact: true }),
    ).toBeEnabled();
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText('The cancellation outcome could not be confirmed.', { exact: false }),
    ).toBeVisible();
    const replay = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === base(detail.series.id) &&
        response.request().method() === 'POST',
    );
    await dialog.getByRole('button', { name: 'Retry same request', exact: true }).click();
    const repeated = await replay;
    expect(repeated.status()).toBe(200);
    const result = (await repeated.json()) as SeriesCancellationResult;
    expect(result.event).toEqual(committed!.event);
    expect(result.detail.appointments[2]).toEqual(movedThird);
    await expect(dialog).toBeHidden();
    await expect(
      page.locator('.series-cancellation-event').filter({ hasText: reason }),
    ).toBeVisible();
    expect(bodies).toHaveLength(4);
    for (const body of bodies) expect(body).toEqual(bodies[0]);
    expect(bodies[0].requestId).not.toBe(staleBody.requestId);
    expect(bodies[0].expectedRevision).toBe(refreshed.revision);
    expect(bodies[0].appointmentIds).toEqual([first.id]);
    expect((await get<SeriesCancellationPage>(page.request, base(detail.series.id))).total).toBe(1);
    expect(
      (
        await get<AppointmentResourceContext>(
          page.request,
          `/api/appointments/${first.id}/resources`,
        )
      ).resourceIds,
    ).toEqual([]);
  } finally {
    await page.unroute(`**${base(detail.series.id)}`, uncertainResponse);
  }
});

test('leaving and returning discards pending previews and cancellation callbacks, and stale history errors cannot expire the current session', async ({
  page,
}, testInfo) => {
  test.setTimeout(120000);
  const { headers } = await login(page.request),
    { detail } = await fixtures(page.request, headers, 2);
  const path = base(detail.series.id),
    detailUrl = `/clinic/appointment-series?series=${detail.series.id}`;
  await page.goto(detailUrl);
  await expect(
    page.getByRole('button', { name: 'Cancel remaining visits', exact: true }),
  ).toBeEnabled();
  await page.evaluate((prefix) => {
    const state = window as unknown as {
      cancellationBodies: Record<string, number>;
      cancellationSessionEvents: number;
    };
    state.cancellationBodies = {};
    state.cancellationSessionEvents = 0;
    window.addEventListener('derma:session-expired', () => state.cancellationSessionEvents++);
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
            state.cancellationBodies[key] = (state.cancellationBodies[key] ?? 0) + 1;
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
    const dialog = await openCancellation(page);
    await visitCheckbox(dialog, 1).check();
    await dialog
      .getByLabel('Internal cancellation reason', { exact: true })
      .fill('Discarded preview intent');
    await dialog.getByRole('button', { name: 'Preview cancellation', exact: true }).click();
    await readyPreview.promise;
    await page.evaluate(() => {
      window.history.pushState(
        { key: 'cancel-preview-away' },
        '',
        '/clinic/appointment-series?search=no-match',
      );
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.getByLabel('Search appointment series', { exact: true })).toBeVisible();
    await page.goBack();
    await expect(
      page.getByRole('button', { name: 'Cancel remaining visits', exact: true }),
    ).toBeEnabled();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    releasePreview.resolve();
    await donePreview.promise;
    await page.waitForFunction(
      (key) =>
        (window as unknown as { cancellationBodies: Record<string, number> }).cancellationBodies[
          key
        ] >= 1,
      `POST ${path}/preview 200`,
    );
    await expect(page.getByRole('dialog')).toHaveCount(0);
  } finally {
    releasePreview.resolve();
    await page.unroute(`**${path}/preview`, heldPreview);
  }

  const dialog = await openCancellation(page);
  for (const position of [1, 2]) await expect(visitCheckbox(dialog, position)).not.toBeChecked();
  await expect(dialog.getByLabel('Internal cancellation reason', { exact: true })).toHaveValue('');
  await expect(dialog.locator('.series-cancel-preview')).toHaveCount(0);
  await visitCheckbox(dialog, 1).check();
  const reason = `PRIVATE pending cancellation ${randomUUID()}`;
  await dialog.getByLabel('Internal cancellation reason', { exact: true }).fill(reason);
  await preview(page, dialog, detail.series.id);
  const readyCommand = deferred(),
    releaseCommand = deferred(),
    doneCommand = deferred();
  let committed: SeriesCancellationResult | undefined;
  const heldCommand = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    committed = (await response.json()) as SeriesCancellationResult;
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
    await dialog.getByLabel(confirmation, { exact: true }).check();
    await dialog.getByRole('button', { name: 'Cancel selected visits', exact: true }).click();
    await readyCommand.promise;
    await page.evaluate(() => {
      window.history.pushState(
        { key: 'cancel-command-away' },
        '',
        '/clinic/appointment-series?search=no-match',
      );
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.getByLabel('Search appointment series', { exact: true })).toBeVisible();
    await page.goBack();
    await expect(
      page.getByRole('button', { name: 'Cancel remaining visits', exact: true }),
    ).toBeEnabled();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(
      page.locator('.series-cancellation-event').filter({ hasText: reason }),
    ).toBeVisible();
    releaseCommand.resolve();
    await doneCommand.promise;
    await page.waitForFunction(
      (key) =>
        (window as unknown as { cancellationBodies: Record<string, number> }).cancellationBodies[
          key
        ] >= 1,
      `POST ${path} 201`,
    );
    await expect(page).toHaveURL(new RegExp(`series=${detail.series.id}$`));
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Dismiss notification', exact: true }),
    ).toHaveCount(0);
    const history = await get<SeriesCancellationPage>(page.request, path);
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
          error: 'Discarded cancellation history must not sign out this session.',
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
      window.history.pushState({ key: 'cancel-history-source' }, '', url);
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
        (window as unknown as { cancellationBodies: Record<string, number> }).cancellationBodies[
          key
        ] >= count,
      { key: `GET ${path} 401`, count: expected },
    );
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { cancellationSessionEvents: number }).cancellationSessionEvents,
      ),
    ).toBe(0);
    await expect(page.getByLabel('Search appointment series', { exact: true })).toBeVisible();
    await expect(
      page.getByText('Discarded cancellation history must not sign out this session.', {
        exact: true,
      }),
    ).toHaveCount(0);
    expect((await get<Session>(page.request, '/api/session')).user?.role).toBe('admin');
  } finally {
    releaseHistory.resolve();
    await page.unroute(`**${path}?*`, staleHistory);
  }
  await page.goto(detailUrl);
  await expect(
    page.locator('.series-cancellation-event').filter({ hasText: reason }),
  ).toBeVisible();
  await page.setViewportSize({ width: 320, height: 860 });
  await audit(page);
  await page.screenshot({
    path: testInfo.outputPath('series-cancellation-read-history-mobile.png'),
    fullPage: true,
  });
});
