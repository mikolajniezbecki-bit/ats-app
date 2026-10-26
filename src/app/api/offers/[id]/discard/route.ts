// Discard an offer (ats-project-scope.md §5.6 Discard offer): Admin and
// Recruiter; `{ version }`. A draft or rejected offer becomes WITHDRAWN.
import { withTransaction } from "@/server/db";
import { discardOffer } from "@/server/offers";
import { withPermission } from "@/server/policy/guards";
import { offerResponse } from "../../response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withPermission("offer.manage", async (request, user, context: RouteContext<"/api/offers/[id]/discard">) => {
  const { id } = await context.params;
  const body: unknown = await request.json().catch(() => undefined);
  return offerResponse(await withTransaction((tx) => discardOffer(tx, user, id, body)));
});
