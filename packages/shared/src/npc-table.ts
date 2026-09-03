import { GAME } from './constants.js';

/**
 * THE NPC TABLE. This is the one file to edit when adding a person to the store.
 *
 * NPCs are survivors standing in the aisles. A player carries one the same way
 * they carry loot — the authoritative match treats them as carryables with a
 * slot cost — but a person fills every carry slot, so recruiting one is a
 * dedicated trip to your cart. Everything here is data; nothing imports game
 * logic, so editing this file can change the roster but cannot break the
 * simulation. The per-match draw lives in `npc-spawn.ts`.
 */

/**
 * A person occupies the whole inventory: picking one up requires empty hands
 * and blocks every other pickup until they are dropped or recruited.
 */
export const NPC_CARRY_SLOTS = GAME.maxCarriedItems;

/**
 * How many people a match places. Every distinct NPC that fits is used, so a
 * roster smaller than the cap simply spawns in full — eight entries today place
 * eight people. Raise the cap as the roster grows.
 */
export const NPC_SPAWN_TABLE = {
  maxPerMatch: 10,
} as const;

/**
 * The source art is hand-authored at whatever canvas each drawing needed, with
 * the figure sitting somewhere inside a large transparent margin. `content` is
 * that figure's opaque bounding box in image pixels, which is what lets every
 * person render at one consistent height instead of at the mercy of their
 * padding. Recompute it when you replace a file; `npc-table.test.ts` fails if a
 * rect escapes its image.
 */
export interface NpcContentRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NpcCatalogEntry {
  id: string;
  /** Display name, also shown on the world label and in the tally. */
  name: string;
  /** Three-character marker tag, used where art is too small to read. */
  shortLabel: string;
  /** Placeholder fill, as a Phaser hex literal, for when the art fails to load. */
  color: number;
  /** Filename under `apps/web/public/npc_images/`. */
  image: string;
  /** Full pixel dimensions of that file. */
  imageWidth: number;
  imageHeight: number;
  /** The figure's opaque bounds inside the file. */
  content: NpcContentRect;
}

/**
 * Every person who can appear in the store. Unlike loot, a match never places
 * the same person twice: each entry is drawn at most once.
 */
export const NPC_CATALOG = [
  { id: 'bryne', name: 'Bryne', shortLabel: 'BRY', color: 0xc98a52, image: 'Bryne.png', imageWidth: 1_408, imageHeight: 768, content: { x: 588, y: 51, width: 238, height: 696 } },
  { id: 'clarence', name: 'Clarence', shortLabel: 'CLA', color: 0x6f8fb5, image: 'Clarence.png', imageWidth: 1_408, imageHeight: 768, content: { x: 443, y: 54, width: 553, height: 693 } },
  { id: 'cody', name: 'Cody', shortLabel: 'COD', color: 0x7f8b93, image: 'Cody.png', imageWidth: 1_024, imageHeight: 1_024, content: { x: 335, y: 35, width: 359, height: 974 } },
  { id: 'denise', name: 'Denise', shortLabel: 'DEN', color: 0xb96a86, image: 'Denise.png', imageWidth: 1_408, imageHeight: 768, content: { x: 540, y: 54, width: 288, height: 698 } },
  { id: 'emily', name: 'Emily', shortLabel: 'EMI', color: 0xd8a44f, image: 'Emily.png', imageWidth: 1_408, imageHeight: 768, content: { x: 604, y: 58, width: 208, height: 688 } },
  { id: 'gort', name: 'Gort', shortLabel: 'GOR', color: 0x7ba36a, image: 'Gort.png', imageWidth: 1_408, imageHeight: 768, content: { x: 586, y: 39, width: 259, height: 710 } },
  { id: 'kevin', name: 'Kevin', shortLabel: 'KEV', color: 0x9a8fc0, image: 'Kevin.png', imageWidth: 1_408, imageHeight: 768, content: { x: 574, y: 57, width: 238, height: 687 } },
  { id: 'maya', name: 'Maya', shortLabel: 'MAY', color: 0x5fb0a8, image: 'Maya.png', imageWidth: 1_408, imageHeight: 768, content: { x: 568, y: 52, width: 252, height: 703 } },
] as const satisfies readonly NpcCatalogEntry[];

export type NpcCatalogId = (typeof NPC_CATALOG)[number]['id'];

/** Where the web app serves NPC art from; see `apps/web/public/npc_images/`. */
export const NPC_IMAGE_BASE_PATH = '/npc_images/';

export function npcImageUrl(entry: NpcCatalogEntry): string {
  return `${NPC_IMAGE_BASE_PATH}${entry.image}`;
}

export function findNpcCatalogEntry(catalogId: string): NpcCatalogEntry | undefined {
  return NPC_CATALOG.find((candidate) => candidate.id === catalogId);
}

/** Resolves one NPC and fails loudly on a bad id, for authoritative code paths. */
export function npcCatalogEntry(catalogId: string): NpcCatalogEntry {
  const entry = findNpcCatalogEntry(catalogId);
  if (!entry) throw new Error(`Unknown NPC catalog id: ${catalogId}`);
  return entry;
}

export function isNpcCatalogId(catalogId: string): boolean {
  return findNpcCatalogEntry(catalogId) !== undefined;
}

/**
 * Where to place the whole image file inside a SQUARE box so that the figure —
 * and none of their transparent margin — fills it at the art's own aspect
 * ratio. Every number is a percentage of the box's side, for an absolutely
 * positioned `<img>` inside a relative, `overflow: hidden` parent.
 *
 * The figure is scaled to the box by height and centred horizontally, so a
 * narrow person reads as narrow rather than being stretched to a square. Phaser
 * crops with a texture frame instead of CSS, but both read the same `content`
 * rect, so a portrait and a world sprite always show the same figure.
 */
export interface NpcSpriteCrop {
  widthPercent: number;
  heightPercent: number;
  leftPercent: number;
  topPercent: number;
}

export function npcSpriteCrop(entry: NpcCatalogEntry): NpcSpriteCrop {
  const scale = 100 / entry.content.height;
  return {
    widthPercent: entry.imageWidth * scale,
    heightPercent: entry.imageHeight * scale,
    leftPercent: 50 - (entry.content.x + entry.content.width / 2) * scale,
    topPercent: -entry.content.y * scale,
  };
}
