// Requisition lifecycle after approval against the database (ats-project-
// scope.md §5.2 L1, L4–L7, L9, L11; §5.4 R7, R8, R11; E8). Rows are
// committed where the API or a second connection needs them; every row is
// new, so tests don't see each other's data.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, asc, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { POST as close } from "@/app/api/requisitions/[id]/close/route";
import { POST as hold } from "@/app/api/requisitions/[id]/hold/route";
import { POST as reopen } from "@/app/api/requisitions/[id]/reopen/route";
import { POST as republish } from "@/app/api/requisitions/[id]/republish/route";
import { POST as resume } from "@/app/api/requisitions/[id]/resume/route";
import { PATCH } from "@/app/api/requisitions/[id]/route";
import { POST as unpublish } from "@/app/api/requisitions/[id]/unpublish/route";
import { jobQueue } from "@/server/adapters/job-queue";
import { submitApplication } from "@/server/apply";
import { listPublicJobs } from "@/server/careers";
import { type Tx, getDb, withTransaction } from "@/server/db";
import {
  applicationHistory,
  applications,
  approvalEvents,
  emailLog,
  masterData,
  offers,
  requisitionHistory,
  requisitions,
  templates,
} from "@/server/db/schema";
import { queueEmail } from "@/server/email";
import { applyStatusChange, changeApplicationStatus } from "@/server/pipeline";
import { runLifecycleAction } from "@/server/requisitions/lifecycle";
import { insertApplication, insertRequisition, insertUser, offerValues } from "./fixtures";
import { unique } from "./helpers";
import { ORIGIN, signedIn } from "./sessions";

const db = () => getDb() as unknown as Tx;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const VALID_PDF = new Uint8Array(readFileSync("tests/fixtures/pdf/valid.pdf"));

// Shared worker database: templates this file created lose their trigger
// status again, and emails it left queued are cancelled.
const createdTemplateIds: string[] = [];
const createdRequisitionIds: string[] = [];
afterAll(async () => {
  if (createdRequisitionIds.length > 0) {
    await withTransaction(async (tx) => {
      const queued = await tx
        .update(emailLog)
        .set({ status: "CANCELLED" })
        .where(and(inArray(emailLog.requisitionId, createdRequisitionIds), eq(emailLog.status, "QUEUED")))
        .returning({ jobId: emailLog.jobId });
      for (const { jobId } of queued) if (jobId) await jobQueue.cancel(tx, "email.send", jobId);
    });
  }
  if (createdTemplateIds.length > 0) await getDb().update(templates).set({ isActive: false, triggerStatus: null }).where(inArray(templates.id, createdTemplateIds));
});

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

/** An approved, published External requisition with a unique word in its title, so the board search finds only it. */
async function approved(overrides: Partial<typeof requisitions.$inferInsert> = {}) {
  const hm = await insertUser(db(), "HIRING_MANAGER");
  const word = `Lifecycle${randomUUID().slice(0, 8)}`;
  const row = await insertRequisition(db(), {
    title: `Operator ${word}`,
    hiringManagerId: hm.id,
    state: "APPROVED",
    approvedAt: new Date(Date.now() - 30 * DAY),
    isPublished: true,
    descriptionHtml: "<p>Run the line.</p>",
    ...overrides,
  });
  createdRequisitionIds.push(row.id);
  return { ...row, word };
}

async function row(id: string) {
  const [found] = await getDb().select().from(requisitions).where(eq(requisitions.id, id));
  return found;
}
async function application(id: string) {
  const [found] = await getDb().select().from(applications).where(eq(applications.id, id));
  return found;
}
const history = (id: string) => getDb().select().from(requisitionHistory).where(eq(requisitionHistory.requisitionId, id)).orderBy(asc(requisitionHistory.createdAt));
const listed = async (word: string) => (await listPublicJobs({ q: word, page: 1 })).jobs.length > 0;

type Session = Awaited<ReturnType<typeof signedIn>>;
type Handler = (request: Request, context: never) => Promise<Response>;
const post = (handler: Handler, id: string, body: unknown, session: Session, method = "POST") =>
  handler(
    new Request(`${ORIGIN}/api/requisitions/${id}/x`, { method, headers: { cookie: session.cookie, "content-type": "application/json" }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) } as never,
  );
const patch = (id: string, body: unknown, session: Session) => post(PATCH as Handler, id, body, session, "PATCH");

