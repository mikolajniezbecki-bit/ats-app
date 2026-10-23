// Picker options for the requisition form (ats-project-scope.md §5.1, §5.2):
// active records and users only, plus the values already stored on the
// requisition being edited, marked inactive when they are, so the form keeps
// showing them as selected.
import { inArray } from "drizzle-orm";
import { type Db, type Tx, getDb } from "../db";
import { masterData, users } from "../db/schema";
import type { CustomFieldDefinition } from "../domain/requisitions/custom-fields";
import { pickMasterData } from "../master-data";
import { listActiveTemplates } from "../templates";
import { listActiveUsers } from "../users";
import { USER_FIELD_ROLES, picklistOptions } from "./index";

export type FormOption = { id: string; label: string; inactive?: boolean };

export type FormOptions = {
  templates: { id: string; name: string; schema: CustomFieldDefinition[] }[];
  departments: FormOption[];
  locations: FormOption[];
  legalEntities: FormOption[];
  hiringManagers: FormOption[];
  recruiters: FormOption[];
  picklists: Record<string, { code: string; label: string; inactive?: boolean }[]>;
};

/** What is stored on the requisition being edited; absent for a new one or a duplicate. */
export type StoredValues = {
  departmentId: string;
  locationId: string;
  legalEntityId: string;
  hiringManagerId: string;
  recruiterId: string;
  customFields: Record<string, unknown>;
  schema: CustomFieldDefinition[];
};

function withStored(options: FormOption[], stored: FormOption | undefined): FormOption[] {
  if (!stored || options.some((option) => option.id === stored.id)) return options;
  return [stored, ...options];
}

export async function requisitionFormOptions(stored?: StoredValues, db: Db | Tx = getDb()): Promise<FormOptions> {
  const [templates, departments, locations, legalEntities, hiringManagers, recruiters] = await Promise.all([
    listActiveTemplates({ type: "REQUISITION" }, db),
    pickMasterData({ type: "DEPARTMENT" }, db),
    pickMasterData({ type: "LOCATION" }, db),
    pickMasterData({ type: "LEGAL_ENTITY" }, db),
    listActiveUsers({ roles: USER_FIELD_ROLES.hiringManagerId }, db),
    listActiveUsers({ roles: USER_FIELD_ROLES.recruiterId }, db),
  ]);
  const md = (rows: { id: string; label: string }[]): FormOption[] => rows.map((row) => ({ id: row.id, label: row.label }));
  const people = (rows: { id: string; name: string }[]): FormOption[] => rows.map((row) => ({ id: row.id, label: row.name }));

  let storedMd: FormOption[] = [];
  let storedUsers: FormOption[] = [];
  const keep: Record<string, string[]> = {};
  if (stored) {
    storedMd = (
      await db
        .select({ id: masterData.id, label: masterData.label, isActive: masterData.isActive })
        .from(masterData)
        .where(inArray(masterData.id, [stored.departmentId, stored.locationId, stored.legalEntityId]))
    ).map((row) => ({ id: row.id, label: row.label, inactive: !row.isActive }));
    storedUsers = (
      await db
        .select({ id: users.id, name: users.name, isActive: users.isActive })
        .from(users)
        .where(inArray(users.id, [stored.hiringManagerId, stored.recruiterId]))
    ).map((row) => ({ id: row.id, label: row.name, inactive: !row.isActive }));
    for (const field of stored.schema) {
      const value = stored.customFields[field.key];
      if (field.type === "PICKLIST" && field.picklist_key && typeof value === "string") (keep[field.picklist_key] ??= []).push(value);
    }
  }
  const find = (list: FormOption[], id?: string) => list.find((option) => option.id === id);
  const picklists = await picklistOptions(keep, db);

  return {
    templates: templates.map((template) => ({ id: template.id, name: template.name, schema: template.schemaJson ?? [] })),
    departments: withStored(md(departments), find(storedMd, stored?.departmentId)),
    locations: withStored(md(locations), find(storedMd, stored?.locationId)),
    legalEntities: withStored(md(legalEntities), find(storedMd, stored?.legalEntityId)),
    hiringManagers: withStored(people(hiringManagers), find(storedUsers, stored?.hiringManagerId)),
    recruiters: withStored(people(recruiters), find(storedUsers, stored?.recruiterId)),
    picklists: Object.fromEntries(
      Object.entries(picklists).map(([key, values]) => [
        key,
        values.map((value) => ({ code: value.code, label: value.label, ...(value.isActive ? {} : { inactive: true }) })),
      ]),
    ),
  };
}
