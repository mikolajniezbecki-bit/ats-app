// Approval reassignment, the deactivation guard and reminders against the
// database (ats-project-scope.md A4, A5, A6, A7, E7, V3a, V9; tech-stack.md
// J3, J7, T3, W5): through the API with real session cookies, the reminder
// run through the tick with `x-test-now` and the J7 helper, and emails read
// from Mailpit. The worker database is shared with other files, so every
// assertion is about this file's own requisitions and recipients.
import { and, asc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { PATCH as patchUser } from "@/app/api/admin/users/[id]/route";
import { POST as deactivate } from "@/app/api/admin/users/[id]/deactivate/route";
import { POST as approve } from "@/app/api/requisitions/[id]/approve/route";
import { POST as reassign } from "@/app/api/requisitions/[id]/reassign/route";
import { POST as submit } from "@/app/api/requisitions/[id]/submit/route";
import { getConfig } from "@/server/config";
import { listMyRequisitionApprovals, reassignRequisition } from "@/server/approvals";
import { runApprovalReminders } from "@/server/approvals/reminders";
import { type Tx, getDb, withTransaction } from "@/server/db";
import { approvalEvents, offers, requisitions, users } from "@/server/db/schema";
import { handleTick } from "@/server/domain/tick";
import { searchMessages, waitForMessage } from "../support/mailpit";
import { processDueJobs } from "../support/process-due-jobs";
import { insertRequisition, insertUser, offerValues } from "./fixtures";
import { ORIGIN, signedIn } from "./sessions";

type Session = Awaited<ReturnType<typeof signedIn>>;
type Handler = (request: Request, context: never) => Promise<Response>;
const db = () => getDb() as unknown as Tx;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;
const call = (handler: Handler, method: string, path: string, id: string, body: unknown, session?: Session) =>
  handler(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { ...(session ? { cookie: session.cookie } : {}), "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    ctx(id),
  );
const post = (handler: Handler, id: string, body: unknown, session?: Session) => call(handler, "POST", `/api/requisitions/${id}/x`, id, body, session);

async function row(id: string) {
  const [found] = await getDb().select().from(requisitions).where(eq(requisitions.id, id));
  return found;
}

const events = (id: string) => getDb().select().from(approvalEvents).where(eq(approvalEvents.subjectId, id)).orderBy(asc(approvalEvents.createdAt));

/** A draft submitted through the API by `submitter` to `approverId`. */
async function submitted(submitter: Session, approverId: string) {
  const hm = await insertUser(db(), "HIRING_MANAGER");
  const draft = await insertRequisition(db(), { hiringManagerId: hm.id, createdByUserId: submitter.userId, descriptionHtml: "<p>Build things.</p>" });
  const response = await post(submit, draft.id, { approverId, version: 1 }, submitter);
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
  return row(draft.id);
}

async function deactivated(userId: string) {
  await getDb().update(users).set({ isActive: false }).where(eq(users.id, userId));
}

describe("reassignment", () => {
  it("A4: reassignment without a reason, or with only spaces, returns 400 and changes nothing", async () => {
    const recruiter = await signedIn("RECRUITER");
    const hm = await insertUser(db(), "HIRING_MANAGER");
    const other = await insertUser(db(), "HIRING_MANAGER");
    const requisition = await submitted(recruiter, hm.id);
    for (const body of [{ approverId: other.id, version: requisition.version }, { approverId: other.id, reason: "   ", version: requisition.version }]) {
      const response = await post(reassign, requisition.id, body, recruiter);
      expect(response.status).toBe(400);
      expect((await response.json()).fields).toEqual({ reason: "Add a reason for the reassignment." });
    }
    const tooLong = await post(reassign, requisition.id, { approverId: other.id, reason: "x".repeat(2001), version: requisition.version }, recruiter);
    expect((await tooLong.json()).fields).toEqual({ reason: "Add a reason for the reassignment." });
    expect((await row(requisition.id)).approverId).toBe(hm.id);
    expect((await events(requisition.id)).map((event) => event.event)).toEqual(["SUBMITTED"]);
  });

  it("A4: reassignment to the submitter, the current approver, an inactive Hiring Manager or a Recruiter returns 400", async () => {
    // The submitter is an Admin, so only A2 stops them from approving.
    const admin = await signedIn("ADMIN");
    const hm = await insertUser(db(), "HIRING_MANAGER");
    const inactive = await insertUser(db(), "HIRING_MANAGER");
    await deactivated(inactive.id);
    const requisition = await submitted(admin, hm.id);
    const cases: [string, string][] = [
      [admin.userId, "The submitter can't approve their own submission."],
      [hm.id, "This user is already the approver."],
      [inactive.id, "Choose an active Hiring Manager or Admin as approver."],
      [(await insertUser(db(), "RECRUITER")).id, "Choose an active Hiring Manager or Admin as approver."],
      [(await insertUser(db(), "INTERVIEWER")).id, "Choose an active Hiring Manager or Admin as approver."],
    ];
    for (const [approverId, text] of cases) {
      const response = await post(reassign, requisition.id, { approverId, reason: "Out of office", version: requisition.version }, admin);
      expect(response.status).toBe(400);
      expect((await response.json()).fields).toEqual({ approverId: text });
    }
    expect(await row(requisition.id)).toMatchObject({ approverId: hm.id, version: requisition.version });
  });

  it("A4: a valid reassignment writes one REASSIGNED event, emails the new approver, and moves the decision to them", async () => {
    const recruiter = await signedIn("RECRUITER");
    const oldApprover = await signedIn("HIRING_MANAGER");
    const newApprover = await signedIn("HIRING_MANAGER");
    const requisition = await submitted(recruiter, oldApprover.userId);

    const response = await post(reassign, requisition.id, { approverId: newApprover.userId, reason: "  On parental leave  ", version: requisition.version }, recruiter);
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    const after = await row(requisition.id);
    expect(after).toMatchObject({
      state: "PENDING_APPROVAL",
      approverId: newApprover.userId,
      submittedByUserId: recruiter.userId,
      submittedAt: requisition.submittedAt,
      version: requisition.version + 1,
    });
    const reassigned = (await events(requisition.id)).filter((event) => event.event === "REASSIGNED");
    expect(reassigned).toHaveLength(1);
    expect(reassigned[0]).toMatchObject({
      subjectType: "REQUISITION",
      actorUserId: recruiter.userId,
      fromApproverId: oldApprover.userId,
      toApproverId: newApprover.userId,
      comment: "On parental leave",
    });

    await processDueJobs();
    const [newEmail] = await getDb().select({ email: users.email }).from(users).where(eq(users.id, newApprover.userId));
    const message = await waitForMessage({ to: newEmail.email, subjectIncludes: requisition.reqNumber });
    expect(message.subject).toBe(`Approval needed: ${requisition.reqNumber} Backend Engineer`);
    expect(message.text).toContain(`/requisitions/${requisition.id}`);

    // V3a, V9: the old approver's access came only from being approver.
    expect((await listMyRequisitionApprovals({ id: oldApprover.userId, role: "HIRING_MANAGER" })).map((item) => item.id)).not.toContain(requisition.id);
    expect((await listMyRequisitionApprovals({ id: newApprover.userId, role: "HIRING_MANAGER" })).map((item) => item.id)).toContain(requisition.id);
    expect((await post(approve, requisition.id, { version: after.version }, oldApprover)).status).toBe(404);
    expect((await post(approve, requisition.id, { version: after.version }, newApprover)).status).toBe(200);
    expect((await row(requisition.id)).state).toBe("APPROVED");
  });

  it("A4: an old approver who is an Admin still sees the requisition but gets 403 on approve; an Admin may take it over themselves", async () => {
    const recruiter = await signedIn("RECRUITER");
    const oldApprover = await signedIn("ADMIN");
    const admin = await signedIn("ADMIN");
    const requisition = await submitted(recruiter, oldApprover.userId);
    const response = await post(reassign, requisition.id, { approverId: admin.userId, reason: "I'll take it", version: requisition.version }, admin);
    expect(response.status).toBe(200);
    const after = await row(requisition.id);
    expect(after.approverId).toBe(admin.userId);
    expect((await post(approve, requisition.id, { version: after.version }, oldApprover)).status).toBe(403);
    expect((await post(approve, requisition.id, { version: after.version }, admin)).status).toBe(200);
  });

  it("A4: Hiring Managers and Interviewers get 403, no session 401; outside PENDING_APPROVAL 409; a stale version 409", async () => {
    const recruiter = await signedIn("RECRUITER");
    const hm = await insertUser(db(), "HIRING_MANAGER");
    const other = await insertUser(db(), "HIRING_MANAGER");
    const requisition = await submitted(recruiter, hm.id);
    const body = { approverId: other.id, reason: "Out of office", version: requisition.version };
    expect((await post(reassign, requisition.id, body, await signedIn("HIRING_MANAGER"))).status).toBe(403);
    expect((await post(reassign, requisition.id, body, await signedIn("INTERVIEWER"))).status).toBe(403);
    expect((await post(reassign, requisition.id, body)).status).toBe(401);
    const stale = await post(reassign, requisition.id, { ...body, version: requisition.version - 1 }, recruiter);
    expect(stale.status).toBe(409);

    const draft = await insertRequisition(db(), { createdByUserId: recruiter.userId });
    const notPending = await post(reassign, draft.id, { ...body, version: 1 }, recruiter);
    expect(notPending.status).toBe(409);
    expect((await notPending.json()).message).toBe("This requisition is not awaiting approval.");
  });
});

describe("deactivation guard", () => {
  const patch = (id: string, body: unknown, session: Session) => call(patchUser as Handler, "PATCH", `/api/admin/users/${id}`, id, body, session);
  const deactivateCall = (id: string, session: Session) => call(deactivate as Handler, "POST", `/api/admin/users/${id}/deactivate`, id, undefined, session);

  it("A5: an approver of a pending requisition can't be deactivated or become a Recruiter or Interviewer; Admin is fine; after reassignment deactivation works", async () => {
    const admin = await signedIn("ADMIN");
    const recruiter = await signedIn("RECRUITER");
    const hm = await insertUser(db(), "HIRING_MANAGER");
    const requisition = await submitted(recruiter, hm.id);

    const refused = await deactivateCall(hm.id, admin);
    expect(refused.status).toBe(409);
    expect((await refused.json()).message).toBe(`This user is the approver of 1 pending item. Reassign it first: ${requisition.reqNumber}`);
    for (const role of ["RECRUITER", "INTERVIEWER"]) {
      const response = await patch(hm.id, { role }, admin);
      expect(response.status).toBe(409);
      expect((await response.json()).error).toBe("pendingApprovals");
    }
    const [unchanged] = await getDb().select().from(users).where(eq(users.id, hm.id));
    expect(unchanged).toMatchObject({ role: "HIRING_MANAGER", isActive: true });

    expect((await patch(hm.id, { role: "ADMIN" }, admin)).status).toBe(200);
    const other = await insertUser(db(), "HIRING_MANAGER");
    expect((await post(reassign, requisition.id, { approverId: other.id, reason: "Leaving", version: requisition.version }, recruiter)).status).toBe(200);
    expect((await deactivateCall(hm.id, admin)).status).toBe(200);
  });

  it("A5: the message counts every pending item; a pending offer blocks too, and other references never block", async () => {
    const admin = await signedIn("ADMIN");
    const recruiter = await signedIn("RECRUITER");
    const hm = await insertUser(db(), "HIRING_MANAGER");
    const first = await submitted(recruiter, hm.id);
    const second = await submitted(recruiter, hm.id);
    const response = await deactivateCall(hm.id, admin);
    const numbers = [first.reqNumber, second.reqNumber].sort().join(", ");
    expect((await response.json()).message).toBe(`This user is the approver of 2 pending items. Reassign them first: ${numbers}`);

    // An offer awaiting this approver (offer approval itself comes in task 36).
    const offerApprover = await insertUser(db(), "HIRING_MANAGER");
    const values = await offerValues(db());
    await getDb().insert(offers).values({ ...values, submittedByUserId: recruiter.userId, submittedAt: new Date(), approverId: offerApprover.id, approvalStatus: "PENDING" });
    expect((await deactivateCall(offerApprover.id, admin)).status).toBe(409);

    // Hiring manager, recruiter and submitter of a pending requisition: no block.
    const requisitionHm = await insertUser(db(), "HIRING_MANAGER");
    const approver = await insertUser(db(), "HIRING_MANAGER");
    const pending = await submitted(recruiter, approver.id);
    await getDb().update(requisitions).set({ hiringManagerId: requisitionHm.id }).where(eq(requisitions.id, pending.id));
    expect((await deactivateCall(requisitionHm.id, admin)).status).toBe(200);
    expect((await deactivateCall(recruiter.userId, admin)).status).toBe(200);
  });

  it("A5: a concurrent deactivation and submission to the same approver never both succeed", async () => {
    const admin = await signedIn("ADMIN");
    const recruiter = await signedIn("RECRUITER");
    for (let attempt = 0; attempt < 5; attempt++) {
      const hm = await insertUser(db(), "HIRING_MANAGER");
      const draft = await insertRequisition(db(), { hiringManagerId: (await insertUser(db(), "HIRING_MANAGER")).id, createdByUserId: recruiter.userId, descriptionHtml: "<p>x</p>" });
      const [submission, deactivation] = await Promise.all([post(submit, draft.id, { approverId: hm.id, version: 1 }, recruiter), deactivateCall(hm.id, admin)]);
      expect([submission.status, deactivation.status]).not.toEqual([200, 200]);
      const [approver] = await getDb().select({ isActive: users.isActive }).from(users).where(eq(users.id, hm.id));
      const after = await row(draft.id);
      expect(after.state === "PENDING_APPROVAL" && after.approverId === hm.id && !approver.isActive).toBe(false);
    }
  });
});

describe("reminders", () => {
  // APPROVAL_REMINDER_DAYS = 3 (the default) and submissions on Monday
  // 2027-01-04 at 16:00 Warsaw time; the daily run is due from 08:00.
  const SUBMITTED_AT = new Date("2027-01-04T15:00:00Z");
  const SECRET = "test-only-tick-secret";

  async function tickAt(iso: string) {
    const base = getConfig();
    const request = new Request("http://localhost/api/internal/tick", { method: "POST", headers: { "x-tick-secret": SECRET, "x-test-now": iso } });
    const response = await handleTick(request, { config: { ...base, auth: { ...base.auth, devLogin: true }, workerEnabled: false } });
    expect(response.status).toBe(200);
    await processDueJobs({ now: new Date(iso) });
  }

  type Item = { id: string; reqNumber: string; approverEmail: string; submitterEmail: string };
  const items: Record<"plain" | "inactiveSubmitter" | "approved" | "reassigned" | "inactiveApprover", Item> = {} as never;
  let newApprover: { id: string; email: string };
  let recruiterId: string;

  /** A requisition submitted at SUBMITTED_AT, inserted directly so its events carry 2027 times. */
  async function pendingItem(state: "PENDING_APPROVAL" | "APPROVED" = "PENDING_APPROVAL"): Promise<Item> {
    const approver = await insertUser(db(), "HIRING_MANAGER");
    const submitter = await insertUser(db(), "RECRUITER");
    const requisition = await insertRequisition(db(), {
      state,
      submittedByUserId: submitter.id,
      submittedAt: SUBMITTED_AT,
      approverId: approver.id,
      ...(state === "APPROVED" ? { approvedAt: SUBMITTED_AT, isPublished: true } : {}),
    });
    await getDb()
      .insert(approvalEvents)
      .values({ subjectType: "REQUISITION", subjectId: requisition.id, event: "SUBMITTED", actorUserId: submitter.id, toApproverId: approver.id, createdAt: SUBMITTED_AT });
    return { id: requisition.id, reqNumber: requisition.reqNumber, approverEmail: approver.email, submitterEmail: submitter.email };
  }

  const reminded = async (item: Item) => (await events(item.id)).filter((event) => event.event === "REMINDED");
  const reminderMails = async (to: string) => (await searchMessages(to)).filter((message) => message.Subject.startsWith("Reminder: approval needed:"));

  beforeAll(async () => {
    items.plain = await pendingItem();
    items.inactiveSubmitter = await pendingItem();
    items.approved = await pendingItem("APPROVED");
    items.reassigned = await pendingItem();
    items.inactiveApprover = await pendingItem();
    await deactivated((await getDb().select({ id: users.id }).from(users).where(eq(users.email, items.inactiveSubmitter.submitterEmail)))[0].id);
    // Possible only for items created before the A5 guard: skipped with a warning.
    await getDb().update(users).set({ isActive: false }).where(eq(users.email, items.inactiveApprover.approverEmail));
    await getDb().insert(approvalEvents).values({ subjectType: "REQUISITION", subjectId: items.approved.id, event: "APPROVED", actorUserId: null, createdAt: SUBMITTED_AT });

    // Reassigned on Wednesday 2027-01-06, which restarts the count.
    const recruiter = await insertUser(db(), "RECRUITER");
    recruiterId = recruiter.id;
    const target = await insertUser(db(), "HIRING_MANAGER");
    newApprover = { id: target.id, email: target.email };
    const version = (await row(items.reassigned.id)).version;
    const result = await withTransaction((tx) => reassignRequisition(tx, { id: recruiter.id, role: "RECRUITER" }, items.reassigned.id, { approverId: target.id, reason: "Away", version }));
    expect(result.ok).toBe(true);
    await getDb().update(approvalEvents).set({ createdAt: new Date("2027-01-06T10:00:00Z") }).where(and(eq(approvalEvents.event, "REASSIGNED"), eq(approvalEvents.subjectId, items.reassigned.id)));
    items.reassigned.approverEmail = target.email;
    await processDueJobs();
  });

  it("A6: a tick on the second day after the submission sends nothing", async () => {
    await tickAt("2027-01-06T08:30:00+01:00");
    for (const item of Object.values(items)) expect(await reminded(item)).toEqual([]);
    expect(await reminderMails(items.plain.approverEmail)).toEqual([]);
  });

  it("A6: on the third day the approver is reminded with the submitter in Cc, recorded as REMINDED at the tick time", async () => {
    await tickAt("2027-01-07T08:30:00+01:00");
    const [event] = await reminded(items.plain);
    expect(event).toMatchObject({ actorUserId: null, fromApproverId: null, comment: null, createdAt: new Date("2027-01-07T07:30:00Z") });
    const [approver] = await getDb().select({ id: users.id }).from(users).where(eq(users.email, items.plain.approverEmail));
    expect(event.toApproverId).toBe(approver.id);

    const message = await waitForMessage({ to: items.plain.approverEmail, subjectIncludes: "Reminder" });
    expect(message.subject).toBe(`Reminder: approval needed: ${items.plain.reqNumber} Backend Engineer`);
    expect(message.cc).toEqual([items.plain.submitterEmail]);
    expect(message.text).toContain("Days waiting: 3");
    expect(message.text).toContain(`/requisitions/${items.plain.id}`);
  });

  it("A6: an inactive submitter is left out of the Cc; an approved requisition and an inactive approver get no reminder", async () => {
    expect(await reminded(items.inactiveSubmitter)).toHaveLength(1);
    const message = await waitForMessage({ to: items.inactiveSubmitter.approverEmail, subjectIncludes: "Reminder" });
    expect(message.cc).toEqual([]);
    expect(await reminded(items.approved)).toEqual([]);
    expect(await reminderMails(items.approved.approverEmail)).toEqual([]);
    expect(await reminded(items.inactiveApprover)).toEqual([]);
    expect(await reminded(items.reassigned)).toEqual([]);
  });

  it("A6: a second tick, or a second run, on the same day sends nothing more", async () => {
    await tickAt("2027-01-07T15:00:00+01:00");
    // The run itself is safe to repeat (J3), not only the tick (W5).
    await runApprovalReminders({ runDate: "2027-01-07", now: new Date("2027-01-07T15:00:00+01:00") });
    expect(await reminded(items.plain)).toHaveLength(1);
    await processDueJobs();
    expect(await reminderMails(items.plain.approverEmail)).toHaveLength(1);
  });

  it("A6: a reassignment restarts the count, and the next reminder comes three calendar days after the last one", async () => {
    await tickAt("2027-01-09T08:30:00+01:00");
    expect(await reminded(items.reassigned)).toHaveLength(1);
    expect((await reminded(items.reassigned))[0].toApproverId).toBe(newApprover.id);
    await waitForMessage({ to: newApprover.email, subjectIncludes: "Reminder" });
    expect(await reminded(items.plain)).toHaveLength(1);

    await tickAt("2027-01-10T09:15:00+01:00");
    expect(await reminded(items.plain)).toHaveLength(2);
    expect(await reminded(items.reassigned)).toHaveLength(1);
    expect(await reminderMails(items.plain.approverEmail)).toHaveLength(2);
  });

  it("A7: submit, reassign and remind events are in approval_events in order, with actor and approver columns", async () => {
    const [firstApprover] = await getDb()
      .select({ id: users.id })
      .from(users)
      .innerJoin(approvalEvents, eq(approvalEvents.toApproverId, users.id))
      .where(eq(approvalEvents.subjectId, items.reassigned.id))
      .orderBy(asc(approvalEvents.createdAt))
      .limit(1);
    const trail = (await events(items.reassigned.id)).map(({ subjectType, event, actorUserId, fromApproverId, toApproverId, comment }) => ({
      subjectType,
      event,
      actorUserId,
      fromApproverId,
      toApproverId,
      comment,
    }));
    expect(trail).toEqual([
      { subjectType: "REQUISITION", event: "SUBMITTED", actorUserId: expect.any(String), fromApproverId: null, toApproverId: firstApprover.id, comment: null },
      { subjectType: "REQUISITION", event: "REASSIGNED", actorUserId: recruiterId, fromApproverId: firstApprover.id, toApproverId: newApprover.id, comment: "Away" },
      { subjectType: "REQUISITION", event: "REMINDED", actorUserId: null, fromApproverId: null, toApproverId: newApprover.id, comment: null },
    ]);
  });
});
