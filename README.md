# ats-app

Custom ATS & career portal. Specs live in `_docs/` (start with `ats-project-scope.md` and `tech-stack.md`).

## Development

Requires Node.js 24 and pnpm (the version pinned in `package.json` `packageManager`; `corepack enable` picks it up).

```sh
pnpm install   # install dependencies (fails on a Node version other than 24)
pnpm dev       # start the dev server on http://localhost:3000
pnpm verify    # lint, typecheck, Vitest unit tests and the rule-ID scan (no build)
pnpm test:rules # rule-ID scan only
pnpm build     # production build (.next/standalone)
```

Database (PostgreSQL 17 from the Compose stack, see below):

```sh
docker compose up -d postgres   # start PostgreSQL on localhost:5432
pnpm db:migrate                 # apply the committed migrations (reads .env if present)
pnpm db:generate                # generate a migration after a schema change
pnpm test:integration           # Vitest integration tests against PostgreSQL
```

- The Drizzle schema in `src/server/db/schema/` is the source of truth for the data model (tech-stack.md D1). To change it: edit the schema, run `pnpm db:generate` (optionally `--name=<what_changed>`), review the SQL in `src/server/db/migrations/` and commit it together with the schema change. On a clean checkout `pnpm db:generate` must report no changes. `drizzle-kit push` is allowed only on a local database (D2).
- `pnpm db:migrate` bundles `src/server/db/migrate.ts` into `dist/db/migrate.mjs` (with the SQL next to it in `dist/db/migrations/`) and runs it with drizzle-orm's runtime migrator, not drizzle-kit. The production image contains the same bundle (see "Local stack"). It uses `DATABASE_ADMIN_URL` when set, otherwise `DATABASE_URL`, and needs a complete configuration (`getConfig()`).
- `pnpm db:migrate` also creates or updates the pg-boss schema (`pgboss`) and the four job queues from tech-stack.md §5 with `ensureJobQueues()` (J5). Changing a queue's retry options in `src/server/adapters/job-queue/queues.ts` takes effect on the next migrate; changing a queue's policy makes it fail, because pg-boss can't change a policy.
- Background jobs: domain code uses `jobQueue.enqueue(tx, queue, data)` and `jobQueue.cancel(tx, queue, jobId)` from `src/server/adapters/job-queue`, always inside the business transaction, so a rollback also undoes the job (J1, J2). Job data holds IDs only (J4). Only `src/server/adapters/**` may import `pg-boss` (ESLint). pg-boss runs on the same `pg.Pool` as Drizzle (D5).
- Job handlers live in `src/worker/` (W2): `handlers.ts` maps a queue to its handler, and every handler runs in one wrapper that logs `job started`, `job completed` and `job failed` with `job_id` and `queue`, never the payload (M3). The web process starts pg-boss in `src/instrumentation.ts` (never during `next build`) and registers the handlers only when `WORKER_ENABLED=true` (W1); otherwise it logs `worker disabled`. A missing variable or an unreachable PostgreSQL stops start-up with exit code 1. `pnpm worker` runs the handlers standalone, without Next.js, and always registers them, whatever `WORKER_ENABLED` says. It isn't deployed (tech-stack.md §3 rule 8).
- Graceful shutdown (W6): on SIGTERM or SIGINT both processes stop fetching, wait up to 8 s for active jobs, stop pg-boss, close the pool, log `worker stopped` and exit 0. pg-boss fails jobs still running at the deadline, so they are retried. The image sets `NEXT_MANUAL_SIG_HANDLE=true` so that Next.js leaves the signal to the app; under `pnpm dev` Next.js still exits on the signal itself.
- The hourly tick (W4, W5): `POST /api/internal/tick` with header `x-tick-secret` queues each daily task that is due (`retention.purge` from 02:00, `approvals.remind` from 08:00 Europe/Warsaw) and has no `job_runs` row for today's Warsaw date, then waits up to 180 s until no due job remains. Locally, against the Compose stack: `curl -s -X POST -H "x-tick-secret: <TICK_SECRET from docker-compose.yml>" localhost:3000/api/internal/tick`. A second call the same day returns `"queued": []`. With `WORKER_ENABLED` off it queues without waiting (`"waited": false`). The daily task handlers are stubs until tasks 31 and 40.
- Test clock (T3): with `AUTH_DEV_LOGIN=true`, a tick may send `x-test-now: <ISO 8601 with Z or an offset>`. That time drives the due check, the run date and the `now` handlers get, and delayed jobs due by then run at once. Without dev login the header is ignored. `processDueJobs({ now })` does the same in tests. Each time-travel test uses its own date, because a `job_runs` row blocks later runs on that date.
- Tests process due jobs synchronously with `processDueJobs()` from `tests/support/process-due-jobs.ts` (J7), never by waiting for a worker (W9). Tests create their own test-only queues with `tests/support/jobs.ts`.
- Server code gets the database with `getDb()` and runs multi-step changes in `withTransaction(async (tx) => ...)` from `src/server/db`; domain services take the `Tx` handle as their first parameter (D3). The pool (max 10 connections) is created on the first call, and TLS follows `sslmode` in `DATABASE_URL`: none without it (Compose), verified TLS with `sslmode=require` (Azure).

