# Deployment

Taking the monorepo from a local Docker MySQL to production: the Express/Socket.IO server and its MySQL database on Railway, the Vite/React client on Cloudflare Pages, and the session cookie that has to survive the trip between them.

| Platform | Hosts |
| --- | --- |
| Railway | `apps/server` — Express, Socket.IO, Drizzle migrations — plus a managed MySQL 8 service |
| Cloudflare Pages | `apps/web` — the static Vite build. No Functions, no Workers; it only talks to Railway |

## Before you start

Authentication is an `HttpOnly` session cookie set by the server and replayed on every `fetch` and on the Socket.IO handshake. Whether the browser keeps that cookie depends entirely on which domains you deploy to.

### Pick a domain strategy first

**Default hostnames will not hold a session for long.** `your-app.pages.dev` and `your-app.up.railway.app` are different registrable domains, so the session cookie is a third-party cookie. It needs `COOKIE_SAME_SITE=none` to be sent at all, Safari blocks it outright, and Chrome is phasing it out. Fine for a smoke test, not for real players.

**Two subdomains of one domain you own is the durable setup.** Point `app.example.com` at Pages and `api.example.com` at Railway. Requests between them are then same-site, `COOKIE_SAME_SITE=lax` works, and nothing is a third-party cookie. Both platforms accept custom domains on their free tiers.

### Prerequisites

- The repo pushed to GitHub, with `apps/web/public/_redirects` committed.
- Railway and Cloudflare accounts, both connected to that GitHub account.
- Node 20.19 or newer locally, in case you need to run migrations by hand.

### The order is circular by nature

Railway needs the Pages URL for `WEB_ORIGIN`; Pages needs the Railway URL for `VITE_SERVER_URL`. Deploy Railway first, then Pages, then come back and close the loop in Part 3. Expect the first Railway deploy to reject browser requests until you do.

## Part 1 — Server and database on Railway

### 1. Create the project from the repo

New Project → **Deploy from GitHub repo** → pick the repository.

Railway reads the npm workspaces and may create one service per app — a `web` and a `server`. **Delete the `web` service.** It is a static Vite build that belongs on Cloudflare Pages (Part 2), and running it here means paying for a Node process to serve files a CDN serves free. You should end up with exactly two services: `server` and `MySQL`.

The first build will fail or misbehave until step 3, because Railway's guessed settings are wrong for this repo. Let it.

### 2. Add the MySQL service

Inside the same project: **Create** → **Database** → **Add MySQL**. It provisions MySQL 8 with its own volume.

Open the MySQL service's **Variables** tab and note the connection variable names — `MYSQL_URL` is the one on the internal private network, `MYSQL_PUBLIC_URL` goes through the public TCP proxy. The app should use the private URL: it is faster, free of egress charges, and never exposed. Keep the public one for running migrations or a client from your laptop.

### 3. Set the server service's build and deploy commands

Open the app service → **Settings**. This is a workspace monorepo, so the build runs from the repo root and only the server workspace is started.

| Field | Value |
| --- | --- |
| Root Directory | `/` (repo root — Railway may have guessed `apps/server`) |
| Build Command | `npm install --include=dev && npm run build:server` |
| Pre-Deploy Command | `npm run db:migrate` |
| Start Command | `npm run start` |
| Replicas | `1` (see below) |

The pre-deploy command runs `drizzle-kit migrate` against `DATABASE_URL` before the new version takes traffic, so the schema is always in place before the server boots.

Root Directory must stay at `/`. The lockfile lives at the repo root and `apps/server/package.json` depends on `"@69-seconds/shared": "*"`, a workspace package that only resolves from there — building inside `apps/server` alone sends npm to the public registry looking for it, and the install fails.

Two details in that build command are not incidental:

- **`npm install`, not `npm ci`.** Nixpacks mounts build caches inside `node_modules` (notably `apps/web/node_modules/.vite`). `npm ci` deletes `node_modules` wholesale and cannot remove a mount point, so it fails with `EBUSY: resource busy or locked`. `npm install` reconciles in place and is unaffected.
- **`--include=dev`.** `NODE_ENV=production` makes npm omit devDependencies, but the build needs `typescript` and the pre-deploy step needs `drizzle-kit`, both of which are devDependencies. Without this flag the build dies on `tsc: not found`.

`build:server` builds only the shared package and the server. The client is Cloudflare's job, so building it here would waste time and pull in the Vite cache directory that caused the `EBUSY` in the first place.

> **Keep replicas at 1.** Rooms live in a single process's memory. A second replica gives you two disjoint room registries behind one URL, and players who "join" the same code land in different games. Horizontal scaling needs shared room state first.

### 4. Set the server's environment variables

App service → **Variables**. The `${{MySQL.MYSQL_URL}}` syntax is a Railway reference — it resolves at deploy time and follows the database if its credentials rotate. Adjust `MySQL` if you renamed the service.

