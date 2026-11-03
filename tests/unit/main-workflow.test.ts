// main.yml (tech-stack.md §12, G2, G4, T6; tasks 43 and 45): the order of the
// steps, that nothing but the failure uploads runs after a failure, that only
// main pushes the one tested image, and the deploy job's gates, permissions
// and concurrency (shared with infra.yml).
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

type Step = { name?: string; uses?: string; run?: string; if?: string; with?: Record<string, unknown>; "continue-on-error"?: boolean };
type Concurrency = { group: string; "cancel-in-progress": boolean };
type Job = {
  needs?: string | string[];
  if?: string;
  "timeout-minutes": number;
  permissions: Record<string, string>;
  concurrency?: Concurrency;
  env?: Record<string, string>;
  steps: Step[];
};
type Workflow = {
  on: { push: { branches: string[]; "paths-ignore": string[] }; workflow_dispatch: unknown };
  permissions: Record<string, string>;
  concurrency?: Concurrency;
  jobs: { main: Job; deploy: Job; cleanup: Job };
};

const workflowText = readFileSync(path.resolve(".github/workflows/main.yml"), "utf8");
const workflow = parse(workflowText) as Workflow;
const infra = parse(readFileSync(path.resolve(".github/workflows/infra.yml"), "utf8")) as { concurrency: Concurrency };
const steps = workflow.jobs.main.steps;
const indexOf = (match: (step: Step) => boolean) => steps.findIndex(match);
const byRun = (prefix: string) => indexOf((step) => step.run?.trim().startsWith(prefix) ?? false);
const byName = (name: string) => indexOf((step) => step.name === name);

