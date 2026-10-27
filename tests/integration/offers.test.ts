// Offer drafting against the database (ats-project-scope.md §5.6, R10, L6,
// L8, A8; tech-stack.md D7, T5): through the API with real session cookies.
// Holds, re-approval, approval and closes go through their real APIs;
// approval states and candidate responses are set directly (the response
// API is tested in hiring.test.ts).
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { POST as createOfferRoute } from "@/app/api/applications/[id]/offers/route";
import { POST as changeStatus } from "@/app/api/applications/[id]/status/route";
import { POST as discard } from "@/app/api/offers/[id]/discard/route";
import { PATCH as patchOffer } from "@/app/api/offers/[id]/route";
import { POST as approve } from "@/app/api/requisitions/[id]/approve/route";
import { POST as close } from "@/app/api/requisitions/[id]/close/route";
import { POST as hold } from "@/app/api/requisitions/[id]/hold/route";
import { POST as resume } from "@/app/api/requisitions/[id]/resume/route";
import { PATCH as patchRequisition } from "@/app/api/requisitions/[id]/route";
import { jobQueue } from "@/server/adapters/job-queue";
import { type Tx, getDb, withTransaction } from "@/server/db";
import { applications, auditLog, emailLog, offers, requisitions, templates } from "@/server/db/schema";
import { warsawRunDate } from "@/server/domain/daily-tasks";
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
      body: JSON.stringify(body),
    }),
    ctx(id),
  );

const STALE = "This record was changed by someone else. Reload and try again.";
const tomorrow = () => warsawRunDate(new Date(Date.now() + 36 * 3_600_000));

// Emails this file queued (re-approval requests, stage emails) are cancelled,
// so another file's processDueJobs with a fake transport never picks them up.
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

async function offerTemplate(isActive = true) {
  const [row] = await getDb().insert(templates).values({ type: "OFFER", name: `Offer ${randomUUID()}`, body: "Dear [[CANDIDATE_FULL_NAME]]", isActive }).returning();
  return row;
}

/** An application in `status` on an approved requisition with its own Hiring Manager. */
async function setup(status: "OFFER" | "INTERVIEW" = "OFFER") {
  const hm = await insertUser(db(), "HIRING_MANAGER");
  const requisition = await insertRequisition(db(), { state: "APPROVED", approvedAt: new Date(), isPublished: true, hiringManagerId: hm.id, openingsCount: 2, descriptionHtml: "<p>Do things.</p>" });
  requisitionIds.push(requisition.id);
  const application = await insertApplication(db(), { requisitionId: requisition.id, status });
  return { requisition, application, template: await offerTemplate() };
}

const body = (templateId: string, overrides: Record<string, unknown> = {}) => ({ jobTitle: "Backend Engineer", salary: "85000.00", currency: "EUR", startDate: tomorrow(), templateId, ...overrides });

async function created(session: Session, applicationId: string, templateId: string, overrides: Record<string, unknown> = {}) {
  const response = await call(createOfferRoute as Handler, "POST", applicationId, body(templateId, overrides), session);
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(201);
  return (await response.json()).offer as typeof offers.$inferSelect;
}

const offersOf = (applicationId: string) => getDb().select().from(offers).where(eq(offers.applicationId, applicationId)).orderBy(asc(offers.createdAt));
async function offerRow(id: string) {
  const [row] = await getDb().select().from(offers).where(eq(offers.id, id));
  return row;
}
async function requisitionVersion(id: string) {
  const [row] = await getDb().select({ version: requisitions.version }).from(requisitions).where(eq(requisitions.id, id));
  return row.version;
}

