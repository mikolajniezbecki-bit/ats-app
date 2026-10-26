// Reschedule or change participants (ats-project-scope.md I3, I5): Admin and
// Recruiter; `{ expectedSequence, startLocal?, timezone?, durationMinutes?,
// locationOrLink?, participantIds? }`.
import { withTransaction } from "@/server/db";
import { updateInterview } from "@/server/interviews";
import { withPermission } from "@/server/policy/guards";
import { interviewResponse } from "../response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const PATCH = withPermission("interview.manage", async (request, user, context: RouteContext<"/api/interviews/[id]">) => {
  const { id } = await context.params;
  const body: unknown = await request.json().catch(() => undefined);
  return interviewResponse(await withTransaction((tx) => updateInterview(tx, user, id, body)));
});
