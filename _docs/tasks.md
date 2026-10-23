# Custom ATS & Career Portal: Task Backlog

Work through these tasks in order, one at a time (see `AGENTS.md`). Each task is sized for one session and names the spec sections and rule IDs it implements; read `ats-project-scope.md`, `tech-stack.md` and `tradeoffs.md` for the full rule text. Tests for a rule must have a title that starts with the rule ID and a colon (`tech-stack.md` T1).

When a task's "Done when" criteria pass, mark it done by appending ` ✅` to its heading.

---

## 1. Empty project skeleton ✅

**Issue:** [#1](https://github.com/mikolajniezbecki-bit/ats-app/issues/1)

**Goal:** An empty Next.js project that matches `tech-stack.md`, with one passing test.

**Description:** Create a Next.js 16 App Router project in TypeScript (strict mode) on Node.js 24 with pnpm (version pinned in `packageManager`), Tailwind CSS, shadcn/ui, and `next-intl` in single-locale mode (`en` only, `/messages/en.json`, no locale prefix). Set up the folder structure from `tech-stack.md` §3 (`src/app`, `src/components`, `src/lib`, `src/i18n`, `src/server/{domain,policy,db,adapters,pdf}`, `src/worker`, `messages`, `infra`, `tests`, `tests/e2e`), `next.config.ts` per §3 rule 7, and install ESLint (`eslint-config-next`), Vitest (`tests/**/*.test.ts(x)`, excluding `tests/e2e/**`) and Playwright (`tests/e2e/**/*.spec.ts`). Enforce Node 24 with `engines` and `engine-strict=true` in `.npmrc`. Add the scripts `lint`, `typecheck`, `test` and `verify` (lint + typecheck + unit tests; no `next build`, G7) and one trivial Vitest test; no business code.

**Depends on:** none

**Done when:**
- `pnpm install` succeeds on a clean checkout; `package.json` pins pnpm in `packageManager` and Node 24 in `engines`.
- `pnpm verify` passes and runs exactly one passing Vitest test.
- `pnpm build` succeeds and produces `.next/standalone`.
- The home page renders a placeholder string read from `messages/en.json`.

## 2. Pull-request CI and rule-traceability scanner ✅

**Issue:** [#2](https://github.com/mikolajniezbecki-bit/ats-app/issues/2)

**Goal:** Every pull request runs the checks from `ci.yml`, including the rule-ID scan.

**Description:** Add `.github/workflows/ci.yml` (install with pnpm cache → the `pnpm verify` checks: lint → typecheck → unit tests → `pnpm test:rules` → then `next build`; no Playwright; `concurrency` cancelling superseded runs, G4) and Dependabot weekly updates for npm and GitHub Actions (G8). Implement `pnpm test:rules` (T1): it scans Vitest and Playwright test titles for rule IDs followed by a colon, matching exactly (`A2:` is not `AU2:`), and fails when a required ID has no test. Because rules are built incrementally, the scanner also reads a committed list of not-yet-implemented IDs (`tests/rules-pending.json`) that each task shrinks; it fails if a pending ID already has a test, so the list cannot go stale. Add `test:rules` to `pnpm verify`; `verify` still does not run `next build` (G7).

**Depends on:** 1

**Done when:**
- Unit tests show the scanner passes when every required ID is tested or pending, fails naming the missing ID otherwise, and does not accept `AU2:` as a test for `A2`.
- The scanner fails when an ID in `rules-pending.json` already has a test.
- `ci.yml` runs green on a pull request; `.github/dependabot.yml` covers npm and GitHub Actions weekly.

## 3. Typed configuration and structured logging ✅

**Issue:** [#3](https://github.com/mikolajniezbecki-bit/ats-app/issues/3)

**Goal:** The app reads all configuration through one validated loader and logs structured JSON without personal data.

**Description:** Implement `getConfig()` in `src/server/config.ts`: it validates every environment variable from `tech-stack.md` §3 with Zod on first call (not at import time), caches the result, and enforces the AU7 guard (refuse to start when `AUTH_DEV_LOGIN === 'true'` and `APP_ENV === 'azure'` or `EMAIL_PROVIDER === 'outbox'`). Add a pino logger module with `redact` paths for personal fields (M1, M2), a per-request `request_id` returned in `x-request-id` (M3), and a generic error page that shows the `request_id` (M4). Commit a `.env.example` listing every variable without secret values.

**Depends on:** 1, 2

**Done when:**
- Unit tests show `getConfig()` throws a message naming a missing variable and is not evaluated when the module is imported.
- `AU7:` tests: startup is refused with `AUTH_DEV_LOGIN=true` plus `APP_ENV=azure`, and with `EMAIL_PROVIDER=outbox`; it is accepted with `NODE_ENV=production`, `APP_ENV=ci`, `EMAIL_PROVIDER=smtp`.
- A test shows the logger redacts email, name and phone fields; responses carry an `x-request-id` header.

## 4. Docker Compose stack and production image ✅

**Issue:** [#8](https://github.com/mikolajniezbecki-bit/ats-app/issues/8)

**Goal:** `docker compose up` runs the whole local stack from the same image used in CI and Azure.

**Description:** Write a multi-stage `Dockerfile` that builds the Next.js standalone output and runs as a non-root user, and a `docker-compose.yml` with `app`, `postgres:17`, `azurite` and `mailpit` (`tech-stack.md` §1, local topology). The image must build without any runtime secrets and run with `NODE_ENV=production`. `docker-compose.yml` contains obviously fake, local-only values for the secrets and the Postgres password, so the stack starts on a fresh clone without `.env` (`AGENTS.md` exception). The `app` service reaches Azurite at `http://azurite:10000` and sets `AZURE_STORAGE_PUBLIC_URL=http://localhost:10000/devstoreaccount1` for browser-facing signed links (`tech-stack.md` §3, §8). Document the local start-up commands in the README.

**Depends on:** 1, 3

**Done when:**
- `docker compose up --build` starts all four services and the app home page returns HTTP 200 on `localhost:3000`.
- The app container starts with `AUTH_DEV_LOGIN=true`, `APP_ENV=ci`, `EMAIL_PROVIDER=smtp` and `NODE_ENV=production` on a fresh clone with no `.env`.
- Mailpit's web UI is reachable on `localhost:8025`; the README describes how to start and stop the stack.

## 5. Database access and administration tables ✅

**Issue:** [#9](https://github.com/mikolajniezbecki-bit/ats-app/issues/9)

**Goal:** Drizzle is wired to PostgreSQL with migrations and the first set of tables.

**Description:** Set up Drizzle ORM with node-postgres (one `pg.Pool`, max 10 connections, TLS when required, D5), `drizzle-kit` with committed SQL migrations, a `pnpm db:migrate` script using drizzle-orm's runtime migrator (`drizzle-orm/node-postgres/migrator`, D2) and a transaction helper that passes `tx` to domain services (D3). Extend the `Dockerfile` so the production image contains the SQL migrations and a compiled migrate entry point that runs without pnpm or dev dependencies (`tech-stack.md` §3 rule 8). Define the tables `users`, `master_data`, `templates`, `settings`, `audit_log`, `job_runs` and `rate_limits` from `ats-project-scope.md` §7 with its conventions (UUID keys, `created_at`/`updated_at`, text enums with check constraints, indexed foreign keys, the `NULLS NOT DISTINCT` unique and the partial unique index on templates). Set up Vitest integration tests in `tests/integration/**`, run by `pnpm test:integration` (not by `pnpm verify`), against the Compose PostgreSQL (never mocks, D9) with a database reset per test worker (T2), and add a `postgres:17` service container to `ci.yml` that runs them on every pull request (§12, G7).

**Depends on:** 4

**Done when:**
- `pnpm db:migrate` creates the tables on an empty PostgreSQL 17 database, and a second run is a no-op; `docker compose run --rm app <migrate command>` does the same from the production image.
- Integration tests prove: the `master_data` unique constraint rejects a duplicate `(type, NULL, code)`; a second active `EMAIL` template with the same `trigger_status` is rejected; an unknown `users.role` is rejected.
- Integration tests run in parallel workers without interfering with each other.
- `ci.yml` runs `pnpm test:integration` against a `postgres:17` service container; a failing integration test turns the pull-request check red.

## 6. Recruiting tables ✅

**Issue:** [#11](https://github.com/mikolajniezbecki-bit/ats-app/issues/11)

**Goal:** All remaining recruiting tables from the data model exist with their constraints.

**Description:** Add Drizzle schema and migrations for `requisitions` (including `req_number_seq` and the `REQ-00001` default), `requisition_history`, `prescreen_questions`, `applications`, `prescreen_answers`, `application_history`, `files` (including the nullable `original_name`), `interviews`, `interview_participants`, `interview_scorecards`, `offers`, `approval_events` and `email_log`, exactly as in `ats-project-scope.md` §7. Add the optimistic-locking update helper for `applications` and `requisitions` (`WHERE version = :v`, increment `version`, D7) that fails with "This record was changed by someone else. Reload and try again."

**Depends on:** 5

**Done when:**
- Migrations apply cleanly; generated SQL is committed.
- Integration tests prove: `req_number` is generated as `REQ-00001`, `REQ-00002`; the `applications` check rejects a NULL email unless `anonymized_at` is set; the `offers` check rejects a NULL `approver_id` unless `approval_status` is `DRAFT` or `WITHDRAWN`.
- `D7:` test: an update with a stale `version` fails with the message above and changes nothing.

## 7. Transactional job queue adapter ✅

**Issue:** [#12](https://github.com/mikolajniezbecki-bit/ats-app/issues/12)

**Goal:** Background jobs are created and cancelled inside the same database transaction as the business change.

**Description:** Define the `JobQueue` interface (`enqueue`, `cancel`) and implement it with pg-boss 12 as the only module importing pg-boss (J4). `send` and `cancel` use `fromDrizzle(tx, sql)` so that a rollback removes the job (J1, J2), with a small `executeSql` fallback if the types don't match. pg-boss shares the D5 pool, and job payloads hold IDs only (J4). Create the four queues from `tech-stack.md` §5 with their retry and singleton options in an idempotent `ensureJobQueues()` that `db:migrate`, the integration-test setup and app start all call; it updates retry options of existing queues and fails loudly on a policy change (J5). This covers Sprint 0 proofs #1 and #2.

**Depends on:** 6

**Done when:**
- `D4:` / `J1:` integration test: a status change plus `enqueue` in one transaction leaves no job after rollback and one job after commit.
- `J2:` integration test: a delayed `email.send` job is cancelled inside a transaction, and stays queued if that transaction rolls back.
- `J5:` test: running queue setup twice succeeds and all four queues exist afterwards.

## 8. In-process worker startup ✅

**Issue:** [#13](https://github.com/mikolajniezbecki-bit/ats-app/issues/13)

**Goal:** Job handlers start with the web app, and the build never needs a database or secrets.

**Description:** Add `instrumentation.ts` that runs only when `NEXT_RUNTIME === 'nodejs'` and not during the production build, calls `getConfig()`, starts pg-boss, ensures the queues and registers handlers only when `WORKER_ENABLED === 'true'` (W1). Handlers live in `src/worker` with a standalone `pnpm worker` entry point (W2), stop gracefully on SIGTERM (W6), and tests can process all due jobs synchronously through a helper (J7). This covers Sprint 0 proof #3.

**Depends on:** 7

**Done when:**
- `W1:` test: `next build` succeeds with no database reachable and no secrets set.
- `W1:` test: with `WORKER_ENABLED=false` no handlers are registered; with `true` a job on a test-only queue is processed; a missing required variable stops startup.
- `pnpm worker` starts, always registers handlers (regardless of `WORKER_ENABLED`) and stops gracefully on SIGTERM. Processing a real job moves to task 9, where the first handlers exist; until then tests use a test-only queue they create themselves.
- Startup exits non-zero when PostgreSQL is unreachable.

## 9. Hourly tick and daily tasks ✅

**Issue:** [#14](https://github.com/mikolajniezbecki-bit/ats-app/issues/14)

**Goal:** An authenticated tick endpoint runs daily tasks once per day and drains due jobs, testable with a fake clock.

**Description:** Implement `POST /api/internal/tick` protected by `x-tick-secret` (W4): it queues each daily task (`approvals.remind` after 08:00, `retention.purge` after 02:00 Europe/Warsaw, stub handlers for now) that has no `job_runs` row for today's Warsaw date (W5), then polls every second until no due job remains or 180 s pass. Add the Europe/Warsaw run-date helper (DST-safe) and the test clock `TEST_NOW`, sent as the `x-test-now` header on the tick (and a `now` option on the J7 helper) and honoured only when `AUTH_DEV_LOGIN=true`. It drives the due check, run date and the `now` in daily task payloads, and its clock shift makes due delayed jobs run immediately via one function in the job adapter (T3). With `WORKER_ENABLED` off the tick doesn't wait; a failed daily task runs again the next day (W4, W5). This covers Sprint 0 proof #4.

**Depends on:** 8

**Done when:**
- `W4:` tests: a wrong or missing secret returns 401; a tick queues due daily tasks, waits for due jobs, ignores future-dated jobs and returns 200.
- `W5:` tests: two overlapping ticks run a daily task only once; the Warsaw run date is correct around both DST changes.
- A test shows a job delayed by 24 h runs on a tick with `x-test-now` 25 h ahead, and `TEST_NOW` is ignored when `AUTH_DEV_LOGIN` is not `true`.
- `pnpm worker` processes a queued daily-task job (moved from task 8).

## 10. Staff sessions and dev sign-in ✅

**Issue:** [#16](https://github.com/mikolajniezbecki-bit/ats-app/issues/16)

**Goal:** Staff can sign in locally and in CI with real database sessions, and every request knows the current user and role.

**Description:** Configure Better Auth with the Drizzle adapter: map its `user` model to `users` with `role` and `is_active` as fields not settable through the auth API, UUID IDs, and generate the `session`, `account` and `verification` tables into the Drizzle schema (AU10). Enable `emailAndPassword` with `disableSignUp` only when `AUTH_DEV_LOGIN=true` (AU7), use 8 h sliding database sessions with secure cookies (AU6), refuse sessions for inactive users and reload role and `is_active` on every request (AU5). Add a sign-in page, a server helper that returns the current user, `proxy.ts` that only checks cookie presence (§3 rule 6) and never redirects public routes such as `/api/internal/tick` (it has its own secret, W4), the career pages or `/api/health` to sign-in, and Playwright sign-in state saved per role (T4). Also set up the serial `time-travel` Playwright project for specs that send `x-test-now`, with the `pnpm verify` check that keeps `x-test-now` inside `tests/e2e/time-travel/**` (T2).

**Depends on:** 6

**Done when:**
- `AU7:` Playwright test: a dev user signs in, a session row is created and later requests are authenticated; the password sign-in endpoint is unavailable when `AUTH_DEV_LOGIN` is not `true`.
- `AU5:` tests: an inactive user cannot sign in; a role change applies on the next request without signing in again.
- `AU6:` test: the session cookie is HTTP-only, Secure and SameSite=Lax with an 8 h expiry; `AU10:` test: sign-up and setting `role` through the auth API are refused.
- `POST /api/internal/tick` without a session is not redirected to sign-in.
- The `time-travel` Playwright project runs with one worker after the parallel projects; a unit-tested check fails when a spec outside `tests/e2e/time-travel/**` sends `x-test-now`.

## 11. Microsoft Entra ID sign-in ✅

**Issue:** [#17](https://github.com/mikolajniezbecki-bit/ats-app/issues/17)

**Goal:** Staff sign in with Entra accounts from the project tenant, but only if an Admin created them first.

**Description:** Add the Better Auth Microsoft provider for the single project tenant with redirect `{BETTER_AUTH_URL}/api/auth/callback/microsoft` (AU1), `disableImplicitSignUp` and the message "Access not granted, contact your ATS admin." for unknown or inactive users (AU2), `mapProfileToUser` with the `preferred_username` fallback and `image = null` (AU3), and account linking with `trustedProviders: ['microsoft']` (AU4). Document the owner's one-time Entra setup (`tech-stack.md` §4) in the README; the manual check in Azure (Sprint 0 proof #6) happens during deployment.

**Depends on:** 10

**Done when:**
- `AU1:` test: the provider is configured with the project tenant ID and the expected redirect URI.
- `AU2:` test with a simulated provider profile: an email with no active user is refused with the message above and no user row is created.
- `AU3:` unit tests: email falls back to `preferred_username`, is lower-cased, and `image` is null; `AU4:` test: the first sign-in links to the pre-created user, later sign-ins match on the Entra account ID.

## 12. Policy module, back-office shell and first Admin ✅

**Issue:** [#18](https://github.com/mikolajniezbecki-bit/ats-app/issues/18)

**Goal:** All authorization goes through one policy module, and an environment can get its first Admin.

**Description:** Implement `can(user, action, resource)` in `src/server/policy` plus the pattern for reusable row-level query filters (V9, D6), covering role-level permissions and V1 (Admin full access) and V2 (Recruiter sees all requisitions, applications, scorecards and offers). Add the back-office layout with role-aware navigation and a 403 page. Add `pnpm seed:admin --email <upn>` to create an active Admin with `email_verified = true` (AU8).

**Depends on:** 10

**Done when:**
- `V1:` / `V2:` policy and row-filter tests, plus a handler-level guard test; Hiring Manager and Interviewer get a real HTTP 403 on `/admin`. No Admin-only API exists yet, so the T5 API checks are in task 14 (Admin) and task 20 (Recruiter V2).
- `seed:admin` on an existing user promotes and reactivates them and writes `ADMIN_SEEDED`.
- `AU9:` test: a signed-in user with no matching permission is denied by the policy module even though authenticated.
- `seed:admin` creates the Admin, and running it again creates no duplicate.

## 13. File storage and secure PDF viewing ✅

**Issue:** [#19](https://github.com/mikolajniezbecki-bit/ats-app/issues/19)

**Goal:** PDFs are validated, stored privately and viewed inline through short-lived signed links.

**Description:** Implement `StorageService` (`upload`, `delete`, `getSignedUrl` with a 5-minute default) on `@azure/storage-blob`, using account-key SAS for Azurite and a user delegation key with managed identity in Azure (`tech-stack.md` §8), random UUID keys in the private `files` container (F4), and SAS headers `rsct=application/pdf`, `rscd=inline` (F5). With Azurite, signed links use the browser-facing `AZURE_STORAGE_PUBLIC_URL` when set (`http://localhost:10000` in Compose) while the app itself talks to `http://azurite:10000` (`tech-stack.md` §8). Add a PDF upload validator (PDF only, `%PDF-` signature, no encrypted PDFs, `MAX_UPLOAD_MB`, F1–F3), a viewer page `/files/[id]` and `GET /api/files/[id]/url` (Admin and Recruiter only for now), the nonce-based CSP with `frame-src` limited to the Blob origin and `nosniff` set by `proxy.ts` (§3 rule 6), the typed `getSetting()` reader with §5.1 defaults, and `GET /api/health` checking database and storage (M5).

**Depends on:** 4, 12

**Done when:**
- `F5:` test: a signed link returns `Content-Type: application/pdf` and `Content-Disposition: inline`; the viewer page's `frame-src` is the configured browser-facing endpoint, never `*` or the Compose-internal `azurite` host. A signed link created by the `app` container in Compose opens from the host. `V11:` test: links expire after 5 minutes and are issued only after a policy check.
- `F1:`, `F2:`, `F3:` tests: a renamed non-PDF, an oversize file and an encrypted PDF are rejected; `F4:` test: an anonymous request to the blob fails.
- `/api/health` returns 200 when database and storage are reachable and 503 otherwise.

## 14. Settings and master data administration ✅

**Issue:** [#20](https://github.com/mikolajniezbecki-bit/ats-app/issues/20)

**Goal:** Admins maintain settings, Departments, Locations, Legal Entities and picklists.

**Description:** Build Admin pages and server actions for the settings in `ats-project-scope.md` §5.1 (Zod-validated, each change written to `audit_log` as `SETTING_CHANGED` with IDs only) and CRUD for master data of type `DEPARTMENT`, `LOCATION`, `LEGAL_ENTITY` and `PICKLIST`. Records that are referenced can only be deactivated, never hard-deleted, and inactive records are not offered in pickers. Add `getRetentionDays()` as the single reader of `RETENTION_DAYS`.

**Grooming notes:** show the "Default" marker for a missing setting row or one with `updated_by IS NULL` (§5.1).

**Depends on:** 12, 13 (`getSetting()`)

**Done when:**
- An Admin changes a setting; the new value is used and an `audit_log` row without personal data exists.
- A referenced master data record cannot be deleted but can be deactivated, after which it no longer appears in picker APIs.
- Non-Admin users get 403 from the settings and master data APIs: the first T5 API check of the task 12 guard.

## 15. User management ✅

**Issue:** [#21](https://github.com/mikolajniezbecki-bit/ats-app/issues/21)

**Goal:** Admins create users, change roles and deactivate users.

**Description:** Build the Admin user pages: create a user (lower-cased email, name, exactly one role, `email_verified = true`), edit the name, change role, reactivate (`USER_REACTIVATED`), and deactivate, which deletes all of the user's sessions and writes `USER_DEACTIVATED` to `audit_log` (`ats-project-scope.md` §5.1). Add the lock-out guards (no self role change or self-deactivation; the last active Admin stays) and a reusable user-picker query that returns active users only, optionally filtered by one or more roles (§5.1). The guard that blocks deactivating a user who is approver of a pending item (A5) is added with approval reassignment.

**Depends on:** 12

**Done when:**
- An Admin creates a user who can then sign in with dev sign-in after the test sets a dev password with the task 10 helper (there is no password UI); a duplicate email is rejected.
- Deactivating a signed-in user ends their session on the next request.
- The user-picker API returns only active users, filtered by role when asked.

## 16. Templates and token resolution ✅

**Issue:** [#22](https://github.com/mikolajniezbecki-bit/ats-app/issues/22)

**Goal:** Admins manage requisition, email and offer templates, and tokens resolve safely.

**Description:** Build Admin CRUD for `REQUISITION` templates (custom-field `schema_json` validated by Zod), `EMAIL` templates (subject, body, optional `trigger_status`) and `OFFER` templates, unique by (type, name) and loaded through `resolveTemplate(type, name)` (`ats-project-scope.md` §5.1). Implement the token resolver for the 13 `[[TOKEN]]` placeholders with HTML escaping, where an unknown token is an error and never output as raw text.

**Depends on:** 14

**Done when:**
- Unit tests: every listed token resolves; values are escaped; an unknown token throws.
- Saving a second active `EMAIL` template with an existing `trigger_status` shows a validation error instead of a database error.
- A `schema_json` field of type `PICKLIST` without `picklist_key` is rejected.

## 17. Base seed ✅

**Issue:** [#23](https://github.com/mikolajniezbecki-bit/ats-app/issues/23)

**Goal:** `pnpm db:seed` sets up any environment with defaults, templates, master data and demo users.

**Description:** Implement an idempotent, non-destructive seed (D8) that inserts only missing records by natural key: settings defaults, master data, a requisition template, the `APPLIED` and `REJECTED` stage emails, the bulk-email templates "Application update" and "Interview preparation", a default offer letter, and four demo users (one per role). Dev passwords are created only when `AUTH_DEV_LOGIN=true`. Synthetic requisitions and applications are added in a later task. Like `db:migrate` (task 5), `db:seed` and `seed:admin` (task 12) get compiled entry points in the production image, so the Azure `db-seed` job runs them from the same image (`tech-stack.md` §3 rule 8, D8, G5).

**Grooming notes:** the seed reuses `ensureDevUser()` from task 10. How demo-user dev passwords are provided is not yet specified, and the `AGENTS.md` exception covers `docker-compose.yml` only; settle this when grooming.

**Depends on:** 15, 16

**Done when:**
- Running the seed twice produces the same row counts.
- A setting and a template changed by an Admin are not overwritten by a rerun.
- With `AUTH_DEV_LOGIN` not `true`, no passwords are created; with `true`, each demo user can sign in.
- `docker compose run --rm app <seed command>` and `<seed:admin command> --email admin@example.com` succeed from the production image.

## 18. Email service and delivery job ✅

**Issue:** [#24](https://github.com/mikolajniezbecki-bit/ats-app/issues/24)

**Goal:** Every email is built in full, logged, and sent to Mailpit or captured in the Outbox.

**Description:** Implement `EmailService` that builds the complete message (From `SENDER_EMAIL`, Reply-To = current active recruiter or `FALLBACK_REPLY_TO_EMAIL`, optional Cc, HTML and text body, `.ics` and PDF attachments) with Nodemailer → Mailpit (`SENT`) or Outbox (`CAPTURED`) transport (E1–E4, E6, `tech-stack.md` §9). Emails are queued in the business transaction as `email.send` jobs with an optional delay and a `QUEUED` `email_log` row holding the `job_id`; the handler is idempotent (J3) and retries with backoff before marking `FAILED` (E5). Candidate emails include the recruiter footer (E3); add a Mailpit API helper for tests.

**Depends on:** 9, 13, 16

**Done when:**
- `E1:`, `E2:`, `E3:` tests read Mailpit: sender, Reply-To (falling back when the recruiter is inactive) and footer are correct.
- `E4:` / `E6:` tests: `email_log` holds the full content; status is `SENT` with `smtp` and `CAPTURED` with `outbox`.
- `E5:` test: a failing transport is retried and ends as `FAILED`; `J3:` test: running the handler twice sends the email once.

## 19. Admin Outbox and background-job pages ✅

**Issue:** [#25](https://github.com/mikolajniezbecki-bit/ats-app/issues/25)

**Goal:** Admins can inspect captured emails and background jobs.

**Description:** Build `/admin/outbox` listing messages with recipient, subject, status, time and application link, showing the HTML body in a sandboxed iframe without scripts, with `.ics` download through `GET /api/admin/outbox/[id]/ics` and PDF attachments through signed links (`tech-stack.md` §9). Build the jobs page listing queued, active and failed jobs per queue and the last 30 days of `job_runs` (J6). Both are Admin-only through the policy module.

**Depends on:** 18

**Done when:**
- An Admin sees a captured email with its body, `.ics` and PDF attachment (Sprint 0 proof #8, local part).
- The iframe has a `sandbox` attribute without `allow-scripts`; the `.ics` route returns `text/calendar; charset=utf-8` as an attachment.
- Non-Admin users get 403 from the Outbox page, the `.ics` route and the jobs page.

## 20. Requisition drafting

**Issue:** [#26](https://github.com/mikolajniezbecki-bit/ats-app/issues/26)

**Goal:** Recruiters and Hiring Managers create and edit draft requisitions.

**Description:** Build the requisition list and form: create from a template, blank, or by duplicating an existing requisition, with all fields from `ats-project-scope.md` §7 and custom fields validated against the template's `schema_json`. Generate a 32-hex `private_slug` on save for `PRIVATE` postings (L9), write every state and L2-field change to `requisition_history` (L11), use optimistic locking, and warn on the page when the recruiter or hiring manager is inactive. The list respects visibility: Hiring Managers see only requisitions where they are hiring manager, approver or creator (V3a).

**Grooming notes:** includes the Recruiter `V2:` API test moved from task 12. The form keeps showing a currently selected master data record or user that is now inactive. Check that each master data foreign key points to a record of the right type.

**Depends on:** 13, 15, 16

**Done when:**
- A new requisition gets the next `req_number` in `DRAFT`; duplicating copies the fields with a new number.
- `L9:` test: saving a `PRIVATE` requisition without a slug generates 32 random hex characters; `L11:` test: field changes are recorded in history.
- `V3:` API test: a Hiring Manager's list contains only requisitions in their scope.

## 21. Pre-screening questions and scoring

**Issue:** [#27](https://github.com/mikolajniezbecki-bit/ats-app/issues/27)

**Goal:** Requisitions carry pre-screening questions that are scored consistently.

**Description:** Build the question editor per requisition for `YES_NO`, `SINGLE`, `MULTI` and `TEXT` questions with options, weight, scoring answer, disqualifying answer, order and active flag. Implement the pure scoring function for S1–S4 (points per answer, total score, disqualification). Once any application has answered a question, it cannot be deleted and its scoring-relevant fields cannot change, but it can be deactivated and new questions can be added (L3).

**Depends on:** 20

**Done when:**
- `S1:`–`S4:` unit tests cover text, yes/no, single and multiple choice scoring, disqualification and totals over active questions only.
- `L3:` test: an answered question cannot be deleted or have its weight changed, but can be deactivated.
- A `TEXT` question is always saved with weight 0 and no scoring or disqualifying answer.

## 22. Requisition first approval

**Issue:** [#28](https://github.com/mikolajniezbecki-bit/ats-app/issues/28)

**Goal:** A draft requisition goes through single-step approval with segregation of duties.

**Description:** Implement submit (submitter picks an active Hiring Manager or Admin as approver, A1; approver must differ from submitter, A2), approve or reject with required reject comment (A3, first-approval branch: approve sets `APPROVED`, `approved_at`, `is_published = true`; reject returns to `DRAFT`), and withdraw (A9). Write every event to `approval_events` (A7), send the approval-request email to the approver (E7), add a "My approvals" page, and block all edits while a requisition is in first-approval `PENDING_APPROVAL` (L8).

**Grooming notes:** add the A2 and current-approver condition to the `approval.decide` policy action from task 12. submit requires a non-empty description. The approval request email is a code-built text sent with `audience = STAFF` and `requisition_id`. The L8 lock also covers pre-screening questions.

**Depends on:** 18, 20

**Done when:**
- `A1:` / `A2:` tests: only active Hiring Managers or Admins can be picked, and a submitter (even an Admin) can never be their own approver.
- `A3:` tests: approve publishes the requisition; reject without a comment fails, with a comment returns it to `DRAFT`. `A9:` test: withdraw returns it to `DRAFT`.
- `A7:` test: each action writes an `approval_events` row; `E7:` test: the approver receives the request email.
- `L8:` test: editing a requisition in first-approval `PENDING_APPROVAL` is refused.

## 23. Public job board and job pages

**Issue:** [#29](https://github.com/mikolajniezbecki-bit/ats-app/issues/29)

**Goal:** Candidates browse published external jobs and open private postings by link.

**Description:** Build server-rendered (`force-dynamic`) `/jobs` with keyword search and Location and Department filters, listing requisitions where `posting_type = 'EXTERNAL' AND is_published = true`, plus job detail pages (`ats-project-scope.md` §5.3). Private postings are reachable only at `/jobs/p/{private_slug}`, carry `noindex`, and are excluded from the list, search and `sitemap.xml`. Unpublished jobs show "This position is no longer accepting applications."; pages are mobile-friendly, keyboard-navigable and meet WCAG 2.1 AA contrast.

**Grooming notes:** the Location and Department filters come from published requisitions (which can reference deactivated records), not from the picker API. sanitize `description_html` again when rendering; `/jobs/p/{slug}` serves Private postings only.

**Depends on:** 22

**Done when:**
- The board shows only external, published requisitions, and search and filters narrow the list.
- A private posting opens via its slug with a `noindex` tag and does not appear in the list or the sitemap.
- An unpublished job page shows the "no longer accepting applications" message and no form.

## 24. Quick Apply

**Issue:** [#30](https://github.com/mikolajniezbecki-bit/ats-app/issues/30)

**Goal:** Candidates apply without an account and the application is scored and acknowledged.

**Description:** Build the single-page Quick Apply form (name, email, phone, required PDF CV, optional cover letter, active pre-screening questions, privacy consent showing the current statement) with server-side Zod validation and the PDF upload rules (`ats-project-scope.md` §5.3). On submit, in one transaction: compute `email_hash` (HMAC-SHA-256 with `EMAIL_HASH_KEY`), store files and answers, score them (S1–S4), and create the application as `APPLIED` with the acknowledgement email, or as `REJECTED` with `reason_code = DISQUALIFIED` and the rejection email delayed by `REJECTION_EMAIL_DELAY_HOURS`. Record source, consent timestamp and version, and reject a duplicate from the same `email_hash` for the same requisition within 24 h (F7).

**Grooming notes:** add the F2 browser-side size check. The upload path must accept two files of up to 10 MiB plus overhead: raise the Next.js server-action body limit (1 MB by default) and the `proxy.ts` body limit accordingly. decide which questions must be answered; lock the questions `FOR SHARE` while scoring and reject the submission if the question set changed meanwhile; stage emails go through `getStageTemplate` and `queueTemplateEmail` (task 18).

**Depends on:** 21, 23

**Done when:**
- A Playwright journey applies to a job; the application is `APPLIED` with consent recorded and the acknowledgement appears in Mailpit.
- A disqualifying answer creates a `REJECTED` application with a queued rejection email scheduled after the delay.
- `F7:` test: a second application within 24 h shows "You have already applied for this position."; a unit test shows `email_hash` is 64 lowercase hex characters of the trimmed, lower-cased email.

## 25. Apply anti-spam

**Issue:** [#31](https://github.com/mikolajniezbecki-bit/ats-app/issues/31)

**Goal:** The apply endpoint is protected by CAPTCHA, a honeypot and a per-IP rate limit.

**Description:** Add a `CaptchaService` adapter for Cloudflare Turnstile (official test keys locally and in CI), a hidden honeypot field, and a limit of 5 submissions per IP per hour counted in `rate_limits` (F6). Resolve the client IP with one helper: `x-envoy-external-address`, otherwise the last `x-forwarded-for` entry, otherwise `127.0.0.1`; never the first entry (`tech-stack.md` §3 rule 9). With `AUTH_DEV_LOGIN=true` the limit is bypassed unless the request sends `x-enforce-rate-limit: true`.

**Grooming notes:** add the Turnstile origin `https://challenges.cloudflare.com` to the CSP `script-src` and `frame-src` (task 13).

**Depends on:** 24

**Done when:**
- `F6:` test: with `x-enforce-rate-limit: true`, the sixth submission from one IP within an hour is refused.
- A filled honeypot or failed Turnstile check refuses the submission without creating an application.
- Unit tests for the IP helper cover each header case and show a client-set first `x-forwarded-for` entry is ignored.

## 26. Pipeline status transitions

**Issue:** [#32](https://github.com/mikolajniezbecki-bit/ats-app/issues/32)

**Goal:** Recruiters move applications through the fixed pipeline with full history and correct emails.

**Description:** Implement the domain transition service for the statuses in `ats-project-scope.md` §5.4: open ↔ open moves (R1), open → `REJECTED`/`WITHDRAWN` (R2; `HIRED` stays blocked unless an accepted offer exists), reopen with comment while the requisition is `APPROVED` or in re-approval (R3), cancelling the application's queued emails in the same transaction (R7), history (R8), optimistic locking (R9) and `dispositioned_at` (R11). A status change sends an email only when an active template has that `trigger_status` (E8, with the `REJECTED` email delayed), and moving to `INTERVIEW` or `OFFER` sends nothing (E9). Only Recruiters and Admins may change status.

**Grooming notes:** R7 uses `JobQueue.cancel` plus `email_log.status = CANCELLED` (J2); E8 goes through `getStageTemplate`.

**Depends on:** 24

**Done when:**
- `R1:`, `R2:`, `R3:` unit tests cover the transition table, including a reopen without comment being refused.
- `R7:` test: rejecting then moving back cancels the delayed rejection email in the same transaction; `R8:` / `R11:` tests: history rows and `dispositioned_at` are set and cleared correctly.
- `E8:` / `E9:` tests: `REJECTED` queues a delayed email, `INTERVIEW` and `OFFER` send nothing; `R9:` test: a stale update fails with the reload message.
- A Hiring Manager calling the status-change API gets 403.

## 27. Recruiter workbench

**Issue:** [#33](https://github.com/mikolajniezbecki-bit/ats-app/issues/33)

**Goal:** Recruiters review applications and their full history in one place.

**Description:** Build the application list per requisition with status, pre-screening score and grouping by `email_hash` (never merged), and the application detail page with inline CV and cover letter viewer, pre-screening answers, a status-change control with optional comment, and a chronological timeline of status history, emails (with a warning for `FAILED` ones), interviews, scorecards and offers (`ats-project-scope.md` §5.4).

**Grooming notes:** the application page is `/applications/[id]` (the Outbox links there); the timeline shows email entries and the E5 `FAILED` warning.

**Depends on:** 26

**Done when:**
- Two applications with the same email on different requisitions appear grouped, not merged.
- The CV opens inline from the detail page through a signed link.
- The timeline lists status changes and emails in order, and a `FAILED` email shows a warning on the application.

## 28. Bulk actions

**Issue:** [#34](https://github.com/mikolajniezbecki-bit/ats-app/issues/34)

**Goal:** Recruiters move or email several applications at once with a per-application result.

**Description:** Add selection to the application list with two bulk actions: move status, and send a templated email using only active `EMAIL` templates with `trigger_status IS NULL`, sent as-is with tokens resolved (`ats-project-scope.md` §5.4). Each application is validated individually against the pipeline rules and the result (success or reason) is reported per application.

**Grooming notes:** bulk email uses `listActiveTemplates({ bulk: true })`; token or send errors are reported per application. call the task 26 status service once per application, each in its own transaction, so one failure doesn't roll back the rest; reuse `checkTransition` to report a reason per application.

**Depends on:** 27

**Done when:**
- A bulk move over valid and invalid applications moves the valid ones and reports a reason for each failure.
- The bulk email picker lists only active templates without `trigger_status`; each recipient's email has its tokens resolved and is logged.
- Bulk actions are unavailable to Hiring Managers and Interviewers at API level.

## 29. Requisition hold, resume, close, reopen and publishing

**Issue:** [#35](https://github.com/mikolajniezbecki-bit/ats-app/issues/35)

**Goal:** Approved requisitions can be paused, resumed, closed and reopened with correct paused time and side effects.

**Description:** Implement free edits while `APPROVED`, `ON_HOLD` or in re-approval (L1), hold (L4: unpublish, set `on_hold_since`), resume (L5: add hold time to `paused_days` with 2 decimals, republish), manual close with `close_reason = CANCELLED` and comment (L6: add any hold time, reject open applications with `REQ_CANCELLED` and the rejection email, mark non-final offers `WITHDRAWN`, unpublish, set `closed_at`), and Admin-only reopen with comment (L7: add closed time to `paused_days`, clear close fields, republish, no automatic restoration of applications). Recruiters can unpublish and republish manually while `APPROVED` (L9); every change is in `requisition_history`.

**Grooming notes:** L6 close rejects open applications through the task 26 service internals (R7, R8, R11, E8) with `REQ_CANCELLED`; L1 free edits keep the first-approval lock from task 22; add hold and close checks against the job board.

**Depends on:** 26

**Done when:**
- `L4:` / `L5:` tests: hold unpublishes; resume adds the hold time to `paused_days` and republishes.
- `L6:` test: closing an `ON_HOLD` requisition adds hold time, rejects open applications with `REQ_CANCELLED`, queues rejection emails and withdraws non-final offers.
- `L7:` test: only an Admin can reopen; closed time is added to `paused_days` and rejected applications stay rejected.
- `L1:` / `L9:` tests: free-edit fields save without approval while `APPROVED`; manual unpublish/republish works only while `APPROVED`.

## 30. Requisition re-approval

**Issue:** [#36](https://github.com/mikolajniezbecki-bit/ats-app/issues/36)

**Goal:** Material changes to a live requisition go through re-approval without stopping the pipeline.

**Description:** From `APPROVED`, increasing `openings_count` or changing department, hiring manager or legal entity saves the old values in `previous_l2_values_json`, applies the change and starts a new approval (L2); the posting stays published and applications keep flowing. Approval clears the saved values and keeps the original `approved_at`; rejection or withdrawal restores the saved values and returns to `APPROVED` (A3, A9). The four fields are locked outside `DRAFT` and `APPROVED`; decreasing openings needs no approval, can't go below the hired count, and lowering it to equal the hired count (≥ 1) closes the requisition as `FILLED` in the same transaction.

**Grooming notes:** extend the task 22 approval service for re-approval (`approved_at` set) and remove the 409 it returns for re-approval decisions; re-approval submissions send the same approval email; the L8 full lock applies to first approval only.

**Depends on:** 22, 29

**Done when:**
- `L2:` test: raising openings on an `APPROVED` requisition sets `PENDING_APPROVAL`, stores previous values and keeps it published and open for applications.
- `A3:` / `A9:` re-approval tests: approve keeps `approved_at`; reject and withdraw restore the previous values.
- `L2:` tests: the four fields are refused in `ON_HOLD`, `PENDING_APPROVAL` and `CLOSED`; lowering openings to the hired count closes the requisition as `FILLED`.

## 31. Approval reassignment, deactivation guard and reminders

**Issue:** [#37](https://github.com/mikolajniezbecki-bit/ats-app/issues/37)

**Goal:** Pending approvals can be reassigned, never orphaned, and approvers are reminded.

**Description:** Recruiters and Admins can reassign a pending requisition or offer approval to another eligible approver with a required reason, with segregation of duties enforced (A4). A user who is the approver of any pending item cannot be deactivated, or have their role changed away from Hiring Manager or Admin, until it is reassigned (A5). The daily `approvals.remind` task sends a reminder to the approver, Cc the submitter, when the last `SUBMITTED`, `REASSIGNED` or `REMINDED` event is at least `APPROVAL_REMINDER_DAYS` old (A6).

**Grooming notes:** leave out the Cc when the submitter is inactive; the reminder text comes from `messages/en.json` (system email, §5.1). A4 reassignment updates `approver_id` and sends the approval email to the new approver (E7); the reminder uses the same system-email builder.

**Depends on:** 22

**Done when:**
- `A4:` test: reassignment without a reason fails, to the submitter fails, and with a valid approver writes a `REASSIGNED` event.
- `A5:` test: deactivating a user with a pending approval, or changing their role to Recruiter or Interviewer, is refused, and succeeds after reassignment.
- `A6:` test using the tick and `TEST_NOW`: a reminder is sent after the configured days with the submitter in Cc, recorded as `REMINDED`, and not repeated on the same day.

## 32. Interview scheduling and calendar invites

**Issue:** [#38](https://github.com/mikolajniezbecki-bit/ats-app/issues/38)

**Goal:** Recruiters schedule interviews and every participant receives a correct `.ics` invite.

**Description:** Implement a `CalendarService` `.ics` builder and interview scheduling with start time (UTC), duration, IANA time zone, location or link, status, stable UID and sequence, and participants (I1). Creating sends a separate `METHOD:REQUEST` email to the candidate and each active interviewer listing only that recipient (I2); rescheduling, cancelling and participant changes increment the sequence and send `REQUEST` or `CANCEL` with the same UID (I3–I5). Show staff times in their browser zone, emails in the interview's zone, `.ics` in UTC (I6); flag past interviews as "Awaiting outcome" for `COMPLETED`/`NO_SHOW` (I7); never change the application status (I8); and cancel future `SCHEDULED` interviews when an application reaches a final status (R12).

**Grooming notes:** interview emails are built in code with the interview tokens; `audience` is `CANDIDATE` for the candidate and `STAFF` for interviewers. add R12 as a step in the task 26 status service; R7 cancels queued invites literally; interview timeline entries already read from `interviews` (task 27).

**Depends on:** 27

**Done when:**
- `I1:` / `I2:` Mailpit tests: each recipient gets a separate email whose `.ics` (attachment and `text/calendar` part) lists only them; inactive interviewers are skipped.
- `I3:` / `I4:` / `I5:` tests: reschedule, cancel and participant changes keep the UID and increment the sequence; an added interviewer gets the invite and a removed one a cancellation.
- `I6:` / `I7:` / `I8:` tests: email time is in the interview's zone and `.ics` in UTC; a past interview shows "Awaiting outcome"; scheduling leaves the status unchanged.
- `R12:` test: rejecting an application cancels its future scheduled interviews.

## 33. Scorecards and feedback summary

**Issue:** [#39](https://github.com/mikolajniezbecki-bit/ats-app/issues/39)

**Goal:** Interviewers submit scorecards, and feedback stays hidden until they have given their own.

**Description:** Interviewers submit one scorecard per interview (thumbs up/down, rating 1–5, comments, optional PDF notes) only for a `SCHEDULED` or `COMPLETED` interview that has started (I9). Other interviewers' scorecards are visible only after the viewer has submitted their own and none of theirs is reopened (V7); submitted scorecards are read-only, an Admin can reopen one, and submission is impossible once the application is final (V8). Recruiters and Hiring Managers see the average rating and thumbs count per application (I10).

**Grooming notes:** interview-notes uploads reuse the task 24 browser size check and body-limit approach.

**Depends on:** 32

**Done when:**
- `I9:` test: submitting before the start time or for a cancelled interview fails; a second scorecard for the same interview is refused.
- `V7:` API test: others' scorecards are hidden before own submission and again after an Admin reopens it.
- `V8:` tests: an Admin reopen sets `reopened_at` and clears `submitted_at`; an unsubmitted scorecard can't be submitted after the application is rejected.
- `I10:` test: the summary shows the correct average rating and thumbs counts.

## 34. Hiring Manager and Interviewer visibility

**Issue:** [#40](https://github.com/mikolajniezbecki-bit/ats-app/issues/40)

**Goal:** Hiring Managers and Interviewers see exactly the data their role allows, enforced in the API.

**Description:** Implement the row-level filters and response shaping for V3–V6: Hiring Managers see full application data on requisitions where they are hiring manager, approver or creator, read-only (V3a, V4); Interviewers see only open applications where they are an active participant of a non-cancelled interview, limited to CV, cover letter, contact details, interview details and their own scorecards (V5, V6). Add an Interviewer "My interviews" page. All checks are asserted on API responses (T5); offer-approver access (V3b) is added with offer approval.

**Grooming notes:** fill in the Hiring Manager and Interviewer row filters and the `file.view` policy, which deny by default until now (D6). open the task 27 list and page to Hiring Managers and add V6 shaping in `src/server/applications/` read models; approvers keep V3a access because `approver_id` is kept after the decision. open the application pages to Hiring Managers with the I10 summary and scorecards from the task 33 read model; reuse the Interviewer filter in `scopeScorecardsFor`; staff invite emails link to `/applications/[id]` and "My interviews" links to `/interviews/[id]/scorecard`; a Hiring Manager participant who leaves V3a scope loses access like a removed participant.

**Depends on:** 33

**Done when:**
- `V3:` / `V4:` API tests: a Hiring Manager gets in-scope applications with history and scorecards, 404/403 for others, and 403 on any status change.
- `V5:` API test: an Interviewer loses access after removal, cancellation or a final status.
- `V6:` API test: Interviewer responses never contain salary, offers, pre-screening answers, score, status comments or other applications by the same person.

## 35. Offer drafting

**Issue:** [#41](https://github.com/mikolajniezbecki-bit/ats-app/issues/41)

**Goal:** Recruiters create and manage one active offer per application.

**Description:** Add the offer form (job title, salary, ISO 4217 currency, start date, offer template), allowed only when the application is in `OFFER` (R10) and the requisition is not `ON_HOLD` or `PENDING_APPROVAL` (L8). A new offer may be created only when every earlier offer is `REJECTED`, `WITHDRAWN` or declined, and creating one freezes all earlier offers (`ats-project-scope.md` §5.6). Recruiters and Admins can discard an offer from `DRAFT` or `REJECTED`, which sets it `WITHDRAWN` and writes `OFFER_DISCARDED` to `audit_log`.

**Grooming notes:** add real tests for L6 withdrawing offers (task 29 tests it with inserted offers).

**Depends on:** 30

**Done when:**
- `R10:` test: creating an offer for an application not in `OFFER` is refused.
- `L8:` test: creating an offer while the requisition is `ON_HOLD` or in `PENDING_APPROVAL` is refused.
- A second offer is refused while the first is active; after it is declined, a new offer can be created and the old one is read-only.
- Discarding from `DRAFT` sets `WITHDRAWN` and writes the audit entry; discarding an `APPROVED` offer is refused.

## 36. Offer approval

**Issue:** [#42](https://github.com/mikolajniezbecki-bit/ats-app/issues/42)

**Goal:** Offers go through the same single-step approval as requisitions, including re-approval of changed terms.

**Description:** Reuse the approval flow for offers: submit with approver (A1, A2), approve to `APPROVED` or reject to `REJECTED` with comment (A3), withdraw the request back to `DRAFT` (A9), reassign and remind (A4, A6); submitting and approving are blocked while the requisition is `ON_HOLD` or `PENDING_APPROVAL` (L8). A rejected offer is editable and resubmittable only while it is the latest offer; editing salary, currency or start date of an `APPROVED` offer requires a new approver, sets `PENDING` and clears `sent_at`, and accepted or declined offers are locked (A8). The current offer approver can see that offer, that single application and the requisition header, and loses access on reassignment (V3b).

**Grooming notes:** fill in the offer-approver row filter and `file.view` for V3b, which deny by default until now (D6). add offers to `/approvals` and the `approval.decide` resource rule for offers in the shared approval service (task 22). add the offer adapter for A4/A6, list offers in "All pending approvals" and in the A5 message (requisition number and candidate), lock the approver's user row on offer submit (A5 race); L8 checks cover re-approval too.

**Depends on:** 31, 34, 35

**Done when:**
- `A3:` offer tests: approve sets `APPROVED`; reject with comment sets `REJECTED`, and only the latest rejected offer can be resubmitted.
- `A8:` test: changing the salary of an `APPROVED` offer sets `PENDING` and clears `sent_at`; an accepted offer can't be edited.
- `A9:` offer test: withdrawing the request returns the offer to `DRAFT` with a `WITHDRAWN` approval event.
- `V3:` API test: the approver sees only that application on the requisition and loses access after reassignment.

## 37. Offer letter PDF and offer email

**Issue:** [#43](https://github.com/mikolajniezbecki-bit/ats-app/issues/43)

**Goal:** An approved offer produces a PDF letter that is emailed to the candidate.

**Description:** Build `/src/server/pdf/OfferLetter.tsx` with `@react-pdf/renderer`: A4 layout, bundled Noto Sans, logo from `/public/logo.png`, footer and page numbers (P1, P4, P5), rendering the template body with tokens resolved and escaped (P2) and the supported markup subset (P3). On approval the `offer.render-pdf` job renders and stores an `OFFER_LETTER` file and queues the offer email with the PDF attached (P7); a re-approved offer gets a new file and the old one is kept. Add "Preview PDF" that renders without storing (P6).

**Grooming notes:** reuse the P3 markup parser in `src/server/domain/markup` (task 16) and provide the offer token values. the `offer.render-pdf` handler skips offers a close has set to `WITHDRAWN` (J3).

**Depends on:** 36

**Done when:**
- `P2:` / `P3:` tests: an unknown token fails the render; headings, bold, italic and lists render, other markup appears as plain text.
- `P7:` test: approving an offer stores a PDF file and the candidate receives it as an attachment in Mailpit; re-approval adds a second file.
- `P5:` / `P6:` tests: the logo is embedded in the letter and in `[[LOGO]]` emails; preview stores no file.
- `P8:` test: a text snapshot of the sample letter matches and every token in the default template resolves.

## 38. Candidate response and hiring

**Issue:** [#44](https://github.com/mikolajniezbecki-bit/ats-app/issues/44)

**Goal:** Recruiters record the candidate's answer and hire, with openings enforced and automatic close.

**Description:** Recruiters record `ACCEPTED` or `DECLINED` on a sent offer; a declined offer leaves the application in `OFFER`. Moving to `HIRED` requires an accepted offer (R2), is blocked when hires already equal `openings_count` or the requisition is `ON_HOLD` or `PENDING_APPROVAL` (R5, L8), sets `hired_at`, and when hires reach `openings_count` closes the requisition as `FILLED` in the same transaction, rejecting the remaining open applications (R6). An Admin can correct `HIRED` to `OFFER`, `REJECTED` or `WITHDRAWN` with a comment, clearing `hired_at` without reopening the requisition (R4).

**Grooming notes:** add R5, the L8 hire block, R6 and the R4 Admin correction to `checkTransition` and the status service; `hired_at` is already set (task 26). bulk hires (task 28) inherit R5, R6 and L8; test R6 auto-closing the requisition partway through a batch with the rest reported as refused; R6 reuses `closeRequisition` (task 29) with `FILLED`/`REQ_FILLED`.

**Depends on:** 37

**Done when:**
- `R2:` test: hiring without an accepted offer is refused; with one it succeeds and sets `hired_at`.
- `R5:` test: a hire beyond `openings_count`, or while the requisition is on hold, is refused.
- `R6:` test: the last hire closes the requisition as `FILLED` and rejects other open applications with `REQ_FILLED` in one transaction.
- `R4:` test: only an Admin can correct `HIRED`, a comment is required and `hired_at` is cleared.

## 39. Hire export

**Issue:** [#45](https://github.com/mikolajniezbecki-bit/ats-app/issues/45)

**Goal:** Recruiters export new hires to CSV for hand-off.

**Description:** Build the hire CSV export with the columns in `ats-project-scope.md` §5.6. By default it contains hires not yet exported and not anonymized; `?includeExported=true` adds earlier exports that are not anonymized. Exporting sets `exported_at` only on first export and writes `EXPORT_HIRES` to `audit_log`; only Recruiters and Admins can export (V10).

**Depends on:** 38

**Done when:**
- The default export contains only new hires and sets their `exported_at`; a second default export is empty.
- `includeExported=true` returns earlier exports without changing their `exported_at`; anonymized hires never appear.
- `V10:` test: Hiring Managers and Interviewers get 403 from the export endpoint.

## 40. Data retention purge

**Issue:** [#46](https://github.com/mikolajniezbecki-bit/ats-app/issues/46)

**Goal:** Expired applications are anonymized and their personal data and files removed.

**Description:** Implement the daily `retention.purge` task (RT1–RT5): select final applications past `RETENTION_DAYS` since `dispositioned_at` (hires only after export), null the personal fields, set `anonymized_at`, delete pre-screening answers, clear comments and email content, delete linked files from storage (F8), and clear offer approval comments, in batches with one transaction per application. The same task deletes `rate_limits` rows older than 2 hours.

**Grooming notes:** cancel the application's queued emails before anonymizing (RT4). also deletes `rate_limits` rows older than 2 h (keys `apply:<ip or /64>`, one-minute buckets); anonymized applications already refuse status changes (RT3). include scorecard notes files (`owner_type = SCORECARD`) and queued interview emails in the test. offer approval and reminder emails set `application_id`, so RT4 clears them; include `OFFER_LETTER` files and offer `approval_events` comments in the purge test; check hires corrected by R4 (`exported_at` cleared, no longer `HIRED`). label anonymized applications as "Anonymized applicant" across staff pages.

**Depends on:** 39

**Done when:**
- `RT1:` / `RT2:` tests with `TEST_NOW`: only final applications past the retention period are selected; open and unexported hired applications are skipped.
- `RT3:` / `RT4:` / `F8:` tests: personal fields, answers, comments, email content and files are removed while status, score and offer terms remain.
- `RT5:` test: running the purge twice is safe; old `rate_limits` rows are deleted.

## 41. Reporting dashboard and CSV exports

**Issue:** [#47](https://github.com/mikolajniezbecki-bit/ats-app/issues/47)

**Goal:** Recruiters and Admins see recruiting KPIs and can export requisition and pipeline data.

**Description:** Build the KPI dashboard: open requisitions, active applications per status, average Time to Fill (only `FILLED`), average Time to Hire (`hired_at − applied_at`) and Age of Requisition per open requisition, using the paused-time formulas in L10. Add CSV exports for the requisition list and pipeline data, Recruiter and Admin only (V10).

**Grooming notes:** L10 uses `paused_days` from task 29; re-approval doesn't pause the clock (TO-10). reuse `src/server/exports/csv.ts` (BOM, quoting, formula prefix, V10) for the requisition and pipeline exports on `/exports`. the pipeline CSV handles anonymized rows.

**Depends on:** 38

**Done when:**
- `L10:` unit tests: Time to Fill and Age of Requisition subtract `paused_days` and the current hold correctly.
- The dashboard shows the five KPIs for seeded data.
- Requisition and pipeline CSV exports download for Recruiters and return 403 for other roles.

## 42. Synthetic demo data

**Issue:** [#48](https://github.com/mikolajniezbecki-bit/ats-app/issues/48)

**Goal:** A fresh environment shows a realistic demo with requisitions, applications and files.

**Description:** Extend `pnpm db:seed` (D8) to create synthetic requisitions in several states and applications in every pipeline status, with sample PDF files uploaded through `StorageService`, only when no requisitions exist yet. All data is clearly synthetic (`ats-project-scope.md` C3).

**Grooming notes:** extend the task 17 seed module and keep its rules (D8). seed applications use `computeEmailHash`, set `dispositioned_at` for final statuses, store `prescreen_answers` only for answered questions, and queue no emails. seeded `ON_HOLD` and `CLOSED` requisitions need consistent `on_hold_since`, `closed_at`, `close_reason` and `paused_days`; seeded interviews queue no emails. every seeded `HIRED` application has exactly one `ACCEPTED` offer with `sent_at`; hires per requisition stay within `openings_count` and `FILLED` requisitions match R6; seeded offers have `version` and, unless `DRAFT`/`WITHDRAWN`, an `approver_id`; mix of `exported_at` on hires; seeded offers queue no render jobs or emails.

**Depends on:** 38

**Done when:**
- On an empty database the seed creates requisitions and applications covering every status, with viewable CVs.
- Rerunning the seed adds no synthetic data when requisitions already exist.
- No seeded name, email or phone resembles a real person (uses reserved domains such as `example.com`).

## 43. Main-branch pipeline with end-to-end tests

**Issue:** [#49](https://github.com/mikolajniezbecki-bit/ats-app/issues/49)

**Goal:** Every push to `main` builds one image and runs the full Playwright suite against it.

**Description:** Add `.github/workflows/main.yml` (push to `main` and manual): run `pnpm verify`, build the image once tagged with the commit SHA, start the Compose stack with that image, migrate and seed from that image, run `pnpm test:integration` against the Compose PostgreSQL, run the full Playwright suite with one retry and trace, video and screenshot kept on failure (T6), then push the image to GHCR with `GITHUB_TOKEN` (G2, G4). Deployment steps are added later.

**Grooming notes:** add a Compose app healthcheck on `/api/health` so the workflow waits for the app; run `pnpm test:e2e` (parallel, then `time-travel`); set `E2E_*` overrides only if needed; add an Azurite service wherever integration tests run (task 13 adds it to `ci.yml`). the seed step gets `DEMO_USER_*` from Compose; Mailpit is already in the stack. CI Playwright needs internet access to `challenges.cloudflare.com` (Turnstile test keys, browser and server); `@axe-core/playwright` is a dev dependency. keep the task 37 Playwright preview test in the main suite: it proves the fonts and `/public/logo.png` are in the image. Playwright `forbidOnly`, retries and trace/video/screenshot settings (left over from task 2); the `APP_IMAGE` Compose variable and app healthcheck; GHCR cleanup (10 versions).

**Depends on:** 42

**Done when:**
- A push to `main` runs the workflow green through the Playwright suite and pushes the image tagged with the commit SHA.
- Each step runs only if the previous one succeeded; superseded runs are cancelled.
- A failing Playwright test uploads its trace, video and screenshot as artifacts.

## 44. Azure infrastructure as code

**Issue:** [#50](https://github.com/mikolajniezbecki-bit/ats-app/issues/50)

**Goal:** The whole Azure environment is defined in Bicep and deployable from GitHub.

**Description:** Write `/infra/main.bicep` with every resource in G5: Log Analytics (0.1 GB/day cap, 30-day retention), Container Apps environment, web app (0–1 replicas, Key Vault secret references, user-assigned identity, `APP_ENV=azure`), `tick`, `db-migrate` and `db-seed` jobs, PostgreSQL Flexible Server 17 B1MS with TLS and a least-privilege app login (which still needs rights to create and use the `pgboss` schema, since app start runs `boss.start()` and `createQueue()`, J5), storage with private `files` container, Key Vault, role assignments and the EUR 10 budget alert. Add `infra.yml` (manual: what-if → approval → deploy) authenticating with OIDC on a service principal scoped to the resource group (G3), and document the one-time owner setup including the GHCR classic PAT with `read:packages` only (G9).

**Grooming notes:** use `/api/health` for the readiness and startup probes, not liveness (M5); Bicep creates the `files` container; `MICROSOFT_TENANT_ID` must be the tenant GUID (AU1). the `db-seed` job runs the compiled entry points (no pnpm in the image), sets `DEMO_USER_DOMAIN` to the tenant domain and never sets `DEMO_USER_PASSWORD` or `AUTH_DEV_LOGIN`; `EMAIL_PROVIDER=outbox` is required (§3 rule 10). real Turnstile keys go in Key Vault; `BETTER_AUTH_URL` is used for sitemap URLs and approval-email links. the `db-seed` job gets the storage identity, `EMAIL_HASH_KEY` and the full variable set (task 42's seed needs them); blob soft delete off so task 40's deletions are real; `pgboss` ownership for the app login and `DATABASE_ADMIN_URL` for the `db:migrate` entry point; a compiled tick client entry point; `infra.yml` runs `db-migrate` and the health check after a full deploy.

**Depends on:** 43

**Done when:**
- `az bicep build` succeeds and `infra.yml` shows a what-if, waits for approval, then deploys.
- The deployed resources match G5, including the log cap, budget alert and `APP_ENV=azure` on the app and all jobs.
- No Azure secrets are stored in GitHub; the README documents OIDC and PAT setup with expiry reminders.

## 45. Azure deployment and cloud proofs

**Issue:** [#51](https://github.com/mikolajniezbecki-bit/ats-app/issues/51)

**Goal:** `main` deploys automatically to Azure and the cloud-only proofs pass.

**Description:** Extend `main.yml` after the image push: Azure login with OIDC, run the `db-migrate` job, update the web Container App to the new tag, and smoke-test `GET /api/health`. Run the remaining manual Sprint 0 proofs in Azure (#6 Entra sign-in and refusal, #7 signed links with a user delegation key, #8 Outbox, #9 client IP header) and record the results. Document the rebuild order from an empty resource group (G6) and how to stop the database and the tick job between demos (G10).

**Grooming notes:** this task runs the cloud halves of Sprint 0 proofs #6 and #7, whose local halves are in tasks 11 and 13. also runs the Azure half of the Outbox proof (#8). Sprint 0 proof #9 confirms the header `getClientIp` relies on; check the Turnstile widget on the Azure hostname. update job images on every deploy; the `ipSource` log line in `getClientIp`; check that dev sign-in and `x-test-now` are off in Azure; Key Vault soft-delete and host-name steps in the rebuild procedure.

**Depends on:** 44

**Done when:**
- A push to `main` deploys the tested image and the health smoke test passes.
- Seeded demo users sign in with Entra; an Entra user without an ATS account and a deactivated user are refused.
- A CV opens inline from Azure Blob, a captured email appears in the Outbox, and the confirmed client IP header is recorded in `tech-stack.md`.
- The README documents the rebuild and stop/start procedures.

## 46. Rule coverage close-out

**Issue:** [#52](https://github.com/mikolajniezbecki-bit/ats-app/issues/52)

**Goal:** Every required rule ID has a named test and the full role journeys pass.

**Description:** Fill any remaining gaps so `tests/rules-pending.json` is empty and `pnpm test:rules` enforces T1 with no exceptions, then remove the pending-list mechanism. Add end-to-end journeys for every role covering apply → screen → interview → scorecard → offer → hire → export, approvals and re-approval, hold/close/reopen and purge (`tech-stack.md` §11).

**Grooming notes:** the journeys can reuse the Playwright flows from tasks 22, 24 and 27. also reuse the flows from tasks 29, 30, 32 and 33. also reuse the flows from tasks 34–39 (Hiring Manager read-only view, My interviews, offer create/approve/reject, preview, response, hire, auto-close, export). includes the purge journey with the test clock.

**Depends on:** 45

**Done when:**
- `pnpm test:rules` passes with no pending IDs and fails if any required test title is removed.
- The full journey for each of the four roles passes in Playwright on `main`.
- `ci.yml` and `main.yml` are green.