describe("create", () => {
  it("R10: an offer for an application in INTERVIEW returns 409 and inserts nothing; in OFFER it is a DRAFT", async () => {
    const recruiter = await signedIn("RECRUITER");
    const early = await setup("INTERVIEW");
    const refused = await call(createOfferRoute as Handler, "POST", early.application.id, body(early.template.id), recruiter);
    expect(refused.status).toBe(409);
    expect((await refused.json()).message).toBe("An offer can be created only when the application is in Offer.");
    expect(await offersOf(early.application.id)).toEqual([]);

    const ready = await setup();
    const offer = await created(recruiter, ready.application.id, ready.template.id);
    expect(offer).toMatchObject({
      approvalStatus: "DRAFT",
      candidateResponse: "PENDING",
      approverId: null,
      submittedByUserId: null,
      submittedAt: null,
      sentAt: null,
      respondedAt: null,
      createdByUserId: recruiter.userId,
      version: 1,
      salary: "85000.00",
      currency: "EUR",
    });
  });

  it("validation: job title, salary, currency, start date and template are refused with 400 naming the field", async () => {
    const recruiter = await signedIn("RECRUITER");
    const { application, template } = await setup();
    const inactive = await offerTemplate(false);
    const cases: [Record<string, unknown>, string][] = [
      [{ jobTitle: " " }, "jobTitle"],
      [{ salary: "0" }, "salary"],
      [{ salary: "100.123" }, "salary"],
      [{ salary: "10000000000" }, "salary"],
      [{ currency: "eur" }, "currency"],
      [{ currency: "XXX" }, "currency"],
      [{ startDate: warsawRunDate(new Date(Date.now() - 48 * 3_600_000)) }, "startDate"],
      [{ templateId: inactive.id }, "templateId"],
      [{ templateId: randomUUID() }, "templateId"],
    ];
    for (const [overrides, field] of cases) {
      const response = await call(createOfferRoute as Handler, "POST", application.id, body(template.id, overrides), recruiter);
      expect(response.status, field).toBe(400);
      expect(Object.keys((await response.json()).fields), field).toEqual([field]);
    }
    expect(await offersOf(application.id)).toEqual([]);
    for (const currency of ["PLN", "USD", "XOF"]) {
      await created(recruiter, application.id, template.id, { currency });
      await getDb().update(offers).set({ approvalStatus: "WITHDRAWN" }).where(eq(offers.applicationId, application.id));
    }
  });

  it("L8: creating while the requisition is ON_HOLD (real hold) returns 409; after resume it succeeds", async () => {
    const recruiter = await signedIn("RECRUITER");
    const { requisition, application, template } = await setup();
    expect((await call(hold as Handler, "POST", requisition.id, { version: await requisitionVersion(requisition.id), comment: "Budget" }, recruiter)).status).toBe(200);
    const refused = await call(createOfferRoute as Handler, "POST", application.id, body(template.id), recruiter);
    expect(refused.status).toBe(409);
    expect((await refused.json()).message).toBe("Offers can't be created while the requisition is on hold or awaiting approval.");
    expect((await call(resume as Handler, "POST", requisition.id, { version: await requisitionVersion(requisition.id) }, recruiter)).status).toBe(200);
    await created(recruiter, application.id, template.id);
  });

  it("L8: creating during re-approval (real L2 edit) returns 409; after approval it succeeds; a draft can still be edited and discarded", async () => {
    const recruiter = await signedIn("RECRUITER");
    const approver = await signedIn("HIRING_MANAGER");
    const { requisition, application, template } = await setup();
    const draft = await created(recruiter, application.id, template.id);
    const edit = await call(patchRequisition as Handler, "PATCH", requisition.id, { version: await requisitionVersion(requisition.id), openingsCount: 5, approverId: approver.userId }, recruiter);
    expect(edit.status, JSON.stringify(await edit.clone().json())).toBe(200);
    expect((await call(patchOffer as Handler, "PATCH", draft.id, { version: 1, salary: "90000" }, recruiter)).status).toBe(200);
    expect((await call(discard as Handler, "POST", draft.id, { version: 2 }, recruiter)).status).toBe(200);
    expect((await call(createOfferRoute as Handler, "POST", application.id, body(template.id), recruiter)).status).toBe(409);
    expect((await call(approve as Handler, "POST", requisition.id, { version: await requisitionVersion(requisition.id) }, approver)).status).toBe(200);
    await created(recruiter, application.id, template.id);
  });

  it("one active offer: a second create while DRAFT is 409; after a decline a new one is created and the old one is frozen", async () => {
    const recruiter = await signedIn("RECRUITER");
    const { application, template } = await setup();
    const first = await created(recruiter, application.id, template.id);
    const second = await call(createOfferRoute as Handler, "POST", application.id, body(template.id), recruiter);
    expect(second.status).toBe(409);
    expect((await second.json()).message).toBe("This application already has an active offer.");

    await getDb().update(offers).set({ approvalStatus: "APPROVED", approverId: (await insertUser(db(), "HIRING_MANAGER")).id, candidateResponse: "DECLINED" }).where(eq(offers.id, first.id));
    const next = await created(recruiter, application.id, template.id, { salary: "92000" });
    expect(next.id).not.toBe(first.id);
    const patched = await call(patchOffer as Handler, "PATCH", first.id, { version: 1, salary: "1" }, recruiter);
    expect(patched.status).toBe(409);
    expect((await patched.json()).message).toBe("This offer is read-only because a newer offer exists.");
    expect((await call(discard as Handler, "POST", first.id, { version: 1 }, recruiter)).status).toBe(409);
    expect((await offerRow(first.id)).approvalStatus).toBe("APPROVED");
  });

  it("two concurrent creates leave exactly one offer", async () => {
    const recruiter = await signedIn("RECRUITER");
    const { application, template } = await setup();
    const responses = await Promise.all([1, 2, 3].map(() => call(createOfferRoute as Handler, "POST", application.id, body(template.id), recruiter)));
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409, 409]);
    expect(await offersOf(application.id)).toHaveLength(1);
  });

  it("access: Hiring Manager and Interviewer 403, no session 401, unknown application 404", async () => {
    const { application, template } = await setup();
    for (const role of ["HIRING_MANAGER", "INTERVIEWER"] as const) {
      expect((await call(createOfferRoute as Handler, "POST", application.id, body(template.id), await signedIn(role))).status, role).toBe(403);
    }
    expect((await call(createOfferRoute as Handler, "POST", application.id, body(template.id))).status).toBe(401);
    expect((await call(createOfferRoute as Handler, "POST", randomUUID(), body(template.id), await signedIn("RECRUITER"))).status).toBe(404);
  });
});

