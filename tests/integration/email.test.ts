// The email service against PostgreSQL, pg-boss, Azurite and Mailpit
// (ats-project-scope.md E1–E6; tech-stack.md §9, J1, J3, J4, J7, T3, M2).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Writable } from "node:stream";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type EmailTransport, type OutgoingEmail, outboxTransport, smtpTransport } from "@/server/adapters/email";
import type { Job } from "@/server/adapters/job-queue";
import { type Tx, getDb, getPool, withTransaction } from "@/server/db";
import { emailLog, requisitions, settings, users } from "@/server/db/schema";
import { queueEmail, queueTemplateEmail } from "@/server/email";
import { createEmailSendHandler } from "@/server/email/send";
import { storePdf } from "@/server/files/store-pdf";
import { createLogger, logger } from "@/server/logger";
import { processDueJobs } from "../support/process-due-jobs";
import { searchMessages, waitForMessage } from "../support/mailpit";
import { insertApplication, insertRequisition, insertUser } from "./fixtures";
import { rolledBack } from "./helpers";

const smtp = smtpTransport("localhost", 1025);
const recipient = () => `e2e-${randomUUID()}@example.com`;

afterEach(async () => {
  vi.restoreAllMocks();
  // Tests that run the handler directly leave their pg-boss job due; the
  // rows are no longer QUEUED, so draining sends nothing, and later test
  // files in this worker don't find stray email.send jobs.
  await processDueJobs();
  await getDb().delete(settings).where(sql`${settings.key} IN ('SENDER_EMAIL', 'FALLBACK_REPLY_TO_EMAIL')`);
});

async function row(id: string) {
  const [found] = await getDb().select().from(emailLog).where(eq(emailLog.id, id));
  return found;
}

/** A requisition with an active recruiter of its own and an application to `to`. */
async function candidateSetup(tx: Tx, to = recipient(), firstName = "Ada") {
  const recruiter = await insertUser(tx, "RECRUITER");
  const requisition = await insertRequisition(tx, { recruiterId: recruiter.id, title: "Backend Engineer" });
  const application = await insertApplication(tx, { requisitionId: requisition.id, email: to, firstName, lastName: "Lovelace" });
  return { recruiter, requisition, application, to };
}

async function queued(input: Partial<Parameters<typeof queueEmail>[1]> & { to: string }, tx?: Tx) {
  const run = (t: Tx) => queueEmail(t, { audience: "STAFF", subject: "Subject", body: "Body", ...input });
  return tx ? run(tx) : withTransaction(run);
}

/** Runs the email.send handler once for a row, like a worker would. */
async function sendNow(emailLogId: string, transport: EmailTransport = smtp, retryCount = 0) {
  const job: Job = { id: randomUUID(), queue: "email.send", data: { emailLogId }, retryCount };
  await createEmailSendHandler({ transport: () => transport })(job);
}

/** A transport that fails `failures` times for `to`, then delegates to Mailpit; counts its calls. */
function flakyTransport(failures: number) {
  let calls = 0;
  const transport: EmailTransport = {
    provider: "smtp",
    async send(email: OutgoingEmail) {
      calls += 1;
      if (calls <= failures) throw Object.assign(new Error(`550 mailbox ${email.to} unavailable`), { responseCode: 550 });
      await smtp.send(email);
    },
  };
  return { transport, calls: () => calls };
}

/** Drives the clock forward until the row leaves QUEUED (T3: no sleeping). */
async function driveUntilSettled(id: string, transport: EmailTransport) {
  const handlers = { "email.send": createEmailSendHandler({ transport: () => transport }) };
  for (let hour = 1; hour <= 24 && (await row(id)).status === "QUEUED"; hour++) {
    await processDueJobs({ handlers, now: new Date(Date.now() + hour * 3_600_000) });
  }
}

