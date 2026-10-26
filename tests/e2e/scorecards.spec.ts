// Scorecards on the Compose stack (ats-project-scope.md I9, I10): the demo
// Interviewer saves a draft for a started interview (fixture time), attaches
// PDF notes and submits; the Recruiter then sees the feedback summary.
import { randomUUID } from "node:crypto";
import { VALID_PDF } from "./support/apply";
import { insertApplication } from "./support/applications";
import { query } from "./support/db";
import { expect, test } from "./support/fixtures";
import { insertRequisition } from "./support/requisitions";
import { ROLES } from "./support/users";

test("I9, I10: the Interviewer drafts, attaches notes and submits a scorecard; the Recruiter sees the summary", async ({ asRole }) => {
  const requisition = await insertRequisition({ state: "APPROVED", approved: true, isPublished: true });
  const application = await insertApplication(requisition.id, { status: "INTERVIEW" });
  const [recruiterRow] = await query<{ id: string }>("SELECT id FROM users WHERE email = $1", [ROLES.recruiter.email]);
  const [interviewerRow] = await query<{ id: string }>("SELECT id FROM users WHERE email = $1", [ROLES.interviewer.email]);
  const [interview] = await query<{ id: string }>(
    `INSERT INTO interviews (application_id, starts_at_utc, duration_minutes, timezone, location_or_link, ics_uid, created_by_user_id)
     VALUES ($1, now() - interval '2 hours', 60, 'Europe/Warsaw', 'Room 3', $2, $3) RETURNING id`,
    [application.id, `${randomUUID()}@ats`, recruiterRow.id],
  );
  await query("INSERT INTO interview_participants (interview_id, user_id) VALUES ($1, $2)", [interview.id, interviewerRow.id]);

  const interviewer = await asRole("interviewer");
  await interviewer.goto(`/interviews/${interview.id}/scorecard`);
  await expect(interviewer.getByText(`${application.firstName} ${application.lastName}`)).toBeVisible();
  const form = interviewer.getByRole("form", { name: "Scorecard" });
  await form.getByRole("button", { name: "Submit" }).click();
  await expect(form.getByText("Choose thumbs up or thumbs down.")).toBeVisible();

  await form.getByLabel("Thumbs up").check();
  await form.getByLabel("Overall rating").selectOption({ label: "4 of 5" });
  await form.getByLabel("Comments (optional)").fill("Clear communicator.");
  await form.getByRole("button", { name: "Save draft" }).click();
  await expect(form.getByText("Draft saved.")).toBeVisible();

  const notes = interviewer.getByRole("form", { name: "Attach notes" });
  await notes.locator('input[type="file"]').setInputFiles(VALID_PDF);
  await notes.getByRole("button", { name: "Attach notes" }).click();
  await expect(interviewer.getByRole("link", { name: "Attached notes" })).toBeVisible();

  await form.getByRole("button", { name: "Submit" }).click();
  await expect(interviewer.getByText("This scorecard has been submitted and can't be changed.")).toBeVisible();
  await expect(form.getByLabel("Overall rating")).toBeDisabled();

  const recruiter = await asRole("recruiter");
  await recruiter.goto(`/applications/${application.id}`);
  await expect(recruiter.getByTestId("feedback-summary")).toHaveText("Average rating: 4.0 · 1 thumbs up, 0 thumbs down");
  await expect(recruiter.getByTestId("feedback")).toContainText(`${ROLES.interviewer.name}: 4 of 5, Thumbs up`);
  await expect(recruiter.getByTestId("feedback").getByRole("link", { name: "Notes" })).toBeVisible();
});
