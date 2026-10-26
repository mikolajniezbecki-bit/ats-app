// The feedback summary of an application (ats-project-scope.md I10, V2,
// V7): average rating to one decimal and thumbs counts over every submitted
// scorecard the user may read, plus those scorecards. One read model that
// takes the user, so task 34 adds the Hiring Manager view (V4) here.
import type { Db } from "../db";
import { getDb } from "../db";
import { feedbackSummary } from "../domain/scorecards";
import type { PolicyUser } from "../policy/permissions";
import { type ScorecardView, listApplicationScorecards } from "../scorecards";

export type ApplicationFeedback = { summary: ReturnType<typeof feedbackSummary>; scorecards: ScorecardView[] };

/**
 * Undefined when the user doesn't get the summary: Admins, Recruiters (V2)
 * and Hiring Managers (V4) do; Interviewers see scorecards under V7 only,
 * never the summary (V6). The caller has checked access to the application.
 */
export async function getApplicationFeedback(user: PolicyUser, applicationId: string, db: Db = getDb()): Promise<ApplicationFeedback | undefined> {
  if (user.isActive === false || !["ADMIN", "RECRUITER", "HIRING_MANAGER"].includes(user.role)) return undefined;
  // Q3: every submitted scorecard counts, also from removed participants and cancelled interviews.
  const submitted = (await listApplicationScorecards(user, applicationId, db)).filter((scorecard) => scorecard.submittedAt !== null);
  return { summary: feedbackSummary(submitted), scorecards: submitted };
}
