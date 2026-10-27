// The retention purge against the database, pg-boss and Azurite
// (ats-project-scope.md §5.8 RT1–RT5, F8; tech-stack.md J2, D7, T3). The
// purge acts on the whole worker database, so every run uses the real
// clock with RETENTION_DAYS = 30 and fixtures dated relative to it: rows
// other files create are dispositioned "now" and stay out of range. Tests
// assert only on their own rows.
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as changeStatus } from "@/app/api/applications/[id]/status/route";
import { getBoss } from "@/server/adapters/job-queue";
import { type StorageService, getStorage } from "@/server/adapters/storage";
import { type Tx, getDb, withTransaction } from "@/server/db";
import {
  applicationHistory,
  applications,
  approvalEvents,
  auditLog,
  emailLog,
  files,
  interviewScorecards,
  interviews,
  jobRuns,
  offers,
  prescreenAnswers,
  prescreenQuestions,
  rateLimits,
  settings,
  templates,
} from "@/server/db/schema";
import { queueEmail } from "@/server/email";
import { purgeApplication, retentionPurgeTask, runRetentionPurge } from "@/server/retention";
import { dailyTaskHandler } from "@/worker/daily-task";
import { insertApplication, insertRequisition, insertUser } from "./fixtures";
import { unique } from "./helpers";
import { ORIGIN, signedIn } from "./sessions";

const db = () => getDb() as unknown as Tx;
const DAY = 86_400_000;
const daysAgo = (now: Date, days: number) => new Date(now.getTime() - days * DAY);
const PDF = new TextEncoder().encode("%PDF-1.4 synthetic retention test file");

beforeAll(async () => {
  await getDb().insert(settings).values({ key: "RETENTION_DAYS", value: "30" }).onConflictDoUpdate({ target: settings.key, set: { value: "30" } });
});
afterAll(async () => {
  await getDb().delete(settings).where(eq(settings.key, "RETENTION_DAYS"));
});

async function app(id: string) {
  const [row] = await getDb().select().from(applications).where(eq(applications.id, id));
  return row;
}

/** A final application on its own requisition, dispositioned `days` before `now`. */
async function finalApplication(now: Date, days: number, overrides: Partial<typeof applications.$inferInsert> = {}) {
  const requisition = await insertRequisition(db(), { state: "APPROVED", approvedAt: daysAgo(now, 90), openingsCount: 5 });
  return insertApplication(db(), { requisitionId: requisition.id, status: "REJECTED", reasonCode: "OTHER", dispositionedAt: daysAgo(now, days), appliedAt: daysAgo(now, days + 10), ...overrides });
}

/** A stored blob and its files row. */
async function storedFile(ownerType: "APPLICATION" | "SCORECARD" | "OFFER", ownerId: string, kind: "CV" | "COVER_LETTER" | "INTERVIEW_NOTES" | "OFFER_LETTER") {
  const { key } = await getStorage().upload(PDF, "application/pdf");
  const [row] = await getDb()
    .insert(files)
    .values({ ownerType, ownerId, kind, mime: "application/pdf", sizeBytes: PDF.length, originalName: `${kind.toLowerCase()}-Kowalski.pdf`, storageKey: key })
    .returning();
  return row;
}

async function blobExists(key: string): Promise<boolean> {
  try {
    await getStorage().download(key);
    return true;
  } catch {
    return false;
  }
}

