# 69 Seconds — Codex Build Prompt Guide

This file is a sequence of prompts for building the first playable version of **69 Seconds** in separate Codex chats.

Use one prompt per chat and run them in order. Let each chat finish its implementation and verification before starting the next one.

## Model guide

- **Sol**: use for architecture, authentication, multiplayer networking, server authority, debugging, security, and integration reviews.
- **Terra**: use for bounded implementation work such as React screens, Phaser scenes, map construction, animation, UI polish, and visual feedback.

The recommended model is listed above every prompt. Do not switch to a weaker model just because a prompt looks long; networking mistakes tend to appear much later.

## Product brief shared by every prompt

The game is a browser-based multiplayer game with these initial requirements:

- Working title: **69 Seconds**.
- One to four players per private room.
- Players register or log in, then create a room or join one with a code.
- A match begins when the host starts it.
- Players spawn near the center of a top-down grocery store.
- Movement is continuous and pixel-based, never tile-by-tile.
- Controls:
  - WASD: move.
  - Shift: sprint.
  - Space: interact or pick up/drop off.
  - Ctrl: shove another player.
- Each player can carry at most four items.
- Four assigned shopping carts sit near the bottom of the map.
- Players collect shared grocery-store loot and deposit it in their assigned carts.
- The looting phase lasts exactly 69 seconds according to the server.
- When time expires, movement and interactions stop and every player sees their loot tally.
- Later resource-management phases are out of scope for this playbook.

## Target architecture

Unless a later implementation uncovers a concrete reason to change it, use:

- npm workspaces in a TypeScript monorepo.
- `apps/web`: React, Vite, TypeScript, Phaser 4.
- `apps/server`: Node.js, TypeScript, Express, Socket.IO.
- `packages/shared`: shared schemas, event contracts, game constants, and pure game rules.
- PostgreSQL and Drizzle ORM for accounts and durable data.
- HTTP-only secure session cookies for authentication.
- Tiled JSON for the grocery-store map when a real map is introduced.
- Vitest for unit/integration tests and Playwright for critical browser flows.

Socket.IO is intentionally selected here because the later game phases already plan to use it. The server must remain authoritative over the timer, loot availability, inventories, cart deposits, sprint constraints, shoves, and match results.

## Deployment target: Cloudflare + Railway

The production target for this project is:

- Cloudflare manages the public domain and DNS.
- Railway deploys the Git repository as one public Node web service.
- The Railway Node service serves the production React/Vite build, the HTTP API, and Socket.IO from the same public origin.
- Railway PostgreSQL stores users, sessions, and durable match summaries.
- The application reads Railway's private `DATABASE_URL`; the database must not be exposed publicly for normal application traffic.

Prefer a single public hostname such as `play.example.com`. In production, the browser should use same-origin relative HTTP URLs and a same-origin Socket.IO connection instead of hard-coded Railway URLs. This keeps HTTP-only session cookies usable for both API requests and the WebSocket handshake and avoids unnecessary CORS complexity.

The server must listen on Railway's injected `PORT` and bind to `0.0.0.0`. Keep one Railway application replica while active match state is in memory. Horizontal scaling requires shared room/state infrastructure and a compatible Socket.IO adapter; adding replicas before that work would split players across isolated processes.

Cloudflare and Railway both support WebSockets, but deployment is not automatic merely because the code uses Socket.IO. Step 13 explicitly configures and tests domain records, TLS/WSS, proxy behavior, cookies, environment variables, database migrations, health checks, reconnect behavior, and the production build/start commands.

## Rules for every Codex chat

Add this paragraph to a prompt if you need to remind a chat how to work:

> Work directly in the current repository. First read `CODEX_BUILD_PROMPTS.md`, `docs/GAME_SPEC.md`, `docs/ARCHITECTURE.md`, and `docs/BUILD_STATUS.md` when they exist. Inspect the current code and git status before editing. Preserve valid existing work and do not rewrite completed systems merely to match personal preferences. Implement the requested step completely, run relevant tests and builds, fix failures caused by your work, and update `docs/BUILD_STATUS.md` with what changed, verification performed, known limitations, and the exact recommended next step. Do not commit, deploy, or add unrelated features.

