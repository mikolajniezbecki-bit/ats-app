// The guard in front of the integration-test setup, which drops databases.
import { describe, expect, it } from "vitest";
import { baseDatabaseUrl, databaseUrlFor } from "../integration/database";

const url = (host: string) => `postgres://ats:test-only@${host}:5432/ats`;

describe("integration test database guard", () => {
  it.each(["localhost", "127.0.0.1", "postgres"])("accepts %s", (host) => {
    expect(baseDatabaseUrl({ DATABASE_URL: url(host) })).toBe(url(host));
  });

  it("defaults to the Compose PostgreSQL", () => {
    expect(new URL(baseDatabaseUrl({})).host).toBe("localhost:5432");
  });

  it.each(["ats-db.postgres.database.azure.com", "10.0.0.5", "localhost.example.com"])("refuses %s", (host) => {
    expect(() => baseDatabaseUrl({ DATABASE_URL: url(host) })).toThrow(/only run against a local PostgreSQL/);
  });

  it("refuses APP_ENV=azure even on localhost", () => {
    expect(() => baseDatabaseUrl({ DATABASE_URL: url("localhost"), APP_ENV: "azure" })).toThrow(/APP_ENV must not be azure/);
  });

  it("swaps only the database name", () => {
    expect(databaseUrlFor(`${url("localhost")}?sslmode=disable`, "ats_test_3")).toBe(
      "postgres://ats:test-only@localhost:5432/ats_test_3?sslmode=disable",
    );
  });
});
