// Bulk status moves and bulk email against the database, pg-boss and Mailpit
// (ats-project-scope.md §5.4 Bulk actions, R3, R7–R9, E8; tech-stack.md D3,
// T5). Every row is new, so tests don't see each other's data.
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { POST as bulkEmail } from "@/app/api/applications/bulk/email/route";
import { POST as bulkStatus } from "@/app/api/applications/bulk/status/route";
import { GET as templatePicker } from "@/app/api/templates/route";
import { jobQueue } from "@/server/adapters/job-queue";
import { type Tx, getDb, withTransaction } from "@/server/db";
import { SEED_TEMPLATES } from "@/server/db/seed/data";
import { applicationHistory, applications, emailLog, templates } from "@/server/db/schema";
import type { PipelineStatus } from "@/server/domain/pipeline";
import { changeApplicationStatus } from "@/server/pipeline";
import { bulkChangeStatus } from "@/server/pipeline/bulk";
import { getMessage, searchMessages, waitForMessage } from "../support/mailpit";
import { processDueJobs } from "../support/process-due-jobs";
import { insertApplication, insertRequisition, insertUser } from "./fixtures";
import { ORIGIN, signedIn } from "./sessions";

const db = () => getDb() as unknown as Tx;
const HOUR = 3_600_000;

// Shared worker database: templates this file created lose their trigger
// status again, and emails it left queued are cancelled (another file's
// processDueJobs must never pick them up).
const createdTemplateIds: string[] = [];
const createdApplicationIds: string[] = [];
afterAll(async () => {
  if (createdApplicationIds.length > 0) {
    await withTransaction(async (tx) => {
      const queued = await tx
        .update(emailLog)
        .set({ status: "CANCELLED" })
        .where(and(inArray(emailLog.applicationId, createdApplicationIds), eq(emailLog.status, "QUEUED")))
        .returning({ jobId: emailLog.jobId });
      for (const { jobId } of queued) if (jobId) await jobQueue.cancel(tx, "email.send", jobId);
    });
  }
  if (createdTemplateIds.length > 0) await getDb().update(templates).set({ isActive: false, triggerStatus: null }).where(inArray(templates.id, createdTemplateIds));
});

async function emailTemplate(values: Partial<typeof templates.$inferInsert>) {
  const [row] = await getDb()
    .insert(templates)
    .values({ type: "EMAIL", name: `Bulk ${randomUUID()}`, subject: "Update on [[JOB_TITLE]]", body: "Dear [[CANDIDATE_FULL_NAME]],", ...values })
    .returning();
  createdTemplateIds.push(row.id);
  return row;
}

/** The active stage template for `status`, created when the worker database has none. */
async function stageTemplate(status: PipelineStatus) {
  const [existing] = await getDb()
    .select()
    .from(templates)
    .where(and(eq(templates.type, "EMAIL"), eq(templates.isActive, true), eq(templates.triggerStatus, status)));
  return existing ?? emailTemplate({ triggerStatus: status });
}

async function requisition() {
  const hm = await insertUser(db(), "HIRING_MANAGER");
  return insertRequisition(db(), { hiringManagerId: hm.id, state: "APPROVED", approvedAt: new Date(), isPublished: true });
}

async function application(requisitionId: string, overrides: Partial<typeof applications.$inferInsert> = {}) {
  const row = await insertApplication(db(), { requisitionId, email: `e2e-${randomUUID()}@example.com`, ...overrides });
  createdApplicationIds.push(row.id);
  return row;
}

const anonymizedValues = { anonymizedAt: new Date(), firstName: null, lastName: null, email: null, emailHash: null, phone: null };

async function row(id: string) {
  const [found] = await getDb().select().from(applications).where(eq(applications.id, id));
  return found;
}
const history = (id: string) => getDb().select().from(applicationHistory).where(eq(applicationHistory.applicationId, id)).orderBy(asc(applicationHistory.createdAt));
const emails = (id: string) => getDb().select().from(emailLog).where(eq(emailLog.applicationId, id)).orderBy(asc(emailLog.createdAt));

