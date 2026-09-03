import type { LootSpawnLocation, LootSpawnPoint } from './loot.js';
import { createSeededRandom, type RandomSource } from './loot-spawn.js';
import { GROCERY_STORE_LOOT_LOCATIONS } from './map.js';
import { NPC_CATALOG, NPC_SPAWN_TABLE, type NpcCatalogEntry } from './npc-table.js';

/**
 * The per-match people draw. NPCs stand on the same candidate locations loot
 * uses, minus the ones the loot draw already filled, so a person never shares a
 * spot with an item. Each person appears at most once per match.
 */

/** Same shape as a loot spawn: people are carryables placed on a location. */
export type NpcSpawnPoint = LootSpawnPoint;

export interface GenerateNpcSpawnsOptions {
  /** Candidate positions to scatter across. Defaults to the production map. */
  locations?: readonly LootSpawnLocation[];
  /** Location ids the loot draw already took; these are never reused. */
  excludedLocationIds?: Iterable<string>;
  /** Roster to draw from. Defaults to the shared NPC catalog. */
  catalog?: readonly NpcCatalogEntry[];
  /** How many people to place. Defaults to the whole roster, capped by the table. */
  count?: number;
  /** Reproducible layouts for tests and bug reports; omit for a fresh match. */
  seed?: number | string;
  random?: RandomSource;
}

/**
 * Places people on free locations. Throws on an impossible request rather than
 * silently placing fewer, so a bad edit to the roster or the cap fails at match
 * start with a message naming the problem.
 */
export function generateNpcSpawns(options: GenerateNpcSpawnsOptions = {}): NpcSpawnPoint[] {
  const locations = options.locations ?? GROCERY_STORE_LOOT_LOCATIONS;
  const catalog = options.catalog ?? NPC_CATALOG;
  const random = options.random
    ?? (options.seed === undefined ? Math.random : createSeededRandom(options.seed));
  const excluded = new Set(options.excludedLocationIds ?? []);
  // The roster is the ceiling: nobody appears twice, so asking for more people
  // than exist is a table error rather than a reason to duplicate one.
  const requested = options.count ?? Math.min(NPC_SPAWN_TABLE.maxPerMatch, catalog.length);

  if (!Number.isInteger(requested) || requested < 0) {
    throw new Error(`NPC count must be a non-negative integer, got ${requested}`);
  }
  if (requested > catalog.length) {
    throw new Error(`NPC draw asks for ${requested} people but the catalog has ${catalog.length}`);
  }

  const free = locations.filter((location) => !excluded.has(location.id));
  if (requested > free.length) {
    throw new Error(`NPC draw asks for ${requested} people but only ${free.length} free spawn locations remain`);
  }

  const people = shuffled(catalog, random).slice(0, requested);
  const scattered = shuffled(free, random).slice(0, requested);
  return people.map((entry, index) => {
    const location = scattered[index]!;
    return { id: location.id, catalogId: entry.id, x: location.x, y: location.y };
  });
}

function shuffled<T>(items: readonly T[], random: RandomSource): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap]!, copy[index]!];
  }
  return copy;
}
