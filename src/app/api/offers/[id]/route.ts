// Edit an offer (ats-project-scope.md §5.6): Admin and Recruiter;
// `{ version, jobTitle?, salary?, currency?, startDate?, templateId? }`.
import { withTransaction } from "@/server/db";
import { updateOffer } from "@/server/offers";
import { withPermission } from "@/server/policy/guards";
import { offerResponse } from "../response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const PATCH = withPermission("offer.manage", async (request, user, context: RouteContext<"/api/offers/[id]">) => {
  const { id } = await context.params;
  const body: unknown = await request.json().catch(() => undefined);
  return offerResponse(await withTransaction((tx) => updateOffer(tx, user, id, body)));
});
