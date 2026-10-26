// Maps a scorecard result to the JSON response the form reads: an error
// code, its text from messages/en.json, and per-field texts for 400s.
import { message } from "@/server/messages";
import type { ScorecardError, ScorecardResult } from "@/server/scorecards";

const STATUS: Record<ScorecardError | "noDraft", number> = {
  invalid: 400,
  notFound: 404,
  forbidden: 403,
  stale: 409,
  notParticipant: 403,
  notStarted: 409,
  interviewClosed: 409,
  applicationClosed: 409,
  submitted: 409,
  notSubmitted: 409,
  applicationFinal: 409,
  noDraft: 409,
};

export function scorecardError(reason: ScorecardError | "noDraft", fields?: Record<string, string>): Response {
  const body: { error: string; message: string; fields?: Record<string, string> } = { error: reason, message: message(`Scorecards.errors.${reason}`) };
  if (fields) body.fields = Object.fromEntries(Object.entries(fields).map(([field, code]) => [field, message(`Scorecards.errors.fields.${code}`)]));
  return Response.json(body, { status: STATUS[reason] });
}

export function scorecardResponse(result: ScorecardResult): Response {
  if (!result.ok) return scorecardError(result.reason, result.fields);
  const { id, interviewId, thumbsUp, overallRating, comments, submittedAt, reopenedAt } = result.scorecard;
  return Response.json({ scorecard: { id, interviewId, thumbsUp, overallRating, comments, submittedAt, reopenedAt } });
}
