// Admin Outbox queries, the .ics download and the J6 job listings
// (tech-stack.md §9, J6, T5).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { GET as ics } from "@/app/api/admin/outbox/[id]/ics/route";
import { countJobsByState, getBoss, listJobs } from "@/server/adapters/job-queue";
import { getDb, withTransaction } from "@/server/db";
import { emailLog, files, jobRuns } from "@/server/db/schema";
import { warsawRunDate } from "@/server/domain/daily-tasks";
import { getOutboxIcs, getOutboxMessage, listOutbox } from "@/server/email/outbox";
import { storePdf } from "@/server/files/store-pdf";
import { listRecentJobRuns, oldestShownRunDate } from "@/server/jobs/runs";
import { createTestQueue, sendTestJob } from "../support/jobs";
import { ORIGIN, signedIn } from "./sessions";

const ICS = "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR\r\n";

async function logRow(values: Partial<typeof emailLog.$inferInsert> = {}) {
  const [row] = await getDb()
    .insert(emailLog)
    .values({ audience: "STAFF", recipient: `e2e-${randomUUID()}@example.com`, subject: "Subject", bodyRendered: "<p>Body</p>", status: "CAPTURED", ...values })
    .returning();
  return row;
}

describe("job listings (J6)", () => {
  it("counts queued (created + retry), active and failed jobs, and lists the failed job's error", async () => {
    const queue = await createTestQueue("j6", { retryLimit: 0 });
    const boss = await getBoss();
    const active = await sendTestJob(queue, { n: "active" });
    expect((await boss.fetch(queue)).map((job) => job.id)).toEqual([active]);
    const failed = await sendTestJob(queue, { n: "failed" });
    await boss.fetch(queue);
    await boss.fail(queue, failed, { message: "boom: handler failed" });
    await sendTestJob(queue, { n: "due" });
    await sendTestJob(queue, { n: "delayed" }, new Date(Date.now() + 3_600_000));

    expect(await countJobsByState([queue])).toEqual([{ queue, queued: 2, active: 1, failed: 1 }]);
    const failedJobs = await listJobs(queue, "failed");
    expect(failedJobs).toEqual([expect.objectContaining({ id: failed, state: "failed", error: "boom: handler failed", data: { n: "failed" } })]);
    expect((await listJobs(queue, "queued")).map((job) => job.data)).toEqual([{ n: "delayed" }, { n: "due" }]);
    expect((await listJobs(queue, "active")).map((job) => job.id)).toEqual([active]);
  });

  it("cuts errors to 500 characters and lists at most 50 jobs per state, newest first", async () => {
    const queue = await createTestQueue("j6limit", { retryLimit: 0 });
    const boss = await getBoss();
    const id = await sendTestJob(queue);
    await boss.fetch(queue);
    await boss.fail(queue, id, { message: "x".repeat(800) });
    expect((await listJobs(queue, "failed"))[0].error).toHaveLength(500);

    for (let i = 0; i < 55; i++) await sendTestJob(queue, { i: String(i) });
    const queued = await listJobs(queue, "queued");
    expect(queued).toHaveLength(50);
  });

  it("lists job_runs of the last 30 Warsaw days, today included: 29 days ago yes, 30 and 31 days ago no", async () => {
    const now = new Date();
    const dayOffset = (days: number) => warsawRunDate(new Date(now.getTime() - days * 86_400_000));
    const name = `test.runs.${randomUUID()}`;
    const rows = [0, 29, 30, 31].map((days) => ({ jobName: name, runDate: dayOffset(days), startedAt: now, finishedAt: now, status: "COMPLETED" as const }));
    await getDb().insert(jobRuns).values(rows);
    try {
      const listed = (await listRecentJobRuns(now)).filter((run) => run.jobName === name).map((run) => run.runDate);
      expect(listed).toEqual([dayOffset(0), dayOffset(29)]);
      expect(oldestShownRunDate(now)).toBe(dayOffset(29));
    } finally {
      await getDb().delete(jobRuns).where(eq(jobRuns.jobName, name));
    }
  });
});

