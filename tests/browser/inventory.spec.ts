import { test, expect, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import type {
  InventoryDetail,
  InventoryItem,
  InventoryLedger,
  InventoryMutation,
} from '../../shared/inventory';

const clinicToday = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
const after = (days: number) =>
  new Date(Date.parse(`${clinicToday()}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

async function audit(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
}

// Hold a committed response so the UI can exercise uncertain outcomes or
// navigation before it receives confirmation from the server.
async function holdCommittedResponse(
  page: Page,
  url: string,
  outcome: 'lost' | 'malformed' | 'success' = 'lost',
) {
  let release!: () => void;
  let arrived!: () => void;
  let finished!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  let body: Record<string, unknown> | undefined;
  let used = false;
  const handler = async (route: Route) => {
    if (used || route.request().method() !== 'POST') return route.continue();
    used = true;
    try {
      body = route.request().postDataJSON();
      const response = await route.fetch();
      expect(response.status(), await response.text()).toBe(201);
      arrived();
      await gate;
      if (outcome === 'success') await route.fulfill({ response });
      else
        await route.fulfill({
          status: outcome === 'malformed' ? 200 : 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error:
              outcome === 'malformed'
                ? 'Synthetic malformed success response.'
                : 'Synthetic lost response after inventory was recorded.',
          }),
        });
    } finally {
      finished();
    }
  };
  await page.route(url, handler);
  return {
    ready,
    body: () => body,
    release: async () => {
      release();
      if (used) await done;
      await page.unroute(url, handler);
    },
  };
}

test('inventory receipts retry once, physical counts preserve concurrent changes, and staff read an immutable lot history', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(120000);
  const login = await page.request.post('/api/auth/login', {
    data: { email: 'admin@derma.demo', password: 'DemoClinic2026!' },
  });
  expect(login.ok()).toBeTruthy();
  const headers = { 'X-CSRF-Token': (await login.json()).csrfToken };
  const suffix = randomUUID().slice(0, 8);
  const name = `Synthetic dressings ${suffix}`;
  const sku = `TEST-${suffix.toUpperCase()}`;
  const lotCode = `SYNTHETIC-LOT-${suffix}`;
  const receiptReason = `Synthetic supply receipt ${suffix}`;
  const receiptReference = `RECEIPT-${suffix}`;
  await page.goto('/clinic/inventory');
  await expect(page.getByRole('heading', { name: 'Inventory', exact: true })).toBeVisible();
  await page
    .locator('.page-actions')
    .getByRole('button', { name: 'Add inventory item', exact: true })
    .click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Item name', { exact: true }).fill(name);
  await dialog.getByLabel('SKU', { exact: true }).fill(sku);
  await dialog.getByLabel('Category', { exact: true }).selectOption('dressings');
  await dialog.getByLabel('Stock unit', { exact: true }).selectOption('piece');
  await dialog.getByLabel('Reorder level', { exact: true }).fill('5');
  const creation = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/inventory/items',
  );
  await dialog.getByRole('button', { name: 'Create item', exact: true }).click();
  const createdResponse = await creation;
  expect(createdResponse.status()).toBe(201);
  const created = (await createdResponse.json()) as InventoryDetail;
  const itemId = created.item.id;
  const detailPath = `/api/inventory/items/${itemId}`;
  const detail = async (): Promise<InventoryDetail> => {
    const response = await page.request.get(detailPath);
    expect(response.ok()).toBeTruthy();
    return response.json();
  };
  const ledger = async (): Promise<InventoryLedger> => {
    const response = await page.request.get(`${detailPath}/movements`);
    expect(response.ok()).toBeTruthy();
    return response.json();
  };
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  expect(created.item).toMatchObject({
    sku,
    name,
    category: 'dressings',
    unit: 'piece',
    reorderLevel: 5,
    active: true,
    onHandQuantity: 0,
    lowStock: true,
  });

  await page
    .locator('.page-actions')
    .getByRole('button', { name: 'Record receipt', exact: true })
    .click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Quantity received', { exact: true }).fill('20');
  await dialog.getByLabel('Lot code', { exact: true }).fill(lotCode);
  await dialog.getByLabel('Expiry date', { exact: true }).fill(after(10));
  await dialog.getByLabel('Reason', { exact: true }).fill(receiptReason);
  await dialog.getByLabel('Reference', { exact: true }).fill(receiptReference);
  const lost = await holdCommittedResponse(page, `**${detailPath}/receipts`);
  try {
    await dialog.getByRole('button', { name: 'Save receipt', exact: true }).click();
    await lost.ready;
    await expect(dialog.getByLabel('Quantity received', { exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await expect(dialog).toBeVisible();
  } finally {
    await lost.release();
  }
  await expect(dialog.getByRole('alert')).toContainText('Synthetic lost response');
  await expect(dialog.getByLabel('Quantity received', { exact: true })).toHaveValue('20');
  await expect(dialog.getByLabel('Quantity received', { exact: true })).toBeDisabled();
  expect(lost.body()).toMatchObject({
    quantity: 20,
    lotCode,
    expiryDate: after(10),
    reason: receiptReason,
    reference: receiptReference,
    expectedRevision: created.item.revision,
  });
  expect(lost.body()?.requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect((await detail()).item.onHandQuantity).toBe(20);
  expect((await ledger()).items).toHaveLength(1);
  await dialog.getByRole('button', { name: 'Close for now', exact: true }).click();
  await page.getByRole('button', { name: 'Resume pending entry', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Quantity received', { exact: true })).toHaveValue('20');
  const retriedRequest = page.waitForRequest(
    (request) =>
      request.method() === 'POST' && new URL(request.url()).pathname === `${detailPath}/receipts`,
  );
  const retriedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `${detailPath}/receipts`,
  );
  await dialog.getByRole('button', { name: 'Retry same request', exact: true }).click();
  expect((await retriedRequest).postDataJSON()).toEqual(lost.body());
  const replay = await retriedResponse;
  expect(replay.status()).toBe(200);
  const replayed = (await replay.json()) as InventoryMutation;
  expect(replayed.detail.item.onHandQuantity).toBe(20);
  expect((await ledger()).items).toHaveLength(1);
  await expect(dialog).toBeHidden();
  const lot = (await detail()).lots.find((entry) => entry.lotCode === lotCode)!;
  expect(lot).toMatchObject({
    receivedQuantity: 20,
    remainingQuantity: 20,
    expired: false,
    expiresSoon: true,
  });
  const lotRow = page
    .locator('article.inventory-lot')
    .filter({ has: page.getByRole('heading', { name: lotCode, exact: true }) });
  await lotRow.getByRole('button', { name: 'Use stock', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Quantity used', { exact: true }).fill('4');
  await dialog.getByLabel('Reason', { exact: true }).fill(`Synthetic use ${suffix}`);
  const usePath = `/api/inventory/lots/${lot.id}/use`;
  const malformed = await holdCommittedResponse(page, `**${usePath}`, 'malformed');
  try {
    await dialog.getByRole('button', { name: 'Record use', exact: true }).click();
    await malformed.ready;
    await expect(dialog.getByLabel('Quantity used', { exact: true })).toBeDisabled();
  } finally {
    await malformed.release();
  }
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(
    dialog.getByText('The save outcome could not be confirmed.', { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByLabel('Quantity used', { exact: true })).toHaveValue('4');
  await expect(dialog.getByLabel('Quantity used', { exact: true })).toBeDisabled();
  await expect(dialog.getByLabel('Reason', { exact: true })).toHaveValue(`Synthetic use ${suffix}`);
  await expect(dialog.getByLabel('Reason', { exact: true })).toBeDisabled();
  expect((await detail()).item.onHandQuantity).toBe(16);
  expect((await ledger()).items).toHaveLength(2);
  const useRetryRequest = page.waitForRequest(
    (request) => request.method() === 'POST' && new URL(request.url()).pathname === usePath,
  );
  const useRetryResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === usePath,
  );
  await dialog.getByRole('button', { name: 'Retry same request', exact: true }).click();
  expect((await useRetryRequest).postDataJSON()).toEqual(malformed.body());
  const useReplayedResponse = await useRetryResponse;
  expect(useReplayedResponse.status()).toBe(200);
  const useReplayed = (await useReplayedResponse.json()) as InventoryMutation;
  expect(useReplayed.movement).toMatchObject({
    type: 'use',
    quantityDelta: -4,
    balanceAfter: 16,
    requestId: malformed.body()?.requestId,
  });
  await expect(dialog).toBeHidden();
  expect((await detail()).item.onHandQuantity).toBe(16);
  expect((await ledger()).items).toHaveLength(2);

  // Another stock entry arrives while the administrator is counting. The UI
  // must keep the physical count draft and require an explicit review.
  await lotRow.getByRole('button', { name: 'Record physical count', exact: true }).click();
  dialog = page.getByRole('dialog');
  const countReason = `Synthetic physical count reconciliation ${suffix}`;
  await dialog.getByLabel('Counted quantity', { exact: true }).fill('12');
  await dialog.getByLabel('Reason', { exact: true }).fill(countReason);
  const concurrent = await page.request.post(`/api/inventory/lots/${lot.id}/use`, {
    headers,
    data: {
      quantity: 1,
      reason: `Concurrent synthetic use ${suffix}`,
      reference: '',
      expectedRevision: (await detail()).item.revision,
      requestId: randomUUID(),
    },
  });
  expect(concurrent.status()).toBe(201);
  const staleRequest = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      new URL(request.url()).pathname === `/api/inventory/lots/${lot.id}/adjust`,
  );
  const staleResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/inventory/lots/${lot.id}/adjust`,
  );
  await dialog.getByRole('button', { name: 'Save physical count', exact: true }).click();
  const staleBody = (await staleRequest).postDataJSON();
  expect((await staleResponse).status()).toBe(409);
  await expect(dialog.getByLabel('Counted quantity', { exact: true })).toHaveValue('12');
  await expect(dialog.getByLabel('Reason', { exact: true })).toHaveValue(countReason);
  await expect(
    dialog.getByRole('button', { name: 'Save physical count', exact: true }),
  ).toBeDisabled();
  await dialog.getByRole('button', { name: 'Refresh stock for review', exact: true }).click();
  await dialog
    .getByRole('button', { name: 'I reviewed the latest stock; keep my draft', exact: true })
    .click();
  await expect(dialog.getByLabel('Counted quantity', { exact: true })).toHaveValue('12');
  const countRequest = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      new URL(request.url()).pathname === `/api/inventory/lots/${lot.id}/adjust`,
  );
  const countResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/inventory/lots/${lot.id}/adjust`,
  );
  await dialog.getByRole('button', { name: 'Save physical count', exact: true }).click();
  const countBody = (await countRequest).postDataJSON();
  expect(countBody.requestId).not.toBe(staleBody.requestId);
  expect(countBody.expectedRevision).not.toBe(staleBody.expectedRevision);
  expect(countBody).toMatchObject({ countedQuantity: 12, reason: countReason });
  const countedResponse = await countResponse;
  expect(countedResponse.status()).toBe(201);
  const counted = (await countedResponse.json()) as InventoryMutation;
  expect(counted.movement).toMatchObject({
    type: 'adjustment',
    quantityDelta: -3,
    balanceAfter: 12,
  });
  await expect(dialog).toBeHidden();
  expect((await detail()).lots.find((entry) => entry.id === lot.id)).toMatchObject({
    receivedQuantity: 20,
    remainingQuantity: 12,
  });
  const movementHistory = await ledger();
  expect(
    movementHistory.items.map((entry) => [entry.type, entry.quantityDelta, entry.balanceAfter]),
  ).toEqual([
    ['adjustment', -3, 12],
    ['use', -1, 15],
    ['use', -4, 16],
    ['receipt', 20, 20],
  ]);
  expect(movementHistory.items.at(-1)).toMatchObject({
    reason: receiptReason,
    reference: receiptReference,
    requestId: lost.body()?.requestId,
  });

  const expiredCode = `EXPIRED-${suffix}`;
  await page.getByRole('button', { name: 'Record receipt', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Quantity received', { exact: true }).fill('3');
  await dialog.getByLabel('Lot code', { exact: true }).fill(expiredCode);
  await dialog.getByLabel('Expiry date', { exact: true }).fill(after(-1));
  await dialog
    .getByLabel('Reason', { exact: true })
    .fill(`Documenting previously expired stock ${suffix}`);
  await dialog.getByRole('button', { name: 'Save receipt', exact: true }).click();
  await expect(dialog).toBeHidden();
  const expiredRow = page
    .locator('article.inventory-lot')
    .filter({ has: page.getByRole('heading', { name: expiredCode, exact: true }) });
  await expect(expiredRow.getByRole('button', { name: 'Use stock', exact: true })).toBeDisabled();
  await expect(
    expiredRow.getByRole('button', { name: 'Record physical count', exact: true }),
  ).toBeEnabled();
  const expiredState = await detail();
  const expiredLot = expiredState.lots.find((entry) => entry.lotCode === expiredCode)!;
  expect(expiredState.item).toMatchObject({
    onHandQuantity: 15,
    unexpiredQuantity: 12,
    expiredQuantity: 3,
    expiringSoonQuantity: 12,
    lowStock: false,
  });
  expect(expiredLot).toMatchObject({
    expired: true,
    expiresSoon: false,
    receivedQuantity: 3,
    remainingQuantity: 3,
  });
  const deniedUse = await page.request.post(`/api/inventory/lots/${expiredLot.id}/use`, {
    headers,
    data: {
      quantity: 1,
      reason: 'Synthetic expired-use rejection',
      expectedRevision: expiredState.item.revision,
      requestId: randomUUID(),
    },
  });
  expect(deniedUse.status()).toBe(409);
  expect((await detail()).item.onHandQuantity).toBe(15);

  await page.getByRole('link', { name: 'Back to catalogue', exact: true }).click();
  await page.getByLabel('Search inventory', { exact: true }).fill(sku);
  await page.getByRole('button', { name: 'Search catalogue', exact: true }).click();
  const catalogueRow = page.locator('.inventory-catalogue-row').filter({ hasText: name });
  await expect(catalogueRow).toBeVisible();
  await page.getByLabel('Inventory category', { exact: true }).selectOption('instruments');
  await expect(catalogueRow).toHaveCount(0);
  await page.getByLabel('Inventory category', { exact: true }).selectOption('dressings');
  await expect(catalogueRow).toBeVisible();
  await page.getByLabel('Stock attention', { exact: true }).selectOption('low');
  await expect(catalogueRow).toHaveCount(0);
  await page.getByLabel('Stock attention', { exact: true }).selectOption('expired');
  await expect(catalogueRow).toBeVisible();
  await page.getByLabel('Stock attention', { exact: true }).selectOption('expiring-soon');
  await expect(catalogueRow).toBeVisible();
  await page.getByLabel('Stock attention', { exact: true }).selectOption('');
  await catalogueRow.getByRole('link', { name, exact: true }).click();
  await expect(expiredRow).toBeVisible();
  await expiredRow.getByRole('button', { name: 'Record physical count', exact: true }).click();
  dialog = page.getByRole('dialog');
  const disposalReason = `Expired stock disposed after physical check ${suffix}`;
  await dialog.getByLabel('Counted quantity', { exact: true }).fill('0');
  await dialog.getByLabel('Reason', { exact: true }).fill(disposalReason);
  await dialog.getByRole('button', { name: 'Save physical count', exact: true }).click();
  await expect(dialog).toBeHidden();
  const disposed = await detail();
  expect(disposed.item).toMatchObject({
    onHandQuantity: 12,
    unexpiredQuantity: 12,
    expiredQuantity: 0,
  });
  expect(disposed.lots.find((entry) => entry.id === expiredLot.id)).toMatchObject({
    receivedQuantity: 3,
    remainingQuantity: 0,
  });
  expect((await ledger()).items[0]).toMatchObject({
    type: 'adjustment',
    quantityDelta: -3,
    balanceAfter: 0,
    reason: disposalReason,
  });
  await page.getByRole('button', { name: 'Movement history', exact: true }).click();
  await expect(page.getByText(disposalReason, { exact: true })).toBeVisible();
  const receiptRow = page.locator('.inventory-movement').filter({ hasText: receiptReason });
  await expect(receiptRow).toBeVisible();
  await expect(receiptRow).toContainText(receiptReference);
  await page.getByRole('button', { name: 'Lots', exact: true }).click();

  await page.getByRole('button', { name: 'Archive item', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Item is active', { exact: true })).not.toBeChecked();
  await expect(dialog.getByLabel('SKU', { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('Stock unit', { exact: true })).toHaveCount(0);
  const archiveReason = `Catalogue archive test ${suffix}`;
  await dialog.getByLabel('Reason', { exact: true }).fill(archiveReason);
  await dialog.getByRole('button', { name: 'Save item changes', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect((await detail()).item).toMatchObject({
    active: false,
    sku,
    unit: 'piece',
    onHandQuantity: 12,
  });
  await expect(page.getByRole('button', { name: 'Record receipt', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Lots', exact: true }).click();
  await expect(lotRow.getByRole('button', { name: 'Use stock', exact: true })).toBeDisabled();
  await expect(
    lotRow.getByRole('button', { name: 'Record physical count', exact: true }),
  ).toBeEnabled();
  await page.getByRole('link', { name: 'Back to catalogue', exact: true }).click();
  await page.getByLabel('Catalogue status', { exact: true }).selectOption('false');
  await expect(catalogueRow).toBeVisible();
  await catalogueRow.getByRole('link', { name, exact: true }).click();
  await page.getByRole('button', { name: 'Reactivate item', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Item is active', { exact: true })).toBeChecked();
  await dialog.getByLabel('Reason', { exact: true }).fill(`Restore catalogue item ${suffix}`);
  await dialog.getByRole('button', { name: 'Save item changes', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('link', { name: 'Back to catalogue', exact: true }).click();
  await page.getByLabel('Catalogue status', { exact: true }).selectOption('true');
  await expect(catalogueRow).toBeVisible();
  await catalogueRow.getByRole('link', { name, exact: true }).click();
  const restored = await detail();
  expect(restored.itemChanges).toHaveLength(3);
  expect(
    restored.itemChanges.find((entry) => entry.reason === archiveReason)?.snapshot.active,
  ).toBe(false);
  expect(
    restored.itemChanges.find((entry) => entry.reason === 'Item created')?.snapshot,
  ).toMatchObject({ sku, name, unit: 'piece', reorderLevel: 5, active: true });
  await page.getByRole('button', { name: 'Item history', exact: true }).click();
  await expect(page.getByText(archiveReason, { exact: true })).toBeVisible();
  await expect(page.getByText('Item created', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 780 });
  await audit(page);
  await page.screenshot({
    path: testInfo.outputPath('inventory-history-mobile.png'),
    fullPage: true,
  });

  const receptionist = await browser.newContext({ baseURL });
  try {
    const receptionLogin = await receptionist.request.post('/api/auth/login', {
      data: { email: 'reception@derma.demo', password: 'DemoClinic2026!' },
    });
    expect(receptionLogin.ok()).toBeTruthy();
    const receptionSession = await receptionLogin.json();
    const member = await receptionist.newPage();
    await member.goto(`/clinic/inventory?item=${itemId}`);
    await expect(member.getByRole('heading', { name, exact: true })).toBeVisible();
    for (const control of [
      'Add inventory item',
      'Record receipt',
      'Use stock',
      'Record physical count',
      'Edit item',
      'Archive item',
    ]) {
      await expect(member.getByRole('button', { name: control, exact: true })).toHaveCount(0);
    }
    const read = await receptionist.request.get(detailPath);
    expect(read.status()).toBe(200);
    expect(((await read.json()) as InventoryDetail).item.onHandQuantity).toBe(12);
    expect((await receptionist.request.get(`${detailPath}/movements`)).status()).toBe(200);
    expect(
      (
        await receptionist.request.post(`/api/inventory/lots/${lot.id}/use`, {
          headers: { 'X-CSRF-Token': receptionSession.csrfToken },
          data: {
            quantity: 1,
            reason: 'Read-only staff cannot change stock',
            expectedRevision: restored.item.revision,
            requestId: randomUUID(),
          },
        })
      ).status(),
    ).toBe(403);
    await member.setViewportSize({ width: 320, height: 780 });
    await expect(member.getByRole('heading', { name: lotCode, exact: true })).toBeVisible();
    await audit(member);
    await member.screenshot({
      path: testInfo.outputPath('inventory-readonly-mobile.png'),
      fullPage: true,
    });
  } finally {
    await receptionist.close();
  }
  const patient = await browser.newContext({ baseURL });
  try {
    const patientLogin = await patient.request.post('/api/auth/login', {
      data: { email: 'patient@derma.demo', password: 'DemoClinic2026!' },
    });
    expect(patientLogin.ok()).toBeTruthy();
    expect((await patient.request.get('/api/inventory/items')).status()).toBe(403);
    expect((await patient.request.get(detailPath)).status()).toBe(403);
    expect((await patient.request.get(`${detailPath}/movements`)).status()).toBe(403);
    const patientPage = await patient.newPage();
    await patientPage.goto(`/clinic/inventory?item=${itemId}`);
    await expect(patientPage).toHaveURL(/\/my-care$/);
    await expect(patientPage.getByText(name, { exact: true })).toHaveCount(0);
  } finally {
    await patient.close();
  }
  const finalCatalogue = (await (
    await page.request.get('/api/inventory/items?active=all')
  ).json()) as InventoryItem[];
  expect(finalCatalogue.find((item) => item.id === itemId)?.onHandQuantity).toBe(12);
  expect((await ledger()).items).toHaveLength(6);
});

test('a receipt completed after leaving inventory does not navigate back or announce success in another workspace', async ({
  page,
}) => {
  const login = await page.request.post('/api/auth/login', {
    data: { email: 'admin@derma.demo', password: 'DemoClinic2026!' },
  });
  expect(login.ok()).toBeTruthy();
  const headers = { 'X-CSRF-Token': (await login.json()).csrfToken };
  const suffix = randomUUID().slice(0, 8);
  const name = `Pending navigation receipt ${suffix}`;
  const creation = await page.request.post('/api/inventory/items', {
    headers,
    data: {
      sku: `NAV-${suffix.toUpperCase()}`,
      name,
      category: 'dressings',
      unit: 'pack',
      reorderLevel: 1,
      requestId: randomUUID(),
    },
  });
  expect(creation.status()).toBe(201);
  const created = (await creation.json()) as InventoryDetail;
  const detailPath = `/api/inventory/items/${created.item.id}`;
  const receiptPath = `${detailPath}/receipts`;
  await page.goto('/clinic');
  // Preserve this document across the navigation. Mark readiness only in the
  // task after response.json has fulfilled, after the API/save promise chain.
  await page.evaluate(
    ({ receiptPath, suffix }) => {
      document.documentElement.setAttribute('data-inventory-test-document', suffix);
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (...args: Parameters<typeof fetch>) => {
        const response = await originalFetch(...args);
        const source = args[0];
        const url = source instanceof Request ? source.url : String(source);
        if (new URL(url, window.location.href).pathname === receiptPath) {
          const originalJson = response.json.bind(response);
          response.json = async () => {
            const result = await originalJson();
            window.setTimeout(() => {
              document.documentElement.setAttribute('data-inventory-response-settled', suffix);
            }, 0);
            return result;
          };
        }
        return response;
      };
    },
    { receiptPath, suffix },
  );
  await page.getByRole('link', { name: 'Inventory', exact: true }).click();
  await expect(page).toHaveURL(/\/clinic\/inventory$/);
  await page.getByRole('link', { name, exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await page
    .locator('.page-actions')
    .getByRole('button', { name: 'Record receipt', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Quantity received', { exact: true }).fill('7');
  await dialog.getByLabel('Lot code', { exact: true }).fill(`NAVIGATION-${suffix}`);
  await dialog.getByLabel('Reason', { exact: true }).fill(`Navigation race fixture ${suffix}`);
  const held = await holdCommittedResponse(page, `**${receiptPath}`, 'success');
  try {
    await dialog.getByRole('button', { name: 'Save receipt', exact: true }).click();
    await held.ready;
    await expect(dialog.getByLabel('Quantity received', { exact: true })).toBeDisabled();
    const committed = (await (await page.request.get(detailPath)).json()) as InventoryDetail;
    expect(committed.item.onHandQuantity).toBe(7);
    await page.goBack();
    await expect(page).toHaveURL(/\/clinic\/inventory$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/clinic$/);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('data-inventory-test-document', suffix);
  } finally {
    await held.release();
  }
  await expect(page.locator('html')).toHaveAttribute('data-inventory-response-settled', suffix);
  await expect(page).toHaveURL(/\/clinic$/);
  await expect(page.getByText('Stock record saved.', { exact: true })).toHaveCount(0);
  const historyResponse = await page.request.get(`${detailPath}/movements`);
  expect(historyResponse.ok()).toBeTruthy();
  const history = (await historyResponse.json()) as InventoryLedger;
  expect(history.items).toHaveLength(1);
  expect(history.items[0]).toMatchObject({
    type: 'receipt',
    quantityDelta: 7,
    balanceAfter: 7,
    requestId: held.body()?.requestId,
  });
  const final = (await (await page.request.get(detailPath)).json()) as InventoryDetail;
  expect(final.item.onHandQuantity).toBe(7);
});
