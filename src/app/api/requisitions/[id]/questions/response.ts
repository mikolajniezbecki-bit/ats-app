// Maps a question result to JSON: an error code, its text from
// messages/en.json, and per-field texts for 400s.
import { message } from "@/server/messages";
import type { QuestionResult } from "@/server/prescreen";

const STATUS = { invalid: 400, badOrder: 400, notFound: 404, forbidden: 403, stateLocked: 409, answered: 409, tooMany: 409 } as const;

export function questionResponse(result: QuestionResult, okStatus = 200): Response {
  if (result.ok) {
    return Response.json(result.question ? { question: result.question } : { questions: result.questions }, { status: okStatus });
  }
  const body: { error: string; message: string; fields?: Record<string, string> } = {
    error: result.reason,
    message: message(`Prescreen.errors.${result.reason}`),
  };
  if (result.reason === "invalid") {
    body.fields = Object.fromEntries(
      Object.entries(result.fields).map(([field, code]) => {
        let text: string;
        try {
          text = message(code === "invalid" ? `Prescreen.errors.fields.${field}` : `Prescreen.errors.${code}`);
        } catch {
          text = message("Prescreen.errors.invalidField");
        }
        return [field, text];
      }),
    );
  }
  return Response.json(body, { status: STATUS[result.reason] });
}
