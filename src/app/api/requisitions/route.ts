// Requisitions API (ats-project-scope.md §5.2, V2, V3a, V9): GET lists the
// requisitions the caller may see (one page, optional state filter); POST
// creates a draft.
import { withTransaction } from "@/server/db";
import { withPermission } from "@/server/policy/guards";
import { createRequisition, listQuerySchema, listRequisitions } from "@/server/requisitions";
import { requisitionResponse } from "./response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withPermission("requisition.read", async (request, user) => {
  const params = new URL(request.url).searchParams;
  const parsed = listQuerySchema.safeParse({ state: params.get("state") ?? undefined, page: params.get("page") ?? undefined });
  if (!parsed.success) return Response.json({ error: "invalid" }, { status: 400 });
  return Response.json(await listRequisitions(user, parsed.data));
});

export const POST = withPermission("requisition.create", async (request, user) => {
  const body: unknown = await request.json().catch(() => undefined);
  return requisitionResponse(await withTransaction((tx) => createRequisition(tx, user, body)), 201);
});
