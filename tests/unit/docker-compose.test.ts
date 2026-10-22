import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@/server/config";

type ComposeFile = {
  services: Record<
    string,
    { environment?: Record<string, string | number | boolean>; healthcheck?: { test: string[] } }
  >;
};

const compose: ComposeFile = parse(readFileSync(path.resolve("docker-compose.yml"), "utf8"));
const appEnv = Object.fromEntries(
  Object.entries(compose.services.app.environment ?? {}).map(([key, value]) => [key, String(value)]),
);

describe("docker-compose.yml", () => {
  it("defines exactly the app, postgres, azurite and mailpit services", () => {
    expect(Object.keys(compose.services).sort()).toEqual(["app", "azurite", "mailpit", "postgres"]);
  });

  it("gives the app a configuration that loadConfig accepts", () => {
    const config = loadConfig(appEnv);
    expect(config.appEnv).toBe("ci");
    expect(config.email).toEqual({ provider: "smtp", host: "mailpit", port: 1025 });
    expect(config.storage).toMatchObject({
      mode: "connectionString",
      publicUrl: "http://localhost:10000/devstoreaccount1",
    });
    expect(config.auth.microsoft).toBeNull();
  });

  it("reports PostgreSQL healthy only once it accepts TCP connections, so the app starts on a fresh volume", () => {
    expect(compose.services.postgres.healthcheck?.test.join(" ")).toMatch(/pg_isready -h 127\.0\.0\.1 /);
  });

  it("runs the app as the CI-style production image (Sprint 0 proof 5)", () => {
    expect(appEnv).toMatchObject({
      NODE_ENV: "production",
      APP_ENV: "ci",
      AUTH_DEV_LOGIN: "true",
      EMAIL_PROVIDER: "smtp",
    });
  });

  it("uses only obviously fake or publicly documented secret values", () => {
    for (const key of ["BETTER_AUTH_SECRET", "EMAIL_HASH_KEY", "TICK_SECRET", "DEMO_USER_PASSWORD"]) {
      expect(appEnv[key], key).toMatch(/^local-only-not-secret-/);
    }
    expect(appEnv.DATABASE_URL).toContain(":local-only-not-secret-");
  });
});
