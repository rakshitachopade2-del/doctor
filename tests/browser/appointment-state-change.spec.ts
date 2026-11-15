import { test, expect, type APIRequestContext, type Page, type Locator } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import type { Appointment, Doctor, Session } from '../../shared/types';
import type {
  AppointmentStateChangeContext,
  AppointmentStateChangeInput,
  AppointmentStateChangeResult,
  AppointmentStateChangeStatus,
} from '../../shared/appointment-state-change';
import type { AppointmentResourceContext } from '../../shared/clinic-resources';
import type { Invoice, InvoiceDetail } from '../../shared/operations';
import type { ProcedureRecord, PatientClinicalWorkflows } from '../../shared/clinical';
import type { ActivityFeed } from '../../shared/activity';

const base = (id: string) => `/api/appointments/${id}`;
const agreement = 'I reviewed this appointment and confirm this status change.';
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
      state = window as Window & { stateConsumed?: string[]; stateExpired?: number };
    state.stateConsumed = [];
    state.stateExpired = 0;
    window.addEventListener('derma:session-expired', () => state.stateExpired!++);
    window.fetch = async (...args) => {
      const response = await original(...args),
        marker = response.headers.get('X-Test-State-Settled');
      if (marker) {
        const json = response.json.bind(response);
        response.json = async () => {
          try {
            return await json();
          } finally {
            state.stateConsumed!.push(marker);
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
          (window as Window & { stateConsumed?: string[] }).stateConsumed?.includes(marker),
        marker,
      ),
    )
    .toBe(true);
}

async function fixture(request: APIRequestContext, tag: string) {
  const visits = await get<Appointment[]>(request, '/api/appointments');
  const visit = visits.find((value) => value.reason === `E2E state ${tag}`);
  expect(visit, `Isolated startup fixture ${tag} must exist`).toBeTruthy();
  return visit!;
}
async function context(request: APIRequestContext, id: string) {
  return get<AppointmentStateChangeContext>(request, `${base(id)}/state-context`);
}
async function change(
  request: APIRequestContext,
  headers: Record<string, string>,
  id: string,
  status: AppointmentStateChangeStatus,
) {
  const source = await context(request, id);
  return post<AppointmentStateChangeResult>(request, headers, `${base(id)}/state-changes`, {
    status,
    expectedRevision: source.revision,
    changeConfirmed: true,
    requestId: randomUUID(),
  });
}
async function open(page: Page, visit: Appointment, action = 'Check in') {
  await page.goto(`/clinic/appointments?date=${visit.date}`);
  const row = page.getByRole('row').filter({ hasText: visit.reason });
  await expect(row).toBeVisible();
  if (action === 'Mark no-show') {
    await row
      .getByRole('button', { name: `More actions for ${visit.patientName}`, exact: true })
      .click();
    await page
      .getByRole('dialog', { name: 'Appointment actions', exact: true })
      .getByRole('button', { name: action, exact: true })
      .click();
  } else await row.getByRole('button', { name: action, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Update appointment status', exact: true });
  await expect(dialog.locator('.appointment-state-change-source')).toBeVisible();
  return dialog;
}
async function confirm(
  page: Page,
  scope: Locator,
  id: string,
  code = 201,
  label = 'Confirm status change',
) {
  const waiting = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `${base(id)}/state-changes` &&
      response.request().method() === 'POST',
  );
  await scope.getByRole('button', { name: label, exact: true }).click();
  const response = await waiting;
  expect(response.status(), await response.text()).toBe(code);
  return response;
}
async function closeConfirmed(dialog: Locator) {
  await expect(
    dialog.getByRole('heading', { name: 'Status change confirmed', exact: true }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Close status update', exact: true }).click();
  await expect(dialog).toBeHidden();
}
async function clearResources(
  request: APIRequestContext,
  headers: Record<string, string>,
  id: string,
) {
  const source = await get<AppointmentResourceContext>(request, `${base(id)}/resources`);
  const response = await request.put(`${base(id)}/resources`, {
    headers,
    data: {
      resourceIds: [],
      expectedRevision: source.revision,
      reason: 'PRIVATE explicitly released synthetic reservation',
      requestId: randomUUID(),
    },
  });
  expect(response.status(), await response.text()).toBe(200);
}

test('reception checks in a historical visit and a clinician starts and completes it without changing booked terms or recorded room reservations', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const admin = await login(page.request),
    original = await fixture(page.request, 'progression');
  const before = await get<AppointmentResourceContext>(
    page.request,
    `${base(original.id)}/resources`,
  );
  expect(before.resourceIds).toHaveLength(1);
  const reception = await browser.newContext({ baseURL }),
    own = await browser.newContext({ baseURL });
  try {
    const desk = await reception.newPage();
    await login(desk.request, 'reception@derma.demo');
    await login(own.request, 'patient@derma.demo');
    const activityBefore = await get<ActivityFeed>(own.request, '/api/activity?limit=100');
    let dialog = await open(desk, original);
    const reviewed = await context(desk.request, original.id);
    expect(reviewed.actions.find((value) => value.status === 'in-consultation')!.allowed).toBe(
      false,
    );
    await expect(
      dialog.getByRole('button', { name: 'Confirm status change', exact: true }),
    ).toBeDisabled();
    const doctor = (await get<Doctor[]>(page.request, '/api/doctors')).find(
      (value) => value.id === original.doctorId,
    )!;
    const profile = await page.request.patch(`/api/doctors/${doctor.id}`, {
      headers: admin.headers,
      data: { ...doctor, name: `${doctor.name} Updated`, fee: 950 },
    });
    expect(profile.status()).toBe(200);
    expect((await context(desk.request, original.id)).revision).toBe(reviewed.revision);
    await dialog.getByLabel(agreement, { exact: true }).check();
    const checked = (await (
      await confirm(desk, dialog, original.id)
    ).json()) as AppointmentStateChangeResult;
    expect(checked.event.before).toEqual(original);
    expect(checked.event.after).toEqual({ ...original, status: 'checked-in' });
    await closeConfirmed(dialog);
    const checkedRow = desk.getByRole('row').filter({ hasText: original.reason });
    await expect(checkedRow).toContainText('Checked in');
    await expect(checkedRow.getByRole('button', { name: 'Start visit', exact: true })).toHaveCount(
      0,
    );

    for (const [action, status] of [
      ['Start visit', 'in-consultation'],
      ['Complete', 'completed'],
    ] as const) {
      dialog = await open(page, original, action);
      await expect(dialog.locator('.appointment-state-change-source')).toContainText(
        original.doctorName,
      );
      await expect(dialog.locator('.appointment-state-change-source')).toContainText('₹650');
      await dialog.getByLabel(agreement, { exact: true }).check();
      const saved = (await (
        await confirm(page, dialog, original.id)
      ).json()) as AppointmentStateChangeResult;
      expect(saved.appointment).toEqual({ ...original, status });
      expect(saved.receipt.status).toBe(status);
      if (status === 'completed') {
        await expect(
          dialog.getByRole('heading', { name: 'Status change confirmed', exact: true }),
        ).toBeVisible();
        await audit(page);
        const closeButton = dialog.getByRole('button', {
          name: 'Close status update',
          exact: true,
        });
        await closeButton.scrollIntoViewIfNeeded();
        await expect(closeButton).toBeInViewport();
        await expect(
          dialog
            .locator('.appointment-state-change-current')
            .getByText('Completed', { exact: true }),
        ).toBeInViewport();
        await page.screenshot({
          path: testInfo.outputPath('appointment-state-completed-mobile.png'),
          fullPage: false,
        });
      }
      await closeConfirmed(dialog);
    }
    const retained = await get<AppointmentResourceContext>(
      page.request,
      `${base(original.id)}/resources`,
    );
    expect(retained.resourceIds).toEqual(before.resourceIds);
    expect(retained.history.filter((value) => value.source === 'appointment-status')).toHaveLength(
      3,
    );
    for (const event of retained.history.filter((value) => value.source === 'appointment-status')) {
      expect(event.after.resources).toEqual(before.history[0].after.resources);
      expect(event.after.appointment.date).toBe(original.date);
      expect(event.after.appointment.time).toBe(original.time);
      expect(event.after.appointment.durationMinutes).toBe(original.durationMinutes);
    }
    const notices = (await get<ActivityFeed>(own.request, '/api/activity?limit=100')).items.filter(
      (value) => !activityBefore.items.some((old) => old.id === value.id),
    );
    expect(notices).toHaveLength(3);
    expect(JSON.stringify(notices)).not.toContain('PRIVATE');
    const patientVisit = (await get<Appointment[]>(own.request, '/api/appointments')).find(
      (value) => value.id === original.id,
    )!;
    expect(patientVisit).toEqual({ ...original, status: 'completed' });
    expect(JSON.stringify(patientVisit)).not.toContain('expectedRevision');
    expect((await own.request.get(`${base(original.id)}/state-context`)).status()).toBe(403);
  } finally {
    await reception.close();
    await own.close();
  }
});

test('reviewed no-show releases a recorded reservation without editing billing or procedure plans and respects role, date and exact-start restrictions', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  const admin = await login(page.request),
    original = await fixture(page.request, 'no-show');
  const procedure = await post<ProcedureRecord>(page.request, admin.headers, '/api/procedures', {
    patientId: original.patientId,
    appointmentId: original.id,
    title: 'Synthetic state non-mutating procedure',
    indication: 'Patient-specific indication',
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
    items: [{ description: 'Unchanged state fixture charge', quantity: 1, unitAmountPaise: 9000 }],
  });
  const billBefore = await get<InvoiceDetail>(page.request, `/api/invoices/${invoice.id}`);
  let dialog = await open(page, original, 'Mark no-show');
  await dialog.getByLabel(agreement, { exact: true }).check();
  await audit(page);
  const submit = dialog.getByRole('button', { name: 'Confirm status change', exact: true });
  await submit.scrollIntoViewIfNeeded();
  await expect(submit).toBeInViewport();
  await expect(dialog.getByLabel(agreement, { exact: true })).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath('appointment-no-show-reviewed-mobile.png'),
    fullPage: false,
  });
  // Center the action above the clinic dialog's sticky close footer; merely
  // intersecting the viewport does not prove that the confirmation is unobscured.
  await submit.evaluate((button) =>
    button.scrollIntoView({ block: 'center', behavior: 'instant' }),
  );
  await expect(submit).toBeInViewport({ ratio: 1 });
  await expect(dialog.getByLabel(agreement, { exact: true })).toBeInViewport({ ratio: 1 });
  await expect
    .poll(() =>
      submit.evaluate((button) => {
        const bounds = button.getBoundingClientRect();
        const atCenter = document.elementFromPoint(
          bounds.x + bounds.width / 2,
          bounds.y + bounds.height / 2,
        );
        return !!atCenter && button.contains(atCenter);
      }),
    )
    .toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('appointment-no-show-confirm-mobile.png'),
    fullPage: false,
  });
  const result = (await (
    await confirm(page, dialog, original.id)
  ).json()) as AppointmentStateChangeResult;
  expect(result.appointment).toEqual({ ...original, status: 'no-show' });
  await closeConfirmed(dialog);
  const released = await get<AppointmentResourceContext>(
    page.request,
    `${base(original.id)}/resources`,
  );
  expect(released.resourceIds).toEqual([]);
  expect(released.history[0]).toMatchObject({
    source: 'appointment-status',
    after: { appointment: { status: 'no-show' }, resources: [] },
  });
  expect(await get<InvoiceDetail>(page.request, `/api/invoices/${invoice.id}`)).toEqual(billBefore);
  const retained = (
    await get<PatientClinicalWorkflows>(
      page.request,
      `/api/patients/${original.patientId}/clinical-workflows`,
    )
  ).procedures.find((value) => value.id === procedure.id)!;
  expect(retained.appointmentId).toBe(original.id);
  expect(retained.scheduledAppointment?.status).toBe('no-show');
  for (const field of [
    'title',
    'indication',
    'benefits',
    'risks',
    'alternatives',
    'aftercare',
    'agreements',
    'completion',
  ] as const)
    expect(retained[field]).toEqual(procedure[field]);

  const future = await fixture(page.request, 'future'),
    sameDay = await fixture(page.request, 'same-day');
  const futureContext = await context(page.request, future.id);
  expect(futureContext.actions.every((action) => !action.allowed)).toBe(true);
  await page.goto(`/clinic/appointments?date=${future.date}`);
  const futureRow = page.getByRole('row').filter({ hasText: future.reason });
  await expect(futureRow).toBeVisible();
  await expect(futureRow.getByRole('button', { name: 'Check in', exact: true })).toHaveCount(0);
  const futureDenied = await page.request.post(`${base(future.id)}/state-changes`, {
    headers: admin.headers,
    data: {
      status: 'checked-in',
      expectedRevision: futureContext.revision,
      changeConfirmed: true,
      requestId: randomUUID(),
    },
  });
  expect(futureDenied.status()).toBe(400);
  expect(await futureDenied.json()).toMatchObject({ stateChangeOutcome: 'not-applied' });
  const currentDay = await context(page.request, sameDay.id);
  expect(currentDay.actions.find((action) => action.status === 'checked-in')!.allowed).toBe(true);
  expect(currentDay.actions.find((action) => action.status === 'no-show')!.allowed).toBe(
    Date.parse(`${sameDay.date}T${sameDay.time}:00+05:30`) <= Date.parse(currentDay.generatedAt),
  );
  // Same-day check-in is valid before the scheduled time; it does not imply arrival timestamps.
  await change(page.request, admin.headers, sameDay.id, 'checked-in');
  const reception = await browser.newContext({ baseURL });
  try {
    const desk = await reception.newPage(),
      actor = await login(desk.request, 'reception@derma.demo');
    const started = await fixture(desk.request, 'already-started'),
      source = await context(desk.request, started.id);
    expect(source.actions.every((action) => !action.allowed)).toBe(true);
    const denied = await desk.request.post(`${base(started.id)}/state-changes`, {
      headers: actor.headers,
      data: {
        status: 'completed',
        expectedRevision: source.revision,
        changeConfirmed: true,
        requestId: randomUUID(),
      },
    });
    expect(denied.status()).toBe(403);
    expect(await denied.json()).not.toHaveProperty('stateChangeOutcome');
    await desk.goto(`/clinic/appointments?date=${started.date}`);
    await expect(
      desk
        .getByRole('row')
        .filter({ hasText: started.reason })
        .getByRole('button', { name: 'Complete', exact: true }),
    ).toHaveCount(0);
  } finally {
    await reception.close();
  }
});

