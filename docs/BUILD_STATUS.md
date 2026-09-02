# 69 Seconds — Build Status

## Current milestone

Step 8 complete: authoritative loot availability, private carried inventory, and assigned-cart deposits, with atomic contested pickups, typed idempotent acknowledgements, and reconnect-safe resynchronization.

## Implemented

- The existing MySQL/Drizzle authentication backend remains the identity source. Socket.IO now authenticates its handshake from the same HTTP-only session cookie and rejects missing, expired, or invalid sessions with typed `UNAUTHENTICATED` connection errors.
- The existing React registration, login, session restoration, protected home, and logout experience is preserved and now connects to the room flow.
- A server-owned in-memory `RoomRegistry` manages room codes, distinct membership, stable slots, host identity, readiness, phase, socket attachment, reconnection timers, host migration, and cleanup.
- Room codes are six uppercase characters generated with Node cryptographic randomness from an alphabet that omits `0`, `1`, `I`, `L`, and `O`. Active-room collisions are checked and retried.
- Authenticated commands and typed acknowledgements for `room:create`, `room:join`, `room:leave`, `lobby:ready`, and `lobby:start`, plus authoritative `lobby:state` and `room:closed` broadcasts.
- One to four distinct authenticated users may join. A user maps to one roster entry even when a refreshed tab briefly overlaps the old socket or the user has multiple sockets.
- Disconnected players remain visible as `RECONNECTING` for a 15-second grace window. Reconnecting as the same authenticated user restores the existing slot, readiness, and host status without duplication.
- Explicit leave removes a player immediately; grace expiry removes a still-disconnected player. When the host is removed, host status migrates deterministically to the remaining player with the lowest stable slot. The room closes when its last player is removed.
- The documented start rule is enforced on the server and shown in the lobby: every rostered player, including the host, must be connected and ready; a one-player room is valid under that rule; only the current host can start.
- Starting changes the room to `COUNTDOWN`, records the server-owned three-second deadline, locks new joins, and leaves existing members eligible to reconnect as themselves.
- Stable typed failures cover malformed requests, unauthenticated sockets, missing/full/started rooms, membership conflicts, non-members, non-host starts, readiness failures, and invalid phases.
- A minimal React shell: the landing page is the login/register form, the authenticated home is one centered menu holding Create Room and a Join Room code field, and every signed-in screen shares a top bar whose account menu (avatar tile, email, chevron) holds Log out. Lobby, server error presentation, player/host/ready/connection status, local socket reconnect status, ready toggling, host-only start, explicit leave, and refresh-safe room re-entry are unchanged.
- Defensive cleanup includes per-player grace timers, an abandoned-room TTL sweep, and timer disposal during process/test shutdown. Room state remains in one process by design; Redis was not added.
- Shared runtime schemas and TypeScript event maps now cover all room commands, acknowledgements, connection states, lobby snapshots, closure notices, room codes, and additional typed errors.
- Server integration coverage exercises authenticated creation, normalized codes, one-to-four joins, fifth-player rejection, missing/malformed codes, reconnect deduplication, ready/start authority, already-started rejection, unauthenticated handshake rejection, disconnect-grace behavior, deterministic host migration, and abandoned-room cleanup.
- React component coverage exercises session/auth behavior, username-or-email login, the account menu (open, outside-click close, log out), Create Room, Join Room validation, authoritative lobby rendering, ready toggling, and the host start gate.
- Phaser 4.2.1 now mounts only after the room leaves `LOBBY`. The renderer is lazy-loaded into its own production chunk, owns a route-local canvas, and is destroyed with canvas removal when React unmounts the match view.
- The temporary 1,800 × 1,200 pixel grocery store uses original generated geometry: a tiled floor, checkout/spawn strip, perimeter treatment, and twelve shelf obstacles. No finished art or external game assets were added.
- WASD movement is continuous Arcade Physics velocity at the rendering frame rate. Shared pure rules resolve opposing keys, normalize all non-zero movement vectors, and apply walk or sprint speed, so diagonals have the same magnitude as cardinal movement.
- Shift selects sprint velocity. The placeholder player tracks eight facing directions and `idle_*`, `walk_*`, and `sprint_*` animation states while procedural shape/tint/facing cues stand in for future sprites.
- Arcade Physics enforces world-bound collision and static shelf collision. The camera follows with 0.10 horizontal/vertical lerp, stays inside map bounds, and increases its minimum zoom when a viewport is larger than the map so outside space is not exposed.
- Space and Ctrl are wired as local-only interact/shove hooks with short Phaser and React debug indicators. They do not emit network messages or alter gameplay state.
- A responsive React HUD overlays the canvas with the room/phase, controls, four empty carry slots, scene readiness, and a route-leave action.
- The focusable game surface scopes keyboard listeners to the match view, captures movement/action keys only while focused, prevents Space scrolling, and clears key state on focus/window loss to avoid stuck movement.
- `apps/web/src/game/maps/grocery-store-placeholder-map.ts` now provides a clearly documented generated placeholder map while Tiled art/assets are unavailable. Its rendered floor/shelf layer, invisible shelf-collision layer, and spawn/cart/loot object layer are deliberately separate so a later Tiled JSON export has a compatible boundary.
- The generated 1,800 × 1,200 store has a labelled central spawn pad, three rows of shelf aisles, 12 data-driven item spawn points, and four slot-assigned carts along the bottom checkout lane. Slot `0`–`3` maps locally to `cart-0`–`cart-3`; the matching cart is visibly highlighted.
- A grid route-verifier test proves the central spawn has a collision-safe path to every loot spawn and every cart interaction point. It is a layout regression check, not server collision authority.
- `packages/shared/src/loot.ts` supplies the original, data-driven grocery catalog plus pure cart-ownership rules. The Step 6 local resolver is gone: `packages/shared/src/map.ts` now owns the 12 loot spawn points and four cart definitions so the server generates the match loot set from the same data the client draws.
- Space nominates the target the client believes is nearest and the server decides. The client can also send `INTERACT` with no target and let the server choose the nearest reachable item, then its own cart.
- In-world prompts describe the closest item/cart context, including hands-full, wrong-cart, and not-yet-synchronized states, and they mirror the server's radius and line-of-access checks so a prompt never promises an interaction the server would refuse. Phaser publishes compact carry-slot and feedback events through the typed React bridge; React renders item-labelled carry slots, deposited count, and accessible feedback without rerendering the scene each frame.
- The `R` local debug reset is removed, along with its key capture and HUD hint: loot is server-owned and a client can no longer restock the store. Ctrl remains the existing shove debug hook.
- Movement tests cover idle/opposing input, diagonal normalization, equal cardinal/diagonal walk magnitude, and sprint magnitude. Lifecycle tests cover idempotent game destruction, canvas removal, and teardown when leaving the React match route.
- Active matches now run a server-owned 30 Hz fixed-step simulation and emit compact movement snapshots at 20 Hz rather than at render frequency.
- The client sends strict, sequenced WASD/sprint input state at a maximum 30 Hz; it never sends a trusted position or velocity. The server ignores stale/duplicate sequences, bounds queued input, and derives all displacement from shared walk/sprint constants.
- The shared package now owns the 1,800 × 1,200 bounds, shelf collision rectangles, player-radius validity checks, axis-separated sliding integration, and four slot-indexed safe spawn positions. Server authority and Phaser prediction consume the same representation.
- Starting a ready lobby assigns separated spawns, broadcasts `COUNTDOWN`, and emits an initial compact snapshot. The server advances to `LOOTING` at the countdown deadline and broadcasts that phase change; movement and local action hooks are gated until then.
- The local Phaser player predicts immediately on the same 30 Hz step. Each snapshot resets it to the authoritative position, removes inputs through the acknowledged sequence, and replays only unacknowledged inputs.
- Remote players use timestamped per-player buffers, rendering 100 ms behind estimated server time and interpolating between snapshots while rejecting stale samples.
- The existing React-owned Socket.IO client remains outside Phaser. Its narrow bridge samples inputs and supplies runtime-validated snapshots without causing React to render per frame.
- Disconnect/reconnect clears held server input and resets connection-local sequencing while preserving the existing 15-second authoritative room slot and position.
- A synchronized React countdown overlay now appears while Phaser preloads. High-frequency movement snapshots contain only phase/time and public movement state; they do not repeat lobby, loot, inventory, or cart state.

