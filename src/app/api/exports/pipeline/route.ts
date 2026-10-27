// The pipeline data as CSV (ats-project-scope.md §5.9, V10): Admin and
// Recruiter (`export.reports`), without candidate contact data (task 41
// Q3). GET: it changes nothing and writes no audit row (Q4).
import { exportPipeline } from "@/server/exports/reports";
import { logger } from "@/server/logger";
import { withPermission } from "@/server/policy/guards";
import { csvResponse } from "../csv-response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withPermission("export.reports", async (_request, user) => {
  const result = await exportPipeline(user);
  logger.info({ user_id: user.id, row_count: result.rowCount }, "pipeline exported");
  return csvResponse(result);
});
