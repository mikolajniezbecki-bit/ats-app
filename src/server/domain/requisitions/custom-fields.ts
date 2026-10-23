// Custom fields of a requisition (ats-project-scope.md §7 `templates.schema_json`,
// `requisitions.custom_fields_json`), checked on every save against the
// template's current schema. Pure: the caller passes the picklist codes it
// may accept (active ones, plus the value already stored, §5.1).

export type CustomFieldType = "TEXT" | "NUMBER" | "BOOLEAN" | "PICKLIST";
export type CustomFieldDefinition = { key: string; label: string; type: CustomFieldType; picklist_key?: string; required: boolean };
export type CustomFieldValue = string | number | boolean | null;
export type CustomFields = Record<string, CustomFieldValue>;

export const MAX_TEXT_FIELD_LENGTH = 1_000;

/** Why one field is wrong; the key is the field key. */
export type CustomFieldErrorCode = "unknownField" | "required" | "text" | "number" | "boolean" | "picklist";

/**
 * Field key → error code, empty when the values are valid. `allowedCodes(field)`
 * returns the picklist codes accepted for a PICKLIST field.
 */
export function customFieldErrors(
  schema: readonly CustomFieldDefinition[],
  values: Record<string, unknown>,
  allowedCodes: (field: CustomFieldDefinition) => ReadonlySet<string>,
): Record<string, CustomFieldErrorCode> {
  const errors: Record<string, CustomFieldErrorCode> = {};
  const byKey = new Map(schema.map((field) => [field.key, field]));
  for (const key of Object.keys(values)) {
    if (!byKey.has(key)) errors[key] = "unknownField";
  }
  for (const field of schema) {
    const value = Object.hasOwn(values, field.key) ? values[field.key] : null;
    if (value === null || value === undefined || value === "") {
      if (field.required) errors[field.key] = "required";
      continue;
    }
    if (field.type === "TEXT" && (typeof value !== "string" || value.length > MAX_TEXT_FIELD_LENGTH)) errors[field.key] = "text";
    if (field.type === "NUMBER" && (typeof value !== "number" || !Number.isFinite(value))) errors[field.key] = "number";
    if (field.type === "BOOLEAN" && typeof value !== "boolean") errors[field.key] = "boolean";
    if (field.type === "PICKLIST" && (typeof value !== "string" || !allowedCodes(field).has(value))) errors[field.key] = "picklist";
  }
  return errors;
}

/** The values to store: every schema key, empty strings and missing ones as null. */
export function normalizeCustomFields(schema: readonly CustomFieldDefinition[], values: Record<string, unknown>): CustomFields {
  const result: CustomFields = {};
  for (const field of schema) {
    const value = values[field.key];
    result[field.key] = value === undefined || value === "" ? null : (value as CustomFieldValue);
  }
  return result;
}
