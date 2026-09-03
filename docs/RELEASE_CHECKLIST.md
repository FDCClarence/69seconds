# 69 Seconds — Release Checklist

This checklist is for the current one-round vertical slice. It does not authorize or require future game phases.

## Local setup

- [ ] Install Node.js 20.19 or newer and npm 10 or newer.
- [ ] Install the lockfile exactly with `npm ci`.
- [ ] Start MySQL 8.4 with `docker compose up -d db`.
- [ ] Create the test database once:

  ```bash
  docker compose exec db mysql -uroot -pmysql \
    -e "CREATE DATABASE IF NOT EXISTS sixtynine_seconds_test"
  ```

- [ ] Copy `apps/server/.env.example` to `apps/server/.env` and `apps/web/.env.example` to `apps/web/.env`.
- [ ] Apply committed migrations with `npm run db:migrate`.
- [ ] Start all workspaces with `npm run dev`, then verify the web app at `http://localhost:5173` and `GET http://localhost:3001/api/health`.

## Environment variables

Server runtime:

| Variable | Requirement | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Required | MySQL connection used by accounts, sessions, and migrations. |
| `WEB_ORIGIN` | Explicit in production | Comma-separated exact HTTP(S) browser origins used by HTTP CORS and the WebSocket Origin gate. No paths, trailing slashes, or `*`. |
| `NODE_ENV` | Set to `production` in production | Enables Secure cookies, the default `__Host-69s_session` name, and the production proxy default. |
| `PORT` | Platform-provided in production | HTTP/Socket.IO port; defaults to `3001` locally. |
| `COOKIE_SAME_SITE` | Usually `lax` | Use `lax` for app/API subdomains of one site. `none` requires production HTTPS and is not reliable where third-party cookies are blocked. |
| `SESSION_TTL_MS` | Optional | Session lifetime; default is 30 days, minimum is 60 seconds. Established sockets are terminated when this expiry is reached. |
| `SESSION_COOKIE_NAME` | Optional | Defaults to `__Host-69s_session` in production and `69s_session` otherwise. |
| `TRUST_PROXY_HOPS` | Optional | Defaults to one in production and zero locally. It must match the actual proxy chain for correct rate-limit IPs. |
| `AUTH_RATE_LIMIT_WINDOW_MS` | Optional | Credential-attempt window; default is 15 minutes. |
| `AUTH_RATE_LIMIT_MAX` | Optional | Credential attempts per process/window; default is 10. |

Build and test:

| Variable | Requirement | Purpose |
| --- | --- | --- |
| `VITE_SERVER_URL` | Required for a production web build | Public API/Socket.IO origin baked into the browser bundle. Never place secrets in a `VITE_` variable. |
| `TEST_DATABASE_URL` | Required for MySQL integration coverage | Must name a dedicated database containing `test`; tests refuse other database names. |
| `CI` | Optional | Enables the Playwright CI reporter and one retry. |

Do not expose `DATABASE_URL` or session tokens to the web build.

## Database migrations

- [ ] Confirm `DATABASE_URL` targets the intended database.
- [ ] Back up production data before applying a new schema migration.
- [ ] Apply existing migrations with `npm run db:migrate` before starting the new server version.
- [ ] After an intentional schema change, run `npm run db:generate`, review the SQL and Drizzle metadata, test it against a disposable MySQL database, and commit both schema and migration files together.
- [ ] Confirm `users`, `sessions`, and `__drizzle_migrations` exist; confirm session expiry and foreign-key indexes are present.
- [ ] Run the database-backed tests:

  ```bash
  TEST_DATABASE_URL="mysql://root:mysql@localhost:3306/sixtynine_seconds_test" npm test
  ```

Never point `TEST_DATABASE_URL` at development or production data.

