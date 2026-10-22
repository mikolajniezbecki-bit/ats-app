// Offers and the approval trail of offers and requisitions
// (ats-project-scope.md §7, tables 15–16).
import { sql } from "drizzle-orm";
import { check, date, index, integer, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { templates, users } from "./administration";
import { applications } from "./applications";
import { enumCheck, id, timestamps } from "./columns";

export const OFFER_APPROVAL_STATUSES = ["DRAFT", "PENDING", "APPROVED", "REJECTED", "WITHDRAWN"] as const;
export const OFFER_CANDIDATE_RESPONSES = ["PENDING", "ACCEPTED", "DECLINED"] as const;
export const APPROVAL_SUBJECT_TYPES = ["REQUISITION", "OFFER"] as const;
export const APPROVAL_EVENTS = ["SUBMITTED", "APPROVED", "REJECTED", "WITHDRAWN", "REASSIGNED", "REMINDED"] as const;

export const offers = pgTable(
  "offers",
  {
    id: id(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id),
    templateId: uuid("template_id")
      .notNull()
      .references(() => templates.id),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id),
    // The latest submission; kept after the decision and after a withdrawal.
    submittedByUserId: uuid("submitted_by_user_id").references(() => users.id),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    approverId: uuid("approver_id").references(() => users.id),
    jobTitle: text("job_title").notNull(),
    // numeric comes back as a string, so amounts stay exact.
    salary: numeric("salary", { precision: 12, scale: 2 }).notNull(),
    // Format only; the ISO 4217 list is checked by the offer service (task 35).
    currency: text("currency").notNull(),
    startDate: date("start_date", { mode: "string" }).notNull(),
    approvalStatus: text("approval_status", { enum: OFFER_APPROVAL_STATUSES }).notNull().default("DRAFT"),
    candidateResponse: text("candidate_response", { enum: OFFER_CANDIDATE_RESPONSES }).notNull().default("PENDING"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    // Optimistic locking (D7); change rows through updateWithVersion.
    version: integer("version").notNull().default(1),
    ...timestamps(),
  },
  (t) => [
    enumCheck("offers_approval_status_check", t.approvalStatus, OFFER_APPROVAL_STATUSES),
    enumCheck("offers_candidate_response_check", t.candidateResponse, OFFER_CANDIDATE_RESPONSES),
    // A discarded or auto-withdrawn draft (§5.6, L6) never had an approver.
    check(
      "offers_approver_id_check",
      sql`${t.approvalStatus} IN ('DRAFT', 'WITHDRAWN') OR ${t.approverId} IS NOT NULL`,
    ),
    check("offers_currency_check", sql`${t.currency} ~ '^[A-Z]{3}$'`),
    index("offers_application_id_idx").on(t.applicationId),
    index("offers_template_id_idx").on(t.templateId),
    index("offers_created_by_user_id_idx").on(t.createdByUserId),
    index("offers_submitted_by_user_id_idx").on(t.submittedByUserId),
    index("offers_approver_id_idx").on(t.approverId),
  ],
);

// Append-only; created_at is the event time.
export const approvalEvents = pgTable(
  "approval_events",
  {
    id: id(),
    subjectType: text("subject_type", { enum: APPROVAL_SUBJECT_TYPES }).notNull(),
    // Polymorphic (requisition or offer): no foreign key.
    subjectId: uuid("subject_id").notNull(),
    event: text("event", { enum: APPROVAL_EVENTS }).notNull(),
    // NULL = system (reminders).
    actorUserId: uuid("actor_user_id").references(() => users.id),
    fromApproverId: uuid("from_approver_id").references(() => users.id),
    toApproverId: uuid("to_approver_id").references(() => users.id),
    comment: text("comment"),
    ...timestamps(),
  },
  (t) => [
    enumCheck("approval_events_subject_type_check", t.subjectType, APPROVAL_SUBJECT_TYPES),
    enumCheck("approval_events_event_check", t.event, APPROVAL_EVENTS),
    index("approval_events_subject_type_subject_id_created_at_idx").on(t.subjectType, t.subjectId, t.createdAt),
    index("approval_events_actor_user_id_idx").on(t.actorUserId),
    index("approval_events_from_approver_id_idx").on(t.fromApproverId),
    index("approval_events_to_approver_id_idx").on(t.toApproverId),
  ],
);
