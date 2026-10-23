// Single-step approvals (ats-project-scope.md §5.2 A1–A3, A7, A9, L8, L11;
// tech-stack.md D3, D7). Submit, decide and withdraw share the approver
// check (A1, A2) and the audit trail (A7); each subject type (a requisition
// now, an offer in task 36) supplies its own state transitions. Every
// transition updates `WHERE id AND version AND state`, so of two concurrent
// actions on the same version exactly one wins. Logs carry IDs only (M2).
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { type Db, type Tx, getDb } from "../db";
import { approvalEvents, masterData, requisitionHistory, requisitions, users } from "../db/schema";
import { queueRequisitionApprovalRequest } from "../email/approval-request";
import { logger } from "../logger";
import { listActiveUsers } from "../users";
import { type ApprovalResource, type PolicyUser, can } from "../policy/permissions";
import { type FieldErrors, type RequisitionRow, findVisibleRequisition, isFirstApprovalPending, submissionErrors } from "../requisitions";

export const APPROVER_ROLES = ["HIRING_MANAGER", "ADMIN"] as const;
export const MAX_COMMENT_LENGTH = 2_000;

type SubjectType = "REQUISITION" | "OFFER";
type ApprovalEvent = "SUBMITTED" | "APPROVED" | "REJECTED" | "WITHDRAWN" | "REASSIGNED" | "REMINDED";

export type ApprovalResult =
  | { ok: true; requisition: RequisitionRow }
  | { ok: false; reason: "invalid"; fields: FieldErrors }
  | { ok: false; reason: "notFound" | "forbidden" | "stale" | "notSubmittable" | "notPending" };

const comment = z.string().trim().max(MAX_COMMENT_LENGTH);
const submitSchema = z.object({ approverId: z.string(), version: z.number().int().min(1) }).strict();
const decisionSchema = z.object({ version: z.number().int().min(1), comment: comment.optional() }).strict();

function zodFields(error: z.ZodError): FieldErrors {
  const fields: FieldErrors = {};
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") for (const key of issue.keys) fields[key] = "readOnlyField";
    else fields[String(issue.path[0] ?? "_")] ??= issue.path[0] === "comment" ? "commentTooLong" : "invalid";
  }
  return fields;
}

/**
 * A1, A2: the approver is an active Hiring Manager or Admin and isn't the
 * submitter, whatever the submitter's role. Returns an error code or undefined.
 */
export async function approverError(tx: Tx, approverId: string, submitterId: string): Promise<string | undefined> {
  if (!z.uuid().safeParse(approverId).success) return "approverInvalid";
  if (approverId === submitterId) return "approverSelf";
  const [approver] = await tx.select({ role: users.role, isActive: users.isActive }).from(users).where(eq(users.id, approverId));
  if (!approver || !approver.isActive || !(APPROVER_ROLES as readonly string[]).includes(approver.role)) return "approverInvalid";
  return undefined;
}

/** A7: one approval event per action, in the action's transaction. */
export async function recordApprovalEvent(
  tx: Tx,
  event: { subjectType: SubjectType; subjectId: string; event: ApprovalEvent; actorUserId: string | null; fromApproverId?: string | null; toApproverId?: string | null; comment?: string | null },
): Promise<void> {
  await tx.insert(approvalEvents).values({
    subjectType: event.subjectType,
    subjectId: event.subjectId,
    event: event.event,
    actorUserId: event.actorUserId,
    fromApproverId: event.fromApproverId ?? null,
    toApproverId: event.toApproverId ?? null,
    comment: event.comment || null,
  });
}

/** The approval view of a requisition, for can() (A2, A3, A9). */
export function requisitionApproval(requisition: RequisitionRow): ApprovalResource {
  return { pending: isFirstApprovalPending(requisition), approverId: requisition.approverId, submittedByUserId: requisition.submittedByUserId };
}

