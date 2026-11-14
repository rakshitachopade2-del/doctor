import { test, expect, type APIRequestContext, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import type { Appointment, Doctor, Session } from '../../shared/types';
import type { ActivityFeed } from '../../shared/activity';
import type { VisitDurationContext, VisitDurationMutation } from '../../shared/visit-duration';
import type {
  AppointmentReminderPolicy,
  AppointmentReminderPolicyContext,
  AppointmentReminderPolicyMutation,
  AppointmentReminderPreview,
  AppointmentReminderRun,
  AppointmentReminderRunSummary,
  AppointmentReminderPage,
  AppointmentReminderHistory,
} from '../../shared/appointment-reminders';

const home = '/clinic/appointment-reminders',
  policyPath = '/api/appointment-reminder-policy',
  previewPath = '/api/appointment-reminders/preview',
  runPath = '/api/appointment-reminders/run',
  runsPath = '/api/appointment-reminders/runs';
const confirmation = 'I reviewed these patient recipients and appointment details.';
const defaults: AppointmentReminderPolicy = { enabled: false, leadHours: 24 };
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
) {
  const response = await request.patch(`/api/appointments/${appointmentId}`, { headers, data });
  expect(response.status(), await response.text()).toBe(200);
  return response.json() as Promise<Appointment>;
}
async function policy(
  request: APIRequestContext,
  headers: Record<string, string>,
  value: AppointmentReminderPolicy,
  reason = 'PRIVATE synthetic reminder configuration',
) {
  const current = await get<AppointmentReminderPolicyContext>(request, policyPath);
  if (current.policy.enabled === value.enabled && current.policy.leadHours === value.leadHours)
    return current;
  return (
    await post<AppointmentReminderPolicyMutation>(
      request,
      headers,
      policyPath,
      { ...value, reason, expectedRevision: current.revision, requestId: randomUUID() },
      201,
    )
  ).context;
}
async function doctor(request: APIRequestContext, headers: Record<string, string>) {
  const value = await post<Doctor>(request, headers, '/api/doctors', {
    name: `Dr. Reminder ${randomUUID().slice(0, 8)}`,
    title: 'Dermatologist',
    qualifications: 'Synthetic profile',
    specialties: ['General dermatology'],
    experience: 5,
    fee: 700,
    bio: 'Synthetic appointment reminder verification.',
    languages: ['English'],
  });
  const response = await request.put(`/api/schedules/${value.id}`, {
    headers,
    data: {
      durationMinutes: 30,
      windows: Array.from({ length: 7 }, (_, day) => ({
        day,
        start: '08:00',
        end: '18:00',
        mode: 'both',
      })),
    },
  });
  expect(response.status(), await response.text()).toBe(200);
  return value;
}
async function appointment(
  request: APIRequestContext,
  headers: Record<string, string>,
  doctorId: string,
  date: string,
  time = '14:00',
  patientId = 'patient-ananya',
) {
  return post<Appointment>(request, headers, '/api/appointments', {
    patientId,
    doctorId,
    date,
    time,
    mode: 'in-person',
    reason: `PRIVATE visit reason ${randomUUID()}`,
  });
}
const policyDialog = (page: Page) =>
  page.getByRole('dialog', { name: 'Appointment reminder policy', exact: true });
const previewDialog = (page: Page) =>
  page.getByRole('dialog', { name: 'Preview appointment reminders', exact: true });
const responseFor = (page: Page, path: string, method = 'POST') =>
  page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === path && response.request().method() === method,
  );
