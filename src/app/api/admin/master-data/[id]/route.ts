// Admin master data API (ats-project-scope.md §5.1): PATCH changes the label
// or active flag; DELETE removes a record that isn't referenced.
import { withTransaction } from "@/server/db";
import { deleteMasterData, updateMasterData } from "@/server/master-data";
import { withPermission } from "@/server/policy/guards";
import { masterDataResponse } from "../response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = RouteContext<"/api/admin/master-data/[id]">;

export const PATCH = withPermission("masterData.manage", async (request, _user, context: Context) => {
  const { id } = await context.params;
  const body: unknown = await request.json().catch(() => undefined);
  return masterDataResponse(await withTransaction((tx) => updateMasterData(tx, id, body)));
});

export const DELETE = withPermission("masterData.manage", async (_request, _user, context: Context) => {
  const { id } = await context.params;
  return masterDataResponse(await withTransaction((tx) => deleteMasterData(tx, id)));
});
