// Master data picker (ats-project-scope.md §5.1): active records of one type,
// for the roles that fill in requisitions.
import { pickMasterData, pickerQuerySchema } from "@/server/master-data";
import { withPermission } from "@/server/policy/guards";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withPermission("masterData.pick", async (request) => {
  const params = new URL(request.url).searchParams;
  const parsed = pickerQuerySchema.safeParse({
    type: params.get("type") ?? undefined,
    picklistKey: params.get("picklistKey") ?? undefined,
  });
  if (!parsed.success) return Response.json({ error: "invalid" }, { status: 400 });
  return Response.json({ options: await pickMasterData(parsed.data) });
});
