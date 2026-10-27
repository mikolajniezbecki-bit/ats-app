// The KPI dashboard and the report exports on the Compose stack
// (ats-project-scope.md §5.9, L10, V10). The database is shared with other
// specs and the seed, so the cards are checked for a number or "—", not for
// totals (T2).
import { readFile } from "node:fs/promises";
import { expect, test } from "./support/fixtures";

const NUMBER_OR_DASH = /^(\d+(\.\d)?|—)$/;
const PIPELINE_HEADER = "Application ID,Requisition number,Job title,Status,Reason code,Source,Pre-screening score,Disqualified,Applied date,Disposition date,Hired date,Anonymized";

test("L10: a Recruiter sees the five KPI cards and downloads the pipeline CSV; a Hiring Manager gets 403", async ({ asRole }) => {
  const recruiter = await asRole("recruiter");
  await recruiter.goto("/dashboard");
  await recruiter.getByRole("link", { name: "Reports" }).click();
  await expect(recruiter.getByRole("heading", { name: "Reports", level: 1 })).toBeVisible();

  await expect(recruiter.getByTestId("kpi-open").locator("p").first()).toHaveText(/^\d+$/);
  const active = recruiter.getByTestId("kpi-active");
  for (const status of ["Applied", "Screening", "Interview", "Offer"]) await expect(active.getByText(status, { exact: true })).toBeVisible();
  await expect(active.locator("dd")).toHaveCount(4);
  for (const value of await active.locator("dd").allTextContents()) expect(value).toMatch(/^\d+$/);
  for (const id of ["kpi-time-to-fill", "kpi-time-to-hire"]) {
    await expect(recruiter.getByTestId(id).locator("p").first()).toHaveText(NUMBER_OR_DASH);
    await expect(recruiter.getByTestId(id)).toContainText("based on");
  }
  const age = recruiter.getByTestId("kpi-age");
  await expect(age.getByRole("heading", { name: "Age of open requisitions (days)" })).toBeVisible();
  const ageCells = age.locator("tbody tr td:last-child");
  for (const value of await ageCells.allTextContents()) expect(value).toMatch(/^-?\d+\.\d$/);

  await recruiter.goto("/exports");
  const [download] = await Promise.all([recruiter.waitForEvent("download"), recruiter.getByRole("link", { name: "Pipeline (CSV)" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^pipeline-\d{4}-\d{2}-\d{2}\.csv$/);
  const text = (await readFile((await download.path())!)).toString("utf8");
  expect(text.split("\r\n")[0]).toBe(`\uFEFF${PIPELINE_HEADER}`);

  const hm = await asRole("hiring-manager");
  const response = await hm.goto("/reports");
  expect(response?.status()).toBe(403);
  await expect(hm.getByRole("link", { name: "Reports" })).toHaveCount(0);
});
