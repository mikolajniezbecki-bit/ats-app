// GET /api/files/[id]/url (ats-project-scope.md F5, V11): a 5-minute signed
// link to one PDF, issued after the policy check. The PDF itself is never
// streamed through the app (tech-stack.md §8).
import { issueFileLink } from "@/server/files/links";
import { withPermission } from "@/server/policy/guards";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

export const GET = withPermission("file.view", async (_request, user, context: RouteContext<"/api/files/[id]/url">) => {
  const { id } = await context.params;
  const result = await issueFileLink(user, id);
  switch (result.status) {
    case "ok":
      return Response.json({ url: result.link.url, expiresAt: result.link.expiresAt.toISOString() }, { headers: NO_STORE });
    case "forbidden":
      return Response.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
    case "not-found":
      return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  }
});
