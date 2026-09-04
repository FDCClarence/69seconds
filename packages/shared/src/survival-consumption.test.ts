import { describe, expect, it } from 'vitest';
import {
  LOOT_CATALOG,
  SURVIVAL_CONSUMABLES,
  SURVIVAL_CHARACTER_DEFAULTS,
  consumeSurvivalItem,
  findSurvivalConsumable,
  isSurvivalConsumable,
  survivalStateSchema,
  type SurvivalCharacter,
  type SurvivalHousehold,
  type SurvivalInventoryItem,
  type SurvivalState,
} from './index.js';

const SOUP = 'canned-soup';
const WATER = 'bottled-water';
const MRE = 'microwave-meal';

interface CharacterOptions {
  nutrition?: [current: number, max: number];
  hydration?: [current: number, max: number];
  isAlive?: boolean;
}

function character(id: string, options: CharacterOptions = {}): SurvivalCharacter {
  const [nutritionCurrent, nutritionMax] = options.nutrition ?? [100, 100];
  const [hydrationCurrent, hydrationMax] = options.hydration ?? [100, 100];
  return {
    id,
    displayName: id,
    kind: 'MAIN',
    catalogId: null,
    isAlive: options.isAlive ?? true,
    stats: {
      ...SURVIVAL_CHARACTER_DEFAULTS.stats,
      nutrition: { current: nutritionCurrent, max: nutritionMax },
      hydration: { current: hydrationCurrent, max: hydrationMax },
    },
    dailyNutritionCost: SURVIVAL_CHARACTER_DEFAULTS.dailyNutritionCost,
    dailyHydrationCost: SURVIVAL_CHARACTER_DEFAULTS.dailyHydrationCost,
  };
}

function item(id: string, catalogId: string): SurvivalInventoryItem {
  const label = LOOT_CATALOG.find((entry) => entry.id === catalogId)?.label ?? catalogId;
  return { id, catalogId, label, category: 'food' };
}

function household(
  playerId: string,
  slot: number,
  characters: SurvivalCharacter[],
  inventory: SurvivalInventoryItem[],
): SurvivalHousehold {
  return { playerId, displayName: playerId, slot, characters, inventory };
}

function dayWith(households: SurvivalHousehold[]): SurvivalState {
  return survivalStateSchema.parse({
    stateId: 'survival:test',
    roomCode: 'ABC234',
    dayNumber: 1,
    startedAtMs: 71_000,
    households,
  });
}

/** One household holding one soup, one water, one meal, and one inedible pistol. */
function stockedDay(): SurvivalState {
  return dayWith([
    household('player-1', 0, [character('player-1')], [
      item('item-soup', SOUP),
      item('item-water', WATER),
      item('item-mre', MRE),
      { id: 'item-pistol', catalogId: 'pistol', label: 'Pistol', category: 'weapons' },
    ]),
  ]);
}

function feed(state: SurvivalState, itemId: string, characterId = 'player-1', playerId = 'player-1') {
  return consumeSurvivalItem({ state, playerId, itemId, characterId });
}

function fed(state: SurvivalState, playerId = 'player-1'): SurvivalHousehold {
  return state.households.find((candidate) => candidate.playerId === playerId)!;
}

describe('the survival consumable table', () => {
  it('names only ids the shared loot catalog actually places', () => {
    for (const catalogId of Object.keys(SURVIVAL_CONSUMABLES)) {
      expect(LOOT_CATALOG.map((entry) => entry.id)).toContain(catalogId);
    }
    expect(Object.keys(SURVIVAL_CONSUMABLES)).toEqual([SOUP, WATER, MRE]);
  });

  it('treats anything absent from the table as inedible', () => {
    expect(isSurvivalConsumable(SOUP)).toBe(true);
    expect(findSurvivalConsumable(SOUP)).toEqual({ nutrition: 50 });
    expect(findSurvivalConsumable(WATER)).toEqual({ hydration: 50 });
    expect(findSurvivalConsumable(MRE)).toEqual({ nutrition: 'MAX', hydration: 'MAX' });
    // A weapon, a recruited person, and an id from a table this build has never
    // seen are all equally not food, with no per-item rule saying so.
    for (const catalogId of ['pistol', 'radio', 'medkit', 'gort', 'from-a-newer-deploy']) {
      expect(isSurvivalConsumable(catalogId)).toBe(false);
    }
  });
});

