import {
  NPC_SURVIVAL_OVERRIDES,
  SURVIVAL_CHARACTER_DEFAULTS,
  SURVIVAL_STAT_CEILING,
  SURVIVAL_STAT_KEYS,
  type NpcSurvivalOverrideTable,
  type SurvivalCharacterOverrides,
  type SurvivalStatKey,
  type SurvivalStatOverride,
} from './survival-table.js';
import { SURVIVAL } from './constants.js';
import { deepFreezeSurvivalState } from './survival-freeze.js';
import { survivalStateSchema } from './schemas.js';
import type {
  MatchTally,
  SurvivalCharacter,
  SurvivalCharacterKind,
  SurvivalHousehold,
  SurvivalState,
  SurvivalStats,
  TallyItem,
} from './schemas.js';

/**
 * The generic survival initialization engine.
 *
 * It knows how to turn the frozen looting result into one household per player
 * and how to lay out a character's stats, and it knows nothing about what those
 * numbers are — every value comes from `survival-table.ts`. Giving one NPC
 * different numbers is therefore a data edit, never a change in here.
 *
 * Nothing in this module reads a clock, a socket, or a client message: the
 * server calls it at the looting deadline and the result it returns is the
 * authoritative state. Clients only ever receive it.
 */

export interface CreateSurvivalCharacterOptions {
  /** Stable within the match; the caller owns uniqueness. */
  id: string;
  displayName: string;
  kind: SurvivalCharacterKind;
  /** Required for an NPC, and must be absent or null for a main character. */
  catalogId?: string | null | undefined;
  overrides?: SurvivalCharacterOverrides | undefined;
}

/**
 * Builds one character from the defaults plus optional overrides.
 *
 * Every returned stat is a freshly allocated object, so two characters built
 * from the same defaults never share a stat and mutating one can never write
 * back into {@link SURVIVAL_CHARACTER_DEFAULTS}.
 */
export function createSurvivalCharacter(options: CreateSurvivalCharacterOptions): SurvivalCharacter {
  const { id, displayName, kind, overrides } = options;
  const catalogId = options.catalogId ?? null;
  if (kind === 'NPC' && catalogId === null) {
    throw new Error(`Survival NPC ${id} needs the catalog id it was recruited from`);
  }
  if (kind === 'MAIN' && catalogId !== null) {
    throw new Error(`Survival main character ${id} must not carry a catalog id`);
  }
  const stats = {} as SurvivalStats;
  for (const key of SURVIVAL_STAT_KEYS) {
    stats[key] = resolveStat(id, key, overrides?.[key]);
  }
  return {
    id,
    displayName,
    kind,
    catalogId,
    // Nobody starts dead, and death is never inferred from health: the coming
    // rules kill on combined nutrition and hydration, so the flag is explicit.
    isAlive: true,
    stats,
    dailyNutritionCost: resolveDailyCost(
      id,
      'dailyNutritionCost',
      overrides?.dailyNutritionCost,
    ),
    dailyHydrationCost: resolveDailyCost(
      id,
      'dailyHydrationCost',
      overrides?.dailyHydrationCost,
    ),
  };
}

export interface InitializeSurvivalStateOptions {
  /**
   * The frozen looting result. It is the only source of who is in the match,
   * who they recruited, and what they banked.
   */
  result: MatchTally;
  /**
   * Per-NPC balance overrides, defaulting to the shipped table. Injectable so a
   * test can prove override support without moving live balance.
   */
  npcOverrides?: NpcSurvivalOverrideTable | undefined;
  /**
   * Which day the returned state describes. Defaults to the first survival day,
   * because looting happens before Day 1.
   *
   * It is a parameter rather than a hard-coded 1 so the end-of-day flow can
   * later open Day 2 through this same engine. The caller — the server — owns
   * the number; nothing in here counts days, and no client can supply one.
   */
  dayNumber?: number | undefined;
}

