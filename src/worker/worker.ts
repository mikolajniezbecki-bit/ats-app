// Starts and stops the handlers of this process (W1, W2, W6). Used by the web
// process (instrumentation.ts, when WORKER_ENABLED=true) and by `pnpm worker`.
import {
  type HandlerMap,
  type JobHandler,
  type WorkOptions,
  stopJobQueue,
  workQueues,
} from "../server/adapters/job-queue";
import type { Logger } from "pino";
import { closeDb } from "../server/db";
import { logger as defaultLogger } from "../server/logger";
import { withJobLoggingAll } from "./run-job";

/** How long shutdown waits for active jobs: under Compose's 10 s stop grace period (W6). */
export const SHUTDOWN_TIMEOUT_MS = 8_000;

let running = false;

/** Registers every handler in its logging wrapper and returns the queue names. */
export async function startWorker(
  handlerMap: HandlerMap | Readonly<Record<string, JobHandler | undefined>>,
  { logger = defaultLogger, ...options }: WorkOptions & { logger?: Logger } = {},
): Promise<string[]> {
  const queues = await workQueues(withJobLoggingAll(handlerMap, logger), options);
  running = true;
  logger.info({ queues }, "worker started");
  return queues;
}

/**
 * Graceful shutdown (W6): stops fetching, waits up to `timeoutMs` for active
 * jobs (pg-boss fails those still running, so they are retried, J3), stops
 * pg-boss and closes the pool.
 */
export async function shutdown({ timeoutMs = SHUTDOWN_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<void> {
  await stopJobQueue({ timeoutMs });
  if (running) {
    running = false;
    defaultLogger.info("worker stopped");
  }
  await closeDb();
}
