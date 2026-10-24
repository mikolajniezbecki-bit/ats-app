// Requisition lifecycle after approval (ats-project-scope.md §5.2 L4–L7,
// L9, L11; tech-stack.md D3, D7): hold, resume, close, reopen and the
// publishing toggles. Each action locks the requisition row FOR UPDATE and
// checks the version and the state before writing anything, and writes its
// history in the same transaction. Status changes lock the row FOR SHARE
// (#32), so they wait for a close. Logs carry IDs and counts only (M2).
import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { type Db, type Tx, getDb } from "../db";
import { updateWithVersion } from "../db/optimistic-lock";
import { applications, offers, requisitionHistory, requisitions } from "../db/schema";
import { OPEN_STATUSES } from "../domain/pipeline";
import { type LifecycleAction, addPausedDays, allowedLifecycleActions } from "../domain/requisitions/lifecycle";
import { logger } from "../logger";
import { applyStatusChange } from "../pipeline";
import { scopeRequisitionsFor } from "../policy/filters";
import { type Action, type PolicyUser, can } from "../policy/permissions";
import type { RequisitionRow } from ".";

const MAX_COMMENT = 2_000;

export type LifecycleResult =
  | { ok: true; requisition: RequisitionRow }
  | { ok: false; reason: "invalid"; fields: Record<string, string> }
  | {
      ok: false;
      reason:
        | "notFound"
        | "forbidden"
        | "stale"
        | "holdNotAllowed"
        | "resumeNotAllowed"
        | "closeNotAllowed"
        | "reopenNotAllowed"
        | "publishNotAllowed"
        | "alreadyPublished"
        | "alreadyUnpublished";
    };

/** Who may take each action (§3): reopen is Admin only (L7), publishing toggles need requisition.publish (L9). */
const PERMISSION: Record<LifecycleAction, Action> = {
  hold: "requisition.manage",
  resume: "requisition.manage",
  close: "requisition.manage",
  reopen: "requisition.reopen",
  unpublish: "requisition.publish",
  republish: "requisition.publish",
};

/** Close and reopen need a comment (L6, L7); hold and resume take an optional one (Q5); publishing takes none. */
const COMMENT_REQUIRED: ReadonlySet<LifecycleAction> = new Set(["close", "reopen"]);

const inputSchema = z.object({ version: z.number().int().min(1), comment: z.string().trim().max(MAX_COMMENT).optional() }).strict();
const publishSchema = z.object({ version: z.number().int().min(1) }).strict();

/** The 409 reason when `action` isn't allowed in the requisition's current state. */
function notAllowed(action: LifecycleAction, requisition: RequisitionRow): LifecycleResult {
  switch (action) {
    case "hold":
      return { ok: false, reason: "holdNotAllowed" };
    case "resume":
      return { ok: false, reason: "resumeNotAllowed" };
    case "close":
      return { ok: false, reason: "closeNotAllowed" };
    case "reopen":
      return { ok: false, reason: "reopenNotAllowed" };
    default:
      if (requisition.state !== "APPROVED") return { ok: false, reason: "publishNotAllowed" };
      return { ok: false, reason: action === "unpublish" ? "alreadyUnpublished" : "alreadyPublished" };
  }
}

type HistoryRow = typeof requisitionHistory.$inferInsert;

function historyRow(requisitionId: string, userId: string, comment: string | null, row: Pick<HistoryRow, "event" | "field" | "oldValue" | "newValue">): HistoryRow {
  return { requisitionId, userId, comment, ...row };
}

/**
 * L6: the close steps, for a requisition row the caller locked FOR UPDATE
 * and checked: add any hold time, reject every open application through the
 * status service's writing step (as `actor`, no history comment, the
 * system reason code), withdraw offers still waiting for the candidate,
 * and close and unpublish. Task 30 (lowering openings) and task 38 (R6)
 * call it with FILLED. `applyChange` is the status step; tests pass a
 * wrapper that fails on purpose.
 */
export async function closeRequisition(
  tx: Tx,
  input: { requisition: RequisitionRow; reason: "CANCELLED" | "FILLED"; actor: { id: string }; comment: string | null },
  deps: { applyChange?: typeof applyStatusChange } = {},
): Promise<{ requisition: RequisitionRow; rejected: number; withdrawn: number }> {
  const applyChange = deps.applyChange ?? applyStatusChange;
  const { requisition, actor, comment } = input;
  const now = new Date();

  // Anonymized applications are never open (RT2) and are skipped anyway (RT3).
  const open = await tx
    .select()
    .from(applications)
    .where(and(eq(applications.requisitionId, requisition.id), inArray(applications.status, [...OPEN_STATUSES]), isNull(applications.anonymizedAt)))
    .orderBy(asc(applications.appliedAt), asc(applications.id))
    .for("update");
  const reasonCode = input.reason === "FILLED" ? "REQ_FILLED" : "REQ_CANCELLED";
  for (const application of open) await applyChange(tx, application, "REJECTED", { actor, comment: null, reasonCode, isReopen: false });

  // Q3: offers still waiting for the candidate's answer; accepted and declined offers keep their record.
  const withdrawn = await tx
    .update(offers)
    .set({ approvalStatus: "WITHDRAWN", updatedAt: now })
    .where(
      and(
        inArray(
          offers.applicationId,
          tx.select({ id: applications.id }).from(applications).where(eq(applications.requisitionId, requisition.id)),
        ),
        eq(offers.candidateResponse, "PENDING"),
        ne(offers.approvalStatus, "WITHDRAWN"),
      ),
    )
    .returning({ id: offers.id });

  const updated = await updateWithVersion(tx, requisitions, requisition.id, requisition.version, {
    state: "CLOSED",
    closeReason: input.reason,
    closedAt: now,
    isPublished: false,
    ...(requisition.state === "ON_HOLD" && requisition.onHoldSince
      ? { pausedDays: addPausedDays(requisition.pausedDays, requisition.onHoldSince, now), onHoldSince: null }
      : {}),
  });
  await tx.insert(requisitionHistory).values([
    historyRow(requisition.id, actor.id, comment, { event: "STATE_CHANGE", field: "state", oldValue: requisition.state, newValue: "CLOSED" }),
    historyRow(requisition.id, actor.id, comment, { event: "FIELD_CHANGE", field: "close_reason", oldValue: null, newValue: input.reason }),
  ]);
  logger.info(
    { requisition_id: requisition.id, user_id: actor.id, close_reason: input.reason, rejected: open.length, withdrawn_offers: withdrawn.length },
    "requisition closed",
  );
  return { requisition: updated, rejected: open.length, withdrawn: withdrawn.length };
}

