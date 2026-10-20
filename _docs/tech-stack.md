# Custom ATS & Career Portal: Technical Architecture

| | |
|---|---|
| **Version** | 1.10 |
| **Date** | 2026-10-20 |
| **Owner** | Mikolaj Niezbecki |
| **Status** | Approved for build |
| **Changes in 1.10** | Tasks 40–46 grooming: synthetic seed rules (D8); backward-compatible migrations (D2); `main.yml` deploy updates job images, never cancels deployments, branch runs don't push (§12, G4); RBAC Administrator with a role condition and `main`-only federation (G3); Bicep stages, logins, storage/Key Vault/PostgreSQL cost-safe settings, compiled job entry points (G5, G6); `DATABASE_ADMIN_URL`, `SEED_ADMIN_EMAIL` (§3); IP source logging (§3 rule 9); budget notifies only (M8); `infra.yml` what-if and deploy as two manual runs (owner decision, §12, TO-21); restart notes (G10); manual proof records (§15) |
| **Changes in 1.9** | Tasks 34–39 grooming: optimistic locking on `offers` (D7); P6 preview rendered on request, not stored (§8); stored letter exempt from the upload limit (P7); fonts committed with their licence (P4); `unpdf` for P8 snapshots (§2) |
| **Changes in 1.8** | Tasks 22–27 grooming: `/sitemap.xml` and `/robots.txt` public (§3 rule 6); Turnstile origin in the CSP on `/apply/**`; 21 MB body limits (§3 rule 7); invalid IP header values ignored, rate-limit key IPv4 or IPv6 /64 (§3 rule 9); `@axe-core/playwright` (§2) |
| **Changes in 1.7** | Tasks 16–21 grooming: `DEMO_USER_PASSWORD` and `DEMO_USER_DOMAIN` (§3, D8, T4); seed rules (D8); app refuses `APP_ENV=azure` without `EMAIL_PROVIDER=outbox` (§3 rule 10); render-then-send email pipeline and Outbox lists every row (§9); `StorageService.download` (§8); read-only job listing SQL allowed (T3); Tiptap and `sanitize-html` (§2); Azurite and Mailpit service containers in `ci.yml` (§12) |
| **Changes in 1.6** | Tasks 10–15 grooming: `proxy.ts` protects every route except a public list, returns 401 JSON on protected APIs and sets the nonce-based CSP (§3 rule 6, §8); Microsoft variables set together with a GUID tenant (§3, AU1); `disableSignUp`, profile mapping, cookie cache off, built-in rate limiter off, self-service endpoints disabled, auth tables follow scope §7 (AU2–AU5, AU7, AU10); `seed:admin` promotes or reactivates (AU8); deny-by-default row filters (D6); `pdf-lib` (§2); Azurite container creation and SAS shape (§8); e2e users, two-step `test:e2e`, Chromium only (T2, T4, §11); health timeouts (M5) |
| **Changes in 1.5** | Tasks 7–9 grooming: pg-boss shares the D5 pool; job payloads hold IDs only; queue setup updates retry options and fails on a policy change (J4, J5, D5, M2); `pnpm worker` always registers handlers, startup exits when PostgreSQL is unreachable (W1, W2); `TEST_NOW` is the `x-test-now` header on the tick (and a `now` option on the J7 helper) and drives the due check, run date and handler "now"; only the clock shift writes to pg-boss tables; tick doesn't wait when the worker is disabled; failed daily tasks rerun the next day (W4, W5, J7, T3); time-travel Playwright specs run serially in their own project (T2) |
| **Changes in 1.4** | Tasks 4–6 grooming: fake local-only values committed in `docker-compose.yml` (§1); browser-facing Azurite endpoint `AZURE_STORAGE_PUBLIC_URL` for signed links and `frame-src` (§3, §8); migrations and seeds run from the production image (§3 rule 8, D2, D8); integration tests in `tests/integration/**` via `pnpm test:integration`, run in `ci.yml` (PostgreSQL 17 service) and `main.yml` (§11, §12, G7) |
| **Changes in 1.3** | Tasks 2–3 grooming: `proxy.ts` also sets `x-request-id` (§3 rule 6, M3); logger reads `LOG_LEVEL` directly as an exception to §3 rule 5; G1 enforced by workflow instead of branch protection (TO-21) |
| **Changes in 1.2** | Task 1 grooming: UI, utility and i18n file locations (§3), test file naming (§11), ESLint, Node version enforced at install (§2), scope of `pnpm verify` vs. `ci.yml` and `main.yml` (G7, T7, §12) |
| **Changes in 1.1** | Decisions from `open-questions.md` (Q1–Q27) applied |

**Purpose of this document:** defines **how** the system is built: architecture, technology choices, technical rules, testing, deployment and operating cost.

**Companion documents**
- `ats-project-scope.md` defines what to build, including all business rules (A, L, S, F, R, I, E, RT, V) and the data model.
- `tradeoffs.md` lists the deliberate limitations of this proof of concept and their upgrade paths.

**Technical rule IDs**

| Prefix | Area | Section |
|---|---|---|
| AU | Authentication | §4 |
| J | Job queue | §5 |
| W | Worker runtime | §6 |
| D | Data access | §7 |
| P | Offer PDF | §10 |
| T | Testing | §11 |
| G | CI/CD & infrastructure | §12 |
| M | Logging & monitoring | §13 |

---

## 1. Architecture Overview

**Guiding principles**
1. One language and one deployable unit, which keeps the coding agent fast and the system simple.
2. Portable by default: the whole stack runs locally with `docker compose up`; Azure-specific code lives only in adapters.
3. Near-zero running cost on a personal Azure subscription (`ats-project-scope.md` C1–C2).
4. Every business rule lives in the server-side domain layer and is covered by a named test.

