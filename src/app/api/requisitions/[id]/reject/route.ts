// Reject a requisition's first approval (ats-project-scope.md A3, A7): only
// its current approver; `{ version, comment }`.
import { withTransaction } from "@/server/db";
import { decideRequisition } from "@/server/approvals";
import { withPermission } from "@/server/policy/guards";
import { requisitionResponse } from "../../response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withPermission("approval.decide", async (request, user, context: RouteContext<"/api/requisitions/[id]/reject">) => {
  const { id } = await context.params;
  const body: unknown = await request.json().catch(() => undefined);
  return requisitionResponse(await withTransaction((tx) => decideRequisition(tx, user, id, "reject", body)));
});
