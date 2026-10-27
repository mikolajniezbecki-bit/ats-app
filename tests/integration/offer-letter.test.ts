// The offer letter against the database (tech-stack.md P5, P6, P7, J3, J5,
// J7; ats-project-scope.md §5.6 Letter, A8): approval through the API, the
// offer.render-pdf job through the J7 helper, the email read from Mailpit.
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { POST as createOfferRoute } from "@/app/api/applications/[id]/offers/route";
import { POST as approve } from "@/app/api/offers/[id]/approve/route";
import { GET as preview } from "@/app/api/offers/[id]/preview/route";
import { PATCH as patchOffer } from "@/app/api/offers/[id]/route";
import { POST as submit } from "@/app/api/offers/[id]/submit/route";
import { POST as close } from "@/app/api/requisitions/[id]/close/route";
import { getBoss, jobQueue } from "@/server/adapters/job-queue";
import { getStorage } from "@/server/adapters/storage";
import { type Tx, getDb, withTransaction } from "@/server/db";
import { emailLog, files, offers, requisitions, templates } from "@/server/db/schema";
import { warsawRunDate } from "@/server/domain/daily-tasks";
import { offerRenderPdfHandler } from "@/server/offers/letter";
import { searchMessages, waitForMessage } from "../support/mailpit";
import { processDueJobs } from "../support/process-due-jobs";
import { insertApplication, insertRequisition } from "./fixtures";
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
const tomorrow = () => warsawRunDate(new Date(Date.now() + 36 * 3_600_000));
const BODY = "# Offer\n\nDear [[CANDIDATE_FULL_NAME]], we offer you **[[JOB_TITLE]]** for [[OFFER_SALARY]] [[OFFER_CURRENCY]] from [[START_DATE]].";

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

/** An offer submitted to `hm`, for an application with a unique candidate email. */
async function pending(recruiter: Session, hm: Session, body = BODY) {
  const requisition = await insertRequisition(db(), { state: "APPROVED", approvedAt: new Date(), isPublished: true, openingsCount: 2 });
  requisitionIds.push(requisition.id);
  const application = await insertApplication(db(), { requisitionId: requisition.id, status: "OFFER", email: `cand-${randomUUID()}@example.com` });
  const [template] = await getDb().insert(templates).values({ type: "OFFER", name: `Offer ${randomUUID()}`, body }).returning();
  const created = await call(createOfferRoute as Handler, "POST", application.id, { jobTitle: "Backend Engineer", salary: "85000", currency: "EUR", startDate: tomorrow(), templateId: template.id }, recruiter);
  expect(created.status, JSON.stringify(await created.clone().json())).toBe(201);
  const offer = (await created.json()).offer as typeof offers.$inferSelect;
  expect((await call(submit as Handler, "POST", offer.id, { approverId: hm.userId, version: 1 }, recruiter)).status).toBe(200);
  return { requisition, application, template, offerId: offer.id };
}

async function offerRow(id: string) {
  const [row] = await getDb().select().from(offers).where(eq(offers.id, id));
  return row;
}
const letters = (offerId: string) =>
  getDb().select().from(files).where(and(eq(files.ownerType, "OFFER"), eq(files.ownerId, offerId), eq(files.kind, "OFFER_LETTER")));

async function approved(recruiter: Session, hm: Session, body = BODY) {
  const setup = await pending(recruiter, hm, body);
  expect((await call(approve as Handler, "POST", setup.offerId, { version: 2 }, hm)).status).toBe(200);
  return setup;
}

