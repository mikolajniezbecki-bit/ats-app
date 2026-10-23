// Creates a CAPTURED email the way Azure's outbox transport would (Sprint 0
// proof #8): a PDF stored in Azurite, an email with that attachment and an
// .ics queued through queueEmail(), then sent by the real email.send handler
// with the outbox transport. It is queued a year ahead, so the Compose
// worker doesn't send it to Mailpit first; the handler then finds it
// CAPTURED and does nothing when that job comes due. Prints JSON IDs.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { outboxTransport } from "@/server/adapters/email";
import { closeDb, withTransaction } from "@/server/db";
import { queueEmail } from "@/server/email";
import { createEmailSendHandler } from "@/server/email/send";
import { storePdf } from "@/server/files/store-pdf";

const ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//ATS//E2E//EN",
  "METHOD:REQUEST",
  "BEGIN:VEVENT",
  `UID:${randomUUID()}@ats-demo.local`,
  "SEQUENCE:0",
  "DTSTART:20300101T090000Z",
  "DTEND:20300101T100000Z",
  "SUMMARY:Interview",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

async function main(): Promise<void> {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const { to } = JSON.parse(input) as { to: string };
  const file = await withTransaction((tx) =>
    storePdf(tx, { ownerType: "OFFER", ownerId: randomUUID(), kind: "OFFER_LETTER", originalName: "Offer letter.pdf", bytes: new Uint8Array(readFileSync("tests/fixtures/pdf/valid.pdf")) }),
  );
  const emailLogId = await withTransaction((tx) =>
    queueEmail(tx, {
      to,
      audience: "CANDIDATE",
      subject: "Your interview",
      body: "[[LOGO]]\n\n# Interview invitation\n\nDear candidate, see the **attached** invite.",
      ics: { content: ICS, method: "REQUEST", uid: "e2e", sequence: 0 },
      attachmentFileIds: [file.id],
      startAfter: new Date(Date.now() + 365 * 86_400_000),
    }),
  );
  await createEmailSendHandler({ transport: outboxTransport })({ id: randomUUID(), queue: "email.send", data: { emailLogId }, retryCount: 0 });
  process.stdout.write(JSON.stringify({ emailLogId, fileId: file.id }));
  await closeDb();
}

void main();
