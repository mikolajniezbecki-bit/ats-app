// Requisition first approval against the database (ats-project-scope.md A1,
// A2, A3, A7, A9, E7, L8, L11; tech-stack.md D7, T5): through the API with
// real session cookies, and the approval request read from Mailpit.
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { POST as approve } from "@/app/api/requisitions/[id]/approve/route";
import { POST as reject } from "@/app/api/requisitions/[id]/reject/route";
import { PATCH } from "@/app/api/requisitions/[id]/route";
import { POST as questionsPost } from "@/app/api/requisitions/[id]/questions/route";
import { POST as submit } from "@/app/api/requisitions/[id]/submit/route";
import { POST as withdraw } from "@/app/api/requisitions/[id]/withdraw/route";
import { type Tx, getDb } from "@/server/db";
import { approvalEvents, emailLog, masterData, requisitionHistory, requisitions, users } from "@/server/db/schema";
import { listApproverOptions } from "@/server/approvals";
import { waitForMessage } from "../support/mailpit";
import { processDueJobs } from "../support/process-due-jobs";
import { insertRequisition, insertUser } from "./fixtures";
import { ORIGIN, signedIn } from "./sessions";

type Session = Awaited<ReturnType<typeof signedIn>>;
const db = () => getDb() as unknown as Tx;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;
type Handler = (request: Request, context: never) => Promise<Response>;
const post = (handler: Handler, id: string, body: unknown, session: Session) =>
  handler(
    new Request(`${ORIGIN}/api/requisitions/${id}/x`, { method: "POST", headers: { cookie: session.cookie, "content-type": "application/json" }, body: JSON.stringify(body) }),
    ctx(id),
  );
const patch = (id: string, body: unknown, session: Session) =>
  PATCH(new Request(`${ORIGIN}/api/requisitions/${id}`, { method: "PATCH", headers: { cookie: session.cookie, "content-type": "application/json" }, body: JSON.stringify(body) }), ctx(id));

/** A draft that passes the submission checks, created by `creatorId`. */
async function draft(creatorId: string, overrides: Partial<typeof requisitions.$inferInsert> = {}) {
  const hm = await insertUser(db(), "HIRING_MANAGER");
  return insertRequisition(db(), { hiringManagerId: hm.id, createdByUserId: creatorId, descriptionHtml: "<p>Build things.</p>", ...overrides });
}

async function row(id: string) {
  const [found] = await getDb().select().from(requisitions).where(eq(requisitions.id, id));
  return found;
}

async function submitted(submitter: Session, approverId: string, overrides: Partial<typeof requisitions.$inferInsert> = {}) {
  const requisition = await draft(submitter.userId, overrides);
  const response = await post(submit, requisition.id, { approverId, version: 1 }, submitter);
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
  return row(requisition.id);
}

const events = (id: string) =>
  getDb().select().from(approvalEvents).where(eq(approvalEvents.subjectId, id)).orderBy(asc(approvalEvents.createdAt));
const stateChanges = async (id: string) =>
  (await getDb().select().from(requisitionHistory).where(eq(requisitionHistory.requisitionId, id)).orderBy(asc(requisitionHistory.createdAt))).filter(
    (entry) => entry.event === "STATE_CHANGE",
  );

