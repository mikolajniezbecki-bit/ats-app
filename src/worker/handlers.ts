// The production handler registry (W2): queue name to handler.
// Every handler checks current state before acting and is safe to run twice
// (J3).
import type { JobHandler, QueueName } from "../server/adapters/job-queue";
import { runApprovalReminders } from "../server/approvals/reminders";
import { emailSendHandler } from "../server/email/send";
import { offerRenderPdfHandler } from "../server/offers/letter";
import { retentionPurgeTask } from "../server/retention";
import { dailyTaskHandler } from "./daily-task";

export const handlers: Partial<Record<QueueName, JobHandler>> = {
  "email.send": emailSendHandler,
  "offer.render-pdf": (job) => offerRenderPdfHandler(job),
  "approvals.remind": dailyTaskHandler(async ({ runDate, now }) => {
    await runApprovalReminders({ runDate, now });
  }),
  "retention.purge": dailyTaskHandler(retentionPurgeTask()),
};
