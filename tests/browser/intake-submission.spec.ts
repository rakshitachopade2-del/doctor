import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type {
  IntakeSubmissionCommand,
  IntakeSubmissionResult,
} from '../../shared/intake-submission';
import type { ClinicSettings, Intake, Session } from '../../shared/types';

const path = '/api/intakes/submit';
const patientId = 'patient-ananya';
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const success = (page: Page) => page.getByRole('heading', { name: 'Your story is ready.' });
const field = (page: Page, name: string) => page.getByRole('textbox', { name, exact: true });
const consent = (page: Page) => page.getByRole('checkbox', { name: /I agree to share/ });
const submitLabel = 'Share with my clinic';
const retryLabel = 'Retry exact submission';
const concernLabel = 'What would you like help with?';
const goalsLabel = 'Questions, concerns, or goals for your dermatologist';

function answers() {
  return {
    concern: 'Visit preparation ' + randomUUID().slice(0, 8),
    location: 'Hands',
    duration: 'Three weeks',
    symptoms: 'Synthetic description in my own words.',
    triggers: 'Not sure.',
    previousTreatment: 'No previous treatment reported.',
    medications: 'No medicines reported.',
    allergies: 'No known allergies reported.',
    goals: 'Discuss my history during the visit.',
    consent: true as const,
  };
}

async function login(request: APIRequestContext, role: 'patient' | 'admin') {
  const response = await request.post('/api/auth/login', {
    data: { email: role + '@derma.demo', password: 'DemoClinic2026!' },
  });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as Session;
}

async function get<T>(request: APIRequestContext, url: string): Promise<T> {
  const response = await request.get(url);
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}

async function setIntake(request: APIRequestContext, session: Session, enabled: boolean) {
  const { modules } = await get<ClinicSettings>(request, '/api/settings');
  const response = await request.patch('/api/settings', {
    headers: { 'X-CSRF-Token': session.csrfToken! },
    data: { modules: { ...modules, intake: enabled } },
  });
  expect(response.status(), await response.text()).toBe(200);
  expect((await response.json()).modules.intake).toBe(enabled);
}

async function review(page: Page, a: ReturnType<typeof answers>) {
  await field(page, concernLabel).fill('  ' + a.concern + '  ');
  await field(page, 'Which areas are affected?').fill(a.location);
  await field(page, 'How long has this been present?').fill(a.duration);
  await field(page, 'What changes or symptoms have you noticed?').fill(a.symptoms);
  await field(page, 'Have you noticed any triggers?').fill(a.triggers);
  await button(page, 'Continue').click();
  await field(page, 'Previous treatments or similar episodes').fill(a.previousTreatment);
  await field(page, 'Current medicines or supplements').fill(a.medications);
  await field(page, 'Known allergies or sensitivities').fill(a.allergies);
  await button(page, 'Continue').click();
  await field(page, goalsLabel).fill(a.goals);
  await button(page, 'Continue').click();
  await expect(page.getByRole('heading', { name: 'Review & share' })).toBeVisible();
}

async function clickSubmit(page: Page, name: string) {
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => new URL(r.url()).pathname === path && r.request().method() === 'POST',
    ),
    button(page, name).click(),
  ]);
  return response;
}

async function savedIntakes(page: Page, concern: string) {
  const record = await get<{ intakes: Intake[] }>(page.request, '/api/patients/' + patientId);
  return record.intakes.filter((intake) => intake.concern === concern);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}

async function mobileCheck(page: Page, control: Locator, screenshot: string) {
  await page.setViewportSize({ width: 320, height: 860 });
  await page.evaluate(() => document.fonts.ready);
  await control.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await expect(control).toBeInViewport({ ratio: 1 });
  expect(
    await control.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    }),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({ path: screenshot });
}

