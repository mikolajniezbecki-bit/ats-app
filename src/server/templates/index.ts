// Templates (ats-project-scope.md §5.1, E8, E9): requisition templates with
// custom fields, email templates and offer templates. `type` and `name` are
// the identity (the seed finds templates by them, D8) and never change. A
// template used anywhere is deactivated, never deleted. Bodies are plain text
// with the P3 markup subset; tokens are checked against their scope on save.
// Logs carry template IDs only, never subjects or bodies (M2).
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { type Db, type Tx, getDb } from "../db";
import { rootCause } from "../db/migrator";
import { APPLICATION_STATUSES, TEMPLATE_TYPES, emailLog, masterData, offers, requisitions, templates } from "../db/schema";
import {
  type TokenScope,
  TokenNotAllowedError,
  UnclosedTokenError,
  UnknownTokenError,
  checkTokens,
} from "../domain/tokens";
import { logger } from "../logger";

export type TemplateType = (typeof TEMPLATE_TYPES)[number];
export type TemplateRow = typeof templates.$inferSelect;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

import { FIELD_KEY_PATTERN, FIELD_TYPES, MAX_FIELDS, TRIGGER_STATUSES } from "./shared";

export { FIELD_KEY_PATTERN, FIELD_TYPES, MAX_FIELDS, TRIGGER_STATUSES } from "./shared";

const PICKLIST_KEY_PATTERN = /^[a-z0-9_]{1,50}$/;

/** One custom field of a requisition template (§7 `templates.schema_json`). */
export type SchemaField = z.infer<typeof schemaFieldSchema>;

const schemaFieldSchema = z
  .object({
    key: z.string().regex(FIELD_KEY_PATTERN, { message: "fieldKey" }),
    label: z.string().trim().min(1, { message: "fieldLabel" }).max(200, { message: "fieldLabel" }),
    type: z.enum(FIELD_TYPES, { message: "fieldType" }),
    picklist_key: z.string().regex(PICKLIST_KEY_PATTERN, { message: "picklistKeyFormat" }).optional(),
    required: z.boolean({ message: "fieldRequiredFlag" }),
  })
  .strict()
  .superRefine((field, ctx) => {
    if (field.type === "PICKLIST" && field.picklist_key === undefined) {
      ctx.addIssue({ code: "custom", path: ["picklist_key"], message: "picklistKeyRequired" });
    }
    if (field.type !== "PICKLIST" && field.picklist_key !== undefined) {
      ctx.addIssue({ code: "custom", path: ["picklist_key"], message: "picklistKeyNotAllowed" });
    }
  });

/** `schema_json`: at most 50 fields with unique keys. */
export const schemaJsonSchema = z
  .array(schemaFieldSchema)
  .max(MAX_FIELDS, { message: "tooManyFields" })
  .superRefine((fields, ctx) => {
    const seen = new Set<string>();
    fields.forEach((field, index) => {
      if (seen.has(field.key)) ctx.addIssue({ code: "custom", path: [index, "key"], message: "duplicateKey" });
      seen.add(field.key);
    });
  });

const name = z.string().trim().min(1).max(100);
const subject = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !/[\r\n]/.test(value), { message: "subjectLine" });
const body = z.string().min(1).max(20_000);
// Any status parses here; INTERVIEW and OFFER are refused with their own
// message below (E9), other values are invalid.
const triggerStatus = z.enum(APPLICATION_STATUSES).nullable();
const isActive = z.boolean();

export const createTemplateSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("REQUISITION"), name, schemaJson: schemaJsonSchema, isActive: isActive.optional() }).strict(),
  z
    .object({ type: z.literal("EMAIL"), name, subject, body, triggerStatus: triggerStatus.optional(), isActive: isActive.optional() })
    .strict(),
  z.object({ type: z.literal("OFFER"), name, body, isActive: isActive.optional() }).strict(),
]);

/** What PATCH may change per type; `type` and `name` are refused. */
const updateSchemas = {
  REQUISITION: z.object({ schemaJson: schemaJsonSchema.optional(), isActive: isActive.optional() }).strict(),
  EMAIL: z
    .object({ subject: subject.optional(), body: body.optional(), triggerStatus: triggerStatus.optional(), isActive: isActive.optional() })
    .strict(),
  OFFER: z.object({ body: body.optional(), isActive: isActive.optional() }).strict(),
} as const;

/** A field's error: a code for messages/en.json, and the token or status it names. */
export type FieldError = { code: string; token?: string };

export type TemplateResult =
  | { ok: true; template: TemplateRow }
  | { ok: false; reason: "invalid"; fields: Record<string, FieldError> }
  | { ok: false; reason: "triggerConflict"; status: ApplicationStatus }
  | { ok: false; reason: "duplicate" | "notFound" | "inUse" };

