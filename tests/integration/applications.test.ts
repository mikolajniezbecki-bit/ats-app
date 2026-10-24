// Recruiter workbench read models against the database (ats-project-scope.md
// §5.4, E4, E5, RT4, TO-01; tech-stack.md D6). Every row is new, so tests
// don't see each other's data.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getApplicationDetail, listRequisitionApplications } from "@/server/applications";
import { getConfig } from "@/server/config";
import { type Tx, getDb } from "@/server/db";
import {
  applicationHistory,
  applications,
  emailLog,
  files,
  interviewScorecards,
  interviews,
  offers,
  prescreenAnswers,
  prescreenQuestions,
} from "@/server/db/schema";
import { computeEmailHash } from "@/server/domain/apply";
import type { PolicyUser } from "@/server/policy/permissions";
import { insertApplication, insertRequisition, insertUser, offerValues } from "./fixtures";

const db = () => getDb() as unknown as Tx;
const recruiter: PolicyUser = { id: randomUUID(), role: "RECRUITER" };
const MINUTE = 60_000;

async function requisition(overrides: Parameters<typeof insertRequisition>[1] = {}) {
  return insertRequisition(db(), { state: "APPROVED", approvedAt: new Date(), isPublished: true, ...overrides });
}

/** An application whose `email_hash` is computed as apply does, so letter case doesn't matter (F7). */
async function applicationFor(requisitionId: string, email: string, overrides: Partial<typeof applications.$inferInsert> = {}) {
  return insertApplication(db(), { requisitionId, email, emailHash: computeEmailHash(email, getConfig().emailHashKey), ...overrides });
}

async function history(applicationId: string, at: Date, values: Partial<typeof applicationHistory.$inferInsert> = {}) {
  await getDb()
    .insert(applicationHistory)
    .values({ applicationId, fromStatus: null, toStatus: "APPLIED", createdAt: at, updatedAt: at, ...values });
}

async function email(applicationId: string, values: Partial<typeof emailLog.$inferInsert>) {
  const [row] = await getDb()
    .insert(emailLog)
    .values({ applicationId, audience: "CANDIDATE", recipient: "someone@example.com", subject: "Subject", bodyRendered: "<p>Body</p>", status: "SENT", ...values })
    .returning();
  return row;
}

