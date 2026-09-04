import { describe, expect, it } from 'vitest';
import { carryableEntry } from './carryable.js';
import { GAME, SURVIVAL } from './constants.js';
import {
  matchTallySchema,
  survivalStateSchema,
  type SurvivalCharacter,
  type SurvivalHousehold,
  type SurvivalState,
} from './schemas.js';
import { initializeSurvivalState } from './survival.js';
import { resolveSurvivalDay } from './survival-resolution.js';
import { SURVIVAL_CHARACTER_DEFAULTS, type SurvivalStatKey } from './survival-table.js';

const DAY_OPENED_AT_MS = 71_000;
const DAY_DEADLINE_MS = DAY_OPENED_AT_MS + GAME.survivalDurationMs;

function stats(
  overrides: Partial<Record<SurvivalStatKey, { current: number; max: number }>> = {},
): SurvivalCharacter['stats'] {
  return { ...SURVIVAL_CHARACTER_DEFAULTS.stats, ...overrides };
}

/** A main character on the shipped defaults unless a test says otherwise. */
function character(id: string, overrides: Partial<SurvivalCharacter> = {}): SurvivalCharacter {
  return {
    id,
    displayName: id,
    kind: 'MAIN',
    catalogId: null,
    isAlive: true,
    stats: stats(),
    dailyNutritionCost: SURVIVAL_CHARACTER_DEFAULTS.dailyNutritionCost,
    dailyHydrationCost: SURVIVAL_CHARACTER_DEFAULTS.dailyHydrationCost,
    ...overrides,
  };
}

/** One open day, built through the real schema the server parses states with. */
function openDay(
  households: readonly { playerId: string; characters: readonly SurvivalCharacter[] }[],
  dayNumber: number = SURVIVAL.firstDayNumber,
): SurvivalState {
  return survivalStateSchema.parse({
    stateId: `survival:ABC234:${DAY_OPENED_AT_MS}`,
    roomCode: 'ABC234',
    dayNumber,
    startedAtMs: DAY_OPENED_AT_MS,
    households: households.map((household, slot) => ({
      playerId: household.playerId,
      displayName: household.playerId,
      slot,
      characters: household.characters,
      inventory: [],
    })),
  });
}

function nutritionAndHydration(household: SurvivalHousehold): readonly [number, number][] {
  return household.characters.map((member) => [
    member.stats.nutrition.current,
    member.stats.hydration.current,
  ]);
}

