# 69 Seconds — Game Specification

## First-playable scope

69 Seconds is a private-room browser game for one to four players. A match covers one grocery-store looting round: players leave a shared central spawn, collect shared items, carry at most four at once, deposit them in their assigned carts, and see a tally after exactly 69 server-timed seconds. Later resource-management phases are not part of this version.

This document defines the intended first playable. Authentication and the private-room lobby lifecycle are implemented; Phaser gameplay and authoritative match simulation remain later milestones.

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
- `Shift`: sprint while held, subject to server-owned constraints added in the gameplay networking step.
- `Space`: context interaction, including pickup or deposit where valid.
- `Ctrl`: request a shove against a valid nearby player.
- Movement and action input has no gameplay effect outside `LOOTING`.
- The server validates speed, collision, timing, proximity, target availability, inventory capacity, cart ownership, and shove constraints. Clients may predict presentation but cannot decide outcomes.

Initial tunable values live in `packages/shared`: walk speed 150 px/s and sprint speed 235 px/s. They are placeholders until movement tuning.

## Loot, inventory, and carts

- Loot is shared: an available item can be successfully claimed by only one player.
- A player may carry zero to four items. A fifth pickup is rejected.
- Pickup requires an available target within interaction range during `LOOTING`.
- Deposit requires a carried item and the player's assigned cart within interaction range during `LOOTING`.
- Deposited items leave the carried inventory and become part of that player's authoritative tally.
- Other players' carts cannot receive a player's deposit.
- Simultaneous conflicts are resolved by server processing order; every client receives the resulting authoritative state.

Exact item values, spawn table, interaction radius, sprint resource constraints, shove impulse/cooldown, and scoring presentation are intentionally deferred to their focused build steps.

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
- Sprint changes speed only while permitted by the server.
- A shared loot item cannot appear in two inventories, including under simultaneous requests.
- No inventory ever exceeds four carried items.
- Players can deposit only their carried loot in their assigned cart.
- Shoves affect only valid in-range targets and obey server cooldown/phase rules.
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

## Explicitly out of scope after the room milestone

Phaser scenes, map/assets, simulation ticks, loot resolution, scoring, and durable room recovery are not implemented yet. MySQL/Drizzle stores accounts and sessions, but rooms remain intentionally in one process and are lost on server restart. Tiled JSON, Phaser 4, and Playwright remain architectural targets for later steps.