test('an uncertain status command survives malformed receipts, later errors and close-resume, then confirms its original event after further progression', async ({
  page,
}, testInfo) => {
  const admin = await login(page.request),
    original = await fixture(page.request, 'retry');
  let dialog = await open(page, original);
  await dialog.getByLabel(agreement, { exact: true }).check();
  const attempts: AppointmentStateChangeInput[] = [];
  let first!: AppointmentStateChangeResult;
  await page.route(`**${base(original.id)}/state-changes`, async (route) => {
    attempts.push(route.request().postDataJSON());
    if (attempts.length === 1) {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      first = await response.json();
      await route.fulfill({
        status: 200,
        json: { ...first, event: { ...first.event, after: null } },
      });
    } else if (attempts.length === 2)
      await route.fulfill({
        status: 400,
        json: {
          error: 'Synthetic later validation response must retain the uncertain status request.',
        },
      });
    else if (attempts.length === 3 || attempts.length === 4) {
      const response = await route.fetch(),
        value = await response.json();
      await route.fulfill({
        status: 200,
        json: {
          ...value,
          receipt: {
            ...value.receipt,
            ...(attempts.length === 3 ? { actorId: 'user-reception' } : { status: 'completed' }),
          },
        },
      });
    } else if (attempts.length === 5)
      await route.fulfill({
        status: 409,
        json: {
          error: 'This request ID was already used for a different appointment state command.',
        },
      });
    else await route.continue();
  });
  await confirm(page, dialog, original.id, 200);
  await expect(
    dialog.getByRole('button', { name: 'Retry same request', exact: true }),
  ).toBeEnabled();
  await expect(dialog.getByLabel(agreement, { exact: true })).toBeDisabled();
  await audit(page);
  const retryButton = dialog.getByRole('button', { name: 'Retry same request', exact: true });
  await retryButton.scrollIntoViewIfNeeded();
  await expect(retryButton).toBeInViewport();
  await expect(dialog.locator('.notice-warning')).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath('appointment-state-pending-mobile.png'),
    fullPage: false,
  });
  await dialog.getByRole('button', { name: 'Close for now', exact: true }).click();
  const other = await fixture(page.request, 'navigation');
  await expect(
    page
      .getByRole('row')
      .filter({ hasText: other.reason })
      .getByRole('button', { name: 'Check in', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Resume status update', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Update appointment status', exact: true });
  await change(page.request, admin.headers, original.id, 'in-consultation');
  await change(page.request, admin.headers, original.id, 'completed');
  for (const code of [400, 200, 200, 409]) {
    await confirm(page, dialog, original.id, code, 'Retry same request');
    await expect(
      dialog.getByRole('button', { name: 'Retry same request', exact: true }),
    ).toBeEnabled();
    await expect(dialog.getByLabel(agreement, { exact: true })).toBeDisabled();
  }
  const replay = (await (
    await confirm(page, dialog, original.id, 200, 'Retry same request')
  ).json()) as AppointmentStateChangeResult;
  expect(replay.event).toEqual(first.event);
  expect(replay.receipt).toEqual(first.receipt);
  expect(replay.event.after.status).toBe('checked-in');
  expect(replay.appointment.status).toBe('completed');
  for (const body of attempts) expect(body).toEqual(attempts[0]);
  expect(attempts).toHaveLength(6);
  await expect(
    dialog.getByRole('heading', { name: 'Status change confirmed', exact: true }),
  ).toBeVisible();
  await expect(dialog.locator('.appointment-state-change-current')).toContainText('Completed');
  await dialog.locator('.appointment-state-change-original summary').click();
  await expect(dialog.locator('.appointment-state-change-original')).toContainText('Checked in');
  const retained = await get<AppointmentResourceContext>(
    page.request,
    `${base(original.id)}/resources`,
  );
  expect(retained.resourceIds).toHaveLength(1);
  expect(retained.history.filter((value) => value.source === 'appointment-status')).toHaveLength(3);
  await closeConfirmed(dialog);
  await expect(page.getByRole('row').filter({ hasText: original.reason })).toContainText(
    'Completed',
  );
});