describe("submit", () => {
  it("A1: submitting to an active Hiring Manager or an active Admin works and records the submission", async () => {
    const recruiter = await signedIn("RECRUITER");
    const hm = await insertUser(db(), "HIRING_MANAGER");
    const admin = await insertUser(db(), "ADMIN");
    const toHm = await submitted(recruiter, hm.id);
    expect(toHm).toMatchObject({ state: "PENDING_APPROVAL", submittedByUserId: recruiter.userId, approverId: hm.id, version: 2 });
    expect(toHm.submittedAt).toBeInstanceOf(Date);
    expect((await submitted(recruiter, admin.id)).approverId).toBe(admin.id);
  });

  it("A1: a Recruiter, an Interviewer or an inactive Hiring Manager as approver returns 400", async () => {
    const recruiter = await signedIn("RECRUITER");
    const inactive = await insertUser(db(), "HIRING_MANAGER");
    await getDb().update(users).set({ isActive: false }).where(eq(users.id, inactive.id));
    for (const approverId of [(await insertUser(db(), "RECRUITER")).id, (await insertUser(db(), "INTERVIEWER")).id, inactive.id]) {
      const requisition = await draft(recruiter.userId);
      const response = await post(submit, requisition.id, { approverId, version: 1 }, recruiter);
      expect(response.status).toBe(400);
      expect((await response.json()).fields).toEqual({ approverId: "Choose an active Hiring Manager or Admin as approver." });
      expect((await row(requisition.id)).state).toBe("DRAFT");
    }
  });

  it("A2: an Admin submitting with themselves as approver gets 400", async () => {
    const admin = await signedIn("ADMIN");
    const requisition = await draft(admin.userId);
    const response = await post(submit, requisition.id, { approverId: admin.userId, version: 1 }, admin);
    expect(response.status).toBe(400);
    expect((await response.json()).fields).toEqual({ approverId: "You can't approve your own submission." });
  });

  it("A2: a Hiring Manager submitting their own draft with themselves as approver gets 400", async () => {
    const hm = await signedIn("HIRING_MANAGER");
    const requisition = await draft(hm.userId);
    const response = await post(submit, requisition.id, { approverId: hm.userId, version: 1 }, hm);
    expect(response.status).toBe(400);
    expect((await response.json()).fields.approverId).toBe("You can't approve your own submission.");
  });

  it("A2: the approver picker for the current user doesn't list that user, but lists other active approvers only", async () => {
    const hm = await signedIn("HIRING_MANAGER");
    const otherHm = await insertUser(db(), "HIRING_MANAGER");
    const admin = await insertUser(db(), "ADMIN");
    const recruiter = await insertUser(db(), "RECRUITER");
    const inactive = await insertUser(db(), "HIRING_MANAGER");
    await getDb().update(users).set({ isActive: false }).where(eq(users.id, inactive.id));

    const ids = (await listApproverOptions({ id: hm.userId, role: "HIRING_MANAGER" })).map((option) => option.id);
    expect(ids).not.toContain(hm.userId);
    expect(ids).toEqual(expect.arrayContaining([otherHm.id, admin.id]));
    expect(ids).not.toContain(recruiter.id);
    expect(ids).not.toContain(inactive.id);
  });

  it("A1: submit checks the description, active references and custom fields, and refuses other states and stale versions", async () => {
    const recruiter = await signedIn("RECRUITER");
    const approver = await insertUser(db(), "HIRING_MANAGER");
    for (const empty of ["", "<p></p>", "<p> </p>", "<br>"]) {
      const requisition = await draft(recruiter.userId, { descriptionHtml: empty });
      const response = await post(submit, requisition.id, { approverId: approver.id, version: 1 }, recruiter);
      expect((await response.json()).fields, empty).toEqual({ descriptionHtml: "Add a job description before submitting." });
    }
    const inactiveDept = await draft(recruiter.userId);
    await getDb().update(masterData).set({ isActive: false }).where(eq(masterData.id, inactiveDept.departmentId));
    const deptResponse = await post(submit, inactiveDept.id, { approverId: approver.id, version: 1 }, recruiter);
    expect((await deptResponse.json()).fields).toEqual({ departmentId: "This value is inactive. Pick an active one." });

    const stale = await draft(recruiter.userId);
    const staleResponse = await post(submit, stale.id, { approverId: approver.id, version: 7 }, recruiter);
    expect(staleResponse.status).toBe(409);
    expect((await staleResponse.json()).message).toBe("This record was changed by someone else. Reload and try again.");

    const approved = await draft(recruiter.userId, { state: "APPROVED", approvedAt: new Date() });
    const stateResponse = await post(submit, approved.id, { approverId: approver.id, version: 1 }, recruiter);
    expect(stateResponse.status).toBe(409);
    expect((await stateResponse.json()).message).toBe("This requisition can't be submitted in its current state.");
    expect(await events(approved.id)).toEqual([]);
  });

  it("E7: the approver receives the request with the number, title and link; email_log is STAFF with the requisition", async () => {
    const recruiter = await signedIn("RECRUITER");
    const approver = await signedIn("HIRING_MANAGER");
    const [approverRow] = await getDb().select().from(users).where(eq(users.id, approver.userId));
    const requisition = await submitted(recruiter, approver.userId, { title: "Platform Engineer" });

    const logs = await getDb().select().from(emailLog).where(eq(emailLog.requisitionId, requisition.id));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ audience: "STAFF", applicationId: null, recipient: approverRow.email, status: "QUEUED" });

    await processDueJobs();
    const message = await waitForMessage({ to: approverRow.email });
    expect(message.subject).toBe(`Approval needed: ${requisition.reqNumber} Platform Engineer`);
    expect(message.text).toContain(`http://localhost:3000/requisitions/${requisition.id}`);
    expect(message.text).not.toContain("Reply to this email to reach your recruiter.");
  });

  it("E7: a submit that fails validation queues nothing", async () => {
    const recruiter = await signedIn("RECRUITER");
    const requisition = await draft(recruiter.userId, { descriptionHtml: "" });
    await post(submit, requisition.id, { approverId: (await insertUser(db(), "HIRING_MANAGER")).id, version: 1 }, recruiter);
    expect(await getDb().select().from(emailLog).where(eq(emailLog.requisitionId, requisition.id))).toEqual([]);
  });
});