export class TemplateNotFoundError extends Error {
  override name = "TemplateNotFoundError";
  constructor(
    readonly type: TemplateType,
    readonly templateName: string,
  ) {
    super(`No active ${type} template with that name`);
  }
}

const PG_UNIQUE_VIOLATION = "23505";
const PG_FOREIGN_KEY_VIOLATION = "23503";

function zodFields(error: z.ZodError): Record<string, FieldError> {
  const fields: Record<string, FieldError> = {};
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) fields[key] = { code: key === "type" || key === "name" ? "notEditable" : "notAllowed" };
      continue;
    }
    const field = String(issue.path[0] ?? "_");
    // Custom issues carry their message code (schema_json rules, one-line subject).
    const custom = (field === "schemaJson" || field === "subject") && /^[a-zA-Z]+$/.test(issue.message) ? issue.message : undefined;
    fields[field] ??= { code: custom ?? "invalid" };
  }
  return fields;
}

/** Checks tokens in a subject or body: known, closed, and allowed in `scope` (§5.1). */
function tokenError(text: string | undefined, scope: TokenScope): FieldError | undefined {
  if (text === undefined) return undefined;
  try {
    checkTokens(text, scope);
    return undefined;
  } catch (err) {
    if (err instanceof UnknownTokenError) return { code: "unknownToken", token: err.token };
    if (err instanceof UnclosedTokenError) return { code: "unclosedToken" };
    if (err instanceof TokenNotAllowedError) return { code: "tokenNotAllowed", token: err.token };
    throw err;
  }
}

/** The template as it would be after the change, for the checks that span fields. */
type Draft = {
  type: TemplateType;
  subject?: string | null;
  body?: string | null;
  triggerStatus?: ApplicationStatus | null;
  schemaJson?: SchemaField[];
};

async function semanticErrors(db: Db | Tx, draft: Draft): Promise<Record<string, FieldError>> {
  const fields: Record<string, FieldError> = {};
  if (draft.type === "EMAIL") {
    const subjectError = tokenError(draft.subject ?? undefined, "emailSubject");
    if (subjectError) fields.subject = subjectError;
    const bodyError = tokenError(draft.body ?? undefined, "emailBody");
    if (bodyError) fields.body = bodyError;
    if (draft.triggerStatus && !(TRIGGER_STATUSES as readonly string[]).includes(draft.triggerStatus)) {
      fields.triggerStatus = { code: "triggerNotAllowed" };
    }
  }
  if (draft.type === "OFFER") {
    const bodyError = tokenError(draft.body ?? undefined, "offerBody");
    if (bodyError) fields.body = bodyError;
  }
  if (draft.type === "REQUISITION" && draft.schemaJson) {
    // A PICKLIST field's key must exist in master data (active or not).
    for (const key of new Set(draft.schemaJson.flatMap((field) => (field.picklist_key ? [field.picklist_key] : [])))) {
      const [found] = await db
        .select({ id: masterData.id })
        .from(masterData)
        .where(and(eq(masterData.type, "PICKLIST"), eq(masterData.picklistKey, key)))
        .limit(1);
      if (!found) {
        fields.schemaJson = { code: "picklistKeyUnknown", token: key };
        break;
      }
    }
  }
  return fields;
}

/**
 * Once a requisition uses the template, its field list can only grow
 * (§5.1): existing fields keep key, type and picklist key and stay; an
 * optional field stays optional; new fields are optional. Labels may change.
 */
export function schemaGrowthError(before: SchemaField[], after: SchemaField[]): FieldError | undefined {
  const afterByKey = new Map(after.map((field) => [field.key, field]));
  for (const old of before) {
    const next = afterByKey.get(old.key);
    if (!next) return { code: "fieldRemoved", token: old.key };
    if (next.type !== old.type || next.picklist_key !== old.picklist_key) return { code: "fieldChanged", token: old.key };
    if (next.required && !old.required) return { code: "fieldNowRequired", token: old.key };
  }
  const existing = new Set(before.map((field) => field.key));
  const added = after.find((field) => !existing.has(field.key) && field.required);
  return added ? { code: "newFieldRequired", token: added.key } : undefined;
}

/** Another active EMAIL template already sending this status (E8: one per status). */
async function triggerConflict(db: Db | Tx, status: ApplicationStatus, exceptId?: string): Promise<boolean> {
  const [found] = await db
    .select({ id: templates.id })
    .from(templates)
    .where(
      and(
        eq(templates.type, "EMAIL"),
        eq(templates.isActive, true),
        eq(templates.triggerStatus, status),
        exceptId ? ne(templates.id, exceptId) : undefined,
      ),
    )
    .limit(1);
  return found !== undefined;
}

