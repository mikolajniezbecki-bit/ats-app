// Pre-screening questions of a requisition (ats-project-scope.md §5.3, L3,
// L8, V4, V6): GET lists them in order for those who may read the
// requisition (404 outside their scope); POST adds one.
import { withTransaction } from "@/server/db";
import { withPermission } from "@/server/policy/guards";
import { createQuestion, listQuestions } from "@/server/prescreen";
import { questionResponse } from "./response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = RouteContext<"/api/requisitions/[id]/questions">;

export const GET = withPermission("requisition.read", async (_request, user, context: Context) => {
  const { id } = await context.params;
  return questionResponse(await listQuestions(user, id));
});

export const POST = withPermission("requisition.edit", async (request, user, context: Context) => {
  const { id } = await context.params;
  const body: unknown = await request.json().catch(() => undefined);
  return questionResponse(await withTransaction((tx) => createQuestion(tx, user, id, body)), 201);
});
