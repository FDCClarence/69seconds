# 69 Seconds — Game Specification

## First-playable scope

69 Seconds is a private-room browser game for one to four players. A match covers one grocery-store looting round: players leave a shared central spawn, collect shared items, carry at most four at once, deposit them in their assigned carts, and see a tally after exactly 69 server-timed seconds. Later resource-management phases are not part of this version.

This document defines the intended first playable. Authentication, the private-room lobby lifecycle, Phaser movement, authoritative multiplayer movement, and authoritative loot collection and cart deposits are implemented; the sprint resource, shove, timer/tally, and later match mechanics remain later milestones.

## Match lifecycle

1. **LOBBY** — Players join a private room, see membership/readiness, and wait for the host. Only the server may accept a start request and transition the room.
2. **COUNTDOWN** — The roster is fixed for the round, gameplay input cannot move or interact, and the server announces an absolute phase end time. The initial target is three seconds.
3. **LOOTING** — The server enables gameplay and sets `phaseEndsAtMs` to its current time plus exactly 69,000 ms. Players move, sprint, pick up/deposit loot, and shove subject to server validation.
4. **TALLY** — At the server deadline, movement, pickups, deposits, and shoves stop. The authoritative deposited items are tallied and displayed to every player.

Phase transitions are one-way for a match: `LOBBY → COUNTDOWN → LOOTING → TALLY`. A rematch lifecycle is out of scope until explicitly specified.

## Players, rooms, and spawning

- A private room contains one to four distinct authenticated users. Multiple sockets or a refreshed tab for one authenticated user never create another roster entry.
- Creation returns a six-character uppercase code generated with cryptographic randomness. Codes omit visually ambiguous `0`, `1`, `I`, `L`, and `O`; the server checks active-room collisions before issuing one.
- The room creator initially hosts. Before starting, every rostered player—including the host—must be connected and ready. A one-player room is valid under the same rule. Only the current host may start.
- A disconnected player remains on the roster as `RECONNECTING` for 15 seconds. Reconnecting with the same authenticated identity during that grace period restores the same slot, readiness, and host status.
- An explicit leave removes the player immediately. A disconnect that outlasts the grace period also removes the player. If the host is removed, host status migrates deterministically to the remaining player with the lowest stable slot; a room with no remaining players closes.
- New joins are rejected after the host starts. Started-room members may still reconnect as themselves during their grace window.
- Each player receives a stable slot from 0–3 and the matching cart. Four carts sit near the bottom of the map.
- Players spawn near the grocery store center at distinct collision-safe points.
- The server owns membership, slots, host identity, phase, spawn positions, and connection status. A client cannot claim these values.

## Controls and movement

- `W`, `A`, `S`, `D`: continuous, pixel-based movement. There is no tile stepping.
- Diagonal input is normalized so it is not faster than movement on one axis.
- `Shift`: sprint while held, limited by the server-owned stamina bar described below.
- `Space`: context interaction, including pickup or deposit where valid.
- `Ctrl`: request a shove against a valid nearby player, resolved as described below.
- Movement and action input has no gameplay effect outside `LOOTING`.
- The server validates speed, collision, timing, proximity, target availability, inventory capacity, cart ownership, and shove constraints. Clients may predict presentation but cannot decide outcomes.

Initial tunable values live in `packages/shared`: walk speed 150 px/s and sprint speed 235 px/s. They are placeholders until movement tuning.

## Sprint resource (stamina)

Decision: sprint is a **short stamina resource with server-owned drain and recovery**, not
unlimited sprint with a tradeoff elsewhere. A visible bar makes the cost legible without
adding a second control to learn, and the server already ticks player state at 30 Hz, so
draining there costs nothing extra in architecture.

- Every player starts each match with a **full** bar and recovers to full between matches.
- The bar drains while the player is actually sprinting, and refills whenever they are not
  — standing still and walking recover at the same rate.
- Refill is half the drain rate, so sprinting is a real budget rather than a default state.
- At zero the player keeps moving at walk speed; sprint is denied, not movement.
- Once exhausted, sprint stays locked until the bar climbs back to the re-engage threshold.
  Without that floor, a held `Shift` would stutter between walk and sprint every few ticks.
- Stamina is not spent by shoving. Shove is gated by its own cooldown so the two mechanics
  stay independently tunable.
- The bar neither drains nor refills outside `LOOTING`.

### Balance values

