import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NPC_CATALOG, NPC_IMAGE_BASE_PATH, npcImageUrl } from '@69-seconds/shared';

// Vitest runs from the web workspace root, which is where `public/` is served from.
const publicDir = resolve(process.cwd(), 'public');

/** Pixel size straight from the PNG header, which is the only authority on it. */
function pngDimensions(path: string): { width: number; height: number } {
  const header = readFileSync(path).subarray(0, 24);
  expect(header.subarray(1, 4).toString('ascii'), `${path} is not a PNG`).toBe('PNG');
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

/**
 * The catalog names each person's art by filename AND carries that file's pixel
 * dimensions, because the crop rect that keeps every NPC at one on-screen size
 * is expressed in those pixels. Replacing a portrait with a differently sized
 * export would otherwise silently mis-frame them in the HUD and on the map,
 * so these assertions turn that into a failing build instead.
 */
describe('NPC art', () => {
  it('resolves every named image to a file that is actually served', () => {
    for (const entry of NPC_CATALOG) {
      const url = npcImageUrl(entry);
      expect(url.startsWith(NPC_IMAGE_BASE_PATH)).toBe(true);
      expect(existsSync(`${publicDir}${url}`), `missing art for ${entry.id}: ${url}`).toBe(true);
    }
  });

  it('names every supplied image from the catalog, so no art is silently orphaned', () => {
    const referenced = new Set<string>(NPC_CATALOG.map((entry) => entry.image));
    for (const file of readdirSync(`${publicDir}${NPC_IMAGE_BASE_PATH}`)) {
      expect(referenced.has(file), `${file} exists but no catalog entry uses it`).toBe(true);
    }
  });

  it('matches each declared image size to the file on disk, so the crops stay true', () => {
    for (const entry of NPC_CATALOG) {
      const actual = pngDimensions(`${publicDir}${npcImageUrl(entry)}`);
      expect(actual, `${entry.id}: recompute imageWidth/imageHeight and content`).toEqual({
        width: entry.imageWidth,
        height: entry.imageHeight,
      });
    }
  });
});