async function openPreview(page: Page) {
  const waiting = responseFor(page, previewPath, 'GET');
  await page.getByRole('button', { name: 'Preview reminders', exact: true }).click();
  const response = await waiting;
  expect(response.status(), await response.text()).toBe(200);
  const value = (await response.json()) as AppointmentReminderPreview;
  await expect(previewDialog(page)).toBeVisible();
  return value;
}
async function run(page: Page) {
  await previewDialog(page).getByLabel(confirmation, { exact: true }).check();
  const waiting = responseFor(page, runPath);
  await previewDialog(page)
    .getByRole('button', { name: 'Create in-app reminders', exact: true })
    .click();
  const response = await waiting;
  expect(response.status(), await response.text()).toBe(201);
  const value = (await response.json()) as AppointmentReminderRun;
  await expect(page.locator('.reminder-run-receipt')).toBeVisible();
  await expect(previewDialog(page)).toBeHidden();
  return value;
}
function assertRun(
  value: AppointmentReminderRun,
  source: AppointmentReminderPreview,
  actorId: string,
) {
  expect(value).toMatchObject({
    source: 'manual',
    createdById: actorId,
    previewRevision: source.revision,
    policyRevision: source.policyRevision,
    policy: source.policy,
    noticeCount: source.items.length,
  });
  expect(
    value.events.map(
      ({
        id: _id,
        runId: _runId,
        source: _source,
        policy: _policy,
        policyRevision: _policyRevision,
        createdAt: _createdAt,
        ...candidate
      }) => candidate,
    ),
  ).toEqual(source.items);
  for (const event of value.events)
    expect(event).toMatchObject({
      runId: value.id,
      source: 'manual',
      policy: source.policy,
      policyRevision: source.policyRevision,
    });
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

test('administrators create only eligible in-app reminders and patient links focus current own visits without changing historical notices or read state', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(120000);
  const { headers, session } = await login(page.request),
    clinician = await doctor(page.request, headers);
  const own = await browser.newContext({ baseURL });
  try {
    await login(own.request, 'patient@derma.demo');
    await policy(page.request, headers, defaults);
    const visit = await appointment(page.request, headers, clinician.id, day(2));
    const duration = await get<VisitDurationContext>(
      page.request,
      `/api/appointments/${visit.id}/duration`,
    );
    const saved = await post<VisitDurationMutation>(
      page.request,
      headers,
      `/api/appointments/${visit.id}/duration`,
      {
        durationPolicy: 'custom',
        durationMinutes: 60,
        date: visit.date,
        time: visit.time,
        reason: 'PRIVATE length explanation',
        expectedRevision: duration.revision,
        requestId: randomUUID(),
      },
      200,
    );
    const cancelled = await appointment(page.request, headers, clinician.id, day(2), '16:00');
    await patch(page.request, headers, cancelled.id, { status: 'cancelled' });
    const distant = await appointment(page.request, headers, clinician.id, day(45));
    const noPortal = await post<{ id: string; name: string }>(
      page.request,
      headers,
      '/api/patients',
      {
        name: `No portal ${randomUUID().slice(0, 8)}`,
        email: '',
        phone: '9000000261',
        dob: '',
        gender: '',
      },
    );
    const unroutable = await appointment(
      page.request,
      headers,
      clinician.id,
      day(2),
      '15:00',
      noPortal.id,
    );
    await page.goto(home);
    await page.getByRole('button', { name: 'Edit reminder policy', exact: true }).click();
    await expect(
      policyDialog(page).getByLabel('Enable in-app appointment reminders', { exact: true }),
    ).not.toBeChecked();
    await policyDialog(page)
      .getByLabel('Enable in-app appointment reminders', { exact: true })
      .check();
    await policyDialog(page).getByLabel('Hours before appointment', { exact: true }).fill('168');
    const reason = `PRIVATE reviewed reminder policy ${randomUUID()}`;
    await policyDialog(page).getByLabel('Reason for policy change', { exact: true }).fill(reason);
    const save = responseFor(page, policyPath);
    await policyDialog(page)
      .getByRole('button', { name: 'Save reminder policy', exact: true })
      .click();
    const policyResponse = await save;
    expect(policyResponse.status()).toBe(201);
    await expect(policyDialog(page)).toBeHidden();
    await expect(page.locator('.reminder-policy-history')).toContainText(reason);
    const source = await openPreview(page);
    expect(source.status).toBe('ready');
    const candidate = source.items.find((item) => item.appointment.id === visit.id)!;
    expect(candidate).toBeTruthy();
    expect(candidate.appointment.durationMinutes).toBe(60);
    expect(candidate.recipient.id).toBe('user-patient');
    expect(
      source.items.some((item) =>
        [cancelled.id, distant.id, unroutable.id].includes(item.appointment.id),
      ),
    ).toBe(false);
    expect(source.unroutableTotal).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(source)).not.toContain(visit.reason);
    expect(JSON.stringify(source)).not.toContain(reason);
    const candidateCard = previewDialog(page)
      .locator('.reminder-preview-candidate')
      .filter({ hasText: clinician.name });
    await expect(candidateCard).toHaveCount(1);
    await expect(candidateCard).toContainText('60 minutes');
    await expect(
      previewDialog(page).getByRole('button', { name: 'Create in-app reminders', exact: true }),
    ).toBeDisabled();
    const created = await run(page);
    assertRun(created, source, session.user!.id);
    const history = await get<AppointmentReminderHistory>(
      page.request,
      `/api/appointments/${visit.id}/reminders`,
    );
    expect(history.total).toBe(1);
    expect(history.current.state).toBe('recorded');
    const again = await get<AppointmentReminderPreview>(page.request, previewPath);
    expect(again.items.some((item) => item.appointment.id === visit.id)).toBe(false);
    expect(again.alreadyRecordedTotal).toBeGreaterThanOrEqual(1);
    await page.goto(home);
    const deduped = await openPreview(page);
    expect(deduped.items).toEqual([]);
    expect(deduped.readyTotal).toBe(0);
    await expect(
      previewDialog(page).getByRole('button', { name: 'Create in-app reminders', exact: true }),
    ).toBeDisabled();
    expect(
      (
        await page.request.post(runPath, {
          headers,
          data: {
            expectedPreviewRevision: deduped.revision,
            expectedPolicyRevision: deduped.policyRevision,
            confirmed: true,
            requestId: randomUUID(),
          },
        })
      ).status(),
    ).toBe(409);
    expect(
      (
        await get<AppointmentReminderHistory>(
          page.request,
          `/api/appointments/${visit.id}/reminders`,
        )
      ).total,
    ).toBe(1);

    const inbox = await get<ActivityFeed>(own.request, '/api/activity?limit=100');
    const notice = inbox.items.find(
      (item) =>
        item.title === 'Upcoming appointment reminder' &&
        item.href === `/my-care?appointment=${visit.id}`,
    )!;
    expect(notice).toBeTruthy();
    expect(notice.readAt).toBeNull();
    expect(notice.detail).toContain(clinician.name);
    expect(notice.detail).toContain('60');
    for (const privateText of [
      reason,
      visit.reason,
      'PRIVATE length explanation',
      noPortal.name,
      created.requestId!,
      created.events[0].id,
    ])
      expect(JSON.stringify(inbox)).not.toContain(privateText);
    const patient = await own.newPage();
    await patient.goto('/my-care/activity');
    const noticeCard = patient
      .locator('.activity-item')
      .filter({
        has: patient.getByRole('link', { name: 'Upcoming appointment reminder', exact: true }),
      })
      .filter({ hasText: clinician.name });
    await expect(noticeCard).toHaveCount(1);
    await noticeCard
      .getByRole('link', { name: 'Upcoming appointment reminder', exact: true })
      .click();
    await expect(patient).toHaveURL(new RegExp(`appointment=${visit.id}$`));
    const selected = patient.locator('.patient-selected-appointment');
    await expect(selected).toBeFocused();
    await expect(
      selected.getByRole('heading', { name: 'Current appointment details', exact: true }),
    ).toBeVisible();
    await expect(selected).toContainText('Earlier activity notices are recorded history.');
    await expect(selected).toContainText('14:00–15:00 IST');
    await expect(patient.locator(`[data-appointment-id="${visit.id}"]`)).toHaveCount(1);
    expect(
      (await get<ActivityFeed>(own.request, '/api/activity?limit=100')).items.find(
        (item) => item.id === notice.id,
      )?.readAt,
    ).toBeNull();
    const calendar = await own.request.get(`/api/appointments/${visit.id}/calendar`);
    expect(calendar.status()).toBe(200);
    expect(await calendar.text()).toContain(`DTSTART:${visit.date.replaceAll('-', '')}T083000Z`);
    expect(await calendar.text()).toContain(`DTEND:${visit.date.replaceAll('-', '')}T093000Z`);
    const download = patient.waitForEvent('download');
    await selected.getByRole('link', { name: 'Add to calendar', exact: true }).click();
    expect((await download).suggestedFilename()).toBe('appointment.ics');
    await audit(patient);
    await patient.screenshot({
      path: testInfo.outputPath('appointment-reminder-current-mobile.png'),
      fullPage: true,
    });
    await selected.getByRole('button', { name: 'Cancel', exact: true }).click();
    await patient
      .getByRole('dialog', { name: 'Cancel this appointment?', exact: true })
      .getByRole('button', { name: 'Confirm cancellation', exact: true })
      .click();
    await expect(selected).toBeFocused();
    await expect(selected).toContainText('cancelled');
    await expect(selected.getByRole('link', { name: 'Reschedule', exact: true })).toHaveCount(0);
    await expect(selected.getByRole('link', { name: 'Add to calendar', exact: true })).toHaveCount(
      0,
    );
    await expect(selected.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
    expect(
      (await get<ActivityFeed>(own.request, '/api/activity?limit=100')).items.find(
        (item) => item.id === notice.id,
      ),
    ).toEqual(notice);
    const current = await get<AppointmentReminderHistory>(
      page.request,
      `/api/appointments/${visit.id}/reminders`,
    );
    expect(current.current.state).toBe('not-scheduled');
    expect(current.items).toEqual(history.items);
    expect(current.items[0].appointment).toMatchObject({
      status: 'scheduled',
      durationMinutes: saved.appointment.durationMinutes,
    });
    await patient.goto(`/my-care?appointment=${unroutable.id}`);
    await expect(
      selected.getByRole('heading', { name: 'Appointment unavailable', exact: true }),
    ).toBeVisible();
    await expect(selected).toBeFocused();
    const unavailable = await selected.innerText();
    expect(unavailable).not.toContain(noPortal.name);
    await patient.goto(`/my-care?appointment=${randomUUID()}`);
    await expect(selected).toHaveText(unavailable, { useInnerText: true });
    const past = (await get<Appointment[]>(own.request, '/api/appointments')).find(
      (item) => item.date < day(0),
    )!;
    expect(past).toBeTruthy();
    await patient.goto(`/my-care?appointment=${past.id}`);
    await expect(selected).toBeFocused();
    await expect(selected).toContainText(past.doctorName);
    await expect(selected.getByRole('link', { name: 'Add to calendar', exact: true })).toHaveCount(
      0,
    );
    await patient.goto('/my-care/activity');
    await noticeCard.getByRole('button', { name: 'Mark read', exact: true }).click();
    await expect(noticeCard).toContainText('Read');
    expect(
      (await get<ActivityFeed>(own.request, '/api/activity?limit=100')).items.find(
        (item) => item.id === notice.id,
      )?.readAt,
    ).toBeTruthy();
  } finally {
    await policy(page.request, headers, defaults);
    await own.close();
  }
});

