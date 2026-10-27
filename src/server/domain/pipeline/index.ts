// The fixed application pipeline (ats-project-scope.md §5.4 R1–R5, L4, L8,
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
  /** Applications of the requisition already HIRED, and its openings (R5). */
  hiredCount: number;
  openingsCount: number;
  /** The actor has `application.correctHired` (R4, Admin). */
  canCorrectHired?: boolean;
  comment?: string | null;
};

export type TransitionRefusal =
  | "sameStatus"
  | "hiredFinal"
  | "requisitionClosed"
  | "hireNeedsAcceptedOffer"
  | "hireOnlyFromOffer"
  | "noOpeningsLeft"
  | "hireBlocked"
  | "correctHiredForbidden"
  | "correctionNeedsComment"
  | "correctionRequisitionClosed"
  | "reopenNeedsComment"
  | "reopenRequisitionNotApproved"
  | "notAllowed";

/** `isCorrection`: an R4 Admin correction of HIRED (clears `hired_at` and `exported_at`). */
export type TransitionCheck = { ok: true; isReopen: boolean; isCorrection?: true } | { ok: false; reason: TransitionRefusal; message: string };

/** The R4 correction targets of a HIRED application. */
export const CORRECTION_TARGETS: readonly PipelineStatus[] = ["OFFER", "REJECTED", "WITHDRAWN"];

export function isOpenStatus(status: string): status is OpenStatus {
  return (OPEN_STATUSES as readonly string[]).includes(status);
}

function refuse(reason: TransitionRefusal): TransitionCheck {
  return { ok: false, reason, message: message(`Pipeline.errors.${reason}`) };
}

/**
 * R1: open ↔ open in any order, unless the requisition is CLOSED (ON_HOLD
 * and re-approval allow it). R2: open → REJECTED/WITHDRAWN always; HIRED
 * only from OFFER with an accepted offer, and (R5, L8) only while the
 * requisition is APPROVED with an opening left. R3: REJECTED/WITHDRAWN →
 * open with a comment, while the requisition is APPROVED or in re-approval.
 * R4: HIRED → OFFER/REJECTED/WITHDRAWN for an Admin with a comment; to OFFER
 * not while the requisition is CLOSED (task 38 Q1). Everything else is
 * refused (scope §5.4 after R3).
 */
export function checkTransition(from: PipelineStatus, to: PipelineStatus, ctx: TransitionContext): TransitionCheck {
  if (from === to) return refuse("sameStatus");
  if (from === "HIRED") {
    if (!CORRECTION_TARGETS.includes(to)) return refuse("hiredFinal");
    if (!ctx.canCorrectHired) return refuse("correctHiredForbidden");
    if (!ctx.comment?.trim()) return refuse("correctionNeedsComment");
    if (to === "OFFER" && ctx.requisitionState === "CLOSED") return refuse("correctionRequisitionClosed");
    return { ok: true, isReopen: false, isCorrection: true };
  }

  if (isOpenStatus(from)) {
    if (isOpenStatus(to)) return ctx.requisitionState === "CLOSED" ? refuse("requisitionClosed") : { ok: true, isReopen: false };
    if (to !== "HIRED") return { ok: true, isReopen: false };
    if (from !== "OFFER") return refuse("hireOnlyFromOffer");
    if (!ctx.hasAcceptedOffer) return refuse("hireNeedsAcceptedOffer");
    if (ctx.requisitionState === "CLOSED") return refuse("requisitionClosed");
    if (ctx.requisitionState !== "APPROVED") return refuse("hireBlocked");
    if (ctx.hiredCount >= ctx.openingsCount) return refuse("noOpeningsLeft");
    return { ok: true, isReopen: false };
  }

  // from is REJECTED or WITHDRAWN.
  if (!isOpenStatus(to)) return refuse("notAllowed");
  if (!ctx.comment?.trim()) return refuse("reopenNeedsComment");
  const reApproval = ctx.requisitionState === "PENDING_APPROVAL" && ctx.requisitionApprovedAt !== null;
  if (ctx.requisitionState !== "APPROVED" && !reApproval) return refuse("reopenRequisitionNotApproved");
  return { ok: true, isReopen: true };
}
