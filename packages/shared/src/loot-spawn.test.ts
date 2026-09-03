import { describe, expect, it } from 'vitest';
import {
  GROCERY_STORE_COLLISION,
  GROCERY_STORE_CART_COLLISION,
  GROCERY_STORE_LOOT_LOCATIONS,
  LOOT,
  LOOT_CATALOG,
  LOOT_CATEGORIES,
  LOOT_SPAWN_TABLE,
  PLAYER_SPAWN_POSITIONS,
  RARITY_SPAWN_WEIGHTS,
  createSeededRandom,
  generateLootSpawns,
  lootCatalogEntry,
  type CollisionRectangle,
  type LootCategory,
} from './index.js';

function countsByCategory(spawns: readonly { catalogId: string }[]): Record<LootCategory, number> {
  const counts = Object.fromEntries(LOOT_CATEGORIES.map((category) => [category, 0])) as Record<LootCategory, number>;
  for (const spawn of spawns) counts[lootCatalogEntry(spawn.catalogId).category] += 1;
  return counts;
}

function contains(rectangle: CollisionRectangle, x: number, y: number): boolean {
  return Math.abs(x - rectangle.x) <= rectangle.width / 2 && Math.abs(y - rectangle.y) <= rectangle.height / 2;
}

describe('loot table', () => {
  it('is satisfiable: floors fit the item budget and the budget fits the map', () => {
    const totalMinimum = Object.values(LOOT_SPAWN_TABLE.categoryMinimums).reduce((sum, count) => sum + count, 0);
    expect(totalMinimum).toBeLessThanOrEqual(LOOT_SPAWN_TABLE.itemsPerMatch);
    expect(LOOT_SPAWN_TABLE.itemsPerMatch).toBeLessThanOrEqual(GROCERY_STORE_LOOT_LOCATIONS.length);
  });

  it('gives every declared category at least one item and every item a positive weight', () => {
    for (const category of LOOT_CATEGORIES) {
      expect(LOOT_CATALOG.filter((entry) => entry.category === category).length).toBeGreaterThan(0);
    }
    for (const entry of LOOT_CATALOG) {
      expect(RARITY_SPAWN_WEIGHTS[entry.rarity]).toBeGreaterThan(0);
      expect(entry.shortLabel).toHaveLength(3);
    }
    expect(new Set(LOOT_CATALOG.map((entry) => entry.id)).size).toBe(LOOT_CATALOG.length);
  });
});

describe('loot spawn locations', () => {
  it('places every candidate in open floor, clear of shelves, carts, and player starts', () => {
    for (const location of GROCERY_STORE_LOOT_LOCATIONS) {
      for (const rectangle of [...GROCERY_STORE_COLLISION, ...GROCERY_STORE_CART_COLLISION]) {
        expect(contains(rectangle, location.x, location.y)).toBe(false);
      }
      for (const start of PLAYER_SPAWN_POSITIONS) {
        expect(Math.hypot(location.x - start.x, location.y - start.y))
          .toBeGreaterThan(LOOT.itemInteractionRadiusPixels);
      }
    }
  });
});

describe('per-match loot draw', () => {
  it('places exactly the configured item count on distinct locations', () => {
    const spawns = generateLootSpawns({ seed: 'ABC234' });
    expect(spawns).toHaveLength(LOOT_SPAWN_TABLE.itemsPerMatch);
    expect(new Set(spawns.map((spawn) => spawn.id)).size).toBe(spawns.length);
    const locationIds = new Set(GROCERY_STORE_LOOT_LOCATIONS.map((location) => location.id));
    for (const spawn of spawns) expect(locationIds.has(spawn.id)).toBe(true);
  });

  it('honours every category floor on every seed', () => {
    for (let seed = 0; seed < 40; seed += 1) {
      const counts = countsByCategory(generateLootSpawns({ seed }));
      for (const [category, minimum] of Object.entries(LOOT_SPAWN_TABLE.categoryMinimums)) {
        expect(counts[category as LootCategory]).toBeGreaterThanOrEqual(minimum);
      }
    }
  });

  it('repeats catalog entries, because 50 items come from a 16-entry catalog', () => {
    const spawns = generateLootSpawns({ seed: 7 });
    expect(new Set(spawns.map((spawn) => spawn.catalogId)).size).toBeLessThan(spawns.length);
  });

  it('is reproducible from a seed and different without one', () => {
    const layout = (seed: number) => generateLootSpawns({ seed }).map((spawn) => `${spawn.id}:${spawn.catalogId}`);
    expect(layout(99)).toEqual(layout(99));
    expect(layout(99)).not.toEqual(layout(100));
    const first = generateLootSpawns().map((spawn) => `${spawn.id}:${spawn.catalogId}`);
    const second = generateLootSpawns().map((spawn) => `${spawn.id}:${spawn.catalogId}`);
    expect(first).not.toEqual(second);
  });

  it('favours common items over epic ones at the configured weights', () => {
    // One long run rather than many matches, so the ratio is stable enough to assert.
    const drawn = Array.from({ length: 60 }, (_, seed) => generateLootSpawns({ seed })).flat();
    const rarities = drawn.map((spawn) => lootCatalogEntry(spawn.catalogId).rarity);
    const count = (rarity: string) => rarities.filter((candidate) => candidate === rarity).length;
    expect(count('common')).toBeGreaterThan(count('uncommon'));
    expect(count('uncommon')).toBeGreaterThan(count('epic'));
    expect(count('rare')).toBeGreaterThan(count('epic'));
  });

  it('rejects an unsatisfiable table instead of quietly placing fewer items', () => {
    expect(() => generateLootSpawns({
      table: { itemsPerMatch: 4, categoryMinimums: { ...LOOT_SPAWN_TABLE.categoryMinimums } },
    })).toThrow(/exceeds itemsPerMatch/);
    expect(() => generateLootSpawns({
      locations: GROCERY_STORE_LOOT_LOCATIONS.slice(0, 10),
    })).toThrow(/only 10 spawn locations/);
    expect(() => generateLootSpawns({
      catalog: LOOT_CATALOG.filter((entry) => entry.category !== 'medicine'),
    })).toThrow(/medicine items but the catalog has none/);
  });

  it('draws the same sequence from the same seed regardless of seed type', () => {
    const fromString = createSeededRandom('seed');
    const again = createSeededRandom('seed');
    expect([fromString(), fromString()]).toEqual([again(), again()]);
  });
});
