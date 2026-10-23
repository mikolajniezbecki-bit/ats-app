// Templates through the API and the resolver (ats-project-scope.md §5.1, E8,
// E9, §5.4, V1, T5).
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { DELETE, PATCH } from "@/app/api/admin/templates/[id]/route";
import { GET as list, POST } from "@/app/api/admin/templates/route";
import { GET as pick } from "@/app/api/templates/route";
import { getDb, withTransaction } from "@/server/db";
import { emailLog, masterData, templates } from "@/server/db/schema";
import { TemplateNotFoundError, getStageTemplate, listActiveTemplates, resolveTemplate } from "@/server/templates";
import { insertRequisition } from "./fixtures";
import { rolledBack } from "./helpers";
import { ORIGIN, signedIn } from "./sessions";

const uniqueName = (prefix = "Template") => `${prefix} ${randomUUID()}`;
const picklistKey = () => `pk_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

function request(method: string, path: string, body?: unknown, cookie?: string) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const create = (body: unknown, cookie?: string) => POST(request("POST", "/api/admin/templates", body, cookie), undefined);
const patch = (id: string, body: unknown, cookie?: string) => PATCH(request("PATCH", `/api/admin/templates/${id}`, body, cookie), params(id));
const remove = (id: string, cookie?: string) => DELETE(request("DELETE", `/api/admin/templates/${id}`, undefined, cookie), params(id));
const picker = (query: string, cookie?: string) => pick(request("GET", `/api/templates?${query}`, undefined, cookie), undefined);

async function created(cookie: string, body: Record<string, unknown>): Promise<{ id: string; name: string }> {
  const response = await create(body, cookie);
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(201);
  return ((await response.json()) as { template: { id: string; name: string } }).template;
}

async function row(id: string) {
  const [found] = await getDb().select().from(templates).where(eq(templates.id, id));
  return found;
}

/** Deactivates every active EMAIL template with this trigger, so a test owns the status. */
async function freeTrigger(status: "APPLIED" | "SCREENING" | "HIRED" | "REJECTED" | "WITHDRAWN") {
  await getDb()
    .update(templates)
    .set({ isActive: false })
    .where(and(eq(templates.type, "EMAIL"), eq(templates.triggerStatus, status)));
}

async function picklist(key: string) {
  await getDb().insert(masterData).values({ type: "PICKLIST", picklistKey: key, code: "SENIOR", label: "Senior" });
}

describe("create and edit", () => {
  it("V1: an Admin creates EMAIL, OFFER and REQUISITION templates", async () => {
    const { cookie } = await signedIn("ADMIN");
    const key = picklistKey();
    await picklist(key);
    const email = await created(cookie, { type: "EMAIL", name: uniqueName(), subject: "Your application for [[JOB_TITLE]]", body: "Dear [[CANDIDATE_FULL_NAME]],\n\n[[LOGO]]" });
    const offer = await created(cookie, { type: "OFFER", name: uniqueName(), body: "Salary: [[OFFER_SALARY]] [[OFFER_CURRENCY]], start [[START_DATE]]" });
    const requisition = await created(cookie, {
      type: "REQUISITION",
      name: uniqueName(),
      schemaJson: [{ key: "level", label: "Level", type: "PICKLIST", picklist_key: key, required: true }],
    });
    expect(await row(email.id)).toMatchObject({ type: "EMAIL", triggerStatus: null, schemaJson: null, isActive: true });
    expect(await row(offer.id)).toMatchObject({ type: "OFFER", subject: null, triggerStatus: null });
    expect(await row(requisition.id)).toMatchObject({ type: "REQUISITION", subject: null, body: null });
  });

  it("a duplicate (type, name) returns 409; the same name for another type is fine", async () => {
    const { cookie } = await signedIn("ADMIN");
    const name = uniqueName();
    await created(cookie, { type: "OFFER", name, body: "Letter" });
    const duplicate = await create({ type: "OFFER", name, body: "Another" }, cookie);
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).message).toBe("A template with this name already exists.");
    await created(cookie, { type: "EMAIL", name, subject: "s", body: "b" });
  });

  it("PATCH refuses type and name, and edits the rest", async () => {
    const { cookie } = await signedIn("ADMIN");
    const template = await created(cookie, { type: "EMAIL", name: uniqueName(), subject: "Old", body: "Old body" });
    for (const field of ["type", "name"]) {
      const response = await patch(template.id, { [field]: "OFFER" }, cookie);
      expect(response.status, field).toBe(400);
      expect((await response.json()).fields[field]).toBe("Type and name can't be changed.");
    }
    expect((await patch(template.id, { subject: "New", body: "New body", isActive: false }, cookie)).status).toBe(200);
    expect(await row(template.id)).toMatchObject({ subject: "New", body: "New body", isActive: false, name: template.name });
  });

  it("refuses unknown, unclosed and out-of-scope tokens on save, naming them", async () => {
    const { cookie } = await signedIn("ADMIN");
    const cases: [Record<string, unknown>, string, string][] = [
      [{ type: "EMAIL", subject: "Hi [[FOO]]", body: "b" }, "subject", "[[FOO]] is not a known token."],
      [{ type: "EMAIL", subject: "s", body: "Hi [[JOB_TITLE" }, "body", "A [[ is not closed with ]]."],
      [{ type: "EMAIL", subject: "s", body: "[[INTERVIEW_DATETIME]]" }, "body", "[[INTERVIEW_DATETIME]] can't be used in this template."],
      [{ type: "EMAIL", subject: "[[LOGO]]", body: "b" }, "subject", "[[LOGO]] can't be used in this template."],
      [{ type: "EMAIL", subject: "s", body: "[[OFFER_SALARY]]" }, "body", "[[OFFER_SALARY]] can't be used in this template."],
      [{ type: "OFFER", body: "[[INTERVIEW_LOCATION]]" }, "body", "[[INTERVIEW_LOCATION]] can't be used in this template."],
    ];
    for (const [body, field, text] of cases) {
      const response = await create({ ...body, name: uniqueName() }, cookie);
      expect(response.status, text).toBe(400);
      expect((await response.json()).fields[field]).toBe(text);
    }
  });

  it("refuses INTERVIEW and OFFER as trigger status (E9)", async () => {
    const { cookie } = await signedIn("ADMIN");
    for (const triggerStatus of ["INTERVIEW", "OFFER"]) {
      const response = await create({ type: "EMAIL", name: uniqueName(), subject: "s", body: "b", triggerStatus }, cookie);
      expect(response.status).toBe(400);
      expect((await response.json()).fields.triggerStatus).toBe("Moving to Interview or Offer never sends an email (E9).");
    }
  });
});

describe("trigger status", () => {
  it("a second active template for a status is a 409 validation error; an inactive one may share it (E8)", async () => {
    const { cookie } = await signedIn("ADMIN");
    await freeTrigger("WITHDRAWN");
    const first = await created(cookie, { type: "EMAIL", name: uniqueName(), subject: "s", body: "b", triggerStatus: "WITHDRAWN" });

    const second = await create({ type: "EMAIL", name: uniqueName(), subject: "s", body: "b", triggerStatus: "WITHDRAWN" }, cookie);
    expect(second.status).toBe(409);
    const message = "Another active template already sends the Withdrawn email. Deactivate it first.";
    expect(await second.json()).toEqual({ error: "triggerConflict", message, fields: { triggerStatus: message } });

    const inactive = await created(cookie, { type: "EMAIL", name: uniqueName(), subject: "s", body: "b", triggerStatus: "WITHDRAWN", isActive: false });
    // Activating it while the first is active is refused too.
    expect((await patch(inactive.id, { isActive: true }, cookie)).status).toBe(409);
    await patch(first.id, { isActive: false }, cookie);
    expect((await patch(inactive.id, { isActive: true }, cookie)).status).toBe(200);
  });

  it("the partial unique index firing on a race maps to the same 409", async () => {
    const { cookie } = await signedIn("ADMIN");
    await freeTrigger("HIRED");
    // Another connection saves an active HIRED template and hasn't committed
    // yet, so the API's check can't see it and its insert waits on the index.
    const other = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await other.connect();
    try {
      await other.query("BEGIN");
      await other.query(
        "INSERT INTO templates (type, name, subject, body, trigger_status) VALUES ('EMAIL', $1, 's', 'b', 'HIRED')",
        [uniqueName()],
      );
      const pending = create({ type: "EMAIL", name: uniqueName(), subject: "s", body: "b", triggerStatus: "HIRED" }, cookie);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await other.query("COMMIT");

      const response = await pending;
      expect(response.status).toBe(409);
      expect((await response.json()).error).toBe("triggerConflict");
    } finally {
      await other.end();
      await freeTrigger("HIRED");
    }
  });
});

describe("requisition template schema", () => {
  it("rejects a picklist_key with no master data", async () => {
    const { cookie } = await signedIn("ADMIN");
    const key = picklistKey();
    const response = await create(
      { type: "REQUISITION", name: uniqueName(), schemaJson: [{ key: "level", label: "Level", type: "PICKLIST", picklist_key: key, required: false }] },
      cookie,
    );
    expect(response.status).toBe(400);
    expect((await response.json()).fields.schemaJson).toBe(`There is no picklist with the key ${key}.`);
  });

  it("once a requisition uses the template, the schema can only grow", async () => {
    const { cookie } = await signedIn("ADMIN");
    const key = picklistKey();
    await picklist(key);
    const level = { key: "level", label: "Level", type: "PICKLIST", picklist_key: key, required: true };
    const notes = { key: "notes", label: "Notes", type: "TEXT", required: false };
    const template = await created(cookie, { type: "REQUISITION", name: uniqueName(), schemaJson: [level, notes] });
    await withTransaction((tx) => insertRequisition(tx, { templateId: template.id }));

    const refused = [
      [level],
      [level, { ...notes, type: "NUMBER" }],
      [level, notes, { key: "budget", label: "Budget", type: "NUMBER", required: true }],
      [level, { ...notes, required: true }],
    ];
    for (const schemaJson of refused) expect((await patch(template.id, { schemaJson }, cookie)).status, JSON.stringify(schemaJson)).toBe(400);

    const grown = [{ ...level, label: "Seniority" }, notes, { key: "budget", label: "Budget", type: "NUMBER", required: false }];
    expect((await patch(template.id, { schemaJson: grown }, cookie)).status).toBe(200);
    expect((await row(template.id)).schemaJson).toEqual(grown);
  });

  it("an unused template's schema can change freely", async () => {
    const { cookie } = await signedIn("ADMIN");
    const template = await created(cookie, { type: "REQUISITION", name: uniqueName(), schemaJson: [{ key: "a", label: "A", type: "TEXT", required: true }] });
    expect((await patch(template.id, { schemaJson: [] }, cookie)).status).toBe(200);
  });
});

describe("delete", () => {
  it("deletes an unreferenced template", async () => {
    const { cookie } = await signedIn("ADMIN");
    const template = await created(cookie, { type: "OFFER", name: uniqueName(), body: "Letter" });
    expect((await remove(template.id, cookie)).status).toBe(200);
    expect(await row(template.id)).toBeUndefined();
  });

  it("a template referenced by a requisition or an email_log row returns 409 and stays", async () => {
    const { cookie } = await signedIn("ADMIN");
    const requisitionTemplate = await created(cookie, { type: "REQUISITION", name: uniqueName(), schemaJson: [] });
    await withTransaction((tx) => insertRequisition(tx, { templateId: requisitionTemplate.id }));
    const emailTemplate = await created(cookie, { type: "EMAIL", name: uniqueName(), subject: "s", body: "b" });
    await getDb().insert(emailLog).values({ audience: "STAFF", templateId: emailTemplate.id, status: "CANCELLED" });

    for (const id of [requisitionTemplate.id, emailTemplate.id]) {
      const response = await remove(id, cookie);
      expect(response.status).toBe(409);
      expect((await response.json()).message).toBe("This template is in use and can only be deactivated.");
      expect(await row(id)).toBeDefined();
    }
  });
});

describe("resolver and pickers", () => {
  it("resolveTemplate returns the active template and throws for an inactive or unknown one", async () => {
    const { cookie } = await signedIn("ADMIN");
    const name = uniqueName();
    const template = await created(cookie, { type: "OFFER", name, body: "Letter" });
    expect((await resolveTemplate("OFFER", name)).id).toBe(template.id);
    await expect(resolveTemplate("EMAIL", name)).rejects.toBeInstanceOf(TemplateNotFoundError);
    await patch(template.id, { isActive: false }, cookie);
    await expect(resolveTemplate("OFFER", name)).rejects.toBeInstanceOf(TemplateNotFoundError);
  });

  it("getStageTemplate finds the active template for a status, or null (E8)", async () => {
    await rolledBack(async (tx) => {
      await tx.update(templates).set({ isActive: false }).where(and(eq(templates.type, "EMAIL"), eq(templates.triggerStatus, "SCREENING")));
      expect(await getStageTemplate("SCREENING", tx)).toBeNull();
      await tx.insert(templates).values({ type: "EMAIL", name: uniqueName(), subject: "s", body: "b", triggerStatus: "SCREENING", isActive: false });
      expect(await getStageTemplate("SCREENING", tx)).toBeNull();
      const [active] = await tx.insert(templates).values({ type: "EMAIL", name: uniqueName(), subject: "s", body: "b", triggerStatus: "SCREENING" }).returning();
      expect((await getStageTemplate("SCREENING", tx))?.id).toBe(active.id);
    });
  });

  it("listActiveTemplates lists active templates by name; bulk lists EMAIL templates without a trigger only", async () => {
    await rolledBack(async (tx) => {
      await tx.update(templates).set({ isActive: false });
      const insert = (values: Partial<typeof templates.$inferInsert> & { type: "EMAIL" | "OFFER" | "REQUISITION"; name: string }) =>
        tx.insert(templates).values(values).returning();
      const [bulkB] = await insert({ type: "EMAIL", name: "B bulk", subject: "s", body: "b" });
      const [bulkA] = await insert({ type: "EMAIL", name: "A bulk", subject: "s", body: "b" });
      const [stage] = await insert({ type: "EMAIL", name: "C stage", subject: "s", body: "b", triggerStatus: "APPLIED" });
      await insert({ type: "EMAIL", name: "D inactive", subject: "s", body: "b", isActive: false });
      const [requisition] = await insert({ type: "REQUISITION", name: "R", schemaJson: [] });

      expect(await listActiveTemplates({ type: "EMAIL" }, tx)).toEqual([
        { id: bulkA.id, name: "A bulk" },
        { id: bulkB.id, name: "B bulk" },
        { id: stage.id, name: "C stage" },
      ]);
      expect((await listActiveTemplates({ type: "EMAIL", bulk: true }, tx)).map((t) => t.id)).toEqual([bulkA.id, bulkB.id]);
      expect(await listActiveTemplates({ type: "REQUISITION" }, tx)).toEqual([{ id: requisition.id, name: "R", schemaJson: [] }]);
    });
  });
});

describe("access (T5)", () => {
  it.each(["RECRUITER", "HIRING_MANAGER", "INTERVIEWER"] as const)("AU9: %s gets 403 from every admin templates endpoint and nothing changes", async (role) => {
    const admin = await signedIn("ADMIN");
    const template = await created(admin.cookie, { type: "OFFER", name: uniqueName(), body: "Letter" });
    const { cookie } = await signedIn(role);
    const name = uniqueName();

    expect((await list(request("GET", "/api/admin/templates", undefined, cookie), undefined)).status).toBe(403);
    expect((await create({ type: "OFFER", name, body: "x" }, cookie)).status).toBe(403);
    expect((await patch(template.id, { body: "changed" }, cookie)).status).toBe(403);
    expect((await remove(template.id, cookie)).status).toBe(403);

    expect(await row(template.id)).toMatchObject({ body: "Letter" });
    expect(await getDb().select().from(templates).where(eq(templates.name, name))).toEqual([]);
  });

  it("AU9: without a session the admin endpoints return 401", async () => {
    const id = randomUUID();
    expect((await list(request("GET", "/api/admin/templates"), undefined)).status).toBe(401);
    expect((await create({ type: "OFFER", name: uniqueName(), body: "x" })).status).toBe(401);
    expect((await patch(id, { body: "x" })).status).toBe(401);
    expect((await remove(id)).status).toBe(401);
  });

  it.each(["ADMIN", "RECRUITER", "HIRING_MANAGER"] as const)("V1: %s may use the template picker", async (role) => {
    const response = await picker("type=EMAIL&bulk=true", (await signedIn(role)).cookie);
    expect(response.status).toBe(200);
  });

  it("AU9: an Interviewer gets 403 from the picker, no session 401, an invalid type 400", async () => {
    expect((await picker("type=EMAIL", (await signedIn("INTERVIEWER")).cookie)).status).toBe(403);
    expect((await picker("type=EMAIL")).status).toBe(401);
    expect((await picker("type=NOPE", (await signedIn("RECRUITER")).cookie)).status).toBe(400);
  });
});
