import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import type { AuditEntry, Session, User } from '../../shared/types';
import type { PatientSearchPage, SearchPage } from '../../shared/record-search';

const password = 'SyntheticAuthSecurity2026!';
function registration() {
  const suffix = randomUUID();
  return {
    name: `Synthetic security ${suffix.slice(0, 8)}`,
    email: `security-${suffix}@example.test`,
    password,
    phone: '+91 9000000319',
    dob: '1992-06-15',
    gender: 'prefer-not-to-say',
  };
}
async function get<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path);
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
function mutation(page: Page, path: string) {
  return page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === path && response.request().method() === 'POST',
  );
}
async function signIn(page: Page, email: string, secret = password, status = 200) {
  await page.goto('/login');
  await page.getByLabel('Email address', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(secret);
  const response = mutation(page, '/api/auth/login');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const result = await response;
  expect(result.status(), await result.text()).toBe(status);
  return result;
}
async function audit(request: APIRequestContext, action: string, entityId?: string) {
  const filters = new URLSearchParams({ action, pageSize: '25' });
  if (entityId) filters.set('entityId', entityId);
  return get<SearchPage<AuditEntry>>(request, `/api/search/audit?${filters}`);
}

test('an unconfirmed signup remains one patient account and administrators can inspect its registration', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(60000);
  const baseURL = String(testInfo.project.use.baseURL);
  const input = registration();
  let committed: Session | null = null;
  await page.route(
    '**/api/auth/register',
    async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch();
      expect(response.status(), await response.text()).toBe(201);
      committed = (await response.json()) as Session;
      await route.fulfill({
        response,
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Synthetic registration response lost after commit.' }),
      });
    },
    { times: 1 },
  );
  await page.goto('/register');
  await page.getByLabel('Full name', { exact: true }).fill(input.name);
  await page.getByLabel('Email address', { exact: true }).fill(input.email);
  await page.getByLabel('Password', { exact: true }).fill(input.password);
  await page.getByLabel('Phone number', { exact: true }).fill(input.phone);
  await page.getByLabel('Date of birth', { exact: true }).fill(input.dob);
  const unknown = mutation(page, '/api/auth/register');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  expect((await unknown).status()).toBe(503);
  await expect(page.getByRole('alert')).toContainText(
    'Synthetic registration response lost after commit.',
  );
  await expect(page).toHaveURL('/register');
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
  expect(committed).not.toBeNull();
  const created = committed as unknown as Session;
  expect(created.user?.role).toBe('patient');

  // Recovery uses the normal sign-in flow; signup is never blindly replayed as a
  // second identity. A duplicate server submission must remain a conflict.
  await signIn(page, input.email);
  await expect(page).toHaveURL('/my-care');
  expect((await get<Session>(page.request, '/api/session')).user?.id).toBe(created.user!.id);
  const duplicate = await page.request.post('/api/auth/register', { data: input });
  expect(duplicate.status()).toBe(409);
  expect((await get<Session>(page.request, '/api/session')).user?.id).toBe(created.user!.id);

  const first = await browser.newContext({ baseURL }),
    second = await browser.newContext({ baseURL }),
    administrator = await browser.newContext({ baseURL });
  try {
    const contested = registration();
    const results = await Promise.all([
      first.request.post('/api/auth/register', { data: contested }),
      second.request.post('/api/auth/register', { data: contested }),
    ]);
    expect(results.map((response) => response.status()).sort()).toEqual([201, 409]);
    const winner = (await results.find((response) => response.status() === 201)!.json()) as Session;
    const loserContext = results[0].status() === 409 ? first : second;
    expect((await get<Session>(loserContext.request, '/api/session')).user).toBeNull();

    const admin = await administrator.newPage();
    await signIn(admin, 'admin@derma.demo', 'DemoClinic2026!');
    await expect(admin).toHaveURL('/clinic');
    for (const candidate of [
      { input, user: created.user! },
      { input: contested, user: winner.user! },
    ]) {
      const accounts = await get<User[]>(
        admin.request,
        `/api/accounts?search=${encodeURIComponent(candidate.input.email)}`,
      );
      expect(accounts.filter((account) => account.email === candidate.input.email)).toHaveLength(1);
      const patients = await get<PatientSearchPage>(
        admin.request,
        `/api/search/patients?q=${encodeURIComponent(candidate.input.email)}`,
      );
      expect(
        patients.items.filter((patient) => patient.email === candidate.input.email),
      ).toHaveLength(1);
      expect(patients.items[0].id).toBe(candidate.user.patientId);
      expect((await audit(admin.request, 'registered', candidate.user.id)).total).toBe(1);
    }
    await admin.goto(
      `/clinic/audit?action=registered&entityId=${encodeURIComponent(created.user!.id)}`,
    );
    await expect(admin.locator('.audit-row')).toHaveCount(1);
    await expect(admin.locator('.audit-row')).toContainText(input.name);
    await expect(admin.locator('.audit-row')).toContainText('registered');
    const ownAudit = await page.request.get('/api/search/audit');
    expect(ownAudit.status()).toBe(403);
  } finally {
    await first.close();
    await second.close();
    await administrator.close();
  }
});

