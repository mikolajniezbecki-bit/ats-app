// Offer approval on the Compose stack (ats-project-scope.md A1, A3, A9, V3b):
// a Recruiter submits an offer to the demo Hiring Manager, who rejects it
// with a comment; the Recruiter edits and resubmits; the Hiring Manager
// approves from "My approvals".
import { randomUUID } from "node:crypto";
import { insertApplication } from "./support/applications";
import { query } from "./support/db";
import { expect, test } from "./support/fixtures";
import { insertRequisition } from "./support/requisitions";
import { ROLES } from "./support/users";

test("A3: a Recruiter submits an offer, the Hiring Manager rejects it, the Recruiter resubmits, and the Hiring Manager approves from My approvals", async ({ asRole }) => {
  const job = await insertRequisition({ state: "APPROVED", approved: true, isPublished: true });
  const application = await insertApplication(job.id, { status: "OFFER" });
  const [template] = await query<{ id: string }>("SELECT id FROM templates WHERE type = 'OFFER' AND is_active ORDER BY name LIMIT 1");
  const [recruiterRow] = await query<{ id: string }>("SELECT id FROM users WHERE email = $1", [ROLES.recruiter.email]);
  const start = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const [offer] = await query<{ id: string }>(
    `INSERT INTO offers (application_id, template_id, created_by_user_id, job_title, salary, currency, start_date)
     VALUES ($1, $2, $3, $4, 85000, 'EUR', $5) RETURNING id`,
    [application.id, template.id, recruiterRow.id, `Engineer ${randomUUID().slice(0, 6)}`, start],
  );

  const recruiter = await asRole("recruiter");
  await recruiter.goto(`/applications/${application.id}`);
  const card = recruiter.getByTestId(`offer-${offer.id}`);
  await card.getByRole("button", { name: "Submit for approval" }).click();
  const submitForm = recruiter.getByRole("form", { name: "Submit for approval" });
  await submitForm.getByLabel("Approver").selectOption({ label: ROLES["hiring-manager"].name });
  await submitForm.getByRole("button", { name: "Submit for approval" }).click();
  await expect(recruiter.getByTestId(`offer-approval-${offer.id}`)).toContainText(`Awaiting approval by ${ROLES["hiring-manager"].name}`);

  const hm = await asRole("hiring-manager");
  await hm.goto(`/applications/${application.id}`);
  await hm.getByTestId(`offer-${offer.id}`).getByRole("button", { name: "Reject" }).click();
  const rejectForm = hm.getByRole("form", { name: "Reject" });
  await rejectForm.getByRole("button", { name: "Reject" }).click();
  await expect(rejectForm.getByText("Add a comment to reject.")).toBeVisible();
  await rejectForm.getByLabel("Comment", { exact: true }).fill("Please lower the salary to the band.");
  await rejectForm.getByRole("button", { name: "Reject" }).click();
  await expect(hm.getByTestId(`offer-latest-${offer.id}`)).toContainText("Please lower the salary to the band.");

  await recruiter.reload();
  await card.getByRole("button", { name: "Edit" }).click();
  const edit = recruiter.getByRole("form", { name: "Edit" });
  await edit.getByLabel("Gross annual salary").fill("82000");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(card).toContainText("82,000.00 EUR");
  await card.getByRole("button", { name: "Submit for approval" }).click();
  const resubmit = recruiter.getByRole("form", { name: "Submit for approval" });
  await resubmit.getByLabel("Approver").selectOption({ label: ROLES["hiring-manager"].name });
  await resubmit.getByRole("button", { name: "Submit for approval" }).click();
  await expect(card).toContainText("Approval: Awaiting approval");

  await hm.goto("/approvals");
  await hm.getByTestId(`offer-approval-${offer.id}`).getByRole("link").click();
  await hm.getByTestId(`offer-${offer.id}`).getByRole("button", { name: "Approve" }).click();
  await hm.getByRole("form", { name: "Approve" }).getByRole("button", { name: "Approve" }).click();
  await expect(hm.getByTestId(`offer-${offer.id}`)).toContainText("Approval: Approved");

  const [row] = await query<{ approval_status: string; salary: string }>("SELECT approval_status, salary FROM offers WHERE id = $1", [offer.id]);
  expect(row).toEqual({ approval_status: "APPROVED", salary: "82000.00" });
});
