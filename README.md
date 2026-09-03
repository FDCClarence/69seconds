# 69 Seconds

A complete vertical slice of a browser-based, server-authoritative multiplayer grocery scramble. It includes MySQL-backed authentication, private one-to-four-player rooms, the 69-second Phaser looting match, authoritative movement/loot/sprint/shove rules, and the final tally.

## Prerequisites

- Node.js 20.19 or newer
- npm 10 or newer
- MySQL 8.4 (the provided Docker Compose service is suitable locally)

## Setup

```bash
npm ci
docker compose up -d db
docker compose exec db mysql -uroot -pmysql -e "CREATE DATABASE IF NOT EXISTS sixtynine_seconds_test"
cp apps/server/.env.example apps/server/.env
cp apps/web/.env.example apps/web/.env
npm run db:migrate
npm run dev
```

The `CREATE DATABASE` command is a one-time test-database setup and is a no-op on later runs. Development uses `sixtynine_seconds_dev`; integration tests deliberately refuse a `TEST_DATABASE_URL` whose database name does not contain `test`.

The web app runs at `http://localhost:5173`; Express and Socket.IO run at `http://localhost:3001`. Check the server with `GET http://localhost:3001/api/health`.

Vite loads `apps/web/.env`; server scripts load `apps/server/.env` through `dotenv`. `DATABASE_URL` is required so the server fails fast instead of silently using an unintended database.

The server talks to MySQL through `mysql2`. Identifiers are application-generated UUIDs in `CHAR(36)` columns because MySQL has no `uuid` type and no `INSERT ... RETURNING`. Timestamps are `DATETIME(3)`, which carries no zone, so the pool sets `timezone: 'Z'` and pins every connection to `SET time_zone = '+00:00'`; both are required for correct UTC round-trips when the Node process or the database server is not itself on UTC. `users.email` is `VARCHAR(255)` and `users.username` is `VARCHAR(24)`; both are uniquely indexed and lowercased by the shared schemas before they reach the database, so uniqueness never depends on the column collation.

## Authentication API

All request/response bodies use JSON. Browser callers must send credentials (for example, `fetch(..., { credentials: 'include' })`).

| Method and path | Purpose | Authentication |
| --- | --- | --- |
| `POST /api/auth/register` | Create an account and session | No |
| `POST /api/auth/login` | Verify credentials and replace the presented session | No |
| `POST /api/auth/logout` | Revoke the presented session and clear its cookie | Idempotent |
| `GET /api/auth/me` | Return the current public user | Required |

Registration accepts `{ "username": string, "email": string, "password": string }`; usernames are 4–24 characters of `a–z`, `0–9`, or `_`, and passwords must be 8–128 characters. Passwords do not require uppercase letters or special characters. Login accepts `{ "identifier": string, "password": string }`, where the identifier is either the username or the email address. Usernames and emails are trimmed, lowercased, and uniquely indexed; a taken one returns `USERNAME_ALREADY_TAKEN` or `EMAIL_ALREADY_REGISTERED`. Errors use `{ "error": { "code", "message", "retryable" } }` with stable codes.

The cookie contains a random opaque value only. The database stores its SHA-256 digest, and password hashes use Argon2id. In development the cookie is HTTP-only, host-only, `SameSite=Lax`, and not `Secure` so localhost HTTP works. `NODE_ENV=production` makes it `Secure` and defaults its name to the `__Host-`-prefixed `__Host-69s_session`. Production defaults to one trusted proxy hop for Railway; local/test defaults to none. `WEB_ORIGIN` is an exact comma-separated allowlist and never accepts `*`.

## Private rooms

The landing page is the login/register form; the authenticated home is a single centered menu with Create Room and a Join Room code field, under a top bar whose account menu holds Log out. Socket.IO reuses the session cookie during its handshake; clients never send a player ID or host claim. Room commands are `room:create`, `room:join`, `room:leave`, `lobby:ready`, and `lobby:start`, with authoritative state broadcast as `lobby:state`.

Rooms hold one to four distinct users in server memory. Codes are six readable characters, a disconnected member has a 15-second reconnection grace, and host status migrates to the remaining lowest slot after a host is actually removed. Starting requires every rostered player—including the host—to be connected and ready. Active rooms do not survive a server restart, and production must remain at one application replica until shared room infrastructure is added.

## People in the store

Survivors stand in the aisles on spawn locations the loot draw left free, and are recruited by carrying one to your own cart. A person fills all four carry slots, so picking one up needs empty hands, and the HUD shows them in the first slot with the other three crossed out. `Q` puts down whatever you picked up last — including a person — at wherever the server has you standing. Recruits appear in the tally by name under a `people` category.

The roster is data: add a portrait to `apps/web/public/npc_images/`, then add an entry to `packages/shared/src/npc-table.ts` naming the file, its pixel size, and the figure's opaque bounding box inside it. That rect is what frames the person on the map and in the HUD at a consistent size, so it must match the file; `npm test -w @69-seconds/web` fails if it does not. `maxPerMatch` in the same file caps how many people a match places.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Watch shared types and run both application dev servers |
| `npm run build` | Build shared, server, then web in dependency order |
| `npm run typecheck` | Type-check every workspace |
| `npm run lint` | Lint the repository |
| `npm test` | Run all workspace tests |
| `npm run db:generate` | Generate a migration after an intentional Drizzle schema change |
| `npm run db:migrate` | Apply committed migrations to `DATABASE_URL` |
| `npm run test:integration -w @69-seconds/server` | Run Socket.IO room integration tests (and MySQL auth tests when `TEST_DATABASE_URL` is set) |

Target one workspace with npm's `-w` flag, for example `npm test -w @69-seconds/shared`.

## Repository layout

- `apps/web` — React/Vite shell and the route-scoped Phaser game host.
- `apps/server` — Express/Socket.IO process and authoritative room simulations.
- `apps/server/drizzle` — committed MySQL migrations and Drizzle migration metadata.
- `packages/shared` — framework-free constants, schemas, event maps, state types, and pure rules.
- `docs` — gameplay specification, architecture decisions, deployment runbook, and implementation handoff.

Read [GAME_SPEC.md](docs/GAME_SPEC.md), [ARCHITECTURE.md](docs/ARCHITECTURE.md), and [BUILD_STATUS.md](docs/BUILD_STATUS.md) before continuing implementation. [DEPLOYMENT.md](docs/DEPLOYMENT.md) covers shipping the server and MySQL to Railway and the client to Cloudflare Pages.
