/**
 * THE LOOT TABLE. This is the one file to edit when tuning what spawns.
 *
 * Everything here is data: how many items a match places, the per-category
 * floors, the item list, and the spawn odds. Nothing in this file imports game
 * logic, so editing it can change balance but can never break the simulation.
 * The generator that consumes it lives in `loot-spawn.ts`; a schema-style test
 * in `loot-table.test.ts` fails loudly if an edit here makes the table
 * unsatisfiable (floors above the item budget, a category with no items, etc.).
 *
 * Rarity is spawn odds ONLY. There is no rarity system in the game: a rare item
 * is not worth more and does not behave differently, it just appears less often.
 */

export const LOOT_CATEGORIES = ['food', 'weapons', 'medicine', 'entertainment', 'misc'] as const;
export type LootCategory = (typeof LOOT_CATEGORIES)[number];

export const LOOT_RARITIES = ['common', 'uncommon', 'rare', 'epic'] as const;
export type LootRarity = (typeof LOOT_RARITIES)[number];

/**
 * Relative draw weight per rarity. These are placeholders: raise a number to
 * make that tier more common. Only the ratios matter, not the absolute values,
 * so `common: 60` simply means a common item is 20x likelier than an epic one.
 */
export const RARITY_SPAWN_WEIGHTS: Record<LootRarity, number> = {
  common: 60,
  uncommon: 25,
  rare: 12,
  epic: 3,
};

/**
 * How a match is populated. `itemsPerMatch` items are placed on distinct spawn
 * locations; `categoryMinimums` are guaranteed floors filled first, and every
 * remaining slot is drawn from the whole catalog by rarity weight.
 *
 * Constraints (enforced by the table test):
 *   sum(categoryMinimums) <= itemsPerMatch <= number of spawn locations
 */
export const LOOT_SPAWN_TABLE = {
  itemsPerMatch: 50,
  categoryMinimums: {
    food: 25,
    entertainment: 5,
    misc: 5,
    medicine: 3,
    weapons: 3,
  },
} as const satisfies { itemsPerMatch: number; categoryMinimums: Record<LootCategory, number> };

export interface LootCatalogEntry {
  id: string;
  label: string;
  /** Three-character marker tag, used where art is too small to read. */
  shortLabel: string;
  /** Marker fill, as a Phaser hex literal. Also tints the no-art placeholder. */
  color: number;
  category: LootCategory;
  rarity: LootRarity;
  /**
   * Filename under `apps/web/public/item_images/`, or `null` when no art exists
   * yet — those items render as a coloured `?` placeholder until a file lands
   * here. Drop the PNG in that folder and name it here to wire it up.
   */
  image: string | null;
}

/**
 * Every item that can spawn. Duplicates are expected at runtime: 50 items are
 * drawn from these 16 entries, so a single match holds many copies of each.
 */
export const LOOT_CATALOG = [
  // Food
  { id: 'canned-soup', label: 'Canned Soup', shortLabel: 'SUP', color: 0xd2703a, category: 'food', rarity: 'common', image: 'canned-soup.png' },
  { id: 'bottled-water', label: 'Bottled Water', shortLabel: 'WTR', color: 0x6fb7d8, category: 'food', rarity: 'common', image: 'bottled-water.png' },
  { id: 'microwave-meal', label: 'Microwave Meal', shortLabel: 'MRE', color: 0xc9a227, category: 'food', rarity: 'epic', image: 'microwave-meal.png' },

  // Weapons
  { id: 'pepper-spray', label: 'Pepper Spray', shortLabel: 'PEP', color: 0xe4572e, category: 'weapons', rarity: 'uncommon', image: 'pepper-spray.png' },
  { id: 'baseball-bat', label: 'Baseball Bat', shortLabel: 'BAT', color: 0xa9714b, category: 'weapons', rarity: 'uncommon', image: 'baseball-bat.png' },
  { id: 'combat-knife', label: 'Combat Knife', shortLabel: 'KNF', color: 0x9aa5ad, category: 'weapons', rarity: 'rare', image: 'combat-knife.png' },
  { id: 'pistol', label: 'Pistol', shortLabel: 'PSL', color: 0x4a4e57, category: 'weapons', rarity: 'epic', image: 'pistol.png' },

  // Medicine
  { id: 'medicine', label: 'Medicine', shortLabel: 'MED', color: 0xe86a92, category: 'medicine', rarity: 'rare', image: 'medicine.png' },
  { id: 'medkit', label: 'Medkit', shortLabel: 'KIT', color: 0xd93b3b, category: 'medicine', rarity: 'epic', image: 'medkit.png' },

  // Entertainment
  { id: 'playing-cards', label: 'Playing Cards', shortLabel: 'CRD', color: 0xdcd6c8, category: 'entertainment', rarity: 'uncommon', image: 'playing-cards.png' },
  { id: 'chess-board', label: 'Chess Board', shortLabel: 'CHS', color: 0x5b4636, category: 'entertainment', rarity: 'rare', image: 'chess-board.png' },

  // Misc
  { id: 'map', label: 'Map', shortLabel: 'MAP', color: 0xc2b280, category: 'misc', rarity: 'uncommon', image: 'map.png' },
  { id: 'radio', label: 'Radio', shortLabel: 'RAD', color: 0x7a8b99, category: 'misc', rarity: 'rare', image: 'radio.png' },
  { id: 'lock-and-key', label: 'Lock and Key', shortLabel: 'LCK', color: 0xb8a13a, category: 'misc', rarity: 'rare', image: 'lock-and-key.png' },
  { id: 'pistol-bullets', label: 'Pistol Bullets', shortLabel: 'AMO', color: 0x8c7853, category: 'misc', rarity: 'rare', image: 'bullets.png' },
  { id: 'methamphetamine', label: 'Methamphetamine', shortLabel: 'MTH', color: 0xb6e3ee, category: 'misc', rarity: 'epic', image: 'meth.png' },
] as const satisfies readonly LootCatalogEntry[];

export type LootCatalogId = (typeof LOOT_CATALOG)[number]['id'];

/** Where the web app serves item art from; see `apps/web/public/item_images/`. */
export const LOOT_IMAGE_BASE_PATH = '/item_images/';

/** Resolved art URL, or null when the item still needs a placeholder. */
export function lootImageUrl(entry: LootCatalogEntry): string | null {
  return entry.image === null ? null : `${LOOT_IMAGE_BASE_PATH}${entry.image}`;
}

/** Draw weight of a single catalog entry. Rarity is the only input today. */
export function lootSpawnWeight(entry: LootCatalogEntry): number {
  return RARITY_SPAWN_WEIGHTS[entry.rarity];
}
