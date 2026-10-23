// Submit a draft for approval (ats-project-scope.md A1, A2, A7, E7):
// `{ approverId, version }`.
import { withTransaction } from "@/server/db";
import { submitRequisition } from "@/server/approvals";
import { withPermission } from "@/server/policy/guards";
import { requisitionResponse } from "../../response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withPermission("requisition.edit", async (request, user, context: RouteContext<"/api/requisitions/[id]/submit">) => {
  const { id } = await context.params;
  const body: unknown = await request.json().catch(() => undefined);
  return requisitionResponse(await withTransaction((tx) => submitRequisition(tx, user, id, body)));
});
