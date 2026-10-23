// Custom fields checked against a requisition template's schema
// (ats-project-scope.md §7 `templates.schema_json`), and the L9 slug format.
import { describe, expect, it } from "vitest";
import { type CustomFieldDefinition, customFieldErrors, normalizeCustomFields } from "@/server/domain/requisitions/custom-fields";
import { PRIVATE_SLUG_PATTERN, generatePrivateSlug } from "@/server/domain/requisitions/slug";

const schema: CustomFieldDefinition[] = [
  { key: "employment_type", label: "Employment type", type: "PICKLIST", picklist_key: "employment_type", required: true },
  { key: "cost_center", label: "Cost center", type: "TEXT", required: false },
  { key: "budget", label: "Budget", type: "NUMBER", required: false },
  { key: "remote", label: "Remote", type: "BOOLEAN", required: false },
];
const codes = () => new Set(["FULL_TIME", "PART_TIME"]);
const errors = (values: Record<string, unknown>) => customFieldErrors(schema, values, codes);

describe("customFieldErrors", () => {
  it("accepts valid values, and null for optional fields", () => {
    expect(errors({ employment_type: "FULL_TIME", cost_center: "CC-1", budget: 1.5, remote: false })).toEqual({});
    expect(errors({ employment_type: "PART_TIME", cost_center: null, budget: null, remote: null })).toEqual({});
    expect(errors({ employment_type: "PART_TIME" })).toEqual({});
  });

  it("a required field needs a value", () => {
    expect(errors({})).toEqual({ employment_type: "required" });
    expect(errors({ employment_type: null })).toEqual({ employment_type: "required" });
    expect(errors({ employment_type: "" })).toEqual({ employment_type: "required" });
  });

  it("TEXT is a string of at most 1,000 characters", () => {
    expect(errors({ employment_type: "FULL_TIME", cost_center: 5 })).toEqual({ cost_center: "text" });
    expect(errors({ employment_type: "FULL_TIME", cost_center: "x".repeat(1001) })).toEqual({ cost_center: "text" });
    expect(errors({ employment_type: "FULL_TIME", cost_center: "x".repeat(1000) })).toEqual({});
  });

  it("NUMBER is a finite number", () => {
    expect(errors({ employment_type: "FULL_TIME", budget: "12" })).toEqual({ budget: "number" });
    expect(errors({ employment_type: "FULL_TIME", budget: Number.POSITIVE_INFINITY })).toEqual({ budget: "number" });
    expect(errors({ employment_type: "FULL_TIME", budget: Number.NaN })).toEqual({ budget: "number" });
  });

  it("BOOLEAN is a boolean", () => {
    expect(errors({ employment_type: "FULL_TIME", remote: "true" })).toEqual({ remote: "boolean" });
  });

  it("PICKLIST is one of the allowed codes", () => {
    expect(errors({ employment_type: "CONTRACT" })).toEqual({ employment_type: "picklist" });
    expect(errors({ employment_type: 1 })).toEqual({ employment_type: "picklist" });
  });

  it("keys that aren't in the schema are rejected", () => {
    expect(errors({ employment_type: "FULL_TIME", salary_band: "B" })).toEqual({ salary_band: "unknownField" });
  });

  it("a blank requisition has no fields to fill", () => {
    expect(customFieldErrors([], {}, codes)).toEqual({});
    expect(customFieldErrors([], { anything: 1 }, codes)).toEqual({ anything: "unknownField" });
  });

  it("normalizes to every schema key, empty values as null", () => {
    expect(normalizeCustomFields(schema, { employment_type: "FULL_TIME", cost_center: "" })).toEqual({
      employment_type: "FULL_TIME",
      cost_center: null,
      budget: null,
      remote: null,
    });
  });
});

describe("generatePrivateSlug", () => {
  it("L9: is 32 random lower-case hex characters", () => {
    const first = generatePrivateSlug();
    expect(first).toMatch(PRIVATE_SLUG_PATTERN);
    expect(generatePrivateSlug()).not.toBe(first);
  });
});
