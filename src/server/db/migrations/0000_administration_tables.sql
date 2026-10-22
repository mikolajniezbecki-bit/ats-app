CREATE TABLE "master_data" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"picklist_key" text,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "master_data_type_picklist_key_code_unique" UNIQUE NULLS NOT DISTINCT("type","picklist_key","code"),
	CONSTRAINT "master_data_type_check" CHECK ("master_data"."type" IN ('DEPARTMENT', 'LOCATION', 'LEGAL_ENTITY', 'PICKLIST')),
	CONSTRAINT "master_data_picklist_key_check" CHECK (("master_data"."type" = 'PICKLIST') = ("master_data"."picklist_key" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"trigger_status" text,
	"subject" text,
	"body" text,
	"schema_json" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "templates_type_name_unique" UNIQUE("type","name"),
	CONSTRAINT "templates_type_check" CHECK ("templates"."type" IN ('REQUISITION', 'EMAIL', 'OFFER')),
	CONSTRAINT "templates_trigger_status_check" CHECK ("templates"."trigger_status" IN ('APPLIED', 'SCREENING', 'INTERVIEW', 'OFFER', 'HIRED', 'REJECTED', 'WITHDRAWN')),
	CONSTRAINT "templates_trigger_status_email_only_check" CHECK ("templates"."trigger_status" IS NULL OR "templates"."type" = 'EMAIL')
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"role" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_email_lower_case_check" CHECK ("users"."email" = lower("users"."email")),
	CONSTRAINT "users_role_check" CHECK ("users"."role" IN ('ADMIN', 'RECRUITER', 'HIRING_MANAGER', 'INTERVIEWER'))
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"subject_type" text,
	"subject_id" text,
	"details_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_name" text NOT NULL,
	"run_date" date NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_runs_job_name_run_date_unique" UNIQUE("job_name","run_date"),
	CONSTRAINT "job_runs_status_check" CHECK ("job_runs"."status" IN ('RUNNING', 'COMPLETED', 'FAILED'))
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_limits_pkey" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "settings_updated_by_idx" ON "settings" USING btree ("updated_by");--> statement-breakpoint
CREATE UNIQUE INDEX "templates_active_email_trigger_status_unique" ON "templates" USING btree ("trigger_status") WHERE type = 'EMAIL' AND is_active AND trigger_status IS NOT NULL;--> statement-breakpoint
CREATE INDEX "audit_log_actor_user_id_idx" ON "audit_log" USING btree ("actor_user_id");