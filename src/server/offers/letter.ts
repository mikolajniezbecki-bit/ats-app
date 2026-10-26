// The offer letter (tech-stack.md §10 P2, P6, P7; ats-project-scope.md §5.6
// Letter, A8; task 37 Q1, Q4, Q5, Q8, Q9, Q11): the offer token values, the
// on-demand preview, and the `offer.render-pdf` job that stores the letter and
// queues the offer email. The handler checks the offer's state before acting
// and again under the row lock, so a second run, a withdrawn offer and an
// offer edited back to PENDING do nothing (J3). Logs carry offer, file and job
// IDs only, never salaries, names or file names (M2, J4).
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { jobQueue } from "../adapters/job-queue";
import type { Job } from "../adapters/job-queue";
import { type Db, type Tx, getDb, withTransaction } from "../db";
import { applications, emailLog, files, offers, requisitions, templates } from "../db/schema";
import { warsawRunDate } from "../domain/daily-tasks";
import { type TokenValues } from "../domain/tokens";
import { formatAmount, formatDate } from "../domain/tokens/format";
import { buildApplicationTokenValues, queueEmail } from "../email";
import { storePdf } from "../files/store-pdf";
import { logger } from "../logger";
import { message } from "../messages";
import { renderOfferLetter } from "../pdf";
import { scopeOffersFor } from "../policy/filters";
import { type PolicyUser, can } from "../policy/permissions";

type OfferRow = typeof offers.$inferSelect;

/**
 * P2: the #24 application values (with the E3 recruiter fallbacks and the
 * legal entity label) plus the offer's own job title, salary, currency and
 * start date in the #22 formats.
 */
export async function offerTokenValues(db: Db | Tx, offer: OfferRow): Promise<{ to: string | null; values: TokenValues; legalEntity: string }> {
  const { to, values } = await buildApplicationTokenValues(db as Tx, offer.applicationId);
  return {
    to,
    legalEntity: values.LEGAL_ENTITY ?? "",
    values: {
      ...values,
      JOB_TITLE: offer.jobTitle,
      OFFER_SALARY: formatAmount(offer.salary),
      OFFER_CURRENCY: offer.currency,
      START_DATE: formatDate(offer.startDate),
    },
  };
}

/** Renders the offer from its stored template (Q5: even if deactivated since), dated today in Warsaw. */
async function renderFor(db: Db | Tx, offer: OfferRow, now: Date): Promise<Uint8Array> {
  const [template] = await db.select({ body: templates.body }).from(templates).where(eq(templates.id, offer.templateId));
  if (!template?.body) throw new Error("Offer template not found");
  const { values, legalEntity } = await offerTokenValues(db, offer);
  return renderOfferLetter({ body: template.body, values, legalEntityLabel: legalEntity, letterDate: formatDate(warsawRunDate(now)) });
}

export type PreviewResult = { ok: true; bytes: Uint8Array } | { ok: false; reason: "notFound" } | { ok: false; reason: "renderError"; message: string };

/**
 * P6 (Q3): the saved offer rendered now, never stored. For anyone who may
 * read the offer (Recruiter, Admin, Hiring Manager in V3a, the V3b approver);
 * Interviewers and out-of-scope callers get notFound.
 */
export async function previewOfferLetter(user: PolicyUser, offerId: string, now = new Date(), db: Db = getDb()): Promise<PreviewResult> {
  if (!can(user, "offer.read") || !z.uuid().safeParse(offerId).success) return { ok: false, reason: "notFound" };
  const [offer] = await db.select().from(offers).where(and(eq(offers.id, offerId), scopeOffersFor(user)));
  if (!offer) return { ok: false, reason: "notFound" };
  try {
    return { ok: true, bytes: await renderFor(db, offer, now) };
  } catch (err) {
    // Token errors name the token only, never a value (P2, M2).
    return { ok: false, reason: "renderError", message: (err as Error).message };
  }
}

/** P7: the letter is issued once per approval: APPROVED, no response yet, not sent. */
const issuable = (offer: Pick<OfferRow, "approvalStatus" | "candidateResponse" | "sentAt">) =>
  offer.approvalStatus === "APPROVED" && offer.candidateResponse === "PENDING" && offer.sentAt === null;

