// Background jobs (tech-stack.md §5). Domain code uses `jobQueue` through the
// JobQueue interface; this directory is the only code that imports pg-boss
// (J4, enforced by ESLint). Jobs are created and cancelled through the
// caller's transaction (J1, J2), so a rollback undoes them.
import { sql } from "drizzle-orm";
import { PgBoss, fromDrizzle } from "pg-boss";
import type pg from "pg";
import { type Tx, getPool } from "../../db";
import { logger } from "../../logger";
import { JOB_QUEUES, PG_BOSS_DEFAULTS, QUEUE_NAMES, type QueueName, type QueueOptions, isQueueName } from "./queues";

export { JOB_QUEUES, QUEUE_NAMES, type QueueName } from "./queues";

/** Job data holds IDs only, never personal data (J4, M2): pg-boss keeps it in its own tables. */
export type JobPayload = Readonly<Record<string, string>>;

export type EnqueueOptions = {
  /** Run no earlier than this, e.g. a delayed rejection email. */
  startAfter?: Date;
};

export interface JobQueue {
  /** Creates a job in `tx` and returns its ID. */
  enqueue(tx: Tx, queue: QueueName, data: JobPayload, options?: EnqueueOptions): Promise<string>;
  /**
   * Cancels a waiting job in `tx`. Returns false, without throwing, when the
   * job is already active, finished, cancelled or unknown, so callers mark
   * an email as cancelled only when it really won't be sent (J2, R7).
   */
  cancel(tx: Tx, queue: QueueName, jobId: string): Promise<boolean>;
}

const WAITING_STATES: ReadonlySet<string> = new Set(["created", "retry"]);

function assertQueue(queue: string): asserts queue is QueueName {
  if (!isQueueName(queue)) throw new Error(`Unknown job queue "${queue}"`);
}

export const jobQueue: JobQueue = {
  async enqueue(tx, queue, data, options = {}) {
    assertQueue(queue);
    const boss = await getBoss();
    const jobId = await boss.send(queue, data, { startAfter: options.startAfter, db: fromDrizzle(tx, sql) });
    if (!jobId) throw new Error(`pg-boss created no job on queue "${queue}"`);
    logger.debug({ queue, job_id: jobId }, "job enqueued");
    return jobId;
  },

  async cancel(tx, queue, jobId) {
    assertQueue(queue);
    const boss = await getBoss();
    const db = fromDrizzle(tx, sql);
    // pg-boss also cancels active jobs, which may already have done their
    // work, so only waiting jobs are cancelled. A job a worker claims between
    // this read and the cancel is still caught by its handler's own state
    // check (J3), which sees the caller's committed change.
    const [job] = await boss.findJobs(queue, { id: jobId, db });
    if (!job || !WAITING_STATES.has(job.state)) {
      logger.debug({ queue, job_id: jobId, state: job?.state ?? null }, "job not cancelled");
      return false;
    }
    const { affected } = (await boss.cancel(queue, jobId, { db })) as { affected: number };
    logger.debug({ queue, job_id: jobId, cancelled: affected > 0 }, "job cancel");
    return affected > 0;
  },
};

/** A claimed job as handlers see it: the queue name and the ID-only payload. */
export type Job = { id: string; queue: string; data: JobPayload };

export type JobHandler = (job: Job) => Promise<void>;

/** Queue name to handler. Tests may add test-only queues they create themselves. */
export type HandlerMap = Readonly<Record<string, JobHandler>>;

type BossState = { promise: Promise<PgBoss>; supervise: boolean; working: boolean };

// One instance per process, created on first use and never at import time
// (W1). Outside production it lives on globalThis so hot reload reuses it.
const globalForBoss = globalThis as typeof globalThis & { __atsBoss?: BossState };
let bossState: BossState | undefined = globalForBoss.__atsBoss;

/** pg-boss runs its statements on our pool instead of opening its own (D5). */
function poolDatabase(pool: pg.Pool) {
  return { executeSql: (text: string, values?: unknown[]) => pool.query(text, values) };
}

async function startBoss(pool: pg.Pool, supervise = false): Promise<PgBoss> {
  // W3: never pg-boss cron; daily tasks come from the tick. Maintenance
  // (supervision) runs only in a process that also runs handlers.
  const boss = new PgBoss({ db: poolDatabase(pool), schedule: false, supervise });
  // Without a listener an emitted error would crash the process.
  boss.on("error", (err: Error & { code?: string }) => {
    logger.error({ err: { message: err.message, code: err.code } }, "pg-boss error");
  });
  // Creates or migrates the pgboss schema.
  await boss.start();
  return boss;
}

/**
 * The started pg-boss instance of this process, on the D5 pool. Exported for
 * the worker and tests; domain code uses `jobQueue`. Started without
 * maintenance unless `startJobQueue({ supervise: true })` ran first.
 */
export function getBoss(): Promise<PgBoss> {
  return (bossState ?? createBossState(false)).promise;
}

/**
 * Starts this process's instance; `supervise` turns on pg-boss maintenance,
 * which only a process that runs handlers needs (W1). Fails if the instance
 * already runs with the other setting.
 */
export async function startJobQueue({ supervise }: { supervise: boolean }): Promise<void> {
  const state = bossState ?? createBossState(supervise);
  if (state.supervise !== supervise) {
    throw new Error(`pg-boss already started with supervise=${state.supervise}`);
  }
  await state.promise;
}