---

## Step 1 — Architecture, specifications, and repository scaffold

**Use: Sol**

Why: This establishes boundaries that every later chat will rely on.

### Prompt

```text
Build the architectural foundation for the first playable version of 69 Seconds.

Read CODEX_BUILD_PROMPTS.md and use its product brief and target architecture as the source of truth. This is a fresh repository, so create an npm-workspaces TypeScript monorepo with:

- apps/web: React + Vite + TypeScript.
- apps/server: Node + Express + Socket.IO + TypeScript.
- packages/shared: framework-independent shared types, schemas, constants, and pure game rules.
- Root scripts for dev, build, typecheck, lint, and test.

Create:

- docs/GAME_SPEC.md containing explicit gameplay rules and acceptance criteria.
- docs/ARCHITECTURE.md describing package boundaries, HTTP/auth flow, Socket.IO flow, server authority, state ownership, and the transition between React and Phaser.
- docs/BUILD_STATUS.md as the cross-chat implementation handoff.
- .env.example files with documented non-secret values.
- A root README with setup and development commands.

Define shared event contracts and state shapes, but do not implement the complete game yet. Include at minimum the phases LOBBY, COUNTDOWN, LOOTING, and TALLY; room/player public state; client input messages; interaction requests; shove requests; snapshots; and typed server errors.

Use runtime validation at network boundaries. Keep domain logic independent from React, Phaser, Express, and Socket.IO. Establish tests that prove the workspaces build and shared contracts can be consumed by both applications.

Do not add authentication, database tables, the finished room system, or full gameplay in this step. Finish by running install/build/typecheck/tests and recording results in docs/BUILD_STATUS.md.
```

### Completion gate

- Both apps start locally.
- Shared package imports work from client and server.
- Root build, typecheck, and tests pass.
- Architecture and status documents exist.

---

## Step 2 — Authentication backend and session foundation

**Use: Sol**

Why: Password storage, cookies, validation, and authorization deserve a security-focused implementation.

### Prompt

```text
Implement production-shaped authentication for the 69 Seconds monorepo.

Read the project documents and current implementation first. Add PostgreSQL and Drizzle ORM to the server, with migrations for users and sessions. Implement register, login, logout, and current-user endpoints. Use secure password hashing and opaque server-side sessions delivered through HTTP-only cookies. Configure SameSite, Secure, expiry, CORS, proxy handling, and development behavior deliberately rather than relying on insecure defaults.

Requirements:

- Normalize and uniquely constrain email addresses.
- Validate all request bodies and return stable typed error codes.
- Never return password hashes or session secrets.
- Rotate or replace sessions on login.
- Rate-limit register and login endpoints.
- Protect authenticated endpoints with reusable middleware.
- Document the local database setup and migration commands.
- Add tests for successful registration/login/logout, duplicate users, invalid credentials, session expiry/revocation, and protected routes.

Do not build the polished React pages yet and do not implement OAuth, email verification, password reset, or social login. Run migrations against a safe local/test database where available, run all relevant checks, and update docs/BUILD_STATUS.md.
```

### Completion gate

- Auth endpoints work and are tested.
- Cookies contain no readable user credentials or bearer tokens.
- Migrations are reproducible from an empty database.

---

## Step 3 — Login, registration, and authenticated landing screens

**Use: Terra**

Why: This is a bounded React and presentation task using the auth contract already established.

### Prompt

```text
Build the React authentication experience and authenticated landing page for 69 Seconds.

Read the project documents, inspect the existing auth API, and use it without changing the server contract unless a verified bug requires a small compatible correction.

Create:

- A distinctive game landing page with clear Login and Register paths.
- Accessible login and registration forms with inline validation.
- Loading, disabled, success, and server-error states.
- Session restoration on refresh through the current-user endpoint.
- Authenticated routing that leads to a home screen containing Create Room and Join Room actions.
- Logout behavior.

Keep the visual identity original and avoid copying the layout, typography, artwork, or branding of 60 Seconds!. Use maintainable CSS and responsive behavior. Keyboard navigation, labels, focus states, and readable contrast are required.

Do not implement room networking yet. Add component and critical flow tests, run the web build/typecheck/tests, and update docs/BUILD_STATUS.md.
```

