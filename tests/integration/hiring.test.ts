// Candidate response and hiring against the database (ats-project-scope.md
// §5.6 Response, R2, R4, R5, R6, L8, A8; tech-stack.md D3, D7, T5): through
// the API with real session cookies. Sent offers are inserted directly (the
// letter flow is task 37's); responses, hires, corrections, bulk moves and
// the reopen go through their real APIs.
import { randomUUID } from "node:crypto";
import { and, asc, count, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { POST as createOfferRoute } from "@/app/api/applications/[id]/offers/route";
import { POST as changeStatus } from "@/app/api/applications/[id]/status/route";
import { POST as bulkStatus } from "@/app/api/applications/bulk/status/route";
import { POST as respond } from "@/app/api/offers/[id]/response/route";
import { PATCH as patchOffer } from "@/app/api/offers/[id]/route";
import { POST as reopen } from "@/app/api/requisitions/[id]/reopen/route";
import { jobQueue } from "@/server/adapters/job-queue";
import { type Tx, getDb, withTransaction } from "@/server/db";
import { applicationHistory, applications, emailLog, interviews, offers, requisitionHistory, requisitions, templates } from "@/server/db/schema";
import { warsawRunDate } from "@/server/domain/daily-tasks";
import { queueEmail } from "@/server/email";
import { changeApplicationStatus } from "@/server/pipeline";
import { insertApplication, insertRequisition, insertUser } from "./fixtures";
import { ORIGIN, signedIn } from "./sessions";

type Session = Awaited<ReturnType<typeof signedIn>>;
type Handler = (request: Request, context: never) => Promise<Response>;
const db = () => getDb() as unknown as Tx;
const DAY = 86_400_000;
const call = (handler: Handler, id: string, body: unknown, session?: Session, method = "POST") =>
  handler(
    new Request(`${ORIGIN}/api/x/${id}`, {
      method,
      headers: { ...(session ? { cookie: session.cookie } : {}), "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) } as never,
  );

const NO_OFFER = "Hiring needs an accepted offer.";
const NO_OPENINGS = "No openings left on this requisition.";
const BLOCKED = "Hiring isn't possible while the requisition is on hold or awaiting approval.";

// Emails this file queued (stage and test emails) are cancelled, so another
// file's processDueJobs with a fake transport never picks them up; templates
// it created lose their trigger status again.
const requisitionIds: string[] = [];
const createdTemplateIds: string[] = [];
afterAll(async () => {
  if (requisitionIds.length > 0) {
    await withTransaction(async (tx) => {
      const queued = await tx
        .update(emailLog)
        .set({ status: "CANCELLED" })
        .where(and(inArray(emailLog.requisitionId, requisitionIds), eq(emailLog.status, "QUEUED")))
        .returning({ jobId: emailLog.jobId });
      for (const { jobId } of queued) if (jobId) await jobQueue.cancel(tx, "email.send", jobId);
    });
  }
  if (createdTemplateIds.length > 0) await getDb().update(templates).set({ isActive: false, triggerStatus: null }).where(inArray(templates.id, createdTemplateIds));
});

/** The active REJECTED stage template, created when the worker database has none. */
async function rejectionTemplate() {
  const [existing] = await getDb()
    .select()
    .from(templates)
    .where(and(eq(templates.type, "EMAIL"), eq(templates.isActive, true), eq(templates.triggerStatus, "REJECTED")));
  if (existing) return existing;
  const [created] = await getDb()
    .insert(templates)
    .values({ type: "EMAIL", name: `Stage REJECTED ${randomUUID()}`, triggerStatus: "REJECTED", subject: "About [[JOB_TITLE]]", body: "Dear [[CANDIDATE_FULL_NAME]]," })
    .returning();
  createdTemplateIds.push(created.id);
  return created;
}

async function approvedRequisition(overrides: Partial<typeof requisitions.$inferInsert> = {}) {
  const hm = await insertUser(db(), "HIRING_MANAGER");
  const row = await insertRequisition(db(), {
    state: "APPROVED",
    approvedAt: new Date(Date.now() - 30 * DAY),
    isPublished: true,
    hiringManagerId: hm.id,
    descriptionHtml: "<p>Build things.</p>",
    ...overrides,
  });
  requisitionIds.push(row.id);
  return row;
}

let offerTemplateId: string | undefined;
async function offerTemplate() {
  if (offerTemplateId) return offerTemplateId;
  const [row] = await getDb().insert(templates).values({ type: "OFFER", name: `Offer ${randomUUID()}`, body: "Dear [[CANDIDATE_FULL_NAME]]" }).returning();
  offerTemplateId = row.id;
  return row.id;
}

/** An offer inserted directly: approved and sent by default (task 37's letter flow), with `overrides`. */
async function insertOffer(applicationId: string, overrides: Partial<typeof offers.$inferInsert> = {}) {
  const approver = await insertUser(db(), "HIRING_MANAGER");
  const creator = await insertUser(db(), "RECRUITER");
  const [row] = await getDb()
    .insert(offers)
    .values({
      applicationId,
      templateId: await offerTemplate(),
      createdByUserId: creator.id,
      approverId: approver.id,
      jobTitle: "Backend Engineer",
      salary: "85000.00",
      currency: "EUR",
      startDate: warsawRunDate(new Date(Date.now() + 30 * DAY)),
      approvalStatus: "APPROVED",
      sentAt: new Date(),
      ...overrides,
    })
    .returning();
  return row;
}

/** An application in OFFER on `requisitionId` with an accepted offer. */
async function acceptedCandidate(requisitionId: string) {
  const application = await insertApplication(db(), { requisitionId, status: "OFFER" });
  await insertOffer(application.id, { candidateResponse: "ACCEPTED", respondedAt: new Date() });
  return application;
}

async function app(id: string) {
  const [row] = await getDb().select().from(applications).where(eq(applications.id, id));
  return row;
}
async function req(id: string) {
  const [row] = await getDb().select().from(requisitions).where(eq(requisitions.id, id));
  return row;
}
async function offerRow(id: string) {
  const [row] = await getDb().select().from(offers).where(eq(offers.id, id));
  return row;
}

async function hire(session: Session, applicationId: string) {
  return call(changeStatus as Handler, applicationId, { toStatus: "HIRED", version: (await app(applicationId)).version }, session);
}
async function correct(session: Session, applicationId: string, toStatus: string, comment?: string) {
  return call(changeStatus as Handler, applicationId, { toStatus, version: (await app(applicationId)).version, ...(comment ? { comment } : {}) }, session);
}
async function expectStatus(response: Response, status: number, message?: string) {
  const body = await response.clone().json();
  expect(response.status, JSON.stringify(body)).toBe(status);
  if (message) expect(body.message).toBe(message);
}

describe("candidate response", () => {
  it("recording on an offer whose letter wasn't sent returns 409; Hiring Manager and Interviewer get 403", async () => {
    const recruiter = await signedIn("RECRUITER");
    const job = await approvedRequisition();
    const application = await insertApplication(db(), { requisitionId: job.id, status: "OFFER" });
    const unsent = await insertOffer(application.id, { sentAt: null });

    await expectStatus(await call(respond as Handler, unsent.id, { response: "ACCEPTED", version: 1 }, recruiter), 409, "The offer hasn't been sent yet.");
    for (const role of ["HIRING_MANAGER", "INTERVIEWER"] as const) {
      expect((await call(respond as Handler, unsent.id, { response: "ACCEPTED", version: 1 }, await signedIn(role))).status, role).toBe(403);
    }
    expect((await call(respond as Handler, unsent.id, { response: "ACCEPTED", version: 1 })).status).toBe(401);
    await expectStatus(await call(respond as Handler, unsent.id, { response: "MAYBE", version: 1 }, recruiter), 400);
    expect(await offerRow(unsent.id)).toMatchObject({ candidateResponse: "PENDING", respondedAt: null, version: 1 });
  });

  it("DECLINED leaves the application in OFFER; a new offer can then be created and the declined one is read-only", async () => {
    const recruiter = await signedIn("RECRUITER");
    const job = await approvedRequisition();
    const application = await insertApplication(db(), { requisitionId: job.id, status: "OFFER" });
    const sent = await insertOffer(application.id);

    const response = await call(respond as Handler, sent.id, { response: "DECLINED", version: 1 }, recruiter);
    await expectStatus(response, 200);
    const declined = await offerRow(sent.id);
    expect(declined).toMatchObject({ candidateResponse: "DECLINED", approvalStatus: "APPROVED", version: 2 });
    expect(declined.respondedAt).toBeInstanceOf(Date);
    expect(await app(application.id)).toMatchObject({ status: "OFFER", version: 1 });

    await expectStatus(
      await call(respond as Handler, sent.id, { response: "ACCEPTED", version: 2 }, recruiter),
      409,
      "A response has already been recorded.",
    );
    const next = await call(
      createOfferRoute as Handler,
      application.id,
      { jobTitle: "Backend Engineer", salary: "90000", currency: "EUR", startDate: warsawRunDate(new Date(Date.now() + 30 * DAY)), templateId: await offerTemplate() },
      recruiter,
    );
    await expectStatus(next, 201);
    await expectStatus(await call(patchOffer as Handler, sent.id, { version: 2, salary: "95000" }, recruiter, "PATCH"), 409);
    expect(await offerRow(sent.id)).toMatchObject({ salary: "85000.00", version: 2 });
  });

  it("A8: after ACCEPTED any edit of the offer returns 409, and a second response too", async () => {
    const recruiter = await signedIn("RECRUITER");
    const job = await approvedRequisition();
    const application = await insertApplication(db(), { requisitionId: job.id, status: "OFFER" });
    const sent = await insertOffer(application.id);
    await expectStatus(await call(respond as Handler, sent.id, { response: "ACCEPTED", version: 1 }, recruiter), 200);

    const approver = await insertUser(db(), "HIRING_MANAGER");
    await expectStatus(
      await call(patchOffer as Handler, sent.id, { version: 2, salary: "95000", approverId: approver.id }, recruiter, "PATCH"),
      409,
      "Accepted and declined offers can't be changed.",
    );
    await expectStatus(await call(respond as Handler, sent.id, { response: "DECLINED", version: 2 }, recruiter), 409);
    expect(await offerRow(sent.id)).toMatchObject({ candidateResponse: "ACCEPTED", approvalStatus: "APPROVED", salary: "85000.00", version: 2 });
  });

  it("L8: a response can be recorded while the requisition is on hold; a stale version returns 409", async () => {
    const admin = await signedIn("ADMIN");
    const job = await approvedRequisition({ state: "ON_HOLD", isPublished: false, onHoldSince: new Date() });
    const application = await insertApplication(db(), { requisitionId: job.id, status: "OFFER" });
    const sent = await insertOffer(application.id);
    await expectStatus(await call(respond as Handler, sent.id, { response: "ACCEPTED", version: 7 }, admin), 409);
    await expectStatus(await call(respond as Handler, sent.id, { response: "ACCEPTED", version: 1 }, admin), 200);
  });
});

describe("hiring rules (R2, R5, L8)", () => {
  it("R2: hiring with only a declined or an unanswered offer returns 409; with an accepted one it sets hired_at and dispositioned_at", async () => {
    const recruiter = await signedIn("RECRUITER");
    const job = await approvedRequisition({ openingsCount: 3 });
    const declined = await insertApplication(db(), { requisitionId: job.id, status: "OFFER" });
    await insertOffer(declined.id, { candidateResponse: "DECLINED", respondedAt: new Date() });
    const unanswered = await insertApplication(db(), { requisitionId: job.id, status: "OFFER" });
    await insertOffer(unanswered.id);
    for (const application of [declined, unanswered]) {
      await expectStatus(await hire(recruiter, application.id), 409, NO_OFFER);
      expect(await app(application.id)).toMatchObject({ status: "OFFER", hiredAt: null, version: 1 });
    }

    const accepted = await acceptedCandidate(job.id);
    await expectStatus(await hire(recruiter, accepted.id), 200);
    const hired = await app(accepted.id);
    expect(hired.status).toBe("HIRED");
    expect(hired.hiredAt).toBeInstanceOf(Date);
    expect(hired.dispositionedAt).toEqual(hired.hiredAt);
    expect((await req(job.id)).state).toBe("APPROVED");
  });

  it("R5: with both openings filled by hires inserted directly, a third hire is refused", async () => {
    const recruiter = await signedIn("RECRUITER");
    const job = await approvedRequisition({ openingsCount: 2 });
    for (let i = 0; i < 2; i++) await insertApplication(db(), { requisitionId: job.id, status: "HIRED", hiredAt: new Date(), dispositionedAt: new Date() });
    const third = await acceptedCandidate(job.id);
    await expectStatus(await hire(recruiter, third.id), 409, NO_OPENINGS);
    expect(await app(third.id)).toMatchObject({ status: "OFFER", version: 1 });
  });

  it("L8: a hire while the requisition is on hold, or in re-approval, is refused", async () => {
    const recruiter = await signedIn("RECRUITER");
    const onHold = await approvedRequisition({ state: "ON_HOLD", isPublished: false, onHoldSince: new Date() });
    const reApproval = await approvedRequisition({ state: "PENDING_APPROVAL" });
    for (const job of [onHold, reApproval]) {
      const candidate = await acceptedCandidate(job.id);
      await expectStatus(await hire(recruiter, candidate.id), 409, BLOCKED);
      expect(await app(candidate.id)).toMatchObject({ status: "OFFER", hiredAt: null });
    }
  });

  it("R5: two concurrent hires for the last opening give one success and one refusal", async () => {
    const job = await approvedRequisition({ openingsCount: 2 });
    await insertApplication(db(), { requisitionId: job.id, status: "HIRED", hiredAt: new Date(), dispositionedAt: new Date() });
    const [a, b] = [await acceptedCandidate(job.id), await acceptedCandidate(job.id)];
    const actor = await insertUser(db(), "RECRUITER");
    const results = await Promise.all(
      [a, b].map((candidate) => withTransaction((tx) => changeApplicationStatus(tx, { applicationId: candidate.id, toStatus: "HIRED", version: 1, actor }))),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    const [{ value: hired }] = await getDb()
      .select({ value: count() })
      .from(applications)
      .where(and(eq(applications.requisitionId, job.id), eq(applications.status, "HIRED")));
    expect(hired).toBe(2);
  });
});

describe("auto-close (R6)", () => {
  async function fillFixture() {
    const rejection = await rejectionTemplate();
    const job = await approvedRequisition({ openingsCount: 1 });
    const candidate = await acceptedCandidate(job.id);
    const withEmail = await insertApplication(db(), { requisitionId: job.id, status: "SCREENING" });
    const withInterview = await insertApplication(db(), { requisitionId: job.id, status: "INTERVIEW" });
    const earlier = await withTransaction((tx) =>
      queueEmail(tx, { to: withEmail.email!, audience: "CANDIDATE", applicationId: withEmail.id, subject: "Earlier", body: "Hello", startAfter: new Date(Date.now() + DAY) }),
    );
    const organizer = await insertUser(db(), "RECRUITER");
    const [interview] = await getDb()
      .insert(interviews)
      .values({
        applicationId: withInterview.id,
        startsAtUtc: new Date(Date.now() + 3 * DAY),
        durationMinutes: 60,
        timezone: "Europe/Warsaw",
        locationOrLink: "Room 1",
        icsUid: `ics-${randomUUID()}`,
        createdByUserId: organizer.id,
      })
      .returning();
    return { rejection, job, candidate, withEmail, withInterview, earlier, interview };
  }

  it("R6: the last hire closes the requisition as FILLED and rejects the other open applications with REQ_FILLED in one transaction", async () => {
    const recruiter = await signedIn("RECRUITER");
    const f = await fillFixture();
    await expectStatus(await hire(recruiter, f.candidate.id), 200);

    expect((await app(f.candidate.id)).status).toBe("HIRED");
    const closed = await req(f.job.id);
    expect(closed).toMatchObject({ state: "CLOSED", closeReason: "FILLED", isPublished: false });
    expect(closed.closedAt).toBeInstanceOf(Date);
    const history = await getDb().select().from(requisitionHistory).where(eq(requisitionHistory.requisitionId, f.job.id)).orderBy(asc(requisitionHistory.createdAt));
    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "state", oldValue: "APPROVED", newValue: "CLOSED", userId: recruiter.userId, comment: null }),
        expect.objectContaining({ field: "close_reason", newValue: "FILLED", userId: recruiter.userId }),
      ]),
    );

    for (const other of [f.withEmail, f.withInterview]) {
      expect(await app(other.id)).toMatchObject({ status: "REJECTED", reasonCode: "REQ_FILLED" });
      const emails = await getDb().select().from(emailLog).where(eq(emailLog.applicationId, other.id)).orderBy(asc(emailLog.createdAt));
      expect(emails.filter((email) => email.status === "QUEUED" && email.templateId === f.rejection.id)).toHaveLength(1);
    }
    const [earlier] = await getDb().select().from(emailLog).where(eq(emailLog.id, f.earlier));
    expect(earlier.status).toBe("CANCELLED");
    const [interview] = await getDb().select().from(interviews).where(eq(interviews.id, f.interview.id));
    expect(interview.status).toBe("CANCELLED");
  });

  it("R6: a failure forced after the close rolls back the hire and the close", async () => {
    const f = await fillFixture();
    const actor = await insertUser(db(), "RECRUITER");
    await expect(
      withTransaction(async (tx) => {
        const result = await changeApplicationStatus(tx, { applicationId: f.candidate.id, toStatus: "HIRED", version: 1, actor });
        expect(result.ok).toBe(true);
        expect((await tx.select({ state: requisitions.state }).from(requisitions).where(eq(requisitions.id, f.job.id)))[0].state).toBe("CLOSED");
        throw new Error("forced after the close");
      }),
    ).rejects.toThrow("forced after the close");

    expect(await app(f.candidate.id)).toMatchObject({ status: "OFFER", hiredAt: null, version: 1 });
    expect(await req(f.job.id)).toMatchObject({ state: "APPROVED", closeReason: null, isPublished: true });
    expect(await app(f.withEmail.id)).toMatchObject({ status: "SCREENING", version: 1 });
    const [earlier] = await getDb().select().from(emailLog).where(eq(emailLog.id, f.earlier));
    expect(earlier.status).toBe("QUEUED");
    const [interview] = await getDb().select().from(interviews).where(eq(interviews.id, f.interview.id));
    expect(interview.status).toBe("SCHEDULED");
  });

  it("R6: a bulk hire of three fills the last opening with the first; the other two are refused and stay REJECTED with REQ_FILLED", async () => {
    const recruiter = await signedIn("RECRUITER");
    await rejectionTemplate();
    const job = await approvedRequisition({ openingsCount: 2 });
    await insertApplication(db(), { requisitionId: job.id, status: "HIRED", hiredAt: new Date(), dispositionedAt: new Date() });
    const candidates = [await acceptedCandidate(job.id), await acceptedCandidate(job.id), await acceptedCandidate(job.id)];

    const response = await call(
      bulkStatus as Handler,
      "",
      { toStatus: "HIRED", items: candidates.map((candidate) => ({ applicationId: candidate.id, version: 1 })) },
      recruiter,
    );
    await expectStatus(response, 200);
    const { results } = (await response.json()) as { results: { applicationId: string; ok: boolean; code?: string }[] };
    expect(results.map((result) => result.ok)).toEqual([true, false, false]);
    expect((await req(job.id)).closeReason).toBe("FILLED");
    expect((await app(candidates[0].id)).status).toBe("HIRED");
    for (const candidate of candidates.slice(1)) expect(await app(candidate.id)).toMatchObject({ status: "REJECTED", reasonCode: "REQ_FILLED" });
  });
});

