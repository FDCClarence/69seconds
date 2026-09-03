import {
  GAME,
  GROCERY_STORE_CARTS,
  GROCERY_STORE_LOOT_LOCATIONS,
  LOOT_SPAWN_TABLE,
  LOOT,
  NPC_CATALOG,
  NPC_SPAWN_TABLE,
  isNpcCatalogId,
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
  { id: 'loot-soup', catalogId: 'canned-soup', x: 900, y: 600 },
  { id: 'loot-water', catalogId: 'bottled-water', x: 910, y: 600 },
  { id: 'loot-bat', catalogId: 'baseball-bat', x: 920, y: 600 },
  { id: 'loot-medicine', catalogId: 'medicine', x: 930, y: 600 },
  { id: 'loot-map', catalogId: 'map', x: 940, y: 600 },
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
    const contested = request('PICK_UP', 'loot-soup');
    const rival = request('PICK_UP', 'loot-soup');

    const first = loot.resolve(context({ playerId: 'player-0', request: contested }));
    const second = loot.resolve(context({ playerId: 'player-1', request: rival }));

    expect(reasonOf(first.result)).toBe('PICKED_UP');
    expect(reasonOf(second.result)).toBe('ITEM_UNAVAILABLE');
    expect(loot.carriedItemIds('player-0')).toEqual(['loot-soup']);
    expect(loot.carriedItemIds('player-1')).toEqual([]);
    expect(first.update?.type).toBe('PICKED_UP');
    expect(second.update).toBeNull();
  });

  it('never lets four players duplicate one item, whatever the arrival order', () => {
    const loot = authority(GAME.maxPlayers);
    const results = Array.from({ length: GAME.maxPlayers }, (_, slot) => loot.resolve(context({
      playerId: `player-${slot}`,
      request: request('PICK_UP', 'loot-bat'),
    })));

    expect(results.filter((resolution) => resolution.result.outcome === 'PICKED_UP')).toHaveLength(1);
    expect(results.filter((resolution) => resolution.update !== null)).toHaveLength(1);
    const holders = Array.from({ length: GAME.maxPlayers }, (_, slot) => loot.carriedItemIds(`player-${slot}`))
      .filter((carried) => carried.includes('loot-bat'));
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
    const overflow = loot.resolve(context({ request: request('PICK_UP', 'loot-map') }));
    expect(reasonOf(overflow.result)).toBe('HANDS_FULL');
    expect(overflow.update).toBeNull();
    expect(loot.carriedItemIds('player-0')).toHaveLength(GAME.maxCarriedItems);
  });

  it('rejects a claim on an item or cart the player is nowhere near', () => {
    const loot = authority();
    const farItem = loot.resolve(context({
      position: { x: 200, y: 900 },
      request: request('PICK_UP', 'loot-soup'),
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
      spawns: [{ id: 'loot-soup', catalogId: 'canned-soup', x: 900, y: 630 }],
      collision: [{ id: 'partition', x: 900, y: 615, width: 400, height: 8 }],
    });
    const blocked = loot.resolve(context({
      position: { x: 900, y: 600 },
      request: request('PICK_UP', 'loot-soup'),
    }));
    expect(reasonOf(blocked.result)).toBe('NO_LINE_OF_ACCESS');

    const alongside = loot.resolve(context({
      position: { x: 900, y: 625 },
      request: request('PICK_UP', 'loot-soup'),
    }));
    expect(reasonOf(alongside.result)).toBe('PICKED_UP');
  });

  it('only accepts deposits into the assigned cart and only when carrying something', () => {
    const loot = authority();
    loot.resolve(context({ request: request('PICK_UP', 'loot-soup') }));

    const wrongCart = loot.resolve(context({
      position: cartPosition(OTHER_CART),
      request: request('DROP_OFF', OTHER_CART.id),
    }));
    expect(reasonOf(wrongCart.result)).toBe('NOT_YOUR_CART');
    expect(loot.carriedItemIds('player-0')).toEqual(['loot-soup']);

    const deposited = loot.resolve(context({
      position: cartPosition(CART),
      request: request('DROP_OFF', CART.id),
    }));
    expect(deposited.result).toMatchObject({ outcome: 'DEPOSITED', itemIds: ['loot-soup'], cartItemCount: 1 });
    expect(loot.carriedItemIds('player-0')).toEqual([]);
    expect(loot.cartItemIds(CART.id)).toEqual(['loot-soup']);

    const empty = loot.resolve(context({
      position: cartPosition(CART),
      request: request('DROP_OFF', CART.id),
    }));
    expect(reasonOf(empty.result)).toBe('NOTHING_CARRIED');
  });

  it('cannot pick up a deposited item a second time', () => {
    const loot = authority();
    loot.resolve(context({ request: request('PICK_UP', 'loot-soup') }));
    loot.resolve(context({ position: cartPosition(CART), request: request('DROP_OFF', CART.id) }));
    const relooted = loot.resolve(context({ request: request('PICK_UP', 'loot-soup') }));
    expect(reasonOf(relooted.result)).toBe('ITEM_UNAVAILABLE');
  });

  it('replays a duplicate request ID instead of applying it twice', () => {
    const loot = authority();
    const pickup = request('PICK_UP', 'loot-soup');
    const first = loot.resolve(context({ request: pickup }));
    const duplicate = loot.resolve(context({ request: pickup }));

    expect(duplicate.replayed).toBe(true);
    expect(duplicate.result).toEqual(first.result);
    expect(duplicate.update).toBeNull();
    expect(loot.carriedItemIds('player-0')).toEqual(['loot-soup']);
  });

  it('replays a duplicate deposit without emptying the hands twice', () => {
    const loot = authority();
    loot.resolve(context({ request: request('PICK_UP', 'loot-soup') }));
    const deposit = request('DROP_OFF', CART.id);
    const first = loot.resolve(context({ position: cartPosition(CART), request: deposit }));
    loot.resolve(context({ request: request('PICK_UP', 'loot-water') }));
    const duplicate = loot.resolve(context({ position: cartPosition(CART), request: deposit }));

    expect(duplicate.result).toEqual(first.result);
    expect(duplicate.update).toBeNull();
    expect(loot.cartItemIds(CART.id)).toEqual(['loot-soup']);
    expect(loot.carriedItemIds('player-0')).toEqual(['loot-water']);
  });

  it('closes interactions outside the looting phase and past the deadline', () => {
    const loot = authority();
    expect(reasonOf(loot.resolve(context({
      phase: 'COUNTDOWN',
      request: request('PICK_UP', 'loot-soup'),
    })).result)).toBe('INVALID_PHASE');
    expect(reasonOf(loot.resolve(context({
      serverNowMs: 100_000,
      request: request('PICK_UP', 'loot-soup'),
    })).result)).toBe('INVALID_PHASE');
    expect(reasonOf(loot.resolve(context({
      phase: 'TALLY',
      request: request('PICK_UP', 'loot-soup'),
    })).result)).toBe('INVALID_PHASE');
    expect(loot.carriedItemIds('player-0')).toEqual([]);
  });

  it('rate limits a spamming client without blocking ordinary play', () => {
    const loot = authority();
    const burst = Array.from({ length: LOOT.interactionBurstCapacity + 4 }, () => loot.resolve(context({
      request: request('PICK_UP', 'loot-soup'),
      serverNowMs: 1_000,
    })));
    const limited = burst.filter((resolution) => reasonOf(resolution.result) === 'RATE_LIMITED');
    expect(limited.length).toBeGreaterThan(0);
    expect(burst.length - limited.length).toBeLessThanOrEqual(LOOT.interactionBurstCapacity);

    // One second later the bucket has refilled, so a legitimate press succeeds again.
    const afterRefill = loot.resolve(context({
      request: request('PICK_UP', 'loot-water'),
      serverNowMs: 2_000,
    }));
    expect(reasonOf(afterRefill.result)).toBe('PICKED_UP');
  });

  it('restores the world and private inventory for a reconnecting player', () => {
    const loot = authority();
    loot.resolve(context({ request: request('PICK_UP', 'loot-soup') }));
    loot.resolve(context({ request: request('PICK_UP', 'loot-water'), serverNowMs: 1_100 }));
    loot.resolve(context({
      playerId: 'player-1',
      request: request('PICK_UP', 'loot-bat'),
    }));

    const mine = loot.syncFor('player-0');
    expect(mine.carriedItemIds).toEqual(['loot-soup', 'loot-water']);
    expect(mine.items.filter((item) => item.available).map((item) => item.id))
      .toEqual(['loot-medicine', 'loot-map']);
    expect(mine.carriedCounts).toEqual([
      { playerId: 'player-0', count: 2 },
      { playerId: 'player-1', count: 1 },
    ]);
    expect(mine.carts.find((cart) => cart.id === CART.id)?.ownerPlayerId).toBe('player-0');

    // The other player's sync exposes counts but never another player's item IDs.
    const theirs = loot.syncFor('player-1');
    expect(theirs.carriedItemIds).toEqual(['loot-bat']);
    expect(theirs.sequence).toBeGreaterThan(mine.sequence);
  });

  it('restocks the shelves when a player leaves mid-match but keeps their deposits', () => {
    const loot = authority();
    loot.resolve(context({ request: request('PICK_UP', 'loot-soup') }));
    loot.resolve(context({ position: cartPosition(CART), request: request('DROP_OFF', CART.id) }));
    loot.resolve(context({ request: request('PICK_UP', 'loot-water'), serverNowMs: 2_000 }));

    const update = loot.removePlayer('player-0');
    expect(update).toMatchObject({ type: 'RESTOCKED', itemIds: ['loot-water'], carriedCount: 0 });
    expect(loot.cartItemIds(CART.id)).toEqual(['loot-soup']);
    const sync = loot.syncFor('player-1');
    expect(sync.items.find((item) => item.id === 'loot-water')?.available).toBe(true);
    expect(sync.items.find((item) => item.id === 'loot-soup')?.available).toBe(false);
    expect(sync.carts.find((cart) => cart.id === CART.id)?.ownerPlayerId).toBeNull();
  });

  it('rejects any interaction from a player who is not in the match', () => {
    const loot = authority();
    const stranger = loot.resolve(context({ playerId: 'player-9', request: request('PICK_UP', 'loot-soup') }));
    expect(reasonOf(stranger.result)).toBe('NOT_IN_MATCH');
    expect(stranger.update).toBeNull();
  });

  it('chooses the nearest reachable target when the client names none', () => {
    const loot = authority();
    const chosen = loot.resolve(context({ position: { x: 902, y: 600 }, request: request('INTERACT') }));
    expect(chosen.result).toMatchObject({ outcome: 'PICKED_UP', itemId: 'loot-soup' });

    const nothing = loot.resolve(context({ position: { x: 100, y: 1_000 }, request: request('INTERACT') }));
    expect(reasonOf(nothing.result)).toBe('NO_NEARBY_TARGET');

    const atCart = loot.resolve(context({ position: cartPosition(CART), request: request('INTERACT') }));
    expect(reasonOf(atCart.result)).toBe('DEPOSITED');
    expect(loot.cartItemIds(CART.id)).toEqual(['loot-soup']);
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
    const people = sync.items.filter((item) => isNpcCatalogId(item.catalogId));
    expect(sync.items).toHaveLength(LOOT_SPAWN_TABLE.itemsPerMatch + people.length);
    expect(people).toHaveLength(Math.min(NPC_SPAWN_TABLE.maxPerMatch, NPC_CATALOG.length));
    expect(sync.carts.map((cart) => cart.id)).toEqual(GROCERY_STORE_CARTS.map((cart) => cart.id as CartId));
    expect(sync.items.every((item) => item.available)).toBe(true);
    // Every placement is a distinct map location, so nobody stands on an item.
    expect(new Set(sync.items.map((item) => item.id)).size).toBe(sync.items.length);
    expect(new Set(people.map((person) => person.catalogId)).size).toBe(people.length);
    for (const item of sync.items) {
      expect(GROCERY_STORE_LOOT_LOCATIONS.some((location) => location.id === item.id)).toBe(true);
    }
  });
});

