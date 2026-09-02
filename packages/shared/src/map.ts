import { GAME } from './constants.js';
import type { CartId, LootSpawnPoint } from './loot.js';
import type { Vector2 } from './schemas.js';

export interface CollisionRectangle {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CartDefinition {
  id: CartId;
  slot: number;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const shelfCenters = [
  [300, 260], [600, 260], [1_200, 260], [1_500, 260],
  [300, 480], [600, 480], [1_200, 480], [1_500, 480],
  [300, 700], [600, 700], [1_200, 700], [1_500, 700],
] as const;

/** Collision data consumed by both the authoritative server and Phaser presentation. */
export const GROCERY_STORE_COLLISION: readonly CollisionRectangle[] = shelfCenters.map(
  ([x, y], index) => ({
    id: `shelf-collision-${index + 1}`,
    x,
    y,
    width: 260,
    height: 72,
  }),
);

/** Slot-indexed, collision-safe start positions with more than two player diameters separation. */
export const PLAYER_SPAWN_POSITIONS: readonly Vector2[] = [
  { x: 840, y: 550 },
  { x: 960, y: 550 },
  { x: 840, y: 650 },
  { x: 960, y: 650 },
] as const;

export const GROCERY_STORE_BOUNDS = {
  width: GAME.mapWidthPixels,
  height: GAME.mapHeightPixels,
} as const;

/**
 * Server-authoritative loot placement. The match service generates its item set
 * from this list and validates interaction distance against it; the Phaser map
 * re-exports the same data purely to draw markers in the right places.
 */
export const GROCERY_STORE_LOOT_SPAWNS: readonly LootSpawnPoint[] = [
  { id: 'loot-apples', catalogId: 'apples', x: 150, y: 175 },
  { id: 'loot-bread', catalogId: 'bread', x: 510, y: 175 },
  { id: 'loot-milk', catalogId: 'milk', x: 1_290, y: 175 },
  { id: 'loot-beans', catalogId: 'beans', x: 1_650, y: 175 },
  { id: 'loot-pasta', catalogId: 'pasta', x: 150, y: 390 },
  { id: 'loot-tea', catalogId: 'tea', x: 510, y: 390 },
  { id: 'loot-soap', catalogId: 'soap', x: 1_290, y: 390 },
  { id: 'loot-rice', catalogId: 'rice', x: 1_650, y: 390 },
  { id: 'loot-eggs', catalogId: 'eggs', x: 150, y: 880 },
  { id: 'loot-juice', catalogId: 'juice', x: 510, y: 880 },
  { id: 'loot-coffee', catalogId: 'coffee', x: 1_290, y: 880 },
  { id: 'loot-tomatoes', catalogId: 'tomatoes', x: 1_650, y: 880 },
] as const;

/** Slot-indexed cart ownership. Cart `slot` always equals the owning room slot. */
export const GROCERY_STORE_CARTS: readonly CartDefinition[] = [
  { id: 'cart-0', slot: 0, label: 'Cart 1', x: 250, y: 1_060, width: 128, height: 72 },
  { id: 'cart-1', slot: 1, label: 'Cart 2', x: 650, y: 1_060, width: 128, height: 72 },
  { id: 'cart-2', slot: 2, label: 'Cart 3', x: 1_150, y: 1_060, width: 128, height: 72 },
  { id: 'cart-3', slot: 3, label: 'Cart 4', x: 1_550, y: 1_060, width: 128, height: 72 },
] as const;

export const STORE_CENTRAL_SPAWN = { id: 'spawn-central', x: 900, y: 600 } as const;
