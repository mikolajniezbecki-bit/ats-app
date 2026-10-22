import { afterEach, describe, expect, it, vi } from "vitest";

describe("job queue adapter", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("importing it with an empty environment neither throws nor creates a pool or pg-boss instance", async () => {
    for (const key of ["DATABASE_URL", "BETTER_AUTH_SECRET", "APP_ENV"]) vi.stubEnv(key, undefined);
    const global = globalThis as { __atsBoss?: unknown; __atsDb?: unknown };

    const adapter = await import("@/server/adapters/job-queue");

    expect(typeof adapter.jobQueue.enqueue).toBe("function");
    expect(global.__atsBoss).toBeUndefined();
    expect(global.__atsDb).toBeUndefined();
  });

  it("declares the four queues of tech-stack.md §5 with their options", async () => {
    const { JOB_QUEUES } = await import("@/server/adapters/job-queue");
    expect(JOB_QUEUES).toEqual({
      "email.send": { retryLimit: 5, retryBackoff: true },
      "offer.render-pdf": { retryLimit: 3 },
      "approvals.remind": { policy: "singleton" },
      "retention.purge": { policy: "singleton" },
    });
  });
});
