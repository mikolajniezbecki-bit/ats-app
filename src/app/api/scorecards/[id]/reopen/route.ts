// Reopen a submitted scorecard (ats-project-scope.md V8): Admin only.
import { withTransaction } from "@/server/db";
import { withPermission } from "@/server/policy/guards";
import { reopenScorecard } from "@/server/scorecards";
import { scorecardResponse } from "../../response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withPermission("scorecard.reopen", async (_request, admin, context: RouteContext<"/api/scorecards/[id]/reopen">) => {
  const { id } = await context.params;
  return scorecardResponse(await withTransaction((tx) => reopenScorecard(tx, admin, id)));
});