Test files:

- Vitest unit tests: `tests/**/*.test.ts(x)`, run by `pnpm test` (excludes `tests/e2e/**` and `tests/integration/**`). They need no database, so `pnpm verify` works with Docker stopped.
- Vitest integration tests: `tests/integration/**/*.test.ts`, run only by `pnpm test:integration` against the Compose PostgreSQL (never mocks, D9). A global setup drops the `ats_test_*` databases of earlier runs and migrates `ats_test_template`; each Vitest worker then works in its own clone, `ats_test_<worker id>` (T2). The setup refuses any `DATABASE_URL` host other than `localhost`, `127.0.0.1` or `postgres`, and `APP_ENV=azure`. It defaults to the Compose credentials when `DATABASE_URL` is unset. Run a single file with `pnpm test:integration tests/integration/<file>`.
- Playwright specs: `tests/e2e/**/*.spec.ts`, run by `pnpm test:e2e` against a running app at `E2E_BASE_URL` (default `http://localhost:3000`, the Compose stack): start it with `docker compose up --build -d` and migrate it first (see "Local stack"). Chromium only; one retry when `CI` is set; trace, video and screenshot are kept on failure in `test-results/`. See "Sign-in and end-to-end tests" below.

Rule traceability (`pnpm test:rules`, tech-stack.md §11 T1):

- A test covers rule `X` when the title of the `test(...)`/`it(...)` call itself starts with `X:` (e.g. `test("R7: status change cancels pending rejection email", ...)`). IDs match exactly (`AU2:` is not `A2:`), one per test. Titles on `describe(...)` and skipped, todo, fixme or failing tests don't count.
- Required IDs that have no test yet are listed in `tests/rules-pending.json`. Every task that adds the first test for an ID removes that ID from the list in the same change; the scan fails if a pending ID already has a test, if a required ID is neither tested nor pending, or if a title starts with an unknown rule-shaped ID.
- Pull requests run the same checks in `.github/workflows/ci.yml`: `pnpm verify`, then `pnpm db:migrate` and `pnpm test:integration` against a `postgres:17` service container, then `pnpm build`.

## Sign-in and end-to-end tests

