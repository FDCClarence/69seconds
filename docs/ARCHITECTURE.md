# 69 Seconds — Architecture

## Principles

The server is the sole game authority; shared code describes data and deterministic rules; the browser renders state and submits intent. Network data is untrusted and runtime-validated even when TypeScript says it has the expected shape. Durable account data and ephemeral match state have different owners.

## Package boundaries

### `packages/shared`

Owns framework-independent Zod schemas, inferred wire types, Socket.IO event maps, constants, and pure deterministic rules. It may depend on small cross-runtime libraries such as Zod. It must not import React, Phaser, Express, Socket.IO implementations, Node-only APIs, browser globals, databases, or mutable application stores.

Schemas are the source of truth for network shapes; TypeScript types are inferred from them. Pure rules accept values and return values without I/O or hidden state. Both apps import the package through `@69-seconds/shared`.

### `apps/server`

Owns process configuration, HTTP routes/middleware, Socket.IO transport, future sessions and persistence adapters, room registry, authoritative simulation, clocks, and concurrency resolution. Transport handlers validate payloads, recover trusted identity from the session/socket context, call domain/application services, and serialize public results. They do not trust player IDs, positions, inventory, phase, or timestamps supplied as claims by clients.

### `apps/web`

Owns React routes/screens, HTTP and Socket.IO clients, session UI state, accessibility, Phaser lifecycle, presentation interpolation/prediction, and the React/Phaser bridge. It may use shared schemas to validate server data before placing it in client state. It never makes an outcome authoritative.

## State ownership

| State | Canonical owner | Durable? | Client behavior |
| --- | --- | --- | --- |
| Account/session | Server + MySQL | Yes | Restore through HTTP cookie session |
| Room membership/host/readiness | Server room registry | No (MVP) | Render snapshots; send intents |
| Phase and phase deadline | Server match clock | No | Estimate display from server time |
| Positions and sprint constraints | Server simulation | No | Predict/interpolate, then reconcile |
| Loot availability/inventory/cart deposits | Server match loot authority | No | Request actions; predict a pickup, roll back on refusal |
| Final tally | Server simulation/result | Match-scoped initially | Display immutable result |
| Routes/forms/HUD/camera/animation | Web app | No | Local presentation only |

Active rooms live in one server process for the MVP. Redis, horizontal match distribution, replay storage, and durable match history are deferred.

## HTTP and authentication flow

1. React sends register/login/logout/current-user requests over HTTPS with credentials included.
2. Express validates JSON bodies against shared or server-owned request schemas.
3. The auth service reads/writes MySQL through Drizzle, hashes passwords with Argon2id, and creates 256-bit opaque server-side session tokens. MySQL stores only SHA-256 token digests.
4. Express sets a host-only, HTTP-only, Secure-in-production, deliberately configured SameSite cookie. JavaScript never reads a credential token. Login deletes the presented session before issuing a replacement.
5. Protected HTTP middleware resolves the cookie to a trusted user and attaches that identity to the request.
6. Responses expose only public user data and stable typed error codes.

The committed migrations create normalized, uniquely indexed users and expiring sessions with cascading deletion. `requireAuth` resolves unexpired sessions and attaches the trusted database user to the request. Register/login share an IP rate limit. Exact-origin credentialed CORS, proxy hops, cookie lifetime, and SameSite policy are explicit environment configuration; production derives `Secure` from `NODE_ENV`. The `/api/health` route remains deliberately unauthenticated.

## Socket.IO connection and message flow

1. The browser first restores its HTTP session.
2. Socket.IO connects with cookies/credentials; connection middleware resolves the same server session and stores the trusted `playerId`, username, and account email in socket data. Missing, expired, and invalid sessions fail the handshake with `UNAUTHENTICATED`.
3. Room create/join/leave, ready, and start commands locate a server-owned in-memory room and authorize that trusted player. Clients never submit an identity, slot, readiness for another player, or host claim.
4. During gameplay the client emits intent events: `input:update`, `interaction:request`, and `shove:request`.
5. The transport parses each payload with its shared Zod schema, applies rate/size controls, and passes validated intent to the room simulation.
6. The authoritative tick validates phase, movement limits, collision, proximity, inventory, loot availability, cart ownership, sprint, and shoves.
7. The server emits increasing-sequence `state:snapshot` messages, per-socket `loot:sync` state, and room-wide `loot:update` changes. `interaction:request` is answered by a typed acknowledgement; a malformed payload also produces `game:error` with a stable code.
8. The browser runtime-validates snapshots/syncs/updates/errors, ignores stale sequences, reconciles local presentation, and never mutates canonical server state.

