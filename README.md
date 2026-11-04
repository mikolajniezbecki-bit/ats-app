# ats-app

**New here? Read the [User Manual](user_manual.md):** a plain-language guide for HR testers and business evaluators.

## DataTalks.Club :: AI Dev Tools Zoomcamp 2026 — Capstone Project

> **Peer reviewers:** this section is your guide to the project, and [section 5](#5-how-peer-reviewers-can-evaluate-the-app) shows how to try it. Everything below it is the project's operational runbook.

### 1. Problem Statement & Project Goal

**The problem.** Enterprise recruiting systems are heavy, expensive and complex to maintain, which is too much for a focused hiring workflow.

**The solution.** A lightweight, production-grade, GDPR-aware Applicant Tracking System (ATS) and public Career Portal. It runs on Azure Container Apps with scale-to-zero and near-zero idle cost, within the project's constraints (`C1–C4`): built by one person, self-funded, synthetic data only, and no real email delivery.

**Core capabilities:**

- **Public Career Portal:** the `/jobs` board and Quick Apply with CV upload, protected by Cloudflare Turnstile.
- **Requisitions and approvals:** the full requisition lifecycle, with single-step approvals, segregation of duties, reassignment and reminders.
- **Recruiter Workbench:** pipeline list, inline CV preview, interview scheduling with `.ics` invites, scorecards, offer PDF generation and an internal email Outbox.
- **Admin and GDPR governance:** the retention purge, an audit trail of approvals and requisition changes, master data, and a KPI dashboard.

### 2. AI-Assisted Development & Multi-Agent Workflow

The application was built end to end across 46 tasks with **Claude Code**, using a spec-driven, multi-agent setup.

**Specifications (`_docs/`)** are the source of truth:

- `ats-project-scope.md`: business rules and domain constraints.
- `tech-stack.md`: architecture, security and testing rules.

**Sub-agents (`.claude/agents/`)** each have one role:

| Agent | Role |
|---|---|
| `pm` | Grooms each task from `_docs/tasks.md` into a GitHub Issue with checkable acceptance criteria |
| `software-engineer` | Implements one groomed task with its tests, within the layer boundaries and using rule-tagged test titles |
| `reviewer` | Independently audits the PR against the acceptance criteria, verifies test integrity (`T8`), merges to `main` and cleans up the environment |

**Automated rule coverage (`T1`).** Business and technical rules have IDs such as `R7` or `AU2`. Every required rule needs a test whose title starts with its ID, for example `R7: status change cancels pending rejection email`. `pnpm test:rules` scans the test files and fails, naming the rule, if any of the 102 required IDs has no running test. It runs in CI as part of `pnpm verify`, and `pnpm test:rules --report` lists the test files for each rule.

### 3. Architecture & Tech Stack

| Layer | Technology |
|---|---|
| Web framework | Next.js 16 (App Router, Server Actions), TypeScript |
| Database and ORM | PostgreSQL 17, Drizzle ORM |
| Authentication | Better Auth: Microsoft Entra ID in the cloud, dev credentials locally |
| Background jobs | pg-boss, with an hourly tick |
| UI | Tailwind CSS, `shadcn/ui` |
| Hosting | Azure Container Apps |
| Managed database | Azure Database for PostgreSQL Flexible Server (B1MS) |
| Files | Azure Blob Storage |
| Secrets | Azure Key Vault |
| Logging | Log Analytics |
| Infrastructure as code | Bicep |

### 4. Verification, Testing & Passwordless CI/CD

**Test layers:**

- **Vitest unit tests**, which need no services.
- **Vitest integration tests** against real PostgreSQL and Azurite.
- **Playwright end-to-end tests**, including a full journey for each of the four roles.
- **`@axe-core/playwright`** WCAG 2.1 AA accessibility checks.
- **`pnpm verify`**, which runs lint, type checks, unit tests and the rule scan.

**GitHub Actions pipelines:**

| Workflow | Purpose |
|---|---|
| `ci.yml` | The PR gate |
| `main.yml` | Full verification, GHCR image publishing and automated Azure rollout |
| `infra.yml` | Two-stage Bicep `what-if` / `deploy` |

Azure access uses passwordless GitHub OIDC federated credentials, so no Azure secrets are stored in GitHub.

### 5. How Peer Reviewers Can Evaluate the App

#### Option A — Live Azure Cloud Deployment

**Career Portal:** https://ats-web-3brhgxoyatsve.politemushroom-7e0cd08d.polandcentral.azurecontainerapps.io/jobs

- Browse the jobs and submit an application through the Cloudflare Turnstile check.
- **Use made-up data only** (`C3`), for example "Test Person" and `test@example.com`, with a small sample PDF.
- The app scales to zero, so the first page can take up to a minute to load.

The cloud Back Office (`/sign-in`) is locked to a single-tenant Microsoft Entra ID directory by security design (`AU1–AU5`). To try the staff roles, use Option B.

#### Option B — 2-Minute Local Quickstart (Full Back-Office Access for Reviewers)

Requires Docker with Compose v2. No Node.js or Azure account is needed.

> The first run also has to build the app image, which takes several minutes on top. The build needs plenty of free memory: on an 8 GB machine it can stop with exit code 143. If it does, close other applications and run it again.

```sh
git clone https://github.com/mikolajniezbecki-bit/ats-app.git
cd ats-app
docker compose up --build -d                    # Postgres, Azurite, Mailpit and the app
docker compose run --rm app node db/migrate.mjs  # database migrations
docker compose run --rm app node db/seed.mjs     # demo users and the rich demo data
```

Then open http://localhost:3000/sign-in. To start again from an empty database, run `docker compose down -v`.

**Demo accounts** (local only, password `local-only-not-secret-demo` for all four):

| Role | Email |
|---|---|
| Admin | `admin@ats-demo.local` |
| Recruiter | `recruiter@ats-demo.local` |
| Hiring Manager | `hm@ats-demo.local` |
| Interviewer | `interviewer@ats-demo.local` |

**Key routes:**

| Route | What to look at |
|---|---|
| `/sign-in` | Staff sign-in |
| `/requisitions` | Requisitions, and from there their applications |
| `/approvals` | Pending approvals (Hiring Manager, Admin) |
| `/reports` | KPI dashboard (Recruiter, Admin) |
| `/admin` | Settings, master data, users, templates, Outbox and jobs (Admin) |
| `/jobs` | The public Career Portal |
| http://localhost:8025 | Mailpit: the emails the app sends locally |

---

Custom ATS & career portal. Specs live in `_docs/` (start with `ats-project-scope.md` and `tech-stack.md`).

## Development

Requires Node.js 24 and pnpm (the version pinned in `package.json` `packageManager`; `corepack enable` picks it up).

In GitHub Codespaces (or VS Code Dev Containers), `.devcontainer/devcontainer.json` provides a slim Node 24 image with Docker-in-Docker, the GitHub CLI and Git LFS (the clone's Git hooks need it). Its first start runs `pnpm install`, installs Playwright's Chromium with its system libraries, and installs Claude Code. Every start also adds a firewall rule that lets the Compose containers reach each other.

```sh
pnpm install   # install dependencies (fails on a Node version other than 24)
pnpm dev       # start the dev server on http://localhost:3000
pnpm verify    # lint, typecheck, Vitest unit tests and the rule-ID scan (no build)
pnpm test:rules # rule-ID scan only
pnpm build     # production build (.next/standalone)
```

Database (PostgreSQL 17 from the Compose stack, see below):

```sh
docker compose up -d postgres azurite mailpit   # PostgreSQL :5432, Azurite :10000, Mailpit :1025/:8025
pnpm db:migrate                 # apply the committed migrations (reads .env if present)
pnpm db:generate                # generate a migration after a schema change
pnpm test:integration           # Vitest integration tests against PostgreSQL, Azurite and Mailpit
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

The role journeys are in `tests/e2e/journeys/`, one spec per role (Recruiter, Hiring Manager, Interviewer, Admin). They run with the other Playwright specs; the purge journey is in `tests/e2e/time-travel/retention-purge.spec.ts`.

Rule traceability (`pnpm test:rules`, tech-stack.md §11 T1):

- A test covers rule `X` when the title of the `test(...)`/`it(...)` call itself starts with `X:` (e.g. `test("R7: status change cancels pending rejection email", ...)`). IDs match exactly (`AU2:` is not `A2:`), one per test. Titles on `describe(...)` and skipped, todo, fixme or failing tests don't count.
- The scan fails, naming the IDs, if a required ID has no test or a title starts with an unknown rule-shaped ID. There are no exceptions.
- `pnpm test:rules --report` also lists each required ID with the files of its tests. The scan proves that a title exists, not that the test is meaningful, so use the list to review coverage.
- Pull requests run the same checks in `.github/workflows/ci.yml`: `pnpm verify`, then `pnpm db:migrate` and `pnpm test:integration` against a `postgres:17` service container, then `pnpm build`.

## Sign-in and end-to-end tests

- Staff sign in at `/sign-in`. Locally and in CI (`AUTH_DEV_LOGIN=true`) the page shows an email and password form (dev sign-in, AU7); sign-up is always disabled, so dev users are created with `ensureDevUser()` from `src/server/auth/dev-users.ts` (the Playwright setup, and the demo seed from task 17). Without dev login the form isn't shown. When the three `MICROSOFT_*` variables are set, the page also shows "Sign in with Microsoft" (see below). A refused sign-in returns to `/sign-in?error=<code>`; the page shows "Access not granted, contact your ATS admin." or a generic failure text, never the code itself.
- Sessions are database rows (`session` table) with an 8 h sliding expiry and a Secure, HTTP-only, SameSite=Lax cookie, even on `http://localhost` (AU6). Server code gets the signed-in user with `getCurrentUser()` from `src/server/auth/current-user.ts`, which reloads the role and active flag on every request (AU5); protected route handlers use `requireApiUser(request)`, which returns a 401 response when signed out.
- `src/proxy.ts` only checks that the session cookie is present. Paths outside its public list (`PUBLIC_PATHS`) redirect to `/sign-in?next=…` (pages) or return 401 JSON (`/api/**`). `/api/internal/tick` is public because it has its own secret.
- `pnpm test:e2e` runs two Playwright invocations: the `parallel` project, then the `time-travel` project, and fails if either failed. Both depend on the `setup` project, which makes sure four users exist — `e2e-admin@example.com`, `e2e-recruiter@example.com`, `e2e-hiring-manager@example.com` and `e2e-interviewer@example.com` — gives each a fresh random password (never stored), signs them in and saves the state to `tests/e2e/.auth/<role>.json` (gitignored). Specs open a signed-in page with the `asRole(role)` fixture from `tests/e2e/support/fixtures.ts`. Specs that change a user's role or active flag create their own throwaway `e2e-<uuid>@example.com` user and never touch the four shared ones.
- Playwright reads the database connection and `TICK_SECRET` from the `app` service in `docker-compose.yml` (with the PostgreSQL host changed to `localhost`); `E2E_DATABASE_URL` and `E2E_TICK_SECRET` override them.
- Time-travel rules (T2): specs that send `x-test-now` or depend on daily tasks live in `tests/e2e/time-travel/` and run alone, one at a time, after the parallel specs, because the clock shift and the daily tasks act on the whole shared database. Every time-travel spec uses a `TEST_NOW` date no other spec uses, or asserts only on data it created, and must pass when rerun against the same database. A unit test in `pnpm verify` fails if any file under `tests/e2e/` outside that folder contains `x-test-now` (any letter case) or imports from it.

## Authorization and the back office

- Every permission check goes through the policy module in `src/server/policy/` (ats-project-scope.md V9, tech-stack.md AU9). `permissions.ts` holds the action catalogue and the role matrix in one place: `can(user, action, resource?)` is `false` for no user, an inactive user or an unknown action. Later tasks add their actions and resource rules there.
- Row-level visibility uses the filters in `filters.ts` (`scopeRequisitionsFor(user)`, `scopeApplicationsFor`, `scopeScorecardsFor`, `scopeOffersFor`) inside the query's `WHERE`, never ad-hoc conditions in a handler (D6). Admin and Recruiter see everything (V1, V2). Roles whose rule isn't implemented yet see no rows.
- Guards in `guards.ts`:
  - `requireUser()` for pages: redirects to sign-in.
  - `requirePermission(action)` for pages: renders `src/app/forbidden.tsx` with HTTP 403 (Next.js `forbidden()`, `experimental.authInterrupts`).
  - `withPermission(action, handler)` for route handlers: 401 `{"error":"unauthorized"}` / 403 `{"error":"forbidden"}`.
  - `authorizeAction(action)` for server actions: throws `ForbiddenError`.
- A unit test fails if a `src/app/api/**/route.ts` is neither on `proxy.ts`'s public list nor guarded.
- Staff pages live in the `src/app/(staff)/` route group. Its layout requires a signed-in user and shows the header: the app name, the navigation, the user's name and role, and sign-out. Navigation items are listed in `src/components/staff-shell/nav-items.ts` as `{ href, labelKey, action }` and shown only when `can()` allows the action. `/admin` is the Admin overview.

### First Admin (`pnpm seed:admin`)

```sh
pnpm seed:admin --email <upn> [--name "<name>"]
```

Creates an active Admin with `email_verified = true` and no password. The name defaults to the email's local part. If a user with that email exists, it is promoted to Admin and reactivated instead (the way back in when no active Admin is left). An existing active Admin is left unchanged.
- Each change writes `ADMIN_SEEDED` to `audit_log`.
- It prints `created|updated|unchanged <user id>` and never the email (M2).
- A missing or invalid `--email` prints the usage and exits 1.
- Concurrent runs are safe.

It reads `.env` like `pnpm db:migrate`. In Azure it runs through the `db-seed` job with `SEED_ADMIN_EMAIL` (tasks 17 and 44).

## Files, health and security headers

**Storage** (tech-stack.md §8). `StorageService` in `src/server/adapters/storage/` is the only code that imports `@azure/storage-blob` and `@azure/identity` (ESLint enforces it). Blobs live in the private container `files` under random UUID keys with no extension; the original file name is stored only in the `files` table. The mode follows the configuration:

| Mode | When | Signed links |
|---|---|---|
| Azurite | `AZURE_STORAGE_CONNECTION_STRING` is set (Compose, CI, `pnpm dev`) | Account-key SAS. The app creates the `files` container at start-up (and the integration-test setup does too) if it's missing. Links use `AZURE_STORAGE_PUBLIC_URL` when set (`http://localhost:10000/devstoreaccount1` in Compose, because the browser can't resolve `azurite`), otherwise the connection string's endpoint. |
| Azure | otherwise: `AZURE_STORAGE_ACCOUNT_URL` + `AZURE_CLIENT_ID` | Managed identity (`DefaultAzureCredential`) and a user delegation key, cached until 5 minutes before it expires; HTTPS only. Bicep creates the container. |

- Every signed link is for one blob, read-only, with no start time, expires after 5 minutes and sets `Content-Type: application/pdf` and `Content-Disposition: inline` (F5, V11). PDFs are never streamed through the app. Signed URLs and original file names are never logged (`url`, `signedUrl`, `originalName` and `original_name` are redacted).
- Uploads go through `storePdf(tx, …)` in `src/server/files/`: it validates the file with `validatePdfUpload()` (empty, larger than `MAX_UPLOAD_MB` MiB, no `%PDF-` at byte 0, encrypted including permissions-only, or unparsable: refused; the name and the browser's MIME type are ignored), uploads it, and inserts the `files` row in `tx`. If the transaction rolls back, the blob is deleted again (`onRollback()` in `src/server/db`).
- Staff view a PDF at `/files/<id>` (the `PdfViewer` server component) or get a link from `GET /api/files/<id>/url` (`{ url, expiresAt }`, `Cache-Control: no-store`). Both check `can(user, 'file.view', file)`: Admins and Recruiters for now. No session gives 401, other roles 403, and an unknown, deleted or non-`CLEAN` file 404.
- Settings are read with `getSetting(key)` from `src/server/settings/`: typed per key, the ats-project-scope.md §5.1 default when no row exists or the stored value doesn't parse, and no cache.

**Health** (M5). `GET /api/health` is public and checks the database (`select 1`) and storage (the `files` container exists) concurrently, each with a 3 s timeout. It returns `200 {"status":"ok","database":"ok","storage":"ok"}`, or `503` with the failed part set to `"fail"`, always with `Cache-Control: no-store` and never with host names or error text. Against the Compose stack: `curl -s localhost:3000/api/health`; after `docker compose stop azurite` it returns 503 within about 3 s.

**Security headers** (§3 rule 6, F5). `src/proxy.ts` sets, at run time, a Content Security Policy with a fresh nonce on every HTML page response:

```
default-src 'self'; script-src 'self' 'nonce-<n>' 'strict-dynamic'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src <blob origin>; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

`'unsafe-eval'` is added only under `next dev`. `<blob origin>` is the scheme, host and port of the browser-facing Blob endpoint (`http://localhost:10000` in Compose, `http://127.0.0.1:10000` for `pnpm dev`, `https://<account>.blob.core.windows.net` in Azure), never `*`. Next.js reads the nonce from the forwarded request header and puts it on its scripts; this needs pages rendered per request, which they are. Every response also gets `X-Content-Type-Options: nosniff` (static assets through `next.config.ts`). The proxy still makes no authorization decision.

## Settings and master data (Admin)

- `/admin/settings` lists every ats-project-scope.md §5.1 setting with its effective value; "Default" marks a setting with no row, or a seeded row (`updated_by IS NULL`). The form sends only changed values to `PUT /api/admin/settings`, which validates them with one Zod schema (`settingsInputSchema` in `src/server/settings/`, built from `SETTING_DEFINITIONS`) and saves all or nothing. Each changed key writes one `SETTING_CHANGED` audit row with `details_json = {"key": …}` only; unchanged keys write nothing. A changed privacy statement text needs a different version. Settings are read when used and never cached, so delays and reminders apply to work queued after the change. `RETENTION_DAYS` is read only through `getRetentionDays()`.
- `/admin/master-data` manages Departments, Locations, Legal Entities and picklist values (`POST /api/admin/master-data`, `PATCH`/`DELETE /api/admin/master-data/<id>`, in `src/server/master-data/`). Code, type and picklist key are fixed at creation; label and active flag can change. A record that is referenced (by a requisition, or for a picklist value by a requisition's custom field bound to its picklist key) returns 409 on delete and can only be deactivated.
- Pickers call `GET /api/master-data?type=<TYPE>[&picklistKey=<key>]` (Admin, Recruiter, Hiring Manager), which returns active records only as `{ id, code, label }`, sorted by label.
- API error texts come from `messages/en.json` through `message()` in `src/server/messages.ts`.

## User management (Admin)

- `/admin/users` lists users (email, name, role, status) sorted by name, filtered Active / Inactive / All. Admins create users (`POST /api/admin/users`: lower-cased email, name, one role; active, `email_verified = true`, no password — staff sign in with Entra ID, and dev sign-in passwords come only from `ensureDevUser()`), change the role or name (`PATCH /api/admin/users/<id>`; the email can't change), deactivate (`POST …/deactivate`) and reactivate (`POST …/reactivate`). The service is `src/server/users/`.
- Deactivation sets `is_active = false` and deletes all the user's sessions in the same transaction, so they are signed out on their next request (AU5). Other references to the user stay in place. Role changes apply on the user's next request.
- Guards: an Admin can't change their own role or deactivate themselves, and the last active Admin can't be demoted or deactivated (the active Admin rows are locked, so concurrent changes can't both pass). A duplicate email (any case, also an inactive user) returns 409.
- Audit rows hold IDs and roles only: `USER_CREATED` (`role`), `USER_ROLE_CHANGED` (`fromRole`, `toRole`; none for the same role or a name change), `USER_DEACTIVATED` (`sessionsDeleted`), `USER_REACTIVATED`.
- User pickers use `listActiveUsers({ roles })` or `GET /api/users/picker?role=HIRING_MANAGER&role=ADMIN` (Admin, Recruiter, Hiring Manager): active users only, with any of the given roles, as `{ id, name, email, role }`, sorted by name.

## Templates and tokens

- `/admin/templates` (Admin) manages requisition templates (custom fields in `schema_json`), email templates (subject, body, optional trigger status) and offer templates (letter text) through `/api/admin/templates` and `/api/admin/templates/<id>`; the service is `src/server/templates/`. Type and name never change (the seed finds templates by them). A template used by a requisition, offer or email log row can only be deactivated. One active email template per trigger status (E8); `INTERVIEW` and `OFFER` are refused (E9). Once a requisition uses a requisition template, its fields can only grow (labels may change; new fields are optional).
- Bodies are plain text with the P3 markup subset (`#`/`##`, paragraphs, `**bold**`, `*italic*`, `-` lists, line breaks); HTML is shown as text. Tokens are checked on save against their scope: email subjects allow the candidate and requisition tokens, email bodies also `[[LOGO]]`, offer bodies also `[[OFFER_SALARY]]`, `[[OFFER_CURRENCY]]` and `[[START_DATE]]`. Interview tokens are for code-built interview emails only.
- Code loads templates with `resolveTemplate(type, name)` (active only), stage emails with `getStageTemplate(status)`, and pickers with `listActiveTemplates({ type, bulk })` or `GET /api/templates?type=<TYPE>[&bulk=true]` (Admin, Recruiter, Hiring Manager).
- `src/server/domain/tokens/` resolves the 13 `[[TOKEN]]` placeholders in one pass with `resolveTokens(text, values, "html" | "text" | "subject")`: HTML-escaped in HTML, as-is in text, line breaks removed in subjects. An unknown token, an unclosed `[[` or a token without a value is an error, never raw output. `[[LOGO]]` takes the data: URI from `logoDataUri()` (`/public/logo.png`, a placeholder to replace for branding). `format.ts` formats dates (`15 January 2027`), amounts (`85,000.00`) and interview times in the interview's zone with its name.

## Base seed (`db:seed`)

Order in every environment: migrate → seed → first Admin.

```sh
pnpm db:migrate && pnpm db:seed && pnpm seed:admin --email <upn>      # host (reads .env)
docker compose run --rm app node db/migrate.mjs                         # production image
docker compose run --rm app node db/seed.mjs
docker compose run --rm app node db/seed-admin.mjs --email <upn>
```

The image holds the three compiled entry points in `/app/db` (`node db/migrate.mjs`, `node db/seed.mjs`, `node db/seed-admin.mjs --email <upn>`), so the Azure `db-migrate` and `db-seed` jobs run the same commands (task 44).

- **Contents** (`src/server/db/seed/data.ts`, all synthetic): one row per setting with its default and `updated_by = NULL` (shown as "Default"); Departments, Locations, Legal Entities and the `employment_type` and `seniority` picklists; the "Standard requisition" template, the "Application received" (`APPLIED`) and "Application rejected" (`REJECTED`) stage emails, the bulk emails "Application update" and "Interview preparation", and the "Default offer letter"; and four demo users, `admin@`, `recruiter@`, `hm@` and `interviewer@` + `DEMO_USER_DOMAIN` (`ats-demo.local` locally; the `<tenant>.onmicrosoft.com` domain in Azure, so they link to the Entra demo accounts). Then the synthetic demo data below.
- **Synthetic demo data** (`src/server/db/seed/synthetic.ts`, task 42): created **only when the database has no requisition yet**, in the same transaction and under the same advisory lock, so a rerun prints `synthetic: skipped (requisitions exist)` and changes nothing. It holds eight requisitions, one per state (draft, first approval and re-approval awaiting `hm@`, External and Private published, on hold, filled, cancelled), each approved one with three pre-screening questions; about 20 applications covering every status (one candidate on two requisitions, so the duplicate grouping shows), each with a generated CV PDF and some with a cover letter; interviews (upcoming, past and awaiting outcome, completed with scorecards; `interviewer@` has one to fill); and offers (a draft, one awaiting `hm@`, one sent and awaiting the candidate, and the hires' accepted ones with rendered offer letters). Everything is obviously fictitious: last names like `Sample` or `Placeholder`, `example.com/.org/.net` emails, `+00` phone numbers, and every PDF says "Synthetic demo data, not a real person". Dates are within the last 60 days, so the default 180-day retention keeps them. It queues no emails or jobs. The files are uploaded before the transaction commits and deleted again if it fails.
- **Idempotent and non-destructive:** it inserts only what is missing by natural key and never updates existing rows, so an Admin's changes, deactivations and role changes survive a rerun. A stage email is skipped when any email template already has its trigger status. A seeded record an Admin **deleted** comes back on the next run — deactivate records instead. The seed runs in one transaction under an advisory lock (concurrent runs are safe) and prints counts only.
- **Dev passwords:** with `AUTH_DEV_LOGIN=true` the seed requires `DEMO_USER_PASSWORD` (12+ characters) and gives all four demo users that password (a rerun updates it). Compose uses the fake `local-only-not-secret-demo`, so `recruiter@ats-demo.local` signs in at `http://localhost:3000/sign-in`; for `pnpm dev` choose your own in `.env`. Without dev login no password is set; in Azure demo users sign in through Entra only.

## Email

- Every email goes through `queueEmail(tx, input)` in `src/server/email/` (or `queueTemplateEmail(tx, { templateId, applicationId })` for stage and bulk templates). In the caller's transaction it renders the subject and body — the P3 markup (`src/server/domain/markup/`) to HTML first, then tokens in HTML mode, so a value never becomes markup — writes a `QUEUED` `email_log` row with the full content, and queues an `email.send` job whose payload is `{ emailLogId }` only (J1, J4). A rollback removes both.
- The `email.send` handler (`src/server/email/send.ts`) locks the row and acts only while it is `QUEUED` (J3). At send time it adds From = `SENDER_EMAIL` (E1), Reply-To = the requisition's current recruiter if active, else `FALLBACK_REPLY_TO_EMAIL` (E2), and for candidate emails the footer with the Reply-To address and "Reply to this email to reach your recruiter." (E3); it writes the final body and `reply_to` back (E4). `.ics` content goes out as a `text/calendar` alternative and an `invite.ics` attachment; PDF attachments are read with `StorageService.download`. Emails of anonymized applications are cancelled, not sent.
- Transports live in `src/server/adapters/email/` (the only code that imports Nodemailer): `EMAIL_PROVIDER=smtp` hands the message to Mailpit (`SENT`), `outbox` builds the same message and keeps it (`CAPTURED`, E6). The app refuses to start with `APP_ENV=azure` unless `EMAIL_PROVIDER=outbox` (C4).
- A failed attempt stays `QUEUED` with a sanitized `error` (error class and SMTP/system code, never addresses); pg-boss retries with exponential backoff (5 retries), and after the last one the row is `FAILED` (E5). Remaining at-least-once case: if the process crashes after Mailpit accepted a message but before the commit, the retry sends it again — only ever to Mailpit, never to a real mailbox.
- Mailpit runs in Compose at `http://localhost:8025`. Integration tests need it (`docker compose up -d postgres azurite mailpit`); `ci.yml` runs it as a service container. Tests read messages with `tests/support/mailpit.ts` (`waitForMessage({ to, subjectIncludes })`, `getMessage(id)`; `E2E_MAILPIT_URL` overrides the URL). There is no "delete all": tests run in parallel against one Mailpit, so each uses its own `e2e-<uuid>@example.com` recipients.

## Outbox and background jobs (Admin)

- `/admin/outbox` lists every `email_log` row, newest first, 50 per page, with recipient, subject, status, time (sent, or scheduled while not sent) and a link to the application (`/applications/<id>`, built in task 27). All statuses appear: `SENT` locally (Mailpit), `CAPTURED` in Azure, plus `QUEUED`, `FAILED` and `CANCELLED`; a status filter narrows the list. Rows whose content the retention purge cleared show "Removed by retention".
- `/admin/outbox/<id>` shows the headers, status, times, message ID, error (for `FAILED`), template and application, and the HTML body in `<iframe sandbox="" srcdoc=…>`: an empty `sandbox` grants nothing, so scripts never run. The page's CSP also applies to the `srcdoc` document, so inline styles and the `data:` logo show but remote images are never fetched. "Download invite (.ics)" uses `GET /api/admin/outbox/<id>/ics` (`text/calendar; charset=utf-8`, attachment). PDF attachments open through a fresh 5-minute signed link from `GET /api/files/<id>/url`; deleted files show "Deleted". "From" is the current `SENDER_EMAIL` setting, because the sender isn't stored per message.
- `/admin/jobs` shows, per queue, the counts of queued (`created` + `retry`), active and failed jobs, the newest 50 jobs per state (with the last error, cut to 500 characters, and the ID-only payload), and the `job_runs` of the last 30 Europe/Warsaw days. The pg-boss listings are read-only SQL in the job-queue adapter (`countJobsByState`, `listJobs`), because pg-boss's API can't list by state (tech-stack.md T3).
- Times on these pages are shown in UTC. Both pages and the `.ics` route are Admin-only (`outbox.view`, `jobs.view`).

## Requisitions

- `/requisitions` lists the requisitions the caller may see (`scopeRequisitionsFor`, D6): Admins and Recruiters all, Hiring Managers those where they are hiring manager, approver or creator (V3a); Interviewers get 403. Newest number first, 50 per page, with a state filter. `GET /api/requisitions?state=&page=` returns the same rows.
- `/requisitions/new` creates a `DRAFT` (`POST /api/requisitions`): blank, from an active requisition template (`?template=<id>`), or prefilled from a requisition the caller can see (`?from=<id>`, "Duplicate"). The template can't change afterwards. `/requisitions/<id>/edit` edits a draft (`PATCH /api/requisitions/<id>` with the loaded `version`; a stale one returns 409). Admins and Recruiters edit any draft, Hiring Managers only drafts they created; a requisition outside the caller's scope is 404.
- Every save checks the references (Department/Location/Legal Entity of the right master data type; recruiter a Recruiter or Admin, hiring manager a Hiring Manager or Admin; active unless it is the value already stored), the custom fields against the template's current `schema_json`, and sanitizes the description with an allowlist (`sanitize-html`: `p`, `br`, `h2`, `h3`, `strong`, `em`, `ul`, `ol`, `li`, and `http`/`https`/`mailto` links opened with `rel="noopener noreferrer nofollow"`). The form edits the description with Tiptap, limited to that markup.
- A `PRIVATE` posting gets a 32-hex `private_slug` on its first save as private (L9); it is kept when the posting switches to External. Creation writes a `STATE_CHANGE` row to `requisition_history`, and each changed L2 field (`openings_count`, `department_id`, `hiring_manager_id`, `legal_entity_id`) a `FIELD_CHANGE` row (L11).

### First approval

- On a draft's page, "Submit for approval" picks an approver from active Hiring Managers and Admins (never the current user) and calls `POST /api/requisitions/<id>/submit` (`{ approverId, version }`). Submitting checks the requisition in full: a description with visible text, active master data and users of a fitting role, and custom fields valid against the template's current schema. Who may submit follows the edit rule (Hiring Managers: their own drafts). The approver is an active Hiring Manager or Admin other than the submitter (A1, A2).
- The approver sees the requisition on `/approvals` ("My approvals", Admins and Hiring Managers) and decides with `POST …/approve` (`{ version, comment? }`, sets `APPROVED`, `approved_at`, `is_published`) or `POST …/reject` (comment required, back to `DRAFT`). Only the current approver decides, never the submitter. The submitter, any Recruiter or any Admin can `POST …/withdraw` (A9). Every transition updates `WHERE id AND version AND state`, so concurrent actions resolve to one winner.
- Each action writes one `approval_events` row and one `STATE_CHANGE` history row (A7, L11). Each submit queues the approval request to the approver (E7): a fixed text from `messages/en.json` (`Email.approvalRequest`), `audience = STAFF`, linked to the requisition, with the link `{BETTER_AUTH_URL}/requisitions/<id>`. Decisions send no email.
- While a first approval is pending, the requisition and its questions can't be changed (409, L8); it can still be viewed and duplicated. The approval service lives in `src/server/approvals/` so re-approval, reassignment, reminders and offer approval extend it.

### Pre-screening questions

- The requisition page has a "Pre-screening questions" editor (add, edit, delete, deactivate, reorder with ↑/↓) backed by `GET/POST /api/requisitions/<id>/questions`, `PATCH/DELETE /api/requisitions/<id>/questions/<qid>` and `PUT /api/requisitions/<id>/questions/order` (`{ questionIds }`, exactly the requisition's questions). Admins and Recruiters change questions; Hiring Managers only on drafts they created; Hiring Managers in V3a scope can read them; Interviewers get 403.
- Rules (`src/server/domain/prescreen/questions.ts`): `YES_NO` options are always YES/NO; `SINGLE`/`MULTI` have 2–20 options with codes `^[A-Z0-9_]{1,30}$`; answers use only the question's codes and the scoring and disqualifying answers differ (disjoint sets for `MULTI`); weight 0–100 and a weight above 0 goes with a scoring answer; `TEXT` has no options, weight 0 and no answers (S1); at most 50 questions.
- Questions change in `DRAFT`, `APPROVED`, `ON_HOLD` and re-approval, never in first-approval `PENDING_APPROVAL` (L8) or `CLOSED`. Once a question has a `prescreen_answers` row, its type, options, weight and answers are locked and it can't be deleted, only deactivated (L3); the check runs under a row lock.
- `scorePrescreen(questions, answers)` (`src/server/domain/prescreen/scoring.ts`) is the one scoring function (S1–S4): active questions only, unanswered = 0, unknown codes throw `InvalidAnswerError`, `MULTI` compared as sets.
- Saving a duplicate copies the source's active questions in order.

## Career portal

- `/jobs` (public, rendered per request) lists requisitions with `posting_type = 'EXTERNAL' AND is_published = true`, newest approval first, 20 per page. `?q=` matches every word in the title or the description text (case-insensitive, `%` and `_` literal, at most 100 characters); `?location=` and `?department=` take master data codes, offered from the listed jobs only (deactivated records included). The form is a plain GET form.
- `/jobs/<id>` serves External requisitions approved at least once and `/jobs/p/<slug>` Private ones; anything else (drafts, first approval, the wrong route for the posting type) is the public 404 "This job can't be found.". An unpublished job shows its title and "This position is no longer accepting applications." only, with `noindex`. The description is sanitized again on render.
- Private pages send `noindex, nofollow` (meta and `X-Robots-Tag`) and `Referrer-Policy: no-referrer` (meta and header, set in `proxy.ts`). `/sitemap.xml` lists `/jobs` and the listed External jobs on `BETTER_AUTH_URL`; `/robots.txt` disallows `/apply/`, `/jobs/p/` and the staff paths.
- Public queries live in `src/server/careers/` and select public columns only (title, department, location, description). Playwright checks the pages with `@axe-core/playwright` (WCAG 2.1 A/AA) and at a 375 px viewport.

### Quick Apply

- "Apply now" opens `/apply/<id>` (External, `source = CAREER_SITE`) or `/apply/p/<slug>` (Private, `source = PRIVATE_LINK`), resolved like the job pages. The form (contact fields, PDF CV, optional PDF cover letter, the active questions, consent showing the current privacy statement) is submitted by a server action; the browser checks the file size against `MAX_UPLOAD_MB` as a convenience. `next.config.ts` raises the server-action and proxy body limits to `21mb` (two 10 MiB files plus fields).
- `submitApplication()` (`src/server/apply/`) is the only way to create an application. It checks fields and files first, then in one transaction: locks the requisition `FOR SHARE` and checks `is_published`; computes `email_hash` (HMAC-SHA-256 with `EMAIL_HASH_KEY`) and refuses a duplicate within 24 h (F7) under an advisory lock; compares the questions (IDs and `updated_at`) and the privacy version with what the form showed; scores the answers (S1–S4); and writes the application (`APPLIED`, or `REJECTED`/`DISQUALIFIED` with `dispositioned_at`), files, answers, one system history row and the stage email (acknowledgement now, rejection after `REJECTION_EMAIL_DELAY_HOURS`). Any refusal rolls everything back, including uploaded blobs. Every outcome shows the same thank-you page at `/apply/thanks`.

### Apply anti-spam (F6)

- The apply action runs three checks before `submitApplication()`, in this order: the rate limit, the honeypot, Turnstile (`src/server/apply/guard.ts`).
- **Rate limit:** 5 attempts per client IP per hour. Every attempt counts, in one-minute `rate_limits` buckets summed over the last 60 minutes, upserted under an advisory lock in its own transaction. The client IP comes from `getClientIp()` (`src/server/http/client-ip.ts`): `x-envoy-external-address`, otherwise the **last** `x-forwarded-for` entry, otherwise `127.0.0.1`; invalid values count as absent. The key is the IPv4 address or the IPv6 /64. With `AUTH_DEV_LOGIN=true` the limit is bypassed unless the request sends `x-enforce-rate-limit: true`. Only the IP source is logged, never the address.
- **Honeypot:** an off-screen `website` field that people leave empty; a filled one is refused with a generic message.
- **Turnstile:** `CaptchaService` (`src/server/adapters/captcha/`) posts to Cloudflare's siteverify with a 5 s timeout and fails closed. The widget loads on `/apply/**` with the request's CSP nonce, and only those pages allow `https://challenges.cloudflare.com` in `script-src` and `frame-src`. Compose and CI use Cloudflare's test keys: site key `1x00000000000000000000AA` and secret `1x0000000000000000000000000000000AA` (always pass). The secret `2x0000000000000000000000000000000AA` always fails. The browser and the app need internet access to Cloudflare for the widget and the check.
- A server action's HTTP response is always 200, so the action returns the refusal with its message and an `httpStatus` field (429 for the limit, 400 for the honeypot and Turnstile) instead of a real HTTP status.

## Microsoft Entra sign-in (owner setup)

Staff sign in with accounts from the project's own Entra tenant (tech-stack.md §4, AU1–AU4). Sign-in is invite-only: an Entra account gets in only if an Admin created an **active** ATS user with the same email first (task 12's `pnpm seed:admin` for the first Admin, the Admin user pages from task 15 after that). Anyone else sees "Access not granted, contact your ATS admin." and no user is created. On the first sign-in the Entra account is linked to that user; later sign-ins match the Entra object ID, so a renamed UPN still signs in the same user. Sign-in never changes the ATS user's name, email or role, and no profile photo is fetched.

One-time setup in the Entra admin center (Microsoft Entra ID → App registrations), done by the owner:

1. **New registration**, supported account types: *Accounts in this organizational directory only* (single tenant). Never multi-tenant: the app refuses a tenant ID that isn't a GUID (`common`, `organizations`, `consumers`).
2. **Authentication → Web** redirect URIs:
   - `http://localhost:3000/api/auth/callback/microsoft` (local)
   - `https://<Azure app address>/api/auth/callback/microsoft` (update it if the host name changes after a rebuild, G6)
3. **Certificates & secrets → New client secret.** Store the value in Key Vault as the secret `microsoft-client-secret` (see [Azure setup](#azure-setup); the apps read it as `MICROSOFT_CLIENT_SECRET`) and set a calendar reminder before it expires; sign-in stops working when it does.
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

## CI/CD

- **`ci.yml`** (pull requests): `pnpm verify`, `db:migrate` and the integration tests against service containers, then `pnpm build` with no configuration (W1). No Playwright.
- **`main.yml`** (every push to `main`, and by hand from the Actions tab: *main* → *Run workflow*): `pnpm verify`, then the Docker image is built **once** as `ghcr.io/<owner>/ats-app:<full commit SHA>` and tested as is. The Compose stack runs it (`APP_IMAGE=<that tag> docker compose up --no-build --wait`; the `app` service has a `/api/health` healthcheck). The workflow migrates and seeds from the image (`node db/migrate.mjs`, `node db/seed.mjs`, which on the empty stack adds the demo data), runs `pnpm test:integration` against the Compose PostgreSQL, Azurite and Mailpit, and then the whole Playwright suite (`pnpm test:e2e`: parallel projects, then `time-travel`; one retry in CI). Only then is **the same image** pushed to GHCR (private package, SHA tag only, no `latest`); the job summary shows the tag and digest.
  - On `main`, the **`deploy`** job then rolls that image out to Azure: OIDC login, `db-migrate` on the new tag, the web app's image, the `tick` and `db-seed` jobs' image, and a smoke test (see [Deploy and rollback](#deploy-and-rollback)). Only after a successful deployment are older GHCR versions deleted so the 10 most recent remain; the image the web app runs is therefore never deleted.
  - Each step runs only if the earlier ones passed. A newer push cancels a running test job, but never a deployment; deployments and `infra.yml` runs share one concurrency group (`azure-deploy`), so they never overlap. Pushes that change only `_docs/**` or Markdown files don't start it. Manual runs from another branch run the tests but never push or deploy; a manual run on `main` deploys.
  - On failure the run uploads `test-results/` (trace, video, screenshot), `playwright-report/` and the Compose logs as an artifact kept 7 days.
  - The test job's only credential is `GITHUB_TOKEN`; the deploy job logs in to Azure with OIDC (no Azure secret in GitHub, G3). Playwright in CI needs internet access to `challenges.cloudflare.com` (Turnstile test keys, in the browser and the app).
  - Expect about 25–35 minutes per run, of which 3–5 for the deployment.
- **`infra.yml`** (by hand, `main` only): what-if or deploy of the Azure environment; see [Azure setup](#azure-setup).
- Locally, `docker compose up --build` still builds the app itself and tags it `ats-app:local`.

## Azure setup

The Azure environment is defined in `infra/main.bicep` (modules in `infra/modules/`) and deployed by the **`infra.yml`** workflow into one resource group in the owner's personal subscription and tenant (tech-stack.md §1, G3, G5; ats-project-scope.md C1). Everything is tagged `project=ats`; names are `ats-<kind>-<uniqueString(resource group)>`, and the location is the resource group's, except PostgreSQL when the optional `POSTGRES_LOCATION` variable is set. The PostgreSQL server's name also includes its region (`ats-pg-<region>-<uniqueString>`), so a new `POSTGRES_LOCATION` gives a new name. A create that Azure refused (`SkuNotAvailable`) can leave a record of the name in ARM. `az resource list` doesn't show that record and it can't be deleted, yet it blocks the name in every other region (`InvalidResourceLocation`).

| Resource | Settings |
|---|---|
| Log Analytics | `PerGB2018`, 30-day retention, 0.1 GB/day cap (M7); logging pauses for the rest of the day at the cap |
| User-assigned identity | Used by the web app and all jobs; **Key Vault Secrets User** on the vault, **Storage Blob Data Contributor** on the storage account |
| Key Vault | Standard, Azure RBAC, 7-day soft delete, purge protection off, template deployment on |
| Storage | `Standard_LRS`, `StorageV2`, Hot, HTTPS and TLS 1.2 only, no public blobs, no shared keys, blob soft delete and versioning off, private container `files` |
| PostgreSQL Flexible Server | 17, `Standard_B1ms`, in `POSTGRES_LOCATION` if set (otherwise the resource group's region), 32 GB without auto-grow, 7-day backups, no HA or geo backup, password auth, firewall `AllowAllWindowsAzureIps`, `require_secure_transport=on`, database `ats`. The `database-url` and `database-admin-url` secrets carry a `postgresHost` tag; the full stage rewrites both from the stored passwords when the tag doesn't match the server's host |
| Container Apps | Consumption environment; web app (0.5 vCPU / 1 GiB, 0–1 replicas, HTTPS ingress on 3000, readiness and startup probes on `/api/health`); jobs `tick` (hourly, `node db/tick.mjs`), `db-migrate` (`node db/migrate.mjs`) and `db-seed` (`node db/seed.mjs`, or `node db/seed-admin.mjs` when `SEED_ADMIN_EMAIL` is set) |
| Budget | 10 per month in the subscription's billing currency, emails at 80 % and 100 % of actual cost |

All four containers run the same image with one environment list: `APP_ENV=azure`, `EMAIL_PROVIDER=outbox`, `LOG_LEVEL=info`, `BETTER_AUTH_URL=https://<web app>.<environment domain>`, the Entra, storage, identity and Turnstile settings, and Key Vault references for `DATABASE_URL`, `BETTER_AUTH_SECRET`, `MICROSOFT_CLIENT_SECRET`, `EMAIL_HASH_KEY`, `TURNSTILE_SECRET_KEY` and `TICK_SECRET`. Only the web app has `WORKER_ENABLED=true`; only `db-migrate` gets `DATABASE_ADMIN_URL`. Dev sign-in, demo passwords, Azurite and SMTP settings are never set (`infra/check-arm.mjs` fails the workflow if the compiled template mentions them).

**Database logins.** The server admin (`atsadmin`) owns the schema and is used only by `db-migrate`. With `DATABASE_ADMIN_URL` set, `db:migrate` applies the migrations as the admin, then creates or updates the app login `ats_app` from `DATABASE_URL`. That login gets `CONNECT`, DML on the tables, `USAGE`/`SELECT` on the sequences and ownership of the `pgboss` schema, and no DDL right on `public`. Last, `db:migrate` installs the job queues as `ats_app`. For that one step `ats_app` may create schemas in the database; the right is revoked straight afterwards. Locally and in CI `DATABASE_ADMIN_URL` is unset and nothing changes.

### `infra.yml`

Runs only by hand (**Actions → infra → Run workflow**) and only on `main`: the first step refuses other refs, and the Azure federated credential accepts only `repo:mikolajniezbecki-bit/ats-app:ref:refs/heads/main`. It logs in with OIDC (`azure/login`); **no Azure secret is stored in GitHub** (G3).

| Input | Values |
|---|---|
| `mode` | `what-if` (default): shows the planned changes in the job summary and deploys nothing. `deploy`: shows the same what-if, then deploys |
| `stage` | `foundation`: Log Analytics, identity, Key Vault with the generated secrets, storage, role assignments, budget. `full`: all of that plus PostgreSQL, the Container Apps environment, the web app and the jobs |
| `image_tag` | Full commit SHA of an image in GHCR. Used only while the web app doesn't exist; afterwards the workflow keeps the image the app runs, so a rerun never rolls it back (`main.yml` deploys new images, task 45) |

**Approval:** read a `what-if` run, then start the matching `deploy` run. Starting it is the approval (Q1, TO-21: GitHub environments with required reviewers aren't available on the Free plan). A deploy run prints its own what-if first, in case `main` changed in between.

After a `full` deployment the workflow runs the `db-migrate` job, waits for it to succeed, and calls `GET {BETTER_AUTH_URL}/api/health` until it returns 200 (up to 5 minutes). On the **first** full deployment the web app is created only after `db-migrate` has created the app login, because the app's start-up fails without it. Its deployment is named `infra-full-bootstrap`.

**Generated secrets.** On the first `foundation` run, when none exists yet, the workflow generates `pg-admin-password`, `pg-app-password`, `better-auth-secret`, `email-hash-key` and `tick-secret` (random, URL-safe), masks them in the log, and Bicep stores them in Key Vault together with `database-url` and `database-admin-url` (`postgres://…@<server>.postgres.database.azure.com:5432/ats?sslmode=require`). Later runs never write them again, so each keeps a single version. If only some of the seven exist, the run stops: restore the missing ones or delete all seven. Don't change them by hand.

### One-time owner setup

Done once in the personal subscription and tenant (C1). `_docs/user-tasks.md` has the same steps click by click.

1. **Resource group** in an EU region where Container Apps is available (this project: `rg-ats-demo` in Poland Central). PostgreSQL Flexible Server 17 `Standard_B1ms` must be offered to the subscription either there or in another EU region set as `POSTGRES_LOCATION` (step 4). Check with `az postgres flexible-server list-skus --location <region> -o table`, but that list isn't the final answer: new and free-trial subscriptions are often refused B1ms at create time (`SkuNotAvailable`, or `ParameterOutOfRange` "The value of the 'Version' should be in: []"). This project's free trial was refused in `polandcentral`, `westeurope`, `swedencentral` and `germanywestcentral`. The database runs in **`francecentral`** (`POSTGRES_LOCATION=francecentral`).
2. **Deploy service principal:** an app registration (`ATS GitHub deploy`, single tenant, no client secret) with a federated credential for GitHub Actions: organization `mikolajniezbecki-bit`, repository `ats-app`, entity *Branch*, branch `main`. On the resource group assign it:
   - **Contributor**;
   - **Role Based Access Control Administrator**, with the condition "allow assigning only **Storage Blob Data Contributor** and **Key Vault Secrets User** to **service principals**" (Q2).
3. **Resource providers:** register `Microsoft.App`, `Microsoft.DBforPostgreSQL`, `Microsoft.KeyVault`, `Microsoft.ManagedIdentity`, `Microsoft.OperationalInsights`, `Microsoft.Storage` and `Microsoft.Consumption` in the subscription (`az provider register --namespace <ns>`). A new subscription has none of them registered, and the deploy service principal can't register them: that is a subscription-scope action (`MissingSubscriptionRegistration` otherwise).
4. **GitHub Actions variables** (Settings → Secrets and variables → Actions → **Variables**, not Secrets): `AZURE_DEPLOY_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`, `GHCR_USERNAME`, `MICROSOFT_CLIENT_ID`, `TURNSTILE_SITE_KEY`, `DEMO_USER_DOMAIN` (`<tenant>.onmicrosoft.com`), `BUDGET_ALERT_EMAIL`, and optionally `POSTGRES_LOCATION` (an EU region name, for the database only; this project: `francecentral`). The database region can't change once the server exists: `infra.yml` stops if the existing server is in another region. Before that it can: each region gets its own server name.
5. Run `infra.yml` with `stage: foundation` (what-if, then deploy). Give yourself **Key Vault Secrets Officer** on the new vault, then add the three secrets only you have:
   - `microsoft-client-secret`: the Entra sign-in app's client secret ([Microsoft Entra sign-in](#microsoft-entra-sign-in-owner-setup));
   - `turnstile-secret-key`: the real Turnstile widget's secret key;
   - `ghcr-pat`: the token from step 6.
6. **GHCR token (G9):** github.com → Settings → Developer settings → Personal access tokens → **Tokens (classic)**. The note is `ATS Azure image pull`, the expiry **90 days**, and the scope **`read:packages` only**. GitHub Packages accepts only classic tokens, and a classic token covers the whole personal account, so never give it any other scope.
   - **Reminders:** set a calendar reminder about two weeks before the token expires (Azure can no longer pull images after that) and one before the Entra client secret expires (staff sign-in stops). To renew, create a new token or secret, add it as a new version of the same Key Vault secret, and restart the web app's revision.
7. Run `infra.yml` with `stage: full` and `image_tag` = the latest SHA in GHCR (the tag in `main.yml`'s job summary). What-if first, then deploy. The database takes 10–15 minutes.
8. **Host-name settings (Q12):** the run's summary shows `appUrl`. Add `{appUrl}/api/auth/callback/microsoft` to the Entra app registration's redirect URIs (AU1), and add the host name (without `https://`) to the Turnstile widget's hostnames. Repeat this after a rebuild if the host name changes.

### Seeding

Run in Azure Cloud Shell (Bash), with `RG` set to the resource group:

```sh
RG=rg-ats-demo
JOB=$(az resource list -g "$RG" --resource-type Microsoft.App/jobs --query "[?starts_with(name, 'ats-db-seed-')].name | [0]" -o tsv)
JOB_ID=$(az resource show -g "$RG" --resource-type Microsoft.App/jobs -n "$JOB" --query id -o tsv)

# Demo data (db:seed, D8): start the job as defined.
az rest --method post --url "https://management.azure.com$JOB_ID/start?api-version=2024-03-01" --query name -o tsv

# First Admin (seed:admin, AU8): one execution with SEED_ADMIN_EMAIL added to the job's own settings.
az resource show --ids "$JOB_ID" --query "properties.template.containers[0]" -o json \
  | jq --arg email "<your UPN>" '{containers: [{image, name, command, resources, env: (.env + [{name: "SEED_ADMIN_EMAIL", value: $email}])}]}' \
  > seed-admin.json
az rest --method post --url "https://management.azure.com$JOB_ID/start?api-version=2024-03-01" --body @seed-admin.json --query name -o tsv

# Status of the executions (Succeeded / Failed); the output is in Log Analytics.
az rest --method get --url "https://management.azure.com$JOB_ID/executions?api-version=2024-03-01" \
  --query "value[].{name: name, status: properties.status, start: properties.startTime}" -o table
```

The second start replaces the execution's container settings, so it passes the job's complete settings plus `SEED_ADMIN_EMAIL`. Secret references stay in place. The job's output carries the user ID only, never the email (M2).

### Deploy and rollback

Every green push to `main` deploys the image it has just tested (`main.yml`, `deploy` job). The steps, each only if the previous one succeeded:

1. Read the resource names from the outputs of the `infra-full` deployment. If it doesn't exist, the run stops: run `infra.yml` (stage `full`) first.
2. Check that the PostgreSQL server is `Ready`. A stopped database stops the run ([Stop and start between demos](#stop-and-start-between-demos)).
3. Set the `db-migrate` job's image to `ghcr.io/<owner>/ats-app:<commit SHA>`, run it (`infra/run-job.sh`, up to 10 minutes) and wait for `Succeeded`.
4. Set the web app's image (`infra/set-image.sh`) and wait up to 10 minutes for the new revision to be ready. Until then the previous revision keeps serving (single revision mode). Only the image changes: the script compares the environment variable names, secret names and registry settings before and after and fails on any difference.
5. Set the `tick` and `db-seed` jobs' image. Their trigger and settings stay as they are, so a `tick` job stopped for G10 stays stopped.
6. Smoke test (`infra/smoke-test.sh`): within 5 minutes, `GET {appUrl}/api/health` returns 200 with `status`, `database` and `storage` all `ok`, and ARM shows exactly one active revision, with 100 % of the traffic, on the new image.

The job summary shows the commit, the `db-migrate` execution, the new revision and the smoke test. The scripts use plain ARM calls (`az resource`, `az rest`), so no Azure CLI extension is needed, and they print names, never secret values.

**After a failure.** There is no automatic rollback (TO-17). If the failure was transient (Azure busy, a timeout), rerun it: **Actions → main → the failed run → Re-run failed jobs**, or **Run workflow** on `main`. The scripts skip what is already done. If the new release is broken, fix it forward with a new pull request, or roll back by hand.

**Rolling back by hand** (Azure Cloud Shell, Bash). Pick an earlier commit SHA whose image is still in GHCR: `main.yml` keeps the 10 most recent versions (the SHAs are in the runs' job summaries).

```sh
RG=rg-ats-demo
SHA=<earlier full commit SHA>
API=api-version=2024-03-01
IMAGE=ghcr.io/mikolajniezbecki-bit/ats-app:$SHA
OUT=$(az deployment group show -g "$RG" -n infra-full --query properties.outputs -o json)
for NAME in $(jq -r '.webName.value, .tickJobName.value, .seedJobName.value, .migrateJobName.value' <<< "$OUT"); do
  ID=$(az resource list -g "$RG" --query "[?name=='$NAME'].id | [0]" -o tsv)
  # The current template with only the image changed; nothing else is sent.
  az rest --method get --url "https://management.azure.com$ID?$API" \
    | jq --arg image "$IMAGE" '{properties: {template: (.properties.template | del(.revisionSuffix) | .containers[0].image = $image)}}' \
    > rollback.json
  az rest --method patch --url "https://management.azure.com$ID?$API" --body @rollback.json --output none
  az resource show --ids "$ID" --query "{name: name, image: properties.template.containers[0].image, state: properties.provisioningState}" -o table
done
```

The web app's new revision takes a minute or two; check `GET {appUrl}/api/health` afterwards. **Migrations are never rolled back:** they are forward only, and each must work with the previous release still running (D2), so the earlier image runs against the newer schema. The next push to `main` deploys again over the rollback.

### Stop and start between demos

> **Not run in Azure.** The owner waived this proof on 2026-11-04 (task 45), so these commands, including the switch of the `tick` trigger to manual, are untested. Check the result with **Check both** the first time you use them.

Stopping the database and the hourly `tick` job keeps the cost near zero between demos, which matters after month 12 when the database is no longer free (G10). Container Apps has no pause switch for a scheduled job, so **stop** switches the `tick` job's trigger to manual (it then never runs by itself) and **start** restores the hourly schedule `0 * * * *`. Rerunning `infra.yml` (stage `full`) restores it too. `main.yml` changes only images, so a deployment never turns the schedule back on.

Run in Azure Cloud Shell (Bash). Set the names first:

```sh
RG=rg-ats-demo
API=api-version=2024-03-01
OUT=$(az deployment group show -g "$RG" -n infra-full --query properties.outputs -o json)
PG=$(jq -r .postgresServerName.value <<< "$OUT")
TICK_ID=$(az resource list -g "$RG" --query "[?name=='$(jq -r .tickJobName.value <<< "$OUT")'].id | [0]" -o tsv)
```

**Stop** (the tick first, so it doesn't fail against a stopped database):

```sh
az rest --method get --url "https://management.azure.com$TICK_ID?$API" \
  | jq '{properties: {configuration: (.properties.configuration
      | .triggerType = "Manual" | .scheduleTriggerConfig = null
      | .manualTriggerConfig = {parallelism: 1, replicaCompletionCount: 1})}}' > tick-trigger.json
az rest --method patch --url "https://management.azure.com$TICK_ID?$API" --body @tick-trigger.json --output none
az postgres flexible-server stop -g "$RG" -n "$PG"
```

**Start** (the database first):

```sh
az postgres flexible-server start -g "$RG" -n "$PG"
az rest --method get --url "https://management.azure.com$TICK_ID?$API" \
  | jq '{properties: {configuration: (.properties.configuration
      | .triggerType = "Schedule" | .manualTriggerConfig = null
      | .scheduleTriggerConfig = {cronExpression: "0 * * * *", parallelism: 1, replicaCompletionCount: 1})}}' > tick-trigger.json
az rest --method patch --url "https://management.azure.com$TICK_ID?$API" --body @tick-trigger.json --output none
```

**Check both** (the database `Ready` or `Stopped`; the tick `Schedule` with `0 * * * *`, or `Manual`; its recent executions):

```sh
az postgres flexible-server show -g "$RG" -n "$PG" --query state -o tsv
az resource show --ids "$TICK_ID" \
  --query "properties.configuration.{trigger: triggerType, cron: scheduleTriggerConfig.cronExpression, secrets: length(secrets), registries: length(registries)}" -o table
az rest --method get --url "https://management.azure.com$TICK_ID/executions?$API" \
  --query "value[].{name: name, status: properties.status, start: properties.startTime}" -o table
```

Good to know:

- Azure starts a stopped server again by itself after **7 days**. Stop it again to keep it stopped; the `tick` stays manual until you start it.
- **While the database is stopped the site returns errors**: the app can't start without it (W1).
- **`main.yml` deployments and `infra.yml` need the database running.** A deployment stops at its second step with "The database is stopped". Start it before merging anything into `main`, then rerun the failed workflow.

### Rebuild from an empty resource group

The environment can be rebuilt from nothing (G6). Task 44's first build was done this way. In order:

0. **Only if the old resource group was deleted:**
   - Recreate it with the same name and region (`rg-ats-demo`, Poland Central): portal **Resource groups → + Create**.
   - Redo the deploy service principal's two role assignments on it ([One-time owner setup](#one-time-owner-setup) step 2): role assignments are deleted with the group. The app registration and its federated credential survive.
   - Deal with the soft-deleted Key Vault (kept 7 days after the group is deleted). **Recover it** (recommended): portal **Key vaults → Manage deleted vaults →** select it **→ Recover**, or `az keyvault recover --name <vault>`. It keeps your three secrets and the generated ones. Or **purge** it (same page, **Purge**): `foundation` then generates new values, and you add your three secrets again (step 2 below). After a recovery, give yourself **Key Vault Secrets Officer** again if you need to change a secret.
1. Run `infra.yml` with `stage: foundation`: what-if, then deploy.
2. **Only if the vault was purged:** add `microsoft-client-secret`, `turnstile-secret-key` and `ghcr-pat` ([One-time owner setup](#one-time-owner-setup) step 5).
3. Run `infra.yml` with `stage: full` and `image_tag` set to a SHA still in GHCR (one of the 10 most recent `main.yml` runs): what-if, then deploy. Keep `POSTGRES_LOCATION` (`francecentral`). If Azure refuses the PostgreSQL name because a deleted server still holds it, set `POSTGRES_LOCATION` to an EU region not tried before ([One-time owner setup](#one-time-owner-setup) step 1). The first full deployment is named `infra-full-bootstrap` and creates the web app only after `db-migrate` has run.
4. **Actions → main → Run workflow** on `main`: tests the latest commit and deploys it.
5. Run the `db-seed` job ([Seeding](#seeding), demo data).
6. Run the `db-seed` job with `SEED_ADMIN_EMAIL=<your UPN>` ([Seeding](#seeding), first Admin).
7. If the host name changed (`appUrl` in the `full` run's summary): update the Entra redirect URI and the Turnstile hostname ([One-time owner setup](#one-time-owner-setup) step 8, `_docs/user-tasks.md` step 2.5).

### Cloud proofs

The manual Sprint 0 proofs in Azure (tech-stack.md §15), all on image `202e9d9` and recorded on issue #51.

| Proof | Date | Image SHA | Outcome | Notes |
|---|---|---|---|---|
| #6 Entra sign-in and refusal | 2026-11-04 | `202e9d9` | Passed | Owner-reported, in a browser (`_docs/user-tasks.md` step 3.2). |
| #7 Signed links | 2026-11-04 | `202e9d9` | Passed | Cloud Shell check: Blob origin over HTTPS, user delegation key, `200`, `application/pdf`, `inline`; `409` without the signature. The `403` after 5 minutes is owner-reported. |
| #8 Outbox | 2026-11-04 | `202e9d9` | Passed | Owner-reported, in a browser (step 3.3). |
| #9 Client IP header | 2026-11-04 | `202e9d9` | Passed | Six attempts with spoofed headers: five refused by Turnstile, the sixth by the rate limit. All six logged `ip_source: envoy`, so `x-envoy-external-address` is the confirmed header. |
| Turnstile on the Azure host name | 2026-11-04 | `202e9d9` | Passed | Owner-reported, in a browser (step 3.3). |
| Dev-only features off | 2026-11-04 | `202e9d9` | Passed | `POST /api/auth/sign-in/email` returns 400 `EMAIL_PASSWORD_DISABLED` with no cookie; `/sign-in` shows only **Sign in with Microsoft**. |
| G10 stop and start | n/a | n/a | Not run (owner decision) | Waived on 2026-11-04: the app won't be used after the Azure free trial. |

### Costs

The settings above stay within the free offer (tech-stack.md §14): B1MS with 32 GB and 7-day backups (12 months free), about 3 GB of logs a month (5 GB free), Container Apps' monthly free grant, and cents for Key Vault and Blob. Things that would raise the cost are all off: PostgreSQL auto-grow, high availability, geo-redundant backups or a larger SKU, blob soft delete or versioning, diagnostic settings, and a second PostgreSQL server.

- **The budget alert only notifies and never stops spending.** It counts in the subscription's billing currency: 10 means EUR 10 on a EUR subscription. On another currency, change `budgetAmount` in `infra/main.bicepparam` to the equivalent.
- **Defender for Cloud plans stay on the free tier.** Don't enable paid plans.
- Check **Cost Management → Cost analysis** for the resource group after the first week. After month 12, B1MS is billed at pay-as-you-go rates and will exceed the budget unless the database is stopped between demos ([Stop and start between demos](#stop-and-start-between-demos), G10).

## Configuration

All configuration goes through `getConfig()` in `src/server/config.ts` (tech-stack.md §3 rule 5). It validates every variable with Zod on the first call (never at import time, so `pnpm build` needs no secrets) and caches the result. Errors name the missing or invalid variables, never their values. An empty value (`KEY=`) counts as missing.

Copy `.env.example` to `.env` and fill the empty values you need. `.env` is git-ignored; never commit it. Secrets stay empty in `.env.example`, including publicly documented dev values. Where they come from:

- `DATABASE_URL`: the Compose PostgreSQL, `postgres://ats:local-only-not-secret-postgres@localhost:5432/ats`.
- `BETTER_AUTH_SECRET`, `EMAIL_HASH_KEY`, `TICK_SECRET`: any random local value, e.g. `openssl rand -base64 32`.
- `AZURE_STORAGE_CONNECTION_STRING`: Azurite's [default development connection string](https://learn.microsoft.com/azure/storage/common/storage-use-azurite#http-connection-strings).
- `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`: Cloudflare's [Turnstile test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/).
- `DEMO_USER_PASSWORD`: any local password of at least 12 characters.
- `MICROSOFT_*`: leave all three empty locally unless you test Entra sign-in; they are set together or not at all, and the tenant ID must be a GUID.
- `pnpm dev` in Codespaces, opened through the forwarded `https://<codespace>-3000.app.github.dev` URL: set `BETTER_AUTH_URL` to that URL and uncomment `BETTER_AUTH_TRUSTED_ORIGINS=https://localhost:3000,http://localhost:3000`, then restart `pnpm dev`. The port-forwarding proxy rewrites the browser's `Origin` header to `localhost:3000`, so without it Better Auth logs `Invalid origin: https://localhost:3000` and sign-in fails with a 403. Better Auth reads this variable itself; it is not part of `getConfig()` and is never set in Azure.

Refused combinations: `AUTH_DEV_LOGIN=true` with `APP_ENV=azure` or `EMAIL_PROVIDER=outbox` (AU7), and `APP_ENV=azure` without `EMAIL_PROVIDER=outbox` (§3 rule 10). `NODE_ENV` plays no part in these checks.

## Logging

`src/server/logger.ts` writes pino JSON lines to stdout (M1). It reads only `LOG_LEVEL` (default `info`), so it works even when the configuration is invalid. Log identifiers only, never personal data (M2); the `redact` paths are a safety net. In server code, use `getRequestLogger()` from `src/server/request-id.ts` to bind the request's `request_id`, which `src/proxy.ts` generates for every request and returns in `x-request-id` (M3). Unhandled errors are logged by `onRequestError` in `src/instrumentation.ts` (M4).

For readable output locally, pipe it through pino-pretty: `pnpm dev | pnpm dlx pino-pretty`.

## License & Attribution

Licensed under the GNU Affero General Public License v3.0 only (AGPL-3.0-only); see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

Copyright (c) 2026 Mikołaj Niezbecki. Any reuse, modification or network deployment must retain the original authorship attribution and comply with the license terms.