- Staff sign in at `/sign-in`. Locally and in CI (`AUTH_DEV_LOGIN=true`) the page shows an email and password form (dev sign-in, AU7); sign-up is always disabled, so dev users are created with `ensureDevUser()` from `src/server/auth/dev-users.ts` (the Playwright setup, and the demo seed from task 17). Without dev login the form isn't shown. When the three `MICROSOFT_*` variables are set, the page also shows "Sign in with Microsoft" (see below). A refused sign-in returns to `/sign-in?error=<code>`; the page shows "Access not granted, contact your ATS admin." or a generic failure text, never the code itself.
- Sessions are database rows (`session` table) with an 8 h sliding expiry and a Secure, HTTP-only, SameSite=Lax cookie, even on `http://localhost` (AU6). Server code gets the signed-in user with `getCurrentUser()` from `src/server/auth/current-user.ts`, which reloads the role and active flag on every request (AU5); protected route handlers use `requireApiUser(request)`, which returns a 401 response when signed out.
- `src/proxy.ts` only checks that the session cookie is present. Paths outside its public list (`PUBLIC_PATHS`) redirect to `/sign-in?next=…` (pages) or return 401 JSON (`/api/**`). `/api/internal/tick` is public because it has its own secret.
- `pnpm test:e2e` runs two Playwright invocations: the `parallel` project, then the `time-travel` project, and fails if either failed. Both depend on the `setup` project, which makes sure four users exist — `e2e-admin@example.com`, `e2e-recruiter@example.com`, `e2e-hiring-manager@example.com` and `e2e-interviewer@example.com` — gives each a fresh random password (never stored), signs them in and saves the state to `tests/e2e/.auth/<role>.json` (gitignored). Specs open a signed-in page with the `asRole(role)` fixture from `tests/e2e/support/fixtures.ts`. Specs that change a user's role or active flag create their own throwaway `e2e-<uuid>@example.com` user and never touch the four shared ones.
- Playwright reads the database connection and `TICK_SECRET` from the `app` service in `docker-compose.yml` (with the PostgreSQL host changed to `localhost`); `E2E_DATABASE_URL` and `E2E_TICK_SECRET` override them.
- Time-travel rules (T2): specs that send `x-test-now` or depend on daily tasks live in `tests/e2e/time-travel/` and run alone, one at a time, after the parallel specs, because the clock shift and the daily tasks act on the whole shared database. Every time-travel spec uses a `TEST_NOW` date no other spec uses, or asserts only on data it created, and must pass when rerun against the same database. A unit test in `pnpm verify` fails if any file under `tests/e2e/` outside that folder contains `x-test-now` (any letter case) or imports from it.

## Microsoft Entra sign-in (owner setup)

Staff sign in with accounts from the project's own Entra tenant (tech-stack.md §4, AU1–AU4). Sign-in is invite-only: an Entra account gets in only if an Admin created an **active** ATS user with the same email first (task 12's `pnpm seed:admin` for the first Admin, the Admin user pages from task 15 after that). Anyone else sees "Access not granted, contact your ATS admin." and no user is created. On the first sign-in the Entra account is linked to that user; later sign-ins match the Entra object ID, so a renamed UPN still signs in the same user. Sign-in never changes the ATS user's name, email or role, and no profile photo is fetched.

One-time setup in the Entra admin center (Microsoft Entra ID → App registrations), done by the owner:

1. **New registration**, supported account types: *Accounts in this organizational directory only* (single tenant). Never multi-tenant: the app refuses a tenant ID that isn't a GUID (`common`, `organizations`, `consumers`).
2. **Authentication → Web** redirect URIs:
   - `http://localhost:3000/api/auth/callback/microsoft` (local)
   - `https://<Azure app address>/api/auth/callback/microsoft` (update it if the host name changes after a rebuild, G6)
3. **Certificates & secrets → New client secret.** Store the value in Key Vault as the `MICROSOFT_CLIENT_SECRET` secret (wired in by task 44) and set a calendar reminder before it expires; sign-in stops working when it does.
4. **Token configuration → Add optional claim → ID → `email`.** Users without a mailbox have no `email` claim; the app then uses their UPN (`preferred_username`).
5. **Demo users:** create `admin@`, `recruiter@`, `hm@` and `interviewer@<tenant>.onmicrosoft.com` in Entra, and the same emails as ATS users with the matching roles (demo seed, task 17).
6. Note the **Application (client) ID** and the **Directory (tenant) ID** from the app's overview page.

To try it locally, set all three in `.env` (set together or not at all; a partial set stops the app at start) and restart `pnpm dev`:

```sh
MICROSOFT_CLIENT_ID=<Application (client) ID>
MICROSOFT_TENANT_ID=<Directory (tenant) ID, a GUID>
MICROSOFT_CLIENT_SECRET=<client secret value>
```

The account you sign in with must already exist as an active ATS user. CI has no Entra credentials (G3): the automated tests mock Microsoft's token endpoint, and the real sign-in in Azure is checked by hand during deployment (Sprint 0 proof #6, task 45).

