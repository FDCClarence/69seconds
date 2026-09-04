Implement ONLY end-of-day resource resolution and advancing to the next survival day.

Do not implement feeding item consumption yet.
Do not implement starvation/dehydration death rolls yet.
Do not implement random events.

When a day resolves

Resolve a survival day when either:

every active player has ended their day, or
the 120-second survival deadline expires and the server auto-ends remaining players

The server performs resolution exactly once.

Per-character resource drain

For every living character:

nutrition.current -= dailyNutritionCost

hydration.current -= dailyHydrationCost

Clamp each value at a minimum of 0.

Do not allow negative Nutrition/Hydration.

Dead characters should not consume resources unless the existing model strongly requires otherwise. Prefer not to drain dead characters.

Next day

After resolution completes:

increment authoritative dayNumber
reset per-player End Day readiness for the new day
establish a fresh authoritative 120-second deadline
return players to the active start-of-day survival state

The existing Day #X transition component should naturally display the newly incremented day.

The transition remains presentation-only.

Death-risk preparation

Do NOT kill characters in this task.

However, after Nutrition/Hydration drain, the resulting values must remain authoritative so the next task can evaluate:

Nutrition + Hydration < 30
Nutrition + Hydration < 10

Do not add random death rolls yet.

Tests

Verify:

daily Nutrition cost is deducted once
daily Hydration cost is deducted once
values clamp at zero
different characters may have different daily costs
dead characters are not drained, if following the preferred behavior
resolution cannot run twice for the same day
day number increments exactly once
readiness resets for the next day
a new 120-second deadline is created
all-players-ended can trigger resolution before timeout
timeout can trigger resolution when players remain active
new day preserves household characters/inventory/stat state

Run standard validation and E2E if green.

Stop after resource drain + next-day advancement.