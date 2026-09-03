# 69 Seconds — Game Specification

## First-playable scope

69 Seconds is a private-room browser game for one to four players. A match covers one grocery-store looting round: players leave a shared central spawn, collect shared items, carry at most four at once, deposit them in their assigned carts, and see a tally after exactly 69 server-timed seconds. Later resource-management phases are not part of this version.

This document defines the implemented first playable. Authentication, the private-room lifecycle, Phaser movement, authoritative movement/loot/sprint/shove rules, the exact server timer, and the final tally are complete. Later resource-management phases remain out of scope.

## Match lifecycle

1. **LOBBY** — Players join a private room, see membership/readiness, and wait for the host. Only the server may accept a start request and transition the room.
2. **COUNTDOWN** — The roster is fixed for the round, gameplay input cannot move or interact, and the server announces an absolute phase end time. The initial target is three seconds.
3. **LOOTING** — The server enables gameplay and sets `phaseEndsAtMs` to the scheduled countdown boundary plus exactly 69,000 ms. Players move, sprint, pick up/deposit loot, and shove subject to server validation.
4. **SURVIVAL** — At the looting deadline, movement, pickups, deposits, and shoves stop, the authoritative deposited items and recruits are frozen into one immutable looting result, and the server opens the survival day with `phaseEndsAtMs` set to that same deadline plus exactly 120,000 ms. The day is played from the frozen looting result; each player will be able to end their day manually, and the server ends it for anyone who has not once the deadline elapses.

Phase transitions are one-way for a match: `LOBBY → COUNTDOWN → LOOTING → SURVIVAL`. The final-result phase that follows survival, and a rematch lifecycle, are out of scope until explicitly specified. `TALLY` remains a valid wire phase because the frozen looting result it describes is still committed and replayed.

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
- `Q`: put the most recently picked-up carryable back on the floor.
- Movement and action input has no gameplay effect outside `LOOTING`, `SURVIVAL` included.
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
- Hands hold four carry slots. An ordinary item costs one slot; a fifth item is rejected.
- Pickup requires an available target within interaction range during `LOOTING`.
- Deposit requires a carried item and the player's assigned cart within interaction range during `LOOTING`.
- Deposited items leave the carried inventory and become part of that player's authoritative tally.
- Other players' carts cannot receive a player's deposit.
- Simultaneous conflicts are resolved by server processing order; every client receives the resulting authoritative state.
- The drop key puts the most recently picked-up carryable back on the floor, at the authoritative position of the player who dropped it. The request carries no coordinate, so a modified client cannot drop anything anywhere but where the server already has it standing.
- An unaddressed interact prefers the player's own cart whenever the nearest carryable does not fit the hands, so full hands standing at their cart always deposit instead of being refused.

Items retain their catalog labels and one of five presentation categories: food, weapons, medicine, entertainment, or misc. Recruited people report a sixth, `people`. The tally counts deposited instances rather than assigning future resource values or building later bunker mechanics.

Each match draws its loot at random. The store publishes 80 candidate spawn locations and the server places `itemsPerMatch` items across a random subset of them, so no two matches share a layout and most locations stay empty. Category floors are guaranteed first — food 25, entertainment 5, misc 5, medicine 3, weapons 3 — and every remaining slot is drawn from the whole catalog by spawn weight. Because 50 items come from a 16-entry catalog, duplicates are normal; each placed item still carries a unique id. Item rarity is a spawn-odds label only: it does not change an item's value or behaviour. Counts, floors, the item list, and the odds all live in `packages/shared/src/loot-table.ts`.

## People (NPCs)

Survivors stand in the aisles and are recruited by carrying them to a cart. They are carryables like loot — same authority, same pickup and deposit rules, same tally — separated only by what a person costs to carry and by how they are drawn.

