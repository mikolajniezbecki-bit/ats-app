// Queueing emails (ats-project-scope.md E1–E4; tech-stack.md §9, J1, J4).
// Every email goes through queueEmail(): its content is rendered now (P3
// markup first, then tokens in HTML mode, so a value can never become
// markup) and logged in full as a QUEUED `email_log` row, and an
// `email.send` job carrying only the row's ID is created in the same
// transaction. From, Reply-To and the E3 footer are added when it is sent.
import { eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { jobQueue } from "../adapters/job-queue";
import type { Tx } from "../db";
import { applications, emailLog, masterData, requisitions, templates, users } from "../db/schema";
import { markupToHtml } from "../domain/markup";
import { type TokenValues, resolveTokens } from "../domain/tokens";
import { logger } from "../logger";
import { message } from "../messages";
import { getSetting } from "../settings";
import { logoDataUri } from "../templates/logo";

export type IcsInput = { content: string; method: "REQUEST" | "CANCEL"; uid: string; sequence: number };

const emailAddress = z.string().trim().toLowerCase().pipe(z.email());

export const queueEmailSchema = z.object({
  to: emailAddress,
  cc: z.array(emailAddress).default([]),
  audience: z.enum(["CANDIDATE", "STAFF"]),
  applicationId: z.uuid().optional(),
  requisitionId: z.uuid().optional(),
  templateId: z.uuid().optional(),
  subject: z.string().min(1),
  body: z.string().min(1),
  values: z.custom<TokenValues>((value) => typeof value === "object" && value !== null).default({}),
  ics: z
    .object({ content: z.string().min(1), method: z.enum(["REQUEST", "CANCEL"]), uid: z.string().min(1), sequence: z.number().int().min(0) })
    .optional(),
  attachmentFileIds: z.array(z.uuid()).default([]),
  startAfter: z.date().optional(),
});

export type QueueEmailInput = z.input<typeof queueEmailSchema>;

/**
 * Renders, logs and queues one email in `tx`; returns the `email_log` ID.
 * Invalid input throws before anything is written. A rollback of `tx` removes
 * both the row and the job (J1).
 */
export async function queueEmail(tx: Tx, input: QueueEmailInput): Promise<string> {
  const email = queueEmailSchema.parse(input);
  const values: TokenValues = { LOGO: logoDataUri(), ...email.values };
  const subject = resolveTokens(email.subject, values, "subject");
  const body = resolveTokens(markupToHtml(email.body), values, "html");

  let requisitionId = email.requisitionId ?? null;
  if (!requisitionId && email.applicationId) {
    const [application] = await tx
      .select({ requisitionId: applications.requisitionId })
      .from(applications)
      .where(eq(applications.id, email.applicationId));
    requisitionId = application?.requisitionId ?? null;
  }

  const scheduledFor = email.startAfter ?? new Date();
  const [row] = await tx
    .insert(emailLog)
    .values({
      applicationId: email.applicationId ?? null,
      requisitionId,
      audience: email.audience,
      templateId: email.templateId ?? null,
      recipient: email.to,
      cc: email.cc.length > 0 ? email.cc.join(", ") : null,
      subject,
      bodyRendered: body,
      icsContent: email.ics?.content ?? null,
      icsUid: email.ics?.uid ?? null,
      icsSequence: email.ics?.sequence ?? null,
      attachmentFileIds: email.attachmentFileIds,
      status: "QUEUED",
      scheduledFor,
    })
    .returning({ id: emailLog.id });
  // J4: the payload holds the row's ID only.
  const jobId = await jobQueue.enqueue(tx, "email.send", { emailLogId: row.id }, { startAfter: email.startAfter });
  await tx.update(emailLog).set({ jobId }).where(eq(emailLog.id, row.id));
  logger.info({ email_log_id: row.id, job_id: jobId, queue: "email.send" }, "email queued");
  return row.id;
}

/**
 * The candidate and requisition token values of an application (§5.1). When
 * the recruiter is inactive, `[[RECRUITER_EMAIL]]` is the fallback Reply-To
 * address and `[[RECRUITER_FULL_NAME]]` "the recruiting team" (E2, E3).
 */
export async function buildApplicationTokenValues(tx: Tx, applicationId: string): Promise<{ to: string | null; values: TokenValues }> {
  const recruiter = alias(users, "recruiter");
  const hiringManager = alias(users, "hiring_manager");
  const [row] = await tx
    .select({
      email: applications.email,
      firstName: applications.firstName,
      lastName: applications.lastName,
      title: requisitions.title,
      reqNumber: requisitions.reqNumber,
      hiringManagerName: hiringManager.name,
      recruiterName: recruiter.name,
      recruiterEmail: recruiter.email,
      recruiterActive: recruiter.isActive,
      legalEntity: masterData.label,
    })
    .from(applications)
    .innerJoin(requisitions, eq(requisitions.id, applications.requisitionId))
    .innerJoin(recruiter, eq(recruiter.id, requisitions.recruiterId))
    .innerJoin(hiringManager, eq(hiringManager.id, requisitions.hiringManagerId))
    .innerJoin(masterData, eq(masterData.id, requisitions.legalEntityId))
    .where(eq(applications.id, applicationId));
  if (!row) throw new Error("Application not found");

  const recruiterValues = row.recruiterActive
    ? { RECRUITER_FULL_NAME: row.recruiterName, RECRUITER_EMAIL: row.recruiterEmail }
    : { RECRUITER_FULL_NAME: message("Email.recruitingTeam"), RECRUITER_EMAIL: await getSetting("FALLBACK_REPLY_TO_EMAIL", tx) };
  return {
    to: row.email,
    values: {
      // Anonymized applications have no name; their emails are never sent (E5).
      CANDIDATE_FULL_NAME: row.firstName && row.lastName ? `${row.firstName} ${row.lastName}` : null,
      JOB_TITLE: row.title,
      REQ_NUMBER: row.reqNumber,
      HIRING_MGR_FULL_NAME: row.hiringManagerName,
      LEGAL_ENTITY: row.legalEntity,
      LOGO: logoDataUri(),
      ...recruiterValues,
    },
  };
}

/** Queues a stage or bulk email template to the application's candidate. */
export async function queueTemplateEmail(
  tx: Tx,
  input: { templateId: string; applicationId: string; startAfter?: Date },
): Promise<string> {
  const [template] = await tx.select().from(templates).where(eq(templates.id, input.templateId));
  if (!template || template.type !== "EMAIL" || !template.subject || !template.body) throw new Error("Not an email template");
  const { to, values } = await buildApplicationTokenValues(tx, input.applicationId);
  if (!to) throw new Error("The application has no email address");
  return queueEmail(tx, {
    to,
    audience: "CANDIDATE",
    applicationId: input.applicationId,
    templateId: template.id,
    subject: template.subject,
    body: template.body,
    values,
    startAfter: input.startAfter,
  });
}
