// Master data through the API (ats-project-scope.md §5.1, V1, T5): codes are
// immutable, referenced records can only be deactivated, and pickers offer
// active records only.
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { DELETE, PATCH } from "@/app/api/admin/master-data/[id]/route";
import { POST } from "@/app/api/admin/master-data/route";
import { GET as pick } from "@/app/api/master-data/route";
import { getDb, withTransaction } from "@/server/db";
import { masterData, templates } from "@/server/db/schema";
import { insertRequisition } from "./fixtures";
import { ORIGIN, signedIn } from "./sessions";

const suffix = () => randomBytes(5).toString("hex");
const code = () => `CODE_${suffix().toUpperCase()}`;

function json(method: string, url: string, body: unknown, cookie?: string) {
  return new Request(`${ORIGIN}${url}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const create = (body: unknown, cookie?: string) => POST(json("POST", "/api/admin/master-data", body, cookie), undefined);
const update = (id: string, body: unknown, cookie?: string) =>
  PATCH(json("PATCH", `/api/admin/master-data/${id}`, body, cookie), { params: Promise.resolve({ id }) });
const remove = (id: string, cookie?: string) =>
  DELETE(json("DELETE", `/api/admin/master-data/${id}`, undefined, cookie), { params: Promise.resolve({ id }) });
const picker = (query: string, cookie?: string) =>
  pick(new Request(`${ORIGIN}/api/master-data?${query}`, { headers: cookie ? { cookie } : {} }), undefined);

async function row(id: string) {
  const [found] = await getDb().select().from(masterData).where(eq(masterData.id, id));
  return found;
}

async function created(cookie: string, body: Record<string, unknown>): Promise<{ id: string; code: string }> {
  const response = await create(body, cookie);
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(201);
  return ((await response.json()) as { record: { id: string; code: string } }).record;
}

describe("master data API", () => {
  it("V1: an Admin creates a record; the code is trimmed and upper-cased", async () => {
    const { cookie } = await signedIn("ADMIN");
    const value = code();
    const record = await created(cookie, { type: "DEPARTMENT", code: ` ${value.toLowerCase()} `, label: " Engineering " });
    expect(await row(record.id)).toMatchObject({ type: "DEPARTMENT", code: value, label: "Engineering", picklistKey: null, isActive: true });
  });

  it("a duplicate (type, picklist key, code) is a 400 with the duplicate message, not a 500", async () => {
    const { cookie } = await signedIn("ADMIN");
    const value = code();
    await created(cookie, { type: "LOCATION", code: value, label: "Warsaw" });
    const duplicate = await create({ type: "LOCATION", code: value, label: "Warsaw again" }, cookie);
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toEqual({ error: "duplicate", message: "A record with this code already exists." });
    // The same code is fine for another type.
    await created(cookie, { type: "LEGAL_ENTITY", code: value, label: "Entity" });
  });

  it("invalid input returns 400 with field errors", async () => {
    const { cookie } = await signedIn("ADMIN");
    const response = await create({ type: "PICKLIST", code: "bad code", label: "" }, cookie);
    expect(response.status).toBe(400);
    expect((await response.json()).fields).toEqual({
      code: "Use 1 to 50 upper-case letters, digits, _ or -.",
      label: "Enter 1 to 200 characters.",
      picklistKey: "Use 1 to 50 lower-case letters, digits or _ (picklists only).",
    });
  });

  it("PATCH changes only label and active flag; code, type and picklist key return 400", async () => {
    const { cookie } = await signedIn("ADMIN");
    const record = await created(cookie, { type: "PICKLIST", picklistKey: `pk_${suffix()}`, code: code(), label: "Junior" });
    expect((await update(record.id, { label: "Junior engineer" }, cookie)).status).toBe(200);
    for (const field of ["code", "type", "picklistKey"]) {
      const response = await update(record.id, { [field]: "X" }, cookie);
      expect(response.status, field).toBe(400);
      expect((await response.json()).fields[field]).toBe("Code, type and picklist key can't be changed.");
    }
    expect(await row(record.id)).toMatchObject({ code: record.code, label: "Junior engineer", type: "PICKLIST" });
  });

  it("a Department referenced by a requisition returns 409 on delete and can be deactivated", async () => {
    const { cookie } = await signedIn("ADMIN");
    const requisition = await withTransaction((tx) => insertRequisition(tx));
    const response = await remove(requisition.departmentId, cookie);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "inUse", message: "This record is in use and can only be deactivated." });
    expect(await row(requisition.departmentId)).toBeDefined();

    expect((await update(requisition.departmentId, { isActive: false }, cookie)).status).toBe(200);
    expect((await row(requisition.departmentId)).isActive).toBe(false);
  });

  it("an unreferenced Location is deleted and the row is gone", async () => {
    const { cookie } = await signedIn("ADMIN");
    const record = await created(cookie, { type: "LOCATION", code: code(), label: "Gdansk" });
    expect((await remove(record.id, cookie)).status).toBe(200);
    expect(await row(record.id)).toBeUndefined();
    expect((await remove(record.id, cookie)).status).toBe(404);
  });

  it("a picklist value used in a requisition's custom field returns 409; the same code in another picklist can be deleted", async () => {
    const { cookie } = await signedIn("ADMIN");
    const usedKey = `pk_${suffix()}`;
    const otherKey = `pk_${suffix()}`;
    const value = code();
    const used = await created(cookie, { type: "PICKLIST", picklistKey: usedKey, code: value, label: "Senior" });
    const other = await created(cookie, { type: "PICKLIST", picklistKey: otherKey, code: value, label: "Senior" });
    await withTransaction(async (tx) => {
      const [template] = await tx
        .insert(templates)
        .values({
          type: "REQUISITION",
          name: `Template ${suffix()}`,
          schemaJson: [
            { key: "seniority", label: "Seniority", type: "PICKLIST", picklist_key: usedKey, required: true },
            { key: "notes", label: "Notes", type: "TEXT", required: false },
          ],
        })
        .returning();
      await insertRequisition(tx, { templateId: template.id, customFieldsJson: { seniority: value, notes: value } });
    });

    expect((await remove(used.id, cookie)).status).toBe(409);
    expect((await remove(other.id, cookie)).status).toBe(200);
  });

  it("a requisition inserted concurrently with the delete still makes it a 409", async () => {
    const { cookie } = await signedIn("ADMIN");
    const base = await withTransaction((tx) => insertRequisition(tx));
    const location = await created(cookie, { type: "LOCATION", code: code(), label: "Krakow" });

    // Another connection inserts a requisition pointing at the location and
    // keeps its transaction open while the delete runs.
    const other = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await other.connect();
    try {
      await other.query("BEGIN");
      await other.query(
        `INSERT INTO requisitions (title, department_id, location_id, legal_entity_id, hiring_manager_id, recruiter_id,
           created_by_user_id, openings_count, posting_type)
         VALUES ('Concurrent', $1, $2, $3, $4, $4, $4, 1, 'EXTERNAL')`,
        [base.departmentId, location.id, base.legalEntityId, base.hiringManagerId],
      );
      let settled = false;
      const pending = remove(location.id, cookie).then((response) => {
        settled = true;
        return response;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      // The delete waits for the other transaction's lock on the record.
      expect(settled).toBe(false);
      await other.query("COMMIT");

      const response = await pending;
      expect(response.status).toBe(409);
      expect(await row(location.id)).toBeDefined();
    } finally {
      await other.end();
    }
  });

  it("a deactivated record disappears from the picker and comes back when reactivated", async () => {
    const admin = await signedIn("ADMIN");
    const recruiter = await signedIn("RECRUITER");
    const record = await created(admin.cookie, { type: "LEGAL_ENTITY", code: code(), label: `Entity ${suffix()}` });
    const ids = async () =>
      ((await (await picker("type=LEGAL_ENTITY", recruiter.cookie)).json()) as { options: { id: string }[] }).options.map((o) => o.id);

    expect(await ids()).toContain(record.id);
    await update(record.id, { isActive: false }, admin.cookie);
    expect(await ids()).not.toContain(record.id);
    await update(record.id, { isActive: true }, admin.cookie);
    expect(await ids()).toContain(record.id);
  });

  it("the picker returns { id, code, label } sorted by label, picklists by key only", async () => {
    const { cookie } = await signedIn("ADMIN");
    const key = `pk_${suffix()}`;
    await created(cookie, { type: "PICKLIST", picklistKey: key, code: "B_VALUE", label: "Beta" });
    await created(cookie, { type: "PICKLIST", picklistKey: key, code: "A_VALUE", label: "Alpha" });
    await created(cookie, { type: "PICKLIST", picklistKey: `pk_${suffix()}`, code: "C_VALUE", label: "Gamma" });
    const response = await picker(`type=PICKLIST&picklistKey=${key}`, cookie);
    expect(response.status).toBe(200);
    const { options } = (await response.json()) as { options: Record<string, unknown>[] };
    expect(options.map(({ code: c, label }) => ({ code: c, label }))).toEqual([
      { code: "A_VALUE", label: "Alpha" },
      { code: "B_VALUE", label: "Beta" },
    ]);
    expect(Object.keys(options[0]).sort()).toEqual(["code", "id", "label"]);
  });
});

describe("master data API access (T5)", () => {
  it.each(["RECRUITER", "HIRING_MANAGER", "INTERVIEWER"] as const)("AU9: %s gets 403 from POST, PATCH and DELETE and nothing changes", async (role) => {
    const admin = await signedIn("ADMIN");
    const record = await created(admin.cookie, { type: "DEPARTMENT", code: code(), label: "Sales" });
    const { cookie } = await signedIn(role);
    const value = code();

    expect((await create({ type: "DEPARTMENT", code: value, label: "Nope" }, cookie)).status).toBe(403);
    expect((await update(record.id, { label: "Changed", isActive: false }, cookie)).status).toBe(403);
    expect((await remove(record.id, cookie)).status).toBe(403);

    expect(await row(record.id)).toMatchObject({ label: "Sales", isActive: true });
    expect(await getDb().select().from(masterData).where(eq(masterData.code, value))).toEqual([]);
  });

  it("AU9: without a session the admin endpoints return 401", async () => {
    const admin = await signedIn("ADMIN");
    const record = await created(admin.cookie, { type: "DEPARTMENT", code: code(), label: "Support" });
    expect((await create({ type: "DEPARTMENT", code: code(), label: "Nope" })).status).toBe(401);
    expect((await update(record.id, { label: "Changed" })).status).toBe(401);
    expect((await remove(record.id)).status).toBe(401);
    expect(await row(record.id)).toMatchObject({ label: "Support" });
  });

  it.each(["ADMIN", "RECRUITER", "HIRING_MANAGER"] as const)("V1: %s may use the picker", async (role) => {
    expect((await picker("type=DEPARTMENT", (await signedIn(role)).cookie)).status).toBe(200);
  });

  it("AU9: an Interviewer gets 403 from the picker, no session 401", async () => {
    expect((await picker("type=DEPARTMENT", (await signedIn("INTERVIEWER")).cookie)).status).toBe(403);
    expect((await picker("type=DEPARTMENT")).status).toBe(401);
  });

  it("the picker returns 400 for a missing or invalid type, or PICKLIST without a key", async () => {
    const { cookie } = await signedIn("RECRUITER");
    for (const query of ["", "type=nope", "type=PICKLIST"]) expect((await picker(query, cookie)).status, query).toBe(400);
  });
});
