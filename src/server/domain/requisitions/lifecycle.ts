// Requisition lifecycle rules (ats-project-scope.md §5.2 L1, L4–L7, L9):
// paused time and which lifecycle action each state allows. Pure: the
// lifecycle service asks it before writing anything.

export type LifecycleState = "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "ON_HOLD" | "CLOSED";
export type LifecycleAction = "hold" | "resume" | "close" | "reopen" | "unpublish" | "republish";

const DAY_MS = 86_400_000;

/**
 * L5, L7: the days between `from` and `to`, rounded half up to 2 decimals
 * from the exact duration (Q6). Never negative.
 */
export function pausedDaysBetween(from: Date, to: Date): number {
  const days = Math.max(0, to.getTime() - from.getTime()) / DAY_MS;
  // Rounded in integer hundredths, with a small epsilon so 0.125 doesn't
  // round down from floating-point noise.
  return Math.floor(days * 100 + 0.5 + 1e-9) / 100;
}

/** `paused_days` (numeric(10,2), a string from the driver) plus a period, as the column's text. */
export function addPausedDays(current: string | number, from: Date, to: Date): string {
  const hundredths = Math.round(Number(current) * 100) + Math.round(pausedDaysBetween(from, to) * 100);
  return (hundredths / 100).toFixed(2);
}

/** Re-approval (TO-10): back in PENDING_APPROVAL after a first approval. */
export function isReApproval(requisition: { state: LifecycleState; approvedAt: Date | null }): boolean {
  return requisition.state === "PENDING_APPROVAL" && requisition.approvedAt !== null;
}

/** L1: free edits while APPROVED, ON_HOLD or in re-approval (DRAFT has its own rules). */
export function allowsFreeEdits(requisition: { state: LifecycleState; approvedAt: Date | null }): boolean {
  return requisition.state === "APPROVED" || requisition.state === "ON_HOLD" || isReApproval(requisition);
}

/**
 * The lifecycle actions a state allows, before role checks: hold from
 * APPROVED (L4), resume from ON_HOLD (L5), close from APPROVED or ON_HOLD
 * (L6, not in re-approval: withdraw that first, A9), reopen from CLOSED
 * (L7), and the publishing toggles only while APPROVED and only towards the
 * other value (L9, Q7).
 */
export function allowedLifecycleActions(requisition: { state: LifecycleState; isPublished: boolean }): LifecycleAction[] {
  switch (requisition.state) {
    case "APPROVED":
      return ["hold", "close", requisition.isPublished ? "unpublish" : "republish"];
    case "ON_HOLD":
      return ["resume", "close"];
    case "CLOSED":
      return ["reopen"];
    default:
      return [];
  }
}
