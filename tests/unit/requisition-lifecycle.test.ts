// Requisition lifecycle rules (ats-project-scope.md §5.2 L1, L4–L7, L9).
import { describe, expect, it } from "vitest";
import { addPausedDays, allowedLifecycleActions, allowsFreeEdits, pausedDaysBetween } from "@/server/domain/requisitions/lifecycle";

const at = (iso: string) => new Date(iso);
const HOUR = 3_600_000;

describe("paused days", () => {
  it("L5: rounds each period half up to 2 decimals from the exact duration", () => {
    const start = at("2027-01-10T00:00:00Z");
    expect(pausedDaysBetween(start, new Date(start.getTime() + 60 * HOUR))).toBe(2.5);
    // 3 hours = 0.125 days → 0.13 (half up).
    expect(pausedDaysBetween(start, new Date(start.getTime() + 3 * HOUR))).toBe(0.13);
    // 1 minute = 0.000694… days → 0.00.
    expect(pausedDaysBetween(start, new Date(start.getTime() + 60_000))).toBe(0);
    // A clock that went backwards never subtracts.
    expect(pausedDaysBetween(start, new Date(start.getTime() - HOUR))).toBe(0);
  });

  it("L5: adds the period to the stored value without floating-point drift", () => {
    const start = at("2027-01-10T00:00:00Z");
    expect(addPausedDays("1.25", start, new Date(start.getTime() + 60 * HOUR))).toBe("3.75");
    expect(addPausedDays("0.10", start, new Date(start.getTime() + 0.2 * 24 * HOUR))).toBe("0.30");
    expect(addPausedDays(0, start, start)).toBe("0.00");
  });
});

describe("allowed actions", () => {
  it("L4, L6, L9: APPROVED allows hold, close and the publishing toggle towards the other value", () => {
    expect(allowedLifecycleActions({ state: "APPROVED", isPublished: true })).toEqual(["hold", "close", "unpublish"]);
    expect(allowedLifecycleActions({ state: "APPROVED", isPublished: false })).toEqual(["hold", "close", "republish"]);
  });

  it("L5, L6, L7: ON_HOLD allows resume and close; CLOSED only reopen; other states nothing", () => {
    expect(allowedLifecycleActions({ state: "ON_HOLD", isPublished: false })).toEqual(["resume", "close"]);
    expect(allowedLifecycleActions({ state: "CLOSED", isPublished: false })).toEqual(["reopen"]);
    expect(allowedLifecycleActions({ state: "PENDING_APPROVAL", isPublished: true })).toEqual([]);
    expect(allowedLifecycleActions({ state: "DRAFT", isPublished: false })).toEqual([]);
  });

  it("L1: free edits while APPROVED, ON_HOLD or in re-approval, not in first approval or CLOSED", () => {
    const approvedAt = at("2027-01-01T00:00:00Z");
    expect(allowsFreeEdits({ state: "APPROVED", approvedAt })).toBe(true);
    expect(allowsFreeEdits({ state: "ON_HOLD", approvedAt })).toBe(true);
    expect(allowsFreeEdits({ state: "PENDING_APPROVAL", approvedAt })).toBe(true);
    expect(allowsFreeEdits({ state: "PENDING_APPROVAL", approvedAt: null })).toBe(false);
    expect(allowsFreeEdits({ state: "CLOSED", approvedAt })).toBe(false);
    expect(allowsFreeEdits({ state: "DRAFT", approvedAt: null })).toBe(false);
  });
});