describe("final letter (P7)", () => {
  it("P7: approving and running the jobs stores one OFFER_LETTER, sets sent_at and emails the candidate with that PDF", async () => {
    const recruiter = await signedIn("RECRUITER");
    const hm = await signedIn("HIRING_MANAGER");
    const { offerId, application } = await approved(recruiter, hm);
    await processDueJobs();

    const stored = await letters(offerId);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ mime: "application/pdf", status: "CLEAN", deletedAt: null });
    expect((await offerRow(offerId)).sentAt).toBeInstanceOf(Date);
    const [logged] = await getDb().select().from(emailLog).where(and(eq(emailLog.applicationId, application.id), eq(emailLog.recipient, application.email!)));
    expect(logged).toMatchObject({ audience: "CANDIDATE", attachmentFileIds: [stored[0].id], status: "SENT" });

    const message = await waitForMessage({ to: application.email!, subjectIncludes: "Your offer" });
    expect(message.subject).toBe("Your offer for Backend Engineer");
    const pdf = message.attachments.find((file) => file.contentType === "application/pdf");
    expect(pdf).toBeDefined();
    expect(Buffer.compare(pdf!.bytes, await getStorage().download(stored[0].storageKey))).toBe(0);
    // P5: [[LOGO]] at the top of the email is the data: URI logo.
    expect(message.html).toContain("data:image/png;base64,");
  });

  it("P7: a re-approval adds a second file, keeps the first, and sends the new PDF with the updated subject", async () => {
    const recruiter = await signedIn("RECRUITER");
    const hm = await signedIn("HIRING_MANAGER");
    const { offerId, application } = await approved(recruiter, hm);
    await processDueJobs();
    const version = (await offerRow(offerId)).version;
    expect((await call(patchOffer as Handler, "PATCH", offerId, { version, salary: "90000", approverId: hm.userId }, recruiter)).status).toBe(200);
    expect((await call(approve as Handler, "POST", offerId, { version: version + 1 }, hm)).status).toBe(200);
    await processDueJobs();

    const stored = await letters(offerId);
    expect(stored).toHaveLength(2);
    expect(stored.every((file) => file.deletedAt === null)).toBe(true);
    const updated = await waitForMessage({ to: application.email!, subjectIncludes: "updated" });
    expect(updated.subject).toBe("Your updated offer for Backend Engineer");
    const newest = stored.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).at(-1)!;
    const pdf = updated.attachments.find((file) => file.contentType === "application/pdf")!;
    expect(Buffer.compare(pdf.bytes, await getStorage().download(newest.storageKey))).toBe(0);
    expect(await searchMessages(application.email!)).toHaveLength(2);
  });

  it("P7: closing the requisition before the job runs leaves no file and no email, and the job completes", async () => {
    const recruiter = await signedIn("RECRUITER");
    const hm = await signedIn("HIRING_MANAGER");
    const { offerId, requisition, application } = await approved(recruiter, hm);
    const [row] = await getDb().select({ version: requisitions.version }).from(requisitions).where(eq(requisitions.id, requisition.id));
    expect((await call(close as Handler, "POST", requisition.id, { version: row.version, comment: "Budget cut" }, recruiter)).status).toBe(200);
    const result = await processDueJobs({ handlers: { "offer.render-pdf": (job) => offerRenderPdfHandler(job) } });
    expect(result.failed).toBe(0);
    expect(await letters(offerId)).toEqual([]);
    expect(await offerRow(offerId)).toMatchObject({ approvalStatus: "WITHDRAWN", sentAt: null });
    const jobs = await (await getBoss()).findJobs("offer.render-pdf", { data: { offerId } });
    expect(jobs.map((job) => job.state)).toEqual(["completed"]);
    expect(await getDb().select().from(emailLog).where(and(eq(emailLog.applicationId, application.id), eq(emailLog.subject, "Your offer for Backend Engineer")))).toEqual([]);
  });

  it("P7: running the handler twice for the same approval stores one file and queues one email (J3)", async () => {
    const recruiter = await signedIn("RECRUITER");
    const hm = await signedIn("HIRING_MANAGER");
    const { offerId, application } = await approved(recruiter, hm);
    const job = { id: randomUUID(), queue: "offer.render-pdf", data: { offerId }, retryCount: 0 };
    await offerRenderPdfHandler(job);
    await offerRenderPdfHandler(job);
    expect(await letters(offerId)).toHaveLength(1);
    expect(await getDb().select().from(emailLog).where(and(eq(emailLog.applicationId, application.id), eq(emailLog.subject, "Your offer for Backend Engineer")))).toHaveLength(1);
  });

  it("A8 (Q9): editing an approved offer cancels its still-queued offer email", async () => {
    const recruiter = await signedIn("RECRUITER");
    const hm = await signedIn("HIRING_MANAGER");
    const { offerId, application } = await approved(recruiter, hm);
    // Render only; the offer email stays QUEUED.
    await processDueJobs({ handlers: { "offer.render-pdf": (job) => offerRenderPdfHandler(job) } });
    const [queued] = await getDb().select().from(emailLog).where(and(eq(emailLog.applicationId, application.id), eq(emailLog.subject, "Your offer for Backend Engineer")));
    expect(queued.status).toBe("QUEUED");
    const version = (await offerRow(offerId)).version;
    expect((await call(patchOffer as Handler, "PATCH", offerId, { version, startDate: warsawRunDate(new Date(Date.now() + 60 * 86_400_000)), approverId: hm.userId }, recruiter)).status).toBe(200);
    const [after] = await getDb().select().from(emailLog).where(eq(emailLog.id, queued.id));
    expect(after.status).toBe("CANCELLED");
    expect((await offerRow(offerId)).sentAt).toBeNull();
  });

  it("render failure (Q11): a render error fails the job for a retry; the offer stays APPROVED with sent_at NULL", async () => {
    const recruiter = await signedIn("RECRUITER");
    const hm = await signedIn("HIRING_MANAGER");
    const { offerId, template } = await approved(recruiter, hm);
    await getDb().update(templates).set({ body: "Hello [[NOT_A_TOKEN]]" }).where(eq(templates.id, template.id));
    const result = await processDueJobs({ handlers: { "offer.render-pdf": (job) => offerRenderPdfHandler(job) } });
    expect(result.failed).toBe(1);
    expect(await offerRow(offerId)).toMatchObject({ approvalStatus: "APPROVED", sentAt: null });
    expect(await letters(offerId)).toEqual([]);
    const [job] = await (await getBoss()).findJobs("offer.render-pdf", { data: { offerId } });
    expect(job.state).toBe("retry");
  });

  it("deactivated template (Q5): a template deactivated after approval still renders the letter", async () => {
    const recruiter = await signedIn("RECRUITER");
    const hm = await signedIn("HIRING_MANAGER");
    const { offerId, template } = await approved(recruiter, hm);
    await getDb().update(templates).set({ isActive: false }).where(eq(templates.id, template.id));
    await processDueJobs({ handlers: { "offer.render-pdf": (job) => offerRenderPdfHandler(job) } });
    expect(await letters(offerId)).toHaveLength(1);
  });
});

