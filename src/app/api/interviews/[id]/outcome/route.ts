// Mark an interview's outcome (ats-project-scope.md I7): Admin and
// Recruiter; `{ status: "COMPLETED" | "NO_SHOW" }`.
import { withTransaction } from "@/server/db";
import { markInterviewOutcome } from "@/server/interviews";
import { withPermission } from "@/server/policy/guards";
import { interviewResponse } from "../../response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withPermission("interview.manage", async (request, user, context: RouteContext<"/api/interviews/[id]/outcome">) => {
  const { id } = await context.params;
  const body: unknown = await request.json().catch(() => undefined);
  return interviewResponse(await withTransaction((tx) => markInterviewOutcome(tx, user, id, body)));
});