The room handlers return typed acknowledgement unions while broadcasting runtime-validated `lobby:state` snapshots. Movement input and loot interactions now both enter the authoritative room simulation; only the shove handler remains validation-only until its focused milestone.

## Authoritative movement networking

- Every active match runs a deterministic 30 Hz fixed-step simulation. Movement distance is derived only from shared walk/sprint speeds, normalized directional booleans, and the fixed step; client timestamps do not advance the simulation.
- The browser sends strict, sequenced input state at no more than 30 Hz. The payload contains WASD booleans and a sprint boolean, never a position or velocity claim. Stale/duplicate sequences are ignored and input backlog is bounded.
- `packages/shared` owns the 1,800 × 1,200 bounds, four slot-indexed spawn points, shelf rectangles, circle-vs-rectangle validity rule, and axis-separated movement integration. Both the server and local predictor consume that representation; Phaser collision is presentation support rather than authority.
- The server broadcasts compact movement snapshots at 20 Hz. A snapshot contains room code, snapshot sequence, server phase/deadline, and each player's position, sprint presentation state, and last processed input sequence. Lobby membership, loot, and inventories are not repeated in this high-frequency message.
- The local Phaser player advances immediately on the same 30 Hz fixed step. On a snapshot it resets to the authoritative position, drops inputs through the acknowledged sequence, and replays only remaining inputs.
- Remote players retain timestamped snapshots and render 100 ms behind estimated server time, interpolating between samples. Stale snapshots and stale interpolation samples are ignored.
- Starting assigns four separated, collision-safe positions and synchronizes `COUNTDOWN` through lobby state plus an initial movement snapshot. The server advances to `LOOTING` at the countdown deadline and broadcasts the phase change; movement and local action hooks are gated until then.
- Disconnect and reconnect clear held server input and reset per-connection input sequencing, preventing stuck movement. Authoritative position and stable room slot remain in the existing room grace lifecycle.

## Authoritative loot networking

- `MatchLootAuthority` owns the match item set, generated from the shared store map's loot spawns and carts. An item is in exactly one place at any moment: on a shelf, in one player's hands, or in one cart. Cart ownership is derived from the stable room slot, never from a client claim.
- The authority is composed into the room simulation, so interaction validation reuses the same authoritative position the movement tick produced. A client can narrow its own prompt but can never widen its reach.
- Each request is validated in a fixed order: membership, duplicate request ID, phase and deadline, rate limit, target existence, interaction radius, line of access, availability, then carry capacity or cart ownership. Every rejection has a stable typed reason.
- Every decision runs to completion synchronously on the event loop, with no `await` between reading an item's availability and claiming it. Two clients racing for one item are therefore serialized, and exactly one can observe it as available.
- Acknowledgements are typed and per request: `PICKED_UP`, `DEPOSITED`, or `REJECTED` with a reason. Every acknowledgement restates the requester's authoritative carried item IDs, which is what lets an optimistic client confirm or roll back from the ack alone.
- Only committed decisions are remembered for idempotency, keyed by request ID and bounded per player. A resent request ID replays its original acknowledgement and broadcasts nothing further, so a duplicate delivery can never double-apply. Rejections stay re-evaluable, so a legitimate retry after a rate limit or a phase edge is judged on fresh state.
- Interaction spam is bounded by a per-player token bucket sized for deliberate key presses rather than held keys. A duplicate request ID is matched before the bucket is charged, so retries do not consume budget.
- `loot:sync` is addressed to a single socket because it carries that player's private carried item IDs; it is sent on match start and after a reconnection. `loot:update` is broadcast to the room and carries only public facts: which item was taken, which items entered which cart, and each player's carried *count*. Another player's inventory contents are never published.
- Loot never travels in the 20 Hz movement snapshot. Availability changes are events, not periodic state, so the high-frequency message stays compact.
- The client predicts a pickup only: the marker hides and a dashed carry slot appears immediately, and both are restored if the server refuses or never answers. Deposits wait for confirmation, because reversing four slots reads worse than a brief pause.
- Removing a player restocks whatever they were still holding and clears their cart ownership, while their deposited items stay in the cart so the tally keeps crediting completed work.

