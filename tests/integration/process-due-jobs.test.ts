// The J7 test helper: processes due jobs synchronously, without a worker and
// without waiting in real time (W9). Each test uses its own test-only queue.
import { describe, expect, it } from "vitest";
import { jobQueue } from "@/server/adapters/job-queue";
import { withTransaction } from "@/server/db";
import { processDueJobs } from "../support/process-due-jobs";
import { createTestQueue, jobState, sendTestJob } from "../support/jobs";

describe("processDueJobs", () => {
  it("processes a due job and leaves a job that starts in an hour untouched", async () => {
    const queue = await createTestQueue("due");
    const due = await sendTestJob(queue);
    const later = await sendTestJob(queue, {}, new Date(Date.now() + 60 * 60 * 1000));
    const seen: string[] = [];

    const result = await processDueJobs({ handlers: { [queue]: async (job) => void seen.push(job.id) } });

    expect(result).toEqual({ processed: 1, failed: 0 });
    expect(seen).toEqual([due]);
    expect(await jobState(queue, due)).toBe("completed");
    expect(await jobState(queue, later)).toBe("created");
  });

  it("processes a due job that a handler enqueues during the same call", async () => {
    const first = await createTestQueue("first");
    const second = await createTestQueue("second");
    await sendTestJob(first);
    let followUp = "";

    const result = await processDueJobs({
      handlers: {
        [first]: async () => void (followUp = await sendTestJob(second)),
        [second]: async () => undefined,
      },
    });

    expect(result).toEqual({ processed: 2, failed: 0 });
    expect(await jobState(second, followUp)).toBe("completed");
  });

  it("fails a throwing job and retries it per the queue options in a later call, not the same one", async () => {
    // No retry delay: the retry is due at once, but still waits for the next call.
    const queue = await createTestQueue("failing", { retryLimit: 1, retryDelay: 0 });
    const jobId = await sendTestJob(queue);
    let attempts = 0;
    const handlers = {
      [queue]: async () => {
        attempts += 1;
        throw new Error("handler broke");
      },
    };

    expect(await processDueJobs({ handlers })).toEqual({ processed: 0, failed: 1 });
    expect(attempts).toBe(1);
    expect(await jobState(queue, jobId)).toBe("retry");

    expect(await processDueJobs({ handlers })).toEqual({ processed: 0, failed: 1 });
    expect(attempts).toBe(2);
    // retryLimit 1: one retry, then failed for good.
    expect(await jobState(queue, jobId)).toBe("failed");
  });

  it("stops with an error after maxJobs instead of looping forever", async () => {
    const queue = await createTestQueue("loop");
    await sendTestJob(queue);

    await expect(
      processDueJobs({ handlers: { [queue]: async () => void (await sendTestJob(queue)) }, maxJobs: 5 }),
    ).rejects.toThrow("maxJobs (5)");
  });

  it("uses the production registry by default", async () => {
    // Since task 18 the registry handles email.send. Other files in this
    // worker leave email.send jobs behind, so drain them first; then exactly
    // the job sent here is processed (for an unknown row the handler is a
    // no-op), which a call with no production handlers would not do.
    await processDueJobs();
    const jobId = await withTransaction((tx) => jobQueue.enqueue(tx, "email.send", { emailLogId: crypto.randomUUID() }));
    expect(await processDueJobs()).toEqual({ processed: 1, failed: 0 });
    expect(await jobState("email.send", jobId)).toBe("completed");
  });
});
