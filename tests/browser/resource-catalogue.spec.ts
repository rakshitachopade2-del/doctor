import { expect, test, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import type { ResourceDetail } from '../../shared/clinic-resources';

const clinicDay = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
const later = (count: number) => {
  const date = new Date(`${clinicDay()}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
};
async function audit(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  const toasts = page.getByRole('button', { name: 'Dismiss notification', exact: true });
  while (await toasts.count()) await toasts.first().click();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
}
async function alterCommittedResponse(
  page: Page,
  method: 'POST' | 'PATCH',
  path: string,
  wrongEvent = false,
) {
  let arrived!: () => void,
    releaseGate!: () => void,
    finished!: () => void,
    fail!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    arrived = resolve;
    fail = reject;
  });
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  let body: Record<string, unknown> | undefined,
    saved: ResourceDetail | undefined,
    used = false;
  const handler = async (route: Route) => {
    if (used || route.request().method() !== method) return route.continue();
    used = true;
    try {
      body = route.request().postDataJSON();
      const response = await route.fetch();
      expect(response.status(), await response.text()).toBe(method === 'POST' ? 201 : 200);
      saved = await response.json();
      arrived();
      await gate;
      if (wrongEvent) {
        const altered = structuredClone(saved!);
        const change = altered.changes.find((entry) => entry.requestId === body?.requestId);
        expect(change).toBeTruthy();
        change!.requestId = randomUUID();
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(altered),
        });
      } else {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Synthetic lost response after resource creation.' }),
        });
      }
    } catch (problem) {
      fail(problem);
      throw problem;
    } finally {
      finished();
    }
  };
  await page.route(`**${path}`, handler);
  return {
    ready,
    body: () => body!,
    saved: () => saved!,
    release: async () => {
      releaseGate();
      if (used) await done;
      await page.unroute(`**${path}`, handler);
    },
  };
}

test('resource catalogue preserves command receipts, archived status and maintenance history through administrator forms', async ({
  page,
}, testInfo) => {
  test.setTimeout(120000);
  const login = await page.request.post('/api/auth/login', {
    data: { email: 'admin@derma.demo', password: 'DemoClinic2026!' },
  });
  expect(login.ok()).toBeTruthy();
  const headers = { 'X-CSRF-Token': (await login.json()).csrfToken };
  const suffix = randomUUID().slice(0, 8);
  const resourceName = `Catalogue room ${suffix}`;
  await page.goto('/clinic/resources?view=catalogue');
  await page.getByRole('button', { name: 'Add resource', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Add a clinic resource', exact: true });
  await dialog.getByLabel('Resource name', { exact: true }).fill(resourceName);
  await dialog.getByLabel('Resource type', { exact: true }).selectOption('room');
  await dialog.getByLabel('Location', { exact: true }).fill('Ground floor, west corridor');
  await dialog
    .getByLabel('Operational notes', { exact: true })
    .fill('Synthetic operational setup note.');
  const lost = await alterCommittedResponse(page, 'POST', '/api/clinic-resources');
  try {
    await dialog.getByRole('button', { name: 'Save resource', exact: true }).click();
    await lost.ready;
    await expect(dialog.getByLabel('Resource name', { exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await expect(dialog).toBeVisible();
  } finally {
    await lost.release();
  }
  await expect(dialog.getByRole('alert')).toContainText('Synthetic lost response');
  await expect(dialog.getByLabel('Resource name', { exact: true })).toHaveValue(resourceName);
  await expect(dialog.getByLabel('Resource name', { exact: true })).toBeDisabled();
  const id = lost.saved().resource.id;
  const detailPath = `/api/clinic-resources/${id}`;
  async function current(): Promise<ResourceDetail> {
    const response = await page.request.get(detailPath);
    expect(response.ok()).toBeTruthy();
    return response.json();
  }
  expect((await current()).changes).toHaveLength(1);
  await dialog.getByRole('button', { name: 'Close for now', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Resume pending resource update', exact: true }).click();
  const createRetryRequest = page.waitForRequest(
    (request) =>
      request.method() === 'POST' && new URL(request.url()).pathname === '/api/clinic-resources',
  );
  const createRetryResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/clinic-resources',
  );
  await dialog.getByRole('button', { name: 'Retry same request', exact: true }).click();
  expect((await createRetryRequest).postDataJSON()).toEqual(lost.body());
  expect((await createRetryResponse).status()).toBe(200);
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { name: resourceName, exact: true })).toBeVisible();
  expect((await current()).changes).toHaveLength(1);
  expect((await current()).changes[0].requestId).toBe(lost.body().requestId);

  // Another administrator archives while this metadata form is open. The visible
  // metadata draft must never restore the hidden active flag when it is reviewed.
  await page.getByRole('button', { name: 'Edit resource', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Edit clinic resource', exact: true });
  await expect(dialog.getByLabel('Resource type', { exact: true })).toHaveCount(0);
  const correctionReason = `Location corrected after handover ${suffix}`;
  await dialog.getByLabel('Location', { exact: true }).fill('First floor, consultation area');
  await dialog.getByLabel('Reason for change', { exact: true }).fill(correctionReason);
  const before = await current();
  const archivedReason = `Concurrent archive ${suffix}`;
  const archive = await page.request.patch(detailPath, {
    headers,
    data: {
      active: false,
      reason: archivedReason,
      expectedRevision: before.resource.revision,
      requestId: randomUUID(),
    },
  });
  expect(archive.status()).toBe(200);
  const staleRequest = page.waitForRequest(
    (request) => request.method() === 'PATCH' && new URL(request.url()).pathname === detailPath,
  );
  const staleResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'PATCH' && new URL(response.url()).pathname === detailPath,
  );
  await dialog.getByRole('button', { name: 'Save resource changes', exact: true }).click();
  const staleBody = (await staleRequest).postDataJSON();
  expect(staleBody).not.toHaveProperty('active');
  expect((await staleResponse).status()).toBe(409);
  await expect(dialog.getByLabel('Location', { exact: true })).toHaveValue(
    'First floor, consultation area',
  );
  await expect(
    dialog.getByRole('button', { name: 'Save resource changes', exact: true }),
  ).toBeDisabled();
  await dialog.getByRole('button', { name: 'Refresh resource context', exact: true }).click();
  await expect(dialog.locator('.crp-snapshot')).toContainText('Archived');
  await dialog
    .getByRole('button', { name: 'I reviewed the latest resource; keep my draft', exact: true })
    .click();
  await expect(dialog.getByLabel('Reason for change', { exact: true })).toHaveValue(
    correctionReason,
  );
  const wrongEvent = await alterCommittedResponse(page, 'PATCH', detailPath, true);
  try {
    await dialog.getByRole('button', { name: 'Save resource changes', exact: true }).click();
    await wrongEvent.ready;
    await expect(dialog.getByLabel('Location', { exact: true })).toBeDisabled();
  } finally {
    await wrongEvent.release();
  }
  await expect(dialog.getByRole('alert')).toContainText('did not confirm');
  await expect(
    dialog.getByText('The save outcome could not be confirmed.', { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByLabel('Location', { exact: true })).toBeDisabled();
  expect(wrongEvent.body()).not.toHaveProperty('active');
  expect(wrongEvent.body().requestId).not.toBe(staleBody.requestId);
  expect(wrongEvent.body().expectedRevision).not.toBe(staleBody.expectedRevision);
  let saved = await current();
  expect(saved.resource.active).toBe(false);
  expect(saved.resource.location).toBe('First floor, consultation area');
  expect(saved.changes).toHaveLength(3);
  const editRetryRequest = page.waitForRequest(
    (request) => request.method() === 'PATCH' && new URL(request.url()).pathname === detailPath,
  );
  const editRetryResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'PATCH' && new URL(response.url()).pathname === detailPath,
  );
  await dialog.getByRole('button', { name: 'Retry same request', exact: true }).click();
  expect((await editRetryRequest).postDataJSON()).toEqual(wrongEvent.body());
  expect((await editRetryResponse).status()).toBe(200);
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Restore resource', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Add maintenance', exact: true })).toBeDisabled();
  saved = await current();
  expect(saved.resource.active).toBe(false);
  expect(saved.changes).toHaveLength(3);
  expect(saved.changes[0].requestId).toBe(wrongEvent.body().requestId);

  await page.getByRole('button', { name: 'Restore resource', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Restore clinic resource', exact: true });
  await dialog
    .getByLabel('Reason for restoring', { exact: true })
    .fill(`Explicit return to service ${suffix}`);
  await dialog.getByRole('button', { name: 'Restore resource', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect((await current()).resource.active).toBe(true);

  await page.getByRole('button', { name: 'Add maintenance', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Schedule resource maintenance', exact: true });
  const start = later(17),
    end = later(18),
    maintenanceReason = `Planned room cleaning ${suffix}`;
  await dialog.getByLabel('Start date', { exact: true }).fill(start);
  await dialog.getByLabel('End date', { exact: true }).fill(end);
  await dialog
    .getByRole('checkbox', { name: 'All day on each included date', exact: true })
    .uncheck();
  await dialog.getByLabel('Daily start time', { exact: true }).fill('13:00');
  await dialog.getByLabel('Daily end time', { exact: true }).fill('14:00');
  await dialog.getByLabel('Reason for maintenance', { exact: true }).fill(maintenanceReason);
  await dialog.getByRole('button', { name: 'Save maintenance', exact: true }).click();
  await expect(dialog).toBeHidden();
  const maintenance = page.locator('.crp-maintenance-card').filter({ hasText: maintenanceReason });
  await expect(maintenance).toBeVisible();
  await expect(maintenance).toContainText('1:00 PM – 2:00 PM IST on each included date');
  saved = await current();
  expect(saved.closures).toHaveLength(1);
  expect(saved.closures[0]).toMatchObject({
    startDate: start,
    endDate: end,
    startTime: '13:00',
    endTime: '14:00',
    reason: maintenanceReason,
    cancellation: null,
  });
  const originalClosure = saved.closures[0];
  await page.getByLabel('Diary date', { exact: true }).fill(start);
  await expect(
    page.locator('.crp-maintenance-event').getByText(maintenanceReason, { exact: true }),
  ).toBeVisible();
  await maintenance.getByRole('button', { name: 'Cancel maintenance', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Cancel resource maintenance', exact: true });
  const cancellationReason = `Cleaning date withdrawn ${suffix}`;
  await dialog
    .getByLabel('Reason for cancelling maintenance', { exact: true })
    .fill(cancellationReason);
  await dialog
    .getByRole('button', { name: 'Confirm maintenance cancellation', exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(maintenance.getByText('Cancelled maintenance', { exact: true })).toBeVisible();
  await expect(maintenance.getByText(cancellationReason, { exact: true })).toBeVisible();
  await expect(page.locator('.crp-maintenance-event')).toHaveCount(0);
  saved = await current();
  expect(saved.closures).toHaveLength(1);
  expect({ ...saved.closures[0], cancellation: null }).toEqual(originalClosure);
  expect(saved.closures[0].cancellation?.reason).toBe(cancellationReason);
  expect(saved.closures[0].cancellation?.requestId).toMatch(/^[a-f0-9-]{36}$/);

  await page.getByRole('button', { name: 'Archive resource', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Archive clinic resource', exact: true });
  const finalArchiveReason = `Retired after catalogue verification ${suffix}`;
  await dialog.getByLabel('Reason for archiving', { exact: true }).fill(finalArchiveReason);
  await dialog.getByRole('button', { name: 'Confirm resource archive', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect((await current()).resource.active).toBe(false);
  await page.getByRole('button', { name: 'Resource history', exact: true }).click();
  await expect(
    page.locator('.crp-history-list').getByText(correctionReason, { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('.crp-history-list').getByText(archivedReason, { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('.crp-history-list').getByText(finalArchiveReason, { exact: true }),
  ).toBeVisible();
  const original = page
    .locator('.crp-history-entry')
    .filter({ has: page.getByRole('heading', { name: 'Resource created', exact: true }) });
  await original.getByText('View preserved values', { exact: true }).click();
  await expect(original).toContainText('Ground floor, west corridor');
  await page.setViewportSize({ width: 320, height: 780 });
  await audit(page);
  await page.screenshot({
    path: testInfo.outputPath('resource-catalogue-history-mobile.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Back to resources', exact: true }).click();
  await page.getByRole('button', { name: 'Resource catalogue', exact: true }).click();
  await page.getByLabel('Resource status', { exact: true }).selectOption('archived');
  await page.getByRole('textbox', { name: 'Search resources', exact: true }).fill(resourceName);
  await expect(page.locator('.crp-resource-card')).toHaveCount(1);
  await expect(page.locator('.crp-resource-card')).toContainText(resourceName);
  await audit(page);
  await page.screenshot({
    path: testInfo.outputPath('resource-catalogue-archived-mobile.png'),
    fullPage: true,
  });
});