describe('resolveSurvivalDay', () => {
  it('spends each daily cost exactly once and opens the next day on the resolution time', () => {
    const day = openDay([{ playerId: 'player-0', characters: [character('player-0')] }]);
    const next = resolveSurvivalDay({ state: day, resolvedAtMs: DAY_OPENED_AT_MS + 30_000 });

    expect(next.dayNumber).toBe(SURVIVAL.firstDayNumber + 1);
    expect(next.startedAtMs).toBe(DAY_OPENED_AT_MS + 30_000);
    expect(next.households[0]?.characters[0]?.stats).toMatchObject({
      nutrition: { current: 80, max: 100 },
      hydration: { current: 80, max: 100 },
    });
    // The costs themselves are per-character data and are never spent down.
    expect(next.households[0]?.characters[0]).toMatchObject({
      dailyNutritionCost: 20,
      dailyHydrationCost: 20,
    });
  });

  it('deducts one day per resolution rather than compounding within one call', () => {
    const day = openDay([{ playerId: 'player-0', characters: [character('player-0')] }]);
    const dayTwo = resolveSurvivalDay({ state: day, resolvedAtMs: DAY_OPENED_AT_MS });
    const dayThree = resolveSurvivalDay({ state: dayTwo, resolvedAtMs: dayTwo.startedAtMs });

    expect(dayTwo.households[0]?.characters[0]?.stats.nutrition.current).toBe(80);
    expect(dayThree.households[0]?.characters[0]?.stats.nutrition.current).toBe(60);
    expect(dayThree.dayNumber).toBe(SURVIVAL.firstDayNumber + 2);
  });

  it('clamps an exhausted character at zero instead of banking a negative debt', () => {
    const day = openDay([{
      playerId: 'player-0',
      characters: [character('player-0', {
        stats: stats({ nutrition: { current: 5, max: 100 }, hydration: { current: 0, max: 100 } }),
      })],
    }]);
    const next = resolveSurvivalDay({ state: day, resolvedAtMs: DAY_DEADLINE_MS });

    expect(next.households[0]?.characters[0]?.stats).toMatchObject({
      nutrition: { current: 0, max: 100 },
      hydration: { current: 0, max: 100 },
    });
  });

  it('spends each character its own costs, including a zero-cost one', () => {
    const day = openDay([{
      playerId: 'player-0',
      characters: [
        character('player-0', { dailyNutritionCost: 20, dailyHydrationCost: 35 }),
        character('npc-1', {
          kind: 'NPC',
          catalogId: 'bryne',
          dailyNutritionCost: 5,
          dailyHydrationCost: 0,
          stats: stats({ nutrition: { current: 60, max: 80 }, hydration: { current: 60, max: 80 } }),
        }),
      ],
    }]);
    const next = resolveSurvivalDay({ state: day, resolvedAtMs: DAY_OPENED_AT_MS + 1 });

    expect(nutritionAndHydration(next.households[0]!)).toEqual([[80, 65], [55, 60]]);
    // A per-character max is preserved: only `current` moves.
    expect(next.households[0]?.characters[1]?.stats.nutrition.max).toBe(80);
  });

  it('does not drain the dead, and leaves their remaining stats exactly as they were', () => {
    const dead = character('npc-1', {
      kind: 'NPC',
      catalogId: 'bryne',
      isAlive: false,
      stats: stats({ nutrition: { current: 4, max: 100 }, hydration: { current: 9, max: 100 } }),
    });
    const day = openDay([{ playerId: 'player-0', characters: [character('player-0'), dead] }]);
    const next = resolveSurvivalDay({ state: day, resolvedAtMs: DAY_OPENED_AT_MS + 10_000 });

    expect(nutritionAndHydration(next.households[0]!)).toEqual([[80, 80], [4, 9]]);
    expect(next.households[0]?.characters[1]).toEqual(dead);
  });

  it('leaves the four stats a day does not touch, and kills nobody', () => {
    const day = openDay([{
      playerId: 'player-0',
      characters: [character('player-0', {
        stats: stats({ nutrition: { current: 10, max: 100 }, hydration: { current: 10, max: 100 } }),
      })],
    }]);
    const next = resolveSurvivalDay({ state: day, resolvedAtMs: DAY_DEADLINE_MS });
    const resolved = next.households[0]!.characters[0]!;

    expect(resolved.stats).toMatchObject({
      health: SURVIVAL_CHARACTER_DEFAULTS.stats.health,
      survival: SURVIVAL_CHARACTER_DEFAULTS.stats.survival,
      morale: SURVIVAL_CHARACTER_DEFAULTS.stats.morale,
      strength: SURVIVAL_CHARACTER_DEFAULTS.stats.strength,
    });
    // Combined nutrition + hydration is 0 here, which the coming death rules
    // read. Resolution itself never kills: it only leaves the numbers standing.
    expect(resolved.stats.nutrition.current + resolved.stats.hydration.current).toBe(0);
    expect(resolved.isAlive).toBe(true);
  });

  it('carries every household, character, and deposited item into the new day', () => {
    const banked = ['canned-soup', 'bryne'].map((catalogId, index) => {
      const entry = carryableEntry(catalogId);
      return { id: `item-${index}`, catalogId, label: entry.label, category: entry.category };
    });
    const result = matchTallySchema.parse({
      resultId: `ABC234:${DAY_OPENED_AT_MS}`,
      roomCode: 'ABC234',
      lootingStartedAtMs: DAY_OPENED_AT_MS - GAME.lootingDurationMs,
      lootingEndedAtMs: DAY_OPENED_AT_MS,
      durationMs: GAME.lootingDurationMs,
      players: [0, 1].map((slot) => ({
        playerId: `player-${slot}`,
        displayName: `Player ${slot}`,
        slot,
        isConnectedAtEnd: true,
        items: slot === 0 ? banked : [],
        categoryTotals: [],
        totalItems: slot === 0 ? banked.length : 0,
      })),
      categoryTotals: [],
      totalItems: banked.length,
    });
    const dayOne = initializeSurvivalState({ result });
    const dayTwo = resolveSurvivalDay({ state: dayOne, resolvedAtMs: DAY_DEADLINE_MS });

    expect(dayTwo.stateId).toBe(dayOne.stateId);
    expect(dayTwo.roomCode).toBe(dayOne.roomCode);
    expect(dayTwo.households.map((household) => household.playerId))
      .toEqual(dayOne.households.map((household) => household.playerId));
    expect(dayTwo.households.map((household) => household.inventory))
      .toEqual(dayOne.households.map((household) => household.inventory));
    // The recruit stays a household member across the day boundary.
    expect(dayTwo.households[0]?.characters.map((member) => member.id))
      .toEqual(dayOne.households[0]?.characters.map((member) => member.id));
    expect(nutritionAndHydration(dayTwo.households[0]!)).toEqual([[80, 80], [80, 80]]);
  });

  it('returns a deep-frozen day without touching the one it resolved', () => {
    const dayOne = openDay([{ playerId: 'player-0', characters: [character('player-0')] }]);
    const dayTwo = resolveSurvivalDay({ state: dayOne, resolvedAtMs: DAY_OPENED_AT_MS });

    expect(Object.isFrozen(dayTwo)).toBe(true);
    expect(Object.isFrozen(dayTwo.households[0])).toBe(true);
    expect(Object.isFrozen(dayTwo.households[0]?.characters[0]?.stats.nutrition)).toBe(true);
    // The closing day is left alone, so a caller may still read what was spent.
    expect(dayOne.dayNumber).toBe(SURVIVAL.firstDayNumber);
    expect(dayOne.households[0]?.characters[0]?.stats.nutrition.current).toBe(100);
  });

  it('refuses a resolution time outside the day it is closing', () => {
    const day = openDay([{ playerId: 'player-0', characters: [character('player-0')] }]);
    for (const resolvedAtMs of [DAY_OPENED_AT_MS - 1, DAY_DEADLINE_MS + 1, DAY_OPENED_AT_MS + 0.5]) {
      expect(() => resolveSurvivalDay({ state: day, resolvedAtMs })).toThrow(/cannot resolve/);
    }
    // The boundaries themselves are legal: a day may end the instant it opened
    // and may run exactly its full 120 seconds.
    expect(resolveSurvivalDay({ state: day, resolvedAtMs: DAY_OPENED_AT_MS }).startedAtMs)
      .toBe(DAY_OPENED_AT_MS);
    expect(resolveSurvivalDay({ state: day, resolvedAtMs: DAY_DEADLINE_MS }).startedAtMs)
      .toBe(DAY_DEADLINE_MS);
  });
});
