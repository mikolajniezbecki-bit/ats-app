// Maps a requisition result to the JSON response the form reads: an error
// code, its text from messages/en.json, and per-field texts for 400s.
import { message } from "@/server/messages";
import type { RequisitionResult } from "@/server/requisitions";

const STATUS = { invalid: 400, notFound: 404, forbidden: 403, stale: 409, notEditable: 409 } as const;

/** A field's text: its own for a generic error, else the code's (custom fields share theirs). */
function fieldText(field: string, code: string): string {
  if (code !== "invalid") return message(`Requisitions.errors.${code}`);
  const base = field.startsWith("customFields.") ? "customField" : field;
  try {
    return message(`Requisitions.errors.fields.${base}`);
  } catch {
    return message("Requisitions.errors.invalid");
  }
}

export function requisitionResponse(result: RequisitionResult, okStatus = 200): Response {
  if (result.ok) return Response.json({ requisition: result.requisition }, { status: okStatus });
  const body: { error: string; message: string; fields?: Record<string, string> } = {
    error: result.reason,
    message: message(`Requisitions.errors.${result.reason}`),
  };
  if (result.reason === "invalid") {
    body.fields = Object.fromEntries(Object.entries(result.fields).map(([field, code]) => [field, fieldText(field, code)]));
  }
  return Response.json(body, { status: STATUS[result.reason] });
}
