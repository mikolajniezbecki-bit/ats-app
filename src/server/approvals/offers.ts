// Offer approval (ats-project-scope.md §5.2 A1–A9, §5.6, L8, E7; tech-stack.md
// D3, D7, J1, J4): the offer subject adapter of the shared approval service.
// It uses the same approver check (A1, A2, with the approver row FOR SHARE
// against the A5 race), the same audit trail (A7), the same approval.decide
// and approval.withdraw rules (through offerApproval()) and the same
// reassignment rules as requisitions; the offer's own state rules come from
// domain/offers. Locks come from the offer service (requisition FOR SHARE,
// application FOR UPDATE, offers FOR UPDATE). Logs carry IDs only, never
// salaries, comments or names (M2).
import { and, asc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { jobQueue } from "../adapters/job-queue";
import { type Db, type Tx, getDb } from "../db";
import { applications, offers, requisitions, users } from "../db/schema";
import { type SubmitRefusal, submitRefusal } from "../domain/offers";
import { queueOfferApprovalRequest } from "../email/approval-request";
import { logger } from "../logger";
import { type OfferRow, lockOffer, offerApproval, validateOfferFields } from "../offers";
import { type PolicyUser, can } from "../policy/permissions";
import { listActiveUsers } from "../users";
import { APPROVER_ROLES, MAX_COMMENT_LENGTH, approverError, recordApprovalEvent } from "./index";

export type OfferApprovalError = "invalid" | "notFound" | "forbidden" | "stale" | "notPending" | "approveBlocked" | SubmitRefusal;
export type OfferApprovalResult = { ok: true; offer: OfferRow } | { ok: false; reason: OfferApprovalError; fields?: Record<string, string> };

const comment = z.string().trim().max(MAX_COMMENT_LENGTH);
const submitSchema = z.object({ approverId: z.string(), version: z.number().int().min(1) }).strict();
const decisionSchema = z.object({ version: z.number().int().min(1), comment: comment.optional() }).strict();
const reassignSchema = z.object({ approverId: z.string(), reason: z.string(), version: z.number().int().min(1) }).strict();

function zodFields(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") for (const key of issue.keys) fields[key] = "invalid";
    else fields[String(issue.path[0] ?? "_")] ??= issue.path[0] === "comment" ? "commentTooLong" : issue.path[0] === "reason" ? "reasonRequired" : "invalid";
  }
  return fields;
}

export { offerApproval };

/** Moves the offer from `from` to the changes, only at `version` (D7) and in `from`. */
async function transition(tx: Tx, id: string, version: number, from: OfferRow["approvalStatus"], changes: Partial<typeof offers.$inferInsert>, now: Date) {
  const [row] = await tx
    .update(offers)
    .set({ ...changes, version: sql`${offers.version} + 1`, updatedAt: now })
    .where(and(eq(offers.id, id), eq(offers.version, version), eq(offers.approvalStatus, from)))
    .returning();
  return row;
}

/**
 * A1, A2, L8 (Q5): submits the latest DRAFT or REJECTED offer to an active
 * Hiring Manager or Admin other than the caller. The fields are checked again
 * and the template must be active. Queues the approval request (E7, Q6).
 */
export async function submitOffer(tx: Tx, user: PolicyUser, offerId: string, input: unknown, now = new Date()): Promise<OfferApprovalResult> {
  const locked = await lockOffer(tx, user, offerId);
  if (!locked) return { ok: false, reason: "notFound" };
  const parsed = submitSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid", fields: zodFields(parsed.error) };
  const { approverId, version } = parsed.data;
  const { offer } = locked;
  const refused = submitRefusal(offer, locked.offers, locked.application.status, locked.requisitionState);
  if (refused) return { ok: false, reason: refused };

  const fields = await validateOfferFields(tx, { jobTitle: offer.jobTitle, salary: offer.salary, currency: offer.currency, startDate: offer.startDate, templateId: offer.templateId }, now);
  const approver = await approverError(tx, approverId, user.id);
  if (approver) fields.approverId = approver;
  if (Object.keys(fields).length > 0) return { ok: false, reason: "invalid", fields };
  if (offer.version !== version) return { ok: false, reason: "stale" };

  const updated = await transition(tx, offerId, version, offer.approvalStatus, { approvalStatus: "PENDING", submittedByUserId: user.id, submittedAt: now, approverId }, now);
  if (!updated) return { ok: false, reason: "stale" };
  await recordApprovalEvent(tx, { subjectType: "OFFER", subjectId: offerId, event: "SUBMITTED", actorUserId: user.id, toApproverId: approverId });
  await queueOfferApprovalRequest(tx, offerId);
  logger.info({ offer_id: offerId, user_id: user.id, approver_id: approverId }, "offer submitted");
  return { ok: true, offer: updated };
}

