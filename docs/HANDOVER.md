# 69 Seconds — Handover

**Written:** 2026-09-03 · **Branch:** `main` (clean, up to date with `origin/main`)
**HEAD:** `ba0c27f` — *Add recruitable npc's* (2026-09-03 16:15 +0800)
**Toolchain used for every check in this document:** Node.js 22.6.0, npm 10.8.2

This is the current-state handover. It supersedes [BUILD_STATUS.md](BUILD_STATUS.md), which
is a point-in-time audit snapshot taken at `27d8272` and does **not** describe the ten
commits that landed after it (item art, the bobbing effect, the loader-timeout fix, and the
whole recruitable-NPC feature).

Read in this order: this file → [GAME_SPEC.md](GAME_SPEC.md) (the rules and their balance
values) → [ARCHITECTURE.md](ARCHITECTURE.md) (the authority model and package boundaries) →
[RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) (what shipping requires).

---

## 1. What this project is

A browser-based, server-authoritative multiplayer grocery scramble. One match is a single
69-second looting round for one to four authenticated players:
`LOBBY → COUNTDOWN → LOOTING → TALLY`, one-way, with no rematch path.

The vertical slice is feature-complete for that one round. It includes MySQL-backed
authentication, private six-character rooms, a Phaser match scene, and server-authoritative
movement, sprint stamina, shoving, loot pickup/deposit, NPC recruitment, and the final tally.

The build plan is [steps.md](../steps.md) — a 13-step guide. **Steps 1–12 are done. Step 13
(deploy and verify Cloudflare + Railway production) has not been started**, and the
`docs/DEPLOYMENT.md` that step 13 produced was deleted in commit `4c1bdae` (see §8).

---

## 2. Status at a glance

Every row below was executed against `ba0c27f` while writing this document, except where
noted.

| Gate | Result |
| --- | --- |
| `npm run lint` | **Passes** — no errors, no warnings |
| `npm run typecheck` | **FAILS** — `apps/web/src/game/loot-art.test.ts(48,95)`: `TS2339` |
| `npm run build` | **FAILS** — same error; `tsc -b` blocks `vite build` in the web workspace |
| `npm test -w @69-seconds/shared` | Passes — 65/65 across 8 files |
| `npm test -w @69-seconds/server` | Passes — 95 passed, 7 skipped (the MySQL auth suite, skipped without `TEST_DATABASE_URL`) |
| `npm test -w @69-seconds/web` | **FAILS** — 62 passed, 1 failed (`loot-art.test.ts`) |
| `npm run e2e` | Not run here. `test-results/.last-run.json` records a pass at 16:14:09, ~1 minute before HEAD was committed. |

`git diff --check` is clean. The only working-tree change is `query.md`, which is a scratch
prompt file the author writes feature requests into — it is currently emptied, and its git
history is a useful record of how each recent feature was asked for.

Note that shared and server are green: **the failure is a single stale assertion in one web
test file, and it is the sole reason typecheck, build, and `npm test` are all red.**

---

## 3. The one blocking issue, and its verified fix

### Symptom

```
src/game/loot-art.test.ts(48,95): error TS2339: Property 'id' does not exist on type 'never'.
```

and, at runtime:

```
FAIL src/game/loot-art.test.ts > item art > leaves the unillustrated items explicitly null…
AssertionError: expected [] to deeply equal [ 'map', 'radio', 'lock-and-key', 'pistol-bullets', 'methamphetamine' ]
```

### Root cause

