import { GAME } from './constants.js';

/**
 * This is presentation-neutral game data. The local Phaser prototype consumes
 * it today; the authoritative match service will consume the same catalog and
 * rules when networked loot is introduced.
 */
export interface LootCatalogEntry {
  id: string;
  label: string;
  shortLabel: string;
  color: number;
}

export const LOOT_CATALOG = [
  { id: 'apples', label: 'Apples', shortLabel: 'APL', color: 0xe85f50 },
  { id: 'bread', label: 'Bread', shortLabel: 'BRD', color: 0xeebd62 },
  { id: 'milk', label: 'Milk', shortLabel: 'MLK', color: 0x83c6dc },
  { id: 'beans', label: 'Beans', shortLabel: 'BNS', color: 0x8ea96c },
  { id: 'pasta', label: 'Pasta', shortLabel: 'PST', color: 0xe69446 },
  { id: 'tea', label: 'Tea', shortLabel: 'TEA', color: 0x6d966b },
  { id: 'soap', label: 'Soap', shortLabel: 'SOP', color: 0x937cbd },
  { id: 'rice', label: 'Rice', shortLabel: 'RIC', color: 0xd8d2bd },
  { id: 'eggs', label: 'Eggs', shortLabel: 'EGG', color: 0xf4e7a4 },
  { id: 'juice', label: 'Juice', shortLabel: 'JCE', color: 0xf08d45 },
  { id: 'coffee', label: 'Coffee', shortLabel: 'COF', color: 0x93684e },
  { id: 'tomatoes', label: 'Tomatoes', shortLabel: 'TOM', color: 0xd95548 },
] as const satisfies readonly LootCatalogEntry[];

export type LootCatalogId = (typeof LOOT_CATALOG)[number]['id'];
export type CartId = `cart-${number}`;

export interface LootSpawnPoint {
  id: string;
  catalogId: LootCatalogId;
  x: number;
  y: number;
}

export interface LocalLootItemState {
  id: string;
  catalogId: LootCatalogId;
  available: boolean;
}

export interface LocalLootState {
  assignedCartId: CartId;
  loot: readonly LocalLootItemState[];
  carriedItemIds: readonly string[];
  depositedItemIds: readonly string[];
}

/** Intents deliberately contain no claimed result, so a future server can acknowledge them. */
export type LootCommand =
  | { type: 'PICK_UP'; itemId: string }
  | { type: 'DEPOSIT'; cartId: CartId }
  | { type: 'NO_TARGET' };

export type LootCommandResult =
  | { type: 'PICKUP_SUCCEEDED'; itemId: string }
  | { type: 'DEPOSIT_SUCCEEDED'; itemIds: readonly string[] }
  | { type: 'HANDS_FULL' }
  | { type: 'ITEM_UNAVAILABLE' }
  | { type: 'INVALID_CART'; cartId: CartId }
  | { type: 'CART_EMPTY' }
  | { type: 'NO_NEARBY_TARGET' };

export interface LootCommandResolution {
  state: LocalLootState;
  result: LootCommandResult;
}

export function lootCatalogEntry(catalogId: LootCatalogId): LootCatalogEntry {
  const entry = LOOT_CATALOG.find((candidate) => candidate.id === catalogId);
  if (!entry) throw new Error(`Unknown loot catalog id: ${catalogId}`);
  return entry;
}

export function createLocalLootState(
  assignedCartId: CartId,
  spawnPoints: readonly LootSpawnPoint[],
): LocalLootState {
  return {
    assignedCartId,
    loot: spawnPoints.map(({ id, catalogId }) => ({ id, catalogId, available: true })),
    carriedItemIds: [],
    depositedItemIds: [],
  };
}

export function resolveLootCommand(state: LocalLootState, command: LootCommand): LootCommandResolution {
  if (command.type === 'NO_TARGET') return { state, result: { type: 'NO_NEARBY_TARGET' } };

  if (command.type === 'DEPOSIT') {
    if (command.cartId !== state.assignedCartId) return { state, result: { type: 'INVALID_CART', cartId: command.cartId } };
    if (state.carriedItemIds.length === 0) return { state, result: { type: 'CART_EMPTY' } };
    return {
      state: {
        ...state,
        carriedItemIds: [],
        depositedItemIds: [...state.depositedItemIds, ...state.carriedItemIds],
      },
      result: { type: 'DEPOSIT_SUCCEEDED', itemIds: state.carriedItemIds },
    };
  }

  const item = state.loot.find((candidate) => candidate.id === command.itemId);
  if (!item?.available) return { state, result: { type: 'ITEM_UNAVAILABLE' } };
  if (state.carriedItemIds.length >= GAME.maxCarriedItems) return { state, result: { type: 'HANDS_FULL' } };

  return {
    state: {
      ...state,
      loot: state.loot.map((candidate) => candidate.id === item.id ? { ...candidate, available: false } : candidate),
      carriedItemIds: [...state.carriedItemIds, item.id],
    },
    result: { type: 'PICKUP_SUCCEEDED', itemId: item.id },
  };
}
