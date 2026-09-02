import { GAME } from './constants.js';

/**
 * Presentation-neutral loot data. The authoritative match service generates its
 * item set from this catalog; the Phaser client uses the same entries only to
 * label and colour markers. The local prototype resolver that used to live here
 * was replaced in Step 8 by server-owned availability and cart decisions.
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

export function lootCatalogEntry(catalogId: string): LootCatalogEntry {
  const entry = LOOT_CATALOG.find((candidate) => candidate.id === catalogId);
  if (!entry) throw new Error(`Unknown loot catalog id: ${catalogId}`);
  return entry;
}

/** Cart ownership is derived from the stable room slot, never from a client claim. */
export function assignedCartIdForSlot(slot: number): CartId {
  if (!Number.isInteger(slot) || slot < 0 || slot >= GAME.maxPlayers) {
    throw new Error(`Cart assignment requires a slot between 0 and ${GAME.maxPlayers - 1}`);
  }
  return `cart-${slot}`;
}

export function cartSlotFromId(cartId: string): number | null {
  const match = /^cart-(\d+)$/.exec(cartId);
  if (!match?.[1]) return null;
  const slot = Number(match[1]);
  return slot >= 0 && slot < GAME.maxPlayers ? slot : null;
}

export function isAssignedCart(cartId: string, slot: number): boolean {
  return cartSlotFromId(cartId) === slot;
}

/** Stable, human-readable cart name shared by the HUD, prompts, and rejections. */
export function cartLabel(cartId: string): string {
  const slot = cartSlotFromId(cartId);
  return slot === null ? 'an unknown cart' : `Cart ${slot + 1}`;
}