### Completion gate

- A user can register, refresh, remain signed in, log out, and log back in.
- Unauthenticated users cannot access the authenticated home screen.
- Forms work with keyboard-only navigation.

---

## Step 4 — Create/join room and lobby lifecycle

**Use: Sol**

Why: Room identity, reconnection, host migration, and authorization are multiplayer foundations.

### Prompt

```text
Implement the private room and lobby lifecycle for 69 Seconds using the existing Socket.IO server and React client.

Requirements:

- Authenticated users can create a room and receive a short, readable, collision-resistant room code.
- Authenticated users can join by code.
- Rooms allow one to four distinct users.
- The lobby shows connected players, host status, ready status, and connection/reconnection state.
- Players can toggle ready.
- Only the host can start, and starting requires an explicit documented readiness rule.
- Reject invalid, full, already-started, and unauthorized joins with typed errors.
- Handle refresh and brief disconnect/reconnect without creating duplicate players.
- Define and test what happens when the host leaves; implement deterministic host migration or room closure according to the documented choice.
- Clean up abandoned in-memory rooms safely.

The server owns room membership and lobby state. The client must not be able to claim host status or another user identity. Keep active match state in memory for this MVP; do not add Redis yet.

Build the corresponding React Create Room, Join Room, and Lobby views. Do not begin Phaser gameplay. Add server integration tests for the one-to-four-player lifecycle and update all documentation and docs/BUILD_STATUS.md.
```

### Completion gate

- Four browser sessions can join one code and see consistent lobby state.
- A fifth player is rejected.
- Refresh/reconnection does not duplicate a player.
- Only the current host can start.

---

## Step 5 — Local Phaser movement prototype

**Use: Terra**

Why: This is focused game-feel work and should be tuned locally before networking complicates it.

### Prompt

```text
Create the local Phaser 4 gameplay prototype for the 69 Seconds grocery-store phase.

Mount Phaser inside the existing React match route and cleanly destroy it when leaving the route. Create a temporary grocery-store test scene using simple original placeholder art and geometry.

Implement:

- Smooth continuous pixel-based WASD movement, never grid stepping.
- Normalized diagonal movement so diagonal speed is not faster.
- Shift sprint with configurable walk/sprint speeds.
- Four-direction or eight-direction animation state handling, using placeholders if no sprites exist.
- Arcade Physics collision against store boundaries and shelf obstacles.
- A camera that follows smoothly without exposing outside the map.
- Space interaction input and Ctrl shove input hooks, but only as local debug indicators for now.
- A React HUD layered over the canvas showing controls and four empty carry slots.
- Focus handling so browser scrolling and accidental stuck keys do not occur when the canvas owns input.

Keep all movement constants in packages/shared when they are game rules. Separate Phaser scenes, entities, input, and React bridge code cleanly. Do not add multiplayer synchronization, actual pickups, or finished visual assets yet.

Add tests for pure movement calculations and lifecycle cleanup. Run the web application and verify smooth movement, diagonal normalization, collision, resizing, and route teardown. Update docs/BUILD_STATUS.md with the tuning values used.
```

### Completion gate

- Movement is fluid at the rendering frame rate.
- No tile-by-tile movement exists.
- Diagonal speed equals horizontal/vertical speed.
- Leaving and re-entering the route does not create duplicate Phaser instances or input handlers.

---

## Step 6 — Grocery-store map, loot, inventory, and carts locally

**Use: Terra**

Why: This expands the local gameplay loop before server synchronization is added.

### Prompt