/**
 * The `offer.render-pdf` handler (P7, J3, J5, Q1, Q4, Q8): renders outside
 * the transaction, then, under the offer's row lock and a re-check, stores the
 * letter (without the upload size limit), queues the offer email with it
 * attached and sets `sent_at`. A failed re-check rolls back, which also
 * deletes the stored blob (#19). A render error fails the job, so pg-boss
 * retries it (retry limit 3) and it shows on the jobs page (Q11).
 */
export async function offerRenderPdfHandler(job: Job, now = () => new Date()): Promise<void> {
  const { offerId } = z.object({ offerId: z.uuid() }).parse(job.data);
  const log = logger.child({ job_id: job.id, offer_id: offerId });
  const [current] = await getDb().select().from(offers).where(eq(offers.id, offerId));
  if (!current || !issuable(current)) {
    log.info("offer letter skipped");
    return;
  }
  const bytes = await renderFor(getDb(), current, now());

  const outcome = await withTransaction(async (tx) => {
    const [offer] = await tx.select().from(offers).where(eq(offers.id, offerId)).for("update");
    if (!offer || !issuable(offer)) return { issued: false as const };
    const [requisition] = await tx
      .select({ reqNumber: requisitions.reqNumber, id: requisitions.id })
      .from(applications)
      .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
      .where(eq(applications.id, offer.applicationId));
    const earlier = await tx
      .select({ id: files.id })
      .from(files)
      .where(and(eq(files.ownerType, "OFFER"), eq(files.ownerId, offerId), eq(files.kind, "OFFER_LETTER")));
    const file = await storePdf(tx, { ownerType: "OFFER", ownerId: offerId, kind: "OFFER_LETTER", originalName: `offer-letter-${requisition.reqNumber}.pdf`, bytes, generated: true });
    const { to, values } = await offerTokenValues(tx, offer);
    if (!to) throw new Error("The application has no email address");
    const emailLogId = await queueEmail(tx, {
      to,
      audience: "CANDIDATE",
      applicationId: offer.applicationId,
      requisitionId: requisition.id,
      subject: message(earlier.length > 0 ? "Email.offerLetter.subjectUpdated" : "Email.offerLetter.subject"),
      body: message("Email.offerLetter.body"),
      values,
      attachmentFileIds: [file.id],
    });
    await tx.update(offers).set({ sentAt: now(), updatedAt: now() }).where(eq(offers.id, offerId));
    return { issued: true as const, fileId: file.id, emailLogId, updated: earlier.length > 0 };
  });
  if (outcome.issued) log.info({ file_id: outcome.fileId, email_log_id: outcome.emailLogId, updated: outcome.updated }, "offer letter issued");
  else log.info("offer letter skipped after re-check");
}

/**
 * A8 (Q9): when an APPROVED offer goes back to PENDING, offer emails still
 * QUEUED with one of its letters attached are cancelled with their jobs, in
 * the caller's transaction (J2). Returns how many.
 */
export async function cancelQueuedLetterEmails(tx: Tx, offerId: string): Promise<number> {
  const letters = await tx
    .select({ id: files.id })
    .from(files)
    .where(and(eq(files.ownerType, "OFFER"), eq(files.ownerId, offerId), eq(files.kind, "OFFER_LETTER"), isNull(files.deletedAt)));
  if (letters.length === 0) return 0;
  const ids = letters.map((letter) => letter.id);
  const queued = await tx
    .update(emailLog)
    .set({ status: "CANCELLED" })
    .where(and(eq(emailLog.status, "QUEUED"), sql`${emailLog.attachmentFileIds} && ARRAY[${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )}]::uuid[]`))
    .returning({ jobId: emailLog.jobId });
  for (const { jobId } of queued) if (jobId) await jobQueue.cancel(tx, "email.send", jobId);
  return queued.length;
}

/** For the Offers section (Q11): an approved offer whose letter hasn't been issued yet. */
export function letterPending(offer: Pick<OfferRow, "approvalStatus" | "candidateResponse" | "sentAt">): boolean {
  return issuable(offer);
}