- A person costs every carry slot, so carrying one requires empty hands. Attempting it with anything held is rejected as `NEEDS_EMPTY_HANDS`, which is a distinct reason from `HANDS_FULL` because the fix is different: drop or bank what you hold.
- While someone is being carried, every other pickup is rejected as `HANDS_FULL`.
- A person is claimed by exactly one player, like any shared item; a second claimant receives `ITEM_UNAVAILABLE`.
- The drop key puts a carried person down and frees all four slots at once, which is the only way to abandon a recruit before reaching a cart.
- Depositing a carried person in the player's assigned cart recruits them. They appear in that player's tally by name, in the `people` category, counting as one entry rather than as the four slots they occupied.
- A player who leaves mid-match releases a carried person the same way they release loot: back to the floor, available again.
- People do not move, are not solid, and are unaffected by shoves. Being shoved never makes a player drop what they carry.

A match places every distinct person that fits under the roster cap — `maxPerMatch` in `packages/shared/src/npc-table.ts`, currently 10 against an eight-person roster, so all eight appear. Nobody is ever placed twice. People are drawn onto the candidate spawn locations the loot draw left unused, so a person and an item never share a spot. The draw fails loudly rather than duplicating anyone or overflowing the free locations.

Each person's art is a large hand-authored canvas with the figure inside a wide transparent margin, so the catalog carries the file's pixel size and the figure's bounding box. Both the on-map sprite and the HUD portrait are framed from that one rect, which is what keeps every person at a consistent on-screen size. Replacing a file with a different export size fails `apps/web/src/game/npc-art.test.ts` rather than silently mis-framing them.

## Survival households and character stats

At the buzzer the server derives one household per player from the frozen looting result. A household holds that player's main character, only the people that player personally recruited, and only that player's deposited items. Households are never merged, and the eventual objective is to be the last household with a living character — elimination and win conditions are not implemented yet.

- A main character and a recruited NPC are the **same** representation. There is no separate player-stat system.
- Every character carries six stats — Health, Survival, Morale, Strength, Nutrition, Hydration — each as a **current/max pair**. All six point the same way: higher is better, lower is worse, 0 is the worst possible value.
- `max` is per character and per stat. 100 is the default scale, never a global assumption.
- Each character also carries a Daily Nutrition Cost and a Daily Hydration Cost. These are plain amounts, not pairs.
- `isAlive` is explicit and starts true for everybody. Death is never inferred from Health, because the coming rules kill on combined Nutrition and Hydration rather than on damage.
- A recruited person becomes exactly one household member, regardless of the four carry slots they occupied during looting. Ordinary loot stays deposited inventory: an item never becomes a character.

Starting values live only in `packages/shared/src/survival-table.ts`: Health 100/100, Survival 50/100, Morale 100/100, Strength 50/100, Nutrition 100/100, Hydration 100/100, and 20 for each daily cost. They are placeholders for a first playable day, not final balance. Per-person overrides go in `NPC_SURVIVAL_OVERRIDES` in the same file, keyed by NPC catalog id; any starting value, any max, or either daily cost can be overridden from that table alone, without touching the initialization engine. The table is empty today, so every person on the roster runs on the defaults.

Survival state is server-authoritative and read-only to clients. It is broadcast once as `survival:state` after the looting result and replayed verbatim to a reconnecting member. No client event carries stats, maxes, daily costs, or alive state, so none of it can be submitted.

End Day readiness is separate mutable server state. Each player may send only an empty `survival:end-day` intent; the authenticated socket determines the household, and the current server phase, day, and deadline determine whether it is valid. Ending locks that household's remaining decisions for the day. Requests are idempotent, unfinished households are automatically ended by the server at 120 seconds, and the broadcast `survival:readiness` state reports every player's completion, the number still active, and whether all players have ended. Reaching that all-ended condition does not resolve or advance the day yet.

### Day numbering and the day transition

The grocery run happens **before Day 1**, so the day the buzzer opens is Day 1. `dayNumber` is carried on the survival state, the server owns it, and it starts at `SURVIVAL.firstDayNumber`. Clients render the number they are given and never derive, increment, or report one — no client event carries a day. Advancing to Day 2 is not implemented; the number is a server field and an initializer parameter so the coming end-of-day flow can open the next day through the same call.