/** Maps a unique violation from a concurrent save to the same results as the checks. */
function uniqueViolation(err: unknown, status: ApplicationStatus | null | undefined): TemplateResult | undefined {
  const cause = rootCause(err) as { code?: string; constraint?: string };
  if (cause.code !== PG_UNIQUE_VIOLATION) return undefined;
  if (cause.constraint === "templates_active_email_trigger_status_unique" && status) {
    return { ok: false, reason: "triggerConflict", status };
  }
  if (cause.constraint === "templates_type_name_unique") return { ok: false, reason: "duplicate" };
  return undefined;
}

export async function createTemplate(tx: Tx, input: unknown): Promise<TemplateResult> {
  const parsed = createTemplateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid", fields: zodFields(parsed.error) };
  const data = parsed.data;
  const draft: Draft =
    data.type === "REQUISITION"
      ? { type: data.type, schemaJson: data.schemaJson }
      : data.type === "EMAIL"
        ? { type: data.type, subject: data.subject, body: data.body, triggerStatus: data.triggerStatus ?? null }
        : { type: data.type, body: data.body };
  const fields = await semanticErrors(tx, draft);
  if (Object.keys(fields).length > 0) return { ok: false, reason: "invalid", fields };

  const active = data.isActive ?? true;
  const [existing] = await tx
    .select({ id: templates.id })
    .from(templates)
    .where(and(eq(templates.type, data.type), eq(templates.name, data.name)));
  if (existing) return { ok: false, reason: "duplicate" };
  if (active && draft.triggerStatus && (await triggerConflict(tx, draft.triggerStatus))) {
    return { ok: false, reason: "triggerConflict", status: draft.triggerStatus };
  }

  try {
    const [template] = await tx.transaction((sp) =>
      sp
        .insert(templates)
        .values({
          type: data.type,
          name: data.name,
          subject: draft.subject ?? null,
          body: draft.body ?? null,
          triggerStatus: draft.triggerStatus ?? null,
          schemaJson: draft.schemaJson ?? null,
          isActive: active,
        })
        .returning(),
    );
    logger.info({ template_id: template.id }, "template created");
    return { ok: true, template };
  } catch (err) {
    const mapped = uniqueViolation(err, draft.triggerStatus);
    if (mapped) return mapped;
    throw err;
  }
}

async function isReferenced(db: Db | Tx, id: string): Promise<boolean> {
  const checks = [
    db.select({ id: requisitions.id }).from(requisitions).where(eq(requisitions.templateId, id)).limit(1),
    db.select({ id: offers.id }).from(offers).where(eq(offers.templateId, id)).limit(1),
    db.select({ id: emailLog.id }).from(emailLog).where(eq(emailLog.templateId, id)).limit(1),
  ];
  return (await Promise.all(checks)).some((rows) => rows.length > 0);
}

async function lockTemplate(tx: Tx, id: string): Promise<TemplateRow | undefined> {
  if (!z.uuid().safeParse(id).success) return undefined;
  const [row] = await tx.select().from(templates).where(eq(templates.id, id)).for("update");
  return row;
}

export async function updateTemplate(tx: Tx, id: string, input: unknown): Promise<TemplateResult> {
  const current = await lockTemplate(tx, id);
  if (!current) return { ok: false, reason: "notFound" };
  const parsed = updateSchemas[current.type].safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid", fields: zodFields(parsed.error) };
  const changes = parsed.data as {
    subject?: string;
    body?: string;
    triggerStatus?: ApplicationStatus | null;
    schemaJson?: SchemaField[];
    isActive?: boolean;
  };

  const draft: Draft = {
    type: current.type,
    subject: changes.subject ?? current.subject,
    body: changes.body ?? current.body,
    triggerStatus: changes.triggerStatus === undefined ? current.triggerStatus : changes.triggerStatus,
    schemaJson: changes.schemaJson,
  };
  const fields = await semanticErrors(tx, draft);
  if (changes.schemaJson && (await isUsedByRequisition(tx, id))) {
    const growth = schemaGrowthError((current.schemaJson as SchemaField[] | null) ?? [], changes.schemaJson);
    if (growth) fields.schemaJson = growth;
  }
  if (Object.keys(fields).length > 0) return { ok: false, reason: "invalid", fields };

  const active = changes.isActive ?? current.isActive;
  if (current.type === "EMAIL" && active && draft.triggerStatus && (await triggerConflict(tx, draft.triggerStatus, id))) {
    return { ok: false, reason: "triggerConflict", status: draft.triggerStatus };
  }

  try {
    const [template] = await tx.transaction((sp) =>
      sp
        .update(templates)
        .set({
          ...(changes.subject !== undefined ? { subject: changes.subject } : {}),
          ...(changes.body !== undefined ? { body: changes.body } : {}),
          ...(changes.triggerStatus !== undefined ? { triggerStatus: changes.triggerStatus } : {}),
          ...(changes.schemaJson !== undefined ? { schemaJson: changes.schemaJson } : {}),
          ...(changes.isActive !== undefined ? { isActive: changes.isActive } : {}),
        })
        .where(eq(templates.id, id))
        .returning(),
    );
    logger.info({ template_id: id }, "template updated");
    return { ok: true, template };
  } catch (err) {
    const mapped = uniqueViolation(err, draft.triggerStatus);
    if (mapped) return mapped;
    throw err;
  }
}

