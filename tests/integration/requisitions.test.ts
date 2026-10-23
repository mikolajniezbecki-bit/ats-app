// Requisition drafting against the database (ats-project-scope.md §5.2, L9,
// L11, V2, V3a, V9; tech-stack.md D7, T5): the service, and the API with real
// session cookies.
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { GET as getOne, PATCH } from "@/app/api/requisitions/[id]/route";
import { GET as list, POST } from "@/app/api/requisitions/route";
import { type Tx, getDb, withTransaction } from "@/server/db";
import { masterData, requisitionHistory, requisitions, templates, users } from "@/server/db/schema";
import type { PolicyUser } from "@/server/policy/permissions";
import { createRequisition, duplicateValues, updateRequisition } from "@/server/requisitions";
import { insertRequisition, insertUser } from "./fixtures";
import { rolledBack } from "./helpers";
import { ORIGIN, signedIn } from "./sessions";

type Row = typeof requisitions.$inferSelect;

function request(method: string, path: string, body?: unknown, cookie?: string) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const apiCreate = (body: unknown, cookie: string) => POST(request("POST", "/api/requisitions", body, cookie), undefined);
const apiPatch = (id: string, body: unknown, cookie: string) => PATCH(request("PATCH", `/api/requisitions/${id}`, body, cookie), params(id));
const apiList = (cookie: string, query = "") => list(request("GET", `/api/requisitions${query}`, undefined, cookie), undefined);
const apiGet = (id: string, cookie: string) => getOne(request("GET", `/api/requisitions/${id}`, undefined, cookie), params(id));

async function md(tx: Tx | ReturnType<typeof getDb>, type: "DEPARTMENT" | "LOCATION" | "LEGAL_ENTITY", isActive = true) {
  const [row] = await tx.insert(masterData).values({ type, code: `C-${randomUUID()}`.toUpperCase(), label: type, isActive }).returning();
  return row.id;
}

