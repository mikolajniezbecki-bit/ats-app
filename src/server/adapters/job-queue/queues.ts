// The four queues of tech-stack.md §5, declared once (J5). Options left out
// use the pg-boss defaults.

export type QueueOptions = {
  /** Retries after the first attempt; pg-boss default 2. */
  retryLimit?: number;
  /** Exponential backoff between retries; pg-boss default false. */
  retryBackoff?: boolean;
  /** pg-boss can't change the policy of an existing queue. */
  policy?: "singleton";
};

export const JOB_QUEUES = {
  "email.send": { retryLimit: 5, retryBackoff: true },
  "offer.render-pdf": { retryLimit: 3 },
  "approvals.remind": { policy: "singleton" },
  "retention.purge": { policy: "singleton" },
} as const satisfies Record<string, QueueOptions>;

export type QueueName = keyof typeof JOB_QUEUES;

export const QUEUE_NAMES = Object.keys(JOB_QUEUES) as QueueName[];

export function isQueueName(name: string): name is QueueName {
  return Object.hasOwn(JOB_QUEUES, name);
}

/** pg-boss defaults, so updating an existing queue also resets an option removed above. */
export const PG_BOSS_DEFAULTS = { retryLimit: 2, retryBackoff: false, policy: "standard" } as const;
