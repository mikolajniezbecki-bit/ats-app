// Reassign a pending approval (ats-project-scope.md A4, A2, A7, E7): a
// Recruiter or an Admin; `{ approverId, reason, version }`.
import { withTransaction } from "@/server/db";
import { reassignRequisition } from "@/server/approvals";
import { withPermission } from "@/server/policy/guards";
import { requisitionResponse } from "../../response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withPermission("approval.reassign", async (request, user, context: RouteContext<"/api/requisitions/[id]/reassign">) => {
  const { id } = await context.params;
  const body: unknown = await request.json().catch(() => undefined);
  return requisitionResponse(await withTransaction((tx) => reassignRequisition(tx, user, id, body)));
});
