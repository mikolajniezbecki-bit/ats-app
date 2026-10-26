// The production handler registry (W2): queue name to handler.
// retention.purge is a stub until task 40; task 37 adds offer.render-pdf. Every handler checks current state before
// acting and is safe to run twice (J3).
import type { JobHandler, QueueName } from "../server/adapters/job-queue";
import { runApprovalReminders } from "../server/approvals/reminders";
import { emailSendHandler } from "../server/email/send";
import { dailyTaskHandler, stubDailyTask } from "./daily-task";

export const handlers: Partial<Record<QueueName, JobHandler>> = {
  "email.send": emailSendHandler,
  "approvals.remind": dailyTaskHandler(async ({ runDate, now }) => {
    await runApprovalReminders({ runDate, now });
  }),
  "retention.purge": dailyTaskHandler(stubDailyTask),
};
