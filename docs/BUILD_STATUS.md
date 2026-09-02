# 69 Seconds — Build Status

## Current milestone

Step 4 complete: authenticated private-room creation/joining and the authoritative lobby lifecycle.

## Implemented

- The existing PostgreSQL/Drizzle authentication backend remains the identity source. Socket.IO now authenticates its handshake from the same HTTP-only session cookie and rejects missing, expired, or invalid sessions with typed `UNAUTHENTICATED` connection errors.
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

## Verification

Completed on 2026-09-02 with Node.js 22.6.0, npm 10.8.2, and Vitest 3.2.7:

- `npm run lint` — passed with no errors or warnings.
- `npm run build` — passed for shared, server, and web. Vite produced the production bundle; the two existing non-failing Zod annotation-position warnings remain.
- `npm run typecheck` — passed in all three workspaces.
- `npm test` — passed 20 tests: 5 shared, 6 server, and 9 web. The 7 PostgreSQL auth integration cases were skipped because `TEST_DATABASE_URL` was not supplied; they were not changed by this milestone.
- The Socket.IO integration portion was run with permission to bind an ephemeral localhost port and passed all 4 lifecycle cases.

## Known limitations

- Active rooms are intentionally process-local and disappear on server restart. Production must use one application replica until a shared room store and Socket.IO adapter are designed; Redis remains deferred.
- Starting currently hands the room to `COUNTDOWN` and records its deadline, but no authoritative simulation advances it to `LOOTING` yet. Phaser gameplay, movement, interactions, snapshots, and tally remain later milestones.
- Player display labels currently derive from the authenticated email local-part because account profiles do not yet have display names.
- Browser-level multi-context Playwright coverage is still deferred; the current multiplayer lifecycle coverage uses real Socket.IO server/client connections at the server integration layer.
- The PostgreSQL auth integration suite still requires an explicitly named test database through `TEST_DATABASE_URL`. The non-database root suite deliberately skips those 7 cases.
- The full development dependency tree retains the previously documented four moderate Drizzle Kit/esbuild audit findings; shipped runtime dependencies were previously verified clean.

## Recommended next step

Proceed exactly to Step 5 in `CODEX_BUILD_PROMPTS.md`: build the local Phaser 4 movement prototype inside the authenticated match route, keep movement constants and pure calculations in `packages/shared`, verify normalized continuous WASD/sprint movement and Phaser teardown, and do not add multiplayer simulation, pickups, or finished assets yet.
