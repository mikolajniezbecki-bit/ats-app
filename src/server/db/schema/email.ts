// Outgoing email log (ats-project-scope.md §7, table 17).
import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { templates } from "./administration";
import { applications } from "./applications";
import { enumCheck, id, timestamps } from "./columns";
import { requisitions } from "./requisitions";

export const EMAIL_AUDIENCES = ["CANDIDATE", "STAFF"] as const;
export const EMAIL_STATUSES = ["QUEUED", "SENT", "CAPTURED", "FAILED", "CANCELLED"] as const;
/** Outbound only; there is no inbound email (TO-09). */
export const EMAIL_DIRECTIONS = ["OUTBOUND"] as const;

export const emailLog = pgTable(
  "email_log",
  {
    id: id(),
    applicationId: uuid("application_id").references(() => applications.id),
    requisitionId: uuid("requisition_id").references(() => requisitions.id),
    audience: text("audience", { enum: EMAIL_AUDIENCES }).notNull(),
    templateId: uuid("template_id").references(() => templates.id),
    // pg-boss job ID (J2), in pg-boss's own schema: no foreign key.
    jobId: uuid("job_id"),
    // NULL after the RT4 purge.
    recipient: text("recipient"),
    cc: text("cc"),
    // Added when the email is sent (E2, tech-stack.md §9), so NULL while QUEUED.
    replyTo: text("reply_to"),
    subject: text("subject"),
    bodyRendered: text("body_rendered"),
    icsContent: text("ics_content"),
    // files.id values; an array has no foreign key.
    attachmentFileIds: uuid("attachment_file_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    status: text("status", { enum: EMAIL_STATUSES }).notNull(),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    providerMessageId: text("provider_message_id"),
    icsUid: text("ics_uid"),
    icsSequence: integer("ics_sequence"),
    direction: text("direction", { enum: EMAIL_DIRECTIONS }).notNull().default("OUTBOUND"),
    error: text("error"),
    ...timestamps(),
  },
  (t) => [
    enumCheck("email_log_audience_check", t.audience, EMAIL_AUDIENCES),
    enumCheck("email_log_status_check", t.status, EMAIL_STATUSES),
    enumCheck("email_log_direction_check", t.direction, EMAIL_DIRECTIONS),
    index("email_log_application_id_idx").on(t.applicationId),
    index("email_log_requisition_id_idx").on(t.requisitionId),
    index("email_log_template_id_idx").on(t.templateId),
  ],
);
