// The order of a requisition's pre-screening questions (ats-project-scope.md
// §5.3): PUT takes every question ID in the new order; any other set is 400.
import { withTransaction } from "@/server/db";
import { withPermission } from "@/server/policy/guards";
import { reorderQuestions } from "@/server/prescreen";
import { questionResponse } from "../response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = RouteContext<"/api/requisitions/[id]/questions/order">;

export const PUT = withPermission("requisition.edit", async (request, user, context: Context) => {
  const { id } = await context.params;
  const body: unknown = await request.json().catch(() => undefined);
  return questionResponse(await withTransaction((tx) => reorderQuestions(tx, user, id, body)));
});
