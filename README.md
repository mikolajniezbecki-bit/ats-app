# ats-app

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

- **Contents** (`src/server/db/seed/data.ts`, all synthetic): one row per setting with its default and `updated_by = NULL` (shown as "Default"); Departments, Locations, Legal Entities and the `employment_type` and `seniority` picklists; the "Standard requisition" template, the "Application received" (`APPLIED`) and "Application rejected" (`REJECTED`) stage emails, the bulk emails "Application update" and "Interview preparation", and the "Default offer letter"; and four demo users, `admin@`, `recruiter@`, `hm@` and `interviewer@` + `DEMO_USER_DOMAIN` (`ats-demo.local` locally; the `<tenant>.onmicrosoft.com` domain in Azure, so they link to the Entra demo accounts). No requisitions or applications (task 42).
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

### Pre-screening questions

- The requisition page has a "Pre-screening questions" editor (add, edit, delete, deactivate, reorder with ↑/↓) backed by `GET/POST /api/requisitions/<id>/questions`, `PATCH/DELETE /api/requisitions/<id>/questions/<qid>` and `PUT /api/requisitions/<id>/questions/order` (`{ questionIds }`, exactly the requisition's questions). Admins and Recruiters change questions; Hiring Managers only on drafts they created; Hiring Managers in V3a scope can read them; Interviewers get 403.
- Rules (`src/server/domain/prescreen/questions.ts`): `YES_NO` options are always YES/NO; `SINGLE`/`MULTI` have 2–20 options with codes `^[A-Z0-9_]{1,30}$`; answers use only the question's codes and the scoring and disqualifying answers differ (disjoint sets for `MULTI`); weight 0–100 and a weight above 0 goes with a scoring answer; `TEXT` has no options, weight 0 and no answers (S1); at most 50 questions.
- Questions change in `DRAFT`, `APPROVED`, `ON_HOLD` and re-approval, never in first-approval `PENDING_APPROVAL` (L8) or `CLOSED`. Once a question has a `prescreen_answers` row, its type, options, weight and answers are locked and it can't be deleted, only deactivated (L3); the check runs under a row lock.
- `scorePrescreen(questions, answers)` (`src/server/domain/prescreen/scoring.ts`) is the one scoring function (S1–S4): active questions only, unanswered = 0, unknown codes throw `InvalidAnswerError`, `MULTI` compared as sets.
- Saving a duplicate copies the source's active questions in order.

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
