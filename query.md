We are beginning the post-looting survival phase.

For this task, implement ONLY the survival phase scaffold and its authoritative 120-second timer.

Do not build the survival UI yet beyond whatever minimal rendering is necessary to prove the phase transition works.

Before changing code, read:

* `docs/HANDOVER.md`
* `docs/GAME_SPEC.md`
* `docs/ARCHITECTURE.md`
* `packages/shared/src/schemas.ts`
* `packages/shared/src/constants.ts`
* `apps/server/src/game/simulation.ts`
* `apps/web/src/App.tsx`
* `apps/web/src/room-client.ts`

Also inspect how the existing LOOTING timer ends and how the current TALLY phase is entered.

## Existing flow

The project currently uses:

`LOBBY → COUNTDOWN → LOOTING → TALLY`

We are changing the overall match flow so that looting is no longer the final gameplay phase.

Introduce a new server-authoritative phase:

`SURVIVAL`

The flow should become:

`LOBBY → COUNTDOWN → LOOTING → SURVIVAL`

Do not design the eventual final-result phase in this task.

Do not remove tally-related code recklessly. Preserve any authoritative looting result data that will be needed by the survival phase.

## Survival timer

The SURVIVAL phase lasts a maximum of:

`120 seconds`

Add this duration to shared constants rather than hardcoding it independently in the client and server.

The server must own the survival deadline.

When SURVIVAL begins:

* establish a server-authoritative deadline 120 seconds in the future
* expose enough phase/deadline state to the client for a countdown display later
* do not trust a client-provided timer
* do not let a browser decide when the survival day has expired

Follow the same authority principles already used for the looting deadline where practical.

## End-of-day concept

The survival phase will eventually allow each player to press an `End the day` button.

Important future rule:

If a player has NOT ended their day manually when the 120-second timer expires, the server must automatically treat that player as having ended their day.

Do NOT implement the button, readiness UI, or full end-of-day flow yet.

For this task, only structure the survival phase/timer so that this rule can be implemented cleanly in the next task.

Avoid adding speculative gameplay systems.

## Transition from looting

When the looting deadline completes, transition into SURVIVAL instead of immediately treating the match as complete.

Preserve the authoritative results of looting.

The survival phase will later need:

* each player's deposited items
* recruited NPCs
* player identities
* match membership

Do not create a duplicate client-owned inventory or NPC list.

Use or evolve the existing frozen tally/result data if appropriate.

## Client behavior

The client only needs enough support to:

* recognize the `SURVIVAL` phase
* stop showing the looting scene when SURVIVAL starts
* render a very simple placeholder such as `Survival phase` so the transition can be verified

Do not build the final survival screen in this task.

Do not add inventory UI.
Do not add NPC composition.
Do not add the topbar.
Do not add house readiness indicators.
Do not add the End the Day button yet.

## Tests

Add/update tests proving:

1. LOOTING transitions into SURVIVAL.
2. SURVIVAL receives a 120-second authoritative deadline.
3. the client recognizes SURVIVAL as a valid phase.
4. the looting result/tally data needed for the next phase is not lost.
5. SURVIVAL does not accidentally advance immediately.
6. existing server-authoritative deadline behavior remains intact.

If the stale `loot-art.test.ts` issue from `docs/HANDOVER.md` is still present, apply the verified fix from the handover first so the repository can validate cleanly.

After implementation run:

`npm run lint`
`npm run typecheck`
`npm test`
`npm run build`

If those pass, run:

`npm run e2e`

Report:

* files changed
* how SURVIVAL was represented in shared types/schemas
* where the 120-second duration lives
* how the server establishes the survival deadline
* how looting result data is preserved into survival
* tests added or changed
* all validation command results

Stop after completing this phase/timer scaffold.
Do not implement survival UI or gameplay yet.
