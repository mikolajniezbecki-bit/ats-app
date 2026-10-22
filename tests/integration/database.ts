// Test-database plumbing shared by the global and worker setup (D9, T2).
// Integration tests run against the Compose PostgreSQL, never mocks.
import pg from "pg";
import { buildPoolOptions } from "@/server/db/pool-options";

/** The Compose PostgreSQL from docker-compose.yml; DATABASE_URL overrides it (CI). */
const COMPOSE_DATABASE_URL = "postgres://ats:local-only-not-secret-postgres@localhost:5432/ats";

export const TEMPLATE_DATABASE = "ats_test_template";
export const WORKER_DATABASE_PREFIX = "ats_test_";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "postgres"]);

/**
 * The server the tests create and drop databases on. Refuses anything but a
 * local or Compose host, and APP_ENV=azure, so a misplaced DATABASE_URL can
 * never drop a real database.
 */
export function baseDatabaseUrl(env: Record<string, string | undefined> = process.env): string {
  const value = env.DATABASE_URL ?? COMPOSE_DATABASE_URL;
  const host = URL.canParse(value) ? new URL(value).hostname : "";
  if (!LOCAL_HOSTS.has(host) || env.APP_ENV === "azure") {
    throw new Error(
      "Integration tests create and drop databases, so they only run against a local PostgreSQL: " +
        "DATABASE_URL must point at localhost, 127.0.0.1 or postgres, and APP_ENV must not be azure.",
    );
  }
  return value;
}

/** The same server and credentials, another database. */
export function databaseUrlFor(baseUrl: string, database: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/** Runs `fn` with a client on the base database; a connection failure gets a hint instead of a hang. */
export async function withAdminClient<T>(baseUrl: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client(buildPoolOptions(baseUrl));
  try {
    await client.connect();
  } catch (err) {
    const code = (err as { code?: string }).code;
    throw new Error(
      `Cannot connect to PostgreSQL for the integration tests${code ? ` (${code})` : ""}. ` +
        "Start it with `docker compose up -d postgres`.",
    );
  }
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Database names are built from fixed prefixes and Vitest's numeric pool ID. */
export function quoteIdent(name: string): string {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Unexpected database name ${name}`);
  return `"${name}"`;
}
