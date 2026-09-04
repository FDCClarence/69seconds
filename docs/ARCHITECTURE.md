# 69 Seconds — Architecture

## Principles

The server is the sole game authority; shared code describes data and deterministic rules; the browser renders state and submits intent. Network data is untrusted and runtime-validated even when TypeScript says it has the expected shape. Durable account data and ephemeral match state have different owners.

## Package boundaries

### `packages/shared`

Owns framework-independent Zod schemas, inferred wire types, Socket.IO event maps, constants, and pure deterministic rules. It may depend on small cross-runtime libraries such as Zod. It must not import React, Phaser, Express, Socket.IO implementations, Node-only APIs, browser globals, databases, or mutable application stores.

Schemas are the source of truth for network shapes; TypeScript types are inferred from them. Pure rules accept values and return values without I/O or hidden state. Both apps import the package through `@69-seconds/shared`.

### `apps/server`

Owns process configuration, HTTP routes/middleware, Socket.IO transport, sessions and persistence adapters, room registry, authoritative simulation, clocks, and concurrency resolution. Transport handlers validate payloads, recover trusted identity from the session/socket context, call domain/application services, and serialize public results. They do not trust player IDs, positions, inventory, phase, or timestamps supplied as claims by clients.

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
2. Socket.IO connects with cookies/credentials; the handshake requires an allowed browser Origin and middleware resolves the same server session into trusted identity. Missing, expired, invalid, and revoked sessions fail or terminate with `UNAUTHENTICATED`; each connected socket is also closed at its database session expiry.
3. Room create/join/leave, ready, and start commands locate a server-owned in-memory room and authorize that trusted player. Clients never submit an identity, slot, readiness for another player, or host claim.
4. During gameplay the client emits intent events: `input:update`, `interaction:request`, and `shove:request`.
5. The transport parses each payload with its shared Zod schema, applies rate/size controls, and passes validated intent to the room simulation.
6. The authoritative tick validates phase, movement limits, collision, proximity, inventory, loot availability, cart ownership, sprint, and shoves.
7. The server emits increasing-sequence `state:snapshot` messages, per-socket `loot:sync` state, room-wide `loot:update` and `shove:landed` changes, and one immutable `match:tally` result at completion. `interaction:request` and `shove:request` are each answered by a typed acknowledgement; a malformed payload also produces `game:error` with a stable code.
8. The browser runtime-validates snapshots/syncs/updates/errors, ignores stale sequences, reconciles local presentation, and never mutates canonical server state.

The room handlers return typed acknowledgement unions while broadcasting runtime-validated `lobby:state` snapshots. Movement input, loot interactions, and shoves all now enter the authoritative room simulation; no gameplay handler remains validation-only.

## Authoritative movement networking

- Every active match runs a deterministic 30 Hz fixed-step simulation. Movement distance is derived only from shared walk/sprint speeds, normalized directional booleans, and the fixed step; client timestamps do not advance the simulation.
- The browser sends strict, sequenced input state at no more than 30 Hz. The payload contains WASD booleans and a sprint boolean, never a position or velocity claim. Stale/duplicate sequences are ignored and input backlog is bounded.
- `packages/shared` owns the 1,800 × 1,200 bounds, four slot-indexed spawn points, shelf rectangles, circle-vs-rectangle validity rule, and axis-separated movement integration. Both the server and local predictor consume that representation; Phaser collision is presentation support rather than authority.
- The server broadcasts compact movement snapshots at 20 Hz. A snapshot contains room code, snapshot sequence, server phase/deadline, and each player's position, effective sprint state, remaining stamina, exhaustion latch, recovery deadline, and last processed input sequence. Lobby membership, loot, and inventories are not repeated in this high-frequency message.
- The local Phaser player advances immediately on the same 30 Hz fixed step. On a snapshot it resets to the authoritative position, drops inputs through the acknowledged sequence, and replays only remaining inputs.
- Remote players retain timestamped snapshots and render 100 ms behind estimated server time, interpolating between samples. Stale snapshots and stale interpolation samples are ignored.
- Starting assigns four separated, collision-safe positions and synchronizes `COUNTDOWN` through lobby state plus an initial movement snapshot. The server advances to `LOOTING` at the scheduled countdown boundary, sets its end to that boundary plus 69,000 ms, and broadcasts the phase change; movement and local action hooks are gated until then. At the looting deadline it emits one final `SURVIVAL` snapshot carrying the day's deadline, then stops the 20 Hz stream: nothing moves during the day, so the phase/deadline pair a client needs is sent once rather than twenty times a second.
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