test('failed logout keeps the authenticated session until successful revocation is audited', async ({
  page,
  browser,
}, testInfo) => {
  const observerContext = await browser.newContext({
    baseURL: String(testInfo.project.use.baseURL),
  });
  try {
    const observer = await observerContext.newPage();
    await signIn(observer, 'admin@derma.demo', 'DemoClinic2026!');
    await expect(observer).toHaveURL('/clinic');
    await signIn(page, 'reception@derma.demo', 'DemoClinic2026!');
    await expect(page).toHaveURL('/clinic');
    const before = await get<Session>(page.request, '/api/session');
    const initialAudit = await audit(observer.request, 'signed out', before.user!.id);
    await page.route(
      '**/api/auth/logout',
      (route) =>
        route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'Synthetic logout failure. Your session is still active.',
          }),
        }),
      { times: 1 },
    );
    let response = mutation(page, '/api/auth/logout');
    await page.getByTitle('Sign out', { exact: true }).click();
    expect((await response).status()).toBe(500);
    await expect(page.locator('.toast-error')).toContainText('Synthetic logout failure.');
    await expect(page).toHaveURL('/clinic');
    expect((await get<Session>(page.request, '/api/session')).user?.id).toBe(before.user!.id);
    expect((await audit(observer.request, 'signed out', before.user!.id)).total).toBe(
      initialAudit.total,
    );
    await page.reload();
    await expect(page.getByTitle('Sign out', { exact: true })).toBeVisible();
    expect((await page.request.get('/api/search/patients')).ok()).toBeTruthy();
    response = mutation(page, '/api/auth/logout');
    await page.getByTitle('Sign out', { exact: true }).click();
    expect((await response).status()).toBe(200);
    await expect(page).toHaveURL('/login');
    expect((await get<Session>(page.request, '/api/session')).user).toBeNull();
    expect((await page.request.get('/api/search/patients')).status()).toBe(401);
    const completed = await audit(observer.request, 'signed out', before.user!.id);
    expect(completed.total).toBe(initialAudit.total + 1);
    await observer.goto(
      `/clinic/audit?action=signed%20out&entityId=${encodeURIComponent(before.user!.id)}`,
    );
    await expect(observer.locator('.audit-row')).toHaveCount(1);
    await expect(observer.locator('.audit-row')).toContainText(before.user!.name);
    await observer.setViewportSize({ width: 320, height: 760 });
    await expect
      .poll(() =>
        observer.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      )
      .toBeTruthy();
    expect(
      (
        await new AxeBuilder({ page: observer })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze()
      ).violations,
    ).toEqual([]);
    await observer.screenshot({
      path: testInfo.outputPath('authentication-audit-mobile.png'),
      fullPage: true,
    });
  } finally {
    await observerContext.close();
  }
});

