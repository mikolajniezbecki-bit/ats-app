// The Interviewer's journey (tech-stack.md §11, T5, task 46): My interviews,
// the V6 allowlist on the page and on the API, a scorecard, the other
// participant's scorecard after submitting (V7), and access ending when the
// application is rejected (V8).
import type { Page } from "@playwright/test";
import { insertApplication } from "../support/applications";
import { query } from "../support/db";
import { expect, test } from "../support/fixtures";
import { changeStatus, insertStartedInterview, live, userId } from "../support/journeys";
import { insertRequisition } from "../support/requisitions";
import { ROLES } from "../support/users";

test("Interviewer journey: allowlisted data, a scorecard, the other participant's scorecard, and 404 after the rejection", async ({ asRole }) => {
  test.setTimeout(120_000);
  const job = await insertRequisition(live);
  const application = await insertApplication(job.id, { status: "INTERVIEW" });
  const candidate = `${application.firstName} ${application.lastName}`;
  const interviewerId = await userId(ROLES.interviewer.email);
  const otherId = await userId(ROLES.recruiter.email);
  const interviewId = await insertStartedInterview(application.id, [interviewerId, otherId]);
  // The other participant has already submitted; this comment must stay hidden until V7 holds.
  const otherComment = `Other participant ${application.lastName}`;
  await query("INSERT INTO interview_scorecards (interview_id, interviewer_id, overall_rating, thumbs_up, comments, submitted_at) VALUES ($1, $2, 3, false, $3, now())", [interviewId, otherId, otherComment]);
  // Data the allowlist must keep out of the page and the API.
  const [template] = await query<{ id: string }>("SELECT id FROM templates WHERE type = 'OFFER' AND name = 'Default offer letter'");
  await query(
    `INSERT INTO offers (application_id, template_id, created_by_user_id, job_title, salary, currency, start_date)
     VALUES ($1, $2, $3, 'Secret offer title', 123456, 'EUR', '2030-01-15')`,
    [application.id, template.id, otherId],
  );
  const page = await asRole("interviewer");

  await test.step("sees the interview in My interviews", async () => {
    await page.goto("/dashboard");
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "My interviews" }).click();
    await expect(page.getByTestId(`my-interview-${interviewId}`)).toContainText(candidate);
  });

  await test.step("sees only the allowlisted data, on the page and in the API response (V6)", async () => {
    await page.goto(`/applications/${application.id}`);
    await expect(page.getByRole("heading", { level: 1, name: candidate })).toBeVisible();
    await expect(page.getByText(application.email)).toBeVisible();
    const body = page.locator("body");
    await expect(body).not.toContainText("Secret offer title");
    await expect(body).not.toContainText("123,456");
    await expect(body).not.toContainText("Pre-screening");
    await expect(page.getByRole("form", { name: "Change status" })).toHaveCount(0);
    // The Recruiter's page has both fields, so an empty result here means they are hidden, not that the locator is wrong.
    const field = (on: Page, label: string) => on.locator("dt", { hasText: new RegExp(`^${label}$`) });
    const recruiter = await asRole("recruiter");
    await recruiter.goto(`/applications/${application.id}`);
    for (const label of ["Status", "Pre-screening score"]) {
      await expect(field(recruiter, label)).toHaveCount(1);
      await expect(field(page, label)).toHaveCount(0);
    }

    const response = await page.request.get(`/api/applications/${application.id}`);
    expect(response.status()).toBe(200);
    const view = (await response.json()) as { audience: string; application: Record<string, unknown> };
    expect(view.audience).toBe("interviewer");
    // V6 is an allowlist, so the exact keys: the full view keeps status and score inside `application`.
    expect(Object.keys(view).sort()).toEqual(["application", "audience", "documents", "interviews", "requisition", "scorecards"]);
    expect(Object.keys(view.application).sort()).toEqual(["email", "firstName", "id", "lastName", "phone"]);
    const text = JSON.stringify(view);
    expect(text).toContain(application.email);
    for (const hidden of ["Secret offer title", "123456", "salary", "prescreen", "offers", "history"]) expect(text).not.toContain(hidden);
  });

  await test.step("submits a scorecard, and only then sees the other participant's (V7)", async () => {
    const before = await page.request.get(`/api/applications/${application.id}/scorecards`);
    expect(before.status()).toBe(200);
    expect(JSON.stringify(await before.json())).not.toContain(otherComment);
    await page.goto(`/applications/${application.id}`);
    await expect(page.getByText(otherComment)).toHaveCount(0);

    await page.goto(`/interviews/${interviewId}/scorecard`);
    const form = page.getByRole("form", { name: "Scorecard" });
    await form.getByLabel("Thumbs up").check();
    await form.getByLabel("Overall rating").selectOption({ label: "4 of 5" });
    await form.getByRole("button", { name: "Submit" }).click();
    await expect(page.getByText("This scorecard has been submitted and can't be changed.")).toBeVisible();

    const after = await page.request.get(`/api/applications/${application.id}/scorecards`);
    expect(after.status()).toBe(200);
    expect(JSON.stringify(await after.json())).toContain(otherComment);
    await page.goto(`/applications/${application.id}`);
    await expect(page.getByText(otherComment)).toBeVisible();
  });

  await test.step("gets 404 after the Recruiter rejects the application (V8)", async () => {
    const recruiter = await asRole("recruiter");
    await recruiter.goto(`/applications/${application.id}`);
    await changeStatus(recruiter, "Rejected");
    expect((await page.goto(`/applications/${application.id}`))?.status()).toBe(404);
    expect((await page.request.get(`/api/applications/${application.id}`)).status()).toBe(404);
  });
});
