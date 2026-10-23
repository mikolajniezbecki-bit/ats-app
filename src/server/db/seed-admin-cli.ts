// `pnpm seed:admin --email <upn> [--name "<name>"]` (tech-stack.md AU8). A
// plain Node entry point with no Next.js imports, so it can be compiled into
// the image for the Azure db-seed job (task 17). Output and logs carry the
// user ID only, never the email (M2: the job's stdout goes to Log Analytics).
import { parseArgs } from "node:util";
import { ConfigError } from "../config";
import { logger } from "../logger";
import { closeDb } from "./index";
import { rootCause } from "./migrator";
import { seedAdmin, seedAdminEmail } from "./seed-admin";

const USAGE = 'Usage: pnpm seed:admin --email <upn> [--name "<name>"]';

async function main(argv: string[]): Promise<number> {
  let values: { email?: string; name?: string };
  try {
    ({ values } = parseArgs({ args: argv, options: { email: { type: "string" }, name: { type: "string" } }, strict: true }));
  } catch {
    console.error(USAGE);
    return 1;
  }
  if (!values.email || !seedAdminEmail.safeParse(values.email).success) {
    console.error(USAGE);
    return 1;
  }

  try {
    const { outcome, userId } = await seedAdmin({ email: values.email, name: values.name });
    console.log(`${outcome} ${userId}`);
    logger.info({ userId, outcome }, "seed:admin finished");
    return 0;
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.error(err.message);
      return 1;
    }
    // Code and message only; never the email or the connection string.
    const { code, message } = rootCause(err) as { code?: string; message?: string };
    logger.error({ code, message }, "seed:admin failed");
    return 1;
  } finally {
    await closeDb();
  }
}

// No top-level await: tsx runs this file as CommonJS (the package has no "type").
void main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
