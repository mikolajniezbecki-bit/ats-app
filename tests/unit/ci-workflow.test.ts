import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@/server/config";

type Step = { run?: string; env?: Record<string, string> };
type Workflow = {
  jobs: { ci: { env: Record<string, string>; services: Record<string, { image: string }>; steps: Step[] } };
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
    const config = loadConfig({ ...job.env, ...migrate.env });
    expect(new URL(config.databaseUrl).host).toBe("localhost:5432");
    expect(config.appEnv).toBe("ci");
  });
});
