// Compiles the database and tick entry points into JavaScript files with their
// runtime dependencies bundled, and copies the committed SQL next to them, so
// the production image runs migrations and seeds without pnpm, tsx or
// drizzle-kit (tech-stack.md §3 rule 8, G5). `pnpm db:migrate` and
// `pnpm db:seed` run the same bundles locally.
//
//   dist/db/migrate.mjs      db:migrate
//   dist/db/seed.mjs         db:seed
//   dist/db/seed-admin.mjs   seed:admin
//   dist/db/tick.mjs         the Azure tick job's client (the image has no curl)
//   dist/db/migrations/      the committed SQL and drizzle-kit journal
import { cpSync, rmSync } from "node:fs";
import { build } from "esbuild";

const OUT_DIR = "dist/db";

rmSync(OUT_DIR, { recursive: true, force: true });

await build({
  entryPoints: {
    migrate: "src/server/db/migrate.ts",
    seed: "src/server/db/seed/cli.ts",
    "seed-admin": "src/server/db/seed-admin-cli.ts",
    tick: "src/worker/tick-cli.ts",
  },
  outdir: OUT_DIR,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  // `server-only` resolves to its no-op build under react-server.
  conditions: ["react-server"],
  // pg loads pg-native only when asked for it. @react-pdf/renderer (the demo
  // seed's offer letters, task 42) resolves package-internal `#` imports at
  // run time, so it loads from node_modules as in the app: in the image from
  // the traced standalone node_modules next to /app/db.
  external: ["pg-native", "@react-pdf/renderer"],
  // Bundled CommonJS dependencies (pg, pino) call require(). The import is
  // aliased: bundled ESM code (the offer letter renderer the demo seed uses,
  // task 42) has its own top-level `import { createRequire }`.
  banner: { js: "import { createRequire as __atsCreateRequire } from 'node:module'; const require = __atsCreateRequire(import.meta.url);" },
  logLevel: "warning",
});

cpSync("src/server/db/migrations", `${OUT_DIR}/migrations`, { recursive: true });
