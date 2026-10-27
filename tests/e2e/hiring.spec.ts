// Candidate response and hiring on the Compose stack (ats-project-scope.md
// §5.6 Response, R2, R6): on a requisition with one opening, the demo
// Recruiter records "Accepted" on a sent offer and hires the candidate; the
// requisition closes as Filled and leaves the job board.
import { randomUUID } from "node:crypto";
import { insertApplication } from "./support/applications";
import { query } from "./support/db";
import { expect, test } from "./support/fixtures";
import { insertRequisition } from "./support/requisitions";
import { ROLES } from "./support/users";

test("R6: a Recruiter records an accepted offer and hires; the requisition closes as Filled and leaves /jobs", async ({ asRole }) => {
  const word = `Hiring${randomUUID().slice(0, 8)}`;
  const job = await insertRequisition({ title: `Platform Engineer ${word}`, state: "APPROVED", approved: true, isPublished: true });
  const application = await insertApplication(job.id, { status: "OFFER" });
  const [template] = await query<{ id: string }>("SELECT id FROM templates WHERE type = 'OFFER' AND name = 'Default offer letter'");
  const [recruiterRow] = await query<{ id: string }>("SELECT id FROM users WHERE email = $1", [ROLES.recruiter.email]);
  const [hmRow] = await query<{ id: string }>("SELECT id FROM users WHERE email = $1", [ROLES["hiring-manager"].email]);
  const start = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  // A sent offer, as task 37's letter job leaves it.
  const [offer] = await query<{ id: string }>(
    `INSERT INTO offers (application_id, template_id, created_by_user_id, job_title, salary, currency, start_date,
       approval_status, submitted_by_user_id, submitted_at, approver_id, sent_at)
     VALUES ($1, $2, $3, $4, 85000, 'EUR', $5, 'APPROVED', $3, now(), $6, now()) RETURNING id`,
    [application.id, template.id, recruiterRow.id, `Platform Engineer ${word}`, start, hmRow.id],
  );

  const recruiter = await asRole("recruiter");
  await recruiter.goto(`/jobs?q=${word}`);
  await expect(recruiter.getByRole("link", { name: new RegExp(word) })).toBeVisible();

  await recruiter.goto(`/applications/${application.id}`);
  const status = recruiter.getByRole("form", { name: "Change status" });
  // R2: no accepted offer yet, so Hired isn't offered.
  await expect(status.getByLabel("New status").locator("option", { hasText: "Hired" })).toHaveCount(0);

  const card = recruiter.getByTestId(`offer-${offer.id}`);
  await card.getByRole("button", { name: "Record response" }).click();
  const form = recruiter.getByRole("form", { name: "Record response" });
  await expect(form).toContainText("This can't be undone.");
  await form.getByLabel("Accepted").check();
  await form.getByRole("button", { name: "Save response" }).click();
  await expect(card).toContainText("Candidate response: Accepted");
  await expect(card.getByRole("button", { name: "Record response" })).toHaveCount(0);

  await status.getByLabel("New status").selectOption({ label: "Hired" });
  await status.getByRole("button", { name: "Change status" }).click();
  // A Recruiter can't change a hired application (R4 is Admin only), so the control is gone.
  await expect(recruiter.getByText("No status change is possible now.")).toBeVisible();

  await recruiter.goto(`/requisitions/${job.id}`);
  const facts = recruiter.getByTestId("lifecycle-facts");
  await expect(facts).toContainText("Closed");
  await expect(facts).toContainText("Filled");
  await recruiter.goto(`/jobs?q=${word}`);
  await expect(recruiter.getByRole("link", { name: new RegExp(word) })).toHaveCount(0);

  const [row] = await query<{ state: string; close_reason: string; status: string }>(
    "SELECT r.state, r.close_reason, a.status FROM requisitions r JOIN applications a ON a.requisition_id = r.id WHERE a.id = $1",
    [application.id],
  );
  expect(row).toEqual({ state: "CLOSED", close_reason: "FILLED", status: "HIRED" });
});
