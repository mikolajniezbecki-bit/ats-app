// Compiles the db:migrate entry point into one JavaScript file with its
// runtime dependencies bundled, and copies the committed SQL next to it, so
// the production image runs migrations without pnpm, tsx or drizzle-kit
// (tech-stack.md §3 rule 8). `pnpm db:migrate` runs the same bundle locally.
//
//   dist/db/migrate.mjs   the bundle
//   dist/db/migrations/   the committed SQL and drizzle-kit journal
import { cpSync, rmSync } from "node:fs";
import { build } from "esbuild";

const OUT_DIR = "dist/db";

rmSync(OUT_DIR, { recursive: true, force: true });

await build({
  entryPoints: ["src/server/db/migrate.ts"],
  outfile: `${OUT_DIR}/migrate.mjs`,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  // `server-only` resolves to its no-op build under react-server.
  conditions: ["react-server"],
  // pg loads pg-native only when asked for it.
  external: ["pg-native"],
  // Bundled CommonJS dependencies (pg, pino) call require().
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: "warning",
});

cpSync("src/server/db/migrations", `${OUT_DIR}/migrations`, { recursive: true });