describe("Outbox queries", () => {
  it("lists every status newest first and filters by status", async () => {
    const statuses = ["QUEUED", "SENT", "CAPTURED", "FAILED", "CANCELLED"] as const;
    const created = [];
    for (const status of statuses) created.push(await logRow({ status }));
    const all = await listOutbox();
    for (const row of created) expect(all.rows.map((r) => r.id)).toContain(row.id);
    expect(all.rows[0].id).toBe(created.at(-1)!.id);

    const failedOnly = await listOutbox({ status: "FAILED" });
    expect(failedOnly.rows.every((row) => row.status === "FAILED")).toBe(true);
    expect(failedOnly.rows.map((r) => r.id)).toContain(created[3].id);
  });

  it("pages 50 rows at a time and shows sent_at, or scheduled_for while not sent", async () => {
    const scheduled = new Date("2030-01-01T10:00:00Z");
    const sent = await logRow({ status: "SENT", scheduledFor: scheduled, sentAt: new Date("2030-01-01T10:05:00Z") });
    const waiting = await logRow({ status: "QUEUED", scheduledFor: scheduled });
    const page = await listOutbox();
    expect(page.rows.find((row) => row.id === sent.id)?.time).toEqual(new Date("2030-01-01T10:05:00Z"));
    expect(page.rows.find((row) => row.id === waiting.id)?.time).toEqual(scheduled);
    expect(page.rows.length).toBeLessThanOrEqual(50);
    for (let i = 0; i < 51; i++) await logRow();
    const second = await listOutbox({ page: 2 });
    expect(second.page).toBe(2);
    expect(second.pages).toBeGreaterThanOrEqual(2);
    expect((await listOutbox()).rows).toHaveLength(50);
  });

  it("returns a message with its attachments, marking deleted files", async () => {
    const bytes = new Uint8Array(readFileSync("tests/fixtures/pdf/valid.pdf"));
    const kept = await withTransaction((tx) => storePdf(tx, { ownerType: "OFFER", ownerId: randomUUID(), kind: "OFFER_LETTER", originalName: "Offer.pdf", bytes }));
    const deleted = await withTransaction((tx) => storePdf(tx, { ownerType: "OFFER", ownerId: randomUUID(), kind: "OFFER_LETTER", originalName: "Old.pdf", bytes }));
    await getDb().update(files).set({ deletedAt: new Date() }).where(eq(files.id, deleted.id));
    const row = await logRow({ attachmentFileIds: [kept.id, deleted.id], icsContent: ICS });

    const message = await getOutboxMessage(row.id);
    expect(message?.attachments).toEqual([
      { id: kept.id, name: "Offer.pdf", deleted: false },
      { id: deleted.id, name: "Old.pdf", deleted: true },
    ]);
    expect(await getOutboxMessage(randomUUID())).toBeUndefined();
    expect(await getOutboxMessage("nope")).toBeUndefined();
    expect(await getOutboxIcs(row.id)).toBe(ICS);
  });
});

describe("GET /api/admin/outbox/[id]/ics", () => {
  const call = (id: string, cookie?: string) =>
    ics(new Request(`${ORIGIN}/api/admin/outbox/${id}/ics`, { headers: cookie ? { cookie } : {} }), { params: Promise.resolve({ id }) });

  it("V1: an Admin downloads the stored .ics as a text/calendar attachment", async () => {
    const row = await logRow({ icsContent: ICS });
    const response = await call(row.id, (await signedIn("ADMIN")).cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="invite-${row.id}.ics"`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe(ICS);
  });

  it("returns 404 for a message without an .ics, a purged one and an unknown ID", async () => {
    const { cookie } = await signedIn("ADMIN");
    const noIcs = await logRow();
    const purged = await logRow({ icsContent: null, recipient: null, subject: null, bodyRendered: null });
    for (const id of [noIcs.id, purged.id, randomUUID(), "nope"]) expect((await call(id, cookie)).status, id).toBe(404);
  });

  it.each(["RECRUITER", "HIRING_MANAGER", "INTERVIEWER"] as const)("AU9: %s gets 403 and no content", async (role) => {
    const row = await logRow({ icsContent: ICS });
    const response = await call(row.id, (await signedIn(role)).cookie);
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("VCALENDAR");
  });

  it("AU9: without a session it returns 401", async () => {
    const row = await logRow({ icsContent: ICS });
    expect((await call(row.id)).status).toBe(401);
  });
});
