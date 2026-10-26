// Schedule an interview (ats-project-scope.md I1, I2, I8): Admin and
// Recruiter; `{ startLocal, timezone, durationMinutes, locationOrLink,
// participantIds }`. 201 with the interview.
import { withTransaction } from "@/server/db";
import { scheduleInterview } from "@/server/interviews";
import { withPermission } from "@/server/policy/guards";
import { interviewResponse } from "../../../interviews/response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withPermission("interview.manage", async (request, user, context: RouteContext<"/api/applications/[id]/interviews">) => {
  const { id } = await context.params;
  const body: unknown = await request.json().catch(() => undefined);
  return interviewResponse(await withTransaction((tx) => scheduleInterview(tx, user, id, body)), 201);
});
