// Admin master data API (ats-project-scope.md §5.1): POST creates a record.
import { withTransaction } from "@/server/db";
import { createMasterData } from "@/server/master-data";
import { withPermission } from "@/server/policy/guards";
import { masterDataResponse } from "./response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withPermission("masterData.manage", async (request) => {
  const body: unknown = await request.json().catch(() => undefined);
  return masterDataResponse(await withTransaction((tx) => createMasterData(tx, body)), 201);
});
