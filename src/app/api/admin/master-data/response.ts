// Maps a master data result to the JSON response the Admin UI reads: an error
// code, its text from messages/en.json, and per-field texts for 400s.
import type { MasterDataResult } from "@/server/master-data";
import { message } from "@/server/messages";

const STATUS = { invalid: 400, duplicate: 400, notFound: 404, inUse: 409 } as const;
/** Fields with their own error text; anything else gets the generic one. */
const FIELDS_WITH_TEXT = new Set(["code", "label", "picklistKey"]);

function fieldText(field: string, code: string): string {
  if (code === "notEditable") return message("AdminMasterData.errors.notEditable");
  return message(`AdminMasterData.errors.${FIELDS_WITH_TEXT.has(field) ? field : "invalid"}`);
}

export function masterDataResponse(result: MasterDataResult, okStatus = 200): Response {
  if (result.ok) return Response.json({ record: result.row }, { status: okStatus });
  const body: { error: string; message: string; fields?: Record<string, string> } = {
    error: result.reason,
    message: message(`AdminMasterData.errors.${result.reason}`),
  };
  if (result.reason === "invalid") {
    body.fields = Object.fromEntries(Object.entries(result.errors).map(([field, code]) => [field, fieldText(field, code)]));
  }
  return Response.json(body, { status: STATUS[result.reason] });
}
