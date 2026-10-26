// Cancel an interview (ats-project-scope.md I4): Admin and Recruiter;
// `{ expectedSequence }`.
import { withTransaction } from "@/server/db";
import { cancelInterview } from "@/server/interviews";
import { withPermission } from "@/server/policy/guards";
import { interviewResponse } from "../../response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withPermission("interview.manage", async (request, user, context: RouteContext<"/api/interviews/[id]/cancel">) => {
  const { id } = await context.params;
  const body: unknown = await request.json().catch(() => undefined);
  return interviewResponse(await withTransaction((tx) => cancelInterview(tx, user, id, body)));
});
