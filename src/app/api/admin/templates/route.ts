// Admin templates API (ats-project-scope.md §5.1): GET lists every template,
// POST creates one.
import { withTransaction } from "@/server/db";
import { withPermission } from "@/server/policy/guards";
import { createTemplate, listTemplates } from "@/server/templates";
import { templateResponse } from "./response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withPermission("templates.manage", async () =>
  Response.json({ templates: await listTemplates({ includeInactive: true }) }),
);

export const POST = withPermission("templates.manage", async (request) => {
  const body: unknown = await request.json().catch(() => undefined);
  return templateResponse(await withTransaction((tx) => createTemplate(tx, body)), 201);
});
