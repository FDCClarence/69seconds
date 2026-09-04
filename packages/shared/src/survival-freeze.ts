import { SURVIVAL_STAT_KEYS } from './survival-table.js';
import type { SurvivalState } from './schemas.js';

/**
 * Deep-freezes one authoritative survival state.
 *
 * Every survival state is a single server decision rather than a mutable
 * working copy — the day it opens, the characters it opens with, and the
 * resources they carry into it — so both the module that opens the first day
 * and the module that resolves one into the next hand their parsed result
 * through here. Freezing is what makes "the state a client received" and "the
 * state the server decided" provably the same object.
 *
 * Internal to the survival engine on purpose: it is not exported from the
 * package index, because a caller outside this package should be receiving
 * frozen states, never freezing one of its own.
 */
export function deepFreezeSurvivalState(state: SurvivalState): SurvivalState {
  for (const household of state.households) {
    for (const character of household.characters) {
      for (const key of SURVIVAL_STAT_KEYS) Object.freeze(character.stats[key]);
      Object.freeze(character.stats);
      Object.freeze(character);
    }
    for (const item of household.inventory) Object.freeze(item);
    Object.freeze(household.characters);
    Object.freeze(household.inventory);
    Object.freeze(household);
  }
  Object.freeze(state.households);
  return Object.freeze(state);
}
