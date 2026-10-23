// POST /api/admin/users/[id]/reactivate (§5.1): lets a deactivated user sign in again.
import { withTransaction } from "@/server/db";
import { withPermission } from "@/server/policy/guards";
import { reactivateUser } from "@/server/users";
import { userResponse } from "../../response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withPermission(
  "users.manage",
  async (_request, admin, context: RouteContext<"/api/admin/users/[id]/reactivate">) => {
    const { id } = await context.params;
    return userResponse(await withTransaction((tx) => reactivateUser(tx, admin.id, id)));
  },
);
