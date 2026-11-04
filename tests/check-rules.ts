// Rule-traceability scan (tech-stack.md §11 T1): every required rule ID needs
// a test whose own title starts with "<ID>:", with no exceptions.
//
// The core (`checkRules`) is a pure function over in-memory sources so every
// rule is unit-tested in tests/unit/check-rules.test.ts; the CLI at the bottom
// only reads the files. Run with `pnpm test:rules`, or `pnpm test:rules --report`
// to list each required ID with the files of its tests (Node 24 type stripping,
// so this file must stay free of enums and other non-erasable TypeScript).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

function range(prefix: string, from: number, to: number): string[] {
  const ids: string[] = [];
  for (let n = from; n <= to; n++) ids.push(`${prefix}${n}`);
  return ids;
}

// The single list of required IDs, in the order of tech-stack.md §11 T1
// ("Required"). Keep it in sync with T1 when the spec changes.
export const REQUIRED_IDS: readonly string[] = [
  ...range("A", 1, 9),
  ...range("L", 1, 11),
  ...range("S", 1, 4),
  ...range("F", 1, 8),
  ...range("R", 1, 12),
  ...range("I", 1, 10),
  ...range("E", 1, 9),
  ...range("RT", 1, 5),
  ...range("V", 1, 8),
  "V10",
  "V11",
  ...range("AU", 1, 7),
  "AU9",
  "AU10",
  ...range("J", 1, 3),
  "J5",
  "W1",
  "W4",
  "W5",
  "D4",
  "D7",
  "P2",
  "P3",
  ...range("P", 5, 8),
];

// Structural IDs from T1 ("Not required"): tests may carry them, but they are
// never demanded and never reported as unknown.
export const NOT_REQUIRED_IDS: readonly string[] = [
  "V9",
  "AU8",
  "J4",
  "J6",
  "J7",
  "W2",
  "W3",
  ...range("W", 6, 9),
  ...range("D", 1, 3),
  "D5",
  "D6",
  "D8",
  "D9",
  "P1",
  "P4",
  ...range("T", 1, 8),
  ...range("G", 1, 10),
  ...range("M", 1, 8),
];

export type SourceFile = { path: string; text: string };

export type CheckInput = {
  files: readonly SourceFile[];
  required?: readonly string[];
  notRequired?: readonly string[];
};

export type CheckResult = {
  ok: boolean;
  errors: string[];
  summary: { required: number; tested: number };
  // Required ID -> files with a counting test.
  tested: Map<string, string[]>;
};

// Files the runners collect (tech-stack.md §11 "Test files"): Vitest
// tests/**/*.test.ts(x) outside tests/e2e (unit and integration), Playwright
// tests/e2e/**/*.spec.ts. Anything else is never run, so it can't cover a rule.
export function isCollectedTestFile(filePath: string): boolean {
  const p = filePath.replaceAll("\\", "/");
  if (!p.startsWith("tests/")) return false;
  if (p.startsWith("tests/e2e/")) return p.endsWith(".spec.ts");
  return p.endsWith(".test.ts") || p.endsWith(".test.tsx");
}

const TEST_FUNCTIONS = new Set(["test", "it"]);
// Modifiers that still run the test. skip, todo, fixme, fail, skipIf, runIf and
// anything unknown do not count (T6: flaky tests are fixed, not skipped).
const RUNNING_MODIFIERS = new Set(["only", "concurrent", "sequential"]);
const TABLE_MODIFIERS = new Set(["each", "for"]);

// True for `test`, `it`, `test.only`, `it.concurrent.only`, ...
function isRunningTestCallee(expr: ts.Expression): boolean {
  if (ts.isIdentifier(expr)) return TEST_FUNCTIONS.has(expr.text);
  if (ts.isPropertyAccessExpression(expr)) {
    return RUNNING_MODIFIERS.has(expr.name.text) && isRunningTestCallee(expr.expression);
  }
  return false;
}

function isTestCall(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (isRunningTestCallee(callee)) return true;
  // test.each(table)('title', fn)
  return (
    ts.isCallExpression(callee) &&
    ts.isPropertyAccessExpression(callee.expression) &&
    TABLE_MODIFIERS.has(callee.expression.name.text) &&
    isRunningTestCallee(callee.expression.expression)
  );
}

// The static leading text of a title: the whole string, or a template
// literal's text before its first `${...}`. Variables and other expressions
// have none.
function staticTitle(arg: ts.Expression | undefined): string | undefined {
  if (!arg) return undefined;
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  if (ts.isTemplateExpression(arg)) return arg.head.text;
  return undefined;
}

export function testTitles(file: SourceFile): string[] {
  const kind = file.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, false, kind);
  const titles: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isTestCall(node)) {
      const title = staticTitle(node.arguments[0]);
      if (title !== undefined) titles.push(title);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return titles;
}

// One ID per test: the leading one, followed directly by a colon.
const RULE_ID_PREFIX = /^([A-Z]{1,2}[0-9]+):/;

function compareIds(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true });
}

export function checkRules(input: CheckInput): CheckResult {
  const requiredList = input.required ?? REQUIRED_IDS;
  const required = new Set(requiredList);
  const known = new Set([...requiredList, ...(input.notRequired ?? NOT_REQUIRED_IDS)]);
  const errors: string[] = [];

  const tested = new Map<string, string[]>();
  for (const file of input.files) {
    if (!isCollectedTestFile(file.path)) continue;
    for (const title of testTitles(file)) {
      const id = RULE_ID_PREFIX.exec(title)?.[1];
      if (id === undefined) continue;
      if (!known.has(id)) {
        errors.push(`${file.path}: test "${title}" starts with unknown rule ID ${id}. Fix the typo or the ID list in tests/check-rules.ts.`);
      } else if (required.has(id)) {
        const files = tested.get(id) ?? [];
        if (!files.includes(file.path)) files.push(file.path);
        tested.set(id, files);
      }
    }
  }

  const missing = requiredList.filter((id) => !tested.has(id)).sort(compareIds);
  if (missing.length > 0) errors.push(`Required rule IDs without a test: ${missing.join(", ")}`);

  return {
    ok: errors.length === 0,
    errors,
    summary: { required: required.size, tested: tested.size },
    tested,
  };
}

/** One line per required ID with the files of its tests, for reviewing coverage by hand. */
export function formatReport(result: CheckResult, required: readonly string[] = REQUIRED_IDS): string {
  return required.map((id) => `${id}: ${result.tested.get(id)?.join(", ") ?? "(no test)"}`).join("\n");
}

function readTestFiles(root: string): SourceFile[] {
  const testsDir = path.join(root, "tests");
  return readdirSync(testsDir, { recursive: true, encoding: "utf8" })
    .map((relative) => `tests/${relative.replaceAll("\\", "/")}`)
    .filter(isCollectedTestFile)
    .map((relative) => ({ path: relative, text: readFileSync(path.join(root, relative), "utf8") }));
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dirname, "..");
  const result = checkRules({ files: readTestFiles(root) });
  if (process.argv.includes("--report")) console.log(formatReport(result));
  const { required, tested } = result.summary;
  console.log(`Rule IDs: ${required} required, ${tested} tested.`);
  for (const error of result.errors) console.error(`✗ ${error}`);
  process.exitCode = result.ok ? 0 : 1;
}
