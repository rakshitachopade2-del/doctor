import { test, expect, type APIRequestContext, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import type { ClinicSettings, Doctor, Session } from '../../shared/types';
import type { CareSummary } from '../../shared/care-summary';
import type {
  ClinicConfigurationContext,
  ClinicConfigurationHistory,
  ClinicConfigurationMutation,
  ClinicModules,
  ClinicProfile,
  ClinicProfileInput,
} from '../../shared/clinic-configuration';

const base = '/api/clinic-configuration';
const profileReview = 'I reviewed these public clinic details.';
const keepDraft = 'I reviewed the latest configuration; keep my draft';
const profileOf = ({ modules: _modules, ...profile }: ClinicSettings): ClinicProfile => profile;
const profileForm = (page: Page) => page.locator('.clinic-profile-form');
const modulesForm = (page: Page) => page.locator('.clinic-modules-form');
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
async function saveProfile(
  request: APIRequestContext,
  headers: Record<string, string>,
  profile: ClinicProfile,
  reason: string,
) {
  const current = await get<ClinicConfigurationContext>(request, base);
  return post<ClinicConfigurationMutation>(request, headers, `${base}/profile`, {
    profile,
    reason,
    expectedRevision: current.profileRevision,
    requestId: randomUUID(),
  });
}
async function saveModules(
  request: APIRequestContext,
  headers: Record<string, string>,
  modules: ClinicModules,
  reason: string,
) {
  const current = await get<ClinicConfigurationContext>(request, base);
  return post<ClinicConfigurationMutation>(request, headers, `${base}/modules`, {
    modules,
    reason,
    expectedRevision: current.modulesRevision,
    requestId: randomUUID(),
  });
}
async function restore(
  request: APIRequestContext,
  headers: Record<string, string>,
  settings: ClinicSettings,
) {
  const current = await get<ClinicConfigurationContext>(request, base);
  if (JSON.stringify(profileOf(current.settings)) !== JSON.stringify(profileOf(settings)))
    await saveProfile(
      request,
      headers,
      profileOf(settings),
      'Restore synthetic browser profile fixture.',
    );
  if (JSON.stringify(current.settings.modules) !== JSON.stringify(settings.modules))
    await saveModules(
      request,
      headers,
      settings.modules,
      'Restore synthetic browser module fixture.',
    );
}
const responseFor = (page: Page, path: string) =>
  page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === path && response.request().method() === 'POST',
  );
