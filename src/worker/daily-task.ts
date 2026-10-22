// The wrapper every daily task handler runs in (W5, J3): it settles the task's
// job_runs row. COMPLETED on success; FAILED and re-thrown on an error, so
// pg-boss retries with the queue's defaults and a later successful retry sets
// COMPLETED. A run that is already COMPLETED does nothing.
import { eq } from "drizzle-orm";
import type { Job, JobHandler } from "../server/adapters/job-queue";
import { getDb } from "../server/db";
import { jobRuns } from "../server/db/schema";
import { logger } from "../server/logger";

/** The payload the tick enqueues: IDs and dates only (M2). */
export type DailyTaskPayload = { jobRunId: string; runDate: string; now: string };

/** The work of one daily task. `now` is the tick's effective time (T3), not the system clock. */
export type DailyTaskRun = (run: { jobRunId: string; runDate: string; now: Date }, job: Job) => Promise<void>;

export function dailyTaskHandler(run: DailyTaskRun): JobHandler {
  return async (job) => {
    const { jobRunId, runDate, now } = job.data as DailyTaskPayload;
    const log = logger.child({ job_id: job.id, queue: job.queue, run_date: runDate });
    const db = getDb();
    const [current] = await db.select({ status: jobRuns.status }).from(jobRuns).where(eq(jobRuns.id, jobRunId));
    if (!current) throw new Error(`job_runs row ${jobRunId} not found`);
    if (current.status === "COMPLETED") {
      log.info("daily task already completed");
      return;
    }
    try {
      await run({ jobRunId, runDate, now: new Date(now) }, job);
    } catch (err) {
      await db.update(jobRuns).set({ status: "FAILED", finishedAt: new Date() }).where(eq(jobRuns.id, jobRunId));
      log.warn("daily task failed");
      throw err;
    }
    await db.update(jobRuns).set({ status: "COMPLETED", finishedAt: new Date() }).where(eq(jobRuns.id, jobRunId));
    log.info("daily task completed");
  };
}

/** Stub until the real work lands: approvals.remind in task 31, retention.purge in task 40. */
export const stubDailyTask: DailyTaskRun = async () => undefined;