async function applyTo(requisitionId: string) {
  return submitApplication({
    route: { kind: "external", id: requisitionId },
    fields: { firstName: "Ann", lastName: "Lee", email: `e2e-${randomUUID()}@example.com`, phone: "+48 600 100 200", consent: true },
    answers: {},
    questionStamp: [],
    consentVersion: "1.0",
    cv: { bytes: VALID_PDF, name: "CV.pdf" },
    coverLetter: null,
  });
}

describe("free edits (L1)", () => {
  async function location() {
    const [created] = await getDb().insert(masterData).values({ type: "LOCATION", code: unique("LOC"), label: "Gdańsk" }).returning();
    return created;
  }

  it("L1: while APPROVED, a new title, location and recruiter save without approval and keep state and publishing", async () => {
    const recruiter = await signedIn("RECRUITER");
    const job = await approved();
    const newRecruiter = await insertUser(db(), "RECRUITER");
    const where = await location();
    const response = await patch(job.id, { version: 1, title: `Senior ${job.word}`, locationId: where.id, recruiterId: newRecruiter.id }, recruiter);
    expect(response.status).toBe(200);
    expect(await row(job.id)).toMatchObject({ title: `Senior ${job.word}`, locationId: where.id, recruiterId: newRecruiter.id, state: "APPROVED", isPublished: true, version: 2 });
    expect(await getDb().select().from(approvalEvents).where(eq(approvalEvents.subjectId, job.id))).toEqual([]);
    expect(await history(job.id)).toEqual([]);
  });

  it("L1: the same works while ON_HOLD and in re-approval", async () => {
    const recruiter = await signedIn("RECRUITER");
    for (const state of ["ON_HOLD", "PENDING_APPROVAL"] as const) {
      const job = await approved({ state, isPublished: false, onHoldSince: state === "ON_HOLD" ? new Date() : null });
      const response = await patch(job.id, { version: 1, title: `Edited ${state}` }, recruiter);
      expect(response.status, state).toBe(200);
      expect(await row(job.id)).toMatchObject({ title: `Edited ${state}`, state });
    }
  });

  it("L1: an L2 field in APPROVED needs re-approval, any field in CLOSED returns 409; an empty description returns 400; a Hiring Manager gets 403", async () => {
    const recruiter = await signedIn("RECRUITER");
    const job = await approved();
    // Task 30 (L2): raising openings from APPROVED starts re-approval, so it needs an approver.
    const needsApprover = await patch(job.id, { version: 1, openingsCount: 3 }, recruiter);
    expect(needsApprover.status).toBe(400);
    expect((await needsApprover.json()).fields.approverId).toBe("This change needs re-approval. Choose an approver.");
    // Sent unchanged (as the form does), the L2 fields are fine.
    expect((await patch(job.id, { version: 1, openingsCount: 1, departmentId: job.departmentId, title: "Same L2" }, recruiter)).status).toBe(200);

    const empty = await patch(job.id, { version: 2, descriptionHtml: "<p>  </p>" }, recruiter);
    expect(empty.status).toBe(400);
    expect((await empty.json()).fields.descriptionHtml).toBe("The job description can't be empty once approved.");

    const hm = await signedIn("HIRING_MANAGER");
    const managed = await approved({ hiringManagerId: hm.userId, createdByUserId: hm.userId });
    expect((await patch(managed.id, { version: 1, title: "HM edit" }, hm)).status).toBe(403);

    const closed = await approved({ state: "CLOSED", isPublished: false, closedAt: new Date(), closeReason: "CANCELLED" });
    const refused = await patch(closed.id, { version: 1, title: "Too late" }, recruiter);
    expect(refused.status).toBe(409);
    expect((await refused.json()).message).toBe("This requisition is closed. An Admin can reopen it.");
    expect((await row(closed.id)).title).not.toBe("Too late");
  });

  it("L1: switching to PRIVATE generates the slug and the job board stops listing it", async () => {
    const recruiter = await signedIn("RECRUITER");
    const job = await approved();
    expect(await listed(job.word)).toBe(true);
    expect((await patch(job.id, { version: 1, postingType: "PRIVATE" }, recruiter)).status).toBe(200);
    const updated = await row(job.id);
    expect(updated.privateSlug).toMatch(/^[0-9a-f]{32}$/);
    expect(await listed(job.word)).toBe(false);
  });
});