## Automated release gate

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm test` (with `TEST_DATABASE_URL` for all auth cases)
- [ ] `npm run build`
- [ ] `npm run e2e`
- [ ] `git diff --check`
- [ ] `npm ls --omit=dev` reports no invalid or missing production packages.
- [ ] Run an approved production dependency/advisory scan in CI (for example `npm audit --omit=dev`) and triage every finding. This requires sending lockfile dependency metadata to the configured npm registry.

## Manual four-player test

Use four genuinely isolated browser profiles or devices so each has its own cookie jar. Use the production build and a disposable environment where possible.

- [ ] Give each client a custom network profile: one unthrottled, one around 100 ms latency, one around 200 ms, and one alternating between roughly 100–350 ms to simulate jitter. Keep bandwidth high enough that deliberate latency, not starvation, is being tested.
- [ ] Register four unique accounts. Create a room as player 1, join the same code as players 2–4, and confirm a fifth distinct account is refused.
- [ ] Confirm every client sees the same four names, stable slots, ready states, host, and countdown. Verify a non-host cannot start and the host cannot start until all four are connected and ready.
- [ ] During looting, hold and release movement in cardinal and diagonal directions. Confirm local prediction stays responsive, remote motion remains bounded, shelves/map edges cannot be crossed, and nobody accelerates because of jitter.
- [ ] Contest the same pickup with all four players. Confirm exactly one player receives it, no hand exceeds four items, and deposits appear once in the assigned cart only.
- [ ] Exhaust sprint, release it, and reconnect while partially depleted. Confirm walking remains available, the recovery threshold is honored, and reconnecting does not refill stamina.
- [ ] Attempt simultaneous mutual shoves and repeated shove spam. Confirm only one mutual shove lands, cooldown/recovery/range/cone/geometry remain authoritative, and no player is pushed through a shelf, cart, or boundary.
- [ ] Take one non-host client offline for 5–10 seconds during looting, then restore it before the 15-second grace expires. Confirm the same slot, position, inventory, stamina, cart, and timer are restored without duplication.
- [ ] In a separate lobby, disconnect the host beyond 15 seconds. Confirm host migration chooses the lowest remaining stable slot. In a started match, confirm an expired member is removed and carried loot is restocked once.
- [ ] Leave one client heavily delayed across the buzzer. Confirm all four clients reach `TALLY`, no movement/interaction/shove after the server deadline changes state, and every displayed tally is identical. Carried but undeposited loot must not count.
- [ ] Inspect WebSocket traffic: input is at most 30 Hz, movement snapshots average 20 Hz, snapshots are compact and do not repeat loot/lobby payloads, and the stream stops in `TALLY`.
- [ ] Repeat the critical lobby, HUD/settings, connection overlay, and tally flows at 320 px width and a 1366×768 viewport. Verify keyboard focus, visible focus indication, reduced-motion behavior, readable live-region text, and no horizontal page overflow.

## Known limitations

- Rooms, active simulations, and final tallies are process-local and disappear on restart or deployment. Run exactly one application replica; there is no Redis adapter, shared room store, or durable match history.
- Automated Playwright coverage uses production HTTP/Socket.IO/game code with in-memory authentication. MySQL behavior is covered separately and only when `TEST_DATABASE_URL` is supplied.
- Playwright covers four isolated clients, a brief in-match offline/reconnect, and the 320 px critical layouts. Variable jitter and long real-device four-player sessions still require the manual procedure above.
- The store, shoppers, loot, and audio are original procedural placeholders. Gameplay is keyboard-controlled; a touch control scheme is not part of this slice.
- Logging is process stdout/stderr rather than structured telemetry. There are no durable gameplay metrics, traces, or alerts.
- The dependency advisory check requires approved registry access and must be run in CI or by a release operator if it was not completed in the release environment.

## Deployment considerations

- [ ] Follow `docs/DEPLOYMENT.md`; host the web and API on subdomains of the same registrable domain where possible so `SameSite=Lax` remains viable.
- [ ] Terminate TLS before production traffic. Confirm the cookie is host-only, `Secure`, `HttpOnly`, `Path=/`, and has the intended SameSite value.
- [ ] Keep one server replica and disable overlapping old/new replicas for rooms unless players are explicitly warned that deployments terminate matches.
- [ ] Run migrations as a pre-deploy step and stop the rollout on migration failure.
- [ ] Send `SIGTERM` during shutdown and allow enough drain time for Socket.IO to close clients and the MySQL pool to end. Expect active process-local matches to be lost.
- [ ] Capture stdout/stderr centrally, monitor `/api/health`, process restarts, 5xx responses, authentication rate limits, Socket.IO disconnect rates, event-loop delay, memory, and database-pool saturation.
- [ ] Restrict MySQL to the private network, rotate credentials, enable backups, and test restore procedures.
- [ ] Confirm `WEB_ORIGIN` lists only intended production/preview origins and that direct WebSocket handshakes from any other browser Origin are rejected.
- [ ] Smoke-test registration, cookie persistence, reload/reconnect, a full room, the exact 69-second deadline, tally agreement, deep links, and logout-driven socket termination after deployment.
