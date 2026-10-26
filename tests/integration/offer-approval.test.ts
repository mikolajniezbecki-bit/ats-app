// Offer approval against the database (ats-project-scope.md A1–A9, L8, V3b,
// V9, E7, RT4; tech-stack.md D7, J1, J2, T2, T3, T5): through the API with
// real session cookies, emails read from Mailpit, reminders through the tick
// with `x-test-now`. Holds and re-approval go through their real APIs.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, asc, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { POST as deactivate } from "@/app/api/admin/users/[id]/deactivate/route";
import { GET as getApplication } from "@/app/api/applications/[id]/route";
import { POST as createOfferRoute } from "@/app/api/applications/[id]/offers/route";
import { GET as fileUrl } from "@/app/api/files/[id]/url/route";
import { POST as approve } from "@/app/api/offers/[id]/approve/route";
import { POST as reassign } from "@/app/api/offers/[id]/reassign/route";
import { POST as reject } from "@/app/api/offers/[id]/reject/route";
import { PATCH as patchOffer } from "@/app/api/offers/[id]/route";
import { POST as submit } from "@/app/api/offers/[id]/submit/route";
import { POST as withdraw } from "@/app/api/offers/[id]/withdraw/route";
import { POST as hold } from "@/app/api/requisitions/[id]/hold/route";
import { POST as resume } from "@/app/api/requisitions/[id]/resume/route";
import { GET as getRequisition, PATCH as patchRequisition } from "@/app/api/requisitions/[id]/route";
import { getBoss, jobQueue } from "@/server/adapters/job-queue";
import { listMyOfferApprovals } from "@/server/approvals/offers";
import { getConfig } from "@/server/config";
import { type Tx, getDb, withTransaction } from "@/server/db";
import { applicationHistory, approvalEvents, emailLog, offers, prescreenAnswers, prescreenQuestions, requisitions, templates, users } from "@/server/db/schema";
import { warsawRunDate } from "@/server/domain/daily-tasks";
import { handleTick } from "@/server/domain/tick";
import { storePdf } from "@/server/files/store-pdf";
import { waitForMessage } from "../support/mailpit";
import { processDueJobs } from "../support/process-due-jobs";
import { insertApplication, insertRequisition, insertUser } from "./fixtures";
import { ORIGIN, signedIn } from "./sessions";

