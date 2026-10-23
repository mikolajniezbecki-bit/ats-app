// Requisition drafting (ats-project-scope.md §5.2, L9, L11, V2, V3a; tech-stack.md
// D3, D6, D7): create from a template, blank or as a duplicate, and edit
// drafts. Every save checks the references (right master data type, right
// user role, active unless already stored, §5.1), the custom fields against
// the template's current schema and the description allowlist, in the
// caller's transaction. Logs carry IDs only, never titles or descriptions (M2).
import { and, asc, count, desc, eq, inArray, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { type Db, type Tx, getDb } from "../db";
import { rootCause } from "../db/migrator";
import { RecordNotFoundError, StaleRecordError, updateWithVersion } from "../db/optimistic-lock";
import {
  POSTING_TYPES,
  REQUISITION_STATES,
  masterData,
  prescreenQuestions,
  requisitionHistory,
  requisitions,
  templates,
  users,
} from "../db/schema";
import {
  type CustomFieldDefinition,
  type CustomFields,
  customFieldErrors,
  normalizeCustomFields,
} from "../domain/requisitions/custom-fields";
import { MAX_DESCRIPTION_LENGTH, hasVisibleText, sanitizeDescription } from "../domain/requisitions/description";
import { generatePrivateSlug } from "../domain/requisitions/slug";
import { logger } from "../logger";
import { scopeRequisitionsFor } from "../policy/filters";
import { type PolicyUser, can } from "../policy/permissions";

export type RequisitionRow = typeof requisitions.$inferSelect;
export type RequisitionState = (typeof REQUISITION_STATES)[number];
export type PostingType = (typeof POSTING_TYPES)[number];

export const PAGE_SIZE = 50;

/** The four fields whose change needs re-approval once approved (L2), recorded in history (L11). */
export const L2_FIELDS = ["openingsCount", "departmentId", "hiringManagerId", "legalEntityId"] as const;
const L2_COLUMNS: Record<(typeof L2_FIELDS)[number], string> = {
  openingsCount: "openings_count",
  departmentId: "department_id",
  hiringManagerId: "hiring_manager_id",
  legalEntityId: "legal_entity_id",
};

const MASTER_DATA_FIELDS = {
  departmentId: "DEPARTMENT",
  locationId: "LOCATION",
  legalEntityId: "LEGAL_ENTITY",
} as const;

/** Roles each user field accepts (§5.2). */
export const USER_FIELD_ROLES = {
  recruiterId: ["RECRUITER", "ADMIN"],
  hiringManagerId: ["HIRING_MANAGER", "ADMIN"],
} as const;

const customFieldValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const fields = {
  title: z.string().trim().min(1).max(200),
  departmentId: z.uuid(),
  locationId: z.uuid(),
  legalEntityId: z.uuid(),
  hiringManagerId: z.uuid(),
  recruiterId: z.uuid(),
  openingsCount: z.number().int().min(1).max(1000),
  descriptionHtml: z.string().max(MAX_DESCRIPTION_LENGTH),
  postingType: z.enum(POSTING_TYPES),
  customFields: z.record(z.string(), customFieldValue),
};

export const createRequisitionSchema = z
  .object({
    ...fields,
    descriptionHtml: fields.descriptionHtml.default(""),
    customFields: fields.customFields.default({}),
    templateId: z.uuid().nullable().optional(),
    // Saving a duplicate also copies the source's active questions (§5.2).
    duplicateOfId: z.uuid().optional(),
  })
  .strict();

/** The template and the slug can't be set through PATCH (strict: unknown keys are refused). */
export const updateRequisitionSchema = z
  .object({
    version: z.number().int().min(1),
    title: fields.title.optional(),
    departmentId: fields.departmentId.optional(),
    locationId: fields.locationId.optional(),
    legalEntityId: fields.legalEntityId.optional(),
    hiringManagerId: fields.hiringManagerId.optional(),
    recruiterId: fields.recruiterId.optional(),
    openingsCount: fields.openingsCount.optional(),
    descriptionHtml: fields.descriptionHtml.optional(),
    postingType: fields.postingType.optional(),
    customFields: fields.customFields.optional(),
  })
  .strict();

export const listQuerySchema = z.object({
  state: z.enum(REQUISITION_STATES).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});

/** Field → error code for messages/en.json (`Requisitions.errors.<code>`); custom fields as `customFields.<key>`. */
export type FieldErrors = Record<string, string>;

export type RequisitionResult =
  | { ok: true; requisition: RequisitionRow }
  | { ok: false; reason: "invalid"; fields: FieldErrors }
  | { ok: false; reason: "notFound" | "forbidden" | "stale" | "notEditable" | "awaitingApproval" };

/** The editable values of a requisition, as the service checks them. */
type Values = {
  title: string;
  departmentId: string;
  locationId: string;
  legalEntityId: string;
  hiringManagerId: string;
  recruiterId: string;
  openingsCount: number;
  descriptionHtml: string;
  postingType: PostingType;
  customFields: Record<string, unknown>;
};

const PG_UNIQUE_VIOLATION = "23505";
const SLUG_CONSTRAINT = "requisitions_private_slug_unique";
const SLUG_ATTEMPTS = 5;

function zodFields(error: z.ZodError): FieldErrors {
  const result: FieldErrors = {};
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) result[key] = "readOnlyField";
      continue;
    }
    result[String(issue.path[0] ?? "_")] ??= "invalid";
  }
  return result;
}