- A server-owned `MatchLootAuthority` generates the match loot set from the shared store map, assigns stable item IDs, and owns availability, carried inventories, and cart contents. An item is on a shelf, in one player's hands, or in one cart, and never in two places.
- The authority is composed into the room simulation, so every interaction is validated against the authoritative position that the movement tick produced rather than anything the client claims.
- Each request is validated for membership, duplicate request ID, phase and looting deadline, rate limit, target existence, interaction radius, line of access, availability, and then carry capacity or cart ownership. Cart ownership is derived from the stable room slot.
- Contested pickups resolve atomically: the availability read and the claim happen with no `await` between them, so two or four clients racing for one item produce exactly one winner and exactly one broadcast.
- `interaction:request` now carries a typed acknowledgement: `PICKED_UP`, `DEPOSITED`, or `REJECTED` with one of eleven stable reasons. Every acknowledgement restates the requester's authoritative carried item IDs.
- The request schema is strict, so a modified client cannot smuggle a claimed outcome, a position, or an inventory alongside its intent. A malformed payload is answered with an `INVALID_PAYLOAD` rejection and also reported on `game:error`.
- Committed decisions are remembered per player by request ID, bounded to the last 32. A resent request ID replays its original acknowledgement and emits no second broadcast; rejections stay re-evaluable so a legitimate retry is judged on fresh state.
- Interaction spam is bounded by a per-player token bucket of six with a six-per-second refill. Duplicate request IDs are matched before the bucket is charged, so retries never consume budget.
- `loot:sync` is addressed to one socket because it carries that player's private carried item IDs; it is sent at match start and on reconnection, and restores the exact world, hands, and cart contents. `loot:update` is broadcast and carries only public facts: the item taken, items entering a cart, and each player's carried *count*.
- Carried item contents are never published to other players, and the broadcast schema rejects any attempt to include them. Cart contents are public.
- Loot never rides in the 20 Hz movement snapshot; availability changes travel as compact events instead.
- The Phaser client predicts a pickup only. The marker hides and a dashed carry slot appears immediately, and both are restored on refusal, on a competing player's confirmed pickup, or when no acknowledgement arrives. Deposits wait for confirmation. A resynchronization discards every prediction, because the sync already reflects every committed decision.
- Leaving or timing out mid-match restocks whatever the player still held and clears their cart ownership, while their deposited items stay in the cart.

