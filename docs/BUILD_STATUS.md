# 69 Seconds — Build Status

## Current milestone

Step 3: React login, registration, session restoration, and authenticated landing screens.

## Implemented

- Step 2 authentication backend remains intact: PostgreSQL/Drizzle users and opaque server-side sessions, Argon2id password hashes, HTTP-only cookies, rate limits, stable API errors, and protected `GET /api/auth/me`.
- Added a typed browser auth client that calls the existing `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, and `GET /api/auth/me` endpoints with `credentials: 'include'`. It validates successful and error responses with the established shared schemas.
- Replaced the web scaffold with an original, responsive 69 Seconds landing experience built from CSS and semantic HTML: a countdown/check-out visual, clear player-pass login/registration paths, strong contrast, keyboard-visible focus states, and a reduced-motion fallback.
- Added accessible login and registration forms with labels, autocomplete attributes, required input semantics, inline client validation, password confirmation on registration, disabled/loading submit states, stable server-error messages, and post-success status notices.
- Added in-app history routing for `/`, `/login`, `/register`, and `/home`; `/home` is protected until a valid current-user session is restored. Refreshing restores the session through `/api/auth/me`.
- Added authenticated home UI with Create Room and Join Room actions plus idempotent logout. The room buttons deliberately announce that room lifecycle is the next build step and do not issue speculative network requests.
- Added Happy DOM + Testing Library component/critical-flow coverage for session restoration, protected access, inline registration validation and success, login server errors, and logout.

## Verification

Completed on 2026-09-02 with Node.js 22.6.0 and npm 10.8.2:

- `npm run typecheck` — passed in shared, server, and web workspaces.
- `npm run lint` — passed with no errors or warnings.
- `npm test` — passed: 2 server unit tests, 6 web tests (including 5 auth component/flow tests), and 4 shared tests. The existing 7 PostgreSQL auth integration tests remain skipped by design without `TEST_DATABASE_URL`.
- `npm run build` — passed for shared, server, and web. Vite produced the production bundle; the two pre-existing non-failing Zod annotation-placement warnings remain.
- `npm audit --omit=dev` — passed with 0 production vulnerabilities.

## Deliberately not implemented

- Room creation/joining transport, lobby membership, host/readiness behavior, reconnection, or Socket.IO room state.
- Phaser gameplay, map/collision, loot, carts, sprint/shove rules, server game tick, or tally.
- OAuth, email verification, password reset, account recovery, and account management.

## Known limitations

- Create Room and Join Room are intentionally presentational until Step 4 establishes the authoritative room API and Socket.IO lifecycle.
- Browser route history is implemented in the React shell. Production static-file fallback/server delivery is deferred with the wider production-serving work; Vite development already serves these routes.
- Expired sessions are denied immediately but remain as indexed database rows until a future periodic cleanup job is added.
- The authentication rate limiter is process-local, matching the documented one-replica MVP. Horizontal scaling will require shared room/state and limiter infrastructure.
- Production correctness depends on setting `NODE_ENV=production`, an exact public `WEB_ORIGIN`, Railway's private `DATABASE_URL`, and the actual proxy-hop count. Deployment verification is intentionally deferred to Step 13.

## Recommended next step

Proceed exactly to Step 4 in `CODEX_BUILD_PROMPTS.md`: implement server-authoritative create/join room and lobby lifecycle with Socket.IO, then replace the two authenticated home placeholders with the real room and lobby views.
