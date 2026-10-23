// Admin settings and master data pages (ats-project-scope.md §5.1, V1, T5).
import { query } from "./support/db";
import { expect, test } from "./support/fixtures";

for (const path of ["/admin/settings", "/admin/master-data"]) {
  test(`AU9: a Recruiter gets HTTP 403 on ${path}`, async ({ asRole }) => {
    const page = await asRole("recruiter");
    const response = await page.goto(path);
    expect(response?.status()).toBe(403);
    await expect(page.getByRole("heading", { name: "You don't have access to this page." })).toBeVisible();
  });
}

test("V1: an Admin changes APPROVAL_REMINDER_DAYS and the page shows the new value without Default", async ({ asRole }) => {
  // The Compose database is shared: start from the default and put it back.
  const reset = () => query("DELETE FROM settings WHERE key = 'APPROVAL_REMINDER_DAYS'");
  await reset();
  try {
    await changeReminderDays(asRole);
  } finally {
    await reset();
  }
});

async function changeReminderDays(asRole: (role: "admin") => Promise<import("@playwright/test").Page>) {
  const page = await asRole("admin");
  await page.goto("/admin");
  await page.getByRole("main").getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/admin\/settings$/);
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");

  const row = page.getByTestId("setting-APPROVAL_REMINDER_DAYS");
  await expect(row.getByText("Default")).toBeVisible();
  await page.getByLabel("Approval reminder after (days)").fill("7");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status")).toHaveText("Settings saved.");

  await page.reload();
  await expect(page.getByLabel("Approval reminder after (days)")).toHaveValue("7");
  await expect(row.getByText("Default")).toHaveCount(0);
  await expect(page.getByTestId("setting-RETENTION_DAYS").getByText("Default")).toBeVisible();
}

test("the settings form shows the server's error for a privacy text change without a new version", async ({ asRole }) => {
  const page = await asRole("admin");
  await page.goto("/admin/settings");
  await page.getByLabel("Privacy statement text").fill("A changed statement");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Change the version when you change the statement text.")).toBeVisible();
});

test("V1: an Admin adds, deactivates and deletes a Location on the master data page", async ({ asRole }) => {
  const page = await asRole("admin");
  const code = `E2E_${Date.now().toString(36).toUpperCase()}`;
  await page.goto("/admin/master-data");
  await page.getByLabel("Type").selectOption("LOCATION");
  await page.getByLabel("Code").fill(code.toLowerCase());
  await page.getByRole("textbox", { name: "Label" }).first().fill("E2E Location");
  await page.getByRole("button", { name: "Add", exact: true }).click();

  const row = page.getByTestId(`master-data-${code}`);
  await expect(row).toContainText("Active");
  await row.getByRole("button", { name: "Deactivate" }).click();
  await expect(row).toHaveCount(0);
  await page.getByRole("link", { name: "Show inactive records" }).click();
  await expect(row).toContainText("Inactive");
  await row.getByRole("button", { name: "Delete" }).click();
  await expect(row).toHaveCount(0);
});