type Session = Awaited<ReturnType<typeof signedIn>>;
type Handler = (request: Request, context: never) => Promise<Response>;
const db = () => getDb() as unknown as Tx;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;
const call = (handler: Handler, method: string, id: string, body: unknown, session?: Session) =>
  handler(
    new Request(`${ORIGIN}/api/x/${id}`, {
      method,
      headers: { ...(session ? { cookie: session.cookie } : {}), "content-type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify(body),
    }),
    ctx(id),
  );
const get = (handler: Handler, id: string, session: Session) => call(handler, "GET", id, undefined, session);
const VALID_PDF = new Uint8Array(readFileSync("tests/fixtures/pdf/valid.pdf"));
const tomorrow = () => warsawRunDate(new Date(Date.now() + 36 * 3_600_000));

const requisitionIds: string[] = [];
afterAll(async () => {
  if (requisitionIds.length === 0) return;
  await withTransaction(async (tx) => {
    const queued = await tx
      .update(emailLog)
      .set({ status: "CANCELLED" })
      .where(and(inArray(emailLog.requisitionId, requisitionIds), eq(emailLog.status, "QUEUED")))
      .returning({ jobId: emailLog.jobId });
    for (const { jobId } of queued) if (jobId) await jobQueue.cancel(tx, "email.send", jobId);
  });
});

/** An application in OFFER with a DRAFT offer created through the API. */
async function drafted(recruiter: Session) {
  const hm = await insertUser(db(), "HIRING_MANAGER");
  const requisition = await insertRequisition(db(), { state: "APPROVED", approvedAt: new Date(), isPublished: true, hiringManagerId: hm.id, openingsCount: 2, descriptionHtml: "<p>x</p>" });
  requisitionIds.push(requisition.id);
  const application = await insertApplication(db(), { requisitionId: requisition.id, status: "OFFER", email: `cand-${randomUUID()}@example.com` });
  const [template] = await getDb().insert(templates).values({ type: "OFFER", name: `Offer ${randomUUID()}`, body: "Letter" }).returning();
  const response = await call(createOfferRoute as Handler, "POST", application.id, { jobTitle: "Backend Engineer", salary: "85000", currency: "EUR", startDate: tomorrow(), templateId: template.id }, recruiter);
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(201);
  const offer = (await response.json()).offer as typeof offers.$inferSelect;
  return { requisition, application, template, offer };
}

async function offerRow(id: string) {
  const [row] = await getDb().select().from(offers).where(eq(offers.id, id));
  return row;
}
const events = (id: string) => getDb().select().from(approvalEvents).where(and(eq(approvalEvents.subjectType, "OFFER"), eq(approvalEvents.subjectId, id))).orderBy(asc(approvalEvents.createdAt));
const renderJobs = async (offerId: string) => (await (await getBoss()).findJobs("offer.render-pdf", { data: { offerId } })).filter((job) => job.state === "created");
async function requisitionVersion(id: string) {
  const [row] = await getDb().select({ version: requisitions.version }).from(requisitions).where(eq(requisitions.id, id));
  return row.version;
}
const emailOf = async (userId: string) => (await getDb().select({ email: users.email }).from(users).where(eq(users.id, userId)))[0].email;

async function submitted(recruiter: Session, approverId: string) {
  const setup = await drafted(recruiter);
  const response = await call(submit as Handler, "POST", setup.offer.id, { approverId, version: setup.offer.version }, recruiter);
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
  return { ...setup, offer: await offerRow(setup.offer.id) };
}

describe("submit (A1, A2, L8)", () => {
  it("A1: submitting to an active Hiring Manager sets PENDING, writes SUBMITTED and emails the approver, linked to the application", async () => {
    const recruiter = await signedIn("RECRUITER");
    const hm = await signedIn("HIRING_MANAGER");
    const { offer, application, requisition } = await submitted(recruiter, hm.userId);
    expect(offer).toMatchObject({ approvalStatus: "PENDING", approverId: hm.userId, submittedByUserId: recruiter.userId, version: 2 });
    expect(offer.submittedAt).toBeInstanceOf(Date);
    expect((await events(offer.id)).map((event) => [event.event, event.toApproverId])).toEqual([["SUBMITTED", hm.userId]]);
    const [logged] = await getDb().select().from(emailLog).where(and(eq(emailLog.applicationId, application.id), eq(emailLog.recipient, await emailOf(hm.userId))));
    expect(logged).toMatchObject({ applicationId: application.id, requisitionId: requisition.id, audience: "STAFF" });
    // Q6: no salary in the email.
    for (const salary of ["85000", "85,000", "85 000"]) expect(logged.bodyRendered).not.toContain(salary);
    await processDueJobs();
    const message = await waitForMessage({ to: await emailOf(hm.userId), subjectIncludes: requisition.reqNumber });
    expect(message.subject).toBe(`Offer approval needed: ${requisition.reqNumber} ${application.firstName} ${application.lastName}`);
    expect(message.text).toContain(`/applications/${application.id}`);
  });

  it("A1, A2: a Recruiter, an inactive Hiring Manager or the caller as approver returns 400", async () => {
    const admin = await signedIn("ADMIN");
    const inactive = await insertUser(db(), "HIRING_MANAGER");
    await getDb().update(users).set({ isActive: false }).where(eq(users.id, inactive.id));
    const { offer } = await drafted(admin);
    const cases: [string, string][] = [
      [(await insertUser(db(), "RECRUITER")).id, "Choose an active Hiring Manager or Admin as approver."],
      [inactive.id, "Choose an active Hiring Manager or Admin as approver."],
      [admin.userId, "You can't approve your own submission."],
    ];
    for (const [approverId, text] of cases) {
      const response = await call(submit as Handler, "POST", offer.id, { approverId, version: 1 }, admin);
      expect(response.status).toBe(400);
      expect((await response.json()).fields).toEqual({ approverId: text });
    }
    expect((await offerRow(offer.id)).approvalStatus).toBe("DRAFT");
    for (const role of ["HIRING_MANAGER", "INTERVIEWER"] as const) {
      expect((await call(submit as Handler, "POST", offer.id, { approverId: inactive.id, version: 1 }, await signedIn(role))).status, role).toBe(403);
    }
  });

  it("L8: submitting while the requisition is ON_HOLD and while it is in re-approval returns 409", async () => {
    const recruiter = await signedIn("RECRUITER");
    const hm = await signedIn("HIRING_MANAGER");
    const held = await drafted(recruiter);
    expect((await call(hold as Handler, "POST", held.requisition.id, { version: await requisitionVersion(held.requisition.id) }, recruiter)).status).toBe(200);
    const onHold = await call(submit as Handler, "POST", held.offer.id, { approverId: hm.userId, version: 1 }, recruiter);
    expect(onHold.status).toBe(409);
    expect((await onHold.json()).message).toBe("Offers can't be submitted while the requisition is on hold or awaiting approval.");

    const reapproval = await drafted(recruiter);
    const edit = await call(patchRequisition as Handler, "PATCH", reapproval.requisition.id, { version: await requisitionVersion(reapproval.requisition.id), openingsCount: 5, approverId: hm.userId }, recruiter);
    expect(edit.status).toBe(200);
    expect((await call(submit as Handler, "POST", reapproval.offer.id, { approverId: hm.userId, version: 1 }, recruiter)).status).toBe(409);
  });
});

describe("decide (A3, L8)", () => {
  it("A3: approve sets APPROVED and queues one offer.render-pdf job; reject needs a comment; the submitting Admin can't approve", async () => {
    const recruiter = await signedIn("RECRUITER");
    const hm = await signedIn("HIRING_MANAGER");
    const { offer } = await submitted(recruiter, hm.userId);
    expect((await call(approve as Handler, "POST", offer.id, { version: offer.version }, recruiter)).status).toBe(403);
    expect((await call(approve as Handler, "POST", offer.id, { version: offer.version }, hm)).status).toBe(200);
    expect(await offerRow(offer.id)).toMatchObject({ approvalStatus: "APPROVED", version: offer.version + 1 });
    expect(await renderJobs(offer.id)).toHaveLength(1);

    const second = await submitted(recruiter, hm.userId);
    const empty = await call(reject as Handler, "POST", second.offer.id, { version: second.offer.version, comment: "  " }, hm);
    expect(empty.status).toBe(400);
    expect((await empty.json()).fields).toEqual({ comment: "Add a comment to reject." });
    expect((await call(reject as Handler, "POST", second.offer.id, { version: second.offer.version, comment: "Salary above band." }, hm)).status).toBe(200);
    expect((await offerRow(second.offer.id)).approvalStatus).toBe("REJECTED");
    expect((await events(second.offer.id)).at(-1)).toMatchObject({ event: "REJECTED", comment: "Salary above band.", actorUserId: hm.userId });
    expect(await renderJobs(second.offer.id)).toEqual([]);

    // A2: an Admin who submitted can't approve their own submission, even when chosen as approver later.
    const admin = await signedIn("ADMIN");
    const own = await drafted(admin);
    const submittedOwn = await call(submit as Handler, "POST", own.offer.id, { approverId: hm.userId, version: 1 }, admin);
    expect(submittedOwn.status).toBe(200);
    await getDb().update(offers).set({ approverId: admin.userId }).where(eq(offers.id, own.offer.id));
    expect((await call(approve as Handler, "POST", own.offer.id, { version: 2 }, admin)).status).toBe(403);
  });

  it("A3: a REJECTED latest offer is edited and resubmitted to PENDING; once a newer offer exists, resubmitting it is 409", async () => {
    const recruiter = await signedIn("RECRUITER");
    const hm = await signedIn("HIRING_MANAGER");
    const { offer, application, template } = await submitted(recruiter, hm.userId);
    expect((await call(reject as Handler, "POST", offer.id, { version: 2, comment: "Lower it." }, hm)).status).toBe(200);
    expect((await call(patchOffer as Handler, "PATCH", offer.id, { version: 3, salary: "80000" }, recruiter)).status).toBe(200);
    expect((await call(submit as Handler, "POST", offer.id, { approverId: hm.userId, version: 4 }, recruiter)).status).toBe(200);
    expect(await offerRow(offer.id)).toMatchObject({ approvalStatus: "PENDING", salary: "80000.00" });

    expect((await call(reject as Handler, "POST", offer.id, { version: 5, comment: "Still no." }, hm)).status).toBe(200);
    expect((await call(createOfferRoute as Handler, "POST", application.id, { jobTitle: "Engineer", salary: "70000", currency: "EUR", startDate: tomorrow(), templateId: template.id }, recruiter)).status).toBe(201);
    const frozen = await call(submit as Handler, "POST", offer.id, { approverId: hm.userId, version: 6 }, recruiter);
    expect(frozen.status).toBe(409);
    expect((await frozen.json()).message).toBe("This offer is read-only because a newer offer exists.");
  });

  it("L8: approving while the requisition is ON_HOLD returns 409; after resume it succeeds; rejecting works during the hold", async () => {
    const recruiter = await signedIn("RECRUITER");
    const hm = await signedIn("HIRING_MANAGER");
    const { offer, requisition } = await submitted(recruiter, hm.userId);
    expect((await call(hold as Handler, "POST", requisition.id, { version: await requisitionVersion(requisition.id) }, recruiter)).status).toBe(200);
    expect((await call(approve as Handler, "POST", offer.id, { version: offer.version }, hm)).status).toBe(409);
    expect((await call(resume as Handler, "POST", requisition.id, { version: await requisitionVersion(requisition.id) }, recruiter)).status).toBe(200);
    expect((await call(approve as Handler, "POST", offer.id, { version: offer.version }, hm)).status).toBe(200);

    const other = await submitted(recruiter, hm.userId);
    expect((await call(hold as Handler, "POST", other.requisition.id, { version: await requisitionVersion(other.requisition.id) }, recruiter)).status).toBe(200);
    expect((await call(reject as Handler, "POST", other.offer.id, { version: other.offer.version, comment: "No." }, hm)).status).toBe(200);
  });

  it("approve and withdraw sent together at the same version: one succeeds, the other gets 409, one outcome event", async () => {
    const recruiter = await signedIn("RECRUITER");
    const hm = await signedIn("HIRING_MANAGER");
    const { offer } = await submitted(recruiter, hm.userId);
    const [a, b] = await Promise.all([
      call(approve as Handler, "POST", offer.id, { version: offer.version }, hm),
      call(withdraw as Handler, "POST", offer.id, { version: offer.version }, recruiter),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await events(offer.id)).filter((event) => event.event !== "SUBMITTED")).toHaveLength(1);
  });
});

describe("withdraw (A9)", () => {
  it("A9: withdrawing returns the offer to DRAFT with one WITHDRAWN event; it is editable again; the approver gets 403", async () => {
    const recruiter = await signedIn("RECRUITER");
    const hm = await signedIn("HIRING_MANAGER");
    const { offer } = await submitted(recruiter, hm.userId);
    expect((await call(withdraw as Handler, "POST", offer.id, { version: offer.version }, hm)).status).toBe(403);
    expect((await call(withdraw as Handler, "POST", offer.id, { version: offer.version, comment: "Wrong start date" }, recruiter)).status).toBe(200);
    const after = await offerRow(offer.id);
    expect(after).toMatchObject({ approvalStatus: "DRAFT", approverId: hm.userId, submittedByUserId: recruiter.userId });
    expect((await events(offer.id)).filter((event) => event.event === "WITHDRAWN")).toEqual([expect.objectContaining({ fromApproverId: hm.userId, comment: "Wrong start date" })]);
    expect((await call(patchOffer as Handler, "PATCH", offer.id, { version: after.version, salary: "86000" }, recruiter)).status).toBe(200);
  });
});

describe("re-approval of changed terms (A8)", () => {
  async function approvedOffer(recruiter: Session, hm: Session) {
    const setup = await submitted(recruiter, hm.userId);
    expect((await call(approve as Handler, "POST", setup.offer.id, { version: setup.offer.version }, hm)).status).toBe(200);
    await getDb().update(offers).set({ sentAt: new Date() }).where(eq(offers.id, setup.offer.id));
    return { ...setup, offer: await offerRow(setup.offer.id) };
  }

  it("A8: changing the salary of a sent APPROVED offer gives PENDING, sent_at NULL, SUBMITTED and an email to the new approver; the render job is cancelled", async () => {
    const recruiter = await signedIn("RECRUITER");
    const hm = await signedIn("HIRING_MANAGER");
    const newApprover = await signedIn("HIRING_MANAGER");
    const { offer, requisition } = await approvedOffer(recruiter, hm);
    expect(await renderJobs(offer.id)).toHaveLength(1);
    const unchanged = await call(patchOffer as Handler, "PATCH", offer.id, { version: offer.version, salary: "85000.00" }, recruiter);
    expect(unchanged.status).toBe(200);
    expect((await offerRow(offer.id)).approvalStatus).toBe("APPROVED");
    const missing = await call(patchOffer as Handler, "PATCH", offer.id, { version: offer.version, salary: "90000" }, recruiter);
    expect(missing.status).toBe(400);
    expect((await missing.json()).fields).toEqual({ approverId: "Changing an approved offer needs re-approval. Choose an approver." });

    const response = await call(patchOffer as Handler, "PATCH", offer.id, { version: offer.version, salary: "90000", approverId: newApprover.userId }, recruiter);
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    expect(await offerRow(offer.id)).toMatchObject({ approvalStatus: "PENDING", sentAt: null, candidateResponse: "PENDING", salary: "90000.00", approverId: newApprover.userId });
    expect((await events(offer.id)).map((event) => event.event)).toEqual(["SUBMITTED", "APPROVED", "SUBMITTED"]);
    expect(await renderJobs(offer.id)).toEqual([]);
    await processDueJobs();
    await waitForMessage({ to: await emailOf(newApprover.userId), subjectIncludes: requisition.reqNumber });
  });

  it("A8: the same change during a hold returns 409; an ACCEPTED offer returns 409 on any edit", async () => {
    const recruiter = await signedIn("RECRUITER");
    const hm = await signedIn("HIRING_MANAGER");
    const held = await approvedOffer(recruiter, hm);
    expect((await call(hold as Handler, "POST", held.requisition.id, { version: await requisitionVersion(held.requisition.id) }, recruiter)).status).toBe(200);
    const blocked = await call(patchOffer as Handler, "PATCH", held.offer.id, { version: held.offer.version, salary: "90000", approverId: hm.userId }, recruiter);
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).message).toBe("Offers can't be submitted while the requisition is on hold or awaiting approval.");

    const accepted = await approvedOffer(recruiter, hm);
    await getDb().update(offers).set({ candidateResponse: "ACCEPTED" }).where(eq(offers.id, accepted.offer.id));
    const locked = await call(patchOffer as Handler, "PATCH", accepted.offer.id, { version: accepted.offer.version, jobTitle: "Lead", approverId: hm.userId }, recruiter);
    expect(locked.status).toBe(409);
    expect((await locked.json()).message).toBe("Accepted and declined offers can't be changed.");
  });
});

