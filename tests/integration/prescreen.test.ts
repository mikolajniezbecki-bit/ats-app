// Pre-screening questions against the database (ats-project-scope.md §5.3,
// L3, L8, V4, V6; T5): the service, and the API with real session cookies.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { DELETE, PATCH } from "@/app/api/requisitions/[id]/questions/[qid]/route";
import { PUT } from "@/app/api/requisitions/[id]/questions/order/route";
import { GET, POST } from "@/app/api/requisitions/[id]/questions/route";
import { type Tx, getDb } from "@/server/db";
import { prescreenAnswers, prescreenQuestions, requisitions } from "@/server/db/schema";
import type { PolicyUser } from "@/server/policy/permissions";
import { createQuestion, deleteQuestion, listQuestionRows, reorderQuestions, updateQuestion } from "@/server/prescreen";
import { createRequisition, duplicateValues } from "@/server/requisitions";
import { insertApplication, insertRequisition, insertUser } from "./fixtures";
import { rolledBack } from "./helpers";
import { ORIGIN, signedIn } from "./sessions";

const yesNo = { questionText: "Do you have a work permit?", questionType: "YES_NO", weight: 10, scoringAnswer: "YES", disqualifyingAnswer: "NO" };
const textQuestion = { questionText: "Anything else?", questionType: "TEXT" };

async function actor(tx: Tx, role: PolicyUser["role"] = "RECRUITER"): Promise<PolicyUser> {
  return { id: (await insertUser(tx, role)).id, role, isActive: true };
}

async function added(tx: Tx, user: PolicyUser, requisitionId: string, input: Record<string, unknown> = yesNo) {
  const result = await createQuestion(tx, user, requisitionId, input);
  if (!result.ok || !result.question) throw new Error(JSON.stringify(result));
  return result.question;
}

async function answer(tx: Tx, requisitionId: string, questionId: string) {
  const application = await insertApplication(tx, { requisitionId });
  await tx.insert(prescreenAnswers).values({ applicationId: application.id, questionId, answerJson: "YES", points: 10 });
}