/**
 * Runs one lifecycle action for `user` at the version they saw (D7):
 * hold (L4), resume (L5), close (L6), reopen (L7), unpublish/republish (L9).
 */
export async function runLifecycleAction(
  tx: Tx,
  user: PolicyUser,
  id: string,
  action: LifecycleAction,
  input: unknown,
  deps: { applyChange?: typeof applyStatusChange } = {},
): Promise<LifecycleResult> {
  if (!z.uuid().safeParse(id).success) return { ok: false, reason: "notFound" };
  const [requisition] = await tx
    .select()
    .from(requisitions)
    .where(and(scopeRequisitionsFor(user), eq(requisitions.id, id)))
    .for("update");
  if (!requisition) return { ok: false, reason: "notFound" };
  if (!can(user, PERMISSION[action])) return { ok: false, reason: "forbidden" };

  const publishing = action === "unpublish" || action === "republish";
  const parsed = (publishing ? publishSchema : inputSchema).safeParse(input);
  if (!parsed.success) {
    const tooLong = parsed.error.issues.some((issue) => issue.path[0] === "comment");
    return { ok: false, reason: "invalid", fields: { [tooLong ? "comment" : "version"]: tooLong ? "commentTooLong" : "invalid" } };
  }
  const comment = (parsed.data as { comment?: string }).comment || null;
  if (COMMENT_REQUIRED.has(action) && !comment) return { ok: false, reason: "invalid", fields: { comment: action === "close" ? "closeCommentRequired" : "reopenCommentRequired" } };
  if (requisition.version !== parsed.data.version) return { ok: false, reason: "stale" };
  if (!allowedLifecycleActions(requisition).includes(action)) return notAllowed(action, requisition);

  const now = new Date();
  const state = (to: RequisitionRow["state"], event: "STATE_CHANGE" | "REOPEN" = "STATE_CHANGE") =>
    historyRow(id, user.id, comment, { event, field: "state", oldValue: requisition.state, newValue: to });
  let updated: RequisitionRow;
  let history: HistoryRow[];
  switch (action) {
    case "hold":
      updated = await updateWithVersion(tx, requisitions, id, requisition.version, { state: "ON_HOLD", isPublished: false, onHoldSince: now });
      history = [state("ON_HOLD")];
      break;
    case "resume":
      // L5 as written: resume publishes, even after a manual unpublish (Q8).
      updated = await updateWithVersion(tx, requisitions, id, requisition.version, {
        state: "APPROVED",
        isPublished: true,
        onHoldSince: null,
        pausedDays: requisition.onHoldSince ? addPausedDays(requisition.pausedDays, requisition.onHoldSince, now) : requisition.pausedDays,
      });
      history = [state("APPROVED")];
      break;
    case "close":
      return { ok: true, requisition: (await closeRequisition(tx, { requisition, reason: "CANCELLED", actor: user, comment }, deps)).requisition };
    case "reopen":
      // L7: rejected applications and withdrawn offers stay as they are.
      updated = await updateWithVersion(tx, requisitions, id, requisition.version, {
        state: "APPROVED",
        isPublished: true,
        closedAt: null,
        closeReason: null,
        pausedDays: requisition.closedAt ? addPausedDays(requisition.pausedDays, requisition.closedAt, now) : requisition.pausedDays,
      });
      history = [
        state("APPROVED", "REOPEN"),
        historyRow(id, user.id, comment, { event: "FIELD_CHANGE", field: "close_reason", oldValue: requisition.closeReason, newValue: null }),
      ];
      break;
    case "unpublish":
    case "republish": {
      const isPublished = action === "republish";
      updated = await updateWithVersion(tx, requisitions, id, requisition.version, { isPublished });
      history = [historyRow(id, user.id, null, { event: "FIELD_CHANGE", field: "is_published", oldValue: String(!isPublished), newValue: String(isPublished) })];
      break;
    }
  }
  await tx.insert(requisitionHistory).values(history);
  logger.info({ requisition_id: id, user_id: user.id, action }, "requisition lifecycle action");
  return { ok: true, requisition: updated };
}

/** The close dialog's preview (L6): how many open applications would be rejected and offers withdrawn. */
export async function closeImpact(requisitionId: string, tx: Db | Tx = getDb()): Promise<{ applications: number; offers: number }> {
  const open = await tx
    .select({ id: applications.id })
    .from(applications)
    .where(and(eq(applications.requisitionId, requisitionId), inArray(applications.status, [...OPEN_STATUSES]), isNull(applications.anonymizedAt)));
  const pending = await tx
    .select({ id: offers.id })
    .from(offers)
    .innerJoin(applications, eq(applications.id, offers.applicationId))
    .where(and(eq(applications.requisitionId, requisitionId), eq(offers.candidateResponse, "PENDING"), ne(offers.approvalStatus, "WITHDRAWN")));
  return { applications: open.length, offers: pending.length };
}
