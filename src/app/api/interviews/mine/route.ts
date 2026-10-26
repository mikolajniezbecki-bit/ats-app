// "My interviews" (ats-project-scope.md V5, I6; tech-stack.md T5): the
// caller's non-cancelled interviews whose application they may still read.
import { listMyInterviews } from "@/server/interviews";
import { withPermission } from "@/server/policy/guards";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withPermission("staff.area", async (_request, user) => {
  return Response.json({ interviews: await listMyInterviews(user) }, { headers: { "Cache-Control": "no-store" } });
});
