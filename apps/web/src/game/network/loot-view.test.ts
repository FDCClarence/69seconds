import { GAME, type InteractionResult, type LootSync, type LootUpdate } from '@69-seconds/shared';
import { describe, expect, it } from 'vitest';
import {
  applyInteractionResult,
  applyLootSync,
  applyLootUpdate,
  cartById,
  createLootView,
  isItemVisible,
  lastCarriedItemId,
  predictPickup,
  predictedCarriedItemIds,
  predictedSlotsUsed,
  rollbackPickup,
  visibleItems,
} from './loot-view.js';

const REQUEST_ID = '00000000-0000-4000-8000-000000000001';

function sync(overrides: Partial<LootSync> = {}): LootSync {
  return {
    sequence: 0,
    roomCode: 'ABC234',
    items: [
      { id: 'loot-soup', catalogId: 'canned-soup', position: { x: 900, y: 600 }, available: true },
      { id: 'loot-water', catalogId: 'bottled-water', position: { x: 910, y: 600 }, available: true },
      { id: 'loot-map', catalogId: 'map', position: { x: 920, y: 600 }, available: false },
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
    expect(visibleItems(view).map((item) => item.id)).toEqual(['loot-soup', 'loot-water']);
    expect(view.carriedCounts['player-1']).toBe(1);
    expect(cartById(view, 'cart-0')?.ownerPlayerId).toBe('player-0');
  });

  it('hides a predicted pickup immediately and confirms it on acknowledgement', () => {
    const predicted = predictPickup(applyLootSync(createLootView(), sync()), REQUEST_ID, 'loot-soup');
    expect(isItemVisible(predicted, 'loot-soup')).toBe(false);
    expect(predictedCarriedItemIds(predicted)).toEqual(['loot-soup']);

    const confirmed = applyInteractionResult(predicted, {
      outcome: 'PICKED_UP',
      requestId: REQUEST_ID,
      itemId: 'loot-soup',
      catalogId: 'canned-soup',
      carriedItemIds: ['loot-soup'],
    });
    expect(confirmed.pendingPickups).toEqual([]);
    expect(confirmed.carriedItemIds).toEqual(['loot-soup']);
    expect(isItemVisible(confirmed, 'loot-soup')).toBe(false);
  });

  it('rolls the marker and the carry slot back when the server refuses', () => {
    const predicted = predictPickup(applyLootSync(createLootView(), sync()), REQUEST_ID, 'loot-soup');
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
    expect(isItemVisible(rolledBack, 'loot-soup')).toBe(true);
  });

  it('rolls back a prediction whose acknowledgement never arrives', () => {
    const predicted = predictPickup(applyLootSync(createLootView(), sync()), REQUEST_ID, 'loot-soup');
    const abandoned = rollbackPickup(predicted, REQUEST_ID);
    expect(abandoned.pendingPickups).toEqual([]);
    expect(isItemVisible(abandoned, 'loot-soup')).toBe(true);
  });

  it('refuses to predict an unavailable item or a fifth carry slot', () => {
    const view = applyLootSync(createLootView(), sync({
      carriedItemIds: ['loot-a', 'loot-b', 'loot-c', 'loot-d'],
    }));
    expect(predictPickup(view, REQUEST_ID, 'loot-map').pendingPickups).toEqual([]);
    expect(predictPickup(view, REQUEST_ID, 'loot-soup').pendingPickups).toEqual([]);
    expect(predictedCarriedItemIds(view)).toHaveLength(GAME.maxCarriedItems);
  });

  it('removes an item another player won and settles our competing prediction', () => {
    const predicted = predictPickup(applyLootSync(createLootView(), sync()), REQUEST_ID, 'loot-soup');
    const lost = applyLootUpdate(predicted, pickedUpBy('player-1', 'loot-soup', 1, 2));

    expect(lost.items['loot-soup']?.available).toBe(false);
    expect(lost.pendingPickups).toEqual([]);
    expect(isItemVisible(lost, 'loot-soup')).toBe(false);
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
      itemIds: ['loot-soup', 'loot-water'],
      cartItemCount: 2,
      carriedCount: 0,
    });
    expect(cartById(deposited, 'cart-0')?.itemIds).toEqual(['loot-soup', 'loot-water']);

    const restocked = applyLootUpdate(deposited, {
      type: 'RESTOCKED',
      sequence: 2,
      roomCode: 'ABC234',
      playerId: 'player-1',
      itemIds: ['loot-map'],
      carriedCount: 0,
    });
    expect(restocked.items['loot-map']?.available).toBe(true);
    expect(isItemVisible(restocked, 'loot-map')).toBe(true);
  });

  it('does not duplicate a deposit received through both its acknowledgement and broadcast', () => {
    const view = applyLootSync(createLootView(), sync());
    const result: InteractionResult = {
      outcome: 'DEPOSITED',
      requestId: REQUEST_ID,
      cartId: 'cart-0',
      itemIds: ['loot-soup', 'loot-water'],
      cartItemCount: 2,
      carriedItemIds: [],
    };
    const acknowledged = applyInteractionResult(view, result);
    const broadcast: LootUpdate = {
      type: 'DEPOSITED',
      sequence: 1,
      roomCode: 'ABC234',
      playerId: 'player-0',
      cartId: 'cart-0',
      itemIds: ['loot-soup', 'loot-water'],
      cartItemCount: 2,
      carriedCount: 0,
    };
    const updated = applyLootUpdate(acknowledged, broadcast);
    const duplicate = applyLootUpdate(updated, broadcast);

    expect(cartById(updated, 'cart-0')?.itemIds).toEqual(['loot-soup', 'loot-water']);
    expect(duplicate).toBe(updated);
  });

  it('ignores stale updates and stale syncs', () => {
    const view = applyLootUpdate(applyLootSync(createLootView(), sync({ sequence: 5 })), pickedUpBy('player-1', 'loot-soup', 2));
    expect(view.items['loot-soup']?.available).toBe(true);
    expect(view.sequence).toBe(5);

    const stale = applyLootSync(view, sync({ sequence: 1, items: [] }));
    expect(stale).toBe(view);
  });

  it('discards predictions on a resynchronization, because the server state is complete', () => {
    const predicted = predictPickup(applyLootSync(createLootView(), sync()), REQUEST_ID, 'loot-soup');
    const resynchronized = applyLootSync(predicted, sync({ sequence: 9, carriedItemIds: ['loot-water'] }));
    expect(resynchronized.pendingPickups).toEqual([]);
    expect(resynchronized.carriedItemIds).toEqual(['loot-water']);
    expect(isItemVisible(resynchronized, 'loot-soup')).toBe(true);
  });

  it('does not apply broadcasts received before the first synchronization', () => {
    const view = applyLootUpdate(createLootView(), pickedUpBy('player-1', 'loot-soup', 0));
    expect(view.synchronized).toBe(false);
    expect(view.items).toEqual({});
  });
});

