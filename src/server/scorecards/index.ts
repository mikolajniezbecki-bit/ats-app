// Scorecards (ats-project-scope.md I9, I10, V7, V8, TO-20; tech-stack.md D3,
// D6, M2): each participant writes one scorecard per interview, saves it as
// a draft and submits it; an Admin can reopen a submitted one. Every write
// re-checks I9 under locks taken in the order the status service uses
// (application, then interview, then scorecard), so a submit racing a
// rejection or a reopen has one outcome. Reads go through
// scopeScorecardsFor() (V7). Logs carry IDs only, never ratings or comments.
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { type Db, type Tx, getDb } from "../db";
import { applications, auditLog, files, interviewParticipants, interviewScorecards, interviews, requisitions, users } from "../db/schema";
import { MAX_COMMENTS_LENGTH, MAX_RATING, MIN_RATING, type WriteRefusal, writeRefusal } from "../domain/scorecards";
import { isOpenStatus } from "../domain/pipeline";
import { storePdf } from "../files/store-pdf";
import { getStorage } from "../adapters/storage";
import { logger } from "../logger";
import { scopeApplicationsFor, scopeScorecardsFor, participatesIn } from "../policy/filters";
import type { PolicyUser } from "../policy/permissions";

export type ScorecardRow = typeof interviewScorecards.$inferSelect;
export type ScorecardError = "invalid" | "notFound" | "forbidden" | "stale" | "notSubmitted" | "applicationFinal" | WriteRefusal;
export type ScorecardResult = { ok: true; scorecard: ScorecardRow } | { ok: false; reason: ScorecardError; fields?: Record<string, string> };

const fieldsSchema = z
  .object({
    thumbsUp: z.boolean({ error: "thumbsRequired" }),
    overallRating: z.number({ error: "ratingRequired" }).int("ratingRequired").min(MIN_RATING, "ratingRequired").max(MAX_RATING, "ratingRequired"),
    comments: z.string().max(MAX_COMMENTS_LENGTH, "commentsTooLong").optional(),
  })
  .strict();

function zodFields(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") for (const key of issue.keys) fields[key] = "invalid";
    else {
      const field = String(issue.path[0] ?? "_");
      fields[field] ??= field === "thumbsUp" ? "thumbsRequired" : field === "overallRating" ? "ratingRequired" : field === "comments" ? "commentsTooLong" : "invalid";
    }
  }
  return fields;
}

type Locked = {
  interview: typeof interviews.$inferSelect;
  application: { id: string; status: string; anonymizedAt: Date | null };
  participant: { active: boolean; removed: boolean } | undefined;
  scorecard: ScorecardRow | undefined;
};

/**
 * Locks the application (FOR SHARE), the interview (FOR SHARE) and the
 * caller's scorecard (FOR UPDATE) and loads what I9 needs. Undefined for an
 * unknown interview.
 */
async function lockForWrite(tx: Tx, user: PolicyUser, interviewId: string): Promise<Locked | undefined> {
  if (!z.uuid().safeParse(interviewId).success) return undefined;
  const [found] = await tx.select({ applicationId: interviews.applicationId }).from(interviews).where(eq(interviews.id, interviewId));
  if (!found) return undefined;
  const [application] = await tx
    .select({ id: applications.id, status: applications.status, anonymizedAt: applications.anonymizedAt })
    .from(applications)
    .where(eq(applications.id, found.applicationId))
    .for("share");
  const [interview] = await tx.select().from(interviews).where(eq(interviews.id, interviewId)).for("share");
  const [participant] = await tx
    .select({ removedAt: interviewParticipants.removedAt, isActive: users.isActive })
    .from(interviewParticipants)
    .innerJoin(users, eq(users.id, interviewParticipants.userId))
    .where(and(eq(interviewParticipants.interviewId, interviewId), eq(interviewParticipants.userId, user.id)));
  const [scorecard] = await tx
    .select()
    .from(interviewScorecards)
    .where(and(eq(interviewScorecards.interviewId, interviewId), eq(interviewScorecards.interviewerId, user.id)))
    .for("update");
  return {
    interview,
    application,
    participant: participant ? { active: participant.isActive && user.isActive !== false, removed: participant.removedAt !== null } : undefined,
    scorecard,
  };
}