describe("queueing (J1, J4)", () => {
  it("J1: a rollback after queueEmail leaves no email_log row and no job", async () => {
    let id = "";
    await rolledBack(async (tx) => {
      id = await queued({ to: recipient() }, tx);
    });
    expect(await row(id)).toBeUndefined();
    const { rows } = await getPool().query("SELECT 1 FROM pgboss.job WHERE data->>'emailLogId' = $1", [id]);
    expect(rows).toEqual([]);
  });

  it("logs the full content as QUEUED, with a job whose payload holds the row ID only", async () => {
    const to = recipient();
    const id = await queued({ to, cc: [recipient()], subject: "Hello [[JOB_TITLE]]", body: "**Hi**", values: { JOB_TITLE: "QA" } });
    const logged = await row(id);
    expect(logged).toMatchObject({ status: "QUEUED", direction: "OUTBOUND", recipient: to, subject: "Hello QA", bodyRendered: "<p><strong>Hi</strong></p>", audience: "STAFF" });
    expect(logged.jobId).toBeTruthy();
    const { rows } = await getPool().query<{ data: unknown }>("SELECT data FROM pgboss.job WHERE id = $1", [logged.jobId]);
    expect(rows[0].data).toEqual({ emailLogId: id });
    expect(JSON.stringify(rows[0].data)).not.toContain("@");
    await sendNow(id);
  });

  it("an invalid to throws before anything is written", async () => {
    const before = (await getDb().select({ n: sql<number>`count(*)::int` }).from(emailLog))[0].n;
    await expect(queued({ to: "not-an-email" })).rejects.toThrow();
    expect((await getDb().select({ n: sql<number>`count(*)::int` }).from(emailLog))[0].n).toBe(before);
  });

  it("takes the requisition from the application", async () => {
    const id = await withTransaction(async (tx) => {
      const { application, to } = await candidateSetup(tx);
      return queued({ to, audience: "CANDIDATE", applicationId: application.id }, tx);
    });
    const logged = await row(id);
    expect(logged.requisitionId).toBeTruthy();
    await sendNow(id);
  });
});