describe("listRequisitionApplications", () => {
  it("groups applications with the same email across requisitions without merging them; another email isn't grouped", async () => {
    const first = await requisition();
    const second = await requisition();
    const address = `Group.${randomUUID()}@Example.com`;
    const onFirst = await applicationFor(first.id, address);
    const onSecond = await applicationFor(second.id, address.toLowerCase(), { status: "INTERVIEW" });
    const stranger = await applicationFor(first.id, `other-${randomUUID()}@example.com`);

    const firstList = (await listRequisitionApplications(recruiter, first.id))!;
    const row = firstList.rows.find((entry) => entry.id === onFirst.id)!;
    expect(row.alsoAppliedTo).toEqual([{ id: onSecond.id, requisitionId: second.id, reqNumber: second.reqNumber, title: second.title, status: "INTERVIEW" }]);
    expect(firstList.rows.find((entry) => entry.id === stranger.id)!.alsoAppliedTo).toEqual([]);

    const secondList = (await listRequisitionApplications(recruiter, second.id))!;
    expect(secondList.rows).toEqual([expect.objectContaining({ id: onSecond.id, alsoAppliedTo: [expect.objectContaining({ id: onFirst.id, reqNumber: first.reqNumber, status: "APPLIED" })] })]);

    // Two separate records: their own IDs, no shared candidate.
    const stored = await getDb().select().from(applications).where(eq(applications.emailHash, onFirst.emailHash!));
    expect(stored.map((entry) => entry.id).sort()).toEqual([onFirst.id, onSecond.id].sort());
    expect(stored.every((entry) => entry.candidateId === null)).toBe(true);
  });

  it("puts applications with the same email on one requisition together under a group row, newest group first", async () => {
    const job = await requisition();
    const address = `same-${randomUUID()}@example.com`;
    const now = Date.now();
    const older = await applicationFor(job.id, address, { appliedAt: new Date(now - 30 * MINUTE) });
    const middle = await applicationFor(job.id, `solo-${randomUUID()}@example.com`, { appliedAt: new Date(now - 20 * MINUTE) });
    const newer = await applicationFor(job.id, address.toUpperCase(), { appliedAt: new Date(now - 10 * MINUTE), status: "REJECTED" });
    const anonymized = await applicationFor(job.id, address, {
      appliedAt: new Date(now - 5 * MINUTE),
      anonymizedAt: new Date(),
      firstName: null,
      lastName: null,
      email: null,
      emailHash: null,
      phone: null,
    });

    const list = (await listRequisitionApplications(recruiter, job.id))!;
    expect(list.rows.map((row) => [row.id, row.groupSize, row.groupStart])).toEqual([
      [anonymized.id, 1, false],
      [newer.id, 2, true],
      [older.id, 2, false],
      [middle.id, 1, false],
    ]);
    expect(list.rows[0]).toMatchObject({ anonymized: true, email: null, alsoAppliedTo: [] });
    expect(list.counts).toEqual({ APPLIED: 3, SCREENING: 0, INTERVIEW: 0, OFFER: 0, HIRED: 0, REJECTED: 1, WITHDRAWN: 0 });
    expect(list.total).toBe(4);

    const rejected = (await listRequisitionApplications(recruiter, job.id, { status: "REJECTED" }))!;
    expect(rejected.rows.map((row) => row.id)).toEqual([newer.id]);
  });

  it("pages 50 at a time", async () => {
    const job = await requisition();
    for (let n = 0; n < 51; n++) await applicationFor(job.id, `page-${randomUUID()}@example.com`, { appliedAt: new Date(Date.now() - n * MINUTE) });
    const first = (await listRequisitionApplications(recruiter, job.id))!;
    const second = (await listRequisitionApplications(recruiter, job.id, { page: 2 }))!;
    expect([first.rows.length, first.pages, second.rows.length, second.page]).toEqual([50, 2, 1, 2]);
  });

  it("E5: a row with a FAILED email has the warning flag; others don't", async () => {
    const job = await requisition();
    const failed = await applicationFor(job.id, `failed-${randomUUID()}@example.com`);
    const fine = await applicationFor(job.id, `fine-${randomUUID()}@example.com`);
    await email(failed.id, { status: "FAILED", error: "Error: 550" });
    await email(fine.id, { status: "SENT", sentAt: new Date() });
    const list = (await listRequisitionApplications(recruiter, job.id))!;
    expect(Object.fromEntries(list.rows.map((row) => [row.id, row.hasFailedEmail]))).toEqual({ [failed.id]: true, [fine.id]: false });
  });

  it("returns nothing to a Hiring Manager or Interviewer, and nothing for an unknown requisition", async () => {
    const hm = await insertUser(db(), "HIRING_MANAGER");
    const job = await requisition({ hiringManagerId: hm.id });
    await applicationFor(job.id, `hm-${randomUUID()}@example.com`);
    const hmList = await listRequisitionApplications({ id: hm.id, role: "HIRING_MANAGER" }, job.id);
    expect(hmList?.rows ?? []).toEqual([]);
    expect(await listRequisitionApplications({ id: randomUUID(), role: "INTERVIEWER" }, job.id)).toBeUndefined();
    expect(await listRequisitionApplications(recruiter, randomUUID())).toBeUndefined();
  });
});

