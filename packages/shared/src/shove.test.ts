import { describe, expect, it } from 'vitest';
import { GAME, SHOVE } from './constants.js';
import {
  GROCERY_STORE_CARTS,
  GROCERY_STORE_COLLISION,
  SHOVE_OBSTACLES,
} from './map.js';
import { distanceBetween, isValidPlayerPosition, isWithinFacingCone, sweepKnockback } from './rules.js';

const EAST = { x: 1, y: 0 };
const OPEN_FLOOR = { x: 900, y: 550 };

/** Directly below the first shelf column, with clear floor between the two. */
const BELOW_SHELF = { x: 300, y: 550 };
const SHELF = GROCERY_STORE_COLLISION.find((rectangle) => rectangle.x === 300 && rectangle.y === 480)!;
const CART = GROCERY_STORE_CARTS[0]!;

describe('shove facing cone', () => {
  it('accepts a target dead ahead and refuses one behind', () => {
    expect(isWithinFacingCone(OPEN_FLOOR, EAST, { x: 960, y: 550 })).toBe(true);
    expect(isWithinFacingCone(OPEN_FLOOR, EAST, { x: 840, y: 550 })).toBe(false);
  });

  it('holds the configured half-angle on both sides', () => {
    const radians = (degrees: number) => (degrees * Math.PI) / 180;
    const at = (degrees: number) => ({
      x: OPEN_FLOOR.x + Math.cos(radians(degrees)) * 60,
      y: OPEN_FLOOR.y + Math.sin(radians(degrees)) * 60,
    });
    const half = SHOVE.coneHalfAngleDegrees;
    expect(isWithinFacingCone(OPEN_FLOOR, EAST, at(half - 1))).toBe(true);
    expect(isWithinFacingCone(OPEN_FLOOR, EAST, at(-(half - 1)))).toBe(true);
    expect(isWithinFacingCone(OPEN_FLOOR, EAST, at(half + 1))).toBe(false);
    expect(isWithinFacingCone(OPEN_FLOOR, EAST, at(-(half + 1)))).toBe(false);
  });

  it('refuses a degenerate facing or a target underfoot', () => {
    expect(isWithinFacingCone(OPEN_FLOOR, { x: 0, y: 0 }, { x: 960, y: 550 })).toBe(false);
    expect(isWithinFacingCone(OPEN_FLOOR, EAST, OPEN_FLOOR)).toBe(false);
    expect(isWithinFacingCone(OPEN_FLOOR, EAST, { x: Number.NaN, y: 550 })).toBe(false);
  });
});

describe('shove knockback sweep', () => {
  it('travels the full push across open floor', () => {
    const landed = sweepKnockback(OPEN_FLOOR, EAST, SHOVE.knockbackPixels);
    expect(distanceBetween(OPEN_FLOOR, landed)).toBeCloseTo(SHOVE.knockbackPixels);
    expect(isValidPlayerPosition(landed)).toBe(true);
  });

  it('stops short of a shelf instead of tunnelling through it', () => {
    const landed = sweepKnockback(BELOW_SHELF, { x: 0, y: -1 }, SHOVE.knockbackPixels);
    expect(distanceBetween(BELOW_SHELF, landed)).toBeLessThan(SHOVE.knockbackPixels);
    expect(landed.y).toBeGreaterThan(SHELF.y + SHELF.height / 2);
    expect(isValidPlayerPosition(landed)).toBe(true);
  });

  it('stops at the map boundary', () => {
    const landed = sweepKnockback({ x: 900, y: 40 }, { x: 0, y: -1 }, SHOVE.knockbackPixels);
    expect(landed.y).toBeGreaterThanOrEqual(GAME.playerCollisionRadiusPixels);
    expect(isValidPlayerPosition(landed)).toBe(true);
  });

  /** Carts block knockback even though walking over them stays allowed. */
  it('stops before a cart footprint that plain movement would cross', () => {
    const above = { x: CART.x, y: CART.y - 80 };
    const blocked = sweepKnockback(above, { x: 0, y: 1 }, SHOVE.knockbackPixels);
    expect(blocked.y).toBeLessThan(CART.y - CART.height / 2);
    expect(isValidPlayerPosition(blocked, SHOVE_OBSTACLES)).toBe(true);

    // The same push with only shelf collision would have pushed straight into it.
    const throughCart = sweepKnockback(above, { x: 0, y: 1 }, SHOVE.knockbackPixels, GROCERY_STORE_COLLISION);
    expect(throughCart.y).toBeGreaterThan(CART.y - CART.height / 2);
  });

  it('pushes a player who is already standing in a cart back out of it', () => {
    const inCart = { x: CART.x, y: CART.y };
    const landed = sweepKnockback(inCart, EAST, SHOVE.knockbackPixels);
    expect(landed.x).toBeGreaterThan(CART.x + CART.width / 2);
    expect(isValidPlayerPosition(landed)).toBe(true);
  });

  it('never moves a player on a degenerate push', () => {
    expect(sweepKnockback(OPEN_FLOOR, { x: 0, y: 0 }, SHOVE.knockbackPixels)).toEqual(OPEN_FLOOR);
    expect(sweepKnockback(OPEN_FLOOR, EAST, 0)).toEqual(OPEN_FLOOR);
    expect(sweepKnockback(OPEN_FLOOR, EAST, Number.NaN)).toEqual(OPEN_FLOOR);
  });

  it('always lands somewhere legal, from every direction and every shelf edge', () => {
    const directions = Array.from({ length: 16 }, (_, index) => {
      const angle = (index / 16) * Math.PI * 2;
      return { x: Math.cos(angle), y: Math.sin(angle) };
    });
    for (const shelf of GROCERY_STORE_COLLISION) {
      const beside = { x: shelf.x, y: shelf.y + shelf.height / 2 + GAME.playerCollisionRadiusPixels + 1 };
      if (!isValidPlayerPosition(beside)) continue;
      for (const direction of directions) {
        const landed = sweepKnockback(beside, direction, SHOVE.knockbackPixels);
        expect(isValidPlayerPosition(landed)).toBe(true);
        expect(distanceBetween(beside, landed)).toBeLessThanOrEqual(SHOVE.knockbackPixels + 1e-9);
      }
    }
  });
});
