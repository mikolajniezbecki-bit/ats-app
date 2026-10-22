// The pg-boss job queue adapter (tech-stack.md §5): jobs are created and
// cancelled in the caller's transaction (J1, J2, D4) and the queues are set up
// idempotently (J5). Job state is read through the pg-boss API, never by
// sleeping (W9). Rows are committed where a test needs a second connection;
// every row is new, so tests don't see each other's data.
import { eq } from "drizzle-orm";
import { describe, expect, inject, it } from "vitest";
import {
  JOB_QUEUES,
  type QueueName,
  ensureJobQueues,
  getBoss,
  inspectJobQueues,
  jobQueue,
} from "@/server/adapters/job-queue";
import { createPool, getDb, withTransaction } from "@/server/db";
import { applications, emailLog } from "@/server/db/schema";
import { withScratchDatabase } from "./database";
import { insertApplication } from "./fixtures";
import { rolledBack } from "./helpers";

class RollBack extends Error {}

async function findJob(queue: QueueName, id: string) {
  const [job] = await (await getBoss()).findJobs(queue, { id });
  return job;
}

async function applicationStatus(id: string) {
  const [row] = await getDb().select({ status: applications.status }).from(applications).where(eq(applications.id, id));
  return row.status;
}

async function emailStatus(id: string) {
  const [row] = await getDb().select({ status: emailLog.status }).from(emailLog).where(eq(emailLog.id, id));
  return row.status;
}

/** A committed QUEUED email_log row with its delayed email.send job. */
async function queuedEmail(startAfter = new Date(Date.now() + 60 * 60 * 1000)) {
  return withTransaction(async (tx) => {
    const [row] = await tx.insert(emailLog).values({ audience: "CANDIDATE", status: "QUEUED" }).returning();
    const jobId = await jobQueue.enqueue(tx, "email.send", { emailLogId: row.id }, { startAfter });
    await tx.update(emailLog).set({ jobId }).where(eq(emailLog.id, row.id));
    return { emailLogId: row.id, jobId, startAfter };
  });
}

/** In one transaction: cancel the job and mark the row CANCELLED, as R7 will. */
async function cancelEmail(tx: Parameters<Parameters<typeof withTransaction>[0]>[0], email: { emailLogId: string; jobId: string }) {
  const cancelled = await jobQueue.cancel(tx, "email.send", email.jobId);
  if (cancelled) await tx.update(emailLog).set({ status: "CANCELLED" }).where(eq(emailLog.id, email.emailLogId));
  return cancelled;
}

describe("JobQueue.enqueue", () => {
  it("D4: a status change and enqueue in one transaction both roll back or both commit", async () => {
    const application = await withTransaction((tx) => insertApplication(tx));
    const changeAndEnqueue = (fail: boolean) =>
      withTransaction(async (tx) => {
        await tx.update(applications).set({ status: "SCREENING" }).where(eq(applications.id, application.id));
        const jobId = await jobQueue.enqueue(tx, "email.send", { applicationId: application.id });
        if (fail) throw new RollBack(jobId);
        return jobId;
      });

    const rolledBackJobId = await changeAndEnqueue(true).catch((err: RollBack) => err.message);
    expect(rolledBackJobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await applicationStatus(application.id)).toBe("APPLIED");
    expect(await findJob("email.send", rolledBackJobId)).toBeUndefined();

    const jobId = await changeAndEnqueue(false);
    expect(await applicationStatus(application.id)).toBe("SCREENING");
    expect(await findJob("email.send", jobId)).toMatchObject({ id: jobId, state: "created" });
  });

  it("J1: a job is invisible to other connections until its transaction commits", async () => {
    let jobId = "";
    let seenBeforeCommit: unknown = "not checked";
    await withTransaction(async (tx) => {
      jobId = await jobQueue.enqueue(tx, "email.send", { emailLogId: crypto.randomUUID() });
      // findJobs without `db` runs on another pool connection.
      seenBeforeCommit = await findJob("email.send", jobId);
    });

    expect(seenBeforeCommit).toBeUndefined();
    expect(await findJob("email.send", jobId)).toMatchObject({ state: "created" });
  });

  it("J1: a rolled-back enqueue with startAfter leaves no job", async () => {
    let jobId = "";
    await rolledBack(async (tx) => {
      jobId = await jobQueue.enqueue(tx, "email.send", { emailLogId: crypto.randomUUID() }, {
        startAfter: new Date(Date.now() + 60_000),
      });
    });

    expect(jobId).not.toBe("");
    expect(await findJob("email.send", jobId)).toBeUndefined();
  });

  it("refuses an unknown queue at runtime", async () => {
    await rolledBack(async (tx) => {
      await expect(jobQueue.enqueue(tx, "email.sned" as QueueName, {})).rejects.toThrow('Unknown job queue "email.sned"');
      await expect(jobQueue.cancel(tx, "nope" as QueueName, crypto.randomUUID())).rejects.toThrow('"nope"');
    });
  });
});