describe("sending (E1–E4, E6)", () => {
  it("E1: From is SENDER_EMAIL, and a changed setting applies to the next send", async () => {
    const first = recipient();
    await sendNow(await queued({ to: first }));
    expect((await waitForMessage({ to: first })).from).toBe("careers@ats-demo.local");

    await getDb().insert(settings).values({ key: "SENDER_EMAIL", value: "careers2@ats-demo.local" });
    const second = recipient();
    await sendNow(await queued({ to: second }));
    const message = await waitForMessage({ to: second });
    expect(message.from).toBe("careers2@ats-demo.local");
    expect(message.messageId).toMatch(/@ats-demo\.local$/);
  });

  it("E2: Reply-To is the requisition's current recruiter at send time, else the fallback", async () => {
    const { id, requisitionId, to } = await withTransaction(async (tx) => {
      const setup = await candidateSetup(tx);
      return { id: await queued({ to: setup.to, audience: "CANDIDATE", applicationId: setup.application.id }, tx), requisitionId: setup.requisition.id, to: setup.to };
    });
    // The recruiter changes between queueing and sending.
    const newRecruiter = await withTransaction((tx) => insertUser(tx, "RECRUITER"));
    await getDb().update(requisitions).set({ recruiterId: newRecruiter.id }).where(eq(requisitions.id, requisitionId));
    await sendNow(id);
    expect((await waitForMessage({ to })).replyTo).toEqual([newRecruiter.email]);
    expect((await row(id)).replyTo).toBe(newRecruiter.email);

    // An inactive recruiter falls back.
    const second = await withTransaction(async (tx) => {
      const setup = await candidateSetup(tx);
      await tx.update(users).set({ isActive: false }).where(eq(users.id, setup.recruiter.id));
      return { id: await queued({ to: setup.to, audience: "CANDIDATE", applicationId: setup.application.id }, tx), to: setup.to };
    });
    await sendNow(second.id);
    expect((await waitForMessage({ to: second.to })).replyTo).toEqual(["recruiting@ats-demo.local"]);
  });

  it("E2: a staff email without a requisition uses FALLBACK_REPLY_TO_EMAIL", async () => {
    await getDb().insert(settings).values({ key: "FALLBACK_REPLY_TO_EMAIL", value: "team@ats-demo.local" });
    const to = recipient();
    await sendNow(await queued({ to }));
    expect((await waitForMessage({ to })).replyTo).toEqual(["team@ats-demo.local"]);
  });

  it("E3: a candidate email's HTML and text end with the Reply-To address and the reply line; a staff email has none", async () => {
    const { id, to, recruiterEmail } = await withTransaction(async (tx) => {
      const setup = await candidateSetup(tx);
      return { id: await queued({ to: setup.to, audience: "CANDIDATE", applicationId: setup.application.id }, tx), to: setup.to, recruiterEmail: setup.recruiter.email };
    });
    await sendNow(id);
    const message = await waitForMessage({ to });
    for (const part of [message.html, message.text]) {
      expect(part).toContain(recruiterEmail);
      expect(part).toContain("Reply to this email to reach your recruiter.");
    }

    const staff = recipient();
    await sendNow(await queued({ to: staff }));
    const staffMessage = await waitForMessage({ to: staff });
    expect(staffMessage.html).not.toContain("Reply to this email");
    expect(staffMessage.text).not.toContain("Reply to this email");
  });

  it("E4: the email_log row holds the full content and the final body equals the HTML Mailpit received", async () => {
    const ics = "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:uid-1\r\nSEQUENCE:0\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    const file = await withTransaction((tx) =>
      storePdf(tx, { ownerType: "OFFER", ownerId: randomUUID(), kind: "OFFER_LETTER", originalName: "Offer letter.pdf", bytes: new Uint8Array(readFileSync("tests/fixtures/pdf/valid.pdf")) }),
    );
    const { id, to } = await withTransaction(async (tx) => {
      const setup = await candidateSetup(tx);
      const cc = recipient();
      return {
        id: await queued(
          {
            to: setup.to,
            cc: [cc],
            audience: "CANDIDATE",
            applicationId: setup.application.id,
            subject: "Interview for [[JOB_TITLE]]",
            body: "# Invitation\n\nSee you soon.",
            values: { JOB_TITLE: "QA" },
            ics: { content: ics, method: "REQUEST", uid: "uid-1", sequence: 0 },
            attachmentFileIds: [file.id],
          },
          tx,
        ),
        to: setup.to,
      };
    });
    await sendNow(id);
    const logged = await row(id);
    expect(logged).toMatchObject({ status: "SENT", recipient: to, subject: "Interview for QA", icsContent: ics, icsUid: "uid-1", icsSequence: 0, attachmentFileIds: [file.id] });
    expect(logged.cc).toMatch(/^e2e-.*@example\.com$/);
    expect(logged.replyTo).toBeTruthy();
    expect(logged.sentAt).toBeInstanceOf(Date);
    expect(logged.scheduledFor).toBeInstanceOf(Date);
    expect(logged.bodyRendered).toContain("Reply to this email to reach your recruiter.");

    const message = await waitForMessage({ to });
    // SMTP carries line breaks as CRLF; the content is otherwise identical.
    expect(message.html.replaceAll("\r\n", "\n")).toBe(logged.bodyRendered);
    expect(`<${message.messageId}>`).toBe(logged.providerMessageId);
    expect(message.cc).toEqual([logged.cc]);
    const pdf = message.attachments.find((a) => a.name === "Offer letter.pdf")!;
    expect(pdf.contentType).toBe("application/pdf");
    expect(new Uint8Array(pdf.bytes)).toEqual(new Uint8Array(readFileSync("tests/fixtures/pdf/valid.pdf")));
    expect(message.attachments.map((a) => a.name)).toContain("invite.ics");
    expect(message.raw).toMatch(/Content-Type: text\/calendar; charset=utf-8; method=REQUEST/i);
  });

  it("E6: with smtp the row is SENT and in Mailpit; with outbox it is CAPTURED and not in Mailpit", async () => {
    const viaSmtp = recipient();
    const smtpId = await queued({ to: viaSmtp });
    await sendNow(smtpId);
    expect((await row(smtpId)).status).toBe("SENT");
    await waitForMessage({ to: viaSmtp });

    const viaOutbox = recipient();
    const outboxId = await queued({ to: viaOutbox, audience: "STAFF" });
    await sendNow(outboxId, outboxTransport());
    const logged = await row(outboxId);
    expect(logged).toMatchObject({ status: "CAPTURED", replyTo: "recruiting@ats-demo.local" });
    expect(logged.providerMessageId).toMatch(/^<.+@ats-demo\.local>$/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await searchMessages(viaOutbox)).toEqual([]);
  });

  it("escapes values in the HTML part, keeps them literal in the text part, and never resolves a value again", async () => {
    const { to } = await withTransaction(async (tx) => {
      const setup = await candidateSetup(tx, recipient(), "<b>Ann</b> &");
      await tx.update(requisitions).set({ title: "[[JOB_TITLE]]" }).where(eq(requisitions.id, setup.requisition.id));
      const [template] = await tx
        .insert((await import("@/server/db/schema")).templates)
        .values({ type: "EMAIL", name: `Escaping ${randomUUID()}`, subject: "For [[CANDIDATE_FULL_NAME]]", body: "Dear [[CANDIDATE_FULL_NAME]], about [[JOB_TITLE]]." })
        .returning();
      const id = await queueTemplateEmail(tx, { templateId: template.id, applicationId: setup.application.id });
      return { id, to: setup.to };
    });
    await processDueJobs();
    const message = await waitForMessage({ to });
    expect(message.html).toContain("Dear &lt;b&gt;Ann&lt;/b&gt; &amp; Lovelace, about [[JOB_TITLE]].");
    expect(message.text).toContain("Dear <b>Ann</b> & Lovelace, about [[JOB_TITLE]].");
    expect(message.subject).toBe("For <b>Ann</b> & Lovelace");
  });

  it("queueTemplateEmail uses the recruiting team and the fallback address for an inactive recruiter (E2, E3)", async () => {
    const id = await withTransaction(async (tx) => {
      const setup = await candidateSetup(tx);
      await tx.update(users).set({ isActive: false }).where(eq(users.id, setup.recruiter.id));
      const [template] = await tx
        .insert((await import("@/server/db/schema")).templates)
        .values({ type: "EMAIL", name: `Fallback ${randomUUID()}`, subject: "s", body: "[[RECRUITER_FULL_NAME]] <[[RECRUITER_EMAIL]]>" })
        .returning();
      return queueTemplateEmail(tx, { templateId: template.id, applicationId: setup.application.id });
    });
    expect((await row(id)).bodyRendered).toBe("<p>the recruiting team &lt;recruiting@ats-demo.local&gt;</p>");
    await sendNow(id);
  });

  it("cancels instead of sending when the application was anonymized", async () => {
    const { id, applicationId, to } = await withTransaction(async (tx) => {
      const setup = await candidateSetup(tx);
      return { id: await queued({ to: setup.to, audience: "CANDIDATE", applicationId: setup.application.id }, tx), applicationId: setup.application.id, to: setup.to };
    });
    await getPool().query(
      "UPDATE applications SET first_name = NULL, last_name = NULL, email = NULL, email_hash = NULL, phone = NULL, anonymized_at = now() WHERE id = $1",
      [applicationId],
    );
    await sendNow(id);
    expect(await row(id)).toMatchObject({ status: "CANCELLED", error: "ANONYMIZED" });
    expect(await searchMessages(to)).toEqual([]);
  });
});