describe("hold and resume (L4, L5)", () => {
  it("L4: hold unpublishes and sets on_hold_since; the board drops it and Quick Apply is refused", async () => {
    const recruiter = await signedIn("RECRUITER");
    const job = await approved();
    const response = await post(hold, job.id, { version: 1, comment: "Budget review" }, recruiter);
    expect(response.status).toBe(200);
    const held = await row(job.id);
    expect(held).toMatchObject({ state: "ON_HOLD", isPublished: false });
    expect(held.onHoldSince).toBeInstanceOf(Date);
    expect(await listed(job.word)).toBe(false);
    expect(await applyTo(job.id)).toMatchObject({ ok: false, reason: "closed" });
    expect(await getDb().select().from(applications).where(eq(applications.requisitionId, job.id))).toEqual([]);
  });

  it("L4: applications on an ON_HOLD requisition can still be moved", async () => {
    const job = await approved({ state: "ON_HOLD", isPublished: false, onHoldSince: new Date() });
    const app = await insertApplication(db(), { requisitionId: job.id });
    const actor = await insertUser(db(), "RECRUITER");
    expect(await withTransaction((tx) => changeApplicationStatus(tx, { applicationId: app.id, toStatus: "SCREENING", version: 1, actor }))).toMatchObject({ ok: true });
  });

  it("L4: hold is refused outside APPROVED, also in re-approval", async () => {
    const recruiter = await signedIn("RECRUITER");
    for (const state of ["ON_HOLD", "PENDING_APPROVAL", "CLOSED"] as const) {
      const job = await approved({ state, isPublished: false });
      const response = await post(hold, job.id, { version: 1 }, recruiter);
      expect(response.status, state).toBe(409);
      expect((await response.json()).message).toBe("This requisition can't be put on hold in its current state.");
    }
  });

  it("L5: resume adds the hold time (2 days 12 hours) to paused_days, clears on_hold_since and publishes again", async () => {
    const recruiter = await signedIn("RECRUITER");
    const job = await approved({ state: "ON_HOLD", isPublished: false, onHoldSince: new Date(Date.now() - 60 * HOUR), pausedDays: "1.25" });
    const response = await post(resume, job.id, { version: 1 }, recruiter);
    expect(response.status).toBe(200);
    expect(await row(job.id)).toMatchObject({ state: "APPROVED", isPublished: true, onHoldSince: null, pausedDays: "3.75" });
    expect(await listed(job.word)).toBe(true);
    expect(await applyTo(job.id)).toMatchObject({ ok: true });
  });

  it("L5: resume publishes even after a manual unpublish before the hold", async () => {
    const admin = await signedIn("ADMIN");
    const job = await approved();
    expect((await post(unpublish, job.id, { version: 1 }, admin)).status).toBe(200);
    expect((await post(hold, job.id, { version: 2 }, admin)).status).toBe(200);
    expect((await post(resume, job.id, { version: 3 }, admin)).status).toBe(200);
    expect((await row(job.id)).isPublished).toBe(true);
  });
});

