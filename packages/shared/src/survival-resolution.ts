import { GAME } from './constants.js';
import { combinedSurvivalResources, survivalDeathChance } from './survival-death.js';
import { deepFreezeSurvivalState } from './survival-freeze.js';
import { survivalStateSchema } from './schemas.js';
import type { RandomSource } from './loot-spawn.js';
import type { SurvivalStat } from './survival-table.js';
import type { SurvivalCharacter, SurvivalState } from './schemas.js';

/**
 * The end-of-day resolution engine: it closes one survival day and opens the
 * next one.
 *
 * Like the initialization engine beside it, this module reads no clock, no
 * socket, and no client message. It is a pure function of the day that is
 * ending, the one authoritative timestamp the server hands it, and the one
 * random source the server hands it — which is what makes a resolved day
 * reproducible from the state and the seed it resolved with.
 *
 * It resolves three things: the daily Nutrition and Hydration drain, the
 * overnight death roll against what that drain leaves standing, and the day
 * number. Random events are deliberately absent.
 */

export interface ResolveSurvivalDayOptions {
  /**
   * The day that is ending. Never mutated: the returned state is a separate
   * object, so a caller holding the closing day still holds it unchanged.
   */
  state: SurvivalState;
  /**
   * The authoritative moment the ending day closed, which is also the moment
   * the next one opens.
   *
   * The server owns it and must have it inside the closing day's own window:
   * every household ending early closes the day early, and a late server tick
   * can never stretch a day past its own 120-second deadline. No client
   * supplies it, and nothing here reads a clock to make one up.
   */
  resolvedAtMs: number;
  /**
   * The source of the night's death rolls. Defaults to `Math.random`; a test or
   * a reproduced bug report passes a seeded one instead.
   *
   * It is drawn from exactly once per living character who is actually at risk,
   * in household order and then roster order, so a scripted source lines up
   * with the characters in danger and a healthy household consumes nothing.
   */
  random?: RandomSource;
}

/**
 * Resolves the ending day's resource drain and returns **the next day's**
 * authoritative state: the same households, characters, and inventories,
 * carrying their post-drain Nutrition and Hydration into an incremented
 * `dayNumber` that starts at `resolvedAtMs`.
 *
 * The night is spent in that order, per character: the day's costs first, then
 * one death roll against what those costs left standing. Draining first is what
 * makes the odds honest — a character is judged on the resources they actually
 * enter the new day with, not on the ones they spent getting there — and it is
 * also why feeding somebody late in the day genuinely saves them.
 *
 * The dead are carried over untouched: they neither drain nor roll again.
 *
 * Being pure, this function drains once per call — it has no memory of days. A
 * day resolving exactly once is the caller's guarantee, and the server keeps it
 * by resolving only on the tick that first observes every household ended.
 */
export function resolveSurvivalDay(options: ResolveSurvivalDayOptions): SurvivalState {
  const { state, resolvedAtMs } = options;
  assertWithinDay(state, resolvedAtMs);
  const random = options.random ?? Math.random;
  const households = state.households.map((household) => ({
    ...household,
    characters: household.characters.map((character) => spendNight(character, random)),
  }));
  // Parsed rather than trusted, exactly as the opening state is: a drain that
  // produced an impossible number fails here instead of reaching a client, and
  // the parse is also what copies every nested value out of the closing day.
  const parsed = survivalStateSchema.parse({
    ...state,
    // The one place a survival day number ever changes. It is a whole-number
    // increment on the server's own state, never a value a client sent.
    dayNumber: state.dayNumber + 1,
    startedAtMs: resolvedAtMs,
    households,
  });
  return deepFreezeSurvivalState(parsed);
}

/**
 * One character's whole night: the day's costs, then the death roll they leave
 * them facing.
 *
 * The odds come from {@link projectedSurvivalDeathChance} on the character as
 * they were, rather than from a second lookup on the drained copy, so the
 * chance the server rolls against is provably the same number a screen can warn
 * the player about before they end the day.
 */
function spendNight(character: SurvivalCharacter, random: RandomSource): SurvivalCharacter {
  const chance = projectedSurvivalDeathChance(character);
  const drained = drainSurvivalCharacter(character);
  // `random()` is in [0, 1), so a chance of 0.99 kills 99% of the time and a
  // chance of 1 would always kill. Only drawn when there is something at stake.
  if (chance > 0 && random() < chance) return { ...drained, isAlive: false };
  return drained;
}

/**
 * The chance this character dies tonight if nothing more is fed to them today.
 *
 * Exported because it is the honest answer to "what am I risking?": it projects
 * the day's own costs before reading the bands, which is exactly what
 * resolution does, so a warning built on it cannot drift from the roll.
 */
export function projectedSurvivalDeathChance(character: SurvivalCharacter): number {
  if (!character.isAlive) return 0;
  return survivalDeathChance(combinedSurvivalResources(drainSurvivalCharacter(character)));
}

/**
 * Spends one day of a character's own costs.
 *
 * Costs are per character, so two people in one household drain by different
 * amounts, and only Nutrition and Hydration move — Health, Survival, Morale,
 * and Strength are untouched by the passage of a day.
 */
export function drainSurvivalCharacter(character: SurvivalCharacter): SurvivalCharacter {
  // The dead eat and drink nothing. Their stats are carried into the new day
  // verbatim so a corpse cannot keep sinking toward a second, deeper death.
  if (!character.isAlive) return character;
  return {
    ...character,
    stats: {
      ...character.stats,
      nutrition: drainStat(character.stats.nutrition, character.dailyNutritionCost),
      hydration: drainStat(character.stats.hydration, character.dailyHydrationCost),
    },
  };
}

/**
 * Clamped at zero rather than allowed to go negative: 0 is the worst value a
 * survival stat has, and a negative one would let a character bank a debt that
 * a later feed would silently pay off.
 */
function drainStat(stat: SurvivalStat, dailyCost: number): SurvivalStat {
  return { current: Math.max(0, stat.current - dailyCost), max: stat.max };
}

/**
 * A resolution timestamp outside the closing day's window is a server bug, and
 * a loud one: it would open the next day before the last one started, or claim
 * a day longer than the only duration `GAME` defines.
 */
function assertWithinDay(state: SurvivalState, resolvedAtMs: number): void {
  const endsAtMs = state.startedAtMs + GAME.survivalDurationMs;
  if (!Number.isInteger(resolvedAtMs) || resolvedAtMs < state.startedAtMs || resolvedAtMs > endsAtMs) {
    throw new Error(
      `Survival day ${state.dayNumber} cannot resolve at ${resolvedAtMs}, `
      + `outside its window ${state.startedAtMs}..${endsAtMs}`,
    );
  }
}
