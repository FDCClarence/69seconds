import { describe, expect, it } from 'vitest';
import { generateLootSpawns } from './loot-spawn.js';
import { GROCERY_STORE_LOOT_LOCATIONS } from './map.js';
import { generateNpcSpawns } from './npc-spawn.js';
import { NPC_CATALOG, NPC_SPAWN_TABLE } from './npc-table.js';

const locationIds = new Set(GROCERY_STORE_LOOT_LOCATIONS.map((location) => location.id));

describe('per-match NPC draw', () => {
  it('places the whole roster when it fits under the cap', () => {
    const people = generateNpcSpawns({ seed: 'roster' });
    expect(people).toHaveLength(Math.min(NPC_SPAWN_TABLE.maxPerMatch, NPC_CATALOG.length));
  });

  it('never places the same person twice, unlike loot', () => {
    for (const seed of ['a', 'b', 'c', 'd']) {
      const people = generateNpcSpawns({ seed });
      expect(new Set(people.map((person) => person.catalogId)).size).toBe(people.length);
    }
  });

  it('uses only locations the loot draw left free', () => {
    const loot = generateLootSpawns({ seed: 'match-7' });
    const taken = new Set(loot.map((spawn) => spawn.id));
    const people = generateNpcSpawns({ seed: 'match-7', excludedLocationIds: taken });

    expect(people.length).toBeGreaterThan(0);
    for (const person of people) {
      expect(taken.has(person.id)).toBe(false);
      expect(locationIds.has(person.id)).toBe(true);
    }
    expect(new Set(people.map((person) => person.id)).size).toBe(people.length);
  });

  it('carries the location coordinates rather than inventing positions', () => {
    for (const person of generateNpcSpawns({ seed: 'coords' })) {
      const location = GROCERY_STORE_LOOT_LOCATIONS.find((candidate) => candidate.id === person.id);
      expect({ x: person.x, y: person.y }).toEqual({ x: location?.x, y: location?.y });
    }
  });

  it('reproduces a layout from a seed', () => {
    expect(generateNpcSpawns({ seed: 42 })).toEqual(generateNpcSpawns({ seed: 42 }));
  });

  it('refuses to duplicate a person to satisfy an oversized count', () => {
    expect(() => generateNpcSpawns({ count: NPC_CATALOG.length + 1 }))
      .toThrow(/catalog has/);
  });

  it('fails loudly when the loot draw has left too few free locations', () => {
    const crowded = GROCERY_STORE_LOOT_LOCATIONS.slice(0, 3).map((location) => location.id);
    expect(() => generateNpcSpawns({
      locations: GROCERY_STORE_LOOT_LOCATIONS.slice(0, 5),
      excludedLocationIds: crowded,
      count: 4,
    })).toThrow(/free spawn locations remain/);
  });

  it('rejects a nonsensical count instead of guessing', () => {
    expect(() => generateNpcSpawns({ count: -1 })).toThrow(/non-negative integer/);
    expect(() => generateNpcSpawns({ count: 1.5 })).toThrow(/non-negative integer/);
  });

  it('places nobody when asked for nobody', () => {
    expect(generateNpcSpawns({ count: 0 })).toEqual([]);
  });
});
