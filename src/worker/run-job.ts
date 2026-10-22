// The one wrapper every handler runs in (M2, M3): it logs the job's start,
// completion with duration, and failure with the stack, always with `job_id`
// and `queue` and never the payload. The error is re-thrown so the job queue
// fails the job and retries it according to the queue's options.
import type { Logger } from "pino";
import type { HandlerMap, JobHandler } from "../server/adapters/job-queue";
import { logger as defaultLogger } from "../server/logger";

export function withJobLogging(handler: JobHandler, logger: Logger = defaultLogger): JobHandler {
  return async (job) => {
    const log = logger.child({ job_id: job.id, queue: job.queue });
    const started = performance.now();
    log.info("job started");
    try {
      await handler(job);
    } catch (err) {
      log.error({ err, duration_ms: Math.round(performance.now() - started) }, "job failed");
      throw err;
    }
    log.info({ duration_ms: Math.round(performance.now() - started) }, "job completed");
  };
}

/** Wraps every handler of a map; entries without a handler are left out. */
export function withJobLoggingAll(handlers: Readonly<Record<string, JobHandler | undefined>>, logger?: Logger): HandlerMap {
  const wrapped: Record<string, JobHandler> = {};
  for (const [queue, handler] of Object.entries(handlers)) {
    if (handler) wrapped[queue] = withJobLogging(handler, logger);
  }
  return wrapped;
}
