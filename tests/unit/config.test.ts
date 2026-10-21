import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG_KEYS, ConfigError, loadConfig } from "@/server/config";

// Obviously fake values; never used outside tests.
const LOCAL: Record<string, string> = {
  DATABASE_URL: "postgres://ats:test-only@localhost:5432/ats",
  BETTER_AUTH_SECRET: "test-only-auth-secret",
  BETTER_AUTH_URL: "http://localhost:3000",
  APP_ENV: "local",
  EMAIL_HASH_KEY: "test-only-hash-key",
  EMAIL_PROVIDER: "smtp",
  SMTP_HOST: "localhost",
  SMTP_PORT: "1025",
  AZURE_STORAGE_CONNECTION_STRING: "UseDevelopmentStorage=true",
  TURNSTILE_SITE_KEY: "test-only-site-key",
  TURNSTILE_SECRET_KEY: "test-only-turnstile-secret",
  TICK_SECRET: "test-only-tick-secret",
};

const MICROSOFT: Record<string, string> = {
  MICROSOFT_CLIENT_ID: "test-only-client-id",
  MICROSOFT_TENANT_ID: "00000000-0000-4000-8000-000000000000",
  MICROSOFT_CLIENT_SECRET: "test-only-client-secret",
};

const AZURE: Record<string, string | undefined> = {
  ...LOCAL,
  ...MICROSOFT,
  APP_ENV: "azure",
  EMAIL_PROVIDER: "outbox",
  SMTP_HOST: undefined,
  SMTP_PORT: undefined,
  AZURE_STORAGE_CONNECTION_STRING: undefined,
  AZURE_STORAGE_ACCOUNT_URL: "https://atstest.blob.core.windows.net",
  AZURE_CLIENT_ID: "test-only-managed-identity",
  LOG_LEVEL: "info",
};

function errorOf(env: Record<string, string | undefined>): string {
  try {
    loadConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error("expected loadConfig to throw");
}

function without(env: Record<string, string | undefined>, ...keys: string[]) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !keys.includes(key)));
}

