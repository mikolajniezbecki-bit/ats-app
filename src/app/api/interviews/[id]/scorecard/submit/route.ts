// Save and submit the caller's scorecard (ats-project-scope.md I9, V8):
// `{ thumbsUp, overallRating, comments? }`; read-only afterwards.
import { withTransaction } from "@/server/db";
import { withPermission } from "@/server/policy/guards";
import { submitScorecard } from "@/server/scorecards";
import { scorecardResponse } from "../../../../scorecards/response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withPermission("staff.area", async (request, user, context: RouteContext<"/api/interviews/[id]/scorecard/submit">) => {
  const { id } = await context.params;
  const body: unknown = await request.json().catch(() => undefined);
  return scorecardResponse(await withTransaction((tx) => submitScorecard(tx, user, id, body)));
});
