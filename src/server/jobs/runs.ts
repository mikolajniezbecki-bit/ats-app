// Daily-task runs for the Admin jobs page (tech-stack.md J6, W5): the last 30
// Europe/Warsaw calendar days, today included, newest first.
import { desc, gte } from "drizzle-orm";
import { type Db, getDb } from "../db";
import { jobRuns } from "../db/schema";
import { warsawRunDate } from "../domain/daily-tasks";

export const JOB_RUN_DAYS = 30;

/** The oldest run date shown: 29 Warsaw days before today's. */
export function oldestShownRunDate(now: Date): string {
  const today = warsawRunDate(now);
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (JOB_RUN_DAYS - 1));
  return date.toISOString().slice(0, 10);
}

export function listRecentJobRuns(now = new Date(), db: Db = getDb()) {
  return db
    .select()
    .from(jobRuns)
    .where(gte(jobRuns.runDate, oldestShownRunDate(now)))
    .orderBy(desc(jobRuns.runDate), desc(jobRuns.startedAt));
}
