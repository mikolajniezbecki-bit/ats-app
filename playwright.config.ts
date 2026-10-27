// Playwright against a running app, by default the Compose stack
// (tech-stack.md §11, T2, T4, T6). `pnpm test:e2e` runs `parallel` and then
// `time-travel` as two invocations, so a failing parallel spec never skips
// the time-travel specs.
import { defineConfig, devices } from "@playwright/test";

// `pnpm test:e2e` starts Playwright twice, and each start empties the output
// folders of the projects it runs and rewrites the HTML report. So each
// project writes its traces, videos and screenshots to its own folder, and
// each start writes its own report (named after its --project), or the
// time-travel start would delete the evidence of a failed parallel test (T6).
const run = process.argv.find((arg) => arg.startsWith("--project="))?.slice("--project=".length) ?? "all";

export default defineConfig({
  testDir: "tests/e2e",
  // CI (main.yml, T6): no committed test.only, one retry, and an HTML report
  // that the workflow uploads with the traces when a test fails.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: `playwright-report/${run}` }]] : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    // T6: kept on failure.
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    // Signs in the four shared e2e users and saves their state (T4).
    { name: "setup", testMatch: "auth.setup.ts", outputDir: "test-results/setup" },
    {
      name: "parallel",
      testMatch: "**/*.spec.ts",
      testIgnore: "time-travel/**",
      outputDir: "test-results/parallel",
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
      outputDir: "test-results/time-travel",
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
