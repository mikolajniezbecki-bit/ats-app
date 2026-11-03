// The main.yml deploy helpers (task 45): infra/set-image.sh and
// infra/smoke-test.sh, run for real against a fake az (and curl) on PATH that
// keeps one Container App or job as JSON in a state file.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const OLD = "ghcr.io/owner/ats-app:1111111111111111111111111111111111111111";
const NEW = "ghcr.io/owner/ats-app:2222222222222222222222222222222222222222";

// FAKE_PATCH_RESULT: ok (default) | never-ready | failed | drops-secret
const fakeAz = `#!/usr/bin/env bash
args="$*"
state="$FAKE_DIR/state.json"
case "$args" in
  *"resource show"*"--query id"*) echo /s/rg/res/web ;;
  *"rest --method patch"*)
    body="\${args##*--body @}"; body="\${body%% *}"
    cp "$body" "$FAKE_DIR/patch.json"
    case "\${FAKE_PATCH_RESULT:-ok}" in
      failed) jq '.properties.provisioningState = "Failed"' "$state" > "$state.new" ;;
      *) jq --slurpfile p "$body" --arg mode "\${FAKE_PATCH_RESULT:-ok}" '
          .properties.template = $p[0].properties.template
          | .properties.latestRevisionName = "web--2"
          | (if $mode == "never-ready" then . else .properties.latestReadyRevisionName = "web--2" end)
          | (if $mode == "drops-secret" then .properties.configuration.secrets |= .[1:] else . end)' "$state" > "$state.new" ;;
    esac
    mv "$state.new" "$state" ;;
  *"rest --method get"*"/revisions/"*"--query"*)
    jq -r '.properties.template.containers[0].image' "$state" ;;
  *"rest --method get"*"/revisions?"*)
    if [[ "$args" == *"page=2"* ]]; then cat "$FAKE_DIR/revisions-2.json"; else cat "$FAKE_DIR/revisions-1.json"; fi ;;
  *"rest --method get"*) cat "$state" ;;
  *) echo "unexpected az $args" >&2; exit 2 ;;
esac
`;

const fakeCurl = `#!/usr/bin/env bash
out=""
while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done
n=$(cat "$FAKE_DIR/curl-count" 2>/dev/null || echo 0); echo $((n + 1)) > "$FAKE_DIR/curl-count"
read -ra replies <<< "$HEALTH"; reply="\${replies[$n]:-\${replies[-1]}}"
case "$reply" in
  ok) echo '{"status":"ok","database":"ok","storage":"ok"}' > "$out"; printf 200 ;;
  503) echo '{"status":"fail","database":"fail","storage":"ok"}' > "$out"; printf 503 ;;
  down) exit 7 ;;
esac
`;

function resource(kind: "app" | "job") {
  return {
    id: "/s/rg/res/web",
    properties: {
      provisioningState: "Succeeded",
      ...(kind === "app" ? { latestRevisionName: "web--1", latestReadyRevisionName: "web--1" } : {}),
      configuration: {
        secrets: [{ name: "database-url", keyVaultUrl: "https://kv/secrets/database-url", identity: "id" }, { name: "ghcr-pat", keyVaultUrl: "https://kv/secrets/ghcr-pat", identity: "id" }],
        registries: [{ server: "ghcr.io", username: "owner", passwordSecretRef: "ghcr-pat" }],
        ...(kind === "job" ? { triggerType: "Manual", manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 } } : {}),
      },
      template: {
        revisionSuffix: kind === "app" ? "abc" : undefined,
        containers: [{ name: "app", image: OLD, env: [{ name: "APP_ENV", value: "azure" }, { name: "DATABASE_URL", secretRef: "database-url" }] }],
      },
    },
  };
}

