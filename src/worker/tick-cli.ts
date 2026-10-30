// Entry point of the Azure `tick` job: `node db/tick.mjs` in the image
// (bundled by build-migrate.mjs). Prints the tick's JSON summary and exits
// non-zero on any status other than 200. Never prints the secret.
import { ConfigError, getConfig } from "../server/config";
import { logger } from "../server/logger";
import { callTick } from "./tick-client";

async function main(): Promise<number> {
  let baseUrl: string;
  let secret: string;
  try {
    const config = getConfig();
    baseUrl = config.auth.url;
    secret = config.tickSecret;
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    logger.error(err.message);
    return 1;
  }

  const result = await callTick({ baseUrl, secret });
  if (result.ok) {
    console.log(result.body);
    return 0;
  }
  logger.error({ status: result.status, body: result.body.slice(0, 500) }, "tick failed");
  return 1;
}

void main().then((code) => {
  process.exitCode = code;
});