type Session = Awaited<ReturnType<typeof signedIn>>;
type Handler = (request: Request, context: never) => Promise<Response>;
const post = (handler: Handler, body: unknown, session?: Session) =>
  handler(
    new Request(`${ORIGIN}/api/applications/bulk/x`, {
      method: "POST",
      headers: { ...(session ? { cookie: session.cookie } : {}), "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    {} as never,
  );

describe("bulk status move", () => {
  it("R9: reports a stale version, refusals and an anonymized application per item; only the valid one changes", async () => {
    const job = await requisition();
    const applied = await application(job.id);
    const stale = await application(job.id, { status: "SCREENING", version: 3 });
    const rejected = await application(job.id, { status: "REJECTED", reasonCode: "OTHER", dispositionedAt: new Date() });
    const screening = await application(job.id, { status: "SCREENING" });
    const anonymized = await application(job.id, { status: "APPLIED", ...anonymizedValues });
    const recruiter = await signedIn("RECRUITER");

    const response = await post(
      bulkStatus,
      {
        toStatus: "SCREENING",
        items: [
          { applicationId: applied.id, version: 1 },
          { applicationId: stale.id, version: 2 },
          { applicationId: rejected.id, version: 1 },
          { applicationId: screening.id, version: 1 },
          { applicationId: anonymized.id, version: 1 },
        ],
      },
      recruiter,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).results).toEqual([
      { applicationId: applied.id, ok: true, status: "SCREENING", version: 2 },
      { applicationId: stale.id, ok: false, code: "stale", message: "This record was changed by someone else. Reload and try again." },
      { applicationId: rejected.id, ok: false, code: "reopenNeedsComment", message: "Reopening needs a comment." },
      { applicationId: screening.id, ok: false, code: "sameStatus", message: "The application is already in this status." },
      { applicationId: anonymized.id, ok: false, code: "anonymized", message: "This application has been anonymized." },
    ]);

    expect(await row(applied.id)).toMatchObject({ status: "SCREENING", version: 2 });
    expect(await history(applied.id)).toEqual([expect.objectContaining({ fromStatus: "APPLIED", toStatus: "SCREENING", changedByUserId: recruiter.userId })]);
    for (const [app, status, version] of [
      [stale, "SCREENING", 3],
      [rejected, "REJECTED", 1],
      [screening, "SCREENING", 1],
      [anonymized, "APPLIED", 1],
    ] as const) {
      expect(await row(app.id), app.id).toMatchObject({ status, version });
      expect(await history(app.id)).toEqual([]);
      expect(await emails(app.id)).toEqual([]);
    }
  });

  it("an unknown or malformed ID is reported as not found and the rest still move", async () => {
    const job = await requisition();
    const applied = await application(job.id);
    const recruiter = await insertUser(db(), "RECRUITER");
    const results = await bulkChangeStatus(
      { id: recruiter.id, role: "RECRUITER" },
      {
        toStatus: "INTERVIEW",
        comment: "  Moving the batch  ",
        items: [
          { applicationId: randomUUID(), version: 1 },
          { applicationId: "nope", version: 1 },
          { applicationId: applied.id, version: 1 },
        ],
      },
    );
    expect(results.map((result) => (result.ok ? "ok" : result.message))).toEqual(["This application can't be found.", "This application can't be found.", "ok"]);
    expect((await history(applied.id))[0].comment).toBe("Moving the batch");
  });

  it("R3: a reopen with the shared comment works per application", async () => {
    const job = await requisition();
    const first = await application(job.id, { status: "REJECTED", reasonCode: "OTHER", dispositionedAt: new Date() });
    const second = await application(job.id, { status: "WITHDRAWN", dispositionedAt: new Date() });
    const recruiter = await insertUser(db(), "RECRUITER");
    const results = await bulkChangeStatus(
      { id: recruiter.id, role: "RECRUITER" },
      { toStatus: "SCREENING", comment: "Reopened as a batch", items: [first, second].map((app) => ({ applicationId: app.id, version: 1 })) },
    );
    expect(results.every((result) => result.ok)).toBe(true);
    for (const app of [first, second]) expect((await history(app.id))[0]).toMatchObject({ isReopen: true, comment: "Reopened as a batch" });
  });

  it("a failure in the service for the second of three items rolls back only that item", async () => {
    const job = await requisition();
    const items = [await application(job.id), await application(job.id), await application(job.id)];
    const recruiter = await insertUser(db(), "RECRUITER");
    const results = await bulkChangeStatus(
      { id: recruiter.id, role: "RECRUITER" },
      { toStatus: "SCREENING", items: items.map((app) => ({ applicationId: app.id, version: 1 })) },
      {
        requestId: "req-123",
        change: async (tx, input) => {
          const result = await changeApplicationStatus(tx, input);
          if (input.applicationId === items[1].id) throw new Error("forced failure after the update");
          return result;
        },
      },
    );
    expect(results).toEqual([
      expect.objectContaining({ applicationId: items[0].id, ok: true }),
      { applicationId: items[1].id, ok: false, code: "failed", message: "Something went wrong with this application. Request ID: req-123" },
      expect.objectContaining({ applicationId: items[2].id, ok: true }),
    ]);
    expect((await row(items[0].id)).status).toBe("SCREENING");
    expect(await row(items[1].id)).toMatchObject({ status: "APPLIED", version: 1 });
    expect(await history(items[1].id)).toEqual([]);
    expect((await row(items[2].id)).status).toBe("SCREENING");
  });

  it("E8: moving two applications to REJECTED queues one delayed rejection email each", async () => {
    const template = await stageTemplate("REJECTED");
    const job = await requisition();
    const items = [await application(job.id, { status: "SCREENING" }), await application(job.id, { status: "INTERVIEW" })];
    const before = Date.now();
    const results = await bulkChangeStatus(
      { id: (await insertUser(db(), "RECRUITER")).id, role: "RECRUITER" },
      { toStatus: "REJECTED", items: items.map((app) => ({ applicationId: app.id, version: 1 })) },
    );
    expect(results.every((result) => result.ok)).toBe(true);
    for (const app of items) {
      const queued = await emails(app.id);
      expect(queued).toEqual([expect.objectContaining({ templateId: template.id, status: "QUEUED", recipient: app.email })]);
      // The default delay (24 h), from the time of that application's own move.
      expect(queued[0].scheduledFor!.getTime()).toBeGreaterThanOrEqual(before + 24 * HOUR - 1_000);
    }
  });

  it("returns 400 for an empty list, over 100 items, a duplicate ID or invalid input", async () => {
    const recruiter = await signedIn("RECRUITER");
    const id = randomUUID();
    const many = Array.from({ length: 101 }, () => ({ applicationId: randomUUID(), version: 1 }));
    for (const [body, text] of [
      [{ toStatus: "SCREENING", items: [] }, "Select at least one application."],
      [{ toStatus: "SCREENING", items: many }, "Select at most 100 applications."],
      [{ toStatus: "SCREENING", items: [{ applicationId: id, version: 1 }, { applicationId: id, version: 2 }] }, "An application was selected more than once."],
      [{ toStatus: "NOPE", items: [{ applicationId: id, version: 1 }] }, "Check the selection and try again."],
    ] as const) {
      const response = await post(bulkStatus, body, recruiter);
      expect(response.status).toBe(400);
      expect((await response.json()).message).toBe(text);
    }
  });
});

describe("bulk email", () => {
  it("sends the seeded 'Application update' template to each candidate with their own tokens; the anonymized one is refused", async () => {
    const seeded = SEED_TEMPLATES.find((entry) => entry.type === "EMAIL" && entry.name === "Application update")!;
    if (seeded.type !== "EMAIL") throw new Error("seed changed");
    const template = await emailTemplate({ name: `Application update ${randomUUID()}`, subject: seeded.subject, body: seeded.body });
    const job = await requisition();
    const ann = await application(job.id, { firstName: "Ann", lastName: "Kowalska" });
    // Same address on purpose: never merged, each gets its own email (TO-01).
    const bob = await application(job.id, { firstName: "Bob", lastName: "Nowak", email: ann.email, emailHash: ann.emailHash });
    const anonymized = await application(job.id, anonymizedValues);
    const recruiter = await signedIn("RECRUITER");

    const response = await post(bulkEmail, { templateId: template.id, applicationIds: [ann.id, bob.id, anonymized.id] }, recruiter);
    expect(response.status).toBe(200);
    const { results } = await response.json();
    expect(results).toEqual([
      { applicationId: ann.id, ok: true, emailLogId: expect.any(String) },
      { applicationId: bob.id, ok: true, emailLogId: expect.any(String) },
      { applicationId: anonymized.id, ok: false, code: "anonymized", message: "This application has been anonymized." },
    ]);
    expect(await emails(anonymized.id)).toEqual([]);

    await processDueJobs();
    for (const app of [ann, bob]) {
      expect((await emails(app.id))[0]).toMatchObject({ templateId: template.id, applicationId: app.id, audience: "CANDIDATE", status: "SENT" });
    }
    // Both went to the same address: two separate messages, one per application.
    await waitForMessage({ to: ann.email! });
    const summaries = await searchMessages(ann.email!);
    expect(summaries).toHaveLength(2);
    const messages = await Promise.all(summaries.map((summary) => getMessage(summary.ID)));
    expect(messages.map((message) => (message.html.includes("Dear Ann Kowalska,") ? "Ann" : message.html.includes("Dear Bob Nowak,") ? "Bob" : "?")).sort()).toEqual([
      "Ann",
      "Bob",
    ]);
    for (const message of messages) {
      expect(message.subject).toBe(`An update on your application for ${job.title}`);
      expect(message.html).toContain(job.title);
      expect(`${message.subject} ${message.html}`).not.toContain("[[");
    }
    const delivered = await getDb().select().from(emailLog).where(inArray(emailLog.applicationId, [ann.id, bob.id]));
    expect(delivered).toHaveLength(2);
  });

  it("refuses the whole request with 409 when the template is a stage template, inactive or unknown, and queues nothing", async () => {
    const job = await requisition();
    const app = await application(job.id);
    const recruiter = await signedIn("RECRUITER");
    const stage = await stageTemplate("APPLIED");
    const inactive = await emailTemplate({ isActive: false });
    for (const templateId of [stage.id, inactive.id, randomUUID()]) {
      const response = await post(bulkEmail, { templateId, applicationIds: [app.id] }, recruiter);
      expect(response.status).toBe(409);
      expect((await response.json()).message).toBe("This template can no longer be used for bulk email.");
    }
    expect(await emails(app.id)).toEqual([]);
  });

  it("reports a token without a value per application", async () => {
    const template = await emailTemplate({ body: "Offer for [[JOB_TITLE]]: [[OFFER_SALARY]]" });
    const job = await requisition();
    const app = await application(job.id);
    const response = await post(bulkEmail, { templateId: template.id, applicationIds: [app.id] }, await signedIn("ADMIN"));
    const [result] = (await response.json()).results;
    expect(result).toMatchObject({ applicationId: app.id, ok: false, code: "tokenError" });
    expect(result.message).toContain("OFFER_SALARY");
    expect(await emails(app.id)).toEqual([]);
  });

  it("the picker API lists an active template without trigger, not the stage templates or an inactive one", async () => {
    const listed = await emailTemplate({});
    const inactive = await emailTemplate({ isActive: false });
    const stages = [await stageTemplate("APPLIED"), await stageTemplate("REJECTED")];
    const recruiter = await signedIn("RECRUITER");
    const response = await templatePicker(new Request(`${ORIGIN}/api/templates?type=EMAIL&bulk=true`, { headers: { cookie: recruiter.cookie } }), {} as never);
    const ids = ((await response.json()).templates as { id: string }[]).map((entry) => entry.id);
    expect(ids).toContain(listed.id);
    for (const excluded of [inactive, ...stages]) expect(ids).not.toContain(excluded.id);
  });
});

describe("access", () => {
  it("a Hiring Manager (also the requisition's own) and an Interviewer get 403 from both endpoints; no session gets 401; nothing changes", async () => {
    const hm = await signedIn("HIRING_MANAGER");
    const job = await insertRequisition(db(), { hiringManagerId: hm.userId, state: "APPROVED", approvedAt: new Date() });
    const app = await application(job.id);
    const template = await emailTemplate({});
    const statusBody = { toStatus: "SCREENING", items: [{ applicationId: app.id, version: 1 }] };
    const emailBody = { templateId: template.id, applicationIds: [app.id] };
    for (const session of [hm, await signedIn("HIRING_MANAGER"), await signedIn("INTERVIEWER")]) {
      expect((await post(bulkStatus, statusBody, session)).status).toBe(403);
      expect((await post(bulkEmail, emailBody, session)).status).toBe(403);
    }
    expect((await post(bulkStatus, statusBody)).status).toBe(401);
    expect((await post(bulkEmail, emailBody)).status).toBe(401);
    expect(await row(app.id)).toMatchObject({ status: "APPLIED", version: 1 });
    expect(await emails(app.id)).toEqual([]);
  });
});
