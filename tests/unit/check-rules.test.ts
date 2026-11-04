import { describe, expect, it } from "vitest";
import {
  NOT_REQUIRED_IDS,
  REQUIRED_IDS,
  checkRules,
  formatReport,
  isCollectedTestFile,
  type SourceFile,
} from "../check-rules";

// Fixtures only exist as strings here; the scanner must not count them as
// tests for this file (see "repository as committed" in issue #2).
const UNIT = "tests/unit/fixture.test.ts";

function file(text: string, path = UNIT): SourceFile {
  return { path, text };
}

// Small required list so each case states exactly what is covered.
function run(files: SourceFile[], required = ["A2", "AU2", "L1", "L11", "R1", "R2", "R5", "R7"]) {
  return checkRules({ files, required, notRequired: ["V9", "M2"] });
}

function testedIds(files: SourceFile[]): string[] {
  return [...run(files).tested.keys()].sort();
}

describe("which files are scanned", () => {
  it.each([
    ["tests/unit/a.test.ts", true],
    ["tests/unit/a.test.tsx", true],
    ["tests/integration/a.test.ts", true],
    ["tests/e2e/a.spec.ts", true],
    ["tests/e2e/time-travel/a.spec.ts", true],
    ["src/foo.test.ts", false],
    ["tests/e2e/foo.test.ts", false],
    ["tests/unit/foo.spec.ts", false],
    ["tests/check-rules.ts", false],
  ])("%s collected: %s", (path, collected) => {
    expect(isCollectedTestFile(path)).toBe(collected);
  });

  it("ignores rule titles in files the runners do not collect", () => {
    const files = ["src/foo.test.ts", "tests/e2e/foo.test.ts", "tests/unit/foo.spec.ts"].map((p) =>
      file("test('A2: approver differs', () => {});", p),
    );
    expect(testedIds(files)).toEqual([]);
  });

  it("counts integration tests under tests/integration, which pnpm test does not run", () => {
    expect(testedIds([file("it('A2: approver differs', async () => {});", "tests/integration/a.test.ts")])).toEqual(["A2"]);
  });

  it("counts Playwright specs under tests/e2e", () => {
    expect(testedIds([file("test('A2: approver differs', async () => {});", "tests/e2e/a.spec.ts")])).toEqual(["A2"]);
  });
});

describe("what counts as a rule test", () => {
  it("counts a test title starting with the ID and a colon", () => {
    expect(testedIds([file("test('A2: approver differs from submitter', () => {});")])).toEqual(["A2"]);
  });

  it("matches IDs exactly: AU2 is not A2 and A2 is not AU2", () => {
    expect(testedIds([file("test('AU2: something', () => {});")])).toEqual(["AU2"]);
    expect(testedIds([file("test('A2: something', () => {});")])).toEqual(["A2"]);
  });

  it("does not count L11 for L1, nor titles without colon, with a leading space or in lower case", () => {
    const src = `
      test('L11: eleven', () => {});
      test('L1 no colon', () => {});
      test(' L1: leading space', () => {});
      test('l1: lower case', () => {});
    `;
    expect(testedIds([file(src)])).toEqual(["L11"]);
  });

  it("counts only the leading ID of a title", () => {
    expect(testedIds([file("test('R2: R5: both', () => {});")])).toEqual(["R2"]);
  });

  it("counts it, test.only, test.concurrent and the each forms", () => {
    const cases = [
      "it('A2: x', () => {});",
      "test.only('A2: x', () => {});",
      "it.only('A2: x', () => {});",
      "test.concurrent('A2: x', async () => {});",
      "test.each([1, 2])('A2: case %s', () => {});",
      "it.each([1, 2])('A2: case %s', () => {});",
    ];
    for (const src of cases) expect(testedIds([file(src)]), src).toEqual(["A2"]);
  });

  it("does not count describe titles", () => {
    const src = `
      describe('R7: cancels rejection', () => { it('cancels the email', () => {}); });
      test.describe('R1: playwright group', () => { test('moves', async () => {}); });
    `;
    expect(testedIds([file(src)])).toEqual([]);
  });

  it("does not count skipped, todo, fixme or failing tests", () => {
    const cases = [
      "test.skip('A2: x', () => {});",
      "it.skip('A2: x', () => {});",
      "test.todo('A2: x');",
      "it.todo('A2: x');",
      "test.fixme('A2: x', async () => {});",
      "test.fail('A2: x', async () => {});",
      "xit('A2: x', () => {});",
      "xtest('A2: x', () => {});",
      "test.skip.each([1])('A2: x', () => {});",
    ];
    for (const src of cases) expect(testedIds([file(src)]), src).toEqual([]);
  });

  it("uses the static leading text of template-literal titles", () => {
    expect(testedIds([file("test(`R1: moves ${from}`, () => {});")])).toEqual(["R1"]);
    expect(testedIds([file("test(`R2: plain template`, () => {});")])).toEqual(["R2"]);
    expect(testedIds([file("test(`${id}: from expression`, () => {});")])).toEqual([]);
    expect(testedIds([file("const title = 'R1: x'; test(title, () => {});")])).toEqual([]);
  });

  it("ignores rule IDs in strings, comments and fixtures that are not test titles", () => {
    const src = `
      // A2: comment
      /* R1: block comment */
      const fixture = "test('R2: inside a string', () => {})";
      expect(log).toContain('R5: message');
      test('checks the R7: text', () => {});
    `;
    expect(testedIds([file(src)])).toEqual([]);
  });

  it("parses .tsx test files", () => {
    const src = "test('A2: renders', () => { render(<Page title=\"x\" />); });";
    expect(testedIds([file(src, "tests/unit/page.test.tsx")])).toEqual(["A2"]);
  });
});

