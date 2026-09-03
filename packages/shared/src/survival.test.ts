import { describe, expect, it } from 'vitest';
import { carryableEntry } from './carryable.js';
import { GAME, SURVIVAL } from './constants.js';
import { NPC_CARRY_SLOTS } from './npc-table.js';
import { matchTallySchema, survivalStateSchema, type MatchTally, type TallyItem } from './schemas.js';
import { createSurvivalCharacter, initializeSurvivalState } from './survival.js';
import {
  NPC_SURVIVAL_OVERRIDES,
  SURVIVAL_CHARACTER_DEFAULTS,
  SURVIVAL_STAT_KEYS,
  type NpcSurvivalOverrideTable,
} from './survival-table.js';

const LOOTING_ENDED_AT_MS = 71_000;

/** One tally line, labelled and categorised exactly as the server labels it. */
function line(id: string, catalogId: string): TallyItem {
  const entry = carryableEntry(catalogId);
  return { id, catalogId, label: entry.label, category: entry.category };
}

/**
 * A frozen looting result, built through the real schema so these tests read the
 * same object the server hands the initializer.
 */
function lootingResult(banked: readonly (readonly TallyItem[])[]): MatchTally {
  const players = banked.map((items, slot) => ({
    playerId: `player-${slot}`,
    displayName: `Player ${slot}`,
    slot,
    isConnectedAtEnd: true,
    items: [...items],
    categoryTotals: [],
    totalItems: items.length,
  }));
  return matchTallySchema.parse({
    resultId: `ABC234:${LOOTING_ENDED_AT_MS}`,
    roomCode: 'ABC234',
    lootingStartedAtMs: LOOTING_ENDED_AT_MS - GAME.lootingDurationMs,
    lootingEndedAtMs: LOOTING_ENDED_AT_MS,
    durationMs: GAME.lootingDurationMs,
    players,
    categoryTotals: [],
    totalItems: players.reduce((count, player) => count + player.totalItems, 0),
  });
}

