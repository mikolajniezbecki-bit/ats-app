// Requisitions and their pre-screening questions (ats-project-scope.md §7,
// tables 5–7).
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgSequence,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { masterData, templates, users } from "./administration";
import { enumCheck, id, timestamps } from "./columns";

export const REQUISITION_STATES = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "ON_HOLD", "CLOSED"] as const;
export const REQUISITION_CLOSE_REASONS = ["FILLED", "CANCELLED"] as const;
export const POSTING_TYPES = ["EXTERNAL", "PRIVATE"] as const;
export const REQUISITION_HISTORY_EVENTS = ["STATE_CHANGE", "FIELD_CHANGE", "REOPEN"] as const;
export const PRESCREEN_QUESTION_TYPES = ["YES_NO", "SINGLE", "MULTI", "TEXT"] as const;

/** Numbers `req_number`; a rolled-back insert leaves a gap, a number is never reused. */
export const reqNumberSeq = pgSequence("req_number_seq");

export const requisitions = pgTable(
  "requisitions",
  {
    id: id(),
    // The §7 default, unchanged: it would truncate past REQ-99999, which the
    // PoC can't reach (owner decision, #11).
    reqNumber: text("req_number")
      .notNull()
      .default(sql`'REQ-' || lpad(nextval('req_number_seq')::text, 5, '0')`),
    title: text("title").notNull(),
    // NULL when created blank (§5.2).
    templateId: uuid("template_id").references(() => templates.id),
    departmentId: uuid("department_id")
      .notNull()
      .references(() => masterData.id),
    locationId: uuid("location_id")
      .notNull()
      .references(() => masterData.id),
    legalEntityId: uuid("legal_entity_id")
      .notNull()
      .references(() => masterData.id),
    hiringManagerId: uuid("hiring_manager_id")
      .notNull()
      .references(() => users.id),
    recruiterId: uuid("recruiter_id")
      .notNull()
      .references(() => users.id),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id),
    // The latest submission; kept after the decision.
    submittedByUserId: uuid("submitted_by_user_id").references(() => users.id),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    approverId: uuid("approver_id").references(() => users.id),
    state: text("state", { enum: REQUISITION_STATES }).notNull().default("DRAFT"),
    closeReason: text("close_reason", { enum: REQUISITION_CLOSE_REASONS }),
    openingsCount: integer("openings_count").notNull(),
    descriptionHtml: text("description_html").notNull().default(""),
    // Validated against the template's schema_json by the requisition service (task 20).
    customFieldsJson: jsonb("custom_fields_json").notNull().default(sql`'{}'::jsonb`),
    postingType: text("posting_type", { enum: POSTING_TYPES }).notNull(),
    privateSlug: text("private_slug"),
    isPublished: boolean("is_published").notNull().default(false),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    previousL2ValuesJson: jsonb("previous_l2_values_json"),
    onHoldSince: timestamp("on_hold_since", { withTimezone: true }),
    // numeric comes back as a string, so fractional days stay exact.
    pausedDays: numeric("paused_days", { precision: 10, scale: 2 }).notNull().default("0"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    // Optimistic locking (D7); change rows through updateWithVersion.
    version: integer("version").notNull().default(1),
    ...timestamps(),
  },
  (t) => [
    unique("requisitions_req_number_unique").on(t.reqNumber),
    // Several NULL slugs are allowed (NULLs are distinct).
    unique("requisitions_private_slug_unique").on(t.privateSlug),
    enumCheck("requisitions_state_check", t.state, REQUISITION_STATES),
    enumCheck("requisitions_close_reason_check", t.closeReason, REQUISITION_CLOSE_REASONS),
    enumCheck("requisitions_posting_type_check", t.postingType, POSTING_TYPES),
    check("requisitions_openings_count_check", sql`${t.openingsCount} >= 1`),
    index("requisitions_template_id_idx").on(t.templateId),
    index("requisitions_department_id_idx").on(t.departmentId),
    index("requisitions_location_id_idx").on(t.locationId),
    index("requisitions_legal_entity_id_idx").on(t.legalEntityId),
    index("requisitions_hiring_manager_id_idx").on(t.hiringManagerId),
    index("requisitions_recruiter_id_idx").on(t.recruiterId),
    index("requisitions_created_by_user_id_idx").on(t.createdByUserId),
    index("requisitions_submitted_by_user_id_idx").on(t.submittedByUserId),
    index("requisitions_approver_id_idx").on(t.approverId),
  ],
);

// Append-only; created_at is the event time.
export const requisitionHistory = pgTable(
  "requisition_history",
  {
    id: id(),
    requisitionId: uuid("requisition_id")
      .notNull()
      .references(() => requisitions.id),
    event: text("event", { enum: REQUISITION_HISTORY_EVENTS }).notNull(),
    field: text("field"),
    oldValue: text("old_value"),
    newValue: text("new_value"),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    comment: text("comment"),
    ...timestamps(),
  },
  (t) => [
    enumCheck("requisition_history_event_check", t.event, REQUISITION_HISTORY_EVENTS),
    index("requisition_history_requisition_id_idx").on(t.requisitionId),
    index("requisition_history_user_id_idx").on(t.userId),
  ],
);

export const prescreenQuestions = pgTable(
  "prescreen_questions",
  {
    id: id(),
    requisitionId: uuid("requisition_id")
      .notNull()
      .references(() => requisitions.id),
    questionText: text("question_text").notNull(),
    questionType: text("question_type", { enum: PRESCREEN_QUESTION_TYPES }).notNull(),
    // Array<{ code, label }>; S1 (text questions have weight 0) is checked in task 21.
    optionsJson: jsonb("options_json").notNull().default(sql`'[]'::jsonb`),
    weight: integer("weight").notNull().default(0),
    scoringAnswer: jsonb("scoring_answer"),
    disqualifyingAnswer: jsonb("disqualifying_answer"),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    enumCheck("prescreen_questions_question_type_check", t.questionType, PRESCREEN_QUESTION_TYPES),
    check("prescreen_questions_weight_check", sql`${t.weight} >= 0`),
    index("prescreen_questions_requisition_id_idx").on(t.requisitionId),
  ],
);
