import { SURVIVAL_DEATH_RISKS, type SurvivalDeathRiskTable } from './survival-table.js';
import type { SurvivalCharacter } from './schemas.js';

/**
 * The overnight death rule.
 *
 * A character who ends a day short of food and water may not wake up: the odds
 * are read from the balance table by band, and nothing in here draws a random
 * number or decides anybody's fate. Looking up a chance is separate from
 * spending one on purpose — the same lookup answers "will this kill them?" for
 * the server that rolls it and "what am I risking?" for the screen that warns
 * about it, and the two can never disagree about the odds.
 */

/**
 * The number the death bands are read against: how much food and water a
 * character is holding, counted together, because a full stomach does not make
 * up for having nothing to drink.
 */
export function combinedSurvivalResources(character: SurvivalCharacter): number {
  return character.stats.nutrition.current + character.stats.hydration.current;
}

/**
 * The chance in 0..1 that a character holding `combinedResources` dies
 * overnight, or 0 when they are holding enough to be in no danger at all.
 *
 * Bands are checked worst-first, so an empty character gets the empty odds
 * rather than the merely-critical ones.
 */
export function survivalDeathChance(
  combinedResources: number,
  table: SurvivalDeathRiskTable = SURVIVAL_DEATH_RISKS,
): number {
  if (!Number.isFinite(combinedResources) || combinedResources < 0) {
    throw new Error(`Combined survival resources must be a non-negative number, got ${combinedResources}`);
  }
  // Nonnegative by the line above, so this is exactly "0 combined".
  if (combinedResources <= 0) return table.emptyChance;
  for (const band of table.bands) {
    if (combinedResources < band.combinedBelow) return band.chance;
  }
  return 0;
}