describe("selection (RT1, RT2)", () => {
  it("RT1: final applications past the period are anonymized; at the limit, inside it, open, reopened and unexported hires are not", async () => {
    const now = new Date();
    const rejected = await finalApplication(now, 31);
    const withdrawn = await finalApplication(now, 31, { status: "WITHDRAWN", reasonCode: null });
    const atLimit = await finalApplication(now, 30);
    const inside = await finalApplication(now, 29);
    const open = await Promise.all(
      (["APPLIED", "SCREENING", "INTERVIEW", "OFFER"] as const).map((status) =>
        finalApplication(now, 400, { status, reasonCode: null, dispositionedAt: null, appliedAt: daysAgo(now, 400) }),
      ),
    );
    const reopened = await finalApplication(now, 31, { status: "SCREENING", reasonCode: null, dispositionedAt: null });

    const summary = await runRetentionPurge({ now });
    expect(summary.failed).toBe(0);
    for (const row of [rejected, withdrawn]) expect((await app(row.id)).anonymizedAt, row.status).toEqual(now);
    for (const row of [atLimit, inside, ...open, reopened]) expect((await app(row.id)).anonymizedAt, `${row.status} ${row.dispositionedAt}`).toBeNull();
  });

  it("RT2: a hire is purged only after export; R4 corrections count from the correction, and one back to OFFER is never purged", async () => {
    const now = new Date();
    const unexported = await finalApplication(now, 31, { status: "HIRED", reasonCode: null, hiredAt: daysAgo(now, 31) });
    const exported = await finalApplication(now, 31, { status: "HIRED", reasonCode: null, hiredAt: daysAgo(now, 31), exportedAt: daysAgo(now, 30) });
    // Hired long ago, corrected by R4 (exported_at cleared, R11 dates set at the correction).
    const correctedRecently = await finalApplication(now, 5, { status: "REJECTED", hiredAt: null, exportedAt: null });
    const correctedToOffer = await finalApplication(now, 0, { status: "OFFER", reasonCode: null, dispositionedAt: null, hiredAt: null, exportedAt: null, appliedAt: daysAgo(now, 300) });

    await runRetentionPurge({ now });
    expect((await app(unexported.id)).anonymizedAt).toBeNull();
    expect((await app(exported.id)).anonymizedAt).toEqual(now);
    expect((await app(correctedRecently.id)).anonymizedAt).toBeNull();
    expect((await app(correctedToOffer.id)).anonymizedAt).toBeNull();

    // 26 days later the correction is past the period.
    const later = new Date(now.getTime() + 26 * DAY);
    await runRetentionPurge({ now: later });
    expect((await app(correctedRecently.id)).anonymizedAt).toEqual(later);
    expect((await app(correctedToOffer.id)).anonymizedAt).toBeNull();
  });
});

