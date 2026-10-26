// Hiring Manager and Interviewer views on the Compose stack
// (ats-project-scope.md V4, V5, V6, V9): the demo Hiring Manager reads an
// application on their requisition without any action; the demo Interviewer
// follows the invite link, uses "My interviews" to reach the scorecard page,
// and gets the 404 page for an application they don't interview for.
import { randomUUID } from "node:crypto";
import { waitForMessage } from "../support/mailpit";
import { insertApplication } from "./support/applications";
import { query } from "./support/db";
import { expect, test } from "./support/fixtures";
import { insertRequisition } from "./support/requisitions";
import { ROLES } from "./support/users";

const live = { state: "APPROVED", approved: true, isPublished: true } as const;
const userId = async (email: string) => (await query<{ id: string }>("SELECT id FROM users WHERE email = $1", [email]))[0].id;

test("V4: the Hiring Manager reads an application on their requisition with the feedback summary but no status control or actions", async ({ asRole }) => {
  const job = await insertRequisition(live);
  const application = await insertApplication(job.id, { status: "INTERVIEW" });
  const recruiter = await userId(ROLES.recruiter.email);
  const interviewer = await userId(ROLES.interviewer.email);
  const [interview] = await query<{ id: string }>(
    `INSERT INTO interviews (application_id, starts_at_utc, duration_minutes, timezone, location_or_link, ics_uid, created_by_user_id)
     VALUES ($1, now() - interval '3 hours', 60, 'UTC', 'Room 5', $2, $3) RETURNING id`,
    [application.id, `${randomUUID()}@ats`, recruiter],
  );
  await query("INSERT INTO interview_participants (interview_id, user_id) VALUES ($1, $2)", [interview.id, interviewer]);
  await query("INSERT INTO interview_scorecards (interview_id, interviewer_id, overall_rating, thumbs_up, submitted_at) VALUES ($1, $2, 5, true, now())", [interview.id, interviewer]);

  const hm = await asRole("hiring-manager");
  await hm.goto(`/requisitions/${job.id}/applications`);
  await expect(hm.getByRole("checkbox")).toHaveCount(0);
  await hm.getByRole("row").filter({ hasText: application.lastName }).getByRole("link", { name: "Open" }).click();
  await expect(hm.getByRole("heading", { level: 1, name: `${application.firstName} ${application.lastName}` })).toBeVisible();
  await expect(hm.getByTestId("feedback-summary")).toHaveText("Average rating: 5.0 · 1 thumbs up, 0 thumbs down");
  await expect(hm.getByRole("form", { name: "Change status" })).toHaveCount(0);
  await expect(hm.getByRole("button", { name: "Schedule interview" })).toHaveCount(0);
  await expect(hm.getByRole("button", { name: "Reopen" })).toHaveCount(0);
});

test("V5, V6: the Interviewer follows the invite link, reaches the scorecard page through My interviews, and gets 404 elsewhere", async ({ asRole }) => {
  const job = await insertRequisition(live);
  const application = await insertApplication(job.id, { status: "INTERVIEW" });
  const other = await insertApplication(job.id);
  const recruiter = await asRole("recruiter");
  const year = new Date().getUTCFullYear() + 1;
  const scheduled = await recruiter.request.post(`/api/applications/${application.id}/interviews`, {
    data: { startLocal: `${year}-03-02T10:00`, timezone: "Europe/Warsaw", durationMinutes: 45, locationOrLink: "Room 6", participantIds: [await userId(ROLES.interviewer.email)] },
  });
  expect(scheduled.status()).toBe(201);
  const { interview } = (await scheduled.json()) as { interview: { id: string } };

  const candidate = `${application.firstName} ${application.lastName}`;
  const invite = await waitForMessage({ to: ROLES.interviewer.email, subjectIncludes: candidate, timeoutMs: 20_000 });
  const link = /https?:\/\/\S+\/applications\/[0-9a-f-]{36}/.exec(invite.text)?.[0];
  expect(link).toBeDefined();

  const page = await asRole("interviewer");
  await page.goto(new URL(link!).pathname);
  await expect(page.getByRole("heading", { level: 1, name: candidate })).toBeVisible();
  await expect(page.getByText(application.email)).toBeVisible();
  await expect(page.getByText("Pre-screening")).toHaveCount(0);
  await expect(page.getByRole("form", { name: "Change status" })).toHaveCount(0);

  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link")).toHaveText(["Home", "My interviews"]);
  await nav.getByRole("link", { name: "My interviews" }).click();
  const row = page.getByTestId(`my-interview-${interview.id}`);
  await expect(row).toContainText(candidate);
  await row.getByRole("link", { name: "Scorecard: Not started" }).click();
  await expect(page).toHaveURL(new RegExp(`/interviews/${interview.id}/scorecard$`));
  await expect(page.getByText("Feedback can be given once the interview has started.")).toBeVisible();

  expect((await page.goto(`/applications/${other.id}`))?.status()).toBe(404);
});