async function picklistKey(tx: Tx | ReturnType<typeof getDb>, codes: { code: string; isActive?: boolean }[]) {
  const key = `pk_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await tx.insert(masterData).values(codes.map(({ code, isActive = true }) => ({ type: "PICKLIST" as const, picklistKey: key, code, label: code, isActive })));
  return key;
}

/** Valid create input with fresh active references. */
async function validInput(tx: Tx | ReturnType<typeof getDb>, overrides: Record<string, unknown> = {}) {
  const recruiter = await insertUser(tx as Tx, "RECRUITER");
  const hm = await insertUser(tx as Tx, "HIRING_MANAGER");
  return {
    title: "Backend Engineer",
    departmentId: await md(tx, "DEPARTMENT"),
    locationId: await md(tx, "LOCATION"),
    legalEntityId: await md(tx, "LEGAL_ENTITY"),
    hiringManagerId: hm.id,
    recruiterId: recruiter.id,
    openingsCount: 1,
    descriptionHtml: "<p>Build things.</p>",
    postingType: "EXTERNAL",
    ...overrides,
  };
}

async function actor(tx: Tx, role: PolicyUser["role"] = "RECRUITER"): Promise<PolicyUser> {
  const user = await insertUser(tx, role);
  return { id: user.id, role, isActive: true };
}

async function create(tx: Tx, user: PolicyUser, input: Record<string, unknown>): Promise<Row> {
  const result = await createRequisition(tx, user, input);
  if (!result.ok) throw new Error(`create failed: ${JSON.stringify(result)}`);
  return result.requisition;
}

describe("create", () => {
  it("creates a DRAFT with the next req_number, version 1 and one STATE_CHANGE history row (L11)", async () => {
    await rolledBack(async (tx) => {
      const user = await actor(tx);
      const first = await create(tx, user, await validInput(tx));
      const second = await create(tx, user, await validInput(tx));
      expect(first).toMatchObject({ state: "DRAFT", isPublished: false, version: 1, createdByUserId: user.id, templateId: null, customFieldsJson: {} });
      expect(first.reqNumber).toMatch(/^REQ-\d{5}$/);
      expect(Number(second.reqNumber.slice(4))).toBeGreaterThan(Number(first.reqNumber.slice(4)));
      const history = await tx.select().from(requisitionHistory).where(eq(requisitionHistory.requisitionId, first.id));
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ event: "STATE_CHANGE", field: "state", oldValue: null, newValue: "DRAFT", userId: user.id });
    });
  });

  it("refuses titles and openings outside the limits", async () => {
    await rolledBack(async (tx) => {
      const user = await actor(tx);
      for (const overrides of [{ title: "" }, { title: "x".repeat(201) }, { openingsCount: 0 }, { openingsCount: 1001 }, { openingsCount: 1.5 }]) {
        const result = await createRequisition(tx, user, await validInput(tx, overrides));
        expect(result, JSON.stringify(overrides)).toMatchObject({ ok: false, reason: "invalid" });
      }
    });
  });

  it("each master data field must point to a record of its type", async () => {
    await rolledBack(async (tx) => {
      const user = await actor(tx);
      const location = await md(tx, "LOCATION");
      const result = await createRequisition(tx, user, await validInput(tx, { departmentId: location }));
      expect(result).toEqual({ ok: false, reason: "invalid", fields: { departmentId: "wrongType" } });
    });
  });

  it("the recruiter must be a Recruiter or Admin and the hiring manager a Hiring Manager or Admin", async () => {
    await rolledBack(async (tx) => {
      const user = await actor(tx);
      const interviewer = await insertUser(tx, "INTERVIEWER");
      const admin = await insertUser(tx, "ADMIN");
      expect(await createRequisition(tx, user, await validInput(tx, { recruiterId: interviewer.id, hiringManagerId: interviewer.id }))).toEqual({
        ok: false,
        reason: "invalid",
        fields: { recruiterId: "wrongRole", hiringManagerId: "wrongRole" },
      });
      expect((await createRequisition(tx, user, await validInput(tx, { recruiterId: admin.id, hiringManagerId: admin.id }))).ok).toBe(true);
    });
  });

  it("a new requisition needs active references", async () => {
    await rolledBack(async (tx) => {
      const user = await actor(tx);
      const inactiveRecruiter = await insertUser(tx, "RECRUITER");
      await tx.update(users).set({ isActive: false }).where(eq(users.id, inactiveRecruiter.id));
      const result = await createRequisition(tx, user, await validInput(tx, { departmentId: await md(tx, "DEPARTMENT", false), recruiterId: inactiveRecruiter.id }));
      expect(result).toEqual({ ok: false, reason: "invalid", fields: { departmentId: "inactive", recruiterId: "inactive" } });
    });
  });

  it("sanitizes the description and allows it empty in DRAFT", async () => {
    await rolledBack(async (tx) => {
      const user = await actor(tx);
      const row = await create(tx, user, await validInput(tx, { descriptionHtml: '<p onclick="x()">Hi</p><script>alert(1)</script>' }));
      expect(row.descriptionHtml).toBe("<p>Hi</p>");
      expect((await create(tx, user, await validInput(tx, { descriptionHtml: "" }))).descriptionHtml).toBe("");
    });
  });

  it("validates custom fields against an active template and stores every schema key", async () => {
    await rolledBack(async (tx) => {
      const user = await actor(tx);
      const key = await picklistKey(tx, [{ code: "FULL_TIME" }, { code: "OLD", isActive: false }]);
      const [template] = await tx
        .insert(templates)
        .values({
          type: "REQUISITION",
          name: `Req ${randomUUID()}`,
          schemaJson: [
            { key: "employment_type", label: "Type", type: "PICKLIST", picklist_key: key, required: true },
            { key: "cost_center", label: "Cost center", type: "TEXT", required: false },
          ],
        })
        .returning();
      const withFields = (customFields: Record<string, unknown>) => validInput(tx, { templateId: template.id, customFields });

      expect(await createRequisition(tx, user, await withFields({}))).toMatchObject({ fields: { "customFields.employment_type": "required" } });
      expect(await createRequisition(tx, user, await withFields({ employment_type: "OLD" }))).toMatchObject({
        fields: { "customFields.employment_type": "picklist" },
      });
      expect(await createRequisition(tx, user, await withFields({ employment_type: "FULL_TIME", extra: "x" }))).toMatchObject({
        fields: { "customFields.extra": "unknownField" },
      });
      const row = await create(tx, user, await withFields({ employment_type: "FULL_TIME" }));
      expect(row).toMatchObject({ templateId: template.id, customFieldsJson: { employment_type: "FULL_TIME", cost_center: null } });

      await tx.update(templates).set({ isActive: false }).where(eq(templates.id, template.id));
      expect(await createRequisition(tx, user, await withFields({ employment_type: "FULL_TIME" }))).toMatchObject({ fields: { templateId: "invalid" } });
      // A requisition whose template was deactivated stays editable with its schema.
      expect(await updateRequisition(tx, user, row.id, { version: 1, title: "Renamed" })).toMatchObject({ ok: true });
    });
  });
});

describe("edit", () => {
  it("D7: of two editors on version 1, the second save gets 409 and the first editor's values stay", async () => {
    const { userId, cookie } = await signedIn("RECRUITER");
    const input = await validInput(getDb());
    const row = await withTransaction((tx) => create(tx, { id: userId, role: "RECRUITER" }, input));

    const first = await apiPatch(row.id, { version: 1, title: "First editor" }, cookie);
    expect(first.status).toBe(200);
    expect((await first.json()).requisition.version).toBe(2);
    const second = await apiPatch(row.id, { version: 1, title: "Second editor", openingsCount: 4 }, cookie);
    expect(second.status).toBe(409);
    expect((await second.json()).message).toBe("This record was changed by someone else. Reload and try again.");
    const [stored] = await getDb().select().from(requisitions).where(eq(requisitions.id, row.id));
    expect(stored).toMatchObject({ title: "First editor", openingsCount: 1, version: 2 });
  });

  it("the template and the slug can't be set through PATCH", async () => {
    await rolledBack(async (tx) => {
      const user = await actor(tx);
      const row = await create(tx, user, await validInput(tx));
      expect(await updateRequisition(tx, user, row.id, { version: 1, templateId: randomUUID() })).toEqual({
        ok: false,
        reason: "invalid",
        fields: { templateId: "readOnlyField" },
      });
      expect(await updateRequisition(tx, user, row.id, { version: 1, privateSlug: "a".repeat(32) })).toMatchObject({ fields: { privateSlug: "readOnlyField" } });
    });
  });

  it("only DRAFT requisitions can be edited in this task", async () => {
    await rolledBack(async (tx) => {
      const user = await actor(tx);
      const row = await create(tx, user, await validInput(tx));
      await tx.update(requisitions).set({ state: "APPROVED" }).where(eq(requisitions.id, row.id));
      expect(await updateRequisition(tx, user, row.id, { version: 1, title: "x" })).toEqual({ ok: false, reason: "notEditable" });
    });
  });

  it("a Hiring Manager edits drafts they created, not others in their scope", async () => {
    await rolledBack(async (tx) => {
      const hm = await actor(tx, "HIRING_MANAGER");
      const own = await create(tx, hm, await validInput(tx));
      expect(await updateRequisition(tx, hm, own.id, { version: 1, title: "Mine" })).toMatchObject({ ok: true });
      const managed = await create(tx, await actor(tx), await validInput(tx, { hiringManagerId: hm.id }));
      expect(await updateRequisition(tx, hm, managed.id, { version: 1, title: "Not mine" })).toEqual({ ok: false, reason: "forbidden" });
      const outside = await create(tx, await actor(tx), await validInput(tx));
      expect(await updateRequisition(tx, hm, outside.id, { version: 1, title: "Hidden" })).toEqual({ ok: false, reason: "notFound" });
    });
  });

  it("a stored inactive Department or recruiter may stay; switching to another inactive one is refused", async () => {
    await rolledBack(async (tx) => {
      const user = await actor(tx);
      const row = await create(tx, user, await validInput(tx));
      await tx.update(masterData).set({ isActive: false }).where(eq(masterData.id, row.departmentId));
      await tx.update(users).set({ isActive: false }).where(eq(users.id, row.recruiterId));

      const kept = await updateRequisition(tx, user, row.id, { version: 1, title: "Still fine" });
      expect(kept).toMatchObject({ ok: true, requisition: { departmentId: row.departmentId, recruiterId: row.recruiterId, title: "Still fine" } });

      const otherInactive = await md(tx, "DEPARTMENT", false);
      expect(await updateRequisition(tx, user, row.id, { version: 2, departmentId: otherInactive })).toEqual({
        ok: false,
        reason: "invalid",
        fields: { departmentId: "inactive" },
      });
      const inactiveRecruiter = await insertUser(tx, "RECRUITER");
      await tx.update(users).set({ isActive: false }).where(eq(users.id, inactiveRecruiter.id));
      expect(await updateRequisition(tx, user, row.id, { version: 2, recruiterId: inactiveRecruiter.id })).toEqual({
        ok: false,
        reason: "invalid",
        fields: { recruiterId: "inactive" },
      });
    });
  });

  it("a stored inactive picklist value may stay", async () => {
    await rolledBack(async (tx) => {
      const user = await actor(tx);
      const key = await picklistKey(tx, [{ code: "A" }, { code: "B" }]);
      const [template] = await tx
        .insert(templates)
        .values({ type: "REQUISITION", name: `Req ${randomUUID()}`, schemaJson: [{ key: "kind", label: "Kind", type: "PICKLIST", picklist_key: key, required: true }] })
        .returning();
      const row = await create(tx, user, await validInput(tx, { templateId: template.id, customFields: { kind: "A" } }));
      await tx.update(masterData).set({ isActive: false }).where(eq(masterData.picklistKey, key));
      expect(await updateRequisition(tx, user, row.id, { version: 1, title: "Kept", customFields: { kind: "A" } })).toMatchObject({ ok: true });
      expect(await updateRequisition(tx, user, row.id, { version: 2, customFields: { kind: "B" } })).toMatchObject({
        fields: { "customFields.kind": "picklist" },
      });
    });
  });

  it("L11: changing openings_count and the title writes exactly one FIELD_CHANGE row; a rolled-back save writes none", async () => {
    await rolledBack(async (tx) => {
      const user = await actor(tx);
      const row = await create(tx, user, await validInput(tx));
      await updateRequisition(tx, user, row.id, { version: 1, title: "New title", openingsCount: 3 });
      const changes = await tx
        .select()
        .from(requisitionHistory)
        .where(eq(requisitionHistory.requisitionId, row.id))
        .orderBy(asc(requisitionHistory.createdAt));
      expect(changes.filter((change) => change.event === "FIELD_CHANGE")).toEqual([
        expect.objectContaining({ field: "openings_count", oldValue: "1", newValue: "3", userId: user.id }),
      ]);
    });

    const user = { id: (await insertUser(getDb() as unknown as Tx)).id, role: "RECRUITER" as const };
    const row = await withTransaction(async (tx) => create(tx, user, await validInput(tx)));
    await expect(
      withTransaction(async (tx) => {
        await updateRequisition(tx, user, row.id, { version: 1, departmentId: await md(tx, "DEPARTMENT") });
        throw new Error("roll back");
      }),
    ).rejects.toThrow("roll back");
    const history = await getDb().select().from(requisitionHistory).where(eq(requisitionHistory.requisitionId, row.id));
    expect(history.map((entry) => entry.event)).toEqual(["STATE_CHANGE"]);
  });

  it("L11: each changed L2 field gets its own row with IDs as text", async () => {
    await rolledBack(async (tx) => {
      const user = await actor(tx);
      const row = await create(tx, user, await validInput(tx));
      const departmentId = await md(tx, "DEPARTMENT");
      const legalEntityId = await md(tx, "LEGAL_ENTITY");
      const hm = await insertUser(tx, "HIRING_MANAGER");
      await updateRequisition(tx, user, row.id, { version: 1, departmentId, legalEntityId, hiringManagerId: hm.id, locationId: await md(tx, "LOCATION") });
      const changes = await tx.select().from(requisitionHistory).where(eq(requisitionHistory.event, "FIELD_CHANGE"));
      const mine = changes.filter((change) => change.requisitionId === row.id).map(({ field, oldValue, newValue }) => ({ field, oldValue, newValue }));
      expect(mine).toEqual(
        expect.arrayContaining([
          { field: "department_id", oldValue: row.departmentId, newValue: departmentId },
          { field: "legal_entity_id", oldValue: row.legalEntityId, newValue: legalEntityId },
          { field: "hiring_manager_id", oldValue: row.hiringManagerId, newValue: hm.id },
        ]),
      );
      expect(mine).toHaveLength(3);
    });
  });
});

describe("private slug", () => {
  it("L9: a new PRIVATE requisition gets 32 hex characters, two get different slugs, EXTERNAL gets none", async () => {
    await rolledBack(async (tx) => {
      const user = await actor(tx);
      const first = await create(tx, user, await validInput(tx, { postingType: "PRIVATE" }));
      const second = await create(tx, user, await validInput(tx, { postingType: "PRIVATE" }));
      const external = await create(tx, user, await validInput(tx));
      expect(first.privateSlug).toMatch(/^[0-9a-f]{32}$/);
      expect(second.privateSlug).toMatch(/^[0-9a-f]{32}$/);
      expect(second.privateSlug).not.toBe(first.privateSlug);
      expect(external.privateSlug).toBeNull();
    });
  });

  it("L9: switching PRIVATE → EXTERNAL → PRIVATE keeps the first slug; EXTERNAL → PRIVATE generates one", async () => {
    await rolledBack(async (tx) => {
      const user = await actor(tx);
      const row = await create(tx, user, await validInput(tx, { postingType: "PRIVATE" }));
      const external = await updateRequisition(tx, user, row.id, { version: 1, postingType: "EXTERNAL" });
      expect(external).toMatchObject({ ok: true, requisition: { postingType: "EXTERNAL", privateSlug: row.privateSlug } });
      const back = await updateRequisition(tx, user, row.id, { version: 2, postingType: "PRIVATE" });
      expect(back).toMatchObject({ ok: true, requisition: { privateSlug: row.privateSlug } });

      const plain = await create(tx, user, await validInput(tx));
      const switched = await updateRequisition(tx, user, plain.id, { version: 1, postingType: "PRIVATE" });
      expect(switched.ok && switched.requisition.privateSlug).toMatch(/^[0-9a-f]{32}$/);
    });
  });
});

describe("duplicate", () => {
  it("copies the fields into a new DRAFT with a higher number and nothing else", async () => {
    await rolledBack(async (tx) => {
      const user = await actor(tx);
      const source = await create(tx, user, await validInput(tx, { postingType: "PRIVATE", openingsCount: 2 }));
      await tx.update(requisitions).set({ state: "APPROVED", isPublished: true, approvedAt: new Date() }).where(eq(requisitions.id, source.id));
      const values = await duplicateValues(user, source.id, tx);
      const copy = await create(tx, user, { ...values });
      expect(copy.id).not.toBe(source.id);
      expect(Number(copy.reqNumber.slice(4))).toBeGreaterThan(Number(source.reqNumber.slice(4)));
      expect(copy).toMatchObject({
        title: source.title,
        departmentId: source.departmentId,
        locationId: source.locationId,
        legalEntityId: source.legalEntityId,
        hiringManagerId: source.hiringManagerId,
        recruiterId: source.recruiterId,
        openingsCount: 2,
        descriptionHtml: source.descriptionHtml,
        postingType: "PRIVATE",
        state: "DRAFT",
        isPublished: false,
        approvedAt: null,
      });
      expect(copy.privateSlug).toMatch(/^[0-9a-f]{32}$/);
      expect(copy.privateSlug).not.toBe(source.privateSlug);
    });
  });

  it("a requisition outside the caller's scope can't be duplicated", async () => {
    await rolledBack(async (tx) => {
      const source = await create(tx, await actor(tx), await validInput(tx));
      expect(await duplicateValues(await actor(tx, "HIRING_MANAGER"), source.id, tx)).toBeUndefined();
    });
  });
});

describe("visibility through the API", () => {
  /** Requisitions where the Hiring Manager is hiring manager (A), approver (B), creator (C), and none (D). */
  async function scopedRequisitions(hmId: string) {
    const db = getDb() as unknown as Tx;
    const a = await insertRequisition(db, { hiringManagerId: hmId });
    const b = await insertRequisition(db, { approverId: hmId });
    const c = await insertRequisition(db, { createdByUserId: hmId });
    const d = await insertRequisition(db);
    return { a, b, c, d };
  }
  const ids = async (response: Response) => ((await response.json()) as { rows: { id: string }[] }).rows.map((row) => row.id);

  it("V3: a Hiring Manager's list holds exactly the requisitions in their scope; another one is 404", async () => {
    const { userId, cookie } = await signedIn("HIRING_MANAGER");
    const { a, b, c, d } = await scopedRequisitions(userId);
    const response = await apiList(cookie);
    expect(response.status).toBe(200);
    expect((await ids(response)).sort()).toEqual([a.id, b.id, c.id].sort());
    expect((await apiGet(a.id, cookie)).status).toBe(200);
    const hidden = await apiGet(d.id, cookie);
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toMatchObject({ error: "notFound" });
  });

  it("V2: a Recruiter's list holds all four, also where another user is recruiter", async () => {
    const hm = await signedIn("HIRING_MANAGER");
    const { a, b, c, d } = await scopedRequisitions(hm.userId);
    const { cookie } = await signedIn("RECRUITER");
    // The worker database is shared by this file's tests; the list is paged, so filter to DRAFT and read every page.
    const seen = new Set<string>();
    for (let page = 1; page < 100; page += 1) {
      const response = await apiList(cookie, `?state=DRAFT&page=${page}`);
      expect(response.status).toBe(200);
      const pageIds = await ids(response);
      pageIds.forEach((id) => seen.add(id));
      if (pageIds.length < 50) break;
    }
    for (const row of [a, b, c, d]) expect(seen.has(row.id), row.id).toBe(true);
    expect((await apiGet(d.id, cookie)).status).toBe(200);
  });

  it("V3: an Interviewer gets 403 from the list API", async () => {
    const { cookie } = await signedIn("INTERVIEWER");
    expect((await apiList(cookie)).status).toBe(403);
  });

  it("creates through the API as a Hiring Manager and reports field errors with texts", async () => {
    const { cookie } = await signedIn("HIRING_MANAGER");
    const input = await validInput(getDb());
    const created = await apiCreate(input, cookie);
    expect(created.status).toBe(201);
    const bad = await apiCreate({ ...input, departmentId: input.locationId }, cookie);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid", fields: { departmentId: "Pick a value of the right type." } });
    const { cookie: interviewer } = await signedIn("INTERVIEWER");
    expect((await apiCreate(input, interviewer)).status).toBe(403);
  });
});
