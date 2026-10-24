// Application status changes against the database, pg-boss and Mailpit
// (ats-project-scope.md §5.4 R1–R3, R7–R9, R11, E8, E9; tech-stack.md J2,
// J7, D7, T5). Rows are committed where a test needs a second connection;
// every row is new, so tests don't see each other's data.
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { POST } from "@/app/api/applications/[id]/status/route";
import { getBoss } from "@/server/adapters/job-queue";
import { type Tx, getDb, withTransaction } from "@/server/db";
import { applicationHistory, applications, emailLog, offers, settings, templates } from "@/server/db/schema";
import type { PipelineStatus } from "@/server/domain/pipeline";
import { changeApplicationStatus } from "@/server/pipeline";
import { searchMessages } from "../support/mailpit";
import { processDueJobs } from "../support/process-due-jobs";
import { insertApplication, insertRequisition, insertUser, offerValues } from "./fixtures";
import { ORIGIN, signedIn } from "./sessions";

const db = () => getDb() as unknown as Tx;
const HOUR = 3_600_000;
const STALE = "This record was changed by someone else. Reload and try again.";

// The worker database is shared with other files, which own the trigger
// statuses: templates this file created are deactivated and lose their
// trigger status again (email_log rows still reference them, so they stay).
const createdTemplateIds: string[] = [];
afterAll(async () => {
  if (createdTemplateIds.length > 0) await getDb().update(templates).set({ isActive: false, triggerStatus: null }).where(inArray(templates.id, createdTemplateIds));
});

/** The active stage template for `status`, created when the worker database has none. */
async function stageTemplate(status: PipelineStatus) {
  const [existing] = await getDb()
    .select()
    .from(templates)
    .where(and(eq(templates.type, "EMAIL"), eq(templates.isActive, true), eq(templates.triggerStatus, status)));
  if (existing) return existing;
  const [created] = await getDb()
    .insert(templates)
    .values({ type: "EMAIL", name: `Stage ${status} ${randomUUID()}`, triggerStatus: status, subject: `${status} for [[JOB_TITLE]]`, body: "Dear [[CANDIDATE_FULL_NAME]]," })
    .returning();
  createdTemplateIds.push(created.id);
  return created;
}

/** Runs `fn` with no active stage template for `status`, and reactivates it afterwards. */
async function withoutStageTemplate(status: PipelineStatus, fn: () => Promise<void>) {
  const active = await getDb()
    .update(templates)
    .set({ isActive: false })
    .where(and(eq(templates.type, "EMAIL"), eq(templates.isActive, true), eq(templates.triggerStatus, status)))
    .returning({ id: templates.id });
  try {
    await fn();
  } finally {
    if (active.length > 0) await getDb().update(templates).set({ isActive: true }).where(inArray(templates.id, active.map((row) => row.id)));
  }
}

async function withRejectionDelay(hours: number, fn: () => Promise<void>) {
  await getDb().insert(settings).values({ key: "REJECTION_EMAIL_DELAY_HOURS", value: String(hours) }).onConflictDoUpdate({ target: settings.key, set: { value: String(hours) } });
  try {
    await fn();
  } finally {
    await getDb().delete(settings).where(eq(settings.key, "REJECTION_EMAIL_DELAY_HOURS"));
  }
}

/** An application on an APPROVED requisition, in `status`. */
async function application(overrides: Partial<typeof applications.$inferInsert> = {}, requisitionOverrides: Parameters<typeof insertRequisition>[1] = {}) {
  const requisition = await insertRequisition(db(), { state: "APPROVED", approvedAt: new Date(), isPublished: true, ...requisitionOverrides });
  return insertApplication(db(), { requisitionId: requisition.id, ...overrides });
}

async function row(id: string) {
  const [found] = await getDb().select().from(applications).where(eq(applications.id, id));
  return found;
}

const history = (id: string) => getDb().select().from(applicationHistory).where(eq(applicationHistory.applicationId, id)).orderBy(asc(applicationHistory.createdAt));
const emails = (id: string) => getDb().select().from(emailLog).where(eq(emailLog.applicationId, id)).orderBy(asc(emailLog.createdAt));

async function findJob(id: string) {
  const [job] = await (await getBoss()).findJobs("email.send", { id });
  return job;
}

