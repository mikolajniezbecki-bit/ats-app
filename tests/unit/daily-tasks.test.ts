import { afterAll, describe, expect, it } from "vitest";
import { DAILY_TASKS, isDailyTaskDue, parseTestNow, warsawRunDate } from "@/server/domain/daily-tasks";
import { resolveTickClock, secretMatches } from "@/server/domain/tick";

const ORIGINAL_TZ = process.env.TZ;
afterAll(() => {
  process.env.TZ = ORIGINAL_TZ;
});

const task = (name: string) => DAILY_TASKS.find((t) => t.name === name)!;

// The helper must not depend on the process time zone, so every case runs
// under two zones far from Warsaw (Node applies a changed TZ immediately).
const PROCESS_ZONES = ["UTC", "Pacific/Auckland"];

describe.each(PROCESS_ZONES)("with TZ=%s", (zone) => {
  it.each([
    ["2026-03-28T22:59:59Z", "2026-03-28"],
    ["2026-03-28T23:00:00Z", "2026-03-29"],
    ["2026-03-29T21:59:59Z", "2026-03-29"],
    ["2026-03-29T22:00:00Z", "2026-03-30"],
    ["2026-10-24T21:59:59Z", "2026-10-24"],
    ["2026-10-24T22:00:00Z", "2026-10-25"],
    ["2026-10-25T22:59:59Z", "2026-10-25"],
    ["2026-10-25T23:00:00Z", "2026-10-26"],
  ])("W5: run date of %s is %s around the DST changes", (instant, expected) => {
    process.env.TZ = zone;
    expect(warsawRunDate(new Date(instant))).toBe(expected);
  });

  it.each([
    ["approvals.remind", "2026-03-28T06:59:59Z", "2026-03-28T07:00:00Z"],
    ["approvals.remind", "2026-03-29T05:59:59Z", "2026-03-29T06:00:00Z"],
    ["approvals.remind", "2026-10-25T06:59:59Z", "2026-10-25T07:00:00Z"],
    ["retention.purge", "2026-03-29T00:59:59Z", "2026-03-29T01:00:00Z"],
    ["retention.purge", "2026-10-24T23:59:59Z", "2026-10-25T00:00:00Z"],
  ])("W5: %s is not due at %s and due at %s", (name, before, at) => {
    process.env.TZ = zone;
    expect(isDailyTaskDue(task(name), new Date(before))).toBe(false);
    expect(isDailyTaskDue(task(name), new Date(at))).toBe(true);
  });
});

describe("tick secret", () => {
  it("W4: matches only the exact secret, without throwing on a length mismatch", () => {
    expect(secretMatches("s3cret", "s3cret")).toBe(true);
    expect(secretMatches("s3creT", "s3cret")).toBe(false);
    expect(secretMatches("s3cret-longer", "s3cret")).toBe(false);
    expect(secretMatches("", "s3cret")).toBe(false);
    expect(secretMatches(null, "s3cret")).toBe(false);
  });
});

describe("test clock", () => {
  const real = new Date("2026-05-01T10:00:00Z");

  it("T3: x-test-now is ignored completely unless dev login is on, so the clock shift can't run", () => {
    expect(resolveTickClock("2030-01-01T00:00:00Z", false, real)).toEqual({ now: real, testNow: false });
    expect(resolveTickClock("not a date", false, real)).toEqual({ now: real, testNow: false });
  });

  it("T3: with dev login on, a valid value drives the clock and an unparsable one is refused", () => {
    expect(resolveTickClock("2030-01-01T01:00:00+01:00", true, real)).toEqual({
      now: new Date("2030-01-01T00:00:00Z"),
      testNow: true,
    });
    expect(resolveTickClock(null, true, real)).toEqual({ now: real, testNow: false });
    expect(resolveTickClock("not a date", true, real)).toBeNull();
  });

  it("T3: accepts ISO 8601 only with Z or an offset", () => {
    expect(parseTestNow("2026-10-25T00:00:00Z")).toEqual(new Date("2026-10-25T00:00:00Z"));
    expect(parseTestNow("2026-10-25T00:00:00.123+02:00")).toEqual(new Date("2026-10-24T22:00:00.123Z"));
    expect(parseTestNow("2026-10-25T00:00:00")).toBeNull();
    expect(parseTestNow("2026-10-25")).toBeNull();
    expect(parseTestNow("2026-13-45T00:00:00Z")).toBeNull();
  });
});