| Value | Initial setting | Rationale |
| --- | --- | --- |
| Bar capacity | 100 units | Renders directly as a percentage. |
| Drain while sprinting | 12 units/s | A full bar buys 8.3 s of sprint. |
| Refill while not sprinting | 6 units/s | Empty to full takes 16.7 s. |
| Re-engage threshold after exhaustion | 20 units | 3.3 s of walking before sprint returns. |

Consequences of those numbers: a full bar covers roughly 1,960 px of sprint, just past one
horizontal crossing of the 1,800 px map, so "one full bar is one trip across the store" is
the mental model. Steady-state duty cycle is one third sprinting, and a player who spends
the resource perfectly can sprint for about 28 s of the 69 s match.

These live in `packages/shared` beside the existing movement and loot limits so the client
HUD and the server tick read one source of truth.

### Authority and presentation

- The simulation owns each player's stamina, drains it on the fixed 30 Hz step, and is the
  only writer. A client may render the bar but never reports its own value.
- Stamina travels in the compact snapshot alongside position and `sprinting`, so the HUD,
  remote-player presentation, and the final state all agree.
- The local client predicts drain and refill from its own input for a responsive bar, then
  reconciles to the snapshot by acknowledged input sequence, exactly as position does.
- A client that sets `sprint: true` with an empty bar is moved at walk speed. The request is
  ignored, not treated as an error, since latency makes it a normal race.
- Reconnecting inside the grace window restores the server's stamina value; the bar cannot
  be refilled by dropping the socket.

## Shove

`Ctrl` asks the server to shove whoever is in front of the player. The client may
nominate a target, but it never decides an outcome and never supplies a direction.

- **The server owns facing.** It is the last non-zero movement direction the server
  itself accepted, so there is no direction vector on the wire to spoof. Players
  spawn facing the carts.
- A request carries only an idempotency ID and an optional nominated target.
  Omitting the target asks the server to pick the nearest eligible player it can
  reach inside the cone.
- The server validates, in order: match membership, a duplicate request ID, the
  looting phase and its deadline, the rate limit, the shover's own recovery
  window, the cooldown, then the target's eligibility, range, facing cone, and
  line of access.
- One request affects at most one player.
- A landed shove pushes the target away from the shover — not along the facing —
  so a target caught at the edge of the cone is pushed away rather than sideways.
- Knockback is swept in small steps and stops at the last legal position, so it
  can pin a player against a shelf but never push one through geometry, into a
  cart, or out of the map.
- The target's own movement input is ignored for a short recovery window. Their
  input keeps being acknowledged throughout, so their client's reconciliation
  never stalls.
- A player in recovery cannot shove. That is what resolves a mutual exchange:
  requests are serialized in arrival order, and the first to arrive puts its
  target into recovery before that target's own request is read. Exactly one
  shove lands.
- Stamina is not spent by shoving; the two mechanics stay independently tunable.
- The recovery window freezes movement, not interaction. The 96 px of knockback is
  itself the denial — it carries a target out of the 64 px item reach — so shoving
  someone off a pickup works through displacement rather than an action lockout.

### Balance values

| Value | Initial setting |
| --- | --- |
| Range | 78 px |
| Facing cone | 60° half-angle, a 120° arc |
| Cooldown | 1,500 ms |
| Knockback | 96 px, swept in 4 px steps |
| Recovery window | 400 ms |
| Anti-spam bucket | 3 requests, refilling 1 per second |

Cooldown-paced play never meets the rate limiter: one shove per 1.5 s spends
0.67 tokens per second against a 1-per-second refill.

### Geometry, and one deliberate asymmetry

Shelves block both reach and knockback. Carts block **knockback only** — walking
over a cart footprint stays allowed so depositing never feels fiddly, but the one
movement a player does not control is held to the stricter geometry. A player who
is already standing inside a cart is pushed out of it rather than pinned there.

### Authority and presentation

- Every committed shove is broadcast to the room as one event carrying the
  target's authoritative post-knockback position, so all clients agree on where
  the target ended up. It is the only trigger for shove animation and sound.
- Each acknowledgement restates the cooldown deadline, so the HUD shows the wait
  without inferring it from a rejection reason.
- The swing animation and the cooldown start on the local key press, which is what
  makes a shove read as immediate. Nobody moves until the server says so, and the
  acknowledgement replaces the predicted cooldown with the real one — rolling it
  back to zero when the attempt is refused outright.
- Committed decisions are remembered per player by request ID, so a resent request
  replays its original acknowledgement and broadcasts no second shove.
