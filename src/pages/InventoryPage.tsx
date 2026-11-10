import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Archive,
  ArrowLeft,
  ArrowUpRight,
  Boxes,
  ClipboardCheck,
  History,
  PackagePlus,
  Pencil,
  Plus,
  RefreshCw,
  Search,
} from 'lucide-react';
import {
  inventoryCategories,
  inventoryUnits,
  type InventoryCategory,
  type InventoryDetail,
  type InventoryItem,
  type InventoryLedger,
  type InventoryLot,
  type InventoryMovement,
  type InventoryMutation,
  type InventoryUnit,
} from '../../shared/inventory';
import { api, ApiError, formatDate, useResource, useSession, useToast } from '../lib';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  Modal,
  PageHeader,
} from '../components/ui';
import './inventory.css';

const categoryNames: Record<InventoryCategory, string> = {
  dressings: 'Dressings',
  'protective-equipment': 'Protective equipment',
  instruments: 'Instruments',
  cleaning: 'Cleaning',
  office: 'Office',
  other: 'Other',
};
const unitNames: Record<InventoryUnit, string> = {
  piece: 'Piece',
  pair: 'Pair',
  pack: 'Pack',
  box: 'Box',
  bottle: 'Bottle',
};
const quantityText = (quantity: number, unit: InventoryUnit) =>
  `${quantity.toLocaleString('en-IN')} ${quantity === 1 ? unit : unit === 'box' ? 'boxes' : `${unit}s`}`;
const lotName = (lot: InventoryLot) => lot.lotCode || 'Unlabelled receipt';
const timestamp = (value: string) =>
  new Date(value).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
const errorText = (problem: unknown) =>
  problem instanceof Error
    ? problem.message
    : 'The request could not be confirmed. Please try again.';
const movementName = (type: InventoryMovement['type']) =>
  ({ receipt: 'Receipt', use: 'Use', adjustment: 'Physical count' })[type];