describe('client view of carried people', () => {
  const PERSON = { id: 'npc-maya', catalogId: 'maya', position: { x: 905, y: 600 }, available: true };

  function peopledSync(overrides: Partial<LootSync> = {}): LootSync {
    const base = sync();
    return { ...base, items: [...base.items, PERSON], ...overrides };
  }

  it('counts a carried person as every slot, not as one item', () => {
    const view = applyLootSync(createLootView(), peopledSync({ carriedItemIds: ['npc-maya'] }));

    expect(predictedCarriedItemIds(view)).toEqual(['npc-maya']);
    expect(predictedSlotsUsed(view)).toBe(GAME.maxCarriedItems);
  });

  it('predicts carrying a person only out of empty hands', () => {
    const empty = applyLootSync(createLootView(), peopledSync());
    expect(predictedSlotsUsed(predictPickup(empty, REQUEST_ID, 'npc-maya'))).toBe(GAME.maxCarriedItems);

    const holding = applyLootSync(createLootView(), peopledSync({ carriedItemIds: ['loot-soup'] }));
    const refused = predictPickup(holding, REQUEST_ID, 'npc-maya');
    expect(refused).toBe(holding);
    expect(predictedSlotsUsed(refused)).toBe(1);
  });

  it('predicts no further pickup while carrying a person', () => {
    const carrying = applyLootSync(createLootView(), peopledSync({ carriedItemIds: ['npc-maya'] }));
    expect(predictPickup(carrying, REQUEST_ID, 'loot-soup')).toBe(carrying);
  });

  it('names the last thing picked up as the one a drop releases', () => {
    const empty = applyLootSync(createLootView(), peopledSync());
    expect(lastCarriedItemId(empty)).toBeUndefined();

    const two = applyLootSync(createLootView(), peopledSync({ carriedItemIds: ['loot-soup', 'loot-water'] }));
    expect(lastCarriedItemId(two)).toBe('loot-water');
  });

  it('treats an unknown catalog id as a single slot rather than free space', () => {
    const stale = applyLootSync(createLootView(), peopledSync({
      items: [{ id: 'loot-ghost', catalogId: 'from-a-newer-table', position: { x: 900, y: 600 }, available: false }],
      carriedItemIds: ['loot-ghost'],
    }));
    expect(predictedSlotsUsed(stale)).toBe(1);
  });
});

describe('client view of a dropped carryable', () => {
  const dropped = (sequence: number, itemId: string, carriedCount: number): LootUpdate => ({
    type: 'DROPPED',
    sequence,
    roomCode: 'ABC234',
    playerId: 'player-1',
    itemId,
    position: { x: 880, y: 640 },
    carriedCount,
  });

  it('makes a rival\'s dropped item visible again, at its new spot', () => {
    const carried = applyLootUpdate(
      applyLootSync(createLootView(), sync()),
      pickedUpBy('player-1', 'loot-soup', 1),
    );
    expect(isItemVisible(carried, 'loot-soup')).toBe(false);

    const view = applyLootUpdate(carried, dropped(2, 'loot-soup', 0));
    expect(isItemVisible(view, 'loot-soup')).toBe(true);
    expect(view.items['loot-soup']?.position).toEqual({ x: 880, y: 640 });
    expect(view.carriedCounts['player-1']).toBe(0);
  });

  it('applies our own acknowledged drop to hands and to the floor', () => {
    const carrying = applyLootSync(createLootView(), sync({ carriedItemIds: ['loot-soup', 'loot-water'] }));
    const result: InteractionResult = {
      outcome: 'DROPPED',
      requestId: REQUEST_ID,
      itemId: 'loot-water',
      catalogId: 'bottled-water',
      position: { x: 880, y: 640 },
      carriedItemIds: ['loot-soup'],
    };
    const view = applyInteractionResult(carrying, result);

    expect(predictedCarriedItemIds(view)).toEqual(['loot-soup']);
    expect(view.items['loot-water']).toMatchObject({ available: true, position: { x: 880, y: 640 } });
    expect(isItemVisible(view, 'loot-water')).toBe(true);
  });

  it('ignores a stale drop that arrives behind the sequence', () => {
    const view = applyLootSync(createLootView(), sync({ sequence: 5 }));
    expect(applyLootUpdate(view, dropped(4, 'loot-soup', 0))).toBe(view);
  });
});