describe("questions service", () => {
  it("adds questions in order, with YES_NO options set by the server", async () => {
    await rolledBack(async (tx) => {
      const user = await actor(tx);
      const requisition = await insertRequisition(tx);
      const first = await added(tx, user, requisition.id);
      const second = await added(tx, user, requisition.id, textQuestion);
      expect(first).toMatchObject({ sortOrder: 0, optionsJson: [{ code: "YES", label: "Yes" }, { code: "NO", label: "No" }], isActive: true });
      expect(second).toMatchObject({ sortOrder: 1, weight: 0, scoringAnswer: null, disqualifyingAnswer: null });
      const reordered = await reorderQuestions(tx, user, requisition.id, { questionIds: [second.id, first.id] });
      expect(reordered.ok && reordered.questions?.map((q) => q.id)).toEqual([second.id, first.id]);
      expect(await reorderQuestions(tx, user, requisition.id, { questionIds: [first.id] })).toEqual({ ok: false, reason: "badOrder" });
      expect(await reorderQuestions(tx, user, requisition.id, { questionIds: [first.id, first.id] })).toEqual({ ok: false, reason: "badOrder" });
    });
  });

  it("at most 50 questions per requisition", async () => {
    await rolledBack(async (tx) => {
      const user = await actor(tx);
      const requisition = await insertRequisition(tx);
      await tx.insert(prescreenQuestions).values(
        Array.from({ length: 50 }, (_, i) => ({ requisitionId: requisition.id, questionText: `Q${i}`, questionType: "TEXT" as const, sortOrder: i })),
      );
      expect(await createQuestion(tx, user, requisition.id, textQuestion)).toEqual({ ok: false, reason: "tooMany" });
    });
  });

  it("questions change in DRAFT, APPROVED, ON_HOLD and re-approval; not in first-approval PENDING_APPROVAL or CLOSED", async () => {
    await rolledBack(async (tx) => {
      const user = await actor(tx);
      const approvedAt = new Date();
      const allowed = [
        { state: "DRAFT" as const },
        { state: "APPROVED" as const, approvedAt },
        { state: "ON_HOLD" as const, approvedAt },
        { state: "PENDING_APPROVAL" as const, approvedAt },
      ];
      for (const fixture of allowed) {
        const requisition = await insertRequisition(tx, fixture);
        expect((await createQuestion(tx, user, requisition.id, yesNo)).ok, fixture.state).toBe(true);
      }
      for (const fixture of [{ state: "PENDING_APPROVAL" as const }, { state: "CLOSED" as const, approvedAt, closeReason: "CANCELLED" as const }]) {
        const requisition = await insertRequisition(tx, fixture);
        expect(await createQuestion(tx, user, requisition.id, yesNo), fixture.state).toEqual({ ok: false, reason: "stateLocked" });
      }
    });
  });

  it("a Hiring Manager changes questions only on drafts they created", async () => {
    await rolledBack(async (tx) => {
      const hm = await actor(tx, "HIRING_MANAGER");
      const own = await insertRequisition(tx, { createdByUserId: hm.id });
      expect((await createQuestion(tx, hm, own.id, yesNo)).ok).toBe(true);
      const managed = await insertRequisition(tx, { hiringManagerId: hm.id });
      expect(await createQuestion(tx, hm, managed.id, yesNo)).toEqual({ ok: false, reason: "forbidden" });
      const ownApproved = await insertRequisition(tx, { createdByUserId: hm.id, state: "APPROVED", approvedAt: new Date() });
      expect(await createQuestion(tx, hm, ownApproved.id, yesNo)).toEqual({ ok: false, reason: "forbidden" });
      const outside = await insertRequisition(tx);
      expect(await createQuestion(tx, hm, outside.id, yesNo)).toEqual({ ok: false, reason: "notFound" });
    });
  });

  it("an unanswered question is fully editable and is deleted for real", async () => {
    await rolledBack(async (tx) => {
      const user = await actor(tx);
      const requisition = await insertRequisition(tx);
      const question = await added(tx, user, requisition.id);
      expect(await updateQuestion(tx, user, requisition.id, question.id, { weight: 20 })).toMatchObject({ ok: true, question: { weight: 20 } });
      expect(
        await updateQuestion(tx, user, requisition.id, question.id, {
          questionType: "SINGLE",
          options: [{ code: "A", label: "A" }, { code: "B", label: "B" }],
          weight: 0,
          scoringAnswer: null,
          disqualifyingAnswer: null,
        }),
      ).toMatchObject({ ok: true, question: { questionType: "SINGLE" } });
      expect((await deleteQuestion(tx, user, requisition.id, question.id)).ok).toBe(true);
      expect(await listQuestionRows(requisition.id, tx)).toEqual([]);
    });
  });

  it("L3: an answered question can't be deleted (409)", async () => {
    await rolledBack(async (tx) => {
      const user = await actor(tx);
      const requisition = await insertRequisition(tx);
      const question = await added(tx, user, requisition.id);
      await answer(tx, requisition.id, question.id);
      expect(await deleteQuestion(tx, user, requisition.id, question.id)).toEqual({ ok: false, reason: "answered" });
      expect(await listQuestionRows(requisition.id, tx)).toHaveLength(1);
    });
  });

  it("L3: changing an answered question's weight returns 409 and the weight is unchanged", async () => {
    await rolledBack(async (tx) => {
      const user = await actor(tx);
      const requisition = await insertRequisition(tx);
      const question = await added(tx, user, requisition.id);
      await answer(tx, requisition.id, question.id);
      expect(await updateQuestion(tx, user, requisition.id, question.id, { weight: 50 })).toEqual({ ok: false, reason: "answered" });
      for (const change of [{ questionType: "TEXT", options: [], weight: 0, scoringAnswer: null, disqualifyingAnswer: null }, { disqualifyingAnswer: null }, { scoringAnswer: "NO", disqualifyingAnswer: "YES" }]) {
        expect(await updateQuestion(tx, user, requisition.id, question.id, change), JSON.stringify(change)).toEqual({ ok: false, reason: "answered" });
      }
      const [stored] = await tx.select().from(prescreenQuestions).where(eq(prescreenQuestions.id, question.id));
      expect(stored).toMatchObject({ weight: 10, scoringAnswer: "YES", disqualifyingAnswer: "NO" });
    });
  });

  it("L3: an answered question can be deactivated and its text corrected", async () => {
    await rolledBack(async (tx) => {
      const user = await actor(tx);
      const requisition = await insertRequisition(tx);
      const question = await added(tx, user, requisition.id);
      await answer(tx, requisition.id, question.id);
      expect(await updateQuestion(tx, user, requisition.id, question.id, { isActive: false })).toMatchObject({ ok: true, question: { isActive: false } });
      expect(await updateQuestion(tx, user, requisition.id, question.id, { questionText: "Do you hold a work permit?" })).toMatchObject({ ok: true });
    });
  });

  it("L3: a new question can be added next to an answered one, and an unanswered one deleted", async () => {
    await rolledBack(async (tx) => {
      const user = await actor(tx);
      const requisition = await insertRequisition(tx);
      const answered = await added(tx, user, requisition.id);
      const unanswered = await added(tx, user, requisition.id, textQuestion);
      await answer(tx, requisition.id, answered.id);
      expect((await createQuestion(tx, user, requisition.id, textQuestion)).ok).toBe(true);
      expect((await deleteQuestion(tx, user, requisition.id, unanswered.id)).ok).toBe(true);
    });
  });

  it("a question of another requisition is not found", async () => {
    await rolledBack(async (tx) => {
      const user = await actor(tx);
      const a = await insertRequisition(tx);
      const b = await insertRequisition(tx);
      const question = await added(tx, user, a.id);
      expect(await updateQuestion(tx, user, b.id, question.id, { weight: 1 })).toEqual({ ok: false, reason: "notFound" });
      expect(await deleteQuestion(tx, user, b.id, question.id)).toEqual({ ok: false, reason: "notFound" });
    });
  });
});