function createBossState(supervise: boolean): BossState {
  const state: BossState = { promise: startBoss(getPool(), supervise), supervise, working: false };
  bossState = state;
  if (process.env.NODE_ENV !== "production") globalForBoss.__atsBoss = state;
  // A failed start must not be cached, so the next call tries again.
  state.promise.catch(() => {
    if (bossState === state) {
      bossState = undefined;
      globalForBoss.__atsBoss = undefined;
    }
  });
  return state;
}

export type WorkOptions = {
  /** How often an idle queue is polled; pg-boss default 2 s. */
  pollingIntervalSeconds?: number;
};

/**
 * Registers one pg-boss worker per queue in `handlers` (W1). A handler that
 * resolves completes its job; one that throws fails it, and pg-boss retries
 * it according to the queue's options. Returns the registered queue names.
 */
export async function workQueues(handlers: HandlerMap, options: WorkOptions = {}): Promise<string[]> {
  const boss = await getBoss();
  bossState!.working = true;
  const names = Object.keys(handlers);
  for (const name of names) {
    const handler = handlers[name];
    await boss.work<JobPayload>(name, { pollingIntervalSeconds: options.pollingIntervalSeconds }, async ([job]) => {
      await handler({ id: job.id, queue: job.name, data: job.data });
    });
  }
  return names;
}

export type StopOptions = {
  /**
   * Stop fetching, then wait up to `timeoutMs` for active handlers (W6).
   * pg-boss fails jobs still active after that, so they are retried (J3).
   * Without it, active jobs are failed at once.
   */
  timeoutMs?: number;
};

/** Stops this process's instance, so the process can exit. The pool stays open. */
export async function stopJobQueue({ timeoutMs }: StopOptions = {}): Promise<void> {
  const current = bossState;
  bossState = undefined;
  globalForBoss.__atsBoss = undefined;
  const boss = await current?.promise.catch(() => undefined);
  await boss?.stop({ graceful: timeoutMs !== undefined, timeout: timeoutMs, close: false });
}

export type QueueSetupOptions = {
  /** Run on this pool with a short-lived instance (db:migrate uses the admin login). */
  pool?: pg.Pool;
  /** The declared queues; tests pass changed declarations to exercise updates. */
  queues?: Record<QueueName, QueueOptions>;
};

/** Runs `fn` with this process's instance, or with a short-lived one on `pool`. */
async function withBoss<T>(pool: pg.Pool | undefined, fn: (boss: PgBoss) => Promise<T>): Promise<T> {
  const boss = pool ? await startBoss(pool) : await getBoss();
  try {
    return await fn(boss);
  } finally {
    if (pool) await boss.stop({ graceful: false, close: false });
  }
}

/**
 * Creates the pgboss schema and the four queues, or brings them up to date
 * (J5). Idempotent and safe to run concurrently. Retry options of an existing
 * queue are updated to the declared values; a different policy fails, because
 * pg-boss can't change it.
 */
export function ensureJobQueues({ pool, queues = JOB_QUEUES }: QueueSetupOptions = {}): Promise<void> {
  return withBoss(pool, async (boss) => {
    for (const name of QUEUE_NAMES) {
      const declared = { ...PG_BOSS_DEFAULTS, ...queues[name] };
      // pg-boss creates a queue only if it doesn't exist yet, under an
      // advisory lock, so a concurrent setup that got here first is fine.
      if (!(await boss.getQueue(name))) await boss.createQueue(name, declared);
      const queue = await boss.getQueue(name);
      if (queue?.policy !== declared.policy) {
        throw new Error(
          `Job queue "${name}" has policy "${queue?.policy}" but "${declared.policy}" is declared; ` +
            "pg-boss can't change a queue's policy, so delete and recreate the queue deliberately.",
        );
      }
      if (queue.retryLimit !== declared.retryLimit || queue.retryBackoff !== declared.retryBackoff) {
        await boss.updateQueue(name, { retryLimit: declared.retryLimit, retryBackoff: declared.retryBackoff });
      }
    }
  });
}

export type QueueSettings = { name: string; policy: string; retryLimit: number; retryBackoff: boolean };

/** The stored settings of the declared queues, read through pg-boss (J5 checks, Admin jobs page). */
export function inspectJobQueues({ pool }: Pick<QueueSetupOptions, "pool"> = {}): Promise<QueueSettings[]> {
  return withBoss(pool, async (boss) => {
    const queues = await boss.getQueues(QUEUE_NAMES);
    return queues
      .map(({ name, policy = PG_BOSS_DEFAULTS.policy, retryLimit = PG_BOSS_DEFAULTS.retryLimit, retryBackoff = false }) => ({
        name,
        policy,
        retryLimit,
        retryBackoff,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });
}

// Test support for the J7 helper (tests/support/process-due-jobs.ts): claim
// due jobs and settle them by hand, without a running worker.

/** True while handlers registered with workQueues() run in this process. */
export function isWorking(): boolean {
  return bossState?.working ?? false;
}

/** Claims up to `limit` jobs of `queue` whose start time has passed (state becomes `active`). */
export async function fetchDueJobs(queue: string, limit: number): Promise<Job[]> {
  const boss = await getBoss();
  const jobs = await boss.fetch<JobPayload>(queue, { batchSize: limit });
  return jobs.map((job) => ({ id: job.id, queue: job.name, data: job.data }));
}

/** Marks a claimed job completed. */
export async function completeJob(queue: string, jobId: string): Promise<void> {
  await (await getBoss()).complete(queue, jobId);
}

/** Marks a claimed job failed; pg-boss retries it according to the queue's options. */
export async function failJob(queue: string, jobId: string, error: Error): Promise<void> {
  await (await getBoss()).fail(queue, jobId, { message: error.message });
}
