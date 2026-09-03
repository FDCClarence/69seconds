import { GAME } from './constants.js';
import { LOOT_CATEGORIES, lootImageUrl } from './loot-table.js';
import { findLootCatalogEntry } from './loot.js';
import { NPC_CARRY_SLOTS, findNpcCatalogEntry, npcImageUrl } from './npc-table.js';

/**
 * The one thing a pair of hands can hold. Loot and people are stored, carried,
 * deposited, and tallied through the same authoritative code path; they differ
 * only in how many carry slots one of them costs and in how they are drawn.
 *
 * This module is the single place that resolves a catalog id without caring
 * which catalog it came from, so nothing downstream needs an `isNpc` branch to
 * answer "what is this, and will it fit?".
 */

/** Loot categories plus `people`, which only a recruited NPC ever reports. */
export const CARRYABLE_CATEGORIES = [...LOOT_CATEGORIES, 'people'] as const;
export type CarryableCategory = (typeof CARRYABLE_CATEGORIES)[number];

export interface CarryableEntry {
  id: string;
  label: string;
  shortLabel: string;
  color: number;
  category: CarryableCategory;
  /** Carry slots consumed: 1 for loot, every slot for a person. */
  slotCost: number;
  /** Art URL, or null for a loot item that still needs a file. */
  imageUrl: string | null;
  isNpc: boolean;
}

/**
 * Resolves a catalog id from either catalog, or undefined when neither knows
 * it. A mid-deploy server can briefly hand a client an id from a table it has
 * not picked up yet, so presentation code looks ids up through this and falls
 * back gracefully rather than crashing a live match.
 */
export function findCarryableEntry(catalogId: string): CarryableEntry | undefined {
  const loot = findLootCatalogEntry(catalogId);
  if (loot) {
    return {
      id: loot.id,
      label: loot.label,
      shortLabel: loot.shortLabel,
      color: loot.color,
      category: loot.category,
      slotCost: 1,
      imageUrl: lootImageUrl(loot),
      isNpc: false,
    };
  }
  const npc = findNpcCatalogEntry(catalogId);
  if (!npc) return undefined;
  return {
    id: npc.id,
    label: npc.name,
    shortLabel: npc.shortLabel,
    color: npc.color,
    category: 'people',
    slotCost: NPC_CARRY_SLOTS,
    imageUrl: npcImageUrl(npc),
    isNpc: true,
  };
}

/** Resolves one carryable and fails loudly on a bad id, for authoritative paths. */
export function carryableEntry(catalogId: string): CarryableEntry {
  const entry = findCarryableEntry(catalogId);
  if (!entry) throw new Error(`Unknown carryable catalog id: ${catalogId}`);
  return entry;
}

/**
 * Slot cost of one catalog id. An id from neither catalog costs a single slot:
 * a stale item must never let a client believe it has infinite room.
 */
export function carryableSlotCost(catalogId: string): number {
  return findCarryableEntry(catalogId)?.slotCost ?? 1;
}

/** Total slots consumed by a set of carried catalog ids. */
export function carriedSlotsUsed(catalogIds: readonly string[]): number {
  return catalogIds.reduce((slots, catalogId) => slots + carryableSlotCost(catalogId), 0);
}

export const CARRYABLE_CATEGORY_LABELS: Readonly<Record<CarryableCategory, string>> = {
  food: 'Food',
  weapons: 'Weapons',
  medicine: 'Medicine',
  entertainment: 'Entertainment',
  misc: 'Misc',
  people: 'People',
};

/** True when `slotCost` more slots still fit alongside `usedSlots`. */
export function canCarrySlots(usedSlots: number, slotCost: number): boolean {
  if (!Number.isInteger(usedSlots) || usedSlots < 0) return false;
  if (!Number.isInteger(slotCost) || slotCost <= 0) return false;
  return usedSlots + slotCost <= GAME.maxCarriedItems;
}
