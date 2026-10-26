// Scorecard rules (ats-project-scope.md I9, I10, V7, V8): pure, so every
// condition is checked without a database.
import { describe, expect, it } from "vitest";
import { canSeeOthers, feedbackSummary, writeRefusal } from "@/server/domain/scorecards";

const now = new Date("2027-01-15T12:00:00Z");
const base = {
  participant: { active: true, removed: false },
  interview: { status: "SCHEDULED", startsAtUtc: new Date("2027-01-15T10:00:00Z") },
  applicationOpen: true,
  scorecard: undefined,
  now,
};

describe("writeRefusal", () => {
  it("I9: a current participant writes once a SCHEDULED or COMPLETED interview has started", () => {
    expect(writeRefusal(base)).toBeUndefined();
    expect(writeRefusal({ ...base, interview: { ...base.interview, status: "COMPLETED" } })).toBeUndefined();
    expect(writeRefusal({ ...base, interview: { ...base.interview, startsAtUtc: now } })).toBeUndefined();
  });

  it("I9: before the start, for a cancelled or no-show interview, and for non-participants it is refused", () => {
    expect(writeRefusal({ ...base, interview: { ...base.interview, startsAtUtc: new Date("2027-01-15T12:00:01Z") } })).toBe("notStarted");
    expect(writeRefusal({ ...base, interview: { ...base.interview, status: "CANCELLED" } })).toBe("interviewClosed");
    expect(writeRefusal({ ...base, interview: { ...base.interview, status: "NO_SHOW" } })).toBe("interviewClosed");
    expect(writeRefusal({ ...base, participant: undefined })).toBe("notParticipant");
    expect(writeRefusal({ ...base, participant: { active: true, removed: true } })).toBe("notParticipant");
    expect(writeRefusal({ ...base, participant: { active: false, removed: false } })).toBe("notParticipant");
  });

  it("V8: a closed application and a submitted scorecard are read-only", () => {
    expect(writeRefusal({ ...base, applicationOpen: false })).toBe("applicationClosed");
    expect(writeRefusal({ ...base, scorecard: { submittedAt: now } })).toBe("submitted");
    expect(writeRefusal({ ...base, scorecard: { submittedAt: null } })).toBeUndefined();
  });
});

describe("canSeeOthers", () => {
  const submitted = { submittedAt: now, reopenedAt: null };
  const draft = { submittedAt: null, reopenedAt: null };
  const reopened = { submittedAt: null, reopenedAt: now };
  const resubmitted = { submittedAt: now, reopenedAt: new Date("2027-01-14T00:00:00Z") };

  it("V7: only after one own scorecard is submitted and none is reopened-but-not-resubmitted", () => {
    expect(canSeeOthers([])).toBe(false);
    expect(canSeeOthers([draft])).toBe(false);
    expect(canSeeOthers([submitted])).toBe(true);
    expect(canSeeOthers([submitted, draft])).toBe(true);
    expect(canSeeOthers([submitted, reopened])).toBe(false);
    expect(canSeeOthers([resubmitted])).toBe(true);
  });
});

describe("feedbackSummary", () => {
  it("I10: 4, 5 up and 2 down plus a draft give 3.7, 2 up, 1 down; without the 2 it is 4.5, 2 up, 0 down", () => {
    const cards = [
      { overallRating: 4, thumbsUp: true, submittedAt: now },
      { overallRating: 5, thumbsUp: true, submittedAt: now },
      { overallRating: 2, thumbsUp: false, submittedAt: now },
      { overallRating: 1, thumbsUp: false, submittedAt: null },
    ];
    expect(feedbackSummary(cards)).toEqual({ count: 3, average: "3.7", thumbsUp: 2, thumbsDown: 1 });
    expect(feedbackSummary(cards.filter((card) => card.overallRating !== 2))).toEqual({ count: 2, average: "4.5", thumbsUp: 2, thumbsDown: 0 });
    expect(feedbackSummary([])).toEqual({ count: 0, average: null, thumbsUp: 0, thumbsDown: 0 });
  });
});