describe("getApplicationDetail", () => {
  it("E4: a status change, a SENT, a QUEUED delayed and a FAILED email are four entries in time order", async () => {
    const job = await requisition();
    const app = await applicationFor(job.id, `timeline-${randomUUID()}@example.com`, { status: "REJECTED" });
    const actor = await insertUser(db(), "RECRUITER");
    const t0 = Date.now() - 60 * MINUTE;
    // Inserted out of order on purpose.
    const failed = await email(app.id, { status: "FAILED", error: "Error: 550", subject: "Failed one", updatedAt: new Date(t0 + 30 * MINUTE) });
    const queued = await email(app.id, { status: "QUEUED", subject: "Rejection", scheduledFor: new Date(t0 + 24 * 60 * MINUTE), sentAt: null });
    await history(app.id, new Date(t0 + 10 * MINUTE), { fromStatus: "APPLIED", toStatus: "REJECTED", changedByUserId: actor.id, comment: "Not now", reasonCode: "OTHER" });
    const sent = await email(app.id, { status: "SENT", subject: "Sent one", sentAt: new Date(t0 + 20 * MINUTE) });

    const detail = (await getApplicationDetail(recruiter, app.id))!;
    expect(detail.timeline.map((entry) => [entry.kind, entry.id])).toEqual([
      ["history", expect.any(String)],
      ["email", sent.id],
      ["email", failed.id],
      ["email", queued.id],
    ]);
    expect(detail.timeline[0]).toMatchObject({ fromStatus: "APPLIED", toStatus: "REJECTED", changedBy: actor.name, comment: "Not now", reasonCode: "OTHER", created: false });
    expect(detail.timeline[3].at).toEqual(queued.scheduledFor);
  });

  it("E5: the FAILED email entry carries the warning and the page flag is set", async () => {
    const job = await requisition();
    const app = await applicationFor(job.id, `warn-${randomUUID()}@example.com`);
    await email(app.id, { status: "FAILED", error: "Error: 550 mailbox unavailable" });
    const detail = (await getApplicationDetail(recruiter, app.id))!;
    expect(detail.hasFailedEmail).toBe(true);
    expect(detail.timeline).toEqual([expect.objectContaining({ kind: "email", failed: true, error: "Error: 550 mailbox unavailable" })]);

    const other = await applicationFor(job.id, `ok-${randomUUID()}@example.com`);
    await email(other.id, { status: "SENT", sentAt: new Date() });
    expect((await getApplicationDetail(recruiter, other.id))!.hasFailedEmail).toBe(false);
  });

  it("an interview, a submitted scorecard and an offer appear in time order; an unsubmitted scorecard doesn't", async () => {
    const values = await offerValues(db());
    const applicationId = values.applicationId;
    const creator = await insertUser(db(), "RECRUITER");
    const interviewer = await insertUser(db(), "INTERVIEWER");
    const other = await insertUser(db(), "INTERVIEWER");
    const t0 = Date.now() - 10 * 24 * 60 * MINUTE;
    const [interview] = await getDb()
      .insert(interviews)
      .values({ applicationId, startsAtUtc: new Date(t0), durationMinutes: 45, timezone: "Europe/Warsaw", locationOrLink: "Room 1", icsUid: randomUUID(), createdByUserId: creator.id, status: "COMPLETED" })
      .returning();
    const [submitted] = await getDb()
      .insert(interviewScorecards)
      .values({ interviewId: interview.id, interviewerId: interviewer.id, overallRating: 4, thumbsUp: true, submittedAt: new Date(t0 + 2 * 60 * MINUTE) })
      .returning();
    await getDb().insert(interviewScorecards).values({ interviewId: interview.id, interviewerId: other.id, overallRating: 2, thumbsUp: false, submittedAt: null });
    const [offer] = await getDb()
      .insert(offers)
      .values({ ...values, createdAt: new Date(t0 + 24 * 60 * MINUTE), updatedAt: new Date(t0 + 24 * 60 * MINUTE) })
      .returning();
    await history(applicationId, new Date(t0 - 60 * MINUTE));

    const detail = (await getApplicationDetail(recruiter, applicationId))!;
    expect(detail.timeline.map((entry) => [entry.kind, entry.id])).toEqual([
      ["history", expect.any(String)],
      ["interview", interview.id],
      ["scorecard", submitted.id],
      ["offer", offer.id],
    ]);
    expect(detail.timeline[2]).toMatchObject({ interviewer: interviewer.name, overallRating: 4, thumbsUp: true });
    expect(detail.timeline[0]).toMatchObject({ created: true });
  });

  it("shows the CV and cover letter, marks deleted files, and lists the pre-screening answers incl. deactivated and unanswered questions", async () => {
    const job = await requisition();
    const app = await applicationFor(job.id, `docs-${randomUUID()}@example.com`);
    const file = (kind: "CV" | "COVER_LETTER", deletedAt: Date | null) => ({
      ownerType: "APPLICATION" as const,
      ownerId: app.id,
      kind,
      mime: "application/pdf",
      sizeBytes: 100,
      storageKey: `test/${randomUUID()}.pdf`,
      deletedAt,
    });
    const [cv] = await getDb().insert(files).values(file("CV", null)).returning();
    const [letter] = await getDb().insert(files).values(file("COVER_LETTER", new Date())).returning();

    const options = [
      { code: "JS", label: "JavaScript" },
      { code: "TS", label: "TypeScript" },
    ];
    const [multi] = await getDb()
      .insert(prescreenQuestions)
      .values({ requisitionId: job.id, questionText: "Languages?", questionType: "MULTI", optionsJson: options, sortOrder: 0 })
      .returning();
    const [retired] = await getDb()
      .insert(prescreenQuestions)
      .values({ requisitionId: job.id, questionText: "Old question", questionType: "TEXT", sortOrder: 1, isActive: false })
      .returning();
    const [open] = await getDb().insert(prescreenQuestions).values({ requisitionId: job.id, questionText: "Notes?", questionType: "TEXT", sortOrder: 2 }).returning();
    await getDb().insert(prescreenQuestions).values({ requisitionId: job.id, questionText: "Never shown", questionType: "TEXT", sortOrder: 3, isActive: false });
    await getDb()
      .insert(prescreenAnswers)
      .values([
        { applicationId: app.id, questionId: multi.id, answerJson: ["TS", "JS"], points: 7 },
        { applicationId: app.id, questionId: retired.id, answerJson: "<b>kept</b>", points: 0 },
      ]);

    const detail = (await getApplicationDetail(recruiter, app.id))!;
    expect(detail.documents).toEqual([
      { id: cv.id, kind: "CV", deleted: false },
      { id: letter.id, kind: "COVER_LETTER", deleted: true },
    ]);
    expect(detail.answers).toEqual([
      { questionId: multi.id, text: "Languages?", type: "MULTI", answer: ["TypeScript", "JavaScript"], answered: true, points: 7, questionActive: true },
      { questionId: retired.id, text: "Old question", type: "TEXT", answer: ["<b>kept</b>"], answered: true, points: 0, questionActive: false },
      { questionId: open.id, text: "Notes?", type: "TEXT", answer: [], answered: false, points: 0, questionActive: true },
    ]);
  });

  it("lists the candidate's other applications on any requisition", async () => {
    const address = `others-${randomUUID()}@example.com`;
    const first = await requisition();
    const second = await requisition();
    const app = await applicationFor(first.id, address);
    const sibling = await applicationFor(first.id, address);
    const elsewhere = await applicationFor(second.id, address, { status: "OFFER" });
    const detail = (await getApplicationDetail(recruiter, app.id))!;
    expect(detail.others.map((other) => other.id).sort()).toEqual([sibling.id, elsewhere.id].sort());
  });

  it("offers the targets the transition table allows, with a comment required for a reopen", async () => {
    const job = await requisition();
    const applied = await applicationFor(job.id, `targets-${randomUUID()}@example.com`);
    expect((await getApplicationDetail(recruiter, applied.id))!.targets).toEqual([
      { status: "SCREENING", needsComment: false },
      { status: "INTERVIEW", needsComment: false },
      { status: "OFFER", needsComment: false },
      { status: "REJECTED", needsComment: false },
      { status: "WITHDRAWN", needsComment: false },
    ]);
    const rejected = await applicationFor(job.id, `reopen-${randomUUID()}@example.com`, { status: "REJECTED" });
    expect((await getApplicationDetail(recruiter, rejected.id))!.targets).toEqual([
      { status: "APPLIED", needsComment: true },
      { status: "SCREENING", needsComment: true },
      { status: "INTERVIEW", needsComment: true },
      { status: "OFFER", needsComment: true },
    ]);
    const onHold = await requisition({ state: "ON_HOLD" });
    const held = await applicationFor(onHold.id, `held-${randomUUID()}@example.com`, { status: "WITHDRAWN" });
    expect((await getApplicationDetail(recruiter, held.id))!.targets).toEqual([]);
  });

  it("an anonymized application keeps status and timeline but has no documents, answers, others or targets; RT4-cleared emails are marked removed", async () => {
    const job = await requisition();
    const app = await applicationFor(job.id, `anon-${randomUUID()}@example.com`, {
      status: "REJECTED",
      anonymizedAt: new Date(),
      firstName: null,
      lastName: null,
      email: null,
      emailHash: null,
      phone: null,
    });
    await email(app.id, { status: "SENT", sentAt: new Date(), recipient: null, subject: null, bodyRendered: null });
    const detail = (await getApplicationDetail(recruiter, app.id))!;
    expect(detail).toMatchObject({ anonymized: true, documents: [], answers: [], others: [], targets: [] });
    expect(detail.application.status).toBe("REJECTED");
    expect(detail.timeline).toEqual([expect.objectContaining({ kind: "email", removed: true })]);
  });

  it("returns undefined for an unknown or malformed ID and for roles without access", async () => {
    const app = await applicationFor((await requisition()).id, `none-${randomUUID()}@example.com`);
    expect(await getApplicationDetail(recruiter, randomUUID())).toBeUndefined();
    expect(await getApplicationDetail(recruiter, "not-a-uuid")).toBeUndefined();
    expect(await getApplicationDetail({ id: randomUUID(), role: "HIRING_MANAGER" }, app.id)).toBeUndefined();
    expect(await getApplicationDetail({ id: randomUUID(), role: "INTERVIEWER" }, app.id)).toBeUndefined();
  });
});
