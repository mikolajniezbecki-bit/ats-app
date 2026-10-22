// `db:migrate` entry point. Bundled to plain JavaScript by build-migrate.mjs
// (runtime dependencies only); the SQL files sit in `migrations/` next to the
// bundle: dist/db/ locally, /app/db/ in the image.
import path from "node:path";
import { ensureJobQueues } from "../adapters/job-queue";
import { ConfigError, getConfig } from "../config";
import { logger } from "../logger";
import { createPool } from "./index";
import { isConnectionError, rootCause, runMigrations } from "./migrator";

async function main(): Promise<number> {
  let connectionString: string;
  try {
    const config = getConfig();
    // The Azure db-migrate job uses the admin login (tech-stack.md §3).
    connectionString = config.databaseAdminUrl ?? config.databaseUrl;
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    logger.error(err.message);
    return 1;
  }

  try {
    await runMigrations(connectionString, path.join(import.meta.dirname, "migrations"));
    // Then the pgboss schema and the four queues (J5), with the same login.
    const pool = createPool(connectionString, { max: 2 });
    try {
      await ensureJobQueues({ pool });
    } finally {
      await pool.end();
    }
  } catch (err) {
    // Only the error code and message: never the connection string.
    const { code, message } = rootCause(err) as { code?: string; message?: string };
    if (isConnectionError(err)) {
      logger.error({ code, message }, "db:migrate failed: cannot connect to PostgreSQL");
    } else {
      logger.error({ code, message }, "db:migrate failed");
    }
    return 1;
  }

  logger.info("db:migrate finished: database is up to date");
  return 0;
}

process.exitCode = await main();
