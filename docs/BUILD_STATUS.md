# 69 Seconds — Build Status

## Current milestone

Step 5 complete: local Phaser 4 grocery-store movement prototype mounted in the authenticated match route.

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
- React Create Room, Join by Code, and Lobby views with responsive styling, accessible forms/buttons, server error presentation, player/host/ready/connection status, local socket reconnect status, ready toggling, host-only start, explicit leave, and refresh-safe room re-entry.
- Defensive cleanup includes per-player grace timers, an abandoned-room TTL sweep, and timer disposal during process/test shutdown. Room state remains in one process by design; Redis was not added.
- Shared runtime schemas and TypeScript event maps now cover all room commands, acknowledgements, connection states, lobby snapshots, closure notices, room codes, and additional typed errors.
- Server integration coverage exercises authenticated creation, normalized codes, one-to-four joins, fifth-player rejection, missing/malformed codes, reconnect deduplication, ready/start authority, already-started rejection, unauthenticated handshake rejection, disconnect-grace behavior, deterministic host migration, and abandoned-room cleanup.
- React component coverage exercises session/auth behavior plus Create Room, Join Room validation, authoritative lobby rendering, ready toggling, and the host start gate.
- Phaser 4.2.1 now mounts only after the room leaves `LOBBY`. The renderer is lazy-loaded into its own production chunk, owns a route-local canvas, and is destroyed with canvas removal when React unmounts the match view.
- The temporary 1,800 × 1,200 pixel grocery store uses original generated geometry: a tiled floor, checkout/spawn strip, perimeter treatment, and twelve shelf obstacles. No finished art or external game assets were added.
- WASD movement is continuous Arcade Physics velocity at the rendering frame rate. Shared pure rules resolve opposing keys, normalize all non-zero movement vectors, and apply walk or sprint speed, so diagonals have the same magnitude as cardinal movement.
- Shift selects sprint velocity. The placeholder player tracks eight facing directions and `idle_*`, `walk_*`, and `sprint_*` animation states while procedural shape/tint/facing cues stand in for future sprites.
- Arcade Physics enforces world-bound collision and static shelf collision. The camera follows with 0.10 horizontal/vertical lerp, stays inside map bounds, and increases its minimum zoom when a viewport is larger than the map so outside space is not exposed.
- Space and Ctrl are wired as local-only interact/shove hooks with short Phaser and React debug indicators. They do not emit network messages or alter gameplay state.
- A responsive React HUD overlays the canvas with the room/phase, controls, four empty carry slots, scene readiness, and a route-leave action.
- The focusable game surface scopes keyboard listeners to the match view, captures movement/action keys only while focused, prevents Space scrolling, and clears key state on focus/window loss to avoid stuck movement.
- Movement tests cover idle/opposing input, diagonal normalization, equal cardinal/diagonal walk magnitude, and sprint magnitude. Lifecycle tests cover idempotent game destruction, canvas removal, and teardown when leaving the React match route.

## Prototype tuning

- Walk speed: 150 pixels/second.
- Sprint speed: 235 pixels/second (1.57× walk speed).
- Player collision radius: 15 pixels.
- Map: 1,800 × 1,200 pixels.
- Shelf collision footprint: 280 × 76 pixels; 12 shelves in three rows.
- Camera follow lerp: 0.10 on both axes.
- Camera minimum zoom: 1.0, increased to `max(viewport width / 1,800, viewport height / 1,200)` on resize.
- Local action indicator duration: 650 ms in-scene and 700 ms in the React overlay.

## Verification

Completed on 2026-09-02 with Node.js 22.6.0, npm 10.8.2, Phaser 4.2.1, and Vitest 3.2.7:

- `npm run lint` — passed with no errors or warnings.
- `npm run build` — passed for shared, server, and web. Vite produced the production bundle; the two existing non-failing Zod annotation-position warnings remain.
- `npm run typecheck` — passed in all three workspaces.
- `npm test` — passed 26 tests: 9 shared, 6 server, and 11 web. The 7 MySQL auth integration cases were skipped because `TEST_DATABASE_URL` was not supplied; they were not changed by this milestone.
- The Socket.IO integration portion was run with permission to bind an ephemeral localhost port and passed all 4 lifecycle cases.
- `npm run dev -w @69-seconds/web -- --host 127.0.0.1` — Vite started successfully on port 5173; the React document and the lazy Phaser scene module both returned HTTP 200. Smooth speed/normalization and teardown are covered by automated tests; Arcade collision, bounded resize behavior, and focus ownership are exercised by the compiled scene implementation. Browser automation remains deferred.

## Known limitations

- Active rooms are intentionally process-local and disappear on server restart. Production must use one application replica until a shared room store and Socket.IO adapter are designed; Redis remains deferred.
- Starting currently hands the room to `COUNTDOWN` and records its deadline, but no authoritative simulation advances it to `LOOTING` yet. The local prototype intentionally permits movement in the mounted match view so game feel can be tuned before phase-gated authoritative simulation exists.
- The generated grocery store, player, shelves, debug actions, and empty inventory HUD are placeholders. There are no actual pickups, deposits, shove effects, multiplayer input/snapshots, prediction, reconciliation, interpolation, or tally behavior yet.
- Player display labels currently derive from the authenticated email local-part because account profiles do not yet have display names.
- Browser-level multi-context Playwright coverage is still deferred; the current multiplayer lifecycle coverage uses real Socket.IO server/client connections at the server integration layer.
- The MySQL auth integration suite still requires an explicitly named test database through `TEST_DATABASE_URL`. The non-database root suite deliberately skips those 7 cases.
- The full development dependency tree retains the previously documented four moderate Drizzle Kit/esbuild audit findings; shipped runtime dependencies were previously verified clean.

## Recommended next step

Proceed exactly to Step 6 in `CODEX_BUILD_PROMPTS.md`: build the complete local-only looting loop with a structured store map, shared loot, carry/deposit interactions, and assigned carts, without adding multiplayer synchronization yet.