```text
Build the complete local-only looting loop in the Phaser scene.

Introduce a Tiled JSON grocery-store map, or a clearly documented generated placeholder map if Tiled assets are not yet available. The store must have navigable aisles, shelf collisions, a central spawn area, and four assigned carts along the bottom. Keep visual layers and collision/object layers separate.

Implement locally:

- Data-driven loot definitions and map spawn points.
- Visible interaction prompts when close enough to an item or assigned cart.
- Space picks up the best valid nearby item.
- A hard four-item carry limit.
- Space at the assigned cart deposits carried items into that cart.
- Clear feedback for success, full hands, invalid cart, and no nearby target.
- Items disappear from the world when collected.
- React HUD carry slots update through a narrow typed Phaser/React bridge.
- A local debug reset for rapid testing.

Use original placeholders and make item/catalog logic data-driven. Do not trust this local implementation as multiplayer authority; structure commands so the next steps can replace local decisions with server acknowledgements. Do not add the timer or multiplayer yet.

Test pure inventory/deposit rules, verify every map route remains traversable, run all relevant checks, and update docs/BUILD_STATUS.md.
```

### Completion gate

- A player can collect no more than four items.
- Depositing works only at the assigned cart.
- Map collision and interaction zones feel consistent.
- Inventory rules are pure and reusable by the server.

---

## Step 7 — Authoritative multiplayer movement and synchronization

**Use: Sol**

Why: Prediction, reconciliation, interpolation, and cheating boundaries are the most technically sensitive part of the first phase.

### Prompt

```text
Convert the Phaser movement prototype into authoritative one-to-four-player multiplayer gameplay.

Read the architecture and existing Socket.IO contracts first. Preserve the smooth local feel while making the server authoritative.

Implement:

- A fixed-rate server simulation with documented tick and snapshot rates.
- Clients send sequenced input state, not trusted final positions.
- Server validation of movement speed, sprint state, map boundaries, and collision constraints.
- Immediate local client prediction.
- Server reconciliation of the local player using acknowledged input sequence numbers.
- Buffered interpolation for remote players.
- Spawn assignment that prevents players overlapping at match start.
- Join/start synchronization from the lobby into a COUNTDOWN scene/state.
- Brief reconnection support with a safe input reset.
- Metrics or debug overlays for ping, reconciliation corrections, and snapshot rate in development only.

Use a shared or server-readable collision representation; do not let Phaser client collision be the only authority. Do not stream at render-frame frequency. Avoid sending the entire room state when a compact snapshot or event is sufficient.

Add deterministic tests for movement validation, input sequencing, excessive-speed rejection, collision, disconnects, and four simulated clients. Manually test under artificial latency and packet jitter if the repository tooling permits it. Document the networking model and update docs/BUILD_STATUS.md.
```

### Completion gate

- Local movement remains responsive under ordinary latency.
- Remote players move smoothly rather than teleporting between snapshots.
- A modified client cannot exceed allowed speed by reporting a position.
- Four clients remain synchronized through movement and reconnection.

---

## Step 8 — Authoritative loot collection and cart deposits

**Use: Sol**

Why: Contested pickups and inventories require atomic server decisions.

### Prompt

```text
Make loot, carried inventory, and cart deposits authoritative and synchronized for multiplayer.

The server must generate or load the match loot set, assign stable item IDs, own availability, and decide every pickup/deposit request. Clients may request an interaction but may not declare that it succeeded.

Requirements:

- Validate phase, player status, position, interaction radius, line-of-access where appropriate, item availability, carry capacity, and assigned cart.
- Resolve simultaneous pickup attempts atomically so exactly one player wins.
- Send explicit success/rejection acknowledgements with typed reasons.
- Remove collected items consistently for all clients.
- Synchronize private carried inventory only to its owner unless the design documents intentionally expose it.
- Synchronize deposited cart contents as required for the HUD and final tally.
- Make repeat/duplicate requests idempotent.
- Restore correct state after brief reconnection.
- Prevent interaction spam with reasonable server-side limits without making normal play feel laggy.

Adapt the Phaser client to play feedback only after confirmed or safely predicted results, with rollback if prediction is used. Add concurrency and malicious-client tests, run four-client manual verification, update architecture/event documentation, and update docs/BUILD_STATUS.md.
```

