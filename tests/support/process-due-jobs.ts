// J7 test helper: processes every job that is due now, synchronously, so
// tests never wait in real time for a worker (W9). Test-only: production code
// never imports it. The `now` option applies the T3 clock shift first.
import {
  type JobHandler,
  completeJob,
  failJob,
  fetchDueJobs,
  isWorking,
  shiftJobClock,
} from "@/server/adapters/job-queue";
import { handlers as productionHandlers } from "@/worker/handlers";
import { withJobLoggingAll } from "@/worker/run-job";

export type ProcessDueJobsOptions = {
  /** Queue name to handler; defaults to the production registry. */
  handlers?: Readonly<Record<string, JobHandler | undefined>>;
  /** Stops with an error after this many jobs, so a handler that keeps enqueueing can't loop forever. */
  maxJobs?: number;
  /** The test clock (T3): jobs due at this time are made runnable first. */
  now?: Date;
};

export type ProcessDueJobsResult = {
  /** Jobs whose handler resolved; they are now `completed`. */
  processed: number;
  /** Jobs whose handler threw; pg-boss retries them according to their queue's options. */
  failed: number;
};

/**
 * Claims the due jobs (state `created` or `retry`, start time ≤ now) of every
 * queue that has a handler and runs them one at a time, until none are left.
 * Jobs a handler enqueues are picked up in the same call. A queue where a job
 * failed isn't fetched again in this call, so a retry that is due at once
 * (no retry delay) waits for the next call instead of running again now.
 */
export async function processDueJobs({
  handlers = productionHandlers,
  maxJobs = 1000,
  now,
}: ProcessDueJobsOptions = {}): Promise<ProcessDueJobsResult> {
  if (isWorking()) throw new Error("processDueJobs() can't run while a worker runs in this process (W9)");
  if (now) await shiftJobClock(now);
  const wrapped = withJobLoggingAll(handlers);
  const failedQueues = new Set<string>();
  const result = { processed: 0, failed: 0 };

  for (let round = true; round; ) {
    round = false;
    for (const [queue, handler] of Object.entries(wrapped)) {
      if (failedQueues.has(queue)) continue;
      // One more than the budget left, so going over it is noticed.
      const jobs = await fetchDueJobs(queue, maxJobs - result.processed - result.failed + 1);
      for (const job of jobs) {
        if (result.processed + result.failed >= maxJobs) {
          throw new Error(`processDueJobs() stopped after maxJobs (${maxJobs}) jobs; is a handler re-enqueueing itself?`);
        }
        round = true;
        try {
          await handler(job);
        } catch (err) {
          await failJob(queue, job.id, err instanceof Error ? err : new Error(String(err)));
          failedQueues.add(queue);
          result.failed += 1;
          continue;
        }
        await completeJob(queue, job.id);
        result.processed += 1;
      }
    }
  }
  return result;
}
