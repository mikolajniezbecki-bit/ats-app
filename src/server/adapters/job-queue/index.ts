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
  /**
   * Cancels every waiting job of `queue` whose payload contains `data`
   * (e.g. `{ offerId }`), in `tx`; returns how many (J2). Active and finished
   * jobs are left to their handler's state check (J3).
   */
  cancelWaiting(tx: Tx, queue: QueueName, data: JobPayload): Promise<number>;
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

  async cancelWaiting(tx, queue, data) {
    assertQueue(queue);
    const boss = await getBoss();
    const db = fromDrizzle(tx, sql);
    const jobs = await boss.findJobs(queue, { data, db });
    let cancelled = 0;
    for (const job of jobs) if (WAITING_STATES.has(job.state) && (await jobQueue.cancel(tx, queue, job.id))) cancelled += 1;
    return cancelled;
  },
};

/**
 * A claimed job as handlers see it: the queue name, the ID-only payload, and
 * how many attempts came before this one (0 on the first), so a handler can
 * tell its last attempt (E5).
 */
export type Job = { id: string; queue: string; data: JobPayload; retryCount: number };

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
  // pg-boss rejects an explicit `pollingIntervalSeconds: undefined`, so the
  // key is left out unless set.
  const workOptions =
    options.pollingIntervalSeconds === undefined ? {} : { pollingIntervalSeconds: options.pollingIntervalSeconds };
  for (const name of names) {
    const handler = handlers[name];
    await boss.work<JobPayload>(name, workOptions, async ([job]) => {
      await handler({ id: job.id, queue: job.name, data: job.data, retryCount: job.retryCount });
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

// The only direct SQL against pg-boss's tables (T3). pg-boss 12.38 keeps every
// job in `pgboss.job` (partitioned by queue name); `state` is the
// `pgboss.job_state` enum and `start_after` the earliest start time, compared
// with the database now() when a worker fetches.

/**
 * W4: the number of jobs, across all queues, that are due or running now:
 * state `created`, `retry` or `active` with a start time ≤ the database
 * now(). Future-dated jobs are never counted. Read-only.
 */
export async function countDueJobs(): Promise<number> {
  await getBoss();
  const { rows } = await getPool().query<{ count: number }>(
    `SELECT count(*)::int AS count FROM pgboss.job
     WHERE state IN ('created', 'retry', 'active') AND start_after <= now()`,
  );
  return rows[0].count;
}

/**
 * T3 clock shift, test clock only: every waiting job (`created` or `retry`)
 * whose start time is ≤ `testNow` gets the database now() as its start time,
 * so it runs at once. Callers run it only when the test clock is honoured
 * (AUTH_DEV_LOGIN=true). The only code that writes to pg-boss tables.
 * Returns the number of jobs moved.
 */
export async function shiftJobClock(testNow: Date): Promise<number> {
  await getBoss();
  const { rowCount } = await getPool().query(
    `UPDATE pgboss.job SET start_after = now()
     WHERE state IN ('created', 'retry') AND start_after <= $1 AND start_after > now()`,
    [testNow],
  );
  if (rowCount) logger.info({ moved: rowCount }, "test clock shift");
  return rowCount ?? 0;
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
  return jobs.map((job) => ({ id: job.id, queue: job.name, data: job.data, retryCount: job.retryCount }));
}

/** Marks a claimed job completed. */
export async function completeJob(queue: string, jobId: string): Promise<void> {
  await (await getBoss()).complete(queue, jobId);
}

/** Marks a claimed job failed; pg-boss retries it according to the queue's options. */
export async function failJob(queue: string, jobId: string, error: Error): Promise<void> {
  await (await getBoss()).fail(queue, jobId, { message: error.message });
}

// J6 Admin view: read-only listings of pg-boss jobs. pg-boss 12's public API
// has no list by state (findJobs filters by id, key or data only, and
// getQueue's counts come from maintenance passes), so these read
// pgboss.job directly, as T3 allows for the J6 listings.

export type JobListState = "queued" | "active" | "failed";

export type JobCounts = { queue: string; queued: number; active: number; failed: number };

export type JobListing = {
  id: string;
  queue: string;
  state: string;
  createdOn: Date;
  startAfter: Date;
  retryCount: number;
  /** The last error message, cut to 500 characters. */
  error: string | null;
  /** IDs only (J4). */
  data: unknown;
};

const STATE_GROUPS: Record<JobListState, string[]> = { queued: ["created", "retry"], active: ["active"], failed: ["failed"] };

/** Queued (`created` + `retry`), active and failed jobs per queue. Read-only. */
export async function countJobsByState(queues: readonly string[] = QUEUE_NAMES): Promise<JobCounts[]> {
  await getBoss();
  const { rows } = await getPool().query<{ name: string; state: string; count: number }>(
    `SELECT name, state::text AS state, count(*)::int AS count FROM pgboss.job
     WHERE name = ANY($1) AND state IN ('created', 'retry', 'active', 'failed')
     GROUP BY name, state`,
    [queues],
  );
  return queues.map((queue) => {
    const count = (states: string[]) =>
      rows.filter((row) => row.name === queue && states.includes(row.state)).reduce((sum, row) => sum + row.count, 0);
    return { queue, queued: count(STATE_GROUPS.queued), active: count(STATE_GROUPS.active), failed: count(STATE_GROUPS.failed) };
  });
}

/** The newest `limit` jobs of one queue in one state group. Read-only. */
export async function listJobs(queue: string, state: JobListState, limit = 50): Promise<JobListing[]> {
  await getBoss();
  const { rows } = await getPool().query<{
    id: string;
    name: string;
    state: string;
    created_on: Date;
    start_after: Date;
    retry_count: number;
    error: string | null;
    data: unknown;
  }>(
    `SELECT id, name, state::text AS state, created_on, start_after, retry_count, data,
            left(coalesce(output->>'message', output::text), 500) AS error
     FROM pgboss.job
     WHERE name = $1 AND state::text = ANY($2)
     ORDER BY created_on DESC
     LIMIT $3`,
    [queue, STATE_GROUPS[state], limit],
  );
  return rows.map((row) => ({
    id: row.id,
    queue: row.name,
    state: row.state,
    createdOn: row.created_on,
    startAfter: row.start_after,
    retryCount: row.retry_count,
    // Only failed jobs carry an error; a completed handler's output isn't one.
    error: row.state === "failed" || row.state === "retry" ? row.error : null,
    data: row.data,
  }));
}