/**
 * Master data and user references (§5.1, §5.2): each must be of the right
 * type or role and active, unless it is the value already stored on this
 * requisition (`stored`), which may stay even if it was deactivated since.
 */
async function referenceErrors(db: Db | Tx, next: Values, stored?: RequisitionRow): Promise<FieldErrors> {
  const errors: FieldErrors = {};
  const changed = (field: keyof typeof MASTER_DATA_FIELDS | keyof typeof USER_FIELD_ROLES) =>
    !stored || stored[field] !== next[field];

  const mdFields = (Object.keys(MASTER_DATA_FIELDS) as (keyof typeof MASTER_DATA_FIELDS)[]).filter(changed);
  const mdRows = mdFields.length
    ? await db
        .select({ id: masterData.id, type: masterData.type, isActive: masterData.isActive })
        .from(masterData)
        .where(inArray(masterData.id, mdFields.map((field) => next[field])))
    : [];
  for (const field of mdFields) {
    const row = mdRows.find((candidate) => candidate.id === next[field]);
    if (!row || row.type !== MASTER_DATA_FIELDS[field]) errors[field] = "wrongType";
    else if (!row.isActive) errors[field] = "inactive";
  }

  const userFields = (Object.keys(USER_FIELD_ROLES) as (keyof typeof USER_FIELD_ROLES)[]).filter(changed);
  const userRows = userFields.length
    ? await db
        .select({ id: users.id, role: users.role, isActive: users.isActive })
        .from(users)
        .where(inArray(users.id, userFields.map((field) => next[field])))
    : [];
  for (const field of userFields) {
    const row = userRows.find((candidate) => candidate.id === next[field]);
    if (!row || !(USER_FIELD_ROLES[field] as readonly string[]).includes(row.role)) errors[field] = "wrongRole";
    else if (!row.isActive) errors[field] = "inactive";
  }
  return errors;
}

/** Checks the custom fields against the schema; stored picklist codes may stay when inactive. */
async function customFieldCheck(
  db: Db | Tx,
  schema: CustomFieldDefinition[],
  values: Record<string, unknown>,
  stored: Record<string, unknown>,
): Promise<{ errors: FieldErrors; normalized: CustomFields }> {
  const keys = [...new Set(schema.flatMap((field) => (field.type === "PICKLIST" && field.picklist_key ? [field.picklist_key] : [])))];
  const rows = keys.length
    ? await db
        .select({ picklistKey: masterData.picklistKey, code: masterData.code, isActive: masterData.isActive })
        .from(masterData)
        .where(and(eq(masterData.type, "PICKLIST"), inArray(masterData.picklistKey, keys)))
    : [];
  const allowed = (field: CustomFieldDefinition) =>
    new Set(
      rows
        .filter((row) => row.picklistKey === field.picklist_key && (row.isActive || stored[field.key] === row.code))
        .map((row) => row.code),
    );
  const errors = Object.fromEntries(
    Object.entries(customFieldErrors(schema, values, allowed)).map(([key, code]) => [`customFields.${key}`, code]),
  );
  return { errors, normalized: normalizeCustomFields(schema, values) };
}

