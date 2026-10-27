// The offer letter on the Compose stack (tech-stack.md P4–P7): rendering in
// the production image proves the fonts and the logo are in it. The demo
// Hiring Manager previews a pending offer, approves it, and the candidate's
// email arrives with the letter attached.
import { randomUUID } from "node:crypto";
import { waitForMessage } from "../support/mailpit";
import { insertApplication } from "./support/applications";
import { query } from "./support/db";
import { expect, test } from "./support/fixtures";
import { insertRequisition } from "./support/requisitions";
import { ROLES } from "./support/users";

test("P6, P7: the Hiring Manager previews a pending offer, approves it, and the candidate receives the PDF", async ({ asRole }) => {
  const job = await insertRequisition({ state: "APPROVED", approved: true, isPublished: true });
  const application = await insertApplication(job.id, { status: "OFFER" });
  const [template] = await query<{ id: string }>("SELECT id FROM templates WHERE type = 'OFFER' AND name = 'Default offer letter'");
  const [recruiter] = await query<{ id: string }>("SELECT id FROM users WHERE email = $1", [ROLES.recruiter.email]);
  const [hmRow] = await query<{ id: string }>("SELECT id FROM users WHERE email = $1", [ROLES["hiring-manager"].email]);
  const start = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const [offer] = await query<{ id: string }>(
    `INSERT INTO offers (application_id, template_id, created_by_user_id, job_title, salary, currency, start_date,
       approval_status, submitted_by_user_id, submitted_at, approver_id)
     VALUES ($1, $2, $3, $4, 85000, 'EUR', $5, 'PENDING', $3, now(), $6) RETURNING id`,
    [application.id, template.id, recruiter.id, `Engineer ${randomUUID().slice(0, 6)}`, start, hmRow.id],
  );
  await query("INSERT INTO approval_events (subject_type, subject_id, event, actor_user_id, to_approver_id) VALUES ('OFFER', $1, 'SUBMITTED', $2, $3)", [offer.id, recruiter.id, hmRow.id]);

  const hm = await asRole("hiring-manager");
  await hm.goto(`/applications/${application.id}`);
  const card = hm.getByTestId(`offer-${offer.id}`);
  const link = card.getByRole("link", { name: "Preview PDF" });
  await expect(link).toHaveAttribute("target", "_blank");
  const preview = await hm.request.get((await link.getAttribute("href"))!);
  expect(preview.status()).toBe(200);
  expect(preview.headers()["content-type"]).toBe("application/pdf");
  expect((await preview.body()).subarray(0, 5).toString()).toBe("%PDF-");

  await card.getByRole("button", { name: "Approve" }).click();
  await hm.getByRole("form", { name: "Approve" }).getByRole("button", { name: "Approve" }).click();
  await expect(card).toContainText("Approval: Approved");

  const message = await waitForMessage({ to: application.email, subjectIncludes: "Your offer for", timeoutMs: 30_000 });
  const pdf = message.attachments.find((file) => file.contentType === "application/pdf");
  expect(pdf).toBeDefined();
  expect(pdf!.bytes.subarray(0, 5).toString()).toBe("%PDF-");
  const [row] = await query<{ sent_at: Date | null }>("SELECT sent_at FROM offers WHERE id = $1", [offer.id]);
  expect(row.sent_at).not.toBeNull();
  await hm.reload();
  await expect(card).toContainText("Letter sent");
});
