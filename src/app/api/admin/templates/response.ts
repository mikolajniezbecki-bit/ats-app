// Maps a template result to the JSON response the Admin UI reads: an error
// code, its text from messages/en.json, and per-field texts for 400s.
import { message } from "@/server/messages";
import type { TemplateResult } from "@/server/templates";

const STATUS = { invalid: 400, duplicate: 409, triggerConflict: 409, notFound: 404, inUse: 409 } as const;
/** Fields whose generic error has its own text. */
const FIELD_TEXT = new Set(["name", "subject", "body", "triggerStatus", "schemaJson"]);

export function templateResponse(result: TemplateResult, okStatus = 200): Response {
  if (result.ok) return Response.json({ template: result.template }, { status: okStatus });
  if (result.reason === "triggerConflict") {
    // Shown on the trigger field too, so the form treats it as a validation error.
    const text = message("AdminTemplates.errors.triggerConflict", { status: message(`Statuses.${result.status}`) });
    return Response.json({ error: result.reason, message: text, fields: { triggerStatus: text } }, { status: STATUS.triggerConflict });
  }
  const body: { error: string; message: string; fields?: Record<string, string> } = {
    error: result.reason,
    message: message(`AdminTemplates.errors.${result.reason}`),
  };
  if (result.reason === "invalid") {
    body.fields = Object.fromEntries(
      Object.entries(result.fields).map(([field, error]) => {
        const code = error.code === "invalid" ? (FIELD_TEXT.has(field) ? field : "invalid") : error.code;
        return [field, message(`AdminTemplates.errors.${code}`, error.token ? { token: error.token } : {})];
      }),
    );
  }
  return Response.json(body, { status: STATUS[result.reason] });
}
