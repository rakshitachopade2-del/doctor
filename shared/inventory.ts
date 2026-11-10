export const inventoryCategories = [
  'dressings',
  'protective-equipment',
  'instruments',
  'cleaning',
  'office',
  'other',
] as const;
export type InventoryCategory = (typeof inventoryCategories)[number];
export const inventoryUnits = ['piece', 'pair', 'pack', 'box', 'bottle'] as const;
export type InventoryUnit = (typeof inventoryUnits)[number];

export interface InventoryCatalogue {
  sku: string;
  name: string;
  category: InventoryCategory;
  unit: InventoryUnit;
  reorderLevel: number;
  active: boolean;
}

export interface InventoryItem extends InventoryCatalogue {
  id: string;
  createdAt: string;
  updatedAt: string;
  revision: string;
  onHandQuantity: number;
  /** Includes lots with no recorded expiry; this is not a clinical usability assessment. */
  unexpiredQuantity: number;
  expiredQuantity: number;
  expiringSoonQuantity: number;
  lowStock: boolean;
}

export interface InventoryItemChange {
  id: string;
  itemId: string;
  reason: string;
  createdById: string;
  createdByName: string;
  createdAt: string;
  snapshot: InventoryCatalogue;
}

export interface InventoryLot {
  id: string;
  itemId: string;
  lotCode: string;
  expiryDate: string | null;
  createdAt: string;
  createdById: string;
  createdByName: string;
  receivedQuantity: number;
  remainingQuantity: number;
  expired: boolean;
  expiresSoon: boolean;
}

export interface InventoryMovement {
  id: string;
  itemId: string;
  lotId: string;
  type: 'receipt' | 'use' | 'adjustment';
  quantityDelta: number;
  balanceAfter: number;
  reason: string;
  reference: string;
  requestId: string;
  createdById: string;
  createdByName: string;
  createdAt: string;
}

export interface InventoryDetail {
  item: InventoryItem;
  lots: InventoryLot[];
  itemChanges: InventoryItemChange[];
}

export interface InventoryLedger {
  items: InventoryMovement[];
  nextCursor: string | null;
}

export interface InventoryMutation {
  detail: InventoryDetail;
  movement: InventoryMovement;
}
