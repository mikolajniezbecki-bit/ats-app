CREATE SEQUENCE "public"."req_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "prescreen_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requisition_id" uuid NOT NULL,
	"question_text" text NOT NULL,
	"question_type" text NOT NULL,
	"options_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"weight" integer DEFAULT 0 NOT NULL,
	"scoring_answer" jsonb,
	"disqualifying_answer" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prescreen_questions_question_type_check" CHECK ("prescreen_questions"."question_type" IN ('YES_NO', 'SINGLE', 'MULTI', 'TEXT')),
	CONSTRAINT "prescreen_questions_weight_check" CHECK ("prescreen_questions"."weight" >= 0)
);
--> statement-breakpoint
CREATE TABLE "requisition_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requisition_id" uuid NOT NULL,
	"event" text NOT NULL,
	"field" text,
	"old_value" text,
	"new_value" text,
	"user_id" uuid NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requisition_history_event_check" CHECK ("requisition_history"."event" IN ('STATE_CHANGE', 'FIELD_CHANGE', 'REOPEN'))
);
--> statement-breakpoint
CREATE TABLE "requisitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"req_number" text DEFAULT 'REQ-' || lpad(nextval('req_number_seq')::text, 5, '0') NOT NULL,
	"title" text NOT NULL,
	"template_id" uuid,
	"department_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"hiring_manager_id" uuid NOT NULL,
	"recruiter_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"submitted_by_user_id" uuid,
	"submitted_at" timestamp with time zone,
	"approver_id" uuid,
	"state" text DEFAULT 'DRAFT' NOT NULL,
	"close_reason" text,
	"openings_count" integer NOT NULL,
	"description_html" text DEFAULT '' NOT NULL,
	"custom_fields_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"posting_type" text NOT NULL,
	"private_slug" text,
	"is_published" boolean DEFAULT false NOT NULL,
	"approved_at" timestamp with time zone,
	"previous_l2_values_json" jsonb,
	"on_hold_since" timestamp with time zone,
	"paused_days" numeric(10, 2) DEFAULT '0' NOT NULL,
	"closed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requisitions_req_number_unique" UNIQUE("req_number"),
	CONSTRAINT "requisitions_private_slug_unique" UNIQUE("private_slug"),
	CONSTRAINT "requisitions_state_check" CHECK ("requisitions"."state" IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'ON_HOLD', 'CLOSED')),
	CONSTRAINT "requisitions_close_reason_check" CHECK ("requisitions"."close_reason" IN ('FILLED', 'CANCELLED')),
	CONSTRAINT "requisitions_posting_type_check" CHECK ("requisitions"."posting_type" IN ('EXTERNAL', 'PRIVATE')),
	CONSTRAINT "requisitions_openings_count_check" CHECK ("requisitions"."openings_count" >= 1)
);
--> statement-breakpoint
CREATE TABLE "application_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"changed_by_user_id" uuid,
	"comment" text,
	"reason_code" text,
	"is_reopen" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_history_from_status_check" CHECK ("application_history"."from_status" IN ('APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED', 'WITHDRAWN')),
	CONSTRAINT "application_history_to_status_check" CHECK ("application_history"."to_status" IN ('APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED', 'WITHDRAWN')),
	CONSTRAINT "application_history_reason_code_check" CHECK ("application_history"."reason_code" IN ('DISQUALIFIED', 'REQ_FILLED', 'REQ_CANCELLED', 'OTHER'))
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requisition_id" uuid NOT NULL,
	"candidate_id" uuid,
	"first_name" text,
	"last_name" text,
	"email" text,
	"email_hash" text,
	"phone" text,
	"status" text DEFAULT 'APPLIED' NOT NULL,
	"reason_code" text,
	"source" text NOT NULL,
	"prescreen_score" integer DEFAULT 0 NOT NULL,
	"is_disqualified" boolean DEFAULT false NOT NULL,
	"consent_accepted_at" timestamp with time zone NOT NULL,
	"consent_version" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispositioned_at" timestamp with time zone,
	"hired_at" timestamp with time zone,
	"exported_at" timestamp with time zone,
	"anonymized_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "applications_status_check" CHECK ("applications"."status" IN ('APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED', 'WITHDRAWN')),
	CONSTRAINT "applications_reason_code_check" CHECK ("applications"."reason_code" IN ('DISQUALIFIED', 'REQ_FILLED', 'REQ_CANCELLED', 'OTHER')),
	CONSTRAINT "applications_source_check" CHECK ("applications"."source" IN ('CAREER_SITE', 'PRIVATE_LINK')),
	CONSTRAINT "applications_personal_data_check" CHECK ("applications"."anonymized_at" IS NOT NULL OR ("applications"."first_name" IS NOT NULL AND "applications"."last_name" IS NOT NULL AND "applications"."email" IS NOT NULL AND "applications"."email_hash" IS NOT NULL AND "applications"."phone" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"original_name" text,
	"storage_key" text NOT NULL,
	"status" text DEFAULT 'CLEAN' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "files_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "files_owner_type_check" CHECK ("files"."owner_type" IN ('APPLICATION', 'SCORECARD', 'OFFER')),
	CONSTRAINT "files_kind_check" CHECK ("files"."kind" IN ('CV', 'COVER_LETTER', 'INTERVIEW_NOTES', 'OFFER_LETTER')),
	CONSTRAINT "files_status_check" CHECK ("files"."status" IN ('CLEAN', 'PENDING_SCAN', 'QUARANTINED'))
);
--> statement-breakpoint
CREATE TABLE "prescreen_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"answer_json" jsonb NOT NULL,
	"points" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interview_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"interview_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interview_participants_interview_id_user_id_unique" UNIQUE("interview_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "interview_scorecards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"interview_id" uuid NOT NULL,
	"interviewer_id" uuid NOT NULL,
	"overall_rating" integer NOT NULL,
	"thumbs_up" boolean NOT NULL,
	"comments" text,
	"submitted_at" timestamp with time zone,
	"reopened_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interview_scorecards_interview_id_interviewer_id_unique" UNIQUE("interview_id","interviewer_id"),
	CONSTRAINT "interview_scorecards_overall_rating_check" CHECK ("interview_scorecards"."overall_rating" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE "interviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"starts_at_utc" timestamp with time zone NOT NULL,
	"duration_minutes" integer NOT NULL,
	"timezone" text NOT NULL,
	"location_or_link" text NOT NULL,
	"status" text DEFAULT 'SCHEDULED' NOT NULL,
	"ics_uid" text NOT NULL,
	"ics_sequence" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interviews_ics_uid_unique" UNIQUE("ics_uid"),
	CONSTRAINT "interviews_status_check" CHECK ("interviews"."status" IN ('SCHEDULED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'))
);
--> statement-breakpoint
CREATE TABLE "approval_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"event" text NOT NULL,
	"actor_user_id" uuid,
	"from_approver_id" uuid,
	"to_approver_id" uuid,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_events_subject_type_check" CHECK ("approval_events"."subject_type" IN ('REQUISITION', 'OFFER')),
	CONSTRAINT "approval_events_event_check" CHECK ("approval_events"."event" IN ('SUBMITTED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'REASSIGNED', 'REMINDED'))
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"submitted_by_user_id" uuid,
	"submitted_at" timestamp with time zone,
	"approver_id" uuid,
	"job_title" text NOT NULL,
	"salary" numeric(12, 2) NOT NULL,
	"currency" text NOT NULL,
	"start_date" date NOT NULL,
	"approval_status" text DEFAULT 'DRAFT' NOT NULL,
	"candidate_response" text DEFAULT 'PENDING' NOT NULL,
	"sent_at" timestamp with time zone,
	"responded_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offers_approval_status_check" CHECK ("offers"."approval_status" IN ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN')),
	CONSTRAINT "offers_candidate_response_check" CHECK ("offers"."candidate_response" IN ('PENDING', 'ACCEPTED', 'DECLINED')),
	CONSTRAINT "offers_approver_id_check" CHECK ("offers"."approval_status" IN ('DRAFT', 'WITHDRAWN') OR "offers"."approver_id" IS NOT NULL),
	CONSTRAINT "offers_currency_check" CHECK ("offers"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "email_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid,
	"requisition_id" uuid,
	"audience" text NOT NULL,
	"template_id" uuid,
	"job_id" uuid,
	"recipient" text,
	"cc" text,
	"reply_to" text,
	"subject" text,
	"body_rendered" text,
	"ics_content" text,
	"attachment_file_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"status" text NOT NULL,
	"scheduled_for" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"provider_message_id" text,
	"ics_uid" text,
	"ics_sequence" integer,
	"direction" text DEFAULT 'OUTBOUND' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_log_audience_check" CHECK ("email_log"."audience" IN ('CANDIDATE', 'STAFF')),
	CONSTRAINT "email_log_status_check" CHECK ("email_log"."status" IN ('QUEUED', 'SENT', 'CAPTURED', 'FAILED', 'CANCELLED')),
	CONSTRAINT "email_log_direction_check" CHECK ("email_log"."direction" IN ('OUTBOUND'))
);
--> statement-breakpoint
ALTER TABLE "prescreen_questions" ADD CONSTRAINT "prescreen_questions_requisition_id_requisitions_id_fk" FOREIGN KEY ("requisition_id") REFERENCES "public"."requisitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisition_history" ADD CONSTRAINT "requisition_history_requisition_id_requisitions_id_fk" FOREIGN KEY ("requisition_id") REFERENCES "public"."requisitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisition_history" ADD CONSTRAINT "requisition_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_department_id_master_data_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."master_data"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_location_id_master_data_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."master_data"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_legal_entity_id_master_data_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "public"."master_data"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_hiring_manager_id_users_id_fk" FOREIGN KEY ("hiring_manager_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_recruiter_id_users_id_fk" FOREIGN KEY ("recruiter_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requisitions" ADD CONSTRAINT "requisitions_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_history" ADD CONSTRAINT "application_history_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_history" ADD CONSTRAINT "application_history_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_requisition_id_requisitions_id_fk" FOREIGN KEY ("requisition_id") REFERENCES "public"."requisitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescreen_answers" ADD CONSTRAINT "prescreen_answers_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescreen_answers" ADD CONSTRAINT "prescreen_answers_question_id_prescreen_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."prescreen_questions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_participants" ADD CONSTRAINT "interview_participants_interview_id_interviews_id_fk" FOREIGN KEY ("interview_id") REFERENCES "public"."interviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_participants" ADD CONSTRAINT "interview_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_scorecards" ADD CONSTRAINT "interview_scorecards_interview_id_interviews_id_fk" FOREIGN KEY ("interview_id") REFERENCES "public"."interviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_scorecards" ADD CONSTRAINT "interview_scorecards_interviewer_id_users_id_fk" FOREIGN KEY ("interviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_events" ADD CONSTRAINT "approval_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_events" ADD CONSTRAINT "approval_events_from_approver_id_users_id_fk" FOREIGN KEY ("from_approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_events" ADD CONSTRAINT "approval_events_to_approver_id_users_id_fk" FOREIGN KEY ("to_approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_log" ADD CONSTRAINT "email_log_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_log" ADD CONSTRAINT "email_log_requisition_id_requisitions_id_fk" FOREIGN KEY ("requisition_id") REFERENCES "public"."requisitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_log" ADD CONSTRAINT "email_log_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "prescreen_questions_requisition_id_idx" ON "prescreen_questions" USING btree ("requisition_id");--> statement-breakpoint
CREATE INDEX "requisition_history_requisition_id_idx" ON "requisition_history" USING btree ("requisition_id");--> statement-breakpoint
CREATE INDEX "requisition_history_user_id_idx" ON "requisition_history" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "requisitions_template_id_idx" ON "requisitions" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "requisitions_department_id_idx" ON "requisitions" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX "requisitions_location_id_idx" ON "requisitions" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "requisitions_legal_entity_id_idx" ON "requisitions" USING btree ("legal_entity_id");--> statement-breakpoint
CREATE INDEX "requisitions_hiring_manager_id_idx" ON "requisitions" USING btree ("hiring_manager_id");--> statement-breakpoint
CREATE INDEX "requisitions_recruiter_id_idx" ON "requisitions" USING btree ("recruiter_id");--> statement-breakpoint
CREATE INDEX "requisitions_created_by_user_id_idx" ON "requisitions" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "requisitions_submitted_by_user_id_idx" ON "requisitions" USING btree ("submitted_by_user_id");--> statement-breakpoint
CREATE INDEX "requisitions_approver_id_idx" ON "requisitions" USING btree ("approver_id");--> statement-breakpoint
CREATE INDEX "application_history_application_id_idx" ON "application_history" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "application_history_changed_by_user_id_idx" ON "application_history" USING btree ("changed_by_user_id");--> statement-breakpoint
CREATE INDEX "applications_requisition_id_email_hash_applied_at_idx" ON "applications" USING btree ("requisition_id","email_hash","applied_at");--> statement-breakpoint
CREATE INDEX "files_owner_type_owner_id_idx" ON "files" USING btree ("owner_type","owner_id");--> statement-breakpoint
CREATE INDEX "prescreen_answers_application_id_idx" ON "prescreen_answers" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "prescreen_answers_question_id_idx" ON "prescreen_answers" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "interview_participants_user_id_idx" ON "interview_participants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "interview_scorecards_interviewer_id_idx" ON "interview_scorecards" USING btree ("interviewer_id");--> statement-breakpoint
CREATE INDEX "interviews_application_id_idx" ON "interviews" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "interviews_created_by_user_id_idx" ON "interviews" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "approval_events_subject_type_subject_id_created_at_idx" ON "approval_events" USING btree ("subject_type","subject_id","created_at");--> statement-breakpoint
CREATE INDEX "approval_events_actor_user_id_idx" ON "approval_events" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "approval_events_from_approver_id_idx" ON "approval_events" USING btree ("from_approver_id");--> statement-breakpoint
CREATE INDEX "approval_events_to_approver_id_idx" ON "approval_events" USING btree ("to_approver_id");--> statement-breakpoint
CREATE INDEX "offers_application_id_idx" ON "offers" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "offers_template_id_idx" ON "offers" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "offers_created_by_user_id_idx" ON "offers" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "offers_submitted_by_user_id_idx" ON "offers" USING btree ("submitted_by_user_id");--> statement-breakpoint
CREATE INDEX "offers_approver_id_idx" ON "offers" USING btree ("approver_id");--> statement-breakpoint
CREATE INDEX "email_log_application_id_idx" ON "email_log" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "email_log_requisition_id_idx" ON "email_log" USING btree ("requisition_id");--> statement-breakpoint
CREATE INDEX "email_log_template_id_idx" ON "email_log" USING btree ("template_id");