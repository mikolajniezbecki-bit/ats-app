// The production handler registry (W2): queue name to handler. The daily
// tasks are stubs until tasks 31 and 40; tasks 18 and 37 add the email.send
// and offer.render-pdf handlers. Every handler checks current state before
// acting and is safe to run twice (J3).
import type { JobHandler, QueueName } from "../server/adapters/job-queue";
import { dailyTaskHandler, stubDailyTask } from "./daily-task";

export const handlers: Partial<Record<QueueName, JobHandler>> = {
  "approvals.remind": dailyTaskHandler(stubDailyTask),
  "retention.purge": dailyTaskHandler(stubDailyTask),
};
