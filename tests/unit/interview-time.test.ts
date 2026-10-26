// Interview times (ats-project-scope.md I1, I6, I7; Q3): local time in an
// IANA zone to UTC, daylight-saving gaps and repeated hours.
import { describe, expect, it } from "vitest";
import { awaitingOutcome, isValidTimeZone, localToUtc, participantChanges, timingChanged, utcToLocal } from "@/server/domain/interviews";

const utc = (local: string, zone: string) => {
  const result = localToUtc(local, zone);
  return result.ok ? result.instant.toISOString() : result.reason;
};

describe("localToUtc", () => {
  it("I1: 10:00 in Europe/Warsaw is 09:00Z in winter and 08:00Z in summer", () => {
    expect(utc("2027-01-15T10:00", "Europe/Warsaw")).toBe("2027-01-15T09:00:00.000Z");
    expect(utc("2027-07-15T10:00", "Europe/Warsaw")).toBe("2027-07-15T08:00:00.000Z");
  });

  it("I6: 14:00 in America/New_York is 19:00Z in winter", () => {
    expect(utc("2027-01-15T14:00", "America/New_York")).toBe("2027-01-15T19:00:00.000Z");
  });

  it("I1: a time in the spring gap doesn't exist; the times around it do", () => {
    expect(utc("2027-03-28T02:30", "Europe/Warsaw")).toBe("nonexistent");
    expect(utc("2027-03-28T01:59", "Europe/Warsaw")).toBe("2027-03-28T00:59:00.000Z");
    expect(utc("2027-03-28T03:00", "Europe/Warsaw")).toBe("2027-03-28T01:00:00.000Z");
  });

  it("I1: an ambiguous autumn time uses the earlier offset (the first occurrence)", () => {
    expect(utc("2027-10-31T02:30", "Europe/Warsaw")).toBe("2027-10-31T00:30:00.000Z");
  });

  it("I1: invalid dates, times and zones are refused", () => {
    expect(utc("2027-02-30T10:00", "Europe/Warsaw")).toBe("invalid");
    expect(utc("2027-01-15T24:00", "Europe/Warsaw")).toBe("invalid");
    expect(utc("2027-01-15 10:00", "Europe/Warsaw")).toBe("invalid");
    expect(utc("2027-01-15T10:00", "Mars/Olympus")).toBe("invalid");
    expect(isValidTimeZone("Europe/Warsaw")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("not a zone")).toBe(false);
  });

  it("I6: utcToLocal is the inverse in the interview's zone", () => {
    expect(utcToLocal(new Date("2027-07-15T08:00:00Z"), "Europe/Warsaw")).toBe("2027-07-15T10:00");
    expect(utcToLocal(new Date("2027-01-15T19:00:00Z"), "America/New_York")).toBe("2027-01-15T14:00");
  });
});

describe("changes and outcome", () => {
  const timing = { startsAtUtc: new Date("2027-01-15T09:00:00Z"), durationMinutes: 60, timezone: "Europe/Warsaw", locationOrLink: "Room 1" };

  it("I3: only time, duration, zone or location count as a timing change", () => {
    expect(timingChanged(timing, { ...timing })).toBe(false);
    expect(timingChanged(timing, { ...timing, durationMinutes: 45 })).toBe(true);
    expect(timingChanged(timing, { ...timing, locationOrLink: "Room 2" })).toBe(true);
    expect(timingChanged(timing, { ...timing, startsAtUtc: new Date("2027-01-15T10:00:00Z") })).toBe(true);
  });

  it("I5: added and removed participants", () => {
    expect(participantChanges(["a", "b"], ["b", "c"])).toEqual({ added: ["c"], removed: ["a"] });
    expect(participantChanges(["a"], ["a"])).toEqual({ added: [], removed: [] });
  });

  it("I7: a SCHEDULED interview awaits its outcome once its end has passed", () => {
    const interview = { status: "SCHEDULED", startsAtUtc: new Date("2027-01-15T09:00:00Z"), durationMinutes: 60 };
    expect(awaitingOutcome(interview, new Date("2027-01-15T09:59:00Z"))).toBe(false);
    expect(awaitingOutcome(interview, new Date("2027-01-15T10:00:00Z"))).toBe(true);
    expect(awaitingOutcome({ ...interview, status: "COMPLETED" }, new Date("2027-01-16T00:00:00Z"))).toBe(false);
  });
});