async function loadTemplateSchema(db: Db | Tx, templateId: string): Promise<{ schema: CustomFieldDefinition[]; isActive: boolean } | undefined> {
  const [row] = await db
    .select({ type: templates.type, schemaJson: templates.schemaJson, isActive: templates.isActive })
    .from(templates)
    .where(eq(templates.id, templateId));
  if (!row || row.type !== "REQUISITION") return undefined;
  return { schema: (row.schemaJson as CustomFieldDefinition[] | null) ?? [], isActive: row.isActive };
}

function isSlugConflict(err: unknown): boolean {
  const cause = rootCause(err) as { code?: string; constraint?: string };
  return cause.code === PG_UNIQUE_VIOLATION && cause.constraint === SLUG_CONSTRAINT;
}

/**
 * Runs `write` in a savepoint with a new slug when one is needed (L9), and
 * again with another slug on the unlikely unique conflict.
 */
async function withSlugRetry<T>(tx: Tx, needsSlug: boolean, write: (sp: Tx, slug: string | undefined) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await tx.transaction((sp) => write(sp, needsSlug ? generatePrivateSlug() : undefined));
    } catch (err) {
      if (!needsSlug || attempt >= SLUG_ATTEMPTS || !isSlugConflict(err)) throw err;
    }
  }
}

/**
 * Creates a DRAFT requisition with the next `req_number` and one
 * `STATE_CHANGE` history row (L11). `user` must already be allowed
 * `requisition.create`. References must be active (a duplicate too).
 */
export async function createRequisition(tx: Tx, user: PolicyUser, input: unknown): Promise<RequisitionResult> {
  const parsed = createRequisitionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid", fields: zodFields(parsed.error) };
  const data = parsed.data;
  const descriptionHtml = sanitizeDescription(data.descriptionHtml);
  const values: Values = { ...data, descriptionHtml };

  const errors: FieldErrors = await referenceErrors(tx, values);
  if (descriptionHtml.length > MAX_DESCRIPTION_LENGTH) errors.descriptionHtml = "tooLong";
  let schema: CustomFieldDefinition[] = [];
  if (data.templateId) {
    const template = await loadTemplateSchema(tx, data.templateId);
    if (!template || !template.isActive) errors.templateId = "invalid";
    else schema = template.schema;
  }
  const custom = await customFieldCheck(tx, schema, data.customFields, {});
  Object.assign(errors, custom.errors);
  const source = data.duplicateOfId ? await findVisibleRequisition(user, data.duplicateOfId, tx) : undefined;
  if (data.duplicateOfId && !source) errors.duplicateOfId = "invalid";
  if (Object.keys(errors).length > 0) return { ok: false, reason: "invalid", fields: errors };

  const requisition = await withSlugRetry(tx, data.postingType === "PRIVATE", async (sp, slug) => {
    const [row] = await sp
      .insert(requisitions)
      .values({
        title: data.title,
        templateId: data.templateId ?? null,
        departmentId: data.departmentId,
        locationId: data.locationId,
        legalEntityId: data.legalEntityId,
        hiringManagerId: data.hiringManagerId,
        recruiterId: data.recruiterId,
        createdByUserId: user.id,
        openingsCount: data.openingsCount,
        descriptionHtml,
        customFieldsJson: custom.normalized,
        postingType: data.postingType,
        privateSlug: slug ?? null,
      })
      .returning();
    return row;
  });
  await tx.insert(requisitionHistory).values({
    requisitionId: requisition.id,
    event: "STATE_CHANGE",
    field: "state",
    oldValue: null,
    newValue: "DRAFT",
    userId: user.id,
  });
  if (source) await copyActiveQuestions(tx, source.id, requisition.id);
  logger.info({ requisition_id: requisition.id, user_id: user.id, duplicate_of: source?.id }, "requisition created");
  return { ok: true, requisition };
}

