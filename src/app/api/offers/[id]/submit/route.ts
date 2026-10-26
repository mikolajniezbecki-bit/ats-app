// Submit an offer for approval (ats-project-scope.md A1, A2, L8): Admin and
// Recruiter; `{ approverId, version }`.
import { withTransaction } from "@/server/db";
import { submitOffer } from "@/server/approvals/offers";
import { withPermission } from "@/server/policy/guards";
import { offerResponse } from "../../response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withPermission("offer.manage", async (request, user, context: RouteContext<"/api/offers/[id]/submit">) => {
  const { id } = await context.params;
  const body: unknown = await request.json().catch(() => undefined);
  return offerResponse(await withTransaction((tx) => submitOffer(tx, user, id, body)));
});