describe("reassign, guard, reminders (A4, A5, A6, A7)", () => {
  it("A4: reassigning moves the offer to the new approver's My approvals; the old approver gets 404 on the application and on approve; the new one approves", async () => {
    const recruiter = await signedIn("RECRUITER");
    const oldApprover = await signedIn("HIRING_MANAGER");
    const newApprover = await signedIn("HIRING_MANAGER");
    const { offer, application } = await submitted(recruiter, oldApprover.userId);
    const noReason = await call(reassign as Handler, "POST", offer.id, { approverId: newApprover.userId, reason: " ", version: offer.version }, recruiter);
    expect((await noReason.json()).fields).toEqual({ reason: "Add a reason for the reassignment." });
    const toSubmitter = await call(reassign as Handler, "POST", offer.id, { approverId: recruiter.userId, reason: "x", version: offer.version }, recruiter);
    expect((await toSubmitter.json()).fields).toEqual({ approverId: "The submitter can't approve their own submission." });

    expect((await call(reassign as Handler, "POST", offer.id, { approverId: newApprover.userId, reason: "Leave", version: offer.version }, recruiter)).status).toBe(200);
    expect((await listMyOfferApprovals({ id: newApprover.userId, role: "HIRING_MANAGER" })).map((row) => row.id)).toContain(offer.id);
    expect((await listMyOfferApprovals({ id: oldApprover.userId, role: "HIRING_MANAGER" })).map((row) => row.id)).not.toContain(offer.id);
    expect((await get(getApplication as Handler, application.id, oldApprover)).status).toBe(404);
    expect((await call(approve as Handler, "POST", offer.id, { version: offer.version + 1 }, oldApprover)).status).toBe(404);
    expect((await call(approve as Handler, "POST", offer.id, { version: offer.version + 1 }, newApprover)).status).toBe(200);
    expect((await events(offer.id)).find((event) => event.event === "REASSIGNED")).toMatchObject({ fromApproverId: oldApprover.userId, toApproverId: newApprover.userId, comment: "Leave" });
  });

  it("A5: a Hiring Manager who approves a real pending offer can't be deactivated; the message names the offer by requisition and candidate", async () => {
    const recruiter = await signedIn("RECRUITER");
    const admin = await signedIn("ADMIN");
    const hm = await insertUser(db(), "HIRING_MANAGER");
    const { requisition, application } = await submitted(recruiter, hm.id);
    const response = await call(deactivate as Handler, "POST", hm.id, undefined, admin);
    expect(response.status).toBe(409);
    expect((await response.json()).message).toBe(`This user is the approver of 1 pending item. Reassign it first: ${requisition.reqNumber} (${application.firstName} ${application.lastName})`);
  });

  it("A6: a pending offer is reminded after APPROVAL_REMINDER_DAYS with the submitter in Cc; one on a held requisition gets no reminder and no event", async () => {
    const SUBMITTED_AT = new Date("2028-03-06T09:00:00Z");
    const recruiter = await signedIn("RECRUITER");
    const hm = await signedIn("HIRING_MANAGER");
    const due = await submitted(recruiter, hm.userId);
    const heldOffer = await submitted(recruiter, hm.userId);
    for (const { offer } of [due, heldOffer]) {
      await getDb().update(offers).set({ submittedAt: SUBMITTED_AT }).where(eq(offers.id, offer.id));
      await getDb().update(approvalEvents).set({ createdAt: SUBMITTED_AT }).where(eq(approvalEvents.subjectId, offer.id));
    }
    expect((await call(hold as Handler, "POST", heldOffer.requisition.id, { version: await requisitionVersion(heldOffer.requisition.id) }, recruiter)).status).toBe(200);
    await processDueJobs();

    const base = getConfig();
    const tickAt = async (iso: string) => {
      const request = new Request("http://localhost/api/internal/tick", { method: "POST", headers: { "x-tick-secret": "test-only-tick-secret", "x-test-now": iso } });
      expect((await handleTick(request, { config: { ...base, auth: { ...base.auth, devLogin: true }, workerEnabled: false } })).status).toBe(200);
      await processDueJobs({ now: new Date(iso) });
    };
    await tickAt("2028-03-08T08:30:00+01:00");
    expect((await events(due.offer.id)).map((event) => event.event)).toEqual(["SUBMITTED"]);
    await tickAt("2028-03-09T08:30:00+01:00");
    expect((await events(due.offer.id)).map((event) => event.event)).toEqual(["SUBMITTED", "REMINDED"]);
    expect((await events(heldOffer.offer.id)).map((event) => event.event)).toEqual(["SUBMITTED"]);
    const [reminder] = await getDb().select().from(emailLog).where(and(eq(emailLog.applicationId, due.application.id), eq(emailLog.subject, `Reminder: offer approval needed: ${due.requisition.reqNumber} ${due.application.firstName} ${due.application.lastName}`)));
    expect(reminder).toMatchObject({ recipient: await emailOf(hm.userId), cc: await emailOf(recruiter.userId) });
  });

  it("A7: submit, reject, resubmit, reassign and approve give five OFFER approval events in order", async () => {
    const recruiter = await signedIn("RECRUITER");
    const hm = await signedIn("HIRING_MANAGER");
    const other = await signedIn("HIRING_MANAGER");
    const { offer } = await submitted(recruiter, hm.userId);
    expect((await call(reject as Handler, "POST", offer.id, { version: 2, comment: "No" }, hm)).status).toBe(200);
    expect((await call(submit as Handler, "POST", offer.id, { approverId: hm.userId, version: 3 }, recruiter)).status).toBe(200);
    expect((await call(reassign as Handler, "POST", offer.id, { approverId: other.userId, reason: "Away", version: 4 }, recruiter)).status).toBe(200);
    expect((await call(approve as Handler, "POST", offer.id, { version: 5 }, other)).status).toBe(200);
    const trail = await events(offer.id);
    expect(trail.map((event) => event.event)).toEqual(["SUBMITTED", "REJECTED", "SUBMITTED", "REASSIGNED", "APPROVED"]);
    expect(trail.every((event) => event.subjectType === "OFFER")).toBe(true);
  });
});