function withFakes<T>(setup: (dir: string) => void, body: (dir: string, env: NodeJS.ProcessEnv) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), "deploy-"));
  try {
    for (const [name, text] of [["az", fakeAz], ["curl", fakeCurl]]) {
      writeFileSync(path.join(dir, name), text);
      chmodSync(path.join(dir, name), 0o755);
    }
    setup(dir);
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_DIR: dir, RESOURCE_GROUP: "rg", GITHUB_OUTPUT: path.join(dir, "github-output") };
    return body(dir, env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runScript(script: string, args: string[], env: NodeJS.ProcessEnv) {
  try {
    return { status: 0, output: execFileSync("bash", [script, ...args], { encoding: "utf8", stdio: "pipe", env }) };
  } catch (error) {
    const failed = error as { status: number; stdout: string; stderr: string };
    return { status: failed.status, output: failed.stdout + failed.stderr };
  }
}

function setImage(kind: "app" | "job", extraEnv: Record<string, string> = {}, initial = resource(kind)) {
  return withFakes(
    (dir) => writeFileSync(path.join(dir, "state.json"), JSON.stringify(initial)),
    (dir, env) => {
      const result = runScript("infra/set-image.sh", [kind, "web", NEW, "1"], { ...env, SET_IMAGE_POLL_SECONDS: "0", ...extraEnv });
      const patchFile = path.join(dir, "patch.json");
      const output = path.join(dir, "github-output");
      return {
        ...result,
        patch: existsSync(patchFile) ? JSON.parse(readFileSync(patchFile, "utf8")) : undefined,
        githubOutput: existsSync(output) ? readFileSync(output, "utf8") : "",
      };
    },
  );
}

describe("infra/set-image.sh", () => {
  it("sends only the template, with only the image changed, and reports the ready revision", () => {
    const result = setImage("app");
    expect(result.output).not.toContain("::error::");
    expect(result.status).toBe(0);
    expect(Object.keys(result.patch)).toEqual(["properties"]);
    expect(Object.keys(result.patch.properties)).toEqual(["template"]);
    const expected = structuredClone(resource("app").properties.template) as { revisionSuffix?: string; containers: { image: string }[] };
    delete expected.revisionSuffix;
    expected.containers[0].image = NEW;
    expect(result.patch.properties.template).toEqual(expected);
    expect(result.output).toContain("web: revision web--2 is ready and runs " + NEW);
    expect(result.githubOutput).toBe("revision=web--2\n");
  });

  it("never sends the configuration, so a job's trigger (a stopped tick, G10) is kept", () => {
    const result = setImage("job");
    expect(result.status).toBe(0);
    expect(result.patch.properties).not.toHaveProperty("configuration");
    expect(result.output).toContain("web: runs " + NEW);
  });

  it("fails, naming the revision, when the new revision isn't ready in time", () => {
    const result = setImage("app", { FAKE_PATCH_RESULT: "never-ready" });
    expect(result.status).toBe(1);
    expect(result.output).toContain("revision web--2 with " + NEW + " isn't ready after 1 s; the previous revision keeps serving (single revision mode).");
  });

  it("fails when provisioning fails", () => {
    const result = setImage("app", { FAKE_PATCH_RESULT: "failed" });
    expect(result.status).toBe(1);
    expect(result.output).toContain("provisioning Failed");
  });

  it("fails when anything but the image changed, printing names only", () => {
    const result = setImage("app", { FAKE_PATCH_RESULT: "drops-secret" });
    expect(result.status).toBe(1);
    expect(result.output).toContain("only the image may change");
    expect(result.output).toContain('-    "database-url"');
    expect(result.output).not.toContain("azure\"");
  });

  it("changes nothing when the image is already set (a rerun)", () => {
    const initial = resource("job");
    initial.properties.template.containers[0].image = NEW;
    const result = setImage("job", {}, initial);
    expect(result.status).toBe(0);
    expect(result.patch).toBeUndefined();
    expect(result.output).toContain("already runs");
  });
});

describe("infra/smoke-test.sh", () => {
  const revision = (name: string, active: boolean, traffic: number, image: string) => ({
    name,
    properties: { active, trafficWeight: traffic, template: { containers: [{ image }] } },
  });
  const smoke = (health: string, page1: object[], page2?: object[]) =>
    withFakes(
      (dir) => {
        writeFileSync(path.join(dir, "revisions-1.json"), JSON.stringify({ value: page1, ...(page2 ? { nextLink: "https://management.azure.com/s/rg/res/web/revisions?page=2" } : {}) }));
        writeFileSync(path.join(dir, "revisions-2.json"), JSON.stringify({ value: page2 ?? [] }));
      },
      (_dir, env) => runScript("infra/smoke-test.sh", ["web", "https://app.example", NEW], { ...env, HEALTH: health, SMOKE_TEST_ATTEMPTS: "4", SMOKE_TEST_WAIT_SECONDS: "0" }),
    );

  it("retries health until it is ok, then finds one active revision on the new image across pages", () => {
    const result = smoke("down 503 ok", [revision("web--1", false, 0, OLD)], [revision("web--2", true, 100, NEW)]);
    expect(result.output).not.toContain("::error::");
    expect(result.status).toBe(0);
    expect(result.output).toContain("Attempt 2: GET https://app.example/api/health returned 503");
    expect(result.output).toContain("Active revision web--2: 100 % of the traffic, " + NEW);
  });

  it("fails when health never returns ok", () => {
    const result = smoke("503", [revision("web--2", true, 100, NEW)]);
    expect(result.status).toBe(1);
    expect(result.output).toContain("did not return 200 with everything ok");
  });

  it("fails when two revisions are active", () => {
    const result = smoke("ok", [revision("web--1", true, 0, OLD), revision("web--2", true, 100, NEW)]);
    expect(result.status).toBe(1);
    expect(result.output).toContain("has 2 active revisions");
  });

  it("fails when the active revision runs another image", () => {
    const result = smoke("ok", [revision("web--1", true, 100, OLD)]);
    expect(result.status).toBe(1);
    expect(result.output).toContain("expected 100 % and " + NEW);
  });
});
