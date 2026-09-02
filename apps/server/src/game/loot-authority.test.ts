import {
  GAME,
  GROCERY_STORE_CARTS,
  GROCERY_STORE_LOOT_SPAWNS,
  LOOT,
  type CartId,
  type InteractionRequest,
  type InteractionResult,
  type Vector2,
} from '@69-seconds/shared';
import { describe, expect, it } from 'vitest';
import { MatchLootAuthority, type InteractionContext } from './loot-authority.js';

const CART = GROCERY_STORE_CARTS[0]!;
const OTHER_CART = GROCERY_STORE_CARTS[1]!;

/** Four spawns in the open central floor so geometry never confuses a rule test. */
const spawns = [
  { id: 'loot-apples', catalogId: 'apples', x: 900, y: 600 },
  { id: 'loot-bread', catalogId: 'bread', x: 910, y: 600 },
  { id: 'loot-milk', catalogId: 'milk', x: 920, y: 600 },
  { id: 'loot-beans', catalogId: 'beans', x: 930, y: 600 },
  { id: 'loot-pasta', catalogId: 'pasta', x: 940, y: 600 },
] as const;

let nextRequest = 0;
function request(action: InteractionRequest['action'], targetId?: string): InteractionRequest {
  nextRequest += 1;
  return {
    requestId: `00000000-0000-4000-8000-${String(nextRequest).padStart(12, '0')}`,
    action,
    ...(targetId ? { targetId } : {}),
  };
}

function authority(playerCount = 2): MatchLootAuthority {
  return new MatchLootAuthority(
    'ABC234',
    Array.from({ length: playerCount }, (_, slot) => ({ id: `player-${slot}`, slot })),
    { spawns },
  );
}

function context(overrides: Partial<InteractionContext> & Pick<InteractionContext, 'request'>): InteractionContext {
  return {
    playerId: 'player-0',
    position: { x: 900, y: 600 },
    phase: 'LOOTING',
    phaseEndsAtMs: 100_000,
    serverNowMs: 1_000,
    ...overrides,
  };
}

function reasonOf(result: InteractionResult): string {
  return result.outcome === 'REJECTED' ? result.reason : result.outcome;
}

function cartPosition(cart: { x: number; y: number }): Vector2 {
  return { x: cart.x, y: cart.y };
}