test('stale source and resource changes require fresh review while only a matching durable rejection unlocks an uncommitted exact attempt', async ({
  page,
}) => {
  const admin = await login(page.request),
    original = await fixture(page.request, 'stale');
  let dialog = await open(page, original);
  await dialog.getByLabel(agreement, { exact: true }).check();
  const before = await context(page.request, original.id);
  const advanced = await change(page.request, admin.headers, original.id, 'checked-in');
  expect((await context(page.request, original.id)).revision).not.toBe(before.revision);
  await confirm(page, dialog, original.id, 409);
  await dialog.getByRole('button', { name: 'Refresh current visit', exact: true }).click();
  await expect(
    dialog.getByRole('heading', { name: 'This status change is not available', exact: true }),
  ).toBeVisible();
  await expect(dialog.locator('.appointment-state-change-source')).toContainText('Checked in');
  await expect(
    dialog.getByRole('button', { name: 'Confirm status change', exact: true }),
  ).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Keep current status', exact: true }).click();
  // A stale check-in must never silently become a Start visit command.
  dialog = await open(page, advanced.appointment, 'Start visit');
  await expect(dialog.getByLabel(agreement, { exact: true })).toBeEnabled();
  await expect(dialog.getByLabel(agreement, { exact: true })).not.toBeChecked();
  await dialog.getByLabel(agreement, { exact: true }).check();
  const attempts: AppointmentStateChangeInput[] = [];
  await page.route(`**${base(original.id)}/state-changes`, async (route) => {
    attempts.push(route.request().postDataJSON());
    if (attempts.length === 1) await route.abort('failed');
    else if (attempts.length === 2)
      await route.fulfill({
        status: 409,
        json: {
          error: 'A different actor rejection cannot discard this pending change.',
          stateChangeOutcome: 'not-applied',
          requestId: attempts[0].requestId,
          actorId: 'user-reception',
          patientId: original.patientId,
          appointmentId: original.id,
        },
      });
    else await route.continue();
  });
  await dialog.getByRole('button', { name: 'Confirm status change', exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: 'Retry same request', exact: true }),
  ).toBeEnabled();
  await clearResources(page.request, admin.headers, original.id);
  await confirm(page, dialog, original.id, 409, 'Retry same request');
  await expect(
    dialog.getByRole('button', { name: 'Retry same request', exact: true }),
  ).toBeEnabled();
  await expect(dialog.getByLabel(agreement, { exact: true })).toBeDisabled();
  const rejected = await confirm(page, dialog, original.id, 409, 'Retry same request');
  expect(await rejected.json()).toMatchObject({
    stateChangeOutcome: 'not-applied',
    actorId: admin.session.user!.id,
    patientId: original.patientId,
    appointmentId: original.id,
    requestId: attempts[0].requestId,
  });
  await expect(dialog.getByRole('button', { name: 'Retry same request', exact: true })).toHaveCount(
    0,
  );
  await dialog.getByRole('button', { name: 'Refresh current visit', exact: true }).click();
  await expect(dialog.getByLabel(agreement, { exact: true })).toBeEnabled();
  await expect(dialog.getByLabel(agreement, { exact: true })).not.toBeChecked();
  const fresh = await context(page.request, original.id);
  expect(fresh.appointment).toEqual(advanced.appointment);
  expect(JSON.stringify(fresh)).not.toContain('PRIVATE');
  const oldReplay = await page.request.post(`${base(original.id)}/state-changes`, {
    headers: admin.headers,
    data: attempts[0],
  });
  expect(oldReplay.status()).toBe(409);
  expect(await oldReplay.json()).toMatchObject({
    stateChangeOutcome: 'not-applied',
    requestId: attempts[0].requestId,
  });
  await dialog.getByLabel(agreement, { exact: true }).check();
  const saved = (await (
    await confirm(page, dialog, original.id)
  ).json()) as AppointmentStateChangeResult;
  expect(saved.event.before).toEqual(advanced.appointment);
  expect(saved.event.after).toEqual({ ...original, status: 'in-consultation' });
  expect(attempts.slice(0, 3)).toEqual([attempts[0], attempts[0], attempts[0]]);
  expect(attempts[3].requestId).not.toBe(attempts[0].requestId);
  expect(attempts[3].expectedRevision).toBe(fresh.revision);
  await closeConfirmed(dialog);
});