async function isUsedByRequisition(db: Db | Tx, id: string): Promise<boolean> {
  const [found] = await db.select({ id: requisitions.id }).from(requisitions).where(eq(requisitions.templateId, id)).limit(1);
  return found !== undefined;
}

/** Deletes a template nothing references; a used one (or one used concurrently) is `inUse`. */
export async function deleteTemplate(tx: Tx, id: string): Promise<TemplateResult> {
  const current = await lockTemplate(tx, id);
  if (!current) return { ok: false, reason: "notFound" };
  if (await isReferenced(tx, id)) return { ok: false, reason: "inUse" };
  try {
    await tx.transaction((sp) => sp.delete(templates).where(eq(templates.id, id)));
  } catch (err) {
    if ((rootCause(err) as { code?: string }).code === PG_FOREIGN_KEY_VIOLATION) return { ok: false, reason: "inUse" };
    throw err;
  }
  logger.info({ template_id: id }, "template deleted");
  return { ok: true, template: current };
}

/** The one resolver (§5.1): the active template of this type and name, or TemplateNotFoundError. */
export async function resolveTemplate(type: TemplateType, templateName: string, db: Db | Tx = getDb()): Promise<TemplateRow> {
  const [found] = await db
    .select()
    .from(templates)
    .where(and(eq(templates.type, type), eq(templates.name, templateName), eq(templates.isActive, true)));
  if (!found) throw new TemplateNotFoundError(type, templateName);
  return found;
}

/** E8: the active stage email for `status`, or null when none is set up. */
export async function getStageTemplate(status: ApplicationStatus, db: Db | Tx = getDb()): Promise<TemplateRow | null> {
  const [found] = await db
    .select()
    .from(templates)
    .where(and(eq(templates.type, "EMAIL"), eq(templates.isActive, true), eq(templates.triggerStatus, status)));
  return found ?? null;
}

export type TemplateOption = { id: string; name: string; schemaJson?: SchemaField[] };

/**
 * Active templates for pickers, sorted by name. `bulk` lists only EMAIL
 * templates without a trigger status (§5.4); requisition templates include
 * their fields.
 */
export async function listActiveTemplates(
  query: { type: TemplateType; bulk?: boolean },
  db: Db | Tx = getDb(),
): Promise<TemplateOption[]> {
  const rows = await db
    .select({ id: templates.id, name: templates.name, schemaJson: templates.schemaJson })
    .from(templates)
    .where(
      and(
        eq(templates.type, query.type),
        eq(templates.isActive, true),
        query.bulk ? isNull(templates.triggerStatus) : undefined,
      ),
    )
    .orderBy(asc(templates.name));
  return rows.map((row) =>
    query.type === "REQUISITION"
      ? { id: row.id, name: row.name, schemaJson: (row.schemaJson as SchemaField[] | null) ?? [] }
      : { id: row.id, name: row.name },
  );
}

export const templatePickerQuerySchema = z.object({
  type: z.enum(TEMPLATE_TYPES),
  bulk: z.enum(["true", "false"]).optional(),
});

/** Admin list: by type, then name; inactive ones only when asked. */
export function listTemplates(options: { includeInactive: boolean }, db: Db | Tx = getDb()): Promise<TemplateRow[]> {
  return db
    .select()
    .from(templates)
    .where(options.includeInactive ? undefined : eq(templates.isActive, true))
    .orderBy(asc(templates.type), asc(templates.name));
}

export async function getTemplate(id: string, db: Db | Tx = getDb()): Promise<TemplateRow | undefined> {
  if (!z.uuid().safeParse(id).success) return undefined;
  const [row] = await db.select().from(templates).where(eq(templates.id, id));
  return row;
}