describe("loadConfig", () => {
  it("returns a typed local configuration with defaults", () => {
    const config = loadConfig(LOCAL);
    expect(config.appEnv).toBe("local");
    expect(config.auth.devLogin).toBe(false);
    expect(config.auth.microsoft).toBeNull();
    expect(config.email).toEqual({ provider: "smtp", host: "localhost", port: 1025 });
    expect(config.storage).toEqual({
      mode: "connectionString",
      connectionString: "UseDevelopmentStorage=true",
      publicUrl: undefined,
    });
    expect(config.workerEnabled).toBe(false);
    expect(config.logLevel).toBe("info");
  });

  it("returns a typed Azure configuration", () => {
    const config = loadConfig(AZURE);
    expect(config.email).toEqual({ provider: "outbox" });
    expect(config.storage).toEqual({
      mode: "managedIdentity",
      accountUrl: "https://atstest.blob.core.windows.net",
      clientId: "test-only-managed-identity",
    });
    expect(config.auth.microsoft).toEqual({
      clientId: "test-only-client-id",
      tenantId: "00000000-0000-4000-8000-000000000000",
      clientSecret: "test-only-client-secret",
    });
  });

  it("ignores variables outside the schema", () => {
    expect(() => loadConfig({ ...LOCAL, PATH: "/usr/bin", NODE_ENV: "test" })).not.toThrow();
  });

  it.each([
    "DATABASE_URL",
    "BETTER_AUTH_SECRET",
    "BETTER_AUTH_URL",
    "APP_ENV",
    "EMAIL_HASH_KEY",
    "EMAIL_PROVIDER",
    "TURNSTILE_SITE_KEY",
    "TURNSTILE_SECRET_KEY",
    "TICK_SECRET",
  ])("requires %s", (key) => {
    expect(errorOf(without(LOCAL, key))).toContain(`missing ${key}`);
  });

  it("names every missing variable in one error", () => {
    const message = errorOf(without(LOCAL, "DATABASE_URL", "TICK_SECRET", "EMAIL_HASH_KEY", "SMTP_PORT"));
    for (const key of ["DATABASE_URL", "TICK_SECRET", "EMAIL_HASH_KEY", "SMTP_PORT"]) {
      expect(message).toContain(key);
    }
  });

  it("names variables, never their values", () => {
    const message = errorOf({
      ...without(LOCAL, "TICK_SECRET"),
      BETTER_AUTH_SECRET: "super-secret-test-value",
      DATABASE_URL: "mysql://super-secret-test-value@db",
    });
    expect(message).toContain("TICK_SECRET");
    expect(message).toContain("DATABASE_URL");
    expect(message).not.toContain("super-secret-test-value");
  });

  it("treats an empty value as missing", () => {
    expect(errorOf({ ...LOCAL, TICK_SECRET: "" })).toContain("missing TICK_SECRET");
    expect(errorOf({ ...LOCAL, APP_ENV: "" })).toContain("missing APP_ENV");
    // Optional values fall back to their default.
    expect(loadConfig({ ...LOCAL, AUTH_DEV_LOGIN: "", LOG_LEVEL: "" }).logLevel).toBe("info");
  });

  it.each([
    ["AUTH_DEV_LOGIN", "1"],
    ["AUTH_DEV_LOGIN", "TRUE"],
    ["WORKER_ENABLED", "yes"],
    ["APP_ENV", "Azure"],
    ["APP_ENV", "production"],
    ["EMAIL_PROVIDER", "SMTP"],
    ["LOG_LEVEL", "verbose"],
  ])("rejects %s=%s instead of treating it as a default", (key, value) => {
    expect(errorOf({ ...LOCAL, [key]: value })).toContain(`invalid ${key}`);
  });

  it.each([
    ["DATABASE_URL", "mysql://localhost/ats"],
    ["DATABASE_URL", "postgres-ish"],
    ["DATABASE_ADMIN_URL", "http://localhost"],
    ["BETTER_AUTH_URL", "localhost:3000"],
    ["AZURE_STORAGE_PUBLIC_URL", "not a url"],
    ["SMTP_PORT", "0"],
    ["SMTP_PORT", "65536"],
    ["SMTP_PORT", "25.5"],
    ["SMTP_PORT", "abc"],
    ["DEMO_USER_PASSWORD", "too-short"],
    ["SEED_ADMIN_EMAIL", "not-an-email"],
  ])("rejects %s=%s", (key, value) => {
    expect(errorOf({ ...LOCAL, [key]: value })).toContain(`invalid ${key}`);
  });

  it("accepts both postgres URL schemes", () => {
    expect(loadConfig({ ...LOCAL, DATABASE_URL: "postgresql://ats@localhost/ats" }).databaseUrl).toBe(
      "postgresql://ats@localhost/ats",
    );
  });

  it("parses the boolean flags and optional values", () => {
    const config = loadConfig({
      ...LOCAL,
      AUTH_DEV_LOGIN: "true",
      WORKER_ENABLED: "true",
      LOG_LEVEL: "debug",
      DEMO_USER_PASSWORD: "test-only-demo-password",
      DEMO_USER_DOMAIN: "ats-demo.local",
      SEED_ADMIN_EMAIL: "admin@example.com",
      DATABASE_ADMIN_URL: "postgres://admin:test-only@localhost/ats",
    });
    expect(config.auth.devLogin).toBe(true);
    expect(config.workerEnabled).toBe(true);
    expect(config.logLevel).toBe("debug");
    expect(config.demoUser).toEqual({ password: "test-only-demo-password", domain: "ats-demo.local" });
    expect(config.seedAdminEmail).toBe("admin@example.com");
    expect(config.databaseAdminUrl).toBe("postgres://admin:test-only@localhost/ats");
  });

  it("needs SMTP_HOST and SMTP_PORT only with EMAIL_PROVIDER=smtp", () => {
    const message = errorOf(without(LOCAL, "SMTP_HOST", "SMTP_PORT"));
    expect(message).toContain("SMTP_HOST");
    expect(message).toContain("SMTP_PORT");
    expect(() =>
      loadConfig({ ...without(LOCAL, "SMTP_HOST", "SMTP_PORT"), APP_ENV: "ci", EMAIL_PROVIDER: "outbox" }),
    ).not.toThrow();
  });

  describe("storage (tech-stack.md §8)", () => {
    const noStorage = without(LOCAL, "AZURE_STORAGE_CONNECTION_STRING");

    it("fails and names the variables when neither mode is complete", () => {
      const message = errorOf(noStorage);
      for (const key of ["AZURE_STORAGE_CONNECTION_STRING", "AZURE_STORAGE_ACCOUNT_URL", "AZURE_CLIENT_ID"]) {
        expect(message).toContain(key);
      }
    });

    it("fails when only half of managed identity is set", () => {
      const message = errorOf({ ...noStorage, AZURE_CLIENT_ID: "test-only-managed-identity" });
      expect(message).toContain("missing AZURE_STORAGE_CONNECTION_STRING, AZURE_STORAGE_ACCOUNT_URL");
    });

    it("uses managed identity when the account URL and client ID are set", () => {
      const config = loadConfig({
        ...noStorage,
        AZURE_STORAGE_ACCOUNT_URL: "https://atstest.blob.core.windows.net",
        AZURE_CLIENT_ID: "test-only-managed-identity",
      });
      expect(config.storage.mode).toBe("managedIdentity");
    });

    it("prefers the connection string when both are set", () => {
      const config = loadConfig({
        ...LOCAL,
        AZURE_STORAGE_PUBLIC_URL: "http://localhost:10000/devstoreaccount1",
        AZURE_STORAGE_ACCOUNT_URL: "https://atstest.blob.core.windows.net",
        AZURE_CLIENT_ID: "test-only-managed-identity",
      });
      expect(config.storage).toEqual({
        mode: "connectionString",
        connectionString: "UseDevelopmentStorage=true",
        publicUrl: "http://localhost:10000/devstoreaccount1",
      });
    });
  });

  describe("Microsoft Entra variables (tech-stack.md §3, AU1)", () => {
    it("requires all three with APP_ENV=azure", () => {
      const message = errorOf(without(AZURE, ...Object.keys(MICROSOFT)));
      for (const key of Object.keys(MICROSOFT)) expect(message).toContain(key);
    });

    it("are optional outside Azure", () => {
      expect(loadConfig({ ...LOCAL, APP_ENV: "ci" }).auth.microsoft).toBeNull();
      expect(loadConfig({ ...LOCAL, ...MICROSOFT }).auth.microsoft).not.toBeNull();
    });

    it("are set together or not at all", () => {
      const message = errorOf({ ...LOCAL, MICROSOFT_CLIENT_ID: "test-only-client-id" });
      expect(message).toContain("missing MICROSOFT_TENANT_ID, MICROSOFT_CLIENT_SECRET");
    });

    it.each(["common", "organizations", "contoso.onmicrosoft.com"])("refuses tenant %s (GUID only)", (tenant) => {
      expect(errorOf({ ...LOCAL, ...MICROSOFT, MICROSOFT_TENANT_ID: tenant })).toContain(
        "invalid MICROSOFT_TENANT_ID",
      );
    });
  });

  it("refuses APP_ENV=azure without EMAIL_PROVIDER=outbox (§3 rule 10)", () => {
    expect(errorOf({ ...AZURE, EMAIL_PROVIDER: "smtp", SMTP_HOST: "smtp.example.com", SMTP_PORT: "25" })).toContain(
      "APP_ENV=azure requires EMAIL_PROVIDER=outbox",
    );
  });
});

