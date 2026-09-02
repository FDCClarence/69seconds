# 69 Seconds

Architectural foundation for a browser-based, server-authoritative multiplayer grocery scramble. This repository currently contains shared network/domain contracts and thin React and Express/Socket.IO application shells; it intentionally does not contain authentication, persistence, rooms, or complete gameplay yet.

## Prerequisites

- Node.js 20.19 or newer
- npm 10 or newer

## Setup

```bash
npm install
cp apps/server/.env.example apps/server/.env
cp apps/web/.env.example apps/web/.env
npm run dev
```

The web app runs at `http://localhost:5173`; Express and Socket.IO run at `http://localhost:3001`. Check the server with `GET http://localhost:3001/api/health`.

Environment files are optional for the documented local defaults. Vite loads `apps/web/.env`; the server shell currently reads process environment variables, so export them in the terminal or use the defaults until a later configuration step adds a loader.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Watch shared types and run both application dev servers |
| `npm run build` | Build shared, server, then web in dependency order |
| `npm run typecheck` | Type-check every workspace |
| `npm run lint` | Lint the repository |
| `npm test` | Run all workspace tests |

Target one workspace with npm's `-w` flag, for example `npm test -w @69-seconds/shared`.

## Repository layout

- `apps/web` — React/Vite shell and, later, the React-to-Phaser game host.
- `apps/server` — Express/Socket.IO process and future authoritative simulation.
- `packages/shared` — framework-free constants, schemas, event maps, state types, and pure rules.
- `docs` — gameplay specification, architecture decisions, and implementation handoff.

Read [GAME_SPEC.md](docs/GAME_SPEC.md), [ARCHITECTURE.md](docs/ARCHITECTURE.md), and [BUILD_STATUS.md](docs/BUILD_STATUS.md) before continuing implementation.
