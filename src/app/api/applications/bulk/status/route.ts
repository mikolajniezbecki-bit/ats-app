// Bulk status move (ats-project-scope.md §5.4 Bulk actions): Admin and
// Recruiter. Body `{ toStatus, comment?, items: [{ applicationId, version }] }`,
// at most 100 items; 200 with one result per item, in request order.
import { message } from "@/server/messages";
import { bulkChangeStatus, bulkIdsError, bulkStatusSchema } from "@/server/pipeline/bulk";
import { withPermission } from "@/server/policy/guards";
import { REQUEST_ID_HEADER } from "@/server/request-id";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withPermission("application.changeStatus", async (request, user) => {
  const body: unknown = await request.json().catch(() => undefined);
  const parsed = bulkStatusSchema.safeParse(body);
  const error = parsed.success ? bulkIdsError(parsed.data.items.map((item) => item.applicationId)) : "invalid";
  if (!parsed.success || error) return Response.json({ error, message: message(`Bulk.errors.${error}`) }, { status: 400 });
  return Response.json({ results: await bulkChangeStatus(user, parsed.data, { requestId: request.headers.get(REQUEST_ID_HEADER) ?? undefined }) });
});
