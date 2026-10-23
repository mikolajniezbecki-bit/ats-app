// Withdraw a pending submission (ats-project-scope.md A9, A7): the
// submitter, a Recruiter or an Admin; `{ version, comment? }`.
import { withTransaction } from "@/server/db";
import { withdrawRequisition } from "@/server/approvals";
import { withPermission } from "@/server/policy/guards";
import { requisitionResponse } from "../../response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withPermission("approval.withdraw", async (request, user, context: RouteContext<"/api/requisitions/[id]/withdraw">) => {
  const { id } = await context.params;
  const body: unknown = await request.json().catch(() => undefined);
  return requisitionResponse(await withTransaction((tx) => withdrawRequisition(tx, user, id, body)));
});