[loot-art.test.ts:47-50](../apps/web/src/game/loot-art.test.ts#L47-L50) asserts that five
loot items still have no art. That was true when the test was written, but commits `4c1bdae`
(*add images*) and `9fef1fd` (*item image optimization*) supplied `map.png`, `radio.png`,
`lock-and-key.png`, `bullets.png`, and `meth.png`. Every one of the 16 entries in
[loot-table.ts](../packages/shared/src/loot-table.ts) now names a real file.

The type error and the test failure are the same fact seen twice. `LOOT_CATALOG` is declared
`as const satisfies readonly LootCatalogEntry[]`, so its `image` fields are string literal
types. With no entry left that can be `null`, `filter((entry) => entry.image === null)`
narrows to `never[]`, and `.map((entry) => entry.id)` therefore cannot see `.id`.

### Fix

Invert the assertion — every catalog entry should now be illustrated — and widen the array
to the interface type so the check survives a future entry being added without art. This
exact patch was applied and verified during this handover (web typecheck clean, 63/63 web
tests passing), then reverted so the working tree stays clean for whoever picks this up:

```ts
// apps/web/src/game/loot-art.test.ts

// line 4 — add the type import
import { LOOT_CATALOG, LOOT_IMAGE_BASE_PATH, lootImageUrl, type LootCatalogEntry } from '@69-seconds/shared';

// replace the final `it(...)` block
it('illustrates every catalog entry, so nothing renders as a bare placeholder', () => {
  // Widened, because the literal catalog type proves `image` is never null
  // today; the cast keeps the assertion meaningful when an entry is added.
  const catalog: readonly LootCatalogEntry[] = LOOT_CATALOG;
  const missing = catalog.filter((entry) => entry.image === null).map((entry) => entry.id);
  expect(missing).toEqual([]);
});
```

Do this first. Nothing else in this handover can be validated end-to-end until `npm run
build` is green again.

---

## 4. Repository map

```
packages/shared/     framework-free: Zod schemas, wire types, event maps, constants, pure rules
apps/server/         Express + Socket.IO, MySQL/Drizzle auth, room registry, authoritative sim
apps/server/drizzle/ committed MySQL migrations + Drizzle metadata
apps/web/            React/Vite shell; Phaser match scene mounted only on the match route
apps/web/art/        full-resolution item masters (6.1 MB, not served)
apps/web/public/     served art: item_images/ (280 KB), npc_images/ (2.7 MB)
e2e/                 Playwright vertical-slice journey + its in-memory-auth fixture server
docs/                specs, this handover, release checklist
steps.md             the 13-step build plan (steps 1–12 done)
query.md             the author's scratch prompt file; history shows recent feature requests
```

The files you will actually spend time in, by size:

| File | Lines | Owns |
| --- | --- | --- |
| [grocery-store-scene.ts](../apps/web/src/game/scenes/grocery-store-scene.ts) | 1030 | The whole Phaser match scene: map, loot/NPC sprites, bobbing, prompts, HUD feed |
| [App.tsx](../apps/web/src/App.tsx) | 662 | Auth screens, home menu, lobby, tally rendering |
| [loot-authority.ts](../apps/server/src/game/loot-authority.ts) | 538 | Authoritative item/NPC set, pickup/deposit/drop validation, idempotency |
| [socket.ts](../apps/server/src/socket.ts) | 517 | Handshake auth, origin gate, payload validation, rate buckets, event routing |
| [MatchGame.tsx](../apps/web/src/game/react/MatchGame.tsx) | 466 | React↔Phaser bridge, HUD, carry slots, connection overlay |
| [schemas.ts](../packages/shared/src/schemas.ts) | 446 | Every wire shape; the source of truth for types |
| [simulation.ts](../apps/server/src/game/simulation.ts) | 401 | 30 Hz fixed step, phase graph, deadline, frozen tally |
| [room-client.ts](../apps/web/src/room-client.ts) | 395 | Browser Socket.IO client, outside Phaser so it survives scene replacement |
| [registry.ts](../apps/server/src/rooms/registry.ts) | 361 | Codes, slots, host, readiness, reconnect grace, abandoned-room sweep |
| [shove-authority.ts](../apps/server/src/game/shove-authority.ts) | 294 | Cooldowns, cone/range checks, swept knockback, idempotency |

Every tunable number lives in [constants.ts](../packages/shared/src/constants.ts) — `GAME`,
`NETWORK`, `LOOT`, `SPRINT`, `SHOVE`. Both the server tick and the client predictor read
them, so changing a value in one place moves both.

---

## 5. The authority model, in short

[ARCHITECTURE.md](ARCHITECTURE.md) is the full treatment; this is the part you must hold in
your head before touching gameplay code.

- **The server is the only authority.** Trusted identity comes solely from the opaque
  HTTP-only session cookie, recovered during the Socket.IO handshake. A client payload can
  never claim a player id, slot, host status, position, velocity, stamina, facing, inventory,
  cart, phase, deadline, shove direction, or tally value.
- **Clients send intent, not outcomes:** `input:update` (WASD + sprint booleans, sequenced,
  ≤30 Hz), `interaction:request`, `shove:request`.
- **The simulation is a 30 Hz fixed step.** Movement distance derives only from shared
  speeds and the fixed step; client timestamps never advance it. Snapshots go out at 20 Hz,
  volatile, carrying position/stamina/recovery/last-acked-input — never loot or lobby data.
- **Races serialize on the Node event loop.** Pickup, deposit, drop, shove, disconnect
  restocking, and the tally commit are synchronous with no `await` between reading
  availability and claiming it. Contested pickups and mutual shoves therefore have exactly
  one winner, decided by arrival order.
- **Idempotency is per request ID**, bounded per player at 128 entries. Only *committed*
  decisions are remembered, so a resent ID replays its original acknowledgement and
  broadcasts nothing further, while a rejection stays re-evaluable for a legitimate retry.
- **The deadline is checked in three places** — the simulation before applying movement, and
  the loot and shove authorities against their own receive time — so a delayed timer callback
  cannot open a late-action window. The first tick at or past the deadline freezes one
  immutable tally and later ticks return the same object.
- **The client predicts only what it can safely roll back:** local movement, stamina drain, a
  pickup (marker hides, dashed slot appears), and the shove swing plus cooldown. Deposits
  wait for confirmation. Remote players render 100 ms behind on an interpolation buffer.

---

## 6. What landed after the last audit

Ten commits sit between the `27d8272` audit and HEAD. They are the part of the codebase that
no existing doc describes as a whole.

**Loot art pipeline** (`ed8c766`, `4c1bdae`, `9fef1fd`)
Hand-authored masters live in `apps/web/art/item_images/` and are downscaled into
`apps/web/public/item_images/`. All 16 catalog entries are now illustrated. Three guards live
in [loot-art.test.ts](../apps/web/src/game/loot-art.test.ts): every named file must exist,
every served file must be named by a catalog entry (no orphans), and each file must be under
64 KB with the directory under 512 KB — because Phaser's preload gates the first frame, so
art is on the critical path to a match starting. The fourth assertion in that file is the
stale one from §3.

**Item bobbing** (`d328d03`, `023ecda`, `8f76f8c`)
Loot renders as a shadow plus a `hoverLayer` container that rides a sine wave, with a random
2500–3200 ms period and a random phase offset per item so the shelves do not pulse in unison.
Baseline `-3 px`, height `10 px`.

**Loader timeout** (`d9b7a19`)
Phaser's loader had no timeout, so one stalled art request left `create()` — the callback
that dismisses the "Opening the store" overlay — permanently unrun, hanging the match at the
loading screen. Now `loader: { timeout: 8_000 }`; a timed-out file just renders as a `?`
placeholder. See the comment in
[create-grocery-game.ts](../apps/web/src/game/create-grocery-game.ts#L15-L20).

**Catalog-disagreement resilience** (`d5b60a5`)
The shared `lootCatalogEntry()` throws on an unknown id, which is correct for the
authoritative server but fatal in the browser: a mid-deploy server can hand a client an id
from a table it has not picked up yet, and one stale item should not take down a live match.
The scene and the tally now look ids up leniently and fall back to a `?` chip, and
`createLootObject` returns `undefined` with a `console.warn` for an unrecognized id.

**Recruitable NPCs** (`ba0c27f`) — the largest change, covered next.

---

## 7. The carryable/NPC subsystem

This is the newest and least-documented area. The design decision worth understanding: rather
than adding a parallel NPC system, people were folded into the *existing* carryable path.
Loot and people share the same authority, the same pickup/deposit/drop rules, and the same
tally. They differ in exactly two things — how many carry slots one costs, and how it is
drawn.

**[carryable.ts](../packages/shared/src/carryable.ts)** is the seam. `findCarryableEntry(id)`
resolves an id from either catalog and returns a uniform shape (`label`, `shortLabel`,
`color`, `category`, `slotCost`, `imageUrl`, `isNpc`), so nothing downstream needs an `isNpc`
branch to answer "what is this, and will it fit?". `carriedSlotsUsed()` and `canCarrySlots()`
are the capacity arithmetic. `CARRYABLE_CATEGORIES` is the five loot categories plus
`people`. An id from neither catalog deliberately costs one slot, so a stale item can never
convince a client it has infinite room.

**[npc-table.ts](../packages/shared/src/npc-table.ts)** is the data file — the one place to
edit when adding a person. Eight entries today (Bryne, Clarence, Cody, Denise, Emily, Gort,
Kevin, Maya) against a `maxPerMatch` of 10, so all eight appear in every match. A person
costs `NPC_CARRY_SLOTS = GAME.maxCarriedItems`, i.e. the whole inventory.

The portraits are large hand-authored canvases with the figure sitting inside a wide
transparent margin, so each entry carries the file's pixel dimensions *and* the figure's
opaque bounding box (`content`). That one rect frames the person both on the map (Phaser adds
a trimmed texture frame named `body`) and in the DOM (`npcSpriteCrop()` returns percentages
for an absolutely positioned `<img>` in an `overflow: hidden` square). The figure is scaled
by height and centred horizontally, so a narrow person reads as narrow instead of being
stretched. **Replacing a portrait with a different export size must be accompanied by a
recomputed `content` rect** — [npc-art.test.ts](../apps/web/src/game/npc-art.test.ts) fails
if a rect escapes its image, which is what stops a silent mis-framing.

**[npc-spawn.ts](../packages/shared/src/npc-spawn.ts)** draws people onto the same 80
candidate locations loot uses, minus the ones the loot draw already took, so a person and an
item never share a spot. Nobody is placed twice. It throws rather than quietly placing fewer
people, so a bad roster or cap edit fails at match start with a message naming the problem.

**Rules as implemented** (also in [GAME_SPEC.md](GAME_SPEC.md#people-npcs)):

- Picking up a person requires empty hands. Failing that returns `NEEDS_EMPTY_HANDS`, which
  is deliberately distinct from `HANDS_FULL` because the remedy differs — drop or bank what
  you hold. See [loot-authority.ts:357-366](../apps/server/src/game/loot-authority.ts#L357-L366).
- While carrying a person, every other pickup returns `HANDS_FULL`.
- The HUD shows the person in the first carry slot with the other three crossed out.
- `Q` (`drop`) puts down the most recently picked-up carryable — person included — at the
  position the *server* has for that player. The request carries no coordinate.
- Depositing a person in your own cart recruits them: they appear in the tally by name under
  the `people` category, counting as one entry rather than the four slots they occupied.
- A player leaving mid-match releases a carried person back to the floor, available again.
- People do not move, are not solid, and are unaffected by shoves. Being shoved never makes a
  player drop what they are carrying.

**Server test coverage** for this lives in
[loot-authority.test.ts](../apps/server/src/game/loot-authority.test.ts) (30 tests, +194
lines in `ba0c27f`) and shared coverage in
[carryable.test.ts](../packages/shared/src/carryable.test.ts) (11) and
[npc-spawn.test.ts](../packages/shared/src/npc-spawn.test.ts) (9).

---

## 8. Documentation drift found while writing this

Small, all real, none blocking:

1. **`docs/DEPLOYMENT.md` does not exist.** It was deleted in `4c1bdae` (*add images*),
   apparently unintentionally — that commit is otherwise five PNGs. Two live documents still
   link to it: [README.md:81](../README.md#L81) and
   [RELEASE_CHECKLIST.md:102](RELEASE_CHECKLIST.md#L102). Either restore it from
   `git show 4c1bdae^:docs/DEPLOYMENT.md` or drop both references. Restoring is probably
   right, since step 13 has not been run and that file was its checklist.
2. **[npc-table.ts:34](../packages/shared/src/npc-table.ts#L34)** names `npc-table.test.ts`
   as the test that guards the content rects. The real file is
   `apps/web/src/game/npc-art.test.ts`; no `npc-table.test.ts` exists.
3. **[BUILD_STATUS.md](BUILD_STATUS.md) is stale** by ten commits and still claims a fully
   green gate, including a passing `npm run build`. That is no longer true (§3). Treat it as
   an audit record for `27d8272`, not as current status.
4. **Test counts in `BUILD_STATUS.md` (170) no longer match** the current 63 web + 95 server
   + 65 shared = 223 (plus 7 skipped MySQL cases).

---

## 9. Known limitations carried forward

These are design decisions or accepted debt, not bugs:

- **Rooms, simulations, and tallies are process-local.** A restart or deploy ends every
  active match. Production must run **exactly one** replica until shared room state and a
  compatible Socket.IO adapter exist. There is no Redis adapter and no durable match history.
- **No rematch.** `TALLY` has no restart path; players leave to home.
- **NPC art is not size-budgeted.** `public/npc_images/` is 2.7 MB across eight files
  (249–574 KB each), against a 280 KB budget for all item art. It is loaded in the background
  after `create()` rather than in preload — see `loadNpcArtInBackground()` — so it does not
  gate match start, but people will pop in on a slow connection. Item art has a test-enforced
  64 KB-per-file cap; the NPC portraits have no equivalent and should get the same downscaling
  treatment.
- **Playwright uses in-memory authentication**, not MySQL. Database behaviour is covered only
  by the server integration suite, and only when `TEST_DATABASE_URL` is set.
- **Variable jitter and real multi-device play are unverified.** The automated suite covers
  four isolated Chromium contexts over loopback with one brief offline interval. The manual
  four-player shaped-network procedure in
  [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md#manual-four-player-test) has not been recorded
  as run.
- **The map and audio are procedural placeholders.** Keyboard only; no touch controls.
- **Logging is stdout/stderr.** No structured telemetry, traces, or alerts.
- **The lazy Phaser production chunk is large** (~1.7 MB raw, ~389 KB gzip at last successful
  build), though it is split from the shell and loads only on the match route.
- **The production-only dependency advisory scan has never completed.** `npm audit --omit=dev`
  could not reach the advisory endpoint in the audited run. Four moderate findings exist in
  the full dev tree. Do not treat this as passing.

---

## 10. Recommended next steps, in order

1. **Unbreak the build.** Apply the §3 patch, then confirm `npm run lint`, `npm run
   typecheck`, `npm test`, and `npm run build` are all green.
2. **Run `npm run e2e`** against the repaired build to reconfirm the four-context journey with
   NPCs present — the recorded pass predates HEAD by about a minute and the NPC feature
   changed the match scene substantially.
3. **Fix the doc drift in §8**, restoring `docs/DEPLOYMENT.md` from
   `git show 4c1bdae^:docs/DEPLOYMENT.md` unless it is genuinely unwanted.
4. **Downscale the NPC portraits** into `public/npc_images/` (keeping masters elsewhere, as
   the item pipeline does) and extend the art test with a per-file size cap. 2.7 MB of
   background art is the largest remaining client-performance item.
5. **Play the NPC feature by hand** with two or more clients. It has unit and integration
   coverage but has never been through the manual multi-client procedure: contest one person
   between two players, drop a person mid-carry, disconnect while carrying one, and confirm
   the recruit appears by name in the tally under `people`.
6. **Run the manual four-player shaped-network sign-off** from
   [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md#manual-four-player-test), recording browser,
   device, and network profiles.
7. **Complete step 13** ([steps.md:527](../steps.md#L527)) — deploy and verify on Railway plus
   Cloudflare Pages — and run the approved production-only dependency advisory scan before
   allowing public traffic.

---

## 11. Running it locally

```bash
npm ci
docker compose up -d db
docker compose exec db mysql -uroot -pmysql \
  -e "CREATE DATABASE IF NOT EXISTS sixtynine_seconds_test"
cp apps/server/.env.example apps/server/.env
cp apps/web/.env.example apps/web/.env
npm run db:migrate
npm run dev
```

Web at `http://localhost:5173`; Express and Socket.IO at `http://localhost:3001`; health
check at `GET http://localhost:3001/api/health`. The `CREATE DATABASE` line is one-time.

Verification commands:

```bash
npm run lint
npm run typecheck
npm test                                   # add TEST_DATABASE_URL for the 7 MySQL auth cases
npm run build
npm run e2e
npm test -w @69-seconds/shared             # target one workspace with -w
```

Integration tests refuse a `TEST_DATABASE_URL` whose database name does not contain `test`.
`DATABASE_URL` is required so the server fails fast rather than silently using an unintended
database. Every variable is documented in
[RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md#environment-variables).
