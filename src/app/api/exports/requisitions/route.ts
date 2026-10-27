// The requisition list as CSV (ats-project-scope.md §5.9, V10): Admin and
// Recruiter (`export.reports`). GET: it changes nothing and writes no audit
// row (task 41 Q4).
import { exportRequisitions } from "@/server/exports/reports";
import { logger } from "@/server/logger";
import { withPermission } from "@/server/policy/guards";
import { csvResponse } from "../csv-response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withPermission("export.reports", async (_request, user) => {
  const result = await exportRequisitions(user);
  logger.info({ user_id: user.id, row_count: result.rowCount }, "requisitions exported");
  return csvResponse(result);
});