describe("required ID list", () => {
  it("has the 102 unique IDs from tech-stack.md T1, without V9 and AU8", () => {
    expect(REQUIRED_IDS).toHaveLength(102);
    expect(new Set(REQUIRED_IDS).size).toBe(102);
    expect(REQUIRED_IDS).not.toContain("V9");
    expect(REQUIRED_IDS).not.toContain("AU8");
  });

  it("knows the 46 not-required IDs and none overlap with the required ones", () => {
    expect(NOT_REQUIRED_IDS).toHaveLength(46);
    expect(new Set(NOT_REQUIRED_IDS).size).toBe(46);
    expect(NOT_REQUIRED_IDS.filter((id) => REQUIRED_IDS.includes(id))).toEqual([]);
  });

  it("allows tests titled with not-required IDs", () => {
    const src = ["M2: logger redacts email", "J7: helper", "D8: seed", "W6: outbox", "T2: isolation", "G10: x"]
      .map((t) => `test('${t}', () => {});`)
      .join("\n");
    const result = checkRules({ files: [file(src)], required: [] });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("pass and fail", () => {
  const ALL = ["A2", "AU2", "L1", "L11", "R1", "R2", "R5", "R7"];
  const titles = (ids: readonly string[]) => ids.map((id) => `test('${id}: x', () => {});`).join("\n");

  it("passes when every required ID is tested and prints the counts", () => {
    const result = run([file(titles(ALL))]);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.summary).toEqual({ required: 8, tested: 8 });
  });

  it("fails naming every missing ID, sorted", () => {
    const result = run([file("test('A2: x', () => {}); test('L1: y', () => {}); test('R1: z', () => {});")]);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(["Required rule IDs without a test: AU2, L11, R2, R5, R7"]);
  });

  it("with test files covering all 102 IDs the scan passes; removing the only R7 title makes it fail and name R7", () => {
    const covered = checkRules({ files: [file(titles(REQUIRED_IDS))] });
    expect(covered.errors).toEqual([]);
    expect(covered.ok).toBe(true);
    expect(covered.summary).toEqual({ required: 102, tested: 102 });

    const result = checkRules({ files: [file(titles(REQUIRED_IDS.filter((id) => id !== "R7")))] });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(["Required rule IDs without a test: R7"]);
  });

  it("fails on a test title with an unknown rule-shaped ID, naming file and title", () => {
    const result = run([file(`${titles(ALL)}\ntest('AU11: typo', () => {}); test('X3: unknown', () => {});`)]);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      `${UNIT}: test "AU11: typo" starts with unknown rule ID AU11. Fix the typo or the ID list in tests/check-rules.ts.`,
      `${UNIT}: test "X3: unknown" starts with unknown rule ID X3. Fix the typo or the ID list in tests/check-rules.ts.`,
    ]);
  });
});

describe("report", () => {
  it("lists each required ID in order with the files of its tests, and marks an ID without a test", () => {
    const result = run(
      [file("test('R7: x', () => {});", "tests/unit/a.test.ts"), file("test('R7: y', async () => {});", "tests/e2e/b.spec.ts")],
      ["A2", "R7"],
    );
    expect(formatReport(result, ["A2", "R7"])).toBe("A2: (no test)\nR7: tests/unit/a.test.ts, tests/e2e/b.spec.ts");
  });
});
