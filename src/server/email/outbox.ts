// Read queries for the Admin Outbox (tech-stack.md §9, ats-project-scope.md
// E4, E6): every email_log row, whatever its status or provider. The page
// shows personal data to Admins on screen; nothing here is logged (M2).
import { count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { type Db, getDb } from "../db";
import { EMAIL_STATUSES, emailLog, files, templates } from "../db/schema";

export const OUTBOX_PAGE_SIZE = 50;

export type EmailStatus = (typeof EMAIL_STATUSES)[number];

export type OutboxRow = {
  id: string;
  recipient: string | null;
  subject: string | null;
  status: EmailStatus;
  /** `sent_at`, or `scheduled_for` while not sent. */
  time: Date | null;
  applicationId: string | null;
};

/** One page of the Outbox, newest first, optionally one status only. */
export async function listOutbox(
  options: { status?: EmailStatus; page?: number } = {},
  db: Db = getDb(),
): Promise<{ rows: OutboxRow[]; total: number; page: number; pages: number }> {
  const page = Math.max(1, options.page ?? 1);
  const where = options.status ? eq(emailLog.status, options.status) : undefined;
  const [{ total }] = await db.select({ total: count() }).from(emailLog).where(where);
  const rows = await db
    .select({
      id: emailLog.id,
      recipient: emailLog.recipient,
      subject: emailLog.subject,
      status: emailLog.status,
      sentAt: emailLog.sentAt,
      scheduledFor: emailLog.scheduledFor,
      createdAt: emailLog.createdAt,
      applicationId: emailLog.applicationId,
    })
    .from(emailLog)
    .where(where)
    .orderBy(desc(emailLog.createdAt), desc(emailLog.id))
    .limit(OUTBOX_PAGE_SIZE)
    .offset((page - 1) * OUTBOX_PAGE_SIZE);
  return {
    rows: rows.map((row) => ({
      id: row.id,
      recipient: row.recipient,
      subject: row.subject,
      status: row.status,
      time: row.sentAt ?? row.scheduledFor,
      applicationId: row.applicationId,
    })),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / OUTBOX_PAGE_SIZE)),
  };
}

export type OutboxAttachment = { id: string; name: string | null; deleted: boolean };

export type OutboxMessage = typeof emailLog.$inferSelect & { templateName: string | null; attachments: OutboxAttachment[] };

/** One message with its template name and attachments, or undefined. */
export async function getOutboxMessage(id: string, db: Db = getDb()): Promise<OutboxMessage | undefined> {
  if (!z.uuid().safeParse(id).success) return undefined;
  const [row] = await db
    .select({ email: emailLog, templateName: templates.name })
    .from(emailLog)
    .leftJoin(templates, eq(templates.id, emailLog.templateId))
    .where(eq(emailLog.id, id));
  if (!row) return undefined;
  const ids = row.email.attachmentFileIds;
  const found = ids.length > 0 ? await db.select().from(files).where(inArray(files.id, ids)) : [];
  const attachments = ids.map((fileId) => {
    const file = found.find((candidate) => candidate.id === fileId);
    return { id: fileId, name: file?.originalName ?? null, deleted: !file || file.deletedAt !== null };
  });
  return { ...row.email, templateName: row.templateName, attachments };
}

/** The stored `.ics` of a message, or undefined when it has none (or it was purged). */
export async function getOutboxIcs(id: string, db: Db = getDb()): Promise<string | undefined> {
  if (!z.uuid().safeParse(id).success) return undefined;
  const [row] = await db.select({ ics: emailLog.icsContent }).from(emailLog).where(eq(emailLog.id, id));
  return row?.ics ?? undefined;
}