describe("main.yml", () => {
  it("runs on pushes to main (not for docs-only changes) and by hand, cancelling superseded runs", () => {
    expect(workflow.on.push.branches).toEqual(["main"]);
    expect(workflow.on.push["paths-ignore"]).toEqual(["_docs/**", "**/*.md"]);
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(workflow.permissions).toEqual({});
    expect(workflow.jobs.main.permissions).toEqual({ contents: "read", packages: "write" });
    // Job level, so a newer push cancels testing but never a deployment.
    expect(workflow.concurrency).toBeUndefined();
    expect(workflow.jobs.main.concurrency).toEqual({ group: "main-${{ github.ref }}", "cancel-in-progress": true });
    expect(workflowText).not.toMatch(/^concurrency:/m);
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
    for (const name of ["Log in to GHCR", "Push the tested image"]) {
      expect(steps[byName(name)].if, name).toBe("github.ref == 'refs/heads/main'");
    }
    expect(workflowText).not.toMatch(/:latest\b/);
  });

  it("G4, T6: no step in any job continues after a failure", () => {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      expect(job.steps.some((step) => step["continue-on-error"]), name).toBe(false);
      expect(job.steps.some((step) => step.if?.includes("always()")), name).toBe(false);
    }
  });

  it("G4, T6: in the main job only the evidence uploads run after a failure; only the evidence uploads run on failure, kept 7 days", () => {
    expect(steps.some((step) => step["continue-on-error"])).toBe(false);
    expect(steps.some((step) => step.if?.includes("always()"))).toBe(false);
    const onFailure = steps.filter((step) => step.if === "failure()").map((step) => step.name);
    expect(onFailure).toEqual(["Collect Compose logs", "Upload failure evidence"]);
    const upload = steps[byName("Upload failure evidence")];
    expect(upload.with).toMatchObject({ "retention-days": 7 });
    expect(String(upload.with?.path)).toMatch(/test-results\/[\s\S]*playwright-report\/[\s\S]*compose-logs\.txt/);
  });

  describe("deploy job (task 45)", () => {
    const deploy = workflow.jobs.deploy;
    const deployStep = (name: string) => deploy.steps.findIndex((step) => step.name === name);

    it("runs after the tested image is pushed, only on main, with OIDC and nothing more", () => {
      expect(deploy.needs).toBe("main");
      expect(deploy.if).toBe("github.ref == 'refs/heads/main'");
      expect(deploy.permissions).toEqual({ "id-token": "write", contents: "read" });
      const login = deploy.steps[deployStep("Azure login (OIDC)")];
      expect(login.uses).toMatch(/^azure\/login@v\d+$/);
      expect(login.with).toEqual({
        "client-id": "${{ vars.AZURE_DEPLOY_CLIENT_ID }}",
        "tenant-id": "${{ vars.AZURE_TENANT_ID }}",
        "subscription-id": "${{ vars.AZURE_SUBSCRIPTION_ID }}",
      });
      expect(deploy.env?.RESOURCE_GROUP).toBe("${{ vars.AZURE_RESOURCE_GROUP }}");
      // G3: no Azure secret in GitHub; GITHUB_TOKEN only for the GHCR login.
      expect(workflowText.match(/secrets\.\w+/g)).toEqual(["secrets.GITHUB_TOKEN"]);
    });

    it("is never cancelled by a newer push and shares its group with infra.yml", () => {
      expect(deploy.concurrency).toEqual({ group: "azure-deploy", "cancel-in-progress": false });
      expect(infra.concurrency).toEqual(deploy.concurrency);
    });

    it("reads the names, checks the database, migrates, updates the app, then the jobs, then smoke-tests", () => {
      const order = [
        deployStep("Azure login (OIDC)"),
        deployStep("Read the resource names"),
        deployStep("Check that the database is running"),
        deployStep("Migrate the database"),
        deployStep("Update the web app"),
        deployStep("Update the tick and db-seed jobs"),
        deployStep("Smoke test"),
      ];
      expect(order.every((index) => index >= 0), JSON.stringify(order)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      // Each step runs only if every earlier one succeeded.
      expect(deploy.steps.filter((step) => step.if !== undefined)).toEqual([]);
      const run = (name: string) => deploy.steps[deployStep(name)].run ?? "";
      expect(run("Image name")).toContain("ats-app:${GITHUB_SHA}");
      expect(run("Read the resource names")).toContain("--name infra-full");
      expect(run("Read the resource names")).toContain("Azure isn't set up yet: run infra.yml (stage full) first (README, Azure setup).");
      for (const output of ["webName", "migrateJobName", "seedJobName", "tickJobName", "postgresServerName", "appUrl"]) {
        expect(run("Read the resource names")).toContain(output);
      }
      expect(run("Check that the database is running")).toContain('[ "$state" != "Ready" ]');
      expect(run("Check that the database is running")).toContain(
        "The database is stopped. Start it (README, Stop and start between demos) and rerun this workflow on main.",
      );
      expect(run("Migrate the database")).toMatch(/set -o pipefail[\s\S]*set-image\.sh job "\$DEPLOY_migrateJobName"[\s\S]*run-job\.sh "\$DEPLOY_migrateJobName" 600/);
      expect(run("Update the web app")).toContain('set-image.sh app "$DEPLOY_webName" "$APP_IMAGE" 600');
      expect(run("Update the tick and db-seed jobs")).toContain('set-image.sh job "$DEPLOY_tickJobName" "$APP_IMAGE"');
      expect(run("Update the tick and db-seed jobs")).toContain('set-image.sh job "$DEPLOY_seedJobName" "$APP_IMAGE"');
      expect(run("Smoke test")).toContain('smoke-test.sh "$DEPLOY_webName" "$DEPLOY_appUrl" "$APP_IMAGE"');
    });

    it("writes the SHA, the db-migrate execution, the revision and the smoke test to the job summary", () => {
      const summary = deploy.steps.map((step) => step.run ?? "").join("\n");
      for (const item of ["Commit: \\`${GITHUB_SHA}\\`", "db-migrate: \\`${execution}\\`", "Web app revision", "Smoke test: "]) {
        expect(summary, item).toContain(item);
      }
    });

    it("needs no Azure CLI extension", () => {
      expect(workflowText).not.toMatch(/az (containerapp|extension)/);
    });
  });

  it("G4, Q9: deletes old GHCR versions only after a successful deployment", () => {
    const cleanup = workflow.jobs.cleanup;
    expect(cleanup.needs).toBe("deploy");
    expect(cleanup.if).toBe("github.ref == 'refs/heads/main'");
    expect(cleanup.permissions).toEqual({ packages: "write" });
    expect(cleanup.steps).toHaveLength(1);
    expect(cleanup.steps[0].uses).toMatch(/^actions\/delete-package-versions@/);
    expect(cleanup.steps[0].with).toMatchObject({ "package-name": "ats-app", "package-type": "container", "min-versions-to-keep": 10 });
    for (const job of ["main", "deploy"] as const) {
      expect(workflow.jobs[job].steps.some((step) => step.uses?.startsWith("actions/delete-package-versions")), job).toBe(false);
    }
  });
});