describe("approver access (V3b)", () => {
  it("V3: an offer approver without V3a sees that application in full and its CV, not other applications or the requisition; after reassignment nothing", async () => {
    const recruiter = await signedIn("RECRUITER");
    const approver = await signedIn("HIRING_MANAGER");
    const replacement = await insertUser(db(), "HIRING_MANAGER");
    const { offer, application, requisition } = await submitted(recruiter, approver.userId);
    const sibling = await insertApplication(db(), { requisitionId: requisition.id });
    const [question] = await getDb().insert(prescreenQuestions).values({ requisitionId: requisition.id, questionText: "Notice period?", questionType: "TEXT", sortOrder: 0 }).returning();
    await getDb().insert(prescreenAnswers).values({ applicationId: application.id, questionId: question.id, answerJson: "One month", points: 0 });
    await getDb().insert(applicationHistory).values({ applicationId: application.id, fromStatus: "INTERVIEW", toStatus: "OFFER", comment: "Great final round." });
    const cv = await withTransaction((tx) => storePdf(tx, { ownerType: "APPLICATION", ownerId: application.id, kind: "CV", originalName: "cv.pdf", bytes: VALID_PDF }));

    const response = await get(getApplication as Handler, application.id, approver);
    expect(response.status).toBe(200);
    const view = await response.json();
    expect(view.answers.map((answer: { answer: string[] }) => answer.answer)).toEqual([["One month"]]);
    expect(view.timeline.some((entry: { comment?: string }) => entry.comment === "Great final round.")).toBe(true);
    expect(view.offers.map((row: { id: string; salary: string }) => [row.id, row.salary])).toEqual([[offer.id, "85000.00"]]);
    expect(view.requisition).toMatchObject({ reqNumber: requisition.reqNumber, openingsCount: 2 });
    expect((await get(fileUrl as Handler, cv.id, approver)).status).toBe(200);
    expect((await get(getApplication as Handler, sibling.id, approver)).status).toBe(404);
    expect((await get(getRequisition as Handler, requisition.id, approver)).status).toBe(404);

    expect((await call(reassign as Handler, "POST", offer.id, { approverId: replacement.id, reason: "Away", version: offer.version }, recruiter)).status).toBe(200);
    expect((await get(getApplication as Handler, application.id, approver)).status).toBe(404);
    expect((await get(fileUrl as Handler, cv.id, approver)).status).toBe(404);
  });

  it("V3b: the approver keeps access after deciding (approver_id is kept)", async () => {
    const recruiter = await signedIn("RECRUITER");
    const approver = await signedIn("HIRING_MANAGER");
    const { offer, application } = await submitted(recruiter, approver.userId);
    expect((await call(reject as Handler, "POST", offer.id, { version: offer.version, comment: "No" }, approver)).status).toBe(200);
    expect((await get(getApplication as Handler, application.id, approver)).status).toBe(200);
  });
});