async function openProfile(page: Page) {
  await page.goto('/clinic/settings?tab=clinic');
  await expect(profileForm(page).getByLabel('Clinic name', { exact: true })).toBeVisible();
}
async function draftProfile(page: Page, name: string, reason: string) {
  const form = profileForm(page);
  await form.getByLabel('Clinic name', { exact: true }).fill(name);
  await form.getByLabel('Reason for profile change', { exact: true }).fill(reason);
  await form.getByLabel(profileReview, { exact: true }).check();
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

test('profile changes preserve newer module pauses, independent drafts, public details and readable patient history', async ({
  page,
  browser,
  playwright,
  baseURL,
}, testInfo) => {
  const admin = await login(page.request);
  const original = await get<ClinicConfigurationContext>(page.request, base);
  const patientContext = await browser.newContext({ baseURL });
  const patientPage = await patientContext.newPage();
  const patient = await login(patientPage.request, 'patient@derma.demo');
  const anonymous = await playwright.request.newContext({ baseURL });
  const suffix = randomUUID().slice(0, 8);
  const name = `Synthetic clinic ${suffix}`;
  const address = `42 Synthetic Lane, ${suffix}`;
  const reason = `Private profile review ${suffix}`;
  const moduleReason = `Unsaved intake pause ${suffix}`;
  const pausedReason = `Private concurrent module review ${suffix}`;
  const caption = `Retained clinical photograph ${suffix}`;
  const message = `Retained patient conversation ${suffix}`;
  try {
    if (Object.values(original.settings.modules).some((value) => !value))
      await saveModules(
        page.request,
        admin.headers,
        { intake: true, images: true, followUp: true },
        'Enable synthetic continuity fixtures.',
      );
    await post(patientPage.request, patient.headers, '/api/images', {
      caption,
      category: 'clinical',
      consent: true,
      dataUrl:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cWb0AAAAASUVORK5CYII=',
    });
    await post(patientPage.request, patient.headers, '/api/messages', { body: message });
    const doctors = await get<Doctor[]>(page.request, '/api/doctors');
    const schedulePath = `/api/schedules/${doctors[0].id}`;
    const scheduleBefore = await get<unknown>(page.request, schedulePath);
    const source = await get<ClinicConfigurationContext>(page.request, base);
    await openProfile(page);
    await draftProfile(page, name, reason);
    await profileForm(page).getByLabel('Clinic address', { exact: true }).fill(address);
    await profileForm(page)
      .getByLabel('Opening hours', { exact: true })
      .fill('Synthetic reception hours: 10:00–16:00');
    await page.getByRole('tab', { name: 'Care modules', exact: true }).click();
    await expect(page).toHaveURL(/tab=modules/);
    const modules = modulesForm(page);
    await modules.getByRole('switch', { name: 'Enable Structured intake', exact: true }).uncheck();
    await modules.getByLabel('Reason for module change', { exact: true }).fill(moduleReason);
    await page.getByRole('tab', { name: 'Clinic profile', exact: true }).click();
    await expect(profileForm(page).getByLabel('Clinic name', { exact: true })).toHaveValue(name);
    await expect(
      profileForm(page).getByLabel('Reason for profile change', { exact: true }),
    ).toHaveValue(reason);

    const paused = { intake: true, images: false, followUp: false };
    const moduleSave = await saveModules(page.request, admin.headers, paused, pausedReason);
    expect(moduleSave.context.profileRevision).toBe(source.profileRevision);
    await profileForm(page).getByLabel(profileReview, { exact: true }).check();
    const saving = responseFor(page, `${base}/profile`);
    await profileForm(page)
      .getByRole('button', { name: 'Save clinic details', exact: true })
      .click();
    const response = await saving;
    expect(response.status(), await response.text()).toBe(201);
    const submitted = response.request().postDataJSON() as ClinicProfileInput;
    expect(submitted.expectedRevision).toBe(source.profileRevision);
    expect(submitted).not.toHaveProperty('modules');
    expect(submitted.profile).not.toHaveProperty('modules');
    const saved = (await response.json()) as ClinicConfigurationMutation;
    expect(saved.context.settings.modules).toEqual(paused);
    expect(saved.context.modulesRevision).toBe(moduleSave.context.modulesRevision);
    await expect(
      profileForm(page).getByLabel('Reason for profile change', { exact: true }),
    ).toHaveValue('');
    await page.getByRole('tab', { name: 'Care modules', exact: true }).click();
    await expect(
      modules.getByRole('switch', { name: 'Enable Structured intake', exact: true }),
    ).not.toBeChecked();
    await expect(modules.getByLabel('Reason for module change', { exact: true })).toHaveValue(
      moduleReason,
    );

    const publicSettings = await get<ClinicSettings>(anonymous, '/api/settings');
    expect(publicSettings).toEqual(saved.context.settings);
    expect(Object.keys(publicSettings).sort()).toEqual(
      ['address', 'email', 'hours', 'modules', 'name', 'phone', 'tagline', 'timezone'].sort(),
    );
    for (const privateValue of [
      reason,
      moduleReason,
      pausedReason,
      source.profileRevision,
      admin.session.user!.id,
    ])
      expect(JSON.stringify(publicSettings)).not.toContain(privateValue);
    const summary = await get<CareSummary>(
      patientPage.request,
      `/api/patients/${patient.session.user!.patientId}/care-summary`,
    );
    expect(summary.clinic).toEqual({
      name,
      address,
      phone: publicSettings.phone,
      email: publicSettings.email,
    });
    expect(JSON.stringify(summary)).not.toContain(reason);
    expect(JSON.stringify(summary)).not.toContain(pausedReason);
    expect(await get(page.request, schedulePath)).toEqual(scheduleBefore);
    for (const endpoint of [base, `${base}/history`])
      expect((await patientPage.request.get(endpoint)).status()).toBe(403);

    await patientPage.goto('/my-care/record?tab=images');
    await expect(patientPage.getByRole('img', { name: caption, exact: true })).toBeVisible();
    await expect(
      patientPage.getByText(
        'Image uploads are paused. Your existing images and reports remain available.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(patientPage.getByRole('button', { name: 'Add image', exact: true })).toHaveCount(
      0,
    );
    await patientPage.goto('/my-care/messages');
    await expect(patientPage.getByText(message, { exact: true })).toBeVisible();
    await expect(
      patientPage.getByText(
        'Messaging is paused. Your existing conversation remains available. Contact the clinic directly for new questions.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(patientPage.getByLabel('Your message', { exact: true })).toHaveCount(0);
    await expect(
      patientPage.getByRole('button', { name: 'Send message', exact: true }),
    ).toHaveCount(0);
    await audit(patientPage);
    await patientPage.screenshot({
      path: testInfo.outputPath('configuration-paused-patient-mobile.png'),
      fullPage: true,
    });
    // The reverse direction also stays independent: a reviewed module save must
    // retain a newer public profile, without changing the clinician's schedule.
    await page.goto('/clinic/settings?tab=modules');
    await expect(
      modulesForm(page).getByRole('switch', { name: 'Enable Structured intake', exact: true }),
    ).toBeChecked();
    await modulesForm(page)
      .getByRole('switch', { name: 'Enable Structured intake', exact: true })
      .uncheck();
    await modulesForm(page)
      .getByLabel('Reason for module change', { exact: true })
      .fill(`Reviewed intake pause ${suffix}`);
    await modulesForm(page)
      .getByLabel('I reviewed how these module choices affect new activity.', { exact: true })
      .check();
    const laterProfile = await saveProfile(
      page.request,
      admin.headers,
      {
        ...profileOf(saved.context.settings),
        hours: 'Later informational reception hours: 11:00–15:00',
      },
      `Independent later profile ${suffix}`,
    );
    const moduleResponse = responseFor(page, `${base}/modules`);
    await modulesForm(page).getByRole('button', { name: 'Save modules', exact: true }).click();
    const moduleResult = await moduleResponse;
    expect(moduleResult.status(), await moduleResult.text()).toBe(201);
    expect(moduleResult.request().postDataJSON()).not.toHaveProperty('profile');
    const finalModules = (await moduleResult.json()) as ClinicConfigurationMutation;
    expect(profileOf(finalModules.context.settings)).toEqual(
      profileOf(laterProfile.context.settings),
    );
    expect(finalModules.context.settings.modules).toEqual({
      intake: false,
      images: false,
      followUp: false,
    });
    await expect(
      modulesForm(page).getByLabel('Reason for module change', { exact: true }),
    ).toHaveValue('');
    expect(await get(page.request, schedulePath)).toEqual(scheduleBefore);
    await page.getByRole('tab', { name: 'Clinic profile', exact: true }).click();
    await audit(page);
    await page.screenshot({
      path: testInfo.outputPath('configuration-profile-mobile.png'),
      fullPage: true,
    });
  } finally {
    await restore(page.request, admin.headers, original.settings);
    await patientContext.close();
    await anonymous.dispose();
  }
});

test('profile ABA conflicts require fresh review and uncertain writes retain their exact request across later errors and newer settings', async ({
  page,
}) => {
  const admin = await login(page.request);
  const original = await get<ClinicConfigurationContext>(page.request, base);
  const suffix = randomUUID().slice(0, 8);
  const name = `Reviewed browser profile ${suffix}`;
  const reason = `Private reviewed intent ${suffix}`;
  const laterName = `Later current profile ${suffix}`;
  const attempts: ClinicProfileInput[] = [];
  let committed: ClinicConfigurationMutation | undefined;
  const endpoint = `${base}/profile`;
  const intercept = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.continue();
    attempts.push(route.request().postDataJSON() as ClinicProfileInput);
    if (attempts.length === 2)
      return route.fulfill({
        status: 400,
        json: { error: 'Synthetic later rejection must preserve this configuration request.' },
      });
    const response = await route.fetch();
    expect(response.status(), await response.text()).toBe(attempts.length === 1 ? 201 : 200);
    const result = (await response.json()) as ClinicConfigurationMutation;
    if (attempts.length === 1) {
      committed = result;
      return route.fulfill({ response, json: { ...result, change: null } });
    }
    if (attempts.length === 3)
      return route.fulfill({
        response,
        json: { ...result, receipt: { ...result.receipt, actorId: randomUUID() } },
      });
    return route.fulfill({ response });
  };
  try {
    await openProfile(page);
    await draftProfile(page, name, reason);
    await saveProfile(
      page.request,
      admin.headers,
      { ...profileOf(original.settings), name: `Intermediate ABA ${suffix}` },
      `Private intervening change ${suffix}`,
    );
    const restored = await saveProfile(
      page.request,
      admin.headers,
      profileOf(original.settings),
      `Restore same displayed values ${suffix}`,
    );
    expect(restored.context.settings).toEqual(original.settings);
    expect(restored.context.profileRevision).not.toBe(original.profileRevision);
    const rejected = responseFor(page, endpoint);
    await profileForm(page)
      .getByRole('button', { name: 'Save clinic details', exact: true })
      .click();
    const rejectedResponse = await rejected;
    expect(rejectedResponse.status()).toBe(409);
    const staleAttempt = rejectedResponse.request().postDataJSON() as ClinicProfileInput;
    const form = profileForm(page);
    await expect(form.getByLabel('Clinic name', { exact: true })).toHaveValue(name);
    await expect(form.getByLabel('Reason for profile change', { exact: true })).toHaveValue(reason);
    await form.getByRole('button', { name: 'Refresh latest configuration', exact: true }).click();
    await expect(form.locator('.configuration-latest')).toContainText(
      `Restore same displayed values ${suffix}`,
    );
    await form.getByRole('button', { name: keepDraft, exact: true }).click();
    await expect(form.getByLabel(profileReview, { exact: true })).not.toBeChecked();
    await expect(form.getByLabel('Clinic name', { exact: true })).toHaveValue(name);
    await form.getByLabel(profileReview, { exact: true }).check();

    await page.route(`**${endpoint}`, intercept);
    const first = responseFor(page, endpoint);
    await form.getByRole('button', { name: 'Save clinic details', exact: true }).click();
    await first;
    await expect(
      form.getByRole('button', { name: 'Retry same request', exact: true }),
    ).toBeEnabled();
    await expect(form.getByLabel('Clinic name', { exact: true })).toBeDisabled();
    await expect(form.getByLabel('Reason for profile change', { exact: true })).toBeDisabled();
    await expect(form.getByLabel(profileReview, { exact: true })).toBeDisabled();
    expect(committed).toBeDefined();
    expect(attempts[0].expectedRevision).toBe(restored.context.profileRevision);
    expect(attempts[0].requestId).not.toBe(staleAttempt.requestId);

    const newer = await saveProfile(
      page.request,
      admin.headers,
      { ...profileOf(committed!.context.settings), name: laterName },
      `Later private correction ${suffix}`,
    );
    for (const attemptNumber of [2, 3]) {
      const waiting = responseFor(page, endpoint);
      await form.getByRole('button', { name: 'Retry same request', exact: true }).click();
      const response = await waiting;
      expect(response.status()).toBe(attemptNumber === 2 ? 400 : 200);
      await expect(
        form.getByRole('button', { name: 'Retry same request', exact: true }),
      ).toBeEnabled();
      await expect(form.getByLabel('Clinic name', { exact: true })).toHaveValue(name);
      await expect(form.getByLabel('Reason for profile change', { exact: true })).toBeDisabled();
      expect(attempts).toHaveLength(attemptNumber);
    }
    const final = responseFor(page, endpoint);
    await form.getByRole('button', { name: 'Retry same request', exact: true }).click();
    const response = await final;
    expect(response.status()).toBe(200);
    await expect(form.getByRole('button', { name: 'Retry same request', exact: true })).toHaveCount(
      0,
    );
    await expect(form.getByLabel('Clinic name', { exact: true })).toHaveValue(laterName);
    await expect(form.getByLabel('Reason for profile change', { exact: true })).toHaveValue('');
    await expect(form.getByLabel(profileReview, { exact: true })).not.toBeChecked();
    expect(attempts).toHaveLength(4);
    for (const attempt of attempts) expect(attempt).toEqual(attempts[0]);
    const current = await get<ClinicConfigurationContext>(page.request, base);
    expect(current).toEqual(newer.context);
    const history = await get<ClinicConfigurationHistory>(
      page.request,
      `${base}/history?scope=profile&pageSize=50`,
    );
    expect(history.items.filter((change) => change.id === committed!.change.id)).toEqual([
      committed!.change,
    ]);
    expect(history.items.filter((change) => change.reason === reason)).toHaveLength(1);
  } finally {
    await page.unroute(`**${endpoint}`, intercept);
    await restore(page.request, admin.headers, original.settings);
  }
});

test('an unsent configuration request recovers from a later stale retry through explicit review and a new command', async ({
  page,
}) => {
  const admin = await login(page.request);
  const original = await get<ClinicConfigurationContext>(page.request, base);
  const suffix = randomUUID().slice(0, 8);
  const name = `Retained unsent profile ${suffix}`;
  const reason = `Private recovered profile intent ${suffix}`;
  const concurrentReason = `Concurrent administrator correction ${suffix}`;
  const endpoint = `${base}/profile`;
  const attempts: ClinicProfileInput[] = [];
  const intercept = async (route: Route) => {
    attempts.push(route.request().postDataJSON() as ClinicProfileInput);
    // Do not forward the first request: no command or history was committed.
    if (attempts.length === 1) return route.abort('failed');
    return route.continue();
  };
  await page.route(`**${endpoint}`, intercept);
  try {
    await openProfile(page);
    await draftProfile(page, name, reason);
    const form = profileForm(page);
    const failed = page.waitForEvent(
      'requestfailed',
      (request) => new URL(request.url()).pathname === endpoint && request.method() === 'POST',
    );
    await form.getByRole('button', { name: 'Save clinic details', exact: true }).click();
    await failed;
    await expect(
      form.getByRole('button', { name: 'Retry same request', exact: true }),
    ).toBeEnabled();
    await expect(form.getByLabel('Clinic name', { exact: true })).toBeDisabled();
    expect(await get<ClinicConfigurationContext>(page.request, base)).toEqual(original);
    const intervening = await saveProfile(
      page.request,
      admin.headers,
      {
        ...profileOf(original.settings),
        name: `Other administrator profile ${suffix}`,
      },
      concurrentReason,
    );

    const retry = responseFor(page, endpoint);
    await form.getByRole('button', { name: 'Retry same request', exact: true }).click();
    const conflict = await retry;
    expect(conflict.status(), await conflict.text()).toBe(409);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    await expect(
      form.getByRole('button', { name: 'Refresh latest configuration', exact: true }),
    ).toBeEnabled();
    await expect(form.getByRole('button', { name: 'Retry same request', exact: true })).toHaveCount(
      0,
    );
    await expect(form.getByLabel('Clinic name', { exact: true })).toHaveValue(name);
    await expect(form.getByLabel('Reason for profile change', { exact: true })).toHaveValue(reason);
    await expect(form.getByLabel(profileReview, { exact: true })).not.toBeChecked();
    expect(await get<ClinicConfigurationContext>(page.request, base)).toEqual(intervening.context);

    await form.getByRole('button', { name: 'Refresh latest configuration', exact: true }).click();
    await expect(form.locator('.configuration-latest')).toContainText(
      intervening.context.settings.name,
    );
    await expect(form.locator('.configuration-latest')).toContainText(concurrentReason);
    await form.getByRole('button', { name: keepDraft, exact: true }).click();
    await expect(form.getByLabel('Clinic name', { exact: true })).toBeEnabled();
    await expect(form.getByLabel('Clinic name', { exact: true })).toHaveValue(name);
    await expect(form.getByLabel('Reason for profile change', { exact: true })).toHaveValue(reason);
    await expect(form.getByLabel(profileReview, { exact: true })).not.toBeChecked();
    await form.getByLabel(profileReview, { exact: true }).check();
    const saving = responseFor(page, endpoint);
    await form.getByRole('button', { name: 'Save clinic details', exact: true }).click();
    const response = await saving;
    expect(response.status(), await response.text()).toBe(201);
    const saved = (await response.json()) as ClinicConfigurationMutation;
    await expect(form.getByLabel('Reason for profile change', { exact: true })).toHaveValue('');
    expect(attempts).toHaveLength(3);
    expect(attempts[2].requestId).not.toBe(attempts[0].requestId);
    expect(attempts[2].expectedRevision).toBe(intervening.context.profileRevision);
    expect(attempts[2].profile).toEqual(attempts[0].profile);
    expect(attempts[2].reason).toBe(reason);
    expect(saved.receipt.requestId).toBe(attempts[2].requestId);
    expect(saved.change).toMatchObject({
      scope: 'profile',
      before: profileOf(intervening.context.settings),
      after: attempts[0].profile,
      reason,
    });
    const history = await get<ClinicConfigurationHistory>(
      page.request,
      `${base}/history?scope=profile&pageSize=50`,
    );
    expect(history.items.filter((change) => change.reason === reason)).toEqual([saved.change]);
  } finally {
    await page.unroute(`**${endpoint}`, intercept);
    await restore(page.request, admin.headers, original.settings);
  }
});

test('configuration history is paged and private, recovers on explicit retry, and ignores obsolete save and unauthorized read responses', async ({
  page,
  playwright,
  baseURL,
}, testInfo) => {
  test.setTimeout(120000);
  const admin = await login(page.request);
  const original = await get<ClinicConfigurationContext>(page.request, base);
  const suffix = randomUUID().slice(0, 8);
  const profile = profileOf(original.settings);
  let failingHistory = true;
  const readFailure = async (route: Route) => {
    if (failingHistory)
      return route.fulfill({
        status: 503,
        json: { error: 'Synthetic configuration history is temporarily unavailable.' },
      });
    return route.continue();
  };
  try {
    for (let index = 0; index < 26; index++)
      await saveProfile(
        page.request,
        admin.headers,
        { ...profile, hours: `Synthetic history ${suffix} entry ${index}` },
        `Private paged history ${suffix} ${index}`,
      );
    const legacy = await page.request.patch('/api/settings', {
      headers: admin.headers,
      data: { hours: `Legacy informational hours ${suffix}` },
    });
    expect(legacy.status(), await legacy.text()).toBe(200);
    const current = await get<ClinicConfigurationContext>(page.request, base);
    expect(current.latestProfileChange).toMatchObject({ source: 'legacy', reason: null });

    await page.route(`**${base}/history?*`, readFailure);
    await page.goto('/clinic/settings?tab=history&scope=profile');
    const history = page.locator('.configuration-history');
    await expect(history.getByRole('alert')).toContainText('Synthetic configuration history');
    failingHistory = false;
    await history.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(history.locator('.configuration-change')).toHaveCount(25);
    await expect(history).toContainText(`Legacy informational hours ${suffix}`);
    await page.unroute(`**${base}/history?*`, readFailure);
    const pageOne = await get<ClinicConfigurationHistory>(
      page.request,
      `${base}/history?scope=profile&page=1&pageSize=25`,
    );
    expect(pageOne.total).toBeGreaterThan(25);
    expect(pageOne.items[0].id).toBe(current.latestProfileChange!.id);
    const pagination = page.getByRole('navigation', {
      name: 'Configuration history pagination',
      exact: true,
    });
    await pagination.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('page')).toBe('2');
    const pageTwo = await get<ClinicConfigurationHistory>(
      page.request,
      `${base}/history?scope=profile&page=2&pageSize=25`,
    );
    await expect(history.locator('.configuration-change')).toHaveCount(pageTwo.items.length);
    expect(
      pageTwo.items
        .map((change) => change.id)
        .some((id) => pageOne.items.some((change) => change.id === id)),
    ).toBe(false);
    await page.goBack();
    await expect.poll(() => new URL(page.url()).searchParams.get('page')).toBeNull();
    await expect(history.locator('.configuration-change')).toHaveCount(25);
    await expect(history.getByLabel('Configuration history scope', { exact: true })).toHaveValue(
      'profile',
    );
    await page.goForward();
    await expect.poll(() => new URL(page.url()).searchParams.get('page')).toBe('2');
    await expect(history.locator('.configuration-change')).toHaveCount(pageTwo.items.length);
    await history
      .getByLabel('Configuration history scope', { exact: true })
      .selectOption('modules');
    await expect.poll(() => new URL(page.url()).searchParams.get('page')).toBeNull();
    await expect.poll(() => new URL(page.url()).searchParams.get('scope')).toBe('modules');
    await page.getByRole('tab', { name: 'Clinic profile', exact: true }).click();
    await expect(profileForm(page)).toBeVisible();
    await page.goBack();
    await expect(
      page.getByRole('tab', { name: 'Configuration history', exact: true }),
    ).toHaveAttribute('aria-selected', 'true');
    await expect(history.getByLabel('Configuration history scope', { exact: true })).toHaveValue(
      'modules',
    );
    await history
      .getByLabel('Configuration history scope', { exact: true })
      .selectOption('profile');
    await expect(history.locator('.configuration-change')).toHaveCount(25);
    await audit(page);
    await page.screenshot({
      path: testInfo.outputPath('configuration-history-mobile.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1280, height: 900 });

    for (const email of ['doctor@derma.demo', 'reception@derma.demo']) {
      const staff = await playwright.request.newContext({ baseURL });
      try {
        const identity = await login(staff, email);
        for (const endpoint of [base, `${base}/history?scope=all`])
          expect((await staff.get(endpoint)).status()).toBe(403);
        const settings = await get<ClinicSettings>(staff, '/api/settings');
        expect(settings).toEqual(current.settings);
        expect(JSON.stringify(settings)).not.toContain('Private paged history');
        const denied = await staff.post(`${base}/profile`, {
          headers: identity.headers,
          data: {
            profile: { ...profile, name: 'Unauthorized configuration change' },
            reason: 'Role boundary fixture',
            expectedRevision: current.profileRevision,
            requestId: randomUUID(),
          },
        });
        expect(denied.status()).toBe(403);
      } finally {
        await staff.dispose();
      }
    }

    await page.evaluate((prefix) => {
      const state = window as unknown as {
        configurationBodies: Record<string, number>;
        configurationExpired: number;
      };
      state.configurationBodies = {};
      state.configurationExpired = 0;
      window.addEventListener('derma:session-expired', () => state.configurationExpired++);
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const response = await originalFetch(input, init);
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const pathname = new URL(url, window.location.origin).pathname;
        if (pathname.startsWith(prefix)) {
          const json = response.json.bind(response);
          response.json = async () => {
            try {
              return await json();
            } finally {
              const key = `${init?.method ?? 'GET'} ${pathname} ${response.status}`;
              state.configurationBodies[key] = (state.configurationBodies[key] ?? 0) + 1;
            }
          };
        }
        return response;
      };
    }, base);
    await page.getByRole('tab', { name: 'Clinic profile', exact: true }).click();
    const pendingName = `Committed while away ${suffix}`;
    const pendingReason = `Private delayed receipt ${suffix}`;
    await draftProfile(page, pendingName, pendingReason);
    const ready = deferred(),
      release = deferred(),
      done = deferred();
    let committed: ClinicConfigurationMutation | undefined;
    const endpoint = `${base}/profile`;
    const held = async (route: Route) => {
      const response = await route.fetch();
      expect(response.status(), await response.text()).toBe(201);
      committed = (await response.json()) as ClinicConfigurationMutation;
      ready.resolve();
      await release.promise;
      try {
        await route.fulfill({ response });
      } finally {
        done.resolve();
      }
    };
    await page.route(`**${endpoint}`, held);
    try {
      await profileForm(page)
        .getByRole('button', { name: 'Save clinic details', exact: true })
        .click();
      await ready.promise;
      await expect(profileForm(page).getByLabel('Clinic name', { exact: true })).toBeDisabled();
      await page.evaluate(() => {
        window.history.pushState({ key: 'configuration-save-away' }, '', '/clinic');
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
      await expect(
        page.getByRole('heading', { name: /^A good day for better care/ }),
      ).toBeVisible();
      await page.goBack();
      await expect(profileForm(page).getByLabel('Clinic name', { exact: true })).toHaveValue(
        pendingName,
      );
      await expect(
        profileForm(page).getByLabel('Reason for profile change', { exact: true }),
      ).toHaveValue('');
      release.resolve();
      await done.promise;
      await page.waitForFunction(
        (key) =>
          (window as unknown as { configurationBodies: Record<string, number> })
            .configurationBodies[key] >= 1,
        `POST ${endpoint} 201`,
      );
      await expect(page.getByRole('tab', { name: 'Clinic profile', exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(profileForm(page).getByLabel('Clinic name', { exact: true })).toBeEnabled();
      await expect(
        profileForm(page).getByRole('button', { name: 'Retry same request', exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: 'Dismiss notification', exact: true }),
      ).toHaveCount(0);
      const savedHistory = await get<ClinicConfigurationHistory>(
        page.request,
        `${base}/history?scope=profile&pageSize=50`,
      );
      expect(
        savedHistory.items.filter((change) => change.id === committed!.change.id),
      ).toHaveLength(1);
    } finally {
      release.resolve();
      await page.unroute(`**${endpoint}`, held);
    }

    await page.evaluate(() => {
      window.history.pushState({ key: 'configuration-history-away' }, '', '/clinic');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.getByRole('heading', { name: /^A good day for better care/ })).toBeVisible();
    const readReady = deferred(),
      releaseRead = deferred();
    let heldReads = 0,
      settledReads = 0;
    const lateRead = async (route: Route) => {
      heldReads++;
      readReady.resolve();
      await releaseRead.promise;
      try {
        await route.fulfill({
          status: 401,
          json: { error: 'Discarded configuration history must not expire the current session.' },
        });
      } finally {
        settledReads++;
      }
    };
    await page.route(`**${base}/history?*`, lateRead);
    try {
      await page.evaluate(() => {
        window.history.pushState(
          { key: 'configuration-history-source' },
          '',
          '/clinic/settings?tab=history&scope=profile',
        );
        window.dispatchEvent(new PopStateEvent('popstate'));
      });
      await readReady.promise;
      await page.goBack();
      await expect(
        page.getByRole('heading', { name: /^A good day for better care/ }),
      ).toBeVisible();
      const count = heldReads;
      expect(count).toBeGreaterThan(0);
      releaseRead.resolve();
      await expect.poll(() => settledReads).toBe(count);
      await page.waitForFunction(
        ({ key, count }) =>
          (window as unknown as { configurationBodies: Record<string, number> })
            .configurationBodies[key] >= count,
        { key: `GET ${base}/history 401`, count },
      );
      expect(
        await page.evaluate(
          () => (window as unknown as { configurationExpired: number }).configurationExpired,
        ),
      ).toBe(0);
      expect((await get<Session>(page.request, '/api/session')).user?.id).toBe(
        admin.session.user!.id,
      );
    } finally {
      releaseRead.resolve();
      await page.unroute(`**${base}/history?*`, lateRead);
    }
  } finally {
    await page.unroute(`**${base}/history?*`, readFailure);
    await restore(page.request, admin.headers, original.settings);
  }
});