| Layer | Choice |
|---|---|
| Language | TypeScript (strict mode) |
| Application | **Next.js** (App Router): career portal, back office and API in one app |
| UI | React, Tailwind CSS, shadcn/ui; `next-intl` in single-locale mode (`en` only, `/messages/en.json`, no locale prefix in URLs) |
| Validation | Zod (forms, API input, configuration) |
| Database | PostgreSQL 17 |
| Data access | Drizzle ORM + node-postgres; SQL migrations committed to Git |
| Authentication | **Better Auth** with Microsoft Entra ID (staff); candidates don't sign in |
| Background jobs | pg-boss (queue in PostgreSQL), worker running inside the web app |
| Files | Azure Blob Storage through `@azure/storage-blob` (Azurite locally) |
| Email | Built by the app, captured: Mailpit locally, in-app Outbox in Azure |
| Offer PDF | `@react-pdf/renderer` |
| CAPTCHA | Cloudflare Turnstile (free tier) |
| Hosting | Azure Container Apps (Consumption, scale to zero) |
| Secrets | Azure Key Vault + managed identity; `.env` locally |
| Source & CI/CD | GitHub private repository, GitHub Actions, GitHub Container Registry |
| Infrastructure as code | Bicep |
| Testing | Playwright (end-to-end, primary) + Vitest |
| Logging | pino → Azure Log Analytics (daily cap) |

### Azure topology
```
GitHub Actions ──OIDC──► Resource group (personal subscription)
   │ push image                ├─ Container Apps environment ──► Log Analytics (0.1 GB/day cap)
   ▼                           │    ├─ web Container App (0–1 replicas): Next.js + in-process worker
  GHCR ◄─ pull (token in KV) ──┤    ├─ Container Apps Job "tick" (hourly) ──► POST /api/internal/tick
                               │    ├─ Container Apps Job "db-migrate" (run on each deploy)
                               │    └─ Container Apps Job "db-seed" (manual: db:seed, seed:admin)
                               ├─ PostgreSQL Flexible Server 17, Burstable B1MS (public access, TLS)
                               ├─ Storage account: private Blob container "files"
                               ├─ Key Vault + user-assigned managed identity
                               └─ Budget alert (EUR 10 / month)

Staff ──► Entra ID (personal tenant) ──► web        Candidates ──► web (/jobs, /apply) + Turnstile
```

### Local and CI topology
`docker compose up` starts: `app` (same image as Azure), `postgres:17`, `azurite`, `mailpit`.

| Concern | Local / CI | Azure |
|---|---|---|
| Database | PostgreSQL 17 container | Azure Database for PostgreSQL Flexible Server 17 |
| Files | Azurite (connection string) | Azure Blob (managed identity) |
| Email | SMTP → Mailpit | Outbox (stored in `email_log`) |
| Staff sign-in | Dev sign-in (AU7) | Microsoft Entra ID |
| `APP_ENV` | `local` / `ci` | `azure` (set only in Bicep) |
| Secrets | `.env` (never committed) for `pnpm dev`; the Compose stack uses obviously fake, local-only values committed in `docker-compose.yml` (`AGENTS.md`) | Key Vault references |
| Tick | Called by tests or manually | Hourly Container Apps Job |
| Seed | `pnpm db:seed` | `db-seed` Container Apps Job (manual, G6) |

---

## 2. Versions

| Component | Version |
|---|---|
| Node.js | 24 LTS (`engines.node` in `package.json`; `engine-strict=true` in `.npmrc` makes install fail on another version) |
| Next.js | 16.x |
| React | version required by Next.js 16 |
| TypeScript | 5.x, strict |
| PostgreSQL | 17 (Docker `postgres:17`; Azure Flexible Server 17) |
| pg-boss | 12.x |
| Drizzle ORM / drizzle-kit | latest stable 0.x (no release candidates) |
| Better Auth | latest stable 1.x |
| next-intl | latest stable |
| Playwright / Vitest | latest stable (Playwright runs Chromium only) |
| pdf-lib | latest stable (PDF parsing and encryption check, F3) |
| unpdf | latest stable, dev only (PDF text extraction for P8 snapshots) |
| @axe-core/playwright | latest stable, dev only (accessibility checks) |
| Tiptap / sanitize-html | latest stable (requisition description editor; allowlist sanitizing on save and display) |
| Linter | ESLint with `eslint-config-next` (called directly; Next.js 16 removed `next lint`) |
| Package manager | pnpm (version pinned in `package.json` `packageManager`) |

All dependencies are pinned through `pnpm-lock.yaml` and updated weekly by Dependabot (G8).

---

## 3. Application Structure & Configuration

```
/src
  /app            Next.js routes (career portal, back office, API route handlers)
  /components     React components; shadcn/ui components in /components/ui
  /lib            client-safe helpers (utils.ts: shadcn/ui `cn`)
  /i18n           request.ts (next-intl request config)
  /server
    /domain       business rules (A, L, S, F, R, I, E, RT, V); no framework imports
    /policy       can(user, action, resource) + row-level query filters (V9)
    /db           Drizzle schema, migrations, query helpers
    /adapters     storage, email, calendar (.ics), job queue, CAPTCHA
    /pdf          offer letter component
    config.ts     typed configuration loader
  /worker         pg-boss job handlers + standalone entry point
  proxy.ts        session-cookie presence check + x-request-id (rule 6)
/messages         en.json (next-intl messages)
/infra            Bicep templates
/tests            Vitest specs (**/*.test.ts(x)), fixtures
  /e2e            Playwright specs (**/*.spec.ts)
```