describe("close (L6)", () => {
  async function closeFixture() {
    await rejectionTemplate();
    const job = await approved({ state: "ON_HOLD", isPublished: false, onHoldSince: new Date(Date.now() - DAY), pausedDays: "0.00" });
    const applied = await insertApplication(db(), { requisitionId: job.id });
    const inOffer = await insertApplication(db(), { requisitionId: job.id, status: "OFFER" });
    const hired = await insertApplication(db(), { requisitionId: job.id, status: "HIRED", dispositionedAt: new Date(), hiredAt: new Date() });
    const rejected = await insertApplication(db(), { requisitionId: job.id, status: "REJECTED", reasonCode: "OTHER", dispositionedAt: new Date() });
    const draftValues = await offerValues(db());
    const [draftOffer] = await getDb().insert(offers).values({ ...draftValues, applicationId: inOffer.id }).returning();
    const approver = await insertUser(db(), "HIRING_MANAGER");
    const [declined] = await getDb()
      .insert(offers)
      .values({ ...draftValues, applicationId: applied.id, approverId: approver.id, approvalStatus: "APPROVED", candidateResponse: "DECLINED", sentAt: new Date(), respondedAt: new Date() })
      .returning();
    // An earlier queued email of an open application, to be cancelled (R7).
    const earlier = await withTransaction((tx) =>
      queueEmail(tx, { to: applied.email!, audience: "CANDIDATE", applicationId: applied.id, subject: "Earlier", body: "Hello", startAfter: new Date(Date.now() + DAY) }),
    );
    return { job, applied, inOffer, hired, rejected, draftOffer, declined, earlier };
  }

  it("L6: closing rejects open applications with REQ_CANCELLED and the delayed email, withdraws pending offers, adds the hold time and unpublishes", async () => {
    const f = await closeFixture();
    const recruiter = await signedIn("RECRUITER");
    const before = Date.now();
    const response = await post(close, f.job.id, { version: 1, comment: "Budget cut" }, recruiter);
    expect(response.status).toBe(200);

    const closed = await row(f.job.id);
    expect(closed).toMatchObject({ state: "CLOSED", isPublished: false, closeReason: "CANCELLED", onHoldSince: null, pausedDays: "1.00" });
    expect(closed.closedAt).toBeInstanceOf(Date);

    for (const app of [f.applied, f.inOffer]) {
      const updated = await application(app.id);
      expect(updated).toMatchObject({ status: "REJECTED", reasonCode: "REQ_CANCELLED" });
      expect(updated.dispositionedAt).toBeInstanceOf(Date);
      expect(await getDb().select().from(applicationHistory).where(eq(applicationHistory.applicationId, app.id))).toEqual([
        expect.objectContaining({ fromStatus: app.status, toStatus: "REJECTED", reasonCode: "REQ_CANCELLED", changedByUserId: recruiter.userId, comment: null }),
      ]);
      const queued = (await getDb().select().from(emailLog).where(eq(emailLog.applicationId, app.id))).filter((email) => email.status === "QUEUED");
      expect(queued).toHaveLength(1);
      expect(queued[0].scheduledFor!.getTime()).toBeGreaterThanOrEqual(before + 24 * HOUR - 1_000);
    }
    expect((await getDb().select().from(emailLog).where(eq(emailLog.id, f.earlier)))[0].status).toBe("CANCELLED");

    const offerStates = await getDb().select().from(offers).where(inArray(offers.id, [f.draftOffer.id, f.declined.id]));
    expect(offerStates.find((offer) => offer.id === f.draftOffer.id)!.approvalStatus).toBe("WITHDRAWN");
    expect(offerStates.find((offer) => offer.id === f.declined.id)).toMatchObject({ approvalStatus: "APPROVED", candidateResponse: "DECLINED" });

    expect(await application(f.hired.id)).toMatchObject({ status: "HIRED", version: 1 });
    expect(await application(f.rejected.id)).toMatchObject({ status: "REJECTED", reasonCode: "OTHER", version: 1 });
  });

  it("L6: closing without a comment returns 400 and changes nothing; close is refused in re-approval", async () => {
    const f = await closeFixture();
    const recruiter = await signedIn("RECRUITER");
    const response = await post(close, f.job.id, { version: 1, comment: "  " }, recruiter);
    expect(response.status).toBe(400);
    expect((await response.json()).fields.comment).toBe("Add a comment to close.");
    expect(await row(f.job.id)).toMatchObject({ state: "ON_HOLD", version: 1 });
    expect((await application(f.applied.id)).status).toBe("APPLIED");

    const reApproval = await approved({ state: "PENDING_APPROVAL", isPublished: true });
    const refused = await post(close, reApproval.id, { version: 1, comment: "No" }, recruiter);
    expect(refused.status).toBe(409);
    expect((await refused.json()).message).toBe("This requisition can't be closed in its current state.");
  });

  it("L6: a failure after the first rejection rolls back the whole close", async () => {
    const f = await closeFixture();
    const user = { id: (await insertUser(db(), "RECRUITER")).id, role: "RECRUITER" as const };
    let calls = 0;
    await expect(
      withTransaction((tx) =>
        runLifecycleAction(tx, user, f.job.id, "close", { version: 1, comment: "Cut" }, {
          applyChange: async (...args) => {
            const result = await applyStatusChange(...args);
            calls += 1;
            if (calls === 1) throw new Error("forced failure after the first rejection");
            return result;
          },
        }),
      ),
    ).rejects.toThrow("forced failure");
    expect(await row(f.job.id)).toMatchObject({ state: "ON_HOLD", version: 1 });
    expect((await application(f.applied.id)).status).toBe("APPLIED");
    expect((await application(f.inOffer.id)).status).toBe("OFFER");
    expect(await getDb().select().from(applicationHistory).where(inArray(applicationHistory.applicationId, [f.applied.id, f.inOffer.id]))).toEqual([]);
  });
});

