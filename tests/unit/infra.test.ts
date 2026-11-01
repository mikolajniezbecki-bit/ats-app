// infra.yml and the Bicep sources (tech-stack.md G3, G5, M7; task 44). The
// compiled template is checked in infra.yml itself (az bicep build, then
// infra/check-arm.mjs); these tests cover what can be read without Azure.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { FORBIDDEN_NAMES, forbiddenNamesIn } from "../../infra/check-arm.mjs";

type Step = { name?: string; uses?: string; run?: string; if?: string; with?: Record<string, unknown>; env?: Record<string, string> };
type Workflow = {
  on: { workflow_dispatch: { inputs: Record<string, { options?: string[]; default?: string }> } } & Record<string, unknown>;
  permissions: Record<string, string>;
  env: Record<string, string>;
  jobs: { infra: { steps: Step[] } };
};

const workflowText = readFileSync(path.resolve(".github/workflows/infra.yml"), "utf8");
const workflow = parse(workflowText) as Workflow;
const steps = workflow.jobs.infra.steps;
const byName = (name: string) => steps.findIndex((step) => step.name === name);

const bicepFiles = ["infra/main.bicep", ...readdirSync("infra/modules").map((file) => `infra/modules/${file}`)];
const bicep = Object.fromEntries(bicepFiles.map((file) => [file, readFileSync(file, "utf8")]));
const withoutComments = (text: string) => text.replace(/\/\/.*$/gm, "");

describe("infra.yml", () => {
  it("runs only by hand, with the mode, stage and image_tag inputs", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    const { inputs } = workflow.on.workflow_dispatch;
    expect(inputs.mode).toMatchObject({ options: ["what-if", "deploy"], default: "what-if" });
    expect(inputs.stage).toMatchObject({ options: ["foundation", "full"] });
    expect(inputs).toHaveProperty("image_tag");
  });

  it("logs in with OIDC from GitHub variables and uses no GitHub secret (G3)", () => {
    expect(workflow.permissions).toEqual({ "id-token": "write", contents: "read" });
    expect(workflowText).not.toMatch(/secrets\./);
    const login = steps[byName("Azure login (OIDC)")];
    expect(login.uses).toMatch(/^azure\/login@/);
    expect(login.with).toEqual({
      "client-id": "${{ vars.AZURE_DEPLOY_CLIENT_ID }}",
      "tenant-id": "${{ vars.AZURE_TENANT_ID }}",
      "subscription-id": "${{ vars.AZURE_SUBSCRIPTION_ID }}",
    });
  });

  it("refuses any ref but main before doing anything else (Q11)", () => {
    expect(steps[0]).toMatchObject({ if: "github.ref != 'refs/heads/main'" });
    expect(steps[0].run).toContain("exit 1");
  });

  it("builds and checks the template, shows the what-if, then deploys, migrates and checks health", () => {
    const order = [
      byName("Azure login (OIDC)"),
      byName("Build the Bicep (no warnings) and check the compiled template"),
      byName("Read the current state"),
      byName("What-if"),
      byName("Deploy, first full deployment without the web app"),
      byName("Deploy"),
      byName("Migrate the database"),
      byName("Health check"),
    ];
    expect(order.every((index) => index >= 0), JSON.stringify(order)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The what-if always runs; nothing is created in what-if mode.
    expect(steps[byName("What-if")].if).toBeUndefined();
    for (const name of ["Deploy", "Deploy, first full deployment without the web app", "Migrate the database", "Health check"]) {
      expect(steps[byName(name)].if, name).toMatch(/^inputs\.mode == 'deploy'/);
    }
    expect(steps[byName("Migrate the database")].if).toContain("inputs.stage == 'full'");
    expect(steps[byName("Build the Bicep (no warnings) and check the compiled template")].run).toContain(
      "node infra/check-arm.mjs infra/main.json",
    );
    expect(steps[byName("What-if")].run).toContain("az deployment group what-if");
    expect(steps[byName("Deploy")].run).toContain("az deployment group create");
  });

  it("masks the generated secrets and creates them only when none exists", () => {
    const state = steps[byName("Read the current state")].run!;
    expect(state).toContain("::add-mask::");
    expect(state).toContain("INFRA_CREATE_GENERATED_SECRETS=true");
    expect(state).toContain("INFRA_CREATE_GENERATED_SECRETS=false");
    // The owner's secrets are only checked for, never written.
    expect(workflowText).not.toMatch(/az keyvault secret set/);
  });
});

