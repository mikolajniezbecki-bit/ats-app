// Maps a user-management result to the JSON response the Admin UI reads: an
// error code, its text from messages/en.json, and per-field texts for 400s.
import { message } from "@/server/messages";
import type { UserError, UserResult } from "@/server/users";

const STATUS: Record<UserError, number> = {
  invalid: 400,
  ownRole: 400,
  ownDeactivation: 400,
  lastAdmin: 400,
  pendingApprovals: 409,
  duplicate: 409,
  duplicateInactive: 409,
  notFound: 404,
};
const FIELDS_WITH_TEXT = new Set(["email", "name", "role"]);

/** A5: names the blocking items by requisition number, the first ten of them. */
function pendingApprovalsText(pending: string[]): string {
  const shown = pending.slice(0, 10).join(", ") + (pending.length > 10 ? ", …" : "");
  return pending.length === 1
    ? message("AdminUsers.errors.pendingApprovalsOne", { items: shown })
    : message("AdminUsers.errors.pendingApprovals", { count: String(pending.length), items: shown });
}

export function userResponse(result: UserResult, okStatus = 200): Response {
  if (result.ok) {
    const { id, email, name, role, isActive } = result.user;
    return Response.json({ user: { id, email, name, role, isActive }, changed: result.changed }, { status: okStatus });
  }
  const body: { error: string; message: string; fields?: Record<string, string> } = {
    error: result.reason,
    message: result.reason === "pendingApprovals" ? pendingApprovalsText(result.pending ?? []) : message(`AdminUsers.errors.${result.reason}`),
  };
  if (result.fields) {
    body.fields = Object.fromEntries(
      Object.entries(result.fields).map(([field, code]) => [
        field,
        message(`AdminUsers.errors.${code === "notEditable" ? "notEditable" : FIELDS_WITH_TEXT.has(field) ? field : "invalid"}`),
      ]),
    );
  }
  return Response.json(body, { status: STATUS[result.reason] });
}
