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
- Playwright specs: `tests/e2e/**/*.spec.ts`.

Rule traceability (`pnpm test:rules`, tech-stack.md §11 T1):

- A test covers rule `X` when the title of the `test(...)`/`it(...)` call itself starts with `X:` (e.g. `test("R7: status change cancels pending rejection email", ...)`). IDs match exactly (`AU2:` is not `A2:`), one per test. Titles on `describe(...)` and skipped, todo, fixme or failing tests don't count.
- Required IDs that have no test yet are listed in `tests/rules-pending.json`. Every task that adds the first test for an ID removes that ID from the list in the same change; the scan fails if a pending ID already has a test, if a required ID is neither tested nor pending, or if a title starts with an unknown rule-shaped ID.
- Pull requests run the same checks in `.github/workflows/ci.yml`: `pnpm verify`, then `pnpm db:migrate` and `pnpm test:integration` against a `postgres:17` service container, then `pnpm build`.

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