### Completion gate

- Two players racing for one item cannot duplicate it.
- Carry capacity and cart ownership cannot be bypassed by a modified client.
- Reconnection restores the correct world and inventory.

---

## Step 9 — Sprint resource and shove mechanic

**Use: Sol**

Why: Player-versus-player actions need fair server validation and latency-tolerant feedback.

### Prompt

```text
Finish sprinting and implement the multiplayer shove mechanic for 69 Seconds.

First make an explicit, documented design choice for sprint: either unlimited sprint with a speed tradeoff elsewhere, or a short stamina resource with server-owned drain/recovery. Prefer the simplest option that creates meaningful decisions and is easy to communicate.

Implement authoritative shove behavior:

- Ctrl requests a shove in the player's facing direction.
- Server validates phase, cooldown, distance, facing cone, target eligibility, and line of access.
- One request can affect at most one intended target unless the game spec deliberately states otherwise.
- Apply bounded knockback and a short recovery window without pushing targets through shelves, carts, or map boundaries.
- Broadcast the result for animation, sound, and HUD feedback.
- Clearly communicate cooldown and failed attempts.
- Handle simultaneous mutual shoves deterministically.
- Rate-limit malformed or spammed requests.

Keep all balance values in shared configuration. Add server tests for distance/facing/cooldown, obstacle handling, mutual shoves, and malicious spam. Test with latency and four clients, then update docs/GAME_SPEC.md and docs/BUILD_STATUS.md.
```

### Completion gate

- Shoves look immediate but resolve consistently for every player.
- Players cannot shove through shelves, from excessive distance, or faster than the cooldown.
- Knockback cannot place a player in invalid map geometry.

---

## Step 10 — Server timer, end of looting, and tally

**Use: Sol**

Why: The phase transition must be atomic and identical for every client.

### Prompt

```text
Implement the complete match phase flow through the end-of-looting tally.

Required flow:

LOBBY -> COUNTDOWN -> LOOTING -> TALLY

Requirements:

- The server owns phase timestamps and the exact 69-second looting deadline.
- Clients display time derived from synchronized server timestamps and never determine when the match ends.
- At the deadline, the server atomically stops movement, pickups, deposits, sprinting, and shoves.
- Requests arriving at or after the deadline are rejected consistently.
- Final deposited loot is frozen into an immutable match result.
- All clients leave/destroy the Phaser scene cleanly and render a React tally screen.
- The tally shows each player's collected items and useful category totals.
- Handle disconnected players and reconnection during TALLY deliberately.
- Host controls cannot restart or mutate the completed result accidentally.
- Provide a safe return-to-home or return-to-lobby action.

Persist the minimal completed match summary if the architecture calls for it, but do not build future bunker/resource-management phases. Add boundary tests around the deadline, delayed packets, phase transitions, duplicate end events, and reconnection. Run end-to-end tests and update docs/BUILD_STATUS.md.
```

### Completion gate

- All clients transition to TALLY from the same server result.
- Late inputs cannot change loot totals.
- The Phaser instance and keyboard listeners are cleaned up.

---

## Step 11 — Game feel, UI polish, audio hooks, and accessibility

**Use: Terra**

Why: The core rules are complete; this step focuses on clarity and feel without changing authority.

### Prompt

```text
Polish the completed 69 Seconds vertical slice without changing its established multiplayer rules or network authority.

Improve:

- Original visual hierarchy across login, home, lobby, countdown, gameplay HUD, and tally.
- Character movement animation transitions and directional readability.
- Pickup, deposit, full-inventory, sprint, shove, countdown, and time-expiry feedback.
- Camera easing and restrained screen shake where appropriate.
- Layering and depth sorting so characters pass convincingly in front of and behind store fixtures.
- Audio integration points with separate music/SFX volume controls and mute; use licensed/original placeholders only.
- Rebindable keyboard controls, or at minimum a centralized binding layer prepared for rebinding.
- Clear focus behavior so Space and Ctrl do not trigger browser/UI actions during gameplay.
- Responsive scaling for common desktop and laptop sizes.
- Reduced-motion support and color-independent status indicators.
- Loading and connection-loss overlays.

Do not hide networking errors behind animation and do not move authoritative decisions to the client. Avoid large new dependencies unless they materially improve the result. Run accessibility checks, tests, typecheck, and production build. Update docs/BUILD_STATUS.md with remaining asset placeholders.
```

