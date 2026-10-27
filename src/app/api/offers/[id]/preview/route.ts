// Preview an offer letter (tech-stack.md P6, task 37 Q3): rendered now from
// the saved offer and its stored template, never stored, returned inline so
// the UI opens it in a new tab (frame-src stays the Blob origin, §8). 404 for
// anyone who may not read the offer; 422 naming the token on a render error.
import { previewOfferLetter } from "@/server/offers/letter";
import { withPermission } from "@/server/policy/guards";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withPermission("staff.area", async (_request, user, context: RouteContext<"/api/offers/[id]/preview">) => {
  const { id } = await context.params;
  const result = await previewOfferLetter(user, id);
  if (!result.ok && result.reason === "notFound") return Response.json({ error: "not_found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  if (!result.ok) return Response.json({ error: "render_error", message: result.message }, { status: 422, headers: { "Cache-Control": "no-store" } });
  return new Response(Buffer.from(result.bytes), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": 'inline; filename="offer-preview.pdf"', "Cache-Control": "no-store" },
  });
});