/** L8: in first-approval PENDING_APPROVAL (never approved), nothing on the requisition can change. */
export function isFirstApprovalPending(requisition: Pick<RequisitionRow, "state" | "approvedAt">): boolean {
  return requisition.state === "PENDING_APPROVAL" && requisition.approvedAt === null;
}

/**
 * The full check before submitting (A1, §5.2): a description with visible
 * text, active master data and users of a fitting role in every reference
 * (a draft may keep inactive stored values, but can't be submitted with
 * them), and custom fields valid against the template's current schema.
 */
export async function submissionErrors(db: Db | Tx, row: RequisitionRow): Promise<FieldErrors> {
  const customFields = (row.customFieldsJson as Record<string, unknown>) ?? {};
  const errors = await referenceErrors(db, { ...row, customFields });
  if (!hasVisibleText(row.descriptionHtml)) errors.descriptionHtml = "descriptionRequired";
  const template = row.templateId ? await loadTemplateSchema(db, row.templateId) : undefined;
  Object.assign(errors, (await customFieldCheck(db, template?.schema ?? [], customFields, {})).errors);
  return errors;
}

/** Copies the source's active questions in their order, as new active questions without answers. */
async function copyActiveQuestions(tx: Tx, sourceId: string, targetId: string): Promise<void> {
  const rows = await tx
    .select()
    .from(prescreenQuestions)
    .where(and(eq(prescreenQuestions.requisitionId, sourceId), eq(prescreenQuestions.isActive, true)))
    .orderBy(asc(prescreenQuestions.sortOrder), asc(prescreenQuestions.createdAt));
  if (rows.length === 0) return;
  await tx.insert(prescreenQuestions).values(
    rows.map((row, index) => ({
      requisitionId: targetId,
      questionText: row.questionText,
      questionType: row.questionType,
      optionsJson: row.optionsJson,
      weight: row.weight,
      scoringAnswer: row.scoringAnswer,
      disqualifyingAnswer: row.disqualifyingAnswer,
      isActive: true,
      sortOrder: index,
    })),
  );
}

/** The requisition if `user` may see it (D6), else undefined; also for malformed IDs. */
export async function findVisibleRequisition(user: PolicyUser, id: string, db: Db | Tx = getDb()): Promise<RequisitionRow | undefined> {
  if (!z.uuid().safeParse(id).success) return undefined;
  const [row] = await db.select().from(requisitions).where(and(scopeRequisitionsFor(user), eq(requisitions.id, id)));
  return row;
}

/**
 * Edits a draft with optimistic locking (D7). Outside the caller's scope it
 * is `notFound` (V9); a Hiring Manager editing a draft they didn't create is
 * `forbidden`; a stale version is `stale`; other states are `notEditable`
 * (later tasks add their edit rules). Changed L2 fields are written to
 * history (L11).
 */
