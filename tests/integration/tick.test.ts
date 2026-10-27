// POST /api/internal/tick (W4, W5, T3) against the test database. The route
// handler is called with Request objects; tests that need the tick to wait
// run the worker in-process with the production stubs. Every test that
// creates job_runs rows uses its own run date, because a row for a date
// blocks every later run on that date.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as route from "@/app/api/internal/tick/route";
import { getBoss, jobQueue } from "@/server/adapters/job-queue";
import { type AppConfig, getConfig } from "@/server/config";
import { getDb, withTransaction } from "@/server/db";
import { jobRuns } from "@/server/db/schema";
import { warsawRunDate } from "@/server/domain/daily-tasks";
import { type TickSummary, handleTick } from "@/server/domain/tick";
import { dailyTaskHandler } from "@/worker/daily-task";
import { handlers } from "@/worker/handlers";
import { shutdown, startWorker } from "@/worker/worker";
import { processDueJobs } from "../support/process-due-jobs";
import { createTestQueue, jobState, sendTestJob } from "../support/jobs";

const SECRET = "test-only-tick-secret";
const HOUR = 60 * 60 * 1000;
const FAST = { pollIntervalMs: 100, timeoutMs: 10_000 };

function config({ devLogin = true, workerEnabled = true } = {}): AppConfig {
  const base = getConfig();
  return { ...base, auth: { ...base.auth, devLogin }, workerEnabled };
}

function tickRequest(headers: Record<string, string> = { "x-tick-secret": SECRET }, url = "http://localhost/api/internal/tick") {
  return new Request(url, { method: "POST", headers });
}

async function tick(headers: Record<string, string>, options: Parameters<typeof handleTick>[1] = {}) {
  const response = await handleTick(tickRequest({ "x-tick-secret": SECRET, ...headers }), {
    config: config(),
    ...FAST,
    ...options,
  });
  return { status: response.status, body: (await response.json()) as TickSummary };
}

/**
 * The production handlers, with the production daily-task wrapper around
 * empty runs for the two daily tasks whose real work acts on the whole
 * worker database: approvals.remind (since task 31) queues a reminder and
 * an email.send job the tick waits for, for every pending requisition other
 * files left here; retention.purge (since task 40) would anonymize their
 * final applications on a tick years ahead. Both are tested on their own
 * (approval-reassignment.test.ts, retention.test.ts).
 */
function quietHandlers() {
  const empty = dailyTaskHandler(async () => undefined);
  return { ...handlers, ...emailHandler, "approvals.remind": empty, "retention.purge": empty };
}

function runsOn(runDate: string) {
  return getDb().select().from(jobRuns).where(eq(jobRuns.runDate, runDate)).orderBy(jobRuns.jobName);
}

async function dailyJobsOn(queue: string, runDate: string) {
  const jobs = await (await getBoss()).findJobs<{ runDate: string; now: string; jobRunId: string }>(queue);
  return jobs.filter((job) => job.data.runDate === runDate);
}

/** A delayed email.send job, committed; IDs only in the payload (M2). */
function delayedEmail(delayMs: number): Promise<string> {
  return withTransaction((tx) =>
    jobQueue.enqueue(tx, "email.send", { emailLogId: randomUUID() }, { startAfter: new Date(Date.now() + delayMs) }),
  );
}

const emailHandler = { "email.send": async () => undefined };

beforeEach(async () => {
  // The W4 count spans every queue, so jobs earlier test files left behind
  // in this worker's database would keep the tick waiting.
  await (await getBoss()).deleteAllJobs();
});

afterEach(async () => {
  await shutdown({ timeoutMs: 1000 });
});

