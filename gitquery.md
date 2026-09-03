STEP 3
Implement ONLY the authoritative End Day/readiness system for the SURVIVAL phase.

Do not implement feeding UI or resource drain yet.

# Rules

Each SURVIVAL day lasts a maximum of 120 seconds.

A player can manually end their day before the timer expires.

Once they end their day:

* their survival decisions for that day are locked
* they cannot perform additional feeding/item actions later
* their readiness state is authoritative on the server

If the 120-second deadline expires and a player has not ended their day:

* the server automatically ends that player's day

Do not require a client event at timeout.

# Multiplayer readiness

Track end-of-day readiness separately for every player.

When every active household has ended the day, the server should be able to proceed immediately without waiting for the remaining timer.

Do not implement full next-day resolution yet.

Instead, expose a clear server-side condition/state indicating:

`all players ended`

so the next task can hook day resolution onto it.

# Network API

Add the smallest appropriate client intent for manually ending the day.

Clients may request:

`end my day`

They must not submit:

* another player's readiness
* timer values
* day number
* end-of-day results

The server validates the requesting authenticated player and current phase/day.

Make the request idempotent.

Repeated End Day requests should not duplicate broadcasts or corrupt state.

# State exposed to clients

Expose enough authoritative readiness state for later UI to know:

* whether the local player has ended
* which other players have ended
* how many are still active

Do not build the house-icon UI in this task.

# Tests

At minimum verify:

1. player can manually end their day
2. ended state is server-authoritative
3. a player cannot end another player's day
4. repeated requests are harmless/idempotent
5. after ending, the player is locked from future day actions
6. timeout automatically ends players who did not manually end
7. manually-ended players are not double-ended on timeout
8. all-players-ended becomes true as soon as the last active player ends
9. this can occur before 120 seconds
10. readiness resets cleanly for a future day model without implementing day advancement yet

Run standard validation and E2E if green.

Stop after End Day/readiness state.



-----
STEP 4

Implement ONLY end-of-day resource resolution and advancing to the next survival day.

Do not implement feeding item consumption yet.
Do not implement starvation/dehydration death rolls yet.
Do not implement random events.

# When a day resolves

Resolve a survival day when either:

* every active player has ended their day, or
* the 120-second survival deadline expires and the server auto-ends remaining players

The server performs resolution exactly once.

# Per-character resource drain

For every living character:

`nutrition.current -= dailyNutritionCost`

`hydration.current -= dailyHydrationCost`

Clamp each value at a minimum of 0.

Do not allow negative Nutrition/Hydration.

Dead characters should not consume resources unless the existing model strongly requires otherwise. Prefer not to drain dead characters.

# Next day

After resolution completes:

* increment authoritative `dayNumber`
* reset per-player End Day readiness for the new day
* establish a fresh authoritative 120-second deadline
* return players to the active start-of-day survival state

The existing `Day #X` transition component should naturally display the newly incremented day.

The transition remains presentation-only.

# Death-risk preparation

Do NOT kill characters in this task.

However, after Nutrition/Hydration drain, the resulting values must remain authoritative so the next task can evaluate:

* Nutrition + Hydration < 30
* Nutrition + Hydration < 10

Do not add random death rolls yet.

# Tests

Verify:

1. daily Nutrition cost is deducted once
2. daily Hydration cost is deducted once
3. values clamp at zero
4. different characters may have different daily costs
5. dead characters are not drained, if following the preferred behavior
6. resolution cannot run twice for the same day
7. day number increments exactly once
8. readiness resets for the next day
9. a new 120-second deadline is created
10. all-players-ended can trigger resolution before timeout
11. timeout can trigger resolution when players remain active
12. new day preserves household characters/inventory/stat state

Run standard validation and E2E if green.

Stop after resource drain + next-day advancement.

-----

STEP 5

Implement ONLY server-authoritative food/water consumption actions for the survival planning period.

Do not build the final sidebar/modal UI yet.

# Feeding rules

During the active start-of-day period, before a player has ended their day, they may use eligible inventory items on one living character in their own household.

The client submits intent:

* which inventory item instance/type to use
* which owned character to give it to

The server validates everything and applies the effect.

Clients must not submit resulting stat values.

# Initial consumables

Canned Soup:

* restore 50 Nutrition

Bottled Water:

* restore 50 Hydration

MRE:

* restore both Nutrition and Hydration to that character's maximum values

Use the actual existing catalog IDs for these items. Inspect the current loot catalog rather than inventing IDs.

Restoration is capped at the character's personal max.

Examples:

Nutrition 70 / 100 + soup => 100 / 100

Nutrition 20 / 80 + soup => 70 / 80

Hydration 40 / 130 + water => 90 / 130

MRE on Nutrition 30 / 80 and Hydration 50 / 130 =>
Nutrition 80 / 80
Hydration 130 / 130

# Inventory

Consuming an item removes one unit of that item from that player's authoritative survival inventory.

Do not consume an item if validation fails.

NPC recruits are not consumable inventory.

# Restrictions

Reject the action if:

* not in active SURVIVAL planning period
* player has already ended the day
* item is not in that player's inventory
* item is not a supported food/water consumable
* target character is not in that player's household
* target character is dead
* request is malformed

Make requests idempotent using the project's existing request-ID patterns where appropriate.

# Tests

Verify:

1. soup adds 50 Nutrition
2. water adds 50 Hydration
3. MRE fills both to personal max
4. restoration clamps to personal max
5. inventory item is removed on success
6. inventory is unchanged on rejection
7. cannot feed another player's character
8. cannot use another player's inventory
9. cannot feed dead character
10. cannot feed after End Day
11. duplicate committed request does not consume twice
12. different max Nutrition/Hydration values work correctly

Run standard validation and E2E if green.

Stop after backend feeding/consumption behavior.