describe("edit", () => {
  it("a draft edit increments version; a stale version is 409; a deactivated stored template may stay", async () => {
    const recruiter = await signedIn("RECRUITER");
    const { application, template } = await setup();
    const offer = await created(recruiter, application.id, template.id);
    await getDb().update(templates).set({ isActive: false }).where(eq(templates.id, template.id));
    const response = await call(patchOffer as Handler, "PATCH", offer.id, { version: 1, salary: "88000.5", templateId: template.id }, recruiter);
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    expect(await offerRow(offer.id)).toMatchObject({ salary: "88000.50", version: 2, approvalStatus: "DRAFT" });
    const stale = await call(patchOffer as Handler, "PATCH", offer.id, { version: 1, salary: "1" }, recruiter);
    expect(stale.status).toBe(409);
    expect((await stale.json()).message).toBe(STALE);
    const other = await offerTemplate(false);
    expect((await call(patchOffer as Handler, "PATCH", offer.id, { version: 2, templateId: other.id }, recruiter)).status).toBe(400);
  });

  it("a REJECTED latest offer is editable and stays REJECTED; PENDING returns 409; APPROVED needs an approver (A8)", async () => {
    const recruiter = await signedIn("RECRUITER");
    const approver = await insertUser(db(), "HIRING_MANAGER");
    const { application, template } = await setup();
    const offer = await created(recruiter, application.id, template.id);
    await getDb().update(offers).set({ approvalStatus: "REJECTED", approverId: approver.id }).where(eq(offers.id, offer.id));
    expect((await call(patchOffer as Handler, "PATCH", offer.id, { version: 1, jobTitle: "Senior Engineer" }, recruiter)).status).toBe(200);
    expect(await offerRow(offer.id)).toMatchObject({ approvalStatus: "REJECTED", jobTitle: "Senior Engineer" });
    await getDb().update(offers).set({ approvalStatus: "PENDING" }).where(eq(offers.id, offer.id));
    const pending = await call(patchOffer as Handler, "PATCH", offer.id, { version: 2, salary: "1" }, recruiter);
    expect(pending.status).toBe(409);
    expect((await pending.json()).message).toBe("This offer is awaiting approval. Withdraw the request to make changes.");
    // Since task 36 (A8) a change to an APPROVED offer goes through re-approval and needs an approver.
    await getDb().update(offers).set({ approvalStatus: "APPROVED" }).where(eq(offers.id, offer.id));
    const approved = await call(patchOffer as Handler, "PATCH", offer.id, { version: 2, salary: "1" }, recruiter);
    expect(approved.status).toBe(400);
    expect((await approved.json()).fields).toEqual({ approverId: "Changing an approved offer needs re-approval. Choose an approver." });
  });
});

