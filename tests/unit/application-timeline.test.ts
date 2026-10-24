// The application timeline's ordering and email times (ats-project-scope.md
// §5.4 Recruiter workbench, E4, E5, RT4).
import { describe, expect, it } from "vitest";
import { type EmailSource, buildTimeline, emailTime } from "@/server/applications/timeline";

const at = (minute: number) => new Date(Date.UTC(2027, 0, 15, 10, minute));
const email = (id: string, values: Partial<EmailSource>): EmailSource => ({
  id,
  createdAt: at(0),
  updatedAt: at(0),
  sentAt: null,
  scheduledFor: null,
  subject: "Subject",
  recipient: "a@example.com",
  bodyRendered: "<p>x</p>",
  audience: "CANDIDATE",
  status: "SENT",
  error: null,
  ...values,
});
const empty = { history: [], emails: [], interviews: [], scorecards: [], offers: [] };

describe("emailTime", () => {
  it("E4: uses sent_at once sent, scheduled_for while queued, updated_at when cancelled or failed", () => {
    expect(emailTime(email("a", { status: "SENT", sentAt: at(5), scheduledFor: at(1), updatedAt: at(9) }))).toEqual(at(5));
    expect(emailTime(email("b", { status: "CAPTURED", sentAt: at(6) }))).toEqual(at(6));
    expect(emailTime(email("c", { status: "QUEUED", scheduledFor: at(30), updatedAt: at(2) }))).toEqual(at(30));
    expect(emailTime(email("d", { status: "FAILED", scheduledFor: at(1), updatedAt: at(7) }))).toEqual(at(7));
    expect(emailTime(email("e", { status: "CANCELLED", scheduledFor: at(40), updatedAt: at(8) }))).toEqual(at(8));
  });
});

describe("buildTimeline", () => {
  it("E4: merges the sources oldest first; at the same instant the status change comes before its email", () => {
    const entries = buildTimeline({
      ...empty,
      emails: [email("queued", { status: "QUEUED", scheduledFor: at(50) }), email("sent", { sentAt: at(10) })],
      history: [
        { id: "h2", createdAt: at(10), fromStatus: "APPLIED", toStatus: "SCREENING", changedBy: "R", comment: null, reasonCode: null, isReopen: false },
        { id: "h1", createdAt: at(0), fromStatus: null, toStatus: "APPLIED", changedBy: null, comment: null, reasonCode: null, isReopen: false },
      ],
      offers: [{ id: "o", createdAt: at(20), jobTitle: "Dev", approvalStatus: "DRAFT", candidateResponse: "PENDING", sentAt: null, respondedAt: null }],
    });
    expect(entries.map((entry) => entry.id)).toEqual(["h1", "h2", "sent", "o", "queued"]);
    expect(entries[0]).toMatchObject({ kind: "history", created: true });
    expect(entries[1]).toMatchObject({ created: false });
  });

  it("E5: flags FAILED emails, and RT4-cleared emails as removed", () => {
    const [failed, removed] = buildTimeline({
      ...empty,
      emails: [email("f", { status: "FAILED", updatedAt: at(1) }), email("r", { sentAt: at(2), recipient: null, subject: null, bodyRendered: null })],
    });
    expect(failed).toMatchObject({ kind: "email", failed: true, removed: false });
    expect(removed).toMatchObject({ kind: "email", failed: false, removed: true });
  });

  it("leaves out unsubmitted scorecards and places submitted ones at submitted_at", () => {
    const entries = buildTimeline({
      ...empty,
      interviews: [{ id: "i", startsAtUtc: at(10), durationMinutes: 60, status: "COMPLETED" }],
      scorecards: [
        { id: "draft", interviewer: "A", overallRating: 3, thumbsUp: true, submittedAt: null },
        { id: "done", interviewer: "B", overallRating: 5, thumbsUp: true, submittedAt: at(5) },
      ],
    });
    expect(entries.map((entry) => [entry.kind, entry.id])).toEqual([
      ["scorecard", "done"],
      ["interview", "i"],
    ]);
  });
});
