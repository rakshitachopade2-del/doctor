import {
  test,
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
  type Route,
} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createHmac, randomUUID } from 'node:crypto';
import type { Session } from '../../shared/types';
import type { MfaChallenge, MfaMutation, MfaPreparation, MfaStatus } from '../../shared/mfa';

const password = 'SyntheticMfaPassword2026!';
// Independent reference implementation; RFC 6238 Appendix B vectors below verify the helper.
// https://www.rfc-editor.org/rfc/rfc6238.html#appendix-B
function totp(secret: string, counter = Math.floor(Date.now() / 30000), digits = 6) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0,
    accumulator = 0;
  const bytes: number[] = [];
  for (const character of secret.replace(/=+$/, '').toUpperCase()) {
    const value = alphabet.indexOf(character);
    if (value < 0) throw new Error('Invalid synthetic Base32 fixture.');
    accumulator = (accumulator << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 255);
      accumulator &= (1 << bits) - 1;
    }
  }
  const moving = Buffer.alloc(8);
  moving.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', Buffer.from(bytes)).update(moving).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).padStart(digits, '0');
}
async function get<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path);
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
async function post<T>(
  request: APIRequestContext,
  path: string,
  data: unknown,
  headers: Record<string, string> = {},
  status = 200,
): Promise<T> {
  const response = await request.post(path, { headers, data });
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}
async function register(request: APIRequestContext) {
  const email = `mfa-${randomUUID()}@example.test`;
  const session = await post<Session>(
    request,
    '/api/auth/register',
    {
      name: `Synthetic MFA ${randomUUID().slice(0, 8)}`,
      email,
      password,
      phone: '+91 9000000242',
      dob: '1993-06-15',
      gender: 'prefer-not-to-say',
    },
    {},
    201,
  );
  return { email, session, headers: { 'X-CSRF-Token': session.csrfToken! } };
}
async function enroll(request: APIRequestContext, headers: Record<string, string>) {
  const status = await get<MfaStatus>(request, '/api/auth/mfa');
  const prepared = await post<MfaPreparation>(
    request,
    '/api/auth/mfa/enrollment/prepare',
    { currentPassword: password, expectedRevision: status.revision, requestId: randomUUID() },
    headers,
  );
  const counter = Math.floor(Date.now() / 30000);
  const enabled = await post<MfaMutation>(
    request,
    '/api/auth/mfa/enrollment/confirm',
    {
      pendingId: prepared.setup.id,
      code: totp(prepared.setup.secret!, counter),
      savedRecoveryCodes: true,
      expectedRevision: prepared.status.revision,
      requestId: randomUUID(),
    },
    headers,
  );
  expect(enabled.status).toMatchObject({ enabled: true, recoveryCodesRemaining: 10 });
  return { prepared, enabled, counter };
}
async function challenge(request: APIRequestContext, email: string, secretPassword = password) {
  const response = await request.post('/api/auth/login', {
    data: { email, password: secretPassword },
  });
  expect(response.status(), await response.text()).toBe(202);
  const value = (await response.json()) as MfaChallenge;
  expect(value.mfaRequired).toBe(true);
  expect(value).not.toHaveProperty('user');
  return value;
}
async function apiRecoverySignIn(
  request: APIRequestContext,
  email: string,
  code: string,
  secretPassword = password,
) {
  const pending = await challenge(request, email, secretPassword);
  return post<Session>(
    request,
    '/api/auth/mfa/verify',
    { proof: { method: 'recovery-code', code } },
    { 'X-MFA-CSRF-Token': pending.csrfToken },
  );
}
async function logout(request: APIRequestContext) {
  const session = await get<Session>(request, '/api/session');
  await post(request, '/api/auth/logout', {}, { 'X-CSRF-Token': session.csrfToken! });
}
function mutation(page: Page, path: string) {
  return page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === path && response.request().method() === 'POST',
  );
}
async function passwordStep(page: Page, email: string, secretPassword = password, next = '') {
  await page.goto(`/login${next ? `?next=${encodeURIComponent(next)}` : ''}`);
  await page.getByLabel('Email address', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(secretPassword);
  const response = mutation(page, '/api/auth/login');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const result = await response;
  expect(result.status(), await result.text()).toBe(202);
  await expect(
    page.getByRole('heading', { name: 'Verify your sign-in', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
  return result.json() as Promise<MfaChallenge>;
}
async function verifyUI(page: Page, method: 'totp' | 'recovery-code', code: string, status = 200) {
  await page.getByLabel('Verification method', { exact: true }).selectOption(method);
  await page.getByLabel('Verification code', { exact: true }).fill(code);
  const response = mutation(page, '/api/auth/mfa/verify');
  await page.getByRole('button', { name: 'Verify sign-in', exact: true }).click();
  const value = await response;
  expect(value.status(), await value.text()).toBe(status);
  return value;
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
async function acknowledgeLatest(dialog: Locator) {
  await dialog.getByRole('button', { name: 'Refresh MFA status', exact: true }).click();
  await dialog
    .getByRole('button', {
      name: 'I reviewed the latest security status; keep my draft',
      exact: true,
    })
    .click();
}
async function retry(page: Page, dialog: Locator, path: string, body: unknown) {
  const response = mutation(page, path);
  await dialog.getByRole('button', { name: 'Retry same request', exact: true }).click();
  const value = await response;
  expect(value.status(), await value.text()).toBe(200);
  expect(value.request().postDataJSON()).toEqual(body);
  return value.json() as Promise<MfaMutation | MfaPreparation>;
}

test('patients activate an authenticator, prove sign-in before private access, and use one-time recovery codes with safe return paths', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(120000);
  const reference = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  expect(totp(reference, Math.floor(59 / 30), 8)).toBe('94287082');
  expect(totp(reference, Math.floor(1111111109 / 30), 8)).toBe('07081804');
  const account = await register(page.request);
  const other = await browser.newContext({ baseURL });
  const outsider = await browser.newContext({ baseURL });
  try {
    await post<Session>(other.request, '/api/auth/login', { email: account.email, password });
    await page.goto('/account');
    const card = page.locator('.mfa-security-card');
    await card.getByRole('button', { name: 'Enable authenticator', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Set up authenticator', exact: true });
    await dialog.getByLabel('Current password', { exact: true }).fill(password);
    const prepareResponse = mutation(page, '/api/auth/mfa/enrollment/prepare');
    await dialog.getByRole('button', { name: 'Prepare authenticator setup', exact: true }).click();
    const preparation = await prepareResponse;
    expect(preparation.status()).toBe(200);
    const prepared = (await preparation.json()) as MfaPreparation;
    await expect(dialog.getByLabel('Authenticator setup key', { exact: true })).toHaveValue(
      prepared.setup.secret!,
    );
    await expect(dialog.locator('.mfa-code-list li')).toHaveCount(10);
    expect(
      (await dialog.locator('.mfa-code-list li').allTextContents()).map((value) => value.trim()),
    ).toEqual(prepared.setup.recoveryCodes);
    expect(new URL(prepared.setup.otpauthUri!).protocol).toBe('otpauth:');
    const staged = await get<MfaStatus>(page.request, '/api/auth/mfa');
    expect(staged.enabled).toBe(false);
    expect(JSON.stringify(staged)).not.toContain(prepared.setup.secret!);
    for (const code of prepared.setup.recoveryCodes)
      expect(JSON.stringify(staged)).not.toContain(code);
    await expect(
      dialog.getByRole('button', { name: 'Activate authenticator', exact: true }),
    ).toBeDisabled();
    const counter = Math.floor(Date.now() / 30000);
    const activationCode = totp(prepared.setup.secret!, counter);
    await dialog.getByLabel('Authenticator code', { exact: true }).fill(activationCode);
    await dialog.getByLabel('I saved these recovery codes privately', { exact: true }).check();
    const activateResponse = mutation(page, '/api/auth/mfa/enrollment/confirm');
    await dialog.getByRole('button', { name: 'Activate authenticator', exact: true }).click();
    expect((await activateResponse).status()).toBe(200);
    await expect(dialog.locator('.mfa-operation-receipt')).toContainText('Authenticator enabled');
    await expect(dialog.locator('.mfa-code-list')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(card.locator('.mfa-security-summary')).toContainText(
      '10 recovery codes remaining',
    );
    expect((await get<Session>(other.request, '/api/session')).user).toBeNull();
    await logout(page.request);
    const pending = await passwordStep(page, account.email, password, '/my-care/summary');
    expect(pending.accountId).toBe(account.session.user!.id);
    expect((await get<Session>(page.request, '/api/session')).user).toBeNull();
    expect(
      (await page.request.get(`/api/patients/${account.session.user!.patientId}`)).status(),
    ).toBe(401);
    expect((await page.request.get('/api/auth/mfa')).status()).toBe(401);
    const cookies = await page.context().cookies();
    expect(cookies.some((cookie) => cookie.name === 'derma_session')).toBe(false);
    expect(cookies.find((cookie) => cookie.name === 'derma_mfa_challenge')).toMatchObject({
      httpOnly: true,
      sameSite: 'Lax',
      path: '/api/auth/mfa',
    });
    expect(
      (
        await outsider.request.post('/api/auth/mfa/verify', {
          headers: { 'X-MFA-CSRF-Token': pending.csrfToken },
          data: { proof: { method: 'recovery-code', code: prepared.setup.recoveryCodes[0] } },
        })
      ).status(),
    ).toBe(401);
    await verifyUI(page, 'totp', activationCode, 400);
    await expect(page.getByLabel('Verification code', { exact: true })).toHaveValue('');
    await expect(page).toHaveURL(/\/login\?next=/);
    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'Verify your sign-in', exact: true }),
    ).toBeVisible();
    const restored = await get<MfaChallenge>(page.request, '/api/auth/mfa/challenge');
    expect(restored.accountId).toBe(pending.accountId);
    await page.setViewportSize({ width: 320, height: 900 });
    await audit(page);
    await page.screenshot({
      path: testInfo.outputPath('mfa-sign-in-challenge-mobile.png'),
      fullPage: true,
    });
    const nextCode = totp(
      prepared.setup.secret!,
      Math.max(counter + 1, Math.floor(Date.now() / 30000)),
    );
    const verified = await verifyUI(page, 'totp', nextCode);
    expect(verified.request().headers()['x-mfa-csrf-token']).toBe(restored.csrfToken);
    expect(verified.request().headers()['x-csrf-token']).toBeUndefined();
    await expect(page).toHaveURL('/my-care/summary');
    expect((await get<MfaStatus>(page.request, '/api/auth/mfa')).recoveryCodesRemaining).toBe(10);
    await logout(page.request);
    await passwordStep(page, account.email, password, '//example.invalid/escape');
    await verifyUI(
      page,
      'recovery-code',
      prepared.setup.recoveryCodes[0].toLowerCase().replaceAll('-', ''),
    );
    await expect(page).toHaveURL('/my-care');
    expect((await get<MfaStatus>(page.request, '/api/auth/mfa')).recoveryCodesRemaining).toBe(9);
    const another = await challenge(other.request, account.email);
    expect(
      (
        await other.request.post('/api/auth/mfa/verify', {
          headers: { 'X-MFA-CSRF-Token': another.csrfToken },
          data: { proof: { method: 'recovery-code', code: prepared.setup.recoveryCodes[0] } },
        })
      ).status(),
    ).toBe(400);
    expect((await get<Session>(other.request, '/api/session')).user).toBeNull();
    await post<Session>(
      other.request,
      '/api/auth/mfa/verify',
      { proof: { method: 'recovery-code', code: prepared.setup.recoveryCodes[1] } },
      { 'X-MFA-CSRF-Token': another.csrfToken },
    );
    await page.goto('/account');
    await expect(card.locator('.mfa-security-summary')).toContainText('8 recovery codes remaining');
    await audit(page);
  } finally {
    await other.close();
    await outsider.close();
  }
});

test('staged recovery replacement and disabling retain exact uncertain requests and reject stale security state', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(150000);
  const account = await register(page.request);
  const { prepared } = await enroll(page.request, account.headers);
  const other = await browser.newContext({ baseURL });
  let releaseSession = () => {};
  try {
    await page.goto('/account');
    await page
      .locator('.mfa-security-card')
      .getByRole('button', { name: 'Replace recovery codes', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Replace recovery codes', exact: true });
    await dialog.getByLabel('Current password', { exact: true }).fill(password);
    await dialog.getByLabel('Verification method', { exact: true }).selectOption('recovery-code');
    await dialog.getByLabel('Recovery code', { exact: true }).fill(prepared.setup.recoveryCodes[1]);
    await apiRecoverySignIn(other.request, account.email, prepared.setup.recoveryCodes[0]);
    const preparePath = '/api/auth/mfa/recovery-codes/prepare';
    const staleResponse = mutation(page, preparePath);
    await dialog.getByRole('button', { name: 'Prepare replacement codes', exact: true }).click();
    const stale = await staleResponse;
    expect(stale.status()).toBe(409);
    await expect(dialog.getByLabel('Current password', { exact: true })).toHaveValue(password);
    await expect(dialog.getByLabel('Recovery code', { exact: true })).toHaveValue(
      prepared.setup.recoveryCodes[1],
    );
    await acknowledgeLatest(dialog);
    let prepareBody: unknown;
    let replacement: MfaPreparation | undefined;
    const malformedPrepare = async (route: Route) => {
      if (route.request().method() !== 'POST') return route.continue();
      prepareBody = route.request().postDataJSON();
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      replacement = await response.json();
      await route.fulfill({
        response,
        json: { ...replacement, setup: { ...replacement!.setup, recoveryCodes: [null] } },
      });
    };
    await page.route(`**${preparePath}`, malformedPrepare);
    await dialog.getByRole('button', { name: 'Prepare replacement codes', exact: true }).click();
    await expect(
      dialog.getByRole('button', { name: 'Retry same request', exact: true }),
    ).toBeVisible();
    await expect(dialog.getByLabel('Current password', { exact: true })).toBeDisabled();
    await expect(dialog.getByLabel('Recovery code', { exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await expect(dialog).toBeVisible();
    await page.unroute(`**${preparePath}`, malformedPrepare);
    const retriedPreparation = (await retry(
      page,
      dialog,
      preparePath,
      prepareBody,
    )) as MfaPreparation;
    expect(retriedPreparation.event).toEqual(replacement!.event);
    expect(retriedPreparation.setup).toEqual(replacement!.setup);
    await expect(dialog.locator('.mfa-code-list li')).toHaveCount(10);
    await expect(dialog.getByLabel('Current password', { exact: true })).toHaveCount(0);
    expect(replacement!.status.recoveryCodesRemaining).toBe(8);
    // Old unused recovery codes still work until the prepared replacement is confirmed.
    await apiRecoverySignIn(other.request, account.email, prepared.setup.recoveryCodes[2]);
    await dialog.getByLabel('I saved these recovery codes privately', { exact: true }).check();
    const confirmPath = '/api/auth/mfa/recovery-codes/confirm';
    const staleConfirm = mutation(page, confirmPath);
    await dialog.getByRole('button', { name: 'Confirm replacement codes', exact: true }).click();
    expect((await staleConfirm).status()).toBe(409);
    await acknowledgeLatest(dialog);
    await dialog.getByLabel('I saved these recovery codes privately', { exact: true }).check();
    let confirmBody: unknown;
    let confirmed: MfaMutation | undefined;
    const malformedConfirm = async (route: Route) => {
      if (route.request().method() !== 'POST') return route.continue();
      confirmBody = route.request().postDataJSON();
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      confirmed = await response.json();
      await route.fulfill({
        response,
        json: {
          ...confirmed,
          event: { ...confirmed!.event, after: { enabled: true, recoveryCodesRemaining: 9 } },
        },
      });
    };
    await page.route(`**${confirmPath}`, malformedConfirm);
    await dialog.getByRole('button', { name: 'Confirm replacement codes', exact: true }).click();
    await expect(
      dialog.getByRole('button', { name: 'Retry same request', exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByLabel('I saved these recovery codes privately', { exact: true }),
    ).toBeDisabled();
    await page.unroute(`**${confirmPath}`, malformedConfirm);
    expect((await retry(page, dialog, confirmPath, confirmBody)).event).toEqual(confirmed!.event);
    await expect(dialog.locator('.mfa-operation-receipt')).toContainText('Recovery codes replaced');
    expect(
      (await get<MfaStatus>(page.request, '/api/auth/mfa')).history.filter(
        (event) => event.operation === 'recovery-codes-replaced',
      ),
    ).toHaveLength(1);
    expect((await get<Session>(other.request, '/api/session')).user).toBeNull();
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    const changed = await challenge(other.request, account.email);
    expect(
      (
        await other.request.post('/api/auth/mfa/verify', {
          headers: { 'X-MFA-CSRF-Token': changed.csrfToken },
          data: { proof: { method: 'recovery-code', code: prepared.setup.recoveryCodes[3] } },
        })
      ).status(),
    ).toBe(400);
    await post<Session>(
      other.request,
      '/api/auth/mfa/verify',
      { proof: { method: 'recovery-code', code: replacement!.setup.recoveryCodes[0] } },
      { 'X-MFA-CSRF-Token': changed.csrfToken },
    );
    await page.goto('/account');
    await page
      .locator('.mfa-security-card')
      .getByRole('button', { name: 'Disable authenticator', exact: true })
      .click();
    const disableDialog = page.getByRole('dialog', { name: 'Disable authenticator', exact: true });
    await disableDialog.getByLabel('Current password', { exact: true }).fill(password);
    await disableDialog
      .getByLabel('Verification method', { exact: true })
      .selectOption('recovery-code');
    await disableDialog
      .getByLabel('Recovery code', { exact: true })
      .fill(replacement!.setup.recoveryCodes[1]);
    await expect(
      disableDialog.getByRole('button', { name: 'Disable authenticator', exact: true }),
    ).toBeDisabled();
    await disableDialog
      .getByLabel('I understand future sign-ins will use only my password', { exact: true })
      .check();
    const disablePath = '/api/auth/mfa/disable';
    let disableBody: unknown;
    let disabled: MfaMutation | undefined;
    const lostDisable = async (route: Route) => {
      if (route.request().method() !== 'POST') return route.continue();
      disableBody = route.request().postDataJSON();
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      disabled = await response.json();
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Synthetic committed response lost.' }),
      });
    };
    await page.route(`**${disablePath}`, lostDisable);
    await disableDialog.getByRole('button', { name: 'Disable authenticator', exact: true }).click();
    await expect(
      disableDialog.getByRole('button', { name: 'Retry same request', exact: true }),
    ).toBeVisible();
    await expect(disableDialog.getByLabel('Current password', { exact: true })).toBeDisabled();
    await page.unroute(`**${disablePath}`, lostDisable);
    // Keep the successful security action's background session refresh in flight.
    // Explicit sign-out must invalidate this real, previously authenticated response.
    let sessionArrived!: () => void, sessionFinished!: () => void;
    const sessionGate = new Promise<void>((resolve) => {
      releaseSession = resolve;
    });
    const sessionReady = new Promise<void>((resolve) => {
      sessionArrived = resolve;
    });
    const sessionDone = new Promise<void>((resolve) => {
      sessionFinished = resolve;
    });
    const heldSession = async (route: Route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      expect(((await response.json()) as Session).user?.id).toBe(account.session.user!.id);
      sessionArrived();
      await sessionGate;
      try {
        await route.fulfill({ response });
      } finally {
        sessionFinished();
      }
    };
    await page.route('**/api/session', heldSession);
    expect((await retry(page, disableDialog, disablePath, disableBody)).event).toEqual(
      disabled!.event,
    );
    await sessionReady;
    await expect(disableDialog.locator('.mfa-operation-receipt')).toContainText(
      'Authenticator disabled',
    );
    const final = await get<MfaStatus>(page.request, '/api/auth/mfa');
    expect(final).toMatchObject({ enabled: false, recoveryCodesRemaining: 0, pending: null });
    expect(final.history.filter((event) => event.operation === 'disabled')).toHaveLength(1);
    expect((await get<Session>(page.request, '/api/session')).user?.id).toBe(
      account.session.user!.id,
    );
    expect((await get<Session>(other.request, '/api/session')).user).toBeNull();
    await post<Session>(other.request, '/api/auth/login', { email: account.email, password });
    await disableDialog.getByRole('button', { name: 'Done', exact: true }).click();
    await page.setViewportSize({ width: 320, height: 900 });
    await audit(page);
    await page.screenshot({
      path: testInfo.outputPath('mfa-security-history-mobile.png'),
      fullPage: true,
    });
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page).toHaveURL('/login');
    await expect(
      page.locator('.public-header').getByRole('link', { name: 'Sign in', exact: true }),
    ).toBeVisible();
    releaseSession();
    await sessionDone;
    await page.unroute('**/api/session', heldSession);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(page).toHaveURL('/login');
    await expect(
      page.locator('.public-header').getByRole('link', { name: 'Open workspace', exact: true }),
    ).toHaveCount(0);
    expect((await get<Session>(page.request, '/api/session')).user).toBeNull();
  } finally {
    releaseSession();
    await other.close();
  }
});

test('password recovery preserves MFA and uncertain sign-in never trusts another account or a discarded session response', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(150000);
  const account = await register(page.request);
  const { prepared } = await enroll(page.request, account.headers);
  const admin = await browser.newContext({ baseURL });
  try {
    const adminSession = await post<Session>(admin.request, '/api/auth/login', {
      email: 'admin@derma.demo',
      password: 'DemoClinic2026!',
    });
    const grant = await post<{ token: string }>(
      admin.request,
      `/api/accounts/${account.session.user!.id}/recovery`,
      { identityVerified: true },
      { 'X-CSRF-Token': adminSession.csrfToken! },
      201,
    );
    const recoveredPassword = 'RecoveredSyntheticMfa2026!';
    await page.goto(`/recover#token=${grant.token}`);
    await page.getByLabel('New password', { exact: true }).fill(recoveredPassword);
    await page.getByLabel('Confirm new password', { exact: true }).fill(recoveredPassword);
    await page.getByRole('button', { name: 'Reset password', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Your password has been reset.', exact: true }),
    ).toBeVisible();
    expect((await get<Session>(page.request, '/api/session')).user).toBeNull();
    await passwordStep(page, account.email, recoveredPassword);
    const fakeVerify = async (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    await page.route('**/api/auth/mfa/verify', fakeVerify);
    await verifyUI(page, 'recovery-code', prepared.setup.recoveryCodes[0]);
    await expect(
      page.getByRole('button', { name: 'Check sign-in status', exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel('Verification code', { exact: true })).toHaveValue('');
    await page.unroute('**/api/auth/mfa/verify', fakeVerify);
    const wrongSession = async (route: Route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(adminSession),
      });
    await page.route('**/api/session', wrongSession);
    await page.getByRole('button', { name: 'Check sign-in status', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Sign-in is not confirmed.');
    await expect(page).toHaveURL('/login');
    await expect(
      page.locator('.public-header').getByRole('link', { name: 'Open workspace', exact: true }),
    ).toHaveCount(0);
    await page.unroute('**/api/session', wrongSession);
    await page.getByRole('button', { name: 'Start again', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
    expect((await page.request.get('/api/auth/mfa/challenge')).status()).toBe(401);
    await passwordStep(page, account.email, recoveredPassword, '/my-care');
    const committedVerify = async (route: Route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.fulfill({ response, json: { ok: true } });
    };
    await page.route('**/api/auth/mfa/verify', committedVerify);
    await verifyUI(page, 'recovery-code', prepared.setup.recoveryCodes[0]);
    await expect(
      page.getByRole('button', { name: 'Check sign-in status', exact: true }),
    ).toBeVisible();
    await page.unroute('**/api/auth/mfa/verify', committedVerify);
    await page.getByRole('button', { name: 'Check sign-in status', exact: true }).click();
    await expect(page).toHaveURL('/my-care');
    expect(await get<MfaStatus>(page.request, '/api/auth/mfa')).toMatchObject({
      enabled: true,
      recoveryCodesRemaining: 9,
    });
    await logout(page.request);
    await passwordStep(page, account.email, recoveredPassword);
    const notices = page.getByRole('button', { name: 'Dismiss notification', exact: true });
    while (await notices.count()) await notices.first().click();
    let release!: () => void, arrived!: () => void, finished!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const done = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const heldSession = async (route: Route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      arrived();
      await gate;
      try {
        await route.fulfill({ response });
      } catch {
        /* An aborted login refresh must stay discarded. */
      } finally {
        finished();
      }
    };
    await page.route('**/api/session', heldSession);
    try {
      await verifyUI(page, 'recovery-code', prepared.setup.recoveryCodes[1]);
      await ready;
      await page.getByRole('link', { name: 'Create a patient account', exact: true }).click();
      await expect(page).toHaveURL('/register');
      release();
      await done;
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await expect(page).toHaveURL('/register');
      await expect(
        page.locator('.public-header').getByRole('link', { name: 'Sign in', exact: true }),
      ).toBeVisible();
      await expect(
        page.locator('.public-header').getByRole('link', { name: 'Open workspace', exact: true }),
      ).toHaveCount(0);
      await expect(page.getByText('Welcome back.', { exact: true })).toHaveCount(0);
    } finally {
      release();
      await page.unroute('**/api/session', heldSession);
    }
    await page.setViewportSize({ width: 320, height: 900 });
    await audit(page);
    await page.screenshot({
      path: testInfo.outputPath('mfa-discarded-login-mobile.png'),
      fullPage: true,
    });
    expect(
      await page.evaluate(() => Object.keys(localStorage).concat(Object.keys(sessionStorage))),
    ).toEqual([]);
  } finally {
    await admin.close();
  }
});