// This final journey deliberately exhausts the isolated project's network login
// budget. Earlier journeys use four successful logins; this one consumes the
// remaining allowed attempts before asserting the separate network boundary.
test('password throttling survives reload and new contexts, blocks correct credentials, and leaves private bounded audit evidence', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(90000);
  const baseURL = String(testInfo.project.use.baseURL);
  const setup = await browser.newContext({ baseURL });
  const administrator = await browser.newContext({ baseURL });
  const fresh = await browser.newContext({ baseURL });
  try {
    const input = registration();
    const created = await setup.request.post('/api/auth/register', { data: input });
    expect(created.status(), await created.text()).toBe(201);
    const admin = await administrator.newPage();
    await signIn(admin, 'admin@derma.demo', 'DemoClinic2026!');
    await expect(admin).toHaveURL('/clinic');
    const initial = await audit(admin.request, 'authentication');
    const existingIds = new Set(initial.items.map((entry) => entry.id));
    await page.goto('/login');
    await page.getByLabel('Email address', { exact: true }).fill(input.email);
    const wrongPassword = 'SyntheticWrongPassword2026!';
    for (let attempt = 0; attempt < 10; attempt++) {
      await page.getByLabel('Password', { exact: true }).fill(wrongPassword);
      const next = mutation(page, '/api/auth/login');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      const result = await next;
      expect(result.status(), await result.text()).toBe(401);
      expect(await result.json()).toEqual({ error: 'Email or password is incorrect.' });
      await expect(page.getByRole('alert')).toHaveText('Email or password is incorrect.');
      await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
    }
    const failures = await audit(admin.request, 'authentication failed');
    const firstFailure = failures.items.find((entry) => !existingIds.has(entry.id));
    expect(firstFailure).toBeDefined();
    expect(firstFailure!.entityType).toBe('auth-security');
    expect(firstFailure!.actorName).toBe('Unauthenticated');
    expect(firstFailure!.entityId).toMatch(/^identifier:login:[a-f0-9]{64}$/);

    async function expectThrottle(response: Awaited<ReturnType<typeof mutation>>) {
      expect(response.status(), await response.text()).toBe(429);
      const seconds = Number(response.headers()['retry-after']);
      expect(Number.isInteger(seconds)).toBeTruthy();
      expect(seconds).toBeGreaterThan(0);
      expect(seconds).toBeLessThanOrEqual(900);
      const body = await response.json();
      expect(body.error).toContain(`Wait at least ${seconds} seconds before trying again.`);
      expect(JSON.stringify(body)).not.toContain(input.email);
      return seconds;
    }
    await page.getByLabel('Password', { exact: true }).fill(password);
    let blocked = mutation(page, '/api/auth/login');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    const firstWait = await expectThrottle(await blocked);
    await expect(page.getByRole('alert')).toContainText('Wait at least');
    expect((await get<Session>(page.request, '/api/session')).user).toBeNull();

    await page.reload();
    await page.getByLabel('Email address', { exact: true }).fill(input.email.toUpperCase());
    await page.getByLabel('Password', { exact: true }).fill(password);
    blocked = mutation(page, '/api/auth/login');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    expect(await expectThrottle(await blocked)).toBeLessThanOrEqual(firstWait);
    await expect(page).toHaveURL('/login');
    await expect(page.getByRole('alert')).toContainText('Wait at least');
    const persistent = await fresh.request.post('/api/auth/login', {
      data: { email: ` ${input.email} `, password },
    });
    expect(persistent.status(), await persistent.text()).toBe(429);
    expect(Number(persistent.headers()['retry-after'])).toBeLessThanOrEqual(firstWait);
    expect((await get<Session>(fresh.request, '/api/session')).user).toBeNull();

    // Another identifier is still permitted at this point: the preceding block
    // therefore came from the failed-password identifier window, not the IP cap.
    const unrelated = await fresh.request.post('/api/auth/login', {
      data: { email: 'patient@derma.demo', password: 'DemoClinic2026!' },
    });
    expect(unrelated.status(), await unrelated.text()).toBe(200);
    const recorded = await get<SearchPage<AuditEntry>>(
      admin.request,
      `/api/search/audit?entityType=auth-security&entityId=${encodeURIComponent(firstFailure!.entityId)}`,
    );
    expect(recorded.total).toBe(3);
    expect(recorded.items.map((entry) => entry.action).sort()).toEqual(
      [
        'authentication failed',
        'authentication failure limit reached',
        'authentication throttled',
      ].sort(),
    );
    expect(recorded.items.every((entry) => entry.actorName === 'Unauthenticated')).toBeTruthy();
    for (const secret of [input.email, wrongPassword, password, '127.0.0.1'])
      expect(JSON.stringify(recorded.items)).not.toContain(secret);
    await admin.goto(
      `/clinic/audit?entityType=auth-security&entityId=${encodeURIComponent(firstFailure!.entityId)}`,
    );
    await expect(admin.locator('.audit-row')).toHaveCount(3);
    await expect(admin.locator('.audit-results-card')).toContainText(
      'authentication failure limit reached',
    );
    await expect(admin.locator('.audit-results-card')).toContainText('authentication throttled');

    // Fill any remaining per-network allowance without creating identifier
    // failures. This also keeps the test independently runnable with --grep.
    let networkBlocked = false;
    for (let remaining = 0; remaining < 20; remaining++) {
      const result = await page.request.post('/api/auth/login', {
        data: { email: 'invalid', password: 'x' },
      });
      if (result.status() === 429) {
        networkBlocked = true;
        break;
      }
      expect(result.status(), await result.text()).toBe(400);
    }
    expect(networkBlocked).toBeTruthy();
    const network = await fresh.request.post('/api/auth/login', {
      data: { email: 'patient@derma.demo', password: 'DemoClinic2026!' },
    });
    expect(network.status(), await network.text()).toBe(429);
    expect(Number(network.headers()['retry-after'])).toBeGreaterThan(0);
    expect((await network.json()).error).toContain('Wait at least');

    await page.setViewportSize({ width: 320, height: 760 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
      .toBeTruthy();
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations,
    ).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath('throttled-login-mobile.png'),
      fullPage: true,
    });
  } finally {
    await setup.close();
    await administrator.close();
    await fresh.close();
  }
});
