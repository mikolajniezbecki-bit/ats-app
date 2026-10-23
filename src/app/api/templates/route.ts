// Template picker (ats-project-scope.md §5.1, §5.4): active templates of one
// type; `bulk=true` lists the bulk-email templates (no trigger status).
import { withPermission } from "@/server/policy/guards";
import { listActiveTemplates, templatePickerQuerySchema } from "@/server/templates";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withPermission("templates.pick", async (request) => {
  const params = new URL(request.url).searchParams;
  const parsed = templatePickerQuerySchema.safeParse({ type: params.get("type") ?? undefined, bulk: params.get("bulk") ?? undefined });
  if (!parsed.success || (parsed.data.bulk === "true" && parsed.data.type !== "EMAIL")) {
    return Response.json({ error: "invalid" }, { status: 400 });
  }
  return Response.json({ templates: await listActiveTemplates({ type: parsed.data.type, bulk: parsed.data.bulk === "true" }) });
});