describe("AU7 guard", () => {
  const SMTP = { SMTP_HOST: "localhost", SMTP_PORT: "1025" };

  it.each([
    ["APP_ENV=azure, EMAIL_PROVIDER=smtp", { ...AZURE, ...SMTP, EMAIL_PROVIDER: "smtp" }, ["APP_ENV"]],
    ["APP_ENV=ci, EMAIL_PROVIDER=outbox", { ...LOCAL, APP_ENV: "ci", EMAIL_PROVIDER: "outbox" }, ["EMAIL_PROVIDER"]],
    ["APP_ENV=azure, EMAIL_PROVIDER=outbox", AZURE, ["APP_ENV", "EMAIL_PROVIDER"]],
    ["APP_ENV=azure, NODE_ENV=development", { ...AZURE, NODE_ENV: "development" }, ["APP_ENV"]],
  ])("AU7: dev sign-in is refused with %s", (_, env, conflicts) => {
    const message = errorOf({ ...env, AUTH_DEV_LOGIN: "true" });
    expect(message).toMatch(/^AU7:/);
    for (const key of ["AUTH_DEV_LOGIN", ...conflicts]) expect(message).toContain(key);
  });

  it("AU7: dev sign-in is accepted in the CI production image, whatever incidental Azure variables are set", () => {
    const config = loadConfig({
      ...LOCAL,
      AUTH_DEV_LOGIN: "true",
      NODE_ENV: "production",
      APP_ENV: "ci",
      EMAIL_PROVIDER: "smtp",
      AZURE_CLIENT_ID: "test-only-managed-identity",
      AZURE_STORAGE_ACCOUNT_URL: "https://atstest.blob.core.windows.net",
    });
    expect(config.auth.devLogin).toBe(true);
    expect(config.appEnv).toBe("ci");
  });

  it.each([["false"], [undefined]])("AU7: Azure with the Outbox is accepted with AUTH_DEV_LOGIN=%s", (devLogin) => {
    expect(loadConfig({ ...AZURE, AUTH_DEV_LOGIN: devLogin }).auth.devLogin).toBe(false);
  });
});

