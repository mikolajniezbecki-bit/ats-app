// Audit and operational tables (ats-project-scope.md §7, tables 18–20).
import { sql } from "drizzle-orm";
import { date, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { users } from "./administration";
import { enumCheck, id, timestamps } from "./columns";

export const JOB_RUN_STATUSES = ["RUNNING", "COMPLETED", "FAILED"] as const;

export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    // NULL = system.
    actorUserId: uuid("actor_user_id").references(() => users.id),
    // `action` and `subject_type` are free text: §7 lists examples, not a closed set.
    action: text("action").notNull(),
    subjectType: text("subject_type"),
    // Text, not uuid: some subjects have natural keys (e.g. a setting key).
    subjectId: text("subject_id"),
    // IDs and counts only, never personal data.
    detailsJson: jsonb("details_json").notNull().default(sql`'{}'::jsonb`),
    ...timestamps(),
  },
  (t) => [index("audit_log_actor_user_id_idx").on(t.actorUserId)],
);

export const jobRuns = pgTable(
  "job_runs",
  {
    id: id(),
    jobName: text("job_name").notNull(),
    // Europe/Warsaw calendar date, as YYYY-MM-DD.
    runDate: date("run_date", { mode: "string" }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    status: text("status", { enum: JOB_RUN_STATUSES }).notNull(),
    ...timestamps(),
  },
  (t) => [
    unique("job_runs_job_name_run_date_unique").on(t.jobName, t.runDate),
    enumCheck("job_runs_status_check", t.status, JOB_RUN_STATUSES),
  ],
);

export const rateLimits = pgTable(
  "rate_limits",
  {
    key: text("key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
    ...timestamps(),
  },
  (t) => [primaryKey({ name: "rate_limits_pkey", columns: [t.key, t.windowStart] })],
);
