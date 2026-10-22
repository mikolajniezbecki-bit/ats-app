// T2 guard: only specs under tests/e2e/time-travel/ may move the clock, since
// the clock shift and daily tasks act on the whole shared Compose database.
// Every file under tests/e2e is scanned, not only specs, so a helper can't
// carry the header out of the folder.

export const TIME_TRAVEL_DIR = "tests/e2e/time-travel/";

export type SourceFile = { path: string; content: string };
export type Violation = { path: string; reason: string };

const TEST_NOW = /x-test-now/i;
// `from "…time-travel/…"`, `import("…time-travel/…")` and `require("…time-travel/…")`.
const TIME_TRAVEL_IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)["'][^"']*time-travel\/[^"']*["']/;

/** Files under tests/e2e outside the time-travel folder that send x-test-now or import from it. */
export function timeTravelViolations(files: SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const { path, content } of files) {
    const normalized = path.replaceAll("\\", "/");
    if (!normalized.startsWith("tests/e2e/") || normalized.startsWith(TIME_TRAVEL_DIR)) continue;
    if (TEST_NOW.test(content)) violations.push({ path: normalized, reason: "sends x-test-now outside tests/e2e/time-travel/" });
    if (TIME_TRAVEL_IMPORT.test(content)) violations.push({ path: normalized, reason: "imports from tests/e2e/time-travel/" });
  }
  return violations;
}
