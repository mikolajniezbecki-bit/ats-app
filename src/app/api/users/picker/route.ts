// User picker (ats-project-scope.md §5.1): active users, optionally filtered
// by one or more roles (`?role=HIRING_MANAGER&role=ADMIN` for approvers, A1).
import { withPermission } from "@/server/policy/guards";
import { listActiveUsers, pickerRolesSchema } from "@/server/users";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withPermission("users.pick", async (request) => {
  const parsed = pickerRolesSchema.safeParse(new URL(request.url).searchParams.getAll("role"));
  if (!parsed.success) return Response.json({ error: "invalid" }, { status: 400 });
  return Response.json({ users: await listActiveUsers({ roles: parsed.data }) });
});
