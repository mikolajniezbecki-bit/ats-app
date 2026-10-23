// Quick Apply against the database, storage and Mailpit (ats-project-scope.md
// §5.3, F1–F3, F7, S4, E8, R11; tech-stack.md J7, M2).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Writable } from "node:stream";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { getStorage } from "@/server/adapters/storage";
import { type ApplyInput, submitApplication } from "@/server/apply";
import { type Tx, getDb } from "@/server/db";
import {
  applicationHistory,
  applications,
  emailLog,
  files,
  prescreenAnswers,
  prescreenQuestions,
  requisitions,
  settings,
  templates,
} from "@/server/db/schema";
import { computeEmailHash } from "@/server/domain/apply";
import { createLogger, logger } from "@/server/logger";
import { waitForMessage } from "../support/mailpit";
import { processDueJobs } from "../support/process-due-jobs";
import { insertRequisition, insertUser } from "./fixtures";

const VALID_PDF = new Uint8Array(readFileSync("tests/fixtures/pdf/valid.pdf"));
const db = () => getDb() as unknown as Tx;
const HOUR = 3_600_000;

afterEach(() => vi.restoreAllMocks());

// The worker database is shared with other files, which own the trigger
// statuses (one active stage template per status, and some count them):
// templates this file created are deactivated and lose their trigger status
// again (email_log rows still reference them, so they stay).
const createdTemplateIds: string[] = [];
afterAll(async () => {
  if (createdTemplateIds.length > 0) await getDb().update(templates).set({ isActive: false, triggerStatus: null }).where(inArray(templates.id, createdTemplateIds));
});

/** A published External requisition (or Private with a slug), with a real Hiring Manager and Recruiter. */
async function job(overrides: Partial<typeof requisitions.$inferInsert> = {}) {
  const hm = await insertUser(db(), "HIRING_MANAGER");
  return insertRequisition(db(), { hiringManagerId: hm.id, state: "APPROVED", approvedAt: new Date(), isPublished: true, ...overrides });
}

