// Constraints of the administration tables (ats-project-scope.md §7, tables
// 1–3). Each test runs in a rolled-back transaction (see helpers.ts).
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { masterData, templates, users } from "@/server/db/schema";
import { PG, expectPgError, rolledBack, unique } from "./helpers";

describe("users", () => {
  const user = (email: string) => ({ email, name: "Test User", role: "RECRUITER" as const });

  it("rejects an unknown role", () =>
    rolledBack(async (tx) => {
      await expectPgError(
        tx,
        (sp) => sp.insert(users).values({ ...user(`${unique("role")}@example.com`), role: sql`'SUPERUSER'` as never }),
        { code: PG.checkViolation, constraint: "users_role_check" },
      );
    }));

  it("rejects an upper-case email", () =>
    rolledBack(async (tx) => {
      await expectPgError(tx, (sp) => sp.insert(users).values(user(`Admin-${unique("case")}@Example.com`)), {
        code: PG.checkViolation,
        constraint: "users_email_lower_case_check",
      });
    }));

  it("rejects a duplicate email", () =>
    rolledBack(async (tx) => {
      const email = `${unique("admin")}@example.com`;
      await tx.insert(users).values(user(email));
      await expectPgError(tx, (sp) => sp.insert(users).values(user(email)), {
        code: PG.uniqueViolation,
        constraint: "users_email_unique",
      });
    }));

  it("applies the defaults", () =>
    rolledBack(async (tx) => {
      const [row] = await tx.insert(users).values(user(`${unique("defaults")}@example.com`)).returning();
      expect(row).toMatchObject({ isActive: true, emailVerified: false, image: null });
      expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    }));
});

describe("master_data", () => {
  const UNIQUE = { code: PG.uniqueViolation, constraint: "master_data_type_picklist_key_code_unique" };
  const PICKLIST_KEY = { code: PG.checkViolation, constraint: "master_data_picklist_key_check" };

  it("rejects a second (DEPARTMENT, NULL, code) because NULL picklist keys are not distinct", () =>
    rolledBack(async (tx) => {
      const code = unique("ENG");
      await tx.insert(masterData).values({ type: "DEPARTMENT", code, label: "Engineering" });
      await expectPgError(tx, (sp) => sp.insert(masterData).values({ type: "DEPARTMENT", code, label: "Again" }), UNIQUE);
    }));

  it("accepts the same code as a picklist value and under two picklist keys", () =>
    rolledBack(async (tx) => {
      const code = unique("ENG");
      await tx.insert(masterData).values([
        { type: "DEPARTMENT", code, label: "Engineering" },
        { type: "PICKLIST", picklistKey: "seniority", code, label: "Engineer" },
        { type: "PICKLIST", picklistKey: "contract", code, label: "Engineer" },
      ]);
      await expectPgError(
        tx,
        (sp) => sp.insert(masterData).values({ type: "PICKLIST", picklistKey: "seniority", code, label: "Again" }),
        UNIQUE,
      );
    }));

  it("rejects PICKLIST without a picklist_key and DEPARTMENT with one", () =>
    rolledBack(async (tx) => {
      await expectPgError(
        tx,
        (sp) => sp.insert(masterData).values({ type: "PICKLIST", code: unique("P"), label: "No key" }),
        PICKLIST_KEY,
      );
      await expectPgError(
        tx,
        (sp) => sp.insert(masterData).values({ type: "DEPARTMENT", picklistKey: "seniority", code: unique("D"), label: "Key" }),
        PICKLIST_KEY,
      );
    }));

  it("rejects an unknown type", () =>
    rolledBack(async (tx) => {
      await expectPgError(
        tx,
        (sp) => sp.insert(masterData).values({ type: sql`'COUNTRY'` as never, code: unique("C"), label: "Country" }),
        { code: PG.checkViolation, constraint: "master_data_type_check" },
      );
    }));
});

describe("templates", () => {
  const ACTIVE_TRIGGER = { code: PG.uniqueViolation, constraint: "templates_active_email_trigger_status_unique" };
  const email = (triggerStatus: "REJECTED" | null, isActive = true) => ({
    type: "EMAIL" as const,
    name: unique("email"),
    triggerStatus,
    subject: "Subject",
    body: "Body",
    isActive,
  });

  it("rejects a second active EMAIL template for the same trigger status", () =>
    rolledBack(async (tx) => {
      await tx.insert(templates).values(email("REJECTED"));
      await expectPgError(tx, (sp) => sp.insert(templates).values(email("REJECTED")), ACTIVE_TRIGGER);
    }));

  it("accepts a second one for the same status when either is inactive", () =>
    rolledBack(async (tx) => {
      await tx.insert(templates).values(email("REJECTED", false));
      await tx.insert(templates).values(email("REJECTED"));
      await tx.insert(templates).values(email("REJECTED", false));
      const rows = await tx.$count(templates, sql`trigger_status = 'REJECTED'`);
      expect(rows).toBe(3);
    }));

  it("accepts several active bulk EMAIL templates without a trigger status", () =>
    rolledBack(async (tx) => {
      await tx.insert(templates).values([email(null), email(null)]);
    }));

  it("rejects a trigger status on a non-EMAIL template", () =>
    rolledBack(async (tx) => {
      await expectPgError(
        tx,
        (sp) => sp.insert(templates).values({ type: "REQUISITION", name: unique("req"), triggerStatus: "APPLIED" }),
        { code: PG.checkViolation, constraint: "templates_trigger_status_email_only_check" },
      );
    }));

  it("rejects an unknown trigger status", () =>
    rolledBack(async (tx) => {
      await expectPgError(
        tx,
        (sp) => sp.insert(templates).values({ ...email(null), triggerStatus: sql`'FOO'` as never }),
        { code: PG.checkViolation, constraint: "templates_trigger_status_check" },
      );
    }));

  it("rejects a duplicate (type, name) but accepts the name for another type", () =>
    rolledBack(async (tx) => {
      const name = unique("Default offer");
      await tx.insert(templates).values({ type: "OFFER", name, body: "Letter" });
      await tx.insert(templates).values({ type: "REQUISITION", name, schemaJson: [] });
      await expectPgError(tx, (sp) => sp.insert(templates).values({ type: "OFFER", name, body: "Other" }), {
        code: PG.uniqueViolation,
        constraint: "templates_type_name_unique",
      });
    }));
});