function wholeNumber(value: string, label: string, minimum: number, maximum: number) {
  if (!/^\d+$/.test(value.trim()))
    throw new Error(`${label} must be a whole number. Fractions are not rounded.`);
  const quantity = Number(value);
  if (!Number.isSafeInteger(quantity) || quantity < minimum || quantity > maximum)
    throw new Error(
      `${label} must be from ${minimum.toLocaleString('en-IN')} to ${maximum.toLocaleString('en-IN')}.`,
    );
  return quantity;
}
function realDate(value: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T12:00:00Z`)) &&
    new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value
  );
}

type Operation = 'create' | 'edit' | 'receipt' | 'use' | 'adjust';
type DraftValues = {
  sku: string;
  name: string;
  category: InventoryCategory;
  unit: InventoryUnit;
  reorderLevel: string;
  active: boolean;
  quantity: string;
  lotCode: string;
  expiryDate: string;
  reason: string;
  reference: string;
};
type Attempt = { path: string; method: 'POST' | 'PATCH'; body: Record<string, unknown> };
type InventoryDraft = {
  kind: Operation;
  requestId: string;
  detail: InventoryDetail | null;
  lotId: string | null;
  values: DraftValues;
  attempt: Attempt | null;
  phase: 'editing' | 'uncertain' | 'conflict';
  error: string;
  reviewed: InventoryDetail | null;
};
function newDraft(
  kind: Operation,
  detail: InventoryDetail | null = null,
  lot?: InventoryLot,
  active?: boolean,
): InventoryDraft {
  return {
    kind,
    detail,
    lotId: lot?.id ?? null,
    requestId: crypto.randomUUID(),
    attempt: null,
    phase: 'editing',
    error: '',
    reviewed: null,
    values: {
      sku: detail?.item.sku ?? '',
      name: detail?.item.name ?? '',
      category: detail?.item.category ?? 'dressings',
      unit: detail?.item.unit ?? 'piece',
      reorderLevel: String(detail?.item.reorderLevel ?? 0),
      active: active ?? detail?.item.active ?? true,
      quantity: kind === 'adjust' ? String(lot?.remainingQuantity ?? 0) : '',
      lotCode: '',
      expiryDate: '',
      reason: '',
      reference: '',
    },
  };
}
const operationTitle: Record<Operation, string> = {
  create: 'Create inventory item',
  edit: 'Update inventory item',
  receipt: 'Record a stock receipt',
  use: 'Record stock use',
  adjust: 'Record a physical count',
};
const saveTitle: Record<Operation, string> = {
  create: 'Create item',
  edit: 'Save item changes',
  receipt: 'Save receipt',
  use: 'Record use',
  adjust: 'Save physical count',
};

function checkedDetail(value: unknown, expectedId?: string): InventoryDetail {
  const detail = value as InventoryDetail | null;
  const item = detail?.item;
  if (
    !item ||
    typeof item.id !== 'string' ||
    !item.id ||
    (expectedId && item.id !== expectedId) ||
    typeof item.revision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(item.revision) ||
    typeof item.sku !== 'string' ||
    typeof item.name !== 'string' ||
    typeof item.active !== 'boolean' ||
    !inventoryUnits.includes(item.unit) ||
    !inventoryCategories.includes(item.category) ||
    ![
      item.reorderLevel,
      item.onHandQuantity,
      item.unexpiredQuantity,
      item.expiredQuantity,
      item.expiringSoonQuantity,
    ].every((number) => Number.isSafeInteger(number) && number >= 0) ||
    !Array.isArray(detail?.lots) ||
    !Array.isArray(detail.itemChanges)
  )
    throw new Error(
      'The server response did not confirm this inventory entry. Retry the same request to verify its outcome.',
    );
  return detail;
}

function checkedSave(value: unknown, draft: InventoryDraft, attempt: Attempt): InventoryDetail {
  if (draft.kind === 'create' || draft.kind === 'edit') {
    const detail = checkedDetail(value, draft.detail?.item.id);
    const sku = draft.kind === 'create' ? attempt.body.sku : draft.detail!.item.sku;
    const unit = draft.kind === 'create' ? attempt.body.unit : draft.detail!.item.unit;
    if (detail.item.sku !== sku || detail.item.unit !== unit)
      throw new Error(
        'The server response did not match this inventory item. Retry the same request to verify its outcome.',
      );
    return detail;
  }
  const result = value as InventoryMutation | null;
  const detail = checkedDetail(result?.detail, draft.detail!.item.id);
  const movement = result?.movement;
  const expectedType = draft.kind === 'adjust' ? 'adjustment' : draft.kind;
  if (
    !movement ||
    typeof movement.id !== 'string' ||
    !movement.id ||
    movement.itemId !== detail.item.id ||
    movement.requestId !== attempt.body.requestId ||
    movement.type !== expectedType ||
    typeof movement.lotId !== 'string' ||
    (draft.lotId && movement.lotId !== draft.lotId) ||
    !detail.lots.some((lot) => lot.id === movement.lotId && lot.itemId === detail.item.id) ||
    !Number.isSafeInteger(movement.quantityDelta) ||
    !Number.isSafeInteger(movement.balanceAfter) ||
    movement.balanceAfter < 0 ||
    (draft.kind === 'receipt' && movement.quantityDelta !== attempt.body.quantity) ||
    (draft.kind === 'use' && movement.quantityDelta !== -Number(attempt.body.quantity)) ||
    (draft.kind === 'adjust' && movement.balanceAfter !== attempt.body.countedQuantity)
  )
    throw new Error(
      'The server response did not confirm the matching stock movement. Retry the same request to verify its outcome.',
    );
  return detail;
}

export function InventoryPage() {
  const { session } = useSession();
  const admin = session.user?.role === 'admin';
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('item');
  const [draft, setDraft] = useState<InventoryDraft | null>(null);
  const [modal, setModal] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const toast = useToast();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  function start(
    kind: Operation,
    detail: InventoryDetail | null = null,
    lot?: InventoryLot,
    active?: boolean,
  ) {
    if (!admin) return;
    if (!draft) setDraft(newDraft(kind, detail, lot, active));
    setModal(true);
  }
  function complete(detail: InventoryDetail) {
    // The server may finish an already-sent entry after browser navigation.
    // Its result must not navigate the user back into an unmounted workspace.
    if (!mounted.current) return;
    const kind = draft?.kind;
    setDraft(null);
    setModal(false);
    setRefreshKey((value) => value + 1);
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set('item', detail.item.id);
      next.set('view', kind === 'edit' ? 'changes' : 'lots');
      return next;
    });
    toast(
      kind === 'create'
        ? 'Inventory item created.'
        : kind === 'edit'
          ? 'Item changes saved with their history.'
          : 'Stock record saved.',
    );
  }
  return (
    <div className="inventory-workspace">
      {draft && !modal && (
        <div className="notice inventory-pending">
          <div>
            <strong>An inventory entry is unfinished.</strong>
            <p>
              {operationTitle[draft.kind]}
              {draft.detail ? ` · ${draft.detail.item.name}` : ''}. Your entry is retained while
              this page stays open.
            </p>
          </div>
          <button className="button button-secondary" onClick={() => setModal(true)}>
            Resume pending entry
          </button>
        </div>
      )}
      {selectedId ? (
        <InventoryItemDetail
          key={`${selectedId}:${refreshKey}`}
          itemId={selectedId}
          admin={admin}
          draftOpen={!!draft}
          onStart={start}
        />
      ) : (
        <InventoryCatalogue
          key={refreshKey}
          admin={admin}
          draftOpen={!!draft}
          onCreate={() => start('create')}
        />
      )}
      {draft && modal && admin && (
        <InventoryEntryModal
          draft={draft}
          onChange={setDraft}
          onClose={() => setModal(false)}
          onDiscard={() => {
            setModal(false);
            setDraft(null);
          }}
          onSaved={complete}
        />
      )}
    </div>
  );
}

function InventoryCatalogue({
  admin,
  draftOpen,
  onCreate,
}: {
  admin: boolean;
  draftOpen: boolean;
  onCreate: () => void;
}) {
  const [params, setParams] = useSearchParams();
  const active = ['true', 'false', 'all'].includes(params.get('active') ?? '')
    ? params.get('active')!
    : 'true';
  const stock = ['low', 'expired', 'expiring-soon'].includes(params.get('stock') ?? '')
    ? params.get('stock')!
    : '';
  const category = inventoryCategories.includes(params.get('category') as InventoryCategory)
    ? params.get('category')!
    : '';
  const search = params.get('search') ?? '';
  const [query, setQuery] = useState(search);
  useEffect(() => {
    setQuery(search);
  }, [search]);
  const request = new URLSearchParams({
    active,
    ...(stock ? { stock } : {}),
    ...(search ? { search } : {}),
  });
  const resource = useResource<InventoryItem[]>(`/api/inventory/items?${request}`);
  const items = (resource.data ?? []).filter((item) => !category || item.category === category);
  const unavailable = resource.loading || !!resource.error;
  function filter(key: string, value: string) {
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  }
  function openItem(id: string) {
    const next = new URLSearchParams(params);
    next.set('item', id);
    next.set('view', 'lots');
    return `/clinic/inventory?${next}`;
  }
  return (
    <>
      <PageHeader
        eyebrow="CLINIC OPERATIONS"
        title="Inventory"
        description="Recorded supplies, dated lots and a clear history of stock changes."
        actions={
          admin ? (
            <button className="button button-primary" disabled={draftOpen} onClick={onCreate}>
              <Plus size={16} />
              Add inventory item
            </button>
          ) : undefined
        }
      />
      <div className="inventory-intro">
        <Boxes size={26} />
        <div>
          <h2>A record of what is on the shelf</h2>
          <p>
            Track whole stock units and expiry dates. These entries do not dispense medication,
            create invoices or place orders.
          </p>
        </div>
      </div>
      {!admin && (
        <p className="notice">
          You can view inventory and its history. Administrators manage stock entries and item
          details.
        </p>
      )}
      <Card className="inventory-filters">
        <form
          className="inventory-search"
          onSubmit={(event) => {
            event.preventDefault();
            filter('search', query.trim());
          }}
        >
          <Field label="Search inventory">
            <input
              value={query}
              maxLength={150}
              placeholder="Item name or SKU"
              onChange={(event) => setQuery(event.target.value)}
            />
          </Field>
          <button className="button button-secondary">
            <Search size={15} />
            Search catalogue
          </button>
        </form>
        <div className="inventory-filter-row">
          <Field label="Catalogue status">
            <select value={active} onChange={(event) => filter('active', event.target.value)}>
              <option value="true">Active items</option>
              <option value="false">Archived items</option>
              <option value="all">All items</option>
            </select>
          </Field>
          <Field label="Stock attention">
            <select value={stock} onChange={(event) => filter('stock', event.target.value)}>
              <option value="">All stock</option>
              <option value="low">Low stock</option>
              <option value="expired">Expired stock</option>
              <option value="expiring-soon">Expiring within 30 days</option>
            </select>
          </Field>
          <Field label="Inventory category">
            <select value={category} onChange={(event) => filter('category', event.target.value)}>
              <option value="">All categories</option>
              {inventoryCategories.map((value) => (
                <option key={value} value={value}>
                  {categoryNames[value]}
                </option>
              ))}
            </select>
          </Field>
          <button
            className="button button-ghost"
            disabled={resource.loading}
            onClick={resource.reload}
          >
            <RefreshCw size={15} />
            Refresh catalogue
          </button>
        </div>
      </Card>
      <div className="inventory-metrics">
        {[
          ['Matching items', items.length, 'Item count after the current filters.'],
          [
            'Low stock',
            items.filter((item) => item.lowStock).length,
            'Unexpired count is at or below the reorder level.',
          ],
          [
            'Expired stock',
            items.filter((item) => item.expiredQuantity > 0).length,
            'Items with a positive expired lot balance.',
          ],
          [
            'Expiring within 30 days',
            items.filter((item) => item.expiringSoonQuantity > 0).length,
            'Items with dated stock expiring today through day 30.',
          ],
        ].map(([label, value, description]) => (
          <Card key={label}>
            <span>{label}</span>
            <strong>{unavailable ? '—' : value}</strong>
            <p>
              {resource.error
                ? 'Counts unavailable'
                : resource.loading
                  ? 'Loading counts…'
                  : description}
            </p>
          </Card>
        ))}
      </div>
      <Card className="inventory-register">
        {resource.loading ? (
          <Loading />
        ) : resource.error ? (
          <ErrorState message={resource.error} retry={resource.reload} />
        ) : !items.length ? (
          <EmptyState
            title="No inventory items match"
            description={
              search || stock || category || active !== 'true'
                ? 'Adjust the catalogue filters to find another item.'
                : 'New items begin with zero stock. Record a receipt after creating an item.'
            }
            action={
              admin && !draftOpen ? (
                <button className="button button-secondary" onClick={onCreate}>
                  Create first inventory item
                </button>
              ) : undefined
            }
          />
        ) : (
          <div
            className="inventory-table"
            role="region"
            aria-label="Inventory catalogue; scroll horizontally for all columns"
            tabIndex={0}
          >
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col">Stock unit</th>
                  <th scope="col">Unexpired</th>
                  <th scope="col">Expired</th>
                  <th scope="col">Reorder level</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="inventory-catalogue-row">
                    <th scope="row">
                      <Link to={openItem(item.id)} className="table-name">
                        {item.name}
                      </Link>
                      <span className="table-sub">
                        {item.sku} · {categoryNames[item.category]}
                      </span>
                    </th>
                    <td>{unitNames[item.unit]}</td>
                    <td>{item.unexpiredQuantity.toLocaleString('en-IN')}</td>
                    <td>{item.expiredQuantity.toLocaleString('en-IN')}</td>
                    <td>{item.reorderLevel.toLocaleString('en-IN')}</td>
                    <td>
                      <div className="inventory-badges">
                        <Badge tone={item.active ? 'green' : 'neutral'}>
                          {item.active ? 'Active' : 'Archived'}
                        </Badge>
                        {item.lowStock && <Badge tone="amber">Low stock</Badge>}
                        {item.expiringSoonQuantity > 0 && <Badge tone="amber">Expiring soon</Badge>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="inventory-help">
          Unexpired counts include lots with no expiry recorded. Check the product and its expiry
          label before use; the register does not verify suitability. Dates follow Asia/Kolkata.
        </p>
      </Card>
    </>
  );
}

type StartOperation = (
  kind: Operation,
  detail?: InventoryDetail | null,
  lot?: InventoryLot,
  active?: boolean,
) => void;
function InventoryItemDetail({
  itemId,
  admin,
  draftOpen,
  onStart,
}: {
  itemId: string;
  admin: boolean;
  draftOpen: boolean;
  onStart: StartOperation;
}) {
  const resource = useResource<InventoryDetail>(
    `/api/inventory/items/${encodeURIComponent(itemId)}`,
  );
  const [params, setParams] = useSearchParams();
  const view = ['lots', 'movements', 'changes'].includes(params.get('view') ?? '')
    ? params.get('view')!
    : 'lots';
  const back = new URLSearchParams(params);
  back.delete('item');
  back.delete('view');
  if (resource.loading) return <Loading />;
  if (resource.error || !resource.data)
    return (
      <>
        <Link className="back-link" to={`/clinic/inventory?${back}`}>
          <ArrowLeft size={15} />
          Back to catalogue
        </Link>
        <ErrorState
          message={resource.error || 'This inventory item is not available.'}
          retry={resource.reload}
        />
      </>
    );
  const detail = resource.data,
    item = detail.item;
  return (
    <>
      <Link className="back-link" to={`/clinic/inventory?${back}`}>
        <ArrowLeft size={15} />
        Back to catalogue
      </Link>
      <PageHeader
        eyebrow={`${item.sku} · ${categoryNames[item.category]}`}
        title={item.name}
        description={`Stock unit: ${unitNames[item.unit]} · Reorder level: ${quantityText(item.reorderLevel, item.unit)}`}
        actions={
          admin ? (
            <>
              <button
                className="button button-secondary"
                disabled={draftOpen}
                onClick={() => onStart('edit', detail)}
              >
                <Pencil size={15} />
                Edit item
              </button>
              <button
                className="button button-primary"
                disabled={draftOpen || !item.active}
                onClick={() => onStart('receipt', detail)}
              >
                <PackagePlus size={16} />
                Record receipt
              </button>
            </>
          ) : undefined
        }
      />
      <div className="inventory-detail-status">
        <div className="inventory-badges">
          <Badge tone={item.active ? 'green' : 'neutral'}>
            {item.active ? 'Active item' : 'Archived item'}
          </Badge>
          {item.lowStock && <Badge tone="amber">Low stock</Badge>}
        </div>
        <div className="row">
          <button className="button button-ghost button-small" onClick={resource.reload}>
            <RefreshCw size={14} />
            Refresh item
          </button>
          {admin && (
            <button
              className="button button-ghost button-small"
              disabled={draftOpen}
              onClick={() => onStart('edit', detail, undefined, !item.active)}
            >
              <Archive size={14} />
              {item.active ? 'Archive item' : 'Reactivate item'}
            </button>
          )}
        </div>
      </div>
      {!item.active && (
        <p className="notice">
          This item is archived. Its stock and history remain visible. New receipts and use are
          paused; administrators can still record physical counts or reactivate it.
        </p>
      )}
      {!admin && (
        <p className="notice">Stock entries and item changes are managed by administrators.</p>
      )}
      <div className="inventory-metrics">
        {[
          ['Recorded on hand', item.onHandQuantity],
          ['Unexpired or undated', item.unexpiredQuantity],
          ['Expired', item.expiredQuantity],
          ['Expiring within 30 days', item.expiringSoonQuantity],
        ].map(([label, value]) => (
          <Card key={label}>
            <span>{label}</span>
            <strong>{Number(value).toLocaleString('en-IN')}</strong>
            <p>{unitNames[item.unit]} units</p>
          </Card>
        ))}
      </div>
      <p className="inventory-help">
        Unexpired stock includes lots with no expiry recorded and does not verify suitability for
        use. Expiry today is included; expired means before today in Asia/Kolkata.
      </p>
      <div className="inventory-tabs" role="group" aria-label="Inventory item sections">
        {[
          ['lots', 'Lots'],
          ['movements', 'Movement history'],
          ['changes', 'Item history'],
        ].map(([key, label]) => (
          <button
            key={key}
            className={`button ${view === key ? 'button-primary' : 'button-secondary'}`}
            aria-pressed={view === key}
            onClick={() =>
              setParams(
                (previous) => {
                  const next = new URLSearchParams(previous);
                  next.set('view', key);
                  return next;
                },
                { replace: true },
              )
            }
          >
            {label}
          </button>
        ))}
      </div>
      {view === 'lots' && (
        <div className="inventory-lots">
          {detail.lots.length ? (
            detail.lots.map((lot) => (
              <article className="inventory-lot card" key={lot.id}>
                <div className="inventory-lot-heading">
                  <div>
                    <h2>{lotName(lot)}</h2>
                    <span className="inventory-receipt-id" title={`Receipt ID ${lot.id}`}>
                      Receipt {lot.id.slice(-8)}
                    </span>
                    <p className="inventory-help">
                      Received {timestamp(lot.createdAt)} IST · {lot.createdByName}
                    </p>
                  </div>
                  <div className="inventory-badges">
                    <Badge tone={lot.expired ? 'red' : lot.expiresSoon ? 'amber' : 'neutral'}>
                      {lot.expired
                        ? 'Expired'
                        : lot.expiresSoon
                          ? 'Expiring soon'
                          : lot.expiryDate
                            ? 'Dated lot'
                            : 'No expiry recorded'}
                    </Badge>
                    {lot.remainingQuantity === 0 && <Badge>Zero balance</Badge>}
                  </div>
                </div>
                <dl className="inventory-lot-facts">
                  <div>
                    <dt>Remaining</dt>
                    <dd>{quantityText(lot.remainingQuantity, item.unit)}</dd>
                  </div>
                  <div>
                    <dt>Originally received</dt>
                    <dd>{quantityText(lot.receivedQuantity, item.unit)}</dd>
                  </div>
                  <div>
                    <dt>Expiry date</dt>
                    <dd>{lot.expiryDate ? formatDate(lot.expiryDate) : 'No expiry recorded'}</dd>
                  </div>
                </dl>
                {admin && (
                  <div className="inventory-lot-actions">
                    <button
                      className="button button-secondary button-small"
                      disabled={
                        draftOpen || !item.active || lot.expired || lot.remainingQuantity === 0
                      }
                      onClick={() => onStart('use', detail, lot)}
                    >
                      <ArrowUpRight size={15} />
                      Use stock
                    </button>
                    <button
                      className="button button-secondary button-small"
                      disabled={draftOpen}
                      onClick={() => onStart('adjust', detail, lot)}
                    >
                      <ClipboardCheck size={15} />
                      Record physical count
                    </button>
                  </div>
                )}
                {lot.expired && lot.remainingQuantity > 0 && (
                  <p className="inventory-help">
                    Use cannot be recorded for expired stock. A physical count can document stock
                    remaining after disposal or a correction.
                  </p>
                )}
              </article>
            ))
          ) : (
            <Card>
              <EmptyState
                title="No receipts recorded"
                description="Record each receipt as a separate lot. Reusing a lot code creates another receipt record."
                action={
                  admin && item.active && !draftOpen ? (
                    <button
                      className="button button-secondary"
                      onClick={() => onStart('receipt', detail)}
                    >
                      Record first receipt
                    </button>
                  ) : undefined
                }
              />
            </Card>
          )}
        </div>
      )}
      {view === 'movements' && <InventoryMovements detail={detail} />}
      {view === 'changes' && (
        <Card>
          <div className="inventory-section-heading">
            <History size={20} />
            <div>
              <h2>Item history</h2>
              <p className="inventory-help">
                Original creation and later catalogue changes are preserved with their reasons.
                Stock movements appear separately.
              </p>
            </div>
          </div>
          {detail.itemChanges.length ? (
            <ol className="inventory-item-history">
              {detail.itemChanges.map((change) => (
                <li key={change.id}>
                  <div className="inventory-lot-heading">
                    <h3>{change.snapshot.name}</h3>
                    <Badge tone={change.snapshot.active ? 'green' : 'neutral'}>
                      {change.snapshot.active ? 'Active' : 'Archived'}
                    </Badge>
                  </div>
                  <p className="inventory-help">
                    {timestamp(change.createdAt)} IST · {change.createdByName}
                  </p>
                  <p className="inventory-reason">{change.reason}</p>
                  <dl className="inventory-lot-facts">
                    <div>
                      <dt>SKU / unit</dt>
                      <dd>
                        {change.snapshot.sku} · {unitNames[change.snapshot.unit]}
                      </dd>
                    </div>
                    <div>
                      <dt>Category</dt>
                      <dd>{categoryNames[change.snapshot.category]}</dd>
                    </div>
                    <div>
                      <dt>Reorder level</dt>
                      <dd>{quantityText(change.snapshot.reorderLevel, change.snapshot.unit)}</dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ol>
          ) : (
            <EmptyState title="No item changes recorded" />
          )}
        </Card>
      )}
    </>
  );
}

function InventoryMovements({ detail }: { detail: InventoryDetail }) {
  const [rows, setRows] = useState<InventoryMovement[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [moreLoading, setMoreLoading] = useState(false);
  const [error, setError] = useState('');
  const [moreError, setMoreError] = useState('');
  const generation = useRef(0);
  const activeRequest = useRef(false);
  const base = `/api/inventory/items/${encodeURIComponent(detail.item.id)}/movements?limit=25`;
  async function load(more = false) {
    if (activeRequest.current) return;
    activeRequest.current = true;
    const request = ++generation.current;
    if (more) {
      setMoreLoading(true);
      setMoreError('');
    } else {
      setLoading(true);
      setError('');
      setMoreError('');
    }
    try {
      const data = await api<InventoryLedger>(
        `${base}${more && cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      if (request !== generation.current) return;
      setRows((previous) =>
        more
          ? [
              ...previous,
              ...data.items.filter((row) => !previous.some((item) => item.id === row.id)),
            ]
          : data.items,
      );
      setCursor(data.nextCursor);
    } catch (problem) {
      if (request === generation.current) (more ? setMoreError : setError)(errorText(problem));
    } finally {
      if (request === generation.current) {
        activeRequest.current = false;
        setLoading(false);
        setMoreLoading(false);
      }
    }
  }
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
      activeRequest.current = false;
    };
  }, [base]);
  return (
    <Card className="inventory-ledger">
      <div className="inventory-section-heading">
        <div>
          <h2>Movement history</h2>
          <p className="inventory-help">
            Immutable stock entries, newest first. Balance after refers to the specific lot at that
            moment.
          </p>
        </div>
        <button
          className="button button-ghost button-small"
          disabled={loading || moreLoading}
          onClick={() => load()}
        >
          <RefreshCw size={14} />
          Refresh history
        </button>
      </div>
      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorState message={error} retry={() => load()} />
      ) : rows.length ? (
        <>
          <div
            className="inventory-table"
            role="region"
            aria-label="Stock movement history; scroll horizontally for all columns"
            tabIndex={0}
          >
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Recorded</th>
                  <th scope="col">Movement</th>
                  <th scope="col">Lot</th>
                  <th scope="col">Change</th>
                  <th scope="col">Lot balance after</th>
                  <th scope="col">Reason / reference</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((movement) => (
                  <tr key={movement.id} className="inventory-movement">
                    <th scope="row">
                      {timestamp(movement.createdAt)} IST
                      <span className="table-sub">{movement.createdByName}</span>
                    </th>
                    <td>{movementName(movement.type)}</td>
                    <td>
                      {detail.lots.find((lot) => lot.id === movement.lotId)?.lotCode ||
                        'Unlabelled receipt'}
                      <span className="inventory-receipt-id" title={`Receipt ID ${movement.lotId}`}>
                        Receipt {movement.lotId.slice(-8)}
                      </span>
                    </td>
                    <td className="inventory-delta">
                      {movement.quantityDelta > 0 ? '+' : ''}
                      {movement.quantityDelta.toLocaleString('en-IN')}
                    </td>
                    <td>{quantityText(movement.balanceAfter, detail.item.unit)}</td>
                    <td className="inventory-ledger-reason">
                      {movement.reason}
                      {movement.reference && (
                        <span className="table-sub">Reference: {movement.reference}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="inventory-ledger-footer">
            <span>
              {rows.length} movement {rows.length === 1 ? 'record' : 'records'} loaded
            </span>
            {cursor && (
              <button
                className="button button-secondary"
                disabled={moreLoading}
                onClick={() => load(true)}
              >
                {moreLoading
                  ? 'Loading more…'
                  : moreError
                    ? 'Retry loading more'
                    : 'Load more movements'}
              </button>
            )}
          </div>
          {moreError && (
            <p className="notice notice-error" role="alert">
              {moreError} The loaded records remain visible.
            </p>
          )}
        </>
      ) : (
        <EmptyState
          title="No stock movements yet"
          description="Receipts, use and physical counts appear here after they are saved."
        />
      )}
    </Card>
  );
}

function InventoryEntryModal({
  draft,
  onChange,
  onClose,
  onDiscard,
  onSaved,
}: {
  draft: InventoryDraft;
  onChange: (draft: InventoryDraft) => void;
  onClose: () => void;
  onDiscard: () => void;
  onSaved: (detail: InventoryDetail) => void;
}) {
  const [busy, setBusy] = useState(false);
  const values = draft.values,
    item = draft.detail?.item;
  const lot = draft.detail?.lots.find((value) => value.id === draft.lotId);
  const locked = busy || draft.phase !== 'editing';
  const catalogue = draft.kind === 'create' || draft.kind === 'edit';
  const title = operationTitle[draft.kind];
  const unavailableReason =
    draft.phase === 'editing' && item
      ? (draft.kind === 'receipt' || draft.kind === 'use') && !item.active
        ? 'This item is archived. Cancel this draft and reactivate the item before recording a receipt or use.'
        : draft.kind === 'use' && lot?.expired
          ? 'This lot has expired. Stock use cannot be recorded; a physical count can document remaining stock or disposal.'
          : draft.kind === 'use' && lot?.remainingQuantity === 0
            ? 'This lot now has a zero balance. Cancel this draft and choose another lot.'
            : ''
      : '';
  function field<K extends keyof DraftValues>(key: K, value: DraftValues[K]) {
    onChange({ ...draft, values: { ...values, [key]: value } });
  }
  function buildAttempt(): Attempt {
    const common = { requestId: draft.requestId };
    if (catalogue) {
      const name = values.name.trim();
      if (!name) throw new Error('Enter an item name.');
      const reorderLevel = wholeNumber(values.reorderLevel, 'Reorder level', 0, 1_000_000);
      if (draft.kind === 'create') {
        const sku = values.sku.trim().toUpperCase();
        if (!/^[A-Z0-9][A-Z0-9._-]{0,49}$/.test(sku))
          throw new Error(
            'Start the SKU with a letter or digit, followed by up to 49 letters, digits, periods, underscores or hyphens.',
          );
        return {
          path: '/api/inventory/items',
          method: 'POST',
          body: {
            ...common,
            sku,
            name,
            category: values.category,
            unit: values.unit,
            reorderLevel,
          },
        };
      }
      if (!values.reason.trim()) throw new Error('Explain why these item details are changing.');
      return {
        path: `/api/inventory/items/${item!.id}`,
        method: 'PATCH',
        body: {
          ...common,
          name,
          category: values.category,
          reorderLevel,
          active: values.active,
          reason: values.reason.trim(),
          expectedRevision: item!.revision,
        },
      };
    }
    if (!values.reason.trim()) throw new Error('Enter a reason for this stock entry.');
    const body = {
      ...common,
      reason: values.reason.trim(),
      reference: values.reference.trim(),
      expectedRevision: item!.revision,
    };
    if (draft.kind === 'receipt') {
      if (values.expiryDate && !realDate(values.expiryDate))
        throw new Error('Choose a real expiry date, or leave it blank when no expiry is recorded.');
      return {
        path: `/api/inventory/items/${item!.id}/receipts`,
        method: 'POST',
        body: {
          ...body,
          quantity: wholeNumber(values.quantity, 'Quantity received', 1, 1_000_000),
          lotCode: values.lotCode.trim(),
          expiryDate: values.expiryDate || null,
        },
      };
    }
    if (!lot) throw new Error('This stock lot is not available. Reopen the item record.');
    if (draft.kind === 'use')
      return {
        path: `/api/inventory/lots/${lot.id}/use`,
        method: 'POST',
        body: { ...body, quantity: wholeNumber(values.quantity, 'Quantity used', 1, 1_000_000) },
      };
    return {
      path: `/api/inventory/lots/${lot.id}/adjust`,
      method: 'POST',
      body: {
        ...body,
        countedQuantity: wholeNumber(values.quantity, 'Counted quantity', 0, 1_000_000_000),
      },
    };
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || draft.phase === 'conflict' || unavailableReason) return;
    let attempt: Attempt;
    try {
      attempt = draft.attempt ?? buildAttempt();
    } catch (problem) {
      onChange({ ...draft, error: errorText(problem) });
      return;
    }
    const pending = { ...draft, attempt, error: '' };
    onChange(pending);
    setBusy(true);
    try {
      const response = await api<unknown>(attempt.path, {
        method: attempt.method,
        body: attempt.body,
      });
      onSaved(checkedSave(response, draft, attempt));
    } catch (problem) {
      const error = errorText(problem);
      if (problem instanceof ApiError && [400, 422].includes(problem.status))
        onChange({ ...draft, attempt: null, phase: 'editing', error });
      else if (
        problem instanceof ApiError &&
        problem.status === 409 &&
        /request ID was already used/i.test(error)
      )
        onChange({ ...pending, phase: 'uncertain', error });
      else if (problem instanceof ApiError && problem.status === 409)
        onChange({ ...pending, phase: 'conflict', reviewed: null, error });
      else if (problem instanceof ApiError && [403, 404].includes(problem.status))
        onChange({ ...pending, phase: 'conflict', reviewed: null, error });
      else onChange({ ...pending, phase: 'uncertain', error });
    } finally {
      setBusy(false);
    }
  }
  async function refreshStock() {
    if (busy || !item) return;
    setBusy(true);
    try {
      onChange({
        ...draft,
        reviewed: checkedDetail(await api<unknown>(`/api/inventory/items/${item.id}`), item.id),
        error: '',
      });
    } catch (problem) {
      onChange({ ...draft, error: errorText(problem) });
    } finally {
      setBusy(false);
    }
  }
  function acceptReview() {
    if (!draft.reviewed || busy) return;
    onChange({
      ...draft,
      detail: draft.reviewed,
      requestId: crypto.randomUUID(),
      attempt: null,
      phase: 'editing',
      reviewed: null,
      error: '',
    });
  }
  const reviewedLot = draft.reviewed?.lots.find((value) => value.id === draft.lotId);
  const countValid = /^\d+$/.test(values.quantity) && Number.isSafeInteger(Number(values.quantity));
  const countDelta = countValid && lot ? Number(values.quantity) - lot.remainingQuantity : null;
  return (
    <Modal
      title={title}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form className="stack inventory-entry-form" onSubmit={save}>
        {item && (
          <div className="inventory-form-context">
            <strong>{item.name}</strong>
            <span>
              {item.sku} · Whole {unitNames[item.unit].toLowerCase()} units
              {lot ? ` · ${lotName(lot)}` : ''}
            </span>
            {lot && (
              <span title={`Receipt ID ${lot.id}`}>
                Receipt {lot.id.slice(-8)} · Recorded remaining:{' '}
                {quantityText(lot.remainingQuantity, item.unit)}
              </span>
            )}
          </div>
        )}
        {draft.error && (
          <p className="notice notice-error" role="alert">
            {draft.error}
          </p>
        )}
        {unavailableReason && (
          <p className="notice" role="status">
            {unavailableReason}
          </p>
        )}
        {catalogue ? (
          <>
            <div className="inventory-form-grid">
              {draft.kind === 'create' ? (
                <Field
                  label="SKU"
                  hint="Start with a letter or digit. Up to 50 characters; letters, digits, periods, underscores or hyphens. Saved in uppercase."
                >
                  <input
                    required
                    maxLength={50}
                    value={values.sku}
                    disabled={locked}
                    onChange={(event) => field('sku', event.target.value)}
                  />
                </Field>
              ) : (
                <div className="inventory-static-field">
                  <strong>SKU</strong>
                  <span>{item?.sku}</span>
                  <small>SKU and stock unit stay fixed after creation.</small>
                </div>
              )}
              <Field label="Item name">
                <input
                  required
                  maxLength={150}
                  value={values.name}
                  disabled={locked}
                  onChange={(event) => field('name', event.target.value)}
                />
              </Field>
              <Field label="Category">
                <select
                  value={values.category}
                  disabled={locked}
                  onChange={(event) => field('category', event.target.value as InventoryCategory)}
                >
                  {inventoryCategories.map((value) => (
                    <option key={value} value={value}>
                      {categoryNames[value]}
                    </option>
                  ))}
                </select>
              </Field>
              {draft.kind === 'create' ? (
                <Field label="Stock unit">
                  <select
                    value={values.unit}
                    disabled={locked}
                    onChange={(event) => field('unit', event.target.value as InventoryUnit)}
                  >
                    {inventoryUnits.map((unit) => (
                      <option key={unit} value={unit}>
                        {unitNames[unit]}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : (
                <div className="inventory-static-field">
                  <strong>Stock unit</strong>
                  <span>{item && unitNames[item.unit]}</span>
                </div>
              )}
              <Field
                label="Reorder level"
                hint="Low stock means the unexpired count is at or below this level."
              >
                <input
                  type="text"
                  inputMode="numeric"
                  required
                  value={values.reorderLevel}
                  disabled={locked}
                  onChange={(event) => field('reorderLevel', event.target.value)}
                />
              </Field>
            </div>
            {draft.kind === 'edit' && (
              <>
                <label className="checkbox-field">
                  <input
                    type="checkbox"
                    disabled={locked}
                    checked={values.active}
                    onChange={(event) => field('active', event.target.checked)}
                  />
                  Item is active
                </label>
                {!values.active && (
                  <p className="notice">
                    Archiving pauses receipts and use. Existing quantities, physical counts and
                    histories remain available.
                  </p>
                )}
              </>
            )}
            {draft.kind === 'create' && (
              <p className="inventory-help">
                The item starts with zero stock. Record receipts separately; this does not place a
                supplier order.
              </p>
            )}
          </>
        ) : (
          <>
            <Field
              label={
                draft.kind === 'receipt'
                  ? 'Quantity received'
                  : draft.kind === 'use'
                    ? 'Quantity used'
                    : 'Counted quantity'
              }
              hint={
                draft.kind === 'adjust'
                  ? 'The total physically present in this specific lot, including zero. This is not an amount to add or subtract.'
                  : 'Whole stock units only. Fractions are not rounded.'
              }
            >
              <input
                type="text"
                inputMode="numeric"
                required
                value={values.quantity}
                disabled={locked}
                onChange={(event) => field('quantity', event.target.value)}
              />
            </Field>
            {draft.kind === 'receipt' && (
              <>
                <div className="inventory-form-grid">
                  <Field
                    label="Lot code"
                    hint="Optional. Each receipt creates a separate lot, even with the same code."
                  >
                    <input
                      maxLength={100}
                      value={values.lotCode}
                      disabled={locked}
                      onChange={(event) => field('lotCode', event.target.value)}
                    />
                  </Field>
                  <Field
                    label="Expiry date"
                    hint="Leave blank if no expiry is recorded; this does not verify suitability."
                  >
                    <input
                      type="date"
                      value={values.expiryDate}
                      disabled={locked}
                      onChange={(event) => field('expiryDate', event.target.value)}
                    />
                  </Field>
                </div>
                <p className="inventory-help">
                  You may record stock that is already expired. It is counted as expired and cannot
                  be recorded as used.
                </p>
              </>
            )}
            {draft.kind === 'use' && (
              <p className="inventory-help">
                Records stock used from this lot. It does not dispense medicine or create a patient
                charge.
              </p>
            )}
            {draft.kind === 'adjust' && (
              <div className="notice inventory-count-preview">
                <strong>Physical count adjustment</strong>
                <p>
                  {countDelta === null || !item
                    ? 'Enter the whole quantity counted in this lot.'
                    : `Recorded ${lot!.remainingQuantity.toLocaleString('en-IN')} → counted ${Number(values.quantity).toLocaleString('en-IN')} ${item.unit === 'box' ? 'boxes' : `${item.unit}s`}. Change: ${countDelta > 0 ? '+' : ''}${countDelta.toLocaleString('en-IN')}.`}
                </p>
                <p>
                  Previous movements remain unchanged. Explain the count difference, correction or
                  disposal below.
                </p>
              </div>
            )}
          </>
        )}
        {draft.kind !== 'create' && (
          <Field
            label="Reason"
            hint={
              draft.kind === 'edit'
                ? 'Explain the catalogue change or archive/reactivation.'
                : 'Explain the receipt, use, correction or disposal.'
            }
          >
            <textarea
              rows={3}
              required
              maxLength={1000}
              value={values.reason}
              disabled={locked}
              onChange={(event) => field('reason', event.target.value)}
            />
          </Field>
        )}
        {!catalogue && (
          <Field label="Reference" hint="Optional delivery, stock or internal reference.">
            <input
              maxLength={200}
              value={values.reference}
              disabled={locked}
              onChange={(event) => field('reference', event.target.value)}
            />
          </Field>
        )}
        {draft.phase === 'uncertain' && (
          <div className="notice inventory-retry">
            <strong>The save outcome could not be confirmed.</strong>
            <p>
              The exact submitted entry and request ID are preserved. Retry the same request to
              check the outcome without recording it twice. Fields stay locked until that is
              resolved.
            </p>
          </div>
        )}
        {draft.phase === 'conflict' && (
          <div className="notice inventory-conflict">
            <strong>Review this entry before trying again.</strong>
            <p>
              Your draft is preserved. Stock or item details may have changed since you opened it.
            </p>
            {item ? (
              draft.reviewed ? (
                <>
                  <p>
                    Latest item status:{' '}
                    <strong>{draft.reviewed.item.active ? 'Active' : 'Archived'}</strong>. Recorded
                    on hand:{' '}
                    {quantityText(draft.reviewed.item.onHandQuantity, draft.reviewed.item.unit)}.
                  </p>
                  {reviewedLot && (
                    <p>
                      Latest lot balance:{' '}
                      <strong>
                        {quantityText(reviewedLot.remainingQuantity, draft.reviewed.item.unit)}
                      </strong>
                      {reviewedLot.expired ? ' · Expired' : ''}.
                    </p>
                  )}
                  {draft.kind === 'edit' && (
                    <dl className="inventory-review-values">
                      <div>
                        <dt>Latest item name</dt>
                        <dd>{draft.reviewed.item.name}</dd>
                      </div>
                      <div>
                        <dt>Latest category</dt>
                        <dd>{categoryNames[draft.reviewed.item.category]}</dd>
                      </div>
                      <div>
                        <dt>Latest reorder level</dt>
                        <dd>{draft.reviewed.item.reorderLevel}</dd>
                      </div>
                    </dl>
                  )}
                  <p>
                    Review these values, then keep your draft to prepare a new request. Nothing
                    changes until you save again.
                  </p>
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={busy}
                    onClick={acceptReview}
                  >
                    I reviewed the latest stock; keep my draft
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={busy}
                  onClick={refreshStock}
                >
                  Refresh stock for review
                </button>
              )
            ) : (
              <>
                <p>
                  Review the item details, including its unique SKU, before making another creation
                  request.
                </p>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={busy}
                  onClick={() =>
                    onChange({
                      ...draft,
                      requestId: crypto.randomUUID(),
                      attempt: null,
                      phase: 'editing',
                      error: '',
                    })
                  }
                >
                  Review item details
                </button>
              </>
            )}
          </div>
        )}
        <div className="inventory-modal-actions">
          <button
            type="button"
            className="button button-secondary"
            disabled={busy}
            onClick={onClose}
          >
            Close for now
          </button>
          {draft.phase === 'editing' && !draft.attempt && (
            <button
              type="button"
              className="button button-ghost"
              disabled={busy}
              onClick={onDiscard}
            >
              Cancel draft
            </button>
          )}
          <button
            className="button button-primary"
            disabled={busy || draft.phase === 'conflict' || !!unavailableReason}
          >
            {busy
              ? 'Saving…'
              : draft.phase === 'uncertain'
                ? 'Retry same request'
                : saveTitle[draft.kind]}
          </button>
        </div>
      </form>
    </Modal>
  );
}