## Local stack (Docker Compose)

Requires Docker with Compose v2 (`docker compose`). `docker-compose.yml` starts the production image of the app (the same image CI and Azure use) with `postgres:17`, Azurite and Mailpit. It works on a fresh clone without `.env`: the file holds obviously fake, local-only values that must never be used in Azure.

```sh
docker compose up --build -d   # build the image and start all four services
docker compose logs -f app     # follow the app's logs
docker compose down            # stop and remove the containers (data is kept)
docker compose down -v         # also delete the PostgreSQL and Azurite data
```

| Service | Address (bound to `127.0.0.1`) |
|---|---|
| App | http://localhost:3000 |
| PostgreSQL 17 | `postgres://ats:local-only-not-secret-postgres@localhost:5432/ats` |
| Azurite Blob | http://localhost:10000/devstoreaccount1 |
| Mailpit SMTP / web UI | `localhost:1025` / http://localhost:8025 |

The `app` container runs like CI: `NODE_ENV=production`, `APP_ENV=ci`, `AUTH_DEV_LOGIN=true` (dev sign-in) and `EMAIL_PROVIDER=smtp` (Mailpit). Inside the stack it uses Compose host names (`postgres`, `azurite`, `mailpit`); signed Blob links for the browser use `AZURE_STORAGE_PUBLIC_URL=http://localhost:10000/devstoreaccount1`. The app doesn't migrate the database on start. Apply the migrations from the same image (the Azure `db-migrate` job runs the same command):

```sh
docker compose run --rm app node db/migrate.mjs
```

A second run applies nothing. The image holds the bundled entry point and the SQL in `/app/db`, with no pnpm, tsx or drizzle-kit.

`pnpm dev` on the host is the alternative for day-to-day work: it reads `.env` (copied from `.env.example`) with `localhost` host names and `APP_ENV=local`, and can use the Compose services without the app container:

```sh
docker compose up -d postgres azurite mailpit
pnpm dev
```

## Configuration

All configuration goes through `getConfig()` in `src/server/config.ts` (tech-stack.md §3 rule 5). It validates every variable with Zod on the first call (never at import time, so `pnpm build` needs no secrets) and caches the result. Errors name the missing or invalid variables, never their values. An empty value (`KEY=`) counts as missing.

Copy `.env.example` to `.env` and fill the empty values you need. `.env` is git-ignored; never commit it. Secrets stay empty in `.env.example`, including publicly documented dev values. Where they come from:

- `DATABASE_URL`: the Compose PostgreSQL, `postgres://ats:local-only-not-secret-postgres@localhost:5432/ats`.
- `BETTER_AUTH_SECRET`, `EMAIL_HASH_KEY`, `TICK_SECRET`: any random local value, e.g. `openssl rand -base64 32`.
- `AZURE_STORAGE_CONNECTION_STRING`: Azurite's [default development connection string](https://learn.microsoft.com/azure/storage/common/storage-use-azurite#http-connection-strings).
- `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`: Cloudflare's [Turnstile test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/).
- `DEMO_USER_PASSWORD`: any local password of at least 12 characters.
- `MICROSOFT_*`: leave all three empty locally unless you test Entra sign-in; they are set together or not at all, and the tenant ID must be a GUID.

Refused combinations: `AUTH_DEV_LOGIN=true` with `APP_ENV=azure` or `EMAIL_PROVIDER=outbox` (AU7), and `APP_ENV=azure` without `EMAIL_PROVIDER=outbox` (§3 rule 10). `NODE_ENV` plays no part in these checks.

## Logging

`src/server/logger.ts` writes pino JSON lines to stdout (M1). It reads only `LOG_LEVEL` (default `info`), so it works even when the configuration is invalid. Log identifiers only, never personal data (M2); the `redact` paths are a safety net. In server code, use `getRequestLogger()` from `src/server/request-id.ts` to bind the request's `request_id`, which `src/proxy.ts` generates for every request and returns in `x-request-id` (M3). Unhandled errors are logged by `onRequestError` in `src/instrumentation.ts` (M4).

For readable output locally, pipe it through pino-pretty: `pnpm dev | pnpm dlx pino-pretty`.