describe("decide", () => {
  it("A3: approve sets APPROVED, approved_at and is_published, and keeps the submission fields", async () => {
    const recruiter = await signedIn("RECRUITER");
    const approver = await signedIn("HIRING_MANAGER");
    const pending = await submitted(recruiter, approver.userId, { postingType: "PRIVATE", privateSlug: randomUUID().replaceAll("-", "") });
    const response = await post(approve, pending.id, { version: pending.version }, approver);
    expect(response.status).toBe(200);
    const approved = await row(pending.id);
    expect(approved).toMatchObject({ state: "APPROVED", isPublished: true, submittedByUserId: recruiter.userId, approverId: approver.userId });
    expect(approved.approvedAt).toBeInstanceOf(Date);
  });

  it("A3: reject without a comment returns 400; with a comment it returns to DRAFT, which can be edited and submitted again", async () => {
    const recruiter = await signedIn("RECRUITER");
    const approver = await signedIn("HIRING_MANAGER");
    const pending = await submitted(recruiter, approver.userId);
    for (const body of [{ version: pending.version }, { version: pending.version, comment: "" }, { version: pending.version, comment: "   " }]) {
      const response = await post(reject, pending.id, body, approver);
      expect(response.status).toBe(400);
      expect((await response.json()).fields).toEqual({ comment: "Add a comment to reject." });
    }
    expect((await row(pending.id)).state).toBe("PENDING_APPROVAL");

    expect((await post(reject, pending.id, { version: pending.version, comment: "Budget unclear" }, approver)).status).toBe(200);
    const rejected = await row(pending.id);
    expect(rejected).toMatchObject({ state: "DRAFT", approvedAt: null, isPublished: false });
    expect((await patch(pending.id, { version: rejected.version, title: "Clarified" }, recruiter)).status).toBe(200);
    expect((await post(submit, pending.id, { approverId: approver.userId, version: rejected.version + 1 }, recruiter)).status).toBe(200);
  });

  it("A3: the submitter, as an Admin who is also the approver, can't approve their own submission (403)", async () => {
    const admin = await signedIn("ADMIN");
    const pending = await draft(admin.userId);
    await getDb()
      .update(requisitions)
      .set({ state: "PENDING_APPROVAL", submittedByUserId: admin.userId, approverId: admin.userId, submittedAt: new Date() })
      .where(eq(requisitions.id, pending.id));
    expect((await post(approve, pending.id, { version: 1 }, admin)).status).toBe(403);
  });

  it("A3: an Admin who isn't the approver gets 403; a Hiring Manager outside the scope gets 404", async () => {
    const recruiter = await signedIn("RECRUITER");
    const pending = await submitted(recruiter, (await insertUser(db(), "HIRING_MANAGER")).id);
    expect((await post(approve, pending.id, { version: pending.version }, await signedIn("ADMIN"))).status).toBe(403);
    expect((await post(approve, pending.id, { version: pending.version }, await signedIn("HIRING_MANAGER"))).status).toBe(404);
    expect((await post(approve, pending.id, { version: pending.version }, recruiter)).status).toBe(403);
  });

  // Task 30 (L2) made re-approval decidable (tests in requisition-reapproval.test.ts);
  // a requisition that isn't pending at all still gets 409.
  it("A3: a decision on a requisition that isn't pending approval returns 409", async () => {
    const approver = await signedIn("HIRING_MANAGER");
    const live = await draft(approver.userId, { state: "APPROVED", approvedAt: new Date(), approverId: approver.userId });
    const response = await post(approve, live.id, { version: 1 }, approver);
    expect(response.status).toBe(409);
    expect((await response.json()).message).toBe("This requisition is not awaiting approval.");
  });

  it("D7: approve and withdraw sent together at the same version: one wins, the other gets 409, one outcome event", async () => {
    const recruiter = await signedIn("RECRUITER");
    const approver = await signedIn("HIRING_MANAGER");
    const pending = await submitted(recruiter, approver.userId);
    const results = await Promise.all([
      post(approve, pending.id, { version: pending.version }, approver),
      post(withdraw, pending.id, { version: pending.version }, recruiter),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
    const outcomes = (await events(pending.id)).filter((event) => event.event !== "SUBMITTED");
    expect(outcomes).toHaveLength(1);
  });
});

describe("withdraw", () => {
  it("A9: the submitter (a Hiring Manager) withdraws and the requisition is DRAFT and editable again", async () => {
    const hm = await signedIn("HIRING_MANAGER");
    const pending = await submitted(hm, (await insertUser(db(), "ADMIN")).id);
    expect((await post(withdraw, pending.id, { version: pending.version }, hm)).status).toBe(200);
    const back = await row(pending.id);
    expect(back.state).toBe("DRAFT");
    expect((await patch(pending.id, { version: back.version, title: "Editable" }, hm)).status).toBe(200);
  });

  it("A9: a Recruiter who isn't the submitter can withdraw; the approver, a different Hiring Manager, gets 403", async () => {
    const submitter = await signedIn("HIRING_MANAGER");
    const approver = await signedIn("HIRING_MANAGER");
    const pending = await submitted(submitter, approver.userId);
    expect((await post(withdraw, pending.id, { version: pending.version }, approver)).status).toBe(403);
    expect((await post(withdraw, pending.id, { version: pending.version }, await signedIn("RECRUITER"))).status).toBe(200);
  });
});

describe("audit", () => {
  it("A7: submit, reject, submit, approve gives four approval events and four STATE_CHANGE rows in order; a failed action writes neither", async () => {
    const recruiter = await signedIn("RECRUITER");
    const approver = await signedIn("HIRING_MANAGER");
    const pending = await submitted(recruiter, approver.userId);
    expect((await post(reject, pending.id, { version: pending.version }, approver)).status).toBe(400);
    await post(reject, pending.id, { version: pending.version, comment: "Fix the title" }, approver);
    await post(submit, pending.id, { approverId: approver.userId, version: pending.version + 1 }, recruiter);
    await post(approve, pending.id, { version: pending.version + 2, comment: "Looks good" }, approver);

    expect((await events(pending.id)).map(({ event, actorUserId, fromApproverId, toApproverId, comment, subjectType }) => ({ event, actorUserId, fromApproverId, toApproverId, comment, subjectType }))).toEqual([
      { subjectType: "REQUISITION", event: "SUBMITTED", actorUserId: recruiter.userId, fromApproverId: null, toApproverId: approver.userId, comment: null },
      { subjectType: "REQUISITION", event: "REJECTED", actorUserId: approver.userId, fromApproverId: null, toApproverId: null, comment: "Fix the title" },
      { subjectType: "REQUISITION", event: "SUBMITTED", actorUserId: recruiter.userId, fromApproverId: null, toApproverId: approver.userId, comment: null },
      { subjectType: "REQUISITION", event: "APPROVED", actorUserId: approver.userId, fromApproverId: null, toApproverId: null, comment: "Looks good" },
    ]);
    expect((await stateChanges(pending.id)).map(({ oldValue, newValue }) => [oldValue, newValue])).toEqual([
      ["DRAFT", "PENDING_APPROVAL"],
      ["PENDING_APPROVAL", "DRAFT"],
      ["DRAFT", "PENDING_APPROVAL"],
      ["PENDING_APPROVAL", "APPROVED"],
    ]);
  });

  it("A7: a withdrawal records the approver it was taken from", async () => {
    const recruiter = await signedIn("RECRUITER");
    const approver = await insertUser(db(), "HIRING_MANAGER");
    const pending = await submitted(recruiter, approver.id);
    await post(withdraw, pending.id, { version: pending.version, comment: "Wrong approver" }, recruiter);
    expect((await events(pending.id)).at(-1)).toMatchObject({ event: "WITHDRAWN", fromApproverId: approver.id, toApproverId: null, comment: "Wrong approver" });
  });
});

describe("first-approval lock", () => {
  it("L8: after a real submit, editing the title and adding a question return 409; both work after a withdrawal", async () => {
    const recruiter = await signedIn("RECRUITER");
    const pending = await submitted(recruiter, (await insertUser(db(), "HIRING_MANAGER")).id);
    const question = { questionText: "Can you start in a month?", questionType: "YES_NO" };
    const addQuestion = () =>
      questionsPost(
        new Request(`${ORIGIN}/q`, { method: "POST", headers: { cookie: recruiter.cookie, "content-type": "application/json" }, body: JSON.stringify(question) }),
        ctx(pending.id),
      );

    const edit = await patch(pending.id, { version: pending.version, title: "Changed" }, recruiter);
    expect(edit.status).toBe(409);
    expect((await edit.json()).message).toBe("This requisition is awaiting approval. Withdraw it to make changes.");
    expect((await addQuestion()).status).toBe(409);
    expect((await row(pending.id)).title).not.toBe("Changed");

    await post(withdraw, pending.id, { version: pending.version }, recruiter);
    expect((await patch(pending.id, { version: pending.version + 1, title: "Changed" }, recruiter)).status).toBe(200);
    expect((await addQuestion()).status).toBe(201);
  });
});
