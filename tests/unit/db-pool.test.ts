import { describe, expect, it, vi } from "vitest";
import { CONNECTION_TIMEOUT_MS, POOL_MAX, buildPoolOptions } from "@/server/db/pool-options";
import { isConnectionError, rootCause } from "@/server/db/migrator";

// Obviously fake values; never used outside tests.
const COMPOSE = "postgres://ats:test-only@postgres:5432/ats";
const AZURE = "postgresql://ats_app:test-only@ats-db.postgres.database.azure.com:5432/ats?sslmode=require";

describe("buildPoolOptions", () => {
  it("D5: connects without TLS when the URL has no sslmode (Compose)", () => {
    const options = buildPoolOptions(COMPOSE);
    expect(options.ssl).toBe(false);
    expect(options.connectionString).toBe(COMPOSE);
  });

  it("D5: connects with verified TLS for sslmode=require (Azure) and removes sslmode from the URL", () => {
    const options = buildPoolOptions(AZURE);
    expect(options.ssl).toEqual({ rejectUnauthorized: true });
    // node-postgres would otherwise parse sslmode and override `ssl`.
    expect(options.connectionString).not.toContain("sslmode");
    expect(new URL(options.connectionString!).hostname).toBe("ats-db.postgres.database.azure.com");
  });

  it("D5: verifies certificates for every TLS mode and disables TLS only for sslmode=disable", () => {
    for (const mode of ["prefer", "require", "verify-ca", "verify-full"]) {
      expect(buildPoolOptions(`${COMPOSE}?sslmode=${mode}`).ssl).toEqual({ rejectUnauthorized: true });
    }
    expect(buildPoolOptions(`${COMPOSE}?sslmode=disable`).ssl).toBe(false);
  });

  it("D5: keeps other query parameters", () => {
    const options = buildPoolOptions(`${COMPOSE}?sslmode=require&application_name=ats`);
    expect(new URL(options.connectionString!).searchParams.get("application_name")).toBe("ats");
  });

  it("D5: allows at most 10 connections and times out connecting", () => {
    const options = buildPoolOptions(COMPOSE);
    expect(options.max).toBe(POOL_MAX);
    expect(POOL_MAX).toBe(10);
    expect(options.connectionTimeoutMillis).toBe(CONNECTION_TIMEOUT_MS);
    expect(buildPoolOptions(COMPOSE, { max: 1 }).max).toBe(1);
  });
});

describe("connection errors", () => {
  it("unwraps the driver error behind a Drizzle query error", () => {
    const driver = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
    const wrapped = new Error("Failed query: CREATE SCHEMA", { cause: driver });
    expect(rootCause(wrapped)).toBe(driver);
    expect(isConnectionError(wrapped)).toBe(true);
  });

  it("treats a connection timeout as a connection error and a SQL error as not", () => {
    expect(isConnectionError(new Error("Connection terminated due to connection timeout"))).toBe(true);
    expect(isConnectionError(Object.assign(new Error("syntax error"), { code: "42601" }))).toBe(false);
  });
});

describe("database module", () => {
  it("D5: imports with an empty environment and reads the configuration only on getDb()", async () => {
    const saved = process.env;
    process.env = {} as NodeJS.ProcessEnv;
    try {
      vi.resetModules();
      const db = await import("@/server/db");
      expect(() => db.getDb()).toThrow(/missing DATABASE_URL/);
      await db.closeDb();
    } finally {
      process.env = saved;
    }
  });
});