describe("reopen (L7)", () => {
  it("L7: only an Admin reopens, with a comment; the closed time is added and auto-rejected applications stay rejected", async () => {
    const job = await approved({ state: "CLOSED", isPublished: false, closedAt: new Date(Date.now() - 3 * DAY), closeReason: "CANCELLED", pausedDays: "0.50" });
    const rejected = await insertApplication(db(), { requisitionId: job.id, status: "REJECTED", reasonCode: "REQ_CANCELLED", dispositionedAt: new Date() });

    expect((await post(reopen, job.id, { version: 1, comment: "Back" }, await signedIn("RECRUITER"))).status).toBe(403);
    const admin = await signedIn("ADMIN");
    const noComment = await post(reopen, job.id, { version: 1 }, admin);
    expect(noComment.status).toBe(400);
    expect((await noComment.json()).fields.comment).toBe("Add a comment to reopen.");

    expect((await post(reopen, job.id, { version: 1, comment: "Budget restored" }, admin)).status).toBe(200);
    expect(await row(job.id)).toMatchObject({ state: "APPROVED", isPublished: true, closedAt: null, closeReason: null, pausedDays: "3.50" });
    expect(await application(rejected.id)).toMatchObject({ status: "REJECTED", reasonCode: "REQ_CANCELLED" });
    expect(await listed(job.word)).toBe(true);
  });

  it("L7: reopening a FILLED requisition is allowed", async () => {
    const job = await approved({ state: "CLOSED", isPublished: false, closedAt: new Date(), closeReason: "FILLED" });
    expect((await post(reopen, job.id, { version: 1, comment: "More hires" }, await signedIn("ADMIN"))).status).toBe(200);
  });
});

describe("publishing (L9)", () => {
  it("L9: unpublish then republish while APPROVED, and the job board follows", async () => {
    const recruiter = await signedIn("RECRUITER");
    const job = await approved();
    expect((await post(unpublish, job.id, { version: 1 }, recruiter)).status).toBe(200);
    expect(await listed(job.word)).toBe(false);
    const again = await post(unpublish, job.id, { version: 2 }, recruiter);
    expect(again.status).toBe(409);
    expect((await again.json()).message).toBe("The posting is already unpublished.");
    expect((await post(republish, job.id, { version: 2 }, recruiter)).status).toBe(200);
    expect(await listed(job.word)).toBe(true);
    expect((await row(job.id)).state).toBe("APPROVED");
  });

  it("L9: both return 409 while ON_HOLD, and a Hiring Manager gets 403", async () => {
    const recruiter = await signedIn("RECRUITER");
    const job = await approved({ state: "ON_HOLD", isPublished: false, onHoldSince: new Date() });
    for (const handler of [unpublish, republish]) {
      const response = await post(handler, job.id, { version: 1 }, recruiter);
      expect(response.status).toBe(409);
      expect((await response.json()).message).toBe("Publishing can be changed only while the requisition is approved.");
    }
    const hm = await signedIn("HIRING_MANAGER");
    const managed = await approved({ hiringManagerId: hm.userId });
    expect((await post(unpublish, managed.id, { version: 1 }, hm)).status).toBe(403);
    expect((await row(managed.id)).isPublished).toBe(true);
  });
});

describe("history (L11)", () => {
  it("L11: hold, resume, close and reopen write their rows in order; a refused action writes none", async () => {
    const recruiter = await signedIn("RECRUITER");
    const admin = await signedIn("ADMIN");
    const job = await approved();
    expect((await post(hold, job.id, { version: 1, comment: "Pause" }, recruiter)).status).toBe(200);
    expect((await post(hold, job.id, { version: 2 }, recruiter)).status).toBe(409);
    expect((await post(resume, job.id, { version: 2 }, recruiter)).status).toBe(200);
    expect((await post(unpublish, job.id, { version: 3 }, recruiter)).status).toBe(200);
    expect((await post(close, job.id, { version: 4, comment: "Done" }, recruiter)).status).toBe(200);
    expect((await post(reopen, job.id, { version: 5, comment: "Again" }, admin)).status).toBe(200);

    // A close or reopen writes two rows in one transaction (same created_at): the state row first.
    const ordered = (await history(job.id)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || Number(a.event === "FIELD_CHANGE") - Number(b.event === "FIELD_CHANGE"));
    const rows = ordered.map((entry) => [entry.event, entry.field, entry.oldValue, entry.newValue, entry.comment]);
    expect(rows).toEqual([
      ["STATE_CHANGE", "state", "APPROVED", "ON_HOLD", "Pause"],
      ["STATE_CHANGE", "state", "ON_HOLD", "APPROVED", null],
      ["FIELD_CHANGE", "is_published", "true", "false", null],
      ["STATE_CHANGE", "state", "APPROVED", "CLOSED", "Done"],
      ["FIELD_CHANGE", "close_reason", null, "CANCELLED", "Done"],
      ["REOPEN", "state", "CLOSED", "APPROVED", "Again"],
      ["FIELD_CHANGE", "close_reason", "CANCELLED", null, "Again"],
    ]);
    const users = ordered.map((entry) => entry.userId);
    expect(users.slice(0, 5).every((id) => id === recruiter.userId)).toBe(true);
    expect(users.slice(5).every((id) => id === admin.userId)).toBe(true);
  });
});