## Atomic tally result

- The simulation checks the wall-clock deadline before applying movement. Loot and shove authorities independently reject requests whose server receive time is at or beyond the same deadline, so a delayed timer callback cannot create a late action window.
- On the first tick at or beyond the deadline, the simulation synchronously changes `LOOTING → SURVIVAL`, sets the day's deadline to that looting deadline plus `GAME.survivalDurationMs` (120,000 ms), and reads cart contents from `MatchLootAuthority`. Deriving the deadline from the looting deadline rather than from receipt time means a delayed timer callback shortens the day instead of extending it, exactly as it does for looting. The resulting `MatchTally` is parsed through the shared strict schema and frozen in memory; later ticks return the same object and cannot emit a duplicate completion.
- Stable cart slots attribute deposits to the original match participants, including somebody disconnected or removed near the end. The result records whether each participant was connected at the buzzer, item labels/categories, per-player totals, and aggregate category totals. Carried items do not count.
- `match:tally` is broadcast once after the authoritative `SURVIVAL` room state, and is the frozen looting result the survival day is played from: per-player deposited items and recruits, player identities, and match membership. No client-owned copy of any of it exists. Reconnecting members receive the already committed result verbatim. The result is match-scoped and process-local; no durable history table is introduced.

## Survival households

- The same transition that freezes the looting result also derives the survival state from it, in the same synchronous tick, so the day's starting characters are one server decision rather than a value assembled per request. `initializeSurvivalState` in `packages/shared` is the only implementation; it reads a `MatchTally` and nothing else — no clock, no socket, no client message.
- Starting stats and per-NPC overrides are data in `packages/shared/src/survival-table.ts`. The engine never hard-codes a value, so giving one person 120 max health is a table edit, not a change to initialization. The override table is injectable, which is how the test suite proves override support without moving live balance.
- A main character and a recruited NPC are one representation, so a later feeding, drain, or death rule iterates a single list. Stats are current/max pairs with a per-character `max`; `isAlive` is explicit rather than derived from health.
- The result is parsed through the shared strict schema and deep-frozen, exactly as the looting result is. `survivalState()` returns that same object on every later tick.
- `survival:state` is broadcast once, after `match:tally`, and replayed verbatim to a reconnecting member. It is server-to-client only, so stats, maxes, daily costs, and alive state have no inbound path at all. The sole inbound survival event is the strict empty `survival:end-day` intent; authenticated socket identity supplies the household and the server supplies the day and deadline.
- The day number rides on that same state. The simulation holds the current day beside the phase and the deadline and passes it into `initializeSurvivalState`, which records the number it is handed rather than counting days itself; the buzzer opens `SURVIVAL.firstDayNumber` because the grocery run precedes Day 1. Only end-of-day resolution moves it, and no inbound event can reach it.
- Each later day is resolved from the previous day's committed state rather than rebuilt from the looting result, so households keep the characters, deposited inventory, and stat values they actually reached. `survival:state` is therefore broadcast once per day, not once per match, and a reconnecting member is replayed whichever day is current.

## Survival End Day readiness

- `SurvivalReadinessAuthority` tracks every household independently from the immutable character/inventory state. A manual End Day request locks only its authenticated owner; retries return the current state without another mutation or broadcast.
- The server tick auto-ends every unfinished household at the exact 120-second deadline. Manual completion timestamps remain untouched, and no timeout event is expected from a client.
- `survival:readiness` exposes each player's completion, the remaining active count, and `allPlayersEnded`. The latter changes synchronously when the final household ends, so a day that everybody finishes early is resolved early rather than at its deadline.

## Survival feeding

