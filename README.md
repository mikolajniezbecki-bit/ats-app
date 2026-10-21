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

Test files:

- Vitest unit tests: `tests/**/*.test.ts(x)`, run by `pnpm test` (excludes `tests/e2e/**` and `tests/integration/**`).
- Playwright specs: `tests/e2e/**/*.spec.ts`.

Rule traceability (`pnpm test:rules`, tech-stack.md §11 T1):

- A test covers rule `X` when the title of the `test(...)`/`it(...)` call itself starts with `X:` (e.g. `test("R7: status change cancels pending rejection email", ...)`). IDs match exactly (`AU2:` is not `A2:`), one per test. Titles on `describe(...)` and skipped, todo, fixme or failing tests don't count.
- Required IDs that have no test yet are listed in `tests/rules-pending.json`. Every task that adds the first test for an ID removes that ID from the list in the same change; the scan fails if a pending ID already has a test, if a required ID is neither tested nor pending, or if a title starts with an unknown rule-shaped ID.
- Pull requests run the same checks in `.github/workflows/ci.yml` (`pnpm verify`, then `pnpm build`).

## Configuration

All configuration goes through `getConfig()` in `src/server/config.ts` (tech-stack.md §3 rule 5). It validates every variable with Zod on the first call (never at import time, so `pnpm build` needs no secrets) and caches the result. Errors name the missing or invalid variables, never their values. An empty value (`KEY=`) counts as missing.

Copy `.env.example` to `.env` and fill the empty values you need. `.env` is git-ignored; never commit it. Secrets stay empty in `.env.example`, including publicly documented dev values. Where they come from:

- `DATABASE_URL`: the local PostgreSQL container (task 4 adds the Compose stack).
- `BETTER_AUTH_SECRET`, `EMAIL_HASH_KEY`, `TICK_SECRET`: any random local value, e.g. `openssl rand -base64 32`.
- `AZURE_STORAGE_CONNECTION_STRING`: Azurite's [default development connection string](https://learn.microsoft.com/azure/storage/common/storage-use-azurite#http-connection-strings).
- `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`: Cloudflare's [Turnstile test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/).
- `DEMO_USER_PASSWORD`: any local password of at least 12 characters.
- `MICROSOFT_*`: leave all three empty locally unless you test Entra sign-in; they are set together or not at all, and the tenant ID must be a GUID.

Refused combinations: `AUTH_DEV_LOGIN=true` with `APP_ENV=azure` or `EMAIL_PROVIDER=outbox` (AU7), and `APP_ENV=azure` without `EMAIL_PROVIDER=outbox` (§3 rule 10). `NODE_ENV` plays no part in these checks.

## Logging

`src/server/logger.ts` writes pino JSON lines to stdout (M1). It reads only `LOG_LEVEL` (default `info`), so it works even when the configuration is invalid. Log identifiers only, never personal data (M2); the `redact` paths are a safety net. In server code, use `getRequestLogger()` from `src/server/request-id.ts` to bind the request's `request_id`, which `src/proxy.ts` generates for every request and returns in `x-request-id` (M3). Unhandled errors are logged by `onRequestError` in `src/instrumentation.ts` (M4).

For readable output locally, pipe it through pino-pretty: `pnpm dev | pnpm dlx pino-pretty`.
