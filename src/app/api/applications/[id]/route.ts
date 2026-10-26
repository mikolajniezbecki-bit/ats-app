// One application as the caller may see it (ats-project-scope.md V2, V4,
// V6, V9; tech-stack.md T5): the same read model as the page. The full view
// for Admins, Recruiters and Hiring Managers in V3a, the V6 allowlist for an
// Interviewer in V5. 404 outside the caller's scope.
import { getApplicationView } from "@/server/applications/views";
import { withPermission } from "@/server/policy/guards";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withPermission("application.read", async (_request, user, context: RouteContext<"/api/applications/[id]">) => {
  const { id } = await context.params;
  const view = await getApplicationView(user, id);
  if (!view) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json(view, { headers: { "Cache-Control": "no-store" } });
});
