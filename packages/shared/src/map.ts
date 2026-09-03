import { GAME } from './constants.js';
import type { CartId, LootSpawnLocation } from './loot.js';
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
 * The 80 candidate loot positions, as `[x, y]` pairs. Every one sits in an open
 * aisle: clear of the shelf rectangles above, clear of the cart footprints, and
 * clear of the player start positions. A match places {@link LOOT_SPAWN_TABLE}
 * `itemsPerMatch` items on a random subset of them, so most stay empty.
 *
 * Edit the pairs freely; ids are derived from the index and are not persisted.
 */
const lootLocationCoordinates = [
  // Top aisle, above the first shelf row.
  [150, 165], [250, 165], [350, 165], [450, 165], [550, 165], [650, 165], [750, 165], [850, 165],
  [950, 165], [1_050, 165], [1_150, 165], [1_250, 165], [1_350, 165], [1_450, 165], [1_550, 165], [1_650, 165],
  // Aisle between shelf rows 1 and 2.
  [150, 370], [250, 370], [350, 370], [450, 370], [550, 370], [650, 370], [750, 370], [850, 370],
  [950, 370], [1_050, 370], [1_150, 370], [1_250, 370], [1_350, 370], [1_450, 370], [1_550, 370], [1_650, 370],
  // Aisle between shelf rows 2 and 3. The four centre columns are left clear
  // so nothing spawns on top of the player start cluster.
  [150, 590], [250, 590], [350, 590], [450, 590], [550, 590], [650, 590], [1_150, 590], [1_250, 590],
  [1_350, 590], [1_450, 590], [1_550, 590], [1_650, 590],
  // Open floor below the last shelf row.
  [150, 800], [250, 800], [350, 800], [450, 800], [550, 800], [650, 800], [750, 800], [850, 800],
  [950, 800], [1_050, 800], [1_150, 800], [1_250, 800], [1_350, 800], [1_450, 800], [1_550, 800], [1_650, 800],
  // Back aisle, above the carts.
  [150, 940], [250, 940], [350, 940], [450, 940], [550, 940], [650, 940], [750, 940], [850, 940],
  [950, 940], [1_050, 940], [1_150, 940], [1_250, 940], [1_350, 940], [1_450, 940], [1_550, 940], [1_650, 940],
  // Side corridors, level with the shelf rows.
  [60, 260], [60, 700], [1_740, 260], [1_740, 700],
] as const;

/**
 * Server-authoritative loot positions. The match service draws its item set
 * across these; the Phaser map re-exports them purely as map data. Which of
 * them actually hold an item is decided per match and arrives over the loot
 * sync, so the client never assumes a location is occupied.
 */
export const GROCERY_STORE_LOOT_LOCATIONS: readonly LootSpawnLocation[] =
  lootLocationCoordinates.map(([x, y], index) => ({
    id: `loot-spot-${String(index + 1).padStart(2, '0')}`,
    x,
    y,
  }));

/** Slot-indexed cart ownership. Cart `slot` always equals the owning room slot. */
export const GROCERY_STORE_CARTS: readonly CartDefinition[] = [
  { id: 'cart-0', slot: 0, label: 'Cart 1', x: 250, y: 1_060, width: 128, height: 72 },
  { id: 'cart-1', slot: 1, label: 'Cart 2', x: 650, y: 1_060, width: 128, height: 72 },
  { id: 'cart-2', slot: 2, label: 'Cart 3', x: 1_150, y: 1_060, width: 128, height: 72 },
  { id: 'cart-3', slot: 3, label: 'Cart 4', x: 1_550, y: 1_060, width: 128, height: 72 },
] as const;

export const STORE_CENTRAL_SPAWN = { id: 'spawn-central', x: 900, y: 600 } as const;

/**
 * Cart footprints as collision. Walking over a cart stays deliberately allowed
 * so depositing never feels fiddly; only knockback treats them as solid.
 */
export const GROCERY_STORE_CART_COLLISION: readonly CollisionRectangle[] = GROCERY_STORE_CARTS.map((cart) => ({
  id: `${cart.id}-collision`,
  x: cart.x,
  y: cart.y,
  width: cart.width,
  height: cart.height,
}));

/** Everything a shove must not push a player through or into. */
export const SHOVE_OBSTACLES: readonly CollisionRectangle[] = [
  ...GROCERY_STORE_COLLISION,
  ...GROCERY_STORE_CART_COLLISION,
];