function refusal(locked: Locked, now: Date): ScorecardError | undefined {
  const reason = writeRefusal({
    participant: locked.participant,
    interview: locked.interview,
    applicationOpen: isOpenStatus(locked.application.status) && locked.application.anonymizedAt === null,
    scorecard: locked.scorecard,
    now,
  });
  // Non-participants (also Recruiters and Admins who aren't on the panel) get 403.
  return reason === "notParticipant" ? "forbidden" : reason;
}

/**
 * Saves the caller's draft (I9, Q1): creates it on the first save, updates
 * it afterwards. Thumbs and rating are required here too, because the
 * columns are NOT NULL (§7).
 */
export async function saveScorecardDraft(tx: Tx, user: PolicyUser, interviewId: string, input: unknown, now = new Date()): Promise<ScorecardResult> {
  const locked = await lockForWrite(tx, user, interviewId);
  if (!locked) return { ok: false, reason: "notFound" };
  const refused = refusal(locked, now);
  if (refused) return { ok: false, reason: refused };
  const parsed = fieldsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid", fields: zodFields(parsed.error) };
  const values = { thumbsUp: parsed.data.thumbsUp, overallRating: parsed.data.overallRating, comments: parsed.data.comments?.trim() || null };

  const [scorecard] = locked.scorecard
    ? await tx
        .update(interviewScorecards)
        .set({ ...values, updatedAt: now })
        .where(and(eq(interviewScorecards.id, locked.scorecard.id), sql`${interviewScorecards.submittedAt} is null`))
        .returning()
    : await tx
        .insert(interviewScorecards)
        .values({ interviewId, interviewerId: user.id, ...values })
        // The unique (interview, interviewer) pair: a concurrent first save updates the same draft.
        .onConflictDoUpdate({ target: [interviewScorecards.interviewId, interviewScorecards.interviewerId], set: { ...values, updatedAt: now }, setWhere: sql`${interviewScorecards.submittedAt} is null` })
        .returning();
  if (!scorecard) return { ok: false, reason: "submitted" };
  logger.info({ scorecard_id: scorecard.id, interview_id: interviewId, user_id: user.id }, "scorecard draft saved");
  return { ok: true, scorecard };
}

/**
 * Saves and submits the caller's scorecard (I9, V8): `submitted_at` is set
 * with `WHERE submitted_at IS NULL`, so a double submit has one outcome.
 * `reopened_at` stays as history.
 */
export async function submitScorecard(tx: Tx, user: PolicyUser, interviewId: string, input: unknown, now = new Date()): Promise<ScorecardResult> {
  const saved = await saveScorecardDraft(tx, user, interviewId, input, now);
  if (!saved.ok) return saved;
  const [scorecard] = await tx
    .update(interviewScorecards)
    .set({ submittedAt: now, updatedAt: now })
    .where(and(eq(interviewScorecards.id, saved.scorecard.id), sql`${interviewScorecards.submittedAt} is null`))
    .returning();
  if (!scorecard) return { ok: false, reason: "submitted" };
  logger.info({ scorecard_id: scorecard.id, interview_id: interviewId, user_id: user.id }, "scorecard submitted");
  return { ok: true, scorecard };
}

/**
 * V8, Q2: an Admin reopens a submitted scorecard so its author can change
 * it: `reopened_at = now`, `submitted_at = NULL`, audited with the ID only.
 * Refused when the application is final, because it couldn't be submitted
 * again.
 */
export async function reopenScorecard(tx: Tx, admin: PolicyUser, scorecardId: string, now = new Date()): Promise<ScorecardResult> {
  if (!z.uuid().safeParse(scorecardId).success) return { ok: false, reason: "notFound" };
  const [found] = await tx
    .select({ applicationId: interviews.applicationId })
    .from(interviewScorecards)
    .innerJoin(interviews, eq(interviews.id, interviewScorecards.interviewId))
    .where(eq(interviewScorecards.id, scorecardId));
  if (!found) return { ok: false, reason: "notFound" };
  const [application] = await tx
    .select({ status: applications.status, anonymizedAt: applications.anonymizedAt })
    .from(applications)
    .where(eq(applications.id, found.applicationId))
    .for("share");
  const [current] = await tx.select().from(interviewScorecards).where(eq(interviewScorecards.id, scorecardId)).for("update");
  if (!isOpenStatus(application.status) || application.anonymizedAt) return { ok: false, reason: "applicationFinal" };
  if (!current.submittedAt) return { ok: false, reason: "notSubmitted" };
  const [scorecard] = await tx
    .update(interviewScorecards)
    .set({ submittedAt: null, reopenedAt: now, updatedAt: now })
    .where(eq(interviewScorecards.id, scorecardId))
    .returning();
  await tx.insert(auditLog).values({ actorUserId: admin.id, action: "SCORECARD_REOPENED", subjectType: "SCORECARD", subjectId: scorecardId, detailsJson: {} });
  logger.info({ scorecard_id: scorecardId, user_id: admin.id }, "scorecard reopened");
  return { ok: true, scorecard };
}