/** Moves the application through the service, committed, and fails the test on a refusal. */
async function move(id: string, toStatus: PipelineStatus, comment?: string) {
  const actor = await insertUser(db(), "RECRUITER");
  const { version } = await row(id);
  const result = await withTransaction((tx) => changeApplicationStatus(tx, { applicationId: id, toStatus, version, comment, actor }));
  if (!result.ok) throw new Error(JSON.stringify(result));
  return { ...result, actor };
}

type Session = Awaited<ReturnType<typeof signedIn>>;
const post = (id: string, body: unknown, session?: Session) =>
  POST(
    new Request(`${ORIGIN}/api/applications/${id}/status`, {
      method: "POST",
      headers: { ...(session ? { cookie: session.cookie } : {}), "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) } as never,
  );

describe("changeApplicationStatus", () => {
  it("R8: APPLIED → SCREENING → REJECTED → reopen to INTERVIEW writes three history rows", async () => {
    const app = await application();
    const toScreening = await move(app.id, "SCREENING");
    const toRejected = await move(app.id, "REJECTED", "  Not a fit  ");
    const reopened = await move(app.id, "INTERVIEW", "Second look after the referral");
    expect(reopened).toMatchObject({ status: "INTERVIEW", version: 4 });

    expect(await history(app.id)).toEqual([
      expect.objectContaining({ fromStatus: "APPLIED", toStatus: "SCREENING", changedByUserId: toScreening.actor.id, comment: null, reasonCode: null, isReopen: false }),
      expect.objectContaining({ fromStatus: "SCREENING", toStatus: "REJECTED", changedByUserId: toRejected.actor.id, comment: "Not a fit", reasonCode: "OTHER", isReopen: false }),
      expect.objectContaining({
        fromStatus: "REJECTED",
        toStatus: "INTERVIEW",
        changedByUserId: reopened.actor.id,
        comment: "Second look after the referral",
        reasonCode: null,
        isReopen: true,
      }),
    ]);
    expect(await row(app.id)).toMatchObject({ status: "INTERVIEW", reasonCode: null, version: 4 });
  });

  it("R11: dispositioned_at is set when rejected, cleared when reopened and set again when withdrawn", async () => {
    const app = await application({ status: "SCREENING" });
    await move(app.id, "REJECTED");
    const rejected = await row(app.id);
    expect(rejected.dispositionedAt).toBeInstanceOf(Date);
    expect(rejected.reasonCode).toBe("OTHER");

    await move(app.id, "SCREENING", "Reconsidered");
    expect(await row(app.id)).toMatchObject({ dispositionedAt: null, reasonCode: null });

    await move(app.id, "WITHDRAWN");
    const withdrawn = await row(app.id);
    expect(withdrawn.dispositionedAt).toBeInstanceOf(Date);
    expect(withdrawn.dispositionedAt!.getTime()).toBeGreaterThan(rejected.dispositionedAt!.getTime());
    expect(withdrawn).toMatchObject({ status: "WITHDRAWN", reasonCode: null, hiredAt: null });
  });

  it("R11: hiring from OFFER with an accepted offer sets dispositioned_at and hired_at; is_disqualified is kept", async () => {
    const values = await offerValues(db());
    await getDb().update(applications).set({ status: "OFFER", isDisqualified: true }).where(eq(applications.id, values.applicationId));
    const approver = await insertUser(db(), "HIRING_MANAGER");
    await getDb()
      .insert(offers)
      .values({ ...values, approverId: approver.id, approvalStatus: "APPROVED", candidateResponse: "ACCEPTED", sentAt: new Date(), respondedAt: new Date() });
    await move(values.applicationId, "HIRED");
    const hired = await row(values.applicationId);
    expect(hired).toMatchObject({ status: "HIRED", reasonCode: null, isDisqualified: true });
    expect(hired.dispositionedAt).toBeInstanceOf(Date);
    expect(hired.hiredAt).toEqual(hired.dispositionedAt);
  });

  it("R2: OFFER → HIRED without an accepted offer is refused and changes nothing", async () => {
    const app = await application({ status: "OFFER" });
    const actor = await insertUser(db(), "RECRUITER");
    const result = await withTransaction((tx) => changeApplicationStatus(tx, { applicationId: app.id, toStatus: "HIRED", version: 1, actor }));
    expect(result).toEqual({ ok: false, reason: "hireNeedsAcceptedOffer", message: "Hiring needs an accepted offer." });
    expect(await row(app.id)).toMatchObject({ status: "OFFER", version: 1 });
    expect(await history(app.id)).toEqual([]);
  });

  it("R3: a reopen without a comment, or while the requisition is on hold, is refused and changes nothing", async () => {
    const actor = await insertUser(db(), "RECRUITER");
    const rejected = await application({ status: "REJECTED", reasonCode: "OTHER", dispositionedAt: new Date() });
    expect(await withTransaction((tx) => changeApplicationStatus(tx, { applicationId: rejected.id, toStatus: "SCREENING", version: 1, comment: "  ", actor }))).toMatchObject({
      ok: false,
      reason: "reopenNeedsComment",
    });
    const onHold = await application({ status: "WITHDRAWN", dispositionedAt: new Date() }, { state: "ON_HOLD" });
    expect(await withTransaction((tx) => changeApplicationStatus(tx, { applicationId: onHold.id, toStatus: "SCREENING", version: 1, comment: "Back", actor }))).toEqual({
      ok: false,
      reason: "reopenRequisitionNotApproved",
      message: "Applications can be reopened only while the requisition is approved.",
    });
    expect(await row(rejected.id)).toMatchObject({ status: "REJECTED", version: 1 });
    expect(await row(onHold.id)).toMatchObject({ status: "WITHDRAWN", version: 1 });
  });

  it("R3: a reopen works while the requisition is in re-approval", async () => {
    const app = await application({ status: "REJECTED", reasonCode: "OTHER", dispositionedAt: new Date() }, { state: "PENDING_APPROVAL" });
    expect(await move(app.id, "APPLIED", "Re-approval reopen")).toMatchObject({ status: "APPLIED" });
  });

  it("R1: moves between open statuses work while the requisition is on hold", async () => {
    const app = await application({ status: "OFFER" }, { state: "ON_HOLD" });
    expect(await move(app.id, "SCREENING")).toMatchObject({ status: "SCREENING", version: 2 });
  });

  it("refuses any change to an anonymized application", async () => {
    const app = await application({ status: "REJECTED", anonymizedAt: new Date(), firstName: null, lastName: null, email: null, emailHash: null, phone: null });
    const actor = await insertUser(db(), "RECRUITER");
    expect(await withTransaction((tx) => changeApplicationStatus(tx, { applicationId: app.id, toStatus: "SCREENING", version: 1, comment: "Back", actor }))).toEqual({
      ok: false,
      reason: "anonymized",
      message: "This application has been anonymized.",
    });
    expect(await row(app.id)).toMatchObject({ status: "REJECTED", version: 1 });
  });
});

describe("pending email cancellation", () => {
  it("R7: rejecting then moving back cancels the delayed rejection email and its job, so nothing is sent", async () => {
    await stageTemplate("REJECTED");
    const app = await application({ status: "SCREENING" });
    await move(app.id, "REJECTED");
    const [rejection] = await emails(app.id);
    expect(rejection.status).toBe("QUEUED");
    expect(await findJob(rejection.jobId!)).toMatchObject({ state: "created" });

    await move(app.id, "SCREENING", "Rejected by mistake");
    expect(await emails(app.id)).toEqual([expect.objectContaining({ id: rejection.id, status: "CANCELLED" })]);
    expect(await findJob(rejection.jobId!)).toMatchObject({ state: "cancelled" });

    await processDueJobs({ now: new Date(Date.now() + 25 * HOUR) });
    expect(await searchMessages(app.email!)).toEqual([]);
    expect((await emails(app.id))[0].status).toBe("CANCELLED");
  });

  it("R7: when the transaction fails after the cancellation, the email stays QUEUED and its job still exists", async () => {
    await stageTemplate("REJECTED");
    const app = await application({ status: "SCREENING" });
    await move(app.id, "REJECTED");
    const [rejection] = await emails(app.id);
    const actor = await insertUser(db(), "RECRUITER");

    await expect(
      withTransaction(async (tx) => {
        const result = await changeApplicationStatus(tx, { applicationId: app.id, toStatus: "SCREENING", version: 2, comment: "Back", actor });
        expect(result.ok).toBe(true);
        const [inTx] = await tx.select().from(emailLog).where(eq(emailLog.id, rejection.id));
        expect(inTx.status).toBe("CANCELLED");
        throw new Error("forced failure");
      }),
    ).rejects.toThrow("forced failure");

    expect(await emails(app.id)).toEqual([expect.objectContaining({ id: rejection.id, status: "QUEUED" })]);
    expect(await findJob(rejection.jobId!)).toMatchObject({ state: "created" });
    expect(await row(app.id)).toMatchObject({ status: "REJECTED", version: 2 });
    expect(await history(app.id)).toHaveLength(1);
  });

  it("R7: cancels the application's other queued emails too, and only that application's", async () => {
    await stageTemplate("APPLIED");
    const app = await application({ status: "WITHDRAWN", dispositionedAt: new Date() });
    const other = await application({ status: "WITHDRAWN", dispositionedAt: new Date() });
    await move(other.id, "APPLIED", "Back");
    await move(app.id, "APPLIED", "Back");
    const [acknowledgement] = await emails(app.id);
    expect(acknowledgement.status).toBe("QUEUED");

    await move(app.id, "SCREENING");
    expect(await emails(app.id)).toEqual([expect.objectContaining({ id: acknowledgement.id, status: "CANCELLED" })]);
    expect((await emails(other.id))[0].status).toBe("QUEUED");
  });
});

describe("stage emails", () => {
  it("E8: SCREENING → REJECTED queues one REJECTED email scheduled after the configured delay", async () => {
    const template = await stageTemplate("REJECTED");
    await withRejectionDelay(6, async () => {
      const app = await application({ status: "SCREENING" });
      const before = Date.now();
      await move(app.id, "REJECTED");
      const queued = await emails(app.id);
      expect(queued).toEqual([expect.objectContaining({ templateId: template.id, status: "QUEUED", audience: "CANDIDATE", recipient: app.email })]);
      expect(queued[0].scheduledFor!.getTime()).toBeGreaterThanOrEqual(before + 6 * HOUR - 1_000);
      expect(queued[0].scheduledFor!.getTime()).toBeLessThanOrEqual(Date.now() + 6 * HOUR + 1_000);
    });
  });

  it("E8: with the delay at 0 the rejection email is due immediately and is sent", async () => {
    await stageTemplate("REJECTED");
    await withRejectionDelay(0, async () => {
      const app = await application({ status: "SCREENING" });
      await move(app.id, "REJECTED");
      const [queued] = await emails(app.id);
      expect(queued.scheduledFor!.getTime()).toBeLessThanOrEqual(Date.now());
      await processDueJobs();
      expect((await emails(app.id))[0].status).not.toBe("QUEUED");
    });
  });

  it("E8: with the REJECTED template deactivated, rejecting queues nothing", async () => {
    await withoutStageTemplate("REJECTED", async () => {
      const app = await application({ status: "SCREENING" });
      await move(app.id, "REJECTED");
      expect(await emails(app.id)).toEqual([]);
    });
  });

  it("E8: with an active WITHDRAWN template, withdrawing queues it immediately", async () => {
    const template = await stageTemplate("WITHDRAWN");
    const app = await application({ status: "INTERVIEW" });
    await move(app.id, "WITHDRAWN");
    const queued = await emails(app.id);
    expect(queued).toEqual([expect.objectContaining({ templateId: template.id, status: "QUEUED" })]);
    expect(queued[0].scheduledFor!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("E8: a reopen to APPLIED sends the acknowledgement again while the APPLIED template is active", async () => {
    const template = await stageTemplate("APPLIED");
    const app = await application({ status: "REJECTED", reasonCode: "OTHER", dispositionedAt: new Date() });
    await move(app.id, "APPLIED", "Reopened");
    expect(await emails(app.id)).toEqual([expect.objectContaining({ templateId: template.id, status: "QUEUED" })]);
  });

  it("E9: moving to INTERVIEW or OFFER queues no email, even with a template for that status", async () => {
    // Inserted directly, bypassing the template validation that refuses these trigger statuses.
    await stageTemplate("INTERVIEW");
    await stageTemplate("OFFER");
    const app = await application({ status: "SCREENING" });
    await move(app.id, "INTERVIEW");
    await move(app.id, "OFFER");
    expect(await emails(app.id)).toEqual([]);
  });
});

describe("POST /api/applications/[id]/status", () => {
  it("returns 200 with the new status and version for a Recruiter and an Admin", async () => {
    const app = await application();
    const recruiter = await signedIn("RECRUITER");
    const response = await post(app.id, { toStatus: "SCREENING", version: 1 }, recruiter);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "SCREENING", version: 2 });
    expect((await history(app.id))[0].changedByUserId).toBe(recruiter.userId);

    const admin = await signedIn("ADMIN");
    const adminResponse = await post(app.id, { toStatus: "INTERVIEW", version: 2 }, admin);
    expect(await adminResponse.json()).toEqual({ status: "INTERVIEW", version: 3 });
  });

  it("returns 401 without a session, 404 for an unknown application, 400 for invalid input and 409 for a refusal", async () => {
    const app = await application();
    const recruiter = await signedIn("RECRUITER");
    expect((await post(app.id, { toStatus: "SCREENING", version: 1 })).status).toBe(401);
    expect((await post(randomUUID(), { toStatus: "SCREENING", version: 1 }, recruiter)).status).toBe(404);
    expect((await post("not-a-uuid", { toStatus: "SCREENING", version: 1 }, recruiter)).status).toBe(404);
    for (const body of [{ toStatus: "NOPE", version: 1 }, { toStatus: "SCREENING" }, { toStatus: "SCREENING", version: 1, extra: true }, "x"]) {
      expect((await post(app.id, body, recruiter)).status, JSON.stringify(body)).toBe(400);
    }
    const tooLong = await post(app.id, { toStatus: "REJECTED", version: 1, comment: "x".repeat(2_001) }, recruiter);
    expect(tooLong.status).toBe(400);
    expect((await tooLong.json()).message).toBe("Enter a comment of at most 2,000 characters.");

    const refused = await post(app.id, { toStatus: "HIRED", version: 1 }, recruiter);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "hireOnlyFromOffer", message: "Only an application in Offer with an accepted offer can be hired." });
    expect(await row(app.id)).toMatchObject({ status: "APPLIED", version: 1 });
  });

  it("returns 409 for an anonymized application", async () => {
    const app = await application({ status: "REJECTED", anonymizedAt: new Date(), firstName: null, lastName: null, email: null, emailHash: null, phone: null });
    const response = await post(app.id, { toStatus: "SCREENING", version: 1, comment: "Back" }, await signedIn("RECRUITER"));
    expect(response.status).toBe(409);
    expect((await response.json()).message).toBe("This application has been anonymized.");
  });

  it("R9: of two updates at the same version, the second returns 409 with the reload message and writes nothing", async () => {
    await stageTemplate("REJECTED");
    const app = await application({ status: "SCREENING" });
    const recruiter = await signedIn("RECRUITER");
    const responses = await Promise.all([
      post(app.id, { toStatus: "REJECTED", version: 1, comment: "First" }, recruiter),
      post(app.id, { toStatus: "REJECTED", version: 1, comment: "Second" }, recruiter),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const loser = responses.find((response) => response.status === 409)!;
    expect(await loser.json()).toEqual({ error: "stale", message: STALE });

    expect(await history(app.id)).toHaveLength(1);
    // The winner's rejection email is neither duplicated nor cancelled by the loser.
    expect(await emails(app.id)).toEqual([expect.objectContaining({ status: "QUEUED" })]);
    expect(await row(app.id)).toMatchObject({ status: "REJECTED", version: 2 });

    const late = await post(app.id, { toStatus: "SCREENING", version: 1, comment: "Late" }, recruiter);
    expect(late.status).toBe(409);
    expect((await late.json()).message).toBe(STALE);
    expect(await history(app.id)).toHaveLength(1);
    expect((await emails(app.id))[0].status).toBe("QUEUED");
  });

  it("a Hiring Manager, also the requisition's own, and an Interviewer get 403 and the application is unchanged", async () => {
    const hm = await signedIn("HIRING_MANAGER");
    const app = await application({}, { hiringManagerId: hm.userId });
    const otherHm = await signedIn("HIRING_MANAGER");
    const interviewer = await signedIn("INTERVIEWER");
    for (const session of [hm, otherHm, interviewer]) {
      const response = await post(app.id, { toStatus: "SCREENING", version: 1 }, session);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden" });
    }
    expect(await row(app.id)).toMatchObject({ status: "APPLIED", version: 1 });
    expect(await history(app.id)).toEqual([]);
  });
});
