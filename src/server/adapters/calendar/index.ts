// CalendarService (tech-stack.md §3 rule 4; ats-project-scope.md I1–I6):
// builds the `.ics` text of one interview invite or cancellation for one
// recipient. Pure: no I/O, no clock (DTSTAMP is an input), so the output is
// snapshot-tested. RFC 5545: CRLF line endings, TEXT escaping, and lines
// folded at 75 octets. Times are always UTC (`…Z`, I6). No RSVP tracking
// (tradeoffs.md TO-11), so the attendee has RSVP=FALSE.

export type InviteInput = {
  method: "REQUEST" | "CANCEL";
  uid: string;
  sequence: number;
  startUtc: Date;
  durationMinutes: number;
  summary: string;
  location: string;
  description: string;
  organizerEmail: string;
  attendee: { email: string; name: string };
  dtstamp: Date;
};

const PRODID = "-//ATS//Interview invites//EN";

/** TEXT values (RFC 5545 §3.3.11): backslash, semicolon, comma and line breaks. */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/** A parameter value such as CN (RFC 5545 §3.2): quoted, without quotes or control characters. */
function paramValue(value: string): string {
  return `"${value.replace(/["\r\n\t]/g, " ")}"`;
}

/** `20270115T130000Z`. */
export function utcStamp(instant: Date): string {
  return instant.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/**
 * Folds a content line at 75 octets (RFC 5545 §3.1): continuation lines
 * start with one space. Never splits a UTF-8 character.
 */
export function foldLine(line: string): string {
  const encoder = new TextEncoder();
  const parts: string[] = [];
  let current = "";
  let octets = 0;
  for (const char of line) {
    const size = encoder.encode(char).length;
    // The first line holds 75 octets; continuation lines 74 after the space.
    const limit = parts.length === 0 ? 75 : 74;
    if (octets + size > limit) {
      parts.push(current);
      current = "";
      octets = 0;
    }
    current += char;
    octets += size;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

export function buildInvite(input: InviteInput): string {
  const end = new Date(input.startUtc.getTime() + input.durationMinutes * 60_000);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    `METHOD:${input.method}`,
    "BEGIN:VEVENT",
    `UID:${input.uid}`,
    `SEQUENCE:${input.sequence}`,
    `DTSTAMP:${utcStamp(input.dtstamp)}`,
    `DTSTART:${utcStamp(input.startUtc)}`,
    `DTEND:${utcStamp(end)}`,
    `SUMMARY:${escapeText(input.summary)}`,
    `LOCATION:${escapeText(input.location)}`,
    `DESCRIPTION:${escapeText(input.description)}`,
    `ORGANIZER;CN=${paramValue("ATS")}:mailto:${input.organizerEmail}`,
    `ATTENDEE;CN=${paramValue(input.attendee.name)};RSVP=FALSE:mailto:${input.attendee.email}`,
    `STATUS:${input.method === "CANCEL" ? "CANCELLED" : "CONFIRMED"}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

export const calendarService = { buildInvite };
export type CalendarService = typeof calendarService;