describe("retries and idempotency (E5, J3)", () => {
  it("E5: a transport that always fails is retried and the row ends FAILED after 6 attempts", async () => {
    const { transport, calls } = flakyTransport(Infinity);
    const id = await queued({ to: recipient() });
    await driveUntilSettled(id, transport);

    const logged = await row(id);
    expect(logged.status).toBe("FAILED");
    expect(logged.error).toBe("Error: 550");
    expect(logged.error).not.toContain("@");
    expect(calls()).toBe(6);
    const { rows } = await getPool().query<{ state: string }>("SELECT state FROM pgboss.job WHERE id = $1", [logged.jobId]);
    expect(rows[0].state).toBe("failed");
  });

  it("E5: a transport that fails twice and then succeeds ends SENT after 3 attempts", async () => {
    const { transport, calls } = flakyTransport(2);
    const to = recipient();
    const id = await queued({ to });
    await driveUntilSettled(id, transport);
    expect(await row(id)).toMatchObject({ status: "SENT", error: null });
    expect(calls()).toBe(3);
    await waitForMessage({ to });
  });

  it("E5: a deleted attachment fails the attempt and keeps the email QUEUED until the last retry", async () => {
    const file = await withTransaction((tx) =>
      storePdf(tx, { ownerType: "OFFER", ownerId: randomUUID(), kind: "OFFER_LETTER", originalName: null, bytes: new Uint8Array(readFileSync("tests/fixtures/pdf/valid.pdf")) }),
    );
    await getPool().query("UPDATE files SET deleted_at = now() WHERE id = $1", [file.id]);
    const id = await queued({ to: recipient(), attachmentFileIds: [file.id] });
    await expect(sendNow(id)).rejects.toThrow("AttachmentMissingError");
    expect(await row(id)).toMatchObject({ status: "QUEUED", error: "AttachmentMissingError" });
    await expect(sendNow(id, smtp, 5)).rejects.toThrow();
    expect((await row(id)).status).toBe("FAILED");
  });

  it("J3: running the handler twice sends one message and leaves one SENT row", async () => {
    const to = recipient();
    const id = await queued({ to });
    await sendNow(id);
    await sendNow(id);
    await waitForMessage({ to });
    expect(await searchMessages(to)).toHaveLength(1);
    expect((await row(id)).status).toBe("SENT");
  });

  it("J3: two concurrent runs send one message", async () => {
    const to = recipient();
    const id = await queued({ to });
    await Promise.all([sendNow(id), sendNow(id)]);
    await waitForMessage({ to });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await searchMessages(to)).toHaveLength(1);
  });

  it("J3: a CANCELLED row is never sent", async () => {
    const to = recipient();
    const id = await queued({ to });
    await getDb().update(emailLog).set({ status: "CANCELLED" }).where(eq(emailLog.id, id));
    await sendNow(id);
    expect((await row(id)).status).toBe("CANCELLED");
    expect(await searchMessages(to)).toEqual([]);
  });
});