## Networking and prototype tuning

- Walk speed: 150 pixels/second.
- Sprint speed: 235 pixels/second (1.57× walk speed).
- Player collision radius: 15 pixels.
- Map: 1,800 × 1,200 pixels.
- Shelf collision footprint: 260 × 72 pixels; 12 shelves in three rows.
- Camera follow lerp: 0.10 on both axes.
- Camera minimum zoom: 1.0, increased to `max(viewport width / 1,800, viewport height / 1,200)` on resize.
- Local interaction feedback duration: 1,100 ms in-scene and 1,200 ms in the React overlay.
- Loot interaction radius: 64 pixels; cart interaction radius: 92 pixels. Both are validated server-side against authoritative positions, and a shelf between player and target blocks the interaction.
- Server loot set: 12 original placeholder items from the shared map; carry limit: 4; four slot-assigned carts.
- Interaction rate limit: token bucket of 6, refilling 6 per second, per player.
- Idempotency history: last 32 committed decisions per player.
- Server simulation: 30 Hz fixed step (33.33 ms).
- Client input sampling/prediction: maximum 30 Hz fixed step.
- Server movement snapshots: 20 Hz (50 ms average cadence).
- Remote interpolation delay: 100 ms.

## Verification

Completed on 2026-09-02 with Node.js 22.6.0, npm 10.8.2, Phaser 4.2.1, and Vitest 3.2.7:

