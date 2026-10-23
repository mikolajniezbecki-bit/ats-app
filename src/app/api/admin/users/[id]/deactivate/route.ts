// POST /api/admin/users/[id]/deactivate (§5.1, AU5): deactivates the user and
// deletes their sessions in one transaction.
import { withTransaction } from "@/server/db";
import { withPermission } from "@/server/policy/guards";
import { deactivateUser } from "@/server/users";
import { userResponse } from "../../response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withPermission(
  "users.manage",
  async (_request, admin, context: RouteContext<"/api/admin/users/[id]/deactivate">) => {
    const { id } = await context.params;
    return userResponse(await withTransaction((tx) => deactivateUser(tx, admin.id, id)));
  },
);
