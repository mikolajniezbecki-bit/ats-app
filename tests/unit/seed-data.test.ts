// The seed's templates and master data pass the same rules an Admin's input
// does (ats-project-scope.md §5.1; tech-stack.md D8), so a broken seeded
// template fails `pnpm verify` instead of a later email.
import { describe, expect, it } from "vitest";
import { SEED_DEMO_USERS, SEED_MASTER_DATA, SEED_TEMPLATES } from "@/server/db/seed/data";
import { checkTokens, tokensIn } from "@/server/domain/tokens";
import { createMasterDataSchema } from "@/server/master-data";
import { createTemplateSchema } from "@/server/templates";

describe("seed data", () => {
  it.each(SEED_TEMPLATES.map((template) => [template.name, template] as const))("template %s passes the template schema and token scopes", (_name, template) => {
    expect(createTemplateSchema.safeParse(template).error).toBeUndefined();
    if (template.type === "EMAIL") {
      expect(() => checkTokens(template.subject, "emailSubject")).not.toThrow();
      expect(() => checkTokens(template.body, "emailBody")).not.toThrow();
      expect(tokensIn(template.body)).not.toEqual(expect.arrayContaining(["INTERVIEW_DATETIME"]));
    }
    if (template.type === "OFFER") expect(() => checkTokens(template.body, "offerBody")).not.toThrow();
  });

  it("ships the stage, bulk, offer and requisition templates D8 lists", () => {
    const byName = Object.fromEntries(SEED_TEMPLATES.map((template) => [template.name, template]));
    expect(byName["Application received"]).toMatchObject({ type: "EMAIL", triggerStatus: "APPLIED" });
    expect(byName["Application rejected"]).toMatchObject({ type: "EMAIL", triggerStatus: "REJECTED" });
    expect(byName["Application update"]).toMatchObject({ type: "EMAIL", triggerStatus: null });
    expect(byName["Interview preparation"]).toMatchObject({ type: "EMAIL", triggerStatus: null });
    expect(byName["Default offer letter"]).toMatchObject({ type: "OFFER" });
    expect(byName["Standard requisition"]).toMatchObject({ type: "REQUISITION" });
    const offer = byName["Default offer letter"];
    expect(offer.type === "OFFER" && tokensIn(offer.body).sort()).toEqual(
      ["CANDIDATE_FULL_NAME", "JOB_TITLE", "LEGAL_ENTITY", "OFFER_SALARY", "OFFER_CURRENCY", "START_DATE", "HIRING_MGR_FULL_NAME", "RECRUITER_FULL_NAME"].sort(),
    );
  });

  it("every picklist field of the requisition template points at seeded picklist values", () => {
    const keys = new Set(SEED_MASTER_DATA.flatMap((record) => (record.picklistKey ? [record.picklistKey] : [])));
    for (const template of SEED_TEMPLATES) {
      if (template.type !== "REQUISITION") continue;
      for (const field of template.schemaJson) if (field.type === "PICKLIST") expect(keys, field.key).toContain(field.picklist_key);
    }
  });

  it("every master data record passes the Admin create rules", () => {
    for (const record of SEED_MASTER_DATA) expect(createMasterDataSchema.safeParse(record).error, record.code).toBeUndefined();
  });

  it("has one demo user per role", () => {
    expect(SEED_DEMO_USERS.map((user) => user.role).sort()).toEqual(["ADMIN", "HIRING_MANAGER", "INTERVIEWER", "RECRUITER"]);
    expect(SEED_DEMO_USERS.map((user) => user.localPart)).toEqual(["admin", "recruiter", "hm", "interviewer"]);
  });
});
