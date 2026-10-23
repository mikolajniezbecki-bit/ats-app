// `db:seed` entry point (tech-stack.md D8). Bundled to plain JavaScript with
// the db:migrate and seed:admin entry points (build-migrate.mjs), so the
// Azure db-seed job runs it from the production image. Prints counts only.
import { ConfigError, getConfig } from "../../config";
import { logger } from "../../logger";
import { closeDb, getDb } from "../index";
import { rootCause } from "../migrator";
import { SeedError, formatCounts, runSeed } from "./index";

async function main(): Promise<number> {
  try {
    const config = getConfig();
    const { warnings, ...counts } = await runSeed(getDb(), config);
    for (const warning of warnings) logger.warn(warning);
    for (const line of formatCounts(counts)) console.log(line);
    logger.info("db:seed finished");
    return 0;
  } catch (err) {
    if (err instanceof SeedError) {
      logger.error(err.message);
    } else if (err instanceof ConfigError) {
      // A too-short password fails the configuration itself; say what the seed needs.
      logger.error(
        /DEMO_USER_PASSWORD/.test(err.message)
          ? "DEMO_USER_PASSWORD (12+ characters) is required when AUTH_DEV_LOGIN=true."
          : err.message,
      );
    } else {
      // Code and message only: never a connection string, email or password.
      const { code, message } = rootCause(err) as { code?: string; message?: string };
      logger.error({ code, message }, "db:seed failed");
    }
    return 1;
  } finally {
    await closeDb();
  }
}

void main().then((code) => {
  process.exitCode = code;
});
