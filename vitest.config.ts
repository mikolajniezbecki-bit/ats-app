import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// tech-stack.md §11 "Test files": two projects. `pnpm test` runs `unit`
// (no database, part of `pnpm verify`); `pnpm test:integration` runs
// `integration` against PostgreSQL. Playwright specs have their own runner.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` throws outside the react-server condition; tests import
      // server modules directly.
      "server-only": fileURLToPath(new URL("./node_modules/server-only/empty.js", import.meta.url)),
    },
  },
  test: {
    watch: false,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/**/*.test.{ts,tsx}"],
          exclude: ["tests/e2e/**", "tests/integration/**", "node_modules/**", ".next/**"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          // Migrates a template database once; each worker clones it (T2).
          globalSetup: ["tests/integration/global-setup.ts"],
          setupFiles: ["tests/integration/worker-setup.ts"],
          testTimeout: 15_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