### Completion gate

- Every action has clear visual feedback.
- HUD remains readable without obstructing the store.
- Losing focus or reconnecting does not leave movement keys stuck.

---

## Step 12 — Final integration, security, performance, and release-readiness audit

**Use: Sol**

Why: This is a cross-system adversarial review, not a cosmetic pass.

### Prompt

```text
Perform a final release-readiness audit of the 69 Seconds vertical slice and fix verified issues within the current scope.

Audit the entire repository for:

- Authentication/session vulnerabilities and authorization gaps.
- Socket event validation, spoofed identity, replay, spam, and oversized payloads.
- Server authority over movement, timer, loot, carts, sprint, shoves, and tally.
- Race conditions around pickups, disconnects, and the 69-second deadline.
- Memory leaks from abandoned rooms, timers, Socket.IO listeners, React effects, and Phaser teardown.
- Network bandwidth, tick/snapshot rates, interpolation behavior, and unnecessary state broadcasts.
- Four-player behavior under latency, jitter, and brief disconnection.
- Build reproducibility, environment documentation, migrations, logging, and graceful server shutdown.
- Accessibility regressions and critical responsive layouts.
- Missing unit, integration, or Playwright coverage for core journeys.

Fix issues supported by evidence. Do not perform a speculative rewrite and do not add future game phases. Run the complete test, typecheck, lint, build, and end-to-end suite. Produce docs/RELEASE_CHECKLIST.md containing local setup, required environment variables, database migration steps, manual four-player test procedure, known limitations, and deployment considerations.

Update docs/BUILD_STATUS.md with a concise final state and explicitly distinguish passing automated checks from items that still require human multiplayer playtesting.
```

### Completion gate

- Full automated suite passes.
- Four-player manual test procedure is documented.
- Known limitations are explicit rather than silently deferred.
- No client can decide competitive outcomes by itself.

---

## Step 13 — Deploy and verify Cloudflare + Railway production

**Use: Sol**

Why: Production cookies, TLS, WebSockets, database migrations, and proxy behavior cross every application boundary.

### Prompt

