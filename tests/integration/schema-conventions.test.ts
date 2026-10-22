// §7 conventions checked against the PostgreSQL catalog of the migrated
// database. The checks cover every table in `public`, so tables added by
// later tasks are held to the same rules.
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "@/server/db";

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await getDb().execute(query)).rows as T[];
}

describe("schema conventions", () => {
  it("D1: every foreign-key column is the leading column of an index", async () => {
    const unindexed = await rows<{ table_name: string; column_name: string }>(sql`
      SELECT c.conrelid::regclass::text AS table_name, a.attname AS column_name
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f'
        AND c.connamespace = 'public'::regnamespace
        AND NOT EXISTS (
          SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1]
        )
      ORDER BY 1, 2`);
    expect(unindexed).toEqual([]);
  });

  it("D1: no foreign key cascades on delete", async () => {
    const cascading = await rows<{ name: string }>(sql`
      SELECT conname AS name FROM pg_constraint
      WHERE contype = 'f' AND connamespace = 'public'::regnamespace AND confdeltype = 'c'`);
    expect(cascading).toEqual([]);
  });

  it("D1: every table has created_at and updated_at as timestamptz NOT NULL DEFAULT now()", async () => {
    const tables = await rows<{ table_name: string; columns: number }>(sql`
      SELECT t.table_name, count(c.column_name)::int AS columns
      FROM information_schema.tables t
      LEFT JOIN information_schema.columns c
        ON c.table_schema = t.table_schema AND c.table_name = t.table_name
        AND c.column_name IN ('created_at', 'updated_at')
        AND c.data_type = 'timestamp with time zone' AND c.is_nullable = 'NO' AND c.column_default = 'now()'
      WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      GROUP BY t.table_name`);
    expect(tables.length).toBe(20);
    expect(tables.filter((t) => t.columns !== 2)).toEqual([]);
  });

  it("D1: the administration tables have exactly the nullable columns of §7", async () => {
    const nullable = await rows<{ column: string }>(sql`
      SELECT table_name || '.' || column_name AS column FROM information_schema.columns
      WHERE table_schema = 'public' AND is_nullable = 'YES'
        AND table_name IN ('users', 'master_data', 'templates', 'settings', 'audit_log', 'job_runs', 'rate_limits')
      ORDER BY 1`);
    expect(nullable.map((r) => r.column)).toEqual([
      "audit_log.actor_user_id",
      "audit_log.subject_id",
      "audit_log.subject_type",
      "job_runs.finished_at",
      "master_data.picklist_key",
      "settings.updated_by",
      "templates.body",
      "templates.schema_json",
      "templates.subject",
      "templates.trigger_status",
      "users.image",
    ]);
  });

  it("D1: the recruiting tables have exactly the nullable columns of §7", async () => {
    const nullable = await rows<{ column: string }>(sql`
      SELECT table_name || '.' || column_name AS column FROM information_schema.columns
      WHERE table_schema = 'public' AND is_nullable = 'YES'
        AND table_name NOT IN ('users', 'master_data', 'templates', 'settings', 'audit_log', 'job_runs', 'rate_limits')
      ORDER BY 1`);
    expect(nullable.map((r) => r.column)).toEqual([
      "application_history.changed_by_user_id",
      "application_history.comment",
      "application_history.from_status",
      "application_history.reason_code",
      "applications.anonymized_at",
      "applications.candidate_id",
      "applications.dispositioned_at",
      "applications.email",
      "applications.email_hash",
      "applications.exported_at",
      "applications.first_name",
      "applications.hired_at",
      "applications.last_name",
      "applications.phone",
      "applications.reason_code",
      "approval_events.actor_user_id",
      "approval_events.comment",
      "approval_events.from_approver_id",
      "approval_events.to_approver_id",
      "email_log.application_id",
      "email_log.body_rendered",
      "email_log.cc",
      "email_log.error",
      "email_log.ics_content",
      "email_log.ics_sequence",
      "email_log.ics_uid",
      "email_log.job_id",
      "email_log.provider_message_id",
      "email_log.recipient",
      "email_log.reply_to",
      "email_log.requisition_id",
      "email_log.scheduled_for",
      "email_log.sent_at",
      "email_log.subject",
      "email_log.template_id",
      "files.deleted_at",
      "files.original_name",
      "interview_participants.removed_at",
      "interview_scorecards.comments",
      "interview_scorecards.reopened_at",
      "interview_scorecards.submitted_at",
      "offers.approver_id",
      "offers.responded_at",
      "offers.sent_at",
      "offers.submitted_at",
      "offers.submitted_by_user_id",
      "prescreen_questions.disqualifying_answer",
      "prescreen_questions.scoring_answer",
      "requisition_history.comment",
      "requisition_history.field",
      "requisition_history.new_value",
      "requisition_history.old_value",
      "requisitions.approved_at",
      "requisitions.approver_id",
      "requisitions.close_reason",
      "requisitions.closed_at",
      "requisitions.on_hold_since",
      "requisitions.previous_l2_values_json",
      "requisitions.private_slug",
      "requisitions.submitted_at",
      "requisitions.submitted_by_user_id",
      "requisitions.template_id",
    ]);
  });

  it("D1: every enumeration of the recruiting tables has a check listing exactly the §7 values", async () => {
    const STATUSES = ["APPLIED", "SCREENING", "INTERVIEW", "OFFER", "HIRED", "REJECTED", "WITHDRAWN"];
    const REASON_CODES = ["DISQUALIFIED", "REQ_FILLED", "REQ_CANCELLED", "OTHER"];
    const expected: Record<string, string[]> = {
      requisitions_state_check: ["DRAFT", "PENDING_APPROVAL", "APPROVED", "ON_HOLD", "CLOSED"],
      requisitions_close_reason_check: ["FILLED", "CANCELLED"],
      requisitions_posting_type_check: ["EXTERNAL", "PRIVATE"],
      requisition_history_event_check: ["STATE_CHANGE", "FIELD_CHANGE", "REOPEN"],
      prescreen_questions_question_type_check: ["YES_NO", "SINGLE", "MULTI", "TEXT"],
      applications_status_check: STATUSES,
      applications_reason_code_check: REASON_CODES,
      applications_source_check: ["CAREER_SITE", "PRIVATE_LINK"],
      application_history_from_status_check: STATUSES,
      application_history_to_status_check: STATUSES,
      application_history_reason_code_check: REASON_CODES,
      files_owner_type_check: ["APPLICATION", "SCORECARD", "OFFER"],
      files_kind_check: ["CV", "COVER_LETTER", "INTERVIEW_NOTES", "OFFER_LETTER"],
      files_status_check: ["CLEAN", "PENDING_SCAN", "QUARANTINED"],
      interviews_status_check: ["SCHEDULED", "COMPLETED", "CANCELLED", "NO_SHOW"],
      offers_approval_status_check: ["DRAFT", "PENDING", "APPROVED", "REJECTED", "WITHDRAWN"],
      offers_candidate_response_check: ["PENDING", "ACCEPTED", "DECLINED"],
      approval_events_subject_type_check: ["REQUISITION", "OFFER"],
      approval_events_event_check: ["SUBMITTED", "APPROVED", "REJECTED", "WITHDRAWN", "REASSIGNED", "REMINDED"],
      email_log_audience_check: ["CANDIDATE", "STAFF"],
      email_log_status_check: ["QUEUED", "SENT", "CAPTURED", "FAILED", "CANCELLED"],
      email_log_direction_check: ["OUTBOUND"],
    };
    const checks = await rows<{ name: string; definition: string }>(sql`
      SELECT conname AS name, pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE contype = 'c' AND connamespace = 'public'::regnamespace
        AND conname IN (${sql.join(Object.keys(expected).map((name) => sql`${name}`), sql`, `)})`);
    // PostgreSQL stores `IN (...)` as `= ANY (ARRAY['A'::text, ...])`.
    const actual = Object.fromEntries(
      checks.map((c) => [c.name, [...c.definition.matchAll(/'([A-Z_]+)'::text/g)].map((m) => m[1])]),
    );
    expect(actual).toEqual(expected);
  });

  it("D1: polymorphic and external references have no foreign key", async () => {
    const constrained = await rows<{ column: string }>(sql`
      SELECT c.conrelid::regclass::text || '.' || a.attname AS column
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace`);
    const columns = constrained.map((r) => r.column);
    for (const column of [
      "files.owner_id",
      "approval_events.subject_id",
      "email_log.job_id",
      "email_log.attachment_file_ids",
      "applications.candidate_id",
    ]) {
      expect(columns).not.toContain(column);
    }
    expect(columns).toContain("email_log.requisition_id");
  });
});