test('stale policy and appointment previews require fresh review while uncertain reminder runs retain their exact identity through malformed receipts and later errors', async ({
  page,
}) => {
  test.setTimeout(120000);
  const { headers, session } = await login(page.request),
    clinician = await doctor(page.request, headers);
  try {
    await policy(page.request, headers, { enabled: true, leadHours: 168 });
    const visit = await appointment(page.request, headers, clinician.id, day(3));
    await page.goto(home);
    await page.getByRole('button', { name: 'Edit reminder policy', exact: true }).click();
    const reason = `PRIVATE retained policy draft ${randomUUID()}`;
    await policyDialog(page).getByLabel('Hours before appointment', { exact: true }).fill('120');
    await policyDialog(page).getByLabel('Reason for policy change', { exact: true }).fill(reason);
    const external = await policy(
      page.request,
      headers,
      { enabled: false, leadHours: 96 },
      'PRIVATE competing policy change',
    );
    const stalePolicy = responseFor(page, policyPath);
    await policyDialog(page)
      .getByRole('button', { name: 'Save reminder policy', exact: true })
      .click();
    expect((await stalePolicy).status()).toBe(409);
    await policyDialog(page)
      .getByRole('button', { name: 'Refresh latest policy', exact: true })
      .click();
    await expect(
      policyDialog(page).getByLabel('Hours before appointment', { exact: true }),
    ).toHaveValue('120');
    await expect(
      policyDialog(page).getByLabel('Reason for policy change', { exact: true }),
    ).toHaveValue(reason);
    await policyDialog(page)
      .getByRole('button', { name: 'I reviewed the latest policy; keep my draft', exact: true })
      .click();
    const save = responseFor(page, policyPath);
    await policyDialog(page)
      .getByRole('button', { name: 'Save reminder policy', exact: true })
      .click();
    const saved = await save;
    expect(saved.status()).toBe(201);
    expect(saved.request().postDataJSON().expectedRevision).toBe(external.revision);
    await expect(policyDialog(page)).toBeHidden();
    const first = await openPreview(page);
    expect(first.items.some((item) => item.appointment.id === visit.id)).toBe(true);
    const moved = await patch(page.request, headers, visit.id, { mode: 'online' });
    await previewDialog(page).getByLabel(confirmation, { exact: true }).check();
    const staleRun = responseFor(page, runPath);
    await previewDialog(page)
      .getByRole('button', { name: 'Create in-app reminders', exact: true })
      .click();
    const stale = await staleRun;
    expect(stale.status()).toBe(409);
    const oldBody = stale.request().postDataJSON();
    await expect(previewDialog(page).getByLabel(confirmation, { exact: true })).not.toBeChecked();
    const refresh = responseFor(page, previewPath, 'GET');
    await previewDialog(page)
      .getByRole('button', { name: 'Refresh reminder preview', exact: true })
      .click();
    const refreshed = await refresh;
    expect(refreshed.status()).toBe(200);
    const current = (await refreshed.json()) as AppointmentReminderPreview;
    expect(current.revision).not.toBe(first.revision);
    expect(current.items.find((item) => item.appointment.id === visit.id)?.appointment.mode).toBe(
      'online',
    );
    await expect(
      previewDialog(page)
        .locator('.reminder-preview-candidate')
        .filter({ hasText: clinician.name }),
    ).toContainText('Online');
    await expect(previewDialog(page).getByLabel(confirmation, { exact: true })).not.toBeChecked();
    type RunBody = {
      expectedPreviewRevision: string;
      expectedPolicyRevision: string;
      confirmed: true;
      requestId: string;
    };
    const bodies: RunBody[] = [];
    let committed: AppointmentReminderRun | undefined;
    const uncertain = async (route: Route) => {
      bodies.push(route.request().postDataJSON());
      if (bodies.length === 2) {
        await route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'Synthetic later rejection must preserve this reminder request.',
          }),
        });
        return;
      }
      const response = await route.fetch();
      expect(response.status()).toBe(bodies.length === 1 ? 201 : 200);
      const value = (await response.json()) as AppointmentReminderRun;
      if (bodies.length === 1) {
        committed = value;
        await route.fulfill({ response, json: { ...value, events: [null] } });
      } else if (bodies.length === 3)
        await route.fulfill({ response, json: { ...value, createdById: 'wrong-current-account' } });
      else await route.fulfill({ response });
    };
    await page.route(`**${runPath}`, uncertain);
    try {
      await previewDialog(page).getByLabel(confirmation, { exact: true }).check();
      await previewDialog(page)
        .getByRole('button', { name: 'Create in-app reminders', exact: true })
        .click();
      await expect(
        previewDialog(page).getByRole('button', { name: 'Retry same request', exact: true }),
      ).toBeEnabled();
      await expect(previewDialog(page).getByLabel(confirmation, { exact: true })).toBeDisabled();
      await page.keyboard.press('Escape');
      await expect(previewDialog(page)).toBeVisible();
      await previewDialog(page).getByRole('button', { name: 'Close dialog', exact: true }).click();
      await expect(previewDialog(page)).toBeVisible();
      await patch(page.request, headers, visit.id, { status: 'cancelled' });
      await policy(page.request, headers, defaults);
      await previewDialog(page)
        .getByRole('button', { name: 'Retry same request', exact: true })
        .click();
      await expect(previewDialog(page).getByRole('alert')).toContainText(
        'Synthetic later rejection',
      );
      await expect(previewDialog(page).getByLabel(confirmation, { exact: true })).toBeDisabled();
      await previewDialog(page)
        .getByRole('button', { name: 'Retry same request', exact: true })
        .click();
      await expect(
        previewDialog(page).getByRole('button', { name: 'Retry same request', exact: true }),
      ).toBeEnabled();
      await expect(previewDialog(page)).toBeVisible();
      await expect(page.locator('.reminder-run-receipt')).toHaveCount(0);
      const retry = responseFor(page, runPath);
      await previewDialog(page)
        .getByRole('button', { name: 'Retry same request', exact: true })
        .click();
      const replay = await retry;
      expect(replay.status()).toBe(200);
      expect(await replay.json()).toEqual(committed);
      assertRun(committed!, current, session.user!.id);
      await expect(previewDialog(page)).toBeHidden();
      await expect(page).toHaveURL(new RegExp(`run=${committed!.id}$`));
      await expect(page.locator('.reminder-run-receipt')).toBeVisible();
      expect(bodies).toHaveLength(4);
      for (const body of bodies) expect(body).toEqual(bodies[0]);
      expect(bodies[0].requestId).not.toBe(oldBody.requestId);
      expect(bodies[0].expectedPreviewRevision).toBe(current.revision);
      const history = await get<AppointmentReminderHistory>(
        page.request,
        `/api/appointments/${visit.id}/reminders`,
      );
      expect(history.total).toBe(1);
      expect(history.current.state).toBe('disabled');
      expect(history.items[0].appointment).toMatchObject({
        id: moved.id,
        mode: 'online',
        status: 'scheduled',
      });
      const runs = await get<AppointmentReminderPage<AppointmentReminderRunSummary>>(
        page.request,
        `${runsPath}?pageSize=50`,
      );
      expect(runs.items.filter((item) => item.requestId === bodies[0].requestId)).toHaveLength(1);
    } finally {
      await page.unroute(`**${runPath}`, uncertain);
    }
  } finally {
    await policy(page.request, headers, defaults);
  }
});