describe('survival characters', () => {
  it('gives a main character the default stats, its own daily costs, and a life', () => {
    const character = createSurvivalCharacter({
      id: 'player-0',
      displayName: 'Player 0',
      kind: 'MAIN',
    });
    expect(character).toMatchObject({
      id: 'player-0',
      displayName: 'Player 0',
      kind: 'MAIN',
      catalogId: null,
      isAlive: true,
      dailyNutritionCost: 20,
      dailyHydrationCost: 20,
    });
    expect(character.stats).toEqual({
      health: { current: 100, max: 100 },
      survival: { current: 50, max: 100 },
      morale: { current: 100, max: 100 },
      strength: { current: 50, max: 100 },
      nutrition: { current: 100, max: 100 },
      hydration: { current: 100, max: 100 },
    });
  });

  it('keeps current and max as separate values rather than one number', () => {
    const { stats } = createSurvivalCharacter({ id: 'c', displayName: 'C', kind: 'MAIN' });
    // Survival and strength start half full, which only a real pair can express.
    expect(stats.survival).toEqual({ current: 50, max: 100 });
    expect(stats.strength.current).not.toBe(stats.strength.max);
    for (const key of SURVIVAL_STAT_KEYS) {
      expect(Object.keys(stats[key]).sort()).toEqual(['current', 'max']);
      expect(stats[key].current).toBeLessThanOrEqual(stats[key].max);
    }
  });

  it('treats the daily costs as independent plain amounts', () => {
    const character = createSurvivalCharacter({
      id: 'npc',
      displayName: 'Gort',
      kind: 'NPC',
      catalogId: 'gort',
      overrides: { dailyHydrationCost: 30 },
    });
    expect(character.dailyNutritionCost).toBe(20);
    expect(character.dailyHydrationCost).toBe(30);
    // Plain numbers, deliberately not current/max pairs.
    expect(typeof character.dailyNutritionCost).toBe('number');
    expect(typeof character.dailyHydrationCost).toBe('number');
  });

  it('gives every character its own stat objects, sharing nothing with the defaults', () => {
    const first = createSurvivalCharacter({ id: 'a', displayName: 'A', kind: 'MAIN' });
    const second = createSurvivalCharacter({ id: 'b', displayName: 'B', kind: 'MAIN' });
    expect(first.stats.health).not.toBe(second.stats.health);
    expect(first.stats.health).not.toBe(SURVIVAL_CHARACTER_DEFAULTS.stats.health);

    first.stats.health.current = 10;
    first.dailyNutritionCost = 99;
    expect(second.stats.health.current).toBe(100);
    expect(second.dailyNutritionCost).toBe(20);
    expect(SURVIVAL_CHARACTER_DEFAULTS.stats.health.current).toBe(100);
    expect(SURVIVAL_CHARACTER_DEFAULTS.dailyNutritionCost).toBe(20);
  });

  it('overrides any starting value, any max, or any daily cost from data alone', () => {
    const character = createSurvivalCharacter({
      id: 'npc',
      displayName: 'Override',
      kind: 'NPC',
      catalogId: 'gort',
      overrides: {
        health: { max: 120 },
        strength: { current: 75 },
        nutrition: { max: 80 },
        dailyHydrationCost: 30,
      },
    });
    // Raising a max does not fill the stat; `current` still comes from defaults.
    expect(character.stats.health).toEqual({ current: 100, max: 120 });
    expect(character.stats.strength).toEqual({ current: 75, max: 100 });
    // Lowering a max clamps the default current instead of producing 100/80.
    expect(character.stats.nutrition).toEqual({ current: 80, max: 80 });
    expect(character.dailyHydrationCost).toBe(30);
    // Everything not named keeps the default.
    expect(character.stats.morale).toEqual({ current: 100, max: 100 });
    expect(character.dailyNutritionCost).toBe(20);
  });

  it('never assumes a max of 100, on the model or on the wire', () => {
    const character = createSurvivalCharacter({
      id: 'npc',
      displayName: 'Big',
      kind: 'NPC',
      catalogId: 'gort',
      overrides: { health: { current: 120, max: 120 }, morale: { max: 40 } },
    });
    expect(character.stats.health.max).toBe(120);
    expect(character.stats.morale.max).toBe(40);
    expect(() => survivalStateSchema.parse({
      stateId: 'survival:ABC234:1',
      roomCode: 'ABC234',
      dayNumber: SURVIVAL.firstDayNumber,
      startedAtMs: 1,
      households: [{
        playerId: 'player-0',
        displayName: 'Player 0',
        slot: 0,
        characters: [character],
        inventory: [],
      }],
    })).not.toThrow();
  });

  it('rejects a stat the model could never satisfy', () => {
    expect(() => createSurvivalCharacter({
      id: 'bad', displayName: 'Bad', kind: 'MAIN', overrides: { health: { max: 0 } },
    })).toThrow(/non-positive health.max/);
    expect(() => createSurvivalCharacter({
      id: 'bad', displayName: 'Bad', kind: 'MAIN', overrides: { hydration: { current: -1 } },
    })).toThrow(/out-of-range hydration.current/);
    expect(() => createSurvivalCharacter({
      id: 'bad', displayName: 'Bad', kind: 'MAIN', overrides: { dailyNutritionCost: Number.NaN },
    })).toThrow(/out-of-range dailyNutritionCost/);
  });

  it('keeps a main character and an NPC in one representation', () => {
    const main = createSurvivalCharacter({ id: 'p', displayName: 'P', kind: 'MAIN' });
    const npc = createSurvivalCharacter({ id: 'n', displayName: 'N', kind: 'NPC', catalogId: 'maya' });
    expect(Object.keys(main).sort()).toEqual(Object.keys(npc).sort());
    expect(main.stats).toEqual(npc.stats);
    // The only structural difference is which catalog entry backs them.
    expect(() => createSurvivalCharacter({ id: 'n', displayName: 'N', kind: 'NPC' }))
      .toThrow(/needs the catalog id/);
    expect(() => createSurvivalCharacter({ id: 'p', displayName: 'P', kind: 'MAIN', catalogId: 'maya' }))
      .toThrow(/must not carry a catalog id/);
  });

  it('declares exactly the stats the wire schema carries', () => {
    expect([...SURVIVAL_STAT_KEYS].sort())
      .toEqual(Object.keys(createSurvivalCharacter({ id: 'c', displayName: 'C', kind: 'MAIN' }).stats).sort());
  });
});

