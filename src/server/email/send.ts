// The `email.send` handler (ats-project-scope.md E1–E6; tech-stack.md §9,
// J3, J4). It locks the `email_log` row and acts only while it is QUEUED, so
// a duplicate delivery sends nothing. At send time it adds From (E1),
// Reply-To from the requisition's current recruiter (E2) and, for candidate
// emails, the footer that repeats the Reply-To address (E3), writes the final
// body back (E4) and records SENT or CAPTURED (E6). A failed attempt stays
// QUEUED with a sanitized error; after the last retry it is FAILED (E5).
// Logs carry IDs only (M2).
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Job, JobHandler } from "../adapters/job-queue";
import { JOB_QUEUES } from "../adapters/job-queue/queues";
import { type EmailTransport, type OutgoingAttachment, getEmailTransport } from "../adapters/email";
import { type StorageService, getStorage } from "../adapters/storage";
import { type Tx, withTransaction } from "../db";
import { applications, emailLog, files, requisitions, users } from "../db/schema";
import { escapeHtml } from "../domain/markup";
import { logger } from "../logger";
import { message } from "../messages";
import { getSetting } from "../settings";
import { htmlToText } from "./html-to-text";

type EmailLogRow = typeof emailLog.$inferSelect;

/** The last attempt: retryLimit retries after the first (E5). */
const RETRY_LIMIT = JOB_QUEUES["email.send"].retryLimit;

/** A failure reason without addresses or content: the error class and an SMTP or system code. */
export function sanitizeError(err: unknown): string {
  const name = err instanceof Error ? err.name : "Error";
  const { code, responseCode } = (err ?? {}) as { code?: unknown; responseCode?: unknown };
  const detail = [typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : undefined, typeof responseCode === "number" ? String(responseCode) : undefined]
    .filter(Boolean)
    .join(" ");
  return detail ? `${name}: ${detail}` : name;
}

/** E2: the requisition's current recruiter if active, otherwise the fallback address. */
async function replyToFor(tx: Tx, requisitionId: string | null): Promise<string> {
  if (requisitionId) {
    const [recruiter] = await tx
      .select({ email: users.email, isActive: users.isActive })
      .from(requisitions)
      .innerJoin(users, eq(users.id, requisitions.recruiterId))
      .where(eq(requisitions.id, requisitionId));
    if (recruiter?.isActive) return recruiter.email;
  }
  return getSetting("FALLBACK_REPLY_TO_EMAIL", tx);
}

/** E3: the Reply-To address and the reply line, so the footer always matches Reply-To. */
function footerHtml(replyTo: string): string {
  return `\n<hr>\n<p>${escapeHtml(replyTo)}<br>\n${escapeHtml(message("Email.footer"))}</p>`;
}

async function attachmentsFor(tx: Tx, storage: StorageService, row: EmailLogRow): Promise<OutgoingAttachment[]> {
  if (row.attachmentFileIds.length === 0) return [];
  const found = await tx.select().from(files).where(inArray(files.id, row.attachmentFileIds));
  const attachments: OutgoingAttachment[] = [];
  for (const id of row.attachmentFileIds) {
    const file = found.find((candidate) => candidate.id === id);
    // A missing or deleted file fails the attempt, so it is retried and finally FAILED.
    if (!file || file.deletedAt) throw new AttachmentMissingError();
    attachments.push({
      filename: file.originalName ?? "document.pdf",
      content: await storage.download(file.storageKey),
      contentType: "application/pdf",
    });
  }
  return attachments;
}

/** A failed attempt, carrying only the sanitized reason. */
export class EmailSendError extends Error {
  override name = "EmailSendError";
}

class AttachmentMissingError extends Error {
  override name = "AttachmentMissingError";
}

function calendarOf(row: EmailLogRow) {
  if (!row.icsContent) return undefined;
  const method = /^METHOD:(REQUEST|CANCEL)\r?$/m.exec(row.icsContent)?.[1] as "REQUEST" | "CANCEL" | undefined;
  return { method: method ?? "REQUEST", content: row.icsContent };
}

/** Handler factory; tests pass their own transport or storage. */
export function createEmailSendHandler(
  deps: { transport?: () => EmailTransport; storage?: () => StorageService } = {},
): JobHandler {
  const transport = deps.transport ?? getEmailTransport;
  const storage = deps.storage ?? getStorage;

  return async (job: Job) => {
    const emailLogId = job.data.emailLogId;
    const log = logger.child({ email_log_id: emailLogId, job_id: job.id, queue: job.queue });
    try {
      await withTransaction(async (tx) => {
        const [row] = await tx.select().from(emailLog).where(eq(emailLog.id, emailLogId)).for("update");
        // J3: a duplicate delivery, or an email cancelled or already handled.
        if (!row || row.status !== "QUEUED") {
          log.info({ status: row?.status ?? null }, "email not sent: not queued");
          return;
        }

        // E5/RT4: an anonymized application's emails are cancelled, never sent.
        const [application] = row.applicationId
          ? await tx.select({ anonymizedAt: applications.anonymizedAt }).from(applications).where(eq(applications.id, row.applicationId))
          : [];
        if (!row.recipient || application?.anonymizedAt) {
          await tx.update(emailLog).set({ status: "CANCELLED", error: "ANONYMIZED" }).where(eq(emailLog.id, row.id));
          log.info("email cancelled: application anonymized");
          return;
        }

        const sender = await getSetting("SENDER_EMAIL", tx);
        const replyTo = await replyToFor(tx, row.requisitionId);
        const html = row.audience === "CANDIDATE" ? `${row.bodyRendered ?? ""}${footerHtml(replyTo)}` : (row.bodyRendered ?? "");
        const messageId = `<${randomUUID()}@${sender.split("@")[1]}>`;
        const active = transport();

        await active.send({
          messageId,
          from: sender,
          replyTo,
          to: row.recipient,
          cc: row.cc ? row.cc.split(",").map((address) => address.trim()) : [],
          subject: (row.subject ?? "").replace(/[\r\n]+/g, " "),
          html,
          text: htmlToText(html),
          calendar: calendarOf(row),
          attachments: await attachmentsFor(tx, storage(), row),
        });

        await tx
          .update(emailLog)
          .set({
            status: active.provider === "smtp" ? "SENT" : "CAPTURED",
            sentAt: new Date(),
            providerMessageId: messageId,
            replyTo,
            bodyRendered: html,
            error: null,
          })
          .where(eq(emailLog.id, row.id));
        log.info({ provider: active.provider }, "email sent");
      });
    } catch (err) {
      // The attempt's transaction rolled back; record the outcome on its own.
      const final = job.retryCount >= RETRY_LIMIT;
      const error = sanitizeError(err);
      await withTransaction((tx) =>
        tx
          .update(emailLog)
          .set(final ? { status: "FAILED", error } : { error })
          .where(and(eq(emailLog.id, emailLogId), eq(emailLog.status, "QUEUED"))),
      );
      log.warn({ attempt: job.retryCount + 1, final, error }, final ? "email failed" : "email attempt failed");
      // Re-thrown sanitized: the job log and pg-boss store the message, and an
      // SMTP error can quote addresses.
      throw new EmailSendError(error);
    }
  };
}

/** The production handler, registered for `email.send` (src/worker/handlers.ts). */
export const emailSendHandler = createEmailSendHandler();