describe("anonymization (RT3, RT4, F8)", () => {
  async function fullFixture(now: Date) {
    const application = await finalApplication(now, 31, { prescreenScore: 7, isDisqualified: false });
    const other = await finalApplication(now, 1);
    const staff = await insertUser(db(), "INTERVIEWER");
    const approver = await insertUser(db(), "HIRING_MANAGER");

    const questions = await getDb()
      .insert(prescreenQuestions)
      .values([1, 2].map((n) => ({ requisitionId: application.requisitionId, questionText: `Question ${n}`, questionType: "TEXT" as const, sortOrder: n })))
      .returning();
    await getDb().insert(prescreenAnswers).values(questions.map((question) => ({ applicationId: application.id, questionId: question.id, answerJson: "My answer, Kowalski" })));
    await getDb().insert(applicationHistory).values({ applicationId: application.id, fromStatus: "SCREENING", toStatus: "REJECTED", comment: "Jan Kowalski wasn't a fit", reasonCode: "OTHER" });

    const [interview] = await getDb()
      .insert(interviews)
      .values({ applicationId: application.id, startsAtUtc: daysAgo(now, 40), durationMinutes: 60, timezone: "Europe/Warsaw", locationOrLink: "Room 1", icsUid: unique("ics"), createdByUserId: staff.id })
      .returning();
    const [scorecard] = await getDb()
      .insert(interviewScorecards)
      .values({ interviewId: interview.id, interviewerId: staff.id, overallRating: 4, thumbsUp: true, comments: "Strong, mentions Kowalski family", submittedAt: daysAgo(now, 39) })
      .returning();

    const [template] = await getDb().insert(templates).values({ type: "OFFER", name: unique("Offer"), body: "Letter" }).returning();
    const [offer] = await getDb()
      .insert(offers)
      .values({ applicationId: application.id, templateId: template.id, createdByUserId: approver.id, approverId: approver.id, jobTitle: "Backend Engineer", salary: "85000.00", currency: "EUR", startDate: "2027-01-15", approvalStatus: "WITHDRAWN" })
      .returning();
    const [approval] = await getDb().insert(approvalEvents).values({ subjectType: "OFFER", subjectId: offer.id, event: "REJECTED", actorUserId: approver.id, comment: "Too high for Kowalski" }).returning();
    const [requisitionApproval] = await getDb().insert(approvalEvents).values({ subjectType: "REQUISITION", subjectId: application.requisitionId, event: "APPROVED", actorUserId: approver.id, comment: "Fine" }).returning();

    const cv = await storedFile("APPLICATION", application.id, "CV");
    const cover = await storedFile("APPLICATION", application.id, "COVER_LETTER");
    const notes = await storedFile("SCORECARD", scorecard.id, "INTERVIEW_NOTES");
    const letter = await storedFile("OFFER", offer.id, "OFFER_LETTER");

    const queued = await withTransaction(async (tx) => ({
      invite: await queueEmail(tx, {
        to: "interviewer@example.com",
        audience: "STAFF",
        applicationId: application.id,
        subject: "Interview with Jan Kowalski",
        body: "See you",
        ics: { content: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", method: "REQUEST", uid: interview.icsUid, sequence: 0 },
        startAfter: new Date(now.getTime() + DAY),
      }),
      rejection: await queueEmail(tx, { to: application.email!, audience: "CANDIDATE", applicationId: application.id, subject: "About your application", body: "Dear Jan", startAfter: new Date(now.getTime() + DAY) }),
      offerApproval: await queueEmail(tx, { to: "approver@example.com", audience: "STAFF", applicationId: application.id, subject: "Offer for Jan Kowalski", body: "Please approve", startAfter: new Date(now.getTime() + DAY) }),
      requisitionEmail: await queueEmail(tx, { to: "approver@example.com", audience: "STAFF", requisitionId: application.requisitionId, subject: "Requisition approval", body: "Please approve", startAfter: new Date(now.getTime() + DAY) }),
      otherEmail: await queueEmail(tx, { to: other.email!, audience: "CANDIDATE", applicationId: other.id, subject: "Other candidate", body: "Hello", startAfter: new Date(now.getTime() + DAY) }),
    }));
    const [sent] = await getDb()
      .insert(emailLog)
      .values({ applicationId: application.id, audience: "CANDIDATE", recipient: application.email, subject: "Thanks Jan", bodyRendered: "Dear Jan Kowalski", status: "SENT", sentAt: daysAgo(now, 35) })
      .returning();
    const [failed] = await getDb()
      .insert(emailLog)
      .values({ applicationId: application.id, audience: "CANDIDATE", recipient: application.email, subject: "Bounce", bodyRendered: "Body", status: "FAILED", error: `550 ${application.email} unknown` })
      .returning();
    // The offer email of the letter, already sent: attachment IDs stay.
    await getDb().insert(emailLog).values({ applicationId: application.id, audience: "CANDIDATE", recipient: application.email, subject: "Your offer", bodyRendered: "Attached", status: "SENT", attachmentFileIds: [letter.id] });

    return { application, other, offer, scorecard, approval, requisitionApproval, files: [cv, cover, notes, letter], queued, sent, failed };
  }

  it("RT3: personal fields, answers, comments, email content and files are removed; status, score, timestamps and offer terms stay", async () => {
    const now = new Date();
    const f = await fullFixture(now);
    const before = await app(f.application.id);

    const summary = await runRetentionPurge({ now });
    expect(summary.failed).toBe(0);

    const after = await app(f.application.id);
    expect(after).toMatchObject({ firstName: null, lastName: null, email: null, emailHash: null, phone: null, anonymizedAt: now, version: before.version + 1 });
    expect(after).toMatchObject({
      status: before.status,
      reasonCode: before.reasonCode,
      prescreenScore: before.prescreenScore,
      isDisqualified: before.isDisqualified,
      appliedAt: before.appliedAt,
      dispositionedAt: before.dispositionedAt,
      consentAcceptedAt: before.consentAcceptedAt,
      consentVersion: before.consentVersion,
    });
    expect(await getDb().select().from(prescreenAnswers).where(eq(prescreenAnswers.applicationId, f.application.id))).toEqual([]);
    const history = await getDb().select().from(applicationHistory).where(eq(applicationHistory.applicationId, f.application.id));
    expect(history.every((row) => row.comment === null)).toBe(true);
    const [scorecard] = await getDb().select().from(interviewScorecards).where(eq(interviewScorecards.id, f.scorecard.id));
    expect(scorecard).toMatchObject({ comments: null, overallRating: 4, thumbsUp: true });
    const [offer] = await getDb().select().from(offers).where(eq(offers.id, f.offer.id));
    expect(offer).toMatchObject({ jobTitle: "Backend Engineer", salary: "85000.00", currency: "EUR", startDate: "2027-01-15" });
    const [approval] = await getDb().select().from(approvalEvents).where(eq(approvalEvents.id, f.approval.id));
    expect(approval.comment).toBeNull();
    const [requisitionApproval] = await getDb().select().from(approvalEvents).where(eq(approvalEvents.id, f.requisitionApproval.id));
    expect(requisitionApproval.comment).toBe("Fine");

    const audit = await getDb().select().from(auditLog).where(and(eq(auditLog.action, "APPLICATION_ANONYMIZED"), eq(auditLog.subjectId, f.application.id)));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorUserId: null, subjectType: "APPLICATION", detailsJson: { filesDeleted: 4, emailsCancelled: 3 } });
  });

  it("RT4: queued emails and their jobs are cancelled and every email row of the application loses its content; others are unchanged", async () => {
    const now = new Date();
    const f = await fullFixture(now);
    await runRetentionPurge({ now });

    const rows = await getDb().select().from(emailLog).where(eq(emailLog.applicationId, f.application.id));
    expect(rows).toHaveLength(6);
    for (const row of rows) expect(row, row.id).toMatchObject({ recipient: null, cc: null, subject: null, bodyRendered: null, icsContent: null, error: null });
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    for (const id of [f.queued.invite, f.queued.rejection, f.queued.offerApproval]) {
      expect(byId[id].status).toBe("CANCELLED");
      const [job] = await (await getBoss()).findJobs("email.send", { id: byId[id].jobId! });
      expect(job.state).toBe("cancelled");
    }
    expect(byId[f.sent.id].status).toBe("SENT");
    expect(byId[f.failed.id].status).toBe("FAILED");
    expect(rows.find((row) => row.attachmentFileIds.length > 0)?.attachmentFileIds).toEqual([f.files[3].id]);

    for (const id of [f.queued.requisitionEmail, f.queued.otherEmail]) {
      const [row] = await getDb().select().from(emailLog).where(eq(emailLog.id, id));
      expect(row.status, id).toBe("QUEUED");
      expect(row.recipient, id).not.toBeNull();
    }
    // Leave nothing queued for another file's processDueJobs.
    await withTransaction(async (tx) => {
      for (const id of [f.queued.requisitionEmail, f.queued.otherEmail]) await tx.update(emailLog).set({ status: "CANCELLED" }).where(eq(emailLog.id, id));
    });
  });

  it("F8: CV, cover letter, scorecard notes and offer letter are deleted from storage and marked deleted without their names", async () => {
    const now = new Date();
    const f = await fullFixture(now);
    for (const file of f.files) expect(await blobExists(file.storageKey), file.kind).toBe(true);
    await runRetentionPurge({ now });

    const rows = await getDb().select().from(files).where(inArray(files.id, f.files.map((file) => file.id)));
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row, row.kind).toMatchObject({ deletedAt: now, originalName: null });
      expect(await blobExists(row.storageKey), row.kind).toBe(false);
    }
  });

  it("RT3: an anonymized application refuses status changes and can't be found by its old email hash", async () => {
    const now = new Date();
    const application = await finalApplication(now, 31);
    await runRetentionPurge({ now });
    const admin = await signedIn("ADMIN");
    const current = await app(application.id);
    const response = await changeStatus(
      new Request(`${ORIGIN}/api/applications/${application.id}/status`, {
        method: "POST",
        headers: { cookie: admin.cookie, "content-type": "application/json" },
        body: JSON.stringify({ toStatus: "SCREENING", version: current.version, comment: "Reopen" }),
      }),
      { params: Promise.resolve({ id: application.id }) } as never,
    );
    expect(response.status).toBe(409);
    expect((await response.json()).message).toBe("This application has been anonymized.");
    expect(await getDb().select({ id: applications.id }).from(applications).where(eq(applications.emailHash, application.emailHash!))).toEqual([]);
  });
});

