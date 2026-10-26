// The production handler registry (W2): queue name to handler.
// retention.purge is a stub until task 40. offer.render-pdf is a no-op until
// task 37 renders the letter: approvals queue it from task 36 on, and the
// tick waits for every due job (W4), so an unhandled queue would keep every
// tick waiting until its timeout. Every handler checks current state before
// acting and is safe to run twice (J3).
import type { JobHandler, QueueName } from "../server/adapters/job-queue";
import { runApprovalReminders } from "../server/approvals/reminders";
import { emailSendHandler } from "../server/email/send";
import { dailyTaskHandler, stubDailyTask } from "./daily-task";

export const handlers: Partial<Record<QueueName, JobHandler>> = {
  "email.send": emailSendHandler,
  "offer.render-pdf": async () => undefined,
  "approvals.remind": dailyTaskHandler(async ({ runDate, now }) => {
    await runApprovalReminders({ runDate, now });
  }),
  "retention.purge": dailyTaskHandler(stubDailyTask),
};