describe('authoritative people', () => {
  /** One person and one item, both in the open central floor beside the player. */
  const npcSpawns = [{ id: 'npc-maya', catalogId: 'maya', x: 905, y: 600 }] as const;

  function peopled(): MatchLootAuthority {
    return new MatchLootAuthority(
      'ABC234',
      [{ id: 'player-0', slot: 0 }, { id: 'player-1', slot: 1 }],
      { spawns, npcSpawns },
    );
  }

  it('takes every carry slot for one person', () => {
    const loot = peopled();
    const result = loot.resolve(context({ request: request('PICK_UP', 'npc-maya') })).result;

    expect(reasonOf(result)).toBe('PICKED_UP');
    expect(loot.carriedItemIds('player-0')).toEqual(['npc-maya']);
    expect(loot.syncFor('player-0').carriedCounts).toContainEqual({
      playerId: 'player-0',
      count: GAME.maxCarriedItems,
    });
  });

  it('refuses a person to hands that are not empty, and says why', () => {
    const loot = peopled();
    loot.resolve(context({ request: request('PICK_UP', 'loot-soup') }));
    const refused = loot.resolve(context({ request: request('PICK_UP', 'npc-maya') })).result;

    expect(reasonOf(refused)).toBe('NEEDS_EMPTY_HANDS');
    expect(loot.carriedItemIds('player-0')).toEqual(['loot-soup']);
  });

  it('refuses any further pickup while someone is being carried', () => {
    const loot = peopled();
    loot.resolve(context({ request: request('PICK_UP', 'npc-maya') }));
    const refused = loot.resolve(context({ request: request('PICK_UP', 'loot-soup') })).result;

    expect(reasonOf(refused)).toBe('HANDS_FULL');
    expect(loot.carriedItemIds('player-0')).toEqual(['npc-maya']);
  });

  it('lets exactly one of two players carry the same person', () => {
    const loot = peopled();
    const first = loot.resolve(context({ playerId: 'player-0', request: request('PICK_UP', 'npc-maya') }));
    const second = loot.resolve(context({ playerId: 'player-1', request: request('PICK_UP', 'npc-maya') }));

    expect(reasonOf(first.result)).toBe('PICKED_UP');
    expect(reasonOf(second.result)).toBe('ITEM_UNAVAILABLE');
  });

  it('recruits a carried person into the owning cart', () => {
    const loot = peopled();
    loot.resolve(context({ request: request('PICK_UP', 'npc-maya') }));
    const deposit = loot.resolve(context({
      position: cartPosition(CART),
      request: request('DROP_OFF', CART.id),
    }));

    expect(reasonOf(deposit.result)).toBe('DEPOSITED');
    expect(loot.cartItemIds(CART.id as CartId)).toEqual(['npc-maya']);
    expect(loot.depositedItemsForSlot(0)).toEqual([{ id: 'npc-maya', catalogId: 'maya' }]);
    expect(loot.carriedItemIds('player-0')).toEqual([]);
  });

  it('prefers the reachable own cart over an item the hands cannot take', () => {
    // Standing at the cart, carrying a person, with an item within reach: an
    // unaddressed interact must recruit rather than rejecting on the item.
    const loot = new MatchLootAuthority(
      'ABC234',
      [{ id: 'player-0', slot: 0 }],
      {
        spawns: [{ id: 'loot-beside-cart', catalogId: 'canned-soup', x: CART.x + 20, y: CART.y }],
        npcSpawns: [{ id: 'npc-maya', catalogId: 'maya', x: 900, y: 600 }],
      },
    );
    loot.resolve(context({ request: request('PICK_UP', 'npc-maya') }));
    const interact = loot.resolve(context({
      position: cartPosition(CART),
      request: request('INTERACT'),
    }));

    expect(reasonOf(interact.result)).toBe('DEPOSITED');
    expect(loot.cartItemIds(CART.id as CartId)).toEqual(['npc-maya']);
  });

  it('still reports the honest reason when only an unfittable item is in reach', () => {
    const loot = peopled();
    loot.resolve(context({ request: request('PICK_UP', 'npc-maya') }));
    const interact = loot.resolve(context({ request: request('INTERACT') })).result;

    expect(reasonOf(interact)).toBe('HANDS_FULL');
  });
});

