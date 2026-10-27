// The daily retention purge (ats-project-scope.md §5.8 RT1–RT5, F8, §6;
// tech-stack.md D3, D7, J2, M2, T3). Selects final applications past
// the retention period (read once per run) in batches and anonymizes each in its own transaction:
// queued emails are cancelled first (RT4), then answers, comments, email
// content and files go, and the personal fields are cleared. Blobs are
// deleted inside the application's transaction, before it commits (task 40
// Q1): a later failure rolls the row back and the rerun repeats the
// idempotent delete. Logs carry IDs and counts only.
import { and, asc, eq, inArray, isNotNull, isNull, lt, ne, notInArray, or, sql } from "drizzle-orm";
import { type StorageService, getStorage } from "../adapters/storage";
import { type Tx, getDb, withTransaction } from "../db";
import {
  applicationHistory,
  applications,
  approvalEvents,
  auditLog,
  emailLog,
  files,
  interviewScorecards,
  interviews,
  offers,
  prescreenAnswers,
  rateLimits,
} from "../db/schema";
import { FINAL_FOR_RETENTION, isDueForPurge, retentionCutoff } from "../domain/retention";
import { logger } from "../logger";
import { cancelQueuedEmails } from "../pipeline";
import { getRetentionDays } from "../settings";

export const PURGE_BATCH_SIZE = 100;
/** §7 rate_limits: one-minute buckets, kept two hours. */
const RATE_LIMIT_KEEP_MS = 2 * 3_600_000;

export type PurgeSummary = {
  selected: number;
  anonymized: number;
  skipped: number;
  failed: number;
  filesDeleted: number;
  emailsCancelled: number;
  rateLimitRowsDeleted: number;
};

type PurgeOutcome = { anonymized: false } | { anonymized: true; filesDeleted: number; emailsCancelled: number };

/** RT2 as SQL, for the batch selection; the row lock re-checks it with isDueForPurge. */
function dueCondition(cutoff: Date) {
  return and(
    isNull(applications.anonymizedAt),
    inArray(applications.status, [...FINAL_FOR_RETENTION]),
    or(ne(applications.status, "HIRED"), isNotNull(applications.exportedAt)),
    lt(applications.dispositionedAt, cutoff),
  );
}

/** Steps 1–9 of the issue for one application, in `tx`; `{ anonymized: false }` when RT2 no longer holds. */
export async function purgeApplication(tx: Tx, applicationId: string, input: { now: Date; retentionDays: number; storage: StorageService }): Promise<PurgeOutcome> {
  const { now, retentionDays, storage } = input;
  // 1. Lock and re-check (Q2): an R3 reopen since the selection skips it.
  const [application] = await tx.select().from(applications).where(eq(applications.id, applicationId)).for("update");
  if (!application || !isDueForPurge(application, now, retentionDays)) return { anonymized: false };

  // 2. RT4, J2: before anything is anonymized, so no queued email goes out afterwards.
  const emailsCancelled = await cancelQueuedEmails(tx, applicationId);

  // 3.–6. Answers, comments, email content and offer approval comments.
  await tx.delete(prescreenAnswers).where(eq(prescreenAnswers.applicationId, applicationId));
  await tx.update(applicationHistory).set({ comment: null }).where(eq(applicationHistory.applicationId, applicationId));
  const interviewIds = tx.select({ id: interviews.id }).from(interviews).where(eq(interviews.applicationId, applicationId));
  const scorecardIds = (await tx.select({ id: interviewScorecards.id }).from(interviewScorecards).where(inArray(interviewScorecards.interviewId, interviewIds))).map(
    (row) => row.id,
  );
  if (scorecardIds.length > 0) await tx.update(interviewScorecards).set({ comments: null }).where(inArray(interviewScorecards.id, scorecardIds));
  await tx
    .update(emailLog)
    .set({ recipient: null, cc: null, subject: null, bodyRendered: null, icsContent: null, error: null })
    .where(eq(emailLog.applicationId, applicationId));
  const offerIds = (await tx.select({ id: offers.id }).from(offers).where(eq(offers.applicationId, applicationId))).map((row) => row.id);
  if (offerIds.length > 0) {
    await tx
      .update(approvalEvents)
      .set({ comment: null })
      .where(and(eq(approvalEvents.subjectType, "OFFER"), inArray(approvalEvents.subjectId, offerIds)));
  }

  // 7. F8: CVs, cover letters, scorecard notes and every offer letter version.
  const owners = [
    and(eq(files.ownerType, "APPLICATION"), eq(files.ownerId, applicationId)),
    scorecardIds.length > 0 ? and(eq(files.ownerType, "SCORECARD"), inArray(files.ownerId, scorecardIds)) : undefined,
    offerIds.length > 0 ? and(eq(files.ownerType, "OFFER"), inArray(files.ownerId, offerIds)) : undefined,
  ].filter((condition) => condition !== undefined);
  const linked = await tx
    .select({ id: files.id, storageKey: files.storageKey })
    .from(files)
    .where(and(isNull(files.deletedAt), or(...owners)))
    .for("update");
  for (const file of linked) await storage.delete(file.storageKey);
  if (linked.length > 0) {
    await tx.update(files).set({ deletedAt: now, originalName: null }).where(inArray(files.id, linked.map((file) => file.id)));
  }

  // 8. The personal fields; status, scores, timestamps and offer terms stay. D7: open pages see a stale version.
  await tx
    .update(applications)
    .set({ firstName: null, lastName: null, email: null, emailHash: null, phone: null, anonymizedAt: now, version: sql`${applications.version} + 1` })
    .where(eq(applications.id, applicationId));

  // 9. Q4: proof of the anonymization, counts only (M2).
  await tx.insert(auditLog).values({
    actorUserId: null,
    action: "APPLICATION_ANONYMIZED",
    subjectType: "APPLICATION",
    subjectId: applicationId,
    detailsJson: { filesDeleted: linked.length, emailsCancelled },
  });
  return { anonymized: true, filesDeleted: linked.length, emailsCancelled };
}

