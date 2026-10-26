// The applications of one requisition (ats-project-scope.md §5.4, V2, V4,
// V9; tech-stack.md T5): the same read model as the list page, `?status=`
// and `?page=` as there. Admins, Recruiters and Hiring Managers in V3a;
// Interviewers never see requisition pages (403); 404 outside the scope.
import { type ApplicationStatus, listRequisitionApplications } from "@/server/applications";
import { APPLICATION_STATUSES } from "@/server/db/schema";
import { withPermission } from "@/server/policy/guards";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withPermission("requisition.read", async (request, user, context: RouteContext<"/api/requisitions/[id]/applications">) => {
  const { id } = await context.params;
  const search = new URL(request.url).searchParams;
  const status = APPLICATION_STATUSES.find((value) => value === search.get("status")) as ApplicationStatus | undefined;
  const page = Number.parseInt(search.get("page") ?? "1", 10) || 1;
  const list = await listRequisitionApplications(user, id, { status, page });
  if (!list) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json(list, { headers: { "Cache-Control": "no-store" } });
});
