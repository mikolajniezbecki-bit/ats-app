// Reject a pending offer (ats-project-scope.md A3): its current approver;
// `{ version, comment }`.
import { withTransaction } from "@/server/db";
import { decideOffer } from "@/server/approvals/offers";
import { withPermission } from "@/server/policy/guards";
import { offerResponse } from "../../response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withPermission("approval.decide", async (request, user, context: RouteContext<"/api/offers/[id]/reject">) => {
  const { id } = await context.params;
  const body: unknown = await request.json().catch(() => undefined);
  return offerResponse(await withTransaction((tx) => decideOffer(tx, user, id, "reject", body)));
});
