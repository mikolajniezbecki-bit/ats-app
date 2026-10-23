// Admin templates (ats-project-scope.md §5.1, E8, T5): one active stage email
// per status, shown as a form error.
import { randomUUID } from "node:crypto";
import { query } from "./support/db";
import { expect, test } from "./support/fixtures";

test("AU9: a Recruiter gets HTTP 403 on /admin/templates", async ({ asRole }) => {
  const page = await asRole("recruiter");
  expect((await page.goto("/admin/templates"))?.status()).toBe(403);
});

test("a second active REJECTED email is a form error until the first is deactivated (E8)", async ({ asRole }) => {
  // The Compose database is shared: remember the active REJECTED template(s)
  // and restore them afterwards.
  const original = await query<{ id: string }>(
    "SELECT id FROM templates WHERE type = 'EMAIL' AND trigger_status = 'REJECTED' AND is_active",
  );
  const firstName = `E2E first ${randomUUID()}`;
  const secondName = `E2E second ${randomUUID()}`;
  try {
    await query("UPDATE templates SET is_active = false WHERE id = ANY($1::uuid[])", [original.map((row) => row.id)]);
    const [first] = await query<{ id: string }>(
      "INSERT INTO templates (type, name, subject, body, trigger_status) VALUES ('EMAIL', $1, 'Update', 'Body', 'REJECTED') RETURNING id",
      [firstName],
    );

    const page = await asRole("admin");
    await page.goto("/admin/templates");
    await page.getByRole("link", { name: "Add template" }).click();
    const form = page.getByRole("form", { name: "Add template" });
    await form.getByLabel("Type").selectOption("EMAIL");
    await form.getByLabel("Name").fill(secondName);
    await form.getByLabel("Sent when the application moves to").selectOption("REJECTED");
    await form.getByLabel("Subject").fill("Your application for [[JOB_TITLE]]");
    await form.getByLabel("Body").fill("Dear [[CANDIDATE_FULL_NAME]],\n\nThank you for applying.");
    await form.getByRole("button", { name: "Save template" }).click();
    await expect(form.getByText("Another active template already sends the Rejected email. Deactivate it first.")).toBeVisible();

    // Deactivate the first one in a second tab, then save again.
    const other = await page.context().newPage();
    await other.goto(`/admin/templates/${first.id}`);
    const edit = other.getByRole("form", { name: "Edit template" });
    await edit.getByLabel("Active").uncheck();
    await edit.getByRole("button", { name: "Save template" }).click();
    await expect(edit.getByRole("status")).toHaveText("Template saved.");

    await form.getByRole("button", { name: "Save template" }).click();
    await expect(page.getByRole("heading", { name: "Edit template" })).toBeVisible();
    await page.goto("/admin/templates");
    await expect(page.getByTestId(`template-${secondName}`)).toContainText("Rejected");
  } finally {
    await query("DELETE FROM templates WHERE name = ANY($1::text[])", [[firstName, secondName]]);
    await query("UPDATE templates SET is_active = true WHERE id = ANY($1::uuid[])", [original.map((row) => row.id)]);
  }
});

test("V1: an Admin builds a requisition template with the field builder", async ({ asRole }) => {
  const name = `E2E requisition ${randomUUID()}`;
  try {
    const page = await asRole("admin");
    await page.goto("/admin/templates/new");
    const form = page.getByRole("form", { name: "Add template" });
    await form.getByLabel("Type").selectOption("REQUISITION");
    await form.getByLabel("Name").fill(name);
    await form.getByRole("button", { name: "Add field" }).click();
    const field = form.getByRole("group", { name: "Field 1" });
    await field.getByLabel("Key").fill("Cost Center");
    await field.getByLabel("Label").fill("Cost center");
    await form.getByRole("button", { name: "Save template" }).click();
    await expect(form.getByText("Field keys start with a lower-case letter")).toBeVisible();

    await field.getByLabel("Key").fill("cost_center");
    await field.getByLabel("Required").check();
    await form.getByRole("button", { name: "Save template" }).click();
    await expect(page.getByRole("heading", { name: "Edit template" })).toBeVisible();
    await expect(page.getByRole("group", { name: "Field 1" }).getByLabel("Key")).toHaveValue("cost_center");
  } finally {
    await query("DELETE FROM templates WHERE name = $1", [name]);
  }
});
