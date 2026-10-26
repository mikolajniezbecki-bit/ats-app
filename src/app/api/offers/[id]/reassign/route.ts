// Reassign a pending offer approval (ats-project-scope.md A4): a Recruiter or
// an Admin; `{ approverId, reason, version }`.
import { withTransaction } from "@/server/db";
import { reassignOffer } from "@/server/approvals/offers";
import { withPermission } from "@/server/policy/guards";
import { offerResponse } from "../../response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withPermission("approval.reassign", async (request, user, context: RouteContext<"/api/offers/[id]/reassign">) => {
  const { id } = await context.params;
  const body: unknown = await request.json().catch(() => undefined);
  return offerResponse(await withTransaction((tx) => reassignOffer(tx, user, id, body)));
});