export async function updateRequisition(tx: Tx, user: PolicyUser, id: string, input: unknown): Promise<RequisitionResult> {
  const current = await findVisibleRequisition(user, id, tx);
  if (!current) return { ok: false, reason: "notFound" };
  if (!can(user, "requisition.edit", current)) return { ok: false, reason: "forbidden" };
  const parsed = updateRequisitionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid", fields: zodFields(parsed.error) };
  const { version, ...changes } = parsed.data;
  if (current.version !== version) return { ok: false, reason: "stale" };
  // L8: nothing changes while a first approval is pending (A9 withdraws it).
  if (isFirstApprovalPending(current)) return { ok: false, reason: "awaitingApproval" };
  if (current.state !== "DRAFT") return { ok: false, reason: "notEditable" };

  const storedCustom = (current.customFieldsJson as Record<string, unknown>) ?? {};
  const descriptionHtml = changes.descriptionHtml === undefined ? current.descriptionHtml : sanitizeDescription(changes.descriptionHtml);
  const next: Values = {
    title: changes.title ?? current.title,
    departmentId: changes.departmentId ?? current.departmentId,
    locationId: changes.locationId ?? current.locationId,
    legalEntityId: changes.legalEntityId ?? current.legalEntityId,
    hiringManagerId: changes.hiringManagerId ?? current.hiringManagerId,
    recruiterId: changes.recruiterId ?? current.recruiterId,
    openingsCount: changes.openingsCount ?? current.openingsCount,
    descriptionHtml,
    postingType: changes.postingType ?? current.postingType,
    customFields: changes.customFields ?? storedCustom,
  };

  const errors = await referenceErrors(tx, next, current);
  if (descriptionHtml.length > MAX_DESCRIPTION_LENGTH) errors.descriptionHtml = "tooLong";
  // A deactivated template keeps working for requisitions that use it.
  const template = current.templateId ? await loadTemplateSchema(tx, current.templateId) : undefined;
  const custom = await customFieldCheck(tx, template?.schema ?? [], next.customFields, storedCustom);
  Object.assign(errors, custom.errors);
  if (Object.keys(errors).length > 0) return { ok: false, reason: "invalid", fields: errors };

  const needsSlug = next.postingType === "PRIVATE" && !current.privateSlug;
  let requisition: RequisitionRow;
  try {
    requisition = await withSlugRetry(tx, needsSlug, (sp, slug) =>
      updateWithVersion(sp, requisitions, id, version, {
        title: next.title,
        departmentId: next.departmentId,
        locationId: next.locationId,
        legalEntityId: next.legalEntityId,
        hiringManagerId: next.hiringManagerId,
        recruiterId: next.recruiterId,
        openingsCount: next.openingsCount,
        descriptionHtml,
        postingType: next.postingType,
        customFieldsJson: custom.normalized,
        ...(slug ? { privateSlug: slug } : {}),
      }),
    );
  } catch (err) {
    if (err instanceof StaleRecordError) return { ok: false, reason: "stale" };
    if (err instanceof RecordNotFoundError) return { ok: false, reason: "notFound" };
    throw err;
  }

  const history = L2_FIELDS.filter((field) => String(current[field]) !== String(next[field])).map((field) => ({
    requisitionId: id,
    event: "FIELD_CHANGE" as const,
    field: L2_COLUMNS[field],
    oldValue: String(current[field]),
    newValue: String(next[field]),
    userId: user.id,
  }));
  if (history.length > 0) await tx.insert(requisitionHistory).values(history);
  logger.info({ requisition_id: id, user_id: user.id, l2_changes: history.length }, "requisition updated");
  return { ok: true, requisition };
}

/** The values a duplicate starts from (§5.2); undefined when the source isn't visible. */
export async function duplicateValues(user: PolicyUser, id: string, db: Db | Tx = getDb()) {
  const source = await findVisibleRequisition(user, id, db);
  if (!source) return undefined;
  return {
    title: source.title,
    templateId: source.templateId,
    departmentId: source.departmentId,
    locationId: source.locationId,
    legalEntityId: source.legalEntityId,
    hiringManagerId: source.hiringManagerId,
    recruiterId: source.recruiterId,
    openingsCount: source.openingsCount,
    descriptionHtml: source.descriptionHtml,
    customFields: (source.customFieldsJson as CustomFields) ?? {},
    postingType: source.postingType,
  };
}

export type DuplicateValues = NonNullable<Awaited<ReturnType<typeof duplicateValues>>>;

const department = alias(masterData, "department");
const location = alias(masterData, "location");
const hiringManager = alias(users, "hiring_manager");
const recruiter = alias(users, "recruiter");

