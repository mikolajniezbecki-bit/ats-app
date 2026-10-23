// Admin users API (ats-project-scope.md §5.1): PATCH changes role or name.
import { withTransaction } from "@/server/db";
import { withPermission } from "@/server/policy/guards";
import { updateUser } from "@/server/users";
import { userResponse } from "../response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const PATCH = withPermission("users.manage", async (request, admin, context: RouteContext<"/api/admin/users/[id]">) => {
  const { id } = await context.params;
  const body: unknown = await request.json().catch(() => undefined);
  return userResponse(await withTransaction((tx) => updateUser(tx, admin.id, id, body)));
});
