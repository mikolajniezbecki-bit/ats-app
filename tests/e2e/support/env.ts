// The local-only values Playwright needs (tech-stack.md T4). docker-compose.yml
// is their single source: the `app` service's environment, with the
// PostgreSQL host changed to localhost because Playwright runs on the host.
// E2E_DATABASE_URL and E2E_TICK_SECRET override them (task 43).
import { readFileSync } from "node:fs";
import { parse } from "yaml";

type ComposeFile = { services: { app: { environment: Record<string, string> } } };

function composeAppEnvironment(): Record<string, string> {
  const compose = parse(readFileSync("docker-compose.yml", "utf8")) as ComposeFile;
  return compose.services.app.environment;
}

const appEnv = composeAppEnvironment();

export const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? appEnv.DATABASE_URL.replace("@postgres:", "@localhost:");

export const E2E_TICK_SECRET = process.env.E2E_TICK_SECRET ?? appEnv.TICK_SECRET;

/** The app's configuration as host-side scripts need it, pointed at the same database and Azurite. */
export function hostAppEnvironment(): Record<string, string> {
  return {
    ...appEnv,
    DATABASE_URL: E2E_DATABASE_URL,
    AZURE_STORAGE_CONNECTION_STRING: appEnv.AZURE_STORAGE_CONNECTION_STRING.replace("//azurite:", "//localhost:"),
    LOG_LEVEL: "silent",
  };
}
