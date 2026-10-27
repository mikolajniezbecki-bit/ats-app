// The hire CSV export (ats-project-scope.md §5.6 Hire export, V10): Admin
// and Recruiter (`export.hires`). POST only (task 39 Q1): the export marks
// hires as exported, and a GET link could be prefetched without anyone
// seeing the file; Next.js answers GET with 405. `?includeExported=true`
// adds earlier exports; any other query is a 400 and exports nothing.
import { withTransaction } from "@/server/db";
import { exportHires, hireExportQuerySchema } from "@/server/exports/hires";
import { withPermission } from "@/server/policy/guards";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withPermission("export.hires", async (request, user) => {
  const parsed = hireExportQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return Response.json({ error: "invalid" }, { status: 400 });
  const result = await withTransaction((tx) => exportHires(tx, user, parsed.data));
  return new Response(result.csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${result.filename}"`,
      "Cache-Control": "no-store",
    },
  });
});
