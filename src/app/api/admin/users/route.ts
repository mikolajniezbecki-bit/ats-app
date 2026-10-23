// Admin users API (ats-project-scope.md §5.1): POST creates a user.
import { withTransaction } from "@/server/db";
import { withPermission } from "@/server/policy/guards";
import { createUser } from "@/server/users";
import { userResponse } from "./response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withPermission("users.manage", async (request, admin) => {
  const body: unknown = await request.json().catch(() => undefined);
  return userResponse(await withTransaction((tx) => createUser(tx, admin.id, body)), 201);
});
