/**
 * THE SURVIVAL BALANCE TABLE. This is the one file to edit when tuning what a
 * character starts the survival day with, or when giving one person different
 * numbers from everybody else.
 *
 * Everything here is data. Nothing in this file imports game logic, so editing
 * it can change the balance but cannot change how initialization works — the
 * generic engine in `survival.ts` reads these values and never hard-codes one.
 * That is the whole point of the split: a future NPC with 120 max health is a
 * one-line edit here, not a change to the initialization path.
 */

/**
 * Every stat a survival character has, in a stable display order.
 *
 * All six share one semantic direction: **higher is better, lower is worse, and
 * 0 is the worst possible value.** Nothing downstream needs a per-stat sign
 * table, and a future rule can compare or sum any of them without asking which
 * way a particular stat points.
 */
export const SURVIVAL_STAT_KEYS = [
  'health',
  'survival',
  'morale',
  'strength',
  'nutrition',
  'hydration',
] as const;

export type SurvivalStatKey = (typeof SURVIVAL_STAT_KEYS)[number];

/**
 * One stat, always as a current/max pair. `max` is per-character and per-stat:
 * 100 is only the default scale, never an assumption any other code may make.
 */
export interface SurvivalStat {
  current: number;
  max: number;
}

/**
 * Sanity ceiling for any stat value or daily cost. It is a guard rail against a
 * typo or an overflowed number reaching the wire, **not** the scale — a max of
 * 100 is the default, a max of 120 or 4,000 is equally legal.
 */
export const SURVIVAL_STAT_CEILING = 10_000;

export interface SurvivalCharacterBalance {
  stats: Readonly<Record<SurvivalStatKey, Readonly<SurvivalStat>>>;
  /** Nutrition removed at the end of each day. A plain amount, not a pair. */
  dailyNutritionCost: number;
  /** Hydration removed at the end of each day. A plain amount, not a pair. */
  dailyHydrationCost: number;
}

/**
 * What every character starts with unless something overrides it. These are
 * placeholders chosen for a first playable day, not final balance.
 *
 * Frozen so a mutated character can never write back into the defaults; the
 * engine copies every value out rather than sharing these objects.
 */
export const SURVIVAL_CHARACTER_DEFAULTS: SurvivalCharacterBalance = Object.freeze({
  stats: Object.freeze({
    health: Object.freeze({ current: 100, max: 100 }),
    survival: Object.freeze({ current: 50, max: 100 }),
    morale: Object.freeze({ current: 100, max: 100 }),
    strength: Object.freeze({ current: 50, max: 100 }),
    nutrition: Object.freeze({ current: 100, max: 100 }),
    hydration: Object.freeze({ current: 100, max: 100 }),
  }),
  dailyNutritionCost: 20,
  dailyHydrationCost: 20,
});

/** A partial stat override: give `current`, `max`, or both. */
export interface SurvivalStatOverride {
  current?: number;
  max?: number;
}

/**
 * Any subset of a character's starting numbers. Absent keys fall back to
 * {@link SURVIVAL_CHARACTER_DEFAULTS}, so an override says only what differs.
 *
 * Raising a `max` does not by itself fill the stat: `{ health: { max: 120 } }`
 * starts that character at 100/120, because `current` still comes from the
 * defaults. Declare `current` too when a bigger tank should also start full.
 * Lowering a `max` below the default `current` does clamp it, so
 * `{ nutrition: { max: 80 } }` starts at 80/80 rather than at an impossible
 * 100/80.
 */
export interface SurvivalCharacterOverrides {
  health?: SurvivalStatOverride;
  survival?: SurvivalStatOverride;
  morale?: SurvivalStatOverride;
  strength?: SurvivalStatOverride;
  nutrition?: SurvivalStatOverride;
  hydration?: SurvivalStatOverride;
  dailyNutritionCost?: number;
  dailyHydrationCost?: number;
}

/** Per-NPC starting numbers, keyed by the NPC catalog id from `npc-table.ts`. */
export type NpcSurvivalOverrideTable = Readonly<Record<string, SurvivalCharacterOverrides>>;

/**
 * Per-person balance overrides. Empty on purpose: every NPC on the roster today
 * uses the defaults above.
 *
 * To give one person their own numbers, add an entry keyed by their catalog id
 * and nothing else changes — the initialization engine already reads this table:
 *
 * ```ts
 * export const NPC_SURVIVAL_OVERRIDES: NpcSurvivalOverrideTable = {
 *   gort: { health: { max: 120 }, strength: { current: 75 }, dailyHydrationCost: 30 },
 * };
 * ```
 */
export const NPC_SURVIVAL_OVERRIDES: NpcSurvivalOverrideTable = Object.freeze({});

/**
 * One overnight death band: the chance of dying tonight for a character whose
 * combined Nutrition + Hydration falls **below** `combinedBelow`.
 */
export interface SurvivalDeathRiskBand {
  combinedBelow: number;
  /** Probability in 0..1. */
  chance: number;
}

export interface SurvivalDeathRiskTable {
  /**
   * Nothing left at all — Nutrition and Hydration both empty. Its own entry
   * rather than a band, because "0 combined" is an exact value while every
   * band below is a strict range.
   */
  emptyChance: number;
  /**
   * Ordered worst-first: the first band a combined value falls under applies,
   * and a value under none of them is not at risk at all.
   */
  bands: readonly SurvivalDeathRiskBand[];
}

/**
 * THE OVERNIGHT DEATH ODDS. A character is rolled against these once per day,
 * on the resources they are left holding after that day's costs are spent — so
 * these read as "starve the day, risk the night".
 *
 * Data, like everything else in this file: the rule that reads it lives in
 * `survival-death.ts` and hard-codes none of these numbers.
 */
export const SURVIVAL_DEATH_RISKS: SurvivalDeathRiskTable = Object.freeze({
  emptyChance: 0.99,
  bands: Object.freeze([
    Object.freeze({ combinedBelow: 10, chance: 0.8 }),
    Object.freeze({ combinedBelow: 20, chance: 0.5 }),
  ]),
});
