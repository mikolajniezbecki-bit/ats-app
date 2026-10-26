// Scorecard rules (ats-project-scope.md I9, I10, V7, V8, TO-20). Pure: the
// service loads the rows under its locks and asks these functions, so every
// rule is unit-tested without a database.

export const MAX_COMMENTS_LENGTH = 5_000;
export const MIN_RATING = 1;
export const MAX_RATING = 5;

export type WriteRefusal = "notParticipant" | "notStarted" | "interviewClosed" | "applicationClosed" | "submitted";

/**
 * I9, V8: why the caller can't save or submit their scorecard now, or
 * undefined when they can. Checked in this order, so the most specific
 * reason wins: participation, the interview's state and time, the
 * application, then the scorecard itself.
 */
export function writeRefusal(input: {
  participant: { active: boolean; removed: boolean } | undefined;
  interview: { status: string; startsAtUtc: Date };
  applicationOpen: boolean;
  scorecard: { submittedAt: Date | null } | undefined;
  now: Date;
}): WriteRefusal | undefined {
  const { participant, interview, applicationOpen, scorecard, now } = input;
  if (!participant || !participant.active || participant.removed) return "notParticipant";
  if (interview.status === "CANCELLED" || interview.status === "NO_SHOW") return "interviewClosed";
  if (interview.startsAtUtc.getTime() > now.getTime()) return "notStarted";
  if (!applicationOpen) return "applicationClosed";
  if (scorecard?.submittedAt) return "submitted";
  return undefined;
}

/** A scorecard reopened by an Admin and not submitted again (V7, V8). */
export const isReopenedPending = (scorecard: { submittedAt: Date | null; reopenedAt: Date | null }) => scorecard.reopenedAt !== null && scorecard.submittedAt === null;

/**
 * V7: an interviewer sees other participants' submitted scorecards on an
 * application only once at least one of their own there is submitted and
 * none is reopened-but-not-resubmitted.
 */
export function canSeeOthers(own: readonly { submittedAt: Date | null; reopenedAt: Date | null }[]): boolean {
  return own.some((scorecard) => scorecard.submittedAt !== null) && !own.some(isReopenedPending);
}

/** I10: the summary of the submitted scorecards; the average to one decimal, null without any. */
export function feedbackSummary(scorecards: readonly { overallRating: number; thumbsUp: boolean; submittedAt: Date | null }[]) {
  const submitted = scorecards.filter((scorecard) => scorecard.submittedAt !== null);
  const total = submitted.reduce((sum, scorecard) => sum + scorecard.overallRating, 0);
  return {
    count: submitted.length,
    average: submitted.length > 0 ? (Math.round((total / submitted.length) * 10) / 10).toFixed(1) : null,
    thumbsUp: submitted.filter((scorecard) => scorecard.thumbsUp).length,
    thumbsDown: submitted.filter((scorecard) => !scorecard.thumbsUp).length,
  };
}