describe('putting a carryable back down', () => {
  const npcSpawns = [{ id: 'npc-maya', catalogId: 'maya', x: 905, y: 600 }] as const;

  function peopled(): MatchLootAuthority {
    return new MatchLootAuthority('ABC234', [{ id: 'player-0', slot: 0 }], { spawns, npcSpawns });
  }

  it('drops the most recent item at the player position the server owns', () => {
    const loot = peopled();
    loot.resolve(context({ request: request('PICK_UP', 'loot-soup') }));
    loot.resolve(context({ request: request('PICK_UP', 'loot-water') }));
    const dropped = loot.resolve(context({
      position: { x: 880, y: 640 },
      request: request('DROP'),
    }));

    expect(dropped.result.outcome).toBe('DROPPED');
    expect(loot.carriedItemIds('player-0')).toEqual(['loot-soup']);
    expect(dropped.update).toMatchObject({
      type: 'DROPPED',
      itemId: 'loot-water',
      position: { x: 880, y: 640 },
      carriedCount: 1,
    });
    const item = loot.syncFor('player-0').items.find((candidate) => candidate.id === 'loot-water');
    expect(item).toMatchObject({ available: true, position: { x: 880, y: 640 } });
  });

  it('ignores a claimed position and uses the authoritative one', () => {
    const loot = peopled();
    loot.resolve(context({ request: request('PICK_UP', 'loot-soup') }));
    // A modified client can name a target but never a coordinate: the request
    // schema carries no position, so the drop lands where the server says.
    const dropped = loot.resolve(context({
      position: { x: 900, y: 600 },
      request: { ...request('DROP'), targetId: 'loot-water' },
    }));

    expect(dropped.result).toMatchObject({ itemId: 'loot-soup', position: { x: 900, y: 600 } });
  });

  it('frees every slot when the dropped carryable is a person', () => {
    const loot = peopled();
    loot.resolve(context({ request: request('PICK_UP', 'npc-maya') }));
    const dropped = loot.resolve(context({ request: request('DROP') }));

    expect(dropped.update).toMatchObject({ type: 'DROPPED', carriedCount: 0 });
    expect(loot.carriedItemIds('player-0')).toEqual([]);
    // With hands free again, the same person can be picked straight back up.
    expect(reasonOf(loot.resolve(context({ request: request('PICK_UP', 'npc-maya') })).result))
      .toBe('PICKED_UP');
  });

  it('refuses a drop from empty hands', () => {
    const loot = peopled();
    const dropped = loot.resolve(context({ request: request('DROP') }));

    expect(reasonOf(dropped.result)).toBe('NOTHING_CARRIED');
    expect(dropped.update).toBeNull();
  });

  it('replays a resent drop instead of dropping a second thing', () => {
    const loot = peopled();
    loot.resolve(context({ request: request('PICK_UP', 'loot-soup') }));
    loot.resolve(context({ request: request('PICK_UP', 'loot-water') }));
    const once = request('DROP');
    const first = loot.resolve(context({ request: once }));
    const replay = loot.resolve(context({ request: once }));

    expect(replay.replayed).toBe(true);
    expect(replay.result).toEqual(first.result);
    expect(replay.update).toBeNull();
    expect(loot.carriedItemIds('player-0')).toEqual(['loot-soup']);
  });

  it('is closed outside the looting phase like every other interaction', () => {
    const loot = peopled();
    loot.resolve(context({ request: request('PICK_UP', 'loot-soup') }));
    const dropped = loot.resolve(context({ phase: 'TALLY', request: request('DROP') }));

    expect(reasonOf(dropped.result)).toBe('INVALID_PHASE');
    expect(loot.carriedItemIds('player-0')).toEqual(['loot-soup']);
  });
});
