import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { CONFIG_KEYS, loadConfig } from "@/server/config";

type Step = { name?: string; run?: string; env?: Record<string, string> };
type Workflow = {
  jobs: { ci: { env?: Record<string, string>; services: Record<string, { image: string }>; steps: Step[] } };
};

const job = (parse(readFileSync(path.resolve(".github/workflows/ci.yml"), "utf8")) as Workflow).jobs.ci;
const runs = job.steps.map((step) => step.run).filter(Boolean);

describe("ci.yml", () => {
  it("runs the integration tests against a postgres:17 service after verify and before the build", () => {
    expect(job.services.postgres.image).toBe("postgres:17");
    const order = ["pnpm verify", "pnpm db:migrate", "pnpm test:integration", "pnpm build"].map((command) =>
      runs.findIndex((run) => run!.startsWith(command)),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("gives db:migrate a configuration that loadConfig accepts, pointing at the service", () => {
    const migrate = job.steps.find((step) => step.run === "pnpm db:migrate")!;
    const config = loadConfig({ ...migrate.env });
    expect(new URL(config.databaseUrl).host).toBe("localhost:5432");
    expect(config.appEnv).toBe("ci");
  });

  it("W1: runs next build with no database URL and no configuration variables in its environment", () => {
    const build = job.steps.find((step) => step.run === "pnpm build")!;
    const buildEnv = { ...job.env, ...build.env };
    expect(Object.keys(buildEnv).filter((key) => (CONFIG_KEYS as string[]).includes(key))).toEqual([]);
    expect(JSON.stringify(buildEnv)).not.toMatch(/postgres(ql)?:\/\//);
  });

  it("starts Azurite with the same image and command as docker-compose.yml, before the integration tests", () => {
    const compose = parse(readFileSync(path.resolve("docker-compose.yml"), "utf8")) as {
      services: { azurite: { image: string; command: string } };
    };
    const start = job.steps.find((step) => step.name === "Start Azurite")!;
    const command = start.run!.replace(/\s+/g, " ");
    expect(command).toContain(`${compose.services.azurite.image} ${compose.services.azurite.command}`);
    expect(command).toContain("-p 10000:10000");
    const index = (s: Step | undefined) => job.steps.indexOf(s!);
    expect(index(start)).toBeLessThan(index(job.steps.find((step) => step.run?.startsWith("pnpm test:integration"))));
  });

  it("runs Mailpit as a service with the docker-compose.yml image, on the SMTP and API ports", () => {
    const compose = parse(readFileSync(path.resolve("docker-compose.yml"), "utf8")) as { services: { mailpit: { image: string } } };
    const mailpit = job.services.mailpit as { image: string; ports: string[] };
    expect(mailpit.image).toBe(compose.services.mailpit.image);
    expect(mailpit.ports).toEqual(["1025:1025", "8025:8025"]);
  });
});
