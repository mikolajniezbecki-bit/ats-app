// Template validation without a database (ats-project-scope.md §5.1, §7
// templates.schema_json, E9).
import { describe, expect, it } from "vitest";
import { createTemplateSchema, schemaGrowthError, schemaJsonSchema } from "@/server/templates";

const field = (overrides: Record<string, unknown> = {}) => ({ key: "cost_center", label: "Cost center", type: "TEXT", required: false, ...overrides });
const codes = (input: unknown) => {
  const result = schemaJsonSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
};

describe("schema_json", () => {
  it("accepts an empty list and well-formed fields", () => {
    expect(codes([])).toEqual([]);
    expect(codes([field(), field({ key: "level", type: "PICKLIST", picklist_key: "seniority", required: true })])).toEqual([]);
  });

  it("rejects a PICKLIST field without picklist_key", () => {
    expect(codes([field({ type: "PICKLIST" })])).toContain("picklistKeyRequired");
  });

  it("rejects a TEXT field with picklist_key", () => {
    expect(codes([field({ picklist_key: "seniority" })])).toContain("picklistKeyNotAllowed");
  });

  it("rejects duplicate keys", () => {
    expect(codes([field(), field({ label: "Again" })])).toContain("duplicateKey");
  });

  it.each(["Cost Center", "1st", "_x", "a".repeat(51), "costCenter"])("rejects the key %j", (key) => {
    expect(codes([field({ key })])).toContain("fieldKey");
  });

  it("rejects an unknown type, a missing required flag and more than 50 fields", () => {
    expect(codes([field({ type: "DATE" })])).toContain("fieldType");
    expect(codes([{ key: "x", label: "X", type: "TEXT" }])).toContain("fieldRequiredFlag");
    expect(codes(Array.from({ length: 51 }, (_, i) => field({ key: `f${i}` })))).toContain("tooManyFields");
  });
});

describe("create schema", () => {
  it("requires the fields of each type and refuses the ones that must stay empty", () => {
    expect(createTemplateSchema.safeParse({ type: "EMAIL", name: "x", subject: "s", body: "b" }).success).toBe(true);
    expect(createTemplateSchema.safeParse({ type: "EMAIL", name: "x", body: "b" }).success).toBe(false);
    expect(createTemplateSchema.safeParse({ type: "OFFER", name: "x", body: "b", subject: "s" }).success).toBe(false);
    expect(createTemplateSchema.safeParse({ type: "OFFER", name: "x", body: "b", triggerStatus: "REJECTED" }).success).toBe(false);
    expect(createTemplateSchema.safeParse({ type: "REQUISITION", name: "x", schemaJson: [], body: "b" }).success).toBe(false);
    expect(createTemplateSchema.safeParse({ type: "REQUISITION", name: "x" }).success).toBe(false);
    expect(createTemplateSchema.safeParse({ type: "EMAIL", name: " ", subject: "s", body: "b" }).success).toBe(false);
    expect(createTemplateSchema.safeParse({ type: "EMAIL", name: "x", subject: "a\nb", body: "b" }).success).toBe(false);
  });
});

describe("schema growth once requisitions use a template", () => {
  const before = [field(), field({ key: "level", type: "PICKLIST", picklist_key: "seniority" })] as never[];

  it("allows a label change and a new optional field", () => {
    expect(schemaGrowthError(before, [field({ label: "Renamed" }), ...before.slice(1), field({ key: "extra" })] as never[])).toBeUndefined();
  });

  it("refuses removing a field, changing its type or picklist, making it required, or adding a required one", () => {
    expect(schemaGrowthError(before, before.slice(1))).toEqual({ code: "fieldRemoved", token: "cost_center" });
    expect(schemaGrowthError(before, [field({ type: "NUMBER" }), before[1]] as never[])).toEqual({ code: "fieldChanged", token: "cost_center" });
    expect(schemaGrowthError(before, [field(), field({ key: "level", type: "PICKLIST", picklist_key: "other" })] as never[])).toEqual({
      code: "fieldChanged",
      token: "level",
    });
    expect(schemaGrowthError(before, [field({ required: true }), before[1]] as never[])).toEqual({ code: "fieldNowRequired", token: "cost_center" });
    expect(schemaGrowthError(before, [...before, field({ key: "extra", required: true })] as never[])).toEqual({ code: "newFieldRequired", token: "extra" });
  });
});
