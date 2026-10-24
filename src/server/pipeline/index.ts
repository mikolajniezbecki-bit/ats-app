// Application status changes (ats-project-scope.md §5.4 R1–R3, R7–R9, R11,
// E8, E9; tech-stack.md D3, D7, J1, J2). The only code that changes
// `applications.status` after apply: bulk moves, requisition close,
// interviews and hiring (tasks 28, 29, 32, 38) extend it instead of writing
// their own updates. Everything runs in the caller's transaction, and every
// check comes before the first write, so a refusal changes nothing. Logs
// carry IDs only, never comments or candidate data (M2).
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { jobQueue } from "../adapters/job-queue";
import type { Tx } from "../db";
import { updateWithVersion } from "../db/optimistic-lock";
import { applicationHistory, applications, emailLog, offers, requisitions } from "../db/schema";
import { type PipelineStatus, type TransitionRefusal, checkTransition, isOpenStatus } from "../domain/pipeline";
import { queueTemplateEmail } from "../email";
import { logger } from "../logger";
import { message } from "../messages";
import { getSetting } from "../settings";
import { getStageTemplate } from "../templates";

export const MAX_STATUS_COMMENT_LENGTH = 2_000;
/** E9: moving to these sends nothing, whatever templates exist; interviews and offers have their own emails. */
const SILENT_STATUSES: ReadonlySet<PipelineStatus> = new Set(["INTERVIEW", "OFFER"]);
const HOUR = 3_600_000;

export const statusChangeSchema = z
  .object({
    toStatus: z.enum(["APPLIED", "SCREENING", "INTERVIEW", "OFFER", "HIRED", "REJECTED", "WITHDRAWN"]),
    version: z.number().int().min(1),
    comment: z.string().trim().max(MAX_STATUS_COMMENT_LENGTH).optional(),
  })
  .strict();

export type StatusChangeInput = z.infer<typeof statusChangeSchema>;

export type StatusChangeResult =
  | { ok: true; status: PipelineStatus; version: number }
  | { ok: false; reason: "notFound" | "anonymized" | "stale" | TransitionRefusal; message: string };

function refused(reason: "notFound" | "anonymized" | "stale"): StatusChangeResult {
  return { ok: false, reason, message: message(`Pipeline.errors.${reason}`) };
}

/**
 * R7, J2: cancels every QUEUED email of the application, whatever its
 * audience or template. The UPDATE waits for a send in progress (the send
 * handler holds the row lock) and skips rows that are no longer QUEUED; the
 * pg-boss jobs are then cancelled in the same transaction. A job that is
 * gone or already running returns false and is ignored: its handler sees
 * the row is no longer QUEUED (J3).
 */
async function cancelQueuedEmails(tx: Tx, applicationId: string): Promise<number> {
  const cancelled = await tx
    .update(emailLog)
    .set({ status: "CANCELLED", error: "STATUS_CHANGED" })
    .where(and(eq(emailLog.applicationId, applicationId), eq(emailLog.status, "QUEUED")))
    .returning({ jobId: emailLog.jobId });
  for (const { jobId } of cancelled) if (jobId) await jobQueue.cancel(tx, "email.send", jobId);
  return cancelled.length;
}

/** E8, E9: queues the active stage email for `status`, if any; REJECTED after the configured delay. */
async function queueStageEmail(tx: Tx, applicationId: string, status: PipelineStatus, now: Date): Promise<void> {
  if (SILENT_STATUSES.has(status)) return;
  const template = await getStageTemplate(status, tx);
  if (!template) return;
  const delayHours = status === "REJECTED" ? await getSetting("REJECTION_EMAIL_DELAY_HOURS", tx) : 0;
  await queueTemplateEmail(tx, {
    templateId: template.id,
    applicationId,
    startAfter: delayHours > 0 ? new Date(now.getTime() + delayHours * HOUR) : undefined,
  });
}

/**
 * Moves one application to `toStatus` at `version` (D7, R9), in `tx` (D3):
 * checks the transition, cancels queued emails (R7), updates the
 * application, writes history (R8) and queues the stage email (E8).
 * Permission checks are the caller's (`application.changeStatus`).
 */
export async function changeApplicationStatus(
  tx: Tx,
  input: { applicationId: string; toStatus: PipelineStatus; version: number; comment?: string; actor: { id: string } },
): Promise<StatusChangeResult> {
  const { applicationId, toStatus, version, actor } = input;
  const comment = input.comment?.trim() || null;

  const [found] = await tx.select({ requisitionId: applications.requisitionId }).from(applications).where(eq(applications.id, applicationId));
  if (!found) return refused("notFound");
  // The requisition first (FOR SHARE), then the application (FOR UPDATE): the
  // same order as a requisition close (task 29), so the two can't deadlock,
  // and a concurrent change of this application waits here and then sees the
  // new version.
  const [requisition] = await tx
    .select({ state: requisitions.state, approvedAt: requisitions.approvedAt })
    .from(requisitions)
    .where(eq(requisitions.id, found.requisitionId))
    .for("share");
  const [application] = await tx.select().from(applications).where(eq(applications.id, applicationId)).for("update");
  if (application.anonymizedAt) return refused("anonymized");
  if (application.version !== version) return refused("stale");

  const [accepted] = await tx
    .select({ id: offers.id })
    .from(offers)
    .where(and(eq(offers.applicationId, applicationId), eq(offers.candidateResponse, "ACCEPTED")))
    .limit(1);
  const check = checkTransition(application.status, toStatus, {
    requisitionState: requisition.state,
    requisitionApprovedAt: requisition.approvedAt,
    hasAcceptedOffer: accepted !== undefined,
    comment,
  });
  if (!check.ok) return { ok: false, reason: check.reason, message: check.message };

  const cancelledEmails = await cancelQueuedEmails(tx, applicationId);

  const now = new Date();
  const reasonCode = toStatus === "REJECTED" ? ("OTHER" as const) : null;
  const final = !isOpenStatus(toStatus);
  const updated = await updateWithVersion(tx, applications, applicationId, version, {
    status: toStatus,
    reasonCode,
    dispositionedAt: final ? now : null,
    ...(toStatus === "HIRED" ? { hiredAt: now } : {}),
  });

  await tx.insert(applicationHistory).values({
    applicationId,
    fromStatus: application.status,
    toStatus,
    changedByUserId: actor.id,
    comment,
    reasonCode,
    isReopen: check.isReopen,
  });

  await queueStageEmail(tx, applicationId, toStatus, now);

  logger.info(
    {
      application_id: applicationId,
      requisition_id: found.requisitionId,
      user_id: actor.id,
      from_status: application.status,
      to_status: toStatus,
      reopen: check.isReopen,
      cancelled_emails: cancelledEmails,
    },
    "application status changed",
  );
  return { ok: true, status: updated.status, version: updated.version };
}