test('source-read recovery and native navigation suppress obsolete status replies and late authorization errors after leaving and returning', async ({
  page,
}) => {
  const admin = await login(page.request),
    original = await fixture(page.request, 'navigation');
  const contextRoute = `**${base(original.id)}/state-context`;
  let failRead = true;
  await page.route(contextRoute, (route) =>
    failRead
      ? route.fulfill({
          status: 503,
          json: { error: 'Synthetic status review is temporarily unavailable.' },
        })
      : route.continue(),
  );
  await page.goto(`/clinic/appointments?date=${original.date}`);
  await page
    .getByRole('row')
    .filter({ hasText: original.reason })
    .getByRole('button', { name: 'Check in', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Update appointment status', exact: true });
  await expect(
    dialog.getByText('Synthetic status review is temporarily unavailable.', { exact: true }),
  ).toBeVisible();
  failRead = false;
  await dialog.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(dialog.locator('.appointment-state-change-source')).toBeVisible();
  await page.unroute(contextRoute);
  await observeResponses(page);
  const seen = deferred(),
    release = deferred();
  let saved!: AppointmentStateChangeResult;
  await page.route(`**${base(original.id)}/state-changes`, async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    saved = await response.json();
    seen.resolve();
    await release.promise;
    await route
      .fulfill({
        response,
        headers: { ...response.headers(), 'X-Test-State-Settled': 'old-committed-status' },
      })
      .catch(() => undefined);
  });
  await dialog.getByLabel(agreement, { exact: true }).check();
  await dialog.getByRole('button', { name: 'Confirm status change', exact: true }).click();
  await seen.promise;
  await expect(dialog.getByRole('button', { name: 'Close for now', exact: true })).toBeDisabled();
  await navigate(page, '/clinic/patients');
  await expect(page.getByLabel('Search patient directory', { exact: true })).toBeVisible();
  await page.goBack();
  const row = page.getByRole('row').filter({ hasText: original.reason });
  await expect(row).toContainText('Checked in');
  const returned = page.url();
  release.resolve();
  await consumed(page, 'old-committed-status');
  await expect(page).toHaveURL(returned);
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Status change confirmed', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Resume status update', exact: true })).toHaveCount(
    0,
  );
  const replay = await post<AppointmentStateChangeResult>(
    page.request,
    admin.headers,
    `${base(original.id)}/state-changes`,
    {
      status: saved.receipt.status,
      expectedRevision: saved.receipt.expectedRevision,
      changeConfirmed: true,
      requestId: saved.receipt.requestId,
    },
    200,
  );
  expect(replay).toEqual(saved);
  await page.unroute(`**${base(original.id)}/state-changes`);
  const another = await fixture(page.request, 'read-navigation');
  const readSeen = deferred(),
    readRelease = deferred();
  await page.route(`**${base(another.id)}/state-context`, async (route) => {
    readSeen.resolve();
    await readRelease.promise;
    await route
      .fulfill({
        status: 401,
        json: { error: 'Obsolete status context must not expire the current session.' },
        headers: { 'X-Test-State-Settled': 'old-state-401' },
      })
      .catch(() => undefined);
  });
  await page
    .getByRole('row')
    .filter({ hasText: another.reason })
    .getByRole('button', { name: 'Check in', exact: true })
    .click();
  await readSeen.promise;
  await navigate(page, '/account');
  await expect(
    page.getByRole('heading', { name: 'Your account & security', exact: true }),
  ).toBeVisible();
  readRelease.resolve();
  await consumed(page, 'old-state-401');
  expect(
    await page.evaluate(() => (window as Window & { stateExpired?: number }).stateExpired),
  ).toBe(0);
  await expect(page).toHaveURL(/\/account$/);
  await expect(
    page.getByText('Obsolete status context must not expire the current session.', { exact: true }),
  ).toHaveCount(0);
  await page.unroute(`**${base(another.id)}/state-context`);
  await page.goBack();
  await expect(page.getByRole('row').filter({ hasText: another.reason })).toContainText(
    'Scheduled',
  );
  await expect(dialog).toHaveCount(0);
  expect((await get<Session>(page.request, '/api/session')).user?.id).toBe(admin.session.user!.id);
});
