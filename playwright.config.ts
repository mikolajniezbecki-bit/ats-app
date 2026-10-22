// Playwright against a running app, by default the Compose stack
// (tech-stack.md §11, T2, T4, T6). `pnpm test:e2e` runs `parallel` and then
// `time-travel` as two invocations, so a failing parallel spec never skips
// the time-travel specs.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    // T6: kept on failure.
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    // Signs in the four shared e2e users and saves their state (T4).
    { name: "setup", testMatch: "auth.setup.ts" },
    {
      name: "parallel",
      testMatch: "**/*.spec.ts",
      testIgnore: "time-travel/**",
      fullyParallel: true,
      dependencies: ["setup"],
      // Chromium only (§2, G4).
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // Specs that move the clock or run daily tasks act on the whole
      // database, so they run alone, one at a time (T2).
      name: "time-travel",
      testMatch: "time-travel/**/*.spec.ts",
      workers: 1,
      fullyParallel: false,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
