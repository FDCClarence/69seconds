import { describe, expect, it } from 'vitest';
import {
  GAME,
  GROCERY_STORE_CARTS,
  GROCERY_STORE_LOOT_SPAWNS,
  LOOT,
  assignedCartIdForSlot,
  cartLabel,
  cartSlotFromId,
  hasLineOfAccess,
  isAssignedCart,
  isWithinInteractionRadius,
  lootCatalogEntry,
} from './index.js';

describe('shared loot and cart rules', () => {
  it('derives cart ownership from the stable room slot only', () => {
    expect(assignedCartIdForSlot(0)).toBe('cart-0');
    expect(assignedCartIdForSlot(GAME.maxPlayers - 1)).toBe(`cart-${GAME.maxPlayers - 1}`);
    expect(() => assignedCartIdForSlot(GAME.maxPlayers)).toThrow();
    expect(() => assignedCartIdForSlot(-1)).toThrow();
    expect(isAssignedCart('cart-2', 2)).toBe(true);
    expect(isAssignedCart('cart-2', 1)).toBe(false);
    expect(cartSlotFromId('cart-9')).toBeNull();
    expect(cartSlotFromId('trolley-0')).toBeNull();
    expect(cartLabel('cart-3')).toBe('Cart 4');
  });

  it('publishes one server-readable spawn per catalog entry and one cart per player', () => {
    expect(GROCERY_STORE_LOOT_SPAWNS).toHaveLength(12);
    expect(GROCERY_STORE_CARTS).toHaveLength(GAME.maxPlayers);
    expect(new Set(GROCERY_STORE_LOOT_SPAWNS.map((spawn) => spawn.id)).size)
      .toBe(GROCERY_STORE_LOOT_SPAWNS.length);
    for (const spawn of GROCERY_STORE_LOOT_SPAWNS) {
      expect(lootCatalogEntry(spawn.catalogId).id).toBe(spawn.catalogId);
    }
    for (const [index, cart] of GROCERY_STORE_CARTS.entries()) {
      expect(cart.id).toBe(assignedCartIdForSlot(index));
      expect(cart.slot).toBe(index);
    }
  });

  it('measures interaction reach inclusively and rejects non-finite positions', () => {
    const origin = { x: 100, y: 100 };
    const radius = LOOT.itemInteractionRadiusPixels;
    expect(isWithinInteractionRadius(origin, { x: 100 + radius, y: 100 }, radius)).toBe(true);
    expect(isWithinInteractionRadius(origin, { x: 100 + radius + 0.5, y: 100 }, radius)).toBe(false);
    expect(isWithinInteractionRadius(origin, { x: Number.NaN, y: 100 }, radius)).toBe(false);
    expect(isWithinInteractionRadius({ x: Number.POSITIVE_INFINITY, y: 0 }, origin, radius)).toBe(false);
  });

  it('blocks reaching through a shelf but allows reaching along an open aisle', () => {
    // The first shelf is centred at (300, 260) and spans 260x72 pixels.
    expect(hasLineOfAccess({ x: 300, y: 200 }, { x: 300, y: 320 })).toBe(false);
    expect(hasLineOfAccess({ x: 300, y: 200 }, { x: 300, y: 220 })).toBe(true);
    expect(hasLineOfAccess({ x: 150, y: 175 }, { x: 150, y: 230 })).toBe(true);
    expect(hasLineOfAccess({ x: 900, y: 600 }, { x: 900, y: 700 })).toBe(true);
  });
});
