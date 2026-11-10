import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('patient activity stays private, supports explicit read state, and opens the source record', async ({
  page,
  playwright,
  baseURL,
}, testInfo) => {
  const doctor = await playwright.request.newContext({ baseURL });
  try {
    const login = await doctor.post('/api/auth/login', {
      data: { email: 'doctor@derma.demo', password: 'DemoClinic2026!' },
    });
    expect(login.ok()).toBeTruthy();
    const doctorSession = await login.json();
    const headers = { 'X-CSRF-Token': doctorSession.csrfToken };
    const message = `Synthetic inbox message ${Date.now()}`;
    expect(
      (
        await doctor.post('/api/messages', {
          headers,
          data: { patientId: 'patient-ananya', body: message },
        })
      ).status(),
    ).toBe(201);
    await page.goto('/login');
    await page.getByLabel('Email address').fill('patient@derma.demo');
    await page.getByLabel('Password', { exact: true }).fill('DemoClinic2026!');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL('/my-care');
    await expect(page.getByRole('link', { name: /Activity, \d+ unread/ })).toBeVisible();
    await page.goto('/my-care/activity');
    const item = page
      .locator('.activity-item')
      .filter({ hasText: 'Your clinic sent a message' })
      .first();
    await expect(item.getByText('Unread', { exact: true })).toBeVisible();
    const before = (await (await page.request.get('/api/activity')).json()).unreadCount;
    await item.getByRole('link', { name: 'Open update →' }).click();
    await expect(page).toHaveURL('/my-care/messages');
    await expect(page.getByText(message, { exact: true })).toBeVisible();
    await page.goto('/my-care/activity');
    expect((await (await page.request.get('/api/activity')).json()).unreadCount).toBe(before);
    await item.getByRole('button', { name: 'Mark read', exact: true }).click();
    await expect(item.getByText('Read', { exact: true })).toBeVisible();
    expect((await (await page.request.get('/api/activity')).json()).unreadCount).toBe(before - 1);
    const ordered = await doctor.post('/api/investigations', {
      headers,
      data: {
        patientId: 'patient-ananya',
        title: 'Inbox investigation example',
        kind: 'other',
        reason: 'Synthetic workflow only',
        instructions: 'Share a synthetic note for review.',
      },
    });
    expect(ordered.status()).toBe(201);
    await page.getByRole('button', { name: 'Refresh updates', exact: true }).click();
    const order = page
      .locator('.activity-item')
      .filter({ hasText: 'Your clinician requested an investigation' })
      .first();
    await expect(order).toBeVisible();
    await order.getByRole('link', { name: 'Open update →' }).click();
    await expect(page).toHaveURL(/record\?tab=workflows/);
    await expect(
      page.getByRole('heading', { name: 'Inbox investigation example', exact: true }),
    ).toBeVisible();
    await page.goto('/my-care/activity');
    await page.getByRole('button', { name: 'Mark all read', exact: true }).click();
    await expect(page.locator('.activity-unread')).toHaveCount(0);
    await page.getByRole('button', { name: /^Unread/ }).click();
    await expect(page.getByText('You’re caught up', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'All updates', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForLoadState('networkidle');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations,
    ).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath('patient-activity-mobile.png'),
      fullPage: true,
    });
    const patientSession = await (await page.request.get('/api/session')).json();
    expect(
      (
        await page.request.post('/api/messages', {
          headers: { 'X-CSRF-Token': patientSession.csrfToken },
          data: { body: 'Patient question for the clinical inbox.' },
        })
      ).status(),
    ).toBe(201);
    const staffFeed = await (await doctor.get('/api/activity')).json();
    expect(staffFeed.items[0].kind).toBe('message');
    const forbidden = await page.request.post(`/api/activity/${staffFeed.items[0].id}/read`, {
      headers: { 'X-CSRF-Token': patientSession.csrfToken },
      data: {},
    });
    expect(forbidden.status()).toBe(404);

    // Force a legal one-item page to exercise continuation after reading the
    // final visible item, and refresh while the read receipt is in flight.
    for (const body of ['Pagination first', 'Pagination second'])
      expect(
        (
          await doctor.post('/api/messages', {
            headers,
            data: { patientId: 'patient-ananya', body },
          })
        ).status(),
      ).toBe(201);
    await page.route(/\/api\/activity\?unread=true/, async (route) => {
      const url = new URL(route.request().url());
      url.searchParams.set('limit', '1');
      await route.continue({ url: url.href });
    });
    await page.goto('/my-care/activity');
    await page.getByRole('button', { name: /^Unread/ }).click();
    await expect(page.locator('.activity-item')).toHaveCount(1);
    let releaseRead!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    await page.route(
      /\/api\/activity\/[^/]+\/read$/,
      async (route) => {
        started();
        await gate;
        await route.continue();
      },
      { times: 1 },
    );
    await page.getByRole('button', { name: 'Mark read', exact: true }).click();
    await didStart;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    releaseRead();
    await expect(page.getByRole('button', { name: 'Unread (1)', exact: true })).toBeVisible();
    await expect(page.locator('.activity-item')).toHaveCount(1);
    await page.getByRole('button', { name: 'Mark read', exact: true }).click();
    await expect(page.getByText('You’re caught up', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mark all read', exact: true })).toBeDisabled();

    await page.route(/\/api\/activity\?unread=false$/, (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Synthetic activity outage' }),
      }),
    );
    await page.getByRole('button', { name: 'All updates', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Synthetic activity outage');
    await expect(page.getByText('No updates yet', { exact: true })).toHaveCount(0);
    await expect(page.getByText('You’re caught up', { exact: true })).toHaveCount(0);
  } finally {
    await doctor.dispose();
  }
});
