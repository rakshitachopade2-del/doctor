import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import { addDays, clinicToday, createUser, openDatabase, seedDemo } from '../server/db.ts';
import type { InventoryDetail, InventoryMovement } from '../shared/inventory.ts';

const app = createApp({ databasePath: ':memory:', demoMode: true });
type Client = { cookie?: string; csrf?: string };
const admin: Client = {},
  otherAdmin: Client = {},
  doctor: Client = {},
  reception: Client = {},
  patient: Client = {},
  temporary: Client = {};
let server: Server,
  base: string,
  serial = 0;
async function call(
  path: string,
  client: Client = admin,
  method = 'GET',
  body?: unknown,
  target = base,
) {
  const response = await fetch(`${target}/api${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(client.cookie ? { Cookie: client.cookie } : {}),
      ...(client.csrf ? { 'X-CSRF-Token': client.csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const cookie = response.headers.get('set-cookie');
  if (cookie) client.cookie = cookie.split(';')[0];
  const data = await response.json();
  if (data.csrfToken) client.csrf = data.csrfToken;
  return { status: response.status, data, headers: response.headers };
}
async function listen(application: ReturnType<typeof createApp>) {
  let instance: Server;
  await new Promise<void>((resolve) => {
    instance = application.listen(0, '127.0.0.1', () => resolve());
  });
  const address = instance!.address();
  assert.ok(address && typeof address !== 'string');
  return { server: instance!, base: `http://127.0.0.1:${address.port}` };
}
async function close(instance: Server) {
  await new Promise<void>((resolve, reject) =>
    instance.close((error) => (error ? reject(error) : resolve())),
  );
}
function catalogue(overrides: Record<string, unknown> = {}) {
  return {
    sku: `CONS-${++serial}`,
    name: `Synthetic consumable ${serial}`,
    category: 'dressings',
    unit: 'pack',
    reorderLevel: 5,
    requestId: randomUUID(),
    ...overrides,
  };
}
async function newItem(overrides: Record<string, unknown> = {}): Promise<InventoryDetail> {
  const result = await call('/inventory/items', admin, 'POST', catalogue(overrides));
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data;
}
async function detail(itemId: string, client = admin): Promise<InventoryDetail> {
  const result = await call(`/inventory/items/${itemId}`, client);
  assert.equal(result.status, 200);
  return result.data;
}
function receiptBody(current: InventoryDetail, overrides: Record<string, unknown> = {}) {
  return {
    quantity: 10,
    lotCode: 'BATCH-1',
    expiryDate: null,
    reason: 'Recorded clinic delivery',
    reference: '',
    expectedRevision: current.item.revision,
    requestId: randomUUID(),
    ...overrides,
  };
}
async function receive(itemId: string, overrides: Record<string, unknown> = {}, client = admin) {
  return call(
    `/inventory/items/${itemId}/receipts`,
    client,
    'POST',
    receiptBody(await detail(itemId), overrides),
  );
}
async function use(
  itemId: string,
  lotId: string,
  overrides: Record<string, unknown> = {},
  client = admin,
) {
  return call(`/inventory/lots/${lotId}/use`, client, 'POST', {
    quantity: 1,
    reason: 'Recorded whole-unit clinic use',
    reference: '',
    expectedRevision: (await detail(itemId)).item.revision,
    requestId: randomUUID(),
    ...overrides,
  });
}
async function count(
  itemId: string,
  lotId: string,
  countedQuantity: number,
  overrides: Record<string, unknown> = {},
  client = admin,
) {
  return call(`/inventory/lots/${lotId}/adjust`, client, 'POST', {
    countedQuantity,
    reason: 'Reconciled observed physical count',
    reference: '',
    expectedRevision: (await detail(itemId)).item.revision,
    requestId: randomUUID(),
    ...overrides,
  });
}
async function edit(itemId: string, changes: Record<string, unknown>, client = admin) {
  return call(`/inventory/items/${itemId}`, client, 'PATCH', {
    reason: 'Catalogue correction',
    expectedRevision: (await detail(itemId)).item.revision,
    requestId: randomUUID(),
    ...changes,
  });
}
before(async () => {
  createUser(
    app.locals.db,
    {
      id: 'inventory-second-admin',
      name: 'Second inventory administrator',
      email: 'inventory-admin@example.test',
      role: 'admin',
    },
    'InventoryAdmin2026!',
  );
  createUser(
    app.locals.db,
    {
      id: 'inventory-temporary-admin',
      name: 'Temporary administrator',
      email: 'inventory-temp@example.test',
      role: 'admin',
      mustChangePassword: true,
    },
    'InventoryTemporary2026!',
  );
  ({ server, base } = await listen(app));
  for (const [role, client] of [
    ['admin', admin],
    ['doctor', doctor],
    ['reception', reception],
    ['patient', patient],
  ] as const)
    assert.equal(
      (
        await call('/auth/login', client, 'POST', {
          email: `${role}@derma.demo`,
          password: 'DemoClinic2026!',
        })
      ).status,
      200,
    );
  assert.equal(
    (
      await call('/auth/login', otherAdmin, 'POST', {
        email: 'inventory-admin@example.test',
        password: 'InventoryAdmin2026!',
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call('/auth/login', temporary, 'POST', {
        email: 'inventory-temp@example.test',
        password: 'InventoryTemporary2026!',
      })
    ).status,
    200,
  );
});
after(async () => {
  await close(server);
  app.locals.close();
});

test('staff can inspect inventory while patients, temporary sessions and nonadmin mutations are denied', async () => {
  const created = await newItem();
  const received = await receive(created.item.id);
  const lotId = received.data.movement.lotId;
  for (const client of [admin, otherAdmin, doctor, reception]) {
    for (const path of [
      '/inventory/items',
      `/inventory/items/${created.item.id}`,
      `/inventory/items/${created.item.id}/movements`,
    ]) {
      const result = await call(path, client);
      assert.equal(result.status, 200);
      assert.equal(result.headers.get('cache-control'), 'no-store');
      assert.ok(!JSON.stringify(result.data).includes('patientId'));
    }
  }
  for (const client of [{}, patient, temporary])
    for (const path of [
      '/inventory/items',
      `/inventory/items/${created.item.id}`,
      `/inventory/items/${created.item.id}/movements`,
    ])
      assert.equal(
        (await call(path, client)).status,
        client === patient || client === temporary ? 403 : 401,
      );
  for (const client of [doctor, reception, patient, temporary]) {
    assert.equal((await call('/inventory/items', client, 'POST', catalogue())).status, 403);
    assert.equal((await edit(created.item.id, { name: 'Forbidden rename' }, client)).status, 403);
    assert.equal((await receive(created.item.id, {}, client)).status, 403);
    assert.equal((await use(created.item.id, lotId, {}, client)).status, 403);
    assert.equal((await count(created.item.id, lotId, 0, {}, client)).status, 403);
  }
});

test('catalogue creation normalizes SKU, records the original snapshot and rejects invalid units and bounds', async () => {
  const input = catalogue({ sku: '  wrap.blue-1  ', name: '  Blue wrapping packs  ' });
  const created = await call('/inventory/items', admin, 'POST', input);
  assert.equal(created.status, 201);
  assert.equal(created.data.item.sku, 'WRAP.BLUE-1');
  assert.equal(created.data.item.name, 'Blue wrapping packs');
  assert.equal(created.data.item.onHandQuantity, 0);
  assert.equal(created.data.item.lowStock, true);
  assert.equal(created.data.itemChanges.length, 1);
  assert.equal(created.data.itemChanges[0].reason, 'Item created');
  assert.equal(created.data.itemChanges[0].createdById, 'user-admin');
  assert.equal(created.data.itemChanges[0].snapshot.unit, 'pack');
  const replay = await call('/inventory/items', admin, 'POST', {
    ...input,
    sku: 'WRAP.BLUE-1',
    name: 'Blue wrapping packs',
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.item.id, created.data.item.id);
  assert.equal(
    (await call('/inventory/items', admin, 'POST', { ...input, requestId: randomUUID() })).status,
    409,
  );
  for (const invalid of [
    { sku: '.starts-with-dot' },
    { sku: 'contains space' },
    { sku: 'x'.repeat(51) },
    { name: '' },
    { name: 'x'.repeat(151) },
    { category: 'pharmacy' },
    { unit: 'mg' },
    { reorderLevel: -1 },
    { reorderLevel: 1.5 },
    { reorderLevel: 1_000_001 },
    { requestId: undefined },
    { createdById: 'forged' },
  ])
    assert.equal((await call('/inventory/items', admin, 'POST', catalogue(invalid))).status, 400);
  assert.equal((await call('/inventory/items?stock=unknown')).status, 400);
  assert.equal((await call('/inventory/items?active=yes')).status, 400);
});

test('catalogue edits preserve immutable prior names, categories and archive state with actor attribution', async () => {
  const created = await newItem();
  const input = {
    name: 'Renamed consumable',
    category: 'cleaning',
    reorderLevel: 12,
    active: false,
    reason: 'Corrected catalogue details',
    expectedRevision: created.item.revision,
    requestId: randomUUID(),
  };
  const changed = await call(`/inventory/items/${created.item.id}`, otherAdmin, 'PATCH', input);
  assert.equal(changed.status, 200);
  assert.equal(changed.data.item.active, false);
  assert.equal(changed.data.item.lowStock, false);
  assert.equal(changed.data.itemChanges.length, 2);
  assert.equal(changed.data.itemChanges[0].createdById, 'inventory-second-admin');
  assert.equal(changed.data.itemChanges[1].snapshot.name, created.item.name);
  assert.equal(changed.data.item.sku, created.item.sku);
  assert.equal(changed.data.item.unit, created.item.unit);
  assert.equal(
    (
      await call(`/inventory/items/${created.item.id}`, otherAdmin, 'PATCH', {
        ...input,
        expectedRevision: 'a'.repeat(64),
      })
    ).status,
    200,
  );
  assert.equal((await detail(created.item.id)).itemChanges.length, 2);
  for (const change of [
    { sku: 'NEW-SKU' },
    { unit: 'piece' },
    { reason: '' },
    { requestId: undefined },
    { expectedRevision: undefined },
  ])
    assert.equal(
      (await edit(created.item.id, { name: 'Attempted update', ...change })).status,
      400,
    );
  assert.equal((await edit(created.item.id, { active: true })).status, 200);
  const retry = await call(`/inventory/items/${created.item.id}`, otherAdmin, 'PATCH', input);
  assert.equal(retry.status, 200);
  assert.equal(retry.data.item.active, true);
  assert.equal(retry.data.itemChanges.length, 3);
  for (const table of ['inventoryItems', 'inventoryItemChanges']) {
    assert.throws(
      () =>
        app.locals.db
          .prepare(`UPDATE ${table} SET data=? WHERE id=?`)
          .run('{}', table === 'inventoryItems' ? created.item.id : changed.data.itemChanges[0].id),
      /immutable/,
    );
    assert.throws(
      () =>
        app.locals.db
          .prepare(`DELETE FROM ${table} WHERE id=?`)
          .run(table === 'inventoryItems' ? created.item.id : changed.data.itemChanges[0].id),
      /immutable/,
    );
  }
});

test('receipts retain distinct lots and derive expiry, unknown-expiry, low-stock and thirty-day warning balances', async () => {
  const created = await newItem({ reorderLevel: 10 });
  const itemId = created.item.id;
  const expired = await receive(itemId, { quantity: 5, expiryDate: addDays(clinicToday(), -1) });
  assert.equal(expired.status, 201);
  assert.equal(expired.data.detail.item.expiredQuantity, 5);
  assert.equal(expired.data.detail.item.unexpiredQuantity, 0);
  assert.equal(expired.data.detail.item.lowStock, true);
  const unknown = await receive(itemId, { quantity: 10, lotCode: undefined });
  assert.equal(
    unknown.data.detail.lots.find((lot: any) => lot.id === unknown.data.movement.lotId).lotCode,
    '',
  );
  assert.equal(unknown.data.detail.item.lowStock, true);
  const today = await receive(itemId, { quantity: 3, expiryDate: clinicToday() });
  await receive(itemId, { quantity: 4, expiryDate: addDays(clinicToday(), 30) });
  const later = await receive(itemId, { quantity: 2, expiryDate: addDays(clinicToday(), 31) });
  assert.equal(later.data.detail.item.onHandQuantity, 24);
  assert.equal(later.data.detail.item.unexpiredQuantity, 19);
  assert.equal(later.data.detail.item.expiredQuantity, 5);
  assert.equal(later.data.detail.item.expiringSoonQuantity, 7);
  assert.equal(later.data.detail.item.lowStock, false);
  assert.equal(later.data.detail.lots.length, 5);
  assert.equal(new Set(later.data.detail.lots.map((lot: any) => lot.id)).size, 5);
  assert.equal((await use(itemId, today.data.movement.lotId)).status, 201);
  assert.equal((await use(itemId, expired.data.movement.lotId)).status, 409);
  assert.ok(
    (await call('/inventory/items?stock=expired')).data.some((item: any) => item.id === itemId),
  );
  assert.ok(
    (await call('/inventory/items?stock=expiring-soon')).data.some(
      (item: any) => item.id === itemId,
    ),
  );
  assert.equal(
    (
      await count(itemId, expired.data.movement.lotId, 0, {
        reason: 'Recorded disposal of expired stock',
      })
    ).status,
    201,
  );
  assert.ok(
    !(await call('/inventory/items?stock=expired')).data.some((item: any) => item.id === itemId),
  );
});

test('stock input validation enforces integer counted units, real dates, bounds and server-owned provenance', async () => {
  const created = await newItem();
  for (const invalid of [
    { quantity: 0 },
    { quantity: -1 },
    { quantity: 1.2 },
    { quantity: 1_000_001 },
    { expiryDate: '2027-02-30' },
    { expiryDate: undefined },
    { lotCode: 'x'.repeat(101) },
    { reason: '' },
    { reason: 'x'.repeat(1001) },
    { reference: 'x'.repeat(201) },
    { expectedRevision: 'invalid' },
    { requestId: 'invalid' },
    { balanceAfter: 999 },
  ])
    assert.equal((await receive(created.item.id, invalid)).status, 400);
  const received = await receive(created.item.id);
  const lotId = received.data.movement.lotId;
  for (const invalid of [
    { quantity: 0 },
    { quantity: -1 },
    { quantity: 0.5 },
    { quantity: 1_000_001 },
    { quantityDelta: -1 },
    { createdById: 'forged' },
  ])
    assert.equal((await use(created.item.id, lotId, invalid)).status, 400);
  for (const value of [-1, 0.5, 1_000_000_001])
    assert.equal((await count(created.item.id, lotId, value)).status, 400);
  assert.equal((await call('/inventory/items/missing')).status, 404);
  assert.equal((await use(created.item.id, 'missing-lot')).status, 404);
});

test('use and physical counts preserve exact signed movements and balance-after evidence without automatic billing', async () => {
  const financialTables = ['invoices', 'expenses', 'payments', 'activity'];
  const before = financialTables.map(
    (table) => app.locals.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,
  );
  const created = await newItem();
  const received = await receive(created.item.id, { quantity: 10 });
  const lotId = received.data.movement.lotId;
  assert.equal(received.data.movement.quantityDelta, 10);
  assert.equal(received.data.movement.balanceAfter, 10);
  const used = await use(created.item.id, lotId, { quantity: 3 });
  assert.equal(used.data.movement.quantityDelta, -3);
  assert.equal(used.data.movement.balanceAfter, 7);
  const reduced = await count(created.item.id, lotId, 5);
  assert.equal(reduced.data.movement.quantityDelta, -2);
  assert.equal(reduced.data.detail.item.onHandQuantity, 5);
  assert.equal(reduced.data.detail.item.lowStock, true);
  const increased = await count(created.item.id, lotId, 8);
  assert.equal(increased.data.movement.quantityDelta, 3);
  const unchanged = await count(created.item.id, lotId, 8);
  assert.equal(unchanged.data.movement.quantityDelta, 0);
  assert.notEqual(unchanged.data.detail.item.revision, increased.data.detail.item.revision);
  const ledger = (await call(`/inventory/items/${created.item.id}/movements`)).data
    .items as InventoryMovement[];
  assert.deepEqual(
    ledger.map((movement) => movement.quantityDelta),
    [0, 3, -2, -3, 10],
  );
  assert.equal(
    ledger.reduce((total, movement) => total + movement.quantityDelta, 0),
    8,
  );
  assert.equal(ledger.at(-1)!.balanceAfter, 10);
  assert.deepEqual(
    financialTables.map(
      (table) => app.locals.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,
    ),
    before,
  );
});

test('global actor-bound UUIDs reject different actions, items, lots or payloads and replay the original event with current detail', async () => {
  const input = catalogue();
  const created = (await call('/inventory/items', admin, 'POST', input)).data as InventoryDetail;
  assert.equal((await call('/inventory/items', otherAdmin, 'POST', input)).status, 409);
  const receipt = receiptBody(created, {
    lotCode: '  lot X  ',
    reason: '  Delivery  ',
    reference: '  receipt  ',
  });
  const received = await call(
    `/inventory/items/${created.item.id}/receipts`,
    admin,
    'POST',
    receipt,
  );
  const lotId = received.data.movement.lotId;
  const normalized = {
    ...receipt,
    lotCode: 'lot X',
    reason: 'Delivery',
    reference: 'receipt',
    expectedRevision: 'b'.repeat(64),
  };
  assert.equal(
    (await call(`/inventory/items/${created.item.id}/receipts`, admin, 'POST', normalized)).status,
    200,
  );
  assert.equal(
    (await call(`/inventory/items/${created.item.id}/receipts`, otherAdmin, 'POST', normalized))
      .status,
    409,
  );
  assert.equal((await receive(created.item.id, { ...normalized, quantity: 11 })).status, 409);
  const second = await newItem();
  assert.equal((await receive(second.item.id, normalized)).status, 409);
  assert.equal((await receive(created.item.id, { requestId: input.requestId })).status, 409);
  const useBody = {
    quantity: 2,
    reason: 'Consumption',
    reference: '',
    expectedRevision: (await detail(created.item.id)).item.revision,
    requestId: randomUUID(),
  };
  const used = await call(`/inventory/lots/${lotId}/use`, admin, 'POST', useBody);
  assert.equal(used.status, 201);
  const secondLot = (await receive(created.item.id, { quantity: 3 })).data.movement.lotId;
  assert.equal(
    (await call(`/inventory/lots/${secondLot}/use`, admin, 'POST', useBody)).status,
    409,
  );
  assert.equal(
    (await count(created.item.id, lotId, 2, { requestId: useBody.requestId })).status,
    409,
  );
  assert.equal(
    (await call(`/inventory/lots/${lotId}/use`, otherAdmin, 'POST', useBody)).status,
    409,
  );
  await count(created.item.id, lotId, 4);
  const replay = await call(`/inventory/lots/${lotId}/use`, admin, 'POST', {
    ...useBody,
    expectedRevision: 'c'.repeat(64),
  });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data.movement, used.data.movement);
  assert.equal(replay.data.movement.balanceAfter, 8);
  assert.equal(replay.data.detail.lots.find((lot: any) => lot.id === lotId).remainingQuantity, 4);
  assert.equal(
    app.locals.db
      .prepare('SELECT count(*) AS n FROM inventoryMovements WHERE requestId=?')
      .get(useBody.requestId).n,
    1,
  );
});

test('simultaneous retries apply a receipt once while competing withdrawals cannot create negative stock', async () => {
  const created = await newItem();
  const body = receiptBody(created, { quantity: 5 });
  const receipts = await Promise.all([
    call(`/inventory/items/${created.item.id}/receipts`, admin, 'POST', body),
    call(`/inventory/items/${created.item.id}/receipts`, admin, 'POST', body),
  ]);
  assert.deepEqual(receipts.map((result) => result.status).sort(), [200, 201]);
  assert.equal(receipts[0].data.movement.id, receipts[1].data.movement.id);
  const current = await detail(created.item.id);
  assert.equal(current.lots.length, 1);
  const lotId = current.lots[0].id;
  const input = {
    quantity: 4,
    reason: 'Competing stock use',
    expectedRevision: current.item.revision,
    requestId: randomUUID(),
  };
  const results = await Promise.all([
    call(`/inventory/lots/${lotId}/use`, admin, 'POST', input),
    call(`/inventory/lots/${lotId}/use`, otherAdmin, 'POST', { ...input, requestId: randomUUID() }),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  assert.equal((await detail(created.item.id)).item.onHandQuantity, 1);
  assert.equal((await use(created.item.id, lotId, { quantity: 2 })).status, 409);
  assert.equal((await detail(created.item.id)).item.onHandQuantity, 1);
  assert.equal((await use(created.item.id, lotId)).status, 201);
  assert.equal((await use(created.item.id, lotId)).status, 409);
});

test('revision checks reject stale metadata, receipts and counts and global balance caps remain exact', async () => {
  const created = await newItem();
  const first = await receive(created.item.id, { quantity: 1 });
  assert.equal(
    (await receive(created.item.id, { expectedRevision: created.item.revision })).status,
    409,
  );
  assert.equal(
    (await edit(created.item.id, { name: 'Stale name', expectedRevision: created.item.revision }))
      .status,
    409,
  );
  const next = await receive(created.item.id, { quantity: 1 });
  const firstLot = first.data.movement.lotId,
    secondLot = next.data.movement.lotId;
  assert.equal(
    (
      await count(created.item.id, firstLot, 5, {
        expectedRevision: first.data.detail.item.revision,
      })
    ).status,
    409,
  );
  const max = await count(created.item.id, firstLot, 999_999_999);
  assert.equal(max.status, 201);
  assert.equal(max.data.detail.item.onHandQuantity, 1_000_000_000);
  assert.equal((await receive(created.item.id, { quantity: 1 })).status, 409);
  assert.equal((await count(created.item.id, secondLot, 2)).status, 409);
  assert.equal((await detail(created.item.id)).item.onHandQuantity, 1_000_000_000);
});

test('archiving retains stock, blocks new receipts/use and permits physical counts and explicit reactivation', async () => {
  const created = await newItem();
  const received = await receive(created.item.id);
  const lotId = received.data.movement.lotId;
  const archived = await edit(created.item.id, {
    active: false,
    reason: 'Retired catalogue item; retained physical balance',
  });
  assert.equal(archived.status, 200);
  assert.equal(archived.data.item.onHandQuantity, 10);
  assert.equal(archived.data.item.lowStock, false);
  assert.ok(
    !(await call('/inventory/items')).data.some((item: any) => item.id === created.item.id),
  );
  assert.ok(
    (await call('/inventory/items?active=false')).data.some(
      (item: any) => item.id === created.item.id,
    ),
  );
  assert.ok(
    (await call(`/inventory/items?active=all&search=${created.item.sku.toLowerCase()}`)).data.some(
      (item: any) => item.id === created.item.id,
    ),
  );
  assert.equal((await receive(created.item.id)).status, 409);
  assert.equal((await use(created.item.id, lotId)).status, 409);
  assert.equal((await count(created.item.id, lotId, 2)).status, 201);
  assert.equal((await detail(created.item.id, reception)).item.onHandQuantity, 2);
  assert.equal((await edit(created.item.id, { active: true })).status, 200);
  assert.equal((await use(created.item.id, lotId)).status, 201);
});

test('clinic midnight changes revision and expiry while exact older requests still replay after expiry and archival', async (context) => {
  const today = clinicToday();
  const start = Date.parse(`${today}T23:59:59.900+05:30`);
  const sessions = app.locals.db.prepare('SELECT tokenHash,expiresAt FROM sessions').all();
  app.locals.db.prepare('UPDATE sessions SET expiresAt=?').run(start + 3 * 86_400_000);
  context.mock.timers.enable({ apis: ['Date'], now: start });
  try {
    const createBody = catalogue();
    const created = (await call('/inventory/items', admin, 'POST', createBody))
      .data as InventoryDetail;
    const receivedBody = receiptBody(created, { quantity: 5, expiryDate: today });
    const received = await call(
      `/inventory/items/${created.item.id}/receipts`,
      admin,
      'POST',
      receivedBody,
    );
    const lotId = received.data.movement.lotId;
    const useBody = {
      quantity: 1,
      reason: 'Recorded before date rollover',
      expectedRevision: received.data.detail.item.revision,
      requestId: randomUUID(),
    };
    const used = await call(`/inventory/lots/${lotId}/use`, admin, 'POST', useBody);
    assert.equal(used.status, 201);
    context.mock.timers.setTime(start + 200);
    assert.equal(clinicToday(), addDays(today, 1));
    const after = await detail(created.item.id);
    assert.notEqual(after.item.revision, used.data.detail.item.revision);
    assert.equal(after.item.expiredQuantity, 4);
    assert.equal(after.item.unexpiredQuantity, 0);
    assert.equal(
      (await use(created.item.id, lotId, { expectedRevision: used.data.detail.item.revision }))
        .status,
      409,
    );
    assert.equal((await use(created.item.id, lotId)).status, 409);
    const replayUse = await call(`/inventory/lots/${lotId}/use`, admin, 'POST', useBody);
    assert.equal(replayUse.status, 200);
    assert.deepEqual(replayUse.data.movement, used.data.movement);
    assert.equal(replayUse.data.detail.item.expiredQuantity, 4);
    assert.equal((await edit(created.item.id, { active: false })).status, 200);
    const replayReceipt = await call(
      `/inventory/items/${created.item.id}/receipts`,
      admin,
      'POST',
      receivedBody,
    );
    assert.equal(replayReceipt.status, 200);
    assert.deepEqual(replayReceipt.data.movement, received.data.movement);
    assert.equal(replayReceipt.data.detail.item.active, false);
    assert.equal(replayReceipt.data.detail.item.onHandQuantity, 4);
    const replayCreate = await call('/inventory/items', admin, 'POST', createBody);
    assert.equal(replayCreate.status, 200);
    assert.equal(replayCreate.data.item.active, false);
    assert.equal(
      (await count(created.item.id, lotId, 0, { reason: 'Recorded disposal after expiry' })).status,
      201,
    );
  } finally {
    context.mock.timers.reset();
    for (const session of sessions)
      app.locals.db
        .prepare('UPDATE sessions SET expiresAt=? WHERE tokenHash=?')
        .run(session.expiresAt, session.tokenHash);
  }
});

test('ledger cursors stay item-scoped and stable when newer movements arrive', async () => {
  const created = await newItem();
  const received = await receive(created.item.id, { quantity: 4 });
  const lotId = received.data.movement.lotId;
  await use(created.item.id, lotId);
  const previous = await count(created.item.id, lotId, 2);
  const first = (await call(`/inventory/items/${created.item.id}/movements?limit=1`)).data;
  assert.equal(first.items[0].id, previous.data.movement.id);
  assert.ok(first.nextCursor);
  await count(created.item.id, lotId, 1);
  const second = (
    await call(`/inventory/items/${created.item.id}/movements?limit=1&cursor=${first.nextCursor}`)
  ).data;
  assert.equal(second.items[0].type, 'use');
  assert.notEqual(second.items[0].id, first.items[0].id);
  const otherItem = await newItem();
  assert.equal(
    (await call(`/inventory/items/${otherItem.item.id}/movements?cursor=${first.nextCursor}`))
      .status,
    400,
  );
  assert.deepEqual((await call(`/inventory/items/${otherItem.item.id}/movements`)).data, {
    items: [],
    nextCursor: null,
  });
  for (const query of ['limit=0', 'limit=101', 'cursor=invalid', `cursor=${randomUUID()}`])
    assert.equal(
      (await call(`/inventory/items/${created.item.id}/movements?${query}`)).status,
      400,
    );
});

test('lot metadata, source movements and request receipts cannot be rewritten or deleted', async () => {
  const created = await newItem();
  const received = await receive(created.item.id);
  const movement = received.data.movement as InventoryMovement;
  assert.throws(
    () =>
      app.locals.db.prepare('UPDATE inventoryLots SET data=? WHERE id=?').run('{}', movement.lotId),
    /immutable/,
  );
  assert.throws(
    () => app.locals.db.prepare('DELETE FROM inventoryLots WHERE id=?').run(movement.lotId),
    /immutable/,
  );
  assert.throws(
    () =>
      app.locals.db
        .prepare('UPDATE inventoryMovements SET quantityDelta=? WHERE id=?')
        .run(100, movement.id),
    /immutable/,
  );
  assert.throws(
    () => app.locals.db.prepare('DELETE FROM inventoryMovements WHERE id=?').run(movement.id),
    /immutable/,
  );
  assert.throws(
    () =>
      app.locals.db
        .prepare('UPDATE inventoryCommands SET payload=? WHERE requestId=?')
        .run('{}', movement.requestId),
    /immutable/,
  );
  assert.throws(
    () =>
      app.locals.db
        .prepare('DELETE FROM inventoryCommands WHERE requestId=?')
        .run(movement.requestId),
    /immutable/,
  );
});

test('audit failures roll back catalogue, lot, movement and idempotency writes together', async () => {
  const created = await newItem();
  const received = await receive(created.item.id);
  const before = await detail(created.item.id);
  const newInput = catalogue();
  const commandIds = Array.from({ length: 4 }, () => randomUUID());
  app.locals.db.exec(
    "CREATE TRIGGER synthetic_inventory_audit_failure BEFORE INSERT ON audit WHEN json_extract(NEW.data,'$.action') IN ('created inventory item','changed inventory catalogue metadata','received inventory stock','recorded inventory stock use','reconciled inventory physical count') BEGIN SELECT RAISE(ABORT,'Synthetic inventory audit failure'); END;",
  );
  try {
    assert.equal((await call('/inventory/items', admin, 'POST', newInput)).status, 500);
    assert.equal(
      (await edit(created.item.id, { name: 'Must not be saved', requestId: commandIds[0] })).status,
      500,
    );
    assert.equal((await receive(created.item.id, { requestId: commandIds[1] })).status, 500);
    assert.equal(
      (await use(created.item.id, received.data.movement.lotId, { requestId: commandIds[2] }))
        .status,
      500,
    );
    assert.equal(
      (await count(created.item.id, received.data.movement.lotId, 0, { requestId: commandIds[3] }))
        .status,
      500,
    );
    assert.deepEqual(await detail(created.item.id), before);
    assert.equal(
      app.locals.db
        .prepare('SELECT count(*) AS n FROM inventoryItems WHERE sku=?')
        .get(newInput.sku).n,
      0,
    );
    for (const requestId of [newInput.requestId, ...commandIds])
      assert.equal(
        app.locals.db
          .prepare('SELECT count(*) AS n FROM inventoryCommands WHERE requestId=?')
          .get(requestId).n,
        0,
      );
  } finally {
    app.locals.db.exec('DROP TRIGGER synthetic_inventory_audit_failure');
  }
  assert.equal((await call('/inventory/items', admin, 'POST', newInput)).status, 201);
  assert.equal(
    (await use(created.item.id, received.data.movement.lotId, { requestId: commandIds[2] })).status,
    201,
  );
});

test('inventory migration is additive and source history, balances and request replays survive restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'derma-inventory-migration-'));
  const path = join(directory, 'legacy.sqlite');
  const legacy = openDatabase(path);
  seedDemo(legacy);
  const originalPatient = legacy
    .prepare('SELECT data FROM patients WHERE id=?')
    .get('patient-ananya')!.data;
  legacy.close();
  let migrated: ReturnType<typeof createApp> | undefined, live: Server | undefined;
  try {
    migrated = createApp({ databasePath: path, demoMode: true });
    const started = await listen(migrated);
    live = started.server;
    const client: Client = {};
    assert.equal(
      (
        await call(
          '/auth/login',
          client,
          'POST',
          { email: 'admin@derma.demo', password: 'DemoClinic2026!' },
          started.base,
        )
      ).status,
      200,
    );
    assert.deepEqual(
      (await call('/inventory/items', client, 'GET', undefined, started.base)).data,
      [],
    );
    const created = await call('/inventory/items', client, 'POST', catalogue(), started.base);
    assert.equal(created.status, 201);
    const receipt = receiptBody(created.data, { quantity: 5 });
    const received = await call(
      `/inventory/items/${created.data.item.id}/receipts`,
      client,
      'POST',
      receipt,
      started.base,
    );
    assert.equal(received.status, 201);
    const used = await call(
      `/inventory/lots/${received.data.movement.lotId}/use`,
      client,
      'POST',
      {
        quantity: 2,
        reason: 'Persistent use',
        expectedRevision: received.data.detail.item.revision,
        requestId: randomUUID(),
      },
      started.base,
    );
    assert.equal(used.status, 201);
    const metadata = await call(
      `/inventory/items/${created.data.item.id}`,
      client,
      'PATCH',
      {
        name: 'Persistent catalogue change',
        reason: 'Confirmed label',
        expectedRevision: used.data.detail.item.revision,
        requestId: randomUUID(),
      },
      started.base,
    );
    assert.equal(metadata.status, 200);
    await close(live);
    live = undefined;
    migrated.locals.close();
    migrated = undefined;
    migrated = createApp({ databasePath: path, demoMode: true });
    const restarted = await listen(migrated);
    live = restarted.server;
    const restored = await call(
      `/inventory/items/${created.data.item.id}`,
      client,
      'GET',
      undefined,
      restarted.base,
    );
    assert.deepEqual(restored.data, metadata.data);
    assert.equal(restored.data.item.onHandQuantity, 3);
    assert.equal(restored.data.itemChanges.length, 2);
    const replay = await call(
      `/inventory/items/${created.data.item.id}/receipts`,
      client,
      'POST',
      receipt,
      restarted.base,
    );
    assert.equal(replay.status, 200);
    assert.equal(replay.data.movement.balanceAfter, 5);
    assert.equal(replay.data.detail.item.onHandQuantity, 3);
    assert.equal(
      migrated.locals.db.prepare('SELECT data FROM patients WHERE id=?').get('patient-ananya').data,
      originalPatient,
    );
    assert.equal(migrated.locals.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    if (live) await close(live);
    migrated?.locals.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
