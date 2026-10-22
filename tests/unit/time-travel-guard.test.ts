import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { type SourceFile, timeTravelViolations } from "../support/time-travel-guard";

function filesUnder(dir: string): SourceFile[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => !path.includes(`${join("tests", "e2e", ".auth")}`))
    .map((path) => ({ path: relative(process.cwd(), path), content: readFileSync(path, "utf8") }));
}

describe("T2 time-travel guard", () => {
  it("T2: no file under tests/e2e outside time-travel/ sends x-test-now or imports from it", () => {
    expect(timeTravelViolations(filesUnder("tests/e2e"))).toEqual([]);
  });

  it("T2: the header in a parallel spec fails and names the file", () => {
    const file = { path: "tests/e2e/jobs.spec.ts", content: `headers: { "x-test-now": "2040-01-01T00:00:00Z" }` };
    expect(timeTravelViolations([file])).toEqual([
      { path: "tests/e2e/jobs.spec.ts", reason: "sends x-test-now outside tests/e2e/time-travel/" },
    ]);
  });

  it("T2: the header in a helper file outside the folder fails", () => {
    expect(timeTravelViolations([{ path: "tests/e2e/support/clock.ts", content: "const H = 'x-test-now';" }])).toHaveLength(1);
  });

  it("T2: any letter case fails", () => {
    expect(timeTravelViolations([{ path: "tests/e2e/a.spec.ts", content: "'X-Test-Now'" }])).toHaveLength(1);
  });

  it("T2: a parallel spec that imports a time-travel helper fails", () => {
    const content = `import { tickAt } from "./time-travel/helpers";`;
    expect(timeTravelViolations([{ path: "tests/e2e/a.spec.ts", content }])).toEqual([
      { path: "tests/e2e/a.spec.ts", reason: "imports from tests/e2e/time-travel/" },
    ]);
  });

  it("T2: the header inside the folder passes, and integration tests aren't scanned", () => {
    expect(
      timeTravelViolations([
        { path: "tests/e2e/time-travel/tick.spec.ts", content: "'x-test-now'" },
        { path: "tests/integration/tick.test.ts", content: "'x-test-now'" },
      ]),
    ).toEqual([]);
  });
});
