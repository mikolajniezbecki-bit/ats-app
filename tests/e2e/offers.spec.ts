// Offer drafting on the Compose stack (ats-project-scope.md §5.6, R10): a
// Recruiter moves an application to Offer, creates an offer, edits the
// salary, discards it and creates a new one; the timeline shows both.
import { insertApplication } from "./support/applications";
import { query } from "./support/db";
import { expect, test } from "./support/fixtures";
import { insertRequisition } from "./support/requisitions";

test("R10: a Recruiter creates, edits, discards and re-creates an offer; the timeline shows both offers", async ({ asRole }) => {
  const job = await insertRequisition({ state: "APPROVED", approved: true, isPublished: true });
  const application = await insertApplication(job.id, { status: "INTERVIEW" });
  const page = await asRole("recruiter");
  await page.goto(`/applications/${application.id}`);
  const offers = page.getByTestId("offers");
  await expect(offers.getByRole("button", { name: "Create offer" })).toBeDisabled();
  await expect(offers.getByText("An offer can be created only when the application is in Offer.")).toBeVisible();

  const status = page.getByRole("form", { name: "Change status" });
  await status.getByLabel("New status").selectOption({ label: "Offer" });
  await status.getByRole("button", { name: "Change status" }).click();
  await expect(status.getByRole("status")).toHaveText("Status changed to Offer.");

  const start = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  await offers.getByRole("button", { name: "Create offer" }).click();
  const form = page.getByRole("form", { name: "Create offer" });
  await expect(form.getByLabel("Job title")).toHaveValue(job.title);
  await expect(form.getByLabel("Offer template")).toHaveValue(/.+/);
  await form.getByLabel("Gross annual salary").fill("85000");
  await form.getByLabel("Currency").selectOption("PLN");
  await form.getByLabel("Start date").fill(start);
  await form.getByRole("button", { name: "Create offer" }).click();
  await expect(offers.getByText(`${job.title}: 85,000.00 PLN, start ${start}`)).toBeVisible();

  await offers.getByRole("button", { name: "Edit" }).click();
  const edit = page.getByRole("form", { name: "Edit" });
  await edit.getByLabel("Gross annual salary").fill("abc");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit.getByText("Enter an amount greater than 0 with at most 2 decimals.")).toBeVisible();
  await edit.getByLabel("Gross annual salary").fill("87500.50");
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(offers.getByText(`${job.title}: 87,500.50 PLN, start ${start}`)).toBeVisible();

  await offers.getByRole("button", { name: "Discard offer" }).click();
  await page.getByRole("form", { name: "Discard offer" }).getByRole("button", { name: "Discard" }).click();
  await expect(offers.getByText("Approval: Withdrawn")).toBeVisible();

  await offers.getByRole("button", { name: "Create offer" }).click();
  const again = page.getByRole("form", { name: "Create offer" });
  await again.getByLabel("Gross annual salary").fill("90000");
  await again.getByLabel("Start date").fill(start);
  await again.getByRole("button", { name: "Create offer" }).click();
  await expect(offers.getByText(`${job.title}: 90,000.00 EUR, start ${start}`)).toBeVisible();
  await expect(offers.getByText("Read-only (a newer offer exists)")).toHaveCount(1);

  const rows = await query<{ approval_status: string; salary: string }>("SELECT approval_status, salary FROM offers WHERE application_id = $1 ORDER BY created_at", [application.id]);
  expect(rows).toEqual([
    { approval_status: "WITHDRAWN", salary: "87500.50" },
    { approval_status: "DRAFT", salary: "90000.00" },
  ]);
  await expect(page.getByRole("region", { name: "Timeline" }).getByText(`Offer: ${job.title}`)).toHaveCount(2);
});