/** One page of the requisitions `user` may see, newest number first, with labels and names. */
export async function listRequisitions(
  user: PolicyUser,
  query: { state?: RequisitionState; page: number },
  db: Db | Tx = getDb(),
) {
  const where = and(scopeRequisitionsFor(user), query.state ? eq(requisitions.state, query.state) : undefined);
  const rows = await db
    .select({
      id: requisitions.id,
      reqNumber: requisitions.reqNumber,
      title: requisitions.title,
      state: requisitions.state,
      department: department.label,
      location: location.label,
      hiringManager: hiringManager.name,
      recruiter: recruiter.name,
      updatedAt: requisitions.updatedAt,
    })
    .from(requisitions)
    .innerJoin(department, eq(department.id, requisitions.departmentId))
    .innerJoin(location, eq(location.id, requisitions.locationId))
    .innerJoin(hiringManager, eq(hiringManager.id, requisitions.hiringManagerId))
    .innerJoin(recruiter, eq(recruiter.id, requisitions.recruiterId))
    .where(where)
    .orderBy(desc(requisitions.reqNumber))
    .limit(PAGE_SIZE)
    .offset((query.page - 1) * PAGE_SIZE);
  const [{ total }] = await db.select({ total: count() }).from(requisitions).where(where);
  return { rows, total, page: query.page, pageSize: PAGE_SIZE };
}

/** A visible requisition with the labels, names and active flags its page shows. */
export async function getRequisitionDetail(user: PolicyUser, id: string, db: Db | Tx = getDb()) {
  const requisition = await findVisibleRequisition(user, id, db);
  if (!requisition) return undefined;
  const refs = await db
    .select({ id: masterData.id, label: masterData.label, isActive: masterData.isActive })
    .from(masterData)
    .where(inArray(masterData.id, [requisition.departmentId, requisition.locationId, requisition.legalEntityId]));
  const people = await db
    .select({ id: users.id, name: users.name, role: users.role, isActive: users.isActive })
    .from(users)
    .where(
      or(
        eq(users.id, requisition.hiringManagerId),
        eq(users.id, requisition.recruiterId),
        requisition.approverId ? eq(users.id, requisition.approverId) : undefined,
      ),
    );
  const [template] = requisition.templateId
    ? await db
        .select({ name: templates.name, schemaJson: templates.schemaJson, isActive: templates.isActive })
        .from(templates)
        .where(eq(templates.id, requisition.templateId))
    : [];
  const ref = (refId: string) => refs.find((row) => row.id === refId)!;
  const person = (userId: string) => people.find((row) => row.id === userId)!;
  return {
    requisition,
    department: ref(requisition.departmentId),
    location: ref(requisition.locationId),
    legalEntity: ref(requisition.legalEntityId),
    hiringManager: person(requisition.hiringManagerId),
    recruiter: person(requisition.recruiterId),
    approver: requisition.approverId ? person(requisition.approverId) : undefined,
    template: template
      ? { name: template.name, schema: (template.schemaJson as CustomFieldDefinition[] | null) ?? [], isActive: template.isActive }
      : undefined,
  };
}

export type RequisitionDetail = NonNullable<Awaited<ReturnType<typeof getRequisitionDetail>>>;

/** Picklist values by key: the active ones, plus `keep` codes per key even when inactive. */
export async function picklistOptions(keep: Record<string, string[]> = {}, db: Db | Tx = getDb()) {
  const rows = await db
    .select({ picklistKey: masterData.picklistKey, code: masterData.code, label: masterData.label, isActive: masterData.isActive })
    .from(masterData)
    .where(eq(masterData.type, "PICKLIST"))
    .orderBy(asc(masterData.label), asc(masterData.code));
  const result: Record<string, { code: string; label: string; isActive: boolean }[]> = {};
  for (const row of rows) {
    if (!row.picklistKey || (!row.isActive && !(keep[row.picklistKey] ?? []).includes(row.code))) continue;
    (result[row.picklistKey] ??= []).push({ code: row.code, label: row.label, isActive: row.isActive });
  }
  return result;
}