- `npm run lint` — passed with no errors or warnings.
- `npm run typecheck` — passed in all three workspaces.
- `npm test` — passed 80 tests: 16 shared, 36 server, and 28 web. The command ran with permission to bind an ephemeral localhost port; all ten Socket.IO integration tests passed. The 7 MySQL auth integration cases remain skipped because `TEST_DATABASE_URL` was not supplied.
- New deterministic loot coverage validates two-player and four-player contested pickups resolving to one winner, carry-capacity overflow, out-of-range and unknown-target claims, line-of-access refusal, wrong-cart and empty-hands deposits, re-picking a deposited item, duplicate-request-ID replay for both pickups and deposits, phase and deadline closure, rate limiting followed by a successful refilled press, reconnect resynchronization including private hands, mid-match restocking, slot-derived cart ownership across membership changes, and server-chosen nearest targets.
- New client coverage validates the pure loot view: predicted pickups hiding a marker, confirmation, rollback on refusal, rollback on a missing acknowledgement, refusal to predict past capacity, settling a prediction a rival won, cart accumulation, restocking, stale-sequence rejection, and prediction discard on resynchronization.
- New Socket.IO loot integration coverage validates per-socket loot sync at match start, a genuine two-client race for one item, malicious range/cart/target/payload claims, the parallel `game:error` report, reconnect restoration of hands and cart, and four clients staying consistent through pickups, deposits, and a replayed deposit.
- Earlier deterministic coverage is unchanged: strict no-position input payloads, ordered/stale sequences, countdown gating, walk/sprint displacement caps, shelf and boundary collision, safe input reset, exact tick/snapshot cadence, distinct four-player movement/spawns, initial Socket.IO countdown snapshot synchronization, acknowledged-input replay, and buffered remote interpolation.
- `npm run build` — passed for shared, server, and web. Vite produced the production bundle; the two existing non-failing Zod annotation-position notices and its advisory lazy-Phaser chunk-size warning remain.
- `git diff --check` — passed.

## Known limitations

- Active rooms are intentionally process-local and disappear on server restart. Production must use one application replica until a shared room store and Socket.IO adapter are designed; Redis remains deferred.
- Deposited items are counted but not yet scored or presented as a result; the atomic `LOOTING → TALLY` flow that reads cart contents remains Step 10.
- Line-of-access validation is defence in depth for future map data. The current 72-pixel shelves are thicker than the 64-pixel item reach and the carts sit clear of every shelf, so the production geometry cannot currently trigger that rejection; it is covered with an injected thin partition.
- `attachSocketServer` and `MatchLootAuthority` accept injected spawns, carts, and collision, and `RoomRegistry` accepts an injected countdown duration. These are test seams; production always uses the shared store map and the 3-second countdown.
- Sprint currently means the shared higher speed while Shift is held; a stamina/resource tradeoff remains the Step 9 design decision. Shove remains a phase-gated local debug hook.
- The simulation records the authoritative 69-second looting deadline and stops movement at it, but the complete atomic `LOOTING → TALLY` result flow remains Step 10.
- The generated grocery store, player, shelves, carts, and item markers remain original placeholders rather than Tiled/sprite assets. Collision and loot placement are nevertheless server-authoritative.
- Player display labels are the account username; profiles carry no separate display name or avatar yet, so the account menu shows a letter tile built from the username.
- Browser-level multi-context Playwright coverage is still deferred; the current multiplayer lifecycle coverage uses real Socket.IO server/client connections at the server integration layer.
- Browser network shaping is not configured, so artificial latency/jitter behavior is covered by deterministic sequence, prediction, and interpolation tests rather than an automated manual browser run.
- The MySQL auth integration suite still requires an explicitly named test database through `TEST_DATABASE_URL`. The non-database root suite deliberately skips those 7 cases.
- The full development dependency tree retains the previously documented four moderate Drizzle Kit/esbuild audit findings; shipped runtime dependencies were previously verified clean.

## Recommended next step

Proceed exactly to Step 9 in `CODEX_BUILD_PROMPTS.md`: turn sprint into a server-owned resource and make shove a real authoritative mechanic. Reuse the existing interaction request/acknowledgement pattern for shove rather than inventing a second one, keep the shove impulse inside the shared movement integration so prediction and authority stay identical, and preserve the loot authority's atomicity when a shove interrupts a player who is carrying items.
