// Hiring Manager and Interviewer visibility through the JSON read APIs
// (ats-project-scope.md V3, V4, V5, V6, V7, V9; tech-stack.md T5): real
// session cookies, data inserted directly where the feature comes later
// (offers: tasks 35-37).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { GET as getApplication } from "@/app/api/applications/[id]/route";
import { GET as listScorecards } from "@/app/api/applications/[id]/scorecards/route";
import { POST as changeStatus } from "@/app/api/applications/[id]/status/route";
import { POST as schedule } from "@/app/api/applications/[id]/interviews/route";
import { GET as fileUrl } from "@/app/api/files/[id]/url/route";
import { POST as cancelInterview } from "@/app/api/interviews/[id]/cancel/route";
import { GET as mine } from "@/app/api/interviews/mine/route";
import { PATCH as patchInterview } from "@/app/api/interviews/[id]/route";
import { PUT as saveDraft } from "@/app/api/interviews/[id]/scorecard/route";
import { POST as submit } from "@/app/api/interviews/[id]/scorecard/submit/route";
import { GET as requisitionApplications } from "@/app/api/requisitions/[id]/applications/route";
import { POST as reopen } from "@/app/api/scorecards/[id]/reopen/route";
import { type Tx, getDb, withTransaction } from "@/server/db";
import { applicationHistory, applications, interviewParticipants, interviews, offers, prescreenAnswers, prescreenQuestions, requisitions } from "@/server/db/schema";
import { storePdf } from "@/server/files/store-pdf";
import { getScorecardPage } from "@/server/scorecards";
import { insertApplication, insertRequisition, insertUser, offerValues } from "./fixtures";
import { ORIGIN, signedIn } from "./sessions";

