# 69 Seconds — Build Status

## Final state

Release-readiness audit completed on 2026-09-03. The current vertical slice implements one complete server-authoritative `LOBBY → COUNTDOWN → LOOTING → TALLY` match for one to four authenticated players. No future game phases were added.

The audit traced authentication and session lifetime, every HTTP/Socket.IO ingress, movement/loot/cart/sprint/shove/tally authority, pickup and deadline ordering, room/timer/listener/Phaser cleanup, snapshot and interpolation behavior, four-player reconnection, build/migration/runtime configuration, accessibility, responsive layouts, and core automated coverage.

## Verified fixes in this audit

- Direct WebSocket upgrades now enforce the exact `WEB_ORIGIN` allowlist. Socket.IO CORS still covers polling; the upgrade gate closes the browser-origin gap that CORS alone does not cover.
- Established sockets now carry the database session expiry, are terminated at that deadline, and are disconnected immediately when login replacement or logout revokes their token. The server reports `UNAUTHENTICATED`, and the React shell returns the user to login instead of leaving a permanently reconnecting match.
- Session invalidation subscriptions and expiry timers are disposed during socket/server shutdown. The React root disconnects its socket on unmount, and pending connection attempts now time out and remove temporary listeners.
- Replay history increased from 32 to 128 committed actions per player, which exceeds every cooldown-paced shove and possible loot commit in one 69-second round. A regression test replays the first request after forty later committed shoves and confirms no second effect.
- Loot sequencing now rejects stale and duplicate broadcasts before they enter the reconnect cache. Deposit item IDs are merged idempotently, fixing a verified client tally bug where the request acknowledgement and room broadcast could append the same deposit twice.
- The Playwright journey now covers a brief in-match offline/reconnect and checks the gameplay and tally layouts at 320 px. That check found and fixed a long-username flex overflow in tally cards.
- The README now describes the implemented slice and uses the lockfile-reproducible `npm ci` setup. App-specific environment examples and the release runbook explicitly separate browser-visible configuration from secrets.
- `docs/RELEASE_CHECKLIST.md` now covers local setup, every environment variable, migrations, the automated gate, a detailed four-player latency/jitter/disconnection procedure, known limitations, and deployment considerations.

## Authority and race audit result

- Trusted identity comes only from the opaque HTTP-only session cookie. Client payloads cannot claim player identity, host/slot, positions, velocity, stamina, facing, inventory, cart ownership, phase, deadline, shove direction, or tally.
- HTTP JSON is limited to 16 KiB. Socket.IO messages are limited to 16 KiB, every known payload is runtime-validated, all inbound socket events share a bounded token bucket, and loot/shove actions have narrower per-player buckets.
- Movement is integrated at a fixed 30 Hz from directional intent; compact position/stamina/recovery snapshots average 20 Hz and use volatile delivery so slow clients do not accumulate obsolete state. Loot, lobby, and tally are event-driven and do not ride the movement stream. Remote clients interpolate behind a 100 ms buffer.
- Pickup, deposit, shove, disconnect restocking, and tally commits are synchronous mutations on the Node event loop. Contested items and mutual shoves therefore serialize to one winner. Each action authority rejects at or beyond the same server deadline even before a delayed simulation timer advances the phase.
- The first deadline tick freezes one immutable cart-derived tally. Carried items do not count, disconnected participants remain represented, late gameplay is rejected, repeated ticks emit no second result, and movement snapshots stop in `TALLY`.
- Room grace timers, the abandoned-room sweep, simulation timer, session expiry timers, invalidation subscription, Socket.IO server, MySQL pool, React effects, scene subscriptions, Phaser listeners, and canvas teardown all have explicit cleanup paths. No unbounded server room/action history or client interpolation buffer was found.

## Passing automated checks

Run with Node.js 22.6.0 and npm 10.8.2:

- `npm ci` — passed from the committed lockfile after network access was available.
- `npm run lint` — passed with no errors or warnings.
- `npm run typecheck` — passed in shared, server, and web workspaces.
- `TEST_DATABASE_URL=mysql://root:mysql@127.0.0.1:3306/sixtynine_seconds_test npm test` — 170 tests passed: 35 shared, 89 server, and 46 web. This includes all 7 MySQL authentication cases and all Socket.IO integration suites.
- `npm run build` — passed for shared, server, and web. Vite retained two non-failing dependency annotation notices and the advisory lazy Phaser chunk warning (`1,713.18 kB`, `388.89 kB` gzip).
- `npm run e2e` — 2 Playwright tests passed. Four isolated browser contexts completed registration, room join/start, lobby reload, in-match offline/reconnect, the real 69-second deadline, and identical tally arrival; authenticated lobby, gameplay, and tally layouts stayed within 320 px.
- `npm ls --omit=dev` — passed with no missing or invalid production packages.
- `git diff --check` — passed.

The clean install's registry audit reported four moderate findings in the full development tree. A separate `npm audit --omit=dev` could not complete because the advisory endpoint was unavailable in the restricted run. Do not treat that production-only advisory check as passing; run it through an approved CI/release environment before deployment.

## Human multiplayer playtesting still required

Automated coverage proves deterministic rules, real loopback Socket.IO behavior, four isolated Chromium contexts, a brief transport outage, responsive layout, and the 69-second browser journey. It does **not** replace human observation under variable real-world latency and device scheduling.

Release sign-off still requires the manual four-player procedure in `docs/RELEASE_CHECKLIST.md`, using distinct profiles/devices with asymmetric latency, changing jitter, a 5–10 second mid-match outage, contested pickups, mutual shoves, sprint exhaustion/reconnect, and side-by-side tally comparison. Record browser/device/network profiles and any visible reconciliation or input problems.

## Known limitations

- Active rooms, simulations, and final results are process-local. A restart/deploy ends matches, and production must remain at exactly one server replica until shared room state and a compatible Socket.IO adapter exist.
- Playwright uses production HTTP, Socket.IO, room, simulation, and client code with in-memory authentication. MySQL is exercised by the separate server integration suite, not the browser fixture.
- Variable jitter and sustained real-device four-player behavior remain manual checks. The automated browser suite covers only one brief offline interval over loopback.
- The procedural map, characters, loot markers, and audio are placeholders. Gameplay is keyboard-controlled; touch controls and later resource-management phases are out of scope.
- Logging uses process stdout/stderr and there is no durable gameplay telemetry, trace store, or alerting layer.
- The lazy Phaser production chunk remains large, although it is split from the application shell and loads only on the match route.
- The full development dependency audit reports four moderate findings; the production-only advisory result must be refreshed in an approved environment.

## Exact recommended next step

Run and record the manual four-player shaped-network sign-off from `docs/RELEASE_CHECKLIST.md` against a production-like single-replica deployment; before allowing public traffic, run the approved production-only dependency advisory scan and resolve or explicitly accept its findings.