describe('survival household initialization', () => {
  it('gives each player one household holding their own main character', () => {
    const state = initializeSurvivalState({ result: lootingResult([[], []]) });
    expect(state.households.map((household) => household.playerId)).toEqual(['player-0', 'player-1']);
    for (const household of state.households) {
      expect(household.characters).toHaveLength(1);
      expect(household.characters[0]).toMatchObject({
        id: household.playerId,
        displayName: household.displayName,
        kind: 'MAIN',
        isAlive: true,
      });
      expect(household.characters[0]?.stats).toEqual(SURVIVAL_CHARACTER_DEFAULTS.stats);
    }
  });

  it('derives its identity and start time from the frozen looting result', () => {
    const result = lootingResult([[]]);
    const state = initializeSurvivalState({ result });
    expect(state).toMatchObject({
      stateId: `survival:${result.resultId}`,
      roomCode: result.roomCode,
      startedAtMs: result.lootingEndedAtMs,
    });
  });

  it('gives each player only the people that player recruited', () => {
    const state = initializeSurvivalState({
      result: lootingResult([
        [line('loot-spot-01', 'maya'), line('loot-spot-02', 'canned-soup')],
        [line('loot-spot-03', 'gort'), line('loot-spot-04', 'kevin')],
        [],
      ]),
    });
    const recruits = state.households.map((household) => household.characters
      .filter((character) => character.kind === 'NPC')
      .map((character) => character.catalogId));
    expect(recruits).toEqual([['maya'], ['gort', 'kevin'], []]);
    // Nobody inherits a neighbour's recruit, and every household keeps its own main.
    expect(state.households.map((household) => household.characters.length)).toEqual([2, 3, 1]);
    expect(state.households.every((household) => household.characters[0]?.kind === 'MAIN')).toBe(true);
  });

  it('keeps ordinary loot as inventory rather than turning it into a character', () => {
    const soup = line('loot-spot-02', 'canned-soup');
    const map = line('loot-spot-05', 'map');
    const state = initializeSurvivalState({
      result: lootingResult([[soup, line('loot-spot-01', 'maya'), map]]),
    });
    const household = state.households[0]!;
    expect(household.inventory).toEqual([soup, map]);
    expect(household.characters.map((character) => character.displayName)).toEqual(['Player 0', 'Maya']);
    expect(household.characters.some((character) => character.catalogId === 'canned-soup')).toBe(false);
  });

  it('counts one recruit as one character despite the four carry slots they cost', () => {
    // Recruiting somebody fills every carry slot during looting; that cost is a
    // looting-time rule and must not multiply or divide household members.
    expect(NPC_CARRY_SLOTS).toBe(GAME.maxCarriedItems);
    expect(NPC_CARRY_SLOTS).toBeGreaterThan(1);
    const state = initializeSurvivalState({ result: lootingResult([[line('loot-spot-01', 'maya')]]) });
    const household = state.households[0]!;
    expect(household.characters.filter((character) => character.kind === 'NPC')).toHaveLength(1);
    expect(household.characters).toHaveLength(2);
  });

  it('starts everybody alive, with independent stats per character', () => {
    const state = initializeSurvivalState({
      result: lootingResult([[line('loot-spot-01', 'maya'), line('loot-spot-02', 'gort')]]),
    });
    const characters = state.households.flatMap((household) => household.characters);
    expect(characters).toHaveLength(3);
    expect(characters.every((character) => character.isAlive)).toBe(true);
    const [main, first, second] = characters;
    expect(first?.stats).not.toBe(second?.stats);
    expect(first?.stats.health).not.toBe(second?.stats.health);
    expect(main?.stats.health).not.toBe(first?.stats.health);
  });

  it('applies per-NPC overrides through data, leaving the generic engine alone', () => {
    // Injected rather than edited into the shipped table, so proving override
    // support does not move live balance. The engine is the same one the server
    // calls; only this table differs.
    const overrides: NpcSurvivalOverrideTable = {
      gort: {
        health: { max: 120 },
        strength: { current: 75 },
        nutrition: { max: 80 },
        dailyHydrationCost: 30,
      },
    };
    const state = initializeSurvivalState({
      result: lootingResult([[line('loot-spot-01', 'gort'), line('loot-spot-02', 'maya')]]),
      npcOverrides: overrides,
    });
    const [main, gort, maya] = state.households[0]!.characters;
    expect(gort).toMatchObject({ catalogId: 'gort', dailyHydrationCost: 30, isAlive: true });
    expect(gort?.stats.health).toEqual({ current: 100, max: 120 });
    expect(gort?.stats.strength).toEqual({ current: 75, max: 100 });
    expect(gort?.stats.nutrition).toEqual({ current: 80, max: 80 });
    // Everybody unnamed by the table is untouched, main character included.
    expect(maya?.stats).toEqual(SURVIVAL_CHARACTER_DEFAULTS.stats);
    expect(maya?.dailyHydrationCost).toBe(20);
    expect(main?.stats).toEqual(SURVIVAL_CHARACTER_DEFAULTS.stats);
  });

  it('ships no overrides today, so the roster runs on the defaults', () => {
    expect(Object.keys(NPC_SURVIVAL_OVERRIDES)).toEqual([]);
    const state = initializeSurvivalState({ result: lootingResult([[line('loot-spot-01', 'gort')]]) });
    expect(state.households[0]?.characters[1]?.stats).toEqual(SURVIVAL_CHARACTER_DEFAULTS.stats);
  });

  it('freezes the whole state, because it is one server decision', () => {
    const state = initializeSurvivalState({ result: lootingResult([[line('loot-spot-01', 'maya')]]) });
    const household = state.households[0]!;
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.households)).toBe(true);
    expect(Object.isFrozen(household)).toBe(true);
    expect(Object.isFrozen(household.characters)).toBe(true);
    expect(Object.isFrozen(household.characters[1])).toBe(true);
    expect(Object.isFrozen(household.characters[1]?.stats.health)).toBe(true);
    expect(Object.isFrozen(household.inventory)).toBe(true);
    expect(() => {
      (household.characters[0] as { isAlive: boolean }).isAlive = false;
    }).toThrow(TypeError);
  });

  it('refuses to build a household with a colliding character id', () => {
    // Two banked lines can never share an id today; if the roster ever placed
    // one person twice this fails at the buzzer rather than silently merging.
    expect(() => initializeSurvivalState({
      result: lootingResult([[line('loot-spot-01', 'maya')], [line('loot-spot-01', 'maya')]]),
    })).toThrow(/Duplicate survival character id/);
  });

  it('orders households by the stable room slot', () => {
    const result = lootingResult([[], [], []]);
    const shuffled = matchTallySchema.parse({ ...result, players: [...result.players].reverse() });
    const state = initializeSurvivalState({ result: shuffled });
    expect(state.households.map((household) => household.slot)).toEqual([0, 1, 2]);
  });
});

