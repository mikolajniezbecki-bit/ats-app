// The pipeline transition table (ats-project-scope.md §5.4 R1–R5, L4, L8, TO-10).
import { describe, expect, it } from "vitest";
import {
  FINAL_STATUSES,
  OPEN_STATUSES,
  type PipelineStatus,
  type TransitionContext,
  type TransitionRefusal,
  checkTransition,
} from "@/server/domain/pipeline";
import { message } from "@/server/messages";

// One opening, none filled: the R5 counts don't refuse anything unless a test sets them.
const approved: TransitionContext = {
  requisitionState: "APPROVED",
  requisitionApprovedAt: new Date("2026-01-01"),
  hasAcceptedOffer: false,
  hiredCount: 0,
  openingsCount: 1,
};
const reApproval: TransitionContext = { ...approved, requisitionState: "PENDING_APPROVAL" };

function refusal(from: PipelineStatus, to: PipelineStatus, ctx: TransitionContext): TransitionRefusal | "ok" {
  const result = checkTransition(from, to, ctx);
  return result.ok ? "ok" : result.reason;
}

function pairs(froms: readonly PipelineStatus[], tos: readonly PipelineStatus[]) {
  return froms.flatMap((from) => tos.filter((to) => to !== from).map((to) => [from, to] as const));
}