export type NotesResult = { ok: true; fileId: string | null; replacedKeys: string[] } | { ok: false; reason: ScorecardError | "noDraft" };

/** The live notes file of a scorecard, if any. */
async function currentNotes(tx: Tx | Db, scorecardId: string) {
  return tx
    .select({ id: files.id, storageKey: files.storageKey })
    .from(files)
    .where(and(eq(files.ownerType, "SCORECARD"), eq(files.ownerId, scorecardId), eq(files.kind, "INTERVIEW_NOTES"), isNull(files.deletedAt)));
}

/** Q6: marks the current notes deleted; returns their blob keys for deleteReplacedNotes() after the commit. */
async function dropNotes(tx: Tx, scorecardId: string, now: Date): Promise<string[]> {
  const old = await currentNotes(tx, scorecardId);
  if (old.length > 0) await tx.update(files).set({ deletedAt: now }).where(inArray(files.id, old.map((file) => file.id)));
  return old.map((file) => file.storageKey);
}

/**
 * Deletes replaced notes blobs; call it after the transaction committed, so
 * a rollback never leaves a live row without its blob. A failure only
 * leaves an orphaned blob (logged by key, never by name).
 */
export async function deleteReplacedNotes(keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    try {
      await getStorage().delete(key);
    } catch (err) {
      logger.warn({ storage_key: key, err: { message: (err as Error).message } }, "replaced notes blob not deleted");
    }
  }
}

/**
 * Attaches (or with `bytes` null removes) the PDF notes of the caller's
 * draft (I9, F1–F3, Q6). Throws PdfRejectedError for an invalid file.
 */
export async function setScorecardNotes(
  tx: Tx,
  user: PolicyUser,
  interviewId: string,
  upload: { bytes: Uint8Array; originalName: string | null } | null,
  now = new Date(),
): Promise<NotesResult> {
  const locked = await lockForWrite(tx, user, interviewId);
  if (!locked) return { ok: false, reason: "notFound" };
  const refused = refusal(locked, now);
  if (refused) return { ok: false, reason: refused };
  if (!locked.scorecard) return { ok: false, reason: "noDraft" };
  const replacedKeys = await dropNotes(tx, locked.scorecard.id, now);
  if (!upload) return { ok: true, fileId: null, replacedKeys };
  const file = await storePdf(tx, { ownerType: "SCORECARD", ownerId: locked.scorecard.id, kind: "INTERVIEW_NOTES", originalName: upload.originalName, bytes: upload.bytes });
  logger.info({ scorecard_id: locked.scorecard.id, file_id: file.id }, "scorecard notes stored");
  return { ok: true, fileId: file.id, replacedKeys };
}

export type ScorecardView = {
  id: string;
  interviewId: string;
  interviewStartsAtUtc: Date;
  interviewerId: string;
  interviewer: string;
  thumbsUp: boolean;
  overallRating: number;
  comments: string | null;
  submittedAt: Date | null;
  reopenedAt: Date | null;
  notesFileId: string | null;
  own: boolean;
};

/**
 * Who may read an application's scorecards at all: Admins and Recruiters
 * (V1, V2) for any application; anyone else only as a current participant
 * of a non-cancelled interview on it while it is open (V5). Otherwise the
 * caller gets 404 (V9).
 */