describe('survival day numbering', () => {
  it('opens the first survival day as Day 1, because looting happens before it', () => {
    expect(SURVIVAL.firstDayNumber).toBe(1);
    const state = initializeSurvivalState({ result: lootingResult([[], []]) });
    expect(state.dayNumber).toBe(1);
    expect(state.dayNumber).toBe(SURVIVAL.firstDayNumber);
  });

  it('carries the day the caller opens rather than a counter of its own', () => {
    // The server owns the number; the engine only records the one it is handed,
    // which is what lets the coming end-of-day flow open Day 2 through this call.
    const result = lootingResult([[]]);
    expect(initializeSurvivalState({ result, dayNumber: 4 }).dayNumber).toBe(4);
    // Nothing else about the day moves with the number: it is not a clock.
    expect(initializeSurvivalState({ result, dayNumber: 4 }).startedAtMs)
      .toBe(initializeSurvivalState({ result }).startedAtMs);
  });

  it('refuses a day that is not a whole day at or after the first', () => {
    const result = lootingResult([[]]);
    for (const dayNumber of [0, -1, 1.5, Number.NaN]) {
      expect(() => initializeSurvivalState({ result, dayNumber })).toThrow();
    }
  });

  it('keeps the day on the frozen state, out of reach of a client', () => {
    const state = initializeSurvivalState({ result: lootingResult([[]]) });
    expect(() => {
      (state as { dayNumber: number }).dayNumber = 9;
    }).toThrow(TypeError);
    expect(state.dayNumber).toBe(SURVIVAL.firstDayNumber);
  });
});
