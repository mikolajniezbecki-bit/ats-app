// Recruiting KPIs (ats-project-scope.md §5.9, L10; task 41 Q2) and the
// report CSV row mappers (V10, Q3), without a database.
import { describe, expect, it } from "vitest";
import { type ReportRequisition, ageOfRequisition, average, formatDays, isOpenRequisition, timeToFill, timeToHire } from "@/server/domain/reporting";
import { addPausedDays } from "@/server/domain/requisitions/lifecycle";
import { PIPELINE_COLUMNS, REQUISITION_COLUMNS, pipelineCsvRow, requisitionCsvRow } from "@/server/exports/reports";
import { csvCell } from "@/server/exports/csv";

const DAY = 86_400_000;
const now = new Date("2031-03-10T12:00:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * DAY);
const req = (overrides: Partial<ReportRequisition> = {}): ReportRequisition => ({
  state: "APPROVED",
  approvedAt: daysAgo(20),
  closedAt: null,
  closeReason: null,
  pausedDays: "0.00",
  onHoldSince: null,
  ...overrides,
});

describe("L10 KPIs", () => {
  it("L10: Time to Fill subtracts paused_days from approved → closed, only for FILLED", () => {
    const filled = req({ state: "CLOSED", approvedAt: daysAgo(10), closedAt: now, closeReason: "FILLED", pausedDays: "2.50" });
    expect(timeToFill(filled)).toBeCloseTo(7.5, 10);
    expect(formatDays(timeToFill(filled))).toBe("7.5");
    expect(timeToFill({ ...filled, closeReason: "CANCELLED" })).toBeNull();
    expect(timeToFill(req())).toBeNull();
  });

  it("L10: filled, reopened (L7 adds the closed time) and filled again uses the latest closed_at and the total paused_days", () => {
    const approvedAt = daysAgo(30);
    const firstClose = daysAgo(20);
    const reopenedAt = daysAgo(15);
    const pausedDays = addPausedDays("1.00", firstClose, reopenedAt);
    expect(pausedDays).toBe("6.00");
    const refilled = req({ state: "CLOSED", approvedAt, closedAt: now, closeReason: "FILLED", pausedDays });
    expect(timeToFill(refilled)).toBeCloseTo(24, 10);
  });

  it("L10: Age subtracts paused_days and the current hold; resume keeps the age the same at that moment", () => {
    const onHold = req({ state: "ON_HOLD", approvedAt: daysAgo(20), pausedDays: "3.00", onHoldSince: daysAgo(4) });
    expect(ageOfRequisition(onHold, now)).toBeCloseTo(13, 10);
    expect(formatDays(ageOfRequisition(onHold, now))).toBe("13.0");
    const resumed = req({ state: "APPROVED", approvedAt: daysAgo(20), pausedDays: addPausedDays("3.00", daysAgo(4), now), onHoldSince: null });
    expect(ageOfRequisition(resumed, now)).toBeCloseTo(13, 10);
  });

  it("L10: re-approval doesn't pause the clock; drafts, first approvals and closed requisitions have no age", () => {
    expect(ageOfRequisition(req({ state: "PENDING_APPROVAL", approvedAt: daysAgo(30) }), now)).toBeCloseTo(30, 10);
    expect(isOpenRequisition({ state: "PENDING_APPROVAL", approvedAt: null })).toBe(false);
    expect(ageOfRequisition(req({ state: "DRAFT", approvedAt: null }), now)).toBeNull();
    expect(ageOfRequisition(req({ state: "CLOSED", closedAt: now, closeReason: "CANCELLED" }), now)).toBeNull();
  });

  it("L10: Time to Hire is hired_at − applied_at for HIRED; empty input averages to null, shown as —", () => {
    expect(timeToHire({ status: "HIRED", appliedAt: daysAgo(30), hiredAt: daysAgo(10) })).toBeCloseTo(20, 10);
    expect(timeToHire({ status: "WITHDRAWN", appliedAt: daysAgo(30), hiredAt: null })).toBeNull();
    expect(average([])).toEqual({ average: null, count: 0 });
    expect(average([null, 2, 4])).toEqual({ average: 3, count: 2 });
    expect(formatDays(null)).toBe("—");
    expect(formatDays(13.75)).toBe("13.8");
    expect(formatDays(0.05)).toBe("0.1");
  });
});

describe("report CSV rows", () => {
  const base = {
    ...req({ state: "CLOSED", approvedAt: new Date("2031-01-01T10:00:00Z"), closedAt: new Date("2031-01-11T10:00:00Z"), closeReason: "FILLED", pausedDays: "2.50" }),
    reqNumber: "REQ-00042",
    title: "=Backend Engineer",
    department: "Engineering",
    location: "Warsaw, Poland",
    legalEntity: "Demo",
    hiringManager: "Hanna Manager",
    recruiter: "Rita Recruiter",
    postingType: "EXTERNAL",
    isPublished: false,
    openingsCount: 2,
    hired: 2,
    openApplications: 0,
  };

  it("maps a requisition to its 19 columns; Time to fill only for FILLED, Age only for open; a title with = is prefixed", () => {
    const row = requisitionCsvRow(base, now);
    expect(row).toHaveLength(REQUISITION_COLUMNS.length);
    expect(row).toEqual(["REQ-00042", "=Backend Engineer", "CLOSED", "FILLED", "Engineering", "Warsaw, Poland", "Demo", "Hanna Manager", "Rita Recruiter", "EXTERNAL", "false", "2", "2", "0", "2031-01-01", "2031-01-11", "2.50", "7.5", null]);
    expect(csvCell(row[1])).toBe("'=Backend Engineer");
    const open = requisitionCsvRow({ ...base, state: "APPROVED", closedAt: null, closeReason: null, pausedDays: "0.00", approvedAt: daysAgo(20) }, now);
    expect(open.slice(-2)).toEqual([null, "20.0"]);
  });

  it("maps an application to its 12 columns without contact data; anonymized rows say so", () => {
    const row = pipelineCsvRow({
      id: "8f1d",
      reqNumber: "REQ-00042",
      title: "Backend Engineer",
      status: "REJECTED",
      reasonCode: "REQ_FILLED",
      source: "CAREER_SITE",
      prescreenScore: 7,
      isDisqualified: false,
      appliedAt: new Date("2031-01-02T23:30:00Z"),
      dispositionedAt: new Date("2031-01-11T10:00:00Z"),
      hiredAt: null,
      anonymizedAt: new Date("2031-03-01T02:00:00Z"),
    });
    expect(row).toHaveLength(PIPELINE_COLUMNS.length);
    // 23:30 UTC is already the next day in Warsaw.
    expect(row).toEqual(["8f1d", "REQ-00042", "Backend Engineer", "REJECTED", "REQ_FILLED", "CAREER_SITE", "7", "false", "2031-01-03", "2031-01-11", null, "true"]);
    expect(PIPELINE_COLUMNS.map((column) => column.header)).not.toEqual(expect.arrayContaining(["Email"]));
  });
});