```text
Prepare and deploy the completed 69 Seconds vertical slice to its documented Cloudflare + Railway production target.

Read all project documentation and inspect the current repository before changing anything. Use the simplest same-origin topology:

- Cloudflare manages DNS for the public hostname.
- One Railway Node service serves apps/web's production assets, the HTTP API, and Socket.IO.
- One private Railway PostgreSQL service supplies DATABASE_URL.

Repository requirements:

- The root production build compiles shared code, server code, and the Vite client.
- The production Node server serves the built frontend and an SPA fallback without intercepting API, Socket.IO, asset, or health routes.
- The server binds to 0.0.0.0 and Railway's injected PORT.
- Browser API and Socket.IO connections use the current origin in production; no localhost or temporary railway.app URL is baked into the client bundle.
- Express trust-proxy behavior and secure HTTP-only cookie settings are correct behind Railway and Cloudflare.
- Production error responses and logs do not expose secrets.
- Add a lightweight /health endpoint suitable for Railway's deployment health check.
- Add reproducible Railway configuration or exact documented dashboard values for build, pre-deploy migration, start, healthcheck, restart policy, and required variables.
- Run Drizzle migrations as a Railway pre-deploy command that fails the deployment on migration failure; do not run competing migrations independently in every app replica.
- Keep the Railway application at one replica because active rooms are currently process-local.
- Add graceful shutdown and client reconnection behavior for WebSocket disconnects. Document that an in-memory active match may still be lost on a process restart until shared durable match state is implemented.

Railway configuration and verification:

- Provision Railway PostgreSQL and reference its private DATABASE_URL from the application service.
- Set all required secrets in Railway variables, never in committed files.
- Configure the service's public Railway domain first and verify HTTPS, API, auth cookies, the SPA, and Socket.IO.
- Add the intended custom hostname in Railway Public Networking.
- Add both the CNAME and TXT records Railway supplies to Cloudflare DNS. Begin DNS-only if needed for domain verification/certificate provisioning, then enable Cloudflare proxying only after the Railway domain is verified and end-to-end TLS works.
- Ensure Cloudflare WebSockets are enabled. Do not create a cache rule that caches API, Socket.IO, authentication, or dynamic HTML responses.
- Confirm the deployed Socket.IO client uses WSS through the custom hostname and successfully upgrades or falls back according to the documented transport policy.
- Verify cookie Domain, Path, Secure, SameSite, and expiry behavior on the real custom hostname.

Production test requirements:

- Register, log in, refresh, and log out through the custom Cloudflare hostname.
- Create a room and join it from at least one separate browser/private session.
- Run a complete match through COUNTDOWN, all 69 seconds of LOOTING, and TALLY.
- Test direct navigation/refresh on React routes.
- Test a brief network interruption and Socket.IO reconnection.
- Confirm database migrations and durable records against Railway PostgreSQL.
- Check browser console, Railway logs, healthcheck, and Cloudflare behavior for errors.

Do not introduce Redis, multiple app replicas, Cloudflare Workers, or Durable Objects in this deployment step. If account access, DNS ownership, Railway project access, or deployment authorization is unavailable, complete all repository-side preparation, create docs/DEPLOYMENT.md with an exact dashboard checklist, and clearly report the remaining manual actions instead of pretending deployment was verified.

Update docs/RELEASE_CHECKLIST.md and docs/BUILD_STATUS.md with the deployed topology, redacted variable names, verified custom URL, test evidence, and known operational limitations.
```

### Completion gate

- The custom Cloudflare hostname serves the React app and API over HTTPS.
- Socket.IO connects over WSS through the custom hostname.
- Authentication cookies work after refresh on the production domain.
- Railway migrations and `/health` succeed.
- A multiplayer match completes through TALLY in production.
- The app service remains at one replica until shared active-match state is implemented.

---

## Optional prompt — Diagnose a bug without authorizing a rewrite

**Use: Sol** for multiplayer, authentication, data-loss, timing, or intermittent bugs.  
**Use: Terra** for isolated rendering, animation, layout, or input-presentation bugs.

```text
Diagnose and fix this issue in the 69 Seconds repository:

[PASTE THE SYMPTOM, ERROR, AND REPRODUCTION STEPS HERE]

Read the project documentation and git status first. Reproduce the problem or collect concrete evidence before changing code. Identify the root cause, implement the smallest durable fix consistent with the existing architecture, add a regression test where practical, and run the affected test/build commands. Do not rewrite adjacent systems or add unrelated features. Update docs/BUILD_STATUS.md only if this changes behavior, architecture, setup, or a known limitation.
```

## Optional prompt — Continue after a chat stopped midway

**Use the same model assigned to the interrupted step.**

```text
Continue the current 69 Seconds build step from the repository's actual state.

Read CODEX_BUILD_PROMPTS.md and docs/BUILD_STATUS.md, inspect git status and diffs, and identify which acceptance criteria from the active step remain incomplete. Preserve correct partial work. Finish the implementation, repair any failing checks caused by the partial state, run the active step's full verification, and update docs/BUILD_STATUS.md. Do not restart the step from scratch and do not proceed into the next numbered step.
```

## Practical usage advice

- Keep one numbered step per Codex chat so context stays focused.
- If a step fails its completion gate, keep working in that same chat or use the continuation prompt before advancing.
- Paste real errors and reproduction steps into bug chats; screenshots alone are rarely enough for networking bugs.
- Do not ask a visual-polish chat to redesign network contracts.
- Do not begin final art production until the Step 10 end-to-end loop is stable.
- Treat **69 Seconds** as a working title. Before public release, review the name and presentation for intellectual-property and marketplace-confusion risk.
