import { describe, expect, it } from 'vitest';
import {
  CARRYABLE_CATEGORIES,
  CARRYABLE_CATEGORY_LABELS,
  canCarrySlots,
  carriedSlotsUsed,
  carryableEntry,
  carryableSlotCost,
  findCarryableEntry,
} from './carryable.js';
import { GAME } from './constants.js';
import { LOOT_CATALOG, LOOT_CATEGORIES } from './loot-table.js';
import { NPC_CARRY_SLOTS, NPC_CATALOG, npcSpriteCrop } from './npc-table.js';

describe('carryables', () => {
  it('resolves loot and people through one lookup', () => {
    expect(carryableEntry('canned-soup')).toMatchObject({
      label: 'Canned Soup', category: 'food', slotCost: 1, isNpc: false,
    });
    expect(carryableEntry('maya')).toMatchObject({
      label: 'Maya', category: 'people', slotCost: NPC_CARRY_SLOTS, isNpc: true,
    });
  });

  it('gives every catalogued thing an art URL and a resolvable id', () => {
    for (const entry of NPC_CATALOG) {
      expect(findCarryableEntry(entry.id)?.imageUrl).toBe(`/npc_images/${entry.image}`);
    }
    for (const entry of LOOT_CATALOG) {
      expect(findCarryableEntry(entry.id)).toBeDefined();
    }
  });

  it('keeps loot ids and NPC ids from colliding', () => {
    const lootIds = new Set<string>(LOOT_CATALOG.map((entry) => entry.id));
    for (const entry of NPC_CATALOG) expect(lootIds.has(entry.id)).toBe(false);
  });

  it('fails loudly on an unknown id, but never lets one claim free space', () => {
    expect(() => carryableEntry('not-a-thing')).toThrow(/Unknown carryable/);
    expect(findCarryableEntry('not-a-thing')).toBeUndefined();
    // A stale id must cost a slot, or a mid-deploy client could carry forever.
    expect(carryableSlotCost('not-a-thing')).toBe(1);
  });

  it('costs a person the entire inventory', () => {
    expect(NPC_CARRY_SLOTS).toBe(GAME.maxCarriedItems);
    expect(carriedSlotsUsed(['maya'])).toBe(GAME.maxCarriedItems);
    expect(carriedSlotsUsed(['canned-soup', 'medicine'])).toBe(2);
    expect(carriedSlotsUsed([])).toBe(0);
  });

  it('admits a person only into empty hands', () => {
    expect(canCarrySlots(0, NPC_CARRY_SLOTS)).toBe(true);
    expect(canCarrySlots(1, NPC_CARRY_SLOTS)).toBe(false);
    expect(canCarrySlots(GAME.maxCarriedItems - 1, 1)).toBe(true);
    expect(canCarrySlots(GAME.maxCarriedItems, 1)).toBe(false);
  });

  it('rejects nonsensical slot arithmetic rather than allowing it', () => {
    expect(canCarrySlots(-1, 1)).toBe(false);
    expect(canCarrySlots(1.5, 1)).toBe(false);
    expect(canCarrySlots(0, 0)).toBe(false);
    expect(canCarrySlots(0, Number.NaN)).toBe(false);
  });

  it('labels every category the tally can report, people included', () => {
    expect(CARRYABLE_CATEGORIES).toEqual([...LOOT_CATEGORIES, 'people']);
    for (const category of CARRYABLE_CATEGORIES) {
      expect(CARRYABLE_CATEGORY_LABELS[category]).toBeTruthy();
    }
  });
});

describe('NPC catalog integrity', () => {
  it('keeps every content rect inside its own image', () => {
    for (const entry of NPC_CATALOG) {
      expect(entry.content.width).toBeGreaterThan(0);
      expect(entry.content.height).toBeGreaterThan(0);
      expect(entry.content.x + entry.content.width).toBeLessThanOrEqual(entry.imageWidth);
      expect(entry.content.y + entry.content.height).toBeLessThanOrEqual(entry.imageHeight);
    }
  });

  it('gives every person a unique id, name, and marker tag', () => {
    for (const field of ['id', 'name', 'shortLabel'] as const) {
      const values = NPC_CATALOG.map((entry) => entry[field]);
      expect(new Set(values).size, `duplicate ${field}`).toBe(values.length);
    }
  });

  /**
   * The crop places the whole file inside a square box so the figure fills it by
   * height and sits centred. Checking the mapped edges is what proves the
   * portrait shows a person rather than a slice of blank canvas.
   */
  it('maps a content rect onto a square box by height, centred', () => {
    for (const entry of NPC_CATALOG) {
      const crop = npcSpriteCrop(entry);
      const scale = 100 / entry.content.height;

      // The figure's vertical extent covers exactly the box, top to bottom.
      expect(crop.topPercent + entry.content.y * scale).toBeCloseTo(0, 6);
      expect(crop.topPercent + (entry.content.y + entry.content.height) * scale).toBeCloseTo(100, 6);
      // ...and its horizontal centre lands on the box's centre.
      const figureCentre = crop.leftPercent + (entry.content.x + entry.content.width / 2) * scale;
      expect(figureCentre).toBeCloseTo(50, 6);
      expect(crop.widthPercent).toBeCloseTo(entry.imageWidth * scale, 6);
      expect(crop.heightPercent).toBeCloseTo(entry.imageHeight * scale, 6);
    }
  });
});