describe("tick authentication", () => {
  it("W4: a missing, wrong, different-length or query-only secret returns 401 and changes nothing", async () => {
    const before = await getDb().$count(jobRuns);
    const cases = [
      tickRequest({}),
      tickRequest({ "x-tick-secret": "test-only-tick-secreT" }),
      tickRequest({ "x-tick-secret": "short" }),
      tickRequest({}, `http://localhost/api/internal/tick?x-tick-secret=${SECRET}`),
    ];
    for (const request of cases) {
      const response = await handleTick(request, { config: config(), ...FAST });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
    expect(await getDb().$count(jobRuns)).toBe(before);
    expect((await (await getBoss()).findJobs("approvals.remind")).length).toBe(0);
  });

  it("W4: the route exports only POST, is dynamic and runs on Node.js", () => {
    expect(Object.keys(route).sort()).toEqual(["POST", "dynamic", "runtime"]);
    expect(route.dynamic).toBe("force-dynamic");
    expect(route.runtime).toBe("nodejs");
  });

  it("T3: an unparsable x-test-now returns 400 and queues nothing", async () => {
    const before = await getDb().$count(jobRuns);
    const { status } = await tick({ "x-test-now": "tomorrow" });
    expect(status).toBe(400);
    expect(await getDb().$count(jobRuns)).toBe(before);
  });
});

describe("tick", () => {
  it("W4: queues the due daily tasks and responds only after both runs are COMPLETED", async () => {
    await startWorker(quietHandlers(), { pollingIntervalSeconds: 0.5 });
    const testNow = "2031-01-06T09:00:00Z"; // 10:00 in Warsaw

    const { status, body } = await tick({ "x-test-now": testNow });

    expect(status).toBe(200);
    expect(body).toMatchObject({ queued: ["retention.purge", "approvals.remind"], waited: true, remainingDueJobs: 0, timedOut: false });
    const runs = await runsOn("2031-01-06");
    expect(runs.map((run) => [run.jobName, run.status])).toEqual([
      ["approvals.remind", "COMPLETED"],
      ["retention.purge", "COMPLETED"],
    ]);
    expect(runs.every((run) => run.finishedAt !== null)).toBe(true);
  });

  it("T3: a tick on another date creates job_runs rows for that date, with the payload now equal to TEST_NOW", async () => {
    const testNow = "2031-02-10T05:30:00+01:00"; // 05:30 in Warsaw: only retention.purge is due
    const { body } = await tick({ "x-test-now": testNow }, { config: config({ workerEnabled: false }) });

    expect(body).toMatchObject({ queued: ["retention.purge"], waited: false });
    const [run] = await runsOn("2031-02-10");
    expect(run).toMatchObject({ jobName: "retention.purge", status: "RUNNING", startedAt: new Date(testNow) });
    const [job] = await dailyJobsOn("retention.purge", "2031-02-10");
    expect(job.data).toEqual({ jobRunId: run.id, runDate: "2031-02-10", now: new Date(testNow).toISOString() });
  });

  it("W4: ignores a job that starts in an hour and returns at once", async () => {
    await startWorker(emailHandler, { pollingIntervalSeconds: 0.5 });
    const jobId = await delayedEmail(HOUR);

    // 01:30 in Warsaw, in the past: nothing is due and the clock shift moves nothing.
    const { status, body } = await tick({ "x-test-now": "2026-01-05T00:30:00Z" });

    expect(status).toBe(200);
    expect(body).toMatchObject({ queued: [], waited: true, remainingDueJobs: 0, timedOut: false });
    expect(body.durationMs).toBeLessThan(2000);
    expect(await jobState("email.send", jobId)).toBe("created");
  });

  it("W4: returns timedOut when a due job is still running at the timeout", async () => {
    const queue = await createTestQueue("stuck");
    let release!: () => void;
    const stuck = new Promise<void>((resolve) => (release = resolve));
    await startWorker({ [queue]: () => stuck }, { pollingIntervalSeconds: 0.5 });
    await sendTestJob(queue);

    try {
      const { status, body } = await tick({ "x-test-now": "2026-01-05T00:30:00Z" }, { timeoutMs: 1500 });
      expect(status).toBe(200);
      expect(body).toMatchObject({ waited: true, timedOut: true, remainingDueJobs: 1 });
      expect(body.durationMs).toBeGreaterThanOrEqual(1500);
    } finally {
      release();
    }
  });

  it("W4: with WORKER_ENABLED off the tick queues the due tasks without waiting", async () => {
    const { status, body } = await tick({ "x-test-now": "2031-03-03T12:00:00Z" }, { config: config({ workerEnabled: false }) });

    expect(status).toBe(200);
    expect(body).toMatchObject({ queued: ["retention.purge", "approvals.remind"], waited: false, timedOut: false, remainingDueJobs: 2 });
  });
});

describe("run once", () => {
  it("W5: two concurrent ticks run each daily task once; a later tick that day queues nothing", async () => {
    const runDate = "2031-04-07";
    const options = { config: config({ workerEnabled: false }) };

    const results = await Promise.all([
      tick({ "x-test-now": "2031-04-07T08:00:00Z" }, options),
      tick({ "x-test-now": "2031-04-07T08:00:00Z" }, options),
    ]);

    expect(results.flatMap((r) => r.body.queued).sort()).toEqual(["approvals.remind", "retention.purge"]);
    const runs = await runsOn(runDate);
    expect(runs.map((run) => run.jobName)).toEqual(["approvals.remind", "retention.purge"]);
    expect(await dailyJobsOn("approvals.remind", runDate)).toHaveLength(1);
    expect(await dailyJobsOn("retention.purge", runDate)).toHaveLength(1);

    const later = await tick({ "x-test-now": "2031-04-07T15:00:00Z" }, options);
    expect(later.body.queued).toEqual([]);
    expect(await runsOn(runDate)).toHaveLength(2);
  });

  it("W5: a tick before the due time queues nothing, and missed earlier dates are not backfilled", async () => {
    const options = { config: config({ workerEnabled: false }) };
    // 01:00 in Warsaw on 2031-05-12; 2031-05-11 never had a tick.
    const { body } = await tick({ "x-test-now": "2031-05-11T23:00:00Z" }, options);

    expect(body.queued).toEqual([]);
    expect(await runsOn("2031-05-12")).toHaveLength(0);
    expect(await runsOn("2031-05-11")).toHaveLength(0);
  });

  it("W5: a failed daily task is FAILED and retried; a successful retry sets COMPLETED; a COMPLETED run is not repeated", async () => {
    const runDate = "2031-06-02";
    await tick({ "x-test-now": "2031-06-02T07:00:00Z" }, { config: config({ workerEnabled: false }) });
    const [job] = await dailyJobsOn("approvals.remind", runDate);
    let calls = 0;
    const handler = dailyTaskHandler(async () => {
      calls += 1;
      if (calls === 1) throw new Error("first attempt fails");
    });
    const status = async () => (await getDb().select().from(jobRuns).where(and(eq(jobRuns.runDate, runDate), eq(jobRuns.jobName, "approvals.remind"))))[0].status;

    expect(await processDueJobs({ handlers: { "approvals.remind": handler } })).toEqual({ processed: 0, failed: 1 });
    expect(await status()).toBe("FAILED");
    expect(await jobState("approvals.remind", job.id)).toBe("retry");

    expect(await processDueJobs({ handlers: { "approvals.remind": handler } })).toEqual({ processed: 1, failed: 0 });
    expect(await status()).toBe("COMPLETED");

    // J3: a duplicate delivery of a completed run does nothing.
    await handler({ id: job.id, queue: "approvals.remind", data: job.data, retryCount: 0 });
    expect(calls).toBe(2);
  });
});

describe("test clock", () => {
  it("T3: a job delayed by 24 h waits on a real-time tick and runs on a tick 25 h ahead; 48 h does not", async () => {
    await startWorker(quietHandlers(), { pollingIntervalSeconds: 0.5 });
    const day = await delayedEmail(24 * HOUR);
    const twoDays = await delayedEmail(48 * HOUR);

    await tick({});
    expect(await jobState("email.send", day)).toBe("created");

    const { body } = await tick({ "x-test-now": new Date(Date.now() + 25 * HOUR).toISOString() });
    expect(body).toMatchObject({ remainingDueJobs: 0, timedOut: false });
    expect(await jobState("email.send", day)).toBe("completed");
    expect(await jobState("email.send", twoDays)).toBe("created");
  });

  it("T3: without dev login x-test-now is ignored: the delayed job waits and run_date is the real Warsaw date", async () => {
    await startWorker(quietHandlers(), { pollingIntervalSeconds: 0.5 });
    const day = await delayedEmail(24 * HOUR);
    // Far enough ahead that honouring it would also have run the 24 h job.
    const ahead = new Date(Date.now() + 30 * 24 * HOUR);

    const { status } = await tick({ "x-test-now": ahead.toISOString() }, { config: config({ devLogin: false }) });

    expect(status).toBe(200);
    expect(await jobState("email.send", day)).toBe("created");
    expect(await runsOn(warsawRunDate(ahead))).toHaveLength(0);
    // Whatever was due in real time ran for the real date (possibly on an earlier test's tick).
    const realRuns = await runsOn(warsawRunDate(new Date()));
    expect(realRuns.every((run) => run.status === "COMPLETED")).toBe(true);
  });

  it("T3: processDueJobs({ now }) runs a job delayed by 24 h", async () => {
    const day = await delayedEmail(24 * HOUR);

    expect(await processDueJobs({ handlers: emailHandler })).toEqual({ processed: 0, failed: 0 });
    expect(await processDueJobs({ handlers: emailHandler, now: new Date(Date.now() + 25 * HOUR) })).toEqual({
      processed: 1,
      failed: 0,
    });
    expect(await jobState("email.send", day)).toBe("completed");
  });
});
