// Resume a requisition on hold (L5): `{ version, comment? }`.
import { withTransaction } from "@/server/db";
import { withPermission } from "@/server/policy/guards";
import { runLifecycleAction } from "@/server/requisitions/lifecycle";
import { requisitionResponse } from "../../response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withPermission("requisition.manage", async (request, user, context: RouteContext<"/api/requisitions/[id]/resume">) => {
  const { id } = await context.params;
  const body: unknown = await request.json().catch(() => undefined);
  return requisitionResponse(await withTransaction((tx) => runLifecycleAction(tx, user, id, "resume", body)));
});
