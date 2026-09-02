import { GAME } from './constants.js';
import type { Vector2 } from './schemas.js';

export interface CollisionRectangle {
  id: string;
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
