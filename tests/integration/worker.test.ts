// The in-process worker (W1, W2, W6, M3) against the test database. Each test
// uses a test-only queue it creates, since the production registry is still
// empty (task 9 adds the first handlers). These tests run a real worker, so
// they wait for it with a deadline instead of using the J7 helper.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { Writable } from "node:stream";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shutdown, startWorker } from "@/worker/worker";
import { createTestQueue, jobState, sendTestJob } from "../support/jobs";

const FAST = { pollingIntervalSeconds: 0.5 };

function captureLogger() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(JSON.parse(String(chunk)));
      done();
    },
  });
  return { logger: pino({ level: "info" }, stream), lines };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(async () => {
  await shutdown({ timeoutMs: 1000 });
});

describe("in-process worker", () => {
  it("W1: a started worker processes a committed job; a queue without a handler is left alone", async () => {
    const handled = await createTestQueue("handled");
    const unhandled = await createTestQueue("unhandled");
    const seen: string[] = [];

    const beforeStart = await sendTestJob(handled, { ref: "a" });
    const ignored = await sendTestJob(unhandled);
    expect(await jobState(handled, beforeStart)).toBe("created");

    expect(await startWorker({ [handled]: async (job) => void seen.push(job.data.ref) }, FAST)).toEqual([handled]);
    const afterStart = await sendTestJob(handled, { ref: "b" });

    await vi.waitFor(
      async () => {
        expect(await jobState(handled, beforeStart)).toBe("completed");
        expect(await jobState(handled, afterStart)).toBe("completed");
      },
      { timeout: 5000, interval: 100 },
    );
    expect(seen.sort()).toEqual(["a", "b"]);
    expect(await jobState(unhandled, ignored)).toBe("created");
  });

  it("logs job started, completed and failed with job_id and queue, never the payload (M3)", async () => {
    const queue = await createTestQueue("failing", { retryLimit: 1, retryDelay: 60 });
    const { logger, lines } = captureLogger();
    const jobId = await sendTestJob(queue, { emailLogId: "secret-looking-id" });

    await startWorker({ [queue]: async () => Promise.reject(new Error("handler broke")) }, { ...FAST, logger });

    await vi.waitFor(async () => expect(await jobState(queue, jobId)).toBe("retry"), { timeout: 5000, interval: 100 });
    const jobLines = lines.filter((line) => line.job_id === jobId);
    expect(jobLines.map((line) => line.msg)).toEqual(["job started", "job failed"]);
    expect(jobLines[1]).toMatchObject({ queue, level: 50, err: { message: "handler broke" } });
    expect(String((jobLines[1].err as { stack: string }).stack)).toContain("handler broke");
    expect(JSON.stringify(lines)).not.toContain("secret-looking-id");
  });

  it("logs job completed with its duration", async () => {
    const queue = await createTestQueue("logged");
    const { logger, lines } = captureLogger();
    const jobId = await sendTestJob(queue);

    await startWorker({ [queue]: async () => undefined }, { ...FAST, logger });

    await vi.waitFor(async () => expect(await jobState(queue, jobId)).toBe("completed"), { timeout: 5000, interval: 100 });
    expect(lines.find((line) => line.job_id === jobId && line.msg === "job completed")).toMatchObject({
      queue,
      duration_ms: expect.any(Number),
    });
  });
});

describe("graceful shutdown (W6)", () => {
  async function startWithActiveJob(runMs: number) {
    const queue = await createTestQueue("slow");
    let started!: () => void;
    const isActive = new Promise<void>((resolve) => (started = resolve));
    await startWorker(
      {
        [queue]: async () => {
          started();
          await sleep(runMs);
        },
      },
      FAST,
    );
    const jobId = await sendTestJob(queue);
    await isActive;
    return { queue, jobId };
  }

  it("waits for an active job to finish, then stops", async () => {
    const { queue, jobId } = await startWithActiveJob(2000);

    const begin = Date.now();
    await shutdown({ timeoutMs: 8000 });

    expect(Date.now() - begin).toBeGreaterThanOrEqual(1500);
    expect(await jobState(queue, jobId)).toBe("completed");
  });

  it("stops after the timeout when a job runs longer; the job is retried later", async () => {
    const { queue, jobId } = await startWithActiveJob(6000);

    const begin = Date.now();
    await shutdown({ timeoutMs: 1000 });

    expect(Date.now() - begin).toBeLessThan(4000);
    // pg-boss 12 fails the jobs still active at the deadline, so they are
    // retried according to the queue's options (J3) instead of waiting for
    // their expiry.
    expect(await jobState(queue, jobId)).toBe("retry");
  });
});

describe("pnpm worker", () => {
  // The command of the `worker` script, run directly so signals reach it
  // (pnpm doesn't forward SIGTERM to its child).
  const script = (JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }).scripts.worker;
  const [command, ...args] = script.split(" ");

  function runWorker(env: Record<string, string | undefined>) {
    const child = spawn(command, args, { env: { ...process.env, LOG_LEVEL: "info", ...env } });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    return { child, exited, output: () => output };
  }

  it("starts, registers the handlers regardless of WORKER_ENABLED and exits 0 on SIGTERM", { timeout: 30_000 }, async () => {
    const worker = runWorker({ WORKER_ENABLED: "false" });
    try {
      await vi.waitFor(() => expect(worker.output()).toContain('"msg":"worker started"'), { timeout: 15_000, interval: 100 });

      const begin = Date.now();
      worker.child.kill("SIGTERM");
      expect(await worker.exited).toBe(0);
      expect(Date.now() - begin).toBeLessThan(10_000);
      expect(worker.output()).toContain('"msg":"worker stopped"');
    } finally {
      worker.child.kill("SIGKILL");
    }
  });

  it("exits non-zero and names the variable when DATABASE_URL is missing", { timeout: 30_000 }, async () => {
    // Empty, not unset: an empty value counts as missing and isn't filled from a local .env.
    const worker = runWorker({ DATABASE_URL: "" });
    try {
      expect(await worker.exited).not.toBe(0);
      expect(worker.output()).toContain("missing DATABASE_URL");
      expect(worker.output()).not.toContain('"msg":"worker started"');
    } finally {
      worker.child.kill("SIGKILL");
    }
  });
});
