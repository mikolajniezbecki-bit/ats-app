// Bulk actions on the application list (ats-project-scope.md §5.4 Bulk
// actions): a Recruiter selects three applications, moves them in one go
// and sees one result per application.
import { insertApplication } from "./support/applications";
import { query } from "./support/db";
import { expect, test } from "./support/fixtures";
import { insertRequisition } from "./support/requisitions";

test("a Recruiter selects three applications, moves them to Interview and sees the result table", async ({ asRole }) => {
  const job = await insertRequisition({ state: "APPROVED", approved: true, isPublished: true });
  const moved = [await insertApplication(job.id, { withCv: false }), await insertApplication(job.id, { withCv: false })];
  const refused = await insertApplication(job.id, { withCv: false, status: "INTERVIEW" });
  const page = await asRole("recruiter");
  await page.goto(`/requisitions/${job.id}/applications`);

  const bar = page.getByTestId("bulk-bar");
  await expect(bar.getByRole("button", { name: "Move status" })).toBeDisabled();
  await page.getByRole("checkbox", { name: "Select all on this page" }).check();
  await expect(bar).toContainText("3 selected");
  await bar.getByRole("button", { name: "Move status" }).click();

  const dialog = page.getByRole("dialog", { name: "Move applications" });
  await dialog.getByLabel("New status").selectOption({ label: "Interview" });
  await expect(dialog).toContainText("Move 3 applications to Interview?");
  await dialog.getByRole("button", { name: "Confirm" }).click();

  const results = dialog.getByTestId("bulk-results");
  for (const app of moved) await expect(results.getByRole("row", { name: new RegExp(app.lastName) })).toContainText("Moved to Interview");
  await expect(results.getByRole("row", { name: new RegExp(refused.lastName) })).toContainText("The application is already in this status.");
  await dialog.getByRole("button", { name: "Close" }).click();

  // The refused row stays selected; the moved ones are unselected.
  await expect(bar).toContainText("1 selected");
  await expect(page.getByRole("checkbox", { name: `Select ${refused.firstName} ${refused.lastName}` })).toBeChecked();
  const rows = await query<{ status: string }>("SELECT status FROM applications WHERE requisition_id = $1", [job.id]);
  expect(rows.map((row) => row.status)).toEqual(["INTERVIEW", "INTERVIEW", "INTERVIEW"]);
});