**Rules**
1. No business rules in React components. UI calls domain services through server actions or route handlers.
2. All API input is validated with Zod.
3. Every route that reads the database, including the public career pages, is rendered on the server at request time (`export const dynamic = 'force-dynamic'`). There is no build-time static generation of database content (W1).
4. External services are reached only through the adapter interfaces `StorageService`, `EmailService`, `CalendarService`, `JobQueue` and `CaptchaService`. No SDK imports outside `/server/adapters`.
5. **Configuration** is read through `getConfig()`, which validates all environment variables with Zod **on first call** (not at import time) and caches the result. Startup code calls it immediately, so a missing variable stops the app at start. The production build never needs runtime secrets. **Exception:** the logger reads `process.env.LOG_LEVEL` directly (default `info`), so a configuration error can itself be logged.
6. **`proxy.ts`** (Next.js 16's replacement for `middleware.ts`) does only three things: (a) it checks that the session cookie is present on every route except one public list (`/api/internal/tick`, which has its own secret, W4; `/api/health`; `/jobs/**`; `/apply/**`; `/sitemap.xml`; `/robots.txt`; `/api/auth/**`; the sign-in page; static assets). Without the cookie, pages redirect to sign-in with a `next` parameter that accepts relative paths only, and protected `/api/**` routes return `401` JSON instead of a redirect. (b) It generates a fresh `x-request-id` for every request, replacing any value the client sent, and sets it on the forwarded request and the response (M3). (c) It sets the nonce-based Content Security Policy and `X-Content-Type-Options: nosniff` on HTML pages (§8); on `/apply/**` the CSP also allows `https://challenges.cloudflare.com` in `script-src` and `frame-src` (Turnstile). The CSP is set here because `next.config` headers are fixed at build time, which has no environment. Every page, server action and route handler loads the session and role on the server and authorizes through the policy module. No authorization or role (RBAC) decision is made in `proxy.ts`.
7. `next.config.ts`: `output: 'standalone'`; `serverExternalPackages: ['pg', 'pg-boss', 'pino', '@react-pdf/renderer']`. `experimental.serverActions.bodySizeLimit: '21mb'` and `experimental.proxyClientMaxBodySize: '21mb'` (two files at the 10 MiB maximum of `MAX_UPLOAD_MB` plus form fields; confirm the option name on the installed Next.js version, formerly `middlewareClientMaxBodySize`).
8. One container image runs everything; `pnpm worker` (standalone worker) exists for future scaling but isn't deployed. Besides the standalone server, the image contains the committed SQL migrations and compiled JavaScript entry points for `db:migrate`, `db:seed` and `seed:admin` (runtime dependencies only, no pnpm or `drizzle-kit`), so the Azure `db-migrate` and `db-seed` jobs run the same image (G2, G5).
9. **Client IP and rate limit** (`ats-project-scope.md` F6): one helper resolves the client IP as (1) `x-envoy-external-address` (set by the Container Apps ingress), if present; (2) otherwise the **last** entry of `x-forwarded-for`; (3) otherwise `127.0.0.1` (local). The first `x-forwarded-for` entry is never used, because the client can set it. Counts are stored in the `rate_limits` table. When `AUTH_DEV_LOGIN=true`, the limit is bypassed unless the request sends `x-enforce-rate-limit: true` (used by the `F6:` test), so parallel Playwright tests don't throttle each other. A value that isn't a valid IP address is treated as absent. The rate-limit key is the IPv4 address or the IPv6 /64 prefix. The helper also reports which source it used (`envoy`, `xff-last` or `fallback`); only the source is logged, never the address.
10. **Email safety (C4):** the app refuses to start with `APP_ENV=azure` unless `EMAIL_PROVIDER=outbox`.

**Environment variables** (secrets marked ●; Azure values come from Key Vault)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` ● | PostgreSQL connection string (`sslmode=require` in Azure) |
| `BETTER_AUTH_SECRET` ● | Session signing secret |
| `BETTER_AUTH_URL` | Public base URL of the app |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_TENANT_ID` | Entra app registration; the tenant ID must be a GUID (`common`/`organizations` refused). The three Microsoft variables are set together or not at all (AU1) |
| `MICROSOFT_CLIENT_SECRET` ● | Entra client secret |
| `APP_ENV` | `local`, `ci` or `azure`; `azure` is set only in Bicep (AU7) |
| `AUTH_DEV_LOGIN` | `true` only locally/CI (AU7) |
| `EMAIL_HASH_KEY` ● | HMAC key for `email_hash` |
| `EMAIL_PROVIDER` | `smtp` (local/CI) or `outbox` (Azure; required there, §3 rule 10) |
| `SMTP_HOST`, `SMTP_PORT` | Mailpit (local/CI) |
| `AZURE_STORAGE_CONNECTION_STRING` ● | Azurite only (local/CI) |
| `AZURE_STORAGE_PUBLIC_URL` | Azurite only, optional: browser-facing Blob endpoint (e.g. `http://localhost:10000/devstoreaccount1`) used in signed links and `frame-src` when the app reaches Azurite under another host (Compose: `http://azurite:10000`); defaults to the endpoint in the connection string (§8) |
| `AZURE_STORAGE_ACCOUNT_URL`, `AZURE_CLIENT_ID` | Azure Blob via managed identity |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` ● | CAPTCHA (official test keys locally/CI) |
| `TICK_SECRET` ● | Shared secret for `/api/internal/tick` |
| `DEMO_USER_PASSWORD` ● | Dev password for the seeded demo users, used only when `AUTH_DEV_LOGIN=true` (at least 12 characters; the seed fails without it). An obviously fake local-only value in `docker-compose.yml`; never set in Azure |
| `DEMO_USER_DOMAIN` | Email domain of the seeded demo users: `ats-demo.local` locally/CI, the `<tenant>.onmicrosoft.com` domain in Azure |
| `DATABASE_ADMIN_URL` ● | Azure `db-migrate` job only: admin connection used to apply migrations and create or update the app login; when unset, `db:migrate` uses `DATABASE_URL` |
| `SEED_ADMIN_EMAIL` | `db-seed` job only, set per execution: run `seed:admin` for this email instead of `db:seed` |
| `WORKER_ENABLED` | `true` to register job handlers in the web process |
| `LOG_LEVEL` | `info` (Azure) / `debug` (local) |

---

## 4. Authentication

Staff sign in with Microsoft Entra ID accounts from the project's own Entra tenant. Candidates never sign in.

| Rule | Behaviour |
|---|---|
| AU1 Provider | Better Auth `socialProviders.microsoft` with `clientId`, `clientSecret` and `tenantId` = the project tenant (single-tenant). Redirect URI: `{BETTER_AUTH_URL}/api/auth/callback/microsoft`. Database adapter: `@better-auth/drizzle-adapter` (`provider: 'pg'`). The provider is registered only when all three Microsoft variables are set. |
| AU2 Invite-only | Users exist only when an Admin creates them. `disableImplicitSignUp: true` and `disableSignUp: true` on the Microsoft provider prevent automatic user creation (with the first alone, a client could still send `requestSignUp: true`). The error code in the callback URL is never echoed back to the page. A sign-in from an Entra account without a matching **active** user is refused with "Access not granted, contact your ATS admin." |
| AU3 Identity mapping | `mapProfileToUser` returns `email = (profile.email ?? profile.preferred_username).toLowerCase()` and `image = null` (Microsoft sends large base64 photos). Entra doesn't send the `email` claim for users without a mailbox, so the user principal name (`preferred_username`) is the fallback. `disableProfilePhoto: true`. Sign-in never overwrites the ATS user's name or email. A profile with neither email nor UPN is refused with the AU2 message. |
| AU4 Account linking | `account.accountLinking.enabled = true` with `trustedProviders: ['microsoft']`. On first sign-in, the Entra account links to the pre-created user with the same email; Admin-created users have `email_verified = true`, which linking requires. After that, sign-in matches on the stored Entra account ID, not on email. |
| AU5 Active check | A `databaseHooks.session.create.before` hook refuses to create a session for an inactive user. Every request reloads the user's role and `is_active` from the database, so role changes and deactivation apply immediately; Better Auth's session cookie cache stays off. Deactivation also deletes the user's sessions. An inactive user signing in (Entra or dev sign-in) sees the AU2 message. |
| AU6 Sessions | Database sessions; HTTP-only, Secure, SameSite=Lax cookie; `expiresIn` 8 h, `updateAge` 1 h (sliding expiry). |
| AU7 Dev sign-in | Better Auth `emailAndPassword` with `disableSignUp: true` is enabled **only** when `AUTH_DEV_LOGIN=true`. When `AUTH_DEV_LOGIN=true`, seeded demo users (one per role) get a password and sign in through the normal sign-in endpoint, which creates real database sessions. The app refuses to start when `AUTH_DEV_LOGIN === 'true' && (APP_ENV === 'azure' \|\| EMAIL_PROVIDER === 'outbox')`. `NODE_ENV` is not part of the check, so the production image (`NODE_ENV=production`) runs with `AUTH_DEV_LOGIN=true`, `APP_ENV=ci` and `EMAIL_PROVIDER=smtp` in the CI Compose stack. The environment is never inferred from `AZURE_CLIENT_ID` or other incidental variables. Better Auth's built-in rate limiter is disabled in every environment: it reads the first `x-forwarded-for` entry, which §3 rule 9 forbids, and throttles parallel Playwright sign-ins; F6 is the only rate limit. |
| AU8 First Admin | `pnpm seed:admin --email <upn>` creates the first Admin in an environment (in Azure through the `db-seed` job, G6). It is idempotent: an existing user with that email is promoted to Admin and reactivated. It writes `ADMIN_SEEDED` to `audit_log` and prints the user ID only. |
| AU9 Authorization | Authentication only identifies the user; every permission check goes through the policy module (`ats-project-scope.md` V9). |
| AU10 Schema | The Better Auth `user` model is mapped to the `users` table with additional fields `role` and `is_active` (not settable through the auth API). IDs are UUIDs. The tables `session`, `account` and `verification` are generated with the Better Auth CLI into the Drizzle schema, adjusted to the `ats-project-scope.md` §7 conventions (snake_case, UUID keys, timestamps, indexed foreign keys, no `ON DELETE CASCADE`) and migrated like any other table. Users are Admin-managed, so the self-service endpoints are disabled: `update-user`, `change-email`, `change-password`, `set-password`, `delete-user`, password reset, `link-social` and `unlink-account`. |

**Entra setup (project tenant, done once by the owner)**
1. App registration: single tenant; web redirect URIs for `http://localhost:3000` and the Azure app address; client secret stored in Key Vault, with a calendar reminder before it expires.
2. Token configuration: add the optional `email` claim to the ID token.
3. Demo users: `admin@`, `recruiter@`, `hm@`, `interviewer@<tenant>.onmicrosoft.com`, each created in the ATS with the matching role.

---

## 5. Job Queue

pg-boss stores jobs in PostgreSQL (schema `pgboss`), so jobs can be created in the same transaction as the business change.

| Queue | Created with | Notes |
|---|---|---|
| `email.send` | retry limit 5, exponential backoff | Immediate and delayed emails (`startAfter`); delayed rejections use this queue |
| `offer.render-pdf` | retry limit 3 | Queues `email.send` on success |
| `approvals.remind` | singleton policy | Queued by the tick once per day |
| `retention.purge` | singleton policy | Queued by the tick once per day |

| Rule | Behaviour |
|---|---|
| J1 Same transaction | Jobs are created and cancelled inside the business transaction using pg-boss's Drizzle adapter: `boss.send(queue, data, { db: fromDrizzle(tx, sql) })`, and likewise for `boss.cancel`. A rollback removes the job. `fromDrizzle` is imported from `pg-boss` and `sql` from `drizzle-orm` (node-postgres). If Sprint 0 proof #1 shows a typing or signature mismatch, the job adapter implements the same `{ executeSql(text, values) }` interface on top of the Drizzle transaction in one small function. |
| J2 Cancellation | `email_log.job_id` stores the job ID while `QUEUED`. Cancelling calls `boss.cancel('email.send', jobId, { db: fromDrizzle(tx, sql) })` and sets `email_log.status = CANCELLED` in the same transaction (`ats-project-scope.md` R7). |
| J3 Idempotency | Every handler checks current state before acting and is safe to run twice. |
| J4 Interface | Domain code uses `JobQueue` (`enqueue`, `cancel`); only the adapter imports pg-boss (enforced by an ESLint rule). `cancel` returns `true`/`false` instead of throwing when the job no longer exists. **Payloads hold IDs only** (e.g. the `email_log` ID), never personal data: pg-boss keeps job data in its own tables, which the retention purge (`ats-project-scope.md` RT4) doesn't touch. |
| J5 Queue setup | One `ensureJobQueues()` function runs `boss.start()` and `createQueue()` for every queue in `pnpm db:migrate` (locally and in the `db-migrate` job), in the integration-test setup and again at app start; it is idempotent and safe to run concurrently, so `send()` never targets a missing queue. For an existing queue it updates the retry options to the declared values; if the existing queue's **policy** differs (pg-boss can't change it), setup fails with a message naming the queue. |
| J6 Admin view | A page lists queued, active and failed jobs per queue and the last 30 days of `job_runs`. |
| J7 Test helper | Tests can process all due jobs synchronously through a helper (`processDueJobs`). When given a `now` option (the test clock, T3), it first applies the T3 clock shift. |

