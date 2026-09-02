# 69 Seconds — Build Status

## Current milestone

Step 7 complete: authoritative one-to-four-player movement, countdown synchronization, local prediction/reconciliation, and remote interpolation.

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
- `packages/shared/src/loot.ts` supplies the original, data-driven grocery catalog and pure local inventory/deposit rules. Commands express only `PICK_UP`, `DEPOSIT`, or `NO_TARGET`; their accepted/rejected result is separate, preserving the seam where Step 8 will apply server acknowledgements instead of local decisions.
- Space selects the nearest available item inside the interaction radius, removes it from the world on successful pickup, and refuses a fifth item. At a cart, Space deposits all carried items only when that cart matches the local player's stable slot. Wrong carts, empty carts, full hands, unavailable items, and empty interaction range all produce explicit feedback.
- In-world prompts describe the closest item/cart context, including hands-full and wrong-cart states. Phaser publishes compact carry-slot and feedback events through the typed React bridge; React renders item-labelled carry slots, deposited count, and accessible feedback without rerendering the scene each frame.
- `R` performs a local debug reset: it restores every spawned item, clears local carry/deposit state, and updates the HUD. Ctrl remains the existing shove debug hook.
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

## Networking and prototype tuning

- Walk speed: 150 pixels/second.
- Sprint speed: 235 pixels/second (1.57× walk speed).
- Player collision radius: 15 pixels.
- Map: 1,800 × 1,200 pixels.
- Shelf collision footprint: 260 × 72 pixels; 12 shelves in three rows.
- Camera follow lerp: 0.10 on both axes.
- Camera minimum zoom: 1.0, increased to `max(viewport width / 1,800, viewport height / 1,200)` on resize.
- Local interaction feedback duration: 1,100 ms in-scene and 1,200 ms in the React overlay.
- Loot interaction radius: 64 pixels; cart interaction radius: 92 pixels.
- Local catalog/spawn count: 12 original placeholder items; carry limit: 4.
- Debug reset: `R`, local-only.
- Server simulation: 30 Hz fixed step (33.33 ms).
- Client input sampling/prediction: maximum 30 Hz fixed step.
- Server movement snapshots: 20 Hz (50 ms average cadence).
- Remote interpolation delay: 100 ms.

## Verification

Completed on 2026-09-02 with Node.js 22.6.0, npm 10.8.2, Phaser 4.2.1, and Vitest 3.2.7:

- `npm run lint` — passed with no errors or warnings.
- `npm run typecheck` — passed in all three workspaces.
- `npm test` — passed 43 tests: 13 shared, 12 server, and 18 web. The command ran with permission to bind an ephemeral localhost port; all four Socket.IO integration tests passed. The 7 MySQL auth integration cases remain skipped because `TEST_DATABASE_URL` was not supplied.
- New deterministic coverage validates strict no-position input payloads, ordered/stale sequences, countdown gating, walk/sprint displacement caps, shelf and boundary collision, safe input reset, exact tick/snapshot cadence, distinct four-player movement/spawns, initial Socket.IO countdown snapshot synchronization, acknowledged-input replay, and buffered remote interpolation.
- `npm run build` — passed for shared, server, and web. Vite produced the production bundle; the two existing non-failing Zod annotation-position notices and its advisory lazy-Phaser chunk-size warning remain.
- `git diff --check` — passed.

## Known limitations

- Active rooms are intentionally process-local and disappear on server restart. Production must use one application replica until a shared room store and Socket.IO adapter are designed; Redis remains deferred.
- Loot availability, carried inventory, and cart deposits remain the local prototype. They are intentionally absent from movement snapshots; Step 8 must replace the resolver with atomic server decisions using authoritative positions for distance checks.
- Sprint currently means the shared higher speed while Shift is held; a stamina/resource tradeoff remains the Step 9 design decision. Shove remains a phase-gated local debug hook.
- The simulation records the authoritative 69-second looting deadline and stops movement at it, but the complete atomic `LOOTING → TALLY` result flow remains Step 10.
- The generated grocery store, player, shelves, carts, and item markers remain original placeholders rather than Tiled/sprite assets. Collision is nevertheless server-authoritative.
- Player display labels are the account username; profiles carry no separate display name or avatar yet, so the account menu shows a letter tile built from the username.
- Browser-level multi-context Playwright coverage is still deferred; the current multiplayer lifecycle coverage uses real Socket.IO server/client connections at the server integration layer.
- Browser network shaping is not configured, so artificial latency/jitter behavior is covered by deterministic sequence, prediction, and interpolation tests rather than an automated manual browser run.
- The MySQL auth integration suite still requires an explicitly named test database through `TEST_DATABASE_URL`. The non-database root suite deliberately skips those 7 cases.
- The full development dependency tree retains the previously documented four moderate Drizzle Kit/esbuild audit findings; shipped runtime dependencies were previously verified clean.

## Recommended next step

Proceed exactly to Step 8 in `CODEX_BUILD_PROMPTS.md`: make loot availability, carried inventory, and assigned-cart deposits authoritative with atomic, idempotent server acknowledgements. Reuse authoritative player positions for interaction-distance validation and keep loot/inventory events separate from compact movement snapshots.
