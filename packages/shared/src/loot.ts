import { GAME } from './constants.js';
import { LOOT_CATALOG, type LootCatalogEntry } from './loot-table.js';

/**
 * Loot helpers shared by the authoritative match service and the Phaser client.
 * The tunable data itself — item list, counts, and spawn odds — lives in
 * `loot-table.ts`; the per-match draw lives in `loot-spawn.ts`.
 */

/** A candidate position on the map. A match fills only a random subset of these. */
export interface LootSpawnLocation {
  id: string;
  x: number;
  y: number;
}

/**
 * One drawn item at one location. `id` is the location id, so it is unique even
 * though the same `catalogId` appears many times in a match. Catalog ids are
 * runtime data drawn from the loot table, so this stays a plain string; use
 * {@link lootCatalogEntry} to resolve one and fail loudly on a bad id.
 */
export interface LootSpawnPoint extends LootSpawnLocation {
  catalogId: string;
}

export type CartId = `cart-${number}`;

export function findLootCatalogEntry(catalogId: string): LootCatalogEntry | undefined {
  return LOOT_CATALOG.find((candidate) => candidate.id === catalogId);
}

export function lootCatalogEntry(catalogId: string): LootCatalogEntry {
  const entry = findLootCatalogEntry(catalogId);
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
