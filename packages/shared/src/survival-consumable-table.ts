import type { SurvivalStatKey } from './survival-table.js';

/**
 * THE FOOD AND WATER TABLE. This is the one file to edit when changing what an
 * item restores, or when making another catalog item edible.
 *
 * Everything here is data. Nothing in this file imports game logic, so editing
 * it can change the balance but cannot change how feeding works — the engine in
 * `survival-consumption.ts` reads these values, validates the request, and
 * spends the item; it never hard-codes an item id or an amount.
 *
 * Keys are ids from the shared loot catalog in `loot-table.ts`, because a
 * household can only ever eat something it actually looted. A
 * `survival-consumables.test.ts` case fails loudly if an entry here names an id
 * the catalog does not have.
 */

/**
 * The two stats a meal moves. Health, Survival, Morale, and Strength are
 * deliberately absent: nothing edible touches them today, and adding one is a
 * change here plus the stat key, not a new code path in the engine.
 */
export type SurvivalRestorableStatKey = Extract<SurvivalStatKey, 'nutrition' | 'hydration'>;

/**
 * How much of a stat one unit restores. A number is an amount, always clamped
 * to that character's own `max`; `'MAX'` fills the stat to that character's max
 * whatever it is, which is a different thing from any fixed number because two
 * characters do not share a maximum.
 */
export type SurvivalRestoreAmount = number | 'MAX';

/** What one unit of a consumable does. An absent stat is simply not restored. */
export type SurvivalConsumableEffect = Readonly<
  Partial<Record<SurvivalRestorableStatKey, SurvivalRestoreAmount>>
>;

/**
 * Every item a household may consume, keyed by its loot catalog id. Anything
 * absent from this table is not food, which is what makes a pistol or a
 * recruited person impossible to eat without a special case anywhere.
 *
 * These are placeholders chosen for a first playable day, not final balance.
 */
export const SURVIVAL_CONSUMABLES: Readonly<Record<string, SurvivalConsumableEffect>> = Object.freeze({
  'canned-soup': Object.freeze({ nutrition: 50 }),
  'bottled-water': Object.freeze({ hydration: 50 }),
  // The one full meal on the roster: it tops a character up rather than adding a
  // fixed amount, so it is worth exactly as much as that character is empty.
  'microwave-meal': Object.freeze({ nutrition: 'MAX', hydration: 'MAX' }),
});
