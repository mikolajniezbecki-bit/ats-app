// Master data (ats-project-scope.md §5.1): Departments, Locations, Legal
// Entities and picklist values. `code`, `type` and `picklist_key` never
// change after creation; a referenced record can only be deactivated; pickers
// offer active records only.
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { type Db, type Tx, getDb } from "../db";
import { rootCause } from "../db/migrator";
import { MASTER_DATA_TYPES, masterData, requisitions } from "../db/schema";

export type MasterDataType = (typeof MASTER_DATA_TYPES)[number];
export type MasterDataRow = typeof masterData.$inferSelect;
export type PickerOption = { id: string; code: string; label: string };

export const CODE_PATTERN = /^[A-Z0-9_-]{1,50}$/;
export const PICKLIST_KEY_PATTERN = /^[a-z0-9_]{1,50}$/;

const label = z.string().trim().min(1).max(200);

export const createMasterDataSchema = z
  .object({
    type: z.enum(MASTER_DATA_TYPES),
    code: z.string().trim().toUpperCase().regex(CODE_PATTERN),
    label,
    picklistKey: z.string().trim().regex(PICKLIST_KEY_PATTERN).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.type === "PICKLIST" && !value.picklistKey) {
      ctx.addIssue({ code: "custom", path: ["picklistKey"], message: "required" });
    }
    if (value.type !== "PICKLIST" && value.picklistKey !== undefined) {
      ctx.addIssue({ code: "custom", path: ["picklistKey"], message: "notAllowed" });
    }
  });

/** Only the label and the active flag change; code, type and picklist key are refused (strict). */
export const updateMasterDataSchema = z
  .object({ label: label.optional(), isActive: z.boolean().optional() })
  .strict()
  .refine((value) => value.label !== undefined || value.isActive !== undefined, { message: "empty" });

export const pickerQuerySchema = z
  .object({ type: z.enum(MASTER_DATA_TYPES), picklistKey: z.string().regex(PICKLIST_KEY_PATTERN).optional() })
  .refine((value) => value.type !== "PICKLIST" || value.picklistKey !== undefined, { path: ["picklistKey"], message: "required" });

/** Field name → error code, from a failed parse. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") for (const key of issue.keys) errors[key] = "notEditable";
    else errors[String(issue.path[0] ?? "_")] ??= issue.code === "custom" ? issue.message : "invalid";
  }
  return errors;
}

export type MasterDataResult =
  | { ok: true; row: MasterDataRow }
  | { ok: false; reason: "invalid"; errors: Record<string, string> }
  | { ok: false; reason: "duplicate" | "notFound" | "inUse" };

const PG_UNIQUE_VIOLATION = "23505";
const PG_FOREIGN_KEY_VIOLATION = "23503";

function pgCode(err: unknown): string | undefined {
  return (rootCause(err) as { code?: string }).code;
}

/** Admin list, ordered by type, picklist key and label; inactive records only when asked. */
export function listMasterData(options: { includeInactive: boolean }, db: Db | Tx = getDb()): Promise<MasterDataRow[]> {
  return db
    .select()
    .from(masterData)
    .where(options.includeInactive ? undefined : eq(masterData.isActive, true))
    .orderBy(asc(masterData.type), asc(masterData.picklistKey), asc(masterData.label), asc(masterData.code));
}

export async function createMasterData(tx: Tx, input: unknown): Promise<MasterDataResult> {
  const parsed = createMasterDataSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid", errors: fieldErrors(parsed.error) };
  const { type, code, label: text, picklistKey } = parsed.data;
  try {
    // A savepoint, so a duplicate leaves the caller's transaction usable.
    const [row] = await tx.transaction((sp) =>
      sp.insert(masterData).values({ type, code, label: text, picklistKey: picklistKey ?? null }).returning(),
    );
    return { ok: true, row };
  } catch (err) {
    if (pgCode(err) === PG_UNIQUE_VIOLATION) return { ok: false, reason: "duplicate" };
    throw err;
  }
}

export async function updateMasterData(tx: Tx, id: string, input: unknown): Promise<MasterDataResult> {
  const parsed = updateMasterDataSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid", errors: fieldErrors(parsed.error) };
  if (!z.uuid().safeParse(id).success) return { ok: false, reason: "notFound" };
  const [row] = await tx.update(masterData).set(parsed.data).where(eq(masterData.id, id)).returning();
  return row ? { ok: true, row } : { ok: false, reason: "notFound" };
}

/**
 * True when the record is referenced (§5.1): a Department, Location or Legal
 * Entity by a requisition; a picklist value by a requisition's custom field
 * whose template field is bound to the value's `picklist_key`.
 */
export async function isReferenced(tx: Db | Tx, row: MasterDataRow): Promise<boolean> {
  if (row.type === "PICKLIST") {
    const result = await tx.execute(sql`
      SELECT 1
      FROM requisitions r
      JOIN templates t ON t.id = r.template_id
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(t.schema_json) = 'array' THEN t.schema_json ELSE '[]'::jsonb END
      ) AS field
      WHERE field->>'type' = 'PICKLIST'
        AND field->>'picklist_key' = ${row.picklistKey}
        AND r.custom_fields_json->>(field->>'key') = ${row.code}
      LIMIT 1`);
    return result.rows.length > 0;
  }
  const column = {
    DEPARTMENT: requisitions.departmentId,
    LOCATION: requisitions.locationId,
    LEGAL_ENTITY: requisitions.legalEntityId,
  }[row.type];
  const [found] = await tx.select({ id: requisitions.id }).from(requisitions).where(eq(column, row.id)).limit(1);
  return found !== undefined;
}

/** Deletes an unreferenced record; a referenced one (or one referenced concurrently) is `inUse`. */
export async function deleteMasterData(tx: Tx, id: string): Promise<MasterDataResult> {
  if (!z.uuid().safeParse(id).success) return { ok: false, reason: "notFound" };
  const [row] = await tx.select().from(masterData).where(eq(masterData.id, id)).for("update");
  if (!row) return { ok: false, reason: "notFound" };
  if (await isReferenced(tx, row)) return { ok: false, reason: "inUse" };
  try {
    await tx.transaction((sp) => sp.delete(masterData).where(eq(masterData.id, id)));
  } catch (err) {
    // A requisition inserted after the check still holds the foreign key.
    if (pgCode(err) === PG_FOREIGN_KEY_VIOLATION) return { ok: false, reason: "inUse" };
    throw err;
  }
  return { ok: true, row };
}

/** Picker options: active records of one type (and picklist), sorted by label. */
export function pickMasterData(
  query: { type: MasterDataType; picklistKey?: string },
  db: Db | Tx = getDb(),
): Promise<PickerOption[]> {
  return db
    .select({ id: masterData.id, code: masterData.code, label: masterData.label })
    .from(masterData)
    .where(
      and(
        eq(masterData.type, query.type),
        eq(masterData.isActive, true),
        query.type === "PICKLIST" ? eq(masterData.picklistKey, query.picklistKey!) : undefined,
      ),
    )
    .orderBy(asc(masterData.label), asc(masterData.code));
}
