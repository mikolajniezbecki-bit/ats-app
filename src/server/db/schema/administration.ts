// Administration tables (ats-project-scope.md §7, tables 1–4).
import { sql } from "drizzle-orm";
import { boolean, check, index, jsonb, pgTable, text, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { enumCheck, id, timestamps } from "./columns";

export const USER_ROLES = ["ADMIN", "RECRUITER", "HIRING_MANAGER", "INTERVIEWER"] as const;
export const MASTER_DATA_TYPES = ["DEPARTMENT", "LOCATION", "LEGAL_ENTITY", "PICKLIST"] as const;
export const TEMPLATE_TYPES = ["REQUISITION", "EMAIL", "OFFER"] as const;
/** Application statuses; `templates.trigger_status` takes one of them (task 6 reuses the list). */
export const APPLICATION_STATUSES = [
  "APPLIED",
  "SCREENING",
  "INTERVIEW",
  "OFFER",
  "HIRED",
  "REJECTED",
  "WITHDRAWN",
] as const;

// Columns are named explicitly so the SQL names match §7 regardless of the
// TypeScript property names.
export const users = pgTable(
  "users",
  {
    id: id(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    role: text("role", { enum: USER_ROLES }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    unique("users_email_unique").on(t.email),
    check("users_email_lower_case_check", sql`${t.email} = lower(${t.email})`),
    enumCheck("users_role_check", t.role, USER_ROLES),
  ],
);

export const masterData = pgTable(
  "master_data",
  {
    id: id(),
    type: text("type", { enum: MASTER_DATA_TYPES }).notNull(),
    picklistKey: text("picklist_key"),
    code: text("code").notNull(),
    label: text("label").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    unique("master_data_type_picklist_key_code_unique").on(t.type, t.picklistKey, t.code).nullsNotDistinct(),
    enumCheck("master_data_type_check", t.type, MASTER_DATA_TYPES),
    // Grooming decision 3 (#9): otherwise a non-PICKLIST row with a stray
    // picklist_key would get around the unique constraint.
    check("master_data_picklist_key_check", sql`(${t.type} = 'PICKLIST') = (${t.picklistKey} IS NOT NULL)`),
  ],
);

export const templates = pgTable(
  "templates",
  {
    id: id(),
    type: text("type", { enum: TEMPLATE_TYPES }).notNull(),
    name: text("name").notNull(),
    triggerStatus: text("trigger_status", { enum: APPLICATION_STATUSES }),
    subject: text("subject"),
    body: text("body"),
    // Shape (§7) is validated by the template service (task 16), not here.
    schemaJson: jsonb("schema_json"),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    unique("templates_type_name_unique").on(t.type, t.name),
    enumCheck("templates_type_check", t.type, TEMPLATE_TYPES),
    enumCheck("templates_trigger_status_check", t.triggerStatus, APPLICATION_STATUSES),
    check("templates_trigger_status_email_only_check", sql`${t.triggerStatus} IS NULL OR ${t.type} = 'EMAIL'`),
    // One active stage email per status; bulk templates (NULL status) are exempt.
    uniqueIndex("templates_active_email_trigger_status_unique")
      .on(t.triggerStatus)
      .where(sql`type = 'EMAIL' AND is_active AND trigger_status IS NOT NULL`),
  ],
);

export const settings = pgTable(
  "settings",
  {
    key: text("key").primaryKey(),
    // Typed and validated per key by the settings service (task 14).
    value: text("value").notNull(),
    // NULL for seeded defaults.
    updatedBy: uuid("updated_by").references(() => users.id),
    ...timestamps(),
  },
  (t) => [index("settings_updated_by_idx").on(t.updatedBy)],
);
