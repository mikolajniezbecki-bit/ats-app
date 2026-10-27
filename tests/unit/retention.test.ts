// The retention rule (ats-project-scope.md §5.8 RT2): which applications the
// purge anonymizes, at a fixed `now`.
import { describe, expect, it } from "vitest";
import { isDueForPurge, retentionCutoff } from "@/server/domain/retention";

const DAY = 86_400_000;
const now = new Date("2031-03-01T02:00:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * DAY);
const app = (overrides: Partial<Parameters<typeof isDueForPurge>[0]> = {}) => ({
  status: "REJECTED",
  anonymizedAt: null,
  exportedAt: null,
  dispositionedAt: daysAgo(31),
  ...overrides,
});

describe("isDueForPurge", () => {
  it("RT2: final applications past the period are due; exactly at the limit or inside it they aren't (strict <)", () => {
    expect(retentionCutoff(now, 30)).toEqual(daysAgo(30));
    for (const status of ["REJECTED", "WITHDRAWN"]) {
      expect(isDueForPurge(app({ status }), now, 30), status).toBe(true);
      expect(isDueForPurge(app({ status, dispositionedAt: daysAgo(30) }), now, 30), `${status} at the limit`).toBe(false);
      expect(isDueForPurge(app({ status, dispositionedAt: daysAgo(29) }), now, 30), `${status} inside`).toBe(false);
    }
    expect(isDueForPurge(app({ dispositionedAt: new Date(daysAgo(30).getTime() - 1) }), now, 30)).toBe(true);
  });

  it("RT2: hires are due only once exported", () => {
    expect(isDueForPurge(app({ status: "HIRED" }), now, 30)).toBe(false);
    expect(isDueForPurge(app({ status: "HIRED", exportedAt: daysAgo(20) }), now, 30)).toBe(true);
  });

  it("RT1: open applications, reopened ones (no dispositioned_at) and anonymized ones are never due", () => {
    for (const status of ["APPLIED", "SCREENING", "INTERVIEW", "OFFER"]) expect(isDueForPurge(app({ status }), now, 30), status).toBe(false);
    expect(isDueForPurge(app({ dispositionedAt: null }), now, 30)).toBe(false);
    expect(isDueForPurge(app({ anonymizedAt: daysAgo(1) }), now, 30)).toBe(false);
  });
});