| Variable | Value | Why |
| --- | --- | --- |
| `DATABASE_URL` | `${{MySQL.MYSQL_URL}}` | Required. The server refuses to boot without it rather than guess a database. |
| `NODE_ENV` | `production` | Turns on `Secure` cookies, the `__Host-69s_session` cookie name, and one trusted proxy hop. |
| `WEB_ORIGIN` | `https://<your Pages URL>` | Exact CORS allowlist for HTTP and the Socket.IO handshake. Leave it unset until Part 3 — it falls back to `http://localhost:5173`, which boots cleanly and lets `curl` verify the server. |
| `COOKIE_SAME_SITE` | `lax` or `none` | `lax` for subdomains of one domain; `none` only if you stay on `pages.dev` + `railway.app`. |
| `SESSION_TTL_MS` | `2592000000` | Optional. 30 days is the default. |
| `AUTH_RATE_LIMIT_MAX` | `10` | Optional. Per-process credential attempts per window — accurate only at one replica. |

**Do not set `PORT`** — Railway injects it and the server reads it. **Do not set `TRUST_PROXY_HOPS`** — it already defaults to `1` in production, which is what Railway's TLS terminator needs for correct client IPs in rate limiting.

`WEB_ORIGIN` is exact-match: no trailing slash, no path, and `*` is rejected at boot. It accepts a comma-separated list, so `https://app.example.com,https://69-seconds.pages.dev` is valid while you cut over between domains.

### 5. Give the service a public domain

App service → **Settings** → **Networking** → **Generate Domain**, which returns something like `69-seconds-production.up.railway.app`. If you are using your own domain, add `api.example.com` here instead and create the CNAME record Railway shows you. Copy whichever URL you end up with — Part 2 needs it.

### 6. Redeploy and confirm the server is alive

```bash
curl https://<your-railway-domain>/api/health
# {"status":"ok","service":"69-seconds-server"}
```

Then check the deploy logs for `migrations applied successfully` from the pre-deploy step. If instead you see `drizzle-kit: not found`, see Troubleshooting — there is a one-command fallback.

## Part 2 — Client on Cloudflare Pages

### 1. Connect the repo

**Workers & Pages** → **Create** → **Pages** → **Connect to Git** → select the repository and the `main` branch.

### 2. Configure the build

Framework preset **None** — the presets assume a single-package repo and will run the wrong build. The `build:web` script builds the shared package first, then the client, which is the order the workspace dependency requires.

| Field | Value |
| --- | --- |
| Framework preset | None |
| Build command | `npm run build:web` |
| Build output directory | `apps/web/dist` |
| Root directory | `/` (leave blank) |

### 3. Add the build-time variables

Under **Environment variables**, for the **Production** environment:

| Variable | Value | Why |
| --- | --- | --- |
| `VITE_SERVER_URL` | `https://<your-railway-domain>` | The API and Socket.IO origin. No trailing slash. |
| `NODE_VERSION` | `22` | The repo requires Node ≥ 20.19; Pages' default is often older. |

> **Vite bakes this in at build time.** `VITE_SERVER_URL` is substituted into the JS bundle during the build, not read at runtime. Changing it later has no effect until you trigger a fresh Pages deployment.

### 4. Save and deploy

Cloudflare builds and publishes to `<project>.pages.dev`. Copy that URL. For a custom domain, open the project's **Custom domains** tab and add `app.example.com`; Cloudflare creates the DNS record if the zone is already on your account.

### 5. Verify deep links resolve

Open `https://<your-pages-url>/login` directly. The client reads its route from `window.location.pathname`, so a bare Pages project would return a 404 here. The committed `apps/web/public/_redirects` rewrites every path to the SPA shell:

```
/*    /index.html   200
```

A 404 on this step means the file did not reach the build output — confirm it is committed under `apps/web/public/` and appears in `apps/web/dist/` after a local `npm run build:web`.

## Part 3 — Close the loop

### 1. Point `WEB_ORIGIN` at the real client

Railway app service → **Variables** → set `WEB_ORIGIN` to the exact Pages origin you copied, for example `https://69-seconds.pages.dev` or `https://app.example.com`. Saving a variable triggers a redeploy.

### 2. Settle the cookie policy

On two subdomains of one domain, leave `COOKIE_SAME_SITE=lax` — requests between them are same-site and the cookie flows normally. On the default platform hostnames you must set `COOKIE_SAME_SITE=none`, and the server only accepts that in production because `SameSite=None` without `Secure` is rejected by browsers anyway.

Either way the cookie ships as `__Host-69s_session` in production: `Secure`, `HttpOnly`, `Path=/`, and no `Domain` attribute, so it is locked to the exact API host.

### 3. Rebuild the client if its API URL changed