describe("failures and reruns (RT5)", () => {
  it("a storage error leaves that application unchanged, another one is still anonymized, and the run ends FAILED", async () => {
    const now = new Date();
    const broken = await finalApplication(now, 33);
    const brokenFile = await storedFile("APPLICATION", broken.id, "CV");
    const fine = await finalApplication(now, 32);
    const storage = getStorage();
    const failing: StorageService = {
      ...storage,
      delete: async (key) => {
        if (key === brokenFile.storageKey) throw new Error("storage unavailable");
        return storage.delete(key);
      },
    };
    const [run] = await getDb().insert(jobRuns).values({ jobName: unique("retention.purge-test"), runDate: "2031-01-01", startedAt: now, status: "RUNNING" }).returning();
    const handler = dailyTaskHandler(retentionPurgeTask({ storage: failing }));

    await expect(handler({ id: randomUUID(), queue: "retention.purge", data: { jobRunId: run.id, runDate: "2031-01-01", now: now.toISOString() }, retryCount: 0 })).rejects.toThrow(
      "retention purge: 1 application(s) failed",
    );
    expect(await app(broken.id)).toMatchObject({ anonymizedAt: null, firstName: broken.firstName, version: broken.version });
    const [file] = await getDb().select().from(files).where(eq(files.id, brokenFile.id));
    expect(file).toMatchObject({ deletedAt: null, originalName: brokenFile.originalName });
    expect((await app(fine.id)).anonymizedAt).toEqual(now);
    const [after] = await getDb().select().from(jobRuns).where(eq(jobRuns.id, run.id));
    expect(after.status).toBe("FAILED");

    // The retry with working storage finishes it (RT5).
    await runRetentionPurge({ now });
    expect((await app(broken.id)).anonymizedAt).toEqual(now);
  });

  it("RT5: a second run with the same now changes nothing and calls storage for nothing; rate limits older than 2 hours go", async () => {
    const now = new Date();
    const application = await finalApplication(now, 31);
    const cv = await storedFile("APPLICATION", application.id, "CV");
    const oldKey = `apply:${randomUUID()}`;
    const recentKey = `apply:${randomUUID()}`;
    await getDb().insert(rateLimits).values([
      { key: oldKey, windowStart: new Date(now.getTime() - 3 * 3_600_000), count: 3 },
      { key: recentKey, windowStart: new Date(now.getTime() - 3_600_000), count: 1 },
    ]);
    const first = await runRetentionPurge({ now });
    expect(first.rateLimitRowsDeleted).toBeGreaterThanOrEqual(1);
    const once = await app(application.id);

    const deletes: string[] = [];
    const storage = getStorage();
    const second = await runRetentionPurge({ now }, { storage: { ...storage, delete: async (key) => void deletes.push(key) } });
    expect(second).toMatchObject({ anonymized: 0, failed: 0 });
    expect(deletes).not.toContain(cv.storageKey);
    expect(await app(application.id)).toEqual(once);
    expect(await getDb().select().from(auditLog).where(and(eq(auditLog.action, "APPLICATION_ANONYMIZED"), eq(auditLog.subjectId, application.id)))).toHaveLength(1);
    expect(await getDb().select().from(rateLimits).where(eq(rateLimits.key, oldKey))).toEqual([]);
    expect(await getDb().select().from(rateLimits).where(eq(rateLimits.key, recentKey))).toHaveLength(1);
  });

  it("RT5: an application reopened between selection and processing is skipped under the row lock", async () => {
    const now = new Date();
    const application = await finalApplication(now, 31);
    await getDb().update(applications).set({ status: "SCREENING", dispositionedAt: null, reasonCode: null }).where(eq(applications.id, application.id));
    const outcome = await withTransaction((tx) => purgeApplication(tx, application.id, { now, retentionDays: 30, storage: getStorage() }));
    expect(outcome).toEqual({ anonymized: false });
    expect((await app(application.id)).anonymizedAt).toBeNull();
  });
});
