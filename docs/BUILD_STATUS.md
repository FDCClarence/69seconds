# 69 Seconds — Build Status

## Current milestone

Step 2: production-shaped authentication backend and session foundation.

## Implemented

- PostgreSQL persistence through Drizzle ORM, with a committed reproducible migration for `users` and `sessions`.
- Users have UUID identities, normalized lowercase/trimmed emails, a database unique index, Argon2id password hashes, and timestamps.
- Sessions use 256-bit opaque random cookie values; only SHA-256 token digests, ownership, and expiry are stored. Login replaces the presented session, logout revokes it, and expired sessions cannot authenticate.
- `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, and protected `GET /api/auth/me` endpoints.
- Strict shared Zod request/response schemas and stable typed HTTP errors for invalid payloads, duplicate email, invalid credentials, unauthenticated access, rate limits, and internal failures.
- Reusable `requireAuth` middleware that resolves trusted user identity from an unexpired database session.
- Shared per-IP register/login rate limiting with standard response headers. This is intentionally process-local while the MVP deploys one server replica.
- Deliberate cookie/security policy: HTTP-only and host-only everywhere; `SameSite=Lax` by default; `Secure` and a `__Host-` default name in production; explicit expiry; no domain attribute; and localhost-compatible development behavior.
- Exact-origin credentialed CORS, wildcard rejection, explicit JSON body limits, explicit Railway proxy-hop configuration, and graceful database pool shutdown.
- Local PostgreSQL Docker Compose service, environment examples, root migration commands, database setup instructions, endpoint contract notes, and safe test-database naming guard.
- Real-PostgreSQL integration coverage for registration, normalization/hash safety, duplicates, invalid credentials, session rotation, logout/revocation, expiry, protected access, body validation, and rate limiting.

## Verification

Completed on 2026-09-02 with Node.js 22.6.0, npm 10.8.2, PostgreSQL 16 Alpine, and Vitest 3.2.7:

- `DATABASE_URL=.../sixtynine_seconds_fresh_test npm run db:migrate -w @69-seconds/server` — passed against a brand-new empty disposable database.
- `npm run build` — passed for shared, server, and web. Vite produced the production bundle; the two existing non-failing Zod annotation-placement warnings remain.
- `npm run typecheck` — passed in all three workspaces.
- `npm run lint` — passed with no errors or warnings.
- `npm test` — passed 7 non-database tests across the workspaces. The 7 PostgreSQL integration tests are skipped by design unless `TEST_DATABASE_URL` is supplied.
- `TEST_DATABASE_URL=.../sixtynine_seconds_fresh_test npm run test:integration -w @69-seconds/server` — passed all 7 auth integration tests against the migrated PostgreSQL database.
- `npm audit --omit=dev` — passed with 0 production vulnerabilities.
- Full `npm audit` reports 4 moderate development-only findings in Drizzle Kit's transitive legacy esbuild loader. npm's proposed forced fix is a breaking Drizzle Kit downgrade, so it was not applied.

## Deliberately not implemented

- Polished React login/registration/current-user pages; these belong to Step 3.
- OAuth, social login, email verification, password reset, account recovery, or account-management flows.
- Finished room creation/joining, membership, readiness, host behavior, or reconnection.
- Authoritative game tick, map/collision, loot resolution, inventories, carts, sprint constraints, shoves, tally scoring, or Phaser.

## Known limitations

- Expired sessions are denied immediately but remain as indexed database rows until a future periodic cleanup job is added.
- The authentication rate limiter is in process. This matches the documented single-replica MVP; horizontal scaling will require a shared limiter store along with shared room/state infrastructure.
- Production correctness depends on setting `NODE_ENV=production`, an exact public `WEB_ORIGIN`, Railway's private `DATABASE_URL`, and the actual proxy-hop count. Deployment verification is intentionally deferred to Step 13.
- The full development dependency tree retains the four moderate Drizzle Kit/esbuild audit findings described above; shipped runtime dependencies audit cleanly.

## Recommended next step

Proceed exactly to Step 3 in `CODEX_BUILD_PROMPTS.md`: build the React login and registration experience, restore sessions through `GET /api/auth/me`, add authenticated home routing and logout, and use the established API contract without expanding into room networking.