---

## 6. Worker Runtime & Scheduling

The worker runs inside the web process. The app scales to zero when idle and an hourly Container Apps Job wakes it.

| Rule | Behaviour |
|---|---|
| W1 Startup | `instrumentation.ts` runs only when `NEXT_RUNTIME === 'nodejs'` and `NEXT_PHASE !== 'phase-production-build'`. It calls `getConfig()`, starts pg-boss and ensures the queues (J5), and registers job handlers with `boss.work()` only when `WORKER_ENABLED === 'true'`. If a variable is missing or PostgreSQL is unreachable, the process logs the error (without the connection string) and exits non-zero, so the container restarts; it never serves requests without a working queue. Losing the database after startup is reported by `/api/health` (M5). Under `pnpm dev` it starts only once. |
| W2 Separable | Handlers live in `/src/worker` with their own entry point (`pnpm worker`), which always registers the handlers; `WORKER_ENABLED` applies only to the web process. |
| W3 Daily tasks | Daily tasks are not scheduled with pg-boss cron (it can't fire while the app is asleep). |
| W4 Tick | The hourly job calls `POST /api/internal/tick` with header `x-tick-secret`. The secret is compared in constant time; a wrong or missing secret returns `401`, other methods `405`. The endpoint: (a) when the test clock is honoured (`x-test-now`, T3), applies the T3 clock shift; queues each daily task whose time has passed and has no `job_runs` row for today's Europe/Warsaw date (W5); (b) waits for due work by polling every 1 s with a count of pg-boss jobs in states `created`, `retry` or `active` whose start time is ≤ now (future-dated jobs, such as delayed rejections not yet due, are excluded); (c) returns `200` when the count is 0 or after **180 s**, whichever comes first. Container Apps' default request timeout is 240 s. Unfinished work continues at the next tick. The count is implemented in one read-only query in the job adapter. The response is a JSON summary (queued tasks, whether it waited). When `WORKER_ENABLED` is not `true`, the tick queues the due tasks, skips (b) and returns `200` with `waited: false` and a logged warning. |
| W5 Run-once | `job_runs` has `UNIQUE (job_name, run_date)`; a task is recorded before it starts, so overlapping ticks never run it twice. `run_date` is the Europe/Warsaw calendar date (`YYYY-MM-DD`), computed by one helper that handles daylight-saving changes. The `job_runs` insert (skipping on conflict) and the enqueue happen in one transaction. Missed past days are not caught up, and a `FAILED` daily task is not rerun on the same day; it runs again on the next run date (safe because of J3, `ats-project-scope.md` RT5 and A6). |
| W6 Shutdown | On SIGTERM, `boss.stop({ graceful: true })`; interrupted jobs expire and are retried (J3). |
| W7 Timing | While the app is awake, jobs run within seconds; while it sleeps, they run at the next tick (up to ~1 h later). |
| W8 Replicas | Minimum 0, maximum 1 replica; no sidecars. |
| W9 Tests | Tests call the tick endpoint or the J7 helper and never wait in real time. |

---

## 7. Data Access

| Rule | Behaviour |
|---|---|
| D1 Schema | Drizzle schema in `/src/server/db/schema/` is the single source of truth for `ats-project-scope.md` §7, including check constraints, unique and partial indexes, and the `req_number_seq` sequence. |
| D2 Migrations | `drizzle-kit generate` → committed SQL reviewed in pull requests; applied by `pnpm db:migrate`, which uses drizzle-orm's runtime migrator (`drizzle-orm/node-postgres/migrator`), not `drizzle-kit`, so the same command runs from the production image in the `db-migrate` job (§3 rule 8). `drizzle-kit push` is allowed only on a local database. Each migration works with the previous release, because `db-migrate` runs before the new revision starts. |
| D3 Transactions | Domain services receive a transaction handle `tx`; every multi-step change (status change + history + email jobs) runs in one transaction. |
| D4 Transaction proof | A test proves J1: a status change and `enqueue` in one transaction; on rollback no job exists, on commit the job exists. |
| D5 Pool | One `pg.Pool` per process, max 10 connections; TLS in Azure. pg-boss uses this pool through its custom `db` option instead of opening its own. |
| D6 Row-level filters | Visibility rules are implemented as reusable query helpers (e.g. `scopeApplicationsFor(user)`), never written ad hoc in handlers. They deny by default: a filter for a role without a rule returns no rows. |
| D7 Optimistic locking | Updates to `applications`, `requisitions` and `offers` include `WHERE version = :v` and increment `version`. |
| D8 Seed | `pnpm db:seed` runs in every environment (in Azure through the `db-seed` job from the production image, §3 rule 8, G6). **Idempotent and non-destructive:** it inserts missing records only, by natural key (template type + name, setting key, master data type + code, user email), and never overwrites settings or templates an Admin has changed; synthetic data is created only if no requisitions exist yet. **Contents:** settings defaults; email, offer and requisition templates (incl. `APPLIED` and `REJECTED` stage emails, the bulk-email templates "Application update" and "Interview preparation", and a default offer letter); master data; the four demo users matching the Entra demo accounts; synthetic requisitions and applications with sample PDF files uploaded through `StorageService`. Dev passwords for demo users (AU7) are created **only when `AUTH_DEV_LOGIN=true`**, from `DEMO_USER_PASSWORD` (a rerun updates it); in Azure, demo users sign in through Entra only. Demo user emails use `DEMO_USER_DOMAIN`. The seed never changes an existing user's role, name or active flag, and writes `USER_CREATED` (no actor) for users it inserts. A seeded stage template is skipped if any `EMAIL` template already has that trigger status. The seed runs in one transaction and prints counts only. Sample PDFs are generated at seed time and marked as synthetic. The synthetic step runs under an advisory lock; its files are uploaded before the transaction commits and deleted again (best effort) if it fails. Synthetic dates are relative to the seed run and stay within the default retention period. Synthetic candidates use `example.com`, `example.org` or `example.net` emails, `+00` phone numbers and obviously fictitious names. |
| D9 Real database in tests | Integration tests run against the PostgreSQL container, never mocks. |

---

## 8. File Storage

- One adapter, `StorageService`, built on `@azure/storage-blob`, with: `upload`, `download` (for email attachments), `delete`, `getSignedUrl(key, ttl = 5 min)`.
- **Local/CI:** if `AZURE_STORAGE_CONNECTION_STRING` is set (Azurite), signed links use a `StorageSharedKeyCredential` (account-key SAS), and the app creates the private `files` container if it is missing (Azurite mode only; in Azure, Bicep creates it).
- **SAS shape:** one blob, read-only, no start time, expiry 5 minutes, HTTPS-only in Azure. Signed URLs are never logged.
- **Azurite host names:** the app talks to Azurite through the endpoint in the connection string (`http://azurite:10000/devstoreaccount1` inside Compose, `http://127.0.0.1:10000/devstoreaccount1` for `pnpm dev`), but signed links handed to the browser use `AZURE_STORAGE_PUBLIC_URL` when set (`http://localhost:10000/devstoreaccount1` in Compose). The SAS signature doesn't include the host, so only the link's origin changes.
- **Azure:** otherwise the adapter uses `DefaultAzureCredential` (user-assigned managed identity via `AZURE_CLIENT_ID`) and signs links with a **user delegation key**. The identity has **Storage Blob Data Contributor** on the **storage account**, which includes permission to request user delegation keys.
- Container `files` is private; object keys are random UUIDs; the original file name is stored only in the database.
- **PDF viewing** (`ats-project-scope.md` F5): signed links for inline viewing set the response headers through the SAS (`rsct=application/pdf`, `rscd=inline`); PDFs are never streamed through the app. The restrictive, nonce-based CSP and `X-Content-Type-Options: nosniff` are set by `proxy.ts` on all HTML pages (§3 rule 6), including those that embed the viewer; `frame-src` includes only the origin of the browser-facing Blob endpoint (a CSP source with a path would match only that exact path) taken from configuration (`AZURE_STORAGE_ACCOUNT_URL` in Azure; locally/CI `AZURE_STORAGE_PUBLIC_URL`, or the Azurite endpoint from the connection string when it is not set), never `*` and never the Compose-internal `azurite` host. Exception: the P6 preview isn't stored; the app renders it on request and returns it (`Content-Type: application/pdf`, `Content-Disposition: inline`, `Cache-Control: no-store`), and it opens in a new tab, so `frame-src` is unchanged.

---

## 9. Email Capture & Outbox

`EmailService` builds the complete message (headers, Reply-To, optional Cc, HTML and text body, `.ics`, PDF attachments) the same way in every environment; only the transport differs. `EmailService.send()` accepts `cc`, which is stored in `email_log.cc`. **Pipeline:** the subject and body are rendered (markup, then tokens) when the email is queued and stored in `email_log`; the `email.send` handler adds From, Reply-To and the recruiter footer at send time (E1–E3) and is guarded so a message is sent at most once (J3). Payloads carry only the `email_log` ID (J4).

| `EMAIL_PROVIDER` | Behaviour |
|---|---|
| `smtp` (local/CI) | Nodemailer → Mailpit (`localhost:1025`), web UI at `http://localhost:8025`; end-to-end tests read messages through Mailpit's API; `email_log.status = SENT` |
| `outbox` (Azure) | Nothing leaves the system: the full message is stored in `email_log` with status `CAPTURED` |

**Outbox page** (`/admin/outbox`, Admin only through the normal session and policy check): lists every `email_log` row (all statuses, not only `CAPTURED`) with recipient, subject, status, time and a link to the application; shows the HTML body in a sandboxed iframe without scripts; downloads the `.ics` from the Admin-only route `GET /api/admin/outbox/[id]/ics` (`Content-Type: text/calendar; charset=utf-8`, `Content-Disposition: attachment`) and PDF attachments (`attachment_file_ids`) through signed Blob links.

---

## 10. Offer Letter PDF

| Rule | Behaviour |
|---|---|
| P1 Content vs layout | The offer template body holds the text with tokens. Layout (A4, margins, logo, font, footer, page numbers) is the React component `/src/server/pdf/OfferLetter.tsx`. |
| P2 Tokens | Tokens are resolved and escaped before rendering; an unknown token fails the render. |
| P3 Markup | Supported: `#`/`##` headings, paragraphs, `**bold**`, `*italic*`, `-` lists, line breaks. Anything else is rendered as plain text. |
| P4 Font | Noto Sans (open licence) is bundled, so Polish and other diacritics render correctly. The font files and their OFL licence are committed under `src/server/pdf/fonts/` and included in the standalone output. |
| P5 Logo | A static PNG bundled at `/public/logo.png` (replaced in the repository for branding). Also used for `[[LOGO]]` in emails. |
| P6 Preview | "Preview PDF" renders on demand without storing. |
| P7 Final letter | On approval, `offer.render-pdf` renders the letter, stores it as a file of kind `OFFER_LETTER`, then queues the offer email with the PDF attached. A re-approved offer (A8) gets a new file; older versions are kept until purge. The stored letter isn't subject to the `MAX_UPLOAD_MB` upload limit. |
| P8 Tests | A text snapshot of a sample letter; every token in the default template resolves. |

---

## 11. Testing

| Layer | Tool | Scope |
|---|---|---|
| End-to-end (primary) | Playwright against the Compose stack | Journeys for every role: apply → screen → interview → scorecard → offer → hire → export; approvals, re-approval, withdrawal; hold, close, reopen; purge; visibility per role; email and `.ics` content via Mailpit |
| Unit | Vitest | Pure logic: transition table, scoring, token resolution, KPI and paused-time calculations, `.ics` builder, time zones (incl. the Europe/Warsaw run date), client IP resolution, `email_hash` |
| Integration | Vitest + PostgreSQL container (`pnpm test:integration`) | D4 and other database-dependent rules where an end-to-end test would be slow |

**Test files:** Vitest unit tests (`pnpm test`) collect `tests/**/*.test.ts(x)` and exclude `tests/e2e/**` and `tests/integration/**` in `vitest.config.ts`; integration tests in `tests/integration/**/*.test.ts` need PostgreSQL and run only through `pnpm test:integration`; Playwright collects `tests/e2e/**/*.spec.ts`. `pnpm test:rules` (T1) relies on this split and scans all three.

| Rule | Behaviour |
|---|---|
| T1 Rule traceability | Every rule ID listed below has at least one test whose title starts with the ID and a colon (e.g. `R7: status change cancels pending rejection email`). IDs are matched exactly (`A2:` is not `AU2:`). **Required:** all business rules in `ats-project-scope.md` (A, L, S, F, R, I, E, RT, V except V9) and AU1–AU10 except AU8, J1–J3, J5, W1, W4, W5, D4, D7, P2, P3, P5–P8. **Not required** (structural): V9, AU8, J4, J6, J7, W2, W3, W6–W9, D1–D3, D5, D6, D8, D9, P1, P4, and all T, G and M rules. `pnpm test:rules` scans Vitest and Playwright test titles and fails if a required ID has no test; it runs in CI on every pull request. |
| T2 Isolation | Each test creates its own data; the integration-test database is reset per test worker. Playwright shares one Compose database, so **time-travel specs** (those that send `x-test-now` or depend on daily tasks, which act on the whole database) live in `tests/e2e/time-travel/**` and run in a separate Playwright project with `workers: 1` that starts only after the parallel projects finish. `pnpm test:e2e` runs the parallel projects and then `time-travel` as two Playwright invocations and fails if either failed (project dependencies would skip every time-travel spec when one parallel test fails). A unit-tested check in `pnpm verify` scans every file under `tests/e2e` (any letter case) and fails if a file outside that folder sends `x-test-now` or imports from it. Each time-travel spec uses its own `TEST_NOW` date or asserts only on data it created. Set up in task 10. |
| T3 Time | Delays and daily tasks are tested with the tick endpoint and a test-only clock (`TEST_NOW`), never by sleeping. `TEST_NOW` is supplied per request as the `x-test-now` header on the tick (ISO 8601 with `Z` or an offset), and as a `now` option on the J7 helper; it is not an environment variable. It is honoured only when `AUTH_DEV_LOGIN=true` (otherwise ignored and real time is used; an unparsable value returns `400`). When honoured, it drives the due check, the Europe/Warsaw run date and the `now` passed in daily task payloads, which handlers compare against instead of the system clock. **Clock shift:** because pg-boss compares start times with the database `now()`, the tick endpoint and the J7 helper first set the start time of every `created` or `retry` job whose start time is ≤ `TEST_NOW` to the database `now()`, so it runs immediately. This SQL against pg-boss's internal table lives in one function in the job adapter and runs only in test mode; it is the only code that writes to pg-boss tables. The only other direct SQL is read-only, also in the job adapter: the W4 count and, if pg-boss's public API can't list jobs by state, the J6 job listing. The pg-boss 12 table and column names are confirmed in Sprint 0 proof #4. |
| T4 Sign-in | Tests sign in through AU7 and reuse saved sign-in state per role, created by a Playwright `setup` project for four `e2e-*@example.com` users with a random password per run (their passwords are never committed; the demo users' local password is the fake `DEMO_USER_PASSWORD` in `docker-compose.yml`). Playwright reads `TICK_SECRET` and the PostgreSQL credentials from `docker-compose.yml`, overridable by environment variables. |
| T5 API visibility | V-rules are asserted on API responses, not only on rendered pages. |
| T6 Flakiness | One retry in CI; trace, video and screenshot kept on failure; flaky tests are fixed, not skipped. |
| T7 Agent loop | The agent runs `pnpm verify` (lint, typecheck, Vitest unit tests, rule scan; no `next build`) on every change and the Playwright specs for the affected rule IDs (`--grep`) before pushing; the full suite runs on `main`. |
| T8 Test integrity | Existing assertions are never deleted or weakened to make a test pass; any change to an existing test is listed with its reason in the pull request. |

---

## 12. CI/CD & Infrastructure

| Workflow | Trigger | Steps |
|---|---|---|
| `ci.yml` | Pull request | Install (pnpm, cached) → the `pnpm verify` checks (lint → typecheck → unit tests → `pnpm test:rules`) → `pnpm db:migrate` + `pnpm test:integration` against `postgres:17`, Azurite and Mailpit service containers → `next build`. No Playwright (G4). |
| `main.yml` | Push to `main`, manual | `pnpm verify` → build the image once (tag = commit SHA) → start the Compose stack with that image → migrate + seed (run from that image) → `pnpm test:integration` against the Compose PostgreSQL → Playwright suite → push image to GHCR → Azure login (OIDC) → set the new tag on the `db-migrate` job and run it (wait for success) → update the web Container App and the `tick` and `db-seed` jobs to the new tag → smoke test `GET /api/health`. Deployments are never cancelled by a newer push. Each step runs only if the previous one succeeded. Manual runs from another branch run the tests but never push or deploy. |
| `infra.yml` | Manual | `mode: what-if` runs `az deployment group what-if` only; `mode: deploy` repeats the what-if and then runs `az deployment group create` with `/infra/main.bicep`. The owner reviews a what-if run before starting a deploy run (TO-21). |

| Rule | Behaviour |
|---|---|
| G1 Branching | Short-lived branches → pull request → `main`. A pull request is merged only after `ci.yml` passes and the owner approves it. This is enforced by the agent and owner workflow (`AGENTS.md`), not by GitHub branch protection, which private repositories on the Free plan don't have (TO-21). |
| G2 One image | The image tested end-to-end is the image deployed. |
| G3 Azure access | GitHub authenticates to Azure with an OIDC federated credential on a service principal in the project tenant, with Contributor rights on the project resource group only, plus Role Based Access Control Administrator on the same resource group, restricted by a condition to assigning Storage Blob Data Contributor and Key Vault Secrets User. The federated credential accepts only workflow runs on `main`. No Azure secrets in GitHub. |
| G4 Minutes budget | End-to-end tests only on `main`; dependency and build caching; `concurrency` cancels superseded runs. The Free plan includes 2,000 Linux minutes per month for private repositories. `main.yml` ignores pushes that change only `_docs/**` or Markdown files. Failure artifacts are kept 7 days; GHCR keeps the 10 most recent image versions. |
| G5 Infrastructure | `/infra/main.bicep` defines: Log Analytics workspace (M7); Container Apps environment; web Container App (0–1 replicas, external HTTPS ingress, Key Vault secret references, user-assigned identity); `tick` job (cron `0 * * * *`; a compiled entry point in the app image calls the tick endpoint); `db-migrate` job; `db-seed` job (manual trigger; runs the compiled `db:seed` entry point, or the compiled `seed:admin` entry point when `SEED_ADMIN_EMAIL` is set); the web app and the jobs share one environment list; `APP_ENV=azure` on the web app and every job; PostgreSQL Flexible Server 17 B1MS (32 GB storage, auto-grow, high availability and geo-redundant backups off) with public access, firewall rule `AllowAllWindowsAzureIps` (0.0.0.0–0.0.0.0), `require_secure_transport = on`, admin password generated into Key Vault and a separate least-privilege app login (DML on the application tables, owner of the `pgboss` schema), created and updated by the `db-migrate` job; storage account with private container `files`, shared key access, public blob access, blob soft delete and versioning off; Key Vault (RBAC authorization, 7-day soft delete, purge protection off); user-assigned managed identity with Storage Blob Data Contributor (storage account scope) and Key Vault Secrets User; budget alert at EUR 10 per month. |
| G6 Rebuildable | An empty resource group can be rebuilt with `infra.yml` (`stage: foundation`), the owner's Key Vault secrets, `infra.yml` (`stage: full`), then `main.yml`, then the `db-seed` job (D8), then the `db-seed` job with `SEED_ADMIN_EMAIL=<owner UPN>` (AU8). Before rebuilding a deleted resource group, purge or recover its soft-deleted Key Vault; after a rebuild, update the Entra redirect URI and the Turnstile hostnames if the app's host name changed. |
| G7 Local parity | `pnpm verify` is the fast local check: lint, typecheck, Vitest unit tests and, from task 2, `pnpm test:rules`. It does not run `next build`. `ci.yml` runs the same checks, then the database integration tests (`pnpm test:integration`, PostgreSQL 17 service container), then `next build`; `main.yml` runs `pnpm verify`, builds the Docker image and runs the integration tests and the full Playwright suite. |
| G8 Dependencies | Dependabot weekly for npm and GitHub Actions. |
| G9 Image pull | The GHCR package is private. GitHub Packages authenticates only with a **classic** personal access token, so the Container App pulls with a classic PAT that has the **`read:packages` scope only** and an expiry date (e.g. 90 days), stored in Key Vault, with a calendar reminder before it expires. A classic token applies to the whole personal account, so it must never get any other scope. `main.yml` pushes images with `GITHUB_TOKEN`. |
| G10 Stopping the database | To save cost between demos, stop the PostgreSQL server **and** disable the `tick` job. A stopped Flexible Server starts again automatically after 7 days. Deployments need the server running. Rerunning `infra.yml` restores the `tick` schedule. |

---

## 13. Logging & Monitoring

| Rule | Behaviour |
|---|---|
| M1 Logger | pino structured JSON to stdout through one logger module. |
| M2 No personal data | Log identifiers only (application, requisition, user, job IDs); never names, emails, phone numbers, file content, salary or comments. pino `redact` paths act as a safety net. The same applies to `audit_log.details_json` and job payloads (J4): IDs and counts only. |
| M3 Correlation | Each request gets a `request_id`, generated in `proxy.ts` (§3 rule 6) and returned in `x-request-id`; job logs include `job_id` and queue name. |
| M4 Errors | Unhandled errors are logged with stack and `request_id`; users see a generic error page showing the `request_id`. |
| M5 Health | `GET /api/health` checks database and storage connectivity with a 3 s timeout per check and returns a fixed JSON body (`200` or `503`); connection strings are never logged. Used by the deploy smoke test and the Container Apps readiness and startup probes (not liveness, so a storage outage doesn't restart the app). |
| M6 Job visibility | J6. |
| M7 Log budget | Log Analytics with a 0.1 GB daily ingestion cap and 30-day retention; logging pauses for the rest of the day when the cap is reached. |
| M8 Cost alert | The budget alert (G5) emails the owner at 80 % and 100 % of EUR 10 per month. The budget is scoped to the resource group, in the subscription's billing currency, and only notifies; it never stops resources. |

---

## 14. Operating Cost

The project runs on a **new** Azure account and is eligible for the Azure free account offer.

| Period | Expected cost |
|---|---|
| First 30 days | Covered by the USD 200 starter credit |
| Months 1–12 | Close to zero: PostgreSQL Flexible Server B1MS (750 h/month) and 32 GB storage are free for 12 months; Container Apps stays within its monthly free grant (180,000 vCPU-s, 360,000 GiB-s, 2 million requests) at 0.25–0.5 vCPU with scale to zero; Log Analytics is capped; Key Vault and Blob storage cost a few cents |
| After month 12 | The B1MS server is billed at pay-as-you-go rates (check the Azure pricing calculator); stop it between demos (G10) |

GitHub (private repository, Actions within 2,000 minutes, GHCR) and Cloudflare Turnstile are free. Check Azure Cost Management after the first week of running.

---

## 15. Sprint 0 Proof Tests

The first sprint sets up the skeleton and proves the integration points everything else depends on. Each item is an automated test, or a one-time manual check where marked.

| # | Proof |
|---|---|
| 1 | D4: job creation commits and rolls back with the business transaction (J1, `fromDrizzle`). |
| 2 | J2: a delayed `email.send` job is cancelled inside a transaction. |
| 3 | W1: `next build` succeeds with no database and no secrets available. |
| 4 | W4: the tick queues daily tasks once, drains due jobs, ignores future-dated jobs and returns within 180 s; T3: the clock shift makes a delayed job due under `TEST_NOW` (confirms the pg-boss 12 table and column names it uses). |
| 5 | AU7: dev sign-in creates a database session that authenticates later requests; the production image starts with `AUTH_DEV_LOGIN=true`, `APP_ENV=ci`, `EMAIL_PROVIDER=smtp`; the app refuses to start with `AUTH_DEV_LOGIN=true` and `APP_ENV=azure` or `EMAIL_PROVIDER=outbox`. |
| 6 | AU2–AU5 (manual, in Azure): a pre-created demo user signs in with Entra and is linked; an Entra user without an ATS account is refused; a deactivated user can't sign in. |
| 7 | §8: signed links work against Azurite (account key) and Azure (user delegation key) and return `Content-Type: application/pdf` and `Content-Disposition: inline`; the viewer page's `frame-src` allows the PDF to load. |
| 8 | §9: the Outbox shows a captured email with its `.ics` and PDF attachment. |
| 9 | §3 rule 9 (manual, in Azure): confirm which client IP header the Container Apps ingress provides (`x-envoy-external-address` or the last `x-forwarded-for` entry) and that a client-set `x-forwarded-for` can't bypass the limit. |

Results of the manual proofs are recorded in the README (date, image tag, outcome).
