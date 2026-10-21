import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  use: {
    baseURL: "http://localhost:3000",
  },
  // Chromium only (tech-stack.md §2).
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
