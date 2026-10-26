// The scorecards of an application the caller may see (ats-project-scope.md
// V2, V5, V7, V9): Admins and Recruiters every submitted one; participants
// their own, and others' only after submitting their own. Hidden ones are
// absent from the response. 404 for anyone without access.
import { withPermission } from "@/server/policy/guards";
import { canReadScorecardsOf, listApplicationScorecards } from "@/server/scorecards";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withPermission("staff.area", async (_request, user, context: RouteContext<"/api/applications/[id]/scorecards">) => {
  const { id } = await context.params;
  if (!(await canReadScorecardsOf(user, id))) return Response.json({ error: "not_found" }, { status: 404 });
  const scorecards = await listApplicationScorecards(user, id);
  return Response.json({ scorecards }, { headers: { "Cache-Control": "no-store" } });
});
