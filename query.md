i'm concerned about the item images efficiency. 

how do you think we should approach the images? i want loading to be optimized when it comes to the images.

## Recommendation (2026-09-03)

The canvas game already loads item art efficiently: `grocery-store-scene.ts` preloads all 17 loot textures once via Phaser's asset loader and caches them by key, so there's no per-frame or repeated loading there. The DOM `<img>` tags used for inventory/carry-slot UI (App.tsx, MatchGame.tsx) rely on the browser's HTTP cache instead of explicit preload, but since they request the same URLs Phaser already warmed, this isn't worth touching unless flicker is actually observed.

The real inefficiency was on disk: five images (`map.png`, `radio.png`, `meth.png`, `bullets.png`, `lock-and-key.png`) were 1024x1024 — 64x the pixel count of every other item icon in the same folder (128x128) — despite never being displayed larger than ~40px CSS (~80px at 2x retina) in either the Phaser loot marker or the DOM inventory slots. That single mismatch accounted for ~3.6MB of the ~3.8MB `item_images` folder.

**Action taken:** downscaled those five PNGs to 128x128 (matching the rest of the set) with `sips -Z 128`. Combined size dropped from ~3.6MB to ~95KB, no code changes needed since consumers already just reference the file by path. Alpha transparency preserved.

**Note:** `apps/web/art/item_images/` still holds 6.1MB of unused high-res source art — left untouched since it's not served at runtime, but worth keeping as the source-of-truth for future re-exports (re-export smaller crops from there rather than re-uploading full-res drops directly into `public/`).