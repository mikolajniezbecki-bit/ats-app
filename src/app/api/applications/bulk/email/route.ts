// Bulk email (ats-project-scope.md §5.4 Bulk actions): Admin and Recruiter.
// Body `{ templateId, applicationIds }`, at most 100; 200 with one result per
// application, or 409 when the template no longer qualifies (nothing queued).
import { bulkEmailSchema, bulkSendEmail } from "@/server/email/bulk";
import { message } from "@/server/messages";
import { bulkIdsError } from "@/server/pipeline/bulk";
import { withPermission } from "@/server/policy/guards";
import { REQUEST_ID_HEADER } from "@/server/request-id";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withPermission("application.bulkEmail", async (request, user) => {
  const body: unknown = await request.json().catch(() => undefined);
  const parsed = bulkEmailSchema.safeParse(body);
  const error = parsed.success ? bulkIdsError(parsed.data.applicationIds) : "invalid";
  if (!parsed.success || error) return Response.json({ error, message: message(`Bulk.errors.${error}`) }, { status: 400 });
  const results = await bulkSendEmail(user, parsed.data, { requestId: request.headers.get(REQUEST_ID_HEADER) ?? undefined });
  if (!results) return Response.json({ error: "templateUnusable", message: message("Bulk.errors.templateUnusable") }, { status: 409 });
  return Response.json({ results });
});