test('staff read reminder evidence without administrative powers and obsolete preview, run and history responses cannot affect a new screen or session', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(150000);
  const { headers } = await login(page.request),
    clinician = await doctor(page.request, headers);
  const reception = await browser.newContext({ baseURL }),
    own = await browser.newContext({ baseURL });
  try {
    const { headers: receptionHeaders } = await login(reception.request, 'reception@derma.demo');
    await login(own.request, 'patient@derma.demo');
    await policy(page.request, headers, { enabled: true, leadHours: 168 });
    const historyFixture = await appointment(page.request, headers, clinician.id, day(4), '15:00');
    const historyPreview = await get<AppointmentReminderPreview>(page.request, previewPath);
    expect(historyPreview.items.some((item) => item.appointment.id === historyFixture.id)).toBe(
      true,
    );
    await post<AppointmentReminderRun>(page.request, headers, runPath, {
      expectedPreviewRevision: historyPreview.revision,
      expectedPolicyRevision: historyPreview.policyRevision,
      confirmed: true,
      requestId: randomUUID(),
    });
    const visit = await appointment(page.request, headers, clinician.id, day(4));
    let failReads = true;
    const failHistory = async (route: Route) => {
      if (failReads)
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Synthetic reminder check history is unavailable.' }),
        });
      else await route.continue();
    };
    await page.route(`**${runsPath}?*`, failHistory);
    try {
      await page.goto(home);
      const history = page.locator('.reminder-runs');
      await expect(history.getByRole('alert')).toContainText(
        'Synthetic reminder check history is unavailable.',
      );
      failReads = false;
      await history.getByRole('button', { name: 'Try again', exact: true }).click();
      await expect(history.getByRole('alert')).toHaveCount(0);
      await expect(history.locator('.reminder-run-row').first()).toBeVisible();
    } finally {
      await page.unroute(`**${runsPath}?*`, failHistory);
    }
    await page.evaluate(() => {
      const state = window as unknown as {
        reminderBodies: Record<string, number>;
        reminderExpired: number;
      };
      state.reminderBodies = {};
      state.reminderExpired = 0;
      window.addEventListener('derma:session-expired', () => state.reminderExpired++);
      const original = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const response = await original(input, init),
          url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const path = new URL(url, window.location.origin).pathname;
        if (path.startsWith('/api/appointment-reminder')) {
          const json = response.json.bind(response);
          response.json = async () => {
            try {
              return await json();
            } finally {
              const key = `${init?.method ?? 'GET'} ${path} ${response.status}`;
              state.reminderBodies[key] = (state.reminderBodies[key] ?? 0) + 1;
            }
          };
        }
        return response;
      };
    });
    const previewReady = deferred(),
      releasePreview = deferred(),
      previewDone = deferred();
    const heldPreview = async (route: Route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      previewReady.resolve();
      await releasePreview.promise;
      try {
        await route.fulfill({ response });
      } finally {
        previewDone.resolve();
      }
    };
    await page.route(`**${previewPath}`, heldPreview);
    try {
      await page.getByRole('button', { name: 'Preview reminders', exact: true }).click();
      await previewReady.promise;
      await page.evaluate(() => {
        window.history.pushState({ key: 'reminder-preview-away' }, '', '/clinic/appointments');
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
      await expect(page.getByLabel('Search appointments', { exact: true })).toBeVisible();
      await page.goBack();
      await expect(
        page.getByRole('heading', { name: 'Appointment reminders', exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      releasePreview.resolve();
      await previewDone.promise;
      await page.waitForFunction(
        (key) =>
          (window as unknown as { reminderBodies: Record<string, number> }).reminderBodies[key] >=
          1,
        `GET ${previewPath} 200`,
      );
      await expect(page.getByRole('dialog')).toHaveCount(0);
    } finally {
      releasePreview.resolve();
      await page.unroute(`**${previewPath}`, heldPreview);
    }
    const source = await openPreview(page);
    expect(source.items.some((item) => item.appointment.id === visit.id)).toBe(true);
    await expect(previewDialog(page).getByLabel(confirmation, { exact: true })).not.toBeChecked();
    const runReady = deferred(),
      releaseRun = deferred(),
      runDone = deferred();
    let committed: AppointmentReminderRun | undefined;
    const heldRun = async (route: Route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      committed = (await response.json()) as AppointmentReminderRun;
      runReady.resolve();
      await releaseRun.promise;
      try {
        await route.fulfill({ response });
      } finally {
        runDone.resolve();
      }
    };
    await page.route(`**${runPath}`, heldRun);
    try {
      await previewDialog(page).getByLabel(confirmation, { exact: true }).check();
      await previewDialog(page)
        .getByRole('button', { name: 'Create in-app reminders', exact: true })
        .click();
      await runReady.promise;
      await page.evaluate(() => {
        window.history.pushState({ key: 'reminder-run-away' }, '', '/clinic/appointments');
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
      await expect(page.getByLabel('Search appointments', { exact: true })).toBeVisible();
      await page.goBack();
      await expect(
        page.getByRole('heading', { name: 'Appointment reminders', exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      releaseRun.resolve();
      await runDone.promise;
      await page.waitForFunction(
        (key) =>
          (window as unknown as { reminderBodies: Record<string, number> }).reminderBodies[key] >=
          1,
        `POST ${runPath} 201`,
      );
      await expect(page).toHaveURL(new RegExp(`${home}$`));
      await expect(page.locator('.reminder-run-receipt')).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: 'Dismiss notification', exact: true }),
      ).toHaveCount(0);
      expect(
        await get<AppointmentReminderRun>(page.request, `${runsPath}/${committed!.id}`),
      ).toEqual(committed);
    } finally {
      releaseRun.resolve();
      await page.unroute(`**${runPath}`, heldRun);
    }

    const readReady = deferred(),
      releaseRead = deferred();
    let held = 0,
      settled = 0;
    const lateHistory = async (route: Route) => {
      held++;
      readReady.resolve();
      await releaseRead.promise;
      try {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'Discarded reminder history must not sign out the current account.',
          }),
        });
      } finally {
        settled++;
      }
    };
    await page.evaluate(() => {
      window.history.pushState({ key: 'reminder-history-away' }, '', '/clinic/appointments');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.getByLabel('Search appointments', { exact: true })).toBeVisible();
    await page.route(`**${runsPath}?*`, lateHistory);
    try {
      await page.evaluate((url) => {
        window.history.pushState({ key: 'reminder-history-source' }, '', url);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }, home);
      await readReady.promise;
      await page.goBack();
      await expect(page.getByLabel('Search appointments', { exact: true })).toBeVisible();
      const count = held;
      expect(count).toBeGreaterThan(0);
      releaseRead.resolve();
      await expect.poll(() => settled).toBe(count);
      await page.waitForFunction(
        ({ key, count }) =>
          (window as unknown as { reminderBodies: Record<string, number> }).reminderBodies[key] >=
          count,
        { key: `GET ${runsPath} 401`, count },
      );
      expect(
        await page.evaluate(
          () => (window as unknown as { reminderExpired: number }).reminderExpired,
        ),
      ).toBe(0);
      await expect(page.getByLabel('Search appointments', { exact: true })).toBeVisible();
      expect((await get<Session>(page.request, '/api/session')).user?.role).toBe('admin');
    } finally {
      releaseRead.resolve();
      await page.unroute(`**${runsPath}?*`, lateHistory);
    }

    const staffPage = await reception.newPage();
    await staffPage.goto(`${home}?run=${committed!.id}`);
    await expect(
      staffPage.getByRole('heading', { name: 'Reminder check', exact: true }),
    ).toBeVisible();
    await expect(
      staffPage.locator('.reminder-event').filter({ hasText: clinician.name }),
    ).toBeVisible();
    await expect(
      staffPage.getByRole('button', { name: 'Edit reminder policy', exact: true }),
    ).toHaveCount(0);
    expect(
      await get<AppointmentReminderRun>(reception.request, `${runsPath}/${committed!.id}`),
    ).toEqual(committed);
    await staffPage.goto(home);
    const staffPreview = await openPreview(staffPage);
    await expect(
      previewDialog(staffPage).getByRole('button', {
        name: 'Create in-app reminders',
        exact: true,
      }),
    ).toHaveCount(0);
    expect(
      (
        await reception.request.post(runPath, {
          headers: receptionHeaders,
          data: {
            expectedPreviewRevision: staffPreview.revision,
            expectedPolicyRevision: staffPreview.policyRevision,
            confirmed: true,
            requestId: randomUUID(),
          },
        })
      ).status(),
    ).toBe(403);
    const currentPolicy = await get<AppointmentReminderPolicyContext>(
      reception.request,
      policyPath,
    );
    expect(
      (
        await reception.request.post(policyPath, {
          headers: receptionHeaders,
          data: {
            enabled: false,
            leadHours: 24,
            reason: 'Unauthorized policy edit',
            expectedRevision: currentPolicy.revision,
            requestId: randomUUID(),
          },
        })
      ).status(),
    ).toBe(403);
    for (const path of [
      policyPath,
      `${policyPath}/history`,
      previewPath,
      runsPath,
      `${runsPath}/${committed!.id}`,
      `/api/appointments/${visit.id}/reminders`,
    ])
      expect((await own.request.get(path)).status()).toBe(403);
    await previewDialog(staffPage)
      .getByRole('button', { name: 'Close dialog', exact: true })
      .click();
    await staffPage.goto(`${home}?appointment=${visit.id}`);
    await expect(
      staffPage.getByRole('heading', { name: 'Appointment reminder history', exact: true }),
    ).toBeVisible();
    await expect(staffPage.locator('.reminder-current-appointment')).toContainText(clinician.name);
    await expect(staffPage.locator('.reminder-event')).toHaveCount(1);
    await audit(staffPage);
    await staffPage.screenshot({
      path: testInfo.outputPath('appointment-reminder-staff-history-mobile.png'),
      fullPage: true,
    });
  } finally {
    await policy(page.request, headers, defaults);
    await reception.close();
    await own.close();
  }
});
