// Withdraw an offer approval request (ats-project-scope.md A9): the submitter,
// a Recruiter or an Admin; `{ version, comment? }`.
import { withTransaction } from "@/server/db";
import { withdrawOfferRequest } from "@/server/approvals/offers";
import { withPermission } from "@/server/policy/guards";
import { offerResponse } from "../../response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withPermission("approval.withdraw", async (request, user, context: RouteContext<"/api/offers/[id]/withdraw">) => {
  const { id } = await context.params;
  const body: unknown = await request.json().catch(() => undefined);
  return offerResponse(await withTransaction((tx) => withdrawOfferRequest(tx, user, id, body)));
});
