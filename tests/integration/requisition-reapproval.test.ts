// Requisition re-approval against the database, pg-boss and Mailpit
// (ats-project-scope.md §5.2 L2, A1–A3, A7, A9, L6, L11, R6, V3a, TO-10).
// Rows are committed where the API needs them; every row is new.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, asc, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { POST as approve } from "@/app/api/requisitions/[id]/approve/route";
import { POST as reject } from "@/app/api/requisitions/[id]/reject/route";
import { GET, PATCH } from "@/app/api/requisitions/[id]/route";
import { POST as withdraw } from "@/app/api/requisitions/[id]/withdraw/route";
import { jobQueue } from "@/server/adapters/job-queue";
import { submitApplication } from "@/server/apply";
import { reApprovalChanges } from "@/server/approvals";
import { listPublicJobs } from "@/server/careers";
import { type Tx, getDb, withTransaction } from "@/server/db";
import { applicationHistory, applications, approvalEvents, emailLog, masterData, requisitionHistory, requisitions } from "@/server/db/schema";
import { changeApplicationStatus } from "@/server/pipeline";
import { updateRequisition } from "@/server/requisitions";
import { waitForMessage } from "../support/mailpit";
import { processDueJobs } from "../support/process-due-jobs";
import { insertApplication, insertRequisition, insertUser } from "./fixtures";
import { unique } from "./helpers";
import { ORIGIN, signedIn } from "./sessions";

const db = () => getDb() as unknown as Tx;
const VALID_PDF = new Uint8Array(readFileSync("tests/fixtures/pdf/valid.pdf"));
const APPROVED_AT = new Date("2026-09-01T10:00:00Z");

// Shared worker database: emails this file left queued are cancelled.
const createdRequisitionIds: string[] = [];
afterAll(async () => {
  if (createdRequisitionIds.length === 0) return;
  await withTransaction(async (tx) => {
    const queued = await tx
      .update(emailLog)
      .set({ status: "CANCELLED" })
      .where(and(inArray(emailLog.requisitionId, createdRequisitionIds), eq(emailLog.status, "QUEUED")))
      .returning({ jobId: emailLog.jobId });
    for (const { jobId } of queued) if (jobId) await jobQueue.cancel(tx, "email.send", jobId);
  });
});