/**
 * Opens a survival day: one household per player in the frozen looting result,
 * each holding that player's main character, only the people that player
 * personally recruited, and only that player's deposited items.
 *
 * The day it opens is {@link InitializeSurvivalStateOptions.dayNumber},
 * defaulting to Day 1 because the grocery run happens before Day 1.
 *
 * Households are never merged. A recruited person becomes exactly one character
 * regardless of the four carry slots they occupied during looting, and ordinary
 * loot stays in `inventory` — an item never becomes a character.
 *
 * The returned object is validated through the shared schema and deep-frozen,
 * the same treatment the looting result gets, because it is one immutable
 * server decision rather than a mutable working copy.
 */
export function initializeSurvivalState(options: InitializeSurvivalStateOptions): SurvivalState {
  const { result } = options;
  const npcOverrides = options.npcOverrides ?? NPC_SURVIVAL_OVERRIDES;
  const dayNumber = options.dayNumber ?? SURVIVAL.firstDayNumber;
  const seenCharacterIds = new Set<string>();
  const households = [...result.players]
    .sort((left, right) => left.slot - right.slot)
    .map((player): SurvivalHousehold => {
      const characters: SurvivalCharacter[] = [createSurvivalCharacter({
        id: player.playerId,
        displayName: player.displayName,
        kind: 'MAIN',
      })];
      const inventory: TallyItem[] = [];
      for (const item of player.items) {
        if (!isRecruit(item)) {
          inventory.push({ ...item });
          continue;
        }
        // One banked person is one character, whatever it cost to carry them:
        // the four looting carry slots buy a single household member.
        characters.push(createSurvivalCharacter({
          // The deposited item id, so two instances of one person would still be
          // two characters even if the roster ever places somebody twice.
          id: item.id,
          displayName: item.label,
          kind: 'NPC',
          catalogId: item.catalogId,
          overrides: npcOverrides[item.catalogId],
        }));
      }
      for (const character of characters) {
        if (seenCharacterIds.has(character.id)) {
          throw new Error(`Duplicate survival character id: ${character.id}`);
        }
        seenCharacterIds.add(character.id);
      }
      return {
        playerId: player.playerId,
        displayName: player.displayName,
        slot: player.slot,
        characters,
        inventory,
      };
    });
  const parsed = survivalStateSchema.parse({
    stateId: `survival:${result.resultId}`,
    roomCode: result.roomCode,
    // The schema refuses anything but a whole day at or after the first, so a
    // bad number fails here rather than reaching a client as "Day #0".
    dayNumber,
    // The authoritative looting deadline, not a receipt time: the day opens
    // exactly where looting ended.
    startedAtMs: result.lootingEndedAtMs,
    households,
  });
  return deepFreezeSurvivalState(parsed);
}

/** True for a recruited person; `people` is the one category a person reports. */
function isRecruit(item: TallyItem): boolean {
  return item.category === 'people';
}

function resolveStat(
  characterId: string,
  key: SurvivalStatKey,
  override: SurvivalStatOverride | undefined,
): { current: number; max: number } {
  const base = SURVIVAL_CHARACTER_DEFAULTS.stats[key];
  const max = assertBalanceNumber(override?.max ?? base.max, characterId, `${key}.max`);
  if (max <= 0) {
    throw new Error(`Survival character ${characterId} has a non-positive ${key}.max: ${max}`);
  }
  const current = assertBalanceNumber(
    override?.current ?? base.current,
    characterId,
    `${key}.current`,
  );
  // Clamped rather than rejected, so lowering only a max is a legal one-line
  // override: `{ nutrition: { max: 80 } }` starts at 80/80, not at 100/80.
  return { current: Math.min(current, max), max };
}

function resolveDailyCost(
  characterId: string,
  key: 'dailyNutritionCost' | 'dailyHydrationCost',
  override: number | undefined,
): number {
  return assertBalanceNumber(override ?? SURVIVAL_CHARACTER_DEFAULTS[key], characterId, key);
}

/**
 * Balance values are authoritative data, so a bad one fails loudly at match
 * start with a message naming the character and the field, rather than quietly
 * producing a character nobody can survive with.
 */
function assertBalanceNumber(value: number, characterId: string, field: string): number {
  if (!Number.isFinite(value) || value < 0 || value > SURVIVAL_STAT_CEILING) {
    throw new Error(`Survival character ${characterId} has an out-of-range ${field}: ${value}`);
  }
  return value;
}
