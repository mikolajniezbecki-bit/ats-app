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
# db:build bundles the db:migrate entry point with its runtime dependencies
# into dist/db/migrate.mjs and copies the committed SQL to dist/db/migrations.
RUN pnpm build && pnpm db:build

# Runtime: the standalone output plus the compiled db:migrate entry point and
# its migrations in /app/db (§3 rule 8). No pnpm, tsx or drizzle-kit here.
# Later tasks add db:seed and seed:admin.
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
