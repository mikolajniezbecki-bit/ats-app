// The Recruiter workbench on the Compose stack (ats-project-scope.md §5.4,
// E4, E5, F5, R9, V9, V11): the application list, the application page
// with its inline CV, status control and timeline, and the Outbox link.
import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { insertApplication } from "./support/applications";
import { query } from "./support/db";
import { expect, test } from "./support/fixtures";
import { insertRequisition } from "./support/requisitions";

const BLOB_ORIGIN = "http://localhost:10000";
const live = { state: "APPROVED", approved: true, isPublished: true } as const;

async function changeStatus(page: Page, status: string, comment?: string) {
  const form = page.getByRole("form", { name: "Change status" });
  await form.getByLabel("New status").selectOption({ label: status });
  if (comment !== undefined) await form.getByLabel(/^Comment/).fill(comment);
  await form.getByRole("button", { name: "Change status" }).click();
}

test("a Recruiter moves an application with a comment, rejects it, and a second tab with the old version gets the reload message", async ({ asRole }) => {
  const job = await insertRequisition(live);
  const application = await insertApplication(job.id);
  const page = await asRole("recruiter");
  const stale = await asRole("recruiter");
  await stale.goto(`/applications/${application.id}`);
  await page.goto(`/applications/${application.id}`);
  await expect(page.getByRole("heading", { level: 1, name: `${application.firstName} ${application.lastName}` })).toBeVisible();

  await changeStatus(page, "Screening", "Strong CV, phone screen next");
  await expect(page.getByRole("form", { name: "Change status" }).getByRole("status")).toHaveText("Status changed to Screening.");
  const timeline = page.getByTestId("timeline");
  await expect(timeline.getByTestId("timeline-history").nth(1)).toContainText("Applied → Screening");
  await expect(timeline.getByTestId("timeline-history").nth(1)).toContainText("Strong CV, phone screen next");

  await changeStatus(page, "Rejected");
  await expect(page.getByRole("form", { name: "Change status" }).getByRole("status")).toHaveText("Status changed to Rejected.");
  await expect(timeline.getByTestId("timeline-history").nth(2)).toContainText("Screening → Rejected");
  await expect(timeline.getByTestId("timeline-history")).toHaveCount(3);
  // The seeded REJECTED stage email, delayed by REJECTION_EMAIL_DELAY_HOURS.
  const rejection = timeline.getByTestId("timeline-email");
  await expect(rejection).toContainText("Scheduled for");
  await expect(rejection).toContainText("Queued");
  await expect(page.getByRole("form", { name: "Change status" }).getByLabel("New status")).toContainText("Screening (reopen)");

  // The second tab still holds version 1.
  await changeStatus(stale, "Interview", "Typed before the reload");
  await expect(stale.getByRole("form", { name: "Change status" }).getByRole("alert")).toHaveText("This record was changed by someone else. Reload and try again.");
  await expect(stale.getByLabel(/^Comment/)).toHaveValue("Typed before the reload");
  const [row] = await query<{ status: string; version: number }>("SELECT status, version FROM applications WHERE id = $1", [application.id]);
  expect(row).toEqual({ status: "REJECTED", version: 3 });
});

test("F5: the CV opens inline from the application page through a signed Blob link", async ({ asRole }) => {
  const job = await insertRequisition(live);
  const application = await insertApplication(job.id);
  const page = await asRole("recruiter");
  const pdf = page.waitForResponse((response) => response.url().startsWith(`${BLOB_ORIGIN}/devstoreaccount1/files/`));
  await page.goto(`/applications/${application.id}`);
  const frame = page.getByTitle("CV", { exact: true });
  await expect(frame).toHaveAttribute("src", new RegExp(`^${BLOB_ORIGIN}/devstoreaccount1/files/.+[?&]sig=`));
  expect((await pdf).status()).toBe(200);
});

