// Interview time zones and limits (ats-project-scope.md I1, I6, §7
// `interviews`). Pure: `Intl` only, no clock, so it is unit-tested with fixed
// instants in any process time zone.

export const MIN_DURATION_MINUTES = 15;
export const MAX_DURATION_MINUTES = 480;
export const MAX_LOCATION_LENGTH = 500;
export const MAX_PARTICIPANTS = 10;

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** True for a zone `Intl` knows (IANA names such as `Europe/Warsaw`, and `UTC`). */
export function isValidTimeZone(timeZone: string): boolean {
  if (!/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(timeZone)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The wall clock of `instant` in `timeZone`, as milliseconds of a UTC date with the same fields. */
function wallClock(instant: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value]),
  );
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
}

export type LocalTimeResult = { ok: true; instant: Date } | { ok: false; reason: "invalid" | "nonexistent" };

/**
 * `2027-01-15T10:00` in `Europe/Warsaw` → `2027-01-15T09:00:00Z` (I1). A
 * local time inside a daylight-saving gap is `nonexistent`; an ambiguous one
 * (the repeated autumn hour) uses the earlier offset, i.e. the first of the
 * two instants (Q3).
 */
export function localToUtc(local: string, timeZone: string): LocalTimeResult {
  const match = LOCAL.exec(local);
  if (!match || !isValidTimeZone(timeZone)) return { ok: false, reason: "invalid" };
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(wall);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || hour > 23 || minute > 59) {
    return { ok: false, reason: "invalid" };
  }
  // Every offset the zone uses around this date; each gives one candidate.
  const offsets = new Set([-1, 0, 1].map((days) => wallClock(wall + days * 86_400_000, timeZone) - (wall + days * 86_400_000)));
  const candidates = [...offsets].map((offset) => wall - offset).filter((instant) => wallClock(instant, timeZone) === wall);
  if (candidates.length === 0) return { ok: false, reason: "nonexistent" };
  return { ok: true, instant: new Date(Math.min(...candidates)) };
}

/** `instant` as `YYYY-MM-DDTHH:MM` in `timeZone`, for the edit form (the inverse of localToUtc). */
export function utcToLocal(instant: Date, timeZone: string): string {
  return new Date(wallClock(instant.getTime(), timeZone)).toISOString().slice(0, 16);
}

/** The fields whose change sends a new REQUEST to everyone (I3). */
export type InterviewTiming = { startsAtUtc: Date; durationMinutes: number; timezone: string; locationOrLink: string };

export function timingChanged(before: InterviewTiming, after: InterviewTiming): boolean {
  return (
    before.startsAtUtc.getTime() !== after.startsAtUtc.getTime() ||
    before.durationMinutes !== after.durationMinutes ||
    before.timezone !== after.timezone ||
    before.locationOrLink !== after.locationOrLink
  );
}

/** I5: who joins and who leaves, from the current and the requested participant IDs. */
export function participantChanges(current: readonly string[], requested: readonly string[]): { added: string[]; removed: string[] } {
  const now = new Set(current);
  const next = new Set(requested);
  return { added: requested.filter((id) => !now.has(id)), removed: current.filter((id) => !next.has(id)) };
}

/** I7: a SCHEDULED interview whose end has passed waits for its outcome. */
export function awaitingOutcome(interview: { status: string; startsAtUtc: Date; durationMinutes: number }, now: Date): boolean {
  return interview.status === "SCHEDULED" && interview.startsAtUtc.getTime() + interview.durationMinutes * 60_000 <= now.getTime();
}
