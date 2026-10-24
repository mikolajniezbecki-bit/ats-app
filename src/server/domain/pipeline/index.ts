// The fixed application pipeline (ats-project-scope.md §5.4 R1–R3, L4,
// TO-10): which status changes are allowed and why one is refused. Pure:
// the status-change service asks it before writing anything, and the unit
// tests cover every row of the table.
import { message } from "../../messages";

export const OPEN_STATUSES = ["APPLIED", "SCREENING", "INTERVIEW", "OFFER"] as const;
export const FINAL_STATUSES = ["HIRED", "REJECTED", "WITHDRAWN"] as const;

export type OpenStatus = (typeof OPEN_STATUSES)[number];
export type FinalStatus = (typeof FINAL_STATUSES)[number];
export type PipelineStatus = OpenStatus | FinalStatus;
export type RequisitionState = "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "ON_HOLD" | "CLOSED";

export type TransitionContext = {
  requisitionState: RequisitionState;
  /** Set once the requisition was first approved; a PENDING_APPROVAL requisition with it is in re-approval (TO-10). */
  requisitionApprovedAt: Date | null;
  /** An offer on the application has `candidate_response = 'ACCEPTED'` (R2). */
  hasAcceptedOffer: boolean;
  comment?: string | null;
};

export type TransitionRefusal =
  | "sameStatus"
  | "hiredFinal"
  | "requisitionClosed"
  | "hireNeedsAcceptedOffer"
  | "hireOnlyFromOffer"
  | "reopenNeedsComment"
  | "reopenRequisitionNotApproved"
  | "notAllowed";

export type TransitionCheck = { ok: true; isReopen: boolean } | { ok: false; reason: TransitionRefusal; message: string };

export function isOpenStatus(status: string): status is OpenStatus {
  return (OPEN_STATUSES as readonly string[]).includes(status);
}

function refuse(reason: TransitionRefusal): TransitionCheck {
  return { ok: false, reason, message: message(`Pipeline.errors.${reason}`) };
}

/**
 * R1: open ↔ open in any order, unless the requisition is CLOSED (ON_HOLD
 * and re-approval allow it). R2: open → REJECTED/WITHDRAWN always; HIRED
 * only from OFFER with an accepted offer. R3: REJECTED/WITHDRAWN → open
 * with a comment, while the requisition is APPROVED or in re-approval.
 * Everything else is refused (scope §5.4 after R3; R4's Admin correction is
 * task 38).
 */
export function checkTransition(from: PipelineStatus, to: PipelineStatus, ctx: TransitionContext): TransitionCheck {
  if (from === to) return refuse("sameStatus");
  if (from === "HIRED") return refuse("hiredFinal");

  if (isOpenStatus(from)) {
    if (isOpenStatus(to)) return ctx.requisitionState === "CLOSED" ? refuse("requisitionClosed") : { ok: true, isReopen: false };
    if (to !== "HIRED") return { ok: true, isReopen: false };
    if (from !== "OFFER") return refuse("hireOnlyFromOffer");
    return ctx.hasAcceptedOffer ? { ok: true, isReopen: false } : refuse("hireNeedsAcceptedOffer");
  }

  // from is REJECTED or WITHDRAWN.
  if (!isOpenStatus(to)) return refuse("notAllowed");
  if (!ctx.comment?.trim()) return refuse("reopenNeedsComment");
  const reApproval = ctx.requisitionState === "PENDING_APPROVAL" && ctx.requisitionApprovedAt !== null;
  if (ctx.requisitionState !== "APPROVED" && !reApproval) return refuse("reopenRequisitionNotApproved");
  return { ok: true, isReopen: true };
}
