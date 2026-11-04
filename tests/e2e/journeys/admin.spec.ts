// The Admin's journey (tech-stack.md §11, task 46): withdraws a pending
// submission (A9), takes a requisition through hold, close and reopen
// (L4–L7), corrects a hire (R4), reopens a scorecard (V8) and sees the job
// runs page.
import { type Page } from "@playwright/test";
import { insertApplication } from "../support/applications";
import { query } from "../support/db";
import { expect, test } from "../support/fixtures";
import { insertStartedInterview, live, submitRequisition, userId } from "../support/journeys";
import { insertRequisition } from "../support/requisitions";
import { ROLES } from "../support/users";

async function act(page: Page, action: string, comment?: string) {
  await page.getByRole("button", { name: action, exact: true }).click();
  const form = page.getByRole("form", { name: action });
  if (comment !== undefined) await form.getByLabel(/^Comment/).fill(comment);
  await form.getByRole("button", { name: action }).click();
  await expect(form).toBeHidden();
}

test("Admin journey: withdraws a pending submission (A9)", async ({ asRole }) => {
  const draft = await insertRequisition();
  await submitRequisition(await asRole("recruiter"), draft.id, ROLES["hiring-manager"].name);
  const admin = await asRole("admin");
  await admin.goto(`/requisitions/${draft.id}`);
  await act(admin, "Withdraw");
  await expect(admin.getByTestId("approval-status")).toHaveCount(0);
  const [row] = await query<{ state: string }>("SELECT state FROM requisitions WHERE id = $1", [draft.id]);
  expect(row.state).toBe("DRAFT");
});

test("Admin journey: holds, resumes, closes and reopens a requisition; closing rejects open applications and queues their emails", async ({ asRole }) => {
  const job = await insertRequisition(live);
  const application = await insertApplication(job.id, { status: "SCREENING", withCv: false });
  const admin = await asRole("admin");
  await admin.goto(`/requisitions/${job.id}`);
  const facts = admin.getByTestId("lifecycle-facts");

  await act(admin, "Put on hold", "Budget review");
  await expect(facts).toContainText("On hold");
  await expect(facts).toContainText("Not published");
  await act(admin, "Resume");
  await expect(facts).toContainText("Approved");
  await expect(facts).toContainText("Published");

  await admin.getByRole("button", { name: "Close", exact: true }).click();
  const close = admin.getByRole("form", { name: "Close" });
  await expect(close).toContainText("1 open application will be rejected and 0 offers withdrawn.");
  await close.getByLabel(/^Comment/).fill("Position cancelled");
  await close.getByRole("button", { name: "Close" }).click();
  await expect(facts).toContainText("Closed");
  await expect(facts).toContainText("Cancelled");
  const [rejected] = await query<{ status: string; reason_code: string }>("SELECT status, reason_code FROM applications WHERE id = $1", [application.id]);
  expect(rejected).toEqual({ status: "REJECTED", reason_code: "REQ_CANCELLED" });
  const emails = await query<{ status: string }>("SELECT status FROM email_log WHERE application_id = $1 AND audience = 'CANDIDATE'", [application.id]);
  expect(emails.map((email) => email.status)).toEqual(["QUEUED"]);

  await act(admin, "Reopen", "Budget restored");
  await expect(facts).toContainText("Approved");
  await expect(facts).toContainText("Published");
  // L7: auto-rejected applications are not restored.
  const [after] = await query<{ status: string }>("SELECT status FROM applications WHERE id = $1", [application.id]);
  expect(after.status).toBe("REJECTED");
});

test("Admin journey: corrects a hire to Withdrawn with a comment (R4)", async ({ asRole }) => {
  const job = await insertRequisition(live);
  const application = await insertApplication(job.id, { status: "HIRED", withCv: false });
  await query("UPDATE applications SET hired_at = now(), dispositioned_at = now(), exported_at = now() WHERE id = $1", [application.id]);
  const admin = await asRole("admin");
  await admin.goto(`/applications/${application.id}`);
  const form = admin.getByRole("form", { name: "Correct hired status" });
  await form.getByLabel("New status").selectOption({ label: "Withdrawn" });
  await form.getByRole("button", { name: "Correct status" }).click();
  await expect(form.getByRole("alert")).toHaveText("Correcting a hired status needs a comment.");
  await form.getByLabel(/^Comment/).fill("The candidate declined after all.");
  await form.getByRole("button", { name: "Correct status" }).click();
  await expect(admin.getByTestId("timeline").getByTestId("timeline-history").last()).toContainText("The candidate declined after all.");
  const [row] = await query<{ status: string; hired_at: Date | null; exported_at: Date | null }>("SELECT status, hired_at, exported_at FROM applications WHERE id = $1", [application.id]);
  expect(row).toEqual({ status: "WITHDRAWN", hired_at: null, exported_at: null });
});

test("Admin journey: reopens a submitted scorecard, and the Interviewer can change it again (V8)", async ({ asRole }) => {
  const job = await insertRequisition(live);
  const application = await insertApplication(job.id, { status: "INTERVIEW", withCv: false });
  const interviewerId = await userId(ROLES.interviewer.email);
  const interviewId = await insertStartedInterview(application.id, [interviewerId]);
  await query("INSERT INTO interview_scorecards (interview_id, interviewer_id, overall_rating, thumbs_up, submitted_at) VALUES ($1, $2, 4, true, now())", [interviewId, interviewerId]);

  const interviewer = await asRole("interviewer");
  await interviewer.goto(`/interviews/${interviewId}/scorecard`);
  await expect(interviewer.getByText("This scorecard has been submitted and can't be changed.")).toBeVisible();

  const admin = await asRole("admin");
  await admin.goto(`/applications/${application.id}`);
  await admin.getByTestId("feedback").getByRole("button", { name: "Reopen" }).click();
  await expect(admin.getByTestId("feedback").getByRole("button", { name: "Reopen" })).toHaveCount(0);

  await interviewer.reload();
  await expect(interviewer.getByText("An Admin reopened this scorecard. Change it and submit it again.")).toBeVisible();
  await expect(interviewer.getByRole("form", { name: "Scorecard" }).getByLabel("Overall rating")).toBeEnabled();
  const [row] = await query<{ submitted_at: Date | null; reopened_at: Date | null }>("SELECT submitted_at, reopened_at FROM interview_scorecards WHERE interview_id = $1", [interviewId]);
  expect(row.submitted_at).toBeNull();
  expect(row.reopened_at).not.toBeNull();
});

test("Admin journey: sees the job runs page", async ({ asRole }) => {
  const admin = await asRole("admin");
  await admin.goto("/admin/jobs");
  await expect(admin.getByRole("heading", { level: 1, name: "Background jobs" })).toBeVisible();
  await expect(admin.getByRole("cell", { name: "email.send" })).toBeVisible();
  expect((await (await asRole("recruiter")).goto("/admin/jobs"))?.status()).toBe(403);
});