describe("hired correction (R4)", () => {
  it("R4: a Recruiter's correction returns 403 and an Admin's without a comment 400; nothing changes", async () => {
    const recruiter = await signedIn("RECRUITER");
    const admin = await signedIn("ADMIN");
    const job = await approvedRequisition({ openingsCount: 2 });
    const candidate = await acceptedCandidate(job.id);
    await expectStatus(await hire(recruiter, candidate.id), 200);

    await expectStatus(await correct(recruiter, candidate.id, "WITHDRAWN", "Never started"), 403, "Only an Admin can correct a hired status.");
    await expectStatus(await correct(admin, candidate.id, "WITHDRAWN"), 400, "Correcting a hired status needs a comment.");
    await expectStatus(await correct(admin, candidate.id, "SCREENING", "Wrong"), 409, "A hired application can't be changed.");
    expect(await app(candidate.id)).toMatchObject({ status: "HIRED", version: 2 });
  });

  it("R4: an Admin corrects a FILLED requisition's hires; the requisition stays CLOSED and OFFER needs a reopen first; the application can be hired again", async () => {
    const recruiter = await signedIn("RECRUITER");
    const admin = await signedIn("ADMIN");
    const job = await approvedRequisition({ openingsCount: 2 });
    const [first, second] = [await acceptedCandidate(job.id), await acceptedCandidate(job.id)];
    await expectStatus(await hire(recruiter, first.id), 200);
    await expectStatus(await hire(recruiter, second.id), 200);
    expect(await req(job.id)).toMatchObject({ state: "CLOSED", closeReason: "FILLED" });
    await getDb().update(applications).set({ exportedAt: new Date() }).where(inArray(applications.id, [first.id, second.id]));

    await expectStatus(await correct(admin, first.id, "WITHDRAWN", "Didn't start"), 200);
    const withdrawn = await app(first.id);
    expect(withdrawn).toMatchObject({ status: "WITHDRAWN", hiredAt: null, exportedAt: null, reasonCode: null });
    expect(withdrawn.dispositionedAt).toBeInstanceOf(Date);
    const [historyRow] = await getDb()
      .select()
      .from(applicationHistory)
      .where(and(eq(applicationHistory.applicationId, first.id), eq(applicationHistory.toStatus, "WITHDRAWN")));
    expect(historyRow).toMatchObject({ fromStatus: "HIRED", comment: "Didn't start", isReopen: false, changedByUserId: admin.userId });
    expect(await req(job.id)).toMatchObject({ state: "CLOSED", closeReason: "FILLED" });

    await expectStatus(await correct(admin, second.id, "OFFER", "Start date moved"), 409, "The requisition is closed. An Admin can reopen it.");
    expect((await app(second.id)).status).toBe("HIRED");

    const reopened = await call(reopen as Handler, job.id, { version: (await req(job.id)).version, comment: "Correction" }, admin);
    await expectStatus(reopened, 200);
    await expectStatus(await correct(admin, second.id, "OFFER", "Start date moved"), 200);
    expect(await app(second.id)).toMatchObject({ status: "OFFER", hiredAt: null, exportedAt: null, dispositionedAt: null, reasonCode: null });

    await expectStatus(await hire(recruiter, second.id), 200);
    expect((await app(second.id)).status).toBe("HIRED");
    expect((await req(job.id)).state).toBe("APPROVED");
  });

  it("R4: a correction to REJECTED records reason OTHER and works while the requisition is on hold", async () => {
    const admin = await signedIn("ADMIN");
    const job = await approvedRequisition({ state: "ON_HOLD", isPublished: false, onHoldSince: new Date() });
    const hired = await insertApplication(db(), { requisitionId: job.id, status: "HIRED", hiredAt: new Date(), dispositionedAt: new Date() });
    await expectStatus(await correct(admin, hired.id, "REJECTED", "Failed background check"), 200);
    expect(await app(hired.id)).toMatchObject({ status: "REJECTED", reasonCode: "OTHER", hiredAt: null });
  });
});
