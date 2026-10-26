// Signed file links (ats-project-scope.md V11, F5): issued only after the
// policy check, for files that still exist and are CLEAN. Used by the API
// route and the PDF viewer, so both make the same decision. Logs carry the
// file ID only, never the link or the original name.
import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { getStorage, type SignedUrl } from "../adapters/storage";
import { getDb } from "../db";
import { files, interviewScorecards } from "../db/schema";
import { logger } from "../logger";
import { scopeScorecardsFor } from "../policy/filters";
import { type PolicyUser, can } from "../policy/permissions";

export type FileLinkResult = { status: "ok"; link: SignedUrl } | { status: "forbidden" } | { status: "not-found" };

const fileId = z.uuid();

/** V7: the scorecard is in the user's scope and is submitted or their own (drafts stay private). */
async function scorecardVisibleTo(user: PolicyUser, scorecardId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: interviewScorecards.id })
    .from(interviewScorecards)
    .where(
      and(
        eq(interviewScorecards.id, scorecardId),
        scopeScorecardsFor(user),
        or(isNotNull(interviewScorecards.submittedAt), eq(interviewScorecards.interviewerId, user.id)),
      ),
    );
  return row !== undefined;
}

/**
 * A 5-minute signed link to file `id` for `user`. Role-level denial is
 * `forbidden`; an unknown, malformed, deleted or non-CLEAN file is `not-found`.
 */
export async function issueFileLink(user: PolicyUser, id: string): Promise<FileLinkResult> {
  if (!can(user, "file.view")) return { status: "forbidden" };
  if (!fileId.safeParse(id).success) return { status: "not-found" };

  const [file] = await getDb()
    .select({ id: files.id, ownerType: files.ownerType, ownerId: files.ownerId, storageKey: files.storageKey })
    .from(files)
    .where(and(eq(files.id, id), isNull(files.deletedAt), eq(files.status, "CLEAN")));
  if (!file) return { status: "not-found" };
  // The resource-level check; later tasks add owner rules for other roles (V4, V6, V3b).
  const scorecardVisible = file.ownerType === "SCORECARD" ? await scorecardVisibleTo(user, file.ownerId) : undefined;
  if (!can(user, "file.view", { ownerType: file.ownerType, scorecardVisible })) return { status: "forbidden" };

  const link = await getStorage().getSignedUrl(file.storageKey);
  logger.info({ file_id: file.id, user_id: user.id }, "file link issued");
  return { status: "ok", link };
}
