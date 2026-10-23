// Master data input rules (ats-project-scope.md §5.1).
import { describe, expect, it } from "vitest";
import { createMasterDataSchema, fieldErrors, pickerQuerySchema, updateMasterDataSchema } from "@/server/master-data";
import { message } from "@/server/messages";

describe("master data input", () => {
  it("trims and upper-cases the code and trims the label", () => {
    expect(createMasterDataSchema.parse({ type: "DEPARTMENT", code: " eng-1_a ", label: " Engineering " })).toEqual({
      type: "DEPARTMENT",
      code: "ENG-1_A",
      label: "Engineering",
    });
  });

  it.each([
    [{ type: "DEPARTMENT", code: "", label: "x" }, "code"],
    [{ type: "DEPARTMENT", code: "A B", label: "x" }, "code"],
    [{ type: "DEPARTMENT", code: "A".repeat(51), label: "x" }, "code"],
    [{ type: "DEPARTMENT", code: "A", label: " " }, "label"],
    [{ type: "DEPARTMENT", code: "A", label: "x".repeat(201) }, "label"],
    [{ type: "OTHER", code: "A", label: "x" }, "type"],
    [{ type: "PICKLIST", code: "A", label: "x" }, "picklistKey"],
    [{ type: "PICKLIST", code: "A", label: "x", picklistKey: "Upper" }, "picklistKey"],
    [{ type: "LOCATION", code: "A", label: "x", picklistKey: "seniority" }, "picklistKey"],
  ])("refuses %j (field %s)", (input, field) => {
    const result = createMasterDataSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(Object.keys(fieldErrors(result.error!))).toContain(field);
  });

  it("accepts a picklist value with its key", () => {
    expect(createMasterDataSchema.parse({ type: "PICKLIST", code: "senior", label: "Senior", picklistKey: "seniority" })).toMatchObject({
      code: "SENIOR",
      picklistKey: "seniority",
    });
  });

  it("allows only label and active flag to change; code, type and picklist key are refused", () => {
    expect(updateMasterDataSchema.parse({ label: "New", isActive: false })).toEqual({ label: "New", isActive: false });
    for (const field of ["code", "type", "picklistKey"]) {
      const result = updateMasterDataSchema.safeParse({ label: "New", [field]: "X" });
      expect(result.success, field).toBe(false);
      expect(fieldErrors(result.error!)[field]).toBe("notEditable");
    }
    expect(updateMasterDataSchema.safeParse({}).success).toBe(false);
  });

  it("the picker needs a valid type, and a picklist key for PICKLIST", () => {
    expect(pickerQuerySchema.safeParse({ type: "LOCATION" }).success).toBe(true);
    expect(pickerQuerySchema.safeParse({}).success).toBe(false);
    expect(pickerQuerySchema.safeParse({ type: "nope" }).success).toBe(false);
    expect(pickerQuerySchema.safeParse({ type: "PICKLIST" }).success).toBe(false);
    expect(pickerQuerySchema.safeParse({ type: "PICKLIST", picklistKey: "seniority" }).success).toBe(true);
  });

  it("reads API texts from messages/en.json", () => {
    expect(message("AdminMasterData.errors.duplicate")).toBe("A record with this code already exists.");
    expect(message("AdminMasterData.errors.inUse")).toBe("This record is in use and can only be deactivated.");
    expect(message("AdminSettings.errors.privacyVersion")).toBe("Change the version when you change the statement text.");
    expect(() => message("AdminMasterData.errors.nope")).toThrow("No message");
  });
});
