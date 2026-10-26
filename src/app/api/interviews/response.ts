// Maps an interview result to the JSON response the forms read: an error
// code, its text from messages/en.json, and per-field texts for 400s.
import { message } from "@/server/messages";
import type { InterviewError, InterviewResult } from "@/server/interviews";

const STATUS: Record<InterviewError, number> = {
  invalid: 400,
  notFound: 404,
  notOpen: 409,
  locked: 409,
  stale: 409,
  notStarted: 409,
};

function fieldText(code: string): string {
  try {
    return message(`Interviews.errors.fields.${code}`);
  } catch {
    return message("Interviews.errors.fields.invalid");
  }
}

export function interviewResponse(result: InterviewResult, okStatus = 200): Response {
  if (result.ok) return Response.json({ interview: result.interview, changed: result.changed }, { status: okStatus });
  const body: { error: string; message: string; fields?: Record<string, string> } = {
    error: result.reason,
    message: message(`Interviews.errors.${result.reason}`),
  };
  if (result.fields) body.fields = Object.fromEntries(Object.entries(result.fields).map(([field, code]) => [field, fieldText(code)]));
  return Response.json(body, { status: STATUS[result.reason] });
}
