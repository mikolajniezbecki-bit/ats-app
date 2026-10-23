// Admin templates API (ats-project-scope.md §5.1): PATCH edits a template
// (never its type or name); DELETE removes one nothing references.
import { withTransaction } from "@/server/db";
import { withPermission } from "@/server/policy/guards";
import { deleteTemplate, updateTemplate } from "@/server/templates";
import { templateResponse } from "../response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = RouteContext<"/api/admin/templates/[id]">;

export const PATCH = withPermission("templates.manage", async (request, _user, context: Context) => {
  const { id } = await context.params;
  const body: unknown = await request.json().catch(() => undefined);
  return templateResponse(await withTransaction((tx) => updateTemplate(tx, id, body)));
});

export const DELETE = withPermission("templates.manage", async (_request, _user, context: Context) => {
  const { id } = await context.params;
  return templateResponse(await withTransaction((tx) => deleteTemplate(tx, id)));
});
