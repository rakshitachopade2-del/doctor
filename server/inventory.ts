import type { Express } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AuthRequest } from './app.ts';
import type { User } from '../shared/types.ts';
import {
  inventoryCategories,
  inventoryUnits,
  type InventoryCatalogue,
  type InventoryDetail,
  type InventoryItemChange,
  type InventoryLot,
  type InventoryMovement,
  type InventoryMutation,
} from '../shared/inventory.ts';
import { addDays, clinicToday, get, id, nowISO, type DB } from './db.ts';

interface InventoryContext {
  db: DB;
  actor: (req: AuthRequest, roles?: User['role'][]) => User;
  audit: (req: AuthRequest, action: string, entityType: string, entityId: string) => void;
  fail: (status: number, message: string) => never;
}
interface StoredItem {
  id: string;
  sku: string;
  unit: InventoryCatalogue['unit'];
  createdAt: string;
}
type StoredLot = Omit<
  InventoryLot,
  'receivedQuantity' | 'remainingQuantity' | 'expired' | 'expiresSoon'
>;
type Operation = 'create-item' | 'change-item' | 'receipt' | 'use' | 'adjustment';
const maxBalance = 1_000_000_000;
const quantity = z.number().int().min(1).max(1_000_000);
const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const revision = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'Refresh inventory to obtain its current revision.');
const reason = z.string().trim().min(1).max(1000);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      !Number.isNaN(Date.parse(`${value}T12:00:00Z`)) &&
      new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value,
    'Use a real calendar expiry date.',
  );
