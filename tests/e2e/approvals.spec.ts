// Requisition first approval on the Compose stack (ats-project-scope.md A1,
// A3, A9; T5): submit, reject with a comment, resubmit, approve.
import { query } from "./support/db";
import { expect, test } from "./support/fixtures";
import { insertRequisition } from "./support/requisitions";

test("A3: a Recruiter submits to the Hiring Manager, who rejects with a comment and later approves", async ({ asRole }) => {
  const requisition = await insertRequisition();
  const recruiter = await asRole("recruiter");
  const hm = await asRole("hiring-manager");

  async function submitToHm() {
    await recruiter.goto(`/requisitions/${requisition.id}`);
    await recruiter.getByRole("button", { name: "Submit for approval" }).click();
    const form = recruiter.getByRole("form", { name: "Submit for approval" });
    await form.getByLabel("Approver").selectOption({ label: "E2E Hiring Manager" });
    await form.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(recruiter.getByTestId("approval-status")).toContainText("Awaiting approval by E2E Hiring Manager");
  }

  await submitToHm();
  await expect(recruiter.getByRole("link", { name: "Edit" })).toHaveCount(0);
  await expect(recruiter.getByText("This requisition is awaiting approval. Withdraw it to make changes.")).toBeVisible();

  await hm.goto("/approvals");
  await hm.getByTestId(`approval-${requisition.reqNumber}`).getByRole("link", { name: requisition.reqNumber }).click();
  await hm.getByRole("button", { name: "Reject" }).click();
  const rejectForm = hm.getByRole("form", { name: "Reject" });
  await rejectForm.getByRole("button", { name: "Reject" }).click();
  await expect(rejectForm.getByText("Add a comment to reject.")).toBeVisible();
  await rejectForm.getByLabel("Comment").fill("Please add the salary band to the description.");
  await rejectForm.getByRole("button", { name: "Reject" }).click();
  await expect(hm.getByTestId("approval-latest")).toContainText("Latest decision: Rejected by E2E Hiring Manager");
  await expect(hm.getByTestId("approval-latest")).toContainText("Please add the salary band to the description.");

  await recruiter.reload();
  await recruiter.getByRole("link", { name: "Edit" }).click();
  const edit = recruiter.getByRole("form", { name: "Save requisition" });
  await edit.getByLabel("Job title").fill(`${requisition.title} (revised)`);
  await edit.getByRole("button", { name: "Save requisition" }).click();
  await expect(recruiter.getByRole("heading", { name: `${requisition.reqNumber} · ${requisition.title} (revised)` })).toBeVisible();
  await submitToHm();

  await hm.goto(`/requisitions/${requisition.id}`);
  await hm.getByRole("button", { name: "Approve" }).click();
  await hm.getByRole("form", { name: "Approve" }).getByRole("button", { name: "Approve" }).click();
  await expect(hm.getByTestId("approval-latest")).toContainText("Latest decision: Approved by E2E Hiring Manager");

  const [row] = await query<{ state: string; is_published: boolean }>("SELECT state, is_published FROM requisitions WHERE id = $1", [requisition.id]);
  expect(row).toEqual({ state: "APPROVED", is_published: true });
});

test("A1: My approvals is in the navigation for Hiring Managers and returns 403 for Recruiters", async ({ asRole }) => {
  const hm = await asRole("hiring-manager");
  await hm.goto("/dashboard");
  await expect(hm.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "My approvals" })).toBeVisible();
  const recruiter = await asRole("recruiter");
  expect((await recruiter.goto("/approvals"))?.status()).toBe(403);
});
