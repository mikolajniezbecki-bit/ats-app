// Change an application's status (ats-project-scope.md §5.4 R1–R6, R9):
// Admin and Recruiter only, whatever the requisition (Q5). Body
// `{ toStatus, version, comment? }`; 200 `{ status, version }`, 400 for
// invalid input or an R4 correction without a comment, 403 for an R4
// correction by a non-Admin, 404 for an unknown application, 409 with the
// message for a refused transition, a stale version or an anonymized
// application.
import { z } from "zod";
import { withTransaction } from "@/server/db";
import { message } from "@/server/messages";
import { changeApplicationStatus, statusChangeSchema } from "@/server/pipeline";
import { withPermission } from "@/server/policy/guards";
import { can } from "@/server/policy/permissions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withPermission("application.changeStatus", async (request, user, context: RouteContext<"/api/applications/[id]/status">) => {
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) return Response.json({ error: "notFound", message: message("Pipeline.errors.notFound") }, { status: 404 });
  const body: unknown = await request.json().catch(() => undefined);
  const parsed = statusChangeSchema.safeParse(body);
  if (!parsed.success) {
    const tooLong = parsed.error.issues.some((issue) => issue.path[0] === "comment" && issue.code === "too_big");
    const error = tooLong ? "commentTooLong" : "invalid";
    return Response.json({ error, message: message(`Pipeline.errors.${error}`) }, { status: 400 });
  }

  const result = await withTransaction((tx) =>
    changeApplicationStatus(tx, { applicationId: id, ...parsed.data, actor: user, canCorrectHired: can(user, "application.correctHired") }),
  );
  if (result.ok) return Response.json({ status: result.status, version: result.version });
  const status = result.reason === "notFound" ? 404 : result.reason === "correctHiredForbidden" ? 403 : result.reason === "correctionNeedsComment" ? 400 : 409;
  return Response.json({ error: result.reason, message: result.message }, { status });
});