/** Moves the requisition from `from` to the changes, only at `version` (D7) and in `from`. */
async function transition(
  tx: Tx,
  id: string,
  version: number,
  from: RequisitionRow["state"],
  changes: Partial<typeof requisitions.$inferInsert>,
): Promise<RequisitionRow | undefined> {
  const [row] = await tx
    .update(requisitions)
    .set({ ...changes, version: sql`${requisitions.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(requisitions.id, id), eq(requisitions.version, version), eq(requisitions.state, from)))
    .returning();
  return row;
}

/** L11: every state change is written to the requisition's history. */
async function stateHistory(tx: Tx, id: string, from: string, to: string, userId: string, note?: string | null) {
  await tx.insert(requisitionHistory).values({ requisitionId: id, event: "STATE_CHANGE", field: "state", oldValue: from, newValue: to, userId, comment: note || null });
}

/**
 * A1, A2: submits a DRAFT to `approverId`. Allowed for users who may edit
 * the draft; the requisition is checked again in full first. Queues the
 * approval request to the approver (E7).
 */
export async function submitRequisition(tx: Tx, user: PolicyUser, id: string, input: unknown): Promise<ApprovalResult> {
  const current = await findVisibleRequisition(user, id, tx);
  if (!current) return { ok: false, reason: "notFound" };
  if (!can(user, "requisition.edit", current) || (user.role === "HIRING_MANAGER" && current.state !== "DRAFT")) {
    return { ok: false, reason: "forbidden" };
  }
  const parsed = submitSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid", fields: zodFields(parsed.error) };
  const { approverId, version } = parsed.data;
  if (current.version !== version) return { ok: false, reason: "stale" };
  if (current.state !== "DRAFT") return { ok: false, reason: "notSubmittable" };

  const fields = await submissionErrors(tx, current);
  const approver = await approverError(tx, approverId, user.id);
  if (approver) fields.approverId = approver;
  if (Object.keys(fields).length > 0) return { ok: false, reason: "invalid", fields };

  const requisition = await transition(tx, id, version, "DRAFT", {
    state: "PENDING_APPROVAL",
    submittedByUserId: user.id,
    submittedAt: new Date(),
    approverId,
  });
  if (!requisition) return { ok: false, reason: "stale" };
  await recordApprovalEvent(tx, { subjectType: "REQUISITION", subjectId: id, event: "SUBMITTED", actorUserId: user.id, toApproverId: approverId });
  await stateHistory(tx, id, "DRAFT", "PENDING_APPROVAL", user.id);
  await queueRequisitionApprovalRequest(tx, id);
  logger.info({ requisition_id: id, user_id: user.id, approver_id: approverId }, "requisition submitted");
  return { ok: true, requisition };
}

/**
 * A3, first approval: only the current approver, never the submitter, while
 * the requisition is in first-approval PENDING_APPROVAL. Approve publishes
 * it; reject (comment required) returns it to DRAFT. The submission fields
 * stay as they were (§7).
 */
export async function decideRequisition(tx: Tx, user: PolicyUser, id: string, decision: "approve" | "reject", input: unknown): Promise<ApprovalResult> {
  const current = await findVisibleRequisition(user, id, tx);
  if (!current) return { ok: false, reason: "notFound" };
  if (!isFirstApprovalPending(current)) return { ok: false, reason: "notPending" };
  if (!can(user, "approval.decide", requisitionApproval(current))) return { ok: false, reason: "forbidden" };
  const parsed = decisionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid", fields: zodFields(parsed.error) };
  const { version, comment: note } = parsed.data;
  if (decision === "reject" && !note) return { ok: false, reason: "invalid", fields: { comment: "commentRequired" } };
  if (current.version !== version) return { ok: false, reason: "stale" };

  const approve = decision === "approve";
  const requisition = await transition(
    tx,
    id,
    version,
    "PENDING_APPROVAL",
    approve ? { state: "APPROVED", approvedAt: new Date(), isPublished: true } : { state: "DRAFT" },
  );
  if (!requisition) return { ok: false, reason: "stale" };
  await recordApprovalEvent(tx, { subjectType: "REQUISITION", subjectId: id, event: approve ? "APPROVED" : "REJECTED", actorUserId: user.id, comment: note });
  await stateHistory(tx, id, "PENDING_APPROVAL", requisition.state, user.id, note);
  logger.info({ requisition_id: id, user_id: user.id, decision }, "requisition decided");
  return { ok: true, requisition };
}

/** A9, first approval: the submitter, a Recruiter or an Admin returns a pending requisition to DRAFT. */
export async function withdrawRequisition(tx: Tx, user: PolicyUser, id: string, input: unknown): Promise<ApprovalResult> {
  const current = await findVisibleRequisition(user, id, tx);
  if (!current) return { ok: false, reason: "notFound" };
  if (!isFirstApprovalPending(current)) return { ok: false, reason: "notPending" };
  if (!can(user, "approval.withdraw", requisitionApproval(current))) return { ok: false, reason: "forbidden" };
  const parsed = decisionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid", fields: zodFields(parsed.error) };
  const { version, comment: note } = parsed.data;
  if (current.version !== version) return { ok: false, reason: "stale" };

  const requisition = await transition(tx, id, version, "PENDING_APPROVAL", { state: "DRAFT" });
  if (!requisition) return { ok: false, reason: "stale" };
  await recordApprovalEvent(tx, { subjectType: "REQUISITION", subjectId: id, event: "WITHDRAWN", actorUserId: user.id, fromApproverId: current.approverId, comment: note });
  await stateHistory(tx, id, "PENDING_APPROVAL", "DRAFT", user.id, note);
  logger.info({ requisition_id: id, user_id: user.id }, "requisition withdrawn");
  return { ok: true, requisition };
}

/**
 * The approver picker (A1, A2): active Hiring Managers and Admins, sorted by
 * name, without the current user, who could never approve their own submission.
 */
export async function listApproverOptions(user: PolicyUser, db: Db | Tx = getDb()): Promise<{ id: string; name: string }[]> {
  const approvers = await listActiveUsers({ roles: APPROVER_ROLES }, db);
  return approvers.filter((approver) => approver.id !== user.id).map(({ id, name }) => ({ id, name }));
}

/** "My approvals": requisitions waiting for this approver, oldest submission first. */
export async function listMyRequisitionApprovals(user: PolicyUser, db: Db | Tx = getDb()) {
  const submitter = alias(users, "submitter");
  return db
    .select({
      id: requisitions.id,
      reqNumber: requisitions.reqNumber,
      title: requisitions.title,
      department: masterData.label,
      submitter: submitter.name,
      submittedAt: requisitions.submittedAt,
    })
    .from(requisitions)
    .innerJoin(masterData, eq(masterData.id, requisitions.departmentId))
    .leftJoin(submitter, eq(submitter.id, requisitions.submittedByUserId))
    .where(and(eq(requisitions.state, "PENDING_APPROVAL"), eq(requisitions.approverId, user.id)))
    .orderBy(asc(requisitions.submittedAt));
}

/** The latest approval event of a requisition, with the actor's name, for its page. */
export async function latestRequisitionApprovalEvent(requisitionId: string, db: Db | Tx = getDb()) {
  const actor = alias(users, "actor");
  const [row] = await db
    .select({ event: approvalEvents.event, comment: approvalEvents.comment, createdAt: approvalEvents.createdAt, actor: actor.name })
    .from(approvalEvents)
    .leftJoin(actor, eq(actor.id, approvalEvents.actorUserId))
    .where(and(eq(approvalEvents.subjectType, "REQUISITION"), eq(approvalEvents.subjectId, requisitionId)))
    .orderBy(desc(approvalEvents.createdAt))
    .limit(1);
  return row;
}
