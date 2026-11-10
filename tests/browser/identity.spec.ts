import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('clinic manages access, required password changes, recovery, and individual sessions', async ({
  page,
  browser,
}) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Admin', exact: true }).click();
  await page.waitForURL('/clinic');
  const adminSession = await (await page.request.get('/api/session')).json();
  const created = await page.request.post('/api/users', {
    headers: { 'X-CSRF-Token': adminSession.csrfToken },
    data: {
      name: 'Access Test Reception',
      email: 'access-browser@example.test',
      password: 'InitialAccess2026!',
      role: 'receptionist',
    },
  });
  expect(created.status()).toBe(201);
  const account = await created.json();
  const memberContext = await browser.newContext();
  const member = await memberContext.newPage();
  try {
    await member.goto('/login');
    await member.getByLabel('Email address').fill('access-browser@example.test');
    await member.getByLabel('Password', { exact: true }).fill('InitialAccess2026!');
    await member.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(member).toHaveURL(/\/account/);
    await member.goto('/clinic/patients');
    await expect(member).toHaveURL(/\/account/);
    expect((await member.request.get('/api/patients')).status()).toBe(403);
    await member.getByLabel('Initial password').fill('InitialAccess2026!');
    await member.getByLabel('New password', { exact: true }).fill('PrivateAccess2026!');
    await member.getByLabel('Confirm new password').fill('PrivateAccess2026!');
    await member.getByRole('button', { name: 'Set my password' }).click();
    await expect(member).toHaveURL('/clinic');
    await page.goto('/clinic/accounts');
    await page.getByLabel('Search accounts').fill('access-browser');
    const row = page.getByRole('row').filter({ hasText: 'access-browser@example.test' });
    await row.getByRole('button', { name: 'Suspend', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Suspend account' }).click();
    await expect(row.getByText('Suspended', { exact: true })).toBeVisible();
    await member.goto('/clinic');
    await expect(member).toHaveURL(/\/login/);
    await row.getByRole('button', { name: 'Restore', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Restore account' }).click();
    await expect(row.getByText('Active', { exact: true })).toBeVisible();
    await row.getByRole('button', { name: 'Recovery', exact: true }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: 'Create recovery link' }).click();
    const recoveryLink = await dialog.getByLabel('Private recovery link').inputValue();
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await member.goto(recoveryLink);
    await expect(member).toHaveURL('/recover');
    await member.getByLabel('New password', { exact: true }).fill('RecoveredAccess2026!');
    await member.getByLabel('Confirm new password').fill('RecoveredAccess2026!');
    await member.getByRole('button', { name: 'Reset password' }).click();
    await expect(
      member.getByRole('heading', { name: 'Your password has been reset.' }),
    ).toBeVisible();
    await member.goto('/login');
    await member.getByLabel('Email address').fill('access-browser@example.test');
    await member.getByLabel('Password', { exact: true }).fill('RecoveredAccess2026!');
    await member.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(member).toHaveURL('/clinic');
    const second = await browser.newContext();
    try {
      const response = await second.request.post('/api/auth/login', {
        data: { email: 'access-browser@example.test', password: 'RecoveredAccess2026!' },
      });
      expect(response.ok()).toBeTruthy();
      await member.goto('/account');
      await expect(member.getByRole('button', { name: 'End session', exact: true })).toHaveCount(1);
      await member.getByRole('button', { name: 'End session', exact: true }).click();
      await expect(member.getByRole('button', { name: 'End session', exact: true })).toHaveCount(0);
      expect((await (await second.request.get('/api/session')).json()).user).toBeNull();
      await member.waitForLoadState('networkidle');
      const result = await new AxeBuilder({ page: member })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze();
      expect(result.violations).toEqual([]);
    } finally {
      await second.close();
    }
    const records = await page.request.get(
      `/api/accounts?search=${encodeURIComponent(account.email)}`,
    );
    expect((await records.json())[0].active).toBe(true);
  } finally {
    await memberContext.close();
  }
});
