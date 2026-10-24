// Requisition re-approval on the Compose stack (ats-project-scope.md L2, A3):
// a Recruiter raises the openings of an approved requisition and picks the
// Hiring Manager as approver; the Hiring Manager sees old → new in "My
// approvals" and on the requisition, rejects with a comment, and the old
// openings are back.
import { query } from "./support/db";
import { expect, test } from "./support/fixtures";
import { insertRequisition } from "./support/requisitions";

test("A3: a re-approval of raised openings is rejected by the Hiring Manager and the openings are restored", async ({ asRole }) => {
  const job = await insertRequisition({ state: "APPROVED", approved: true, isPublished: true });
  const recruiter = await asRole("recruiter");
  await recruiter.goto(`/requisitions/${job.id}/edit`);
  const form = recruiter.getByRole("form", { name: "Save requisition" });
  await expect(form.getByTestId("reapproval-picker")).toHaveCount(0);
  await form.getByLabel("Openings").fill("3");
  const picker = form.getByTestId("reapproval-picker");
  await expect(picker).toContainText("Changing this field needs re-approval. The posting stays live meanwhile.");
  await picker.getByLabel("Approver for the re-approval").selectOption({ label: "E2E Hiring Manager" });
  await form.getByRole("button", { name: "Save requisition" }).click();
  await expect(recruiter).toHaveURL(new RegExp(`/requisitions/${job.id}$`));
  await expect(recruiter.getByTestId("reapproval-changes")).toContainText("Openings: 1 → 3");

  const hm = await asRole("hiring-manager");
  await hm.goto("/approvals");
  const row = hm.getByTestId(`approval-${job.reqNumber}`);
  await expect(row).toContainText("Re-approval");
  await expect(row).toContainText("Openings: 1 → 3");
  await row.getByRole("link", { name: job.reqNumber }).click();
  await hm.getByRole("button", { name: "Reject" }).click();
  const rejectForm = hm.getByRole("form", { name: "Reject" });
  await rejectForm.getByLabel("Comment").fill("One opening is enough for now.");
  await rejectForm.getByRole("button", { name: "Reject" }).click();
  await expect(hm.getByTestId("reapproval-changes")).toHaveCount(0);

  const [stored] = await query<{ state: string; openings_count: number; is_published: boolean; previous_l2_values_json: unknown }>(
    "SELECT state, openings_count, is_published, previous_l2_values_json FROM requisitions WHERE id = $1",
    [job.id],
  );
  expect(stored).toEqual({ state: "APPROVED", openings_count: 1, is_published: true, previous_l2_values_json: null });
});