describe('consumeSurvivalItem', () => {
  it('restores 50 Nutrition from canned soup and touches nothing else', () => {
    const before = dayWith([household('player-1', 0, [
      character('player-1', { nutrition: [20, 100], hydration: [40, 100] }),
    ], [item('item-soup', SOUP)])]);
    const outcome = feed(before, 'item-soup');
    if (!outcome.ok) throw new Error(`Expected a committed feed, got ${outcome.reason}`);
    expect(outcome.character.stats.nutrition).toEqual({ current: 70, max: 100 });
    expect(outcome.character.stats.hydration).toEqual({ current: 40, max: 100 });
    // Health, Survival, Morale, and Strength are not what a meal is for.
    expect(outcome.character.stats.health).toEqual(before.households[0]!.characters[0]!.stats.health);
    expect(outcome.character.stats.morale).toEqual(before.households[0]!.characters[0]!.stats.morale);
  });

  it('restores 50 Hydration from bottled water and touches nothing else', () => {
    const before = dayWith([household('player-1', 0, [
      character('player-1', { nutrition: [20, 100], hydration: [40, 130] }),
    ], [item('item-water', WATER)])]);
    const outcome = feed(before, 'item-water');
    if (!outcome.ok) throw new Error(`Expected a committed feed, got ${outcome.reason}`);
    expect(outcome.character.stats.hydration).toEqual({ current: 90, max: 130 });
    expect(outcome.character.stats.nutrition).toEqual({ current: 20, max: 100 });
  });

  it('fills both stats to that character\'s own maximums from a microwave meal', () => {
    const before = dayWith([household('player-1', 0, [
      character('player-1', { nutrition: [30, 80], hydration: [50, 130] }),
    ], [item('item-mre', MRE)])]);
    const outcome = feed(before, 'item-mre');
    if (!outcome.ok) throw new Error(`Expected a committed feed, got ${outcome.reason}`);
    // Full means full for this character: 80 and 130, not the default 100.
    expect(outcome.character.stats.nutrition).toEqual({ current: 80, max: 80 });
    expect(outcome.character.stats.hydration).toEqual({ current: 130, max: 130 });
  });

  it('clamps every restoration at the personal max rather than at 100', () => {
    const day = dayWith([household('player-1', 0, [
      character('nearly-full', { nutrition: [70, 100], hydration: [95, 100] }),
      character('small-tank', { nutrition: [20, 80], hydration: [10, 40] }),
      character('big-tank', { nutrition: [60, 200], hydration: [40, 130] }),
    ], [
      item('soup-1', SOUP), item('soup-2', SOUP), item('soup-3', SOUP),
      item('water-1', WATER), item('water-2', WATER),
    ])]);

    // 70/100 + 50 stops at the max; 20/80 + 50 lands mid-tank; 60/200 + 50 is
    // an ordinary addition on a tank far larger than the default.
    const capped = feed(day, 'soup-1', 'nearly-full');
    if (!capped.ok) throw new Error('Expected a committed feed');
    expect(capped.character.stats.nutrition).toEqual({ current: 100, max: 100 });

    const partial = feed(day, 'soup-2', 'small-tank');
    if (!partial.ok) throw new Error('Expected a committed feed');
    expect(partial.character.stats.nutrition).toEqual({ current: 70, max: 80 });

    const roomy = feed(day, 'soup-3', 'big-tank');
    if (!roomy.ok) throw new Error('Expected a committed feed');
    expect(roomy.character.stats.nutrition).toEqual({ current: 110, max: 200 });

    // A tank smaller than the restoration is capped, never overfilled.
    const overflowing = feed(day, 'water-1', 'small-tank');
    if (!overflowing.ok) throw new Error('Expected a committed feed');
    expect(overflowing.character.stats.hydration).toEqual({ current: 40, max: 40 });

    const almost = feed(day, 'water-2', 'nearly-full');
    if (!almost.ok) throw new Error('Expected a committed feed');
    expect(almost.character.stats.hydration).toEqual({ current: 100, max: 100 });
  });

  it('spends exactly one unit and leaves the rest of the household alone', () => {
    const before = dayWith([household('player-1', 0, [
      character('player-1', { nutrition: [10, 100] }),
      character('recruit', { nutrition: [10, 100] }),
    ], [item('soup-1', SOUP), item('soup-2', SOUP), item('item-water', WATER)])]);
    const outcome = feed(before, 'soup-1');
    if (!outcome.ok) throw new Error('Expected a committed feed');

    // The named instance goes, its duplicate stays, and nothing else moves.
    expect(outcome.inventory.map((entry) => entry.id)).toEqual(['soup-2', 'item-water']);
    expect(fed(outcome.state).inventory.map((entry) => entry.id)).toEqual(['soup-2', 'item-water']);
    expect(outcome.item).toEqual(before.households[0]!.inventory[0]);
    // The household's other character never ate.
    expect(fed(outcome.state).characters[1]!.stats.nutrition).toEqual({ current: 10, max: 100 });
    // The day that was fed from is untouched: it is still the state it was.
    expect(before.households[0]!.inventory).toHaveLength(3);
    expect(before.households[0]!.characters[0]!.stats.nutrition).toEqual({ current: 10, max: 100 });
    expect(outcome.state).not.toBe(before);
    expect(outcome.state.dayNumber).toBe(before.dayNumber);
  });

  it('rejects an item that is not in that household and consumes nothing', () => {
    const before = stockedDay();
    const missing = feed(before, 'item-nobody-has');
    expect(missing).toEqual({ ok: false, reason: 'UNKNOWN_ITEM' });
    expect(before.households[0]!.inventory).toHaveLength(4);
  });

  it('rejects an item that is not food and consumes nothing', () => {
    const before = stockedDay();
    const inedible = feed(before, 'item-pistol');
    expect(inedible).toEqual({ ok: false, reason: 'NOT_CONSUMABLE' });
    expect(before.households[0]!.inventory.map((entry) => entry.id)).toContain('item-pistol');
  });

  it('cannot feed another player\'s character or spend another player\'s inventory', () => {
    const before = dayWith([
      household('player-1', 0, [character('player-1', { nutrition: [10, 100] })], [item('mine', SOUP)]),
      household('player-2', 1, [character('player-2', { nutrition: [10, 100] })], [item('theirs', SOUP)]),
    ]);

    // Their character is not in my household, so my own soup cannot reach them.
    const acrossHouseholds = consumeSurvivalItem({
      state: before, playerId: 'player-1', itemId: 'mine', characterId: 'player-2',
    });
    expect(acrossHouseholds).toEqual({ ok: false, reason: 'UNKNOWN_CHARACTER' });

    // Their soup is not in my inventory, so naming it finds nothing at all.
    const acrossInventories = consumeSurvivalItem({
      state: before, playerId: 'player-1', itemId: 'theirs', characterId: 'player-1',
    });
    expect(acrossInventories).toEqual({ ok: false, reason: 'UNKNOWN_ITEM' });

    // A player with no household in this day owns neither.
    const stranger = consumeSurvivalItem({
      state: before, playerId: 'player-3', itemId: 'mine', characterId: 'player-1',
    });
    expect(stranger).toEqual({ ok: false, reason: 'NO_HOUSEHOLD' });

    // Both households are exactly as they were.
    expect(before.households[0]!.inventory).toHaveLength(1);
    expect(before.households[1]!.inventory).toHaveLength(1);
    expect(before.households[1]!.characters[0]!.stats.nutrition).toEqual({ current: 10, max: 100 });
  });

  it('cannot feed a dead character and consumes nothing', () => {
    const before = dayWith([household('player-1', 0, [
      character('player-1'),
      character('lost', { nutrition: [0, 100], hydration: [0, 100], isAlive: false }),
    ], [item('item-mre', MRE)])]);
    expect(feed(before, 'item-mre', 'lost')).toEqual({ ok: false, reason: 'CHARACTER_DEAD' });
    expect(before.households[0]!.inventory).toHaveLength(1);
    expect(before.households[0]!.characters[1]!.stats.nutrition).toEqual({ current: 0, max: 100 });
  });

  it('cannot reach a recruited person, because people are never inventory', () => {
    const recruit: SurvivalCharacter = {
      ...character('recruit-1'),
      kind: 'NPC',
      catalogId: 'gort',
    };
    const before = dayWith([household('player-1', 0, [
      character('player-1', { nutrition: [10, 100] }),
      recruit,
    ], [item('item-soup', SOUP)])]);
    // Naming the recruit as the item finds nothing: `inventory` is the only
    // place this ever looks, and no person is ever placed there.
    expect(feed(before, 'recruit-1')).toEqual({ ok: false, reason: 'UNKNOWN_ITEM' });
    // Naming them as the target is an ordinary, legal feed.
    const outcome = feed(before, 'item-soup', 'recruit-1');
    if (!outcome.ok) throw new Error('Expected a committed feed');
    expect(outcome.character.kind).toBe('NPC');
  });

  it('returns a frozen day, exactly as the days that open and resolve are', () => {
    const outcome = feed(stockedDay(), 'item-soup');
    if (!outcome.ok) throw new Error('Expected a committed feed');
    expect(Object.isFrozen(outcome.state)).toBe(true);
    expect(Object.isFrozen(outcome.state.households[0])).toBe(true);
    expect(Object.isFrozen(outcome.state.households[0]!.characters[0]!.stats.nutrition)).toBe(true);
  });
});