// Runs the real "Read the current state" script against a fake az on PATH.
// The fake serves the secrets list one name per page, like a paged ARM list,
// so a script that reads only the first page miscounts (infra run #6).
describe("infra.yml Read the current state", () => {
  const generated = ["pg-admin-password", "pg-app-password", "better-auth-secret", "email-hash-key", "tick-secret", "database-url", "database-admin-url"];
  const owner = ["microsoft-client-secret", "turnstile-secret-key", "ghcr-pat"];
  const fakeAz = `#!/usr/bin/env bash
args="$*"
vault=/subscriptions/s/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/kv
case "$args" in
  *"resource list"*KeyVault/vaults*) echo "$vault" ;;
  *"resource list"*flexibleServers*) [ -z "$PG_SERVER" ] || echo "$PG_SERVER" ;;
  *"group show"*) echo polandcentral ;;
  *"resource list"*) echo "" ;;
  *"rest --method get"*"/secrets?"*) echo "{\\"value\\":[{\\"name\\":\\"\${SECRETS%% *}\\"}],\\"nextLink\\":\\"page-2\\"}" ;;
  *"rest --method get"*"/secrets/"*)
    name="\${args##*/secrets/}"; name="\${name%%[?]*}"
    if [[ " $SECRETS " == *" $name "* ]]; then echo "{}"; else echo "ERROR: (SecretNotFound) Not Found" >&2; exit 1; fi ;;
  *) echo "unexpected az $args" >&2; exit 2 ;;
esac
`;
  const run = (secrets: string[], stage: "foundation" | "full", extraEnv: Record<string, string> = {}) => {
    const dir = mkdtempSync(path.join(tmpdir(), "infra-state-"));
    try {
      writeFileSync(path.join(dir, "az"), fakeAz);
      chmodSync(path.join(dir, "az"), 0o755);
      const githubEnv = path.join(dir, "github-env");
      writeFileSync(githubEnv, "");
      const script = steps[byName("Read the current state")].run ?? "";
      let status = 0;
      let output = "";
      try {
        output = execFileSync("bash", ["-e", "-c", script], {
          encoding: "utf8",
          stdio: "pipe",
          env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_ENV: githubEnv, RESOURCE_GROUP: "rg", INFRA_STAGE: stage, IMAGE_TAG_INPUT: "abc", SECRETS: secrets.join(" "), PG_SERVER: "", POSTGRES_LOCATION: "", ...extraEnv },
        });
      } catch (error) {
        const failed = error as { status: number; stdout: string };
        status = failed.status;
        output = failed.stdout + (error as { stderr: string }).stderr;
      }
      return { status, output, env: readFileSync(githubEnv, "utf8") };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("finds all 10 secrets however the list API pages them", () => {
    const result = run([...generated, ...owner].sort(), "full");
    expect(result.output).not.toContain("::error::");
    expect(result.status).toBe(0);
    expect(result.env).toContain("INFRA_CREATE_GENERATED_SECRETS=false");
  });

  it("creates the generated secrets when none exists", () => {
    const result = run([], "foundation");
    expect(result.status).toBe(0);
    expect(result.env).toContain("INFRA_CREATE_GENERATED_SECRETS=true");
  });

  it("refuses a partial set of generated secrets", () => {
    const result = run(generated.slice(0, 3), "foundation");
    expect(result.status).toBe(1);
    expect(result.output).toContain("Only 3 of the 7 generated secrets");
  });

  const all = [...generated, ...owner];

  it("puts PostgreSQL in the resource group's region unless POSTGRES_LOCATION is set", () => {
    expect(run(all, "full").output).toContain("PostgreSQL region: polandcentral");
    expect(run(all, "full", { POSTGRES_LOCATION: "westeurope" }).output).toContain("PostgreSQL region: westeurope");
  });

  it("refuses to deploy when the existing server is in another region than the run would use", () => {
    const result = run(all, "full", { PG_SERVER: "ats-pg-x\tPoland Central", POSTGRES_LOCATION: "westeurope" });
    expect(result.status).toBe(1);
    expect(result.output).toContain("PostgreSQL server ats-pg-x is in polandcentral, but this run would put it in westeurope");
  });

  it("accepts an existing server in the region the run would use", () => {
    const result = run(all, "full", { PG_SERVER: "ats-pg-x\twesteurope", POSTGRES_LOCATION: "westeurope" });
    expect(result.output).not.toContain("::error::");
    expect(result.status).toBe(0);
  });

  it("refuses the full stage while an owner secret is missing", () => {
    const result = run([...generated, "ghcr-pat"], "full");
    expect(result.status).toBe(1);
    expect(result.output).toContain("no secret microsoft-client-secret");
  });
});

describe("check-arm.mjs", () => {
  it("finds every forbidden name as a whole word only", () => {
    expect(forbiddenNamesIn(JSON.stringify({ env: [{ name: "SMTP_HOST" }, { name: "AUTH_DEV_LOGIN" }] }))).toEqual([
      "AUTH_DEV_LOGIN",
      "SMTP_HOST",
    ]);
    expect(forbiddenNamesIn('{"name": "SMTP_HOSTNAME", "x": "MY_SMTP_PORT"}')).toEqual([]);
    expect(FORBIDDEN_NAMES).toEqual([
      "AUTH_DEV_LOGIN",
      "DEMO_USER_PASSWORD",
      "AZURE_STORAGE_CONNECTION_STRING",
      "AZURE_STORAGE_PUBLIC_URL",
      "SMTP_HOST",
      "SMTP_PORT",
    ]);
  });

  it("finds none of them in the Bicep sources outside comments", () => {
    for (const [file, text] of Object.entries(bicep)) expect(forbiddenNamesIn(withoutComments(text)), file).toEqual([]);
  });
});

describe("Bicep sources", () => {
  const apps = bicep["infra/modules/apps.bicep"];

  it("caps Log Analytics at 0.1 GB a day with 30-day retention (M7)", () => {
    const monitoring = bicep["infra/modules/monitoring.bicep"];
    expect(monitoring).toContain("dailyQuotaGb: json('0.1')");
    expect(monitoring).toContain("retentionInDays: 30");
  });

  it("sets APP_ENV=azure and EMAIL_PROVIDER=outbox in the one list the web app and every job use (G5, Q8)", () => {
    expect(apps).toContain("{ name: 'APP_ENV', value: 'azure' }");
    expect(apps).toContain("{ name: 'EMAIL_PROVIDER', value: 'outbox' }");
    // Every container's env starts from sharedEnv (jobEnv is sharedEnv + WORKER_ENABLED=false).
    const envs = [...apps.matchAll(/^\s+env: (.+)$/gm)].map((match) => match[1]);
    expect(envs).toHaveLength(4);
    for (const env of envs) expect(env).toMatch(/^(concat\((sharedEnv|jobEnv), |jobEnv$)/);
    // The admin connection only on db-migrate.
    expect(apps.match(/DATABASE_ADMIN_URL/g)).toHaveLength(1);
  });

  it("puts only PostgreSQL in POSTGRES_LOCATION, falling back to the resource group's region", () => {
    expect(workflow.env.POSTGRES_LOCATION).toBe("${{ vars.POSTGRES_LOCATION }}");
    expect(readFileSync("infra/main.bicepparam", "utf8")).toContain("param postgresLocation = readEnvironmentVariable('POSTGRES_LOCATION', '')");
    const main = withoutComments(bicep["infra/main.bicep"]);
    expect(main).toMatch(/name: names\.postgres\s+location: empty\(postgresLocation\) \? location : postgresLocation/);
    expect(main.match(/location: empty\(postgresLocation\)/g)).toHaveLength(1);
  });

  it("tags every taggable resource project=ats", () => {
    for (const [file, text] of Object.entries(bicep)) {
      if (file.endsWith("budget.bicep")) continue;
      const resources = [...withoutComments(text).matchAll(/^resource \w+ '([^']+)' (?!existing)/gm)]
        .map((match) => match[1])
        .filter((type) => !/roleAssignments|blobServices|firewallRules|configurations|flexibleServers\/databases/.test(type));
      expect(withoutComments(text).match(/^\s+tags: tags$/gm)?.length ?? 0, file).toBeGreaterThanOrEqual(resources.length);
    }
  });
});
