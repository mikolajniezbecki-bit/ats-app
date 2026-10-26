// The .ics builder (ats-project-scope.md I1–I6; tech-stack.md §3 rule 4):
// pure, so a fixed input is compared with a committed snapshot.
import { describe, expect, it } from "vitest";
import { type InviteInput, buildInvite, escapeText, foldLine } from "@/server/adapters/calendar";

const BASE: InviteInput = {
  method: "REQUEST",
  uid: "0b8f2c1e-5d1a-4c55-9d7e-2f0c6c4d8a11@ats",
  sequence: 0,
  startUtc: new Date("2027-01-15T13:00:00Z"),
  durationMinutes: 45,
  summary: "Interview: Backend Engineer",
  location: "Room 4",
  description: "Interview for Backend Engineer.",
  organizerEmail: "careers@ats-demo.local",
  attendee: { email: "ada@example.com", name: "Ada Lovelace" },
  dtstamp: new Date("2027-01-10T09:30:00Z"),
};

const unfold = (ics: string) => ics.replace(/\r\n /g, "");
const lines = (ics: string) => unfold(ics).split("\r\n");

describe("buildInvite", () => {
  it("I1: a fixed input matches the committed snapshot", () => {
    expect(buildInvite(BASE)).toMatchSnapshot();
  });

  it("I1: CRLF line endings, one VEVENT with UID, SEQUENCE and exactly one ATTENDEE with RSVP=FALSE", () => {
    const ics = buildInvite(BASE);
    expect(ics.endsWith("\r\n")).toBe(true);
    expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    const all = lines(ics);
    expect(all.filter((line) => line === "BEGIN:VEVENT")).toHaveLength(1);
    expect(all).toContain("METHOD:REQUEST");
    expect(all).toContain(`UID:${BASE.uid}`);
    expect(all).toContain("SEQUENCE:0");
    expect(all).toContain("STATUS:CONFIRMED");
    expect(all).toContain("ORGANIZER;CN=\"ATS\":mailto:careers@ats-demo.local");
    expect(all.filter((line) => line.startsWith("ATTENDEE"))).toEqual(['ATTENDEE;CN="Ada Lovelace";RSVP=FALSE:mailto:ada@example.com']);
  });

  it("I6: DTSTART, DTEND and DTSTAMP are UTC", () => {
    const all = lines(buildInvite(BASE));
    expect(all).toContain("DTSTART:20270115T130000Z");
    expect(all).toContain("DTEND:20270115T134500Z");
    expect(all).toContain("DTSTAMP:20270110T093000Z");
  });

  it("I1: a location with commas, semicolons, a backslash and a line break is escaped", () => {
    const all = lines(buildInvite({ ...BASE, location: "Main St 1, floor 2; room \\4\nReception" }));
    expect(all).toContain("LOCATION:Main St 1\\, floor 2\\; room \\\\4\\nReception");
    expect(escapeText("a\r\nb")).toBe("a\\nb");
  });

  it("I1: a long description folds at 75 octets without splitting a character", () => {
    const description = `${"Długi opis rozmowy ".repeat(12)}koniec`;
    const ics = buildInvite({ ...BASE, description });
    for (const line of ics.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(lines(ics)).toContain(`DESCRIPTION:${description}`);
    expect(foldLine("x".repeat(75))).toBe("x".repeat(75));
    expect(foldLine("x".repeat(76))).toBe(`${"x".repeat(75)}\r\n x`);
  });

  it("I4: a CANCEL keeps the UID, carries the given sequence and STATUS:CANCELLED", () => {
    const all = lines(buildInvite({ ...BASE, method: "CANCEL", sequence: 2 }));
    expect(all).toContain("METHOD:CANCEL");
    expect(all).toContain(`UID:${BASE.uid}`);
    expect(all).toContain("SEQUENCE:2");
    expect(all).toContain("STATUS:CANCELLED");
  });
});
