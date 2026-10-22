// The production handler registry (W2): queue name to handler. Empty until
// the first handlers land: task 9 adds the daily stubs, tasks 18, 31, 37 and
// 40 the real email.send, approvals.remind, offer.render-pdf and
// retention.purge handlers. Every handler checks current state before acting
// and is safe to run twice (J3).
import type { JobHandler, QueueName } from "../server/adapters/job-queue";

export const handlers: Partial<Record<QueueName, JobHandler>> = {};
