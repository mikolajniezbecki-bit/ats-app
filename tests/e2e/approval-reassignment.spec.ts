// Approval reassignment and the deactivation guard on the Compose stack
// (ats-project-scope.md A4, A5): a Recruiter finds a pending requisition on
// "All pending approvals" and reassigns it with a reason; an Admin can't
// deactivate an approver of a pending item and sees why.
import { query } from "./support/db";
import { expect, test } from "./support/fixtures";
import { insertRequisition } from "./support/requisitions";
import { ROLES, createThrowawayUser } from "./support/users";

test("A4: a Recruiter reassigns a pending requisition from All pending approvals to another Hiring Manager with a reason", async ({ asRole }) => {
  const requisition = await insertRequisition();
  const newApprover = createThrowawayUser("HIRING_MANAGER");
  const recruiter = await asRole("recruiter");

  await recruiter.goto(`/requisitions/${requisition.id}`);
  await recruiter.getByRole("button", { name: "Submit for approval" }).click();
  const submitForm = recruiter.getByRole("form", { name: "Submit for approval" });
  await submitForm.getByLabel("Approver").selectOption({ label: ROLES["hiring-manager"].name });
  await submitForm.getByRole("button", { name: "Submit", exact: true }).click();
  await expect(recruiter.getByTestId("approval-status")).toContainText(`Awaiting approval by ${ROLES["hiring-manager"].name}`);

  await recruiter.goto("/dashboard");
  await recruiter.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "All pending approvals" }).click();
  const listed = recruiter.getByTestId(`pending-${requisition.reqNumber}`);
  await expect(listed).toContainText(ROLES["hiring-manager"].name);
  await expect(listed).toContainText(ROLES.recruiter.name);
  await listed.getByRole("link", { name: requisition.reqNumber }).click();

  await recruiter.getByRole("button", { name: "Reassign" }).click();
  const form = recruiter.getByRole("form", { name: "Reassign" });
  await expect(form.getByLabel("New approver").locator("option", { hasText: ROLES["hiring-manager"].name })).toHaveCount(0);
  await form.getByLabel("New approver").selectOption({ label: newApprover.name });
  await form.getByRole("button", { name: "Reassign" }).click();
  await expect(form.getByText("Add a reason for the reassignment.")).toBeVisible();
  await form.getByLabel("Reason").fill("On holiday until next month.");
  await form.getByRole("button", { name: "Reassign" }).click();
  await expect(recruiter.getByTestId("approval-status")).toContainText(`Awaiting approval by ${newApprover.name}`);
  await expect(recruiter.getByTestId("approval-latest")).toContainText("Latest decision: Reassigned by E2E Recruiter");

  const events = await query<{ event: string; comment: string | null }>(
    "SELECT event, comment FROM approval_events WHERE subject_id = $1 ORDER BY created_at",
    [requisition.id],
  );
  expect(events).toEqual([
    { event: "SUBMITTED", comment: null },
    { event: "REASSIGNED", comment: "On holiday until next month." },
  ]);
  const hm = await asRole("hiring-manager");
  await hm.goto("/approvals");
  await expect(hm.getByTestId(`approval-${requisition.reqNumber}`)).toHaveCount(0);
});

test("A5: the Admin users page refuses to deactivate an approver of a pending requisition and names it", async ({ asRole }) => {
  const approver = createThrowawayUser("HIRING_MANAGER");
  const requisition = await insertRequisition({ state: "PENDING_APPROVAL" });
  const [recruiter] = await query<{ id: string }>("SELECT id FROM users WHERE email = $1", [ROLES.recruiter.email]);
  await query("UPDATE requisitions SET approver_id = $1, submitted_by_user_id = $2, submitted_at = now() WHERE id = $3", [approver.id, recruiter.id, requisition.id]);

  const admin = await asRole("admin");
  await admin.goto("/admin/users");
  const row = admin.getByTestId(`user-${approver.email}`);
  await row.getByRole("button", { name: "Deactivate" }).click();
  await expect(row.getByRole("alert")).toHaveText(`This user is the approver of 1 pending item. Reassign it first: ${requisition.reqNumber}`);
  const [user] = await query<{ is_active: boolean }>("SELECT is_active FROM users WHERE id = $1", [approver.id]);
  expect(user.is_active).toBe(true);
});
