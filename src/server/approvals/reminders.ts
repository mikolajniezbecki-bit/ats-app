// Approval reminders, the daily `approvals.remind` task (ats-project-scope.md
// A6, A7; tech-stack.md J3, W5, T3). A pending requisition is due when at
// least APPROVAL_REMINDER_DAYS Europe/Warsaw calendar days lie between the
// date of its last SUBMITTED, REASSIGNED or REMINDED event and the run date:
// the daily run starts at 08:00 or up to about an hour later, so comparing
// exact timestamps would drift by a day (Q4). Every time comes from the
// tick (`now`, `runDate`), never from the system clock. Logs carry IDs and
// counts only (M2).
import { and, eq, sql } from "drizzle-orm";
import { type Db, type Tx, getDb, withTransaction } from "../db";
import { requisitions, users } from "../db/schema";
import { WARSAW_TIME_ZONE } from "../domain/daily-tasks";
import { queueRequisitionApprovalReminder } from "../email/approval-request";
import { logger } from "../logger";
import { getSetting } from "../settings";
import { recordApprovalEvent } from "./index";

export type ReminderRun = { runDate: string; now: Date };
export type ReminderSummary = { due: number; reminded: number; skipped: number; failed: number };

/** The events that start the reminder count again (A6). */
const COUNTED_EVENTS = sql`('SUBMITTED', 'REASSIGNED', 'REMINDED')`;

/**
 * The pending requisitions due on `runDate`, oldest first; with `id`, only
 * that one. Each row has the calendar days since the submission.
 */
async function dueRequisitions(db: Db | Tx, runDate: string, days: number, id?: string) {
  const result = await db.execute<{ id: string; days_waiting: number }>(sql`
    SELECT r.id, (${runDate}::date - (r.submitted_at AT TIME ZONE ${WARSAW_TIME_ZONE})::date) AS days_waiting
    FROM requisitions r
    CROSS JOIN LATERAL (
      SELECT max(e.created_at) AS at
      FROM approval_events e
      WHERE e.subject_type = 'REQUISITION' AND e.subject_id = r.id AND e.event IN ${COUNTED_EVENTS}
    ) last_event
    WHERE r.state = 'PENDING_APPROVAL'
      AND last_event.at IS NOT NULL
      AND ${runDate}::date - (last_event.at AT TIME ZONE ${WARSAW_TIME_ZONE})::date >= ${days}
      ${id ? sql`AND r.id = ${id}` : sql``}
    ORDER BY r.submitted_at, r.id
  `);
  return result.rows;
}

/**
 * One reminder in its own transaction (Q6): re-checks under the row lock
 * that the requisition is still pending and still due (J3), skips an
 * inactive approver with a warning, then queues the email and records
 * REMINDED at the tick's `now` (A7: system actor, `to_approver_id`).
 */
async function remindRequisition(id: string, run: ReminderRun, days: number): Promise<"reminded" | "skipped"> {
  return withTransaction(async (tx) => {
    const [locked] = await tx
      .select({ approverId: requisitions.approverId })
      .from(requisitions)
      .where(and(eq(requisitions.id, id), eq(requisitions.state, "PENDING_APPROVAL")))
      .for("update");
    const [due] = locked ? await dueRequisitions(tx, run.runDate, days, id) : [];
    if (!locked?.approverId || !due) return "skipped";
    const [approver] = await tx.select({ isActive: users.isActive }).from(users).where(eq(users.id, locked.approverId));
    if (!approver?.isActive) {
      logger.warn({ requisition_id: id, approver_id: locked.approverId }, "approval reminder skipped: approver inactive");
      return "skipped";
    }
    await queueRequisitionApprovalReminder(tx, id, Number(due.days_waiting));
    await recordApprovalEvent(tx, {
      subjectType: "REQUISITION",
      subjectId: id,
      event: "REMINDED",
      actorUserId: null,
      toApproverId: locked.approverId,
      createdAt: run.now,
    });
    return "reminded";
  });
}

/**
 * The `approvals.remind` work for one run date. One failing item doesn't
 * stop the others; if any failed, it throws after all were tried, so the
 * run is FAILED and retried, and the items already reminded are skipped on
 * the retry because their last event is now on the run date.
 */
export async function runApprovalReminders(run: ReminderRun): Promise<ReminderSummary> {
  const days = await getSetting("APPROVAL_REMINDER_DAYS");
  const due = await dueRequisitions(getDb(), run.runDate, days);
  const summary: ReminderSummary = { due: due.length, reminded: 0, skipped: 0, failed: 0 };
  for (const { id } of due) {
    try {
      summary[await remindRequisition(id, run, days)] += 1;
    } catch (err) {
      summary.failed += 1;
      logger.error({ err, requisition_id: id }, "approval reminder failed");
    }
  }
  logger.info({ run_date: run.runDate, ...summary }, "approval reminders done");
  if (summary.failed > 0) throw new Error(`${summary.failed} of ${summary.due} approval reminders failed`);
  return summary;
}
