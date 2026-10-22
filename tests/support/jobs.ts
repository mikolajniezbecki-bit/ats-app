// Test-only queues and jobs. Each test creates its own queue, so jobs other
// test files leave in the four real queues never reach its handlers (T2).
import { randomUUID } from "node:crypto";
import { type JobPayload, getBoss } from "@/server/adapters/job-queue";

export type TestQueueOptions = { retryLimit?: number; retryDelay?: number; expireInSeconds?: number };

/** Creates a queue named `test.<prefix>.<uuid>` and returns its name. */
export async function createTestQueue(prefix: string, options: TestQueueOptions = {}): Promise<string> {
  const name = `test.${prefix}.${randomUUID()}`;
  await (await getBoss()).createQueue(name, options);
  return name;
}

/** Commits a job on a test queue; `jobQueue.enqueue` accepts only the four declared queues. */
export async function sendTestJob(queue: string, data: JobPayload = {}, startAfter?: Date): Promise<string> {
  const id = await (await getBoss()).send(queue, data, { startAfter });
  if (!id) throw new Error(`no job created on ${queue}`);
  return id;
}

export async function jobState(queue: string, id: string): Promise<string | undefined> {
  const [job] = await (await getBoss()).findJobs(queue, { id });
  return job?.state;
}