/**
 * A3, L8: the current approver, never the submitter, approves (needs the
 * application in OFFER and the requisition APPROVED) or rejects with a
 * comment (allowed during L8). Approving queues the letter render (J1, J4,
 * Q8); decisions send no email (E7).
 */
export async function decideOffer(tx: Tx, user: PolicyUser, offerId: string, decision: "approve" | "reject", input: unknown, now = new Date()): Promise<OfferApprovalResult> {
  const locked = await lockOffer(tx, user, offerId);
  if (!locked) return { ok: false, reason: "notFound" };
  const { offer } = locked;
  if (offer.approvalStatus !== "PENDING") return { ok: false, reason: "notPending" };
  if (!can(user, "approval.decide", offerApproval(offer))) return { ok: false, reason: "forbidden" };
  const parsed = decisionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid", fields: zodFields(parsed.error) };
  const { version, comment: note } = parsed.data;
  if (decision === "reject" && !note) return { ok: false, reason: "invalid", fields: { comment: "commentRequired" } };
  const approve = decision === "approve";
  if (approve && (locked.application.status !== "OFFER" || locked.requisitionState !== "APPROVED")) return { ok: false, reason: "approveBlocked" };
  if (offer.version !== version) return { ok: false, reason: "stale" };

  const updated = await transition(tx, offerId, version, "PENDING", { approvalStatus: approve ? "APPROVED" : "REJECTED" }, now);
  if (!updated) return { ok: false, reason: "stale" };
  await recordApprovalEvent(tx, { subjectType: "OFFER", subjectId: offerId, event: approve ? "APPROVED" : "REJECTED", actorUserId: user.id, comment: note });
  if (approve) await jobQueue.enqueue(tx, "offer.render-pdf", { offerId });
  logger.info({ offer_id: offerId, user_id: user.id, decision }, "offer decided");
  return { ok: true, offer: updated };
}

/**
 * A9: the submitter, a Recruiter or an Admin takes a PENDING offer back to
 * DRAFT; the submission fields keep the latest submission (Q3). Allowed
 * during L8.
 */
export async function withdrawOfferRequest(tx: Tx, user: PolicyUser, offerId: string, input: unknown, now = new Date()): Promise<OfferApprovalResult> {
  const locked = await lockOffer(tx, user, offerId);
  if (!locked) return { ok: false, reason: "notFound" };
  const { offer } = locked;
  if (offer.approvalStatus !== "PENDING") return { ok: false, reason: "notPending" };
  if (!can(user, "approval.withdraw", offerApproval(offer))) return { ok: false, reason: "forbidden" };
  const parsed = decisionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid", fields: zodFields(parsed.error) };
  if (offer.version !== parsed.data.version) return { ok: false, reason: "stale" };
  const updated = await transition(tx, offerId, parsed.data.version, "PENDING", { approvalStatus: "DRAFT" }, now);
  if (!updated) return { ok: false, reason: "stale" };
  await recordApprovalEvent(tx, { subjectType: "OFFER", subjectId: offerId, event: "WITHDRAWN", actorUserId: user.id, fromApproverId: offer.approverId, comment: parsed.data.comment });
  logger.info({ offer_id: offerId, user_id: user.id }, "offer request withdrawn");
  return { ok: true, offer: updated };
}

/**
 * A4: a Recruiter or an Admin hands a PENDING offer to another active
 * Hiring Manager or Admin, not the submitter and not the current approver,
 * with a reason; the new approver gets the approval request. Allowed during
 * L8 (Q1).
 */
