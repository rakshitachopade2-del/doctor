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
import type { CarePlan, ClinicSettings, Doctor, Session, User } from '../../shared/types';
import type { FollowUpWorkItem } from '../../shared/follow-up';
import type { CareSummary } from '../../shared/care-summary';
import type { ActivityFeed } from '../../shared/activity';
import type {
  EscalationHistory,
  EscalationPolicy,
  EscalationPolicyContext,
  EscalationPolicyMutation,
  EscalationPreview,
  EscalationRun,
} from '../../shared/follow-up-escalation';

const policyPath = '/api/follow-up-escalation-policy';
const previewPath = '/api/follow-up-escalations/preview';
const runPath = '/api/follow-up-escalations/run';
const defaults: EscalationPolicy = { enabled: false, ownerAfterDays: 3, clinicAfterDays: 7 };
const today = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
const day = (offset: number) =>
  new Date(Date.parse(`${today()}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
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
  status = 200,
): Promise<T> {
  const response = await request.post(path, { headers, data });
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}
async function policy(
  request: APIRequestContext,
  headers: Record<string, string>,
  next: EscalationPolicy,
  reason = 'PRIVATE browser policy fixture.',
) {
  const source = await get<EscalationPolicyContext>(request, policyPath);
  if (JSON.stringify(source.policy) === JSON.stringify(next)) return source;
  return (
    await post<EscalationPolicyMutation>(request, headers, policyPath, {
      ...next,
      reason,
      requestId: randomUUID(),
      expectedRevision: source.revision,
    })
  ).context;
}
async function plan(
  request: APIRequestContext,
  headers: Record<string, string>,
  title: string,
  overdueDays: number,
) {
  return post<CarePlan>(
    request,
    headers,
    '/api/care-plans',
    {
      patientId: 'patient-ananya',
      title,
      instructions: `PRIVATE clinical instructions ${title}`,
      expectations: `PRIVATE clinical expectations ${title}`,
      warnings: `PRIVATE clinical precautions ${title}`,
      cost: '',
      startDate: day(-35),
      endDate: day(15),
      followUpDate: day(-overdueDays),
      medications: [],
    },
    201,
  );
}
async function workItem(request: APIRequestContext, id: string) {
  const item = (await get<FollowUpWorkItem[]>(request, '/api/follow-up-worklist?scope=all')).find(
    (entry) => entry.carePlan.id === id,
  );
  expect(item).toBeTruthy();
  return item!;
}
const history = (request: APIRequestContext, id: string) =>
  get<EscalationHistory>(request, `/api/care-plans/${id}/escalations`);
async function run(
  request: APIRequestContext,
  headers: Record<string, string>,
  preview = undefined as EscalationPreview | undefined,
) {
  const source = preview ?? (await get<EscalationPreview>(request, previewPath));
  return post<EscalationRun>(request, headers, runPath, {
    expectedPreviewRevision: source.revision,
    expectedPolicyRevision: source.policyRevision,
    requestId: randomUUID(),
  });
}
async function complete(request: APIRequestContext, headers: Record<string, string>, id: string) {
  const source = await workItem(request, id);
  return post<CarePlan>(
    request,
    headers,
    `/api/care-plans/${id}/reviews`,
    {
      expectedRevision: source.revision,
      assessment: 'PRIVATE clinical assessment, not part of an operational notice.',
      patientInstructions: 'The synthetic care plan is complete.',
      disposition: 'complete',
      nextReviewDate: null,
    },
    201,
  );
}
function policyDialog(page: Page) {
  return page.getByRole('dialog', { name: 'Escalation policy', exact: true });
}
function previewDialog(page: Page) {
  return page.getByRole('dialog', { name: 'Preview follow-up notices', exact: true });
}
async function close(dialog: Locator) {
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(dialog).toBeHidden();
}
async function fillPolicy(dialog: Locator, value: EscalationPolicy, reason: string) {
  await dialog.getByLabel('Enable operational notices', { exact: true }).setChecked(value.enabled);
  await dialog
    .getByLabel('Owner notice after days', { exact: true })
    .fill(String(value.ownerAfterDays));
  await dialog
    .getByLabel('Clinic notice after days', { exact: true })
    .fill(String(value.clinicAfterDays));
  await dialog.getByLabel('Reason for policy change', { exact: true }).fill(reason);
}
function mutationResponse(page: Page, path: string) {
  return page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === path && response.request().method() === 'POST',
  );
}
async function savePolicy(page: Page) {
  const response = mutationResponse(page, policyPath);
  await policyDialog(page)
    .getByRole('button', { name: 'Save escalation policy', exact: true })
    .click();
  const saved = await response;
  expect(saved.status(), await saved.text()).toBe(200);
  return saved.json() as Promise<EscalationPolicyMutation>;
}
async function openPreview(page: Page) {
  const response = page.waitForResponse(
    (value) => new URL(value.url()).pathname === previewPath && value.request().method() === 'GET',
  );
  await page.getByRole('button', { name: 'Preview notices', exact: true }).click();
  const value = await response;
  expect(value.status(), await value.text()).toBe(200);
  await expect(previewDialog(page).locator('.escalation-preview-summary')).toBeVisible();
  return value.json() as Promise<EscalationPreview>;
}
async function createNotices(page: Page) {
  const response = mutationResponse(page, runPath);
  await previewDialog(page)
    .getByRole('button', { name: 'Create in-app notices', exact: true })
    .click();
  const value = await response;
  expect(value.status(), await value.text()).toBe(200);
  await expect(previewDialog(page).locator('.escalation-run-receipt')).toBeVisible();
  return value.json() as Promise<EscalationRun>;
}
function expectRun(saved: EscalationRun, preview: EscalationPreview, actorId: string) {
  expect(saved).toMatchObject({
    source: 'manual',
    createdById: actorId,
    previewRevision: preview.revision,
    policyRevision: preview.policyRevision,
    clinicDate: preview.clinicDate,
    notifiedPlans: preview.items.length,
    recipientCount: preview.items.reduce((total, entry) => total + entry.recipients.length, 0),
    remainingReady: preview.readyTotal - preview.items.length,
    unroutableTotal: preview.unroutableTotal,
    alreadyNotifiedTotal: preview.alreadyNotifiedTotal,
  });
  expect(
    saved.events.map(
      ({
        id: _id,
        runId: _runId,
        source: _source,
        policy: _policy,
        policyRevision: _revision,
        clinicDate: _date,
        createdAt: _at,
        ...candidate
      }) => candidate,
    ),
  ).toEqual(preview.items);
  for (const event of saved.events)
    expect(event).toMatchObject({
      runId: saved.id,
      source: 'manual',
      policy: preview.policy,
      policyRevision: preview.policyRevision,
      clinicDate: preview.clinicDate,
    });
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

test('administrators preview dated operational notices, preserve exact routing and history, and keep patient care and clinical privacy unchanged', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(150000);
  const { session, headers } = await login(page.request);
  const doctor = await browser.newContext({ baseURL });
  const own = await browser.newContext({ baseURL });
  const reception = await browser.newContext({ baseURL });
  try {
    const { session: doctorSession, headers: doctorHeaders } = await login(
      doctor.request,
      'doctor@derma.demo',
    );
    const { headers: ownHeaders } = await login(own.request, 'patient@derma.demo');
    const { headers: receptionHeaders } = await login(reception.request, 'reception@derma.demo');
    const initial = await get<EscalationPolicyContext>(page.request, policyPath);
    expect(initial.policy).toEqual(defaults);
    expect(initial.history).toEqual([]);
    expect(initial.worker.automaticEnabled).toBe(false);
    const suffix = randomUUID().slice(0, 8);
    const ownerPlan = await plan(page.request, headers, `Owner reminder ${suffix}`, 4);
    const clinicPlan = await plan(page.request, headers, `Clinic reminder ${suffix}`, 10);
    const fallbackPlan = await plan(page.request, headers, `Unavailable owner ${suffix}`, 4);
    const notDue = await plan(page.request, headers, `Below threshold ${suffix}`, 2);
    const receiver = await post<Doctor>(
      page.request,
      headers,
      '/api/doctors',
      {
        name: `Dr. Temporary Owner ${suffix}`,
        title: 'Dermatologist',
        qualifications: 'Synthetic profile',
        specialties: ['General dermatology'],
        experience: 5,
        fee: 600,
        bio: 'Synthetic escalation routing.',
        languages: ['English'],
      },
      201,
    );
    const temporary = await post<User>(
      page.request,
      headers,
      '/api/users',
      {
        name: receiver.name,
        email: `escalation-${suffix}@example.test`,
        password: 'EscalationFixture2026!',
        role: 'doctor',
        doctorId: receiver.id,
      },
      201,
    );
    expect(temporary.mustChangePassword).toBe(true);
    await post(
      page.request,
      headers,
      `/api/care-plans/${fallbackPlan.id}/assignment`,
      {
        doctorId: receiver.id,
        reason: `PRIVATE handover ${suffix}`,
        expectedRevision: (await workItem(page.request, fallbackPlan.id)).revision,
      },
      201,
    );
    await page.goto('/clinic/follow-ups');
    const disabledPreview = await openPreview(page);
    expect(disabledPreview.status).toBe('disabled');
    expect(disabledPreview.items.some((entry) => entry.carePlanId === ownerPlan.id)).toBe(true);
    await expect(
      previewDialog(page).getByRole('button', { name: 'Create in-app notices', exact: true }),
    ).toBeDisabled();
    expect((await history(page.request, ownerPlan.id)).events).toEqual([]);
    await close(previewDialog(page));
    await page.getByRole('button', { name: 'Escalation policy', exact: true }).click();
    const privateReason = `PRIVATE policy reason ${suffix}`;
    await fillPolicy(
      policyDialog(page),
      { enabled: true, ownerAfterDays: 3, clinicAfterDays: 7 },
      privateReason,
    );
    await savePolicy(page);
    await expect(policyDialog(page).locator('.escalation-policy-history')).toContainText(
      privateReason,
    );
    await close(policyDialog(page));
    const preview = await openPreview(page);
    expect(preview.status).toBe('ready');
    const ownerCandidate = preview.items.find((entry) => entry.carePlanId === ownerPlan.id)!;
    const clinicCandidate = preview.items.find((entry) => entry.carePlanId === clinicPlan.id)!;
    const fallbackCandidate = preview.items.find((entry) => entry.carePlanId === fallbackPlan.id)!;
    expect(ownerCandidate).toMatchObject({
      stage: 'owner',
      routing: 'owner',
      overdueDays: 4,
      reviewDate: day(-4),
    });
    expect(clinicCandidate).toMatchObject({ stage: 'clinic', routing: 'clinic', overdueDays: 10 });
    expect(fallbackCandidate).toMatchObject({
      stage: 'owner',
      routing: 'owner-unavailable-fallback',
      ownerDoctorId: receiver.id,
    });
    const eligibleIds = [session.user!.id, doctorSession.user!.id].sort();
    for (const candidate of [ownerCandidate, clinicCandidate, fallbackCandidate])
      expect(candidate.recipients.map((entry) => entry.userId)).toEqual(eligibleIds);
    expect(preview.items.some((entry) => entry.carePlanId === notDue.id)).toBe(false);
    expect(JSON.stringify(preview)).not.toContain('PRIVATE');
    const candidateCard = previewDialog(page)
      .locator('.escalation-candidate')
      .filter({ hasText: ownerPlan.title });
    await expect(candidateCard).toContainText(doctorSession.user!.name);
    await expect(candidateCard).not.toContainText(ownerPlan.instructions);
    // Reports do not alter a reminder episode or stand in for a review.
    await post(
      own.request,
      ownHeaders,
      '/api/check-ins',
      {
        carePlanId: ownerPlan.id,
        date: today(),
        adherence: 'partial',
        feeling: 'worse',
        note: `PRIVATE patient report ${suffix}`,
      },
      201,
    );
    expect((await get<EscalationPreview>(page.request, previewPath)).revision).toBe(
      preview.revision,
    );
    const beforeItem = await workItem(page.request, ownerPlan.id);
    const beforeSummary = await get<CareSummary>(
      own.request,
      '/api/patients/patient-ananya/care-summary',
    );
    const beforePatientActivity = await get<ActivityFeed>(own.request, '/api/activity?limit=100');
    const saved = await createNotices(page);
    expectRun(saved, preview, session.user!.id);
    const ownerHistory = await history(page.request, ownerPlan.id);
    expect(ownerHistory.events).toHaveLength(1);
    expect(ownerHistory.current.state).toBe('recorded');
    expect(ownerHistory.events[0].recipients).toEqual(ownerCandidate.recipients);
    const afterItem = await workItem(page.request, ownerPlan.id);
    expect(afterItem.revision).toBe(beforeItem.revision);
    expect(afterItem.carePlan).toEqual(beforeItem.carePlan);
    expect(afterItem.unreviewedCount).toBe(1);
    expect(afterItem.due).toBe(true);
    expect(
      (await get<CareSummary>(own.request, '/api/patients/patient-ananya/care-summary')).revision,
    ).toBe(beforeSummary.revision);
    expect(await get<ActivityFeed>(own.request, '/api/activity?limit=100')).toEqual(
      beforePatientActivity,
    );
    const patientPlans = await get<CarePlan[]>(own.request, '/api/care-plans');
    expect(patientPlans.find((entry) => entry.id === ownerPlan.id)).not.toHaveProperty(
      'escalation',
    );
    for (const [request, auth] of [
      [own.request, ownHeaders],
      [reception.request, receptionHeaders],
    ] as const) {
      for (const endpoint of [
        policyPath,
        previewPath,
        `/api/care-plans/${ownerPlan.id}/escalations`,
      ])
        expect((await request.get(endpoint)).status()).toBe(403);
      expect(
        (
          await request.post(runPath, {
            headers: auth,
            data: {
              expectedPreviewRevision: preview.revision,
              expectedPolicyRevision: preview.policyRevision,
              requestId: randomUUID(),
            },
          })
        ).status(),
      ).toBe(403);
    }
    const activity = await get<ActivityFeed>(doctor.request, '/api/activity?limit=100');
    const notice = activity.items.find(
      (entry) => entry.href === `/clinic/follow-ups?escalation=${ownerPlan.id}`,
    )!;
    expect(notice).toBeTruthy();
    expect(JSON.stringify(notice)).not.toContain('PRIVATE');
    await post(doctor.request, doctorHeaders, `/api/activity/${notice.id}/read`, {});
    expect((await workItem(page.request, ownerPlan.id)).due).toBe(true);
    expect((await history(doctor.request, ownerPlan.id)).events).toHaveLength(1);
    await close(previewDialog(page));
    const duplicatePreview = await openPreview(page);
    expect(duplicatePreview.items).toHaveLength(0);
    const noNew = await createNotices(page);
    expectRun(noNew, duplicatePreview, session.user!.id);
    expect(noNew.notifiedPlans).toBe(0);
    await expect(previewDialog(page).locator('.escalation-run-receipt')).toContainText(
      'No new notices recorded',
    );
    await close(previewDialog(page));
    // A shorter clinic threshold advances owner notices once, without a new clinical episode.
    await page.getByRole('button', { name: 'Escalation policy', exact: true }).click();
    await fillPolicy(
      policyDialog(page),
      { enabled: true, ownerAfterDays: 3, clinicAfterDays: 4 },
      'PRIVATE advance clinic threshold.',
    );
    await savePolicy(page);
    await close(policyDialog(page));
    const next = await openPreview(page);
    expect(next.items.find((entry) => entry.carePlanId === ownerPlan.id)?.stage).toBe('clinic');
    expect(next.items.find((entry) => entry.carePlanId === ownerPlan.id)?.episodeId).toBe(
      ownerCandidate.episodeId,
    );
    expect(next.items.some((entry) => entry.carePlanId === clinicPlan.id)).toBe(false);
    expectRun(await createNotices(page), next, session.user!.id);
    expect((await history(page.request, ownerPlan.id)).events.map((entry) => entry.stage)).toEqual([
      'clinic',
      'owner',
    ]);
    await page.setViewportSize({ width: 320, height: 900 });
    await audit(page);
    await page.screenshot({
      path: testInfo.outputPath('follow-up-escalation-run-mobile.png'),
      fullPage: true,
    });
  } finally {
    await policy(page.request, headers, defaults);
    await doctor.close();
    await own.close();
    await reception.close();
  }
});

test('policy and manual evaluation retain stale intent and exact uncertain receipts without duplicate changes or notices', async ({
  page,
}, testInfo) => {
  test.setTimeout(150000);
  const { session, headers } = await login(page.request);
  try {
    await policy(page.request, headers, defaults);
    await page.goto('/clinic/follow-ups');
    await page.getByRole('button', { name: 'Escalation policy', exact: true }).click();
    const dialog = policyDialog(page);
    const intent = { enabled: true, ownerAfterDays: 2, clinicAfterDays: 6 };
    const reason = `PRIVATE retained policy draft ${randomUUID()}`;
    await fillPolicy(dialog, intent, reason);
    await policy(
      page.request,
      headers,
      { enabled: false, ownerAfterDays: 4, clinicAfterDays: 9 },
      'PRIVATE concurrent policy update.',
    );
    const staleResponse = mutationResponse(page, policyPath);
    await dialog.getByRole('button', { name: 'Save escalation policy', exact: true }).click();
    const stale = await staleResponse;
    expect(stale.status()).toBe(409);
    const staleBody = stale.request().postDataJSON();
    await expect(dialog.getByLabel('Owner notice after days', { exact: true })).toHaveValue('2');
    await expect(dialog.getByLabel('Reason for policy change', { exact: true })).toHaveValue(
      reason,
    );
    await dialog.getByRole('button', { name: 'Refresh latest policy', exact: true }).click();
    await expect(dialog).toContainText('PRIVATE concurrent policy update.');
    await dialog
      .getByRole('button', { name: 'I reviewed the latest policy; keep my draft', exact: true })
      .click();
    let policyAttempt: Record<string, unknown> | undefined;
    let policySaved: EscalationPolicyMutation | undefined;
    const malformedPolicy = async (route: Route) => {
      if (route.request().method() !== 'POST') return route.continue();
      policyAttempt = route.request().postDataJSON();
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      policySaved = await response.json();
      await route.fulfill({
        response,
        json: {
          ...policySaved,
          change: { ...policySaved!.change, createdById: 'different-account' },
        },
      });
    };
    await page.route(`**${policyPath}`, malformedPolicy);
    await dialog.getByRole('button', { name: 'Save escalation policy', exact: true }).click();
    await expect(
      dialog.getByRole('button', { name: 'Retry same request', exact: true }),
    ).toBeVisible();
    expect(policyAttempt!.requestId).not.toBe(staleBody.requestId);
    await expect(dialog.getByLabel('Reason for policy change', { exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await expect(dialog).toBeVisible();
    await page.unroute(`**${policyPath}`, malformedPolicy);
    const later = { enabled: true, ownerAfterDays: 1, clinicAfterDays: 5 };
    const advanced = await policy(page.request, headers, later, 'PRIVATE later current policy.');
    const replayResponse = mutationResponse(page, policyPath);
    await dialog.getByRole('button', { name: 'Retry same request', exact: true }).click();
    const replay = await replayResponse;
    expect(replay.status()).toBe(200);
    expect(replay.request().postDataJSON()).toEqual(policyAttempt);
    const confirmed = (await replay.json()) as EscalationPolicyMutation;
    expect(confirmed.change).toEqual(policySaved!.change);
    expect(confirmed.context.policy).toEqual(later);
    expect(confirmed.context.history).toHaveLength(advanced.history.length);
    await expect(dialog.getByLabel('Owner notice after days', { exact: true })).toHaveValue('1');
    await expect(dialog.getByLabel('Clinic notice after days', { exact: true })).toHaveValue('5');
    await expect(dialog.getByLabel('Reason for policy change', { exact: true })).toHaveValue('');
    await close(dialog);
    const selectedPlan = await plan(
      page.request,
      headers,
      `Retry run ${randomUUID().slice(0, 8)}`,
      15,
    );
    const originalPreview = await openPreview(page);
    const extraPlan = await plan(
      page.request,
      headers,
      `Arrived after preview ${randomUUID().slice(0, 8)}`,
      12,
    );
    const staleRunResponse = mutationResponse(page, runPath);
    await previewDialog(page)
      .getByRole('button', { name: 'Create in-app notices', exact: true })
      .click();
    const staleRun = await staleRunResponse;
    expect(staleRun.status()).toBe(409);
    expect((await history(page.request, selectedPlan.id)).events).toHaveLength(0);
    await expect(
      previewDialog(page).getByRole('button', { name: 'Create in-app notices', exact: true }),
    ).toBeDisabled();
    const freshResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === previewPath,
    );
    await previewDialog(page).getByRole('button', { name: 'Refresh preview', exact: true }).click();
    const fresh = (await (await freshResponse).json()) as EscalationPreview;
    expect(fresh.revision).not.toBe(originalPreview.revision);
    expect(fresh.items.some((entry) => entry.carePlanId === extraPlan.id)).toBe(true);
    await expect(
      previewDialog(page).getByRole('button', { name: 'Create in-app notices', exact: true }),
    ).toBeDisabled();
    await previewDialog(page)
      .getByRole('button', { name: 'I reviewed the refreshed preview', exact: true })
      .click();
    let runAttempt: Record<string, unknown> | undefined;
    let runSaved: EscalationRun | undefined;
    const lostRun = async (route: Route) => {
      if (route.request().method() !== 'POST') return route.continue();
      runAttempt = route.request().postDataJSON();
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      runSaved = await response.json();
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Synthetic response lost after notices were committed.' }),
      });
    };
    await page.route(`**${runPath}`, lostRun);
    await previewDialog(page)
      .getByRole('button', { name: 'Create in-app notices', exact: true })
      .click();
    await expect(
      previewDialog(page).getByRole('button', { name: 'Retry same request', exact: true }),
    ).toBeVisible();
    expect(runAttempt!.requestId).not.toBe(staleRun.request().postDataJSON().requestId);
    await expect(
      previewDialog(page).getByRole('button', { name: 'Refresh preview', exact: true }),
    ).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(previewDialog(page)).toBeVisible();
    await page.unroute(`**${runPath}`, lostRun);
    await policy(
      page.request,
      headers,
      { ...later, enabled: false },
      'PRIVATE paused after committed run.',
    );
    const exactRunResponse = mutationResponse(page, runPath);
    await previewDialog(page)
      .getByRole('button', { name: 'Retry same request', exact: true })
      .click();
    const exactRun = await exactRunResponse;
    expect(exactRun.status()).toBe(200);
    expect(exactRun.request().postDataJSON()).toEqual(runAttempt);
    expect(await exactRun.json()).toEqual(runSaved);
    expectRun(runSaved!, fresh, session.user!.id);
    await expect(previewDialog(page).locator('.escalation-run-receipt')).toBeVisible();
    expect((await history(page.request, selectedPlan.id)).events).toHaveLength(1);
    expect((await history(page.request, extraPlan.id)).events).toHaveLength(1);
    await close(previewDialog(page));
    await policy(page.request, headers, later);
    const malformedPlan = await plan(
      page.request,
      headers,
      `Malformed run ${randomUUID().slice(0, 8)}`,
      20,
    );
    const malformedPreview = await openPreview(page);
    let malformedAttempt: Record<string, unknown> | undefined;
    let realRun: EscalationRun | undefined;
    const malformedRun = async (route: Route) => {
      if (route.request().method() !== 'POST') return route.continue();
      malformedAttempt = route.request().postDataJSON();
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      realRun = await response.json();
      const events = realRun!.events.map((event, index) =>
        index
          ? event
          : {
              ...event,
              recipients: event.recipients.map((recipient, recipientIndex) =>
                recipientIndex ? recipient : { ...recipient, userId: 'different-recipient' },
              ),
            },
      );
      await route.fulfill({ response, json: { ...realRun, events } });
    };
    await page.route(`**${runPath}`, malformedRun);
    await previewDialog(page)
      .getByRole('button', { name: 'Create in-app notices', exact: true })
      .click();
    await expect(
      previewDialog(page).getByRole('button', { name: 'Retry same request', exact: true }),
    ).toBeVisible();
    await expect(previewDialog(page).locator('.escalation-run-receipt')).toHaveCount(0);
    await page.unroute(`**${runPath}`, malformedRun);
    const validResponse = mutationResponse(page, runPath);
    await previewDialog(page)
      .getByRole('button', { name: 'Retry same request', exact: true })
      .click();
    const valid = await validResponse;
    expect(valid.status()).toBe(200);
    expect(valid.request().postDataJSON()).toEqual(malformedAttempt);
    expect(await valid.json()).toEqual(realRun);
    expectRun(realRun!, malformedPreview, session.user!.id);
    expect((await history(page.request, malformedPlan.id)).events).toHaveLength(1);
    await expect(previewDialog(page).locator('.escalation-run-receipt')).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('follow-up-exact-run-receipt.png'),
      fullPage: true,
    });
  } finally {
    await policy(page.request, headers, defaults);
  }
});

test('doctors read exact historical episodes without administration access, module pauses preserve evidence, and worklist failures do not invent zero counts', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(120000);
  const { headers } = await login(page.request);
  const doctor = await browser.newContext({ baseURL });
  const settings = await get<ClinicSettings>(page.request, '/api/settings');
  let moduleChanged = false;
  try {
    const { headers: doctorHeaders } = await login(doctor.request, 'doctor@derma.demo');
    await policy(page.request, headers, { enabled: true, ownerAfterDays: 3, clinicAfterDays: 7 });
    const closed = await plan(
      page.request,
      headers,
      `Historical reminder ${randomUUID().slice(0, 8)}`,
      12,
    );
    const pending = await plan(
      page.request,
      headers,
      `Paused reminder ${randomUUID().slice(0, 8)}`,
      4,
    );
    const before = await get<EscalationPreview>(page.request, previewPath);
    const firstRun = await run(page.request, headers, before);
    expect(firstRun.events.some((entry) => entry.carePlanId === closed.id)).toBe(true);
    await complete(page.request, headers, closed.id);
    const recorded = await history(page.request, closed.id);
    expect(recorded.current.state).toBe('completed');
    expect(recorded.events).toHaveLength(1);
    const doctorPage = await doctor.newPage();
    await doctorPage.goto(`/clinic/follow-ups?escalation=${closed.id}`);
    const dialog = doctorPage.getByRole('dialog', {
      name: 'Follow-up notice history',
      exact: true,
    });
    await expect(dialog).toContainText(closed.title);
    await expect(dialog.locator('.escalation-history')).toContainText('Previous episode');
    await expect(dialog).not.toContainText('PRIVATE clinical');
    expect((await history(doctor.request, closed.id)).events).toEqual(recorded.events);
    await doctorPage.setViewportSize({ width: 320, height: 900 });
    await audit(doctorPage);
    await doctorPage.screenshot({
      path: testInfo.outputPath('follow-up-escalation-history-mobile.png'),
      fullPage: true,
    });
    await close(dialog);
    await expect(
      doctorPage.getByRole('button', { name: 'Preview notices', exact: true }),
    ).toHaveCount(0);
    await doctorPage.getByRole('button', { name: 'View escalation policy', exact: true }).click();
    await expect(
      policyDialog(doctorPage).getByRole('button', { name: 'Save escalation policy', exact: true }),
    ).toHaveCount(0);
    await expect(
      policyDialog(doctorPage).getByLabel('Reason for policy change', { exact: true }),
    ).toHaveCount(0);
    const currentPolicy = await get<EscalationPolicyContext>(doctor.request, policyPath);
    expect((await doctor.request.get(previewPath)).status()).toBe(403);
    expect(
      (
        await doctor.request.post(policyPath, {
          headers: doctorHeaders,
          data: {
            ...defaults,
            reason: 'Unauthorized policy edit.',
            expectedRevision: currentPolicy.revision,
            requestId: randomUUID(),
          },
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await doctor.request.post(runPath, {
          headers: doctorHeaders,
          data: {
            expectedPolicyRevision: currentPolicy.revision,
            expectedPreviewRevision: before.revision,
            requestId: randomUUID(),
          },
        })
      ).status(),
    ).toBe(403);
    await audit(doctorPage);
    await close(policyDialog(doctorPage));
    // Pause the module without losing past events; a newly overdue source remains unsent.
    const notSent = await plan(
      page.request,
      headers,
      `No notice while paused ${randomUUID().slice(0, 8)}`,
      10,
    );
    const paused = await page.request.patch('/api/settings', {
      headers,
      data: { modules: { ...settings.modules, followUp: false } },
    });
    expect(paused.status()).toBe(200);
    moduleChanged = true;
    await page.goto('/clinic/follow-ups');
    const pausedPreview = await openPreview(page);
    expect(pausedPreview.status).toBe('paused');
    await expect(
      previewDialog(page).getByRole('button', { name: 'Create in-app notices', exact: true }),
    ).toBeDisabled();
    expect((await history(page.request, notSent.id)).events).toHaveLength(0);
    expect((await history(page.request, pending.id)).events).toHaveLength(1);
    await close(previewDialog(page));
    const outage = async (route: Route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Synthetic follow-up worklist outage.' }),
      });
    await page.route('**/api/follow-up-worklist?*', outage);
    await page.getByRole('button', { name: 'Refresh worklist', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Synthetic follow-up worklist outage.');
    await expect(page.locator('.fu-metrics')).not.toContainText(/^0$/);
    const values = await page.locator('.fu-metrics strong').allTextContents();
    expect(values.some((value) => /^\d+$/.test(value.trim()))).toBe(false);
    await page.unroute('**/api/follow-up-worklist?*', outage);
    await page.getByRole('button', { name: 'Refresh worklist', exact: true }).click();
    await expect(
      page.getByText('Synthetic follow-up worklist outage.', { exact: true }),
    ).toHaveCount(0);
    await expect(page.locator('.fu-metrics strong').first()).toHaveText(/^\d+$/);
    await page.setViewportSize({ width: 320, height: 900 });
    await audit(page);
    await page.screenshot({
      path: testInfo.outputPath('follow-up-operational-worklist-mobile.png'),
      fullPage: true,
    });
  } finally {
    if (moduleChanged) {
      const restored = await page.request.patch('/api/settings', {
        headers,
        data: { modules: settings.modules },
      });
      expect(restored.status()).toBe(200);
    }
    await policy(page.request, headers, defaults);
    await doctor.close();
  }
});