/** Makes sure an active stage template exists for `status` (the worker database isn't seeded). */
async function ensureStageTemplate(status: "APPLIED" | "REJECTED") {
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

async function question(requisitionId: string, values: Partial<typeof prescreenQuestions.$inferInsert>) {
  const [row] = await getDb()
    .insert(prescreenQuestions)
    .values({ requisitionId, questionText: "Q", questionType: "TEXT", sortOrder: 0, ...values })
    .returning();
  return row;
}

const yesNoOptions = [
  { code: "YES", label: "Yes" },
  { code: "NO", label: "No" },
];

async function stampFor(requisitionId: string) {
  const rows = await getDb().select().from(prescreenQuestions).where(eq(prescreenQuestions.requisitionId, requisitionId));
  return rows.filter((row) => row.isActive).map((row) => ({ id: row.id, updatedAt: row.updatedAt.toISOString() }));
}

async function input(requisition: { id: string }, overrides: Partial<ApplyInput> = {}, fields: Partial<ApplyInput["fields"]> = {}): Promise<ApplyInput> {
  return {
    route: { kind: "external", id: requisition.id },
    fields: { firstName: "Łucja", lastName: "Żółć", email: `e2e-${randomUUID()}@example.com`, phone: "+48 600 100 200", consent: true, ...fields },
    answers: {},
    questionStamp: await stampFor(requisition.id),
    consentVersion: "1.0",
    cv: { bytes: VALID_PDF, name: "Synthetic CV.pdf" },
    coverLetter: null,
    ...overrides,
  };
}

async function application(id: string) {
  const [row] = await getDb().select().from(applications).where(eq(applications.id, id));
  return row;
}

async function applied(applyInput: ApplyInput) {
  const result = await submitApplication(applyInput);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result;
}

describe("submitApplication", () => {
  it("creates an APPLIED application with consent, source, files, history and the acknowledgement", async () => {
    const template = await ensureStageTemplate("APPLIED");
    const requisition = await job();
    const applyInput = await input(requisition, { coverLetter: { bytes: VALID_PDF, name: "Letter.pdf" } });
    const result = await applied(applyInput);
    expect(result.status).toBe("APPLIED");

    const row = await application(result.applicationId);
    expect(row).toMatchObject({
      requisitionId: requisition.id,
      firstName: "Łucja",
      lastName: "Żółć",
      email: applyInput.fields.email,
      status: "APPLIED",
      reasonCode: null,
      source: "CAREER_SITE",
      consentVersion: "1.0",
      isDisqualified: false,
      prescreenScore: 0,
      dispositionedAt: null,
      candidateId: null,
      version: 1,
    });
    expect(row.consentAcceptedAt).toBeInstanceOf(Date);
    expect(row.emailHash).toBe(computeEmailHash(applyInput.fields.email, "test-only-hash-key"));

    const stored = await getDb().select().from(files).where(eq(files.ownerId, result.applicationId));
    expect(stored.map((file) => [file.kind, file.ownerType, file.originalName]).sort()).toEqual([
      ["COVER_LETTER", "APPLICATION", "Letter.pdf"],
      ["CV", "APPLICATION", "Synthetic CV.pdf"],
    ]);
    expect(await getDb().select().from(applicationHistory).where(eq(applicationHistory.applicationId, result.applicationId))).toEqual([
      expect.objectContaining({ fromStatus: null, toStatus: "APPLIED", changedByUserId: null, reasonCode: null, isReopen: false }),
    ]);
    const emails = await getDb().select().from(emailLog).where(eq(emailLog.applicationId, result.applicationId));
    expect(emails).toEqual([expect.objectContaining({ templateId: template.id, status: "QUEUED", audience: "CANDIDATE" })]);
  });

  it("a Private posting records PRIVATE_LINK and can't be applied to by its ID", async () => {
    const slug = randomUUID().replaceAll("-", "");
    const requisition = await job({ postingType: "PRIVATE", privateSlug: slug });
    const result = await applied(await input(requisition, { route: { kind: "private", slug } }));
    expect((await application(result.applicationId)).source).toBe("PRIVATE_LINK");
    expect(await submitApplication(await input(requisition))).toEqual({ ok: false, reason: "notFound" });
  });

  it("a disqualifying answer creates a REJECTED application with a delayed rejection email, sent after the delay", async () => {
    await ensureStageTemplate("REJECTED");
    const requisition = await job({ title: "Night Shift Operator" });
    const permit = await question(requisition.id, { questionType: "YES_NO", optionsJson: yesNoOptions, weight: 10, scoringAnswer: "YES", disqualifyingAnswer: "NO" });
    const applyInput = await input(requisition, { answers: { [permit.id]: ["NO"] } });
    const before = Date.now();
    const result = await applied(applyInput);
    expect(result.status).toBe("REJECTED");
    const row = await application(result.applicationId);
    expect(row).toMatchObject({ status: "REJECTED", reasonCode: "DISQUALIFIED", isDisqualified: true, prescreenScore: 0 });
    expect(row.dispositionedAt).toBeInstanceOf(Date);
    expect(await getDb().select().from(applicationHistory).where(eq(applicationHistory.applicationId, result.applicationId))).toEqual([
      expect.objectContaining({ fromStatus: null, toStatus: "REJECTED", reasonCode: "DISQUALIFIED", changedByUserId: null }),
    ]);

    const [email] = await getDb().select().from(emailLog).where(eq(emailLog.applicationId, result.applicationId));
    expect(email.status).toBe("QUEUED");
    expect(email.scheduledFor!.getTime()).toBeGreaterThanOrEqual(before + 24 * HOUR - 1_000);
    expect(email.scheduledFor!.getTime()).toBeLessThanOrEqual(Date.now() + 24 * HOUR + 1_000);

    await processDueJobs();
    expect((await getDb().select().from(emailLog).where(eq(emailLog.id, email.id)))[0].status).toBe("QUEUED");
    await processDueJobs({ now: new Date(Date.now() + 25 * HOUR) });
    const message = await waitForMessage({ to: applyInput.fields.email });
    expect(message.subject).toContain("Night Shift Operator");
  });

  it("S4: stored points and prescreen_score equal scorePrescreen; an unanswered optional TEXT question has no row", async () => {
    const requisition = await job();
    const permit = await question(requisition.id, { questionType: "YES_NO", optionsJson: yesNoOptions, weight: 10, scoringAnswer: "YES", sortOrder: 0 });
    const level = await question(requisition.id, {
      questionType: "SINGLE",
      optionsJson: [{ code: "A", label: "A" }, { code: "B", label: "B" }],
      weight: 5,
      scoringAnswer: "B",
      sortOrder: 1,
    });
    const skills = await question(requisition.id, {
      questionType: "MULTI",
      optionsJson: [{ code: "JS", label: "JS" }, { code: "TS", label: "TS" }],
      weight: 7,
      scoringAnswer: ["JS", "TS"],
      sortOrder: 2,
    });
    const notes = await question(requisition.id, { questionType: "TEXT", sortOrder: 3 });
    const result = await applied(await input(requisition, { answers: { [permit.id]: ["YES"], [level.id]: ["A"], [skills.id]: ["TS", "JS"], [notes.id]: [""] } }));
    const rows = await getDb().select().from(prescreenAnswers).where(eq(prescreenAnswers.applicationId, result.applicationId));
    expect(Object.fromEntries(rows.map((row) => [row.questionId, [row.answerJson, row.points]]))).toEqual({
      [permit.id]: ["YES", 10],
      [level.id]: ["A", 0],
      [skills.id]: [["TS", "JS"], 7],
    });
    expect((await application(result.applicationId)).prescreenScore).toBe(17);
  });

  it("YES_NO and SINGLE questions must be answered; an unknown code stores nothing", async () => {
    const requisition = await job();
    const permit = await question(requisition.id, { questionType: "YES_NO", optionsJson: yesNoOptions });
    const missing = await submitApplication(await input(requisition));
    expect(missing).toEqual({ ok: false, reason: "invalid", fields: { [`answers.${permit.id}`]: "answerRequired" } });
    const unknown = await submitApplication(await input(requisition, { answers: { [permit.id]: ["MAYBE"] } }));
    expect(unknown).toEqual({ ok: false, reason: "invalid", fields: { [`answers.${permit.id}`]: "invalidOption" } });
    expect(await getDb().select().from(applications).where(eq(applications.requisitionId, requisition.id))).toEqual([]);
  });

  it("validates the contact fields and the files before anything is stored", async () => {
    const requisition = await job();
    const result = await submitApplication(
      await input(requisition, { cv: null, coverLetter: { bytes: new Uint8Array(0), name: "empty.pdf" } }, { firstName: "", email: "nope", phone: "12-34", consent: false }),
    );
    expect(result).toEqual({
      ok: false,
      reason: "invalid",
      fields: { firstName: "invalid", email: "invalid", phone: "invalid", consent: "invalid", cv: "required", coverLetter: "EMPTY" },
      maxMb: 5,
    });
    const notPdf = await submitApplication(await input(requisition, { cv: { bytes: new TextEncoder().encode("hello"), name: "cv.pdf" } }));
    expect(notPdf).toMatchObject({ ok: false, fields: { cv: "NOT_PDF" } });
  });

  it("a question deactivated between render and submit is refused and stores nothing", async () => {
    const requisition = await job();
    const shown = await question(requisition.id, { questionType: "TEXT" });
    const applyInput = await input(requisition);
    await getDb().update(prescreenQuestions).set({ isActive: false }).where(eq(prescreenQuestions.id, shown.id));
    expect(await submitApplication(applyInput)).toEqual({ ok: false, reason: "questionsChanged" });
    expect(await getDb().select().from(applications).where(eq(applications.requisitionId, requisition.id))).toEqual([]);
  });

  it("a changed privacy version is refused", async () => {
    const requisition = await job();
    expect(await submitApplication(await input(requisition, { consentVersion: "0.9" }))).toEqual({ ok: false, reason: "consentChanged" });
  });

  it("an unpublished requisition refuses the submission", async () => {
    const requisition = await job();
    const applyInput = await input(requisition);
    await getDb().update(requisitions).set({ isPublished: false, state: "ON_HOLD" }).where(eq(requisitions.id, requisition.id));
    expect(await submitApplication(applyInput)).toEqual({ ok: false, reason: "closed" });
  });

  it("a requisition in re-approval accepts applications", async () => {
    const requisition = await job({ state: "PENDING_APPROVAL" });
    expect((await submitApplication(await input(requisition))).ok).toBe(true);
  });

  it("a failure after the CV upload leaves no application and no blob", async () => {
    const original = await getDb()
      .select({ id: templates.id })
      .from(templates)
      .where(and(eq(templates.type, "EMAIL"), eq(templates.isActive, true), eq(templates.triggerStatus, "APPLIED")));
    const brokenName = `Broken ${randomUUID()}`;
    const keys: string[] = [];
    const storage = getStorage();
    const upload = storage.upload.bind(storage);
    vi.spyOn(storage, "upload").mockImplementation(async (bytes, contentType) => {
      const result = await upload(bytes, contentType);
      keys.push(result.key);
      return result;
    });
    try {
      await getDb().update(templates).set({ isActive: false }).where(inArray(templates.id, original.map((row) => row.id).concat(randomUUID())));
      // Stored directly, bypassing the save check: the token has no value for a stage email, so queueing fails after the upload.
      await getDb().insert(templates).values({ type: "EMAIL", name: brokenName, triggerStatus: "APPLIED", subject: "Hi", body: "[[OFFER_SALARY]]" });
      const requisition = await job();
      await expect(submitApplication(await input(requisition))).rejects.toThrow();
      expect(await getDb().select().from(applications).where(eq(applications.requisitionId, requisition.id))).toEqual([]);
      expect(keys).toHaveLength(1);
      expect((await fetch((await storage.getSignedUrl(keys[0])).url)).status).toBe(404);
    } finally {
      await getDb().delete(templates).where(eq(templates.name, brokenName));
      if (original.length > 0) await getDb().update(templates).set({ isActive: true }).where(inArray(templates.id, original.map((row) => row.id)));
    }
  });

  it("stores two 9.5 MiB files with MAX_UPLOAD_MB = 10", async () => {
    const big = new Uint8Array(Math.round(9.5 * 1_048_576));
    big.set(VALID_PDF);
    // A valid PDF padded with spaces after %%EOF still parses.
    big.fill(0x20, VALID_PDF.length);
    await getDb().insert(settings).values({ key: "MAX_UPLOAD_MB", value: "10" }).onConflictDoUpdate({ target: settings.key, set: { value: "10" } });
    try {
      const requisition = await job();
      const result = await applied(await input(requisition, { cv: { bytes: big, name: "cv.pdf" }, coverLetter: { bytes: big, name: "letter.pdf" } }));
      const stored = await getDb().select().from(files).where(eq(files.ownerId, result.applicationId));
      expect(stored.map((file) => file.sizeBytes)).toEqual([big.length, big.length]);
    } finally {
      await getDb().delete(settings).where(eq(settings.key, "MAX_UPLOAD_MB"));
    }
  });

  it("M2: logs hold IDs only, never the email, the name or an @", async () => {
    const lines: string[] = [];
    const capture = createLogger(new Writable({ write: (chunk, _encoding, done) => (lines.push(String(chunk)), done()) }));
    capture.level = "debug";
    vi.spyOn(logger, "child").mockImplementation((bindings) => capture.child(bindings));
    for (const level of ["info", "warn", "error", "debug"] as const) {
      vi.spyOn(logger, level).mockImplementation(((...args: Parameters<typeof capture.info>) => capture[level](...args)) as never);
    }
    const requisition = await job();
    await applied(await input(requisition, {}, { firstName: "Zbigniewa", lastName: "Ćmielewska" }));
    expect(lines.length).toBeGreaterThan(0);
    const output = lines.join("\n");
    expect(output).not.toContain("@");
    expect(output).not.toContain("Zbigniewa");
    expect(output).not.toContain("Ćmielewska");
  });
});

describe("duplicates", () => {
  it("F7: a second application from the same email (other case and spaces) within 24 h is refused", async () => {
    const requisition = await job();
    const email = `ann-${randomUUID()}@example.com`;
    await applied(await input(requisition, {}, { email }));
    expect(await submitApplication(await input(requisition, {}, { email: `  ${email.toUpperCase().replace("@EXAMPLE.COM", "@Example.com")} ` }))).toEqual({
      ok: false,
      reason: "duplicate",
    });
  });

  it("F7: the same email is accepted on another requisition, and again after 24 h", async () => {
    const first = await job();
    const email = `ann-${randomUUID()}@example.com`;
    const original = await applied(await input(first, {}, { email }));
    expect((await submitApplication(await input(await job(), {}, { email }))).ok).toBe(true);
    await getDb()
      .update(applications)
      .set({ appliedAt: new Date(Date.now() - 25 * HOUR) })
      .where(eq(applications.id, original.applicationId));
    expect((await submitApplication(await input(first, {}, { email }))).ok).toBe(true);
  });

  it("F7: two concurrent submissions create exactly one application", async () => {
    const requisition = await job();
    const email = `ann-${randomUUID()}@example.com`;
    const results = await Promise.all([submitApplication(await input(requisition, {}, { email })), submitApplication(await input(requisition, {}, { email }))]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: "duplicate" }]);
    expect(await getDb().select().from(applications).where(eq(applications.requisitionId, requisition.id))).toHaveLength(1);
  });
});
