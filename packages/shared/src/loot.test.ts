import { describe, expect, it } from 'vitest';
import {
  GAME,
  createLocalLootState,
  resolveLootCommand,
  type LocalLootState,
  type LootSpawnPoint,
} from './index.js';

const spawnPoints: readonly LootSpawnPoint[] = [
  { id: 'loot-apples', catalogId: 'apples', x: 0, y: 0 },
  { id: 'loot-bread', catalogId: 'bread', x: 0, y: 0 },
  { id: 'loot-milk', catalogId: 'milk', x: 0, y: 0 },
  { id: 'loot-beans', catalogId: 'beans', x: 0, y: 0 },
  { id: 'loot-pasta', catalogId: 'pasta', x: 0, y: 0 },
];

function stateWithCarry(itemIds: readonly string[]): LocalLootState {
  return { ...createLocalLootState('cart-0', spawnPoints), carriedItemIds: itemIds };
}

describe('local loot rules', () => {
  it('claims an available item and removes it from the world state', () => {
    const resolution = resolveLootCommand(createLocalLootState('cart-0', spawnPoints), { type: 'PICK_UP', itemId: 'loot-apples' });
    expect(resolution.result).toEqual({ type: 'PICKUP_SUCCEEDED', itemId: 'loot-apples' });
    expect(resolution.state.carriedItemIds).toEqual(['loot-apples']);
    expect(resolution.state.loot.find((item) => item.id === 'loot-apples')?.available).toBe(false);
  });

  it('enforces the four-item carry limit without changing state', () => {
    const resolution = resolveLootCommand(
      stateWithCarry(spawnPoints.slice(0, GAME.maxCarriedItems).map((point) => point.id)),
      { type: 'PICK_UP', itemId: 'loot-pasta' },
    );
    expect(resolution.result).toEqual({ type: 'HANDS_FULL' });
    expect(resolution.state.carriedItemIds).toHaveLength(GAME.maxCarriedItems);
    expect(resolution.state.loot.find((item) => item.id === 'loot-pasta')?.available).toBe(true);
  });

  it('only deposits all held items into the assigned cart', () => {
    const held = ['loot-apples', 'loot-bread'];
    const invalid = resolveLootCommand(stateWithCarry(held), { type: 'DEPOSIT', cartId: 'cart-1' });
    expect(invalid.result).toEqual({ type: 'INVALID_CART', cartId: 'cart-1' });
    expect(invalid.state.carriedItemIds).toEqual(held);

    const deposited = resolveLootCommand(stateWithCarry(held), { type: 'DEPOSIT', cartId: 'cart-0' });
    expect(deposited.result).toEqual({ type: 'DEPOSIT_SUCCEEDED', itemIds: held });
    expect(deposited.state.carriedItemIds).toEqual([]);
    expect(deposited.state.depositedItemIds).toEqual(held);
  });

  it('reports empty carts and missing targets without inventing a result', () => {
    expect(resolveLootCommand(createLocalLootState('cart-0', spawnPoints), { type: 'DEPOSIT', cartId: 'cart-0' }).result)
      .toEqual({ type: 'CART_EMPTY' });
    expect(resolveLootCommand(createLocalLootState('cart-0', spawnPoints), { type: 'NO_TARGET' }).result)
      .toEqual({ type: 'NO_NEARBY_TARGET' });
  });
});
