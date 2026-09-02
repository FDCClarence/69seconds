import { GAME, type InteractionResult, type LootSync, type LootUpdate } from '@69-seconds/shared';
import { describe, expect, it } from 'vitest';
import {
  applyInteractionResult,
  applyLootSync,
  applyLootUpdate,
  cartById,
  createLootView,
  isItemVisible,
  predictPickup,
  predictedCarriedItemIds,
  rollbackPickup,
  visibleItems,
} from './loot-view.js';

const REQUEST_ID = '00000000-0000-4000-8000-000000000001';

function sync(overrides: Partial<LootSync> = {}): LootSync {
  return {
    sequence: 0,
    roomCode: 'ABC234',
    items: [
      { id: 'loot-apples', catalogId: 'apples', position: { x: 900, y: 600 }, available: true },
      { id: 'loot-bread', catalogId: 'bread', position: { x: 910, y: 600 }, available: true },
      { id: 'loot-milk', catalogId: 'milk', position: { x: 920, y: 600 }, available: false },
    ],
    carts: [{ id: 'cart-0', slot: 0, ownerPlayerId: 'player-0', itemIds: [] }],
    carriedCounts: [{ playerId: 'player-0', count: 0 }, { playerId: 'player-1', count: 1 }],
    carriedItemIds: [],
    ...overrides,
  };
}

function pickedUpBy(playerId: string, itemId: string, sequence: number, carriedCount = 1): LootUpdate {
  return { type: 'PICKED_UP', sequence, roomCode: 'ABC234', playerId, itemId, carriedCount };
}

describe('client loot view', () => {
  it('starts unsynchronized and takes the server state wholesale', () => {
    const empty = createLootView();
    expect(empty.synchronized).toBe(false);
    expect(visibleItems(empty)).toEqual([]);

    const view = applyLootSync(empty, sync());
    expect(view.synchronized).toBe(true);
    expect(visibleItems(view).map((item) => item.id)).toEqual(['loot-apples', 'loot-bread']);
    expect(view.carriedCounts['player-1']).toBe(1);
    expect(cartById(view, 'cart-0')?.ownerPlayerId).toBe('player-0');
  });

  it('hides a predicted pickup immediately and confirms it on acknowledgement', () => {
    const predicted = predictPickup(applyLootSync(createLootView(), sync()), REQUEST_ID, 'loot-apples');
    expect(isItemVisible(predicted, 'loot-apples')).toBe(false);
    expect(predictedCarriedItemIds(predicted)).toEqual(['loot-apples']);

    const confirmed = applyInteractionResult(predicted, {
      outcome: 'PICKED_UP',
      requestId: REQUEST_ID,
      itemId: 'loot-apples',
      catalogId: 'apples',
      carriedItemIds: ['loot-apples'],
    });
    expect(confirmed.pendingPickups).toEqual([]);
    expect(confirmed.carriedItemIds).toEqual(['loot-apples']);
    expect(isItemVisible(confirmed, 'loot-apples')).toBe(false);
  });

  it('rolls the marker and the carry slot back when the server refuses', () => {
    const predicted = predictPickup(applyLootSync(createLootView(), sync()), REQUEST_ID, 'loot-apples');
    const rejected: InteractionResult = {
      outcome: 'REJECTED',
      requestId: REQUEST_ID,
      reason: 'ITEM_UNAVAILABLE',
      message: 'That item is no longer available',
      carriedItemIds: [],
    };
    const rolledBack = applyInteractionResult(predicted, rejected);

    expect(rolledBack.pendingPickups).toEqual([]);
    expect(rolledBack.carriedItemIds).toEqual([]);
    expect(predictedCarriedItemIds(rolledBack)).toEqual([]);
    expect(isItemVisible(rolledBack, 'loot-apples')).toBe(true);
  });

  it('rolls back a prediction whose acknowledgement never arrives', () => {
    const predicted = predictPickup(applyLootSync(createLootView(), sync()), REQUEST_ID, 'loot-apples');
    const abandoned = rollbackPickup(predicted, REQUEST_ID);
    expect(abandoned.pendingPickups).toEqual([]);
    expect(isItemVisible(abandoned, 'loot-apples')).toBe(true);
  });

  it('refuses to predict an unavailable item or a fifth carry slot', () => {
    const view = applyLootSync(createLootView(), sync({
      carriedItemIds: ['loot-a', 'loot-b', 'loot-c', 'loot-d'],
    }));
    expect(predictPickup(view, REQUEST_ID, 'loot-milk').pendingPickups).toEqual([]);
    expect(predictPickup(view, REQUEST_ID, 'loot-apples').pendingPickups).toEqual([]);
    expect(predictedCarriedItemIds(view)).toHaveLength(GAME.maxCarriedItems);
  });

  it('removes an item another player won and settles our competing prediction', () => {
    const predicted = predictPickup(applyLootSync(createLootView(), sync()), REQUEST_ID, 'loot-apples');
    const lost = applyLootUpdate(predicted, pickedUpBy('player-1', 'loot-apples', 1, 2));

    expect(lost.items['loot-apples']?.available).toBe(false);
    expect(lost.pendingPickups).toEqual([]);
    expect(isItemVisible(lost, 'loot-apples')).toBe(false);
    expect(lost.carriedCounts['player-1']).toBe(2);
  });

  it('adds deposited items to the cart and restores restocked shelves', () => {
    const view = applyLootSync(createLootView(), sync());
    const deposited = applyLootUpdate(view, {
      type: 'DEPOSITED',
      sequence: 1,
      roomCode: 'ABC234',
      playerId: 'player-0',
      cartId: 'cart-0',
      itemIds: ['loot-apples', 'loot-bread'],
      cartItemCount: 2,
      carriedCount: 0,
    });
    expect(cartById(deposited, 'cart-0')?.itemIds).toEqual(['loot-apples', 'loot-bread']);

    const restocked = applyLootUpdate(deposited, {
      type: 'RESTOCKED',
      sequence: 2,
      roomCode: 'ABC234',
      playerId: 'player-1',
      itemIds: ['loot-milk'],
      carriedCount: 0,
    });
    expect(restocked.items['loot-milk']?.available).toBe(true);
    expect(isItemVisible(restocked, 'loot-milk')).toBe(true);
  });

  it('ignores stale updates and stale syncs', () => {
    const view = applyLootUpdate(applyLootSync(createLootView(), sync({ sequence: 5 })), pickedUpBy('player-1', 'loot-apples', 2));
    expect(view.items['loot-apples']?.available).toBe(true);
    expect(view.sequence).toBe(5);

    const stale = applyLootSync(view, sync({ sequence: 1, items: [] }));
    expect(stale).toBe(view);
  });

  it('discards predictions on a resynchronization, because the server state is complete', () => {
    const predicted = predictPickup(applyLootSync(createLootView(), sync()), REQUEST_ID, 'loot-apples');
    const resynchronized = applyLootSync(predicted, sync({ sequence: 9, carriedItemIds: ['loot-bread'] }));
    expect(resynchronized.pendingPickups).toEqual([]);
    expect(resynchronized.carriedItemIds).toEqual(['loot-bread']);
    expect(isItemVisible(resynchronized, 'loot-apples')).toBe(true);
  });

  it('does not apply broadcasts received before the first synchronization', () => {
    const view = applyLootUpdate(createLootView(), pickedUpBy('player-1', 'loot-apples', 0));
    expect(view.synchronized).toBe(false);
    expect(view.items).toEqual({});
  });
});
