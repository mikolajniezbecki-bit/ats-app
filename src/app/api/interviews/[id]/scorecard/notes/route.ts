// PDF notes of the caller's scorecard draft (ats-project-scope.md I9, F1–F3):
// PUT multipart with one `notes` file replaces them, DELETE removes them. The
// replaced blob is deleted after the commit (Q6).
import { message } from "@/server/messages";
import { withTransaction } from "@/server/db";
import { PdfRejectedError } from "@/server/files/store-pdf";
import { withPermission } from "@/server/policy/guards";
import { type NotesResult, deleteReplacedNotes, setScorecardNotes } from "@/server/scorecards";
import { scorecardError } from "../../../../scorecards/response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function respond(run: () => Promise<NotesResult>): Promise<Response> {
  let result: NotesResult;
  try {
    result = await run();
  } catch (err) {
    if (!(err instanceof PdfRejectedError)) throw err;
    const text = message(`Files.errors.${err.code}`, { max: String(err.maxMb) });
    return Response.json({ error: "invalid", message: text, fields: { notes: text } }, { status: 400 });
  }
  if (!result.ok) return scorecardError(result.reason);
  await deleteReplacedNotes(result.replacedKeys);
  return Response.json({ fileId: result.fileId });
}

export const PUT = withPermission("staff.area", async (request, user, context: RouteContext<"/api/interviews/[id]/scorecard/notes">) => {
  const { id } = await context.params;
  const form = await request.formData().catch(() => null);
  const file = form?.get("notes");
  if (!(file instanceof File)) {
    return Response.json({ error: "invalid", message: message("Files.errors.EMPTY"), fields: { notes: message("Files.errors.EMPTY") } }, { status: 400 });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  return respond(() => withTransaction((tx) => setScorecardNotes(tx, user, id, { bytes, originalName: file.name || null })));
});

export const DELETE = withPermission("staff.area", async (_request, user, context: RouteContext<"/api/interviews/[id]/scorecard/notes">) => {
  const { id } = await context.params;
  return respond(() => withTransaction((tx) => setScorecardNotes(tx, user, id, null)));
});
