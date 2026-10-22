// POST /api/internal/tick (tech-stack.md W4, W5, T3): queues the daily tasks
// that are due and haven't run for today's Europe/Warsaw date, then waits
// until no due job remains or the timeout passes. The route file only wires
// this to Next.js, so tests call it with plain Request objects.
import { timingSafeEqual } from "node:crypto";
import { countDueJobs, jobQueue, shiftJobClock } from "../adapters/job-queue";
import { type AppConfig, getConfig } from "../config";
import { type Tx, withTransaction } from "../db";
import { jobRuns } from "../db/schema";
import { logger } from "../logger";
import { type DailyTaskName, dueDailyTasks, parseTestNow, warsawRunDate } from "./daily-tasks";

export const TICK_SECRET_HEADER = "x-tick-secret";
export const TEST_NOW_HEADER = "x-test-now";

/** W4: under Container Apps' 240 s request timeout. */
export const TICK_TIMEOUT_MS = 180_000;
export const TICK_POLL_INTERVAL_MS = 1_000;

export type TickOptions = {
  config?: AppConfig;
  pollIntervalMs?: number;
  timeoutMs?: number;
};

export type TickSummary = {
  queued: DailyTaskName[];
  waited: boolean;
  remainingDueJobs: number;
  timedOut: boolean;
  durationMs: number;
};

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/** Constant-time comparison that returns false, without throwing, on a length mismatch. */
export function secretMatches(sent: string | null, expected: string): boolean {
  if (sent === null) return false;
  const a = Buffer.from(sent);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on different lengths; compare b with itself so the
  // time spent doesn't depend on whether the lengths match.
  return a.length === b.length ? timingSafeEqual(a, b) : !timingSafeEqual(b, b);
}

export type TickClock = { now: Date; testNow: boolean };

/**
 * The effective time of a tick (T3). `x-test-now` counts only with
 * AUTH_DEV_LOGIN=true; otherwise it is ignored and real time is used.
 * Returns null for an unparsable value while dev login is on.
 */
export function resolveTickClock(header: string | null, devLogin: boolean, realNow: Date = new Date()): TickClock | null {
  if (!devLogin || header === null) return { now: realNow, testNow: false };
  const testNow = parseTestNow(header);
  return testNow ? { now: testNow, testNow: true } : null;
}

/**
 * W5: records today's run of `task` and enqueues it, in `tx`. Returns false
 * when a run for this date already exists, so overlapping ticks queue it once.
 */
async function queueDailyTask(tx: Tx, task: DailyTaskName, runDate: string, now: Date): Promise<boolean> {
  const [row] = await tx
    .insert(jobRuns)
    .values({ jobName: task, runDate, startedAt: now, status: "RUNNING" })
    .onConflictDoNothing({ target: [jobRuns.jobName, jobRuns.runDate] })
    .returning({ id: jobRuns.id });
  if (!row) return false;
  await jobQueue.enqueue(tx, task, { jobRunId: row.id, runDate, now: now.toISOString() });
  return true;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function handleTick(request: Request, options: TickOptions = {}): Promise<Response> {
  const started = performance.now();
  const config = options.config ?? getConfig();

  // A query parameter never counts: only the header is read.
  if (!secretMatches(request.headers.get(TICK_SECRET_HEADER), config.tickSecret)) {
    logger.warn("tick refused: missing or wrong secret");
    return json(401, { error: "unauthorized" });
  }

  const clock = resolveTickClock(request.headers.get(TEST_NOW_HEADER), config.auth.devLogin);
  if (!clock) {
    logger.warn("tick refused: unparsable x-test-now");
    return json(400, { error: "invalid x-test-now" });
  }

  // T3: make jobs that are due at the test time runnable now, before queueing.
  if (clock.testNow) await shiftJobClock(clock.now);

  const runDate = warsawRunDate(clock.now);
  const queued: DailyTaskName[] = [];
  for (const task of dueDailyTasks(clock.now)) {
    // One transaction per task: the job_runs row and the job commit together.
    if (await withTransaction((tx) => queueDailyTask(tx, task.name, runDate, clock.now))) queued.push(task.name);
  }
  logger.info({ queued, run_date: runDate, test_now: clock.testNow }, "tick queued daily tasks");

  if (!config.workerEnabled) {
    logger.warn("tick did not wait: WORKER_ENABLED is not true");
    return json(200, summary(queued, false, await countDueJobs(), false, started));
  }

  const timeoutMs = options.timeoutMs ?? TICK_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? TICK_POLL_INTERVAL_MS;
  const deadline = started + timeoutMs;
  let remaining = await countDueJobs();
  while (remaining > 0 && performance.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - performance.now())));
    remaining = await countDueJobs();
  }
  const timedOut = remaining > 0;
  if (timedOut) logger.warn({ remaining_due_jobs: remaining }, "tick timed out; work continues at the next tick");
  return json(200, summary(queued, true, remaining, timedOut, started));
}

function summary(queued: DailyTaskName[], waited: boolean, remaining: number, timedOut: boolean, started: number): TickSummary {
  return { queued, waited, remainingDueJobs: remaining, timedOut, durationMs: Math.round(performance.now() - started) };
}
