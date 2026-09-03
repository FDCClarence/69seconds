import type { LootSpawnLocation, LootSpawnPoint } from './loot.js';
import {
  LOOT_CATALOG,
  LOOT_SPAWN_TABLE,
  lootSpawnWeight,
  type LootCatalogEntry,
  type LootCategory,
} from './loot-table.js';
import { GROCERY_STORE_LOOT_LOCATIONS } from './map.js';

/**
 * The per-match loot draw. Category floors are filled first, every remaining
 * slot is drawn from the whole catalog by rarity weight, and the resulting items
 * are scattered across a random subset of the map's candidate locations.
 *
 * Duplicates are expected: 50 items come out of a 16-entry catalog, so a match
 * holds many copies of the common ones. Each item still gets a unique id,
 * because it inherits the id of the location it landed on.
 */

export type RandomSource = () => number;

/** Deterministic PRNG (mulberry32) so a match layout can be reproduced from a seed. */
export function createSeededRandom(seed: number | string): RandomSource {
  let state = typeof seed === 'number' ? seed >>> 0 : hashSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let drawn = Math.imul(state ^ (state >>> 15), 1 | state);
    drawn = (drawn + Math.imul(drawn ^ (drawn >>> 7), 61 | drawn)) ^ drawn;
    return ((drawn ^ (drawn >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function hashSeed(seed: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < seed.length; index += 1) {
    hash = Math.imul(hash ^ seed.charCodeAt(index), 16_777_619);
  }
  return hash >>> 0;
}

export interface LootSpawnTable {
  itemsPerMatch: number;
  categoryMinimums: Readonly<Record<LootCategory, number>>;
}

export interface GenerateLootSpawnsOptions {
  /** Candidate positions to scatter across. Defaults to the production map. */
  locations?: readonly LootSpawnLocation[];
  /** Counts and floors. Defaults to the shared loot table. */
  table?: LootSpawnTable;
  /** Item list to draw from. Defaults to the shared catalog. */
  catalog?: readonly LootCatalogEntry[];
  /** Reproducible layouts for tests and bug reports; omit for a fresh match. */
  seed?: number | string;
  random?: RandomSource;
}

/**
 * Draws one match's worth of loot. Throws on an unsatisfiable table rather than
 * silently placing fewer items, so a bad edit to `loot-table.ts` fails at match
 * start with a message naming the problem.
 */
export function generateLootSpawns(options: GenerateLootSpawnsOptions = {}): LootSpawnPoint[] {
  const locations = options.locations ?? GROCERY_STORE_LOOT_LOCATIONS;
  const table = options.table ?? LOOT_SPAWN_TABLE;
  const catalog = options.catalog ?? LOOT_CATALOG;
  const random = options.random ?? (options.seed === undefined ? Math.random : createSeededRandom(options.seed));

  const { itemsPerMatch, categoryMinimums } = table;
  const floors = Object.entries(categoryMinimums) as [LootCategory, number][];
  const totalMinimum = floors.reduce((sum, [, minimum]) => sum + minimum, 0);

  if (!Number.isInteger(itemsPerMatch) || itemsPerMatch < 0) {
    throw new Error(`Loot table itemsPerMatch must be a non-negative integer, got ${itemsPerMatch}`);
  }
  if (totalMinimum > itemsPerMatch) {
    throw new Error(`Loot table minimums total ${totalMinimum}, which exceeds itemsPerMatch ${itemsPerMatch}`);
  }
  if (itemsPerMatch > locations.length) {
    throw new Error(`Loot table asks for ${itemsPerMatch} items but only ${locations.length} spawn locations exist`);
  }

  const drawn: LootCatalogEntry[] = [];
  for (const [category, minimum] of floors) {
    const pool = catalog.filter((entry) => entry.category === category);
    if (minimum > 0 && pool.length === 0) {
      throw new Error(`Loot table requires ${minimum} ${category} items but the catalog has none`);
    }
    for (let placed = 0; placed < minimum; placed += 1) drawn.push(weightedPick(pool, random));
  }
  for (let placed = drawn.length; placed < itemsPerMatch; placed += 1) {
    drawn.push(weightedPick(catalog, random));
  }

  // Only the locations are shuffled: the drawn list is grouped by category, so
  // pairing it with a shuffled subset is what scatters the floors across the map.
  const scattered = shuffled(locations, random).slice(0, itemsPerMatch);
  return scattered.map((location, index) => ({
    id: location.id,
    catalogId: drawn[index]!.id,
    x: location.x,
    y: location.y,
  }));
}

function weightedPick(pool: readonly LootCatalogEntry[], random: RandomSource): LootCatalogEntry {
  if (pool.length === 0) throw new Error('Cannot draw a loot item from an empty pool');
  const total = pool.reduce((sum, entry) => sum + lootSpawnWeight(entry), 0);
  if (total <= 0) throw new Error('Loot pool has no positive spawn weight');
  let ticket = random() * total;
  for (const entry of pool) {
    ticket -= lootSpawnWeight(entry);
    if (ticket < 0) return entry;
  }
  // Only reachable through floating-point drift at the very top of the range.
  return pool[pool.length - 1]!;
}

function shuffled<T>(items: readonly T[], random: RandomSource): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap]!, copy[index]!];
  }
  return copy;
}