- `consumeSurvivalItem` in `packages/shared` is the only implementation of a feed. Like the engines beside it, it reads no clock, no socket, and no client message: it is a pure function of the committed day plus the intent, and it answers every restriction that the day itself can answer — the household must be the requester's own, the item must be in that inventory, the item must be food, the character must be in that household, and they must be alive. A rejected request returns the day untouched, so a failed feed can never cost an item.
- What an item restores is data in `survival-consumable-table.ts`, keyed by loot catalog id, so adding a consumable is a table edit rather than a code path. Restoration is clamped at the character's own `max`, and the microwave meal is expressed as `'MAX'` rather than a number precisely because two characters do not share a maximum. A recruited person is unreachable from here by construction: people are characters, and the engine only ever looks items up in `inventory`.
- `SurvivalConsumptionAuthority` on the server holds the two things a pure function cannot: the room's live gates and the committed request ledger. `SurvivalReadinessAuthority.dayActionStatus` supplies the gate as `OPEN`/`ALREADY_ENDED`/`DAY_CLOSED`/`NOT_A_HOUSEHOLD`, so "you already ended your day" and "the day is over" stay distinct answers rather than one shared false.
- Idempotency follows the loot authority's pattern: the ledger is keyed by request id per player and checked before every gate, so a duplicate delivery replays its original decision instead of being re-judged — including across a day rollover and after that household has ended its day. Only committed decisions are remembered, so a retry after a rejection is judged on fresh state. The ledger outlives any single day and is dropped when the player leaves the match.
- The result is a whole new deep-frozen `SurvivalState` that the simulation adopts, and the room receives it as `survival:state` — the same event a day rollover uses, because a committed day is one object the whole room shares. The acknowledgement restates the fed character and the household's remaining inventory so a client renders what the server decided; it is a restatement, never a submission, since `survival:consume` is a strict intent carrying only a request id, an item instance id, and a character id.

## Survival end-of-day resolution

- The tick that first observes `allPlayersEnded` resolves the day, whether every household pressed End Day or the deadline ended it for the stragglers. An End Day request never resolves a day inside the request itself, so a day is always closed by the server clock and one ledger field (`lastResolvedSurvivalDay`) makes it provably once per day.
- Resolution is one atomic step: `resolveSurvivalDay` in `packages/shared` spends each character's own Daily Nutrition and Hydration Cost, clamped at 0, and returns the next day's deep-frozen state with an incremented `dayNumber`; the simulation then adopts it, moves the phase deadline, and resets readiness for every household. No client ever observes a day that is over but unresolved, and the phase stays `SURVIVAL` throughout — the next day is the same phase, freshly opened.
- The next day opens at the earlier of the resolving tick and the closed day's deadline: finishing early starts the next day early, while a delayed timer callback closes the day it was meant to close instead of being handed the lost time. `resolveSurvivalDay` rejects any timestamp outside the closing day's own window, so a resolution time is never inferred from a clock inside the shared engine.
- The drained values are left standing as the authoritative numbers. Nobody is killed by resolution, and dead characters are not drained at all, which is what keeps the coming combined Nutrition + Hydration death rules reading exactly one day of cost.

## Authoritative sprint and shove

- Sprint is a server-owned stamina resource, not a client speed switch. `resolveSprint` in `packages/shared` is the single implementation of drain, refill, and the exhaustion latch; the 30 Hz server tick and the local predictor both step it, so a predicted bar and a predicted position can never disagree with the snapshot that follows. `docs/GAME_SPEC.md` holds the design decision and its balance values.
- Sprinting requires a held Shift, an actual movement input, and a bar that is neither empty nor latched. Emptying the bar latches exhaustion, and only the re-engage floor clears it, which is what stops a held Shift from flickering between walk and sprint every few ticks. An exhausted player still walks; sprint is denied, not movement.
- Stamina and recovery windows survive a reconnection by design. `resetInput` clears held input and per-connection sequencing without touching either, so dropping a socket cannot refill the bar or cancel a stun.
- `MatchShoveAuthority` owns shove cooldowns, the anti-spam bucket, and idempotency history. World state stays with the simulation: the authority is handed a read-only view of participants and returns a decision plus the effect to apply, which keeps the two concerns separable and the authority unit-testable.
- The server owns facing, derived from the last non-zero movement input it accepted. The request schema therefore carries no direction vector, which removes the obvious thing a modified client would forge. `targetPlayerId` is a nomination only, and omitting it makes the server choose the nearest reachable player inside the cone.
- Each request is validated in a fixed order: membership, duplicate request ID, phase and deadline, rate limit, the shover's own recovery window, cooldown, then the target's eligibility, range, facing cone, and line of access. Every rejection has a stable typed reason, and every acknowledgement restates the cooldown deadline.
- Knockback is a swept impulse resolved inside the same synchronous call, not a per-tick velocity. `sweepKnockback` steps along the push direction and keeps the last legal position, so knockback stops at geometry instead of tunnelling through it and can never leave a player in invalid map space. Carts block knockback although they do not block walking; `docs/GAME_SPEC.md` records why.
- Mutual shoves are deterministic for the same reason contested pickups are: resolution runs to completion on the event loop. The first request to arrive lands and puts its target into recovery, and a recovering player cannot shove, so the second request is refused. Exactly one shove lands.
- `shove:landed` is broadcast to the room with the target's authoritative post-knockback position, and it is the only trigger for shove animation and sound. The local target is corrected from that event immediately and clears its pending inputs; a remote target is left to the interpolation buffer, which reaches the same position from the next snapshot without fighting an already-smoothed path.
- The client predicts only the swing and the cooldown, so a shove reads as immediate while nobody moves until the server says so. The acknowledgement replaces the predicted cooldown with the real one, which rolls it back to zero when the attempt is refused outright.

