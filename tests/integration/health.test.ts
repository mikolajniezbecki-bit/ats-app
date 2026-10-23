// GET /api/health (tech-stack.md M5) against the real database and Azurite,
// and with each one unreachable.
import { describe, expect, it } from "vitest";
import pg from "pg";
import { GET as health } from "@/app/api/health/route";
import { createStorageService } from "@/server/adapters/storage";
import { getPool } from "@/server/db";
import { runHealthChecks } from "@/server/health";

const AZURITE_KEY = "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";

describe("health", () => {
  it("returns 200 with the fixed body when database and storage are reachable", async () => {
    const response = await health();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "ok", database: "ok", storage: "ok" });
  });

  it("returns 503 with database fail within 4 s when PostgreSQL is unreachable", async () => {
    const closed = new pg.Pool({ connectionString: "postgres://ats:wrong@127.0.0.1:1/ats", max: 1 });
    closed.on("error", () => {});
    const started = Date.now();
    try {
      const result = await runHealthChecks({
        database: () => closed.query("select 1"),
        storage: (signal) => createStorageService({ mode: "connectionString", connectionString: "UseDevelopmentStorage=true", publicUrl: undefined }).checkHealth(signal),
      });
      expect(result).toEqual({ httpStatus: 503, body: { status: "fail", database: "fail", storage: "ok" } });
      expect(Date.now() - started).toBeLessThan(4_000);
    } finally {
      await closed.end();
    }
  });

  it("returns 503 with storage fail when the Blob endpoint is unreachable", async () => {
    const unreachable = createStorageService({
      mode: "connectionString",
      connectionString: `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=${AZURITE_KEY};BlobEndpoint=http://127.0.0.1:1/devstoreaccount1;`,
      publicUrl: undefined,
    });
    const started = Date.now();
    const result = await runHealthChecks({ database: () => getPool().query("select 1"), storage: (signal) => unreachable.checkHealth(signal) });
    expect(result).toEqual({ httpStatus: 503, body: { status: "fail", database: "ok", storage: "fail" } });
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});
