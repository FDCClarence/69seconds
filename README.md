# 69 Seconds

Foundation for a browser-based, server-authoritative multiplayer grocery scramble. The repository includes shared network/domain contracts, a React authentication and lobby client, an Express/Socket.IO server with private in-memory rooms, and PostgreSQL-backed account/session authentication. Phaser gameplay is not implemented yet.

## Prerequisites

- Node.js 20.19 or newer
- npm 10 or newer
- PostgreSQL 16 (the provided Docker Compose service is suitable locally)

## Setup

```bash
npm install
docker compose up -d db
docker compose exec db createdb -U postgres sixtynine_seconds_test
cp apps/server/.env.example apps/server/.env
cp apps/web/.env.example apps/web/.env
npm run db:migrate
npm run dev
```

The `createdb` command is a one-time test-database setup and reports that the database already exists on later runs. Development uses `sixtynine_seconds_dev`; integration tests deliberately refuse a `TEST_DATABASE_URL` whose database name does not contain `test`.

The web app runs at `http://localhost:5173`; Express and Socket.IO run at `http://localhost:3001`. Check the server with `GET http://localhost:3001/api/health`.

Vite loads `apps/web/.env`; server scripts load `apps/server/.env` through `dotenv`. `DATABASE_URL` is required so the server fails fast instead of silently using an unintended database.

## Authentication API

All request/response bodies use JSON. Browser callers must send credentials (for example, `fetch(..., { credentials: 'include' })`).

| Method and path | Purpose | Authentication |
| --- | --- | --- |
| `POST /api/auth/register` | Create an account and session | No |
| `POST /api/auth/login` | Verify credentials and replace the presented session | No |
| `POST /api/auth/logout` | Revoke the presented session and clear its cookie | Idempotent |
| `GET /api/auth/me` | Return the current public user | Required |

Registration accepts `{ "email": string, "password": string }`; passwords must be 12–128 characters. Login uses the same fields. Emails are trimmed, lowercased, and uniquely indexed. Errors use `{ "error": { "code", "message", "retryable" } }` with stable codes.

The cookie contains a random opaque value only. The database stores its SHA-256 digest, and password hashes use Argon2id. In development the cookie is HTTP-only, host-only, `SameSite=Lax`, and not `Secure` so localhost HTTP works. `NODE_ENV=production` makes it `Secure` and defaults its name to the `__Host-`-prefixed `__Host-69s_session`. Production defaults to one trusted proxy hop for Railway; local/test defaults to none. `WEB_ORIGIN` is an exact comma-separated allowlist and never accepts `*`.

## Private rooms

The authenticated React home links to Create Room and Join Room views. Socket.IO reuses the session cookie during its handshake; clients never send a player ID or host claim. Room commands are `room:create`, `room:join`, `room:leave`, `lobby:ready`, and `lobby:start`, with authoritative state broadcast as `lobby:state`.

Rooms hold one to four distinct users in server memory. Codes are six readable characters, a disconnected member has a 15-second reconnection grace, and host status migrates to the remaining lowest slot after a host is actually removed. Starting requires every rostered player—including the host—to be connected and ready. Active rooms do not survive a server restart, and production must remain at one application replica until shared room infrastructure is added.

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
| `npm run test:integration -w @69-seconds/server` | Run Socket.IO room integration tests (and PostgreSQL auth tests when `TEST_DATABASE_URL` is set) |

Target one workspace with npm's `-w` flag, for example `npm test -w @69-seconds/shared`.

## Repository layout

- `apps/web` — React/Vite shell and, later, the React-to-Phaser game host.
- `apps/server` — Express/Socket.IO process and future authoritative simulation.
- `apps/server/drizzle` — committed PostgreSQL migrations and Drizzle migration metadata.
- `packages/shared` — framework-free constants, schemas, event maps, state types, and pure rules.
- `docs` — gameplay specification, architecture decisions, and implementation handoff.

Read [GAME_SPEC.md](docs/GAME_SPEC.md), [ARCHITECTURE.md](docs/ARCHITECTURE.md), and [BUILD_STATUS.md](docs/BUILD_STATUS.md) before continuing implementation.