export async function reassignOffer(tx: Tx, user: PolicyUser, offerId: string, input: unknown, now = new Date()): Promise<OfferApprovalResult> {
  const locked = await lockOffer(tx, user, offerId);
  if (!locked) return { ok: false, reason: "notFound" };
  if (!can(user, "approval.reassign")) return { ok: false, reason: "forbidden" };
  const { offer } = locked;
  if (offer.approvalStatus !== "PENDING" || !offer.submittedByUserId || !offer.approverId) return { ok: false, reason: "notPending" };
  const parsed = reassignSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid", fields: zodFields(parsed.error) };
  const { approverId, version } = parsed.data;
  const reason = parsed.data.reason.trim();
  const fields: Record<string, string> = {};
  if (reason.length === 0 || reason.length > MAX_COMMENT_LENGTH) fields.reason = "reasonRequired";
  if (approverId === offer.approverId) fields.approverId = "approverCurrent";
  else {
    const approver = await approverError(tx, approverId, offer.submittedByUserId);
    if (approver) fields.approverId = approver === "approverSelf" ? "approverSubmitter" : approver;
  }
  if (Object.keys(fields).length > 0) return { ok: false, reason: "invalid", fields };
  if (offer.version !== version) return { ok: false, reason: "stale" };

  const updated = await transition(tx, offerId, version, "PENDING", { approverId }, now);
  if (!updated) return { ok: false, reason: "stale" };
  await recordApprovalEvent(tx, { subjectType: "OFFER", subjectId: offerId, event: "REASSIGNED", actorUserId: user.id, fromApproverId: offer.approverId, toApproverId: approverId, comment: reason });
  await queueOfferApprovalRequest(tx, offerId);
  logger.info({ offer_id: offerId, user_id: user.id, from_approver_id: offer.approverId, to_approver_id: approverId }, "offer reassigned");
  return { ok: true, offer: updated };
}

/** The approver pickers: active Hiring Managers and Admins, minus `exclude` (the caller, or the submitter and current approver). */
export async function listOfferApproverOptions(exclude: readonly (string | null)[], db: Db | Tx = getDb()): Promise<{ id: string; name: string }[]> {
  const approvers = await listActiveUsers({ roles: APPROVER_ROLES }, db);
  return approvers.filter((approver) => !exclude.includes(approver.id)).map(({ id, name }) => ({ id, name }));
}

function pendingOffersQuery(db: Db | Tx) {
  const submitter = alias(users, "submitter");
  const approver = alias(users, "approver");
  return db
    .select({
      id: offers.id,
      applicationId: offers.applicationId,
      reqNumber: requisitions.reqNumber,
      jobTitle: offers.jobTitle,
      firstName: applications.firstName,
      lastName: applications.lastName,
      submitter: submitter.name,
      approver: approver.name,
      approverActive: approver.isActive,
      approverId: offers.approverId,
      submittedAt: offers.submittedAt,
    })
    .from(offers)
    .innerJoin(applications, eq(applications.id, offers.applicationId))
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .leftJoin(submitter, eq(submitter.id, offers.submittedByUserId))
    .leftJoin(approver, eq(approver.id, offers.approverId));
}

const withCandidate = <T extends { firstName: string | null; lastName: string | null }>(row: T) => ({ ...row, candidate: `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim() });

/** "My approvals" (task 36): offers waiting for this approver, oldest submission first. */
export async function listMyOfferApprovals(user: PolicyUser, db: Db | Tx = getDb()) {
  const rows = await pendingOffersQuery(db)
    .where(and(eq(offers.approvalStatus, "PENDING"), eq(offers.approverId, user.id)))
    .orderBy(asc(offers.submittedAt), asc(offers.id));
  return rows.map(withCandidate);
}

/** "All pending approvals" (A4, A5): every pending offer, oldest submission first. */
export async function listAllPendingOfferApprovals(db: Db | Tx = getDb()) {
  const rows = await pendingOffersQuery(db).where(eq(offers.approvalStatus, "PENDING")).orderBy(asc(offers.submittedAt), asc(offers.id));
  return rows.map(withCandidate);
}
