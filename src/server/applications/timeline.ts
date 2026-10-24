// The application timeline (ats-project-scope.md §5.4 Recruiter workbench,
// E4, E5, RT4): status history, emails, interviews, submitted scorecards and
// offers merged into one list, oldest first. Pure: the read model loads the
// rows, this decides each entry's time and order, and the tests check it
// without a database.

export type HistorySource = {
  id: string;
  createdAt: Date;
  fromStatus: string | null;
  toStatus: string;
  changedBy: string | null;
  comment: string | null;
  reasonCode: string | null;
  isReopen: boolean;
};

export type EmailSource = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  sentAt: Date | null;
  scheduledFor: Date | null;
  subject: string | null;
  recipient: string | null;
  bodyRendered: string | null;
  audience: "CANDIDATE" | "STAFF";
  status: "QUEUED" | "SENT" | "CAPTURED" | "FAILED" | "CANCELLED";
  error: string | null;
};

export type InterviewSource = {
  id: string;
  startsAtUtc: Date;
  durationMinutes: number;
  status: "SCHEDULED" | "COMPLETED" | "CANCELLED" | "NO_SHOW";
};

export type ScorecardSource = {
  id: string;
  interviewer: string;
  overallRating: number;
  thumbsUp: boolean;
  submittedAt: Date | null;
};

export type OfferSource = {
  id: string;
  createdAt: Date;
  jobTitle: string;
  approvalStatus: string;
  candidateResponse: string;
  sentAt: Date | null;
  respondedAt: Date | null;
};

export type TimelineEntry =
  | ({ kind: "history"; at: Date; created: boolean } & HistorySource)
  | ({ kind: "email"; at: Date; removed: boolean; failed: boolean } & EmailSource)
  | ({ kind: "interview"; at: Date } & InterviewSource)
  | ({ kind: "scorecard"; at: Date } & Omit<ScorecardSource, "submittedAt"> & { submittedAt: Date })
  | ({ kind: "offer"; at: Date } & OfferSource);

/** Order of kinds at the same instant: the status change first, then what it caused. */
const KIND_ORDER: Record<TimelineEntry["kind"], number> = { history: 0, email: 1, interview: 2, scorecard: 3, offer: 4 };

/**
 * Where an email sits (Q5): `sent_at` once sent, `scheduled_for` while
 * QUEUED, `updated_at` for CANCELLED and FAILED (when that happened), and
 * `created_at` as the last resort.
 */
export function emailTime(email: Pick<EmailSource, "status" | "sentAt" | "scheduledFor" | "updatedAt" | "createdAt">): Date {
  if (email.sentAt) return email.sentAt;
  if (email.status === "QUEUED") return email.scheduledFor ?? email.createdAt;
  if (email.status === "CANCELLED" || email.status === "FAILED") return email.updatedAt;
  return email.createdAt;
}

/** One list, oldest first; unsubmitted scorecards are left out. */
export function buildTimeline(sources: {
  history: readonly HistorySource[];
  emails: readonly EmailSource[];
  interviews: readonly InterviewSource[];
  scorecards: readonly ScorecardSource[];
  offers: readonly OfferSource[];
}): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...sources.history.map((row) => ({ ...row, kind: "history" as const, at: row.createdAt, created: row.fromStatus === null })),
    ...sources.emails.map((row) => ({
      ...row,
      kind: "email" as const,
      at: emailTime(row),
      // RT4 clears recipient, subject and body.
      removed: row.recipient === null && row.subject === null,
      failed: row.status === "FAILED",
    })),
    ...sources.interviews.map((row) => ({ ...row, kind: "interview" as const, at: row.startsAtUtc })),
    ...sources.scorecards.flatMap((row) => (row.submittedAt ? [{ ...row, submittedAt: row.submittedAt, kind: "scorecard" as const, at: row.submittedAt }] : [])),
    ...sources.offers.map((row) => ({ ...row, kind: "offer" as const, at: row.createdAt })),
  ];
  return entries.sort((a, b) => a.at.getTime() - b.at.getTime() || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.id.localeCompare(b.id));
}