export async function canReadScorecardsOf(user: PolicyUser, applicationId: string, db: Db | Tx = getDb()): Promise<boolean> {
  if (!z.uuid().safeParse(applicationId).success) return false;
  const broad = user.role === "ADMIN" || user.role === "RECRUITER";
  const [row] = await db
    .select({ id: applications.id })
    .from(applications)
    .where(and(eq(applications.id, applicationId), broad ? scopeApplicationsFor(user) : participatesIn(user, sql`${applications.id}`)));
  return row !== undefined;
}

/**
 * The scorecards of an application `user` may see (V7): submitted ones in
 * scope plus the caller's own draft; other people's drafts never. Oldest
 * interview first.
 */
export async function listApplicationScorecards(user: PolicyUser, applicationId: string, db: Db | Tx = getDb()): Promise<ScorecardView[]> {
  const rows = await db
    .select({
      id: interviewScorecards.id,
      interviewId: interviewScorecards.interviewId,
      interviewStartsAtUtc: interviews.startsAtUtc,
      interviewerId: interviewScorecards.interviewerId,
      interviewer: users.name,
      thumbsUp: interviewScorecards.thumbsUp,
      overallRating: interviewScorecards.overallRating,
      comments: interviewScorecards.comments,
      submittedAt: interviewScorecards.submittedAt,
      reopenedAt: interviewScorecards.reopenedAt,
    })
    .from(interviewScorecards)
    .innerJoin(interviews, eq(interviews.id, interviewScorecards.interviewId))
    .innerJoin(users, eq(users.id, interviewScorecards.interviewerId))
    .where(
      and(
        eq(interviews.applicationId, applicationId),
        scopeScorecardsFor(user),
        or(isNotNull(interviewScorecards.submittedAt), eq(interviewScorecards.interviewerId, user.id)),
      ),
    )
    .orderBy(asc(interviews.startsAtUtc), asc(users.name));
  const notes = rows.length
    ? await db
        .select({ ownerId: files.ownerId, id: files.id })
        .from(files)
        .where(and(eq(files.ownerType, "SCORECARD"), eq(files.kind, "INTERVIEW_NOTES"), isNull(files.deletedAt), inArray(files.ownerId, rows.map((row) => row.id))))
    : [];
  return rows.map((row) => ({ ...row, notesFileId: notes.find((file) => file.ownerId === row.id)?.id ?? null, own: row.interviewerId === user.id }));
}

/**
 * The scorecard page (I9): the interview, the job, the candidate and the
 * caller's own scorecard. Undefined (404, V9) unless the caller still has
 * participant access (V5, V8): a current participant of a non-cancelled
 * interview on an open, not anonymized application.
 */
export async function getScorecardPage(user: PolicyUser, interviewId: string, db: Db = getDb()) {
  if (!z.uuid().safeParse(interviewId).success) return undefined;
  const [row] = await db
    .select({
      interview: interviews,
      jobTitle: requisitions.title,
      firstName: applications.firstName,
      lastName: applications.lastName,
      anonymizedAt: applications.anonymizedAt,
      applicationStatus: applications.status,
      removedAt: interviewParticipants.removedAt,
    })
    .from(interviews)
    .innerJoin(applications, eq(applications.id, interviews.applicationId))
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .innerJoin(interviewParticipants, and(eq(interviewParticipants.interviewId, interviews.id), eq(interviewParticipants.userId, user.id)))
    .where(and(eq(interviews.id, interviewId), isNull(interviewParticipants.removedAt)));
  if (!row || row.interview.status === "CANCELLED" || !isOpenStatus(row.applicationStatus) || row.anonymizedAt) return undefined;
  const [scorecard] = await db
    .select()
    .from(interviewScorecards)
    .where(and(eq(interviewScorecards.interviewId, interviewId), eq(interviewScorecards.interviewerId, user.id)));
  const [notes] = scorecard ? await currentNotes(db, scorecard.id) : [];
  const refused = writeRefusal({
    participant: { active: user.isActive !== false, removed: false },
    interview: row.interview,
    applicationOpen: isOpenStatus(row.applicationStatus) && row.anonymizedAt === null,
    scorecard,
    now: new Date(),
  });
  return {
    interview: row.interview,
    jobTitle: row.jobTitle,
    candidate: `${row.firstName} ${row.lastName}`,
    scorecard: scorecard ?? null,
    notesFileId: notes?.id ?? null,
    refusal: refused,
  };
}
