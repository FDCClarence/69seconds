import { describe, expect, it } from 'vitest';
import { combinedSurvivalResources, survivalDeathChance } from './survival-death.js';
import {
  SURVIVAL_CHARACTER_DEFAULTS,
  SURVIVAL_DEATH_RISKS,
  type SurvivalDeathRiskTable,
  type SurvivalStatKey,
} from './survival-table.js';
import type { SurvivalCharacter } from './schemas.js';

function character(overrides: Partial<Record<SurvivalStatKey, { current: number; max: number }>>): SurvivalCharacter {
  return {
    id: 'player-0',
    displayName: 'Player 0',
    kind: 'MAIN',
    catalogId: null,
    isAlive: true,
    stats: { ...SURVIVAL_CHARACTER_DEFAULTS.stats, ...overrides },
    dailyNutritionCost: SURVIVAL_CHARACTER_DEFAULTS.dailyNutritionCost,
    dailyHydrationCost: SURVIVAL_CHARACTER_DEFAULTS.dailyHydrationCost,
  };
}

describe('SURVIVAL_DEATH_RISKS', () => {
  it('publishes the shipped odds', () => {
    // The balance this task set, asserted outright: a change to any of these
    // three numbers is a deliberate balance edit, not a refactor.
    expect(SURVIVAL_DEATH_RISKS.emptyChance).toBe(0.99);
    expect(SURVIVAL_DEATH_RISKS.bands).toEqual([
      { combinedBelow: 10, chance: 0.8 },
      { combinedBelow: 20, chance: 0.5 },
    ]);
  });

  it('orders its bands worst-first, which is what the lookup relies on', () => {
    const bounds = SURVIVAL_DEATH_RISKS.bands.map((band) => band.combinedBelow);
    expect([...bounds].sort((left, right) => left - right)).toEqual(bounds);
    for (const band of SURVIVAL_DEATH_RISKS.bands) {
      expect(band.chance).toBeGreaterThan(0);
      expect(band.chance).toBeLessThanOrEqual(1);
    }
  });

  it('is frozen, so no caller can retune live balance', () => {
    expect(Object.isFrozen(SURVIVAL_DEATH_RISKS)).toBe(true);
    expect(Object.isFrozen(SURVIVAL_DEATH_RISKS.bands)).toBe(true);
  });
});

describe('survivalDeathChance', () => {
  it('reads each band, worst-first', () => {
    expect(survivalDeathChance(0)).toBe(0.99);
    expect(survivalDeathChance(1)).toBe(0.8);
    expect(survivalDeathChance(9)).toBe(0.8);
    expect(survivalDeathChance(10)).toBe(0.5);
    expect(survivalDeathChance(19)).toBe(0.5);
    expect(survivalDeathChance(20)).toBe(0);
    expect(survivalDeathChance(200)).toBe(0);
  });

  it('treats each bound as strict, including on a fractional value', () => {
    // A stat max is per-character data rather than a scale, so a combined value
    // between two whole numbers is legal. 0.5 is not "nothing left"; 9.5 is
    // still under 10; 19.5 is still under 20.
    expect(survivalDeathChance(0.5)).toBe(0.8);
    expect(survivalDeathChance(9.5)).toBe(0.8);
    expect(survivalDeathChance(19.5)).toBe(0.5);
    expect(survivalDeathChance(20.5)).toBe(0);
  });

  it('reads an injected table instead of the shipped one', () => {
    const harsher: SurvivalDeathRiskTable = {
      emptyChance: 1,
      bands: [{ combinedBelow: 50, chance: 0.25 }],
    };
    expect(survivalDeathChance(0, harsher)).toBe(1);
    expect(survivalDeathChance(49, harsher)).toBe(0.25);
    expect(survivalDeathChance(50, harsher)).toBe(0);
  });

  it('refuses a value no survival stat could produce', () => {
    // Stats are schema-nonnegative and finite, so either of these is a caller
    // bug worth failing on rather than a band to guess at.
    expect(() => survivalDeathChance(-1)).toThrow(/non-negative/);
    expect(() => survivalDeathChance(Number.NaN)).toThrow(/non-negative/);
    expect(() => survivalDeathChance(Number.POSITIVE_INFINITY)).toThrow(/non-negative/);
  });
});

describe('combinedSurvivalResources', () => {
  it('adds the two current values and ignores the maxes', () => {
    expect(combinedSurvivalResources(character({
      nutrition: { current: 12, max: 100 },
      hydration: { current: 3, max: 80 },
    }))).toBe(15);
  });

  it('counts only food and water, not the four stats a day does not spend', () => {
    // Full health and morale are no defence against having nothing to eat.
    expect(combinedSurvivalResources(character({
      nutrition: { current: 0, max: 100 },
      hydration: { current: 0, max: 100 },
      health: { current: 100, max: 100 },
      morale: { current: 100, max: 100 },
    }))).toBe(0);
  });
});
