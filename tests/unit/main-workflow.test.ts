// main.yml (tech-stack.md §12, G2, G4, T6; task 43): the order of the steps,
// that nothing but the failure uploads runs after a failure, and that only
// main pushes the one tested image.
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

type Step = { name?: string; uses?: string; run?: string; if?: string; with?: Record<string, unknown>; "continue-on-error"?: boolean };
type Workflow = {
  on: { push: { branches: string[]; "paths-ignore": string[] }; workflow_dispatch: unknown };
  permissions: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: { main: { "timeout-minutes": number; steps: Step[] } };
};

const workflow = parse(readFileSync(path.resolve(".github/workflows/main.yml"), "utf8")) as Workflow;
const steps = workflow.jobs.main.steps;
const indexOf = (match: (step: Step) => boolean) => steps.findIndex(match);
const byRun = (prefix: string) => indexOf((step) => step.run?.trim().startsWith(prefix) ?? false);
const byName = (name: string) => indexOf((step) => step.name === name);

describe("main.yml", () => {
  it("runs on pushes to main (not for docs-only changes) and by hand, cancelling superseded runs", () => {
    expect(workflow.on.push.branches).toEqual(["main"]);
    expect(workflow.on.push["paths-ignore"]).toEqual(["_docs/**", "**/*.md"]);
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(workflow.permissions).toEqual({ contents: "read", packages: "write" });
    expect(workflow.concurrency).toEqual({ group: "main-${{ github.ref }}", "cancel-in-progress": true });
    expect(workflow.jobs.main["timeout-minutes"]).toBe(45);
  });

  it("verifies, builds once, migrates and seeds from the image, then runs integration and Playwright, and pushes last", () => {
    const order = [
      byRun("pnpm verify"),
      byName("Build image"),
      byName("Migrate from the image"),
      byName("Start the app"),
      byName("Seed from the image"),
      byRun("pnpm test:integration"),
      byRun("pnpm test:e2e"),
      byName("Push the tested image"),
      byName("Delete old image versions"),
    ];
    expect(order.every((index) => index >= 0), JSON.stringify(order)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const build = steps[byName("Build image")];
    expect(build.with).toMatchObject({ load: true, push: false, tags: "${{ env.APP_IMAGE }}" });
    expect(String(build.with?.labels)).toContain("org.opencontainers.image.source=");
    expect(steps[byName("Image name")].run).toContain("ats-app:${GITHUB_SHA}");
    expect(steps[byName("Migrate from the image")].run).toContain("node db/migrate.mjs");
    expect(steps[byName("Seed from the image")].run).toContain("node db/seed.mjs");
  });

  it("G2: pushes the tested image without rebuilding, only from main, with no latest tag", () => {
    const push = steps[byName("Push the tested image")];
    expect(push.run).toContain('docker push "$APP_IMAGE"');
    expect(steps.filter((step) => step.uses?.startsWith("docker/build-push-action"))).toHaveLength(1);
    for (const name of ["Log in to GHCR", "Push the tested image", "Delete old image versions"]) {
      expect(steps[byName(name)].if, name).toBe("github.ref == 'refs/heads/main'");
    }
    expect(readFileSync(path.resolve(".github/workflows/main.yml"), "utf8")).not.toMatch(/:latest\b/);
    expect(steps[byName("Delete old image versions")].with).toMatchObject({ "package-type": "container", "min-versions-to-keep": 10 });
  });

  it("G4, T6: no step continues after a failure; only the evidence uploads run on failure, kept 7 days", () => {
    expect(steps.some((step) => step["continue-on-error"])).toBe(false);
    expect(steps.some((step) => step.if?.includes("always()"))).toBe(false);
    const onFailure = steps.filter((step) => step.if === "failure()").map((step) => step.name);
    expect(onFailure).toEqual(["Collect Compose logs", "Upload failure evidence"]);
    const upload = steps[byName("Upload failure evidence")];
    expect(upload.with).toMatchObject({ "retention-days": 7 });
    expect(String(upload.with?.path)).toMatch(/test-results\/[\s\S]*playwright-report\/[\s\S]*compose-logs\.txt/);
  });
});