describe("duplicate", () => {
  it("saving a duplicate copies the source's active questions in order", async () => {
    await rolledBack(async (tx) => {
      const user = await actor(tx);
      const source = await insertRequisition(tx, { hiringManagerId: (await insertUser(tx, "HIRING_MANAGER")).id });
      await added(tx, user, source.id, { ...yesNo, questionText: "First" });
      const inactive = await added(tx, user, source.id, { ...textQuestion, questionText: "Inactive" });
      await added(tx, user, source.id, { questionText: "Third", questionType: "MULTI", options: [{ code: "A", label: "A" }, { code: "B", label: "B" }], weight: 3, scoringAnswer: ["A"] });
      await updateQuestion(tx, user, source.id, inactive.id, { isActive: false });

      const values = await duplicateValues(user, source.id, tx);
      const result = await createRequisition(tx, user, { ...values, duplicateOfId: source.id });
      if (!result.ok) throw new Error(JSON.stringify(result));
      const copied = await listQuestionRows(result.requisition.id, tx);
      expect(copied.map((q) => [q.questionText, q.sortOrder, q.isActive])).toEqual([
        ["First", 0, true],
        ["Third", 1, true],
      ]);
      expect(copied[1]).toMatchObject({ questionType: "MULTI", weight: 3, scoringAnswer: ["A"] });
    });
  });
});

describe("questions API", () => {
  const request = (method: string, path: string, body: unknown, cookie: string) =>
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const ctx = (id: string, qid?: string) => ({ params: Promise.resolve(qid ? { id, qid } : { id }) }) as never;

  it("a Hiring Manager in scope reads the questions (V4 pre-screening data); one outside gets 404; an Interviewer gets 403", async () => {
    const hm = await signedIn("HIRING_MANAGER");
    const db = getDb() as unknown as Tx;
    const inScope = await insertRequisition(db, { hiringManagerId: hm.userId });
    const outside = await insertRequisition(db);
    const recruiter = await signedIn("RECRUITER");
    const created = await POST(request("POST", "/q", yesNo, recruiter.cookie), ctx(inScope.id));
    expect(created.status).toBe(201);

    const read = await GET(request("GET", "/q", undefined, hm.cookie), ctx(inScope.id));
    expect(read.status).toBe(200);
    expect((await read.json()).questions).toHaveLength(1);
    expect((await GET(request("GET", "/q", undefined, hm.cookie), ctx(outside.id))).status).toBe(404);
    const interviewer = await signedIn("INTERVIEWER");
    expect((await GET(request("GET", "/q", undefined, interviewer.cookie), ctx(inScope.id))).status).toBe(403);
  });

  it("returns 400 with field texts, 409 for locked states and answered questions", async () => {
    const { cookie } = await signedIn("RECRUITER");
    const db = getDb() as unknown as Tx;
    const requisition = await insertRequisition(db);
    const bad = await POST(request("POST", "/q", { questionText: "Q", questionType: "TEXT", weight: 5 }, cookie), ctx(requisition.id));
    expect(bad.status).toBe(400);
    expect((await bad.json()).fields).toEqual({ weight: "Text questions always have weight 0." });
    const noAnswer = await POST(request("POST", "/q", { questionText: "Q", questionType: "YES_NO", weight: 5 }, cookie), ctx(requisition.id));
    expect((await noAnswer.json()).fields).toEqual({ weight: "Set a weight above 0 or remove the scoring answer." });

    const { question } = await (await POST(request("POST", "/q", yesNo, cookie), ctx(requisition.id))).json();
    await answer(db, requisition.id, question.id);
    const del = await DELETE(request("DELETE", "/q", undefined, cookie), ctx(requisition.id, question.id));
    expect(del.status).toBe(409);
    expect((await del.json()).message).toBe("This question has answers and can only be deactivated.");
    const order = await PUT(request("PUT", "/q", { questionIds: [randomUUID()] }, cookie), ctx(requisition.id));
    expect(order.status).toBe(400);

    await getDb().update(requisitions).set({ state: "PENDING_APPROVAL" }).where(eq(requisitions.id, requisition.id));
    const locked = await PATCH(request("PATCH", "/q", { isActive: false }, cookie), ctx(requisition.id, question.id));
    expect(locked.status).toBe(409);
    expect((await locked.json()).message).toBe("Pre-screening questions can't be changed in the current state.");
  });
});
