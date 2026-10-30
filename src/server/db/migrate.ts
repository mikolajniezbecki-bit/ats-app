// `db:migrate` entry point. Bundled to plain JavaScript by build-migrate.mjs
// (runtime dependencies only); the SQL files sit in `migrations/` next to the
// bundle: dist/db/ locally, /app/db/ in the image.
import path from "node:path";
import { ensureJobQueues } from "../adapters/job-queue";
import { ConfigError, getConfig } from "../config";
import { logger } from "../logger";
import { createPool } from "./index";
import { isConnectionError, rootCause, runMigrations, setUpAppLogin } from "./migrator";

async function main(): Promise<number> {
  let databaseUrl: string;
  let adminUrl: string | undefined;
  try {
    const config = getConfig();
    databaseUrl = config.databaseUrl;
    // Set only in the Azure db-migrate job (tech-stack.md §3, G5).
    adminUrl = config.databaseAdminUrl;
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    logger.error(err.message);
    return 1;
  }

  try {
    // With an admin URL: migrate as the admin, then create or update the app
    // login. Without one (local, CI): one login does everything, as before.
    await runMigrations(adminUrl ?? databaseUrl, path.join(import.meta.dirname, "migrations"));
    // The pgboss schema and the four queues (J5) as the app login, so pg-boss
    // objects belong to the login that uses them at app start.
    const installQueues = async () => {
      const pool = createPool(databaseUrl, { max: 2 });
      try {
        await ensureJobQueues({ pool });
      } finally {
        await pool.end();
      }
    };
    if (adminUrl) await setUpAppLogin(adminUrl, databaseUrl, installQueues);
    else await installQueues();
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

void main().then((code) => {
  process.exitCode = code;
});
