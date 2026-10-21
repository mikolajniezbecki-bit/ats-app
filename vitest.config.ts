import { defineConfig } from "vitest/config";

// tech-stack.md §11 "Test files": unit tests only; Playwright and
// integration specs are collected by their own runners.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    exclude: ["tests/e2e/**", "tests/integration/**", "node_modules/**", ".next/**"],
    watch: false,
  },
});
