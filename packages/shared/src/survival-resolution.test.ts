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
import { projectedSurvivalDeathChance, resolveSurvivalDay } from './survival-resolution.js';
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
    // A roll of 1 is under no chance, so this stays a test about the clamp
    // rather than a test about the death it would otherwise trigger.
    const next = resolveSurvivalDay({ state: day, resolvedAtMs: DAY_DEADLINE_MS, random: () => 1 });

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

  it('leaves the four stats a day does not touch, even on the night it kills', () => {
    const day = openDay([{
      playerId: 'player-0',
      characters: [character('player-0', {
        stats: stats({ nutrition: { current: 10, max: 100 }, hydration: { current: 10, max: 100 } }),
      })],
    }]);
    // Combined resources land at 0, which is the worst band there is, and the
    // roll takes it. Dying still moves none of the other four stats: death is a
    // flag on the character, not damage applied to them.
    const next = resolveSurvivalDay({ state: day, resolvedAtMs: DAY_DEADLINE_MS, random: () => 0 });
    const resolved = next.households[0]!.characters[0]!;

    expect(resolved.stats).toMatchObject({
      health: SURVIVAL_CHARACTER_DEFAULTS.stats.health,
      survival: SURVIVAL_CHARACTER_DEFAULTS.stats.survival,
      morale: SURVIVAL_CHARACTER_DEFAULTS.stats.morale,
      strength: SURVIVAL_CHARACTER_DEFAULTS.stats.strength,
    });
    expect(resolved.stats.nutrition.current + resolved.stats.hydration.current).toBe(0);
    expect(resolved.isAlive).toBe(false);
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

describe('overnight death rolls', () => {
  /** A character who will be at `nutrition`/`hydration` once the day is paid. */
  function endingAt(id: string, nutrition: number, hydration: number): SurvivalCharacter {
    const cost = SURVIVAL_CHARACTER_DEFAULTS.dailyNutritionCost;
    return character(id, {
      stats: stats({
        nutrition: { current: nutrition + cost, max: 100 },
        hydration: { current: hydration + cost, max: 100 },
      }),
    });
  }

  function resolveWith(
    characters: readonly SurvivalCharacter[],
    random: () => number,
  ): readonly SurvivalCharacter[] {
    const day = openDay([{ playerId: 'player-0', characters }]);
    return resolveSurvivalDay({ state: day, resolvedAtMs: DAY_DEADLINE_MS, random })
      .households[0]!.characters;
  }

  it('kills on a roll under the band chance and spares one on the chance itself', () => {
    // Ends the day on 10 + 0, which is under 20 but not under 10: a 50% night.
    const atRisk = [endingAt('player-0', 10, 0)];

    expect(resolveWith(atRisk, () => 0.49)[0]?.isAlive).toBe(false);
    // `random()` is in [0, 1), so the comparison is strict and 0.5 survives —
    // which is what makes a 50% chance 50% rather than a hair more.
    expect(resolveWith(atRisk, () => 0.5)[0]?.isAlive).toBe(true);
  });

  it('uses the odds the balance table publishes for each band', () => {
    const bands: readonly [SurvivalCharacter, number][] = [
      [endingAt('player-0', 0, 0), 0.99],
      [endingAt('player-0', 5, 4), 0.8],
      [endingAt('player-0', 10, 9), 0.5],
      [endingAt('player-0', 10, 10), 0],
    ];
    for (const [member, chance] of bands) {
      expect(projectedSurvivalDeathChance(member)).toBe(chance);
      // The published chance is exactly the threshold the roll is compared
      // against: a hair under it kills, the chance itself does not.
      expect(resolveWith([member], () => Math.max(0, chance - 0.001))[0]?.isAlive).toBe(chance === 0);
      expect(resolveWith([member], () => chance)[0]?.isAlive).toBe(true);
    }
  });

  it('reads the band from what the day cost, not from what the character had', () => {
    // Starts the day full and still ends it on 5 + 5, because this character
    // burns 95 of each: the night judges the resources they are left holding.
    const hungry = character('player-0', {
      dailyNutritionCost: 95,
      dailyHydrationCost: 95,
      stats: stats({ nutrition: { current: 100, max: 100 }, hydration: { current: 100, max: 100 } }),
    });

    expect(projectedSurvivalDeathChance(hungry)).toBe(0.5);
    expect(resolveWith([hungry], () => 0.4)[0]?.isAlive).toBe(false);
  });

  it('does not roll for a household the day leaves in no danger', () => {
    const fed = [character('player-0'), character('npc-1', { kind: 'NPC', catalogId: 'bryne' })];
    // Drawing at all for a safe character would be the bug: a night nobody is
    // at risk in has no random outcome to reach for.
    const next = resolveWith(fed, () => { throw new Error('rolled for a safe household'); });

    expect(next.every((member) => member.isAlive)).toBe(true);
  });

  it('draws once per at-risk character, in roster order, skipping the safe', () => {
    const rolls = [0.9, 0.1];
    const roster = [
      // 50% and spared by 0.9.
      endingAt('player-0', 15, 0),
      // Safe, and takes no draw — which is what lines the next roll up with Mim.
      character('npc-safe', { kind: 'NPC', catalogId: 'bryne' }),
      // 80% and taken by 0.1.
      endingAt('npc-mim', 4, 0),
    ];
    const next = resolveWith(roster, () => rolls.shift()!);

    expect(next.map((member) => member.isAlive)).toEqual([true, true, false]);
    expect(rolls).toHaveLength(0);
  });

  it('rolls each household separately, in slot order', () => {
    // Both are empty, so both face 99%: the first is the one in a hundred who
    // wakes up, the second is not.
    const rolls = [0.995, 0.1];
    const day = openDay([
      { playerId: 'player-0', characters: [endingAt('player-0', 0, 0)] },
      { playerId: 'player-1', characters: [endingAt('player-1', 0, 0)] },
    ]);
    const next = resolveSurvivalDay({
      state: day,
      resolvedAtMs: DAY_DEADLINE_MS,
      random: () => rolls.shift()!,
    });

    expect(next.households.map((house) => house.characters[0]?.isAlive)).toEqual([true, false]);
  });

  it('never rolls the dead a second time', () => {
    const dead = character('npc-1', {
      kind: 'NPC',
      catalogId: 'bryne',
      isAlive: false,
      stats: stats({ nutrition: { current: 0, max: 100 }, hydration: { current: 0, max: 100 } }),
    });
    // Empty and dead: the worst band there is, and still no draw for them.
    expect(projectedSurvivalDeathChance(dead)).toBe(0);

    const next = resolveWith(
      [character('player-0'), dead],
      () => { throw new Error('rolled for a corpse'); },
    );
    expect(next[1]).toEqual(dead);
  });

  it('kills without touching anything else the new day carries', () => {
    const day = openDay([{
      playerId: 'player-0',
      characters: [endingAt('player-0', 0, 0), character('npc-1', { kind: 'NPC', catalogId: 'bryne' })],
    }]);
    const next = resolveSurvivalDay({ state: day, resolvedAtMs: DAY_DEADLINE_MS, random: () => 0 });
    const killed = next.households[0]!.characters[0]!;

    expect(killed.isAlive).toBe(false);
    expect(killed.dailyNutritionCost).toBe(SURVIVAL_CHARACTER_DEFAULTS.dailyNutritionCost);
    // A death is one flag on one character: the day still advances, the rest of
    // the household is untouched, and the result is frozen like any other.
    expect(next.dayNumber).toBe(SURVIVAL.firstDayNumber + 1);
    expect(next.households[0]?.characters[1]?.isAlive).toBe(true);
    expect(Object.isFrozen(killed)).toBe(true);
    expect(day.households[0]?.characters[0]?.isAlive).toBe(true);
  });

  it('defaults to Math.random when the caller supplies no source', () => {
    const day = openDay([{ playerId: 'player-0', characters: [endingAt('player-0', 0, 0)] }]);
    const rolls = [0.5, 0.999];
    const original = Math.random;
    Math.random = () => rolls.shift()!;
    try {
      // 99% odds: the first roll takes them, the second is one of the 1% who
      // wake up. Both go through the same default the server relies on.
      expect(resolveSurvivalDay({ state: day, resolvedAtMs: DAY_DEADLINE_MS })
        .households[0]?.characters[0]?.isAlive).toBe(false);
      expect(resolveSurvivalDay({ state: day, resolvedAtMs: DAY_DEADLINE_MS })
        .households[0]?.characters[0]?.isAlive).toBe(true);
    } finally {
      Math.random = original;
    }
  });
});
