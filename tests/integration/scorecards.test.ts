// Scorecards against the database (ats-project-scope.md I9, I10, V7, V8, V9,
// V11, F1, F2; tech-stack.md T5): through the API with real session cookies.
// Interviews are inserted directly with a start time in the past.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { GET as listScorecards } from "@/app/api/applications/[id]/scorecards/route";
import { GET as fileUrl } from "@/app/api/files/[id]/url/route";
import { PUT as saveDraft } from "@/app/api/interviews/[id]/scorecard/route";
import { DELETE as deleteNotes, PUT as putNotes } from "@/app/api/interviews/[id]/scorecard/notes/route";
import { POST as submit } from "@/app/api/interviews/[id]/scorecard/submit/route";
import { POST as reopen } from "@/app/api/scorecards/[id]/reopen/route";
import { getStorage } from "@/server/adapters/storage";
import { getApplicationFeedback } from "@/server/applications/feedback";
import { type Tx, getDb, withTransaction } from "@/server/db";
import { applications, auditLog, files, interviewParticipants, interviewScorecards, interviews } from "@/server/db/schema";
import { changeApplicationStatus } from "@/server/pipeline";
import { getScorecardPage } from "@/server/scorecards";
import { getSetting } from "@/server/settings";
import { insertApplication, insertRequisition, insertUser } from "./fixtures";
import { ORIGIN, signedIn } from "./sessions";