type Session = Awaited<ReturnType<typeof signedIn>>;
type Handler = (request: Request, context: never) => Promise<Response>;
const db = () => getDb() as unknown as Tx;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;
const call = (handler: Handler, method: string, id: string, session: Session, body?: unknown) =>
  handler(
    new Request(`${ORIGIN}/api/x/${id}`, {
      method,
      headers: { cookie: session.cookie, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    ctx(id),
  );
const get = (handler: Handler, id: string, session: Session) => call(handler, "GET", id, session);
const VALID_PDF = new Uint8Array(readFileSync("tests/fixtures/pdf/valid.pdf"));
const HOUR = 3_600_000;
const GOOD = { thumbsUp: true, overallRating: 4 };

async function cvFor(applicationId: string, kind: "CV" | "COVER_LETTER" = "CV") {
  return withTransaction((tx) => storePdf(tx, { ownerType: "APPLICATION", ownerId: applicationId, kind, originalName: "cv.pdf", bytes: VALID_PDF }));
}

async function liveRequisition(overrides: Partial<typeof requisitions.$inferInsert> = {}) {
  return insertRequisition(db(), { state: "APPROVED", approvedAt: new Date(), isPublished: true, ...overrides });
}

async function interviewOn(applicationId: string, participants: string[], startsAtUtc = new Date(Date.now() - HOUR)) {
  const creator = await insertUser(db(), "RECRUITER");
  const [row] = await getDb()
    .insert(interviews)
    .values({ applicationId, startsAtUtc, durationMinutes: 60, timezone: "Europe/Warsaw", locationOrLink: "Room 9", icsUid: `${randomUUID()}@ats`, createdByUserId: creator.id })
    .returning();
  await getDb().insert(interviewParticipants).values(participants.map((userId) => ({ interviewId: row.id, userId })));
  return row;
}

describe("Hiring Manager (V3, V4)", () => {
  it("V3: a Hiring Manager lists applications on requisitions they manage, approved or created, and gets 404 for any other", async () => {
    const hm = await signedIn("HIRING_MANAGER");
    const a = await liveRequisition({ hiringManagerId: hm.userId });
    const b = await liveRequisition({ approverId: hm.userId });
    const c = await liveRequisition({ createdByUserId: hm.userId });
    const d = await liveRequisition();
    for (const requisition of [a, b, c]) {
      const app = await insertApplication(db(), { requisitionId: requisition.id });
      const response = await get(requisitionApplications as Handler, requisition.id, hm);
      expect(response.status).toBe(200);
      expect((await response.json()).rows.map((row: { id: string }) => row.id)).toEqual([app.id]);
    }
    await insertApplication(db(), { requisitionId: d.id });
    expect((await get(requisitionApplications as Handler, d.id, hm)).status).toBe(404);
    expect((await get(requisitionApplications as Handler, a.id, await signedIn("INTERVIEWER"))).status).toBe(403);
  });

  it("V4: the full view has history with comments, submitted scorecards and the summary, offers with salary and answers; D is 404; files follow the scope", async () => {
    const hm = await signedIn("HIRING_MANAGER");
    const admin = await signedIn("ADMIN");
    const a = await liveRequisition({ hiringManagerId: hm.userId });
    const d = await liveRequisition();
    const emailHash = randomUUID();
    const app = await insertApplication(db(), { requisitionId: a.id, status: "INTERVIEW", emailHash, prescreenScore: 7 });
    const elsewhere = await insertApplication(db(), { requisitionId: d.id, emailHash });
    await getDb().insert(applicationHistory).values({ applicationId: app.id, fromStatus: "APPLIED", toStatus: "INTERVIEW", comment: "Strong portfolio, move on." });
    const [question] = await getDb().insert(prescreenQuestions).values({ requisitionId: a.id, questionText: "Years with TypeScript?", questionType: "TEXT", sortOrder: 0 }).returning();
    await getDb().insert(prescreenAnswers).values({ applicationId: app.id, questionId: question.id, answerJson: "Six years", points: 0 });
    const values = await offerValues(db());
    const [offer] = await getDb().insert(offers).values({ ...values, applicationId: app.id, salary: "98765.43" }).returning();
    const writer = await signedIn("INTERVIEWER");
    const drafter = await signedIn("INTERVIEWER");
    const interview = await interviewOn(app.id, [writer.userId, drafter.userId]);
    expect((await call(submit as Handler, "POST", interview.id, writer, GOOD)).status).toBe(200);
    expect((await call(saveDraft as Handler, "PUT", interview.id, drafter, { thumbsUp: false, overallRating: 1 })).status).toBe(200);

    const response = await get(getApplication as Handler, app.id, hm);
    expect(response.status).toBe(200);
    const view = await response.json();
    expect(view.audience).toBe("full");
    expect(view.timeline.some((entry: { kind: string; comment?: string }) => entry.kind === "history" && entry.comment === "Strong portfolio, move on.")).toBe(true);
    expect(view.feedback.scorecards.map((card: { interviewerId: string }) => card.interviewerId)).toEqual([writer.userId]);
    expect(view.feedback.summary).toEqual({ count: 1, average: "4.0", thumbsUp: 1, thumbsDown: 0 });
    expect(view.offers).toEqual([expect.objectContaining({ id: offer.id, salary: "98765.43" })]);
    expect(view.answers.map((answer: { answer: string[] }) => answer.answer)).toEqual([["Six years"]]);
    // Q4: the same candidate on D isn't linked.
    expect(view.others.map((other: { id: string }) => other.id)).not.toContain(elsewhere.id);
    expect(JSON.stringify(view)).not.toContain(elsewhere.id);

    expect((await get(getApplication as Handler, elsewhere.id, hm)).status).toBe(404);
    expect((await get(fileUrl as Handler, (await cvFor(app.id)).id, hm)).status).toBe(200);
    expect((await get(fileUrl as Handler, (await cvFor(elsewhere.id)).id, hm)).status).toBe(404);
    // Even the admin's own view of A lists D's application, proving the link exists.
    expect((await (await get(getApplication as Handler, app.id, admin)).json()).others.map((other: { id: string }) => other.id)).toContain(elsewhere.id);
  });

  it("V4: actions stay 403 for a Hiring Manager in scope: status change, interview scheduling, scorecard reopen", async () => {
    const hm = await signedIn("HIRING_MANAGER");
    const a = await liveRequisition({ hiringManagerId: hm.userId });
    const app = await insertApplication(db(), { requisitionId: a.id });
    const status = await call(changeStatus as Handler, "POST", app.id, hm, { toStatus: "SCREENING", version: app.version });
    expect(status.status).toBe(403);
    const [after] = await getDb().select().from(applications).where(eq(applications.id, app.id));
    expect(after).toMatchObject({ status: "APPLIED", version: app.version });
    const interviewer = await insertUser(db(), "INTERVIEWER");
    const year = new Date().getUTCFullYear() + 1;
    const body = { startLocal: `${year}-02-01T10:00`, timezone: "UTC", durationMinutes: 30, locationOrLink: "Call", participantIds: [interviewer.id] };
    expect((await call(schedule as Handler, "POST", app.id, hm, body)).status).toBe(403);
    expect((await call(reopen as Handler, "POST", randomUUID(), hm)).status).toBe(403);
  });
});

describe("Interviewer (V5, V6)", () => {
  /** An open application on which `interviewer` sits on one interview (with a second participant), plus a CV. */
  async function interviewed(interviewer: Session, startsAtUtc = new Date(Date.now() + 24 * HOUR)) {
    const requisition = await liveRequisition();
    const app = await insertApplication(db(), { requisitionId: requisition.id, status: "INTERVIEW" });
    const other = await insertUser(db(), "INTERVIEWER");
    const interview = await interviewOn(app.id, [interviewer.userId, other.id], startsAtUtc);
    const cv = await cvFor(app.id);
    return { app, interview, cv, other };
  }

  async function expectAccess(interviewer: Session, ids: { app: { id: string }; interview: { id: string }; cv: { id: string } }, allowed: boolean) {
    const code = allowed ? 200 : 404;
    expect((await get(getApplication as Handler, ids.app.id, interviewer)).status, "application").toBe(code);
    expect((await get(listScorecards as Handler, ids.app.id, interviewer)).status, "scorecards").toBe(code);
    expect((await get(fileUrl as Handler, ids.cv.id, interviewer)).status, "cv").toBe(code);
    const listed = (await (await mine(new Request(`${ORIGIN}/api/interviews/mine`, { headers: { cookie: interviewer.cookie } }), undefined as never)).json()).interviews;
    expect(listed.map((row: { id: string }) => row.id).includes(ids.interview.id), "my interviews").toBe(allowed);
  }

  it("V5: a participant has access; it ends when they are removed through the interview API", async () => {
    const recruiter = await signedIn("RECRUITER");
    const interviewer = await signedIn("INTERVIEWER");
    const ids = await interviewed(interviewer);
    await expectAccess(interviewer, ids, true);
    const response = await call(patchInterview as Handler, "PATCH", ids.interview.id, recruiter, { expectedSequence: 0, participantIds: [ids.other.id] });
    expect(response.status).toBe(200);
    await expectAccess(interviewer, ids, false);
  });

  it("V5: access ends when the interview is cancelled; with two interviews, cancelling one keeps it", async () => {
    const recruiter = await signedIn("RECRUITER");
    const interviewer = await signedIn("INTERVIEWER");
    const ids = await interviewed(interviewer);
    const second = await interviewOn(ids.app.id, [interviewer.userId], new Date(Date.now() + 48 * HOUR));
    expect((await call(cancelInterview as Handler, "POST", second.id, recruiter, { expectedSequence: 0 })).status).toBe(200);
    await expectAccess(interviewer, ids, true);
    expect((await call(cancelInterview as Handler, "POST", ids.interview.id, recruiter, { expectedSequence: 0 })).status).toBe(200);
    await expectAccess(interviewer, ids, false);
  });

  it("V5: access ends when the application is rejected, hired or withdrawn", async () => {
    const recruiter = await signedIn("RECRUITER");
    const interviewer = await signedIn("INTERVIEWER");
    const rejected = await interviewed(interviewer);
    const response = await call(changeStatus as Handler, "POST", rejected.app.id, recruiter, { toStatus: "REJECTED", version: rejected.app.version });
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    await expectAccess(interviewer, rejected, false);
    for (const status of ["HIRED", "WITHDRAWN"] as const) {
      const ids = await interviewed(interviewer);
      await getDb().update(applications).set({ status }).where(eq(applications.id, ids.app.id));
      await expectAccess(interviewer, ids, false);
    }
  });

  it("V5: an Interviewer who was never a participant gets 404 everywhere", async () => {
    const ids = await interviewed(await signedIn("INTERVIEWER"));
    await expectAccess(await signedIn("INTERVIEWER"), ids, false);
  });

  it("V5: a Hiring Manager participant who leaves V3a scope loses the application, the scorecard page and the scorecard save", async () => {
    const hm = await signedIn("HIRING_MANAGER");
    const requisition = await liveRequisition({ hiringManagerId: hm.userId });
    const app = await insertApplication(db(), { requisitionId: requisition.id, status: "INTERVIEW" });
    const interview = await interviewOn(app.id, [hm.userId]);
    const policyUser = { id: hm.userId, role: "HIRING_MANAGER" as const };
    expect((await get(getApplication as Handler, app.id, hm)).status).toBe(200);
    expect(await getScorecardPage(policyUser, interview.id)).toBeDefined();
    expect((await call(saveDraft as Handler, "PUT", interview.id, hm, GOOD)).status).toBe(200);

    await getDb().update(requisitions).set({ hiringManagerId: (await insertUser(db(), "HIRING_MANAGER")).id }).where(eq(requisitions.id, requisition.id));
    expect((await get(getApplication as Handler, app.id, hm)).status).toBe(404);
    expect(await getScorecardPage(policyUser, interview.id)).toBeUndefined();
    expect((await call(saveDraft as Handler, "PUT", interview.id, hm, GOOD)).status).toBe(404);
    expect((await call(submit as Handler, "POST", interview.id, hm, GOOD)).status).toBe(404);
  });

  it("V6: the Interviewer's JSON has only the allowlist: no salary, offer, answers, score, comments, other applications or hash; the offer letter is 404", async () => {
    const interviewer = await signedIn("INTERVIEWER");
    const ids = await interviewed(interviewer);
    const emailHash = `hash-${randomUUID()}`;
    await getDb().update(applications).set({ emailHash, prescreenScore: 42 }).where(eq(applications.id, ids.app.id));
    const [requisition] = await getDb().select({ id: applications.requisitionId }).from(applications).where(eq(applications.id, ids.app.id));
    const [question] = await getDb().insert(prescreenQuestions).values({ requisitionId: requisition.id, questionText: "Favourite stack?", questionType: "TEXT", sortOrder: 0 }).returning();
    await getDb().insert(prescreenAnswers).values({ applicationId: ids.app.id, questionId: question.id, answerJson: "Answer-7f3a-distinct", points: 0 });
    await getDb().insert(applicationHistory).values({ applicationId: ids.app.id, fromStatus: "SCREENING", toStatus: "INTERVIEW", comment: "Comment-9c1b-distinct" });
    const values = await offerValues(db());
    const [offer] = await getDb().insert(offers).values({ ...values, applicationId: ids.app.id, salary: "98765.43" }).returning();
    const letter = await withTransaction((tx) => storePdf(tx, { ownerType: "OFFER", ownerId: offer.id, kind: "OFFER_LETTER", originalName: "offer.pdf", bytes: VALID_PDF }));
    const elsewhere = await insertApplication(db(), { requisitionId: (await liveRequisition()).id, emailHash });

    const response = await get(getApplication as Handler, ids.app.id, interviewer);
    expect(response.status).toBe(200);
    const view = await response.json();
    expect(view.audience).toBe("interviewer");
    expect(Object.keys(view).sort()).toEqual(["application", "audience", "documents", "interviews", "requisition", "scorecards"]);
    expect(Object.keys(view.application).sort()).toEqual(["email", "firstName", "id", "lastName", "phone"]);
    const text = JSON.stringify(view);
    for (const forbidden of ["98765.43", offer.id, "Answer-7f3a-distinct", "prescreenScore", "isDisqualified", "Comment-9c1b-distinct", elsewhere.id, emailHash, "emailHash", "status\":\"INTERVIEW"]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    expect(view.documents.map((file: { id: string }) => file.id)).toEqual([ids.cv.id]);
    expect(view.interviews.map((interview: { id: string }) => interview.id)).toEqual([ids.interview.id]);
    expect((await get(fileUrl as Handler, letter.id, interviewer)).status).toBe(404);
  });
});