const catalogueFields = {
  name: z.string().trim().min(1).max(150),
  category: z.enum(inventoryCategories),
  reorderLevel: z.number().int().min(0).max(1_000_000),
};
const movementFields = {
  reason,
  reference: z.string().trim().max(200).default(''),
  expectedRevision: revision,
  requestId: uuid,
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function registerInventory(app: Express, { db, actor, audit, fail }: InventoryContext) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inventoryItems (
      id TEXT PRIMARY KEY, sku TEXT NOT NULL UNIQUE COLLATE NOCASE, unit TEXT NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inventoryItemChanges (
      id TEXT PRIMARY KEY, itemId TEXT NOT NULL REFERENCES inventoryItems(id), data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS inventory_item_changes_item ON inventoryItemChanges(itemId);
    CREATE TABLE IF NOT EXISTS inventoryLots (
      id TEXT PRIMARY KEY, itemId TEXT NOT NULL REFERENCES inventoryItems(id), data TEXT NOT NULL, UNIQUE(id,itemId)
    );
    CREATE INDEX IF NOT EXISTS inventory_lots_item ON inventoryLots(itemId);
    CREATE TABLE IF NOT EXISTS inventoryMovements (
      id TEXT PRIMARY KEY, itemId TEXT NOT NULL REFERENCES inventoryItems(id), lotId TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('receipt','use','adjustment')),
      quantityDelta INTEGER NOT NULL CHECK(quantityDelta BETWEEN -1000000000 AND 1000000000),
      requestId TEXT NOT NULL UNIQUE, data TEXT NOT NULL,
      FOREIGN KEY(lotId,itemId) REFERENCES inventoryLots(id,itemId)
    );
    CREATE INDEX IF NOT EXISTS inventory_movements_item ON inventoryMovements(itemId);
    CREATE INDEX IF NOT EXISTS inventory_movements_lot ON inventoryMovements(lotId);
    CREATE UNIQUE INDEX IF NOT EXISTS inventory_lot_initial_receipt ON inventoryMovements(lotId) WHERE type='receipt';
    CREATE TABLE IF NOT EXISTS inventoryCommands (
      requestId TEXT PRIMARY KEY, actorId TEXT NOT NULL REFERENCES users(id),
      operation TEXT NOT NULL, targetId TEXT NOT NULL, payload TEXT NOT NULL,
      itemId TEXT NOT NULL REFERENCES inventoryItems(id), movementId TEXT REFERENCES inventoryMovements(id)
    );
  `);
  for (const table of [
    'inventoryItems',
    'inventoryItemChanges',
    'inventoryLots',
    'inventoryMovements',
    'inventoryCommands',
  ]) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT,'Inventory source records are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT,'Inventory source records are immutable'); END;`);
  }
  function transaction<T>(operation: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  const staff = (req: AuthRequest) => actor(req, ['admin', 'doctor', 'receptionist']);
  const admin = (req: AuthRequest) => actor(req, ['admin']);
  function itemRecord(itemId: string) {
    const item = get<StoredItem>(db, 'inventoryItems', itemId);
    if (!item) return fail(404, 'Inventory item not found.');
    return item;
  }
  function checkedBalance(value: number) {
    if (!Number.isSafeInteger(value) || value < 0 || value > maxBalance)
      return fail(409, 'Stock must remain between zero and 1,000,000,000 whole units.');
    return value;
  }
  function detail(itemId: string): InventoryDetail {
    const original = itemRecord(itemId);
    const today = clinicToday();
    const itemChanges = db
      .prepare('SELECT data FROM inventoryItemChanges WHERE itemId=? ORDER BY rowid DESC')
      .all(itemId)
      .map((row) => JSON.parse(row.data as string) as InventoryItemChange);
    const latest = itemChanges[0];
    if (!latest) return fail(500, 'Inventory catalogue history is incomplete.');
    const latestMovement = db
      .prepare('SELECT id,data FROM inventoryMovements WHERE itemId=? ORDER BY rowid DESC LIMIT 1')
      .get(itemId);
    const lots: InventoryLot[] = db
      .prepare(
        `SELECT lots.data,COALESCE(SUM(movements.quantityDelta),0) AS remaining,
      COALESCE(SUM(CASE WHEN movements.type='receipt' THEN movements.quantityDelta ELSE 0 END),0) AS received
      FROM inventoryLots AS lots LEFT JOIN inventoryMovements AS movements ON movements.lotId=lots.id
      WHERE lots.itemId=? GROUP BY lots.id`,
      )
      .all(itemId)
      .map((row) => {
        const lot = JSON.parse(row.data as string) as StoredLot;
        const remainingQuantity = checkedBalance(Number(row.remaining));
        return {
          ...lot,
          receivedQuantity: Number(row.received),
          remainingQuantity,
          expired: lot.expiryDate !== null && lot.expiryDate < today,
          expiresSoon:
            remainingQuantity > 0 &&
            lot.expiryDate !== null &&
            lot.expiryDate >= today &&
            lot.expiryDate <= addDays(today, 30),
        };
      })
      .sort(
        (a, b) =>
          (a.expiryDate ?? '9999-99-99').localeCompare(b.expiryDate ?? '9999-99-99') ||
          a.createdAt.localeCompare(b.createdAt) ||
          a.id.localeCompare(b.id),
      );
    const sum = (filter: (lot: InventoryLot) => boolean) =>
      checkedBalance(lots.filter(filter).reduce((total, lot) => total + lot.remainingQuantity, 0));
    const unexpiredQuantity = sum((lot) => !lot.expired);
    const updatedAt = latestMovement
      ? [
          latest.createdAt,
          (JSON.parse(latestMovement.data as string) as InventoryMovement).createdAt,
        ]
          .sort()
          .at(-1)!
      : latest.createdAt;
    return {
      item: {
        ...latest.snapshot,
        id: original.id,
        sku: original.sku,
        unit: original.unit,
        createdAt: original.createdAt,
        updatedAt,
        revision: digest([original.id, latest.id, latestMovement?.id ?? null, today]),
        onHandQuantity: sum(() => true),
        unexpiredQuantity,
        expiredQuantity: sum((lot) => lot.expired),
        expiringSoonQuantity: sum((lot) => lot.expiresSoon),
        lowStock: latest.snapshot.active && unexpiredQuantity <= latest.snapshot.reorderLevel,
      },
      lots,
      itemChanges,
    };
  }
  function assertCurrent(expected: string, current: InventoryDetail) {
    if (expected !== current.item.revision)
      fail(
        409,
        'Inventory or its expiry status has changed. Refresh and review the latest stock before saving.',
      );
  }
  // A UUID belongs to its authenticated actor and semantic operation globally.
  // Expected revisions are concurrency controls, not business payload; replays
  // are resolved before checking current revision, activation or expiry state.
  function replay(
    user: User,
    requestId: string,
    operation: Operation,
    targetId: string,
    payload: unknown,
  ) {
    const row = db
      .prepare(
        'SELECT actorId,operation,targetId,payload,itemId,movementId FROM inventoryCommands WHERE requestId=?',
      )
      .get(requestId);
    if (!row) return null;
    if (
      row.actorId !== user.id ||
      row.operation !== operation ||
      row.targetId !== targetId ||
      row.payload !== JSON.stringify(payload)
    )
      return fail(
        409,
        'This request ID was already used by another actor or for different inventory details. Retry the original request.',
      );
    return {
      itemId: String(row.itemId),
      movementId: row.movementId ? String(row.movementId) : null,
    };
  }
  function remember(
    user: User,
    requestId: string,
    operation: Operation,
    targetId: string,
    payload: unknown,
    itemId: string,
    movementId: string | null = null,
  ) {
    db.prepare(
      'INSERT INTO inventoryCommands(requestId,actorId,operation,targetId,payload,itemId,movementId) VALUES (?,?,?,?,?,?,?)',
    ).run(requestId, user.id, operation, targetId, JSON.stringify(payload), itemId, movementId);
  }
  function catalogueChange(user: User, itemId: string, snapshot: InventoryCatalogue, note: string) {
    const change: InventoryItemChange = {
      id: id(),
      itemId,
      snapshot,
      reason: note,
      createdById: user.id,
      createdByName: user.name,
      createdAt: nowISO(),
    };
    db.prepare('INSERT INTO inventoryItemChanges(id,itemId,data) VALUES (?,?,?)').run(
      change.id,
      itemId,
      JSON.stringify(change),
    );
    return change;
  }
  function recordMovement(
    user: User,
    itemId: string,
    lotId: string,
    type: InventoryMovement['type'],
    quantityDelta: number,
    balanceAfter: number,
    input: { requestId: string; reason: string; reference: string },
  ): InventoryMovement {
    const movement: InventoryMovement = {
      id: id(),
      itemId,
      lotId,
      type,
      quantityDelta,
      balanceAfter,
      ...input,
      createdById: user.id,
      createdByName: user.name,
      createdAt: nowISO(),
    };
    db.prepare(
      'INSERT INTO inventoryMovements(id,itemId,lotId,type,quantityDelta,requestId,data) VALUES (?,?,?,?,?,?,?)',
    ).run(
      movement.id,
      itemId,
      lotId,
      type,
      quantityDelta,
      input.requestId,
      JSON.stringify(movement),
    );
    return movement;
  }
  function replayMovement(command: {
    itemId: string;
    movementId: string | null;
  }): InventoryMutation {
    const movement = command.movementId
      ? get<InventoryMovement>(db, 'inventoryMovements', command.movementId)
      : undefined;
    if (!movement) return fail(500, 'Inventory request history is incomplete.');
    return { detail: detail(command.itemId), movement };
  }
  app.get('/api/inventory/items', (req: AuthRequest, res) => {
    staff(req);
    const input = z
      .object({
        search: z.string().trim().max(200).default(''),
        active: z.enum(['true', 'false', 'all']).default('true'),
        stock: z.enum(['low', 'expired', 'expiring-soon']).optional(),
      })
      .parse(req.query);
    const values = transaction(() => {
      const query = input.search.toLowerCase();
      const rows = db
        .prepare('SELECT id FROM inventoryItems')
        .all()
        .map((row) => detail(String(row.id)).item)
        .filter(
          (item) =>
            (input.active === 'all' || item.active === (input.active === 'true')) &&
            (!query ||
              item.name.toLowerCase().includes(query) ||
              item.sku.toLowerCase().includes(query)) &&
            (!input.stock ||
              (input.stock === 'low'
                ? item.lowStock
                : input.stock === 'expired'
                  ? item.expiredQuantity > 0
                  : item.expiringSoonQuantity > 0)),
        )
        .sort((a, b) => a.name.localeCompare(b.name) || a.sku.localeCompare(b.sku));
      audit(req, 'viewed clinic inventory catalogue', 'inventory', 'catalogue');
      return rows;
    });
    res.json(values);
  });
  app.get('/api/inventory/items/:id', (req: AuthRequest, res) => {
    staff(req);
    const value = transaction(() => {
      const current = detail(String(req.params.id));
      audit(req, 'viewed inventory item', 'inventoryItem', current.item.id);
      return current;
    });
    res.json(value);
  });
  app.get('/api/inventory/items/:id/movements', (req: AuthRequest, res) => {
    staff(req);
    const input = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        cursor: uuid.optional(),
      })
      .parse(req.query);
    const itemId = String(req.params.id);
    const ledger = transaction(() => {
      itemRecord(itemId);
      let cursorRow: number | undefined;
      if (input.cursor) {
        const row = db
          .prepare('SELECT rowid FROM inventoryMovements WHERE id=? AND itemId=?')
          .get(input.cursor, itemId);
        if (!row)
          return fail(400, 'This inventory ledger page is unavailable. Refresh the history.');
        cursorRow = Number(row.rowid);
      }
      const rows = db
        .prepare(
          `SELECT id,data FROM inventoryMovements WHERE itemId=?${cursorRow === undefined ? '' : ' AND rowid<?'} ORDER BY rowid DESC LIMIT ?`,
        )
        .all(itemId, ...(cursorRow === undefined ? [] : [cursorRow]), input.limit + 1);
      const visible = rows.slice(0, input.limit);
      audit(req, 'viewed inventory movement history', 'inventoryItem', itemId);
      return {
        items: visible.map((row) => JSON.parse(row.data as string) as InventoryMovement),
        nextCursor: rows.length > input.limit ? String(visible.at(-1)!.id) : null,
      };
    });
    res.json(ledger);
  });
  app.post('/api/inventory/items', (req: AuthRequest, res) => {
    const user = admin(req);
    const input = z
      .object({
        sku: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z0-9][A-Z0-9._-]{0,49}$/),
        ...catalogueFields,
        unit: z.enum(inventoryUnits),
        requestId: uuid,
      })
      .strict()
      .parse(req.body);
    const { requestId, ...payload } = input;
    const result = transaction(() => {
      const previous = replay(user, requestId, 'create-item', '', payload);
      if (previous) return { value: detail(previous.itemId), duplicate: true };
      if (db.prepare('SELECT 1 FROM inventoryItems WHERE sku=? COLLATE NOCASE').get(input.sku))
        return fail(409, 'This inventory SKU already exists. Use its existing catalogue entry.');
      const item: StoredItem = { id: id(), sku: input.sku, unit: input.unit, createdAt: nowISO() };
      db.prepare('INSERT INTO inventoryItems(id,sku,unit,data) VALUES (?,?,?,?)').run(
        item.id,
        item.sku,
        item.unit,
        JSON.stringify(item),
      );
      catalogueChange(user, item.id, { ...payload, active: true }, 'Item created');
      audit(req, 'created inventory item', 'inventoryItem', item.id);
      remember(user, requestId, 'create-item', '', payload, item.id);
      return { value: detail(item.id), duplicate: false };
    });
    res.status(result.duplicate ? 200 : 201).json(result.value);
  });
  app.patch('/api/inventory/items/:id', (req: AuthRequest, res) => {
    const user = admin(req);
    const input = z
      .object({
        name: catalogueFields.name.optional(),
        category: catalogueFields.category.optional(),
        reorderLevel: catalogueFields.reorderLevel.optional(),
        active: z.boolean().optional(),
        reason,
        expectedRevision: revision,
        requestId: uuid,
      })
      .strict()
      .refine(
        (value) =>
          value.name !== undefined ||
          value.category !== undefined ||
          value.reorderLevel !== undefined ||
          value.active !== undefined,
        'Supply at least one catalogue field.',
      )
      .parse(req.body);
    const { expectedRevision, requestId, ...payload } = input;
    const itemId = String(req.params.id);
    const value = transaction(() => {
      const previous = replay(user, requestId, 'change-item', itemId, payload);
      if (previous) return detail(previous.itemId);
      const current = detail(itemId);
      assertCurrent(expectedRevision, current);
      const prior = current.itemChanges[0].snapshot;
      const { reason: note, ...changes } = payload;
      catalogueChange(user, itemId, { ...prior, ...changes }, note);
      audit(req, 'changed inventory catalogue metadata', 'inventoryItem', itemId);
      remember(user, requestId, 'change-item', itemId, payload, itemId);
      return detail(itemId);
    });
    res.json(value);
  });
  app.post('/api/inventory/items/:id/receipts', (req: AuthRequest, res) => {
    const user = admin(req);
    const input = z
      .object({
        quantity,
        lotCode: z.string().trim().max(100).default(''),
        expiryDate: date.nullable(),
        ...movementFields,
      })
      .strict()
      .parse(req.body);
    const { expectedRevision, requestId, ...payload } = input;
    const itemId = String(req.params.id);
    const result = transaction(() => {
      const previous = replay(user, requestId, 'receipt', itemId, payload);
      if (previous) return { value: replayMovement(previous), duplicate: true };
      const current = detail(itemId);
      assertCurrent(expectedRevision, current);
      if (!current.item.active)
        return fail(409, 'Reactivate this item before recording a new receipt.');
      checkedBalance(current.item.onHandQuantity + input.quantity);
      const lot: StoredLot = {
        id: id(),
        itemId,
        lotCode: input.lotCode,
        expiryDate: input.expiryDate,
        createdAt: nowISO(),
        createdById: user.id,
        createdByName: user.name,
      };
      db.prepare('INSERT INTO inventoryLots(id,itemId,data) VALUES (?,?,?)').run(
        lot.id,
        itemId,
        JSON.stringify(lot),
      );
      const movement = recordMovement(
        user,
        itemId,
        lot.id,
        'receipt',
        input.quantity,
        input.quantity,
        { requestId, reason: input.reason, reference: input.reference },
      );
      audit(req, 'received inventory stock', 'inventoryItem', itemId);
      remember(user, requestId, 'receipt', itemId, payload, itemId, movement.id);
      return { value: { detail: detail(itemId), movement }, duplicate: false };
    });
    res.status(result.duplicate ? 200 : 201).json(result.value);
  });
  function changeLot(req: AuthRequest, operation: 'use' | 'adjustment') {
    const user = admin(req);
    const input =
      operation === 'use'
        ? z
            .object({ quantity, ...movementFields })
            .strict()
            .parse(req.body)
        : z
            .object({ countedQuantity: z.number().int().min(0).max(maxBalance), ...movementFields })
            .strict()
            .parse(req.body);
    const { expectedRevision, requestId, ...payload } = input;
    const lotId = String(req.params.id);
    return transaction(() => {
      const previous = replay(user, requestId, operation, lotId, payload);
      if (previous) return { value: replayMovement(previous), duplicate: true };
      const original = get<StoredLot>(db, 'inventoryLots', lotId);
      if (!original) return fail(404, 'Inventory lot not found.');
      const current = detail(original.itemId);
      assertCurrent(expectedRevision, current);
      const lot = current.lots.find((value) => value.id === lotId)!;
      if (operation === 'use') {
        if (!current.item.active)
          return fail(409, 'Reactivate this item before recording stock use.');
        if (lot.expired)
          return fail(
            409,
            'This lot has expired. Record disposal through a physical-count adjustment instead.',
          );
      }
      const balanceAfter = checkedBalance(
        'quantity' in input ? lot.remainingQuantity - input.quantity : input.countedQuantity,
      );
      checkedBalance(current.item.onHandQuantity - lot.remainingQuantity + balanceAfter);
      const movement = recordMovement(
        user,
        original.itemId,
        lotId,
        operation,
        balanceAfter - lot.remainingQuantity,
        balanceAfter,
        { requestId, reason: input.reason, reference: input.reference },
      );
      audit(
        req,
        operation === 'use'
          ? 'recorded inventory stock use'
          : 'reconciled inventory physical count',
        'inventoryItem',
        original.itemId,
      );
      remember(user, requestId, operation, lotId, payload, original.itemId, movement.id);
      return { value: { detail: detail(original.itemId), movement }, duplicate: false };
    });
  }
  app.post('/api/inventory/lots/:id/use', (req: AuthRequest, res) => {
    const result = changeLot(req, 'use');
    res.status(result.duplicate ? 200 : 201).json(result.value);
  });
  app.post('/api/inventory/lots/:id/adjust', (req: AuthRequest, res) => {
    const result = changeLot(req, 'adjustment');
    res.status(result.duplicate ? 200 : 201).json(result.value);
  });
}
