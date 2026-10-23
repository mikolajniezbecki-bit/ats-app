// Process start-up for the web app (W1), kept out of instrumentation.ts so it
// is unit-tested without Next.js. A missing variable or an unreachable
// PostgreSQL stops the process with a non-zero exit code, so the container
// restarts instead of serving requests without a working queue.
import { ensureJobQueues, startJobQueue } from "../server/adapters/job-queue";
import { getStorage } from "../server/adapters/storage";
import { ConfigError, getConfig } from "../server/config";
import { isConnectionError, rootCause } from "../server/db/migrator";
import { logger } from "../server/logger";
import { handlers } from "./handlers";
import { shutdown, startWorker } from "./worker";

/** Validates the configuration, starts pg-boss, ensures the queues and, if enabled, the worker. */
export async function startWebProcess(): Promise<void> {
  const config = getConfig();
  await startJobQueue({ supervise: config.workerEnabled });
  await ensureJobQueues();
  await ensureFilesContainer();
  if (config.workerEnabled) {
    await startWorker(handlers);
  } else {
    logger.info("worker disabled");
  }
}

/**
 * Azurite starts empty, so the private `files` container is created when
 * missing (Azurite mode only; Bicep creates it in Azure). Storage isn't
 * required to serve requests: after a few attempts a failure is logged and
 * /api/health reports it (M5).
 */
export async function ensureFilesContainer(attempts = 5, delayMs = 1_000): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await getStorage().ensureContainer();
      return;
    } catch (err) {
      if (attempt >= attempts) {
        logger.error({ error_type: (err as Error).name, code: (err as { code?: string }).code }, "files container not ensured");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

// `next dev` may load instrumentation again after an edit; the process must
// still start pg-boss and register the handlers only once.
const globalForStartup = globalThis as typeof globalThis & { __atsStartup?: Promise<void> };

/** instrumentation.ts register(): starts once, exits the process if start-up fails. */
export async function runWebProcess(): Promise<void> {
  globalForStartup.__atsStartup ??= startWebProcess().then(() => onShutdownSignal(() => shutdown()));
  try {
    await globalForStartup.__atsStartup;
  } catch (err) {
    logStartupError(err);
    process.exit(1);
  }
}

/** Logs why start-up failed: variable names or the error code, never values or connection strings. */
export function logStartupError(err: unknown): void {
  if (err instanceof ConfigError) {
    logger.error(`startup failed: ${err.message}`);
    return;
  }
  const { code, message, stack } = rootCause(err) as { code?: string; message?: string; stack?: string };
  if (isConnectionError(err)) {
    logger.error({ code, message }, "startup failed: cannot connect to PostgreSQL");
  } else {
    logger.error({ err: { code, message, stack } }, "startup failed");
  }
}

/**
 * Runs `stop` once on SIGTERM or SIGINT, then exits 0 (1 if it fails). The
 * web process needs NEXT_MANUAL_SIG_HANDLE=true, or Next.js exits on the
 * signal before this completes.
 */
export function onShutdownSignal(stop: () => Promise<void>, exit: (code: number) => void = process.exit): void {
  let stopping = false;
  const handle = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "shutting down");
    stop().then(
      () => exit(0),
      (err: unknown) => {
        logger.error({ err }, "shutdown failed");
        exit(1);
      },
    );
  };
  process.on("SIGTERM", handle);
  process.on("SIGINT", handle);
}