- A rejected attempt returns a stable typed reason, and the reasons distinguish an
  empty cone, a nominated target out of range, one outside the cone, one behind a
  shelf, a cooldown, a recovery, and a rate limit.

## Loot, inventory, and carts

- Loot is shared: an available item can be successfully claimed by only one player.
- A player may carry zero to four items. A fifth pickup is rejected.
- Pickup requires an available target within interaction range during `LOOTING`.
- Deposit requires a carried item and the player's assigned cart within interaction range during `LOOTING`.
- Deposited items leave the carried inventory and become part of that player's authoritative tally.
- Other players' carts cannot receive a player's deposit.
- Simultaneous conflicts are resolved by server processing order; every client receives the resulting authoritative state.

Exact item values, the spawn table, and scoring presentation are intentionally deferred to their focused build steps.

## Timing and tally

- The looting window is exactly 69,000 ms measured against the server's monotonic match timeline.
- Clients render time remaining from server timestamps and snapshots; a client clock never ends or extends the phase.
- Once the deadline is reached, the server transitions before accepting further gameplay effects.
- TALLY reflects deposited loot only. Carried but undeposited items do not count unless a later product decision explicitly changes this rule.
- Every connected player sees the same final authoritative result.

## Acceptance criteria for the first playable

- One to four authenticated browser sessions can create/join the same private room; a fifth is rejected.
- Only the current host can begin a valid match, under the documented readiness rule.
- All clients observe the same ordered lifecycle: LOBBY, COUNTDOWN, LOOTING, TALLY.
- Players spawn near the map center and move smoothly with WASD; diagonal movement is normalized and collisions prevent crossing shelves/bounds.
- Sprint changes speed only while the server-owned stamina bar permits it.
- Stamina starts full, drains only while sprinting, refills only while not sprinting, and never leaves 0..capacity.
- A player at zero stamina still walks, and cannot sprint again until the re-engage threshold is reached.
- A modified client cannot sprint past an empty bar, report its own stamina, or refill by reconnecting.
- A shared loot item cannot appear in two inventories, including under simultaneous requests.
- No inventory ever exceeds four carried items.
- Players can deposit only their carried loot in their assigned cart.
- Shoves affect only valid in-range targets inside the facing cone, and obey the server cooldown, recovery window, and phase rules.
- A shove never places a player inside a shelf, a cart, or outside the map, from any direction.
- Two players shoving each other at the same moment produce exactly one landed shove, decided by arrival order.
- A modified client cannot supply its own facing, shove further than the configured range, shove faster than the cooldown, or shove while recovering.
- The server ends looting after 69 seconds even if clients pause, lag, alter their clocks, or send late requests.
- Inputs and interactions have no effect after TALLY begins.
- All clients display a tally consistent with authoritative deposited items.
- Refresh/reconnect within the supported grace window does not duplicate a player or reset authoritative match state.
- Malformed, unauthorized, impossible, and excessive network messages are rejected with stable typed errors and do not crash the process.
- Critical pure rules, room lifecycle, authority checks, network validation, and browser flow have automated coverage at their appropriate layers.

## Current room-lifecycle error contract

- A malformed code or command payload returns `INVALID_PAYLOAD`; a well-formed code with no active room returns `ROOM_NOT_FOUND`.
- A fifth distinct user receives `ROOM_FULL`, and a new user joining after start receives `MATCH_ALREADY_STARTED`.
- An unauthenticated socket handshake receives `UNAUTHENTICATED`. A user already belonging to a different room receives `ALREADY_IN_ROOM`.
- Non-host start attempts receive `FORBIDDEN`; a host start before the readiness rule is met receives `PLAYERS_NOT_READY`.
- Lobby-only changes after start receive `INVALID_PHASE` or `MATCH_ALREADY_STARTED` as appropriate.

## Current implementation boundary

The 30 Hz server simulation now owns movement, the sprint stamina resource, bounds, shelf collision, spawn assignment, and the `COUNTDOWN → LOOTING` transition. Clients predict local movement and reconcile by acknowledged input sequence; remote movement is buffered and interpolated from 20 Hz compact snapshots. The same simulation now also owns loot availability, carried inventories, and cart deposits, deciding every pickup and deposit atomically and answering each request with a typed acknowledgement. It additionally owns each player's derived facing, shove decisions, knockback sweeps, and recovery windows. Scoring, the complete timer/tally flow, durable room recovery, Tiled JSON, and Playwright browser coverage remain out of scope for this milestone. MySQL/Drizzle stores accounts and sessions, while rooms and matches remain intentionally process-local.