describe("delay and logging", () => {
  it("an email due in 24 h is not sent now, and is sent once the test clock passes it (T3)", async () => {
    const to = recipient();
    const id = await queued({ to, startAfter: new Date(Date.now() + 24 * 3_600_000) });
    await processDueJobs();
    expect((await row(id)).status).toBe("QUEUED");
    await processDueJobs({ now: new Date(Date.now() + 25 * 3_600_000) });
    expect((await row(id)).status).toBe("SENT");
    await waitForMessage({ to });
  });

  it("logs IDs only: no address appears in the logs while queueing and sending", async () => {
    const lines: string[] = [];
    const capture = createLogger(new Writable({ write: (chunk, _encoding, done) => (lines.push(String(chunk)), done()) }));
    capture.level = "debug";
    vi.spyOn(logger, "child").mockImplementation((bindings) => capture.child(bindings));
    for (const level of ["info", "warn", "debug", "error"] as const) {
      vi.spyOn(logger, level).mockImplementation(((...args: Parameters<typeof capture.info>) => capture[level](...args)) as never);
    }
    const { transport } = flakyTransport(1);
    const cc = recipient();
    const { id, to, recruiterEmail } = await withTransaction(async (tx) => {
      const setup = await candidateSetup(tx);
      const queuedId = await queued({ to: setup.to, cc: [cc], audience: "CANDIDATE", applicationId: setup.application.id }, tx);
      return { id: queuedId, to: setup.to, recruiterEmail: setup.recruiter.email };
    });
    await driveUntilSettled(id, transport);
    expect((await row(id)).status).toBe("SENT");
    expect(lines.length).toBeGreaterThan(2);
    const output = lines.join("\n");
    for (const address of [to, cc, recruiterEmail, "careers@ats-demo.local"]) expect(output).not.toContain(address);
    // Stack traces quote pnpm paths such as node_modules/.pnpm/vitest@5…;
    // outside them no "@" may appear at all.
    const withoutStacks = lines
      .map((line) => {
        const record = JSON.parse(line) as { err?: Record<string, unknown> };
        return JSON.stringify({ ...record, err: record.err && { ...record.err, stack: undefined } });
      })
      .join("\n");
    expect(withoutStacks).not.toContain("@");
  });
});
