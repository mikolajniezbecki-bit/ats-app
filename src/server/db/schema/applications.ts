// Applications, their answers, history and files (ats-project-scope.md §7,
// tables 8–11).
import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { APPLICATION_STATUSES, users } from "./administration";
import { enumCheck, id, timestamps } from "./columns";
import { prescreenQuestions, requisitions } from "./requisitions";

export const APPLICATION_REASON_CODES = ["DISQUALIFIED", "REQ_FILLED", "REQ_CANCELLED", "OTHER"] as const;
export const APPLICATION_SOURCES = ["CAREER_SITE", "PRIVATE_LINK"] as const;
export const FILE_OWNER_TYPES = ["APPLICATION", "SCORECARD", "OFFER"] as const;
export const FILE_KINDS = ["CV", "COVER_LETTER", "INTERVIEW_NOTES", "OFFER_LETTER"] as const;
/** `PENDING_SCAN` and `QUARANTINED` are reserved; there is no malware scanning (TO-07). */
export const FILE_STATUSES = ["CLEAN", "PENDING_SCAN", "QUARANTINED"] as const;

export const applications = pgTable(
  "applications",
  {
    id: id(),
    requisitionId: uuid("requisition_id")
      .notNull()
      .references(() => requisitions.id),
    // Reserved for candidate profiles; no foreign key (TO-01).
    candidateId: uuid("candidate_id"),
    // Personal data: NULL only after anonymization (see the check below).
    firstName: text("first_name"),
    lastName: text("last_name"),
    email: text("email"),
    emailHash: text("email_hash"),
    phone: text("phone"),
    status: text("status", { enum: APPLICATION_STATUSES }).notNull().default("APPLIED"),
    reasonCode: text("reason_code", { enum: APPLICATION_REASON_CODES }),
    source: text("source", { enum: APPLICATION_SOURCES }).notNull(),
    prescreenScore: integer("prescreen_score").notNull().default(0),
    isDisqualified: boolean("is_disqualified").notNull().default(false),
    consentAcceptedAt: timestamp("consent_accepted_at", { withTimezone: true }).notNull(),
    consentVersion: text("consent_version").notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
    dispositionedAt: timestamp("dispositioned_at", { withTimezone: true }),
    hiredAt: timestamp("hired_at", { withTimezone: true }),
    exportedAt: timestamp("exported_at", { withTimezone: true }),
    anonymizedAt: timestamp("anonymized_at", { withTimezone: true }),
    // Optimistic locking (D7); change rows through updateWithVersion.
    version: integer("version").notNull().default(1),
    ...timestamps(),
  },
  (t) => [
    enumCheck("applications_status_check", t.status, APPLICATION_STATUSES),
    enumCheck("applications_reason_code_check", t.reasonCode, APPLICATION_REASON_CODES),
    enumCheck("applications_source_check", t.source, APPLICATION_SOURCES),
    check(
      "applications_personal_data_check",
      sql`${t.anonymizedAt} IS NOT NULL OR (${t.firstName} IS NOT NULL AND ${t.lastName} IS NOT NULL AND ${t.email} IS NOT NULL AND ${t.emailHash} IS NOT NULL AND ${t.phone} IS NOT NULL)`,
    ),
    // Duplicate check (F7); also the requisition_id foreign-key index.
    index("applications_requisition_id_email_hash_applied_at_idx").on(t.requisitionId, t.emailHash, t.appliedAt),
  ],
);

export const prescreenAnswers = pgTable(
  "prescreen_answers",
  {
    id: id(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id),
    questionId: uuid("question_id")
      .notNull()
      .references(() => prescreenQuestions.id),
    answerJson: jsonb("answer_json").notNull(),
    points: integer("points").notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    index("prescreen_answers_application_id_idx").on(t.applicationId),
    index("prescreen_answers_question_id_idx").on(t.questionId),
  ],
);

// Append-only; created_at is the event time.
export const applicationHistory = pgTable(
  "application_history",
  {
    id: id(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id),
    // NULL on the entry written when the application is created.
    fromStatus: text("from_status", { enum: APPLICATION_STATUSES }),
    toStatus: text("to_status", { enum: APPLICATION_STATUSES }).notNull(),
    // NULL = system.
    changedByUserId: uuid("changed_by_user_id").references(() => users.id),
    comment: text("comment"),
    reasonCode: text("reason_code", { enum: APPLICATION_REASON_CODES }),
    isReopen: boolean("is_reopen").notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    enumCheck("application_history_from_status_check", t.fromStatus, APPLICATION_STATUSES),
    enumCheck("application_history_to_status_check", t.toStatus, APPLICATION_STATUSES),
    enumCheck("application_history_reason_code_check", t.reasonCode, APPLICATION_REASON_CODES),
    index("application_history_application_id_idx").on(t.applicationId),
    index("application_history_changed_by_user_id_idx").on(t.changedByUserId),
  ],
);

export const files = pgTable(
  "files",
  {
    id: id(),
    ownerType: text("owner_type", { enum: FILE_OWNER_TYPES }).notNull(),
    // Polymorphic (application, scorecard or offer): no foreign key.
    ownerId: uuid("owner_id").notNull(),
    kind: text("kind", { enum: FILE_KINDS }).notNull(),
    mime: text("mime").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    // The uploaded file name: personal data, cleared by the RT4 purge.
    originalName: text("original_name"),
    storageKey: text("storage_key").notNull(),
    status: text("status", { enum: FILE_STATUSES }).notNull().default("CLEAN"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    unique("files_storage_key_unique").on(t.storageKey),
    enumCheck("files_owner_type_check", t.ownerType, FILE_OWNER_TYPES),
    enumCheck("files_kind_check", t.kind, FILE_KINDS),
    enumCheck("files_status_check", t.status, FILE_STATUSES),
    index("files_owner_type_owner_id_idx").on(t.ownerType, t.ownerId),
  ],
);