/**
 * One purge run at `now` (the tick's time, T3). Batches of 100 by
 * `dispositioned_at`, each application in its own transaction; a failed
 * application is logged with its ID, left as it was and not retried in this
 * run. Then old rate-limit rows go. Returns the counts; the caller fails the
 * run when `failed > 0`, so pg-boss retries it (RT5).
 */
export async function runRetentionPurge(input: { now: Date }, deps: { storage?: StorageService } = {}): Promise<PurgeSummary> {
  const { now } = input;
  const storage = deps.storage ?? getStorage();
  const db = getDb();
  const retentionDays = await getRetentionDays(db);
  const cutoff = retentionCutoff(now, retentionDays);
  const summary: PurgeSummary = { selected: 0, anonymized: 0, skipped: 0, failed: 0, filesDeleted: 0, emailsCancelled: 0, rateLimitRowsDeleted: 0 };
  // Every ID handled in this run, so a permanent failure or a skip can't loop.
  const seen: string[] = [];

  for (;;) {
    const batch = await db
      .select({ id: applications.id })
      .from(applications)
      .where(and(dueCondition(cutoff), seen.length > 0 ? notInArray(applications.id, seen) : undefined))
      .orderBy(asc(applications.dispositionedAt), asc(applications.id))
      .limit(PURGE_BATCH_SIZE);
    if (batch.length === 0) break;
    summary.selected += batch.length;
    for (const { id } of batch) {
      seen.push(id);
      try {
        const outcome = await withTransaction((tx) => purgeApplication(tx, id, { now, retentionDays, storage }));
        if (!outcome.anonymized) {
          summary.skipped++;
          continue;
        }
        summary.anonymized++;
        summary.filesDeleted += outcome.filesDeleted;
        summary.emailsCancelled += outcome.emailsCancelled;
      } catch (err) {
        summary.failed++;
        logger.error({ err, application_id: id }, "retention purge failed for an application");
      }
    }
  }

  const deleted = await db.delete(rateLimits).where(lt(rateLimits.windowStart, new Date(now.getTime() - RATE_LIMIT_KEEP_MS))).returning({ key: rateLimits.key });
  summary.rateLimitRowsDeleted = deleted.length;
  logger.info({ retention_days: retentionDays, ...toLogFields(summary) }, "retention purge finished");
  return summary;
}

function toLogFields(summary: PurgeSummary) {
  return {
    selected: summary.selected,
    anonymized: summary.anonymized,
    skipped: summary.skipped,
    failed: summary.failed,
    files_deleted: summary.filesDeleted,
    emails_cancelled: summary.emailsCancelled,
    rate_limit_rows_deleted: summary.rateLimitRowsDeleted,
  };
}

export class RetentionPurgeFailedError extends Error {
  constructor(readonly failed: number) {
    super(`retention purge: ${failed} application(s) failed`);
  }
}

/**
 * The daily task's run (§6 retention.purge): purge, then fail the run when
 * an application failed, after the others were processed, so pg-boss
 * retries it (RT5) and the jobs page shows FAILED. `deps` is for tests.
 */
export function retentionPurgeTask(deps: { storage?: StorageService } = {}) {
  return async ({ now }: { now: Date }): Promise<void> => {
    const summary = await runRetentionPurge({ now }, deps);
    if (summary.failed > 0) throw new RetentionPurgeFailedError(summary.failed);
  };
}
