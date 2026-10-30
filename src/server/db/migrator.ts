// Applies the committed SQL migrations with drizzle-orm's runtime migrator
// (D2), never drizzle-kit, so it runs from the production image (§3 rule 8).
// Shared by the db:migrate entry point and the integration-test setup.
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { appLoginFrom, provisionAppRole, withDatabaseCreate } from "./app-role";
import { createPool } from "./index";

export async function runMigrations(connectionString: string, migrationsFolder: string): Promise<void> {
  const pool = createPool(connectionString, { max: 1 });
  try {
    await migrate(drizzle({ client: pool }), { migrationsFolder });
  } finally {
    await pool.end();
  }
}

/**
 * Creates or updates the least-privilege login of `databaseUrl`, connected as
 * the admin (G5), then runs `installQueues` as that login. pg-boss's first
 * install runs `CREATE SCHEMA IF NOT EXISTS pgboss`, and PostgreSQL checks the
 * CREATE right on the database before it sees that the schema exists, so the
 * login holds that right only while `installQueues` runs.
 */
export async function setUpAppLogin(
  adminUrl: string,
  databaseUrl: string,
  installQueues: () => Promise<void>,
): Promise<void> {
  const login = appLoginFrom(databaseUrl);
  const pool = createPool(adminUrl, { max: 1 });
  try {
    await provisionAppRole(pool, login);
    await withDatabaseCreate(pool, login, installQueues);
  } finally {
    await pool.end();
  }
}

/**
 * The driver error behind a Drizzle error: drizzle-orm wraps every failed
 * query in a DrizzleQueryError whose `cause` is the node-postgres error.
 */
export function rootCause(err: unknown): unknown {
  let current = err;
  while (current instanceof Error && current.cause !== undefined) current = current.cause;
  return current;
}

/** Errors meaning "PostgreSQL is not reachable", as opposed to a failing migration. */
export function isConnectionError(error: unknown): boolean {
  const err = rootCause(error);
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH)$/.test(code)) {
    return true;
  }
  return err instanceof Error && /connection timeout|Connection terminated/i.test(err.message);
}
