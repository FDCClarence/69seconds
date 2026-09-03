import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOOT_CATALOG, LOOT_IMAGE_BASE_PATH, lootImageUrl, type LootCatalogEntry } from '@69-seconds/shared';

// Vitest runs from the web workspace root, which is where `public/` is served from.
const publicDir = resolve(process.cwd(), 'public');

/**
 * The catalog names its art by filename, so a typo or a deleted file would only
 * surface as a silent `?` placeholder in a live match. These assertions turn
 * that into a failing build instead.
 */
describe('item art', () => {
  it('resolves every named image to a file that is actually served', () => {
    for (const entry of LOOT_CATALOG) {
      const url = lootImageUrl(entry);
      if (url === null) continue;
      expect(url.startsWith(LOOT_IMAGE_BASE_PATH)).toBe(true);
      expect(existsSync(`${publicDir}${url}`), `missing art for ${entry.id}: ${url}`).toBe(true);
    }
  });

  it('names every supplied image from the catalog, so no art is silently orphaned', () => {
    const referenced = new Set<string>(LOOT_CATALOG.flatMap((entry) => entry.image === null ? [] : [entry.image]));
    for (const file of readdirSync(`${publicDir}${LOOT_IMAGE_BASE_PATH}`)) {
      expect(referenced.has(file), `${file} exists but no catalog entry uses it`).toBe(true);
    }
  });

  /**
   * Phaser's preload gates the first frame, so served art is on the critical path
   * to a match starting. Full-resolution masters live in `apps/web/art/` and are
   * downscaled into `public/`; this stops a master being dropped back in by hand.
   */
  it('serves only downscaled art, keeping the preload off the critical path', () => {
    let total = 0;
    for (const file of readdirSync(`${publicDir}${LOOT_IMAGE_BASE_PATH}`)) {
      const bytes = statSync(`${publicDir}${LOOT_IMAGE_BASE_PATH}${file}`).size;
      expect(bytes, `${file} is ${Math.round(bytes / 1024)}KB; downscale it into public/`)
        .toBeLessThan(64 * 1024);
      total += bytes;
    }
    expect(total).toBeLessThan(512 * 1024);
  });

  it('illustrates every catalog entry, so nothing renders as a bare placeholder', () => {
    // Widened, because the literal catalog type proves `image` is never null
    // today; the annotation keeps the assertion meaningful when an entry is
    // added without art.
    const catalog: readonly LootCatalogEntry[] = LOOT_CATALOG;
    const missing = catalog.filter((entry) => entry.image === null).map((entry) => entry.id);
    expect(missing).toEqual([]);
  });
});
