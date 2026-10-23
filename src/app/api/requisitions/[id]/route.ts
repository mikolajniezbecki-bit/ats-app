// One requisition (ats-project-scope.md §5.2, V3a, V9; tech-stack.md D7): GET
// returns it when the caller may see it (404 otherwise, so IDs can't be
// probed); PATCH edits a draft with the version the caller loaded.
import { withTransaction } from "@/server/db";
import { withPermission } from "@/server/policy/guards";
import { findVisibleRequisition, updateRequisition } from "@/server/requisitions";
import { requisitionResponse } from "../response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = RouteContext<"/api/requisitions/[id]">;

export const GET = withPermission("requisition.read", async (_request, user, context: Context) => {
  const { id } = await context.params;
  const requisition = await findVisibleRequisition(user, id);
  return requisition ? Response.json({ requisition }) : requisitionResponse({ ok: false, reason: "notFound" });
});

export const PATCH = withPermission("requisition.edit", async (request, user, context: Context) => {
  const { id } = await context.params;
  const body: unknown = await request.json().catch(() => undefined);
  return requisitionResponse(await withTransaction((tx) => updateRequisition(tx, user, id, body)));
});