In Pages, **Deployments** → **Retry deployment** on the latest build, or push a commit. Skip this only if `VITE_SERVER_URL` was already correct at build time.

### 4. Note on preview deployments

Pages gives every branch and pull request its own hostname, and none of them are in `WEB_ORIGIN`, so previews will fail CORS against production. Either add specific preview origins to the list, or point a second Railway environment at them.

## Production smoke test

Two browser profiles are enough to exercise rooms end to end.

- [ ] **Health responds.** `curl https://<api>/api/health` returns `{"status":"ok","service":"69-seconds-server"}`.
- [ ] **Registration sets a production cookie.** In DevTools → Network, the `Set-Cookie` on `/api/auth/register` reads `__Host-69s_session` with `Secure`, `HttpOnly` and your chosen `SameSite`.
- [ ] **The session survives a reload.** Hard-refresh the app: `GET /api/auth/me` returns 200, not 401. A 401 here is the third-party cookie problem, not a bug.
- [ ] **Rows land in Railway MySQL.** Open the MySQL service's Data tab — `users`, `sessions` and `__drizzle_migrations` exist, and your test account is in `users` with an Argon2id `password_hash`.
- [ ] **Timestamps are UTC.** `SELECT created_at FROM users` matches the wall-clock UTC time of the signup, not a local-time offset.
- [ ] **Rooms work across two clients.** Create a room in profile A, join the six-character code in profile B, both mark ready, and the host can start. This proves the Socket.IO handshake is reading the cookie.
- [ ] **Deep links load.** `https://<app>/room/join` opens the join view directly instead of a 404.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Browser console: blocked by CORS policy | `WEB_ORIGIN` does not exactly equal the page's origin. Check for a trailing slash, `http` vs `https`, or a `www.` prefix. |
| Login succeeds, then a refresh logs you out | The session cookie is being dropped as a third-party cookie. Move both apps onto subdomains of one domain and switch `COOKIE_SAME_SITE` back to `lax`. |
| Socket connects then errors `UNAUTHENTICATED` | Same cause — the handshake carries no cookie. The HTTP API failing the same way confirms it. |
| Build fails: `EBUSY: resource busy or locked, rmdir '/app/apps/web/node_modules/.vite'` | `npm ci` is trying to delete a Nixpacks cache mount. Use `npm install --include=dev` in the Build Command instead. Setting `NIXPACKS_NO_CACHE=1` also works but slows every build. |
| Build fails: `tsc: not found` or `sh: 1: tsc: not found` | `NODE_ENV=production` made npm skip devDependencies. Add `--include=dev` to the install in the Build Command. |
| Pre-deploy fails: `drizzle-kit: not found` | Same cause — devDependencies were pruned. Add `--include=dev` to the Build Command. Failing that, run migrations from your machine against the public URL and clear the Pre-Deploy Command: `DATABASE_URL="<MYSQL_PUBLIC_URL>" npm run db:migrate` |
| Server exits at boot: `DATABASE_URL is required` | The reference variable did not resolve. Confirm the MySQL service's name matches what you typed inside `${{ }}`. |
| `ECONNREFUSED` or DNS failure to `*.railway.internal` | Private networking is only reachable from services in the same project and environment. If you are running migrations locally, you need `MYSQL_PUBLIC_URL`. |
| Rooms disappear for everyone at once | Expected. Rooms are in-memory and every redeploy clears them. If it happens without a deploy, check that replicas is still 1. |
| Pages build fails on `engines` | `NODE_VERSION` is unset or too low. Set it to `22` in the Pages environment variables and retry the deployment. |
| Registering an existing email or username returns 500, not 409 | The duplicate-key path is matched on MySQL's `ER_DUP_ENTRY`. A 500 means a different driver is in play — verify the deploy built the current `mysql2` code. |

## Appendix — running MySQL locally

The same schema and migrations back local development, so a bug reproduces the same way in both places.

```bash
docker compose up -d db

# one-time: the integration suite refuses any database whose
# name does not contain "test"
docker compose exec db mysql -uroot -pmysql \
  -e "CREATE DATABASE IF NOT EXISTS sixtynine_seconds_test"

cp apps/server/.env.example apps/server/.env
cp apps/web/.env.example apps/web/.env
npm run db:migrate
npm run dev
```

To run the MySQL-backed auth tests, which are skipped when the variable is absent:

```bash
TEST_DATABASE_URL="mysql://root:mysql@localhost:3306/sixtynine_seconds_test" \
  npm run test:integration -w @69-seconds/server
```

After any intentional change to `apps/server/src/db/schema.ts`, generate and commit a migration rather than editing the SQL by hand:

```bash
npm run db:generate
```

---

Every claim about environment variables here reflects the validation in [`apps/server/src/config.ts`](../apps/server/src/config.ts), which fails fast at boot on anything it does not accept.
