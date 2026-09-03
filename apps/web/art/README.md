# Item art masters

`item_images/` here holds the full-resolution (1024×1024) originals. They are
**not served** — nothing in this folder ships to the browser.

`apps/web/public/item_images/` holds the 128×128 copies the game actually loads.
Phaser's `preload()` gates the first frame of a match, so served art sits on the
critical path to a match starting: the masters total ~6.1MB, the served copies
~158KB.

## Adding or replacing an item image

1. Drop the full-resolution PNG in `item_images/` here.
2. Downscale it into `public/item_images/` under the same filename:

   ```sh
   python3 -c "
   from PIL import Image
   im = Image.open('apps/web/art/item_images/NAME.png').convert('RGBA')
   im.resize((128, 128), Image.LANCZOS).save('apps/web/public/item_images/NAME.png', 'PNG', optimize=True)
   "
   ```

3. Name the file on the item's line in `packages/shared/src/loot-table.ts`
   (`image: 'NAME.png'`). An item left at `image: null` renders a `?` placeholder.

`src/game/loot-art.test.ts` fails if a catalog entry names a file that is not
served, if a served file is not named by any entry, or if a served file is large
enough to suggest a master was copied in by mistake.

The art is anti-aliased rather than grid-aligned pixel art, so it is scaled
smoothly — do not add `image-rendering: pixelated` when styling it.
