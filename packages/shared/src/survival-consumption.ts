import {
  SURVIVAL_CONSUMABLES,
  type SurvivalConsumableEffect,
  type SurvivalRestorableStatKey,
} from './survival-consumable-table.js';
import { deepFreezeSurvivalState } from './survival-freeze.js';
import { survivalStateSchema } from './schemas.js';
import type { SurvivalStat } from './survival-table.js';
import type {
  SurvivalCharacter,
  SurvivalConsumeRejectionReason,
  SurvivalHousehold,
  SurvivalInventoryItem,
  SurvivalState,
} from './schemas.js';

/**
 * The feeding engine: it spends one item out of one household's inventory and
 * restores the Nutrition or Hydration of one character in that same household.
 *
 * Like the two engines beside it, this module reads no clock, no socket, and no
 * client message. It is a pure function of the committed day plus the intent —
 * *which item, on whom* — and it decides everything else itself. A client never
 * sends a resulting stat value, and there is nowhere in this signature to put
 * one: what an item restores comes from `survival-consumable-table.ts` and what
 * a character can hold comes from the character.
 *
 * It knows nothing about whose turn it is or whether the day is still open.
 * Those are the caller's gates, because they are answered by the room clock and
 * the End Day ledger rather than by the state being changed.
 */

/** What one unit of a catalog id restores, or undefined when it is not food. */
export function findSurvivalConsumable(catalogId: string): SurvivalConsumableEffect | undefined {
  return SURVIVAL_CONSUMABLES[catalogId];
}

/**
 * True only for a supported food or water item. A weapon, a radio, and a
 * recruited person are all equally inedible, and none of them needs its own
 * rule to be: absence from the table is the whole answer.
 */
export function isSurvivalConsumable(catalogId: string): boolean {
  return findSurvivalConsumable(catalogId) !== undefined;
}

export interface ConsumeSurvivalItemOptions {
  /**
   * The committed day. Never mutated: a successful call returns a separate
   * state, so a caller holding the pre-feed day still holds it unchanged.
   */
  state: SurvivalState;
  /** The authenticated household owner. Never a value a client supplied. */
  playerId: string;
  /** The inventory item instance to spend, which must be that household's. */
  itemId: string;
  /** The character to feed, which must be in that same household. */
  characterId: string;
}

/** Every way feeding can fail on the state alone, ownership included. */
export type SurvivalConsumptionRejection = Extract<
  SurvivalConsumeRejectionReason,
  'NO_HOUSEHOLD' | 'UNKNOWN_ITEM' | 'NOT_CONSUMABLE' | 'UNKNOWN_CHARACTER' | 'CHARACTER_DEAD'
>;

export type ConsumeSurvivalItemOutcome =
  | {
    ok: true;
    /** The next committed day, validated and frozen like every other one. */
    state: SurvivalState;
    /** The fed character as the server now holds them. */
    character: SurvivalCharacter;
    /** The item that was spent; it is already gone from `state`. */
    item: SurvivalInventoryItem;
    /** That household's remaining inventory, so nobody subtracts their own. */
    inventory: readonly SurvivalInventoryItem[];
  }
  | { ok: false; reason: SurvivalConsumptionRejection };

/**
 * Feeds one character one item.
 *
 * Every restriction that can be answered from the day itself is answered here,
 * in one place and in the same order for every caller: the household must be
 * the requester's own, the item must be in *that* inventory, the item must be
 * food, the character must be in *that* household, and they must be alive.
 * Nothing is spent unless all five hold — a rejected request returns the day
 * untouched, so a failed feed can never cost an item.
 *
 * A recruited person is unreachable from here by construction rather than by a
 * check: people are characters, and this only ever looks items up in
 * `inventory`, which no person is ever placed in.
 */
export function consumeSurvivalItem(options: ConsumeSurvivalItemOptions): ConsumeSurvivalItemOutcome {
  const { state, playerId, itemId, characterId } = options;
  const household = state.households.find((candidate) => candidate.playerId === playerId);
  // One lookup answers both "is this your household?" and "is this your item?":
  // another player's inventory is simply not in the household this finds.
  if (!household) return { ok: false, reason: 'NO_HOUSEHOLD' };
  const itemIndex = household.inventory.findIndex((candidate) => candidate.id === itemId);
  const item = household.inventory[itemIndex];
  if (!item) return { ok: false, reason: 'UNKNOWN_ITEM' };
  const effect = findSurvivalConsumable(item.catalogId);
  if (!effect) return { ok: false, reason: 'NOT_CONSUMABLE' };
  const characterIndex = household.characters.findIndex((candidate) => candidate.id === characterId);
  const character = household.characters[characterIndex];
  if (!character) return { ok: false, reason: 'UNKNOWN_CHARACTER' };
  if (!character.isAlive) return { ok: false, reason: 'CHARACTER_DEAD' };

  const fed = restoreCharacter(character, effect);
  const characters = [...household.characters];
  characters[characterIndex] = fed;
  // Exactly one unit leaves the household: the instance that was named, not
  // every copy of that item, and not one from anybody else's shelf.
  const inventory = household.inventory.filter((_, index) => index !== itemIndex);
  const nextHousehold: SurvivalHousehold = { ...household, characters, inventory };
  // Parsed rather than trusted, exactly as the opening and resolving days are:
  // a restoration that produced an impossible number fails here instead of
  // reaching a client, and the parse is what copies the day out of the old one.
  const parsed = survivalStateSchema.parse({
    ...state,
    households: state.households.map((candidate) =>
      candidate.playerId === playerId ? nextHousehold : candidate),
  });
  const next = deepFreezeSurvivalState(parsed);
  const committedHousehold = next.households.find((candidate) => candidate.playerId === playerId)!;
  return {
    ok: true,
    state: next,
    character: committedHousehold.characters[characterIndex]!,
    item: { ...item },
    inventory: committedHousehold.inventory,
  };
}

/** Applies one item's effect, leaving every stat it does not name untouched. */
function restoreCharacter(
  character: SurvivalCharacter,
  effect: SurvivalConsumableEffect,
): SurvivalCharacter {
  const stats = { ...character.stats };
  for (const key of ['nutrition', 'hydration'] as const satisfies readonly SurvivalRestorableStatKey[]) {
    stats[key] = restoreStat(character.stats[key], effect[key]);
  }
  return { ...character, stats };
}

/**
 * Restores one stat, capped at that character's own maximum.
 *
 * The cap is personal, never the default 100: 20/80 plus 50 is 70/80, and the
 * same soup on a 70/100 character reaches 100/100. `'MAX'` fills to whatever
 * this character's maximum happens to be, which is why a full meal cannot be
 * expressed as a number.
 */
function restoreStat(stat: SurvivalStat, amount: SurvivalConsumableEffect[SurvivalRestorableStatKey]): SurvivalStat {
  if (amount === undefined) return stat;
  const restored = amount === 'MAX' ? stat.max : stat.current + amount;
  return { current: Math.min(stat.max, restored), max: stat.max };
}