describe('authoritative loot collection', () => {
  it('gives a contested item to exactly one of two simultaneous claimants', () => {
    const loot = authority();
    const contested = request('PICK_UP', 'loot-apples');
    const rival = request('PICK_UP', 'loot-apples');

    const first = loot.resolve(context({ playerId: 'player-0', request: contested }));
    const second = loot.resolve(context({ playerId: 'player-1', request: rival }));

    expect(reasonOf(first.result)).toBe('PICKED_UP');
    expect(reasonOf(second.result)).toBe('ITEM_UNAVAILABLE');
    expect(loot.carriedItemIds('player-0')).toEqual(['loot-apples']);
    expect(loot.carriedItemIds('player-1')).toEqual([]);
    expect(first.update?.type).toBe('PICKED_UP');
    expect(second.update).toBeNull();
  });

  it('never lets four players duplicate one item, whatever the arrival order', () => {
    const loot = authority(GAME.maxPlayers);
    const results = Array.from({ length: GAME.maxPlayers }, (_, slot) => loot.resolve(context({
      playerId: `player-${slot}`,
      request: request('PICK_UP', 'loot-milk'),
    })));

    expect(results.filter((resolution) => resolution.result.outcome === 'PICKED_UP')).toHaveLength(1);
    expect(results.filter((resolution) => resolution.update !== null)).toHaveLength(1);
    const holders = Array.from({ length: GAME.maxPlayers }, (_, slot) => loot.carriedItemIds(`player-${slot}`))
      .filter((carried) => carried.includes('loot-milk'));
    expect(holders).toHaveLength(1);
  });

  it('enforces carry capacity that a modified client cannot exceed', () => {
    const loot = authority();
    for (const spawn of spawns.slice(0, GAME.maxCarriedItems)) {
      // Tokens refill over time, so advance the clock between deliberate presses.
      expect(reasonOf(loot.resolve(context({
        request: request('PICK_UP', spawn.id),
        serverNowMs: 1_000,
      })).result)).toBe('PICKED_UP');
    }
    const overflow = loot.resolve(context({ request: request('PICK_UP', 'loot-pasta') }));
    expect(reasonOf(overflow.result)).toBe('HANDS_FULL');
    expect(overflow.update).toBeNull();
    expect(loot.carriedItemIds('player-0')).toHaveLength(GAME.maxCarriedItems);
  });

  it('rejects a claim on an item or cart the player is nowhere near', () => {
    const loot = authority();
    const farItem = loot.resolve(context({
      position: { x: 200, y: 900 },
      request: request('PICK_UP', 'loot-apples'),
    }));
    expect(reasonOf(farItem.result)).toBe('OUT_OF_RANGE');

    const farCart = loot.resolve(context({
      position: { x: 900, y: 600 },
      request: request('DROP_OFF', CART.id),
    }));
    expect(reasonOf(farCart.result)).toBe('OUT_OF_RANGE');

    const unknown = loot.resolve(context({ request: request('PICK_UP', 'loot-does-not-exist') }));
    expect(reasonOf(unknown.result)).toBe('UNKNOWN_TARGET');
  });

  /**
   * Defence in depth for future map data. The current 72-pixel shelves are
   * thicker than the 64-pixel item reach, so the production geometry cannot
   * produce this rejection; a thin partition can.
   */
  it('refuses to reach through a partition inside the interaction radius', () => {
    const loot = new MatchLootAuthority('ABC234', [{ id: 'player-0', slot: 0 }], {
      spawns: [{ id: 'loot-apples', catalogId: 'apples', x: 900, y: 630 }],
      collision: [{ id: 'partition', x: 900, y: 615, width: 400, height: 8 }],
    });
    const blocked = loot.resolve(context({
      position: { x: 900, y: 600 },
      request: request('PICK_UP', 'loot-apples'),
    }));
    expect(reasonOf(blocked.result)).toBe('NO_LINE_OF_ACCESS');

    const alongside = loot.resolve(context({
      position: { x: 900, y: 625 },
      request: request('PICK_UP', 'loot-apples'),
    }));
    expect(reasonOf(alongside.result)).toBe('PICKED_UP');
  });

  it('only accepts deposits into the assigned cart and only when carrying something', () => {
    const loot = authority();
    loot.resolve(context({ request: request('PICK_UP', 'loot-apples') }));

    const wrongCart = loot.resolve(context({
      position: cartPosition(OTHER_CART),
      request: request('DROP_OFF', OTHER_CART.id),
    }));
    expect(reasonOf(wrongCart.result)).toBe('NOT_YOUR_CART');
    expect(loot.carriedItemIds('player-0')).toEqual(['loot-apples']);

    const deposited = loot.resolve(context({
      position: cartPosition(CART),
      request: request('DROP_OFF', CART.id),
    }));
    expect(deposited.result).toMatchObject({ outcome: 'DEPOSITED', itemIds: ['loot-apples'], cartItemCount: 1 });
    expect(loot.carriedItemIds('player-0')).toEqual([]);
    expect(loot.cartItemIds(CART.id)).toEqual(['loot-apples']);

    const empty = loot.resolve(context({
      position: cartPosition(CART),
      request: request('DROP_OFF', CART.id),
    }));
    expect(reasonOf(empty.result)).toBe('NOTHING_CARRIED');
  });

  it('cannot pick up a deposited item a second time', () => {
    const loot = authority();
    loot.resolve(context({ request: request('PICK_UP', 'loot-apples') }));
    loot.resolve(context({ position: cartPosition(CART), request: request('DROP_OFF', CART.id) }));
    const relooted = loot.resolve(context({ request: request('PICK_UP', 'loot-apples') }));
    expect(reasonOf(relooted.result)).toBe('ITEM_UNAVAILABLE');
  });

  it('replays a duplicate request ID instead of applying it twice', () => {
    const loot = authority();
    const pickup = request('PICK_UP', 'loot-apples');
    const first = loot.resolve(context({ request: pickup }));
    const duplicate = loot.resolve(context({ request: pickup }));

    expect(duplicate.replayed).toBe(true);
    expect(duplicate.result).toEqual(first.result);
    expect(duplicate.update).toBeNull();
    expect(loot.carriedItemIds('player-0')).toEqual(['loot-apples']);
  });

  it('replays a duplicate deposit without emptying the hands twice', () => {
    const loot = authority();
    loot.resolve(context({ request: request('PICK_UP', 'loot-apples') }));
    const deposit = request('DROP_OFF', CART.id);
    const first = loot.resolve(context({ position: cartPosition(CART), request: deposit }));
    loot.resolve(context({ request: request('PICK_UP', 'loot-bread') }));
    const duplicate = loot.resolve(context({ position: cartPosition(CART), request: deposit }));

    expect(duplicate.result).toEqual(first.result);
    expect(duplicate.update).toBeNull();
    expect(loot.cartItemIds(CART.id)).toEqual(['loot-apples']);
    expect(loot.carriedItemIds('player-0')).toEqual(['loot-bread']);
  });

  it('closes interactions outside the looting phase and past the deadline', () => {
    const loot = authority();
    expect(reasonOf(loot.resolve(context({
      phase: 'COUNTDOWN',
      request: request('PICK_UP', 'loot-apples'),
    })).result)).toBe('INVALID_PHASE');
    expect(reasonOf(loot.resolve(context({
      serverNowMs: 100_000,
      request: request('PICK_UP', 'loot-apples'),
    })).result)).toBe('INVALID_PHASE');
    expect(reasonOf(loot.resolve(context({
      phase: 'TALLY',
      request: request('PICK_UP', 'loot-apples'),
    })).result)).toBe('INVALID_PHASE');
    expect(loot.carriedItemIds('player-0')).toEqual([]);
  });

  it('rate limits a spamming client without blocking ordinary play', () => {
    const loot = authority();
    const burst = Array.from({ length: LOOT.interactionBurstCapacity + 4 }, () => loot.resolve(context({
      request: request('PICK_UP', 'loot-apples'),
      serverNowMs: 1_000,
    })));
    const limited = burst.filter((resolution) => reasonOf(resolution.result) === 'RATE_LIMITED');
    expect(limited.length).toBeGreaterThan(0);
    expect(burst.length - limited.length).toBeLessThanOrEqual(LOOT.interactionBurstCapacity);

    // One second later the bucket has refilled, so a legitimate press succeeds again.
    const afterRefill = loot.resolve(context({
      request: request('PICK_UP', 'loot-bread'),
      serverNowMs: 2_000,
    }));
    expect(reasonOf(afterRefill.result)).toBe('PICKED_UP');
  });

  it('restores the world and private inventory for a reconnecting player', () => {
    const loot = authority();
    loot.resolve(context({ request: request('PICK_UP', 'loot-apples') }));
    loot.resolve(context({ request: request('PICK_UP', 'loot-bread'), serverNowMs: 1_100 }));
    loot.resolve(context({
      playerId: 'player-1',
      request: request('PICK_UP', 'loot-milk'),
    }));

    const mine = loot.syncFor('player-0');
    expect(mine.carriedItemIds).toEqual(['loot-apples', 'loot-bread']);
    expect(mine.items.filter((item) => item.available).map((item) => item.id))
      .toEqual(['loot-beans', 'loot-pasta']);
    expect(mine.carriedCounts).toEqual([
      { playerId: 'player-0', count: 2 },
      { playerId: 'player-1', count: 1 },
    ]);
    expect(mine.carts.find((cart) => cart.id === CART.id)?.ownerPlayerId).toBe('player-0');

    // The other player's sync exposes counts but never another player's item IDs.
    const theirs = loot.syncFor('player-1');
    expect(theirs.carriedItemIds).toEqual(['loot-milk']);
    expect(theirs.sequence).toBeGreaterThan(mine.sequence);
  });

  it('restocks the shelves when a player leaves mid-match but keeps their deposits', () => {
    const loot = authority();
    loot.resolve(context({ request: request('PICK_UP', 'loot-apples') }));
    loot.resolve(context({ position: cartPosition(CART), request: request('DROP_OFF', CART.id) }));
    loot.resolve(context({ request: request('PICK_UP', 'loot-bread'), serverNowMs: 2_000 }));

    const update = loot.removePlayer('player-0');
    expect(update).toMatchObject({ type: 'RESTOCKED', itemIds: ['loot-bread'], carriedCount: 0 });
    expect(loot.cartItemIds(CART.id)).toEqual(['loot-apples']);
    const sync = loot.syncFor('player-1');
    expect(sync.items.find((item) => item.id === 'loot-bread')?.available).toBe(true);
    expect(sync.items.find((item) => item.id === 'loot-apples')?.available).toBe(false);
    expect(sync.carts.find((cart) => cart.id === CART.id)?.ownerPlayerId).toBeNull();
  });

  it('rejects any interaction from a player who is not in the match', () => {
    const loot = authority();
    const stranger = loot.resolve(context({ playerId: 'player-9', request: request('PICK_UP', 'loot-apples') }));
    expect(reasonOf(stranger.result)).toBe('NOT_IN_MATCH');
    expect(stranger.update).toBeNull();
  });

  it('chooses the nearest reachable target when the client names none', () => {
    const loot = authority();
    const chosen = loot.resolve(context({ position: { x: 902, y: 600 }, request: request('INTERACT') }));
    expect(chosen.result).toMatchObject({ outcome: 'PICKED_UP', itemId: 'loot-apples' });

    const nothing = loot.resolve(context({ position: { x: 100, y: 1_000 }, request: request('INTERACT') }));
    expect(reasonOf(nothing.result)).toBe('NO_NEARBY_TARGET');

    const atCart = loot.resolve(context({ position: cartPosition(CART), request: request('INTERACT') }));
    expect(reasonOf(atCart.result)).toBe('DEPOSITED');
    expect(loot.cartItemIds(CART.id)).toEqual(['loot-apples']);
  });

  it('keeps cart ownership tied to the slot when membership changes', () => {
    const loot = authority(1);
    expect(loot.syncFor('player-0').carts.find((cart) => cart.id === OTHER_CART.id)?.ownerPlayerId).toBeNull();
    loot.synchronizePlayers([{ id: 'player-0', slot: 0 }, { id: 'player-7', slot: 1 }]);
    expect(loot.syncFor('player-7').carts.find((cart) => cart.id === OTHER_CART.id)?.ownerPlayerId).toBe('player-7');

    const dropped = loot.synchronizePlayers([{ id: 'player-7', slot: 1 }]);
    expect(dropped).toEqual([]);
    expect(loot.syncFor('player-7').carts.find((cart) => cart.id === CART.id)?.ownerPlayerId).toBeNull();
  });

  it('validates every generated production spawn and cart against the shared map', () => {
    const production = new MatchLootAuthority('ABC234', [{ id: 'player-0', slot: 0 }]);
    const sync = production.syncFor('player-0');
    expect(sync.items).toHaveLength(GROCERY_STORE_LOOT_SPAWNS.length);
    expect(sync.carts.map((cart) => cart.id)).toEqual(GROCERY_STORE_CARTS.map((cart) => cart.id as CartId));
    expect(sync.items.every((item) => item.available)).toBe(true);
  });
});