type Session = Awaited<ReturnType<typeof signedIn>>;
type Handler = (request: Request, context: never) => Promise<Response>;
const call = (handler: Handler, id: string, body: unknown, session: Session, method = "POST") =>
  handler(
    new Request(`${ORIGIN}/api/requisitions/${id}/x`, {
      method,
      headers: { cookie: session.cookie, "content-type": "application/json" },
      ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve({ id }) } as never,
  );
const patch = (id: string, body: unknown, session: Session) => call(PATCH as Handler, id, body, session, "PATCH");

async function department(label = "Logistics") {
  const [row] = await getDb().insert(masterData).values({ type: "DEPARTMENT", code: unique("DEP"), label }).returning();
  return row;
}
async function legalEntity(label = "Demo DE") {
  const [row] = await getDb().insert(masterData).values({ type: "LEGAL_ENTITY", code: unique("LE"), label }).returning();
  return row;
}

/** An approved, published requisition with a unique title word and its own Hiring Manager. */
async function approved(overrides: Partial<typeof requisitions.$inferInsert> = {}) {
  const hm = await insertUser(db(), "HIRING_MANAGER");
  const word = `Reapproval${randomUUID().slice(0, 8)}`;
  const row = await insertRequisition(db(), {
    title: `Picker ${word}`,
    hiringManagerId: hm.id,
    state: "APPROVED",
    approvedAt: APPROVED_AT,
    isPublished: true,
    openingsCount: 2,
    descriptionHtml: "<p>Pick orders.</p>",
    ...overrides,
  });
  createdRequisitionIds.push(row.id);
  return { ...row, word };
}

async function row(id: string) {
  const [found] = await getDb().select().from(requisitions).where(eq(requisitions.id, id));
  return found;
}
const events = (id: string) => getDb().select().from(approvalEvents).where(eq(approvalEvents.subjectId, id)).orderBy(asc(approvalEvents.createdAt));
const history = (id: string) => getDb().select().from(requisitionHistory).where(eq(requisitionHistory.requisitionId, id)).orderBy(asc(requisitionHistory.createdAt));

/** A Recruiter raises openings to `openings` and names `approverId`; returns the updated row. */
async function startReApproval(job: { id: string }, recruiter: Session, approverId: string, changes: Record<string, unknown> = { openingsCount: 4 }) {
  const response = await patch(job.id, { version: (await row(job.id)).version, ...changes, approverId }, recruiter);
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
  return row(job.id);
}

describe("triggering re-approval (L2)", () => {
  it("L2: raising openings 2 → 4 starts re-approval; the posting stays live and the pipeline keeps flowing; the approver is emailed", async () => {
    const recruiter = await signedIn("RECRUITER");
    const approver = await signedIn("HIRING_MANAGER");
    const job = await approved();
    const rejected = await insertApplication(db(), { requisitionId: job.id, status: "REJECTED", reasonCode: "OTHER", dispositionedAt: new Date() });

    const updated = await startReApproval(job, recruiter, approver.userId);
    expect(updated).toMatchObject({
      state: "PENDING_APPROVAL",
      openingsCount: 4,
      approvedAt: APPROVED_AT,
      isPublished: true,
      submittedByUserId: recruiter.userId,
      approverId: approver.userId,
      previousL2ValuesJson: { openings_count: 2, department_id: job.departmentId, hiring_manager_id: job.hiringManagerId, legal_entity_id: job.legalEntityId },
    });
    expect((await events(job.id)).map((event) => [event.event, event.toApproverId])).toEqual([["SUBMITTED", approver.userId]]);
    expect((await history(job.id)).map((entry) => [entry.event, entry.field, entry.oldValue, entry.newValue])).toEqual([
      ["FIELD_CHANGE", "openings_count", "2", "4"],
      ["STATE_CHANGE", "state", "APPROVED", "PENDING_APPROVAL"],
    ]);

    expect((await listPublicJobs({ q: job.word, page: 1 })).jobs).toHaveLength(1);
    const applied = await submitApplication({
      route: { kind: "external", id: job.id },
      fields: { firstName: "Ann", lastName: "Lee", email: `e2e-${randomUUID()}@example.com`, phone: "+48 600 100 200", consent: true },
      answers: {},
      questionStamp: [],
      consentVersion: "1.0",
      cv: { bytes: VALID_PDF, name: "CV.pdf" },
      coverLetter: null,
    });
    expect(applied).toMatchObject({ ok: true, status: "APPLIED" });
    const actor = { id: recruiter.userId };
    if (!applied.ok) throw new Error("apply failed");
    expect(await withTransaction((tx) => changeApplicationStatus(tx, { applicationId: applied.applicationId, toStatus: "SCREENING", version: 1, actor }))).toMatchObject({ ok: true });
    expect(
      await withTransaction((tx) => changeApplicationStatus(tx, { applicationId: rejected.id, toStatus: "SCREENING", version: 1, comment: "Second look", actor })),
    ).toMatchObject({ ok: true });

    await processDueJobs();
    const [approverRow] = await getDb().select({ email: emailLog.recipient }).from(emailLog).where(and(eq(emailLog.requisitionId, job.id), eq(emailLog.audience, "STAFF")));
    const message = await waitForMessage({ to: approverRow.email! });
    expect(message.html).toContain(job.reqNumber);
  });

  it("L2: a triggering save without an approver, or with the editor as approver, returns 400 and changes nothing", async () => {
    const admin = await signedIn("ADMIN");
    const job = await approved();
    const missing = await patch(job.id, { version: 1, openingsCount: 3 }, admin);
    expect(missing.status).toBe(400);
    expect((await missing.json()).fields.approverId).toBe("This change needs re-approval. Choose an approver.");
    const self = await patch(job.id, { version: 1, departmentId: (await department()).id, approverId: admin.userId }, admin);
    expect(self.status).toBe(400);
    expect((await self.json()).fields.approverId).toBe("You can't approve your own submission.");
    expect(await row(job.id)).toMatchObject({ state: "APPROVED", version: 1, openingsCount: 2, departmentId: job.departmentId, previousL2ValuesJson: null });
    expect(await events(job.id)).toEqual([]);
  });

  it("L2: a decrease combined with a new department starts re-approval and saves the old, higher openings", async () => {
    const recruiter = await signedIn("RECRUITER");
    const approver = await insertUser(db(), "HIRING_MANAGER");
    const job = await approved({ openingsCount: 3 });
    const updated = await startReApproval(job, recruiter, approver.id, { openingsCount: 1, departmentId: (await department()).id });
    expect(updated).toMatchObject({ state: "PENDING_APPROVAL", openingsCount: 1 });
    expect(updated.previousL2ValuesJson).toMatchObject({ openings_count: 3, department_id: job.departmentId });
  });

  it("L2: a Hiring Manager can't make the change", async () => {
    const hm = await signedIn("HIRING_MANAGER");
    const job = await approved({ hiringManagerId: hm.userId, createdByUserId: hm.userId });
    expect((await patch(job.id, { version: 1, openingsCount: 5, approverId: (await insertUser(db(), "ADMIN")).id }, hm)).status).toBe(403);
  });
});

describe("field locks and decreases (L2)", () => {
  it("L2: each of the four fields is refused in ON_HOLD, PENDING_APPROVAL (first and re-approval) and CLOSED", async () => {
    const recruiter = await signedIn("RECRUITER");
    const changes = async () => [
      { openingsCount: 1 },
      { departmentId: (await department()).id },
      { hiringManagerId: (await insertUser(db(), "HIRING_MANAGER")).id },
      { legalEntityId: (await legalEntity()).id },
    ];
    const states: Partial<typeof requisitions.$inferInsert>[] = [
      { state: "ON_HOLD", isPublished: false, onHoldSince: new Date() },
      { state: "PENDING_APPROVAL", approvedAt: null, isPublished: false },
      { state: "PENDING_APPROVAL" },
      { state: "CLOSED", isPublished: false, closedAt: new Date(), closeReason: "CANCELLED" },
    ];
    for (const state of states) {
      for (const change of await changes()) {
        const job = await approved({ openingsCount: 3, ...state });
        const response = await patch(job.id, { version: 1, ...change }, recruiter);
        expect(response.status, `${state.state} ${Object.keys(change)[0]}`).toBe(409);
        expect((await row(job.id)).version).toBe(1);
      }
    }
  });

  it("L2: decreasing openings alone needs no approver and no approval event and writes a FIELD_CHANGE row", async () => {
    const recruiter = await signedIn("RECRUITER");
    const job = await approved({ openingsCount: 3 });
    expect((await patch(job.id, { version: 1, openingsCount: 2 }, recruiter)).status).toBe(200);
    expect(await row(job.id)).toMatchObject({ state: "APPROVED", openingsCount: 2, previousL2ValuesJson: null });
    expect(await events(job.id)).toEqual([]);
    expect((await history(job.id)).map((entry) => [entry.event, entry.field, entry.oldValue, entry.newValue])).toEqual([["FIELD_CHANGE", "openings_count", "3", "2"]]);
  });

  it("L2: with two hired, lowering openings 3 → 1 returns 400 and 3 → 2 closes the requisition as FILLED", async () => {
    const recruiter = await signedIn("RECRUITER");
    const job = await approved({ openingsCount: 3 });
    for (let n = 0; n < 2; n += 1) await insertApplication(db(), { requisitionId: job.id, status: "HIRED", dispositionedAt: new Date(), hiredAt: new Date() });
    const open = await insertApplication(db(), { requisitionId: job.id, status: "INTERVIEW" });

    const below = await patch(job.id, { version: 1, openingsCount: 1 }, recruiter);
    expect(below.status).toBe(400);
    expect((await below.json()).fields.openingsCount).toBe("Openings can't be lower than the 2 already hired.");

    expect((await patch(job.id, { version: 1, openingsCount: 2 }, recruiter)).status).toBe(200);
    const closed = await row(job.id);
    expect(closed).toMatchObject({ state: "CLOSED", closeReason: "FILLED", isPublished: false, openingsCount: 2 });
    expect(closed.closedAt).toBeInstanceOf(Date);
    const [rejected] = await getDb().select().from(applications).where(eq(applications.id, open.id));
    expect(rejected).toMatchObject({ status: "REJECTED", reasonCode: "REQ_FILLED" });
    expect(await getDb().select().from(applicationHistory).where(eq(applicationHistory.applicationId, open.id))).toHaveLength(1);
  });

  it("L2: the edit and the FILLED close are one transaction: a failure after the close leaves openings 3 and APPROVED", async () => {
    const recruiter = await insertUser(db(), "RECRUITER");
    const job = await approved({ openingsCount: 3 });
    for (let n = 0; n < 2; n += 1) await insertApplication(db(), { requisitionId: job.id, status: "HIRED", dispositionedAt: new Date(), hiredAt: new Date() });
    const open = await insertApplication(db(), { requisitionId: job.id });
    await expect(
      withTransaction(async (tx) => {
        const result = await updateRequisition(tx, { id: recruiter.id, role: "RECRUITER" }, job.id, { version: 1, openingsCount: 2 });
        expect(result).toMatchObject({ ok: true, requisition: { state: "CLOSED" } });
        throw new Error("forced failure after the close");
      }),
    ).rejects.toThrow("forced failure");
    expect(await row(job.id)).toMatchObject({ state: "APPROVED", openingsCount: 3, version: 1 });
    expect((await getDb().select().from(applications).where(eq(applications.id, open.id)))[0].status).toBe("APPLIED");
  });
});

describe("decisions on re-approval (A3, A9)", () => {
  async function inReApproval() {
    const recruiter = await signedIn("RECRUITER");
    const approver = await signedIn("HIRING_MANAGER");
    const job = await approved({ isPublished: false });
    const newDepartment = await department("Warehouse");
    const newEntity = await legalEntity("Demo CZ");
    const newHm = await insertUser(db(), "HIRING_MANAGER");
    await startReApproval(job, recruiter, approver.userId, { openingsCount: 5, departmentId: newDepartment.id, hiringManagerId: newHm.id, legalEntityId: newEntity.id });
    return { recruiter, approver, job, newDepartment, newEntity, newHm };
  }

  it("A3: approving a re-approval keeps the original approved_at and publishing, and clears the saved values", async () => {
    const { approver, job } = await inReApproval();
    const response = await call(approve, job.id, { version: 2 }, approver);
    expect(response.status).toBe(200);
    expect(await row(job.id)).toMatchObject({ state: "APPROVED", approvedAt: APPROVED_AT, isPublished: false, openingsCount: 5, previousL2ValuesJson: null });
    expect((await events(job.id)).map((event) => event.event)).toEqual(["SUBMITTED", "APPROVED"]);
  });

  it("A3: rejecting a re-approval with a comment restores the four fields; without a comment it returns 400", async () => {
    const { approver, job } = await inReApproval();
    expect((await call(reject, job.id, { version: 2 }, approver)).status).toBe(400);
    expect((await call(reject, job.id, { version: 2, comment: "Not in budget" }, approver)).status).toBe(200);
    expect(await row(job.id)).toMatchObject({
      state: "APPROVED",
      approvedAt: APPROVED_AT,
      isPublished: false,
      openingsCount: 2,
      departmentId: job.departmentId,
      hiringManagerId: job.hiringManagerId,
      legalEntityId: job.legalEntityId,
      previousL2ValuesJson: null,
    });
    const restored = (await history(job.id)).filter((entry) => entry.comment === "Not in budget");
    expect(restored.map((entry) => entry.field).sort()).toEqual(["department_id", "hiring_manager_id", "legal_entity_id", "openings_count", "state"]);
  });

  it("A9: the submitter withdraws a re-approval and the old values come back; a Hiring Manager who isn't the submitter gets 403", async () => {
    const { recruiter, job } = await inReApproval();
    const other = await signedIn("HIRING_MANAGER");
    expect((await call(withdraw, job.id, { version: 2 }, other)).status).toBe(404);
    // In scope (creator) but not the submitter: 403.
    await getDb().update(requisitions).set({ createdByUserId: other.userId }).where(eq(requisitions.id, job.id));
    expect((await call(withdraw, job.id, { version: 2 }, other)).status).toBe(403);
    expect((await call(withdraw, job.id, { version: 2 }, recruiter)).status).toBe(200);
    expect(await row(job.id)).toMatchObject({ state: "APPROVED", openingsCount: 2, departmentId: job.departmentId, previousL2ValuesJson: null });
    expect((await events(job.id)).map((event) => event.event)).toEqual(["SUBMITTED", "WITHDRAWN"]);
  });

  it("restores a value deactivated in the meantime, as stored", async () => {
    const { approver, job } = await inReApproval();
    await getDb().update(masterData).set({ isActive: false }).where(eq(masterData.id, job.departmentId));
    expect((await call(reject, job.id, { version: 2, comment: "No" }, approver)).status).toBe(200);
    expect((await row(job.id)).departmentId).toBe(job.departmentId);
  });

  it("V3a follows the live hiring manager: the new one sees it during re-approval, the replaced one again after a reject", async () => {
    const recruiter = await signedIn("RECRUITER");
    const approver = await signedIn("HIRING_MANAGER");
    const oldHm = await signedIn("HIRING_MANAGER");
    const newHm = await signedIn("HIRING_MANAGER");
    const job = await approved({ hiringManagerId: oldHm.userId });
    await startReApproval(job, recruiter, approver.userId, { hiringManagerId: newHm.userId });
    expect((await call(GET as Handler, job.id, undefined, newHm, "GET")).status).toBe(200);
    expect((await call(GET as Handler, job.id, undefined, oldHm, "GET")).status).toBe(404);
    expect((await call(reject, job.id, { version: 2, comment: "Keep the old one" }, approver)).status).toBe(200);
    expect((await call(GET as Handler, job.id, undefined, oldHm, "GET")).status).toBe(200);
    expect((await call(GET as Handler, job.id, undefined, newHm, "GET")).status).toBe(404);
  });

  it("shows the changed L2 fields as old → new labels", async () => {
    const { job, newDepartment, newHm } = await inReApproval();
    const changes = await reApprovalChanges(await row(job.id));
    expect(changes).toEqual([
      { field: "openingsCount", from: "2", to: "5" },
      { field: "departmentId", from: "DEPARTMENT", to: newDepartment.label },
      { field: "hiringManagerId", from: "Test User", to: newHm.name },
      { field: "legalEntityId", from: "LEGAL_ENTITY", to: "Demo CZ" },
    ]);
  });
});