test('review shows all normalized answers and requires fresh consent after editing; the confirmed snapshot matches the shared record', async ({
  page,
}, testInfo) => {
  const patient = await login(page.request, 'patient');
  const a = answers();
  await page.goto('/intake');
  await review(page, a);
  for (const answer of Object.values(a))
    if (typeof answer === 'string')
      await expect(page.getByText(answer, { exact: true })).toBeVisible();
  await consent(page).check();
  await button(page, 'Back').click();
  a.goals = 'Ask about my updated history.';
  await field(page, goalsLabel).fill(a.goals);
  await button(page, 'Continue').click();
  await expect(consent(page)).not.toBeChecked();
  await consent(page).check();
  await mobileCheck(
    page,
    button(page, submitLabel),
    testInfo.outputPath('intake-review-mobile.png'),
  );

  const received = deferred(),
    release = deferred();
  await page.route('**' + path, async (route) => {
    const upstream = await route.fetch();
    received.resolve();
    await release.promise;
    await route.fulfill({ response: upstream });
  });
  const result = clickSubmit(page, submitLabel);
  await received.promise;
  try {
    await expect(button(page, 'Back')).toBeDisabled();
    await expect(consent(page)).toBeDisabled();
    await expect(success(page)).toHaveCount(0);
  } finally {
    release.resolve();
  }
  const response = await result;
  expect(response.status()).toBe(201);
  const request = response.request().postDataJSON();
  expect(request).toEqual({ ...a, patientId, requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  const { receipt } = await response.json();
  expect(receipt).toMatchObject({
    actorId: patient.user!.id,
    patientId,
    requestId: request.requestId,
    intake: { ...a, patientId },
  });
  await expect(success(page)).toBeVisible();
  for (const answer of Object.values(a))
    if (typeof answer === 'string')
      await expect(page.getByText(answer, { exact: true })).toBeVisible();
  await mobileCheck(
    page,
    page.getByRole('link', { name: 'View my record' }),
    testInfo.outputPath('intake-saved-mobile.png'),
  );
  expect(await savedIntakes(page, a.concern)).toEqual([receipt.intake]);
  await page.getByRole('link', { name: 'View my record' }).click();
  await expect(page).toHaveURL(/\/my-care\/record\?tab=history$/);
  await expect(page.getByRole('combobox', { name: 'Record section' })).toHaveValue('history');
  await expect(page.getByRole('heading', { name: a.concern, exact: true })).toBeVisible();
});

test('a committed intake is recovered after lost and mismatched replies, navigation and a clinic pause', async ({
  page,
  playwright,
  baseURL,
}, testInfo) => {
  await login(page.request, 'patient');
  const admin = await playwright.request.newContext({ baseURL });
  const staff = await login(admin, 'admin');
  const a = answers();
  const commands: IntakeSubmissionCommand[] = [];
  let original!: IntakeSubmissionResult;
  try {
    await page.goto('/intake');
    await review(page, a);
    await consent(page).check();
    await page.route('**' + path, async (route) => {
      commands.push(route.request().postDataJSON());
      if (commands.length === 1) {
        const response = await route.fetch();
        expect(response.status()).toBe(201);
        original = await response.json();
        return route.abort('failed');
      }
      const { receipt } = original;
      switch (commands.length) {
        case 2:
          return route.fulfill({ json: {} });
        case 3:
          return route.fulfill({ json: { receipt: { ...receipt, actorId: 'different-account' } } });
        case 4:
          return route.fulfill({
            json: {
              receipt: {
                ...receipt,
                intake: { ...receipt.intake, medications: 'Different answers' },
              },
            },
          });
        case 5:
          return route.fulfill({
            json: { receipt: { ...receipt, intake: { ...receipt.intake, consent: false } } },
          });
        default:
          return route.continue();
      }
    });
    await button(page, submitLabel).click();
    await expect(button(page, retryLabel)).toBeEnabled();
    await mobileCheck(
      page,
      button(page, retryLabel),
      testInfo.outputPath('intake-retry-mobile.png'),
    );
    await page.setViewportSize({ width: 1280, height: 720 });
    for (let attempt = 2; attempt <= 5; attempt++) {
      await clickSubmit(page, retryLabel);
      await expect(button(page, retryLabel)).toBeEnabled();
      await expect(button(page, 'Back')).toBeDisabled();
      await expect(success(page)).toHaveCount(0);
    }
    await setIntake(admin, staff, false);
    await page.getByRole('link', { name: 'Open workspace' }).click();
    await expect(page.getByRole('heading', { name: /^Hello,/ })).toBeVisible();
    await page.goBack();
    await expect(button(page, retryLabel)).toBeEnabled();
    await expect(page.getByText(a.concern, { exact: true })).toBeVisible();
    const recovered = await clickSubmit(page, retryLabel);
    expect(recovered.status()).toBe(200);
    expect(await recovered.json()).toEqual(original);
    await expect(success(page)).toBeVisible();
    expect(commands).toHaveLength(6);
    for (const command of commands) expect(command).toEqual(commands[0]);
    expect(await savedIntakes(page, a.concern)).toEqual([original.receipt.intake]);
    const summary = await get<unknown>(
      page.request,
      '/api/patients/' + patientId + '/care-summary',
    );
    expect(JSON.stringify(summary)).toContain(a.concern);
    expect(JSON.stringify(summary)).not.toContain(commands[0].requestId);
  } finally {
    await setIntake(admin, staff, true);
    await admin.dispose();
  }
});

test('a matching paused rejection retains the draft for review, fresh consent and a new submission', async ({
  page,
  playwright,
  baseURL,
}) => {
  const patient = await login(page.request, 'patient');
  const admin = await playwright.request.newContext({ baseURL });
  const staff = await login(admin, 'admin');
  const a = answers();
  const commands: IntakeSubmissionCommand[] = [];
  try {
    await page.goto('/intake');
    await review(page, a);
    await consent(page).check();
    await page.route('**' + path, (route) => {
      const input = route.request().postDataJSON();
      commands.push(input);
      if (commands.length === 1) return route.abort('failed');
      if (commands.length === 2)
        return route.fulfill({ status: 403, json: { error: 'No evidence' } });
      if (commands.length === 3)
        return route.fulfill({
          status: 403,
          json: {
            code: 'INTAKE_NOT_SUBMITTED',
            requestId: input.requestId,
            actorId: patient.user!.id,
            patientId,
            answers: { ...a, allergies: 'Different history' },
            message: 'Intake is paused.',
          },
        });
      return route.continue();
    });
    await button(page, submitLabel).click();
    await expect(button(page, retryLabel)).toBeEnabled();
    await setIntake(admin, staff, false);
    for (let attempt = 2; attempt <= 3; attempt++) {
      await clickSubmit(page, retryLabel);
      await expect(button(page, retryLabel)).toBeEnabled();
      await expect(button(page, 'Edit draft')).toHaveCount(0);
    }
    const refused = await clickSubmit(page, retryLabel);
    expect(refused.status()).toBe(403);
    const rejection = await refused.json();
    expect(rejection).toMatchObject({
      code: 'INTAKE_NOT_SUBMITTED',
      actorId: patient.user!.id,
      patientId,
      answers: a,
      requestId: commands[0].requestId,
    });
    await button(page, 'Edit draft').click();
    await expect(field(page, concernLabel)).toHaveValue(a.concern);
    await button(page, 'Continue').click();
    await expect(field(page, 'Known allergies or sensitivities')).toHaveValue(a.allergies);
    await button(page, 'Continue').click();
    a.goals += ' Please use the updated wording.';
    await field(page, goalsLabel).fill(a.goals);
    await button(page, 'Continue').click();
    await expect(consent(page)).not.toBeChecked();
    await setIntake(admin, staff, true);
    const replay = await page.request.post(path, {
      headers: { 'X-CSRF-Token': patient.csrfToken! },
      data: commands[0],
    });
    expect(replay.status()).toBe(403);
    expect(await replay.json()).toEqual(rejection);
    await button(page, 'Check availability').click();
    await consent(page).check();
    const fresh = await clickSubmit(page, submitLabel);
    expect(fresh.status()).toBe(201);
    await expect(success(page)).toBeVisible();
    expect(commands).toHaveLength(5);
    expect(commands.slice(0, 4)).toEqual(Array(4).fill(commands[0]));
    expect(commands[4]).toEqual({ ...a, patientId, requestId: expect.any(String) });
    expect(commands[4].requestId).not.toEqual(commands[0].requestId);
    expect(await savedIntakes(page, a.concern)).toEqual([(await fresh.json()).receipt.intake]);
  } finally {
    await setIntake(admin, staff, true);
    await admin.dispose();
  }
});

// Wait for the app to parse a held response before checking whether it expired the current session.
async function observeReplies(page: Page) {
  await page.addInitScript(() => {
    const state = window as Window & { intakeReplies?: string[]; intakeExpirations?: number };
    state.intakeReplies = [];
    state.intakeExpirations = 0;
    window.addEventListener('derma:session-expired', () => state.intakeExpirations!++);
    const fetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await fetch(...args);
      const marker = response.headers.get('X-Intake-Reply');
      if (marker) {
        const json = response.json.bind(response);
        response.json = async () => {
          try {
            return await json();
          } finally {
            state.intakeReplies!.push(marker);
          }
        };
      }
      return response;
    };
  });
}

async function expectConsumed(page: Page, marker: string) {
  await expect
    .poll(() =>
      page.evaluate(
        (value) => (window as Window & { intakeReplies?: string[] }).intakeReplies?.includes(value),
        marker,
      ),
    )
    .toBe(true);
  expect(
    await page.evaluate(
      () => (window as Window & { intakeExpirations?: number }).intakeExpirations,
    ),
  ).toBe(0);
}

async function workspace(page: Page) {
  await page.getByRole('link', { name: 'Open workspace' }).click();
  await expect(page.getByRole('heading', { name: /^Hello,/ })).toBeVisible();
}

test('obsolete settings and submission responses cannot expire a later page, and signing out clears pending history', async ({
  page,
}) => {
  const patient = await login(page.request, 'patient');
  await observeReplies(page);
  const read = deferred(),
    releaseRead = deferred();
  await page.route(
    '**/api/settings',
    async (route) => {
      read.resolve();
      await releaseRead.promise;
      await route.fulfill({
        status: 401,
        headers: { 'X-Intake-Reply': 'old-settings' },
        json: { error: 'Stale session response' },
      });
    },
    { times: 1 },
  );
  await page.goto('/intake', { waitUntil: 'domcontentloaded' });
  await read.promise;
  try {
    await workspace(page);
    await page.goBack();
    await expect(field(page, concernLabel)).toBeEditable();
    await field(page, concernLabel).fill('Still editing after Back');
  } finally {
    releaseRead.resolve();
  }
  await expectConsumed(page, 'old-settings');
  await expect(field(page, concernLabel)).toHaveValue('Still editing after Back');

  const a = answers();
  await review(page, a);
  await consent(page).check();
  const write = deferred(),
    releaseWrite = deferred();
  await page.route(
    '**' + path,
    async (route) => {
      write.resolve();
      await releaseWrite.promise;
      await route.fulfill({
        status: 401,
        headers: { 'X-Intake-Reply': 'old-submission' },
        json: { error: 'Stale submission response' },
      });
    },
    { times: 1 },
  );
  await button(page, submitLabel).click();
  await write.promise;
  try {
    await workspace(page);
  } finally {
    releaseWrite.resolve();
  }
  await expectConsumed(page, 'old-submission');
  expect((await get<Session>(page.request, '/api/session')).user?.id).toBe(patient.user!.id);
  await page.goBack();
  await expect(button(page, retryLabel)).toBeEnabled();
  await expect(page.getByText(a.concern, { exact: true })).toBeVisible();
  await workspace(page);
  await page.getByTitle('Sign out', { exact: true }).click();
  await page.getByLabel('Email address', { exact: true }).fill('patient@derma.demo');
  await page.getByLabel('Password', { exact: true }).fill('DemoClinic2026!');
  await button(page, 'Sign in').click();
  await page.getByRole('link', { name: 'Prepare your history', exact: true }).click();
  await expect(field(page, concernLabel)).toHaveValue('');
  await expect(button(page, retryLabel)).toHaveCount(0);
  expect(await savedIntakes(page, a.concern)).toEqual([]);
});

test('a delayed saved reply cannot confirm a revisited page; a full reload clears the retry while the original record remains', async ({
  page,
}) => {
  await login(page.request, 'patient');
  await observeReplies(page);
  await page.goto('/intake');
  const a = answers();
  await review(page, a);
  await consent(page).check();
  const committed = deferred(),
    release = deferred();
  let result!: IntakeSubmissionResult;
  await page.route(
    '**' + path,
    async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      result = await response.json();
      committed.resolve();
      await release.promise;
      await route.fulfill({
        response,
        headers: { ...response.headers(), 'X-Intake-Reply': 'old-saved' },
      });
    },
    { times: 1 },
  );
  await button(page, submitLabel).click();
  await committed.promise;
  try {
    await workspace(page);
    await page.goBack();
    await expect(button(page, retryLabel)).toBeEnabled();
  } finally {
    release.resolve();
  }
  await expectConsumed(page, 'old-saved');
  await expect(button(page, retryLabel)).toBeEnabled();
  await expect(success(page)).toHaveCount(0);
  await page.reload();
  await expect(field(page, concernLabel)).toHaveValue('');
  await expect(button(page, retryLabel)).toHaveCount(0);
  expect(await savedIntakes(page, a.concern)).toEqual([result.receipt.intake]);
});
