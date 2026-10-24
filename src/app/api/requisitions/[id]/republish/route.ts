// Republish an approved requisition (L9): `{ version }`.
import { withTransaction } from "@/server/db";
import { withPermission } from "@/server/policy/guards";
import { runLifecycleAction } from "@/server/requisitions/lifecycle";
import { requisitionResponse } from "../../response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withPermission("requisition.publish", async (request, user, context: RouteContext<"/api/requisitions/[id]/republish">) => {
  const { id } = await context.params;
  const body: unknown = await request.json().catch(() => undefined);
  return requisitionResponse(await withTransaction((tx) => runLifecycleAction(tx, user, id, "republish", body)));
});
