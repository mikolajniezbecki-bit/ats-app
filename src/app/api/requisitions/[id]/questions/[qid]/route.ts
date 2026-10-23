// One pre-screening question (ats-project-scope.md §5.3, L3): PATCH edits
// it, DELETE removes it while it has no answers. A question of another
// requisition is 404.
import { withTransaction } from "@/server/db";
import { withPermission } from "@/server/policy/guards";
import { deleteQuestion, updateQuestion } from "@/server/prescreen";
import { questionResponse } from "../response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = RouteContext<"/api/requisitions/[id]/questions/[qid]">;

export const PATCH = withPermission("requisition.edit", async (request, user, context: Context) => {
  const { id, qid } = await context.params;
  const body: unknown = await request.json().catch(() => undefined);
  return questionResponse(await withTransaction((tx) => updateQuestion(tx, user, id, qid, body)));
});

export const DELETE = withPermission("requisition.edit", async (_request, user, context: Context) => {
  const { id, qid } = await context.params;
  return questionResponse(await withTransaction((tx) => deleteQuestion(tx, user, id, qid)));
});
