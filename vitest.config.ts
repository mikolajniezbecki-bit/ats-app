import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// tech-stack.md §11 "Test files": unit tests only; Playwright and
// integration specs are collected by their own runners.
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
    include: ["tests/**/*.test.{ts,tsx}"],
    exclude: ["tests/e2e/**", "tests/integration/**", "node_modules/**", ".next/**"],
    watch: false,
  },
});
