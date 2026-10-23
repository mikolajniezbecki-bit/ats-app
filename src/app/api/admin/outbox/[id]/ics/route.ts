// GET /api/admin/outbox/[id]/ics (tech-stack.md §9): the stored `.ics` of a
// logged email, as a download. Admin only.
import { getOutboxIcs } from "@/server/email/outbox";
import { withPermission } from "@/server/policy/guards";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withPermission("outbox.view", async (_request, _user, context: RouteContext<"/api/admin/outbox/[id]/ics">) => {
  const { id } = await context.params;
  const ics = await getOutboxIcs(id);
  if (!ics) return Response.json({ error: "not_found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  return new Response(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="invite-${id}.ics"`,
      "Cache-Control": "no-store",
    },
  });
});