test("E5: a FAILED email shows the warning on the list row, the banner and the timeline entry", async ({ asRole }) => {
  const job = await insertRequisition(live);
  const application = await insertApplication(job.id, { withCv: false });
  await query(
    `INSERT INTO email_log (application_id, requisition_id, audience, recipient, subject, body_rendered, status, error)
     VALUES ($1, $2, 'CANDIDATE', $3, 'Application update', '<p>Hello</p>', 'FAILED', 'Error: 550 mailbox unavailable')`,
    [application.id, job.id, application.email],
  );
  const page = await asRole("recruiter");

  await page.goto(`/requisitions/${job.id}`);
  await page.getByRole("link", { name: "Applications (1)" }).click();
  const row = page.getByTestId(`application-row-${application.id}`);
  await expect(row.getByRole("img", { name: "An email to this candidate failed to send" })).toBeVisible();

  await row.getByRole("link", { name: "Open" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "An email to this candidate failed to send. Check the timeline." })).toBeVisible();
  const entry = page.getByTestId("timeline-email");
  await expect(entry).toContainText("This email could not be sent. Error: 550 mailbox unavailable");
  await entry.getByText("View").click();
  await expect(page.getByTitle("Email body")).toHaveAttribute("sandbox", "");
});

test("applications from the same email are grouped and cross-linked, never merged", async ({ asRole }) => {
  const emailHash = randomUUID();
  const first = await insertRequisition(live);
  const second = await insertRequisition(live);
  const one = await insertApplication(first.id, { emailHash, withCv: false });
  const other = await insertApplication(second.id, { emailHash, withCv: false, status: "INTERVIEW" });
  const page = await asRole("recruiter");

  await page.goto(`/requisitions/${first.id}/applications`);
  const row = page.getByTestId(`application-row-${one.id}`);
  await row.getByRole("link", { name: `${second.reqNumber} (Interview)` }).click();
  await expect(page).toHaveURL(new RegExp(`/applications/${other.id}$`));
  await expect(page.getByRole("region", { name: "Other applications by this candidate" }).getByRole("link")).toHaveText(`${first.reqNumber} · ${first.title}`);
});

test("the Outbox link to an application opens its page", async ({ asRole }) => {
  const job = await insertRequisition(live);
  const application = await insertApplication(job.id, { withCv: false });
  const [email] = await query<{ id: string }>(
    `INSERT INTO email_log (application_id, requisition_id, audience, recipient, subject, body_rendered, status, sent_at)
     VALUES ($1, $2, 'CANDIDATE', $3, 'Thanks for applying', '<p>Hi</p>', 'SENT', now()) RETURNING id`,
    [application.id, job.id, application.email],
  );
  const page = await asRole("admin");
  await page.goto(`/admin/outbox/${email.id}`);
  await page.getByRole("link", { name: "Application" }).click();
  await expect(page.getByRole("heading", { level: 1, name: `${application.firstName} ${application.lastName}` })).toBeVisible();
  await expect(page.getByTestId("timeline-email")).toContainText("Thanks for applying");
});

test("V9: a Hiring Manager and an Interviewer get the 403 page; an unknown application is 404", async ({ asRole }) => {
  const job = await insertRequisition(live);
  const application = await insertApplication(job.id, { withCv: false });
  for (const role of ["hiring-manager", "interviewer"] as const) {
    const page = await asRole(role);
    expect((await page.goto(`/applications/${application.id}`))?.status(), role).toBe(403);
    expect((await page.goto(`/requisitions/${job.id}/applications`))?.status(), role).toBe(403);
  }
  const recruiter = await asRole("recruiter");
  expect((await recruiter.goto(`/applications/${randomUUID()}`))?.status()).toBe(404);
});

test("the list and the application page pass axe (WCAG 2.1 A/AA) and the status control works with the keyboard alone", async ({ asRole }) => {
  const job = await insertRequisition(live);
  const application = await insertApplication(job.id, { withCv: false });
  const page = await asRole("recruiter");
  const axe = async () => {
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target).join(", ")}`)).toEqual([]);
  };
  await page.goto(`/requisitions/${job.id}/applications`);
  await axe();
  await page.goto(`/applications/${application.id}`);
  await axe();

  await page.getByLabel("New status").focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Keyboard only");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Change status" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("form", { name: "Change status" }).getByRole("status")).toHaveText("Status changed to Screening.");
});
