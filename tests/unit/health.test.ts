// Health checks (tech-stack.md M5) with stub checks: fixed body, timeout per
// check, nothing about the failure in the response.
import { describe, expect, it } from "vitest";
import { runHealthChecks } from "@/server/health";

const ok = async () => undefined;
const refused = async () => {
  throw Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432 password=secret"), { code: "ECONNREFUSED" });
};
const hang = () => new Promise<never>(() => {});

describe("runHealthChecks", () => {
  it("returns 200 with a fixed body when both checks pass", async () => {
    expect(await runHealthChecks({ database: ok, storage: ok })).toEqual({
      httpStatus: 200,
      body: { status: "ok", database: "ok", storage: "ok" },
    });
  });

  it("returns 503 naming only the failed part, without error text", async () => {
    const result = await runHealthChecks({ database: refused, storage: ok });
    expect(result).toEqual({ httpStatus: 503, body: { status: "fail", database: "fail", storage: "ok" } });
    expect(JSON.stringify(result)).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|secret/);
  });

  it("fails a check that doesn't answer within the timeout, and aborts it", async () => {
    let aborted = false;
    const started = Date.now();
    const result = await runHealthChecks(
      {
        database: ok,
        storage: (signal) => {
          signal.addEventListener("abort", () => (aborted = true));
          return hang();
        },
      },
      50,
    );
    expect(result.body).toEqual({ status: "fail", database: "ok", storage: "fail" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(aborted).toBe(true);
  });

  it("runs the checks concurrently", async () => {
    const started = Date.now();
    const result = await runHealthChecks({ database: hang, storage: hang }, 200);
    expect(result.body).toEqual({ status: "fail", database: "fail", storage: "fail" });
    expect(Date.now() - started).toBeLessThan(380);
  });
});