describe("preview (P6)", () => {
  it("P6: a preview returns an inline PDF and stores nothing: no files row and no upload", async () => {
    const recruiter = await signedIn("RECRUITER");
    const hm = await signedIn("HIRING_MANAGER");
    const { offerId } = await pending(recruiter, hm);
    const filesBefore = (await getDb().select({ id: files.id }).from(files)).length;
    const upload = vi.spyOn(getStorage(), "upload");
    try {
      const response = await call(preview as Handler, "GET", offerId, undefined, recruiter);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/pdf");
      expect(response.headers.get("content-disposition")).toBe('inline; filename="offer-preview.pdf"');
      expect(response.headers.get("cache-control")).toBe("no-store");
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
      expect(upload).not.toHaveBeenCalled();
    } finally {
      upload.mockRestore();
    }
    expect((await getDb().select({ id: files.id }).from(files)).length).toBe(filesBefore);
  });

  it("P6: the approver (V3b) and a Hiring Manager in V3a may preview; an Interviewer and an unrelated Hiring Manager get 404; a bad token is 422", async () => {
    const recruiter = await signedIn("RECRUITER");
    const approver = await signedIn("HIRING_MANAGER");
    const { offerId, requisition, template } = await pending(recruiter, approver);
    expect((await call(preview as Handler, "GET", offerId, undefined, approver)).status).toBe(200);
    const owner = await signedIn("HIRING_MANAGER");
    await getDb().update(requisitions).set({ hiringManagerId: owner.userId }).where(eq(requisitions.id, requisition.id));
    expect((await call(preview as Handler, "GET", offerId, undefined, owner)).status).toBe(200);
    expect((await call(preview as Handler, "GET", offerId, undefined, await signedIn("INTERVIEWER"))).status).toBe(404);
    expect((await call(preview as Handler, "GET", offerId, undefined, await signedIn("HIRING_MANAGER"))).status).toBe(404);
    expect((await call(preview as Handler, "GET", randomUUID(), undefined, recruiter)).status).toBe(404);

    await getDb().update(templates).set({ body: "Hi [[NOT_A_TOKEN]]" }).where(eq(templates.id, template.id));
    const broken = await call(preview as Handler, "GET", offerId, undefined, recruiter);
    expect(broken.status).toBe(422);
    expect((await broken.json()).message).toContain("[[NOT_A_TOKEN]]");
  });
});
