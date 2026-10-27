// Record the candidate's response (ats-project-scope.md §5.6 Response): Admin
// and Recruiter; `{ response: 'ACCEPTED' | 'DECLINED', version }`. Once, on
// the latest sent offer while the application is in Offer.
import { withTransaction } from "@/server/db";
import { recordOfferResponse } from "@/server/offers";
import { withPermission } from "@/server/policy/guards";
import { offerResponse } from "../../response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withPermission("offer.manage", async (request, user, context: RouteContext<"/api/offers/[id]/response">) => {
  const { id } = await context.params;
  const body: unknown = await request.json().catch(() => undefined);
  return offerResponse(await withTransaction((tx) => recordOfferResponse(tx, user, id, body)));
});