describe("getConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  function stubEnv(env: Record<string, string | undefined>) {
    for (const key of CONFIG_KEYS) vi.stubEnv(key, env[key]);
  }

  it("does not validate when the module is imported with an empty environment", async () => {
    const saved = process.env;
    process.env = {} as NodeJS.ProcessEnv;
    try {
      vi.resetModules();
      const config = await import("@/server/config");
      expect(() => config.getConfig()).toThrow(/missing DATABASE_URL/);
    } finally {
      process.env = saved;
    }
  });

  it("caches the first result even if process.env changes", async () => {
    stubEnv(LOCAL);
    const { getConfig } = await import("@/server/config");
    const first = getConfig();
    vi.stubEnv("APP_ENV", "ci");
    vi.stubEnv("TICK_SECRET", undefined);
    expect(getConfig()).toBe(first);
    expect(getConfig().appEnv).toBe("local");
  });

  it("does not cache a failed validation", async () => {
    stubEnv(without(LOCAL, "TICK_SECRET"));
    const { getConfig } = await import("@/server/config");
    expect(() => getConfig()).toThrow(/TICK_SECRET/);
    vi.stubEnv("TICK_SECRET", "test-only-tick-secret");
    expect(getConfig().tickSecret).toBe("test-only-tick-secret");
  });

  it("is never called at module top level under src/", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(path.resolve("src"))) {
      const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node, insideFunction: boolean): void => {
        if (
          !insideFunction &&
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "getConfig"
        ) {
          offenders.push(`${path.relative(process.cwd(), file)}:${source.getLineAndCharacterOfPosition(node.pos).line + 1}`);
        }
        ts.forEachChild(node, (child) => visit(child, insideFunction || ts.isFunctionLike(node)));
      };
      visit(source, false);
    }
    expect(offenders).toEqual([]);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

describe(".env.example", () => {
  const lines = readFileSync(path.resolve(".env.example"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const entries = lines.map((line) => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1)] as const;
  });
  const example = Object.fromEntries(entries);

  it("lists every configuration variable exactly once", () => {
    const keys = entries.map(([key]) => key);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual([...CONFIG_KEYS].sort());
  });

  it("leaves secrets empty and holds local-development values", () => {
    const secrets = [
      "DATABASE_URL",
      "DATABASE_ADMIN_URL",
      "BETTER_AUTH_SECRET",
      "MICROSOFT_CLIENT_SECRET",
      "EMAIL_HASH_KEY",
      "AZURE_STORAGE_CONNECTION_STRING",
      "TURNSTILE_SITE_KEY",
      "TURNSTILE_SECRET_KEY",
      "TICK_SECRET",
      "DEMO_USER_PASSWORD",
    ];
    for (const key of secrets) expect(example[key], key).toBe("");
    expect(example).toMatchObject({
      APP_ENV: "local",
      AUTH_DEV_LOGIN: "true",
      EMAIL_PROVIDER: "smtp",
      SMTP_HOST: "localhost",
      SMTP_PORT: "1025",
      BETTER_AUTH_URL: "http://localhost:3000",
      WORKER_ENABLED: "true",
      LOG_LEVEL: "debug",
    });
  });

  it("is accepted by loadConfig once the local secrets are filled in", () => {
    // Entra stays empty locally: its three variables are set together (AU1).
    const config = loadConfig({
      ...example,
      DATABASE_URL: "postgres://ats:test-only@localhost:5432/ats",
      DATABASE_ADMIN_URL: "postgres://admin:test-only@localhost:5432/ats",
      BETTER_AUTH_SECRET: "test-only-auth-secret",
      EMAIL_HASH_KEY: "test-only-hash-key",
      AZURE_STORAGE_CONNECTION_STRING: "UseDevelopmentStorage=true",
      TURNSTILE_SITE_KEY: "test-only-site-key",
      TURNSTILE_SECRET_KEY: "test-only-turnstile-secret",
      TICK_SECRET: "test-only-tick-secret",
      DEMO_USER_PASSWORD: "test-only-demo-password",
    });
    expect(config.appEnv).toBe("local");
    expect(config.auth.devLogin).toBe(true);
  });
});