type Session = Awaited<ReturnType<typeof signedIn>>;
type Handler = (request: Request, context: never) => Promise<Response>;
const db = () => getDb() as unknown as Tx;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;
const json = (handler: Handler, method: string, id: string, body: unknown, session?: Session) =>
  handler(
    new Request(`${ORIGIN}/api/x/${id}`, {
      method,
      headers: { ...(session ? { cookie: session.cookie } : {}), "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    ctx(id),
  );
const get = (handler: Handler, id: string, session: Session) => handler(new Request(`${ORIGIN}/api/x/${id}`, { headers: { cookie: session.cookie } }), ctx(id));
const upload = (interviewId: string, bytes: Uint8Array, session: Session, name = "notes.pdf") => {
  const form = new FormData();
  // slice() copies into a plain ArrayBuffer, which File accepts.
  form.set("notes", new File([bytes.slice()], name, { type: "application/pdf" }));
  return putNotes(new Request(`${ORIGIN}/api/x`, { method: "PUT", headers: { cookie: session.cookie }, body: form }), ctx(interviewId));
};

const VALID_PDF = new Uint8Array(readFileSync("tests/fixtures/pdf/valid.pdf"));
const GOOD = { thumbsUp: true, overallRating: 4, comments: "Strong on systems design." };
const HOUR = 3_600_000;

/** An open application with one interview that started an hour ago and the given participants. */
async function panel(participants: string[], interview: Partial<typeof interviews.$inferInsert> = {}) {
  const requisition = await insertRequisition(db(), { state: "APPROVED", approvedAt: new Date(), isPublished: true });
  const application = await insertApplication(db(), { requisitionId: requisition.id, status: "INTERVIEW" });
  const creator = await insertUser(db(), "RECRUITER");
  const [row] = await getDb()
    .insert(interviews)
    .values({
      applicationId: application.id,
      startsAtUtc: new Date(Date.now() - HOUR),
      durationMinutes: 45,
      timezone: "Europe/Warsaw",
      locationOrLink: "Room 2",
      icsUid: `${randomUUID()}@ats`,
      createdByUserId: creator.id,
      ...interview,
    })
    .returning();
  if (participants.length) await getDb().insert(interviewParticipants).values(participants.map((userId) => ({ interviewId: row.id, userId })));
  return { application, interview: row };
}

/** A second interview on the same application. */
async function anotherInterview(applicationId: string, participants: string[]) {
  const creator = await insertUser(db(), "RECRUITER");
  const [row] = await getDb()
    .insert(interviews)
    .values({ applicationId, startsAtUtc: new Date(Date.now() - 2 * HOUR), durationMinutes: 30, timezone: "UTC", locationOrLink: "Call", icsUid: `${randomUUID()}@ats`, createdByUserId: creator.id })
    .returning();
  await getDb().insert(interviewParticipants).values(participants.map((userId) => ({ interviewId: row.id, userId })));
  return row;
}

async function scorecardOf(interviewId: string, interviewerId: string) {
  return getDb()
    .select()
    .from(interviewScorecards)
    .where(and(eq(interviewScorecards.interviewId, interviewId), eq(interviewScorecards.interviewerId, interviewerId)));
}

const visibleTo = async (applicationId: string, session: Session) => {
  const response = await get(listScorecards as Handler, applicationId, session);
  expect(response.status).toBe(200);
  return ((await response.json()).scorecards as { id: string; interviewerId: string; submittedAt: string | null }[]).map((card) => card.interviewerId);
};

describe("writing", () => {
  it("I9: submitting before the start time fails with 409", async () => {
    const a = await signedIn("INTERVIEWER");
    const { interview } = await panel([a.userId], { startsAtUtc: new Date(Date.now() + HOUR) });
    const response = await json(submit as Handler, "POST", interview.id, GOOD, a);
    expect(response.status).toBe(409);
    expect((await response.json()).message).toBe("Feedback can be given once the interview has started.");
    expect(await scorecardOf(interview.id, a.userId)).toEqual([]);
  });

  it("I9: a CANCELLED and a NO_SHOW interview get no feedback", async () => {
    const a = await signedIn("INTERVIEWER");
    for (const status of ["CANCELLED", "NO_SHOW"] as const) {
      const { interview } = await panel([a.userId], { status });
      const response = await json(submit as Handler, "POST", interview.id, GOOD, a);
      expect(response.status, status).toBe(409);
      expect((await response.json()).message).toBe("Feedback can't be given for a cancelled or no-show interview.");
    }
  });

  it("I9: one scorecard per interviewer and interview: a second save updates the draft; after submitting a save returns 409", async () => {
    const a = await signedIn("INTERVIEWER");
    const { interview } = await panel([a.userId]);
    expect((await json(saveDraft as Handler, "PUT", interview.id, { thumbsUp: false, overallRating: 2 }, a)).status).toBe(200);
    expect((await json(saveDraft as Handler, "PUT", interview.id, GOOD, a)).status).toBe(200);
    const [draft] = await scorecardOf(interview.id, a.userId);
    expect(draft).toMatchObject({ thumbsUp: true, overallRating: 4, comments: GOOD.comments, submittedAt: null });
    expect(await scorecardOf(interview.id, a.userId)).toHaveLength(1);

    const submitted = await json(submit as Handler, "POST", interview.id, GOOD, a);
    expect(submitted.status).toBe(200);
    const [row] = await scorecardOf(interview.id, a.userId);
    expect(row.submittedAt).toBeInstanceOf(Date);
    expect(row.id).toBe(draft.id);

    const again = await json(saveDraft as Handler, "PUT", interview.id, { ...GOOD, overallRating: 1 }, a);
    expect(again.status).toBe(409);
    expect((await again.json()).message).toBe("This scorecard has been submitted and can't be changed.");
    expect((await json(submit as Handler, "POST", interview.id, GOOD, a)).status).toBe(409);
    expect((await scorecardOf(interview.id, a.userId))[0].overallRating).toBe(4);
  });

  it("I9: thumbs and rating are required, comments at most 5,000 characters", async () => {
    const a = await signedIn("INTERVIEWER");
    const { interview } = await panel([a.userId]);
    const cases: [Record<string, unknown>, Record<string, string>][] = [
      [{ overallRating: 3 }, { thumbsUp: "Choose thumbs up or thumbs down." }],
      [{ thumbsUp: true }, { overallRating: "Choose a rating from 1 to 5." }],
      [{ thumbsUp: true, overallRating: 6 }, { overallRating: "Choose a rating from 1 to 5." }],
      [{ ...GOOD, comments: "x".repeat(5001) }, { comments: "Comments are at most 5,000 characters." }],
    ];
    for (const [body, fields] of cases) {
      const response = await json(submit as Handler, "POST", interview.id, body, a);
      expect(response.status).toBe(400);
      expect((await response.json()).fields).toEqual(fields);
    }
  });

  it("I9: non-participants (also a Recruiter and an Admin) and a removed participant get 403; no session 401", async () => {
    const a = await signedIn("INTERVIEWER");
    const removed = await signedIn("INTERVIEWER");
    const { interview } = await panel([a.userId, removed.userId]);
    expect((await json(saveDraft as Handler, "PUT", interview.id, GOOD, removed)).status).toBe(200);
    await getDb().update(interviewParticipants).set({ removedAt: new Date() }).where(eq(interviewParticipants.userId, removed.userId));
    for (const session of [await signedIn("INTERVIEWER"), await signedIn("RECRUITER"), await signedIn("ADMIN"), removed]) {
      expect((await json(saveDraft as Handler, "PUT", interview.id, GOOD, session)).status).toBe(403);
      expect((await json(submit as Handler, "POST", interview.id, GOOD, session)).status).toBe(403);
    }
    expect((await json(saveDraft as Handler, "PUT", interview.id, GOOD)).status).toBe(401);
    expect((await json(saveDraft as Handler, "PUT", randomUUID(), GOOD, a)).status).toBe(404);
  });

  it("F1, F2: notes that aren't a PDF or are above MAX_UPLOAD_MB are refused; a valid PDF is stored and replacing it deletes the old one", async () => {
    const a = await signedIn("INTERVIEWER");
    const { interview } = await panel([a.userId]);
    const noDraft = await upload(interview.id, VALID_PDF, a);
    expect(noDraft.status).toBe(409);
    expect((await json(saveDraft as Handler, "PUT", interview.id, GOOD, a)).status).toBe(200);

    const notPdf = await upload(interview.id, new TextEncoder().encode("just text"), a, "notes.txt");
    expect(notPdf.status).toBe(400);
    expect((await notPdf.json()).fields).toEqual({ notes: "Only PDF files are accepted." });
    const maxMb = await getSetting("MAX_UPLOAD_MB");
    const big = new Uint8Array(maxMb * 1_048_576 + 1);
    big.set(new TextEncoder().encode("%PDF-1.4\n"));
    const tooLarge = await upload(interview.id, big, a);
    expect(tooLarge.status).toBe(400);
    expect((await tooLarge.json()).fields).toEqual({ notes: `The file is larger than ${maxMb} MB.` });

    const first = await upload(interview.id, VALID_PDF, a);
    expect(first.status).toBe(200);
    const { fileId: firstId } = await first.json();
    const [scorecard] = await scorecardOf(interview.id, a.userId);
    const second = await upload(interview.id, VALID_PDF, a);
    const { fileId: secondId } = await second.json();
    const stored = await getDb().select().from(files).where(and(eq(files.ownerType, "SCORECARD"), eq(files.ownerId, scorecard.id)));
    const replaced = stored.find((file) => file.id === firstId)!;
    expect(replaced.deletedAt).toBeInstanceOf(Date);
    // Q6: the replaced blob itself is gone from storage, not only marked.
    await expect(getStorage().download(replaced.storageKey)).rejects.toThrow();
    const current = stored.find((file) => file.id === secondId)!;
    expect((await getStorage().download(current.storageKey)).length).toBe(VALID_PDF.length);
    expect(stored.find((file) => file.id === secondId)).toMatchObject({ kind: "INTERVIEW_NOTES", deletedAt: null });

    expect((await deleteNotes(new Request(`${ORIGIN}/api/x`, { method: "DELETE", headers: { cookie: a.cookie } }), ctx(interview.id))).status).toBe(200);
    const [after] = await getDb().select().from(files).where(eq(files.id, secondId));
    expect(after.deletedAt).toBeInstanceOf(Date);
  });
});

describe("visibility", () => {
  it("V7: B's scorecard is hidden from A until A submits, hidden again after an Admin reopens A's, and back after A resubmits", async () => {
    const a = await signedIn("INTERVIEWER");
    const b = await signedIn("INTERVIEWER");
    const admin = await signedIn("ADMIN");
    const { application, interview } = await panel([a.userId, b.userId]);
    expect((await json(submit as Handler, "POST", interview.id, { thumbsUp: false, overallRating: 3 }, b)).status).toBe(200);
    expect((await json(saveDraft as Handler, "PUT", interview.id, GOOD, a)).status).toBe(200);

    expect(await visibleTo(application.id, a)).toEqual([a.userId]);
    // A's draft never appears for B, although B has submitted.
    expect(await visibleTo(application.id, b)).toEqual([b.userId]);

    expect((await json(submit as Handler, "POST", interview.id, GOOD, a)).status).toBe(200);
    expect((await visibleTo(application.id, a)).sort()).toEqual([a.userId, b.userId].sort());

    const [aCard] = await scorecardOf(interview.id, a.userId);
    expect((await json(reopen as Handler, "POST", aCard.id, undefined, admin)).status).toBe(200);
    expect(await visibleTo(application.id, a)).toEqual([a.userId]);
    expect(await visibleTo(application.id, b)).toEqual([b.userId]);

    expect((await json(submit as Handler, "POST", interview.id, GOOD, a)).status).toBe(200);
    expect((await visibleTo(application.id, a)).sort()).toEqual([a.userId, b.userId].sort());
  });

  it("V7: a submitted scorecard on another interview of the same application counts; reopened-but-not-resubmitted on any blocks", async () => {
    const a = await signedIn("INTERVIEWER");
    const b = await signedIn("INTERVIEWER");
    const admin = await signedIn("ADMIN");
    const { application, interview } = await panel([a.userId, b.userId]);
    const second = await anotherInterview(application.id, [a.userId]);
    expect((await json(submit as Handler, "POST", interview.id, GOOD, b)).status).toBe(200);
    expect((await json(submit as Handler, "POST", second.id, GOOD, a)).status).toBe(200);
    expect((await visibleTo(application.id, a)).sort()).toEqual([a.userId, b.userId].sort());
    expect((await json(submit as Handler, "POST", interview.id, GOOD, a)).status).toBe(200);
    const [onSecond] = await scorecardOf(second.id, a.userId);
    expect((await json(reopen as Handler, "POST", onSecond.id, undefined, admin)).status).toBe(200);
    // A still sees both of their own scorecards, but no longer B's.
    expect(await visibleTo(application.id, a)).toEqual([a.userId, a.userId]);
  });

  it("V9, V5: a non-participant Interviewer and a Hiring Manager get 404; Recruiters see all submitted scorecards but no drafts", async () => {
    const a = await signedIn("INTERVIEWER");
    const b = await signedIn("INTERVIEWER");
    const { application, interview } = await panel([a.userId, b.userId]);
    expect((await json(submit as Handler, "POST", interview.id, GOOD, a)).status).toBe(200);
    expect((await json(saveDraft as Handler, "PUT", interview.id, GOOD, b)).status).toBe(200);
    for (const session of [await signedIn("INTERVIEWER"), await signedIn("HIRING_MANAGER")]) {
      expect((await get(listScorecards as Handler, application.id, session)).status).toBe(404);
    }
    expect(await visibleTo(application.id, await signedIn("RECRUITER"))).toEqual([a.userId]);
  });

  it("V11, V7: scorecard notes open through a signed link only for those who may see the scorecard", async () => {
    const a = await signedIn("INTERVIEWER");
    const b = await signedIn("INTERVIEWER");
    const { interview } = await panel([a.userId, b.userId]);
    expect((await json(saveDraft as Handler, "PUT", interview.id, GOOD, b)).status).toBe(200);
    const { fileId } = await (await upload(interview.id, VALID_PDF, b)).json();
    expect((await json(submit as Handler, "POST", interview.id, GOOD, b)).status).toBe(200);

    expect((await get(fileUrl as Handler, fileId, b)).status).toBe(200);
    expect((await get(fileUrl as Handler, fileId, a)).status).toBe(403);
    expect((await get(fileUrl as Handler, fileId, await signedIn("INTERVIEWER"))).status).toBe(403);
    expect((await get(fileUrl as Handler, fileId, await signedIn("RECRUITER"))).status).toBe(200);
    expect((await json(submit as Handler, "POST", interview.id, GOOD, a)).status).toBe(200);
    expect((await get(fileUrl as Handler, fileId, a)).status).toBe(200);
  });

  it("I9, V11: a draft's notes are private to their author, also from Recruiters and Admins, until it is submitted", async () => {
    const a = await signedIn("INTERVIEWER");
    const recruiter = await signedIn("RECRUITER");
    const admin = await signedIn("ADMIN");
    const { interview } = await panel([a.userId]);
    expect((await json(saveDraft as Handler, "PUT", interview.id, GOOD, a)).status).toBe(200);
    const { fileId } = await (await upload(interview.id, VALID_PDF, a)).json();
    expect((await get(fileUrl as Handler, fileId, a)).status).toBe(200);
    for (const session of [recruiter, admin]) expect((await get(fileUrl as Handler, fileId, session)).status).toBe(403);

    expect((await json(submit as Handler, "POST", interview.id, GOOD, a)).status).toBe(200);
    expect((await get(fileUrl as Handler, fileId, recruiter)).status).toBe(200);
    // Reopened and not resubmitted: private again.
    const [card] = await scorecardOf(interview.id, a.userId);
    expect((await json(reopen as Handler, "POST", card.id, undefined, admin)).status).toBe(200);
    expect((await get(fileUrl as Handler, fileId, recruiter)).status).toBe(403);
  });

  it("V8, V9: the scorecard page is 404 once access has ended: removed participant, cancelled interview, final application", async () => {
    const page = (session: Session, interviewId: string) => getScorecardPage({ id: session.userId, role: "INTERVIEWER" }, interviewId);
    const removed = await signedIn("INTERVIEWER");
    const stays = await signedIn("INTERVIEWER");
    const first = await panel([removed.userId, stays.userId]);
    expect(await page(removed, first.interview.id)).toBeDefined();
    await getDb().update(interviewParticipants).set({ removedAt: new Date() }).where(and(eq(interviewParticipants.interviewId, first.interview.id), eq(interviewParticipants.userId, removed.userId)));
    expect(await page(removed, first.interview.id)).toBeUndefined();
    expect((await page(stays, first.interview.id))?.candidate).toBeTruthy();

    const cancelled = await panel([stays.userId]);
    await getDb().update(interviews).set({ status: "CANCELLED" }).where(eq(interviews.id, cancelled.interview.id));
    expect(await page(stays, cancelled.interview.id)).toBeUndefined();

    const admin = await signedIn("ADMIN");
    for (const toStatus of ["REJECTED", "WITHDRAWN"] as const) {
      const final = await panel([stays.userId]);
      expect((await json(submit as Handler, "POST", final.interview.id, GOOD, stays)).status).toBe(200);
      const result = await withTransaction((tx) =>
        changeApplicationStatus(tx, { applicationId: final.application.id, toStatus, version: final.application.version, actor: { id: admin.userId } }),
      );
      expect(result.ok).toBe(true);
      expect(await page(stays, final.interview.id)).toBeUndefined();
    }
    const hired = await panel([stays.userId]);
    await getDb().update(applications).set({ status: "HIRED" }).where(eq(applications.id, hired.application.id));
    expect(await page(stays, hired.interview.id)).toBeUndefined();
    expect(await page(await signedIn("INTERVIEWER"), first.interview.id)).toBeUndefined();
  });
});

describe("locking and reopen", () => {
  it("V8: an Admin reopen sets reopened_at, clears submitted_at and is audited; the author edits and resubmits; a Recruiter gets 403", async () => {
    const a = await signedIn("INTERVIEWER");
    const admin = await signedIn("ADMIN");
    const { interview } = await panel([a.userId]);
    expect((await json(submit as Handler, "POST", interview.id, GOOD, a)).status).toBe(200);
    const [card] = await scorecardOf(interview.id, a.userId);
    expect((await json(reopen as Handler, "POST", card.id, undefined, await signedIn("RECRUITER"))).status).toBe(403);
    expect((await json(reopen as Handler, "POST", card.id, undefined, admin)).status).toBe(200);
    const [reopened] = await scorecardOf(interview.id, a.userId);
    expect(reopened.submittedAt).toBeNull();
    expect(reopened.reopenedAt).toBeInstanceOf(Date);
    const audits = await getDb().select().from(auditLog).where(and(eq(auditLog.action, "SCORECARD_REOPENED"), eq(auditLog.subjectId, card.id)));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorUserId: admin.userId, subjectType: "SCORECARD", detailsJson: {} });

    expect((await json(reopen as Handler, "POST", card.id, undefined, admin)).status).toBe(409);
    expect((await json(submit as Handler, "POST", interview.id, { ...GOOD, overallRating: 5 }, a)).status).toBe(200);
    const [resubmitted] = await scorecardOf(interview.id, a.userId);
    expect(resubmitted).toMatchObject({ overallRating: 5, reopenedAt: reopened.reopenedAt });
    expect(resubmitted.submittedAt).toBeInstanceOf(Date);
  });

  it("V8: after the application is rejected an unsubmitted scorecard can be neither saved nor submitted, and a submitted one can't be reopened", async () => {
    const a = await signedIn("INTERVIEWER");
    const b = await signedIn("INTERVIEWER");
    const admin = await signedIn("ADMIN");
    const { application, interview } = await panel([a.userId, b.userId]);
    expect((await json(saveDraft as Handler, "PUT", interview.id, GOOD, a)).status).toBe(200);
    expect((await json(submit as Handler, "POST", interview.id, GOOD, b)).status).toBe(200);
    const result = await withTransaction((tx) =>
      changeApplicationStatus(tx, { applicationId: application.id, toStatus: "REJECTED", version: application.version, actor: { id: admin.userId } }),
    );
    expect(result.ok).toBe(true);

    for (const [handler, method] of [
      [saveDraft, "PUT"],
      [submit, "POST"],
    ] as const) {
      const response = await json(handler as Handler, method, interview.id, GOOD, a);
      expect(response.status).toBe(409);
      expect((await response.json()).message).toBe("This application is closed, so feedback can no longer be submitted.");
    }
    const [bCard] = await scorecardOf(interview.id, b.userId);
    const refused = await json(reopen as Handler, "POST", bCard.id, undefined, admin);
    expect(refused.status).toBe(409);
    expect((await refused.json()).message).toBe("Feedback on a closed application can't be reopened, because it couldn't be submitted again.");
  });
});

describe("summary", () => {
  it("I10: ratings 4 and 5 up and 2 down plus a draft of 1 give 3.7, 2 up, 1 down; after reopening the 2 it is 4.5, 2 up, 0 down", async () => {
    const people = await Promise.all([signedIn("INTERVIEWER"), signedIn("INTERVIEWER"), signedIn("INTERVIEWER"), signedIn("INTERVIEWER")]);
    const admin = await signedIn("ADMIN");
    const { application, interview } = await panel(people.map((person) => person.userId));
    const [four, five, two, draft] = people;
    expect((await json(submit as Handler, "POST", interview.id, { thumbsUp: true, overallRating: 4 }, four)).status).toBe(200);
    expect((await json(submit as Handler, "POST", interview.id, { thumbsUp: true, overallRating: 5 }, five)).status).toBe(200);
    expect((await json(submit as Handler, "POST", interview.id, { thumbsUp: false, overallRating: 2 }, two)).status).toBe(200);
    expect((await json(saveDraft as Handler, "PUT", interview.id, { thumbsUp: false, overallRating: 1 }, draft)).status).toBe(200);

    const before = await getApplicationFeedback({ id: admin.userId, role: "ADMIN" }, application.id);
    expect(before?.summary).toEqual({ count: 3, average: "3.7", thumbsUp: 2, thumbsDown: 1 });
    const [twoCard] = await scorecardOf(interview.id, two.userId);
    expect((await json(reopen as Handler, "POST", twoCard.id, undefined, admin)).status).toBe(200);
    const after = await getApplicationFeedback({ id: admin.userId, role: "ADMIN" }, application.id);
    expect(after?.summary).toEqual({ count: 2, average: "4.5", thumbsUp: 2, thumbsDown: 0 });

    // Q3: a removed participant's and a cancelled interview's submitted scorecards still count.
    await getDb().update(interviewParticipants).set({ removedAt: new Date() }).where(eq(interviewParticipants.userId, four.userId));
    await getDb().update(interviews).set({ status: "CANCELLED" }).where(eq(interviews.id, interview.id));
    expect((await getApplicationFeedback({ id: admin.userId, role: "ADMIN" }, application.id))?.summary.count).toBe(2);
    expect(await getApplicationFeedback({ id: four.userId, role: "INTERVIEWER" }, application.id)).toBeUndefined();
  });
});
