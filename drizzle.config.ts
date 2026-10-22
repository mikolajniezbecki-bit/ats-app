// drizzle-kit generates SQL migrations from the schema (D2); they are
// committed and applied by `pnpm db:migrate` with the runtime migrator.
// `pnpm db:generate` needs no database.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema/index.ts",
  out: "./src/server/db/migrations",
  strict: true,
});
