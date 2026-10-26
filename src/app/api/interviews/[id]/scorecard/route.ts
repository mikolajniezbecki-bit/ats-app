// Save the caller's scorecard draft (ats-project-scope.md I9, V8):
// `{ thumbsUp, overallRating, comments? }`. Any signed-in staff user; the
// service checks participation, the interview, the application and the lock.
import { withTransaction } from "@/server/db";
import { withPermission } from "@/server/policy/guards";
import { saveScorecardDraft } from "@/server/scorecards";
import { scorecardResponse } from "../../../scorecards/response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const PUT = withPermission("staff.area", async (request, user, context: RouteContext<"/api/interviews/[id]/scorecard">) => {
  const { id } = await context.params;
  const body: unknown = await request.json().catch(() => undefined);
  return scorecardResponse(await withTransaction((tx) => saveScorecardDraft(tx, user, id, body)));
});
