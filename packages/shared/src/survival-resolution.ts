import { GAME } from './constants.js';
import { deepFreezeSurvivalState } from './survival-freeze.js';
import { survivalStateSchema } from './schemas.js';
import type { SurvivalStat } from './survival-table.js';
import type { SurvivalCharacter, SurvivalState } from './schemas.js';

/**
 * The end-of-day resolution engine: it closes one survival day and opens the
 * next one.
 *
 * Like the initialization engine beside it, this module reads no clock, no
 * socket, and no client message. It is a pure function of the day that is
 * ending plus the one authoritative timestamp the server hands it, which is
 * what makes a resolved day reproducible from the state it resolved.
 *
 * It resolves exactly two things today — the daily Nutrition and Hydration
 * drain, and the day number — because those are the two the next task needs to
 * be authoritative. Feeding, item consumption, the death rolls that read the
 * drained values, and random events are deliberately absent.
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
}

/**
 * Resolves the ending day's resource drain and returns **the next day's**
 * authoritative state: the same households, characters, and inventories,
 * carrying their post-drain Nutrition and Hydration into an incremented
 * `dayNumber` that starts at `resolvedAtMs`.
 *
 * Nobody is killed here. Drained values are clamped at 0 and left standing as
 * the authoritative numbers, which is exactly what the coming death rules read
 * when they compare combined Nutrition + Hydration against their thresholds.
 *
 * Being pure, this function drains once per call — it has no memory of days. A
 * day resolving exactly once is the caller's guarantee, and the server keeps it
 * by resolving only on the tick that first observes every household ended.
 */
export function resolveSurvivalDay(options: ResolveSurvivalDayOptions): SurvivalState {
  const { state, resolvedAtMs } = options;
  assertWithinDay(state, resolvedAtMs);
  const households = state.households.map((household) => ({
    ...household,
    characters: household.characters.map(drainCharacter),
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
 * Spends one day of a character's own costs.
 *
 * Costs are per character, so two people in one household drain by different
 * amounts, and only Nutrition and Hydration move — Health, Survival, Morale,
 * and Strength are untouched by the passage of a day.
 */
function drainCharacter(character: SurvivalCharacter): SurvivalCharacter {
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