describe("discard", () => {
  it("discarding a DRAFT sets WITHDRAWN and writes one OFFER_DISCARDED row; afterwards a new offer can be created", async () => {
    const recruiter = await signedIn("RECRUITER");
    const { application, template } = await setup();
    const offer = await created(recruiter, application.id, template.id);
    expect((await call(discard as Handler, "POST", offer.id, { version: 1 }, recruiter)).status).toBe(200);
    expect(await offerRow(offer.id)).toMatchObject({ approvalStatus: "WITHDRAWN", version: 2 });
    const audits = await getDb().select().from(auditLog).where(and(eq(auditLog.action, "OFFER_DISCARDED"), eq(auditLog.subjectId, offer.id)));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorUserId: recruiter.userId, subjectType: "OFFER", detailsJson: { applicationId: application.id, fromStatus: "DRAFT" } });
    await created(recruiter, application.id, template.id);
  });

  it("discarding an APPROVED offer returns 409 and writes nothing", async () => {
    const recruiter = await signedIn("RECRUITER");
    const { application, template } = await setup();
    const offer = await created(recruiter, application.id, template.id);
    await getDb().update(offers).set({ approvalStatus: "APPROVED", approverId: (await insertUser(db(), "HIRING_MANAGER")).id }).where(eq(offers.id, offer.id));
    const response = await call(discard as Handler, "POST", offer.id, { version: 1 }, recruiter);
    expect(response.status).toBe(409);
    expect((await response.json()).message).toBe("Only draft or rejected offers can be discarded.");
    expect((await offerRow(offer.id)).approvalStatus).toBe("APPROVED");
    expect(await getDb().select().from(auditLog).where(eq(auditLog.subjectId, offer.id))).toEqual([]);
  });
});

describe("final status (Q1)", () => {
  it("rejecting an application withdraws its DRAFT offer; moving OFFER → INTERVIEW keeps it DRAFT but not editable", async () => {
    const recruiter = await signedIn("RECRUITER");
    const rejected = await setup();
    const offer = await created(recruiter, rejected.application.id, rejected.template.id);
    const response = await call(changeStatus as Handler, "POST", rejected.application.id, { toStatus: "REJECTED", version: rejected.application.version }, recruiter);
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    expect((await offerRow(offer.id)).approvalStatus).toBe("WITHDRAWN");

    const back = await setup();
    const draft = await created(recruiter, back.application.id, back.template.id);
    expect((await call(changeStatus as Handler, "POST", back.application.id, { toStatus: "INTERVIEW", version: back.application.version }, recruiter)).status).toBe(200);
    expect((await offerRow(draft.id)).approvalStatus).toBe("DRAFT");
    const edit = await call(patchOffer as Handler, "PATCH", draft.id, { version: 1, salary: "1" }, recruiter);
    expect(edit.status).toBe(409);
    expect((await edit.json()).message).toBe("An offer can be created only when the application is in Offer.");
  });

  it("L6: closing the requisition withdraws an API-created draft and leaves a discarded one as it was, with no OFFER_DISCARDED from the close", async () => {
    const recruiter = await signedIn("RECRUITER");
    const { requisition, application, template } = await setup();
    const second = await insertApplication(db(), { requisitionId: requisition.id, status: "OFFER" });
    const draft = await created(recruiter, application.id, template.id);
    const discarded = await created(recruiter, second.id, template.id);
    expect((await call(discard as Handler, "POST", discarded.id, { version: 1 }, recruiter)).status).toBe(200);
    // Task 38: answered offers keep their record through the close.
    const approver = await insertUser(db(), "HIRING_MANAGER");
    const answered = await Promise.all(
      (["ACCEPTED", "DECLINED"] as const).map(async (candidateResponse) => {
        const owner = await insertApplication(db(), { requisitionId: requisition.id, status: "OFFER" });
        const [row] = await getDb()
          .insert(offers)
          .values({ ...body(template.id), applicationId: owner.id, createdByUserId: recruiter.userId, approverId: approver.id, approvalStatus: "APPROVED", candidateResponse, sentAt: new Date(), respondedAt: new Date() })
          .returning();
        return row;
      }),
    );

    const response = await call(close as Handler, "POST", requisition.id, { version: await requisitionVersion(requisition.id), comment: "Budget cut" }, recruiter);
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    expect((await offerRow(draft.id)).approvalStatus).toBe("WITHDRAWN");
    expect(await offerRow(discarded.id)).toMatchObject({ approvalStatus: "WITHDRAWN", version: 2 });
    const audits = await getDb().select().from(auditLog).where(and(eq(auditLog.action, "OFFER_DISCARDED"), or(eq(auditLog.subjectId, draft.id), eq(auditLog.subjectId, discarded.id))));
    expect(audits.map((row) => row.subjectId)).toEqual([discarded.id]);
    for (const offer of answered) {
      expect(await offerRow(offer.id), offer.candidateResponse).toMatchObject({ approvalStatus: "APPROVED", candidateResponse: offer.candidateResponse, version: offer.version });
    }
    const apps = await getDb().select({ status: applications.status }).from(applications).where(eq(applications.requisitionId, requisition.id));
    expect(apps.every((row) => row.status === "REJECTED")).toBe(true);
  });
});
