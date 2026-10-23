// Value formats for tokens (ats-project-scope.md §5.1 "Formats", I6). Pure;
// used by the code that builds token values (tasks 18, 32, 37).

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const AMOUNT = new Intl.NumberFormat("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: true });

/** `2027-01-15` (a calendar date) → `15 January 2027`. */
export function formatDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) throw new Error("Expected a YYYY-MM-DD date");
  return DATE.format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))));
}

/** `85000` or `"85000.5"` → `85,000.00`; the currency code is a separate token. */
export function formatAmount(amount: string | number): string {
  const value = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(value)) throw new Error("Expected a numeric amount");
  return AMOUNT.format(value);
}

/**
 * An instant shown in the interview's own time zone with the zone's name
 * (I6): `Monday, 15 January 2027, 14:00 (Europe/Warsaw)`.
 */
export function formatInterviewDateTime(instant: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.weekday}, ${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute} (${timeZone})`;
}
