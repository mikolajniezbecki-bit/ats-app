// Typed configuration (tech-stack.md §3 rule 5): every environment variable
// from the §3 table is validated here, on the first getConfig() call and never
// at import time, so `next build` needs no secrets (§15 proof 3).
//
// Errors name variables, never their values: a message may end up in a log or
// a CI transcript, and some of these values are secrets.
import "server-only";
import { z } from "zod";

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

const postgresUrl = z
  .string()
  .refine((value) => /^postgres(ql)?:\/\//.test(value) && URL.canParse(value));
const url = z.string().refine((value) => /^https?:\/\//.test(value) && URL.canParse(value));
const flag = z.enum(["true", "false"]).default("false");

// One entry per §3 variable. Conditional requirements (SMTP, storage,
// Microsoft) are checked in loadConfig, so they are optional here.
const envSchema = z.object({
  DATABASE_URL: postgresUrl,
  BETTER_AUTH_SECRET: z.string(),
  BETTER_AUTH_URL: url,
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_TENANT_ID: z.guid().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  APP_ENV: z.enum(["local", "ci", "azure"]),
  AUTH_DEV_LOGIN: flag,
  EMAIL_HASH_KEY: z.string(),
  EMAIL_PROVIDER: z.enum(["smtp", "outbox"]),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(65535))
    .optional(),
  AZURE_STORAGE_CONNECTION_STRING: z.string().optional(),
  AZURE_STORAGE_PUBLIC_URL: url.optional(),
  AZURE_STORAGE_ACCOUNT_URL: url.optional(),
  AZURE_CLIENT_ID: z.string().optional(),
  TURNSTILE_SITE_KEY: z.string(),
  TURNSTILE_SECRET_KEY: z.string(),
  TICK_SECRET: z.string(),
  DEMO_USER_PASSWORD: z.string().min(12).optional(),
  DEMO_USER_DOMAIN: z.string().optional(),
  DATABASE_ADMIN_URL: postgresUrl.optional(),
  SEED_ADMIN_EMAIL: z.email().optional(),
  WORKER_ENABLED: flag,
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
});

type EnvKey = keyof typeof envSchema.shape;

/** Every configuration variable, in §3 order (also checked against `.env.example`). */
export const CONFIG_KEYS = Object.keys(envSchema.shape) as EnvKey[];

export type AppConfig = {
  appEnv: "local" | "ci" | "azure";
  databaseUrl: string;
  /** Migrations only; `db:migrate` falls back to `databaseUrl`. */
  databaseAdminUrl: string | undefined;
  auth: {
    secret: string;
    url: string;
    devLogin: boolean;
    /** Null when the Microsoft variables are not set (AU1). */
    microsoft: { clientId: string; tenantId: string; clientSecret: string } | null;
  };
  emailHashKey: string;
  email: { provider: "smtp"; host: string; port: number } | { provider: "outbox" };
  /** Connection string (Azurite) wins over managed identity (§8). */
  storage:
    | { mode: "connectionString"; connectionString: string; publicUrl: string | undefined }
    | { mode: "managedIdentity"; accountUrl: string; clientId: string };
  turnstile: { siteKey: string; secretKey: string };
  tickSecret: string;
  demoUser: { password: string | undefined; domain: string | undefined };
  seedAdminEmail: string | undefined;
  workerEnabled: boolean;
  logLevel: (typeof LOG_LEVELS)[number];
};

export class ConfigError extends Error {
  override name = "ConfigError";
}

function present(env: Partial<Record<EnvKey, string | undefined>>, keys: EnvKey[]): EnvKey[] {
  return keys.filter((key) => env[key] !== undefined);
}

/**
 * Validates an environment object and returns the typed configuration, or
 * throws a ConfigError naming every missing or invalid variable. Pure: no
 * caching, no logging, no reads from process.env.
 */
export function loadConfig(source: Record<string, string | undefined>): AppConfig {
  // `KEY=` in a .env file is a missing value, not an empty string.
  const raw: Partial<Record<EnvKey, string>> = {};
  for (const key of CONFIG_KEYS) {
    const value = source[key];
    if (value !== undefined && value !== "") raw[key] = value;
  }

  const missing = new Set<EnvKey>();
  const invalid = new Set<EnvKey>();
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path[0] as EnvKey;
      (raw[key] === undefined ? missing : invalid).add(key);
    }
  }

  // Conditional requirements, checked on the raw values so one error lists
  // everything that is missing.
  if (raw.EMAIL_PROVIDER === "smtp") {
    for (const key of ["SMTP_HOST", "SMTP_PORT"] as const) if (!raw[key]) missing.add(key);
  }
  const managedIdentity: EnvKey[] = ["AZURE_STORAGE_ACCOUNT_URL", "AZURE_CLIENT_ID"];
  const storageProblem =
    !raw.AZURE_STORAGE_CONNECTION_STRING && present(raw, managedIdentity).length < managedIdentity.length;
  const microsoft: EnvKey[] = ["MICROSOFT_CLIENT_ID", "MICROSOFT_TENANT_ID", "MICROSOFT_CLIENT_SECRET"];
  const microsoftSet = present(raw, microsoft);
  if (raw.APP_ENV === "azure" || (microsoftSet.length > 0 && microsoftSet.length < microsoft.length)) {
    // AU1: the three Microsoft variables are set together or not at all.
    for (const key of microsoft) if (!raw[key]) missing.add(key);
  }

  if (missing.size > 0 || invalid.size > 0 || storageProblem) {
    const problems: string[] = [];
    if (missing.size > 0) problems.push(`missing ${[...missing].join(", ")}`);
    if (invalid.size > 0) problems.push(`invalid ${[...invalid].join(", ")}`);
    if (storageProblem) {
      const absent = managedIdentity.filter((key) => !raw[key]);
      problems.push(
        `storage needs AZURE_STORAGE_CONNECTION_STRING, or AZURE_STORAGE_ACCOUNT_URL and AZURE_CLIENT_ID (missing ${["AZURE_STORAGE_CONNECTION_STRING", ...absent].join(", ")})`,
      );
    }
    throw new ConfigError(`Invalid configuration: ${problems.join("; ")}.`);
  }

  const env = parsed.data!;

  // AU7: dev sign-in never runs in Azure or next to the Outbox. NODE_ENV is
  // deliberately not part of the check (the CI image runs as production).
  if (env.AUTH_DEV_LOGIN === "true" && (env.APP_ENV === "azure" || env.EMAIL_PROVIDER === "outbox")) {
    const conflicts = ["AUTH_DEV_LOGIN=true"];
    if (env.APP_ENV === "azure") conflicts.push("APP_ENV=azure");
    if (env.EMAIL_PROVIDER === "outbox") conflicts.push("EMAIL_PROVIDER=outbox");
    throw new ConfigError(`AU7: dev sign-in is refused with ${conflicts.join(" and ")}.`);
  }

  // §3 rule 10 (C4): no real email delivery from Azure.
  if (env.APP_ENV === "azure" && env.EMAIL_PROVIDER !== "outbox") {
    throw new ConfigError("Invalid configuration: APP_ENV=azure requires EMAIL_PROVIDER=outbox.");
  }

  return {
    appEnv: env.APP_ENV,
    databaseUrl: env.DATABASE_URL,
    databaseAdminUrl: env.DATABASE_ADMIN_URL,
    auth: {
      secret: env.BETTER_AUTH_SECRET,
      url: env.BETTER_AUTH_URL,
      devLogin: env.AUTH_DEV_LOGIN === "true",
      microsoft:
        env.MICROSOFT_CLIENT_ID && env.MICROSOFT_TENANT_ID && env.MICROSOFT_CLIENT_SECRET
          ? {
              clientId: env.MICROSOFT_CLIENT_ID,
              tenantId: env.MICROSOFT_TENANT_ID,
              clientSecret: env.MICROSOFT_CLIENT_SECRET,
            }
          : null,
    },
    emailHashKey: env.EMAIL_HASH_KEY,
    email:
      env.EMAIL_PROVIDER === "smtp"
        ? { provider: "smtp", host: env.SMTP_HOST!, port: env.SMTP_PORT! }
        : { provider: "outbox" },
    storage: env.AZURE_STORAGE_CONNECTION_STRING
      ? {
          mode: "connectionString",
          connectionString: env.AZURE_STORAGE_CONNECTION_STRING,
          publicUrl: env.AZURE_STORAGE_PUBLIC_URL,
        }
      : { mode: "managedIdentity", accountUrl: env.AZURE_STORAGE_ACCOUNT_URL!, clientId: env.AZURE_CLIENT_ID! },
    turnstile: { siteKey: env.TURNSTILE_SITE_KEY, secretKey: env.TURNSTILE_SECRET_KEY },
    tickSecret: env.TICK_SECRET,
    demoUser: { password: env.DEMO_USER_PASSWORD, domain: env.DEMO_USER_DOMAIN },
    seedAdminEmail: env.SEED_ADMIN_EMAIL,
    workerEnabled: env.WORKER_ENABLED === "true",
    logLevel: env.LOG_LEVEL,
  };
}

let cached: AppConfig | undefined;

/** Validates process.env on the first call and caches the result; a failure is not cached. */
export function getConfig(): AppConfig {
  cached ??= loadConfig(process.env);
  return cached;
}