describe("JobQueue.cancel", () => {
  it("J2: cancelling a delayed email.send job and marking the row CANCELLED commit together", async () => {
    const email = await queuedEmail();

    const cancelled = await withTransaction((tx) => cancelEmail(tx, email));

    expect(cancelled).toBe(true);
    expect(await findJob("email.send", email.jobId)).toMatchObject({ state: "cancelled" });
    expect(await emailStatus(email.emailLogId)).toBe("CANCELLED");
  });

  it("J2: a rolled-back cancel leaves the job queued with its start time and the row QUEUED", async () => {
    const email = await queuedEmail();

    await rolledBack(async (tx) => {
      expect(await cancelEmail(tx, email)).toBe(true);
    });

    const job = await findJob("email.send", email.jobId);
    expect(job).toMatchObject({ state: "created" });
    expect(job?.startAfter.getTime()).toBe(email.startAfter.getTime());
    expect(await emailStatus(email.emailLogId)).toBe("QUEUED");
  });

  it("returns false for a completed job, a second cancel and an unknown id", async () => {
    const boss = await getBoss();
    const completed = await queuedEmail();
    await boss.complete("email.send", completed.jobId, null, { includeQueued: true });
    const cancelledTwice = await queuedEmail();
    await withTransaction((tx) => jobQueue.cancel(tx, "email.send", cancelledTwice.jobId));

    const results = await withTransaction(async (tx) => [
      await jobQueue.cancel(tx, "email.send", completed.jobId),
      await jobQueue.cancel(tx, "email.send", cancelledTwice.jobId),
      await jobQueue.cancel(tx, "email.send", crypto.randomUUID()),
    ]);

    expect(results).toEqual([false, false, false]);
    expect(await findJob("email.send", completed.jobId)).toMatchObject({ state: "completed" });
  });

  it("returns false for an active job and leaves it running", async () => {
    const boss = await getBoss();
    // Only this test uses offer.render-pdf, so fetching claims this job.
    const jobId = await withTransaction((tx) => jobQueue.enqueue(tx, "offer.render-pdf", { offerId: crypto.randomUUID() }));
    const fetched = await boss.fetch("offer.render-pdf", { batchSize: 100 });
    expect(fetched.map((job) => job.id)).toContain(jobId);

    expect(await withTransaction((tx) => jobQueue.cancel(tx, "offer.render-pdf", jobId))).toBe(false);
    expect(await findJob("offer.render-pdf", jobId)).toMatchObject({ state: "active" });

    await boss.complete("offer.render-pdf", fetched.map((job) => job.id));
  });
});

describe("ensureJobQueues", () => {
  const baseUrl = () => inject("integrationDatabaseUrl");
  const DECLARED = [
    { name: "approvals.remind", policy: "singleton", retryLimit: 2, retryBackoff: false },
    { name: "email.send", policy: "standard", retryLimit: 5, retryBackoff: true },
    { name: "offer.render-pdf", policy: "standard", retryLimit: 3, retryBackoff: false },
    { name: "retention.purge", policy: "singleton", retryLimit: 2, retryBackoff: false },
  ];

  it("J5: runs twice on a database without the pgboss schema and leaves the four declared queues", () =>
    withScratchDatabase(baseUrl(), "j5", { fromTemplate: false }, async (url) => {
      const pool = createPool(url, { max: 2 });
      try {
        await ensureJobQueues({ pool });
        await ensureJobQueues({ pool });
        expect(await inspectJobQueues({ pool })).toEqual(DECLARED);
      } finally {
        await pool.end();
      }
    }));

  it("J5: two concurrent runs on an empty database both succeed", () =>
    withScratchDatabase(baseUrl(), "j5_concurrent", { fromTemplate: false }, async (url) => {
      const pools = [createPool(url, { max: 2 }), createPool(url, { max: 2 })];
      try {
        await Promise.all(pools.map((pool) => ensureJobQueues({ pool })));
        expect(await inspectJobQueues({ pool: pools[0] })).toEqual(DECLARED);
      } finally {
        await Promise.all(pools.map((pool) => pool.end()));
      }
    }));

  it("J5: updates the retry options of an existing queue and refuses a policy change", () =>
    withScratchDatabase(baseUrl(), "j5_update", { fromTemplate: false }, async (url) => {
      const pool = createPool(url, { max: 2 });
      try {
        await ensureJobQueues({ pool });

        const changedRetries = { ...JOB_QUEUES, "email.send": { retryLimit: 7 } };
        await ensureJobQueues({ pool, queues: changedRetries });
        expect((await inspectJobQueues({ pool })).find((q) => q.name === "email.send")).toMatchObject({
          retryLimit: 7,
          retryBackoff: false,
        });

        const changedPolicy = { ...JOB_QUEUES, "approvals.remind": {} };
        await expect(ensureJobQueues({ pool, queues: changedPolicy })).rejects.toThrow(
          'Job queue "approvals.remind" has policy "singleton" but "standard" is declared',
        );

        await ensureJobQueues({ pool });
        expect(await inspectJobQueues({ pool })).toEqual(DECLARED);
      } finally {
        await pool.end();
      }
    }));
});