describe("checkTransition", () => {
  it("R1: allows every open → open move, backward and skipping stages, unless the requisition is closed", () => {
    for (const [from, to] of pairs(OPEN_STATUSES, OPEN_STATUSES)) {
      expect(checkTransition(from, to, approved), `${from} → ${to}`).toEqual({ ok: true, isReopen: false });
      expect(refusal(from, to, { ...approved, requisitionState: "ON_HOLD" }), `${from} → ${to} on hold`).toBe("ok");
      expect(refusal(from, to, reApproval), `${from} → ${to} in re-approval`).toBe("ok");
      expect(refusal(from, to, { ...approved, requisitionState: "CLOSED" }), `${from} → ${to} closed`).toBe("requisitionClosed");
    }
    expect(refusal("APPLIED", "OFFER", approved)).toBe("ok");
    expect(refusal("OFFER", "SCREENING", approved)).toBe("ok");
  });

  it("R2: allows open → REJECTED and WITHDRAWN in any requisition state", () => {
    for (const from of OPEN_STATUSES) {
      for (const to of ["REJECTED", "WITHDRAWN"] as const) {
        for (const requisitionState of ["APPROVED", "ON_HOLD", "PENDING_APPROVAL", "CLOSED"] as const) {
          expect(refusal(from, to, { ...approved, requisitionState }), `${from} → ${to} (${requisitionState})`).toBe("ok");
        }
      }
    }
  });

  it("R2: hires only from OFFER with an accepted offer", () => {
    expect(refusal("OFFER", "HIRED", approved)).toBe("hireNeedsAcceptedOffer");
    expect(checkTransition("OFFER", "HIRED", { ...approved, hasAcceptedOffer: true })).toEqual({ ok: true, isReopen: false });
    for (const from of ["APPLIED", "SCREENING", "INTERVIEW"] as const) {
      expect(refusal(from, "HIRED", { ...approved, hasAcceptedOffer: true }), from).toBe("hireOnlyFromOffer");
      expect(refusal(from, "HIRED", approved), from).toBe("hireOnlyFromOffer");
    }
  });

  it("R2: a hired application can't be changed, and final → final moves are refused", () => {
    // R4's targets (OFFER, REJECTED, WITHDRAWN) are refused without the Admin permission, see the R4 tests.
    for (const to of ["APPLIED", "SCREENING", "INTERVIEW"] as const) {
      expect(refusal("HIRED", to, { ...approved, hasAcceptedOffer: true, comment: "Fix" }), to).toBe("hiredFinal");
      expect(refusal("HIRED", to, { ...approved, hasAcceptedOffer: true, comment: "Fix", canCorrectHired: true }), `${to} (Admin)`).toBe("hiredFinal");
    }
    for (const [from, to] of [
      ["REJECTED", "WITHDRAWN"],
      ["WITHDRAWN", "REJECTED"],
      ["REJECTED", "HIRED"],
      ["WITHDRAWN", "HIRED"],
    ] as const) {
      expect(refusal(from, to, { ...approved, hasAcceptedOffer: true, comment: "Reason" }), `${from} → ${to}`).toBe("notAllowed");
    }
  });

  it("R2: a move to the same status is refused", () => {
    for (const status of [...OPEN_STATUSES, ...FINAL_STATUSES]) {
      expect(refusal(status, status, { ...approved, comment: "Again" }), status).toBe("sameStatus");
    }
  });

  it("R3: reopens REJECTED and WITHDRAWN to any open status with a comment while the requisition is approved", () => {
    for (const from of ["REJECTED", "WITHDRAWN"] as const) {
      for (const to of OPEN_STATUSES) {
        expect(checkTransition(from, to, { ...approved, comment: "Second look" }), `${from} → ${to}`).toEqual({ ok: true, isReopen: true });
      }
    }
  });

  it("R3: a reopen without a comment, or with only spaces, is refused", () => {
    expect(refusal("REJECTED", "SCREENING", approved)).toBe("reopenNeedsComment");
    expect(refusal("REJECTED", "SCREENING", { ...approved, comment: "" })).toBe("reopenNeedsComment");
    expect(refusal("WITHDRAWN", "APPLIED", { ...approved, comment: "   " })).toBe("reopenNeedsComment");
    expect(refusal("WITHDRAWN", "APPLIED", { ...approved, comment: null })).toBe("reopenNeedsComment");
  });

  it("R3: a reopen is refused while the requisition is on hold, closed or a draft, and allowed in re-approval", () => {
    const comment = "Second look";
    expect(refusal("REJECTED", "INTERVIEW", { ...approved, requisitionState: "ON_HOLD", comment })).toBe("reopenRequisitionNotApproved");
    expect(refusal("REJECTED", "INTERVIEW", { ...approved, requisitionState: "CLOSED", comment })).toBe("reopenRequisitionNotApproved");
    expect(refusal("WITHDRAWN", "INTERVIEW", { ...approved, requisitionState: "DRAFT", requisitionApprovedAt: null, comment })).toBe(
      "reopenRequisitionNotApproved",
    );
    // First approval (never approved) isn't re-approval.
    expect(refusal("REJECTED", "INTERVIEW", { ...reApproval, requisitionApprovedAt: null, comment })).toBe("reopenRequisitionNotApproved");
    expect(checkTransition("REJECTED", "INTERVIEW", { ...reApproval, comment })).toEqual({ ok: true, isReopen: true });
  });

  it("R5, L8: a hire needs an opening left and an APPROVED requisition", () => {
    const accepted = { ...approved, hasAcceptedOffer: true, openingsCount: 2 };
    expect(checkTransition("OFFER", "HIRED", { ...accepted, hiredCount: 1 })).toEqual({ ok: true, isReopen: false });
    expect(refusal("OFFER", "HIRED", { ...accepted, hiredCount: 2 })).toBe("noOpeningsLeft");
    expect(refusal("OFFER", "HIRED", { ...accepted, hiredCount: 3 })).toBe("noOpeningsLeft");
    expect(refusal("OFFER", "HIRED", { ...accepted, requisitionState: "ON_HOLD" })).toBe("hireBlocked");
    expect(refusal("OFFER", "HIRED", { ...accepted, requisitionState: "PENDING_APPROVAL" })).toBe("hireBlocked");
    expect(refusal("OFFER", "HIRED", { ...accepted, requisitionState: "CLOSED" })).toBe("requisitionClosed");
    // R2 is checked first: without an accepted offer the answer is always R2's.
    expect(refusal("OFFER", "HIRED", { ...approved, requisitionState: "ON_HOLD", hiredCount: 1 })).toBe("hireNeedsAcceptedOffer");
  });

  it("R4: an Admin corrects HIRED to OFFER, REJECTED or WITHDRAWN with a comment", () => {
    const admin = { ...approved, hasAcceptedOffer: true, canCorrectHired: true, comment: "Hired by mistake" };
    for (const to of ["OFFER", "REJECTED", "WITHDRAWN"] as const) {
      expect(checkTransition("HIRED", to, admin), to).toEqual({ ok: true, isReopen: false, isCorrection: true });
      expect(refusal("HIRED", to, { ...admin, canCorrectHired: false }), `${to} (Recruiter)`).toBe("correctHiredForbidden");
      expect(refusal("HIRED", to, { ...admin, canCorrectHired: undefined }), `${to} (no permission given)`).toBe("correctHiredForbidden");
      expect(refusal("HIRED", to, { ...admin, comment: "  " }), `${to} without a comment`).toBe("correctionNeedsComment");
    }
  });

  it("R4, task 38 Q1: corrections to REJECTED and WITHDRAWN work in any requisition state; to OFFER not while CLOSED", () => {
    const admin = { ...approved, canCorrectHired: true, comment: "Fix" };
    for (const requisitionState of ["APPROVED", "ON_HOLD", "PENDING_APPROVAL", "CLOSED"] as const) {
      expect(refusal("HIRED", "REJECTED", { ...admin, requisitionState }), requisitionState).toBe("ok");
      expect(refusal("HIRED", "WITHDRAWN", { ...admin, requisitionState }), requisitionState).toBe("ok");
    }
    expect(refusal("HIRED", "OFFER", { ...admin, requisitionState: "CLOSED" })).toBe("correctionRequisitionClosed");
    expect(refusal("HIRED", "OFFER", { ...admin, requisitionState: "ON_HOLD" })).toBe("ok");
  });

  it("returns each refusal with its text from messages/en.json", () => {
    const result = checkTransition("REJECTED", "SCREENING", approved);
    expect(result).toEqual({ ok: false, reason: "reopenNeedsComment", message: "Reopening needs a comment." });
    for (const reason of [
      "sameStatus",
      "hiredFinal",
      "requisitionClosed",
      "hireNeedsAcceptedOffer",
      "hireOnlyFromOffer",
      "reopenRequisitionNotApproved",
      "notAllowed",
      "noOpeningsLeft",
      "hireBlocked",
      "correctHiredForbidden",
      "correctionNeedsComment",
      "correctionRequisitionClosed",
    ] as const) {
      expect(message(`Pipeline.errors.${reason}`)).toBeTruthy();
    }
    expect(checkTransition("OFFER", "HIRED", approved)).toMatchObject({ message: "Hiring needs an accepted offer." });
    expect(checkTransition("HIRED", "SCREENING", approved)).toMatchObject({ message: "A hired application can't be changed." });
    expect(checkTransition("HIRED", "OFFER", approved)).toMatchObject({ message: "Only an Admin can correct a hired status." });
    expect(checkTransition("OFFER", "HIRED", { ...approved, hasAcceptedOffer: true, hiredCount: 1 })).toMatchObject({ message: "No openings left on this requisition." });
    expect(checkTransition("OFFER", "HIRED", { ...approved, hasAcceptedOffer: true, requisitionState: "ON_HOLD" })).toMatchObject({
      message: "Hiring isn't possible while the requisition is on hold or awaiting approval.",
    });
  });
});