## In-memory room lifecycle

- `RoomRegistry` owns active codes, user-to-room membership, stable slots, host identity, readiness, phase, socket sets, reconnect timers, and abandoned-room cleanup. Socket handlers only validate/authorize/translate transport events.
- Codes contain six cryptographically selected characters from an ambiguity-free alphabet. Allocation checks the active registry and retries collisions.
- One user maps to at most one room and one roster entry, while that entry may own multiple socket IDs during a refresh overlap or multiple tabs.
- Losing the last socket marks the player `RECONNECTING` for 15 seconds. The same authenticated user reattaches to the existing member. Once grace expires, the member is removed and the lowest remaining slot becomes host; an empty room closes.
- The host may start only from `LOBBY` when every rostered player (host included) is both connected and ready. Start changes the authoritative phase to `COUNTDOWN`, sets the three-second phase deadline, and locks out new joins. The later gameplay-networking milestone owns advancing and simulating subsequent phases.
- A periodic TTL sweep is a defensive backstop for wholly disconnected rooms, while per-player timers normally close them sooner. Registry shutdown clears timers so test/process teardown cannot mutate disposed state.

## Server authority and time

The match service owns the transition graph and an absolute `phaseEndsAtMs`. On each authoritative update—and before applying queued actions—it checks the deadline. `LOOTING` lasts 69,000 ms by the server timeline. Network latency can change when a client sees an update, never the recorded deadline or accepted result.

Client input sequence numbers support deduplication/order checks but do not prove time. Request IDs correlate interaction errors and make later idempotency possible. Snapshot sequence numbers allow clients to discard stale state.

Public snapshots contain only information all room participants may know. Server-private state (session data, input queues, cooldown bookkeeping, collision internals, and anti-abuse measurements) must use separate internal types rather than expanding public state.

## Runtime validation boundary

- Parse every HTTP body, parameter, query, cookie-derived identifier, Socket.IO inbound payload, persisted JSON blob, and untrusted third-party response before domain use.
- Parse or construct-check public outbound messages where practical; tests assert that emitted fixtures match shared schemas.
- Convert validation failures to typed errors without returning stack traces or Zod internals.
- TypeScript event maps improve development ergonomics but are not security controls.

## React-to-Phaser transition

React remains the application shell: authentication, home/lobby routes, loading/errors, match HUD, tally overlay, and navigation. Phaser 4 is introduced only on the match route and owns the canvas, scenes, map, physics bodies, sprite animation, camera, and local input sampling.

The match route creates one game instance after its host element mounts and destroys it—including scenes and input listeners—on unmount. React does not rerender the simulation each frame. A narrow typed bridge passes:

- React/network → Phaser: validated snapshots, connection/phase changes, and immutable configuration.
- Phaser → React/network: sampled input intent, interaction/shove intent, and low-frequency HUD presentation events.

The Socket.IO client should live outside Phaser scenes (in a match controller/service) so reconnects survive scene replacement and can be tested independently. Domain calculations that do not require Phaser types move into `packages/shared`. Phaser-specific collision/vector/scene logic stays in `apps/web`.

React owns LOBBY and the countdown overlay while mounting Phaser behind `COUNTDOWN`. Phaser receives snapshots through the room client rather than owning the socket. At TALLY, the controller will disable Phaser input immediately on authoritative phase change while React presents the result overlay; route teardown still performs final destruction.

## Testing strategy

- Shared: schema fixtures, rejection cases, constants, and pure rules with Vitest.
- Server: HTTP tests, Socket.IO integration tests, room/simulation/loot-authority unit tests, fake authoritative clock, and authority/concurrency cases. The loot authority accepts injected spawns, carts, and collision, and `attachSocketServer` accepts an equivalent seam, so integration tests can exercise contested pickups without walking a player across the store.
- Web: React/controller unit tests, Phaser lifecycle tests around a small bridge, and schema handling.
- End-to-end: Playwright for auth, room lifecycle, multiple browser contexts, the 69-second transition using controlled test timing, and tally consistency.

Root build order is shared → server → web. Root tests include a consumer test in each app so a broken shared package boundary is caught early.
