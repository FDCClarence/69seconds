import {
  GAME,
  type CartPublicState,
  type InteractionResult,
  type LootSync,
  type LootUpdate,
  type Vector2,
} from '@69-seconds/shared';

export interface LootViewItem {
  id: string;
  catalogId: string;
  position: Vector2;
  available: boolean;
}

/** One optimistically claimed pickup, held until its acknowledgement arrives. */
export interface PendingPickup {
  requestId: string;
  itemId: string;
}

export interface LootView {
  /** Highest authoritative sequence applied; lower ones are stale and ignored. */
  sequence: number;
  synchronized: boolean;
  items: Readonly<Record<string, LootViewItem>>;
  carts: readonly CartPublicState[];
  carriedItemIds: readonly string[];
  carriedCounts: Readonly<Record<string, number>>;
  pendingPickups: readonly PendingPickup[];
}

export function createLootView(): LootView {
  return {
    sequence: -1,
    synchronized: false,
    items: {},
    carts: [],
    carriedItemIds: [],
    carriedCounts: {},
    pendingPickups: [],
  };
}

/**
 * A full authoritative replacement. Predictions are discarded because the sync
 * already reflects every decision the server has committed, which is exactly
 * what makes reconnection safe.
 */
export function applyLootSync(view: LootView, sync: LootSync): LootView {
  if (sync.sequence < view.sequence) return view;
  return {
    sequence: sync.sequence,
    synchronized: true,
    items: Object.fromEntries(sync.items.map((item) => [item.id, {
      id: item.id,
      catalogId: item.catalogId,
      position: item.position,
      available: item.available,
    }])),
    carts: sync.carts,
    carriedItemIds: sync.carriedItemIds,
    carriedCounts: Object.fromEntries(sync.carriedCounts.map((entry) => [entry.playerId, entry.count])),
    pendingPickups: [],
  };
}

export function applyLootUpdate(view: LootView, update: LootUpdate): LootView {
  if (!view.synchronized || update.sequence < view.sequence) return view;
  const next: LootView = { ...view, sequence: update.sequence };
  next.carriedCounts = { ...view.carriedCounts, [update.playerId]: update.carriedCount };

  if (update.type === 'PICKED_UP') {
    next.items = setAvailability(view.items, [update.itemId], false);
    // A confirmed pickup by anyone settles our own prediction for that item.
    next.pendingPickups = view.pendingPickups.filter((pending) => pending.itemId !== update.itemId);
    return next;
  }
  if (update.type === 'RESTOCKED') {
    next.items = setAvailability(view.items, update.itemIds, true);
    return next;
  }
  next.carts = view.carts.map((cart) => cart.id === update.cartId
    ? { ...cart, itemIds: [...cart.itemIds, ...update.itemIds] }
    : cart);
  return next;
}

/** Hides the marker immediately; `applyInteractionResult` confirms or restores it. */
export function predictPickup(view: LootView, requestId: string, itemId: string): LootView {
  if (!isItemVisible(view, itemId)) return view;
  if (predictedCarriedItemIds(view).length >= GAME.maxCarriedItems) return view;
  return { ...view, pendingPickups: [...view.pendingPickups, { requestId, itemId }] };
}

export function applyInteractionResult(view: LootView, result: InteractionResult): LootView {
  const pendingPickups = view.pendingPickups.filter((pending) => pending.requestId !== result.requestId);
  const next: LootView = { ...view, pendingPickups, carriedItemIds: result.carriedItemIds };

  if (result.outcome === 'PICKED_UP') {
    next.items = setAvailability(view.items, [result.itemId], false);
    return next;
  }
  if (result.outcome === 'DEPOSITED') {
    next.carts = view.carts.map((cart) => cart.id === result.cartId
      ? { ...cart, itemIds: [...cart.itemIds, ...result.itemIds] }
      : cart);
    return next;
  }
  // Rejected: dropping the pending entry restores the marker and the carry slot.
  return next;
}

/** Clears a prediction whose acknowledgement never arrived. */
export function rollbackPickup(view: LootView, requestId: string): LootView {
  return { ...view, pendingPickups: view.pendingPickups.filter((pending) => pending.requestId !== requestId) };
}

export function isItemVisible(view: LootView, itemId: string): boolean {
  const item = view.items[itemId];
  if (!item?.available) return false;
  return !view.pendingPickups.some((pending) => pending.itemId === itemId);
}

export function visibleItems(view: LootView): readonly LootViewItem[] {
  return Object.values(view.items).filter((item) => isItemVisible(view, item.id));
}

/** Authoritative hands plus predicted pickups, which is what the HUD renders. */
export function predictedCarriedItemIds(view: LootView): readonly string[] {
  const predicted = view.pendingPickups
    .map((pending) => pending.itemId)
    .filter((itemId) => !view.carriedItemIds.includes(itemId));
  return [...view.carriedItemIds, ...predicted].slice(0, GAME.maxCarriedItems);
}

export function cartById(view: LootView, cartId: string): CartPublicState | undefined {
  return view.carts.find((cart) => cart.id === cartId);
}

function setAvailability(
  items: Readonly<Record<string, LootViewItem>>,
  itemIds: readonly string[],
  available: boolean,
): Readonly<Record<string, LootViewItem>> {
  const next = { ...items };
  for (const itemId of itemIds) {
    const item = next[itemId];
    if (item) next[itemId] = { ...item, available };
  }
  return next;
}
