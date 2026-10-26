// Create an offer (ats-project-scope.md §5.6, R10, L8): Admin and Recruiter;
// `{ jobTitle, salary, currency, startDate, templateId }`. 201 with the offer.
import { withTransaction } from "@/server/db";
import { createOffer } from "@/server/offers";
import { withPermission } from "@/server/policy/guards";
import { offerResponse } from "../../../offers/response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withPermission("offer.manage", async (request, user, context: RouteContext<"/api/applications/[id]/offers">) => {
  const { id } = await context.params;
  const body: unknown = await request.json().catch(() => undefined);
  return offerResponse(await withTransaction((tx) => createOffer(tx, user, id, body)), 201);
});