On genuinely entering a new day, a client fades to black, shows `Day #X` from the authoritative number, holds for about two seconds in total, then fades away to reveal the survival screen. The overlay is presentational: the server's 120-second day is already running behind it, the transition neither pauses nor extends the deadline, and nothing is sent to the server when the animation finishes. A remount or reconnect during the same day finishes only the time left rather than replaying the fade, remembered in a client-only session note that is never authoritative. Reduced-motion players see the overlay and its text without the fade.

Not implemented yet, and deliberately out of scope for the current model: feeding, item consumption, end-of-day resource drain (Nutrition and Hydration falling by their daily costs), the death rolls that follow (combined Nutrition + Hydration below 30 gives a 50% death chance the next day; below 10 is certain death), advancing past Day 1, and events.

## Timing and tally

- The looting window is exactly 69,000 ms measured against the server's monotonic match timeline.
- Clients render time remaining from server timestamps and snapshots; a client clock never ends or extends the phase.
- Once the deadline is reached, the server transitions before accepting further gameplay effects.
- The looting result reflects deposited loot only. Carried but undeposited items do not count unless a later product decision explicitly changes this rule.
- The first tick at or beyond the deadline freezes one immutable match result from the cart authority. It contains per-player item lists, per-player category totals, match category totals, and stable server timestamps.
- The server broadcasts that result once as `match:tally`; a rostered player reconnecting during the 15-second grace window receives the same committed result verbatim, in `SURVIVAL` as well as after it.
- A player disconnected at the buzzer remains represented in the result. Later roster removal or host migration cannot rewrite it.
- Every connected player sees the same authoritative looting result. Rematch/restart controls do not exist.

## Acceptance criteria for the first playable

- One to four authenticated browser sessions can create/join the same private room; a fifth is rejected.
- Only the current host can begin a valid match, under the documented readiness rule.
- All clients observe the same ordered lifecycle: LOBBY, COUNTDOWN, LOOTING, SURVIVAL.
- Players spawn near the map center and move smoothly with WASD; diagonal movement is normalized and collisions prevent crossing shelves/bounds.
- Sprint changes speed only while the server-owned stamina bar permits it.
- Stamina starts full, drains only while sprinting, refills only while not sprinting, and never leaves 0..capacity.
- A player at zero stamina still walks, and cannot sprint again until the re-engage threshold is reached.
- A modified client cannot sprint past an empty bar, report its own stamina, or refill by reconnecting.
- A shared loot item cannot appear in two inventories, including under simultaneous requests.
- No inventory ever exceeds four carry slots, and a carried person occupies all four.
- A person can only be picked up with empty hands, and only ever by one player.
- A dropped carryable reappears where the server had the dropping player, never where a client claims.
- Players can deposit only their carried loot in their assigned cart.
- Shoves affect only valid in-range targets inside the facing cone, and obey the server cooldown, recovery window, and phase rules.
- A shove never places a player inside a shelf, a cart, or outside the map, from any direction.
- Two players shoving each other at the same moment produce exactly one landed shove, decided by arrival order.
- A modified client cannot supply its own facing, shove further than the configured range, shove faster than the cooldown, or shove while recovering.
- The server ends looting after 69 seconds even if clients pause, lag, alter their clocks, or send late requests.
- Inputs and interactions have no effect after the looting deadline, `SURVIVAL` included.
- The survival day begins on every client at the authoritative looting deadline, with the server-owned 120-second deadline, and no client may end or extend it.
- The first survival day is Day 1 for every client, taken from the server's survival state, and the `Day #X` transition that announces it changes no deadline.
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

The 30 Hz server simulation owns movement, stamina, collision, spawn assignment, the complete phase graph, loot/cart state, shove effects, the immutable looting result, and the survival day's deadline. Clients predict local movement and presentation only, reconcile from validated server messages, destroy Phaser when the looting phase ends, and render server-committed state in React. Durable match history, future scoring/resource conversion, and Tiled JSON remain out of scope. MySQL/Drizzle stores accounts and sessions, while rooms and completed match results remain intentionally process-local. Playwright covers the four-context vertical-slice journey and minimum-width critical layouts.
