# One image for local Compose, CI and Azure (tech-stack.md §3 rule 8, G2).
# It builds without any secret or database (§15 proof 3); all configuration
# comes from the container environment at run time.

FROM node:24-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# pnpm at the exact version pinned in package.json `packageManager`.
COPY package.json ./
RUN corepack enable && corepack install

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
# db:build bundles the db:migrate, db:seed, seed:admin and tick entry points with
# their runtime dependencies into dist/db/*.mjs and copies the committed SQL to
# dist/db/migrations.
RUN pnpm build && pnpm db:build

# Runtime: the standalone output plus the compiled entry points in /app/db
# (§3 rule 8, G5): `node db/migrate.mjs`, `node db/seed.mjs`,
# `node db/seed-admin.mjs --email <upn>` and `node db/tick.mjs` (the Azure
# tick job). No pnpm, tsx, drizzle-kit or curl here.
FROM node:24-slim AS runtime
WORKDIR /app
# NEXT_MANUAL_SIG_HANDLE: Next.js would exit on SIGTERM at once; the app's own
# handler first lets active jobs finish and stops pg-boss (W6).
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_MANUAL_SIG_HANDLE=true
# Files stay owned by root (read-only for the app user); only Next's cache
# directory is writable.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/dist/db ./db
RUN mkdir -p .next/cache && chown node:node .next/cache && chmod -R o-w /app
USER node
EXPOSE 3000
CMD ["node", "server.js"]