## In-memory room lifecycle

- `RoomRegistry` owns active codes, user-to-room membership, stable slots, host identity, readiness, phase, socket sets, reconnect timers, and abandoned-room cleanup. Socket handlers only validate/authorize/translate transport events.
- Codes contain six cryptographically selected characters from an ambiguity-free alphabet. Allocation checks the active registry and retries collisions.
- One user maps to at most one room and one roster entry, while that entry may own multiple socket IDs during a refresh overlap or multiple tabs.
- Losing the last socket marks the player `RECONNECTING` for 15 seconds. The same authenticated user reattaches to the existing member. Once grace expires, the member is removed and the lowest remaining slot becomes host; an empty room closes.
- The host may start only from `LOBBY` when every rostered player (host included) is both connected and ready. Start changes the authoritative phase to `COUNTDOWN`, sets the three-second phase deadline, and locks out new joins. `COUNTDOWN → LOOTING → SURVIVAL` is one-way; a committed looting result has no restart mutation path.
- A periodic TTL sweep is a defensive backstop for wholly disconnected rooms, while per-player timers normally close them sooner. Registry shutdown clears timers so test/process teardown cannot mutate disposed state.

## Server authority and time

The match service owns the transition graph and an absolute `phaseEndsAtMs`. On each authoritative update—and before applying queued actions—it checks the deadline. `LOOTING` lasts exactly 69,000 ms from the scheduled countdown boundary by the server timeline, and `SURVIVAL` lasts at most 120,000 ms from the looting deadline. Both durations live only in `GAME`, so the client countdown and the server deadline read the same number. Network latency can change when a client sees an update, never the recorded deadline or accepted result. Clients extrapolate display time from the latest validated `serverTimeMs`/`phaseEndsAtMs` pair and never transition the match themselves.

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

React owns LOBBY and the countdown overlay while mounting Phaser behind `COUNTDOWN`. Phaser receives snapshots through the room client rather than owning the socket. On authoritative `SURVIVAL` room state, React replaces the match component, whose cleanup destroys the Phaser instance, canvas, scene subscriptions, and keyboard listeners; the survival screen is currently a placeholder behind the day transition. `apps/web/src/survival/DayTransition.tsx` owns that transition — the fade, the `Day #X` text, and its two-second life — so `App.tsx` only hands it the authoritative day and state id. Whether a day has already been announced is remembered by elapsed time in `day-transition-memory.ts`, a single `sessionStorage` note that keeps a remount or reconnect from replaying a finished fade and is deliberately not game state. The tally route waits for and runtime-validates `match:tally`, then renders only that server result and offers a room-leave action back to home.

## Testing strategy

- Shared: schema fixtures, rejection cases, constants, and pure rules with Vitest.
- Server: HTTP tests, Socket.IO integration tests, room/simulation/loot-authority unit tests, fake authoritative clock, and authority/concurrency cases. The loot authority accepts injected spawns, carts, and collision, and `attachSocketServer` accepts an equivalent seam, so integration tests can exercise contested pickups without walking a player across the store.
- Web: React/controller unit tests, Phaser lifecycle tests around a small bridge, and schema handling.
- End-to-end: Playwright for auth, room lifecycle, multiple browser contexts, the 69-second transition using controlled test timing, and tally consistency.

Root build order is shared → server → web. Root tests include a consumer test in each app so a broken shared package boundary is caught early.
