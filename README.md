# ats-app

Custom ATS & career portal. Specs live in `_docs/` (start with `ats-project-scope.md` and `tech-stack.md`).

## Development

Requires Node.js 24 and pnpm (the version pinned in `package.json` `packageManager`; `corepack enable` picks it up).

```sh
pnpm install   # install dependencies (fails on a Node version other than 24)
pnpm dev       # start the dev server on http://localhost:3000
pnpm verify    # lint, typecheck and Vitest unit tests (no build)
pnpm build     # production build (.next/standalone)
```

Test files:

- Vitest unit tests: `tests/**/*.test.ts(x)`, run by `pnpm test` (excludes `tests/e2e/**` and `tests/integration/**`).
- Playwright specs: `tests/e2e/**/*.spec.ts`.
